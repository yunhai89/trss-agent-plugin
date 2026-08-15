/**
 * StateProjector —— 为 Planner/Replyer 生成不同粒度的状态投影（设计文档 v1.1 §14.2、§15.1）。
 *
 * Planner 投影：结构化行为偏置（overall_mood 四档 / arousal / energy / social_security /
 * target_stance / action_bias 十倾向 / expression_budget），token ≤ maxStateTokens(220)。
 * Replyer 胶囊：自然语言最小状态（tone/openness/length/emotion_to_show/target_distance/may_reference_cause）。
 * shadowMode 或 expression_frozen → 一律返回中性（计算继续但零影响，§25 Phase 0）。
 * 红线：不含数值、不外显内部评价；情绪只是偏置（§14.3）。
 */
const clamp11 = (v) => Math.max(-1, Math.min(1, Number(v) || 0))
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

const MOOD_ZH = { positive: '不错', neutral: '平稳', slightly_negative: '有点低落', negative: '明显低落' }
const STANCE_ZH = { warm: '亲近', normal: '平常', guarded: '有所保留', distant: '疏远' }

export class StateProjector {
  /**
   * @param {object} opts { dao, emotion, concerns, reflection, cfg:()=>object, trace? }
   */
  constructor({ dao, emotion, concerns, reflection, cfg, trace = null } = {}) {
    if (!dao || !emotion) throw new Error('StateProjector 需要 dao+emotion')
    this.dao = dao
    this.emotion = emotion
    this.concerns = concerns
    this.reflection = reflection
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.trace = trace
  }

  /**
   * §14.2 Planner 状态投影。shadow/frozen → 中性。
   * @param {object} o { botId, groupId, targetUserId?, now? }
   * @returns {Promise<{neutral:boolean, projection:object|null, text:string}>} text=可直接注入 prompt 的片段
   */
  async buildPlannerProjection({ botId, groupId, targetUserId = null, now = Date.now() }) {
    const cfg = this._cfgFn()
    if (cfg.enabled !== true || cfg.planner?.includeStateProjection === false) return NEUTRAL()
    const state = await this._getState(botId, groupId)
    if (cfg.shadowMode === true || state.expression_frozen) return NEUTRAL()

    const emotions = await this.emotion.decayAndGetActive(botId, groupId, now)
    const minVis = cfg.emotion?.minVisibleIntensity ?? 0.18
    const visible = emotions.filter((e) => e.intensity >= minVis)

    const rel = targetUserId ? await this.dao.get('SELECT familiarity,affinity,trust,resentment,guardedness,hurt,gratitude FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [botId, groupId, targetUserId]).catch(() => null) : null
    const concern = this.concerns ? await this.concerns.activeForTarget(botId, groupId, targetUserId) : null

    // 心境四档
    const v = clamp11(state.valence)
    const overallMood = v >= 0.15 ? 'positive' : v > -0.15 ? 'neutral' : v > -0.45 ? 'slightly_negative' : 'negative'
    // 目标立场
    let targetStance = 'normal'
    if (rel) {
      const neg = clamp01((Number(rel.resentment) || 0) + (Number(rel.guardedness) || 0) + (Number(rel.hurt) || 0))
      const pos = clamp01((Number(rel.gratitude) || 0) + clamp01(Number(rel.affinity) || 0))
      if (neg > 0.4 && neg > pos) targetStance = neg > 0.7 ? 'distant' : 'guarded'
      else if (pos > 0.6) targetStance = 'warm'
    }
    // 行为偏置（十倾向；情绪只是偏置）
    const negMood = Math.max(0, -v)
    const security = clamp01(state.social_security)
    const actionBias = {
      join: Math.round((v * 0.25 + (security - 0.5) * 0.2) * 100) / 100,
      help: Math.round(((targetStance === 'distant' ? -0.3 : targetStance === 'guarded' ? -0.15 : 0.05) + v * 0.1) * 100) / 100,
      tease: Math.round(((visible.some((e) => e.emotion_type === 'amusement') ? 0.2 : 0) - negMood * 0.4) * 100) / 100,
      set_boundary: Math.round((clamp01(visible.find((e) => e.emotion_type === 'anger')?.intensity || 0) * 0.6 + (targetStance === 'guarded' || targetStance === 'distant' ? 0.3 : 0)) * 100) / 100,
      ignore: Math.round((negMood * 0.35 + (targetStance === 'distant' ? 0.25 : 0)) * 100) / 100,
      repair: Math.round((concern && (concern.concern_type === 'ignored_pattern') ? 0.15 : 0.05) * 100) / 100,
    }
    const expressionBudget = overallMood === 'negative' || security < 0.3 ? 'low' : overallMood === 'slightly_negative' ? 'medium' : 'normal'

    const projection = {
      overall_mood: overallMood, arousal: clamp01(state.arousal) > 0.6 ? 'high' : clamp01(state.arousal) > 0.3 ? 'medium' : 'low',
      energy: clamp01(state.energy) < 0.35 ? 'low' : 'normal',
      social_security: security < 0.35 ? 'low' : security > 0.7 ? 'high' : 'normal',
      target_stance: targetStance,
      active_concern: concern ? { type: concern.concern_type, summary: concern.summary } : null,
      action_bias: actionBias,
      expression_budget: expressionBudget,
    }
    // text 化（≤maxStateTokens 预算，粗算字数）
    const maxTok = cfg.planner?.maxStateTokens ?? 220
    const text = this._plannerText(projection, visible, maxTok)
    this.trace?.record?.('ss_project', { groupId, role: 'planner', mood: overallMood, stance: targetStance })
    return { neutral: false, projection, text }
  }

  /**
   * §15.1 Replyer 表达胶囊。shadow/frozen → 中性。
   * @param {object} o { botId, groupId, targetUserId?, plannerIntent?, now? }
   */
  async buildReplyerCapsule({ botId, groupId, targetUserId = null, plannerIntent = 'normal_reply', now = Date.now() }) {
    const cfg = this._cfgFn()
    if (cfg.enabled !== true || cfg.replyer?.includeExpressionCapsule === false) return NEUTRAL_CAPSULE()
    const state = await this._getState(botId, groupId)
    if (cfg.shadowMode === true || state.expression_frozen) return NEUTRAL_CAPSULE()

    const emotions = await this.emotion.decayAndGetActive(botId, groupId, now)
    const minVis = cfg.emotion?.minVisibleIntensity ?? 0.18
    const visible = emotions.filter((e) => e.intensity >= minVis)
    const v = clamp11(state.valence)
    const rel = targetUserId ? await this.dao.get('SELECT resentment,guardedness,gratitude,affinity FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [botId, groupId, targetUserId]).catch(() => null) : null

    // 语气/开放度/长度（§15.1）
    let tone = '平常'
    if (v < -0.15) tone = '比平时冷一点'
    else if (v > 0.25) tone = '比平时轻快一点'
    const openness = v < -0.3 ? '低' : v < -0.1 ? '中低' : '中'
    const length = v < -0.2 || visible.some((e) => ['anger', 'hurt'].includes(e.emotion_type)) ? '短' : '正常'
    const topEmo = visible[0]?.emotion_type
    const emoZh = { amusement: '觉得好笑', anger: '不爽', hurt: '受伤', sadness: '难过', disappointment: '失望', loneliness: '有点落单', embarrassment: '尴尬', joy: '高兴', gratitude: '感激', relief: '松了口气', anxiety: '不安', pride: '自豪' }[topEmo]
    const emotionToShow = emoZh ? `轻微${emoZh}，不主动卖惨` : '无明显情绪'
    let distance = '平常'
    if (rel) {
      const neg = clamp01((Number(rel.resentment) || 0) + (Number(rel.guardedness) || 0))
      if (neg > 0.5) distance = '保持边界'
      else if (neg > 0.25) distance = '稍微收着点'
      else if (clamp01(Number(rel.gratitude) || 0) > 0.4) distance = '更亲近些'
    }
    // may_reference_cause：仅 Planner 明确选择表达类意图才允许点出原因
    const mayRef = ['express_disappointment', 'attempt_repair', 'accept_apology', 'set_boundary'].includes(plannerIntent)
      && cfg.replyer?.allowNaturalEmotionDisclosure !== false

    const capsule = { tone, openness, length, emotion_to_show: emotionToShow, target_distance: distance, may_reference_cause: mayRef }
    const text = `【当前表达状态（只影响语气/长度/距离感；不输出数值；不说"系统判断"）】语气${tone}；开放度${openness}；长度${length}；${emotionToShow}；对对方：${distance}${mayRef ? '；可以自然点到刚才的事，但一句带过' : ''}`
    this.trace?.record?.('ss_project', { groupId, role: 'replyer', tone })
    return { neutral: false, capsule, text }
  }

  _plannerText(p, visible, maxTok) {
    const lines = [
      `【自我状态偏置（仅供参与态度参考，非命令；不向群友复述）】`,
      `心境：${MOOD_ZH[p.overall_mood]}｜精力${p.energy === 'low' ? '偏低' : '正常'}｜社交安心感${p.social_security === 'low' ? '偏低' : '正常'}`,
    ]
    if (p.target_stance && p.target_stance !== 'normal') lines.push(`对当前发言对象：${STANCE_ZH[p.target_stance]}`)
    if (p.active_concern) lines.push(`未决心事：${p.active_concern.summary}`)
    // 数值不进文本（分档中文，即使被模型复述泄漏也不像系统输出）；数值仅存于结构化 projection 对象
    const bias = Object.entries(p.action_bias || {}).filter(([, v]) => Math.abs(v) >= 0.05)
      .map(([k, v]) => `${k}${v > 0 ? '↑' : '↓'}${Math.abs(v) >= 0.25 ? '较强' : '轻微'}`)
    if (bias.length) lines.push(`行为偏置：${bias.join(' ')}`)
    if (p.expression_budget === 'low') lines.push(`表达预算：低（少说、短句）`)
    // 预算裁剪（粗估：中文 1 字≈1.5tok）
    let t = lines.join('\n')
    const est = Math.ceil([...t].length * 1.5)
    if (est > maxTok && lines.length > 3) t = lines.slice(0, 3).join('\n') + '\n…'
    return t
  }

  async _getState(botId, groupId) {
    let s = await this.dao.get('SELECT * FROM ss_group_state WHERE bot_id=? AND group_id=?', [botId, groupId]).catch(() => null)
    if (!s) s = { valence: 0, arousal: 0.2, energy: 0.7, social_security: 0.6, agency: 0.6, expression_frozen: 0, state_version: 1 }
    return s
  }
}

const NEUTRAL = () => ({ neutral: true, projection: null, text: '' })
const NEUTRAL_CAPSULE = () => ({ neutral: true, capsule: null, text: '' })
