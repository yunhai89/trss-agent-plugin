/**
 * Sticker 自动发现（MaiBot 式）—— 被动采集群内 image 段 → 视觉判定+打标 → 入库。
 *
 * 设计（指南/MaiBot 移植）：
 *  - 一次视觉调用同时做「判定是否表情/梗图」+「打≤5 标签 + 起名」，拒绝普通照片/文档/截图。
 *  - sha256 去重（同一张图只入一次）。
 *  - pickByEmotion：标签相似度 top-K + 随机，跨**全库**选图（不受目录 top-N 限制）。
 *
 * 纯逻辑（hash/解析/相似度）+ 视觉调用在此；文件 I/O 与 index 写入由 manager 负责。
 */

import { createHash } from 'node:crypto'

/** 判定+打标指令：只返回严格 JSON。 */
export const JUDGE_TAG_PROMPT = `你是一个表情包库的策展器。看这张图，判断它是否适合收藏进「群聊表情包库」，并打标签。

只返回一个 JSON 对象，不要解释、不要 markdown 代码块、不要多余文字：
{"isSticker": true或false, "name": "4字以内的中文名称", "desc": "一句话说明这个表情的意思或用法", "tags": ["开心","无奈","赞同","摸鱼","666"]}

判定规则：
- isSticker=true：表情包、梗图、meme、趣味图、二次元立绘表情、带文字的搞笑图、可爱的动物表情图——即群聊里用来表达情绪/玩梗的图。
- isSticker=false：普通生活照、真人自拍、风景照、证件/文档/截图（纯信息性，非表情用途）、二维码、Logo、过于私密或不适内容。返回 false 时 name/desc/tags 可留空。

tags 是 3~5 个情绪/场景/语义词（中文或网络用语），用于后续按情绪检索。`

/** sha256 图片去重 key。 */
export function hashImage(buffer) {
  if (!buffer) return ''
  return createHash('sha256').update(buffer).digest('hex')
}

/** 标签文本归一化：按 [,，、;；\r\n\t#] 切，trim，去空去重（小写不敏感）。 */
export function normalizeTags(input) {
  const arr = typeof input === 'string' ? input.split(/[,，、;；\r\n\t#]+/) : (Array.isArray(input) ? input : [])
  const seen = new Set()
  const out = []
  for (const raw of arr) {
    const t = String(raw || '').trim()
    if (!t || t.length > 20) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out.slice(0, 8)
}

/** 从 VLM 返回里抠 JSON（容忍 ```json 包裹/前后多余文字）。 */
function extractJson(text) {
  const t = String(text || '').trim()
  if (!t) return null
  // 直接试
  try { return JSON.parse(t) } catch { /* 继续 */ }
  // 去代码块
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) { try { return JSON.parse(fence[1].trim()) } catch { /* 继续 */ } }
  // 第一个 {... }
  const m = t.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch { /* 继续 */ } }
  return null
}

/**
 * 视觉判定+打标（一次调用）。
 * @param {object} vision VisionService 实例（需已配 agent.vision.model）
 * @param {object} img { buffer, mime, name? }
 * @returns {Promise<{isSticker:boolean, name:string, desc:string, tags:string[], raw?:string}>}
 *   无 vision 时返回 {isSticker:true, name:auto, desc:'', tags:[], noVision:true}（保守放行，由调用方决定是否入）。
 */
export async function judgeAndTag(vision, { buffer, mime, name } = {}) {
  if (!vision || typeof vision.analyze !== 'function') {
    return { isSticker: true, name: autoName(buffer), desc: '', tags: [], noVision: true }
  }
  let raw = ''
  try {
    raw = await vision.analyze({ buffer, mime, name }, JUDGE_TAG_PROMPT, { maxTokens: 300 })
  } catch (e) {
    return { isSticker: false, name: '', desc: '', tags: [], raw: String(e?.message || e), error: true }
  }
  const j = extractJson(raw)
  if (!j || typeof j !== 'object') {
    // JSON 解析失败 = LLM 异常（内容审核拒绝/超时/返回非 JSON）：一律拒绝，不入库
    return { isSticker: false, name: '', desc: '', tags: [], raw: raw.slice(0, 160), parseFailed: true }
  }
  const isSticker = j.isSticker !== false && j.isSticker !== 'false'
  return {
    isSticker,
    name: cleanName(j.name) || autoName(buffer),
    desc: String(j.desc || j.description || '').trim().slice(0, 80),
    tags: normalizeTags(j.tags || j.emotions || []),
    raw: raw.slice(0, 160),
  }
}

/** 名称清洗：去标点/空白，限 10 字。 */
function cleanName(s) {
  const t = String(s || '').replace(/[\s\[【】《》""'']+/g, '').trim()
  if (!t) return ''
  // 去掉常见前缀「表情:」
  return t.replace(/^(表情|sticker|emoji)[::]?/i, '').slice(0, 10) || ''
}

/** 无名时自动命名：表情_<hash6>。 */
function autoName(buffer) {
  const h = hashImage(buffer).slice(0, 6)
  return `表情_${h}`
}

// ───────── 标签相似度选图（pickByEmotion） ─────────

/** Levenshtein 编辑距离（小串够用）。 */
function levenshtein(a, b) {
  a = String(a || ''); b = String(b || '')
  const m = a.length, n = b.length
  if (!m) return n; if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let curr = new Array(n + 1)
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    [prev, curr] = [curr, prev]
  }
  return prev[n]
}

/** 两个词的相似度（1 - lev/maxLen），中文按字符。 */
function wordSim(a, b) {
  a = String(a || '').toLowerCase(); b = String(b || '').toLowerCase()
  if (!a || !b) return 0
  if (a === b) return 1
  const maxLen = Math.max(a.length, b.length)
  return Math.max(0, 1 - levenshtein(a, b) / maxLen)
}

/**
 * 情绪/意图 → 按 tags 相似度跨全库选一张。
 * 每个表情的得分 = 它所有 tags 与 emotion 的最大相似度（+ desc 子串匹配小加分）。
 * top-K 后随机一个（注入多样性，对齐 MaiBot）。
 * @param {Array<[name, entry]>} entries [[name, {tags, desc, ...}], ...]
 * @param {string} emotion 情绪/场景词（可多个，按空格/逗号拆）
 * @param {object} opts { topK?:number, rand?:() => number }
 * @returns {string|null} 选中的 name；无候选返回 null
 */
export function pickByEmotion(entries, emotion, { topK = 10, rand = Math.random } = {}) {
  if (!entries || !entries.length) return null
  const emoWords = String(emotion || '').split(/[\s,，、;；]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (!emoWords.length) {
    // 无情绪词：随机一张（偏向低 usage，给冷门图曝光）
    const sorted = [...entries].sort((a, b) => (a[1].usageCount || 0) - (b[1].usageCount || 0))
    const pool = sorted.slice(0, Math.min(topK, sorted.length))
    return pool[Math.floor(rand() * pool.length)]?.[0] || null
  }
  const scored = entries.map(([name, e]) => {
    const tags = Array.isArray(e.tags) ? e.tags : []
    let best = 0
    for (const emo of emoWords) {
      for (const tag of tags) {
        const s = wordSim(emo, tag)
        if (s > best) best = s
      }
      // desc 子串匹配小加分
      const desc = String(e.desc || '').toLowerCase()
      if (desc.includes(emo)) best = Math.max(best, 0.6)
    }
    return [name, best]
  })
  scored.sort((a, b) => b[1] - a[1])
  const k = Math.min(topK, scored.length)
  // 只在有正向相似（>0.3）的候选里选；都不沾边则返回最高分（兜底）
  const positive = scored.slice(0, k).filter((x) => x[1] > 0.3)
  const pool = positive.length ? positive : scored.slice(0, Math.min(3, k))
  return pool[Math.floor(rand() * pool.length)]?.[0] || null
}
