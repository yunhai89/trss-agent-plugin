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
import { getGroupWorld } from './groupworld.js'
import { SelfStateService } from '../model/selfstate/index.js'
import { buildEmbed } from '../model/llm/embed-wiring.js'
import { makeEmbedder } from '../model/groupworld/embedding.js'
import { createSearchManager, formatResults } from '../model/search/index.js'
import { fetchReply } from '../model/media/collect.js'
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

/** SelfState 定时任务用：bot 自身 QQ。 */
function botNicknameSelfId() {
  try {
    if (typeof Bot !== 'undefined' && Bot) {
      if (Bot.uin) return String(Bot.uin)
      if (Bot.uins?.[0]) return String(Bot.uins[0])
    }
  } catch { /* noop */ }
  return Config.get().agent?.humanize?.botId || 'bot'
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
      // 伪人全链路日志写独立目录（按日文件），与主 Agent 的 data/logs 隔离：
      // 既不上 web 日志时间线（web 只读 data/logs），又按日便于定期压缩。
      const d = new Date(rec.ts || Date.now())
      const p = (n) => String(n).padStart(2, '0')
      const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
      devLog('humanize', rec, rec.turnId || null, null, { dir: Config.path.humanizeLogs, filename: `humanize-${day}.log` })
    },
  })
  // 伪人独立记忆库（MaiBot 式睡眠整合；独立 sqlite，与主 Agent 的 recall/KV 完全隔离）
  // embedder：配置 agent.recall.embedProvider 后记忆检索走语义余弦（同义换说可召回），未配回落词面
  const { embedFn: memEmbedFn, embedModel: memEmbedModel } = buildEmbed(rt)
  const hmem = new H.HumanizeMemoryStore({
    dataDir: Config.path.data + '/humanize',
    provider: rt.provider,
    cfg: cfgFn,
    embedder: memEmbedFn ? makeEmbedder({ embedFn: memEmbedFn, model: memEmbedModel }) : null,
    trace: { record: (event, data = {}) => { try { trace.record(event, data) } catch { /* noop */ } } },
  })
  hmem.init().catch(() => {})
  const readTools = buildReadTools(rt, cfgFn())
  const sticker = rt.sticker

  let manager // 先声明，工厂闭包内引用（getOrCreate 时已赋值）

  // GroupWorld 局部社会现场（仅 online 时注入；GW 未就绪/失败 → 空现场，零影响）。复用 apps/groupworld 单例。
  const EMPTY_SCENE = { empty: true, text: '' }
  const gwLazy = getGroupWorld().catch(() => null)
  const gwPlannerCtx = async (ctx) => { try { const gw = await gwLazy; return gw ? await gw.buildPlannerContext(ctx) : EMPTY_SCENE } catch (e) { Log.debug('[humanize] GW现场降级:', e?.message || e); return EMPTY_SCENE } }
  const gwReplyerCtx = async (ctx) => { try { const gw = await gwLazy; return gw ? await gw.buildReplyerContext(ctx) : EMPTY_SCENE } catch (e) { Log.debug('[humanize] GW现场降级:', e?.message || e); return EMPTY_SCENE } }
  // SelfState（自我认知与情绪）：惰性单例，enabled=false 时 service.init 返 false 全链路 no-op。
  const NEUTRAL = { neutral: true, text: '' }
  const ssLazy = (() => {
    try {
      // 语义检测层 embedder：与 GroupWorld 共用 agent.recall.embedProvider 配置（未配 → 词面/规则兜底）
      const { embedFn, embedModel } = buildEmbed(rt)
      const svc = new SelfStateService({
        provider: rt.provider,
        cfg: () => Config.get().agent?.selfState || {},
        botId: botSelfIdsAll(rt)[0] || 'bot',
        botNames: H.resolvePersonaIdentity(cfgFn(), { botNickname: botNickname() }).identityNames,
        // SS trace 同样写伪人独立目录（按日 ss-*.log；曾字符串 scope → private-unknown-0 落主目录）
        trace: { record: (event, data = {}) => {
          try {
            const d = new Date()
            const p = (n) => String(n).padStart(2, '0')
            const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
            devLog(event, data, null, null, { dir: Config.path.humanizeLogs, filename: `ss-${day}.log` }).catch(() => {})
          } catch { /* noop */ }
        } },
        dataDir: Config.path.data + '/groupworld',
        embedFn, embedModel,
      })
      return svc.init().then(() => svc).catch(() => null)
    } catch { return Promise.resolve(null) }
  })()
  const ssPlannerProj = async (ctx) => { try { const ss = await ssLazy; return ss ? await ss.buildPlannerProjection(ctx) : NEUTRAL } catch (e) { Log.debug('[humanize] SS投影降级:', e?.message || e); return NEUTRAL } }
  const ssReplyerCap = async (ctx) => { try { const ss = await ssLazy; return ss ? await ss.buildReplyerCapsule(ctx) : NEUTRAL } catch (e) { Log.debug('[humanize] SS胶囊降级:', e?.message || e); return NEUTRAL } }
  const ssOnDelivered = async (info) => {
    try {
      const ss = await ssLazy
      if (ss && info?.sentText) await ss.registerOutgoingExpectation({ groupId: info.groupId, sourceMessageId: info.sourceMessageId, targetUserId: info.targetUserId, sentText: info.sentText, replyGuide: info.replyGuide })
    } catch { /* noop */ }
  }
  const gwOnDelivered = async (info) => {
    try {
      const gw = await gwLazy
      if (gw) await gw.recordInteraction(info)
    } catch { /* noop */ }
    // 梗实际使用登记（6h 冷却数据源——仅真实发送的文本才计，检索不算）
    try { if (info?.sentText) hmem.markJargonUsed(info.groupId, info.sentText).catch(() => {}) } catch { /* noop */ }
    // 记忆真实使用登记：只有真实发送成功且注入本轮 prompt 的记忆才计 hit（recall 本身零副作用）
    try { if (info?.usedMemoryIds?.length) hmem.markUsed(info.groupId, info.usedMemoryIds).catch(() => {}) } catch { /* noop */ }
    await ssOnDelivered(info)
  }
  /** 取 bot 自身 id 集合（runtime 期）。 */
  function botSelfIdsAll(rt) {
    const ids = []
    try {
      if (typeof Bot !== 'undefined' && Bot) {
        if (Bot.uin) ids.push(String(Bot.uin))
        if (Bot.uins) for (const u of Bot.uins) ids.push(String(u))
      }
    } catch { /* noop */ }
    if (rt?.botId) ids.push(String(rt.botId))
    return ids
  }

  // 伪人看图：配置了视觉模型（agent.vision.enable + model → rt.vision）时，把上下文里的图片注成一句话描述
  const mediaDesc = new H.MediaDescriber({
    vision: rt.vision || null,
    trace: { record: (event, data = {}) => { try { trace.record(event, data) } catch { /* noop */ } } },
  })
  if (mediaDesc.available) Log.info('[humanize] 视觉已接入：伪人可看见群友图片（每轮最多 3 张新描述，按图缓存）')
  const enrichMedia = mediaDesc.available ? (msgs, o) => mediaDesc.annotate(msgs, o) : null

  // 网络梗学习用：复用主框架搜索引擎配置（agent.search 多源），无可用源 → 返回 null 走降级
  let _searcher = null
  const webSearch = async (q) => {
    try {
      if (!_searcher) _searcher = createSearchManager({ ...(Config.get().agent?.search || {}), fetcher: (typeof fetch !== 'undefined' && fetch) || undefined, logger: Log.tag('search') })
      if (!_searcher.availableProviders?.length) { Log.warn('[humanize-memory] 未配搜索引擎，网络梗学习降级（等群友解释路径兜底）'); return null }
      const r = await _searcher.search(q)
      return formatResults(r, { maxResults: 5, maxContent: 400 })
    } catch (e) { Log.warn('[humanize-memory] 梗搜索失败:', e?.message || e); return null }
  }

  // 对话落地层（Conversation Grounding）：谁在对谁说+实体白名单+纠错检测+bot↔bot闭环
  const { resolveGrounding, formatGroundingBlock, windowNames: winNames } = H
  const getGroundingRaw = (msgs) => {
    const knownBots = new Set([...(cfgFn().knownBots || []).map(String), ...botSelfIdsAll(rt)])
    const g = resolveGrounding(msgs, { knownBots })
    if (g) g.windowNames = winNames(msgs)
    return g
  }
  const getGroundingContext = (msgs, o = {}) => {
    try {
      const g = resolveGrounding(msgs, {
        knownBots: new Set([...(cfgFn().knownBots || []).map(String), ...botSelfIdsAll(rt)]),
        targetMessageId: o?.targetId,
      })
      if (g) g.windowNames = winNames(msgs)
      return g ? { grounding: g, block: formatGroundingBlock(g) } : null
    } catch { return null }
  }

  // ConversationScene 分析器（规则+LLM 混合；按 groupId+lastMessageId 缓存；失败降级规则不阻塞）
  const sceneAnalyzer = new H.ConversationSceneAnalyzer({ provider: rt.provider, cfg: cfgFn, trace })

  /** 近窗熟悉度代理：目标在近期群聊出现多 = 熟（GW online 时关系数据更准，此处零成本兜底）。 */
  function familiarityProxy(gid, targetUserId, _recentSelfTexts) {
    try {
      const win = manager?.getOrCreate?.(gid)?.runtime?.buffer?.snapshot(20, { includeSelf: false }) || []
      const n = win.filter((m) => targetUserId && String(m.userId) === String(targetUserId)).length
      return n >= 3 ? 0.8 : n >= 1 ? 0.5 : 0.3
    } catch { return 0.5 }
  }

  /** 本轮场景（Grounding → Scene；Gate/Planner/Replyer 共用同一对象）。RuntimeManager 按群转发。 */
  const getSceneForTurn = async (gid, { runtime, decision, messages, now } = {}) => {
    try {
      const g = getGroundingContext(messages || [], { targetId: decision?.targetMessage?.id })
      return await sceneAnalyzer.analyze({
        groupId: gid,
        messages: messages || [],
        grounding: g?.grounding || null,
        lastMessageId: decision?.targetMessage?.id || messages?.[messages.length - 1]?.id || null,
        signal: runtime?.signal || null,
        now,
      })
    } catch (e) { Log.debug('[humanize] 场景分析降级:', e?.message || e); return null }
  }

  const makePlanner = (gid) => new H.HumanizePlanner({
    provider: rt.provider, cfg: cfgFn, readTools,
    // 独立记忆库检索（替换原 rt.recall 适配——伪人记忆与主 Agent 记忆彻底分离）
    getMemories: async (q, o = {}) => {
      try {
        if (cfgFn().memory?.enabled === false) return ''
        // 梗词典按当前目标文本窄化注入；近期由 bot 真实使用过的梗在 store 层冷却，
        // 不再整本常驻 Planner。
        const dict = await hmem.jargonDict(gid, { queryText: q })
        // 收集本轮注入的记忆 id（真实发送成功后经 onDelivered → markUsed 登记使用）
        const collected = []
        const rel = await hmem.recallText({ groupId: gid, query: String(q || '').slice(0, 200), topK: cfgFn().memory?.maxPerQuery ?? 5, allowedUserIds: o?.threadUserIds, collectIds: collected })
        const tset = manager?.getOrCreate?.(gid)?.runtime?.turnMemoryIds
        if (tset) for (const id of collected) tset.add(id)
        return [dict, rel].filter(Boolean).join('\n')
      } catch (e) { Log.debug('[humanize] 记忆检索降级:', e?.message || e); return '' }
    },
    getBehaviorPolicyBlock: () => formatPolicyBlock(cfgFn().behaviorPolicy),
    getPersonaName: () => H.resolvePersonaIdentity(cfgFn(), { botNickname: botNickname() }).name,
    // 注意：Planner 不再接收完整 PersonaVoice（人设只给 Replyer）——决策器只需要角色名/行为政策/
    // 场景/归属/状态；全量人设会诱导它替角色写台词。
    getWorldContext: gwPlannerCtx,
    getSelfProjection: ssPlannerProj,
    enrichMedia,
    getGrounding: getGroundingContext,
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
    // 断点7：最近 8 条 bot 回复全文（重复检测从"上一条0.9字符相似"升级为"近8条语义+梗词复读"）
    getRecentBotTexts: () => {
      try {
        const ent = manager?.getOrCreate?.(gid)
        return (ent?.runtime?.buffer?.snapshot(30, { includeSelf: true })?.filter((m) => m.isSelf) || []).slice(-8).map((m) => String(m.text || ''))
      } catch { return [] }
    },
    // 自然风格示例：按当前 ConversationScene 检索 2~4 条（带场景/语气/熟悉度标签的人工样本）。
    // 样本来源：persona.styleExamples（用户自定义，全量覆盖默认）> 默认人设配套 DEFAULT_STYLE_EXAMPLES
    // （仅在使用默认人设时；自定义 persona 不带样本 → 不注入，避免风格错配）。
    // 绝不收录机器人自己生成的消息（防 AI 味自我强化）；近期用词重复惩罚用最近真实发送的 bot 文本。
    getStyleExamples: (_gid, o = {}) => {
      try {
        const cfg = cfgFn()
        const usingDefault = !cfg.persona?.prompt && !cfg.persona?.fromPersonaId
        const custom = Array.isArray(cfg.persona?.styleExamples) ? cfg.persona.styleExamples : []
        const examples = custom.length ? custom : (usingDefault ? H.DEFAULT_STYLE_EXAMPLES : [])
        if (!examples.length) return ''
        const recent = (manager?.getOrCreate?.(_gid)?.runtime?.buffer?.snapshot(30, { includeSelf: true })?.filter((m) => m.isSelf) || []).slice(-8).map((m) => String(m.text || ''))
        const picked = H.pickStyleExamples(examples, o?.scene || null, {
          familiarity: familiarityProxy(_gid, o?.targetUserId, recent),
          recentBotTexts: recent,
          queryText: String(o?.queryText || '').slice(0, 100),
        })
        return H.formatStyleExamples(picked, { identityName: H.resolvePersonaIdentity(cfgFn(), { botNickname: botNickname() }).name })
      } catch (e) { Log.debug('[humanize] 风格示例降级:', e?.message || e); return '' }
    },
    // 表情包清单注入：reply.allowSticker !== false 且表情包启用时给 Replyer 看 [sticker:名称] 与可用名表
    getStickerCatalog: () => (cfgFn().reply?.allowSticker !== false && sticker?.enabled?.() ? (sticker.catalog?.() || '') : ''),
    getWorldContext: gwReplyerCtx,
    getSelfCapsule: ssReplyerCap,
    enrichMedia,
    getGrounding: getGroundingContext,
    // 伪人独立记忆：对当前发言对象的印象 + 相关群梗（Replyer 用；失败/空零影响；热读配置）
    getMemoryBlock: async ({ groupId, targetUserId, queryText, allowedUserIds }) => {
      try {
        if (cfgFn().memory?.enabled === false) return ''
        const dict = await hmem.jargonDict(groupId, { queryText: queryText })
        const collected = []
        const rel = await hmem.recallText({ groupId, userId: targetUserId, query: queryText, topK: 3, kinds: ['impression'], allowedUserIds, collectIds: collected })
        const tset = manager?.getOrCreate?.(groupId)?.runtime?.turnMemoryIds
        if (tset) for (const id of collected) tset.add(id)
        return [dict, rel].filter(Boolean).join('\n')
      } catch (e) { Log.debug('[humanize] 记忆注入降级:', e?.message || e); return '' }
    },
  })
  const makeComposer = () => new H.HumanizeReplyComposer({ cfg: cfgFn, stickerManager: sticker })
  const makeSend = (gid) => makeSendFn(gid)

  manager = new H.RuntimeManager({
    store, trace, cfg: cfgFn, makePlanner, makeReplyer, makeComposer, makeSend, onDelivered: gwOnDelivered,
    // seq 地板（持久单调，锚在 hmem sqlite）：无 redis 时 KV 状态会丢，buffer 全过期后 seq 归零会
    // 被 hm 库的 consolidated_seq 高水位长期压制（项4）。floor 保证跨重启单调续号。
    seqFloor: { get: (gid) => hmem.getSeqFloor(gid), set: (gid, n) => hmem.setSeqFloor(gid, n) },
    getScene: getSceneForTurn,
  })

  // 配置热重载：取消所有进行中规划/未发送分段 + 重建信号量上限
  Config.onChange(() => {
    try { manager.reload(); manager.cancelAll(); Log.info('[humanize] 配置热加载，已取消所有进行中规划') } catch (e) { Log.warn('[humanize] 热加载失败', e?.message || e) }
  })

  // getPersona：把 rt 闭包在内，供 onAmbient 的 SelfState 感知解析人设（onAmbient 作用域无 rt）
  const getPersona = () => resolveHumanizePersona(cfgFn(), rt)
  return { manager, store, trace, cfgFn, ssLazy, getPersona, getGroundingRaw, webSearch, hmem }
}

/** 取伪人装配体（manager/hmem/trace 等；web 与测试用）。 */
export async function getHumanize() {
  if (_humanize) return _humanize
  if (_humanizeFailed) throw _humanizeFailed
  _humanize = await buildHumanize()
  return _humanize
}

/** 取 SelfStateService（web API 用；未装配/enabled=false → null）。 */
export async function getSelfState() {
  const h = await getHumanize()
  return (await h.ssLazy) || null
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
  // 角色名单一来源（persona.name > 旧 personaName > botNickname）：Normalizer/Planner/Replyer/SelfState 同源
  const { name } = H.resolvePersonaIdentity(cfg, { botNickname: botNickname() })
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

// （getHumanize 已上移导出——web/测试需要 hmem 等装配体）

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
        { reg: '^#伪人记忆(?:\\s+(\\d+))?$', fnc: 'humanizeMemory', permission: 'master' },
        { reg: '^[\\s\\S]+$', fnc: 'onAmbient', log: false }, // 旁听 catch-all（最后）
      ],
    })
    // 每天 04:17 压缩归档过期的伪人全链路日志（>24h 未修改的 .log → .gz）
    this.task = [{
      name: '伪人日志压缩归档',
      cron: '17 4 * * *',
      fnc: this.compressHumanizeLogs.bind(this),
    }, {
      name: '自我状态-反思',
      cron: '37 4 * * *',
      fnc: this.selfStateReflection.bind(this),
    }, {
      name: '自我状态-维护',
      cron: '43 4 * * *',
      fnc: this.selfStateMaintenance.bind(this),
    }, {
      name: '伪人记忆整合',
      cron: '47 4 * * *',
      fnc: this.humanizeMemoryConsolidate.bind(this),
    }, {
      name: '伪人记忆增量整合',
      cron: '23 * * * *', // 每小时轻整合：梗当天入库（此前每日一次，新梗要隔天才能被理解）
      fnc: this.humanizeMemoryConsolidate.bind(this),
    }]
    // 异步预热（不阻塞构造）
    getHumanize().catch(() => {})
  }

  /** 压缩归档伪人全链路日志（data/humanize-logs/ 下超过 24h 的 .log） */
  async compressHumanizeLogs() {
    try {
      const { default: compressOldLogs } = await import('../utils/compressLogs.js')
      const r = compressOldLogs(Config.path.humanizeLogs, { maxAgeMs: 24 * 3600 * 1000, logger: Log })
      if (r.compressed) Log.mark('[humanize] 日志压缩', `归档 ${r.compressed} 个旧日志（跳过 ${r.skipped} 个太新${r.failed ? `，失败 ${r.failed}` : ''}）`)
    } catch (e) { Log.warn('[humanize] 日志压缩失败', e?.message || e) }
  }

  /**
   * 伪人独立记忆"睡眠整合"（近期对话→长时记忆）+ 遗忘衰减。
   * 每小时增量版带水位闸（新增 ≥ incrementalMinMessages 条才烧 LLM）；04:47 每日版全量兜底。
   */
  async humanizeMemoryConsolidate() {
    try {
      const h = await getHumanize()
      const cfg = h.cfgFn()
      if (cfg.enable !== true || cfg.memory?.enabled === false) return
      const hourly = new Date().getHours() !== 4 // 04 点那次是每日全量，其余小时走水位闸
      for (const gid of (cfg.groups || []).map(String)) {
        try {
          const ent = h.manager.getOrCreate(gid)
          const rt = ent.runtime
          if (hourly && !await h.hmem.shouldConsolidate(gid, rt.buffer.lastSeq, cfg.memory?.incrementalMinMessages ?? 20)) continue
          // 断点1修复：只整合水位之后的新消息（此前每轮取最近100条——同一事件反复整合+重要性反复+0.05，
          // 造成"马赛克梗"被强化到最高权重。水位前的消息上轮已处理过）
          let since = await h.hmem.consolidatedSeq(gid)
          // 水位回退保护（项4）：旧 incarnation 高水位 + 缓冲全过期重启 → seq 从 0 重来会小于水位，
          // 增量整合长期不跑。安全重置到 0（旧消息已不在缓冲，重置不会重复强化已整合内容）。
          if (since > rt.buffer.lastSeq) {
            Log.info('[humanize] 记忆整合水位回退，重置到 0 重整合当前缓冲', `群${gid}`, since, '→', 0)
            await h.hmem.markConsolidated(gid, 0)
            since = 0
          }
          const msgs = rt.buffer.snapshotAfter(since).slice(-100)
          const r = await h.hmem.consolidate({ groupId: gid, messages: msgs })
          await h.hmem.decay(gid)
          Log.mark('[humanize] 记忆整合', `群${gid} 新增${r.created} 合并${r.merged}${r.skipped ? `（跳过:${r.skipped}）` : ''}${hourly ? ' [增量]' : ' [日全量]'}`)
          // 网络梗学习：整合时发现的词典外梗 → 上网查释义（去重+置信+重试三闸防污染）
          if (Array.isArray(r.suspected) && r.suspected.length) {
            const lr = await h.hmem.learnJargonFromWeb({ groupId: gid, terms: r.suspected, webSearch: h.webSearch })
            if (r.suspected.length) Log.mark('[humanize] 网络梗学习', `群${gid} 候选${r.suspected.join('、')} → 学会${lr.learned} 跳过${lr.skipped} 失败${lr.failed}`)
          }
        } catch (e) { Log.warn('[humanize] 记忆整合失败', gid, e?.message || e) }
      }
    } catch (e) { Log.warn('[humanize] 记忆整合任务失败', e?.message || e) }
  }

  /** SelfState 每日反思（§13）与维护（衰减/过期/§20.5 恢复/retention）。 */
  async selfStateReflection() {
    const cfg = Config.get().agent?.selfState
    if (cfg?.enabled !== true) return
    try {
      const ss = new SelfStateService({
        provider: (await getRuntime().catch(() => null))?.provider || null,
        cfg: () => cfg, botId: botNicknameSelfId(), dataDir: Config.path.data + '/groupworld',
      })
      await ss.init()
      for (const gid of (Config.get().agent?.humanize?.groups || []).map(String)) await ss.runReflection(gid)
    } catch (e) { Log.warn('[selfstate] 反思任务失败', e?.message || e) }
  }

  async selfStateMaintenance() {
    const cfg = Config.get().agent?.selfState
    if (cfg?.enabled !== true) return
    try {
      const ss = new SelfStateService({
        provider: (await getRuntime().catch(() => null))?.provider || null,
        cfg: () => cfg, botId: botNicknameSelfId(), dataDir: Config.path.data + '/groupworld',
      })
      await ss.init()
      for (const gid of (Config.get().agent?.humanize?.groups || []).map(String)) await ss.runMaintenance(gid)
    } catch (e) { Log.warn('[selfstate] 维护任务失败', e?.message || e) }
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
    const botNames = H.resolvePersonaIdentity(cfg, { botNickname: botNickname() }).identityNames
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

    // 富化跨窗口引用：优先缓冲；未命中时用 getReply/get_msg/history 取轻量快照。
    // 快照只挂在当前消息上，不把历史消息 append 成新的候选消息。
    let quoteIsBot = false
    let ent = null
    if (!norm.isSelf && norm.replyToId) {
      try {
        ent = h.manager.getOrCreate(norm.groupId)
        let replied = ent.runtime.buffer.get(norm.replyToId) || norm.replySource
        if (!replied || !String(replied.text || '').trim()) {
          const rawReply = await fetchReply(e, {
            bot: (typeof Bot !== 'undefined' && Bot) || null,
            log: (msg) => Log.debug('[humanize] 引用补全:', msg),
          })
          const source = H.normalizeReplySource(rawReply, { selfIds, fallbackId: norm.replyToId })
          if (source) {
            norm.replySource = source
            replied = source
          }
        }
        if (replied?.isSelf) { norm.quotesBot = true; quoteIsBot = true }
      } catch { /* noop */ }
    }

    // SelfState 感知（§4.2：即使最终 Planner ignore，指向机器人的事件仍改变内部状态；失败零影响）。
    // scene：同一 ConversationScene 模块的**规则场景**（热路径逐消息感知不调 LLM；Gate/Planner/Replyer
    // 轮次用的是混合场景——同一 schema 同一模块，评价 LLM 从此不再面对空 scene）
    let ss = null
    try {
      ss = await h.ssLazy
      if (ss && norm.userId) {
        const persona = h.getPersona()
        let ruleScene = null
        try {
          const preBuf = h.manager?.getOrCreate?.(norm.groupId)?.runtime?.buffer?.snapshot(10, { includeSelf: true }) || []
          ruleScene = H.ruleScene([...preBuf, norm], null, { now: Date.now() })
        } catch { ruleScene = null }
        ss.onMessage(norm, { groupId: norm.groupId, quoteIsBot, personaText: persona.prompt, personaName: persona.name, scene: ruleScene || undefined }).catch(() => {})
      }
    } catch { /* noop */ }

    // 对象纠错独立于 SelfState 开关：当前纠错消息允许回应一次，随后只暂停同一发送者 2 分钟。
    // 必须带完整窗口做 grounding——被纠正的人名在历史里，单传 [norm] 无法识别。
    if (norm.userId) {
      try {
        ent ||= h.manager.getOrCreate(norm.groupId)
        const buf = ent.runtime.buffer.snapshot(30, { includeSelf: true })
        const g = h.getGroundingRaw([...buf, norm])
        if (g?.correction) {
          ent.runtime.markReferenceCorrection(norm.userId, norm.id, Date.now() + 2 * 60 * 1000)
          ss?.applyCorrection?.({ groupId: norm.groupId, userId: String(norm.userId) })
            ?.catch?.((err) => Log.warn('[selfstate] 纠错冲销失败:', err?.message || err))
        }
      } catch (err) { Log.debug('[humanize] 纠错检测异常:', err?.message || err) }
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

  /** #伪人记忆 [群号]——查看伪人独立记忆库（最近条目 + 统计）。 */
  async humanizeMemory() {
    let h
    try { h = await getHumanize() } catch (e) { return this.e.reply(`伪人模式未就绪：${e?.message || e}`, true) }
    const gid = String(this.e.msg.match(/\d+/)?.[1] || this.e.group_id || (h.cfgFn().groups || [])[0] || '')
    if (!gid) return this.e.reply('请指定群号或在白名单群内使用：#伪人记忆 960179589', true)
    const st = await h.hmem.stats(gid)
    const rows = await h.hmem.recent(gid, 15)
    if (!st?.total) return this.e.reply(`群 ${gid} 暂无伪人记忆（每日 04:47 自动整合，或等群聊积累后查看）。`, true)
    const KIND_ZH = { impression: '印象', event: '事件', jargon: '群梗', style: '风格' }
    const lines = rows.map((r) => `- [${KIND_ZH[r.kind] || r.kind}${r.user_id ? `@${String(r.user_id).slice(-4)}` : ''}] ${String(r.content).slice(0, 60)}（重要${(Number(r.importance) * 100) | 0}% 用${r.hit_count}次）`)
    await this.e.reply([`伪人记忆（群 ${gid}，共 ${st.total} 条 / 累计引用 ${st.hits} 次）：`, ...lines].join('\n'), true)
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
