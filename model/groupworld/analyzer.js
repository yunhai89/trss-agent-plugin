/**
 * WorldAnalyzer —— 小时增量 LLM 分析（设计文档 §6.3、§8）。
 *
 * 流程：切片闭合 → 取待分析片段 → 预算熔断 → 逐片段调轻量模型抽取 → JSON 校验（非法重试1次→dead_letter）
 *       → 敏感过滤 → 证据合并入库 → 事务内「标记 analyzed + 推进 cursor + 计预算」。
 *
 * 约束（§8.3、§6.3、§11.2.10）：
 *   - 模型置信只是候选，由 evidence.js 用 scoring.confidence 重算；
 *   - 模型返回非法 JSON 重试 1 次，仍失败置 dead_letter，不阻塞其他片段；
 *   - 每群每日调用预算 maxDailyCallsPerGroup，超则当日停（cursor.daily_calls_today + date rollover）；
 *   - 全程不阻塞消息收发（由定时任务驱动，非主消息线程）。
 */
import { ANALYZER_SYSTEM, buildAnalyzerPrompt, parseAnalyzerOutput, validateAnalyzerOutput } from './prompts.js'
import Log, { ANSI } from '../../utils/Log.js'

const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export class WorldAnalyzer {
  /**
   * @param {object} opts { provider, dao, segmenter, resolver, cfg:()=>object, trace? }
   */
  constructor({ provider, dao, segmenter, resolver, cfg, trace = null, botId = null }) {
    if (!provider || !dao || !segmenter || !resolver) throw new Error('WorldAnalyzer 缺参数')
    this.provider = provider
    this.dao = dao
    this.segmenter = segmenter
    this.resolver = resolver
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.trace = trace
    this.botId = botId != null ? String(botId) : null
  }

  /** 一轮小时分析。返回统计。 */
  async runHourly(groupId) {
    const c = this._cfgFn()
    const now = Date.now()
    // 1. 切片（折叠新消息 + 闭合静默片段）
    try { await this.segmenter.processGroup(groupId, c.ingestion || {}, now) } catch (e) { Log.warn('[groupworld] 切片失败', groupId, e?.message || e) }

    // 2. 预算
    const budget = await this._checkBudget(groupId, Number(c.analysis?.maxDailyCallsPerGroup) || 100)
    if (!budget.ok) {
      this.trace?.record?.('gw_analyze', { groupId, skipped: 'budget', used: budget.used, max: budget.max })
      return { skipped: 'budget', analyzed: 0 }
    }

    // 3. 待分析片段
    const pending = await this.segmenter.pendingSegments(groupId, c.analysis || {}, { maxSegmentsPerRun: Number(c.analysis?.maxSegmentsPerRun) || 50 })
    if (!pending.length) return { analyzed: 0, pending: 0 }

    let analyzed = 0; let failed = 0; let budgetHit = false
    for (const seg of pending) {
      // 单轮内逐段复查预算（修 H1：入口只查一次会让单轮突破 maxDailyCallsPerGroup）
      const b = await this._checkBudget(groupId, Number(c.analysis?.maxDailyCallsPerGroup) || 100)
      if (!b.ok) { budgetHit = true; break }
      const ok = await this._analyzeSegment(groupId, seg, c, now)
      if (ok) analyzed++; else failed++
    }
    this.trace?.record?.('gw_analyze', { groupId, analyzed, failed, pending: pending.length, calls: analyzed, budgetHit })
    Log.mark('[groupworld]', `${ANSI.c}分析${ANSI.R} 群${groupId} 片段${pending.length} 成功${analyzed} 失败${failed}${budgetHit ? ' 预算熔断' : ''}`)
    return { analyzed, failed, pending: pending.length, budgetHit }
  }

  /** 分析单个片段。成功 true。 */
  async _analyzeSegment(groupId, seg, c, now) {
    const acfg = c.analysis || {}
    const model = acfg.modelProfile || null
    // retryCount=重试次数；maxAttempts=初次+重试。Number.isFinite 让 0 生效（不重试），修 L5
    const retryCount = Number.isFinite(Number(acfg.retryCount)) ? Number(acfg.retryCount) : 1
    const maxAttempts = Math.max(1, retryCount + 1)
    const idMap = this._buildIdMap(seg.messages)
    const validMsgIds = new Set(seg.messages.map((m) => m.message_id))
    const validAnonIds = new Set(Object.values(idMap))
    const prompt = buildAnalyzerPrompt(seg, idMap)

    let parsed = null
    let lastErr = null
    for (let attempt = 0; attempt < maxAttempts && !parsed; attempt++) {
      try {
        const out = await this._call(model, prompt, acfg)
        parsed = parseAnalyzerOutput(out)
      } catch (e) { lastErr = e?.message || String(e) }
    }
    if (!parsed) {
      await this.dao.run('UPDATE gw_segments SET status=?, attempt=attempt+1, error=? WHERE id=?', ['dead_letter', String(lastErr || 'invalid_json').slice(0, 200), seg.segment.id])
      this.trace?.record?.('gw_analyze', { groupId, segId: seg.segment.id, dead: true, err: String(lastErr).slice(0, 80) })
      return false
    }

    const validated = validateAnalyzerOutput(parsed, validMsgIds, validAnonIds)
    const revMap = {}; for (const [uid, anon] of Object.entries(idMap)) revMap[anon] = uid
    const evOf = (ids) => seg.messages.filter((m) => ids.includes(m.message_id)).map((m) => ({ message_id: m.message_id, text: m.plain_text, sent_at: m.sent_at }))

    try {
      await this.dao.txn(async () => {
        // 写入前最终复查 opt-out（分析发生在 LLM 调用之后，用户可能在排队期间已退出建模，
        // 旧 pending 片段不得重建其画像/关系/事件参与者）
        const optRows = await this.dao.all('SELECT user_id FROM gw_optout WHERE group_id=?', [groupId]).catch(() => [])
        const optOut = new Set((optRows || []).map((r) => String(r.user_id)))
        if (this.botId) optOut.add(String(this.botId))
        for (const t of validated.trait_candidates) {
          const userId = revMap[t.user_id]; if (!userId) continue
          // 不给 bot 自己提画像（bot 消息留在片段里供对话上下文，但"关于我自己的特征"无意义且占据画像预算）
          if (this.botId && String(userId) === String(this.botId)) continue
          await this.resolver.mergeTraitCandidate({ groupId, userId, candidate: t, evidenceMsgs: evOf(t.evidence_message_ids), sourceType: 'inferred', optOut, now })
        }
        for (const r of validated.relation_candidates) {
          const fromUserId = revMap[r.from_user_id]; const toUserId = revMap[r.to_user_id]
          if (!fromUserId || !toUserId) continue
          await this.resolver.mergeRelationCandidate({ groupId, fromUserId, toUserId, hint: r.relation_hint, evidenceMsgs: evOf(r.evidence_message_ids), optOut, now })
        }
        for (const e of validated.episode_candidates) {
          // 匿名 ID → 真实稳定 user id（内部身份不用匿名标识；伪造 ID 已在 validate 阶段丢弃）
          const participants = (e.participant_ids || []).map((a) => revMap[a]).filter(Boolean)
          await this.resolver.mergeEpisodeCandidate({ groupId, candidate: e, participantIds: participants, topicTags: e.topic_tags || [], evidenceMsgs: evOf(e.evidence_message_ids), optOut, now })
        }
        await this.dao.run("UPDATE gw_segments SET status='analyzed', analyzed_at=?, attempt=attempt+1 WHERE id=?", [now, seg.segment.id])
        await this.dao.run('UPDATE gw_cursor SET last_analyzed_segment_id=?, daily_calls_today=daily_calls_today+1, daily_calls_date=? WHERE group_id=?', [seg.segment.id, dateKey(new Date(now)), groupId])
      })
      this.trace?.record?.('gw_trait', { groupId, segId: seg.segment.id, traits: validated.trait_candidates.length, relations: validated.relation_candidates.length, episodes: validated.episode_candidates.length, sensitive: validated.sensitive_inferences.length })
      return true
    } catch (e) {
      Log.warn('[groupworld] 片段入库失败', groupId, seg.segment.id, e?.message || e)
      await this.dao.run('UPDATE gw_segments SET status=?, attempt=attempt+1, error=? WHERE id=?', ['failed', String(e?.message || e).slice(0, 200), seg.segment.id]).catch(() => {})
      return false
    }
  }

  /** 按首次出现给 sender_id 分配匿名 u<n>。 */
  _buildIdMap(messages) {
    const map = {}; let n = 0
    for (const m of messages) {
      if (!map[m.sender_id]) { n++; map[m.sender_id] = `u${n}` }
    }
    return map
  }

  async _call(model, prompt, acfg) {
    const res = await this.provider.chat({
      model: model || undefined,
      system: ANALYZER_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      tools: undefined, tool_choice: { mode: 'none' },
      temperature: 0.2,
      max_tokens: Number(acfg.maxTokens) || 1200,
      thinking: { type: 'disabled' },
      stream: false,
    })
    return res?.content || ''
  }

  /** 预算检查 + 日期滚动。返回 { ok, used, max }。 */
  async _checkBudget(groupId, max) {
    const today = dateKey()
    let row = await this.dao.get('SELECT daily_calls_today, daily_calls_date FROM gw_cursor WHERE group_id=?', [groupId])
    if (!row) {
      await this.dao.run('INSERT OR IGNORE INTO gw_cursor(group_id, daily_calls_date) VALUES (?,?)', [groupId, today])
      row = { daily_calls_today: 0, daily_calls_date: today }
    }
    let used = Number(row.daily_calls_today) || 0
    if (row.daily_calls_date !== today) {
      used = 0
      await this.dao.run('UPDATE gw_cursor SET daily_calls_today=0, daily_calls_date=? WHERE group_id=?', [today, groupId])
    }
    return { ok: used < max, used, max }
  }
}

export { dateKey }
