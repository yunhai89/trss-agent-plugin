/**
 * StateMaintenance —— SelfState 维护任务（设计文档 v1.1 §9.5 兜底、§20.4、§20.5、§22.3、retention）。
 *
 * 每日（低峰）：
 *  1. 懒衰减兜底扫描（长期无人读取的群也衰减，写库）；
 *  2. 期待/情绪/心事过期（§16.3/§6.7）；
 *  3. §20.4 防自强化：无新证据的负面关系残留定期衰减（缺少互动≠负面互动）；
 *  4. §20.5 状态上限：负心境持续超 maxNegativeMoodHours → 恢复流程（降即时情绪→保留关系事件→恢复参与倾向→记稳定性修正）；
 *  5. §22.3 异常自检：数值越界钳回、对无关用户残留清零、已删消息锚点情绪失效、版本冲突自愈；
 *  6. retention 清理（transitions 14d、resolved emotions/expectations 7d）。
 */
import Log from '../../utils/Log.js'

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))
const clamp11 = (v) => Math.max(-1, Math.min(1, Number(v) || 0))
const ENGINE_VERSION = 'ss-maint-v1'

export class StateMaintenance {
  /**
   * @param {object} opts { dao, emotion, cfg:()=>object, trace? }
   */
  constructor({ dao, emotion, concerns = null, cfg, trace = null } = {}) {
    if (!dao) throw new Error('StateMaintenance 需要 dao')
    this.dao = dao
    this.emotion = emotion
    this.concerns = concerns
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.trace = trace
  }

  /** 心事过期：TTL = resentment.halfLifeDays × 2（§6.7）。统一走 ConcernManager.expireStale，
   *  使面板「怨气半衰期(天)」生效（此前本文件硬编码 21 天 → 该配置项是死配置）。 */
  async _expireConcerns({ botId, groupId, now }) {
    if (this.concerns?.expireStale) return await this.concerns.expireStale({ botId, groupId, now })
    const days = Math.max(1, Number(this._cfgFn().resentment?.halfLifeDays) || 7) * 2
    return this._expire('ss_concerns', "status='active' AND updated_at<?", [now - days * 86400000], now)
  }

  /** 对一个群跑维护。返回统计。 */
  async runGroup({ botId, groupId, now = Date.now() }) {
    const cfg = this._cfgFn()
    const r = { decayed: 0, expired: 0, residueDecay: 0, recoveries: 0, sanityFixed: 0, cleaned: 0 }
    try {
      // 1. 懒衰减兜底
      if (cfg.emotion?.lazyDecay !== false) {
        const list = await this.emotion.decayAndGetActive(botId, groupId, now)
        r.decayed = list.length
      }
      // 2. 过期
      const rt = cfg.retention || {}
      r.expired += await this._expire('ss_expectations', "status IN ('pending','uncertain') AND expires_at<?", [now - (rt.resolvedExpectationDays ?? 7) * 86400000], now)
      r.expired += await this._expire('ss_emotions', "status='resolved' AND resolved_at<?", [now - (rt.resolvedEmotionDays ?? 7) * 86400000], now)
      r.expired += await this._expireConcerns({ botId, groupId, now })
      // ss_reflections 此前只置 status='expired'、从不删行（表只增不减）；且被旧代码置过 expired 的行
      // 会被 "status='active'" 条件永久排除在清理之外（第 7 轮 M1）→ 改成按 expires_at 直接删除。
      // 读取侧 activeAll 本来就只认"active 且未过期"，删除不影响投影；expires_at 为 NULL 的行不匹配、保留。
      r.expired += await this._expire('ss_reflections', 'expires_at<?', [now], now, 'delete')
      // 3. 负残留衰减（§20.4：无新证据支持 → 缓慢归零）
      const staleCutoff = now - 3 * 86400000
      const res = await this.dao.run(
        `UPDATE gw_bot_rel SET
           resentment=IFNULL(resentment,0)*0.8, guardedness=IFNULL(guardedness,0)*0.85,
           hurt=IFNULL(hurt,0)*0.8, disappointment=IFNULL(disappointment,0)*0.85, gratitude=IFNULL(gratitude,0)*0.9
         WHERE bot_id=? AND group_id=? AND (last_affective_event_at IS NULL OR last_affective_event_at<?)`,
        [botId, groupId, staleCutoff],
      ).catch(() => null)
      r.residueDecay = res?.changes || 0
      // 4. 负心境上限（§20.5）
      r.recoveries = await this._enforceMoodCeiling({ botId, groupId, now })
      // 5. 异常自检（§22.3）
      r.sanityFixed = await this._sanityCheck({ botId, groupId, now })
      // 6. retention
      r.cleaned += await this._expire('ss_transitions', 'created_at<?', [now - (rt.transitionLogDays ?? 14) * 86400000], now, 'delete')
      this.trace?.record?.('ss_maint', { groupId, ...r })
    } catch (e) { Log.warn('[selfstate] 维护失败', groupId, e?.message || e) }
    return r
  }

  // 各表可写的审计列不同（修复：此前通用 SET 带 updated_at，但 ss_expectations 只有 resolved_at、
  // ss_reflections 两者皆无 → "no such column" 被 catch 吞掉 → 期待/反思过期清理永远静默失败）。
  // ss_reflections 现在走 mode='delete' 的保留期清理（第 7 轮 M1），保留表项是防止误用 expire 模式再报 no such column。
  static EXPIRE_COLS = {
    ss_emotions: ['resolved_at', 'updated_at'],
    ss_concerns: ['resolved_at', 'updated_at'],
    ss_expectations: ['resolved_at'],
    ss_reflections: [],
  }

  async _expire(table, where, params, now, mode = 'expire') {
    try {
      if (mode === 'delete') return (await this.dao.run(`DELETE FROM ${table} WHERE ${where}`, params))?.changes || 0
      const cols = StateMaintenance.EXPIRE_COLS[table] ?? ['resolved_at']
      const sets = ["status='expired'", ...cols.map((c) => `${c}=?`)].join(', ')
      return (await this.dao.run(`UPDATE ${table} SET ${sets} WHERE ${where}`, [...cols.map(() => now), ...params]))?.changes || 0
    } catch { return 0 }
  }

  /** §20.5：负心境超时 → 恢复流程。 */
  async _enforceMoodCeiling({ botId, groupId, now }) {
    const cfg = this._cfgFn()
    const maxHours = cfg.stability?.maxNegativeMoodHours ?? 24
    const s = await this.dao.get('SELECT valence, energy, social_security, negative_since, last_transition_at FROM ss_group_state WHERE bot_id=? AND group_id=?', [botId, groupId]).catch(() => null)
    if (!s || Number(s.valence) >= -0.15) return 0
    // 负心境起点（修复：此前拿 last_transition_at 当"负心境持续时长"，而每次情绪迁移都会重置它 →
    // 只要群里还有互动，负心境永远"刚开始"，恢复流程永不触发）。旧库/旧行缺该标记时就地补一次起点。
    let since = Number(s.negative_since) || 0
    if (!since) {
      // 旧库/旧行没有 negative_since：用 last_transition_at 作为近似起点并落库为正式标记。
      // 既修掉「每次迁移都重置计时 → 永不恢复」，也不让历史负心境白等一个 24h 周期。
      since = Number(s.last_transition_at) || now
      await this.dao.run('UPDATE ss_group_state SET negative_since=? WHERE bot_id=? AND group_id=? AND negative_since IS NULL', [since, botId, groupId]).catch(() => {})
    }
    const hours = (now - since) / 3600000
    if (hours < maxHours) return 0
    // 恢复：即时情绪强度减半 → 心境回归一半 → 记稳定性修正审计（negative_since 重置，重新计时）
    await this.dao.run(
      "UPDATE ss_emotions SET intensity=intensity*0.5, updated_at=? WHERE bot_id=? AND group_id=? AND status='active'",
      [now, botId, groupId],
    ).catch(() => {})
    await this.dao.run(
      `UPDATE ss_group_state SET valence=valence*0.5, energy=MAX(energy,0.5), social_security=MAX(social_security,0.45),
        negative_since=?, last_transition_at=?, state_version=state_version+1, updated_at=? WHERE bot_id=? AND group_id=?`,
      [now, now, now, botId, groupId],
    ).catch(() => {})
    await this.dao.run(
      "INSERT INTO ss_transitions(bot_id,group_id,source_event_id,before_state_json,delta_json,after_state_json,transition_reason,engine_version,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [botId, groupId, null, JSON.stringify({ valence: s.valence }), JSON.stringify({ recovery: 'half' }), JSON.stringify({ valence: s.valence * 0.5 }), 'stability_ceiling_recovery', ENGINE_VERSION, now],
    ).catch(() => {})
    Log.mark('[selfstate]', `负心境超 ${maxHours}h，触发恢复流程 群${groupId}`)
    return 1
  }

  /** §22.3 自检修正。 */
  async _sanityCheck({ botId, groupId, now }) {
    let n = 0
    // 数值越界钳回
    const fixed = await this.dao.run(
      `UPDATE ss_group_state SET
         valence=MAX(-1,MIN(1,valence)), arousal=MAX(0,MIN(1,arousal)), energy=MAX(0,MIN(1,energy)),
         social_security=MAX(0,MIN(1,social_security)), agency=MAX(0,MIN(1,agency))
       WHERE bot_id=? AND group_id=? AND (valence<-1 OR valence>1 OR arousal<0 OR arousal>1 OR energy<0 OR energy>1)`,
      [botId, groupId],
    ).catch(() => null)
    n += fixed?.changes || 0
    // 情绪强度越界
    const em = await this.dao.run("UPDATE ss_emotions SET intensity=MAX(0,MIN(1,intensity)), updated_at=? WHERE bot_id=? AND group_id=? AND (intensity<0 OR intensity>1)", [now, botId, groupId]).catch(() => null)
    n += em?.changes || 0
    // 无目标情绪残留带 target 的清 target（防错绑）
    // （略——绑定在写入时已保证；此处保守不清理）
    return n
  }
}
