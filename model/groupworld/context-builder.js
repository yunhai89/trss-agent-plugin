/**
 * WorldContextBuilder —— 为 Planner/Replyer 生成不同结构的社会现场（设计文档 §9.3、§10.2/10.3）。
 *
 * 检索由 WorldRetriever 完成；这里做：结构化组装 + 按角色独立 token 预算截断 + 渲染为 prompt 片段。
 *   - Planner 预算 plannerTokenBudget（默认 800）：含圈子摘要、更多关系/旧事，用于判断"该不该参与/态度"；
 *   - Replyer 预算 replyerTokenBudget（默认 500）：通常不带圈子，聚焦称呼/距离感/可自然提及的旧事。
 * 截断顺序：先丢圈子 → 旧事 → 关系 → 画像特征（保住"是谁"最小信息）。预算超限时绝不硬切半句话。
 */
import { buildSocialSceneBlock } from './prompts.js'
import { estTokens } from './scoring.js'
import { TIER_LABEL } from './retriever.js'

export class WorldContextBuilder {
  /**
   * @param {object} opts { retriever, cfg:()=>object, trace? }
   */
  constructor({ retriever, cfg, trace = null }) {
    if (!retriever) throw new Error('WorldContextBuilder 需要 retriever')
    this.retriever = retriever
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.trace = trace
    this._cache = new Map() // gather 结果 TTL 缓存（retrieval.cacheTtlSeconds，曾为死配置键）
  }

  /** 失效某群缓存（recordInteraction 写回关系后调用，保证下次读到新关系）。 */
  invalidate(groupId) { this._cache.delete(String(groupId)) }

  /** Planner 现场。返回 { empty, socialScene, text }。 */
  async buildPlannerContext(input) {
    return this._build(input, 'planner', Number(this._cfgFn().retrieval?.plannerTokenBudget) || 800)
  }

  /** Replyer 现场。返回 { empty, socialScene, text }。 */
  async buildReplyerContext(input) {
    return this._build(input, 'replyer', Number(this._cfgFn().retrieval?.replyerTokenBudget) || 500)
  }

  /**
   * gather TTL 缓存：同一（群/焦点用户/角色/话题）在 cacheTtlSeconds 内复用检索结果。
   * 主要收益是同轮 Planner+Replyer 双查询合一（topicText 同源必命中）；跨消息 60s 内
   * 话题未变也命中。写入路径（recordInteraction/画像纠正）经 invalidate() 立即失效。
   */
  async _gatherCached(input, role, now) {
    const ttl = Number(this._cfgFn().retrieval?.cacheTtlSeconds)
    if (!Number.isFinite(ttl) || ttl <= 0) {
      return this.retriever.gather({ botId: input.botId, groupId: input.groupId, focusUserId: input.focusUserId, relatedUserIds: input.relatedUserIds || [], topicText: input.topicText || '', now })
    }
    const key = `${role}|${input.groupId}|${input.focusUserId || ''}|${input.topicText || ''}`
    const hit = this._cache.get(String(input.groupId))?.get(key)
    if (hit && now - hit.at < ttl * 1000) return hit.raw
    const raw = await this.retriever.gather({ botId: input.botId, groupId: input.groupId, focusUserId: input.focusUserId, relatedUserIds: input.relatedUserIds || [], topicText: input.topicText || '', now })
    let bucket = this._cache.get(String(input.groupId))
    if (!bucket) { bucket = new Map(); this._cache.set(String(input.groupId), bucket) }
    bucket.set(key, { at: now, raw })
    return raw
  }

  async _build(input, role, budget) {
    const now = input.now || Date.now()
    let raw
    try {
      raw = await this._gatherCached(input, role, now)
    } catch (e) {
      // §15.1 降级：检索失败 → 空现场，不阻断
      this.trace?.record?.('gw_retrieve', { groupId: input.groupId, err: String(e?.message || e).slice(0, 80) })
      return { empty: true, socialScene: null, text: '' }
    }
    if (raw.empty) return { empty: true, socialScene: null, text: '' }

    const scene = this._assemble(raw, role, input.focusUserId)
    this._fitBudget(scene, role, budget)
    const text = buildSocialSceneBlock(scene, { role })
    this.trace?.record?.('gw_retrieve', { groupId: input.groupId, role, tokens: estTokens(text), traits: scene.focusUser?.relevantTraits?.length || 0, episodes: scene.relevantEpisodes.length, rels: scene.relevantRelationships.length })
    return { empty: false, socialScene: scene, text }
  }

  /** 组装结构化现场（buildSocialSceneBlock 消费的形态）。 */
  _assemble(raw, role, focusUserId) {
    const fp = raw.focusProfile
    const focusUser = {
      userId: focusUserId,
      displayName: fp?.current_nickname || focusUserId,
      activityTier: fp ? (TIER_LABEL[fp.activity_tier] || fp.activity_tier) : '陌生（首次见到）',
      relevantTraits: (raw.focusTraits || []).map((t) => ({ text: t.trait_value, confidence: t.confidence, source_type: t.source_type })),
    }
    const maxRels = Number.isFinite(Number(this._cfgFn().retrieval?.maxRelationships)) ? Math.max(0, Number(this._cfgFn().retrieval.maxRelationships)) : 5
    const relevantRelationships = []
    const seenRel = new Set() // 同一 userId 去重（修 M5：边邻居与@相关人重复罗列）
    for (const e of (raw.edges || []).slice(0, maxRels)) {
      if (seenRel.has(String(e.otherId))) continue
      seenRel.add(String(e.otherId))
      const dirLabel = e.dir === '↔' ? '（互动频繁）' : e.dir === '→' ? '（TA常找对方）' : '（对方常找TA）'
      relevantRelationships.push({ summary: `${e.displayName}${dirLabel}${e.hint ? '：' + e.hint : ''}` })
    }
    for (const u of (raw.relatedUsers || [])) {
      if (relevantRelationships.length >= maxRels) break
      if (seenRel.has(String(u.userId))) continue // 已由边推送，不重复
      seenRel.add(String(u.userId))
      relevantRelationships.push({ summary: `${u.displayName}（${u.tier ? TIER_LABEL[u.tier] || '?' : '在场'}）${u.edge?.hint ? '：' + u.edge.hint : ''}` })
    }
    const relevantEpisodes = (raw.episodes || []).map((e) => ({
      summary: e.summary,
      confidence: e.confidence,
      occurredAt: e.occurredAt,
    }))
    // preferred_name（称呼）透传给 Replyer（修 M6：查了却丢，无法自然称呼）
    const botRelation = raw.botRel
      ? { familiarity: raw.botRel.familiarity, affinity: raw.botRel.affinity, interactionStyle: raw.botRel.interaction_style || '', preferredName: raw.botRel.preferred_name || '' }
      : null
    const communitySummary = role === 'planner' && raw.community ? `${raw.community.summary}${raw.community.tags?.length ? '（话题：' + raw.community.tags.join('/') + '）' : ''}` : null
    return { empty: false, focusUser, botRelation, relevantRelationships, relevantEpisodes, communitySummary }
  }

  /** 按预算裁剪：圈子 → 旧事 → 关系 → 特征。 */
  _fitBudget(scene, role, budget) {
    const measure = () => estTokens(buildSocialSceneBlock(scene, { role }))
    let guard = 50
    while (measure() > budget && guard-- > 0) {
      if (scene.communitySummary) { scene.communitySummary = null; continue }
      if (scene.relevantEpisodes.length) { scene.relevantEpisodes.pop(); continue }
      if (scene.relevantRelationships.length) { scene.relevantRelationships.pop(); continue }
      if (scene.focusUser?.relevantTraits?.length) { scene.focusUser.relevantTraits.pop(); continue }
      break // 只剩最小信息，无法再裁
    }
  }
}
