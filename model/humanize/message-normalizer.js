/**
 * MessageNormalizer —— Yunzai/TRSS 消息事件 → AmbientMessage（伪人模式统一消息形态）。
 *
 * 设计要点（指南 §7、§8.1）：
 *  - 纯函数：输入 Yunzai 事件 + { selfId, botNames, isCommand, platform }，输出 AmbientMessage。
 *  - self 判定抽成 isSelfEvent，供 apps/humanize.js 与 apps/agent.js 复用（防 report-self-message 回环）。
 *  - 无稳定 message_id 时生成短期指纹（仅用于去重，不作永久业务主键）。
 *  - mentionsBotName 做最小边界匹配，避免子串误判（指南 §9.2）。
 *
 * 不做：网络请求、引用原文拉取（由 perception/composer 按需拉）。
 */

import { createHash } from 'node:crypto'

/**
 * @typedef {Object} AmbientMessage
 * @property {string} id                 平台 message_id；缺失时用稳定指纹
 * @property {string} groupId
 * @property {string} userId
 * @property {string} displayName
 * @property {number} timestamp          毫秒
 * @property {string} text               纯文本（媒体标注占位）
 * @property {Array<object>} segments    原始消息段（克隆，避免污染事件）
 * @property {string|null} replyToId     被引用消息 id
 * @property {boolean} atBot             显式 @机器人
 * @property {boolean} mentionsBotName   文本提及机器人昵称
 * @property {boolean} quotesBot         引用了机器人的消息（由 app 层据 self 发言标记富化）
 * @property {boolean} isCommand         命令消息（绝不触发环境回复）
 * @property {boolean} isSelf            机器人自身消息
 * @property {boolean} handledByDirectAgent 直接模式已接管（app 层置位）
 * @property {Array<{kind:string,name?:string,url?:string}>} media 图片/文件/语音/视频
 */

/** 把消息段数组拼成可读文本（媒体标注类型），与 perception.messageToText 同构但本模块自包含。 */
export function segmentsToText(segments) {
  const arr = Array.isArray(segments) ? segments : [segments]
  const parts = []
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue
    if (s.type === 'text') parts.push(s.text || '')
    else if (s.type === 'at') parts.push(`@${s.qq}`)
    else if (s.type === 'image') parts.push('[图片]')
    else if (s.type === 'face' || s.type === 'bface' || s.type === 'mface') parts.push('[表情]')
    else if (s.type === 'record') parts.push('[语音]')
    else if (s.type === 'video') parts.push('[视频]')
    else if (s.type === 'file') parts.push(`[文件:${s.name || ''}]`)
  }
  return parts.join('').trim()
}

/**
 * 统一 self 判定（指南 §8.1：必须保留并复用 agent.js 的 self 过滤，防 report-self-message 回环）。
 * @param {object} e Yunzai 事件
 * @param {string[]} selfIds 机器人自身 uin 集合（e.self_id、e.bot.self_id、Bot.uin 等）
 * @returns {boolean}
 */
export function isSelfEvent(e, selfIds = []) {
  const uid = String(e?.user_id ?? e?.sender?.user_id ?? '')
  if (!uid) return false
  return selfIds.some((s) => String(s) === uid)
}

/** 收集机器人自身 id：e.self_id / e.bot.self_id / e.bot?.uin / Bot.uin（兜底）。调用方应把全局 Bot 也塞进来。 */
export function collectSelfIds(e, extra = []) {
  const out = new Set()
  const push = (v) => { if (v != null && String(v) !== '0') out.add(String(v)) }
  push(e?.self_id)
  push(e?.selfId)
  push(e?.bot?.self_id)
  push(e?.bot?.uin)
  for (const x of extra) push(x)
  // 全局 Bot（Yunzai）
  try {
    if (typeof Bot !== 'undefined' && Bot) {
      push(Bot.uin)
      if (Bot.uins && Array.isArray(Bot.uins)) for (const u of Bot.uins) push(u)
    }
  } catch { /* noop */ }
  return [...out]
}

/**
 * 生成短期消息指纹（平台缺少稳定 message_id 时用）。仅用于去重，不作永久主键。
 * 指南 §24：sha256(platform + groupId + userId + floor(timestamp/1000) + normalizedText + mediaIds)
 */
export function fingerprintId({ platform = 'qq', groupId = '', userId = '', timestamp = Date.now(), text = '', mediaIds = [] } = {}) {
  const norm = String(text).replace(/\s+/g, '')
  const mediaKey = Array.isArray(mediaIds) ? mediaIds.join(',') : ''
  // 指南 §24：floor(timestamp/1000) 秒级桶（防止同秒重复入队；operator-precedence 已修正）
  const tsSec = Math.floor((Number(timestamp) || Date.now()) / 1000)
  const key = [platform, groupId, userId, tsSec, norm, mediaKey].join('|')
  return 'fp_' + createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** 提取媒体段（图片/文件/语音/视频）。返回 [{kind, name?, url?}]。 */
function extractMedia(segments) {
  const out = []
  for (const s of segments) {
    if (!s || typeof s !== 'object') continue
    if (s.type === 'image') out.push({ kind: 'image', url: s.url || s.file || '' })
    else if (s.type === 'file') out.push({ kind: 'file', name: s.name || '', url: s.url || '' })
    else if (s.type === 'record') out.push({ kind: 'record', url: s.url || '' })
    else if (s.type === 'video') out.push({ kind: 'video', url: s.url || '' })
  }
  return out
}

/** 从消息段或事件中取被引用消息 id（reply 段 / e.reply_id / e.source.id）。 */
function extractReplyToId(e, segments) {
  if (e?.reply_id != null) return String(e.reply_id)
  for (const s of segments) {
    if (s?.type === 'reply' && (s.id != null || s.message_id != null)) {
      return String(s.id ?? s.message_id)
    }
  }
  const src = e?.source
  if (src && (src.id != null || src.message_id != null)) return String(src.id ?? src.message_id)
  return null
}

/**
 * 文本是否提及机器人昵称（最小边界匹配）。
 * - 昵称长度 < 2 不参与（单字误判率高）。
 * - 对含字母/数字的昵称要求前后非字母数字（避免 "AI" 命中 "EMAIL"）。
 * - 纯中文昵称用 includes（中文天然分词）。
 */
export function textMentionsName(text, names = []) {
  const t = String(text || '')
  if (!t) return false
  for (const raw of names) {
    const n = String(raw || '').trim()
    if (n.length < 2) continue
    if (/[A-Za-z0-9]/.test(n)) {
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`)
      if (re.test(t)) return true
    } else if (t.includes(n)) return true
  }
  return false
}

/**
 * 把 Yunzai 事件归一化为 AmbientMessage。
 * @param {object} e Yunzai 消息事件
 * @param {object} opts { selfIds, botNames, isCommand, platform }
 * @returns {AmbientMessage}
 */
export function normalizeYunzaiEvent(e, opts = {}) {
  const selfIds = Array.isArray(opts.selfIds) ? opts.selfIds : collectSelfIds(e)
  const botNames = Array.isArray(opts.botNames) ? opts.botNames : []
  const platform = opts.platform || 'qq'
  const segments = Array.isArray(e?.message) ? e.message.map((s) => ({ ...s })) : []

  const userId = String(e?.user_id ?? e?.sender?.user_id ?? '')
  const groupId = e?.group_id != null ? String(e.group_id) : ''
  const displayName = String(e?.sender?.card || e?.sender?.nickname || userId || '')
  const timestamp = Number(e?.time) ? Number(e.time) * 1000 : Date.now()

  const text = String(e?.msg ?? segmentsToText(segments) ?? '')
  const media = extractMedia(segments)
  const replyToId = extractReplyToId(e, segments)

  const atBot = !!(e?.atBot || segments.some((s) => s?.type === 'at' && selfIds.includes(String(s.qq))))
  const mentionsBotName = textMentionsName(text, botNames)
  const isSelf = isSelfEvent(e, selfIds)

  const messageId = e?.message_id != null ? String(e.message_id) : null
  const id = messageId || fingerprintId({ platform, groupId, userId, timestamp, text, mediaIds: media.map((m) => m.url) })

  const isCommand = typeof opts.isCommand === 'function' ? !!opts.isCommand(text, e) : false

  return {
    id,
    groupId,
    userId,
    displayName,
    timestamp,
    text,
    segments,
    replyToId,
    atBot,
    mentionsBotName,
    quotesBot: false, // 由 app 层据「replyToId 是否命中机器人最近发言」富化
    isCommand,
    isSelf,
    handledByDirectAgent: false,
    media,
  }
}
