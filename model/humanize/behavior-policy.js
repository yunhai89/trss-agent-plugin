/**
 * BehaviorPolicy —— 「何时参与」的行为政策（指南 §14.1）。
 *
 * 与 PersonaVoice（怎么说，现有）分离：BehaviorPolicy 决定机器人何时、对什么话题参与。
 * 环境运行时按「机器人+群」绑 Persona，不沿用某用户 Direct Agent 人设。
 *
 * 可被群级覆盖（store.setGroupConfig）；resolveBehaviorPolicy 合并默认 + 群覆盖。
 */

export const DEFAULT_BEHAVIOR_POLICY = Object.freeze({
  topics: [],                              // 角色关注主题（命中 +10~25）
  avoidTopics: [],                         // 回避主题（命中应沉默/谨慎）
  initiative: 0.35,                        // 主动性 0~1（影响 talkValue 基线）
  humor: 0.4,                              // 幽默倾向 0~1
  answerUnknownQuestions: false,           // 是否回答不确定的问题（false=宁可不说也不编）
  interruptHumanConversation: false,       // 是否允许打断顺畅的人类对话
  maxRepliesPer10Minutes: 4,               // 10 分钟内最大回复数（频率硬上限）
})

/**
 * 合并默认政策 + 群级覆盖（深合并，数组替换）。
 * @param {object} [groupOverride]
 * @returns {object}
 */
export function resolveBehaviorPolicy(groupOverride) {
  if (!groupOverride || typeof groupOverride !== 'object') return { ...DEFAULT_BEHAVIOR_POLICY }
  const out = { ...DEFAULT_BEHAVIOR_POLICY }
  for (const k of Object.keys(DEFAULT_BEHAVIOR_POLICY)) {
    if (k in groupOverride) out[k] = groupOverride[k]
  }
  // topics/avoidTopics 必须是数组
  out.topics = Array.isArray(out.topics) ? out.topics : []
  out.avoidTopics = Array.isArray(out.avoidTopics) ? out.avoidTopics : []
  return out
}

/** 文本是否命中主题（最小实现：关键词 includes；多词命中加分）。 */
export function topicMatch(text, topics = []) {
  const t = String(text || '')
  if (!t || !Array.isArray(topics) || !topics.length) return 0
  let hits = 0
  for (const raw of topics) {
    const kw = String(raw || '').trim()
    if (kw.length >= 2 && t.includes(kw)) hits++
  }
  return hits
}

/** 命中主题的分值（指南 +10~25）：1 个命中 +10，2 个 +18，3+ 个 +25。无命中 0。 */
export function topicMatchScore(text, topics = []) {
  const hits = topicMatch(text, topics)
  if (hits <= 0) return 0
  if (hits === 1) return 10
  if (hits === 2) return 18
  return 25
}

/** 文本是否命中回避主题（命中 → 倾向沉默）。 */
export function hitsAvoidTopic(text, avoidTopics = []) {
  return topicMatch(text, avoidTopics) > 0
}

/**
 * 频率上限检查：最近 windowMs 内机器人回复数是否超 maxReplies。
 * @param {number[]} recentReplyTs 最近回复时间戳数组（ms）
 * @param {number} maxReplies
 * @param {number} windowMs 默认 10 分钟
 */
export function withinReplyRate(recentReplyTs = [], maxReplies = 4, windowMs = 10 * 60 * 1000, now = Date.now()) {
  const cutoff = now - windowMs
  const count = recentReplyTs.filter((ts) => Number.isFinite(ts) && ts >= cutoff).length
  return { within: count < maxReplies, count, maxReplies }
}
