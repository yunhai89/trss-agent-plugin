/**
 * GroupWorldService —— §14.1 接口聚合 + 定时任务入口 + 隐私操作 + 统计。
 *
 * 持有全部子组件（ingester/segmenter/resolver/analyzer/retriever/contextBuilder/maintenance/community），
 * 对外暴露统一接口；apps 层（groupworld.js / humanize.js）只依赖此服务。
 *
 * 降级（§15.1）：所有在线查询（buildPlannerContext/buildReplyerContext/recordInteraction）失败 → 返回空/不阻断。
 * 惰性初始化：首次使用时 initDb；sqlite3 未装/失败 → isReady()=false，ingest/分析跳过，在线检索返回空。
 */
import path from 'node:path'
import Log, { ANSI } from '../../utils/Log.js'
import * as Db from './db.js'
import { GroupWorldIngester } from './ingest.js'
import { ConversationSegmenter } from './segmenter.js'
import { EvidenceResolver } from './evidence.js'
import { WorldAnalyzer } from './analyzer.js'
import { WorldRetriever } from './retriever.js'
import { WorldContextBuilder } from './context-builder.js'
import { WorldMaintenance } from './maintenance.js'
import { CommunityDetector } from './community.js'
import { resolveGroupWorldConfig } from './default-config.js'
import { isSensitiveContent, isValueLabelContent } from './prompts.js'
import { makeEmbedder } from './embedding.js'

// 主观关系单次变化上限（§5.6：不让单次互动大幅改变）
const REL_DELTA = { familiarity: 0.04, affinity: 0.05, trust: 0.04 }
const REL_MIN = -1; const REL_MAX = 1

export class GroupWorldService {
  /**
   * @param {object} opts { provider, cfg:()=>object, dataDir, botId?, trace?, embedFn?, embedModel? }
   *   embedFn = (text)=>Promise<number[]>（同 recall.embedFn 契约；未配 → 语义层禁用，词面兜底，零影响）
   *   embedModel = embedding 模型 id（存 meta；换模型自动清存量 embedding 由维护回填重建）
   */
  constructor({ provider, cfg, dataDir, botId = null, trace = null, embedFn = null, embedModel = 'default' }) {
    this.provider = provider
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.dataDir = dataDir
    this.botId = botId ? String(botId) : null
    this.trace = trace
    this._embedFn = embedFn
    this._embedModel = embedModel
    this._ready = false
    this._initPromise = null
  }

  cfg() { return resolveGroupWorldConfig(this._cfgFn() || {}) }

  /** 惰性初始化（建 DB + 子组件）。幂等。 */
  async init() {
    if (this._ready) return true
    if (this._initPromise) return this._initPromise
    this._initPromise = (async () => {
      try {
        await Db.initDb({ dir: this.dataDir })
        const dao = Db.dao
        const cFn = () => this.cfg()
        this.dao = dao
        // P0 语义层：嵌入器（可选）+ 模型一致性检查（换模型 → 清存量，维度/语义空间不兼容）
        this.embedder = makeEmbedder({ embedFn: this._embedFn, model: this._embedModel })
        if (this.embedder) await this._checkEmbeddingModel(dao)
        this.ingester = new GroupWorldIngester({ dao, trace: this.trace })
        this.segmenter = new ConversationSegmenter({ dao, trace: this.trace, embedder: this.embedder })
        this.resolver = new EvidenceResolver({ dao, minOnlineConfidence: cFn().profiles.minOnlineConfidence, embedder: this.embedder, episodeMergeSim: cFn().analysis?.episodeMergeSim })
        this.analyzer = new WorldAnalyzer({ provider: this.provider, dao, segmenter: this.segmenter, resolver: this.resolver, cfg: cFn, trace: this.trace, botId: this.botId })
        this.retriever = new WorldRetriever({ dao, cfg: cFn, trace: this.trace, embedder: this.embedder })
        this.contextBuilder = new WorldContextBuilder({ retriever: this.retriever, cfg: cFn, trace: this.trace })
        this.community = new CommunityDetector({ dao, cfg: cFn, trace: this.trace })
        this.maintenance = new WorldMaintenance({ dao, community: this.community, cfg: cFn, trace: this.trace, embedder: this.embedder })
        this._ready = true
        Log.info('[groupworld] 服务就绪', path.join(this.dataDir, 'gw.db'), this.embedder ? `语义层:${this.embedder.model}` : '语义层:词面')
        return true
      } catch (e) {
        Log.warn('[groupworld] 初始化失败（sqlite3 未装？），GroupWorld 降级为空', e?.message || e)
        this._ready = false
        return false
      } finally {
        this._initPromise = null
      }
    })()
    return this._initPromise
  }

  /** embedding 模型一致性：与 meta 不符 → 清空全部存量 embedding（回填任务会重建），并记新模型。 */
  async _checkEmbeddingModel(dao) {
    try {
      const meta = await dao.get("SELECT value FROM gw_meta WHERE key='embedding_model'")
      if ((meta?.value || null) !== this.embedder.model) {
        await dao.run('UPDATE gw_traits SET embedding=NULL')
        await dao.run('UPDATE gw_episodes SET embedding=NULL')
        await dao.run("INSERT OR REPLACE INTO gw_meta(key,value) VALUES ('embedding_model',?)", [this.embedder.model])
        if (meta?.value) Log.info('[groupworld] embedding 模型变更，已清空存量向量（维护任务将回填）')
      }
    } catch { /* noop */ }
  }

  isReady() { return this._ready }

  // ─────────────── 摄入 ───────────────
  async ingestMessage(norm) {
    if (!await this.init()) return { id: null, isNew: false }
    // 退出建模的用户不摄入（§12）
    if (norm?.userId && await this.ingester.isOptedOut(String(norm.groupId), String(norm.userId))) return { id: null, isNew: false, optout: true }
    return this.ingester.ingestMessage(norm)
  }

  // ─────────────── 在线检索（Planner/Replyer） ───────────────
  async buildPlannerContext(input) {
    if (!await this.init() || !this.cfg().online) return { empty: true, socialScene: null, text: '' }
    try { return await this.contextBuilder.buildPlannerContext({ ...input, botId: input.botId || this.botId }) } catch (e) { Log.warn('[groupworld] buildPlannerContext 失败', e?.message || e); return { empty: true, socialScene: null, text: '' } }
  }

  async buildReplyerContext(input) {
    if (!await this.init() || !this.cfg().online) return { empty: true, socialScene: null, text: '' }
    try { return await this.contextBuilder.buildReplyerContext({ ...input, botId: input.botId || this.botId }) } catch (e) { Log.warn('[groupworld] buildReplyerContext 失败', e?.message || e); return { empty: true, socialScene: null, text: '' } }
  }

  // ─────────────── 主观关系写回（§10.4） ───────────────
  /**
   * @param {object} o { botId?, groupId, targetUserId, kind:'reply_to_bot'|'friendly'|'reliable'|'conflict'|'neutral', now? }
   */
  async recordInteraction({ botId, groupId, targetUserId, kind = 'neutral', now = Date.now() }) {
    if (!await this.init() || !this.cfg().online) return
    const bot = String(botId || this.botId || 'bot')
    if (!groupId || !targetUserId) return
    const deltas = this._relDeltas(kind)
    try {
      const existing = await this.dao.get('SELECT * FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [bot, String(groupId), String(targetUserId)])
      const clamp = (v) => Math.max(REL_MIN, Math.min(REL_MAX, v))
      if (existing) {
        await this.dao.run(
          'UPDATE gw_bot_rel SET familiarity=?, affinity=?, trust=?, interaction_count=interaction_count+1, last_interacted_at=?, updated_at=? WHERE bot_id=? AND group_id=? AND user_id=?',
          [clamp((Number(existing.familiarity) || 0) + deltas.familiarity), clamp((Number(existing.affinity) || 0) + deltas.affinity), clamp((Number(existing.trust) || 0) + deltas.trust), now, now, bot, String(groupId), String(targetUserId)],
        )
      } else {
        await this.dao.run(
          'INSERT INTO gw_bot_rel(bot_id,group_id,user_id,familiarity,affinity,trust,interaction_count,last_interacted_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [bot, String(groupId), String(targetUserId), clamp(deltas.familiarity), clamp(deltas.affinity), clamp(deltas.trust), 1, now, now],
        )
      }
    } catch (e) { Log.warn('[groupworld] recordInteraction 失败', e?.message || e) }
  }

  _relDeltas(kind) {
    switch (kind) {
      case 'reply_to_bot': return { familiarity: REL_DELTA.familiarity, affinity: 0, trust: 0 }
      case 'friendly': return { familiarity: REL_DELTA.familiarity * 0.5, affinity: REL_DELTA.affinity, trust: 0 }
      case 'reliable': return { familiarity: 0, affinity: 0, trust: REL_DELTA.trust }
      case 'conflict': return { familiarity: 0, affinity: -REL_DELTA.affinity, trust: 0 } // 单次冲突只记，不大改长期
      default: return { familiarity: REL_DELTA.familiarity * 0.3, affinity: 0, trust: 0 }
    }
  }

  // ─────────────── 隐私操作（§12.2/12.3） ───────────────

  /** 查看自己的画像（标注来源/置信/更新时间）。 */
  async inspectUserProfile(groupId, userId) {
    if (!await this.init()) return null
    const g = String(groupId); const u = String(userId)
    const profile = await this.dao.get('SELECT current_nickname,activity_tier,message_count_30d,active_days_30d,last_spoke_at,opt_out FROM gw_member_profiles WHERE group_id=? AND user_id=?', [g, u])
    const optedOut = !!(await this.dao.get('SELECT 1 FROM gw_optout WHERE group_id=? AND user_id=?', [g, u]))
    const traits = await this.dao.all('SELECT trait_type,trait_value,source_type,confidence,last_observed_at FROM gw_traits WHERE group_id=? AND user_id=? ORDER BY confidence DESC', [g, u])
    return { profile, optedOut, traits }
  }

  /** 纠正画像（本人/管理员）：写高置信 admin_corrected 特征。
   *  敏感/价值标签内容拒绝入库（修 E-H1：曾直接存原文绕过过滤，PII 可经 #纠正 高注入库+回显；与分析器路径对齐）。 */
  async correctUserProfile(groupId, userId, content) {
    if (!await this.init() || !content) return false
    if (this.cfg().privacy?.blockSensitiveInference !== false && (isSensitiveContent(content) || isValueLabelContent(content))) {
      this.trace?.record?.('gw_privacy', { groupId, action: 'correct_blocked_sensitive' })
      return false
    }
    const now = Date.now()
    await this.resolver.mergeTraitCandidate({
      groupId: String(groupId), userId: String(userId),
      candidate: { trait_type: 'self_disclosed_fact', trait_key: 'user_correction', trait_value: String(content).slice(0, 500), scope: '本人纠正' },
      evidenceMsgs: [{ text: String(content).slice(0, 200), sent_at: now }],
      sourceType: 'admin_corrected', now,
    })
    this.trace?.record?.('gw_privacy', { groupId, action: 'correct' })
    return true
  }

  /** 删除自己的画像（派生数据全删；不强制 optout）。 */
  async deleteUserProfile(groupId, userId) {
    if (!await this.init()) return false
    await this.ingester.purgeUser(String(groupId), String(userId))
    this.trace?.record?.('gw_privacy', { groupId, action: 'delete' })
    return true
  }

  /** 关闭/开启对我的建模。关闭时同时清除已有派生数据（修 E-L1：曾残留底层表）。 */
  async setOptOut(groupId, userId, on) {
    if (!await this.init()) return false
    await this.ingester.setOptOut(String(groupId), String(userId), on)
    if (on) await this.ingester.purgeUser(String(groupId), String(userId))
    this.trace?.record?.('gw_privacy', { groupId, action: on ? 'opt_out' : 'opt_in' })
    return true
  }

  // ─────────────── 定时任务入口 ───────────────
  async runHourlyAnalysis(groupId) { if (await this.init()) return this.analyzer.runHourly(String(groupId)); return null }
  async runDailyMaintenance(groupId) { if (await this.init()) return this.maintenance.runDaily(String(groupId)); return null }
  async runWeeklyCommunity(groupId) { if (await this.init()) return this.maintenance.runWeekly(String(groupId)); return null }

  /** 删整群派生数据（主人 #群世界清理）。 */
  async purgeGroup(groupId, opts) { if (await this.init()) return this.ingester.purgeGroup(String(groupId), opts || {}); return null }

  // ─────────────── 统计（看板/状态命令） ───────────────
  async getStats(groupId) {
    if (!await this.init()) return null
    const g = String(groupId)
    const count = async (sql) => { try { const r = await this.dao.get(sql, [g]); return Number(r?.c) || 0 } catch { return 0 } }
    return {
      members: await count("SELECT COUNT(*) c FROM gw_member_profiles WHERE opt_out=0 AND group_id=?"),
      hotMembers: await count("SELECT COUNT(*) c FROM gw_member_profiles WHERE activity_tier='hot' AND group_id=?"),
      traits: await count("SELECT COUNT(*) c FROM gw_traits WHERE status='active' AND group_id=?"),
      edges: await count("SELECT COUNT(*) c FROM gw_edges WHERE group_id=?"),
      episodes: await count("SELECT COUNT(*) c FROM gw_episodes WHERE status='active' AND group_id=?"),
      communities: await count("SELECT COUNT(*) c FROM gw_communities WHERE group_id=?"),
      pendingSegments: await count("SELECT COUNT(*) c FROM gw_segments WHERE status='closed' AND group_id=?"),
      deadSegments: await count("SELECT COUNT(*) c FROM gw_segments WHERE status='dead_letter' AND group_id=?"),
      cursor: await this.dao.get('SELECT * FROM gw_cursor WHERE group_id=?', [g]).catch(() => null),
    }
  }

  // ─────────────── 数据浏览（web 面板/主人） ───────────────

  /** 成员列表（按 30d 发言数降序）。tier 可选过滤。 */
  async listMembers(groupId, { tier = null, limit = 200, offset = 0 } = {}) {
    if (!await this.init()) return []
    const params = [String(groupId)]
    let where = 'WHERE group_id=? AND opt_out=0'
    if (tier) { where += ' AND activity_tier=?'; params.push(tier) }
    params.push(Math.max(1, Math.min(1000, Number(limit) || 200)), Math.max(0, Number(offset) || 0))
    return this.dao.all(
      `SELECT user_id,current_nickname,activity_tier,message_count_30d,message_count_7d,active_days_30d,last_spoke_at,updated_at FROM gw_member_profiles ${where} ORDER BY message_count_30d DESC LIMIT ? OFFSET ?`,
      params,
    )
  }

  /** 单成员画像详情：profile + 特征(+证据) + 与各 bot 主观关系 + 一跳关系边。 */
  async getProfileDetail(groupId, userId) {
    if (!await this.init()) return null
    const g = String(groupId); const u = String(userId)
    const profile = await this.dao.get('SELECT * FROM gw_member_profiles WHERE group_id=? AND user_id=?', [g, u])
    const traits = await this.dao.all('SELECT id,trait_type,trait_key,trait_value,scope,source_type,confidence,evidence_count,first_observed_at,last_observed_at,expires_at,status FROM gw_traits WHERE group_id=? AND user_id=? ORDER BY confidence DESC', [g, u])
    const evidByTrait = {}
    if (traits.length) {
      const ids = traits.map((t) => t.id)
      const evs = await this.dao.all(`SELECT target_id,message_id,evidence_text,observed_at FROM gw_evidence WHERE target_type='trait' AND target_id IN (${ids.map(() => '?').join(',')}) LIMIT 300`, ids).catch(() => [])
      for (const e of evs) { (evidByTrait[e.target_id] ||= []).push(e) }
    }
    const botRels = await this.dao.all('SELECT bot_id,familiarity,affinity,trust,interaction_count,interaction_style,preferred_name,last_interacted_at FROM gw_bot_rel WHERE group_id=? AND user_id=?', [g, u])
    const edges = await this.dao.all('SELECT from_user_id,to_user_id,reply_count_30d,mention_count_30d,interaction_strength,inferred_relation,last_interacted_at FROM gw_edges WHERE group_id=? AND (from_user_id=? OR to_user_id=?) ORDER BY interaction_strength DESC LIMIT 30', [g, u, u])
    return { profile, traits, evidByTrait, botRels, edges }
  }

  /** 群事件/群梗列表。 */
  async listEpisodes(groupId, { limit = 50 } = {}) {
    if (!await this.init()) return []
    return this.dao.all(
      "SELECT id,episode_type,title,summary,participant_ids,topic_tags,importance,confidence,occurred_at,last_referenced_at,status FROM gw_episodes WHERE group_id=? ORDER BY importance DESC, occurred_at DESC LIMIT ?",
      [String(groupId), Math.max(1, Math.min(200, Number(limit) || 50))],
    )
  }

  /** 小圈子列表（最新在前）。 */
  async listCommunities(groupId, { limit = 30 } = {}) {
    if (!await this.init()) return []
    return this.dao.all(
      "SELECT id,algorithm,member_ids,core_member_ids,topic_tags,summary,confidence,valid_from,valid_until,created_at FROM gw_communities WHERE group_id=? ORDER BY created_at DESC LIMIT ?",
      [String(groupId), Math.max(1, Math.min(100, Number(limit) || 30))],
    )
  }
}

export { REL_DELTA }
