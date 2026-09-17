/**
 * StickerManager —— 表情包门面（有状态）。
 *
 * 职责：
 *  - 自动发现：群聊图片 → 视觉判定+打标 → 入库（仅此一种资源来源，已移除远端仓库克隆） / status / setEnable
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
import Log from '../../utils/Log.js'
import path from 'node:path'
import Config from '../../utils/Config.js'
import {
  paths, ensureDirs, loadIndex, saveIndex, imageAbsOf, dirSize, buildCatalog,
  findByHash, addDiscoveredEntry, evictDiscoveredToCap,
} from './index.js'
import { parseMarkers, composeString, composeSegments } from './parser.js'
import { hashImage, judgeAndTag, pickByEmotion as pickByEmotionFrom, fuzzyFindByName } from './discover.js'

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

/** mime → 扩展名（无匹配默认 png）。 */
function mimeToExt(mime) {
  const m = String(mime || '').toLowerCase()
  if (m.includes('png')) return 'png'
  if (m.includes('gif')) return 'gif'
  if (m.includes('webp')) return 'webp'
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  return 'png'
}

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
    // 按 index 版本缓存 catalog 文本：system 前缀不因 usageCount 写盘（mtime 变）逐轮改写。
    // 刷新时机 = index 结构性变更（discover 置脏 _catalogVersion）。
    if (this._catalogCache && this._catalogCacheVersion === this._catalogVersion) return this._catalogCache
    const text = buildCatalog(this.getIndex(), { listTopN: this.cfg.listTopN ?? 30 })
    this._catalogCache = text
    this._catalogCacheVersion = this._catalogVersion
    return text
  }

  /** index 结构性变更时调用（discover）——usageCount 节流写盘不算 */
  bumpCatalogVersion() { this._catalogVersion = (this._catalogVersion || 0) + 1 }

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
    if (this.cfg.enable !== true) return { status: 'rejected', reason: 'sticker disabled' }
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
    this.bumpCatalogVersion()
    if (next.dup) return { status: 'dup', hash }
    const cap = Math.max(1, Number(maxDiscovered ?? this.cfg.maxDiscovered ?? 200))
    const ev = evictDiscoveredToCap(next.index, cap)
    for (const f of ev.removedFiles) { try { fs.unlinkSync(f) } catch { /* noop */ } }
    this._indexCache = ev.index
    try { saveIndex(ev.index); this.bumpCatalogVersion() } catch (e) { this.logger('warn', '[sticker] discover 写盘失败', e?.message || e) }
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
    // 多样性硬闸（独立于 sendRate/cooldown 配置）：最近发过的表情（近 3 张）不再发——
    // 防 LLM 对某张表情形成惯性（曾在无频率闸配置下连发同一张 8 次）
    const recent = new Set(this._recentSent || [])
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
      let entry = stickers[mk.name]
      let usedName = mk.name
      if (!entry) {
        // 精确名未中 → MaiBot 式模糊（Levenshtein，对 name+tags+desc）：容错拼写/简称/编的近似名
        const fz = fuzzyFindByName(mk.name, Object.entries(stickers))
        if (fz?.matched) {
          entry = stickers[fz.name]
          usedName = fz.name
          this.logger('info', `[sticker] 模糊命中 "${mk.name}" → ${fz.name}（sim ${fz.score.toFixed(2)}）`)
        } else if (fz) {
          this.logger('info', `[sticker] 无匹配 "${mk.name}"（最近 ${fz.name} ${fz.score.toFixed(2)}）`)
        } else {
          this.logger('info', `[sticker] 无匹配 "${mk.name}"（库无候选）`)
        }
      }
      if (!entry || entry.nsfw) continue
      if (recent.has(usedName)) continue // 最近发过：本轮不发（标记剥除，streak 打断）
      const abs = imageAbsOf(entry)
      if (!fs.existsSync(abs)) continue
      if (acceptMap.has(usedName)) continue
      acceptMap.set(usedName, abs)
      count++
    }
    return acceptMap
  }

  /** 记录实际发送的表情（多样性去重用；由 composer/主Agent 发送成功后调用）。 */
  noteSent(names = []) {
    if (!Array.isArray(names) || !names.length) return
    this._recentSent = [...(this._recentSent || []), ...names.map(String)].slice(-3)
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
      `最近入库：${idx?.updatedAt ? new Date(idx.updatedAt).toLocaleString('zh-CN') : '未知'}`,
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

  /** 库概览（web 面板用，只读）：启用状态/总数/自动采集数。 */
  libStats() {
    const stickers = (this.getIndex()?.stickers) || {}
    const names = Object.keys(stickers)
    let discovered = 0
    for (const n of names) if (stickers[n]?.source === 'discovered') discovered++
    return { enabled: this.enabled(), total: names.length, discovered }
  }
}

/** 进程级单例：buildRuntime 与 apps/sticker.js 共享，保证 usageCount/冷却状态全局一致 */
let _mgr = null
export function getStickerManager(opts) {
  if (!_mgr) _mgr = new StickerManager({ logger: (lvl, ...a) => { const fn = Log[lvl] || Log.info; fn(...a) }, ...(opts || {}) })
  return _mgr
}
