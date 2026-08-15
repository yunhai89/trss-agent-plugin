/**
 * SelfState 默认配置 + 校验（设计文档 v1.1 §18）。
 *
 * 双层安全门：
 *  - enabled 总开关（默认 false）；
 *  - shadowMode（默认 true）：全链路计算/入库/审计，但投影恒中性、不影响 Planner/Replyer 发言。
 * 硬约束（validateSelfStateConfig）：
 *  - 单次脉冲上限钳制 [0.05, 0.5]；高显著上限 ≥ 普通上限；
 *  - 期待窗口 min ≤ max；
 *  - minIgnoredConfidence 不得低于 0.6（误判代价高，文档 §25 Phase 3 要求 Shadow 积累）；
 *  - maxNegativeMoodHours ≤ 48h（§20.5 状态上限）；
 *  - enabled=true 但未开启 GroupWorld 时仅警告不阻断（SS 可独立跑，但关系维度退化为默认值）。
 */

export const DEFAULT_SELFSTATE_CONFIG = Object.freeze({
  enabled: false,
  shadowMode: true,          // 计算但不影响发言；观察后翻 false 放量
  expressionFrozen: false,   // 冻结情绪外显（继续影子计算）§19.3

  scope: {
    isolateByGroup: true,    // 群级隔离（唯一支持模式；跨群不传事件/怨气）
    crossGroupMoodCarry: 0,  // 无来源全局心境携带，默认关闭
  },

  eventDetection: {
    directReply: true,
    directMention: true,
    nicknameReference: true,
    expectationTracking: true,
    semantic: true,                   // 语义近邻检测层（需 agent.recall.embedProvider；未配自动回落关键词）
    ambiguousIntentModelProfile: '',  // 歧义评价模型（留空=utilityModel→主模型）
    minEventConfidence: 0.55,         // 低于此值不产生事件
  },

  emotion: {
    maxNormalImpulse: 0.20,       // 普通事件单次脉冲上限（§9.3）
    maxHighSalienceImpulse: 0.35, // 高置信公开重复攻击上限
    minVisibleIntensity: 0.18,    // 低于此强度的情绪不进投影
    maxActiveEmotions: 8,
    enableMixedEmotions: true,
    lazyDecay: true,
    moodEmaAlpha: 0.3,            // 心境 EMA 惯性系数（0=心境冻结 1=无惯性直投影；算法升级 #5）
    moodResetHours: 6,            // 超过该时长无迁移 → α→1 自动回基线（睡一觉恢复）
  },

  resentment: {
    enabled: true,
    minCreateConfidence: 0.72,
    minRepeatedEvents: 2,
    maxSingleEventDelta: 0.05,   // 单次事件对怨气的最大增量
    halfLifeDays: 7,
  },

  expectations: {
    enabled: true,
    minimumWindowSeconds: 90,
    maximumWindowSeconds: 3600,
    minIgnoredConfidence: 0.65,          // ignore_score 达到此值才算高置信冷落
    requireTargetActivityEvidence: true, // 必须有目标活跃证据
    firstIgnoreCanBeExpressed: false,    // 首次被忽略不表达（§11.6 防卖惨）
  },

  reflection: {
    enabled: true,
    schedule: '37 4 * * *',
    minSignificantEvents: 3,   // 同成员相似高显著事件数阈值
    maxReflectionsPerDay: 10,
    defaultTtlDays: 7,
  },

  planner: {
    includeStateProjection: true,
    maxStateTokens: 220,
    emotionIsBiasOnly: true,   // 情绪只是偏置红线（§14.3）
  },

  replyer: {
    includeExpressionCapsule: true,
    exposeNumericState: false, // 永不外显数值
    allowNaturalEmotionDisclosure: true,
  },

  stability: {
    commandsIgnoreEmotion: true,
    toolsIgnoreEmotion: true,
    noCrossUserSpillover: true,     // 禁无关扩散（§20.2）
    preventEmotionalBlackmail: true,// 禁情绪绑架（§20.1）
    preventSelfHarmNarratives: true,
    maxNegativeMoodHours: 24,       // 负状态上限→恢复流程（§20.5）
  },

  retention: {
    transitionLogDays: 14,
    resolvedEmotionDays: 7,
    resolvedExpectationDays: 7,
  },
})

/**
 * 校验并归一化配置。返回 { ok, config, errors[] }。
 */
export function validateSelfStateConfig(raw = {}) {
  const errors = []
  const c = mergeConfig(DEFAULT_SELFSTATE_CONFIG, raw)

  const cl = (v, lo, hi, dflt) => { const n = Number(v); if (!Number.isFinite(n)) return dflt; return Math.max(lo, Math.min(hi, n)) }

  c.eventDetection.minEventConfidence = cl(c.eventDetection?.minEventConfidence, 0.3, 0.95, 0.55)
  c.emotion.maxNormalImpulse = cl(c.emotion?.maxNormalImpulse, 0.05, 0.5, 0.20)
  c.emotion.maxHighSalienceImpulse = cl(c.emotion?.maxHighSalienceImpulse, 0.1, 0.5, 0.35)
  if (c.emotion.maxHighSalienceImpulse < c.emotion.maxNormalImpulse) {
    c.emotion.maxHighSalienceImpulse = c.emotion.maxNormalImpulse
    errors.push('emotion.maxHighSalienceImpulse 被钳到 ≥ maxNormalImpulse')
  }
  c.emotion.minVisibleIntensity = cl(c.emotion?.minVisibleIntensity, 0, 1, 0.18)
  c.emotion.maxActiveEmotions = cl(c.emotion?.maxActiveEmotions, 2, 32, 8)
  c.resentment.minCreateConfidence = cl(c.resentment?.minCreateConfidence, 0.5, 0.95, 0.72)
  c.resentment.minRepeatedEvents = cl(c.resentment?.minRepeatedEvents, 1, 10, 2)
  c.resentment.maxSingleEventDelta = cl(c.resentment?.maxSingleEventDelta, 0.01, 0.2, 0.05)
  c.resentment.halfLifeDays = cl(c.resentment?.halfLifeDays, 1, 60, 7)
  c.expectations.minimumWindowSeconds = cl(c.expectations?.minimumWindowSeconds, 30, 1800, 90)
  c.expectations.maximumWindowSeconds = cl(c.expectations?.maximumWindowSeconds, 120, 86400, 3600)
  if (c.expectations.maximumWindowSeconds < c.expectations.minimumWindowSeconds) {
    c.expectations.maximumWindowSeconds = c.expectations.minimumWindowSeconds
    errors.push('expectations.maximumWindowSeconds 被钳到 ≥ minimumWindowSeconds')
  }
  c.expectations.minIgnoredConfidence = Math.max(0.6, Math.min(0.95, Number(c.expectations?.minIgnoredConfidence) || 0.65))
  c.reflection.minSignificantEvents = cl(c.reflection?.minSignificantEvents, 2, 10, 3)
  c.reflection.maxReflectionsPerDay = cl(c.reflection?.maxReflectionsPerDay, 1, 100, 10)
  c.reflection.defaultTtlDays = cl(c.reflection?.defaultTtlDays, 1, 90, 7)
  c.planner.maxStateTokens = cl(c.planner?.maxStateTokens, 60, 800, 220)
  c.stability.maxNegativeMoodHours = cl(c.stability?.maxNegativeMoodHours, 1, 48, 24)
  c.retention.transitionLogDays = cl(c.retention?.transitionLogDays, 1, 90, 14)
  c.retention.resolvedEmotionDays = cl(c.retention?.resolvedEmotionDays, 1, 90, 7)
  c.retention.resolvedExpectationDays = cl(c.retention?.resolvedExpectationDays, 1, 90, 7)
  // 红线强制（不可配置为 false）
  if (c.stability.noCrossUserSpillover === false) { c.stability.noCrossUserSpillover = true; errors.push('stability.noCrossUserSpillover 强制 true（红线）') }
  if (c.stability.preventEmotionalBlackmail === false) { c.stability.preventEmotionalBlackmail = true; errors.push('stability.preventEmotionalBlackmail 强制 true（红线）') }
  if (c.stability.preventSelfHarmNarratives === false) { c.stability.preventSelfHarmNarratives = true; errors.push('stability.preventSelfHarmNarratives 强制 true（红线）') }
  if (c.replyer.exposeNumericState === true) { c.replyer.exposeNumericState = false; errors.push('replyer.exposeNumericState 强制 false（红线：不外显数值）') }
  if (c.planner.emotionIsBiasOnly === false) { c.planner.emotionIsBiasOnly = true; errors.push('planner.emotionIsBiasOnly 强制 true（红线：情绪只是偏置）') }
  if (c.scope.isolateByGroup === false) { c.scope.isolateByGroup = true; errors.push('scope.isolateByGroup 强制 true（红线：跨群隔离）') }

  return { ok: errors.length === 0, config: c, errors }
}

export function resolveSelfStateConfig(raw = {}) {
  return validateSelfStateConfig(raw).config
}

// ─────────────── helpers ───────────────
function mergeConfig(base, over) {
  if (!over || typeof over !== 'object') return deepClone(base)
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const k of Object.keys(over)) {
    if (over[k] != null && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object' && base[k] !== null) {
      out[k] = mergeConfig(base[k], over[k])
    } else if (over[k] !== undefined) {
      out[k] = over[k]
    }
  }
  return out
}
function deepClone(v) { return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v }
