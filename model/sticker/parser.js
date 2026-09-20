/**
 * 表情包标记解析（纯函数）。
 *
 * 标记格式：[sticker:名称] —— 名称 1~24 字符、不含 []。
 * 复用方（manager）先跑门控得到 acceptMap(name→图片绝对路径)，再调：
 *   - composeString：图片模式，把通过的标记替换为 <img>、未通过的剥除 → 返回新字符串（交给 markdown 渲染）
 *   - composeSegments：文本模式，切成 [文本段, 图段, 文本段…] → Yunzai segment 数组
 *
 * 关键：未通过门控的标记一律剥除（绝不把字面 [sticker:xxx] 漏给用户）。
 */

export const MARKER_RE = /\[sticker:([^\[\]]{1,24})\]/g
const NAME_MAX = 24

/** 提取全部标记（每次新建正则实例，避免 /g 的 lastIndex 状态污染） */
export function parseMarkers(text) {
  const out = []
  const re = new RegExp(MARKER_RE.source, 'g')
  let m
  while ((m = re.exec(String(text || ''))) !== null) {
    const name = m[1].trim()
    if (name && name.length <= NAME_MAX) out.push({ name, raw: m[0], start: m.index, end: m.index + m[0].length })
  }
  return out
}

/**
 * 整条文本是否只由表情标记组成（剥除标记后为空）。
 * 用于回复出口：这类"只有表情"的回复若被频率门控挡下，会变成一条空白消息——
 * 应强制发出，绝不落空。
 */
export function isStickerOnly(text) {
  const s = String(text || '')
  if (!parseMarkers(s).length) return false
  return composeString(s, new Map(), () => '').trim() === ''
}

/**
 * 图片模式：把通过门控的标记替换为 onImage(file) 返回串，未通过的剥除 → 返回新字符串。
 * @param acceptMap Map(name → 图片绝对路径)
 */
export function composeString(text, acceptMap, onImage) {
  const markers = parseMarkers(text)
  let out = ''
  let cursor = 0
  for (const mk of markers) {
    out += String(text).slice(cursor, mk.start)
    const file = acceptMap.get(mk.name)
    if (file) out += onImage(file)
    cursor = mk.end
  }
  out += String(text).slice(cursor)
  return out
}

/**
 * 文本模式：切成 [文本段, 图段(image), 文本段…]；未通过门控的标记剥除。
 * @returns { segs, imgInserted } segs 元素为 string 或 makeImage(file) 的返回值
 */
export function composeSegments(text, acceptMap, makeImage) {
  const markers = parseMarkers(text)
  const segs = []
  let cursor = 0
  let imgInserted = 0
  for (const mk of markers) {
    if (cursor < mk.start) segs.push(String(text).slice(cursor, mk.start))
    const file = acceptMap.get(mk.name)
    if (file) { segs.push(makeImage(file)); imgInserted++ }
    cursor = mk.end
  }
  if (cursor < text.length) segs.push(String(text).slice(cursor))
  return { segs, imgInserted }
}
