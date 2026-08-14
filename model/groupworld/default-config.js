/**
 * GroupWorld 默认配置 + 校验（设计文档 §13）。
 *
 * 硬约束（validateGroupWorldConfig）：
 *  - enabled=true && groups=[] → 仍不开启（不得全群开启，需显式白名单）；
 *  - online=true 自动要求 enabled=true；
 *  - minOnlineConfidence 不得低于 0.55（低置信推断默认不进在线上下文，§7.2）；
 *  - 数值字段有硬上下限。
 */

export const DEFAULT_GROUPWORLD_CONFIG = Object.freeze({
  enabled: false,
  groups: [],                 // 显式白名单群号；空=不开启
  online: false,              // 在线影响 Planner/Replyer（默认关：先观察画像质量再放量）

  ingestion: {
    rawMessageRetentionDays: 30,
    segmentIdleSeconds: 300,  // 文档 3~8min，默认 5min
    segmentMaxMessages: 100,  // 文档 60~120
    ignoreCommandMessages: true,
    ignoreSystemNotices: true,
    // 主题漂移切分（TextTiling 式，§6.2「明显更换主题时可提前分割」；词面 bigram 相似度）
    topicShiftEnabled: true,
    topicShiftWindow: 6,          // 参与比较的近窗有效消息数
    topicShiftSimThreshold: 0.06, // 新消息与近窗相似度低于此值 → 分割（保守，避免碎片化）
  },
  analysis: {
    schedule: '7 * * * *',    // 每小时 :07（避开整点）
    minSegmentMessages: 4,
    maxSegmentsPerRun: 50,
    modelProfile: '',         // 留空=主模型/utilityModel
    maxDailyCallsPerGroup: 100,
    retryCount: 1,
    maxTokens: 1200,
    episodeMergeSim: 0.85,    // 事件语义去重阈值（embedding 余弦；无 embedding 时仅按同 title）
  },
  profiles: {
    hotActiveDays30d: 10,
    warmMessageCount30d: 5,
    minOnlineConfidence: 0.55,
    maxTraitsPerUser: 5,
    temporaryTraitTtlDays: 14,
    traitMergeSimThreshold: 0.82, // 近义特征聚类合并阈值（每日维护；embedding 余弦）
  },
  graph: {
    activeEdgeDays: 90,
    maxNeighborsPerUser: 40,
    maxOnlineHops: 1,
    weeklyCommunityDetection: true,
    minCommunitySize: 3,
  },
  retrieval: {
    plannerTokenBudget: 800,
    replyerTokenBudget: 500,
    maxEpisodes: 3,
    maxRelationships: 5,
    cacheTtlSeconds: 60,
  },
  privacy: {
    allowUserOptOut: true,
    allowUserInspect: true,
    allowUserCorrect: true,
    blockSensitiveInference: true,
  },
})

/**
 * 校验并归一化配置。返回 { ok, config, errors[] }。
 * @param {object} raw 用户/默认配置（agent.groupWorld）
 */
export function validateGroupWorldConfig(raw = {}) {
  const errors = []
  const c = mergeConfig(DEFAULT_GROUPWORLD_CONFIG, raw)

  c.groups = Array.isArray(c.groups) ? c.groups.map(String) : []
  if (c.enabled === true && !c.groups.length) {
    c.enabled = false
    errors.push('enabled=true 但 groups 为空，GroupWorld 不开启（需显式白名单）')
  }
  // online 要求 enabled
  if (c.online === true && c.enabled !== true) {
    c.online = false
    errors.push('online=true 但 enabled=false，online 被强制为 false（先观察再上线）')
  }

  // 数值硬上下限
  const cl = (v, lo, hi, dflt) => { const n = Number(v); if (!Number.isFinite(n)) return dflt; return Math.max(lo, Math.min(hi, n)) }
  c.ingestion.rawMessageRetentionDays = cl(c.ingestion?.rawMessageRetentionDays, 1, 365, 30)
  c.ingestion.segmentIdleSeconds = cl(c.ingestion?.segmentIdleSeconds, 60, 1800, 300)
  c.ingestion.segmentMaxMessages = cl(c.ingestion?.segmentMaxMessages, 20, 200, 100)
  c.ingestion.topicShiftWindow = cl(c.ingestion?.topicShiftWindow, 2, 30, 6)
  c.ingestion.topicShiftSimThreshold = cl(c.ingestion?.topicShiftSimThreshold, 0, 0.5, 0.06)
  c.analysis.minSegmentMessages = cl(c.analysis?.minSegmentMessages, 1, 50, 4)
  c.analysis.maxSegmentsPerRun = cl(c.analysis?.maxSegmentsPerRun, 1, 500, 50)
  c.analysis.maxDailyCallsPerGroup = cl(c.analysis?.maxDailyCallsPerGroup, 0, 10000, 100)
  c.analysis.retryCount = cl(c.analysis?.retryCount, 0, 5, 1)
  c.analysis.maxTokens = cl(c.analysis?.maxTokens, 256, 8192, 1200)
  c.analysis.episodeMergeSim = cl(c.analysis?.episodeMergeSim, 0.5, 1, 0.85)
  c.profiles.hotActiveDays30d = cl(c.profiles?.hotActiveDays30d, 1, 30, 10)
  c.profiles.warmMessageCount30d = cl(c.profiles?.warmMessageCount30d, 1, 1000, 5)
  c.profiles.maxTraitsPerUser = cl(c.profiles?.maxTraitsPerUser, 1, 20, 5)
  c.profiles.temporaryTraitTtlDays = cl(c.profiles?.temporaryTraitTtlDays, 1, 90, 14)
  c.profiles.traitMergeSimThreshold = cl(c.profiles?.traitMergeSimThreshold, 0.5, 1, 0.82)
  // minOnlineConfidence 不得低于 0.55
  c.profiles.minOnlineConfidence = Math.max(0.55, Math.min(0.99, Number(c.profiles?.minOnlineConfidence) || 0.55))
  c.graph.activeEdgeDays = cl(c.graph?.activeEdgeDays, 7, 365, 90)
  c.graph.maxNeighborsPerUser = cl(c.graph?.maxNeighborsPerUser, 0, 200, 40)
  c.graph.maxOnlineHops = Math.max(1, Math.min(2, Number(c.graph?.maxOnlineHops) || 1))
  c.graph.minCommunitySize = Math.max(2, Math.min(20, Number(c.graph?.minCommunitySize) || 3))
  c.retrieval.plannerTokenBudget = cl(c.retrieval?.plannerTokenBudget, 100, 4000, 800)
  c.retrieval.replyerTokenBudget = cl(c.retrieval?.replyerTokenBudget, 100, 3000, 500)
  c.retrieval.maxEpisodes = cl(c.retrieval?.maxEpisodes, 0, 10, 3)
  c.retrieval.maxRelationships = cl(c.retrieval?.maxRelationships, 0, 20, 5)
  c.retrieval.cacheTtlSeconds = cl(c.retrieval?.cacheTtlSeconds, 0, 3600, 60)

  return { ok: errors.length === 0, config: c, errors }
}

/** 解析最终生效配置（默认 + 用户）。 */
export function resolveGroupWorldConfig(raw = {}) {
  return validateGroupWorldConfig(raw).config
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
