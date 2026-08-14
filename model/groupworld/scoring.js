/**
 * Scoring —— GroupWorld 评分纯函数（设计文档 §7）。
 *
 * 全部纯函数、无副作用、不读 DB；调用方（analyzer/evidence/retriever/maintenance）取数据后算。
 * 风格对齐 humanize/necessity-scorer.js：公式集中在文件头注释，函数短小、可单测。
 *
 * §7.1 互动强度：raw = reply×1.0 + mention×0.8 + co×0.25 + reciprocal_bonus×2.0
 *        recency = exp(-days/30)；strength = clamp(log1p(raw)/5 × recency, 0, 1)
 * §7.2 画像置信度：confidence = source_reliability × evidence_saturation × consistency × recency_factor
 *        初始：自述 0.75~0.90；统计可达 0.95；单片 LLM ≤0.45；<0.55 默认不进在线上下文
 * §7.3 记忆重要度：importance = relevanceToBot×.30 + engagement×.20 + recurrence×.20 + emotion×.15 + future×.15
 * §7.4 检索评分：score = targetMatch×.30 + topicSim×.25 + graphProx×.15 + recency×.10 + importance×.10 + confidence×.10
 */

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))
const log1p = (x) => Math.log1p(Math.max(0, Number(x) || 0))

/** 时间衰减因子：exp(-days/halfLife)。halfLife 默认 30 天（§7.1）。 */
export function recencyFactor(days, halfLife = 30) {
  const d = Math.max(0, Number(days) || 0)
  const h = Math.max(1, Number(halfLife) || 30)
  return Math.exp(-d / h)
}

/**
 * §7.1 互动强度。
 * @param {object} e { replyCount, mentionCount, coDialogueCount, reciprocalBonus, daysSince, halfLife? }
 */
export function interactionStrength({ replyCount = 0, mentionCount = 0, coDialogueCount = 0, reciprocalBonus = 0, daysSince = 0, halfLife = 30 } = {}) {
  const raw =
    (Number(replyCount) || 0) * 1.0
    + (Number(mentionCount) || 0) * 0.8
    + (Number(coDialogueCount) || 0) * 0.25
    + (Number(reciprocalBonus) || 0) * 2.0
  const recency = recencyFactor(daysSince, halfLife)
  return clamp01((log1p(raw) / 5) * recency)
}

/**
 * 互惠度（双向往返比）：0~1。两向边计数越均衡越高。
 * @param {number} aToB A→B 互动数
 * @param {number} bToA B→A 互动数
 */
export function reciprocity(aToB, bToA) {
  const a = Number(aToB) || 0
  const b = Number(bToA) || 0
  const sum = a + b
  if (sum <= 0) return 0
  // 双向都有 → 2*min/max 趋近 1；单向 → 0
  return clamp01((2 * Math.min(a, b)) / sum)
}

/**
 * §7.2 source 基线置信（按 source_type）——已校准至文档 stated 初始范围：
 *   统计可达 0.95；本人自述 0.75~0.90；管理员纠正 ~0.92；单片 LLM 推断 ≤0.45。
 * 单证据时这些值即近似最终置信（再经 recency/矛盾/多日期微调）。
 */
export function sourceReliability(sourceType) {
  switch (sourceType) {
    case 'statistical': return 0.92
    case 'admin_corrected': return 0.92
    case 'explicit': return 0.82
    case 'inferred': return 0.32 // 单片 LLM 推断基线 ≤0.45
    default: return 0.30
  }
}

/**
 * §7.2 画像置信度（系统重算，覆盖模型给的候选值）。
 * 校准目标：单证据时 explicit/statistical/admin_corrected ≥0.55（可进在线），
 *   inferred 单证据 <0.55（不进在线），需多个不同日期反复出现才逐步提升。
 * @param {object} o { sourceType, evidenceCount, distinctDates, contradictions, daysSince, halfLife? }
 */
export function confidence({ sourceType = 'inferred', evidenceCount = 1, distinctDates = 1, contradictions = 0, daysSince = 0, halfLife = 90 } = {}) {
  const base = sourceReliability(sourceType)
  const rec = recencyFactor(daysSince, halfLife) // 画像衰减更慢，默认 90 天
  // 矛盾降一致性（出现反例越多越不可信）
  const conPen = 1 - Math.min(0.8, 0.18 * Math.max(0, Number(contradictions) || 0))
  // 多日期反复出现提升（推断尤其需要积累才进在线；显式/统计本就高，提升锦上添花）
  const boost = Math.min(2.0, 1 + 0.15 * Math.max(0, (Number(distinctDates) || 1) - 1))
  return clamp01(base * rec * conPen * boost)
}

// —— 以下保留为可复用的独立因子（confidence 已内联其逻辑），供单测/未来维护 ——
/**
 * §7.2 证据饱和度：证据越多越趋近 1（快速收敛）。
 */
export function evidenceSaturation(evidenceCount) {
  const n = Math.max(0, Number(evidenceCount) || 0)
  return clamp01(1 - Math.exp(-n / 2.5))
}

/**
 * §7.2 一致性系数：不同日期反复出现提升；反例降低。
 */
export function consistency({ distinctDates = 0, contradictions = 0 } = {}) {
  const base = clamp01(0.5 + 0.12 * Math.max(0, Number(distinctDates) || 0))
  const pen = 0.18 * Math.max(0, Number(contradictions) || 0)
  return clamp01(base - pen)
}

/** 在线上下文最低置信度门槛（§7.2：<0.55 默认不进）。 */
export const DEFAULT_MIN_ONLINE_CONFIDENCE = 0.55

/**
 * §7.3 记忆重要度（不只用情绪强度，避免争吵占满记忆）。
 * @param {object} o 各分量 0~1
 */
export function importance({ relevanceToBot = 0, participantEngagement = 0, recurrence = 0, emotionalSalience = 0, futureUsefulness = 0 } = {}) {
  return clamp01(
    clamp01(relevanceToBot) * 0.30
    + clamp01(participantEngagement) * 0.20
    + clamp01(recurrence) * 0.20
    + clamp01(emotionalSalience) * 0.15
    + clamp01(futureUsefulness) * 0.15,
  )
}

/**
 * §7.4 检索评分（单条记忆进入当前社会现场）。
 * @param {object} o 各分量 0~1
 */
export function retrievalScore({ currentTargetMatch = 0, topicSimilarity = 0, graphProximity = 0, recency = 0, importance: imp = 0, confidence: conf = 0 } = {}) {
  return clamp01(
    clamp01(currentTargetMatch) * 0.30
    + clamp01(topicSimilarity) * 0.25
    + clamp01(graphProximity) * 0.15
    + clamp01(recency) * 0.10
    + clamp01(imp) * 0.10
    + clamp01(conf) * 0.10,
  )
}

/**
 * 简易 token 估算（中文按 1.5 字/token、ASCII 按 4 字符/token 的折中；用于预算截断，非精确）。
 * @param {string} s
 * @returns {number}
 */
export function estTokens(s) {
  const t = String(s || '')
  const cjk = (t.match(/[㐀-鿿]/g) || []).length
  const other = Math.max(0, t.length - cjk)
  return Math.ceil(cjk * 1.5 + other / 4)
}

export const __test__ = { clamp01, log1p, recencyFactor, interactionStrength, reciprocity, confidence, importance, retrievalScore, estTokens }
