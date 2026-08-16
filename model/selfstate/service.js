/**
 * SelfStateService —— §21.1 接口聚合。对 apps 层唯一入口。
 *
 * onMessage（感知+评价+迁移+期待解析一体）→ 事件入库/情绪/心境/关系残留/心事。
 * buildPlannerProjection / buildReplyerCapsule（shadow/frozen 恒中性）。
 * registerOutgoingExpectation（仅真实发送）。runMaintenance / runReflection。
 * resetGroupState / clearMemberResidue / markEventMisjudged / toggleShadow / freezeExpression。
 * getOverview / getRelations / getStats（web 面板）。
 * 红线：所有公开方法不抛错——失败降级中性/空（§22.1），绝不影响消息链路。
 */
import Log from '../../utils/Log.js'
import * as Db from '../groupworld/db.js'
import { SelfCoreCompiler, personaVersion } from './self-core.js'
import { SelfEventDetector } from './detector.js'
import { AppraisalEngine } from './appraisal.js'
import { EmotionTransition } from './emotion.js'
import { ExpectationManager } from './expectations.js'
import { ConcernManager } from './concerns.js'
import { SelfReflectionJob } from './reflection.js'
import { StateProjector } from './projector.js'
import { StateMaintenance } from './maintenance.js'
import { resolveSelfStateConfig } from './default-config.js'
import { makeEmbedder } from '../groupworld/embedding.js'

export class SelfStateService {
  /**
   * @param {object} opts { provider, cfg:()=>object, botId, botNames?:string[], trace? }
   *   dao 复用 GroupWorld 的 sqlite 单例（需 GroupWorld db 已/将初始化——service.init 会 initDb）
   */
  constructor({ provider, cfg, botId, botNames = [], trace = null, dataDir, embedFn = null, embedModel = 'default' } = {}) {
    this.provider = provider
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.botId = String(botId || 'bot')
    this.botNames = botNames
    this.trace = trace
    this.dataDir = dataDir
    this.embedder = embedFn ? makeEmbedder({ embedFn, model: embedModel }) : null
    this._ready = false
    this._initPromise = null
    this._coreCache = null
  }

  cfg() { return resolveSelfStateConfig(this._cfgFn() || {}) }
  isReady() { return this._ready }

  async init() {
    if (this._ready) return true
    if (this._initPromise) return this._initPromise
    this._initPromise = (async () => {
      try {
        await Db.initDb({ dir: this.dataDir })
        const dao = Db.dao
        const cFn = () => this.cfg()
        if (!cFn().enabled) { this._ready = false; return false } // 关闭时不装配
        const model = cFn().eventDetection?.ambiguousIntentModelProfile || null
        this.dao = dao
        this.core = new SelfCoreCompiler({ dao, provider: this.provider, model })
        this.detector = new SelfEventDetector({ botIds: new Set([this.botId]), botNames: this.botNames, cfg: cFn, embedder: this.embedder })
        this.appraiser = new AppraisalEngine({ dao, provider: this.provider, model, cfg: cFn, trace: this.trace })
        this.emotion = new EmotionTransition({ dao, cfg: cFn, trace: this.trace })
        this.expectations = new ExpectationManager({ dao, cfg: cFn, trace: this.trace })
        this.concerns = new ConcernManager({ dao, emotion: this.emotion, cfg: cFn, trace: this.trace })
        this.reflection = new SelfReflectionJob({ dao, provider: this.provider, model, cfg: cFn, trace: this.trace })
        this.projector = new StateProjector({ dao, emotion: this.emotion, concerns: this.concerns, reflection: this.reflection, cfg: cFn, trace: this.trace })
        this.maintenance = new StateMaintenance({ dao, emotion: this.emotion, cfg: cFn, trace: this.trace })
        this._ready = true
        Log.info('[selfstate] 服务就绪', `shadow=${this.cfg().shadowMode}`)
        return true
      } catch (e) {
        Log.warn('[selfstate] 初始化失败，降级禁用', e?.message || e)
        this._ready = false
        return false
      } finally { this._initPromise = null }
    })()
    return this._initPromise
  }

  // ─────────────── 核心：感知一条消息（§4.2 升级链路前半）───────────────
  /**
   * 检测+评价+迁移+期待解析。不抛错。返回 { events:number, ignored:number }|null。
   * @param {object} norm AmbientMessage
   * @param {object} ctx { groupId, quoteIsBot, personaText?, personaName? }
   */
  async onMessage(norm, ctx = {}) {
    if (!await this.init() || !this._ready) return null
    try {
      const groupId = String(ctx.groupId || norm?.groupId || '')
      if (!groupId) return null
      const now = Date.now()
      const botId = this.botId

      // 期待解析（先于检测：回应可完成期待；到期可产生冷落事件）
      const fulfilled = await this.expectations.resolveForMessage({ botId, groupId, norm, quoteIsBot: !!ctx.quoteIsBot, now })
      // 得到回应的正反馈（§12.1/§16.2）：期待被真实回应 → response_received 事件
      // （此前该类型在默认 minEventConfidence 下经 detector 不可达——带指向的回应消息会先 fulfill 期待）
      for (const f of fulfilled) {
        await this._applyEvent({
          botId, groupId,
          actorUserId: String(f.expectation.target_user_id ?? norm.userId ?? '') || null,
          eventType: 'response_received',
          appraisal: {
            self_relevance: 0.6, desirability: 0.3, directedness: 0.5, certainty: 0.8,
            other_agency: 0.9, controllability: 0.5, expectedness: 0.5, norm_violation: 0,
            publicness: 0.5, repetition: 0, relationship_closeness: 0.5, playfulness: 0.2, repair_signal: 0,
          },
          semantic: {}, sourceMessageIds: [String(norm.id)], now,
        })
      }
      const expiredIgnored = await this.expectations.sweepExpired({ botId, groupId, now })

      // 冷落事件（仅高置信 ignored；uncertain 不影响关系 §16.3）
      let ignoredCount = 0
      for (const ig of expiredIgnored) {
        const appraisal = {
          self_relevance: 0.7, desirability: -0.35, directedness: 0.6, certainty: ig.confidence,
          other_agency: 0.9, controllability: 0.2, expectedness: 0.4, norm_violation: 0.1,
          publicness: 0.5, repetition: 0.3, relationship_closeness: 0.5, playfulness: 0, repair_signal: 0,
        }
        await this._applyEvent({ botId, groupId, actorUserId: ig.targetUserId, eventType: 'ignored_expectation', appraisal, semantic: {}, sourceMessageIds: [ig.expectation.source_message_id], now })
        ignoredCount++
      }

      // 事件检测
      const hasPending = await this.dao.get(
        "SELECT 1 FROM ss_expectations WHERE bot_id=? AND group_id=? AND target_user_id IS ? AND status='pending' LIMIT 1",
        [botId, groupId, String(norm?.userId ?? '')],
      ).catch(() => null)
      const candidate = await this.detector.detect(norm, { hasPendingExpectation: !!hasPending, quoteIsBot: !!ctx.quoteIsBot })
      if (!candidate) return { events: 0, ignored: ignoredCount }

      // 自我核心（缓存）
      const core = await this._getCore(ctx)
      // 关系背景（gw_bot_rel）
      const relation = await this._relation(groupId, norm.userId)
      // 评价（scene：调用方传入的真实当前会话场景——同一 ConversationScene 模块的规则产物；
      // 旧实现恒传 {}，评价 LLM 看不到任何对话语境）
      const result = await this.appraiser.appraise({ botId, groupId, candidate, norm, relation, scene: ctx.scene || {}, now })
      if (!result) return { events: 0, ignored: ignoredCount }
      this.trace?.record?.('ss_event', { groupId, type: result.eventType, actor: norm.userId, conf: Math.round(result.confidence * 100) / 100 })

      // 迁移（修复类先走 repair 路径 §12）
      if (result.eventType === 'apology' || result.eventType === 'repair') {
        if (norm.userId) await this.concerns.applyRepair({
          botId, groupId, actorUserId: String(norm.userId),
          repairSignal: result.semantic?.repair_signal ?? 0.75,
          sincerity: result.semantic?.sincerity ?? 0.7, now,
        })
        // §16.3 repaired：该成员的冷落/不确定期待一并标记已修复
        if (norm.userId) await this.expectations.markRepaired({ botId, groupId, targetUserId: String(norm.userId), now })
      }
      const applied = await this._applyEvent({ botId, groupId, actorUserId: norm.userId ? String(norm.userId) : null, eventType: result.eventType, appraisal: result.appraisal, semantic: result.semantic, sourceMessageIds: candidate.sourceMessageIds, core, now })
      return { events: applied ? 1 : 0, ignored: ignoredCount }
    } catch (e) {
      Log.warn('[selfstate] onMessage 失败（降级跳过）', e?.message || e)
      return null
    }
  }

  async _applyEvent({ botId, groupId, actorUserId, eventType, appraisal, semantic, sourceMessageIds, core, now }) {
    const r = await this.emotion.applyEvent({ botId, groupId, actorUserId, eventType, appraisal, semantic, sourceMessageIds, core, now })
    await this.concerns.onEvent({ botId, groupId, actorUserId, eventType, appraisal, eventId: r.eventId, significance: r.significance ?? 0, now })
    return r
  }

  async _getCore(ctx) {
    const pv = personaVersion(`${ctx.personaText || ''}|${ctx.personaName || ''}`)
    if (this._coreCache && this._coreCache.version === pv) return this._coreCache
    const core = await this.core.getOrCompile({ botId: this.botId, personaText: ctx.personaText || '', personaName: ctx.personaName || '' })
    this._coreCache = core
    return core
  }

  async _relation(groupId, userId) {
    if (!userId) return {}
    const r = await this.dao.get('SELECT familiarity,affinity,trust,interaction_style,resentment,guardedness FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [this.botId, groupId, String(userId)]).catch(() => null)
    if (!r) return { familiarity: 0.15 }
    // 互损历史近似：interaction_style 含"互损/调侃" → reciprocalTeasing
    return { ...r, reciprocalTeasing: /互损|调侃|互怼/.test(String(r.interaction_style || '')) }
  }

  // ─────────────── 投影（Planner/Replyer）───────────────
  async buildPlannerProjection(input) {
    if (!await this.init() || !this._ready) return { neutral: true, projection: null, text: '' }
    try { return await this.projector.buildPlannerProjection({ botId: this.botId, ...input }) } catch { return { neutral: true, projection: null, text: '' } }
  }

  async buildReplyerCapsule(input) {
    if (!await this.init() || !this._ready) return { neutral: true, capsule: null, text: '' }
    try { return await this.projector.buildReplyerCapsule({ botId: this.botId, ...input }) } catch { return { neutral: true, capsule: null, text: '' } }
  }

  // ─────────────── 出站期待（§16.1）───────────────
  async registerOutgoingExpectation({ groupId, sourceMessageId, targetUserId = null, sentText = '', replyGuide = '' }) {
    if (!await this.init() || !this._ready) return null
    try { return await this.expectations.register({ botId: this.botId, groupId, sourceMessageId, targetUserId, sentText, replyGuide }) } catch { return null }
  }

  // ─────────────── 定时任务 ───────────────
  async runMaintenance(groupId) { if (await this.init() && this._ready) return this.maintenance.runGroup({ botId: this.botId, groupId }); return null }
  async runReflection(groupId) { if (await this.init() && this._ready) return this.reflection.runGroup({ botId: this.botId, groupId }); return null }

  // ─────────────── 控制（web §19.3）───────────────
  async resetGroupState(groupId) {
    if (!await this.init() || !this._ready) return false
    const g = String(groupId); const now = Date.now()
    await this.dao.txn(async () => {
      await this.dao.run('DELETE FROM ss_group_state WHERE bot_id=? AND group_id=?', [this.botId, g])
      await this.dao.run("UPDATE ss_emotions SET status='resolved', resolved_at=?, intensity=0 WHERE bot_id=? AND group_id=? AND status='active'", [now, this.botId, g])
      await this.dao.run("UPDATE ss_expectations SET status='naturally_expired', resolved_at=? WHERE bot_id=? AND group_id=? AND status='pending'", [now, this.botId, g])
      await this.dao.run("UPDATE ss_concerns SET status='resolved', resolved_at=? WHERE bot_id=? AND group_id=? AND status='active'", [now, this.botId, g])
    }).catch(() => {})
    this.trace?.record?.('ss_privacy', { groupId: g, action: 'reset_group' })
    return true
  }

  async clearMemberResidue(groupId, userId) {
    if (!await this.init() || !this._ready) return false
    const g = String(groupId); const u = String(userId); const now = Date.now()
    await this.dao.run(
      'UPDATE gw_bot_rel SET gratitude=0,hurt=0,resentment=0,disappointment=0,guardedness=0,unresolved_event_count=0,updated_at=? WHERE bot_id=? AND group_id=? AND user_id=?',
      [now, this.botId, g, u],
    ).catch(() => {})
    await this.dao.run("UPDATE ss_concerns SET status='resolved', resolved_at=? WHERE bot_id=? AND group_id=? AND target_user_id=? AND status='active'", [now, this.botId, g, u]).catch(() => {})
    await this.dao.run("UPDATE ss_emotions SET status='resolved', resolved_at=?, intensity=0 WHERE bot_id=? AND group_id=? AND target_user_id=? AND status='active'", [now, this.botId, g, u]).catch(() => {})
    this.trace?.record?.('ss_privacy', { groupId: g, action: 'clear_member', target: u })
    return true
  }

  async markEventMisjudged(eventId) {
    if (!await this.init() || !this._ready) return false
    await this.dao.run("UPDATE ss_events SET status='misjudged' WHERE id=?", [Number(eventId)]).catch(() => {})
    this.trace?.record?.('ss_privacy', { action: 'mark_misjudged', eventId })
    return true
  }

  /** 对象纠错冲销（Conversation Grounding）：认错人后对方说"我说的是X" →
   *  撤销错误指代产生的情绪与关系残留（复用 repair 路径：降即时 anger/hurt + 缓降残留 + 关心事 + 期待标记 repaired）。 */
  async applyCorrection({ groupId, userId }) {
    if (!await this.init() || !this._ready || !userId) return false
    try {
      await this.concerns.applyRepair({ botId: this.botId, groupId: String(groupId), actorUserId: String(userId), repairSignal: 1.0, sincerity: 0.95 })
      await this.expectations.markRepaired({ botId: this.botId, groupId: String(groupId), targetUserId: String(userId) })
      await this.dao.run("UPDATE ss_events SET status='misjudged' WHERE bot_id=? AND group_id=? AND actor_user_id=? AND status='active' AND event_type IN ('direct_insult','rejection','public_embarrassment') AND occurred_at>?", [this.botId, String(groupId), String(userId), Date.now() - 30 * 60000]).catch(() => {})
      this.trace?.record?.('ss_correction', { groupId: String(groupId), target: String(userId), rolledBack: true })
      return true
    } catch (e) { Log.warn('[selfstate] 纠错冲销失败', e?.message || e); return false }
  }

  async setExpressionFrozen(groupId, frozen) {
    if (!await this.init() || !this._ready) return false
    await this.dao.run('UPDATE ss_group_state SET expression_frozen=?, updated_at=? WHERE bot_id=? AND group_id=?', [frozen ? 1 : 0, Date.now(), this.botId, String(groupId)]).catch(() => {})
    return true
  }

  // ─────────────── 查询（web §19.1/19.2）───────────────
  async getOverview(groupId) {
    if (!await this.init() || !this._ready) return null
    const g = String(groupId); const now = Date.now()
    const state = await this.dao.get('SELECT * FROM ss_group_state WHERE bot_id=? AND group_id=?', [this.botId, g]).catch(() => null)
    const emotions = await this.emotion.decayAndGetActive(this.botId, g, now)
    const withCause = []
    for (const e of emotions.slice(0, 10)) {
      const ev = await this.dao.get('SELECT id,event_type,actor_user_id,occurred_at FROM ss_events WHERE id=?', [e.cause_event_id]).catch(() => null)
      withCause.push({ ...e, cause: ev })
    }
    const expectations = await this.dao.all("SELECT * FROM ss_expectations WHERE bot_id=? AND group_id=? AND status='pending' ORDER BY expires_at LIMIT 20", [this.botId, g]).catch(() => [])
    const concerns = await this.concerns.activeAll(this.botId, g)
    const reflections = await this.reflection.activeAll(this.botId, g, now)
    const lastTransition = await this.dao.get('SELECT * FROM ss_transitions WHERE bot_id=? AND group_id=? ORDER BY id DESC LIMIT 1', [this.botId, g]).catch(() => null)
    const cfg = this.cfg()
    return { state, emotions: withCause, expectations, concerns, reflections, lastTransition, shadowMode: cfg.shadowMode, enabled: cfg.enabled }
  }

  async getRelations(groupId) {
    if (!await this.init() || !this._ready) return []
    return this.dao.all(
      `SELECT user_id, familiarity,affinity,trust,gratitude,hurt,resentment,disappointment,guardedness,unresolved_event_count,last_affective_event_at
       FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND (gratitude>0 OR hurt>0 OR resentment>0 OR disappointment>0 OR guardedness>0 OR familiarity>0) ORDER BY resentment DESC, hurt DESC LIMIT 100`,
      [this.botId, String(groupId)],
    ).catch(() => [])
  }

  async getStats(groupId) {
    if (!await this.init() || !this._ready) return null
    const g = String(groupId)
    const cnt = async (where) => { try { const r = await this.dao.get(`SELECT COUNT(*) c FROM ${where.table} WHERE bot_id=? AND group_id=? AND ${where.cond}`, [this.botId, g]); return Number(r?.c) || 0 } catch { return 0 } }
    return {
      // 修复：此前五条 SQL 缺 WHERE 占位符却传参 → "Too many parameter values" 被吞 → 统计恒 0
      events: await cnt({ table: 'ss_events', cond: "status='active'" }),
      emotions: await cnt({ table: 'ss_emotions', cond: "status='active'" }),
      pendingExpectations: await cnt({ table: 'ss_expectations', cond: "status='pending'" }),
      concerns: await cnt({ table: 'ss_concerns', cond: "status='active'" }),
      reflections: await cnt({ table: 'ss_reflections', cond: "status='active'" }),
    }
  }
}
