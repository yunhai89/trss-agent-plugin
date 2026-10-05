/**
 * 合并转发工具（内置）—— NapCat 原生 send_*_forward_msg / get_forward_msg。
 *
 * send_forward_msg：发送合并转发（群/私聊自适应）。
 * get_forward_msg：获取合并转发消息内容（按 resid/message_id）。
 *
 * 节点(messages)格式（OneBot node 段）：每项 {
 *   uin?: "发送者QQ", name?: "发送者昵称",      // 自定义发送者
 *   id?: "已有消息id",                           // 引用已存在消息
 *   content: "文本" | 消息段数组                  // 该节点内容
 * }
 */

import { defineTool, param, groupIdOf, sendApi } from '../toolkit/index.js'
import { fetchForwardNodes, flattenForwardNodes, formatTranscript, analyzeMessages, resolveForwardId } from './chat-record.js'

/** 单个消息段归一为 OneBot 段 {type, data}（LLM 可能给扁平 {type,...} 或已是 {type,data}） */
function normSegment(s) {
  if (typeof s === 'string') return { type: 'text', data: { text: s } }
  if (!s || typeof s !== 'object') return { type: 'text', data: { text: String(s ?? '') } }
  if (s.data && typeof s.data === 'object') return s
  const { type, ...rest } = s
  return { type: type || 'text', data: rest }
}

/** 节点 content 归一：字符串原样（NapCat 会解析 CQ 码）；数组逐段归一；单段对象包成数组 */
function normContent(c) {
  if (Array.isArray(c)) return c.map(normSegment)
  if (typeof c === 'string') return c
  if (c && typeof c === 'object') return [normSegment(c)]
  return ''
}

/**
 * 归一转发节点为 NapCat 要求的 {type:'node', data:{content,user_id,nickname}} 形状。
 *
 * 关键：NapCat 的 send_*_forward_msg 只把 `type==='node'` 的元素当转发节点（其 data 里读
 * content/user_id/nickname）；裸 {uin,name,content} 会被当成普通消息段，因 `type` 为 undefined
 * 直接报「未知的消息类型：undefined」。本工具历史上正是这样透传 LLM 给的裸节点。
 */
export function normalizeForwardNodes(messages) {
  return (messages || []).map((n) => {
    if (n && n.type === 'node' && n.data && typeof n.data === 'object') return n // 已是原生 node
    const data = {}
    if (n?.id != null) {
      data.id = String(n.id) // 引用已有消息
    } else {
      data.content = normContent(n?.content)
      const uid = n?.uin ?? n?.user_id
      if (uid != null && uid !== '') data.user_id = String(uid)
      const nick = n?.name ?? n?.nickname
      if (nick) data.nickname = String(nick)
    }
    return { type: 'node', data }
  })
}

/** send_forward_msg：发送合并转发；群→send_group_forward_msg，私聊→send_private_forward_msg */
export const sendForwardMsgTool = defineTool({
  name: 'send_forward_msg',
  description: '发送合并转发消息（多条消息打包成一条转发卡片）。messages 为节点数组，每项 {uin,name,content} 或 {id}。群聊发群、私聊发好友（按 groupId/userId 自适应）。',
  category: 'message',
  meta: { summary: '发送合并转发', interactive: true },
  parameters: param.object({
    messages: {
      type: 'array',
      description: '转发节点数组。每项：{ uin:"发送者QQ", name:"昵称", content:"文本或消息段数组" }；或 { id:"已有消息id" }',
      items: { type: 'object' },
    },
    groupId: param.str('目标群号（群聊转发，与 userId 二选一；默认当前群）'),
    userId: param.str('目标 QQ 号（私聊转发，与 groupId 二选一）'),
  }, ['messages']),
  async execute(p, ctx) {
    if (!Array.isArray(p.messages) || !p.messages.length) return { error: 'messages 需为非空节点数组' }
    const gid = groupIdOf(ctx, p.groupId)
    const uid = p.userId ? String(p.userId) : null
    const target = gid ? 'group' : uid ? 'private' : null
    if (!target) return { error: '需指定目标（群聊或 userId）；当前会话无法判断' }
    const action = target === 'group' ? 'send_group_forward_msg' : 'send_private_forward_msg'
    const nodes = normalizeForwardNodes(p.messages)
    const params = target === 'group'
      ? { group_id: gid, messages: nodes }
      : { user_id: uid, messages: nodes }
    const r = await sendApi(ctx, action, params)
    if (!r.ok) return { error: r.error }
    return { ok: true, target, groupId: gid || null, userId: uid || null, messageId: r.data?.message_id ?? null, resId: r.data?.res_id ?? r.data?.resid ?? null }
  },
})

/**
 * get_forward_msg：读取合并转发（聊天记录卡片）的完整内容。
 * 修形状：NapCat 返回节点是 `{type:'node',data:{user_id,nickname,message}}`（旧实现按 n.content/n.sender 读 → 取不到）。
 * 支持自动定位：未传 messageId/resid 时，自动取当前消息或引用消息里的转发卡片。
 */
export const getForwardMsgTool = defineTool({
  name: 'get_forward_msg',
  description: '获取合并转发（聊天记录卡片）的完整内容（各节点昵称/时间/文本）。用户发来或引用了转发卡片时用它解析；需要统计/总结用 analyze_chat_record。',
  category: 'query',
  meta: { summary: '读取合并转发', resultCap: 12000 },
  parameters: param.object({
    messageId: param.str('转发卡片的 message_id / resid（留空则自动取当前消息或引用消息里的转发卡片）'),
  }),
  async execute(p, ctx) {
    const id = resolveForwardId(ctx, p || {})
    if (!id) return { error: '未找到转发卡片：请直接发送/引用该聊天记录，或传入 messageId/resid' }
    const { nodes, error } = await fetchForwardNodes(sendApi, ctx, id)
    if (error) return { error }
    const messages = flattenForwardNodes(nodes)
    if (!messages.length) return { error: '转发内容为空或已过期（NapCat 仅能取仍在服务器保留期的记录）' }
    const { text, truncated, total } = formatTranscript(messages, { maxChars: 10000 })
    return { ok: true, count: total, truncated, transcript: text }
  },
})

/**
 * analyze_chat_record：分析用户发送/引用的「合并聊天记录」卡片（可能来自别的群）。
 * 拉全文 → 归一 → 确定性统计（条数/时间跨度/发言排行/关键词/链接）→ 返回可总结的转录文本。
 */
export const analyzeChatRecordTool = defineTool({
  name: 'analyze_chat_record',
  description: '分析用户发送/引用的「合并聊天记录」卡片（可能来自其他群）：拉取全文并给出条数、时间跨度、发言排行、关键词等统计 + 可总结的转录文本。何时用：用户转发聊天记录并让你总结/分析/看谁说了什么/提取要点时。',
  category: 'query',
  meta: { summary: '分析聊天记录', resultCap: 14000 },
  parameters: param.object({
    messageId: param.str('转发卡片的 message_id/resid（留空自动取当前或引用的卡片）'),
    question: param.str('用户的分析诉求（如"总结重点"/"谁在吵架"），用于引导你的总结'),
  }),
  async execute(p, ctx) {
    const id = resolveForwardId(ctx, p || {})
    if (!id) return { error: '未找到聊天记录卡片：请直接发送/引用该记录，或传入 messageId/resid' }
    const { nodes, error } = await fetchForwardNodes(sendApi, ctx, id)
    if (error) return { error }
    const messages = flattenForwardNodes(nodes)
    if (!messages.length) return { error: '聊天记录为空或已过期（NapCat 仅能取仍在服务器保留期的记录）' }
    const stats = analyzeMessages(messages)
    const { text, truncated, total } = formatTranscript(messages, { maxChars: 9000 })
    return {
      ok: true,
      total,
      stats: { total: stats.total, timeSpan: stats.spanText, topSenders: stats.senders, keywords: stats.keywords, links: stats.links },
      truncated,
      transcript: text,
      ...(truncated ? { hint: '记录较长，以上为头尾节选；需要特定部分请让用户指明发送者或关键词' } : {}),
      ...(p?.question ? { question: String(p.question) } : {}),
    }
  },
})

export const forwardTools = [sendForwardMsgTool, getForwardMsgTool, analyzeChatRecordTool]
