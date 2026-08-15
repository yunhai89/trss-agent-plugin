/**
 * 表情包索引层（纯函数为主）。
 *
 * 索引以**仓库 manifest 为准**（语义化匹配，不靠文件名猜）：
 *   - 仓库根目录放一个 .json manifest（数组）：[{ id, name, tags, docs }]
 *       id    数字/字符串，图文件名以此命名（如 id=1 → 000001.png，补零 6 位）
 *       name  表情名称 —— 模型用 [sticker:name] 引用，也是语义匹配主键
 *       tags  标签数组（兼容拼写 'tages'）
 *       docs  一句话意思描述（供模型语义匹配，最关键）
 *   - 图文件按 id 命名（000001.png/.jpg/.gif/.webp），可放仓库任意目录
 *   - 无 manifest 时退化为"文件名清洗"模式（兼容旧式仓库）
 *
 * 存储布局（relpath 相对 REPO_DIR，images/ 同构镜像）：
 *   resources/stickers/_repo/<repo 全量>      ← git 浅克隆（官方仓库）
 *   resources/stickers/images/<relpath>       ← 启用层镜像
 *   resources/stickers/index.json             ← 清单（由 manifest + 图构建）
 */

import fs from 'node:fs'
import path from 'node:path'
import Config from '../../utils/Config.js'

const STICKER_DIR = path.join(Config.path.plugin, 'resources/stickers')
const REPO_DIR = path.join(STICKER_DIR, '_repo')
const IMAGES_DIR = path.join(STICKER_DIR, 'images')
const INDEX_PATH = path.join(STICKER_DIR, 'index.json')

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const BUILTIN_KEYWORD_BLOCK = [/nsfw/i, /色情|裸露|porn|hentai|18禁/i]

export const paths = { STICKER_DIR, REPO_DIR, IMAGES_DIR, INDEX_PATH }

export function ensureDirs() {
  for (const d of [STICKER_DIR, REPO_DIR, IMAGES_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch { /* noop */ }
  }
}

/** id 补零到 6 位（manifest id=1 ↔ 图 000001.png） */
function padId(id) { return String(id).padStart(6, '0') }

/** 文件名清洗（无 manifest 时的退化模式）：去扩展名/《》/[前缀]/取_后/trim/限 20 字 */
export function cleanName(filename) {
  let s = path.basename(filename)
  const ext = path.extname(s)
  if (ext) s = s.slice(0, -ext.length)
  s = s.replace(/《|》/g, '').replace(/^\[[^\]]*\]\s*/, '')
  if (s.includes('_')) s = s.slice(s.indexOf('_') + 1)
  s = s.replace(/^[_\s]+|[_\s]+$/g, '').trim()
  if (!s) s = (ext ? path.basename(filename, ext) : path.basename(filename)) || 'sticker'
  return s.length > 20 ? s.slice(0, 20) : s
}

/**
 * 读取仓库 manifest：根目录（或指定 file）下第一个"数组且元素含 name"的 .json。
 * 兼容 tags/tages 拼写；docs 缺省取 desc。无则返回 null。
 */
export function loadManifest({ file } = {}) {
  if (!fs.existsSync(REPO_DIR)) return null
  let cands
  try { cands = file ? [file] : fs.readdirSync(REPO_DIR).filter((f) => f.endsWith('.json')) }
  catch { return null }
  for (const f of cands) {
    const p = path.join(REPO_DIR, f)
    try {
      if (!fs.statSync(p).isFile()) continue
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (!Array.isArray(data) || !data.length || !data[0] || data[0].name == null) continue
      return data
        .map((e) => (e && typeof e === 'object')
          ? {
              id: e.id != null ? String(e.id) : '',
              name: String(e.name ?? '').trim(),
              tags: Array.isArray(e.tags) ? e.tags : (Array.isArray(e.tages) ? e.tages : []),
              docs: e.docs || e.desc || '',
            }
          : null)
        .filter((e) => e && e.name)
    } catch { /* 试下一个 */ }
  }
  return null
}

/** 构建仓库内"图文件名(去扩展名) → {file, abs, source}"映射（排除黑名单目录/关键词） */
function buildImageMap({ excludeDirs = [], excludeKeywords = [] } = {}) {
  const map = new Map()
  if (!fs.existsSync(REPO_DIR)) return map
  const exclDirSet = new Set(excludeDirs.map((d) => String(d).replace(/\/$/, '')))
  const kwRes = [...BUILTIN_KEYWORD_BLOCK, ...excludeKeywords.filter(Boolean).map((k) => new RegExp(k, 'i'))]
  const walk = (dir, topDir, dirRel) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name === '_repo') continue
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!topDir && exclDirSet.has(ent.name)) continue
        const childTop = topDir || ent.name
        const childRel = dirRel ? `${dirRel}/${ent.name}` : ent.name
        walk(abs, childTop, childRel)
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase()
        if (!IMG_EXT.has(ext)) continue
        if (kwRes.some((re) => re.test(ent.name))) continue
        const base = ent.name.slice(0, -ext.length)
        const source = topDir || 'root'
        const fileRel = dirRel ? `${dirRel}/${ent.name}` : `root/${ent.name}`
        map.set(base, { file: fileRel, abs, source })
      }
    }
  }
  walk(REPO_DIR, '', '')
  return map
}

/**
 * 扫描 _repo → items [{name, tags, desc, file(relpath), source, abs}]。
 * 优先 manifest 驱动（按 id 定位图 + 语义字段）；无 manifest 退化为文件名清洗。
 */
export function scanRepo({ manifest, excludeDirs = [], excludeKeywords = [] } = {}) {
  const entries = loadManifest({ file: manifest })
  const imgMap = buildImageMap({ excludeDirs, excludeKeywords })
  if (entries) {
    const items = []
    for (const e of entries) {
      const hit = imgMap.get(e.id) || imgMap.get(padId(e.id)) || imgMap.get(e.name)
      if (!hit) continue // manifest 有条目但找不到对应图，跳过
      items.push({ name: e.name, tags: e.tags, desc: e.docs || e.name, file: hit.file, source: hit.source, abs: hit.abs })
    }
    return items
  }
  // 退化：无 manifest，按文件名清洗
  return [...imgMap.values()].map((h) => {
    const name = cleanName(path.basename(h.file))
    return { name, tags: [], desc: name, file: h.file, source: h.source, abs: h.abs }
  })
}

/**
 * 由 items 构建 stickers 映射（manifest 为准取 name/tags/desc；按 file 合并保留旧 usageCount）。
 * 同名追加 _2/_3。
 * 关键：保留旧 index 中 source='discovered' 的条目（自动发现的图不在 _repo，否则 #表情包更新 会丢）。
 */
export function buildIndex(items, oldIndex, { commit } = {}) {
  const oldByFile = new Map()
  for (const entry of Object.values(oldIndex?.stickers || {})) oldByFile.set(entry.file, entry)
  const stickers = {}
  const usedNames = new Set()
  for (const it of items) {
    let name = it.name
    if (usedNames.has(name)) {
      let i = 2
      while (usedNames.has(`${name}_${i}`)) i++
      name = `${name}_${i}`
    }
    usedNames.add(name)
    const old = oldByFile.get(it.file)
    stickers[name] = {
      file: it.file,
      desc: it.desc || name,
      tags: it.tags || [],
      source: it.source || 'root',
      usageCount: old?.usageCount || 0,
      nsfw: old?.nsfw || false,
      ...(it.hash || old?.hash ? { hash: it.hash || old?.hash } : {}),
      addedAt: old?.addedAt || Date.now(),
    }
    oldByFile.delete(it.file)
  }
  // 保留旧 index 里自动发现的条目（不在 _repo，但图在 images/discovered 下）
  for (const [name, entry] of Object.entries(oldIndex?.stickers || {})) {
    if (entry?.source === 'discovered' && !usedNames.has(name) && fs.existsSync(imageAbsOf(entry))) {
      stickers[name] = entry
      usedNames.add(name)
    }
  }
  return { version: 5, commit: commit ?? oldIndex?.commit ?? null, updatedAt: Date.now(), stickers }
}

/** 按 hash 查条目（去重用）。 */
export function findByHash(index, hash) {
  if (!hash) return null
  for (const [, e] of Object.entries(index?.stickers || {})) {
    if (e.hash === hash) return e
  }
  return null
}

/**
 * 新增一个自动发现的表情条目到 index（含 hash 去重）。
 * @returns {{index:object, name:string, dup?:boolean}} dup=true 表示已存在（按 hash）
 */
export function addDiscoveredEntry(index, { name, file, desc, tags, hash, source = 'discovered' }) {
  const stickers = { ...(index?.stickers || {}) }
  if (hash && findByHash(index, hash)) return { index, name, dup: true }
  let nm = name || `表情_${(hash || '').slice(0, 6) || Date.now().toString(36)}`
  if (stickers[nm]) { let i = 2; while (stickers[`${nm}_${i}`]) i++; nm = `${nm}_${i}` }
  stickers[nm] = {
    file, desc: desc || nm, tags: Array.isArray(tags) ? tags : [],
    source, usageCount: 0, nsfw: false,
    ...(hash ? { hash } : {}),
    addedAt: Date.now(),
  }
  return { index: { version: 5, commit: index?.commit ?? null, updatedAt: Date.now(), stickers }, name: nm, dup: false }
}

/**
 * 把自动发现条目裁到 maxDiscovered 个：按 usageCount 升序淘汰最冷门的 discovered（不动 repo 条目）。
 * 返回 {index, removedFiles[]}（removedFiles 供调用方删盘）。
 */
export function evictDiscoveredToCap(index, maxDiscovered = 200) {
  const entries = Object.entries(index?.stickers || {})
  const disc = entries.filter(([, e]) => e?.source === 'discovered')
  if (disc.length <= maxDiscovered) return { index, removedFiles: [] }
  disc.sort((a, b) => (a[1].usageCount || 0) - (b[1].usageCount || 0))
  const removeCount = disc.length - maxDiscovered
  const toRemove = disc.slice(0, removeCount)
  const removedFiles = []
  const stickers = { ...(index?.stickers || {}) }
  for (const [name, e] of toRemove) {
    delete stickers[name]
    removedFiles.push(imageAbsOf(e))
  }
  return { index: { version: 5, commit: index?.commit ?? null, updatedAt: Date.now(), stickers }, removedFiles }
}

export function loadIndex() {
  try {
    if (!fs.existsSync(INDEX_PATH)) return null
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'))
  } catch { return null }
}

/** 原子写盘（tmp+rename） */
export function saveIndex(index) {
  ensureDirs()
  const tmp = `${INDEX_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2))
  fs.renameSync(tmp, INDEX_PATH)
}

/** index 中某条目对应图片在 images/ 下的绝对路径 */
export function imageAbsOf(entry) {
  return path.join(IMAGES_DIR, entry.file)
}

/** 目录体积（字节，递归；不存在返回 0） */
export function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0
  let total = 0
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const abs = path.join(d, ent.name)
      if (ent.isDirectory()) walk(abs)
      else if (ent.isFile()) try { total += fs.statSync(abs).size } catch { /* noop */ }
    }
  }
  walk(dir)
  return total
}

/**
 * 产 prompt 注入块文本（catalog）。语义信息 = tags ｜ docs，供模型语义匹配（而非靠名称猜）。
 * ≤ listTopN 全量列出；超 listTopN 取 usageCount 高频 + **最近自动发现加权**（新图 usage=0 不被埋没）。
 */
export function buildCatalog(index, { listTopN = 30 } = {}) {
  const entries = index?.stickers ? Object.entries(index.stickers) : []
  if (!entries.length) return ''
  const sorted = entries.sort((a, b) => (b[1].usageCount || 0) - (a[1].usageCount || 0))
  // 最近自动发现加权：取 addedAt 最新的若干个 discovered，合入候选（去重后不超 listTopN*1.3）
  const newBoostMax = Math.max(4, Math.floor(listTopN / 3))
  const recentDiscovered = entries
    .filter(([, e]) => e?.source === 'discovered')
    .sort((a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0))
    .slice(0, newBoostMax)
  const topNames = new Set(sorted.slice(0, listTopN).map((x) => x[0]))
  const boosted = sorted.slice(0, listTopN)
  for (const [name] of recentDiscovered) {
    if (topNames.has(name)) continue
    boosted.push([name, index.stickers[name]])
    topNames.add(name)
    if (boosted.length >= Math.ceil(listTopN * 1.3)) break
  }
  // 展示顺序洗牌：按 usage 取样仍保留热度信号，但打破"最高使用恒排第一行"的注意力偏置
  // （马太效应修复：怼脸吐舌曾因恒排第一被 LLM 连发 8 次）
  for (let k = boosted.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [boosted[k], boosted[j]] = [boosted[j], boosted[k]] }
  const lines = boosted.map(([name, e]) => {
    const tags = e.tags?.length ? e.tags.join('/') : ''
    const desc = e.desc && e.desc !== name ? e.desc : ''
    const sem = [tags, desc].filter(Boolean).join('｜')
    const src = e.source === 'discovered' ? '✨' : ''
    return `- ${src}${name}: ${sem || name}`
  })
  return [
    '## 表情包',
    '你可以在回复中插入 [sticker:名称] 附带表情包。但带不带完全由对话语境决定，绝不是每条回复都要带。',
    '可用表情（名称: 标签｜语义；用 [sticker:名称] 引用，名称须与下表完全一致；✨=群聊新发现）：',
    ...lines,
    ...(entries.length > boosted.length ? [`……（共 ${entries.length} 个，仅列高频+新发现 ${boosted.length}）`] : []),
    '另外：表情很多时，可调用 send_sticker 工具按情绪自动选图（无需记名称）。',
    '是否带表情包的判断（重要）：',
    '- 该用：轻松闲聊、调侃、玩笑、情绪表达、活跃气氛、回应夸赞或善意——且表情的语义确实贴合此刻这句话才用。',
    '- 不该用：故障排查、技术解答、指令操作、步骤说明、事实陈述、正经讨论、求助投诉、对方情绪低落或认真求助；这类信息性/严肃回复一律不带。',
    '- 多数回复（尤其解答、说明、干活）根本不需要表情包；拿不准就不带。宁缺毋滥——生硬硬塞反而违和。',
    '格式约束：',
    '- 标记 [sticker:名称] 只能写在回复的【最末尾】（主内容全部写完之后另起一行），绝不能插在文字中间。系统会把它作为独立消息在正文之后单独发送，不会和正文混在一条里。',
    '- 一条回复优先 1 个、最多 2 个；连续几条回复不要每次都带。',
    '- 只使用上面列出的名称，不要编造；标记严格为 [sticker:名称]，不要写成 [表情包] 之类的占位词。',
  ].join('\n')
}
