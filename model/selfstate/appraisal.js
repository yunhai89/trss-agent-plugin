/**
 * AppraisalEngine —— 事件评价（设计文档 v1.1 §8、§10）。
 *
 * 14 维评价（§8.1）：确定性维度（self_relevance/directedness/publicness/repetition/relationship_closeness）
 * 由规则+GroupWorld 关系直接计算；语义维度（playfulness/hostility/repair/sincerity）仅在歧义
 * （candidate.needsLlm 或规则冲突）时调小模型（§17.2 普通感谢/明确辱骂不调模型）。
 * 引擎最终重判 event_type（模型只提供候选，§7.3）。
 * 关系修正矩阵（§10.2）：互损熟人 hostility↓playfulness↑ / 信任者认真否定 hurt↑ / 陌生人公开辱骂
 * guardedness+anger↑ / 同人重复 repetition↑→resentment 渐成。
 */
import { APPRAISAL_SYSTEM, buildAppraisalPrompt, parseAppraisalOutput } from './prompts.js'
import Log from '../../utils/Log.js'

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

export class AppraisalEngine {
  /**
   * @param {object} opts { dao, provider?, model?, cfg:()=>object, trace? }
   */
  constructor({ dao, provider = null, model = null, cfg, trace = null } = {}) {
    if (!dao) throw new Error('AppraisalEngine 需要 dao')
    this.dao = dao
    this.provider = provider
    this.model = model
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.trace = trace
  }

  /**
   * 评价一个候选 → 完整 appraisal（含 event_type 重判 + emotion impulse 预估）。
   * @param {object} o { botId, groupId, candidate, norm, relation?, scene?, now }
   *   relation = gw_bot_rel 行 + reciprocalTeasing 标志（service 层组装）
   * @returns {Promise<{eventType, appraisal, semantic, confidence}|null>} null=无效事件
   */
  async appraise({ botId, groupId, candidate, norm, relation = {}, scene = {}, now = Date.now() }) {
    const cfg = this._cfgFn()
    const ed = cfg.eventDetection || {}
    const det = candidate.deterministicSignals || {}
    const text = String(norm?.text || '')

    // ── 确定性维度（§8.1）── 取最强指向信号（回复≈0.9 / @≈0.9 / 昵称≈0.6），叠加轻微加成
    const directedness = clamp01(Math.max(
      det.direct_reply_to_bot ? 0.9 : 0,
      det.direct_mention ? 0.9 : 0,
      det.nickname_reference ? 0.6 : 0,
      (det.direct_reply_to_bot && det.direct_mention) ? 0.98 : 0,
    ))
    // 重复：近 14 天同 actor 显著敌意事件数（significance≥0.2 过滤——无指向的 ambient 辱骂不算重复证据）
    const repetition = await this._repetition(botId, groupId, candidate.actorUserId, candidate.candidateType, now)
    const closeness = clamp01(relation.familiarity ?? 0.3)
    const publicness = 0.9 // 群聊天然公开；@提升到 1
    const selfRelevance = clamp01(Math.max(directedness, det.in_expectation_window ? 0.5 : 0))

    // ── 语义维度：规则初判，歧义才调 LLM（§17.2）──
    let semantic = this._ruleSemantic(candidate, det)
    let eventType = this._ruleEventType(candidate, semantic, relation, det)
    let needsLlm = candidate.needsLlm || (eventType === 'direct_insult' && closeness > 0.5) // 熟人"辱骂词"需判玩笑
    if (needsLlm && this.provider) {
      try {
        const llm = await this._callLlm(candidate, relation, scene, text)
        if (llm) {
          semantic = {
            playfulness: clamp01(llm.semantic_signals?.playfulness ?? semantic.playfulness),
            hostility: clamp01(llm.semantic_signals?.hostility ?? semantic.hostility),
            repair_signal: clamp01(llm.semantic_signals?.repair_signal ?? semantic.repair_signal),
            sincerity: clamp01(llm.semantic_signals?.sincerity ?? 0.5),
          }
          const llmType = String(llm.event_type || '')
          if (llmType && llmType !== 'ambient_noise') eventType = this._rejudge(llmType, semantic, relation, det, directedness)
          if (llmType === 'ambient_noise') return null // 与机器人无关，宁可放弃
        }
      } catch (e) { Log.warn('[selfstate] 评价 LLM 失败，规则降级', e?.message || e) }
    }

    // ── 关系修正矩阵（§10.2）──
    const adjusted = this._applyRelationModifiers(eventType, semantic, { closeness, relation, repetition, directedness, quoteSuspicion: clamp01(det.quote_suspicion || 0) })

    const confidence = clamp01(candidate.confidence * 0.6 + directedness * 0.25 + (semantic.certainty ?? 0.15))
    if (confidence < (ed.minEventConfidence || 0.55)) return null

    const appraisal = {
      self_relevance: selfRelevance,
      desirability: adjusted.desirability,
      directedness,
      certainty: confidence,
      other_agency: 0.9, // 群友主动行为
      controllability: adjusted.controllability,
      expectedness: 1 - clamp01(repetition * 0.3),
      norm_violation: adjusted.norm_violation,
      publicness,
      repetition,
      relationship_closeness: closeness,
      playfulness: adjusted.playfulness,
      repair_signal: semantic.repair_signal,
    }
    this.trace?.record?.('ss_appraise', { groupId, type: eventType, conf: Math.round(confidence * 100) / 100, llm: needsLlm && !!this.provider })
    return { eventType: adjusted.eventType, appraisal, semantic: adjusted, confidence }
  }

  /** 规则语义初判（无 LLM 时的兜底）。 */
  _ruleSemantic(candidate, det) {
    const kw = det.kw_hits || []
    const insult = kw.includes('insult')
    const rejection = kw.includes('rejection')
    return {
      playfulness: insult ? 0.2 : 0.35,
      hostility: insult ? 0.6 : rejection ? 0.4 : kw.includes('praise') || kw.includes('thanks') ? 0 : 0.1,
      repair_signal: kw.includes('apology') ? 0.75 : 0,
      sincerity: kw.includes('apology') ? 0.6 : 0.5,
      certainty: 0.15,
    }
  }

  /** 规则事件类型初判。 */
  _ruleEventType(candidate, semantic, relation, det) {
    const kw = det.kw_hits || []
    if (kw.includes('apology')) return 'apology'
    if (kw.includes('defense')) return 'defense'
    if (kw.includes('thanks')) return 'thanks'
    if (kw.includes('praise')) return 'praise'
    if (kw.includes('invitation')) return 'invitation'
    if (kw.includes('rejection')) return 'rejection'
    if (kw.includes('insult')) {
      // 熟人+高玩笑嫌疑 → friendly_tease（§10.2 关系修正）
      if ((relation.familiarity ?? 0) > 0.5 && relation.reciprocalTeasing && semantic.playfulness >= 0.15) return 'friendly_tease'
      return 'direct_insult'
    }
    if (candidate.candidateType === 'possible_response') return 'response_received'
    if (det.in_expectation_window) return 'response_received'
    return 'directed_message'
  }

  /** LLM 结果重判（§7.3 引擎说了算）。 */
  _rejudge(llmType, semantic, relation, det, directedness) {
    if (llmType === 'direct_insult' && (relation.familiarity ?? 0) > 0.6 && semantic.playfulness > 0.6) return 'friendly_tease'
    if (llmType === 'friendly_tease' && semantic.hostility > 0.7) return 'direct_insult'
    if ((llmType === 'praise' || llmType === 'thanks') && directedness < 0.2) return 'ambient_noise'
    return llmType
  }

  /** 关系修正（§10.2）→ 最终类型 + desirability/norm_violation。 */
  _applyRelationModifiers(eventType, semantic, { closeness, relation, repetition, directedness, quoteSuspicion = 0 }) {
    let desirability = 0
    let norm_violation = 0
    let controllability = 0.4
    if (eventType === 'friendly_tease') {
      desirability = 0.1 * semantic.playfulness - 0.1 * semantic.hostility
      norm_violation = 0.12
    } else if (eventType === 'direct_insult' || eventType === 'public_embarrassment') {
      desirability = -0.7 - 0.2 * semantic.hostility
      norm_violation = 0.65 + 0.25 * semantic.hostility
      // 陌生人公开辱骂：anger↑guardedness↑（§10.2）；熟人认真辱骂伤害更深
      controllability = 0.3
    } else if (eventType === 'praise' || eventType === 'thanks' || eventType === 'defense' || eventType === 'support') {
      desirability = 0.65
      norm_violation = 0
    } else if (eventType === 'apology' || eventType === 'repair') {
      desirability = 0.4
      norm_violation = 0
    } else if (eventType === 'invitation' || eventType === 'shared_fun') {
      desirability = 0.45
    } else if (eventType === 'rejection') {
      desirability = -0.5
      norm_violation = 0.2
    } else if (eventType === 'excluded' || eventType === 'ignored_expectation') {
      desirability = -0.35
      norm_violation = 0.1
    } else if (eventType === 'help_succeeded') {
      desirability = 0.5
    } else if (eventType === 'help_dismissed') {
      desirability = -0.4
    } else if (eventType === 'response_received') {
      desirability = 0.3
    }
    // 引用嫌疑削弱敌意归因（§10.1-2，接线修复——曾为 this._qs 恒 undefined 的死代码）：
    // 回复他人（qs=0.5）或回复机器人但疑似转述第三方（qs=0.15）时，文本的敌意立场可能是被引用者的，
    // 按 qs 比例把负面 desirability 与 norm_violation 往中性拉（削弱而非清除——直接发辱骂词仍保留底线反应）。
    if (norm_violation > 0.3 && quoteSuspicion > 0) {
      desirability *= (1 - 0.6 * quoteSuspicion)
      norm_violation *= (1 - 0.5 * quoteSuspicion)
    }
    return { eventType, desirability: Math.max(-1, Math.min(1, desirability)), norm_violation, controllability, playfulness: semantic.playfulness, hostility: semantic.hostility, repair_signal: semantic.repair_signal, closeness, repetition }
  }

  /** 近 14 天同 actor 敌意事件重复度（0~1）。仅统计显著事件（significance≥0.2），并按 bot 隔离。 */
  async _repetition(botId, groupId, actorUserId, candidateType, now) {
    if (!actorUserId) return 0
    try {
      const rows = await this.dao.all(
        "SELECT event_type FROM ss_events WHERE bot_id=? AND group_id=? AND actor_user_id=? AND occurred_at>=? AND status='active' AND significance>=0.2",
        [botId, groupId, actorUserId, now - 14 * 86400000],
      )
      if (!rows.length) return 0
      const hostile = rows.filter((r) => r.event_type === 'direct_insult' || r.event_type === 'public_embarrassment').length
      if (hostile >= 3) return 1
      if (hostile === 2) return 0.7
      return Math.min(0.4, rows.length * 0.08)
    } catch { return 0 }
  }

  async _callLlm(candidate, relation, scene, text) {
    const res = await this.provider.chat({
      model: this.model || undefined,
      system: APPRAISAL_SYSTEM,
      messages: [{ role: 'user', content: buildAppraisalPrompt({ ...candidate, text }, relation, scene) }],
      tools: undefined, tool_choice: { mode: 'none' },
      temperature: 0.2, max_tokens: 400, thinking: { type: 'disabled' }, stream: false,
    })
    return parseAppraisalOutput(res?.content || '')
  }
}
