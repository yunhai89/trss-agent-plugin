/**
 * SelfReflectionJob —— 低频自我反思（设计文档 v1.1 §13）。
 *
 * 反思不是思维链：不保存模型长篇推理，只产短、结构化、可追溯叙事入 ss_reflections。
 * §13.2 触发条件（任一）：同成员 ≥3 相似高显著事件 / 心事持续超时 / 关系显著转向 /
 * 高强度公开事件 / 显著修复 / 日维护发现可压缩组。
 * 日预算 maxReflectionsPerDay；LLM 失败跳过（反思是增强，不是必需）。
 */
import { REFLECTION_SYSTEM, parseReflectionOutput } from './prompts.js'
import Log from '../../utils/Log.js'

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

export class SelfReflectionJob {
  /**
   * @param {object} opts { dao, provider?, model?, cfg:()=>object, trace? }
   */
  constructor({ dao, provider = null, model = null, cfg, trace = null } = {}) {
    if (!dao) throw new Error('SelfReflectionJob 需要 dao')
    this.dao = dao
    this.provider = provider
    this.model = model
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.trace = trace
  }

  /** 对一个群跑反思。返回 { created }。 */
  async runGroup({ botId, groupId, now = Date.now() }) {
    const cfg = this._cfgFn()
    if (cfg.reflection?.enabled === false) return { created: 0 }
    const created = await this.dao.get(
      'SELECT COUNT(*) c FROM ss_reflections WHERE group_id=? AND created_at>=?',
      [groupId, now - 86400000],
    ).then((r) => Number(r?.c) || 0).catch(() => 0)
    const budget = cfg.reflection?.maxReflectionsPerDay ?? 10
    if (created >= budget) return { created: 0 }

    const candidates = await this._findCandidates({ botId, groupId, now, budget })
    let n = 0
    for (const cand of candidates) {
      if (created + n >= budget) break
      try {
        const ok = await this._reflectOne({ botId, groupId, cand, now })
        if (ok) n++
      } catch (e) { Log.warn('[selfstate] 反思失败', e?.message || e) }
    }
    this.trace?.record?.('ss_reflection', { groupId, created: n, candidates: candidates.length })
    return { created: n }
  }

  /** §13.2 触发条件 → 反思候选（按 target 分组的事件束）。 */
  async _findCandidates({ botId, groupId, now, budget = 10 }) {
    const cfg = this._cfgFn()
    const minEvents = cfg.reflection?.minSignificantEvents ?? 3
    const since = now - 14 * 86400000
    const events = await this.dao.all(
      "SELECT id, event_type, actor_user_id, significance, confidence, appraisal_json, occurred_at FROM ss_events WHERE bot_id=? AND group_id=? AND occurred_at>=? AND status='active' ORDER BY occurred_at DESC LIMIT 300",
      [botId, groupId, since],
    ).catch(() => [])
    if (!events.length) return []

    // ① 同成员相似高显著事件 ≥ minEvents
    const byActor = new Map()
    for (const e of events) {
      if (!e.actor_user_id || Number(e.significance) < 0.3) continue
      const k = `${e.actor_user_id}|${e.event_type}`
      if (!byActor.has(k)) byActor.set(k, [])
      byActor.get(k).push(e)
    }
    const cands = []
    for (const [k, list] of byActor) {
      if (list.length >= minEvents) cands.push({ kind: 'repeated_pattern', targetUserId: k.split('|')[0], events: list })
    }
    // ② 高强度单次公开事件（significance ≥0.6）
    for (const e of events) {
      if (Number(e.significance) >= 0.6 && !cands.some((c) => c.events.some((x) => x.id === e.id))) {
        cands.push({ kind: 'high_salience', targetUserId: e.actor_user_id, events: [e] })
      }
    }
    // ③ 显著修复（apology/repair 事件 ≥1 且此前有负面）
    const repairs = events.filter((e) => e.event_type === 'apology' || e.event_type === 'repair')
    for (const r of repairs) {
      const priorNeg = events.filter((e) => e.actor_user_id === r.actor_user_id && e.occurred_at < r.occurred_at
        && ['direct_insult', 'public_embarrassment', 'rejection', 'excluded'].includes(e.event_type))
      if (priorNeg.length) cands.push({ kind: 'repair', targetUserId: r.actor_user_id, events: [...priorNeg.slice(0, 3), r] })
    }
    return cands.slice(0, Math.max(1, budget))
  }

  async _reflectOne({ botId, groupId, cand, now }) {
    const cfg = this._cfgFn()
    const eventLines = cand.events.slice(0, 8).map((e) => {
      let ap = {}; try { ap = JSON.parse(e.appraisal_json || '{}') } catch { /* noop */ }
      return `- [${new Date(e.occurred_at).toISOString().slice(0, 16)}] ${e.event_type} by ${e.actor_user_id} 显著度${clamp01(e.significance).toFixed(2)} 敌意${clamp01(ap.hostility ?? ap.desirability < 0 ? 0.5 : 0).toFixed(2)}`
    }).join('\n')
    let out = null
    if (this.provider) {
      try {
        const res = await this.provider.chat({
          model: this.model || undefined,
          system: REFLECTION_SYSTEM,
          messages: [{ role: 'user', content: `事件历史（该群、与机器人相关）：\n${eventLines}\n\n请输出 JSON 反思。` }],
          tools: undefined, tool_choice: { mode: 'none' },
          temperature: 0.3, max_tokens: 400, thinking: { type: 'disabled' }, stream: false,
        })
        out = parseReflectionOutput(res?.content || '')
      } catch { out = null }
    }
    // 无 LLM/失败 → 确定性摘要兜底
    const summary = out?.summary || this._fallbackSummary(cand)
    const confidence = out ? clamp01(out.confidence) : 0.5
    const ttlDays = out?.expires_in_days || cfg.reflection?.defaultTtlDays || 7
    await this.dao.run(
      `INSERT INTO ss_reflections(bot_id,group_id,summary,scope,target_user_id,confidence,source_event_ids,recommended_concern,expires_at,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [botId, groupId, String(summary).slice(0, 600), cand.kind === 'repair' ? 'bot_user_relationship' : (cand.targetUserId ? 'bot_user_relationship' : 'group_mood'),
        cand.targetUserId || null, confidence, JSON.stringify(cand.events.slice(0, 10).map((e) => e.id)),
        out?.recommended_concern || (cand.kind === 'repair' ? 'repair_attempt' : 'monitor'), now + ttlDays * 86400000, 'active', now],
    )
    return true
  }

  _fallbackSummary(cand) {
    const n = cand.events.length
    const who = cand.targetUserId || '某成员'
    if (cand.kind === 'repair') return `${who}在近期摩擦后出现道歉或修复行为，关系正在缓和。`
    if (cand.kind === 'high_salience') return `发生一次高强度公开事件（${cand.events[0]?.event_type}），值得留意后续走向。`
    return `${who}近期 ${n} 次出现同类高显著互动（${cand.events[0]?.event_type}），构成重复模式。`
  }

  /** 活跃反思（投影用，未过期）。 */
  async activeAll(botId, groupId, now = Date.now()) {
    return this.dao.all(
      "SELECT * FROM ss_reflections WHERE bot_id=? AND group_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC LIMIT 5",
      [botId, groupId, now],
    ).catch(() => [])
  }
}
