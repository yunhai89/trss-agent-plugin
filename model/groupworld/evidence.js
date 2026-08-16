/**
 * EvidenceResolver —— 证据合并、冲突处理、置信度计算（设计文档 §3.6、§7.2、§8.3）。
 *
 * 核心原则（§3.1 事实/推断分离 + §8.3 模型置信度只是候选）：
 *   - LLM 给的 confidence 只是候选值；系统用 scoring.confidence() 重新计算后入库。
 *   - 同 (group,user,trait_type,trait_key) 的候选合并：证据数 +1、补 last_observed_at、重算置信度。
 *   - 多个不同日期反复出现 → distinctDates 提升 consistency；与现有 value 明显冲突 → 计 contradictions 降一致性。
 *   - value 取已观测中置信度最高者；写入 gw_evidence 可回溯。
 *   - 低置信（< minOnlineConfidence）仍入库（供后台审计），但 retriever 硬过滤不进在线上下文。
 */
import { confidence as computeConfidence } from './scoring.js'
import { toBlob, fromBlob, cosine } from './embedding.js'
import Log from '../../utils/Log.js'

const dayKey = (ms) => { const d = new Date(Number(ms) || Date.now()); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }

/** 归一化 trait_value 用于冲突比较（去空白/小写/截断）。 */
function normValue(v) {
  return String(v || '').replace(/\s+/g, '').toLowerCase().slice(0, 80)
}

export class EvidenceResolver {
  /**
   * @param {object} opts { dao, minOnlineConfidence?, embedder?, episodeMergeSim? }
   *   embedder = makeEmbedder 产物（可选；缺省一切走词面，零影响）
   */
  constructor({ dao, minOnlineConfidence = 0.55, embedder = null, episodeMergeSim = 0.85 } = {}) {
    if (!dao) throw new Error('EvidenceResolver 需要 dao')
    this.dao = dao
    this.minOnlineConfidence = minOnlineConfidence
    this.embedder = embedder
    this.episodeMergeSim = episodeMergeSim
  }

  /** 写入后算并存 embedding（失败静默，词面兜底不受影响）。 */
  async _storeEmbedding(table, id, text) {
    if (!this.embedder || !id) return
    try {
      const v = await this.embedder.embed(text)
      if (v) await this.dao.run(`UPDATE ${table} SET embedding=? WHERE id=?`, [toBlob(v), id])
    } catch { /* noop */ }
  }

  /**
   * 合并一个画像候选 → upsert gw_traits + 写 gw_evidence。
   * @param {object} o { groupId, userId, candidate, evidenceMsgs:[{message_id, text, sent_at}], sourceType?, optOut?:Set, now }
   *   candidate = { trait_type, trait_key, trait_value, scope?, confidence?(候选，被忽略) }
   *   optOut = 写入前最终复查的退出集合（分析时段与入库时段之间用户可能已退出，防旧 pending 重建画像）
   * @returns {Promise<{traitId:number, isNew:boolean, confidence:number}>}
   */
  async mergeTraitCandidate({ groupId, userId, candidate, evidenceMsgs = [], sourceType = 'inferred', optOut = null, now = Date.now() }) {
    if (!groupId || !userId || !candidate?.trait_type || !candidate?.trait_key) return { traitId: null, isNew: false, confidence: 0 }
    if (optOut?.has?.(String(userId))) return { traitId: null, isNew: false, confidence: 0, skipped: 'optout' }
    const traitType = String(candidate.trait_type)
    const traitKey = String(candidate.trait_key).slice(0, 64)
    const value = String(candidate.trait_value || '').slice(0, 512)
    const scope = candidate.scope ? String(candidate.scope).slice(0, 128) : null

    const existing = await this.dao.get(
      'SELECT * FROM gw_traits WHERE group_id=? AND user_id=? AND trait_type=? AND trait_key=? AND status!=? ORDER BY id DESC LIMIT 1',
      [groupId, userId, traitType, traitKey, 'expired'],
    )

    let traitId
    let distinctDates = 1
    let contradictions = 0
    let evidenceCount = 1

    if (existing) {
      traitId = existing.id
      // 历史证据：distinct 日期（跨多天反复出现 → 提升）
      const evRows = await this.dao.all('SELECT observed_at FROM gw_evidence WHERE target_type=? AND target_id=?', ['trait', traitId])
      const dates = new Set(evRows.map((e) => dayKey(e.observed_at)))
      dates.add(dayKey(now))
      distinctDates = dates.size
      evidenceCount = evRows.length + 1
      // 冲突：新 value 与现有 value 明显不同 → 计 1 次（不再用 evidence_text 误判，原文几乎永不等于 trait_value 会系统性夸大）
      contradictions = (normValue(value) && normValue(value) !== normValue(existing.trait_value)) ? 1 : 0
      // 重算置信度（recency 锚 last_observed_at）
      const conf = computeConfidence({ sourceType: existing.source_type || sourceType, evidenceCount, distinctDates, contradictions, daysSince: (now - (existing.last_observed_at || existing.first_observed_at)) / 86400000 })
      // value：若新候选置信（按本批单证据估）高于现有存量置信则替换；否则保留并记冲突已降置信
      const keepValue = conf >= (Number(existing.confidence) || 0) ? value : existing.trait_value
      await this.dao.run(
        `UPDATE gw_traits SET trait_value=?, confidence=?, evidence_count=?, last_observed_at=?, status=?, updated_at=? WHERE id=?`,
        [keepValue, Math.round(conf * 10000) / 10000, evidenceCount, now, 'active', now, traitId],
      )
      await this._writeEvidence(groupId, 'trait', traitId, evidenceMsgs, now, '', String(userId))
      await this._storeEmbedding('gw_traits', traitId, keepValue)
      return { traitId, isNew: false, confidence: conf }
    }

    // 新建
    const conf = computeConfidence({ sourceType, evidenceCount, distinctDates, contradictions, daysSince: 0 })
    const res = await this.dao.run(
      `INSERT INTO gw_traits(group_id,user_id,trait_type,trait_key,trait_value,scope,source_type,confidence,evidence_count,first_observed_at,last_observed_at,expires_at,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [groupId, userId, traitType, traitKey, value, scope, sourceType, Math.round(conf * 10000) / 10000, evidenceCount, now, now, this._defaultExpiry(traitType, now), 'active', now, now],
    )
    traitId = res?.lastID ?? null
    if (traitId) {
      await this._writeEvidence(groupId, 'trait', traitId, evidenceMsgs, now, '', String(userId))
      await this._storeEmbedding('gw_traits', traitId, value)
    }
    return { traitId, isNew: true, confidence: conf }
  }

  /**
   * 合并关系候选 → 更新 gw_edges.inferred_relation/relation_confidence（不重复统计 reply/mention）。
   * @param {object} o { groupId, fromUserId, toUserId, hint, evidenceMsgs, optOut?:Set, now }
   */
  async mergeRelationCandidate({ groupId, fromUserId, toUserId, hint, evidenceMsgs = [], optOut = null, now = Date.now() }) {
    if (!groupId || !fromUserId || !toUserId || fromUserId === toUserId) return
    if (optOut?.has?.(String(fromUserId)) || optOut?.has?.(String(toUserId))) return
    const conf = computeConfidence({ sourceType: 'inferred', evidenceCount: (evidenceMsgs.length || 1), distinctDates: 1, contradictions: 0, daysSince: 0 })
    try {
      const res = await this.dao.run(
        'UPDATE gw_edges SET inferred_relation=?, relation_confidence=?, updated_at=? WHERE group_id=? AND from_user_id=? AND to_user_id=?',
        [String(hint || '').slice(0, 128) || null, Math.round(conf * 10000) / 10000, now, groupId, fromUserId, toUserId],
      )
      if (!res?.changes) {
        await this.dao.run(
          'INSERT INTO gw_edges(group_id,from_user_id,to_user_id,inferred_relation,relation_confidence,first_interacted_at,last_interacted_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
          [groupId, fromUserId, toUserId, String(hint || '').slice(0, 128) || null, Math.round(conf * 10000) / 10000, now, now, now],
        )
      }
      // 关系证据挂在虚拟 target（用 from→to 复合 id 不便；这里以 target_type='edge' + target_id=NULL + segment 证据文本留痕）
      await this._writeEvidence(groupId, 'edge', 0, evidenceMsgs, now, `${fromUserId}>${toUserId}:${hint || ''}`, String(fromUserId))
    } catch (e) { Log.warn('[groupworld] mergeRelationCandidate 失败', e?.message || e) }
  }

  /**
   * 合并事件候选 → upsert gw_episodes（近似去重：同 group+title / 语义近义）。
   * @param {object} o { groupId, candidate, participantIds, topicTags, evidenceMsgs, optOut?:Set, now }
   *   candidate = { episode_type, title, summary, importance? }
   *   participantIds/topicTags 须为**真实稳定 user id / 已校验标签**（analyzer 侧完成匿名反映射与校验）；
   *   合并已有 episode 时参与者与标签取并集（不能只更新 summary 丢人物/话题）。
   */
  async mergeEpisodeCandidate({ groupId, candidate, participantIds = [], topicTags = [], evidenceMsgs = [], optOut = null, now = Date.now() }) {
    if (!groupId || !candidate?.title) return null
    const title = String(candidate.title).slice(0, 128)
    const summary = String(candidate.summary || '').slice(0, 1000)
    // 退出建模者不进事件参与者（群级事件保留，但参与者名单剔除）
    const parts = [...new Set((Array.isArray(participantIds) ? participantIds : []).map(String).filter((p) => p && !(optOut?.has?.(p))))].slice(0, 30)
    const tags = [...new Set((Array.isArray(topicTags) ? topicTags : []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 8)
    // 先算一次 embedding（语义去重 + 存储复用，避免双调）
    let emb = null
    if (this.embedder) emb = await this.embedder.embed(`${title} ${summary}`)
    // 去重：① 完全同 title；② 语义近义（余弦 ≥ episodeMergeSim，不再只认字面 title）
    let existing = await this.dao.get('SELECT id, confidence, importance, participant_ids, topic_tags FROM gw_episodes WHERE group_id=? AND title=? AND status=? ORDER BY id DESC LIMIT 1', [groupId, title, 'active'])
    if (!existing && emb) {
      try {
        const cands = await this.dao.all("SELECT id, confidence, importance, participant_ids, topic_tags, embedding FROM gw_episodes WHERE group_id=? AND status='active'", [groupId])
        for (const c of cands) {
          const sim = cosine(emb, fromBlob(c.embedding))
          if (sim != null && sim >= this.episodeMergeSim) { existing = c; break }
        }
      } catch { /* noop */ }
    }
    // episode 也按 distinct 日期累积可信度（不再恒封顶 2）
    let epDistinct = 1
    if (existing) {
      const evRows = await this.dao.all('SELECT observed_at FROM gw_evidence WHERE target_type=? AND target_id=?', ['episode', existing.id])
      const dates = new Set(evRows.map((e) => dayKey(e.observed_at))); dates.add(dayKey(now)); epDistinct = dates.size
    }
    const conf = computeConfidence({ sourceType: 'inferred', evidenceCount: (evidenceMsgs.length || 1), distinctDates: epDistinct, contradictions: 0, daysSince: 0 })
    const imp = Math.max(0, Math.min(1, Number(candidate.importance) || 0.4))
    if (existing) {
      const newConf = Math.max(Number(existing.confidence) || 0, conf)
      // 参与者/话题标签并集合入（不能只更新 summary——曾把已有参与者清丢，检索端人物/话题匹配失效）
      const mergeArr = (cur, add) => {
        let a = []; try { a = JSON.parse(cur || '[]') } catch { /* noop */ }
        return [...new Set([...a.map(String), ...add.map(String)])]
      }
      const mergedParts = mergeArr(existing.participant_ids, parts).slice(0, 30)
      const mergedTags = mergeArr(existing.topic_tags, tags).slice(0, 8)
      await this.dao.run(
        'UPDATE gw_episodes SET summary=?, importance=?, confidence=?, participant_ids=?, topic_tags=?, last_referenced_at=?, updated_at=? WHERE id=?',
        [summary, Math.max(Number(existing.importance) || 0, imp), newConf, JSON.stringify(mergedParts), JSON.stringify(mergedTags), now, now, existing.id],
      )
      // 重复出现也要写证据（否则 distinctDates 无法跨日累积，置信恒封顶）
      await this._writeEvidence(groupId, 'episode', existing.id, evidenceMsgs, now)
      return existing.id
    }
    const res = await this.dao.run(
      `INSERT INTO gw_episodes(group_id,episode_type,title,summary,participant_ids,topic_tags,importance,confidence,occurred_at,last_referenced_at,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [groupId, String(candidate.episode_type || 'ongoing_topic').slice(0, 32), title, summary,
        JSON.stringify(parts), JSON.stringify(tags), imp, Math.round(conf * 10000) / 10000, now, now, 'active', now, now],
    )
    const epId = res?.lastID ?? null
    if (epId) {
      await this._writeEvidence(groupId, 'episode', epId, evidenceMsgs, now)
      if (emb && toBlob(emb)) await this.dao.run('UPDATE gw_episodes SET embedding=? WHERE id=?', [toBlob(emb), epId]).catch(() => {})
    }
    return epId
  }

  /** 写一批证据行。subjectUserId = 证据主体用户（隐私清理直接定位，不再依赖 target 反查）。 */
  async _writeEvidence(groupId, targetType, targetId, evidenceMsgs, now, fallbackText = '', subjectUserId = null) {
    if (!Array.isArray(evidenceMsgs) || !evidenceMsgs.length) {
      if (fallbackText) await this.dao.run('INSERT INTO gw_evidence(group_id,target_type,target_id,subject_user_id,evidence_kind,evidence_text,weight,observed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)', [groupId, targetType, targetId || null, subjectUserId, 'inferred', String(fallbackText).slice(0, 1000), 1, now, now])
      return
    }
    for (const m of evidenceMsgs.slice(0, 12)) {
      try {
        await this.dao.run(
          'INSERT INTO gw_evidence(group_id,target_type,target_id,subject_user_id,message_id,evidence_kind,evidence_text,weight,observed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [groupId, targetType, targetId || null, subjectUserId, m.message_id ? String(m.message_id) : null, 'inferred', String(m.text || fallbackText).slice(0, 1000), 1, Number(m.sent_at) || now, now],
        )
      } catch { /* noop */ }
    }
  }

  /** temporary_state 默认 14 天过期；其余无过期。 */
  _defaultExpiry(traitType, now) {
    if (traitType === 'temporary_state') return now + 14 * 86400000
    return null
  }

  /**
   * 删除某消息关联的证据，并把依赖它的 trait/episode 失效或重算（§5.4、§16.1）。
   * 简化：证据删除 → 若某 trait 剩余证据为 0 则置 expired；否则重算置信。
   */
  async invalidateByMessage(groupId, messageId, now = Date.now()) {
    if (!groupId || !messageId) return
    const evRows = await this.dao.all('SELECT target_type,target_id FROM gw_evidence WHERE group_id=? AND message_id=?', [groupId, String(messageId)])
    await this.dao.run('DELETE FROM gw_evidence WHERE group_id=? AND message_id=?', [groupId, String(messageId)])
    const traitIds = new Set(evRows.filter((e) => e.target_type === 'trait' && e.target_id).map((e) => e.target_id))
    for (const tid of traitIds) {
      const left = await this.dao.all('SELECT observed_at FROM gw_evidence WHERE target_type=? AND target_id=?', ['trait', tid])
      if (!left.length) {
        await this.dao.run('UPDATE gw_traits SET status=?, updated_at=? WHERE id=?', ['expired', now, tid])
      } else {
        const t = await this.dao.get('SELECT source_type, last_observed_at FROM gw_traits WHERE id=?', [tid])
        const dates = new Set(left.map((e) => dayKey(e.observed_at)))
        // recency 锚 last_observed_at（与 mergeTraitCandidate 一致；曾用 first_observed_at 致老画像置信暴跌归零）
        const conf = computeConfidence({ sourceType: t?.source_type || 'inferred', evidenceCount: left.length, distinctDates: dates.size, contradictions: 0, daysSince: (now - (t?.last_observed_at || now)) / 86400000 })
        await this.dao.run('UPDATE gw_traits SET confidence=?, evidence_count=?, updated_at=? WHERE id=?', [Math.round(conf * 10000) / 10000, left.length, now, tid])
      }
    }
  }
}

export { dayKey, normValue }
