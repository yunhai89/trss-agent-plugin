/**
 * Humanize 默认配置 + 校验（指南 §15）。
 *
 * 硬约束（validateHumanizeConfig）：
 *  - enable=true && groups=[] → 仍不开启（不得全群开启）；
 *  - threshold/talkValue/超时/回合数有硬上下限；
 *  - allowedReadTools 不可包含写/删/管理/终端/消息发送类工具；
 *  - privateMemoryInGroup 不可改为 true（字段可不暴露）。
 */

import { resolveBehaviorPolicy, DEFAULT_BEHAVIOR_POLICY } from './behavior-policy.js'

export const DEFAULT_HUMANIZE_CONFIG = Object.freeze({
  enable: false,
  groups: [],                 // 显式白名单；空=不开启
  shadow: true,               // true=只记录决策，不实发
  triggerMode: 'necessity',   // necessity | frequency
  talkValue: 0.35,
  mentionHandledByDirectAgent: true,

  debounceMs: 1200,
  plannerTimeoutMs: 30000,
  maxPlannerRounds: 4,
  contextMessages: 30,
  threshold: 80,
  cooldownSeconds: 45,
  presenceWindowSeconds: 300,
  maxRepliesPer10Minutes: 4,

  bufferCapacity: 150,
  bufferTtlHours: 2,

  idleBackoffBaseSeconds: 15,
  idleBackoffCapSeconds: 300,
  idleBackoffStartCount: 2,
  bypassPendingCount: 6,

  planner: {
    model: '',                // 留空=utilityModel→主模型
    temperature: 0.2,
    maxTokens: 800,
    allowedReadTools: [],     // 白名单只读工具名；写/删/管理/终端/发送类一律拒绝
  },
  replyer: {
    model: '',                // 留空=主模型
    temperature: 0.7,
    maxTokens: 500,
    maxChars: 500,
  },
  reply: {
    maxBubbles: 3,
    typingSpeed: 1.0,
    minDelayMs: 600,
    maxDelayMs: 3500,
    typos: false,             // 第一版永关
    allowSticker: true,
    quoteTarget: 'auto',
  },
  behaviorPolicy: { ...DEFAULT_BEHAVIOR_POLICY },
  learning: {                 // Phase 4：仅 shadow 采集，不进 Prompt
    style: 'shadow',
    jargon: 'shadow',
    behavior: false,
    minSamples: 20,
    requireReview: true,
  },
  safety: {
    blockCommands: true,
    blockDestructiveTools: true,
    privateMemoryInGroup: false, // 不可改的硬约束
    maxConcurrentGroups: 1,
  },
  redactSecrets: true,
})

/** 危险工具名黑名单：绝不允许进 allowedReadTools（指南 §15）。 */
const FORBIDDEN_READ_TOOLS = /^(?:send_|delete_|remove_|group_(kick|mute|set_|notice)|terminal|stagehand|file_to_pdf|upload_|create_group|transfer_|schedule_task|reminder_set|reload_skills|memory$)/i

/**
 * 校验并归一化人类化配置。返回 { ok, config, errors[] }。
 * @param {object} raw 用户/默认配置（agent.humanize）
 * @param {object} [runtimeToolNames] 可用工具名集合（用于校验 allowedReadTools 是否存在/合法）
 */
export function validateHumanizeConfig(raw = {}, runtimeToolNames = null) {
  const errors = []
  const c = mergeConfig(DEFAULT_HUMANIZE_CONFIG, raw)

  // 硬约束：privateMemoryInGroup 不可为 true
  if (c.safety?.privateMemoryInGroup === true) {
    c.safety.privateMemoryInGroup = false
    errors.push('safety.privateMemoryInGroup 被强制为 false（隐私红线，不可开启）')
  }
  // typos 第一版永关
  if (c.reply?.typos === true) { c.reply.typos = false; errors.push('reply.typos 被强制为 false（第一版不支持自动错字）') }

  // 数值硬上下限
  c.talkValue = clamp(c.talkValue, 0.05, 1)
  c.threshold = clamp(c.threshold, 1, 120)
  c.maxPlannerRounds = clamp(c.maxPlannerRounds, 1, 6)
  c.plannerTimeoutMs = clamp(c.plannerTimeoutMs, 5000, 120000)
  c.debounceMs = clamp(c.debounceMs, 200, 10000)
  c.cooldownSeconds = clamp(c.cooldownSeconds, 0, 600)
  c.maxRepliesPer10Minutes = clamp(c.maxRepliesPer10Minutes, 0, 60)
  c.contextMessages = clamp(c.contextMessages, 5, 100)
  c.reply.maxBubbles = clamp(c.reply.maxBubbles, 1, 5)

  // groups 必须是数组
  c.groups = Array.isArray(c.groups) ? c.groups.map(String) : []
  // enable=true 但 groups 空 → 仍不开启
  if (c.enable === true && !c.groups.length) {
    c.enable = false
    errors.push('enable=true 但 groups 为空，人类化模式不开启（需显式白名单）')
  }

  // allowedReadTools 过滤：剔除危险/未知工具
  if (Array.isArray(c.planner?.allowedReadTools) && c.planner.allowedReadTools.length) {
    const allowed = runtimeToolNames ? new Set(runtimeToolNames) : null
    const cleaned = []
    for (const name of c.planner.allowedReadTools) {
      const n = String(name || '')
      if (FORBIDDEN_READ_TOOLS.test(n)) { errors.push(`planner.allowedReadTools 剔除危险工具：${n}`); continue }
      if (allowed && !allowed.has(n)) { errors.push(`planner.allowedReadTools 剔除未知工具：${n}`); continue }
      cleaned.push(n)
    }
    c.planner.allowedReadTools = cleaned
  }

  // 解析 behaviorPolicy
  c.behaviorPolicy = resolveBehaviorPolicy(c.behaviorPolicy)

  return { ok: errors.length === 0, config: c, errors }
}

/**
 * 解析最终生效配置（默认 + 用户 + 群级覆盖 + behaviorPolicy）。
 * 供 RuntimeManager._groupCfg 使用。
 */
export function resolveHumanizeConfig(raw = {}, groupOverride = null) {
  const { config } = validateHumanizeConfig(raw)
  if (groupOverride && typeof groupOverride === 'object') {
    return mergeConfig(config, groupOverride)
  }
  return config
}

// ─────────────── helpers ───────────────

function clamp(v, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

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
