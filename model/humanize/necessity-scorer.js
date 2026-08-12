/**
 * NecessityScorer —— 确定性回复必要性评分（纯函数，指南 §9.2）。
 *
 * 输入一批待处理外部消息 + presence 统计，输出 NecessityDecision。
 * 绝大多数普通消息在此被廉价筛掉，不进 Planner（指南：规则先于 LLM）。
 *
 * 公式（指南 §9.2）：
 *   raw = relevance + content + pressure + idleBonus
 *         - presencePenalty - cooldownPenalty - directionPenalty
 *   强信号（relevance >= 80）：final = clamp(raw, 0, 120)            // 不乘频率倍率（强制候选）
 *   普通：                  final = clamp(raw * freqMul, 0, 120)
 *   freqMul = 0.5 + 0.5 * talkValue
 *   shouldPlan = final >= threshold(默认 80)
 *
 * @、引用、提及等强关联已在 relevance 体现；@ 由 Direct Agent 接管，环境模式主要走 quotesBot/mentionsBotName/追问。
 */

/**
 * @typedef {Object} NecessityDecision
 * @property {number} rawScore
 * @property {number} finalScore
 * @property {number} threshold
 * @property {boolean} shouldPlan
 * @property {boolean} forcedCandidate   强信号强制候选（不乘频率倍率）
 * @property {string[]} positiveReasons
 * @property {string[]} negativeReasons
 * @property {{relevance:number,content:number,pressure:number,idleBonus:number,presencePenalty:number,cooldownPenalty:number,directionPenalty:number,freqMul:number}} components
 * @property {object} targetMessage      候选目标消息（得分最高的那条）
 */

// —— 内容特征词表（移植 MaiBot reply_necessity.py 的中文词集，指南 §9.2）——
const QUESTION_TERMS = ['怎么', '如何', '为什么', '有没有', '啥', '吗？', '吗?', '什么']
const DIRECT_REQUEST_TERMS = ['帮我', '帮忙', '能不能', '可以吗', '要不要', '能不能帮', '谁能让', '能不能给']
const WEAK_REQUEST_TERMS = ['需要', '求', '看看', '试试', '有没有人']
const OPINION_TERMS = ['你觉得', '你认为', '咋看', '有什么建议', '你们觉得', '大家觉得']
const SHORT_REACTIONS = new Set(['哈哈', '哈哈哈', '草', '笑死', '好', '嗯', '啊', '哦', '6', '666', '？', '?', '哈', '对', '是的', '牛', '卧槽', 'nb', 'NB'])
// 叫群里另一个人（@他人 / 明确称呼）的弱信号
const OTHER_ADDRESSEE = /@(?:\d+|[Qq][Qq])/ // @QQ号；@昵称难以可靠判定，留 directionPenalty 由 at 段判断

/**
 * 压力分（指南 §9.2 pressureScore）。
 * p<=0→0；p<k→25*(p/k)²；p>=k→min(45, 25+10*log2(1+p-k))。
 */
export function pressureScore(p, k) {
  p = Math.max(0, p | 0)
  k = Math.max(1, k | 0)
  if (p <= 0) return 0
  if (p < k) return Math.round(25 * (p / k) ** 2)
  return Math.min(45, Math.round(25 + 10 * Math.log2(1 + p - k)))
}

/**
 * 在场惩罚（指南 §9.2 presencePenalty）：share<=0.25→0；否则线性到 0.60 满罚 25。
 * 与 MaiBot 的 0.25/0.60 一致（指南 §3.2 也提到约 25% 起扣、最多 -25）。
 */
export function presencePenalty(botCount, totalCount) {
  const total = totalCount | 0
  if (!total) return 0
  const share = Math.min(1, (botCount | 0) / total)
  if (share <= 0.25) return 0
  return Math.min(25, Math.round(((share - 0.25) / 0.35) * 25))
}

/** cooldown 惩罚：剩余冷却越多扣得越多（-30~-100）。 */
export function cooldownPenalty(cooldownUntil, now = Date.now()) {
  if (!cooldownUntil || cooldownUntil <= now) return 0
  const remainSec = Math.max(0, (cooldownUntil - now) / 1000)
  // 60s 内线性 -30~-100
  return Math.round(Math.min(100, 30 + (remainSec / 60) * 70))
}

/** 单条消息的内容分（不含 relevance/pressure）。返回 {score, reasons[]}。 */
function scoreContent(text, { isDirectContext }) {
  const reasons = []
  let score = 0
  const t = String(text || '')
  const len = [...t].length // 按 Unicode 码点计长（中文友好）

  // 极短反应/纯表情/单个语气词（指南 -25）
  const stripped = t.replace(/\s+/g, '')
  if (stripped.length <= 8 && SHORT_REACTIONS.has(stripped)) {
    return { score: -25, reasons: ['short_reaction'] }
  }

  // 疑问句（指南 +15）：需有问意词或问号，且长度适中（避免单「？」误判）
  const isQuestion = /[?？]/.test(t) || QUESTION_TERMS.some((w) => t.includes(w))
  if (isQuestion && len >= 2) { score += 15; reasons.push('question') }

  // 请求/求助/邀请（指南 +20）；弱请求仅在直接上下文计
  const forOtherAI = /^(?:DeepSeek|ChatGPT|Grok|豆包|千问|元宝|通义|Kimi|Claude|文心)[，,、\s]/.test(t)
  if (DIRECT_REQUEST_TERMS.some((w) => t.includes(w))) { score += 20; reasons.push('request') }
  else if (isDirectContext && !forOtherAI && WEAK_REQUEST_TERMS.some((w) => t.includes(w))) { score += 20; reasons.push('weak_request') }

  // 观点（指南 +20）
  if (!forOtherAI && OPINION_TERMS.some((w) => t.includes(w))) { score += 20; reasons.push('opinion') }

  // 长度（指南 +5 if 20-80 字；+10 if >80 字，上限 10）
  if (len >= 80) { score += 10; reasons.push('length_long') }
  else if (len >= 20) { score += 5; reasons.push('length_mid') }

  return { score, reasons }
}

/**
 * 找批次的候选目标消息 + relevance（按最强信号）。
 * relevance（指南 §9.2）：quotesBot +90 / mentionsBotName +80 / 紧接机器人追问 +55 / else 0。
 * 注：@机器人(+100) 由 Direct Agent 接管，环境不从此触发，但保留 +100 分支以防 atBot 漏接管。
 */
function pickTargetAndRelevance(messages) {
  let best = null
  let bestScore = 0
  let bestReason = 'none'
  for (const m of messages) {
    let rel = 0
    let reason = 'none'
    if (m.atBot) { rel = 100; reason = 'at_bot' }
    else if (m.quotesBot) { rel = 90; reason = 'quotes_bot' }
    else if (m.mentionsBotName) { rel = 80; reason = 'mentions_bot_name' }
    else if (isFollowupToBot(m, messages)) { rel = 55; reason = 'followup_to_bot' }
    if (rel > bestScore || best == null) { bestScore = rel; best = m; bestReason = reason }
  }
  return { target: best || (messages[messages.length - 1] || null), relevance: bestScore, reason: bestReason }
}

/** 紧接机器人发言的明确追问：目标消息前一条是 isSelf，且当前是疑问/请求。 */
function isFollowupToBot(msg, messages) {
  const idx = messages.indexOf(msg)
  if (idx <= 0) return false
  const prev = messages[idx - 1]
  if (!prev?.isSelf) return false
  const t = String(msg.text || '')
  return /[?？]/.test(t) || QUESTION_TERMS.some((w) => t.includes(w)) || DIRECT_REQUEST_TERMS.some((w) => t.includes(w))
}

/** directionPenalty：明显在叫群里另一个人（-30）。 */
function directionPenaltyOf(msg) {
  if (!msg) return 0
  // @了别人（非机器人）
  const segs = msg.segments || []
  const atOther = segs.some((s) => s?.type === 'at' && s.qq != null && !msg.atBot)
  if (atOther || OTHER_ADDRESSEE.test(msg.text || '')) return 30
  return 0
}

/**
 * 评估一批待处理消息的回复必要性。
 * @param {object} input { messages: AmbientMessage[], presence, cfg, now? }
 *   presence = { bot, other, total }（来自 buffer.presenceStats(windowMs)）
 *   cfg = { threshold, talkValue, behaviorPolicy?, cooldownUntil?, bypassPendingCount? }
 * @returns {NecessityDecision}
 */
export function evaluate({ messages = [], presence = {}, cfg = {}, now = Date.now() } = {}) {
  const threshold = cfg.threshold ?? 80
  const talkValue = Math.min(1, Math.max(0, cfg.talkValue ?? 0.35))
  const external = messages.filter((m) => m && !m.isSelf && !m.handledByDirectAgent)

  const positive = []
  const negative = []

  if (!external.length) {
    return { rawScore: 0, finalScore: 0, threshold, shouldPlan: false, forcedCandidate: false,
      positiveReasons: [], negativeReasons: [],
      components: { relevance: 0, content: 0, pressure: 0, idleBonus: 0, presencePenalty: 0, cooldownPenalty: 0, directionPenalty: 0, freqMul: 0 },
      targetMessage: null }
  }

  // —— relevance + 目标候选 ——
  const { target, relevance, reason } = pickTargetAndRelevance(external)
  if (relevance > 0) positive.push(reason)

  // —— content（按目标消息；强关联算直接上下文）——
  const isDirectContext = relevance >= 55
  const c = scoreContent(target?.text || '', { isDirectContext })
  if (c.score > 0) positive.push(...c.reasons)
  else if (c.score < 0) negative.push(...c.reasons)

  // —— 命中角色关注主题（指南 +10~25；由 scheduler 经 behavior-policy 计算后传入，避免循环依赖）——
  const topicBonus = Math.max(0, Math.min(25, cfg.topicBonus | 0))
  if (topicBonus > 0) positive.push('topic_match')

  // —— pressure（待处理条数 → pendingThreshold = ceil(1/talkValue²)）——
  const pendingThreshold = talkValue > 0 ? Math.max(1, Math.ceil(1 / (talkValue * talkValue))) : 1
  const pressure = pressureScore(external.length, pendingThreshold)
  if (pressure > 0) positive.push(`pressure(${external.length}/${pendingThreshold})`)

  // —— idleBonus（空闲补偿：群变慢后适度提高参与机会）——
  // presence.recentExternalIntervals 平均间隔；idle 秒 = now - lastExternalAt
  const intervals = presence.recentExternalIntervals || []
  const avgInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0
  const idleSec = presence.lastExternalAt ? Math.max(0, (now - presence.lastExternalAt) / 1000) : 0
  const idleReachedAvg = avgInterval > 0 && idleSec >= avgInterval
  const idleBonus = idleReachedAvg ? 15 : 0
  if (idleBonus > 0) positive.push('idle_bonus')

  // —— penalties ——
  const presencePen = presencePenalty(presence.bot || 0, presence.total || 0)
  if (presencePen > 0) negative.push(`presence(${((presence.bot || 0) / Math.max(1, presence.total || 1) * 100).toFixed(0)}%)`)
  const cdPen = cfg.cooldownUntil ? cooldownPenalty(cfg.cooldownUntil, now) : 0
  if (cdPen > 0) negative.push('cooldown')
  const dirPen = directionPenaltyOf(target)
  if (dirPen > 0) negative.push('other_addressee')

  // —— 合成 ——
  const rawScore = relevance + c.score + topicBonus + pressure + idleBonus - presencePen - cdPen - dirPen
  const forcedCandidate = relevance >= 80 // 强信号不乘频率倍率
  const freqMul = 0.5 + 0.5 * talkValue
  const finalScore = Math.round(Math.max(0, Math.min(120, forcedCandidate ? rawScore : rawScore * freqMul)))
  const shouldPlan = finalScore >= threshold

  // —— 强信号绕过退避（指南 §9.3）：forcedCandidate 或 pending>=bypassPendingCount ——
  return {
    rawScore,
    finalScore,
    threshold,
    shouldPlan,
    forcedCandidate,
    positiveReasons: positive,
    negativeReasons: negative,
    components: { relevance, content: c.score, topicBonus, pressure, idleBonus, presencePenalty: presencePen, cooldownPenalty: cdPen, directionPenalty: dirPen, freqMul },
    targetMessage: target,
    // 辅助：是否应绕过 idle backoff
    bypassBackoff: forcedCandidate || external.length >= (cfg.bypassPendingCount ?? 6),
  }
}

export const __test__ = { pressureScore, presencePenalty, cooldownPenalty, scoreContent, SHORT_REACTIONS }
