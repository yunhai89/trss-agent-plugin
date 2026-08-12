/**
 * StickerManager —— 表情包门面（有状态）。
 *
 * 职责：
 *  - 资源管理：install(git clone) / update(fetch+reset) / syncImages(_repo→images+重建清单) / status / setEnable / 目录子集
 *  - prompt 注入：catalog()（仅启用且有清单时返回文本，否则空串——零影响）
 *  - 发送层双模式：renderForImage（标记→<img base64>，图片模式内嵌）/ renderForText（→segment 数组，文本模式混排）
 *  - 多层频率闸：合法性 + 数量 + 冷却 + 防连发 + 概率(sendRate)
 *  - usageCount 节流写盘
 *
 * 设计要点：
 *  - cfg 经 getter 实时读 Config（热加载后即生效）；路径静态（Config.path.plugin）。
 *  - 未启用/无资源 → _decide 返回空 acceptMap → renderFor* 仅剥除字面标记、不解析成图（零副作用，标记绝不漏给用户）。
 */

import fs from 'node:fs'
import path from 'node:path'
import Config from '../../utils/Config.js'
import { spawn, exec } from 'node:child_process'
import {
  paths, ensureDirs, scanRepo, buildIndex, loadIndex, saveIndex, imageAbsOf, dirSize, buildCatalog,
  findByHash, addDiscoveredEntry, evictDiscoveredToCap,
} from './index.js'
import { parseMarkers, composeString, composeSegments } from './parser.js'
import { hashImage, judgeAndTag, pickByEmotion as pickByEmotionFrom } from './discover.js'

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const IMG_EXT = new Set(Object.keys(MIME))

function shellQuote(s) { return `"${String(s).replace(/"/g, '\\"')}"` }

/** mime → 扩展名（无匹配默认 png）。 */
function mimeToExt(mime) {
  const m = String(mime || '').toLowerCase()
  if (m.includes('png')) return 'png'
  if (m.includes('gif')) return 'gif'
  if (m.includes('webp')) return 'webp'
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  return 'png'
}

function _trunc(s, max = 8000) {
  const t = String(s == null ? '' : '')
  return t.length <= max ? t : t.slice(0, max) + `\n…[已截断，共 ${t.length} 字符]`
}

/**
 * 主机执行 shell（表情包 git 操作专用）。操作主机仓库目录 paths.REPO_DIR，**不走 terminal Docker 沙盒**——
 * 沙盒容器无 git 且看不到主机目录，会误报"无 git"。返回 {ok,exitCode,stdout,stderr}（与 _spawnGit 同构）。
 */
function runShell(command, { cwd, timeout = 60, maxOutput = 8000 } = {}) {
  return new Promise((resolve) => {
    try {
      exec(command, { cwd: cwd || undefined, timeout: (Number(timeout) || 60) * 1000, maxBuffer: (maxOutput || 8000) * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, exitCode: err ? (Number.isFinite(err.code) ? err.code : 1) : 0, stdout: _trunc(stdout, maxOutput), stderr: _trunc(stderr, maxOutput) })
      })
    } catch (e) {
      resolve({ ok: false, exitCode: null, stdout: '', stderr: `exec 失败：${e?.message || e}` })
    }
  })
}

/**
 * 内置 GitHub 加速代理（克隆表情包仓库用）。前缀式直接拼在原 URL 前；gitclone 为域名替换镜像。
 * 代理域名易失效，可用 sticker.githubProxies 追加/覆盖。来源（2026-07 搜集）：ghfast.top / gh-proxy.com /
 * ghproxy.net / gitclone.com。详见 https://ghproxy.link/
 */
const GITHUB_PROXIES = [
  { name: 'ghfast.top', xform: (u) => `https://ghfast.top/${u}` },
  { name: 'gh-proxy.com', xform: (u) => `https://gh-proxy.com/${u}` },
  { name: 'ghproxy.net', xform: (u) => `https://ghproxy.net/${u}` },
  { name: 'gitclone.com', xform: (u) => u.replace(/^https:\/\/github\.com\//, 'https://gitclone.com/github.com/') },
]

export class StickerManager {
  constructor({ logger = () => {} } = {}) {
    this.logger = logger
    this._indexCache = null
    this._cooldown = new Map()   // 会话 key -> 上次带图时间戳
    this._lastHad = new Map()    // 会话 key -> 上一条回复是否带了图
    this._usageDirty = new Set()
    this._usageTimer = null
  }

  /** 实时读 sticker 配置（热加载后即生效） */
  get cfg() { return Config.get().agent?.sticker || {} }

  /** 三重门：enable && index 存在 && 条目 > 0 */
  enabled() {
    const c = this.cfg
    if (!c || c.enable !== true) return false
    const idx = this.getIndex()
    return !!(idx?.stickers && Object.keys(idx.stickers).length > 0)
  }

  getIndex() {
    if (this._indexCache === null) this._indexCache = loadIndex()
    return this._indexCache
  }

  /** prompt 注入块；未启用/无清单返回空串 */
  catalog() {
    if (!this.enabled()) return ''
    return buildCatalog(this.getIndex(), { listTopN: this.cfg.listTopN ?? 30 })
  }

  // ───────────────────────── 自动发现（MaiBot 式） ─────────────────────────

  /**
   * 从一张群聊图片自动发现+打标+入库。
   * 流程：sha256 去重 → 视觉判定+打标（拒绝照片/文档）→ 存盘 → 入 index → 超限淘汰冷门。
   * @param {Buffer} buffer 图片字节
   * @param {string} mime
   * @param {object} opts { vision?, maxDiscovered? }
   * @returns {Promise<{status:'added'|'dup'|'rejected'|'noVision', name?:string, tags?:string[], hash?:string, reason?:string}>}
   */
  async discover(buffer, mime, { vision = null, maxDiscovered } = {}) {
    if (!this.enabled()) return { status: 'rejected', reason: 'sticker disabled' }
    if (!buffer || !mime) return { status: 'rejected', reason: 'no_buffer' }
    // 大小闸（cfg.discoverMaxSizeMB，默认 5；0=不限）
    const maxMB = Number(this.cfg.discoverMaxSizeMB ?? 5)
    if (maxMB > 0 && buffer.length > maxMB * 1024 * 1024) return { status: 'rejected', reason: 'too_large' }
    const hash = hashImage(buffer)
    const index = this.getIndex()
    if (findByHash(index, hash)) return { status: 'dup', hash }
    // 视觉判定+打标
    const judged = await judgeAndTag(vision, { buffer, mime })
    if (!judged.isSticker) return { status: 'rejected', reason: 'not_sticker', hash }
    // 存盘：images/discovered/<hash>.<ext>
    const ext = mimeToExt(mime)
    const fileRel = `discovered/${hash}.${ext}`
    ensureDirs()
    const abs = path.join(paths.IMAGES_DIR, fileRel)
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, buffer)
    } catch (e) {
      this.logger('warn', '[sticker] discover 存盘失败', e?.message || e)
      return { status: 'rejected', reason: 'save_failed', hash }
    }
    // 入 index（去重双保险）+ 超限淘汰
    let next = addDiscoveredEntry(index, { name: judged.name, file: fileRel, desc: judged.desc, tags: judged.tags, hash, source: 'discovered' })
    if (next.dup) return { status: 'dup', hash }
    const cap = Math.max(1, Number(maxDiscovered ?? this.cfg.maxDiscovered ?? 200))
    const ev = evictDiscoveredToCap(next.index, cap)
    for (const f of ev.removedFiles) { try { fs.unlinkSync(f) } catch { /* noop */ } }
    this._indexCache = ev.index
    try { saveIndex(ev.index) } catch (e) { this.logger('warn', '[sticker] discover 写盘失败', e?.message || e) }
    this.logger('mark', `[sticker] 自动发现+入库：${next.name}（${judged.tags.join('/') || '无标签'}）${judged.noVision ? ' [无视觉模型，未打标]' : ''}`)
    return { status: 'added', name: next.name, tags: judged.tags, desc: judged.desc, hash }
  }

  /**
   * 按情绪/意图跨全库选一张表情名（供 send_sticker 工具/自动附图用；不受目录 top-N 限制）。
   * @returns {string|null} 表情名
   */
  pickByEmotion(emotion, opts = {}) {
    const index = this.getIndex()
    const entries = Object.entries(index?.stickers || {}).filter(([, e]) => {
      // 只选文件存在的
      try { return fs.existsSync(imageAbsOf(e)) } catch { return false }
    })
    return pickByEmotionFrom(entries, emotion, opts)
  }

  /** 取某表情的图片绝对路径（供 send_sticker 工具发图）。 */
  imageOf(name) {
    const e = this.getIndex()?.stickers?.[name]
    if (!e) return null
    const abs = imageAbsOf(e)
    return fs.existsSync(abs) ? abs : null
  }

  // ───────────────────────── 发送层：双模式渲染 ─────────────────────────

  /** 会话 key：群按 groupId，私聊按 pm:userId */
  _key(ctx) { return ctx?.isGroup ? (ctx.groupId || 'group') : ('pm:' + (ctx?.userId || 'anon')) }

  /**
   * 多层频率闸 → acceptMap(name → 图片绝对路径)。空 map 表示本轮不带图（标记全剥除）。
   * 顺序：启用检查 → groupOnly → 冷却 → 防连发 → 概率 → 合法性+数量。
   */
  _decide(content, ctx) {
    const acceptMap = new Map()
    if (!this.enabled()) return acceptMap
    const c = this.cfg
    if (c.groupOnly && !ctx?.isGroup) return acceptMap
    const key = this._key(ctx)
    if ((c.cooldown ?? 0) > 0) {
      const last = this._cooldown.get(key) || 0
      if (Date.now() - last < (c.cooldown | 0) * 1000) return acceptMap
    }
    if (c.antiConsecutive !== false && this._lastHad.get(key)) return acceptMap
    const rate = Math.min(1, Math.max(0, Number(c.sendRate) ?? 1))
    if (rate < 1 && Math.random() > rate) return acceptMap
    const stickers = this.getIndex()?.stickers || {}
    const max = Math.max(0, (c.maxPerReply | 0) || 0)
    let count = 0
    for (const mk of parseMarkers(content)) {
      if (max > 0 && count >= max) break
      const entry = stickers[mk.name]
      if (!entry || entry.nsfw) continue
      const abs = imageAbsOf(entry)
      if (!fs.existsSync(abs)) continue
      if (acceptMap.has(mk.name)) continue
      acceptMap.set(mk.name, abs)
      count++
    }
    return acceptMap
  }

  /** 门控副作用：更新冷却/防连发/usage。acceptMap 为空则记"本轮未带图"。 */
  _afterDecide(key, acceptMap) {
    const had = acceptMap.size > 0
    this._lastHad.set(key, had)
    if (had) {
      this._cooldown.set(key, Date.now())
      this.bumpUsage([...acceptMap.keys()])
    }
  }

  /** 本轮一次性门控（含副作用：冷却/防连发/usage）。返回 acceptMap（空=本轮不带图）。回复出口调一次，按实际发送路径 apply。 */
  decide(content, ctx) {
    const acceptMap = this._decide(content, ctx)
    this._afterDecide(this._key(ctx), acceptMap)
    return acceptMap
  }

  /** 图片模式应用：把通过的标记替换为 <img class="sticker" src="data:...">，未通过的剥除 → 返回 content 字符串 */
  applyImage(content, acceptMap) {
    return composeString(content, acceptMap || new Map(), (abs) => this._imgDataUri(abs))
  }

  /** 文本模式应用：无通过标记→干净文本字符串；有→返回 [文本段, segment.image, …] 数组 */
  applyText(content, acceptMap) {
    if (!acceptMap || acceptMap.size === 0) return composeString(content, acceptMap || new Map(), () => '')
    const seg = (typeof segment !== 'undefined' && segment) || null
    const makeImage = seg ? (abs) => seg.image(abs) : (abs) => `[图片:${path.basename(abs)}]`
    const { segs } = composeSegments(content, acceptMap, makeImage)
    return segs
  }

  /** 便捷封装：decide + applyImage（单次调用场景；注意图片失败落文本时勿重复调，改用 decide+apply 各一次） */
  renderForImage(content, ctx) { return this.applyImage(content, this.decide(content, ctx)) }
  /** 便捷封装：decide + applyText */
  renderForText(content, ctx) { return this.applyText(content, this.decide(content, ctx)) }

  _imgDataUri(abs) {
    try {
      const buf = fs.readFileSync(abs)
      const mime = MIME[path.extname(abs).toLowerCase()] || 'image/png'
      return `<img class="sticker" src="data:${mime};base64,${buf.toString('base64')}">`
    } catch { return '' }
  }

  // ───────────────────────── usage 节流写盘 ─────────────────────────

  bumpUsage(names) {
    if (!names?.length) return
    for (const n of names) this._usageDirty.add(n)
    if (this._usageTimer) return
    this._usageTimer = setTimeout(() => this._flushUsage(), 60000)
    if (this._usageTimer.unref) this._usageTimer.unref()
  }

  _flushUsage() {
    this._usageTimer = null
    const dirty = this._usageDirty
    this._usageDirty = new Set()
    if (!dirty.size) return
    const idx = this.getIndex()
    if (!idx?.stickers) return
    let changed = false
    for (const n of dirty) {
      if (idx.stickers[n]) { idx.stickers[n].usageCount = (idx.stickers[n].usageCount || 0) + 1; changed = true }
    }
    if (!changed) return
    idx.updatedAt = Date.now()
    try { saveIndex(idx); this._indexCache = idx } catch (e) { this.logger('warn', '[sticker] usage 写盘失败', e?.message || e) }
  }

  // ───────────────────────── 资源管理 ─────────────────────────

  async _headSha() {
    const r = await runShell('git rev-parse HEAD', { cwd: paths.REPO_DIR, timeout: 15 })
    return r.ok ? r.stdout.trim() : null
  }
  async _defaultBranch() {
    const r = await runShell('git rev-parse --abbrev-ref HEAD', { cwd: paths.REPO_DIR, timeout: 15 })
    const b = r.ok ? r.stdout.trim() : ''
    return b || 'HEAD'
  }

  /**
   * 流式跑 git（spawn），捕获 --progress 实时进度（Receiving objects X% 等）。
   * runShell 是缓冲式 exec，拿不到中途输出；克隆这种长任务用它就报不了真实进度，故用 spawn。
   * 返回 runShell 同构结果 {ok, exitCode, stdout, stderr, ...}，便于上层统一处理。
   */
  _spawnGit(args, { cwd, timeout = 600, onProgress } = {}) {
    return new Promise((resolve) => {
      let stdout = '', stderr = '', lastProgress = ''
      let timer = null
      const finish = (r) => { if (timer) clearTimeout(timer); resolve(r) }
      let proc
      try { proc = spawn('git', args, { cwd: cwd || undefined, stdio: ['ignore', 'pipe', 'pipe'] }) }
      catch (e) { return finish({ ok: false, exitCode: null, stdout: '', stderr: `spawn 失败：${e?.message || e}` }) }
      if (timeout) timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* noop */ } finish({ ok: false, timedOut: true, exitCode: null, signal: 'SIGKILL', stdout, stderr }) }, timeout * 1000)
      proc.stdout?.on('data', (d) => { stdout += d.toString() })
      proc.stderr?.on('data', (d) => {
        const chunk = d.toString()
        stderr += chunk
        const ms = [...chunk.matchAll(/(Receiving objects|Counting objects|Resolving deltas|Compressing objects|Enumerating objects):\s*(\d+)%/g)]
        if (ms.length) { lastProgress = `${ms[ms.length - 1][1]} ${ms[ms.length - 1][2]}%`; try { onProgress?.({ progress: lastProgress }) } catch { /* noop */ } }
      })
      proc.on('error', (e) => finish({ ok: false, exitCode: null, stdout, stderr: stderr + `\n${e?.message || e}` }))
      proc.on('close', (code) => finish({ ok: code === 0, exitCode: code, stdout, stderr, progress: lastProgress }))
    })
  }

  /** 候选代理 URL：直连 + 内置代理 + sticker.githubProxies 追加（去重） */
  _proxyCandidates(repo) {
    const out = [{ name: '直连', url: repo }]
    for (const p of GITHUB_PROXIES) { try { out.push({ name: p.name, url: p.xform(repo) }) } catch { /* noop */ } }
    for (const px of (this.cfg.githubProxies || [])) {
      if (typeof px === 'string' && px) {
        const prefix = px.replace(/\/$/, '')
        out.push({ name: prefix, url: `${prefix}/${repo}` })
      }
    }
    const seen = new Set()
    return out.filter((p) => p.url && !seen.has(p.url) && seen.add(p.url))
  }

  /** 测一个候选：git ls-remote 计时（真握手，比 HTTP HEAD 更准） */
  async _testProxy(c, timeout = 12) {
    const t0 = Date.now()
    let ok = false
    try {
      const r = await runShell(`git ls-remote ${shellQuote(c.url)} HEAD`, { timeout, maxOutput: 500 })
      ok = r.ok && /[0-9a-f]{7,40}/.test(r.stdout)
    } catch { ok = false }
    return { name: c.name, url: c.url, ok, ms: Date.now() - t0 }
  }

  /** 并发测速所有候选，按"可用优先 + 耗时升序"排序返回 */
  async _pickFastestUrl(repo, { timeout = 12 } = {}) {
    const cands = this._proxyCandidates(repo)
    const results = await Promise.all(cands.map((c) => this._testProxy(c, timeout)))
    results.sort((a, b) => (a.ok !== b.ok ? (a.ok ? -1 : 1) : a.ms - b.ms))
    return results
  }

  /**
   * 安装：测速选最优 GitHub 代理 → 浅克隆 → 启用层同步 → 重建清单。
   * 全程仅控制台打实时进度（logger），群聊零消息——只在结束返回成功/失败给调用方回复。
   */
  async install() {
    ensureDirs()
    if (fs.existsSync(path.join(paths.REPO_DIR, '.git'))) {
      return { ok: false, already: true, msg: '_repo 已存在。如需拉取最新请用 #表情包更新；如需重装请先删除 _repo 目录。' }
    }
    const gitCheck = await runShell('git --version', { timeout: 10 })
    if (!gitCheck.ok) return { ok: false, msg: '系统未安装 git，无法克隆表情包仓库。请先安装 git。' }
    const repo = (this.cfg.repo || '').trim()
    if (!repo) return { ok: false, msg: '尚未配置表情包仓库地址（agent.sticker.repo 为空）。请填入你自建/自有的表情包 git 仓库后重试。' }

    // 测速选最优代理（结果打控制台）
    this.logger('mark', '[sticker] 开始测速 GitHub 代理…')
    const ranked = await this._pickFastestUrl(repo)
    const okList = ranked.filter((r) => r.ok)
    const probe = ranked.map((r) => `${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? ` (${r.ms}ms)` : ''}`).join('  ')
    this.logger('mark', `[sticker] 代理测速：${probe}`)
    if (!okList.length) {
      this.logger('error', `[sticker] 所有代理都连不上 GitHub：${probe}`)
      return { ok: false, msg: '所有 GitHub 代理都连不上（详见控制台）。可配置 sticker.githubProxies 或手动 git clone 后 #表情包更新。' }
    }

    // 用最优（失败则依次兜底）浅克隆；进度实时打控制台
    this.logger('mark', `[sticker] 使用「${okList[0].name}」克隆…`)
    const target = paths.REPO_DIR
    let used = okList[0], res = null
    for (const c of okList) {
      if (c !== okList[0]) this.logger('mark', `[sticker] 切换代理「${c.name}」重试…`)
      let lastLog = ''
      res = await this._spawnGit(['clone', '--depth', '1', '--progress', c.url, target], {
        cwd: paths.STICKER_DIR, timeout: 600,
        onProgress: ({ progress }) => { if (progress && progress !== lastLog) { lastLog = progress; this.logger('info', `[sticker] 下载进度 ${progress}`) } },
      })
      used = c
      if (res.ok || fs.existsSync(path.join(paths.REPO_DIR, '.git'))) break
      this.logger('warn', `[sticker] 「${c.name}」克隆失败：${(res.stderr || res.stdout || '').slice(-160)}`)
    }
    if (!fs.existsSync(path.join(paths.REPO_DIR, '.git'))) {
      this.logger('error', `[sticker] 克隆失败（已试 ${okList.length} 个代理）：${res?.stderr || res?.stdout || res?.signal || '未知'}`)
      return { ok: false, msg: `克隆失败（已试 ${okList.length} 个代理，详见控制台）。可手动 git clone 到 ${paths.REPO_DIR} 后 #表情包更新。` }
    }
    const commit = await this._headSha()
    const stats = await this.syncImages({ commit })
    this.logger('mark', `[sticker] 安装完成：${stats.total} 个表情（经 ${used.name}，commit ${String(commit).slice(0, 8)})`)
    return { ok: true, commit, stats, proxy: used.name, msg: `安装完成，共 ${stats.total} 个表情（经 ${used.name}）。` }
  }

  /** 更新：fetch+reset；HEAD 未变短路；变则启用层同步 + 重建清单。全程控制台打进度。 */
  async update() {
    if (!fs.existsSync(path.join(paths.REPO_DIR, '.git'))) {
      return { ok: false, msg: '尚未安装表情包资源，请先 #表情包安装。' }
    }
    this.logger('mark', '[sticker] 开始更新…')
    const branch = await this._defaultBranch()
    const before = await this._headSha()
    const fetchCmd = (proxy) => `git ${proxy ? `-c http.proxy=${shellQuote(proxy)} ` : ''}fetch --depth 1 origin ${shellQuote(branch)}`
    let res = await runShell(fetchCmd(false), { cwd: paths.REPO_DIR, timeout: 600 })
    if (!res.ok && this.cfg.gitProxy) {
      this.logger('mark', '[sticker] 直连 fetch 失败，用 gitProxy 重试…')
      res = await runShell(fetchCmd(this.cfg.gitProxy), { cwd: paths.REPO_DIR, timeout: 600 })
    }
    if (!res.ok) {
      this.logger('error', `[sticker] 更新失败：${res.stderr || res.stdout || '未知'}`)
      return { ok: false, msg: `更新失败（详见控制台；可配置 sticker.gitProxy 重试）。` }
    }
    await runShell('git reset --hard FETCH_HEAD', { cwd: paths.REPO_DIR, timeout: 120 })
    const after = await this._headSha()
    if (before && after && before === after) return { ok: true, noop: true, msg: '已是最新，无需更新。' }
    const stats = await this.syncImages({ commit: after })
    this.logger('mark', `[sticker] 更新完成：+${stats.added} ~${stats.updated} -${stats.removed}，共 ${stats.total}`)
    return { ok: true, stats, msg: `更新完成：新增 ${stats.added} / 更新 ${stats.updated} / 移除 ${stats.removed}，共 ${stats.total} 个。` }
  }

  /**
   * 启用层同步：扫描 _repo（按黑名单过滤）→ 与 images/ 比对（增/改/删）→ 重建 index.json（合并保留旧 tags/usageCount）。
   * 返回 { total, added, updated, removed }。
   */
  async syncImages({ commit } = {}) {
    ensureDirs()
    const scanned = scanRepo({ manifest: this.cfg.manifest, excludeDirs: this.cfg.excludeDirs, excludeKeywords: this.cfg.excludeKeywords })
    const wantRel = new Set(scanned.map((s) => s.file))
    let added = 0, updated = 0, removed = 0

    // 删除 images/ 中多余文件（上游删除 / 刚加入黑名单的目录）
    const prune = (dir) => {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const ent of entries) {
        const abs = path.join(dir, ent.name)
        if (ent.isDirectory()) { prune(abs); try { if (!fs.readdirSync(abs).length) fs.rmdirSync(abs) } catch { /* noop */ } }
        else if (ent.isFile()) {
          const rel = path.relative(paths.IMAGES_DIR, abs).split(path.sep).join('/')
          if (!wantRel.has(rel)) { try { fs.unlinkSync(abs); removed++ } catch { /* noop */ } }
        }
      }
    }
    prune(paths.IMAGES_DIR)

    // 复制/覆盖
    const copy = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst) }
    for (const s of scanned) {
      const dst = path.join(paths.IMAGES_DIR, s.file)
      let needCopy = false
      try {
        if (!fs.existsSync(dst)) needCopy = true
        else {
          const a = fs.statSync(s.abs), b = fs.statSync(dst)
          if (a.size !== b.size || Math.abs(a.mtimeMs - b.mtimeMs) > 1000) needCopy = true
        }
      } catch { needCopy = true }
      if (!needCopy) continue
      const existed = fs.existsSync(dst)
      try { copy(s.abs, dst); existed ? updated++ : added++ } catch (e) { this.logger('warn', '[sticker] 复制失败', s.file, e?.message || e) }
    }

    // 重建清单（合并旧）
    const oldIndex = loadIndex()
    const index = buildIndex(scanned, oldIndex, { commit: commit ?? await this._headSha() })
    saveIndex(index)
    this._indexCache = index
    return { total: scanned.length, added, updated, removed }
  }

  status() {
    const idx = this.getIndex()
    const total = idx?.stickers ? Object.keys(idx.stickers).length : 0
    const size = dirSize(paths.IMAGES_DIR)
    const top = idx?.stickers
      ? Object.entries(idx.stickers).sort((a, b) => (b[1].usageCount || 0) - (a[1].usageCount || 0)).slice(0, 5).map(([n, e]) => `${n}(${e.usageCount || 0})`).join('、') || '无'
      : '无'
    return [
      `状态：${this.cfg.enable ? '✅已开启' : '❌未开启（#表情包开启）'}`,
      `表情总数：${total}`,
      `本地体积：${(size / 1024 / 1024).toFixed(1)} MB`,
      `上游 commit：${idx?.commit || '未知'}`,
      `最近重建：${idx?.updatedAt ? new Date(idx.updatedAt).toLocaleString('zh-CN') : '未知'}`,
      `高频 Top5：${top}`,
    ].join('\n')
  }

  /** 热开关：写配置（持久化 + 触发热加载） */
  setEnable(v) {
    const cfg = Config.get()
    cfg.agent = cfg.agent || {}; cfg.agent.sticker = cfg.agent.sticker || {}
    cfg.agent.sticker.enable = !!v
    Config.save(cfg)
    return cfg.agent.sticker.enable
  }

  /** 列出 _repo 顶层目录及启停状态（基于 excludeDirs） */
  dirList() {
    if (!fs.existsSync(paths.REPO_DIR)) return '尚未安装表情包资源，请先 #表情包安装。'
    const excl = new Set((this.cfg.excludeDirs || []).map((d) => String(d).replace(/\/$/, '')))
    const entries = fs.readdirSync(paths.REPO_DIR, { withFileTypes: true }).filter((d) => !d.name.startsWith('.') && d.name !== '_repo')
    const dirs = entries.filter((d) => d.isDirectory()).map((d) => d.name).sort()
    const rootImgs = entries.filter((d) => d.isFile() && IMG_EXT.has(path.extname(d.name).toLowerCase())).length
    const lines = dirs.map((d) => `${excl.has(d) ? '⏸️' : '✅'} ${d}`)
    if (rootImgs) lines.push(`${excl.has('root') ? '⏸️' : '✅'} root（散图 ${rootImgs}）`)
    return `表情包目录（✅启用 / ⏸️停用）：\n${lines.join('\n')}\n\n用法：#表情包目录 启用 <目录名> / #表情包目录 停用 <目录名>`
  }

  /** 启用/停用某目录：改 excludeDirs + 存配置 + 重新同步 */
  async dirToggle(dir, enable) {
    if (!dir) return { ok: false, msg: '请指定目录名（见 #表情包目录）' }
    const cfg = Config.get()
    cfg.agent = cfg.agent || {}; cfg.agent.sticker = cfg.agent.sticker || {}
    const list = new Set((cfg.agent.sticker.excludeDirs || []).map((d) => String(d).replace(/\/$/, '')))
    if (enable) list.delete(dir); else list.add(dir)
    cfg.agent.sticker.excludeDirs = [...list]
    Config.save(cfg)
    const stats = await this.syncImages()
    return { ok: true, enable, dir, stats, msg: `${enable ? '启用' : '停用'} ${dir}，已重建清单（共 ${stats.total} 个）。` }
  }
}

/** 进程级单例：buildRuntime 与 apps/sticker.js 共享，保证 usageCount/冷却状态全局一致 */
let _mgr = null
export function getStickerManager(opts) {
  if (!_mgr) _mgr = new StickerManager(opts || {})
  return _mgr
}
