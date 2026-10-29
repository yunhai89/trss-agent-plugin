/**
 * 群消息本地环形缓存 —— 协议端没有历史消息 API 时的兜底。
 *
 * 背景：QQ 官方机器人 OpenAPI 只提供「发送/撤回群消息」，**没有拉取群历史消息的接口**
 * （2026-10 官方文档确认）。因此 `get_chat_history` 在官方 bot 下必然拿不到历史。
 *
 * 方案：进程内按群保留机器人实际收到过的最近消息，供 `get_chat_history` 和情境补全使用。
 *  - 默认每群 200 条 / 24 小时 TTL；只在内存，不落盘，重启即清空；
 *  - 只保存归一化后的文本与发送者，不保存原始媒体/大对象；
 *  - 按 message_id 去重，适配器重复投递不会重复计数。
 *
 * 这不是完整历史：没开「全量消息」时只能看到 @ 机器人的消息；要完整群聊请开官方平台的
 * 「接收所有消息」权限，或启用群世界/伪人旁听（它们有自己的持久化存储）。
 */
import { messageToText } from '../perception.js'

const DEFAULT_MAX = 200
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_GROUPS = 200
const _groups = new Map() // groupId -> Array<{ message_id, user_id, sender, time, message }>

function toSeconds(v, now = Date.now()) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return Math.floor(now / 1000)
  return Math.floor(n > 1e12 ? n / 1000 : n) // 兼容秒/毫秒
}

/**
 * 记录一条群消息（非群/空文本自动忽略）。
 * @param {object} e Yunzai 事件
 * @param {object} [opts] { now?, max?, ttlMs? }（测试注入）
 * @returns {boolean} 是否新增
 */
export function recordGroupMessage(e, { now = Date.now(), max = DEFAULT_MAX, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!e?.isGroup || !e?.group_id) return false
  const groupId = String(e.group_id)
  const text = messageToText(e) || String(e.raw_message || e.msg || '').trim()
  if (!text) return false

  const messageId = e.message_id != null
    ? String(e.message_id)
    : `local-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const list = _groups.get(groupId) || []
  if (list.some((m) => String(m.message_id) === messageId)) return false

  list.push({
    message_id: messageId,
    user_id: String(e.user_id ?? e.sender?.user_id ?? ''),
    sender: {
      card: String(e.sender?.card || ''),
      nickname: String(e.sender?.nickname || e.sender?.name || ''),
    },
    time: toSeconds(e.time, now),
    message: [{ type: 'text', text }],
  })

  const cutoff = now - Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS)
  _groups.delete(groupId) // 刷新 LRU 顺序
  _groups.set(groupId, list.filter((m) => m.time * 1000 >= cutoff).slice(-Math.max(1, Number(max) || DEFAULT_MAX)))
  while (_groups.size > DEFAULT_MAX_GROUPS) _groups.delete(_groups.keys().next().value)
  return true
}

/**
 * 取某群最近 count 条本地缓存（时间正序）。
 * @param {string} groupId
 * @param {number} [count]
 * @param {object} [opts] { now?, ttlMs? }
 * @returns {Array<object>}
 */
export function recentGroupMessages(groupId, count = 20, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!groupId) return []
  const cutoff = now - Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS)
  const n = Math.max(1, Math.min(200, Number(count) || 20))
  return (_groups.get(String(groupId)) || [])
    .filter((m) => m.time * 1000 >= cutoff)
    .slice(-n)
    .map((m) => ({ ...m, sender: { ...m.sender }, message: m.message.map((s) => ({ ...s })) }))
}

/** 清空缓存（groupId 省略=全部），供测试/隐私清理。 */
export function resetGroupHistory(groupId = null) {
  if (groupId == null) _groups.clear()
  else _groups.delete(String(groupId))
}

/** 当前群缓存条数（测试/诊断）。 */
export function groupHistorySize(groupId) {
  return (_groups.get(String(groupId)) || []).length
}

export default { recordGroupMessage, recentGroupMessages, resetGroupHistory, groupHistorySize }
