/**
 * 媒体主动收集 —— 从 Yunzai 事件 e 中按 4 个来源扫描文件/图片，归一为 MediaFile 描述符。
 *
 * 设计要点（与 TRSS-Yunzai 对齐）：
 *  - 协议适配层（OneBotv11/napcat 等）已把消息段拍平为 {type, ...data}，本层只消费这层结构。
 *  - 来源优先级：① 消息本体段 → ② 引用消息（getReply / source+getChatHistory 兜底）
 *      → ③ 合并转发（forward / xml·json 的 m_resid）→ ④ 群文件 / 离线文件（e.file）。
 *  - 框架优先：下载链接发现用 e.getReply / e.group.getFileUrl / e.group.fs.download / e.bot.getForwardMsg。
 *      这些方法不存在时优雅降级（不抛错），交由 resolve.js 兜底。
 *  - 本文件只做"发现"（得到 url/fid/segment），不做"下载字节"——字节下载在 resolve.js，便于离线测试。
 *
 * MediaFile 描述符（未解析态）：
 *   { id, source, kind, name, url, fid, busid, size, segment }
 * 解析后（resolve.js 填充）：buffer/mime/ext/bytes。
 */

let _seq = 0
function nextId() {
  _seq = (_seq + 1) % 1e9
  return `mf_${Date.now().toString(36)}_${_seq}`
}

/** 段类型 → 归一 kind */
export function kindOf(type) {
  switch (type) {
    case 'image':
      return 'image'
    case 'record':
      return 'audio'
    case 'video':
      return 'video'
    case 'file':
      return 'file'
    default:
      return null
  }
}

/** 从单个消息对象的 .message/.content 段数组抽取媒体描述符 */
export function extractFromMessage(msg, source) {
  const out = []
  const segs = msg?.message || msg?.content || msg?.messages
  const arr = Array.isArray(segs) ? segs : (segs ? [segs] : [])
  for (const seg of arr) {
    if (!seg || typeof seg !== 'object') continue
    // 兼容两种段形态：TRSS 扁平段 {type, ...data} 与原始 OneBot 段 {type, data:{...}}
    // （引用/历史消息走 sendApi('get_msg') 兜底时返回原始段，file_id 在 data 里——
    //  不合并就读不到，导致引用的 .txt 等文件段 fid 丢失、无法 get_file 取字节）
    const d = (seg.data && typeof seg.data === 'object' && !Array.isArray(seg.data)) ? { ...seg, ...seg.data } : seg
    const kind = kindOf(seg.type)
    if (!kind) continue
    out.push({
      id: nextId(),
      source,
      kind,
      name: d.name || d.file || d.fileName || (d.url ? String(d.url).split('/').pop()?.split('?')[0] : null) || `${kind}_${out.length}`,
      url: d.url || null,
      // NapCat 文件段用 file_id（非 fid/id）；图片/语音段用 file（哈希文件名，供 get_image/get_record）
      fid: d.fid || d.file_id || d.id || null,
      busid: d.busid ?? null,
      size: d.size ? Number(d.size) : (d.file_size ? Number(d.file_size) : null),
      segment: d,
    })
  }
  return out
}

/** 解析合并转发段（forward / xml / json）的 m_resid，返回 resid 或 null */
export function extractForwardResid(seg) {
  if (!seg) return null
  if (seg.type === 'forward' && seg.id) return seg.id
  if (seg.type === 'xml' || seg.type === 'json') {
    const raw = typeof seg.data === 'string' ? seg.data : JSON.stringify(seg.data || {})
    // XML 卡片用 m_resid，JSON 卡片（com.tencent.multimsg）用 resid —— 两者都兼容
    const m = String(raw).match(/(?:m_)?resid["']?\s*[:=]\s*["']([\w/+=-]+)["']/)
    if (m) return m[1]
  }
  return null
}

/**
 * 群文件 / 离线文件：e.file 段通常没有 url（只有 {id/fid, name, size, busid}），
 * 需调用 e.group.getFileUrl(fid) 或 e.group.fs.download(fid, busid) 拿下载链接。
 * 框架方法缺失时返回 null（交由上层跳过）。
 */
async function discoverFileUrl(seg, { bot, e }) {
  if (seg.url) return seg.url
  const fid = seg.fid || seg.id
  const pick = e?.group || e?.friend || bot
  try {
    if (pick?.getFileUrl && fid) return await pick.getFileUrl(fid)
  } catch { /* noop */ }
  try {
    if (pick?.fs?.download && fid != null) {
      const r = await pick.fs.download(fid, seg.busid)
      return r?.url || r || null
    }
  } catch { /* noop */ }
  return null
}

/**
 * 取引用消息对象：优先 e.getReply()；失败则直连 OneBot get_msg；再否则 e.source + getChatHistory 兜底。
 * 返回 { message:[...] } 或 null。log 为可选调试回调。
 */
export async function fetchReply(e, { bot, log } = {}) {
  if (!e) return null
  // reply_id：优先 loader 已提取的 e.reply_id，否则从 e.message 的 reply 段兜底
  const replyId = e.reply_id ?? (() => {
    const seg = Array.isArray(e.message) ? e.message.find((s) => s && s.type === 'reply') : null
    return seg?.id ?? null
  })()
  try {
    if (typeof e.getReply === 'function') {
      const r = await e.getReply()
      if (r?.message) return r
    }
  } catch (err) { log?.(`getReply 失败: ${err?.message || err}`) }
  // 直连 OneBot get_msg（最稳；NapCat 历史消息也能取到 message 段）。e.bot 不可用时用注入的 bot 兜底。
  const sendApiFn = (typeof e.bot?.sendApi === 'function' && e.bot.sendApi.bind(e.bot)) || (typeof bot?.sendApi === 'function' && bot.sendApi.bind(bot)) || null
  if (replyId != null && sendApiFn) {
    try {
      const r = await sendApiFn('get_msg', { message_id: replyId })
      if (r?.message) return r
    } catch (err) { log?.(`get_msg(reply ${replyId}) 失败: ${err?.message || err}`) }
  }
  const src = e.source
  if (src) {
    try {
      if (e.group?.getChatHistory) return (await e.group.getChatHistory(src.seq, 1)).pop()
      if (e.friend?.getChatHistory) return (await e.friend.getChatHistory((src.time || 0) + 1, 1)).pop()
      if (bot?.pickGroup && e.group_id) return (await bot.pickGroup(e.group_id).getChatHistory(src.seq, 1)).pop()
      if (bot?.pickFriend && e.user_id) return (await bot.pickFriend(e.user_id).getChatHistory((src.time || 0) + 1, 1)).pop()
    } catch (err) { log?.(`getChatHistory(reply) 失败: ${err?.message || err}`) }
  }
  return null
}

/** 消息段 → 引用预览文本（转发/文件/图片给占位，不丢信息） */
function quoteSegText(s) {
  if (typeof s === 'string') return s
  if (!s || typeof s !== 'object') return ''
  const d = s.data && typeof s.data === 'object' ? s.data : s
  switch (s.type) {
    case 'text': return d.text || ''
    case 'at': return `@${d.qq ?? d.user_id ?? ''}`
    case 'image': return '[图片]'
    case 'face': return '[表情]'
    case 'record': case 'voice': return '[语音]'
    case 'video': return '[视频]'
    case 'file': return `[文件:${d.name || d.file || ''}]`
    case 'forward': case 'xml': case 'json': return '[聊天记录卡片]'
    case 'reply': return '[回复]'
    default: return d.text || d.summary || ''
  }
}

/**
 * 拉取被引用消息的上下文（文本 / 媒体段 / 转发卡片 resid），供 Agent 把"引用内容"并入本轮输入。
 * 复用 fetchReply（getReply → get_msg → 历史兜底）；取不到返回 null（调用方降级，不阻断）。
 * @returns {Promise<{nick:string,text:string,forwardResid:string|null,raw:object}|null>}
 */
export async function fetchQuotedContext(e, { bot, log } = {}) {
  const reply = await fetchReply(e, { bot, log })
  if (!reply) return null
  const segsRaw = reply.message ?? reply.content ?? reply.messages ?? []
  const segs = Array.isArray(segsRaw) ? segsRaw : (segsRaw ? [segsRaw] : [])
  const text = segs.map(quoteSegText).join('').trim()
  let forwardResid = null
  for (const s of segs) { const r = extractForwardResid(s); if (r) { forwardResid = r; break } }
  const nick = reply.sender?.nickname || reply.sender?.card || reply.user_id || reply.sender?.user_id || ''
  return { nick: String(nick || ''), text, forwardResid, raw: reply }
}

/** 按 url||name 去重（保留首个来源） */
export function dedupMedia(list) {
  const seen = new Set()
  const out = []
  for (const m of list) {
    const key = (m.url || m.name || m.id)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out
}

/**
 * 主动收集：扫描事件 e 的 4 个来源，返回 MediaFile 描述符（已去重，未下载字节）。
 * @param {object} e Yunzai 事件
 * @param {object} opts { bot, fetchReplyMsg:boolean }
 * @returns {Promise<MediaFile[]>}
 */
export async function collectFromEvent(e, { bot, log } = {}) {
  if (!e) return []
  const collected = []

  // ① 消息本体段
  for (const m of extractFromMessage(e, 'message')) collected.push(m)

  // ② 引用消息
  try {
    const reply = await fetchReply(e, { bot, log })
    if (reply) {
      for (const m of extractFromMessage(reply, 'reply')) collected.push(m)
    } else if (e.reply_id != null || (Array.isArray(e.message) && e.message.some((s) => s && s.type === 'reply'))) {
      log?.('引用消息未能取到（getReply/get_msg/getChatHistory 均失败）')
    }
  } catch (err) { log?.(`收集引用消息异常: ${err?.message || err}`) }

  // ③ 合并转发
  if (Array.isArray(e.message)) {
    const forwards = e.message.filter((s) => s.type === 'forward' || s.type === 'xml' || s.type === 'json')
    for (const seg of forwards) {
      const resid = extractForwardResid(seg)
      if (!resid) continue
      try {
        const fn = e.bot?.getForwardMsg || bot?.getForwardMsg || e.group?.getForwardMsg || e.friend?.getForwardMsg
        if (typeof fn === 'function') {
          const nodes = await fn(resid)
          for (const node of [].concat(nodes || [])) {
            for (const m of extractFromMessage(node, 'forward')) collected.push(m)
          }
        }
      } catch { /* noop */ }
    }
  }

  // ④ 群文件 / 离线文件（e.file，单独段；可能已含于 ①，但 e.file 路径更稳）
  if (e.file && e.file.type === 'file') {
    const url = await discoverFileUrl(e.file, { bot, e })
    collected.push({
      id: nextId(),
      source: 'group_file',
      kind: 'file',
      name: e.file.name || e.file.fid || e.file.id || 'group_file',
      url,
      fid: e.file.fid || e.file.id || null,
      busid: e.file.busid ?? null,
      size: e.file.size ? Number(e.file.size) : null,
      segment: e.file,
    })
  }

  return dedupMedia(collected)
}

export { nextId }
