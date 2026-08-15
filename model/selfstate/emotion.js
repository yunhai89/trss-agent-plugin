/**
 * EmotionTransition —— 情绪产生、衰减、聚合与状态迁移（设计文档 v1.1 §9）。
 *
 * base = self_relevance × directedness × certainty × event_salience（§9.1）
 * 17 事件类型 → impulse 模板 + §9.2 七公式微调；§9.3 性格调质 × 稳定上限（普通 0.20 / 高显著 0.35 / 玩笑怨气 0.03）；
 * §9.4 半衰期表 × recovery_speed/rumination/亲密度/重复；§9.5 懒衰减（读时算+回写）；
 * §9.6 CoreAffect 聚合（投影只影响群级状态，不改人格）；乐观锁（§21.4）+ ss_transitions 审计（§6.8）。
 * 关系残留（gratitude/hurt/resentment/guardedness/disappointment）写 gw_bot_rel 扩列，衰减慢于即时情绪。
 */
import Log from '../../utils/Log.js'

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))
const clamp11 = (v) => Math.max(-1, Math.min(1, Number(v) || 0))
const ENGINE_VERSION = 'ss-emotion-v2'

/**
 * §9.4 双指数衰减（算法升级 #4）：快分量（权重 0.7，原半衰期）+ 慢拖尾（权重 0.3，8× 半衰期）。
 * 真实情绪不是纯指数——先猛降后拖尾（激愤当天消一半，低强度残留拖几天）；单指数要么消太快
 * 要么赖太久。t=0 时两分量权重和为 1，与原公式幅值兼容；合并/懒衰减/读时回写统一走本函数。
 */
export function decayIntensity(intensity, halfLifeSeconds, elapsedMs) {
  const hl = Math.max(60, Number(halfLifeSeconds) || 3600)
  const t = Math.max(0, Number(elapsedMs) || 0) / 1000
  return Number(intensity) * (0.7 * Math.pow(0.5, t / hl) + 0.3 * Math.pow(0.5, t / (hl * 8)))
}

// §9.4 半衰期基线（秒）
const HALF_LIFE = {
  amusement: 20 * 60, joy: 2 * 3600, pride: 3 * 3600, gratitude: 14 * 86400, relief: 2 * 3600,
  curiosity: 30 * 60, annoyance: 60 * 60, anger: 3 * 3600, hurt: 8 * 3600, sadness: 12 * 3600,
  embarrassment: 2 * 3600, loneliness: 3 * 3600, disappointment: 15 * 3600, anxiety: 2 * 3600, resentment: 7 * 86400,
}

// 事件类型 → 默认 impulse 模板（§9.2 公式的工程化基线；再经 appraisal 维度与性格调制）
const EVENT_IMPULSES = {
  friendly_tease: { amusement: 0.32, annoyance: 0.08 },
  direct_insult: { anger: 0.34, hurt: 0.12, annoyance: 0.2 },
  public_embarrassment: { embarrassment: 0.3, anger: 0.15, hurt: 0.1 },
  praise: { joy: 0.3, pride: 0.15 },
  thanks: { gratitude: 0.3, joy: 0.15 },
  support: { joy: 0.15, relief: 0.1 },
  defense: { gratitude: 0.32, relief: 0.18 },
  rejection: { hurt: 0.28, disappointment: 0.2 },
  ignored_expectation: { disappointment: 0.2, embarrassment: 0.12, loneliness: 0.1 },
  response_received: { relief: 0.15, joy: 0.1 },
  invitation: { joy: 0.25, curiosity: 0.1 },
  excluded: { loneliness: 0.28, hurt: 0.12 },
  help_succeeded: { pride: 0.25, joy: 0.15 },
  help_dismissed: { disappointment: 0.25, hurt: 0.1 },
  apology: { relief: 0.25 },
  repair: { relief: 0.2, gratitude: 0.1 },
  shared_fun: { amusement: 0.3, joy: 0.2 },
  directed_message: { curiosity: 0.1 },
}

// 事件 → 关系残留增量方向（写 gw_bot_rel 扩列；§6.6）
const RELATION_EFFECTS = {
  direct_insult: { hurt: 1, resentment: 1, guardedness: 1 },
  public_embarrassment: { hurt: 1, resentment: 1 },
  friendly_tease: {},                       // 玩笑不留怨气（上限 0.03 §9.3）
  praise: { gratitude: 1 }, thanks: { gratitude: 1 }, defense: { gratitude: 1 },
  rejection: { disappointment: 1, hurt: 1 }, excluded: { hurt: 1 },
  help_dismissed: { disappointment: 1 },
  apology: {}, repair: {},                  // 修复由 concerns.repairRelation 处理（§12.3）
  ignored_expectation: { disappointment: 0.5 },
}

// 情绪 → CoreAffect 投影系数（§9.6）
const AFFECT_PROJECTION = {
  valence: { joy: +1, amusement: +0.7, gratitude: +0.6, relief: +0.5, pride: +0.6, curiosity: +0.2, anger: -1, hurt: -0.9, sadness: -0.8, loneliness: -0.7, disappointment: -0.6, annoyance: -0.4, embarrassment: -0.3, anxiety: -0.4, resentment: -0.5 },
  arousal: { anger: +0.8, anxiety: +0.6, amusement: +0.5, embarrassment: +0.4, sadness: -0.4, relief: -0.3 },
  social_security: { gratitude: +0.3, relief: +0.2, loneliness: -0.8, embarrassment: -0.5, disappointment: -0.3, resentment: -0.3 },
}

export class EmotionTransition {
  /**
   * @param {object} opts { dao, cfg:()=>object, trace? }
   */
  constructor({ dao, cfg, trace = null } = {}) {
    if (!dao) throw new Error('EmotionTransition 需要 dao')
    this.dao = dao
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.trace = trace
  }

  /**
   * 应用一次事件 → 写 ss_events + ss_emotions + 心境迁移（乐观锁）+ 关系残留。返回 { eventId, impulses }。
   * @param {object} o { botId, groupId, actorUserId, eventType, appraisal, semantic, sourceMessageIds, core(temperament), now }
   */
  async applyEvent({ botId, groupId, actorUserId, eventType, appraisal, semantic, sourceMessageIds, core, now = Date.now() }) {
    const cfg = this._cfgFn()
    const em = cfg.emotion || {}
    const t = core?.temperament || {}
    const a = appraisal || {}

    // §9.1 base
    const salience = clamp01(Math.max(a.norm_violation, Math.abs(a.desirability)))
    const base = clamp01(a.self_relevance * Math.max(a.directedness, 0.4) * a.certainty * (0.5 + salience * 0.5))

    // impulse 计算 + §9.3 调质
    const template = EVENT_IMPULSES[eventType] || {}
    const highSalience = a.norm_violation > 0.6 && a.publicness > 0.6 && a.repetition > 0.5
    const capNormal = em.maxNormalImpulse ?? 0.20
    const capHigh = em.maxHighSalienceImpulse ?? 0.35
    const impulses = {}
    for (const [etype, rawI] of Object.entries(template)) {
      let v = rawI * base
      // 性格调制（敏感度按情绪类别选维度）
      const sens = etype === 'anger' || etype === 'annoyance' ? (t.disrespect_sensitivity ?? 0.5)
        : etype === 'hurt' || etype === 'disappointment' ? (t.rejection_sensitivity ?? 0.5)
          : 1
      const react = 0.6 + (t.reactivity ?? 0.5) * 0.8
      v *= clamp01(sens) * react
      // 关系修正：越亲近 hurt 越重（§9.2 hurt 公式的 0.4+closeness*0.6）
      if (etype === 'hurt') v *= 0.4 + clamp01(a.relationship_closeness) * 0.6
      if (etype === 'amusement') v *= 0.5 + clamp01(a.playfulness) * 0.5
      // 稳定上限（§9.3）
      const cap = highSalience ? capHigh : capNormal
      v = Math.min(v, cap)
      if (v >= 0.01) impulses[etype] = Math.round(v * 10000) / 10000
    }
    // 玩笑怨气上限 0.03（§9.3：单次玩笑造成的长期怨气上限）
    if (eventType === 'friendly_tease' && impulses.resentment) impulses.resentment = Math.min(impulses.resentment, 0.03)

    // 混合情绪上限条数
    let entries = Object.entries(impulses).sort((x, y) => y[1] - x[1])
    if (em.enableMixedEmotions !== false) entries = entries.slice(0, em.maxActiveEmotions ?? 8)

    // 写 ss_events
    const eventId = await this._insertEvent({ botId, groupId, actorUserId, eventType, appraisal, semantic, impulses, sourceMessageIds, base, now })

    // 写 ss_emotions（同型情绪合并：取 max 强度 + 重锚衰减）
    for (const [etype, intensity] of entries) {
      await this._upsertEmotion({ botId, groupId, etype, intensity, targetUserId: actorUserId, eventId, temperament: t, now })
    }

    // §9.6 心境聚合迁移（乐观锁 + 审计）
    await this._transitionAffect({ botId, groupId, entries, eventType, eventId, now })

    // 关系残留（gw_bot_rel 扩列，§6.6；低置信负面不入关系 §20.4）
    if (actorUserId) await this._applyRelationResidue({ botId, groupId, actorUserId, eventType, appraisal, impulses, base, cfg, now })

    this.trace?.record?.('ss_emotion', { groupId, eventType, impulses: entries.map(([e, v]) => `${e}:${v}`).join(','), base: Math.round(base * 100) / 100 })
    return { eventId, impulses, significance: base }
  }

  async _insertEvent({ botId, groupId, actorUserId, eventType, appraisal, semantic, impulses, sourceMessageIds, base, now }) {
    const confidence = clamp01(appraisal?.certainty ?? 0.5)
    const significance = clamp01(base)
    const res = await this.dao.run(
      `INSERT INTO ss_events(bot_id,group_id,event_type,actor_user_id,target_user_id,source_message_ids,appraisal_json,emotion_impulse_json,confidence,significance,occurred_at,processed_at,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [botId, groupId, eventType, actorUserId, null, JSON.stringify(sourceMessageIds || []),
        JSON.stringify(appraisal || {}), JSON.stringify(impulses || {}), confidence, significance, now, now, 'active', now],
    )
    return res?.lastID ?? null
  }

  async _upsertEmotion({ botId, groupId, etype, intensity, targetUserId, eventId, temperament, now }) {
    const halfLife = this._halfLifeFor(etype, temperament, targetUserId != null)
    const existing = await this.dao.get(
      "SELECT id, intensity, half_life_seconds, last_evaluated_at FROM ss_emotions WHERE bot_id=? AND group_id=? AND emotion_type=? AND target_user_id IS ? AND status='active' ORDER BY id DESC LIMIT 1",
      [botId, groupId, etype, targetUserId ?? null],
    )
    if (existing) {
      // 先按 §9.5 懒衰减把存量降到真实值再取 max（否则旧峰值被新小事件"满血复活"，半衰期失效）
      const decayed = decayIntensity(existing.intensity, existing.half_life_seconds, now - (existing.last_evaluated_at || now))
      const merged = Math.max(decayed, intensity)
      await this.dao.run(
        'UPDATE ss_emotions SET intensity=?, cause_event_id=?, last_evaluated_at=?, updated_at=? WHERE id=?',
        [Math.round(merged * 10000) / 10000, eventId, now, now, existing.id],
      )
    } else {
      await this.dao.run(
        `INSERT INTO ss_emotions(bot_id,group_id,emotion_type,intensity,target_user_id,cause_event_id,started_at,half_life_seconds,last_evaluated_at,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [botId, groupId, etype, intensity, targetUserId, eventId, now, halfLife, now, 'active', now, now],
      )
    }
  }

  /** §9.4 半衰期 × recovery/rumination 调制。 */
  _halfLifeFor(etype, temperament, hasTarget) {
    let hl = HALF_LIFE[etype] || 2 * 3600
    const rec = Number(temperament?.recovery_speed ?? 0.5)
    const rum = Number(temperament?.rumination ?? 0.5)
    // 恢复快→半衰期短；反刍→负面情绪半衰期长
    if (/anger|hurt|sadness|disappointment|resentment|loneliness/.test(etype)) hl *= (1.3 - rec * 0.6) * (0.8 + rum * 0.6)
    else hl *= 1.2 - rec * 0.4
    if (etype === 'resentment') hl = Math.max(hl, 6 * 3600) // 怨气至少 6h（修复：此前误写 6h 的毫秒数当秒用 ≈ 250 天）
    return Math.max(300, Math.round(hl))
  }

  /** §9.5 懒衰减：读取某群活跃情绪，按 last_evaluated_at 一次性衰减并回写。返回衰减后列表。
   *  §9.4：intensity(t) = intensity(t0) × 0.5^((t−t0)/half_life)——elapsed(ms) 与 half_life(s) 单位换算。 */
  async decayAndGetActive(botId, groupId, now = Date.now()) {
    const rows = await this.dao.all(
      "SELECT * FROM ss_emotions WHERE bot_id=? AND group_id=? AND status='active'",
      [botId, groupId],
    )
    const out = []
    for (const r of rows) {
      const decayed = decayIntensity(r.intensity, r.half_life_seconds, now - (r.last_evaluated_at || r.started_at))
      if (decayed < 0.01) {
        await this.dao.run("UPDATE ss_emotions SET status='resolved', resolved_at=?, intensity=0, updated_at=? WHERE id=?", [now, now, r.id])
      } else {
        await this.dao.run('UPDATE ss_emotions SET intensity=?, last_evaluated_at=?, updated_at=? WHERE id=?', [Math.round(decayed * 10000) / 10000, now, now, r.id])
        out.push({ ...r, intensity: Math.round(decayed * 10000) / 10000 })
      }
    }
    return out.sort((a, b) => b.intensity - a.intensity)
  }

  /** §9.6 CoreAffect 聚合 + 乐观锁迁移 + 审计。
   *  EMA 惯性积分器（算法升级 #5，在"绝对投影"防饱和基础上加时间惯性）：
   *    target = f(当前活跃情绪集合)（绝对投影，天然无饱和）
   *    valence = (1-α)·prev + α·target，α = emotion.moodEmaAlpha（默认 0.3）
   *  心境跟随情绪但带惯性——被骂后低落持续一晚上而不是半小时；超过 moodResetHours（默认 6h）
   *  无迁移则 α→1，一觉醒来自动回基线。 */
  async _transitionAffect({ botId, groupId, entries, eventType, eventId, now }) {
    const emc = this._cfgFn().emotion || {}
    const active = await this.decayAndGetActive(botId, groupId, now) // 含刚写入的
    let pValence = 0; let pArousal = 0; let pSecurity = 0
    for (const e of active) {
      const i = Number(e.intensity) || 0
      pValence += (AFFECT_PROJECTION.valence[e.emotion_type] || 0) * i
      pArousal += (AFFECT_PROJECTION.arousal[e.emotion_type] || 0) * i
      pSecurity += (AFFECT_PROJECTION.social_security[e.emotion_type] || 0) * i
    }
    const state = await this._getOrCreateState(botId, groupId)
    const before = { valence: state.valence, arousal: state.arousal, energy: state.energy, social_security: state.social_security, agency: state.agency }
    const target = {
      valence: clamp11(pValence * 0.5),
      arousal: clamp01(0.2 + pArousal * 0.4),
      energy: clamp01(0.7 - Math.max(0, -clamp11(pValence * 0.5)) * 0.3), // 负面按当前深度消耗精力（随情绪消退自动恢复）
      social_security: clamp01(0.6 + pSecurity * 0.5),
    }
    const elapsed = state.last_transition_at ? now - Number(state.last_transition_at) : Infinity
    const alpha = elapsed >= (emc.moodResetHours ?? 6) * 3600000
      ? 1
      : clamp01(emc.moodEmaAlpha ?? 0.3)
    const blend = (prev, tgt) => (1 - alpha) * Number(prev) + alpha * tgt
    const after = {
      valence: clamp11(blend(state.valence, target.valence)),
      arousal: clamp01(blend(state.arousal, target.arousal)),
      energy: clamp01(blend(state.energy, target.energy)),
      social_security: clamp01(blend(state.social_security, target.social_security)),
      agency: Number(state.agency),
    }
    // 乐观锁（§21.4）：冲突时直接覆盖写（投影是绝对值，与重算等价，无累加风险）
    const upd = await this.dao.run(
      `UPDATE ss_group_state SET valence=?, arousal=?, energy=?, social_security=?, agency=?, last_transition_at=?, updated_at=?, state_version=state_version+1
       WHERE bot_id=? AND group_id=? AND state_version=?`,
      [after.valence, after.arousal, after.energy, after.social_security, after.agency, now, now, botId, groupId, state.state_version],
    )
    if (!upd?.changes) {
      await this.dao.run(
        'UPDATE ss_group_state SET valence=?, arousal=?, energy=?, social_security=?, agency=?, last_transition_at=?, updated_at=?, state_version=state_version+1 WHERE bot_id=? AND group_id=?',
        [after.valence, after.arousal, after.energy, after.social_security, after.agency, now, now, botId, groupId],
      ).catch(() => {})
    }
    // 审计（§6.8）
    await this.dao.run(
      `INSERT INTO ss_transitions(bot_id,group_id,source_event_id,before_state_json,delta_json,after_state_json,transition_reason,engine_version,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [botId, groupId, eventId, JSON.stringify(before), JSON.stringify({ dValence: Math.round((after.valence - Number(before.valence)) * 1000) / 1000, dArousal: Math.round((after.arousal - Number(before.arousal)) * 1000) / 1000, dSecurity: Math.round((after.social_security - Number(before.social_security)) * 1000) / 1000 }),
        JSON.stringify(after), String(eventType || 'decay'), ENGINE_VERSION, now],
    ).catch(() => {})
    return after
  }

  /** 关系残留写 gw_bot_rel 扩列（§6.6/§10.4）。低置信负面不入关系（§20.4）；
   *  base 门槛（§7.1/§20.2）：无指向/与机器人无关的消息（base≈0，如路人骂街）不写任何关系残留。 */
  async _applyRelationResidue({ botId, groupId, actorUserId, eventType, appraisal, impulses, base, cfg, now }) {
    const effects = RELATION_EFFECTS[eventType]
    if (!effects || !Object.keys(effects).length) return
    if (base < 0.2) return
    const rcfg = cfg.resentment || {}
    const confOK = (appraisal?.certainty ?? 0) >= (rcfg.minCreateConfidence ? rcfg.minCreateConfidence - 0.15 : 0.57)
    if (!confOK && Object.values(effects).some((w) => w > 0) && (appraisal?.desirability ?? 0) < 0) return // 低置信负面不入关系
    await this.dao.run('INSERT OR IGNORE INTO gw_bot_rel(bot_id,group_id,user_id,updated_at) VALUES (?,?,?,?)', [botId, groupId, actorUserId, now])
    for (const [col, w] of Object.entries(effects)) {
      if (!w) continue
      let delta = 0.06 * w * Math.min(1, Math.abs(appraisal?.desirability ?? 0.5) + 0.3)
      // 怨气单次上限（§9.3/§18 resentment.maxSingleEventDelta）
      if (col === 'resentment') {
        // §10.4 记仇需重复：重复度不足时怨气增量极小
        const rep = Number(appraisal?.repetition) || 0
        if (rep < 0.5) delta *= 0.25
        delta = Math.min(delta, rcfg.maxSingleEventDelta ?? 0.05)
      }
      if (col === 'gratitude') delta = Math.min(delta, 0.1)
      await this.dao.run(
        `UPDATE gw_bot_rel SET ${col}=MIN(1, IFNULL(${col},0)+?), last_affective_event_at=?, unresolved_event_count=unresolved_event_count+?, updated_at=? WHERE bot_id=? AND group_id=? AND user_id=?`,
        [Math.round(delta * 10000) / 10000, now, eventType === 'apology' || eventType === 'repair' ? 0 : 1, now, botId, groupId, actorUserId],
      )
    }
  }

  async _getOrCreateState(botId, groupId) {
    let s = await this.dao.get('SELECT * FROM ss_group_state WHERE bot_id=? AND group_id=?', [botId, groupId])
    if (!s) {
      const now = Date.now()
      await this.dao.run('INSERT OR IGNORE INTO ss_group_state(bot_id,group_id,updated_at) VALUES (?,?,?)', [botId, groupId, now])
      s = await this.dao.get('SELECT * FROM ss_group_state WHERE bot_id=? AND group_id=?', [botId, groupId])
    }
    return s
  }

  /** 修复：降低即时愤怒/受伤（§12.3 由 concerns 调用）。 */
  async sootheImmediate(botId, groupId, targetUserId, factor, now = Date.now()) {
    const rows = await this.dao.all(
      "SELECT id, intensity FROM ss_emotions WHERE bot_id=? AND group_id=? AND (target_user_id IS ? OR target_user_id IS NULL) AND emotion_type IN ('anger','hurt') AND status='active'",
      [botId, groupId, targetUserId ?? null],
    )
    for (const r of rows) {
      const nv = Number(r.intensity) * (1 - clamp01(factor))
      if (nv < 0.01) await this.dao.run("UPDATE ss_emotions SET status='resolved', resolved_at=?, intensity=0, updated_at=? WHERE id=?", [now, now, r.id])
      else await this.dao.run('UPDATE ss_emotions SET intensity=?, updated_at=? WHERE id=?', [Math.round(nv * 10000) / 10000, now, r.id])
    }
  }
}

export { HALF_LIFE, EVENT_IMPULSES, AFFECT_PROJECTION, ENGINE_VERSION }
