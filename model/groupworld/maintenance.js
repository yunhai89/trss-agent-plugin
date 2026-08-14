/**
 * WorldMaintenance —— 日清理 + 周聚类（设计文档 §6.4 每日、§6.5 每周）。
 *
 * 每日（低峰，§6.4）：重算 7/30 日窗口统计 → 更新活跃等级 → 精确重算关系边计数/强度/互惠度
 *   → 衰减陈旧推断特征 → 过期临时状态 → 归档冷成员 → 生成 hot 成员确定性摘要 → 清理超期原始消息/旧圈子。
 * 每周（§6.5）：跑小圈子识别（community.js）。
 *
 * 原则：不重建全部原始数据；只重算派生统计。关系边的 inferred_relation/relation_confidence（LLM 产出）在
 * 重算计数时保留，只覆盖统计字段。hot 摘要为确定性拼接（top 特征），不调 LLM（maintenance 以非 LLM 为主）。
 */
import { interactionStrength, reciprocity, confidence as computeConfidence } from './scoring.js'
import { toBlob, fromBlob, cosine } from './embedding.js'
import Log from '../../utils/Log.js'

const dayMs = 86400000
const dayKey = (ms) => { const d = new Date(Number(ms) || 0); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }

export class WorldMaintenance {
  /**
   * @param {object} opts { dao, community, cfg:()=>object, trace?, embedder? }
   *   embedder = makeEmbedder 产物（可选；缺省跳过回填/近义合并，零影响）
   */
  constructor({ dao, community = null, cfg, trace = null, embedder = null }) {
    if (!dao) throw new Error('WorldMaintenance 需要 dao')
    this.dao = dao
    this.community = community
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.trace = trace
    this.embedder = embedder
  }

  /** 每日维护。返回统计。 */
  async runDaily(groupId, now = Date.now()) {
    const c = this._cfgFn()
    const p = c.profiles || {}; const ing = c.ingestion || {}
    const hotDays = Number(p.hotActiveDays30d) || 10
    const warmMsg = Number(p.warmMessageCount30d) || 5
    const retentionDays = Number(ing.rawMessageRetentionDays) || 30

    const members = await this._recomputeProfiles(groupId, now, { hotDays, warmMsg })
    await this._recomputeEdges(groupId, now)
    await this._decayTraits(groupId, now)
    await this._archiveCold(groupId, now)
    await this._retention(groupId, now, retentionDays)
    // P0 语义层：embedding 回填 + 近义特征聚类合并（embedder 未配时为 no-op）
    const embedded = await this._backfillEmbeddings(groupId)
    const mergedTraits = await this._mergeSimilarTraits(groupId, now)

    this.trace?.record?.('gw_maint', { groupId, kind: 'daily', members, embedded, mergedTraits })
    Log.mark('[groupworld]', `每日维护 群${groupId} 成员${members}${embedded ? ` 补嵌入${embedded}` : ''}${mergedTraits ? ` 合并近义${mergedTraits}` : ''}`)
    return { members, embedded, mergedTraits }
  }

  /** 每周维护：小圈子 + 长期关系已在每日重算。 */
  async runWeekly(groupId, now = Date.now()) {
    const c = this._cfgFn()
    let communities = 0
    if (c.graph?.weeklyCommunityDetection !== false && this.community) {
      const r = await this.community.detect(groupId, now)
      communities = r.written
    }
    this.trace?.record?.('gw_maint', { groupId, kind: 'weekly', communities })
    return { communities }
  }

  /** 重算成员 7/30d 窗口统计 + 活跃等级；静默成员(窗口内无消息)清零并降 cold。返回处理成员数。 */
  async _recomputeProfiles(groupId, now, { hotDays, warmMsg }) {
    const cutoff30 = now - 30 * dayMs; const cutoff7 = now - 7 * dayMs
    const rows = await this.dao.all(
      'SELECT sender_id, reply_to_user_id, length(plain_text) AS len, sent_at, mentioned_users FROM gw_messages WHERE group_id=? AND sent_at>=?',
      [groupId, cutoff30],
    )
    const agg = new Map() // uid -> {c30,c7,days:Set,sumLen,replies,mentions}
    for (const r of rows) {
      const uid = r.sender_id; if (!uid) continue
      let a = agg.get(uid); if (!a) { a = { c30: 0, c7: 0, days: new Set(), sumLen: 0, replies: 0, mentions: 0 }; agg.set(uid, a) }
      a.c30++; if (r.sent_at >= cutoff7) a.c7++
      a.days.add(dayKey(r.sent_at))
      a.sumLen += Number(r.len) || 0
      if (r.reply_to_user_id) a.replies++
      let mu = []; try { mu = JSON.parse(r.mentioned_users || '[]') } catch { /* noop */ }
      if (Array.isArray(mu) && mu.length) a.mentions++
    }
    let n = 0
    for (const [uid, a] of agg) {
      const activeDays = a.days.size
      const avg = a.c30 ? Math.round((a.sumLen / a.c30) * 100) / 100 : null
      const replyRatio = a.c30 ? Math.round((a.replies / a.c30) * 10000) / 10000 : null
      const mentionRatio = a.c30 ? Math.round((a.mentions / a.c30) * 10000) / 10000 : null
      let tier = 'cold'
      if (activeDays >= hotDays) tier = 'hot'
      else if (a.c30 >= warmMsg) tier = 'warm'
      // hot 摘要：top 特征拼接（确定性，不调 LLM）
      let summary = null; let summaryConf = null; let summaryAt = null
      if (tier === 'hot') {
        const ts = await this.dao.all("SELECT trait_value,confidence FROM gw_traits WHERE group_id=? AND user_id=? AND status='active' ORDER BY confidence DESC LIMIT 3", [groupId, uid])
        if (ts.length) { summary = ts.map((t) => t.trait_value).join('；').slice(0, 200); summaryConf = ts[0].confidence; summaryAt = now }
      }
      await this.dao.run(
        `UPDATE gw_member_profiles SET message_count_30d=?, message_count_7d=?, active_days_30d=?, avg_message_length=?, reply_ratio=?, mention_ratio=?, activity_tier=?, profile_summary=?, summary_confidence=?, summary_updated_at=?, updated_at=? WHERE group_id=? AND user_id=?`,
        [a.c30, a.c7, activeDays, avg, replyRatio, mentionRatio, tier, summary, summaryConf, summaryAt, now, groupId, uid],
      )
      n++
    }
    // 静默成员（窗口内 0 消息，31~60d）→ 清零窗口统计 + 降 cold（修 BUG2：曾漏致卡 warm/hot 直到 60d 归档）
    const allProfiles = await this.dao.all("SELECT user_id FROM gw_member_profiles WHERE group_id=? AND activity_tier!='archived'", [groupId])
    const active = new Set(agg.keys())
    for (const p of allProfiles) {
      if (active.has(p.user_id)) continue
      await this.dao.run(
        `UPDATE gw_member_profiles SET message_count_30d=0, message_count_7d=0, active_days_30d=0, avg_message_length=NULL, reply_ratio=NULL, mention_ratio=NULL, activity_tier='cold', updated_at=? WHERE group_id=? AND user_id=?`,
        [now, groupId, p.user_id],
      )
    }
    return n
  }

  /** 精确重算关系边（保留 inferred_* 字段）。 */
  async _recomputeEdges(groupId, now) {
    const cutoff30 = now - 30 * dayMs
    // 回复计数（分组）
    const replyRows = await this.dao.all(
      'SELECT sender_id, reply_to_user_id, COUNT(*) AS c FROM gw_messages WHERE group_id=? AND sent_at>=? AND reply_to_user_id IS NOT NULL GROUP BY sender_id, reply_to_user_id',
      [groupId, cutoff30],
    )
    const replyMap = new Map() // "from>to" -> count
    for (const r of replyRows) replyMap.set(`${r.sender_id}>${r.reply_to_user_id}`, r.c)
    // @ 计数（解析 mentioned_users JSON）
    const mentionRows = await this.dao.all('SELECT sender_id, mentioned_users FROM gw_messages WHERE group_id=? AND sent_at>=?', [groupId, cutoff30])
    const mentionMap = new Map()
    for (const r of mentionRows) {
      let arr = []; try { arr = JSON.parse(r.mentioned_users || '[]') } catch { /* noop */ }
      for (const to of arr) { const k = `${r.sender_id}>${to}`; mentionMap.set(k, (mentionMap.get(k) || 0) + 1) }
    }
    // 遍历现有边，重算
    const edges = await this.dao.all('SELECT group_id,from_user_id,to_user_id,first_interacted_at,last_interacted_at FROM gw_edges WHERE group_id=?', [groupId])
    const rev = (f, t) => replyMap.has(`${t}>${f}`) || mentionMap.has(`${t}>${f}`)
    for (const e of edges) {
      const f = e.from_user_id; const t = e.to_user_id
      const reply = replyMap.get(`${f}>${t}`) || 0
      const mention = mentionMap.get(`${f}>${t}`) || 0
      const revReply = replyMap.get(`${t}>${f}`) || 0
      const revMention = mentionMap.get(`${t}>${f}`) || 0
      const recip = reciprocity(reply + mention, revReply + revMention)
      const daysSince = e.last_interacted_at ? (now - e.last_interacted_at) / dayMs : 0
      const strength = interactionStrength({ replyCount: reply, mentionCount: mention, coDialogueCount: 0, reciprocalBonus: recip, daysSince, halfLife: 30 })
      await this.dao.run(
        'UPDATE gw_edges SET reply_count_30d=?, mention_count_30d=?, reciprocity=?, interaction_strength=?, updated_at=? WHERE group_id=? AND from_user_id=? AND to_user_id=?',
        [reply, mention, Math.round(recip * 10000) / 10000, Math.round(strength * 10000) / 10000, now, groupId, f, t],
      )
    }
  }

  /** 幂等衰减：对 active inferred 特征按"last_observed_at 至今"确定性重算置信（不再每次 ×0.7 累积）。
   *  对同一 now 重跑结果不变（修 BUG1：曾乘法累积致置信一路崩到 expired）。 */
  async _decayTraits(groupId, now) {
    const rows = await this.dao.all(
      "SELECT id, evidence_count, last_observed_at FROM gw_traits WHERE group_id=? AND source_type='inferred' AND status='active'",
      [groupId],
    )
    for (const t of rows) {
      let dd = 1
      try {
        const ev = await this.dao.all('SELECT observed_at FROM gw_evidence WHERE target_type=? AND target_id=?', ['trait', t.id])
        if (ev.length) dd = new Set(ev.map((e) => dayKey(e.observed_at))).size
      } catch { /* noop */ }
      const daysSince = t.last_observed_at ? (now - t.last_observed_at) / dayMs : 0
      const conf = computeConfidence({ sourceType: 'inferred', evidenceCount: Number(t.evidence_count) || 1, distinctDates: dd, contradictions: 0, daysSince, halfLife: 90 })
      await this.dao.run('UPDATE gw_traits SET confidence=?, updated_at=? WHERE id=?', [Math.round(conf * 10000) / 10000, now, t.id])
    }
    // 过期：仅 inferred 且置信过低（修 BUG6：曾漏 source_type，会误伤被衰减的高可靠特征）
    await this.dao.run("UPDATE gw_traits SET status='expired', updated_at=? WHERE group_id=? AND source_type='inferred' AND status='active' AND confidence<0.1", [now, groupId])
    // 临时状态按 TTL 过期
    await this.dao.run("UPDATE gw_traits SET status='expired', updated_at=? WHERE group_id=? AND trait_type='temporary_state' AND expires_at IS NOT NULL AND expires_at<?", [now, groupId, now])
  }

  /** 归档冷成员（60d 无发言 → archived）。 */
  async _archiveCold(groupId, now) {
    const cutoff = now - 60 * dayMs
    await this.dao.run("UPDATE gw_member_profiles SET activity_tier='archived', updated_at=? WHERE group_id=? AND activity_tier!='archived' AND (last_spoke_at IS NULL OR last_spoke_at<?)", [now, groupId, cutoff])
  }

  /** 原始消息保留期清理 + 旧圈子清理（§5.1、§5.8）。 */
  async _retention(groupId, now, retentionDays) {
    const cutoff = now - retentionDays * dayMs
    try { await this.dao.run('DELETE FROM gw_messages WHERE group_id=? AND sent_at<?', [groupId, cutoff]) } catch { /* noop */ }
    try { await this.dao.run('DELETE FROM gw_communities WHERE group_id=? AND created_at<?', [groupId, now - 14 * dayMs]) } catch { /* noop */ }
    try { await this.dao.run("UPDATE gw_segments SET status='archived' WHERE group_id=? AND status='closed' AND closed_at<?", [groupId, cutoff]) } catch { /* noop */ }
  }

  // ─────────────── P0 语义层：embedding 回填 + 近义合并 ───────────────

  /** 回填缺失 embedding（历史行 / 降级期写入的行）。每轮限量，跨数日追平。 */
  async _backfillEmbeddings(groupId) {
    if (!this.embedder) return 0
    let n = 0
    try {
      const traits = await this.dao.all("SELECT id, trait_value FROM gw_traits WHERE group_id=? AND status='active' AND embedding IS NULL LIMIT 300", [groupId])
      for (const t of traits) {
        const v = await this.embedder.embed(t.trait_value)
        if (v) { await this.dao.run('UPDATE gw_traits SET embedding=? WHERE id=?', [toBlob(v), t.id]); n++ }
      }
      const eps = await this.dao.all("SELECT id, title, summary FROM gw_episodes WHERE group_id=? AND status='active' AND embedding IS NULL LIMIT 100", [groupId])
      for (const e of eps) {
        const v = await this.embedder.embed(`${e.title} ${e.summary}`)
        if (v) { await this.dao.run('UPDATE gw_episodes SET embedding=? WHERE id=?', [toBlob(v), e.id]); n++ }
      }
    } catch (e) { Log.warn('[groupworld] embedding 回填失败', e?.message || e) }
    return n
  }

  /**
   * 近义特征聚类合并：同用户同 trait_type 内，embedding 余弦 ≥ traitMergeSimThreshold（默认 0.82）
   * 的特征视为同一结论（"爱聊服务器运维"/"搞服务器的"）。合并策略：保留置信最高者为主，
   * 证据行迁移到主特征后删除冗余，再按合并后证据统计重算主特征置信。
   */
  async _mergeSimilarTraits(groupId, now) {
    if (!this.embedder) return 0
    const simThr = Number(this._cfgFn().profiles?.traitMergeSimThreshold) || 0.82
    let merged = 0
    try {
      const rows = await this.dao.all(
        "SELECT id,user_id,trait_type,confidence,embedding FROM gw_traits WHERE group_id=? AND status='active' AND embedding IS NOT NULL LIMIT 2000",
        [groupId],
      )
      const groups = new Map()
      for (const r of rows) {
        const k = `${r.user_id}|${r.trait_type}`
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push({ id: r.id, conf: Number(r.confidence) || 0, emb: fromBlob(r.embedding) })
      }
      for (const list of groups.values()) {
        const items = list.filter((x) => x.emb)
        if (items.length < 2) continue
        // 单链接聚类（并查集）
        const parent = items.map((_, i) => i)
        const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
        for (let i = 0; i < items.length; i++) {
          for (let j = i + 1; j < items.length; j++) {
            if (cosine(items[i].emb, items[j].emb) >= simThr) parent[find(i)] = find(j)
          }
        }
        const clusters = new Map()
        for (let i = 0; i < items.length; i++) {
          const root = find(i)
          if (!clusters.has(root)) clusters.set(root, [])
          clusters.get(root).push(items[i])
        }
        for (const members of clusters.values()) {
          if (members.length < 2) continue
          members.sort((a, b) => b.conf - a.conf)
          const primary = members[0]; const others = members.slice(1)
          const otherIds = others.map((o) => o.id)
          // 证据迁移到主特征 → 删冗余 → 按合并后证据重算置信
          await this.dao.run(`UPDATE gw_evidence SET target_id=? WHERE target_type='trait' AND target_id IN (${otherIds.map(() => '?').join(',')})`, [primary.id, ...otherIds])
          await this.dao.run(`DELETE FROM gw_traits WHERE id IN (${otherIds.map(() => '?').join(',')})`, otherIds)
          const ev = await this.dao.all('SELECT observed_at FROM gw_evidence WHERE target_type=? AND target_id=?', ['trait', primary.id])
          const dates = new Set(ev.map((e) => dayKey(e.observed_at)))
          const t = await this.dao.get('SELECT source_type, last_observed_at FROM gw_traits WHERE id=?', [primary.id])
          const daysSince = t?.last_observed_at ? (now - t.last_observed_at) / dayMs : 0
          const conf = computeConfidence({ sourceType: t?.source_type || 'inferred', evidenceCount: ev.length || 1, distinctDates: Math.max(1, dates.size), contradictions: 0, daysSince })
          await this.dao.run('UPDATE gw_traits SET confidence=?, evidence_count=?, updated_at=? WHERE id=?', [Math.round(conf * 10000) / 10000, ev.length || 1, now, primary.id])
          merged += others.length
        }
      }
    } catch (e) { Log.warn('[groupworld] 近义合并失败', e?.message || e) }
    return merged
  }
}
