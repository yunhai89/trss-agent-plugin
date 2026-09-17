/**
 * 表情包索引层（纯函数为主）—— 仅自动发现模式。
 *
 * 索引由**自动发现**的群聊图片构建：图片经视觉判定+打标后入库，index.json 记录
 *   { name, file, desc, tags, source:'discovered', usageCount, hash, addedAt }。
 * 模型用 [sticker:name] 引用（name 为语义匹配主键），tags/desc 供语义匹配。
 *
 * 存储布局：
 *   resources/stickers/images/discovered/<hash>.<ext>   ← 自动发现入库的图片
 *   resources/stickers/index.json                       ← 清单
 *
 * （已移除远端仓库克隆/更新/manifest/目录启停相关逻辑，只保留自动发现。）
 */

import fs from 'node:fs'
import path from 'node:path'
import Config from '../../utils/Config.js'

const STICKER_DIR = path.join(Config.path.plugin, 'resources/stickers')
const IMAGES_DIR = path.join(STICKER_DIR, 'images')
const INDEX_PATH = path.join(STICKER_DIR, 'index.json')

export const paths = { STICKER_DIR, IMAGES_DIR, INDEX_PATH }

export function ensureDirs() {
  for (const d of [STICKER_DIR, IMAGES_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch { /* noop */ }
  }
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
 * 把自动发现条目裁到 maxDiscovered 个：按 usageCount 升序淘汰最冷门的。
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
  // 展示顺序按名称排序（确定性）：catalog 注入 system prompt 前缀区，任何随机化都会逐轮
  // 打穿 KV/prompt 缓存（曾 Fisher-Yates 洗牌——每轮 system 从此处起全部 cache miss）。
  // 防马太不靠目录乱序：发送侧已有 recent-3 多样性硬闸 + 模糊匹配 top-5 随机，注意力偏置在那层防。
  boosted.sort((a, b) => String(a[0]).localeCompare(String(b[0])))
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
