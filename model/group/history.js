/**
 * 群聊历史记录检索（被动找回）—— 模型判断需要更多上下文时主动调用。
 *
 * 与 perception 的"主动注入"（首次入群/久离补课/会话稀薄时自动塞一段）互补：
 * 主动注入只在少数触发点发生；当模型在对话中途发现上下文不够（用户引用了不在窗口里的内容、
 * 说"刚才那个/前面说的"等），可调用本工具按需拉取近期群聊原文，补足会话窗口之外的信息。
 *
 * 数据源两级：
 *  1) 协议端 `getChatHistory`（OneBot/NapCat 等）——能力探测后分页拉取；
 *  2) 本地环形缓存（QQ 官方机器人没有历史消息 API）——见 history-store.js。
 *
 * 通过 ctx 读取运行时（ctx.e = Yunzai 事件，ctx.bot = Bot 句柄）。
 */

import { formatHistory } from '../perception.js'
import { recentGroupMessages } from './history-store.js'

function pickGroup(ctx) {
  return ctx?.e?.group || ctx?.bot?.pickGroup?.(ctx?.e?.group_id) || null
}

/**
 * get_chat_history：拉取当前群最近的聊天记录（群友发言，时间正序）。
 * 何时不调：私聊不可用；当前窗口已有足够上下文时无需调用（省 token）。
 */
export const chatHistoryTool = {
  name: 'get_chat_history',
  description: '获取当前群最近的聊天记录（所有群友的发言，按时间正序，已剔除你自己刚发的这条）。协议端支持历史接口时直接拉取；QQ 官方机器人等不支持时会用机器人本地已接收消息缓存兜底。何时用：用户提到"刚才/前面/上面说的"、引用了不在你记忆里的内容，或你感觉缺少上下文无法准确回答时，调用本工具拉取近期群聊补全。私聊不可用。',
  category: 'query',
  meta: { resultCap: 12000 },
  parameters: {
    type: 'object',
    properties: {
      count: { type: 'integer', description: '拉取条数（默认 20，上限 50）' },
    },
  },
  async execute(params, ctx) {
    params = params || {} // 模型无参调用时 args 可能为 null/undefined（通道未给 arguments 字段），防空
    const e = ctx?.e
    const groupId = String(e?.group_id || ctx?.groupId || '')
    const g = pickGroup(ctx)
    const want = Math.min(50, Math.max(1, Number(params.count) || 20))
    const protocolSupported = !!(g && typeof g.getChatHistory === 'function')
    let protocolError = null
    const acc = []

    if (protocolSupported) {
      try {
        // NapCat 等 OneBot 端 get_group_msg_history 单次返回有限（常 ≤20 条，部分端更少），
        // 向前翻页累积凑满 want：按 message_id 去重，以"本批最旧消息"为下一页锚点继续向前，
        // 最后按时间正序取最近 want 条。有界 MAX_PAGES + 无进展即停，防死循环。
        // 注：不再按 isolation 过滤成"仅自己"——本工具用途就是看群友上下文，滤成只剩自己会使工具失效。
        const MAX_PAGES = 8
        let anchor = e?.seq ?? e?.message_id ?? e?.source?.seq ?? undefined
        const seen = new Set()
        for (let page = 0; page < MAX_PAGES && acc.length < want; page++) {
          const batch = [].concat((await g.getChatHistory(anchor, want)) || [])
          if (!batch.length) break
          let added = 0
          let oldest = null
          for (const m of batch) {
            if (!m) continue
            const mid = m.message_id
            if (mid != null && seen.has(mid)) continue
            if (mid != null) seen.add(mid)
            acc.push(m); added++
            if (!oldest || (m.time ?? 0) < (oldest.time ?? 0)) oldest = m
          }
          const next = oldest?.message_seq ?? oldest?.seq ?? oldest?.message_id
          if (!next || next === anchor || added === 0) break // 无更早记录 / 无进展 → 停（防死循环）
          anchor = next
        }
      } catch (err) {
        protocolError = err
      }
    }

    // 协议端不支持 / 返回空 / 调用失败 → 用机器人实际收到过的本地缓存兜底。
    if (groupId && !acc.length) {
      const local = recentGroupMessages(groupId, want)
      if (local.length) {
        // 本地缓存是时间正序；formatHistory 契约入参「最新在前」，先翻转，内部再翻回正序。
        const lines = formatHistory(local.slice(-want).reverse(), e, want)
        if (lines.length) return { count: lines.length, history: lines.join('\n'), source: 'local' }
      }
    }

    if (!groupId) return { error: '当前会话非群聊或协议端不支持聊天记录查询' }
    if (!protocolSupported) {
      // QQ 官方机器人 OpenAPI 没有群历史接口，这是平台限制而非插件故障；返回 note 让模型改用上下文。
      return {
        count: 0,
        note: ctx?.official
          ? 'QQ 官方机器人没有历史消息 API；本地缓存暂无更早记录（仅能记录机器人实际收到的群消息。要积累完整群聊请开启官方平台「全量消息」）'
          : '协议端不支持聊天记录查询；本地缓存暂无记录',
      }
    }
    if (protocolError) return { error: `取聊天记录失败：${protocolError?.message || protocolError}` }
    return { count: 0, note: '未取到聊天记录（协议端未返回或会话无历史）' }
  },
}

export const groupHistoryTools = [chatHistoryTool]
