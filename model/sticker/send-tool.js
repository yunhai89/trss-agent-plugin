/**
 * send_sticker 工具 —— 按情绪/场景跨全库自动选表情（MaiBot send_emoji 的对应物）。
 *
 * 库很大（自动发现可积累数百张）时，目录注入受 top-N 限制无法列全；
 * LLM 调本工具描述情绪，由 manager.pickByEmotion 按标签相似度选一张，返回名称。
 * LLM 再在回复正文里用 [sticker:名称] 插入（复用既有渲染管线）。
 */

/**
 * @param {object} manager StickerManager 实例
 * @returns {object} ToolRegistry 可注册的工具定义
 */
export function makeSendStickerTool(manager) {
  return {
    name: 'send_sticker',
    description: '按情绪/场景从表情包库自动选一张合适的表情。库很大时无需记名称，描述想要的情绪/场景即可（如「开心」「赞同」「无奈」「摸鱼」「666」）。选中后在回复正文里用 [sticker:名称] 插入该表情。',
    category: 'query',
    parameters: {
      type: 'object',
      required: ['emotion'],
      properties: {
        emotion: { type: 'string', description: '想要表达的情绪/场景/语气（可多个，空格分隔）', maxLength: 60 },
      },
      additionalProperties: false,
    },
    meta: { resultCap: 400 },
    async execute(args = {}) {
      const emotion = String(args?.emotion || '').trim()
      if (!emotion) return { ok: false, error: '缺少 emotion' }
      if (!manager?.enabled?.()) return { ok: false, error: '表情包未启用' }
      const name = manager.pickByEmotion(emotion)
      if (!name) return { ok: false, error: 'no_match', hint: '库中暂无表情，或都无匹配标签' }
      return {
        ok: true,
        name,
        hint: `在回复正文里写 [sticker:${name}] 即可附上这张表情（仅写标记，不要解释）。`,
      }
    },
  }
}
