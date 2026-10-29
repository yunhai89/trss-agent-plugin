/**
 * QQ 官方机器人（QQBot）协议适配 —— 纯逻辑层（无框架依赖，可离线测试）。
 *
 * 背景：TRSS-Yunzai 接入 QQ 官方机器人（Yunzai-QQBot-Plugin 适配器）时，事件里的 ID 与 OneBot/ICQQ 不同：
 *  - QQ 群：      group_id = `<self_id>:<group_openid>`，sender.user_id = `<self_id>:<member_openid>`
 *  - 群聊(C2C)：   sender.user_id = `<self_id>:<user_openid>`，无 group_id
 *  - 频道：       group_id = `qg_<guild_id>-<channel_id>`，user_id = `qg_<openid>`
 *  - 频道私聊：   user_id = `qg_<openid>`，无 group_id
 * 这些值不是 QQ 号，且 `scopeId` 会被当作**目录名**（memory/sessions/evolution），
 * 直接拼进路径会因 `:` 等字符在 Windows 上非法。本模块负责：
 *  1) 识别当前事件是否走官方机器人适配器（及哪种上下文）；
 *  2) 展示/配置用的原始 ID（去前缀）与完整 ID；
 *  3) 目录安全的 scope 片段（数字 ID 保持原样，官方 ID 净化 + 短哈希防撞）；
 *  4) Markdown 消息与 inline keyboard 按钮的协议段构造（QQ 官方专属能力）；
 *  5) 协议降级：官方不可用时把 markdown 转纯文本。
 *
 * 注：分段构造依赖 Yunzai 的全局 `segment`（TRSS 版提供 markdown/button；Miao 版没有），
 * 全部按能力探测，缺失时返回 null 由调用方降级。
 */

/** 官方单条 markdown 内容上限（保守值；官方接口约 4000，留出转义余量） */
export const MARKDOWN_MAX_CHARS = 3500
/** inline keyboard 官方限制：最多 5 行，每行最多 5 个按钮 */
export const KEYBOARD_MAX_ROWS = 5
export const KEYBOARD_MAX_PER_ROW = 5

/** 适配器识别关键字：TRSS QQBot 适配器 id="QQBot"；QQGuild 适配器 id="QQGuild" */
const ADAPTER_QQBOT_RE = /qqbot|qq[_\s-]?bot|官方机器人|qq群机器人/i
const ADAPTER_GUILD_RE = /guild|频道/i

function str(v) {
  return v == null ? '' : String(v)
}

function asAdapter(raw) {
  return raw && typeof raw === 'object' ? raw : {}
}

/**
 * 识别当前事件的适配器。
 * @param {object} e Yunzai 事件
 * @returns {{kind:'qqbot'|'guild'|'other', official:boolean, adapterId:string, adapterName:string, reason:string}}
 */
export function detectAdapter(e) {
  const botAdapter = asAdapter(e?.bot?.adapter)
  const adapterId = str(e?.adapter_id || e?.adapter?.id || botAdapter.id)
  const adapterName = str(e?.adapter_name || e?.adapter?.name || botAdapter.name)
  const probe = `${adapterId} ${adapterName}`.trim()

  if (ADAPTER_GUILD_RE.test(probe)) {
    return { kind: 'guild', official: true, adapterId, adapterName, reason: 'adapter' }
  }
  if (ADAPTER_QQBOT_RE.test(probe)) {
    return { kind: 'qqbot', official: true, adapterId, adapterName, reason: 'adapter' }
  }

  // 兜底：适配器元数据缺失（部分框架版本不给 adapter 字段）时按 ID 形态判断。
  // 只认「明显的官方形态」，避免把 OneBot 的正常数字 ID 误判。
  const userId = str(e?.user_id)
  const groupId = str(e?.group_id)
  const selfId = str(e?.self_id || e?.bot?.uin)
  const looksPrefixed = (id) => {
    if (!id) return false
    if (id.startsWith('qg_')) return true
    if (!selfId) return false
    return id.startsWith(`${selfId}:`) || (id.startsWith(selfId) && id.slice(selfId.length).startsWith(':'))
  }
  if (userId.startsWith('qg_') || groupId.startsWith('qg_')) {
    return { kind: 'guild', official: true, adapterId, adapterName, reason: 'id-shape' }
  }
  if (looksPrefixed(userId) || looksPrefixed(groupId)) {
    return { kind: 'qqbot', official: true, adapterId, adapterName, reason: 'id-shape' }
  }
  return { kind: 'other', official: false, adapterId, adapterName, reason: 'none' }
}

/**
 * 消息上下文类型。
 * @returns {'group'|'c2c'|'guild'|'guild_dm'|'private'}
 */
export function contextKind(e, adapter = null) {
  const info = adapter || detectAdapter(e)
  const isGroup = !!e?.isGroup
  if (info.kind === 'guild') return isGroup ? 'guild' : 'guild_dm'
  if (info.kind === 'qqbot') return isGroup ? 'group' : 'c2c'
  return isGroup ? 'group' : 'private'
}

/** 上下文的中文名（/uid、/groupid 与日志用） */
export function contextLabel(e, adapter = null) {
  const kind = contextKind(e, adapter)
  return { group: '群聊', c2c: '私聊(C2C)', guild: '频道', guild_dm: '频道私聊', private: '私聊' }[kind] || kind
}

/**
 * 去掉官方 ID 的 self_id 前缀（及频道的 qg_ 前缀），得到可直接配置/展示的原始 ID。
 * Windows 下适配器 sep 为空字符串（ID 不带前缀），此时原样返回。
 */
export function stripSelfPrefix(id, e) {
  let s = str(id)
  if (!s) return ''
  const selfId = str(e?.self_id || e?.bot?.uin || e?.selfId)
  if (selfId) {
    if (s.startsWith(`${selfId}:`)) s = s.slice(selfId.length + 1)
    else if (s.startsWith(selfId) && s.slice(selfId.length).startsWith(':')) s = s.slice(selfId.length + 1)
  }
  if (s.startsWith('qg_')) s = s.slice(3)
  return s
}

/** 发言人原始 ID（去前缀） */
export function rawUserId(e) {
  return stripSelfPrefix(e?.user_id ?? e?.sender?.user_id ?? '', e)
}

/** 群标识原始 ID（去前缀）；频道为 `<guild_id>-<channel_id>` */
export function rawGroupId(e) {
  return stripSelfPrefix(e?.group_id ?? '', e)
}

/** 频道 ID 拆解（非频道返回 null） */
export function splitGuildId(e) {
  const raw = rawGroupId(e)
  if (!raw || detectAdapter(e).kind !== 'guild') return null
  const idx = raw.lastIndexOf('-')
  if (idx <= 0) return { guildId: raw, channelId: '' }
  return { guildId: raw.slice(0, idx), channelId: raw.slice(idx + 1) }
}

/** 稳定短哈希（FNV-1a 32bit，8 位 hex；仅用于净化后防撞） */
function shortHash(s) {
  let h = 0x811c9dc5
  const text = String(s)
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 目录安全片段：scopeId 会作为 memory/sessions/evolution 的子目录名。
 * 数字/常规 ID 原样返回（保持既有目录兼容）；含非法字符时净化并追加短哈希避免撞车。
 */
export function safeScopePart(id) {
  const s = str(id)
  if (!s) return ''
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s
  return `${s.replace(/[^A-Za-z0-9_-]/g, '-')}-${shortHash(s)}`
}

/**
 * 从事件推导数据隔离 scope（与 apps/agent.js 的 ctxOf 同口径，抽出来便于离线测试）。
 * @param {object} e 事件
 * @param {boolean} isolation 是否按用户隔离（agent.isolation.enable）
 * @returns {{userId:string, groupId:string|null, isGroup:boolean, scopeUserId:string, scopeId:string, official:boolean, contextKind:string}}
 */
export function deriveScope(e, isolation = true) {
  const adapter = detectAdapter(e)
  const userId = str(e?.user_id ?? e?.sender?.user_id ?? '')
  const groupIdRaw = str(e?.group_id ?? '')
  const isGroup = !!e?.isGroup
  const groupId = groupIdRaw || null
  const sharedGroup = !!(isGroup && groupId && !isolation)
  const scopeUserId = sharedGroup ? `__group__:${safeScopePart(groupId)}` : userId
  const scopeId = !isGroup
    ? `u_${safeScopePart(userId)}`
    : (isolation ? `g${safeScopePart(groupId)}_u${safeScopePart(userId)}` : `g${safeScopePart(groupId)}`)
  return {
    userId,
    groupId,
    isGroup,
    scopeUserId,
    scopeId,
    official: adapter.official,
    adapterKind: adapter.kind,
    contextKind: contextKind(e, adapter),
  }
}

/** 全局 segment（TRSS 提供 markdown/button；缺失时安全降级） */
function seg() {
  return typeof segment !== 'undefined' ? segment : null
}

/** 当前环境是否具备 markdown 段能力 */
export function hasMarkdownSegment() {
  return typeof seg()?.markdown === 'function'
}

/** 当前环境是否具备 button 段能力 */
export function hasButtonSegment() {
  return typeof seg()?.button === 'function'
}

/**
 * 构造 markdown 段。
 * @param {string|object} content 纯 markdown 文本；或官方模板对象 { templateId, params } / 原生 { custom_template_id, params }
 * @returns {object|null} segment.markdown 段；能力缺失返回 null
 */
export function markdownSegment(content) {
  const s = seg()
  if (typeof s?.markdown !== 'function') return null
  if (content && typeof content === 'object') {
    const payload = content.custom_template_id
      ? { ...content }
      : { custom_template_id: content.templateId, ...(content.params ? { params: content.params } : {}) }
    return s.markdown(payload)
  }
  return s.markdown(str(content))
}

/**
 * 归一按钮定义为 Yunzai `segment.button(...rows)` 需要的「行数组」。
 * 按钮字段（前端/LLM 友好）：
 *  - text         按钮文案（必填）
 *  - clicked_text 点击后展示文案（可选）
 *  - callback     回调文本：点击后作为用户消息发回（走插件命令/对话）
 *  - link         链接 URL（与 callback/input 互斥）
 *  - input        输入框回填文本（与 callback/link 互斥）
 *  - send         input 类型时是否直接发送（默认 true）
 *  - permission   'admin' 或 [用户ID,...]（限制可点击者；默认由调用方决定）
 *  - public       true=所有人可点（等价 permission 不设）
 * @param {Array<Array<object>|object>} rows
 * @returns {Array<Array<object>>} 归一后的行（已裁剪非法/超限按钮）
 */
export function normalizeKeyboard(rows) {
  const input = Array.isArray(rows) ? rows : []
  const out = []
  for (const row of input) {
    if (out.length >= KEYBOARD_MAX_ROWS) break
    const list = Array.isArray(row) ? row : [row]
    const btns = []
    for (const b of list) {
      if (btns.length >= KEYBOARD_MAX_PER_ROW) break
      if (!b || typeof b !== 'object') continue
      const text = str(b.text ?? b.label ?? '').trim()
      if (!text) continue
      const btn = { text }
      if (b.clickedText ?? b.clicked_text) btn.clicked_text = str(b.clickedText ?? b.clicked_text).slice(0, 20)
      if (b.link) btn.link = str(b.link)
      else if (b.input != null) {
        btn.input = str(b.input)
        btn.send = b.send !== false
      } else if (b.callback != null) btn.callback = str(b.callback)
      else continue // 无动作的按钮官方会拒收，直接丢弃
      if (b.permission === 'admin') btn.permission = 'admin'
      else if (Array.isArray(b.permission) && b.permission.length) btn.permission = b.permission.map(str)
      else if (b.public === true) btn.public = true
      // 透传 QQBot 原生动作覆盖（高级用法）
      if (b.QQBot && typeof b.QQBot === 'object') btn.QQBot = b.QQBot
      btns.push(btn)
    }
    if (btns.length) out.push(btns)
  }
  return out
}

/**
 * 构造 keyboard 段组（`segment.button(row1, row2, ...)`）。
 * @returns {object[]} 每个元素的 type 均为 'button'（每行一个段）
 */
export function keyboardSegments(rows, { ownerId = '', allowPublic = false } = {}) {
  const s = seg()
  if (typeof s?.button !== 'function') return []
  const normalized = normalizeKeyboard(rows)
  if (!normalized.length) return []
  // 安全默认：回调按钮仅触发者可点（除非显式 public）；链接按钮对所有人开放。
  const rowsSafe = normalized.map((row) => row.map((b) => {
    if (b.public === true) {
      const { public: _p, ...rest } = b
      return allowPublic ? rest : { ...rest, permission: ownerId ? [ownerId] : 'admin' }
    }
    if (b.callback && b.permission == null) return { ...b, permission: ownerId ? [ownerId] : 'admin' }
    return b
  }))
  const built = []
  for (const row of rowsSafe) {
    // 注意：segment.button(row) → { type:'button', data:[row] }；适配器按 data 逐行取按钮，
    // 不能把返回值展开（对象不可迭代，且一行应只产出一个 button 段）。
    built.push(s.button(row))
  }
  return built
}

/**
 * 组装一条「markdown + 可选 @ + 可选按钮」的消息段（供 e.reply 使用）。
 * @param {object} e 事件
 * @param {string|object} markdown markdown 文本或模板对象
 * @param {object} [opts]
 * @param {object|object[]} [opts.atSender] 已构造的 at 段（多次传入会合并）
 * @param {Array} [opts.keyboard] 按钮行（normalizeKeyboard 入参）
 * @param {string} [opts.ownerId] 回调按钮默认允许点击者
 * @param {boolean} [opts.allowPublic] 允许按钮 public
 * @returns {object|null} 单段或段数组；能力缺失返回 null
 */
export function buildMarkdownMessage(e, markdown, { atSender = null, keyboard = null, ownerId = '', allowPublic = false } = {}) {
  const md = markdownSegment(markdown)
  if (!md) return null
  const parts = []
  if (atSender) {
    if (Array.isArray(atSender)) parts.push(...atSender.filter(Boolean))
    else parts.push(atSender)
  }
  parts.push(md)
  if (Array.isArray(keyboard) && keyboard.length) {
    const kb = keyboardSegments(keyboard, { ownerId: ownerId || rawUserId(e), allowPublic })
    if (kb.length) parts.push(...kb)
  }
  return parts.length === 1 ? parts[0] : parts
}

/**
 * 轻量 markdown → 纯文本（官方不可用 / 发送失败时的降级；不追求完美，只保证可读）。
 */
export function markdownToPlain(md) {
  let s = str(md)
  if (!s) return ''
  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => code.trim())
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/!\[[^\]]*\]\(([^)]+)\)/g, '$1')
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => (text && text !== url ? `${text}（${url}）` : url))
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  s = s.replace(/^\s*>\s?/gm, '')
  s = s.replace(/^\s*[-*+]\s+/gm, '· ')
  s = s.replace(/^\s*(\d+)\.\s+/gm, '$1. ')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
  s = s.replace(/~~([^~]+)~~/g, '$1')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/**
 * 按行切分 markdown（尽量不破坏代码块 / 段落），每段不超过 maxChars。
 * @param {string} md
 * @param {number} [maxChars]
 * @returns {string[]}
 */
export function splitMarkdown(md, maxChars = MARKDOWN_MAX_CHARS) {
  const text = str(md)
  const cap = Math.max(200, Number(maxChars) || MARKDOWN_MAX_CHARS)
  if (text.length <= cap) return text ? [text] : []
  const chunks = []
  let buf = ''
  let inFence = false
  const flush = () => {
    if (buf.trim()) chunks.push(buf)
    buf = ''
  }
  for (const rawLine of text.split('\n')) {
    let line = rawLine
    const isFence = /^\s*(```|~~~)/.test(line)
    // 单行超长：硬切
    while (line.length > cap) {
      if (buf) flush()
      chunks.push(line.slice(0, cap))
      line = line.slice(cap)
    }
    const would = buf ? buf.length + 1 + line.length : line.length
    if (would > cap) {
      if (inFence) {
        // 代码块跨段：补闭合围栏，下一段重新打开
        buf += '\n```'
        flush()
        buf = '```\n'
      } else flush()
    }
    buf = buf ? `${buf}\n${line}` : line
    if (isFence) inFence = !inFence
  }
  if (inFence) buf += '\n```'
  flush()
  return chunks
}

/**
 * 诊断信息：给 `/uid`、`/groupid` 与日志用。
 * @param {object} e 事件
 * @param {object} [scope] deriveScope 结果（可选，避免重复推导）
 */
export function describeContext(e, scope = null) {
  const adapter = detectAdapter(e)
  const kind = contextKind(e, adapter)
  const s = scope || deriveScope(e, true)
  const guild = splitGuildId(e)
  return {
    adapterKind: adapter.kind,
    adapterId: adapter.adapterId,
    adapterName: adapter.adapterName,
    official: adapter.official,
    reason: adapter.reason,
    contextKind: kind,
    contextLabel: contextLabel(e, adapter),
    selfId: str(e?.self_id || e?.bot?.uin),
    fullUserId: str(e?.user_id),
    rawUserId: rawUserId(e),
    fullGroupId: str(e?.group_id),
    rawGroupId: rawGroupId(e),
    guildId: guild?.guildId || '',
    channelId: guild?.channelId || '',
    scopeId: s.scopeId,
    scopeUserId: s.scopeUserId,
    isGroup: s.isGroup,
  }
}

export default {
  MARKDOWN_MAX_CHARS,
  KEYBOARD_MAX_ROWS,
  KEYBOARD_MAX_PER_ROW,
  detectAdapter,
  contextKind,
  contextLabel,
  stripSelfPrefix,
  rawUserId,
  rawGroupId,
  splitGuildId,
  safeScopePart,
  deriveScope,
  hasMarkdownSegment,
  hasButtonSegment,
  markdownSegment,
  normalizeKeyboard,
  keyboardSegments,
  buildMarkdownMessage,
  markdownToPlain,
  splitMarkdown,
  describeContext,
}
