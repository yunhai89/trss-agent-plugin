/**
 * ConcernManager —— 未解决心事与关系修复（设计文档 v1.1 §6.7、§10.4、§12）。
 *
 * §10.4 记仇定义：负面事件达显著阈值 + 绑具体成员 + 即时情绪衰减后仍留低强度 resentment
 * + 影响该成员的互动距离/信任/帮助意愿 + 可被道歉/解释/新正面经历修复 + 无新证据自然衰减。
 * §12.3 修复公式：repair_amount = repair_signal × sincerity × relationship_value × no_repeat_bonus；
 * 先降即时 anger/hurt（emotion.sootheImmediate），再缓降 resentment/guardedness（不瞬间清空）。
 * 禁止对 A 记仇而对 B/全群/功能指令表现敌意（§10.4/§20.2）——本模块只按 targetUserId 操作。
 */
import Log from '../../utils/Log.js'

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

// 事件 → 心事类型（显著负面才建/升级）
const CONcern_TRIGGERS = {
  direct_insult: 'unresolved_disrespect',
  public_embarrassment: 'unresolved_disrespect',
  excluded: 'unresolved_exclusion',
  rejection: 'unresolved_rejection',
  help_dismissed: 'unappreciated_help',
  ignored_expectation: 'ignored_pattern',
}

export class ConcernManager {
  /**
   * @param {object} opts { dao, emotion, cfg:()=>object, trace? }
   *   emotion = EmotionTransition 实例（修复时 sootheImmediate）
   */
  constructor({ dao, emotion = null, cfg, trace = null } = {}) {
    if (!dao) throw new Error('ConcernManager 需要 dao')
    this.dao = dao
    this.emotion = emotion
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.trace = trace
  }

  /**
   * 事件后更新心事（显著负面 → 创建/升级；无目标不建）。返回 concern 行或 null。
   * @param {object} o { botId, groupId, actorUserId, eventType, appraisal, eventId, significance(=事件 base), now }
   */
  async onEvent({ botId, groupId, actorUserId, eventType, appraisal, eventId, significance = 0, now = Date.now() }) {
    if (!actorUserId) return null
    const cfg = this._cfgFn()
    const rcfg = cfg.resentment || {}
    const concernType = CONcern_TRIGGERS[eventType]
    if (!concernType) return null
    if (significance < 0.2) return null // base 门槛（§7.1/§20.2）：无指向/与机器人无关的消息不建心事

    const sig = clamp01(significance * 0.5 + (appraisal?.norm_violation ?? 0) * 0.5)
    if (sig < 0.25) return null // 未达显著阈值（§10.4）

    // 同型心事升级（intensity 提升 + 追加 source_event_ids）
    const existing = await this.dao.get(
      "SELECT * FROM ss_concerns WHERE bot_id=? AND group_id=? AND concern_type=? AND target_user_id=? AND status='active' ORDER BY id DESC LIMIT 1",
      [botId, groupId, concernType, actorUserId],
    )
    if (existing) {
      let ids = []; try { ids = JSON.parse(existing.source_event_ids || '[]') } catch { /* noop */ }
      ids.push(eventId)
      const intensity = clamp01(Math.max(Number(existing.intensity), sig * 0.5))
      await this.dao.run(
        'UPDATE ss_concerns SET intensity=?, priority=?, source_event_ids=?, updated_at=? WHERE id=?',
        [intensity, clamp01(intensity * 0.9), JSON.stringify(ids.slice(-10)), now, existing.id],
      )
      this.trace?.record?.('ss_concern', { groupId, kind: 'upgrade', type: concernType, target: actorUserId, intensity })
      return { ...existing, intensity }
    }
    // 记仇需重复（§18 minRepeatedEvents）：重复度不足时仍建但低强度（monitor）
    const rep = Number(appraisal?.repetition) || 0
    const res = await this.dao.run(
      `INSERT INTO ss_concerns(bot_id,group_id,concern_type,target_user_id,source_event_ids,summary,intensity,priority,desired_resolution,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [botId, groupId, concernType, actorUserId, JSON.stringify([eventId]),
        this._summary(eventType, actorUserId, rep), clamp01(sig * (0.45 + rep * 0.3)), clamp01(sig * 0.5),
        concernType === 'unresolved_disrespect' ? 'apology_or_positive_interaction' : 'positive_interaction',
        'active', now, now],
    )
    this.trace?.record?.('ss_concern', { groupId, kind: 'create', type: concernType, target: actorUserId })
    return { id: res?.lastID ?? null }
  }

  /** 修复事件（apology/repair）→ §12.3 公式。返回修复量。 */
  async applyRepair({ botId, groupId, actorUserId, repairSignal = 0.8, sincerity = 0.7, now = Date.now() }) {
    const rel = await this.dao.get('SELECT * FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [botId, groupId, actorUserId])
    if (!rel) return 0
    const relationshipValue = clamp01(0.3 + (Number(rel.familiarity) || 0) * 0.4 + (Number(rel.affinity) || 0) * 0.3)
    const noRepeatBonus = (Number(rel.unresolved_event_count) || 0) < 2 ? 1.2 : 1.0
    const repairAmount = clamp01(clamp01(repairSignal) * clamp01(sincerity) * relationshipValue * noRepeatBonus * 0.5)

    // 先降即时 anger/hurt
    if (this.emotion) await this.emotion.sootheImmediate(botId, groupId, actorUserId, repairAmount * 0.8, now)
    // 再缓降 resentment/guardedness（乘性缓降，不清零）
    const soft = 1 - repairAmount * 0.4
    await this.dao.run(
      'UPDATE gw_bot_rel SET resentment=IFNULL(resentment,0)*?, guardedness=IFNULL(guardedness,0)*?, hurt=IFNULL(hurt,0)*?, disappointment=IFNULL(disappointment,0)*?, unresolved_event_count=0, updated_at=? WHERE bot_id=? AND group_id=? AND user_id=?',
      [soft, 1 - repairAmount * 0.3, 1 - repairAmount * 0.5, 1 - repairAmount * 0.5, now, botId, groupId, actorUserId],
    )
    // 相关心事降级/解决
    const concerns = await this.dao.all(
      "SELECT * FROM ss_concerns WHERE bot_id=? AND group_id=? AND target_user_id=? AND status='active'",
      [botId, groupId, actorUserId],
    )
    for (const c of concerns) {
      const ni = clamp01(Number(c.intensity) * (1 - repairAmount * 0.7))
      if (ni < 0.08) await this.dao.run("UPDATE ss_concerns SET status='resolved', resolved_at=?, updated_at=? WHERE id=?", [now, now, c.id])
      else await this.dao.run('UPDATE ss_concerns SET intensity=?, updated_at=? WHERE id=?', [ni, now, c.id])
    }
    this.trace?.record?.('ss_concern', { groupId, kind: 'repair', target: actorUserId, amount: Math.round(repairAmount * 100) / 100 })
    return repairAmount
  }

  /** 心事过期（TTL/自然衰减）。 */
  async expireStale({ botId, groupId, now = Date.now() }) {
    const rcfg = this._cfgFn().resentment || {}
    const ttl = (rcfg.halfLifeDays ?? 7) * 2 * 86400000
    await this.dao.run(
      "UPDATE ss_concerns SET status='expired', resolved_at=?, updated_at=? WHERE bot_id=? AND group_id=? AND status='active' AND updated_at<?",
      [now, now, botId, groupId, now - ttl],
    ).catch(() => {})
  }

  /** 取某目标的活跃心事（投影用）。 */
  async activeForTarget(botId, groupId, targetUserId) {
    if (!targetUserId) return null
    return this.dao.get(
      "SELECT concern_type, summary, intensity FROM ss_concerns WHERE bot_id=? AND group_id=? AND target_user_id=? AND status='active' ORDER BY intensity DESC LIMIT 1",
      [botId, groupId, targetUserId],
    ).catch(() => null)
  }

  async activeAll(botId, groupId) {
    return this.dao.all(
      "SELECT * FROM ss_concerns WHERE bot_id=? AND group_id=? AND status='active' ORDER BY priority DESC LIMIT 20",
      [botId, groupId],
    ).catch(() => [])
  }

  _summary(eventType, actorUserId, repetition) {
    const rep = repetition > 0.5 ? '近期多次' : '近期'
    const map = {
      direct_insult: `${rep}公开对机器人不尊重，尚无解释或修复`,
      public_embarrassment: `${rep}使机器人公开难堪`,
      excluded: '群内互动中明显绕开机器人',
      rejection: '明确拒绝机器人的提议或帮助',
      help_dismissed: '机器人提供的帮助被轻视',
      ignored_expectation: `${rep}多次跳过对机器人的直接回应`,
    }
    return (map[eventType] || '未解决的关系摩擦').slice(0, 500)
  }
}

export { CONcern_TRIGGERS }
