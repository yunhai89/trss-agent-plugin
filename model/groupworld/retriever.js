/**
 * WorldRetriever —— 在线选择性检索（设计文档 §9）。
 *
 * 每条触发候选消息到来时，构造一个**小型局部社会现场**，而非整个关系图（§3.5 检索先于生成）。
 * 默认检索顺序：当前发言者 → 被@/引用者 → 机器人主观关系 → 一跳关系 → 话题相关共同经历 → 圈子摘要。
 *
 * 硬过滤先于评分（§7.4）：群不一致、机器人身份不一致、已过期、低置信、敏感、已删除、已退出。
 * 一跳默认（§9.1 maxOnlineHops=1）；只返回关系摘要 + 必要昵称，不返回他人完整画像（§9.2、§12.3）。
 *
 * 产出原始候选；由 context-builder 按角色预算截断格式化。topic 相似度用 jaccard（热路径零额外调用，
 * 与 RecallStore 兜底同模；embedding 留作后续增强）。
 */
import { retrievalScore, recencyFactor } from './scoring.js'
import { textSim, fromBlob, hybridSim } from './embedding.js'
import Log from '../../utils/Log.js'

const TIER_LABEL = { hot: '常驻', warm: '偶尔出现', cold: '潜水', archived: '已离开' }

export class WorldRetriever {
  /**
   * @param {object} opts { dao, cfg:()=>object, trace?, embedder? }
   *   embedder = makeEmbedder 产物（可选；缺省 topic 相似度走词面 textSim，零影响）
   */
  constructor({ dao, cfg, trace = null, embedder = null }) {
    if (!dao) throw new Error('WorldRetriever 需要 dao')
    this.dao = dao
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.trace = trace
    this.embedder = embedder
  }

  /**
   * 收集原始社会现场。
   * @param {object} o { botId, groupId, focusUserId, relatedUserIds?, topicText?, now? }
   * @returns {Promise<object>} { empty, focusProfile, focusTraits, botRel, relatedUsers, edges, episodes, community }
   */
  async gather({ botId, groupId, focusUserId, relatedUserIds = [], topicText = '', now = Date.now() }) {
    const empty = { empty: true, focusProfile: null, focusTraits: [], botRel: null, relatedUsers: [], edges: [], episodes: [], community: null }
    if (!groupId || !focusUserId) return empty

    // 硬过滤：退出建模的用户不构造现场（§12）
    const opt = await this.dao.get('SELECT 1 FROM gw_optout WHERE group_id=? AND user_id=?', [groupId, focusUserId])
    if (opt) return empty
    // 群内退出用户集合（邻居/相关人也不得泄露其昵称/活跃度——修 H1：曾只保护焦点）
    const optRows = await this.dao.all('SELECT user_id FROM gw_optout WHERE group_id=?', [groupId]).catch(() => [])
    const optOut = new Set((optRows || []).map((r) => String(r.user_id)))

    const c = this._cfgFn()
    const g = c.graph || {}; const p = c.profiles || {}
    const minConf = Number(p.minOnlineConfidence) || 0.55
    const maxTraits = Math.max(1, Number(p.maxTraitsPerUser) || 5)
    // 0 应能禁用（修 M1/M2：Number(x)||默认 会吞 0）
    const maxEdges = Number.isFinite(Number(g.maxNeighborsPerUser)) ? Math.max(0, Number(g.maxNeighborsPerUser)) : 40
    const maxEpisodes = Number.isFinite(Number(c.retrieval?.maxEpisodes)) ? Math.max(0, Number(c.retrieval.maxEpisodes)) : 3

    // 焦点用户画像（陌生人无画像/无特征 → 不凭空生成，§16.3-B）
    const focusProfile = await this.dao.get('SELECT * FROM gw_member_profiles WHERE group_id=? AND user_id=?', [groupId, focusUserId])
    // 特征独立加载：被纠正/自述过但近期无发言（无 profile 行）的用户仍应看到其可信特征；
    // 真正的陌生人无特征行 → 自然为空。
    const focusTraits = await this.dao.all(
      'SELECT trait_type,trait_key,trait_value,source_type,confidence FROM gw_traits WHERE group_id=? AND user_id=? AND status=? AND confidence>=? AND (expires_at IS NULL OR expires_at>?) ORDER BY confidence DESC, last_observed_at DESC LIMIT ?',
      [groupId, focusUserId, 'active', minConf, now, maxTraits],
    )

    // 机器人主观关系
    let botRel = null
    if (botId) {
      botRel = await this.dao.get('SELECT familiarity,affinity,trust,interaction_style,preferred_name FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [botId, groupId, focusUserId])
    }

    // 一跳关系边（Phase 2）：focus 与他人的有向互动，按 otherId 合并双向（取较强向 + 标双向），按强度取 top
    const edges = []
    if (maxEdges > 0) {
      const eRows = await this.dao.all(
        'SELECT from_user_id,to_user_id,interaction_strength,inferred_relation FROM gw_edges WHERE group_id=? AND (from_user_id=? OR to_user_id=?) AND interaction_strength>0 ORDER BY interaction_strength DESC LIMIT ?',
        [groupId, focusUserId, focusUserId, maxEdges * 2],
      )
      const byOther = new Map() // otherId -> merged
      for (const e of eRows) {
        const otherId = String(e.from_user_id === focusUserId ? e.to_user_id : e.from_user_id)
        if (otherId === String(focusUserId) || optOut.has(otherId)) continue // 退出建模者不泄露
        const outgoing = e.from_user_id === focusUserId
        const strength = Number(e.interaction_strength) || 0
        const cur = byOther.get(otherId)
        if (!cur) {
          byOther.set(otherId, { otherId, outgoing, incoming: !outgoing, strength, hint: e.inferred_relation || '' })
        } else {
          if (outgoing) cur.outgoing = true; else cur.incoming = true
          if (strength > cur.strength) { cur.strength = strength; if (e.inferred_relation) cur.hint = e.inferred_relation }
        }
      }
      for (const e of [...byOther.values()].sort((a, b) => b.strength - a.strength).slice(0, maxEdges)) {
        const name = await this._displayName(groupId, e.otherId)
        edges.push({ otherId: e.otherId, displayName: name, dir: e.outgoing && e.incoming ? '↔' : (e.outgoing ? '→' : '←'), strength: e.strength, hint: e.hint })
      }
    }

    // 相关旧事：按检索评分取 top。topic 相似度：episode 有 embedding 且 topicText 非空 → 余弦；
    // 否则中文友好词面 textSim 兜底（双模，同 RecallStore；每轮检索至多 1 次 embed，可被空 topicText 跳过）
    const episodes = []
    if (maxEpisodes > 0) {
      let topicEmb = null
      if (this.embedder && topicText) topicEmb = await this.embedder.embed(topicText).catch(() => null)
      const epRows = await this.dao.all(
        "SELECT id,title,summary,participant_ids,topic_tags,importance,confidence,occurred_at,embedding FROM gw_episodes WHERE group_id=? AND status=? AND (expires_at IS NULL OR expires_at>?) ORDER BY importance DESC LIMIT 30",
        [groupId, 'active', now],
      )
      const scored = epRows.map((e) => {
        let participants = []; try { participants = JSON.parse(e.participant_ids || '[]') } catch { /* noop */ }
        let tags = []; try { tags = JSON.parse(e.topic_tags || '[]') } catch { /* noop */ }
        const targetMatch = participants.includes(focusUserId) ? 1 : (relatedUserIds.some((u) => participants.includes(u)) ? 0.5 : 0)
        const topicSimV = hybridSim(topicEmb, fromBlob(e.embedding), topicText, `${e.title} ${e.summary} ${tags.join(' ')}`)
        const rec = recencyFactor((now - (e.occurred_at || now)) / 86400000, 60)
        const score = retrievalScore({ currentTargetMatch: targetMatch, topicSimilarity: topicSimV, graphProximity: 0, recency: rec, importance: e.importance, confidence: e.confidence })
        return { ...e, _score: score }
      }).filter((e) => e._score > 0.05).sort((a, b) => b._score - a._score).slice(0, maxEpisodes)
      for (const e of scored) episodes.push({ id: e.id, summary: e.summary, confidence: e.confidence, occurredAt: e.occurred_at })
    }

    // 圈子摘要（仅 planner 用；context-builder 按 role 决定是否带）
    let community = null
    if (g.weeklyCommunityDetection !== false) {
      const comms = await this.dao.all('SELECT member_ids,topic_tags,summary,confidence FROM gw_communities WHERE group_id=? ORDER BY created_at DESC LIMIT 30', [groupId])
      for (const cm of comms) {
        let members = []; try { members = JSON.parse(cm.member_ids || '[]') } catch { /* noop */ }
        if (members.includes(focusUserId)) {
          let tags = []; try { tags = JSON.parse(cm.topic_tags || '[]') } catch { /* noop */ }
          community = { summary: cm.summary || '该成员属于一个活跃小圈子', tags: tags.slice(0, 3), confidence: cm.confidence }
          break
        }
      }
    }

    // 相关用户（被@/引用者）：基础画像 + 与 focus 的关系摘要。退出建模者跳过（不泄露昵称/活跃度）。
    const relatedUsers = []
    for (const uid of [...new Set(relatedUserIds)].filter((u) => u && String(u) !== String(focusUserId) && !optOut.has(String(u))).slice(0, 3)) {
      const rp = await this.dao.get('SELECT current_nickname,activity_tier FROM gw_member_profiles WHERE group_id=? AND user_id=?', [groupId, uid])
      const edge = edges.find((e) => String(e.otherId) === String(uid))
      relatedUsers.push({ userId: uid, displayName: rp?.current_nickname || uid, tier: rp?.activity_tier, edge })
    }

    return { empty: false, focusProfile, focusTraits, botRel, relatedUsers, edges, episodes, community, minConf }
  }

  /** 取昵称（缓存可选；MVP 直接查）。 */
  async _displayName(groupId, userId) {
    const r = await this.dao.get('SELECT current_nickname FROM gw_member_profiles WHERE group_id=? AND user_id=?', [groupId, userId])
    return r?.current_nickname || userId
  }
}

export { TIER_LABEL }
export { textSim } from './embedding.js'
