/**
 * apps/humanize.js —— 伪人模式旁听 app（指南 §8）。
 *
 * 职责：
 *  - 旁听群消息（catch-all，priority 低→先跑；永远 return false 不阻断其他插件）；
 *  - 8 步过滤：非群/功能关/非白名单 → skip；self/系统 → skip；命令 → 入缓冲不触发；
 *    @机器人/#ai → handledByDirectAgent（Direct Agent 独占）；普通消息 → 写缓冲 + 唤醒 runtime；
 *  - 富化 quotesBot（replyToId 命中缓冲中机器人自身消息）；
 *  - 自身发言防环（report-self-message 时 self 消息不触发）；
 *  - 配置热重载：cancelAll + reload 信号量；
 *  - 管理命令：#伪人状态 / #伪人决策 / #伪人开关。
 *
 * 复用 getRuntime()（agent.js 导出）的 provider/persona/recall/memory/sticker/kv，但会话/触发器/发送出口隔离。
 */

import plugin from '../../../lib/plugins/plugin.js'
import Config from '../utils/Config.js'
import Log from '../utils/Log.js'
import devLog from '../utils/DevLog.js'
import { getRuntime } from './agent.js'
import * as H from '../model/humanize/index.js'

let _humanize = null
let _humanizeFailed = null

/** 取机器人自身 id 集合（normalizer 用）。 */
function botSelfIds(e) {
  const ids = []
  try {
    if (typeof Bot !== 'undefined' && Bot) {
      if (Bot.uin) ids.push(String(Bot.uin))
      if (Bot.uins) for (const u of Bot.uins) ids.push(String(u))
    }
  } catch { /* noop */ }
  if (e?.self_id) ids.push(String(e.self_id))
  if (e?.bot?.uin) ids.push(String(e.bot.uin))
  return [...new Set(ids)]
}

function botNickname() {
  try { if (typeof Bot !== 'undefined' && Bot) return Bot.nickname || Bot.name || '' } catch { /* noop */ }
  return ''
}

function extractMsgId(res) {
  if (!res) return null
  if (typeof res === 'string') return res
  return res?.message_id || res?.data?.message_id || res?.seq || null
}

/** 构造 Planner 可用的白名单只读工具（指南 §11.1：默认不接完整 ToolRegistry）。 */
function buildReadTools(rt, hcfg) {
  const allowed = new Set(Array.isArray(hcfg?.planner?.allowedReadTools) ? hcfg.planner.allowedReadTools : [])
  if (!allowed.size || !rt?.tools) return []
  const out = []
  for (const name of allowed) {
    const t = rt.tools.get?.(name)
    if (!t || typeof t.execute !== 'function') continue
    // 再保险：剔除危险工具名（与 default-config.js FORBIDDEN_READ_TOOLS 对齐；validateHumanizeConfig 已先过滤）
    if (/^(?:send_|delete_|remove_|group_(kick|mute|set_|notice)|terminal|stagehand|file_to_pdf|upload_|create_group|transfer_|schedule_task|reminder_set|reload_skills|memory$)/i.test(name)) continue
    out.push({
      name: t.name, description: t.description, parameters: t.parameters,
      execute: async (args) => {
        const ctx = { bot: (typeof Bot !== 'undefined' && Bot) || null, fetcher: (typeof fetch !== 'undefined' && fetch) || null, groupId: null }
        const raw = await t.execute(args || {}, ctx)
        return typeof raw === 'string' ? raw : JSON.stringify(raw)
      },
    })
  }
  return out
}

/** 装配人类化运行时（共享 agent.js 的 getRuntime 单例）。 */
async function buildHumanize() {
  const rt = await getRuntime()
  const rawCfgFn = () => Config.get().agent?.humanize || {}
  // 初次校验（过滤危险 allowedReadTools 等；记录错误但不抛）
  const validation = H.validateHumanizeConfig(rawCfgFn(), rt.tools?.list?.().map((t) => t.name) || null)
  if (validation.errors.length) Log.warn('[humanize] 配置校验提示：', validation.errors.join('； '))
  const cfgFn = () => H.resolveHumanizeConfig(rawCfgFn())

  const store = new H.HumanizeStore({ kv: rt.kv })
  const trace = new H.Trace({
    sink: (rec) => {
      Log.debug('[humanize]', rec.event, 'group=' + (rec.groupIdHash || '-'), 'turn=' + (rec.turnId || '-'))
      devLog('humanize', rec, rec.turnId || null, null)
    },
  })
  const memory = new H.MemoryAdapter({ recall: rt.recall, memory: rt.memory, kv: rt.kv })
  const readTools = buildReadTools(rt, cfgFn())
  const sticker = rt.sticker

  let manager // 先声明，工厂闭包内引用（getOrCreate 时已赋值）

  const makePlanner = (gid) => new H.HumanizePlanner({
    provider: rt.provider, cfg: cfgFn, readTools,
    getMemories: async (q) => {
      try {
        const ms = await memory.retrieveGroupPublic(gid, q, 5)
        return H.formatPublicMemories(ms)
      } catch { return '' }
    },
    getBehaviorPolicyBlock: () => formatPolicyBlock(cfgFn().behaviorPolicy),
    getPersonaName: () => cfgFn().persona?.name || cfgFn().personaName || botNickname() || '机器人',
    // 角色人设注入 Planner：第三人称"参考"框定（决策器不是角色本人，只据此判断该不该接/态度）
    getPersonaBlock: () => H.buildPlannerPersonaBlock(resolveHumanizePersona(cfgFn(), rt)),
  })
  const makeReplyer = (gid) => new H.HumanizeReplyer({
    provider: rt.provider, cfg: cfgFn,
    // 角色人设（prompt / fromPersonaId / 内置默认）；恒有值，不再回落主任务 Agent systemPrompt（AI 味来源）
    getPersonaVoice: () => H.buildHumanizePersonaBlock(resolveHumanizePersona(cfgFn(), rt)),
    getRecentBotText: () => {
      try {
        const ent = manager?.getOrCreate?.(gid)
        const self = ent?.runtime?.buffer?.snapshot(8, { includeSelf: true })?.filter((m) => m.isSelf) || []
        return self[self.length - 1]?.text || ''
      } catch { return '' }
    },
    getStyleExamples: () => '',
    // 表情包清单注入：reply.allowSticker !== false 且表情包启用时给 Replyer 看 [sticker:名称] 与可用名表
    getStickerCatalog: () => (cfgFn().reply?.allowSticker !== false && sticker?.enabled?.() ? (sticker.catalog?.() || '') : ''),
  })
  const makeComposer = () => new H.HumanizeReplyComposer({ cfg: cfgFn, stickerManager: sticker })
  const makeSend = (gid) => makeSendFn(gid)

  manager = new H.RuntimeManager({ store, trace, cfg: cfgFn, makePlanner, makeReplyer, makeComposer, makeSend })

  // 配置热重载：取消所有进行中规划/未发送分段 + 重建信号量上限
  Config.onChange(() => {
    try { manager.reload(); manager.cancelAll(); Log.info('[humanize] 配置热加载，已取消所有进行中规划') } catch (e) { Log.warn('[humanize] 热加载失败', e?.message || e) }
  })

  return { manager, store, trace, memory, cfgFn }
}

function makeSendFn(groupId) {
  return async (content, { quoteTargetId } = {}) => {
    const bot = (typeof Bot !== 'undefined' && Bot) || null
    const group = bot?.pickGroup?.(groupId) || null
    if (!group?.sendMsg) return null
    const body = Array.isArray(content) ? content : [content]
    const msg = quoteTargetId ? [{ type: 'reply', id: String(quoteTargetId) }, ...body] : body
    try {
      const res = await group.sendMsg(msg)
      return extractMsgId(res)
    } catch (err) {
      Log.warn('[humanize] 发送失败', groupId, err?.message || err)
      return null
    }
  }
}

/**
 * 解析伪人角色人设（同步）。优先级：persona.prompt > persona.fromPersonaId（复用 PersonaStore）
 * > 内置默认人设（DEFAULT_HUMANIZE_PERSONA，刻意去 AI 味、尊重看人）。
 * 即用户不配置时，也始终有一份「像真人」的人设兜底，绝不回落到主任务 Agent 的 systemPrompt（那是 AI 味来源）。
 * @returns {{name:string, prompt:string}} prompt 恒非空
 */
function resolveHumanizePersona(cfg, rt) {
  const persona = (cfg && cfg.persona) || {}
  const name = String(persona.name || '').trim()
  let prompt = String(persona.prompt || '').trim()
  if (!prompt && persona.fromPersonaId) {
    try {
      const found = rt?.persona?.store?.get?.(persona.fromPersonaId)
      if (found?.systemPrompt) prompt = String(found.systemPrompt).trim()
    } catch { /* noop */ }
  }
  if (!prompt) return { name, prompt: H.DEFAULT_HUMANIZE_PERSONA.prompt }
  return { name, prompt }
}

function formatPolicyBlock(policy) {
  if (!policy) return ''
  const lines = []
  if (policy.topics?.length) lines.push(`- 关注主题：${policy.topics.join('、')}`)
  if (policy.avoidTopics?.length) lines.push(`- 回避主题：${policy.avoidTopics.join('、')}（命中时应沉默或谨慎）`)
  lines.push(`- 主动性：${policy.initiative}；幽默：${policy.humor}`)
  if (policy.interruptHumanConversation === true) {
    // 主动型群友：该插就插，但不硬插
    lines.push('- 主动参与：你是普通群员，对感兴趣或有话可说的对话可以自然接话，不必等被 @ 或被点名')
    lines.push('- 但不硬插：别人正在快速一来一回时别打断，挑自然停顿；没话说就沉默，不为说而说')
  } else {
    lines.push('- 不打断顺畅进行的人类对话；不回答明显发给别人的话')
  }
  if (policy.answerUnknownQuestions === false) lines.push('- 事实不足时宁可不说，不编造')
  return lines.length ? '角色行为政策：\n' + lines.join('\n') : ''
}

async function getHumanize() {
  if (_humanize) return _humanize
  if (_humanizeFailed) throw _humanizeFailed
  try {
    _humanize = await buildHumanize()
    _humanizeFailed = null
    return _humanize
  } catch (e) {
    _humanizeFailed = e
    Log.warn('[humanize] 装配失败（agent 未初始化？），旁听暂停', e?.message || e)
    throw e
  }
}

// 触发命令检测：所有 # 前缀视为命令（绝不触发环境回复）
function isCommandText(text) {
  return /^\s*#/.test(String(text || ''))
}

// ───────────────────────── 插件类 ─────────────────────────

export class Humanize extends plugin {
  constructor() {
    super({
      name: '伪人模式',
      dsc: '群聊环境参与者：旁听→门控→决策→自然发送（默认 shadow）',
      event: 'message',
      priority: 1, // 先于 agent.js(9999) 跑，旁听后 return false 不阻断
      rule: [
        { reg: '^#伪人状态$', fnc: 'humanizeStatus', permission: 'master' },
        { reg: '^#伪人决策(?:\\s+(\\d+))?$', fnc: 'humanizeTrace', permission: 'master' },
        { reg: '^#伪人开关\\s+(on|off|开|关)$', fnc: 'humanizeToggle', permission: 'master' },
        { reg: '^[\\s\\S]+$', fnc: 'onAmbient', log: false }, // 旁听 catch-all（最后）
      ],
    })
    // 异步预热（不阻塞构造）
    getHumanize().catch(() => {})
  }

  /** 旁听入口：8 步过滤 + 归一化 + 路由。永远 return false（不阻断）。 */
  async onAmbient() {
    const e = this.e
    // 1. 非群消息：不处理（私聊不在环境模式范围）
    if (!e.isGroup) return false

    let h
    try { h = await getHumanize() } catch (e) { Log.warn('[humanize] getHumanize 失败', e?.message || e); return false }
    const cfg = h.cfgFn()
    // 2. 功能关 / 群不在白名单：跳过（但仍 return false）
    if (cfg.enable !== true || !Array.isArray(cfg.groups) || !cfg.groups.map(String).includes(String(e.group_id))) return false

    const selfIds = botSelfIds(e)
    const botNames = [cfg.personaName, botNickname()].filter(Boolean)
    const norm = H.normalizeYunzaiEvent(e, {
      selfIds,
      botNames,
      isCommand: isCommandText,
      platform: 'qq',
    })

    // 3. self / 系统通知：入缓冲供 presence/上下文，但不触发（normalizer 已判 isSelf）
    //    （伪人自身发言：report-self-message 时进入此分支，防环）
    // 4. 命令消息：入缓冲、isCommand=true、绝不触发（normalizer 已标记）
    // 5. @机器人 / #ai：handledByDirectAgent=true（Direct Agent 独占）
    if (!norm.isSelf && (norm.atBot || norm.isCommand)) {
      norm.handledByDirectAgent = true
      try { await h.store.markDirectHandled(norm.groupId, norm.id) } catch { /* noop */ }
    }

    // 富化 quotesBot：replyToId 命中缓冲中机器人自身消息
    if (!norm.isSelf && norm.replyToId) {
      try {
        const ent = h.manager.getOrCreate(norm.groupId)
        const replied = ent.runtime.buffer.get(norm.replyToId)
        if (replied?.isSelf) norm.quotesBot = true
      } catch { /* noop */ }
    }

    // 路由到对应群运行时（写缓冲 + 必要时唤醒 debounce）
    try {
      Log.info('[humanize] 路由', norm.groupId, 'isSelf=' + norm.isSelf, 'isCmd=' + norm.isCommand, 'handled=' + norm.handledByDirectAgent, 'text="' + (norm.text || '').slice(0, 20) + '"')
      await h.manager.route(norm.groupId, norm)
    } catch (err) {
      Log.warn('[humanize] 路由失败', norm.groupId, err?.message || err)
    }
    return false // 永远不阻断其他插件（含 agent.js 的 @/#ai 处理）
  }

  async humanizeStatus() {
    let h
    try { h = await getHumanize() } catch (e) { return this.e.reply(`伪人模式未就绪：${e?.message || e}`, true) }
    const cfg = h.cfgFn()
    const groups = h.manager.activeGroups()
    const lines = [
      `伪人模式：${cfg.enable ? '✅已开启' : '❌未开启'}（shadow=${cfg.shadow !== false}）`,
      `白名单群：${cfg.groups.length ? cfg.groups.join('、') : '(空)'}`,
      `活跃运行时：${groups.length}`,
    ]
    if (groups.length) {
      for (const g of groups.slice(0, 10)) {
        lines.push(`- ${g.groupId}：${g.phase} | 缓冲 ${g.size} | 冷却 ${g.cooldown ? '是' : '否'} | backoff ${g.backoff}`)
      }
    }
    await this.e.reply(lines.join('\n'))
    return true
  }

  async humanizeTrace() {
    let h
    try { h = await getHumanize() } catch (e) { return this.e.reply(`伪人模式未就绪：${e?.message || e}`, true) }
    const n = Number(this.e.msg.match(/\d+/)?.[0] || 10)
    const recent = h.trace.recent({ limit: n })
    if (!recent.length) return this.e.reply(`暂无伪人决策记录（最近 ${n} 条）。`, true)
    const lines = recent.map((r) => {
      const score = r.finalScore != null ? `分${r.finalScore}/${r.threshold}` : ''
      const action = r.action ? `→${r.action}` : ''
      return `[${new Date(r.ts).toLocaleTimeString('zh-CN')}] ${r.event} ${score} ${(r.reasons?.positive || []).join(',')}${action}`
    })
    await this.e.reply(['伪人决策 trace：', ...lines].join('\n'))
    return true
  }

  async humanizeToggle() {
    const arg = this.e.msg.match(/(on|off|开|关)/)?.[1]
    const on = arg === 'on' || arg === '开'
    const cfg = Config.get()
    cfg.agent = cfg.agent || {}; cfg.agent.humanize = cfg.agent.humanize || {}
    cfg.agent.humanize.enable = on
    Config.save(cfg) // 触发热加载（Config.onChange → cancelAll + reload）
    await this.e.reply(`伪人模式已${on ? '开启' : '关闭'}（${on && !cfg.agent.humanize.groups?.length ? '但白名单为空，仍不生效；请配 groups' : 'shadow=' + (cfg.agent.humanize.shadow !== false)}）`)
    return true
  }
}
