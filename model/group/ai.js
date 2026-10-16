/**
 * AI 语音工具（内置）—— NapCat 原生 AI 接口。
 *
 * get_ai_characters：获取可用 AI 语音角色（读）。
 * ai_tts (get_ai_record)：文字转 AI 语音，返回语音文件信息（读）。
 * send_group_ai_record：在群内发送 AI 语音消息（写消息，message 类别）。
 *
 * 注：QQ 的 AI 语音能力受账号/地区限制，部分账号可能不可用（调用会返回错误）。
 */

import { defineTool, param, groupIdOf, groupScopeError, sendApi } from '../toolkit/index.js'

function needGid(ctx, groupId) {
  const scopeErr = groupScopeError(ctx, groupId)
  if (scopeErr) return { error: scopeErr }
  return groupIdOf(ctx, groupId) || null
}

/** get_ai_characters：获取可用 AI 语音角色 */
export const getAiCharactersTool = defineTool({
  name: 'get_ai_characters',
  description: '获取可用的 AI 语音角色列表（用于 ai_tts / send_group_ai_record 的 character 参数）。',
  category: 'query',
  meta: { summary: '查AI语音角色' },
  parameters: param.object({
    groupId: param.str('群号（可选，取该群可用角色）'),
  }),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    if (gid?.error) return gid
    const r = await sendApi(ctx, 'get_ai_characters', gid ? { group_id: gid } : {})
    if (!r.ok) return { error: r.error }
    const list = Array.isArray(r.data) ? r.data : []
    return { count: list.length, characters: list }
  },
})

/** ai_tts：文字转 AI 语音（返回语音文件信息，不直接发送） */
export const aiTtsTool = defineTool({
  name: 'ai_tts',
  description: '把文字转成 AI 语音，返回语音文件信息（不直接发送；如需直接发到群里用 send_group_ai_record）。character 必填：用 get_ai_characters 查询可用角色 id。',
  category: 'query',
  meta: { summary: '文字转AI语音' },
  parameters: param.object({
    text: param.str('要转语音的文字'),
    character: param.str('角色 id（必填，用 get_ai_characters 查询）'),
    groupId: param.str('群号（可选）'),
  }, ['text', 'character']),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    if (gid?.error) return gid
    if (!gid) return { error: '当前非群聊且未指定 groupId（AI 语音需群上下文）' }
    const r = await sendApi(ctx, 'get_ai_record', {
      group_id: gid, text: String(p.text),
      ...(p.character ? { character: String(p.character) } : {}),
    })
    if (!r.ok) return { error: r.error }
    return { ok: true, ...((r.data && typeof r.data === 'object') ? r.data : { file: r.data }) }
  },
})

/** send_group_ai_record：群内发送 AI 语音 */
export const sendGroupAiRecordTool = defineTool({
  name: 'send_group_ai_record',
  description: '把文字合成 AI 语音并直接发到当前群（message 写操作）。character 必填：用 get_ai_characters 查询可用角色 id。',
  category: 'message',
  meta: { summary: '群内发AI语音', interactive: true },
  parameters: param.object({
    text: param.str('要转语音并发送的文字'),
    character: param.str('角色 id（必填，用 get_ai_characters 查询）'),
    groupId: param.str('群号（可选，默认当前群）'),
  }, ['text', 'character']),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    // 修 2026-10-17 审计：此处漏判 needGid 的跨群守卫错误对象（同文件另两个工具都判 gid?.error），
    // 会把 {error:'目标群 X 不是当前会话群 Y…'} 当成 group_id 发给协议端 → 守卫失效、报错误导。
    if (gid?.error) return gid
    if (!gid) return { error: '当前非群聊且未指定 groupId' }
    const r = await sendApi(ctx, 'send_group_ai_record', {
      group_id: gid, text: String(p.text),
      ...(p.character ? { character: String(p.character) } : {}),
    })
    if (!r.ok) return { error: r.error }
    return { ok: true, groupId: gid, sent: true }
  },
})

export const aiVoiceTools = [getAiCharactersTool, aiTtsTool, sendGroupAiRecordTool]
