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
  personaName: '',             // 机器人在群里的名字（留空=自动探测 Bot.nickname）
  botId: '',                   // bot 自身账号 id（默认自动取协议端 self_id；显式配置可覆盖，多协议/改名场景用）

  persona: {                  // 群聊角色人设（MaiBot 式，与主 Agent 人设独立）
    name: '',                 // 角色名（留空=用 personaName）
    prompt: '',               // 角色卡正文（自由多段）；最高优先级。空则回落 fromPersonaId/旧来源
    fromPersonaId: '',        // prompt 为空时，按 id/名复用 PersonaStore 人设 systemPrompt
    aliases: [],              // 角色别名（均参与 @/提及昵称判定；与 name 一同人 identityNames）
  },

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
  knownBots: [],              // 已知其它 bot 账号（QQ 号）：bot↔bot 交替≥3轮无真人 → 10分钟熔断（真人不受影响）
  memory: {                   // 伪人独立记忆库（MaiBot 式睡眠整合；独立 sqlite，与主 Agent 记忆隔离）
    enabled: true,
    maxPerQuery: 5,           // Planner 单次注入记忆条数上限
    maxPerGroup: 300,         // 单群记忆容量（超量按价值淘汰）
    minConsolidateMessages: 6, // 整合所需最少消息数
    incrementalMinMessages: 20, // 每小时增量整合水位（新增 ≥N 条才跑；梗当天入库）
    forgetDays: 30,           // 超龄硬遗忘（天）
  },
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
    maxConcurrentGroups: 2,
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
  c.memory = c.memory && typeof c.memory === 'object' ? c.memory : {}
  c.memory.maxPerQuery = clamp(c.memory.maxPerQuery, 1, 12)
  c.memory.maxPerGroup = clamp(c.memory.maxPerGroup, 50, 2000)
  c.memory.minConsolidateMessages = clamp(c.memory.minConsolidateMessages, 4, 50)
  c.memory.forgetDays = clamp(c.memory.forgetDays, 7, 180)
  c.plannerTimeoutMs = clamp(c.plannerTimeoutMs, 5000, 120000)
  c.debounceMs = clamp(c.debounceMs, 200, 10000)
  c.cooldownSeconds = clamp(c.cooldownSeconds, 0, 600)
  c.maxRepliesPer10Minutes = clamp(c.maxRepliesPer10Minutes, 0, 60)
  c.contextMessages = clamp(c.contextMessages, 5, 100)
  c.reply.maxBubbles = clamp(c.reply.maxBubbles, 1, 5)

  // 角色人设块：归一为对象 + 裁剪 prompt 超长（防 prompt 注入/膨胀）
  const PERSONA_PROMPT_MAX = 4000
  c.persona = (c.persona && typeof c.persona === 'object') ? c.persona : {}
  const personaPrompt = String(c.persona.prompt || '').slice(0, PERSONA_PROMPT_MAX)
  if (personaPrompt.length < String(c.persona.prompt || '').length) {
    errors.push(`persona.prompt 超过 ${PERSONA_PROMPT_MAX} 字，已裁剪`)
  }
  c.persona = {
    name: String(c.persona.name || '').slice(0, 60),
    prompt: personaPrompt,
    fromPersonaId: String(c.persona.fromPersonaId || '').slice(0, 60),
    aliases: (Array.isArray(c.persona.aliases) ? c.persona.aliases : []).map((a) => String(a || '').trim().slice(0, 60)).filter((a) => a.length >= 2).slice(0, 8),
    // 人工认可的风格示例（带 sceneType/speechAct/tone/familiarity/text 标签；Replyer 按场景检索 2~4 条）。
    // 提供即全量覆盖默认样本；text 必须非空，总量封顶 60 条。
    styleExamples: (Array.isArray(c.persona.styleExamples) ? c.persona.styleExamples : [])
      .filter((e) => e && typeof e === 'object' && typeof e.text === 'string' && e.text.trim())
      .slice(0, 60)
      .map((e) => ({
        sceneType: String(e.sceneType || '').slice(0, 24),
        speechAct: String(e.speechAct || '').slice(0, 24),
        tone: String(e.tone || '').slice(0, 16),
        familiarity: Math.max(0, Math.min(1, Number(e.familiarity) || 0.5)),
        text: e.text.trim().slice(0, 120),
      })),
  }

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

/**
 * 人设身份统一解析（单一来源）：persona.name（新）> personaName（旧兼容）> botNickname。
 * Normalizer 的 botNames（@/提及判定）、Planner 的角色名、SelfState 的 personaName、
 * Replyer 人设块必须同源消费本函数产物——否则一处叫角色名、一处叫"机器人"，
 * 提及判定与自我认知互相打架。
 * @param {object} cfg 已解析 humanize 配置
 * @param {object} o { botNickname? } 协议端昵称（兜底名）
 * @returns {{ name:string, aliases:string[], identityNames:string[] }} identityNames = 参与昵称判定的全部名字（去重、≥2字）
 */
export function resolvePersonaIdentity(cfg, { botNickname = '' } = {}) {
  const persona = cfg?.persona || {}
  const primary = String(persona.name || cfg?.personaName || '').trim()
  const aliases = (Array.isArray(persona.aliases) ? persona.aliases : []).map((a) => String(a || '').trim()).filter((a) => a.length >= 2)
  const bot = String(botNickname || '').trim()
  const identityNames = [...new Set([...(primary ? [primary] : []), ...aliases, ...(bot ? [bot] : [])])]
    .filter((n) => n.length >= 2)
  return { name: primary || bot || '机器人', aliases, identityNames }
}
