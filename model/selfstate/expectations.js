/**
 * ExpectationManager —— 回应期待与冷落判定（设计文档 v1.1 §11、§16）。
 *
 * §11.1 仅五场景建期待（提问/双向对话中/邀请/对方请求的帮助后/有限自我表达后）；纯陈述不建。
 * §11.2 强度公式；§11.3 动态 deadline = max(群节奏, 目标响应, 最低窗)；§16.2 后续消息匹配顺序；
 * §11.5 ignore_score 四档（<0.45 自然 / 0.45~0.65 uncertain / 0.65~0.8 轻微 / >0.8+重复可残留）；
 * §16.3 七态生命周期；§11.4 反证清单（群集体沉默/目标不在线/刷屏不可见 → 不判冷落）。
 * §20.4 防自强化：bot_initiated_withdrawal 标记后的沉默不计冷落。
 */
import Log from '../../utils/Log.js'

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

// 出站消息文本 → 期待判定（规则；不调 LLM）。问句判定（修复：此前 ^那?你… 前缀过宽，
// "你觉得这游戏不行"这类陈述句也误建期待）——有问号，或以"呢/吗/嘛/么"收尾，或以疑问开头词起头。
function classifyOutgoing(text) {
  const s = String(text || '').trim()
  const isQuestion = /[?？]/.test(s) || /[呢吗嘛么]\s*$/.test(s) || /^(?:谁来|有没有|要不要|是不是|怎么样|如何)/.test(s)
  const directTarget = /@|你说|你觉得|你那边|给你|帮你/.test(s)
  return { isQuestion, directTarget, expectationType: isQuestion ? 'direct_answer' : null }
}

export class ExpectationManager {
  /**
   * @param {object} opts { dao, cfg:()=>object, trace? }
   */
  constructor({ dao, cfg, trace = null } = {}) {
    if (!dao) throw new Error('ExpectationManager 需要 dao')
    this.dao = dao
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.trace = trace
  }

  /**
   * §16.1 发送成功后登记期待（仅真实发送）。返回期待行或 null。
   * @param {object} o { botId, groupId, sourceMessageId, targetUserId?, sentText, replyGuide?, now }
   */
  async register({ botId, groupId, sourceMessageId, targetUserId = null, sentText = '', replyGuide = '', now = Date.now() }) {
    const cfg = this._cfgFn()
    const ec = cfg.expectations || {}
    if (ec.enabled === false) return null
    const { isQuestion, directTarget, expectationType } = classifyOutgoing(`${sentText} ${replyGuide}`)
    if (!expectationType) return null // §11.1 纯陈述不建期待

    // §11.2 强度
    const strength = clamp01(
      (isQuestion ? 0.30 : 0.1) + (directTarget || targetUserId ? 0.25 : 0) + 0.15 + 0.1 + 0.1,
    )
    // §11.3 动态窗口：群节奏 + 目标响应 + 最低/最高钳制
    const groupPace = await this._groupPaceMs(groupId, now)
    const targetPace = targetUserId ? await this._targetPaceMs(groupId, targetUserId, now) : 0
    const minW = (ec.minimumWindowSeconds ?? 90) * 1000
    const maxW = (ec.maximumWindowSeconds ?? 3600) * 1000
    const deadline = Math.max(groupPace, targetPace, minW)
    const expires = now + Math.min(maxW, deadline)

    const res = await this.dao.run(
      `INSERT INTO ss_expectations(bot_id,group_id,source_message_id,target_user_id,expectation_type,expectation_strength,group_activity_at_send,normal_response_ms,not_before_at,expires_at,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [botId, groupId, String(sourceMessageId), targetUserId, expectationType, strength, clamp01(groupPace / 600000), Math.round(deadline), now + Math.min(minW, 30000), expires, 'pending', now],
    )
    this.trace?.record?.('ss_expectation', { groupId, kind: 'register', type: expectationType, strength, deadlineSec: Math.round((expires - now) / 1000) })
    return res?.lastID ?? null
  }

  /**
   * §16.2 新消息到来：匹配未解决期待 → 回应/冷落判定。返回解析结果数组。
   * @param {object} o { botId, groupId, norm, quoteIsBot, now }
   */
  async resolveForMessage({ botId, groupId, norm, quoteIsBot, now = Date.now() }) {
    const cfg = this._cfgFn()
    const ec = cfg.expectations || {}
    const out = []
    if (ec.enabled === false || !norm || norm.isSelf) return out

    // 只取尚未到期的期待做"回应匹配"；到期判定统一走 sweepExpired（由 service.onMessage 紧随调用）——
    // 此前这里内联 _judgeExpiry 且丢弃返回值，导致"到期后 60s 内来了新消息"的 ignored 事件永久丢失（恰是最活跃群的场景）
    const pending = await this.dao.all(
      "SELECT * FROM ss_expectations WHERE bot_id=? AND group_id=? AND status='pending' AND expires_at>? ORDER BY id",
      [botId, groupId, now],
    )
    if (!pending.length) return out

    const fromSender = String(norm.userId)
    const text = String(norm.text || '')
    const repliedToBotMsg = !!(norm.replyToId && quoteIsBot)
    const mentionsBot = !!norm.atBot

    // 回应匹配（§16.2 匹配顺序；修复：此前 semanticAnswer 含 isTarget——目标回复"别人"的任意闲聊
    // 如"哈哈哈"都会 fulfill 未到期期待，真实场景的"活跃但绕开"几乎总被误判已回应）
    const replyingToOther = !!(norm.replyToId && !quoteIsBot) // 回复链指向他人 → 不是对机器人说话
    const casualReaction = /^[哈嘿嘻嘻xX～~\s!！。.,，?？]{1,6}$|^\[.+\]$/.test(text.trim()) // 纯语气/表情反应不算回答
    for (const exp of pending) {
      const isTarget = !exp.target_user_id || String(exp.target_user_id) === fromSender
      // 无显式指向的"语义回答"从严：目标本人 + 未在回复他人 + 实质内容（≥4 字、非问句、非纯反应）
      const semanticAnswer = exp.expectation_type === 'direct_answer' && isTarget && !replyingToOther
        && !/[?？]/.test(text) && [...text].length >= 4 && !casualReaction
      if (isTarget && (repliedToBotMsg || mentionsBot || semanticAnswer)) {
        await this.dao.run(
          "UPDATE ss_expectations SET status='fulfilled', fulfilled_by_message_id=?, outcome='fulfilled', outcome_confidence=0.85, resolved_at=? WHERE id=?",
          [String(norm.id), now, exp.id],
        )
        out.push({ expectation: exp, outcome: 'fulfilled' })
        this.trace?.record?.('ss_expectation', { groupId, kind: 'fulfilled', expId: exp.id })
      }
    }
    // 冷落评分对到期期待在 _judgeExpiry 内完成
    return out
  }

  /** 到期判定：§11.4 反证排除 → §11.5 ignore_score 四档。产生 ignored_expectation 事件候选返回。
   *  判定顺序（修复：此前"目标无活跃→uncertain"抢在"全群沉默→naturally_expired"之前，群集体沉默大多误落 uncertain）；
   *  无 target 的群级期待以"群自身活跃度"为证据（修复：此前 null 被当"无证据"→ 永远 uncertain）。 */
  async _judgeExpiry(exp, groupId, now, ec) {
    const groupActiveAfter = await this._groupActiveAfter(groupId, exp.created_at, now)
    const hasTarget = !!exp.target_user_id
    const targetActiveAfter = hasTarget ? await this._userActiveAfter(groupId, exp.target_user_id, exp.created_at, now) : null
    const targetRepliedOthers = hasTarget ? await this._targetRepliedOthers(groupId, exp.target_user_id, exp.created_at, now) : 0

    let status = 'naturally_expired'; let outcome = 'naturally_expired'; let conf = 0.5
    const requireActivity = ec.requireTargetActivityEvidence !== false
    if (groupActiveAfter < 2) {
      status = 'naturally_expired'; outcome = 'naturally_expired'; conf = 0.6 // 全群集体沉默 → 自然结束（§11.4 首条反证）
    } else {
      // 活跃证据：有 target 看目标活跃度；群级期待看群自身活跃度
      const evidence = hasTarget ? targetActiveAfter : groupActiveAfter
      if (requireActivity && evidence === 0) {
        status = 'uncertain'; outcome = 'uncertain'; conf = 0.4 // 目标没再活动：可能没看见 → uncertain（不影响关系）
      } else {
        // §11.5 评分
        const bypass = clamp01(targetRepliedOthers >= 2 ? 0.9 : targetRepliedOthers === 1 ? 0.6 : 0.3)
        const visibility = clamp01(groupActiveAfter < 30 ? 1 : 0.6) // 刷屏淹没 → 可见性低
        const score = clamp01(Number(exp.expectation_strength) * clamp01(groupActiveAfter / 10) * (evidence ? 1 : 0.5) * bypass * visibility)
        if (score >= (ec.minIgnoredConfidence ?? 0.65)) { status = 'ignored'; outcome = 'ignored'; conf = score }
        else if (score >= 0.45) { status = 'uncertain'; outcome = 'uncertain'; conf = score }
        else { status = 'naturally_expired'; outcome = 'naturally_expired'; conf = 0.55 }
      }
    }
    await this.dao.run('UPDATE ss_expectations SET status=?, outcome=?, outcome_confidence=?, resolved_at=? WHERE id=?', [status, outcome, Math.round(conf * 100) / 100, now, exp.id])
    this.trace?.record?.('ss_expectation', { groupId, kind: outcome, expId: exp.id, conf: Math.round(conf * 100) / 100, target: exp.target_user_id })
    // 返回给 service：仅 ignored 产生明确事件（uncertain 不影响长期关系 §16.3）
    return outcome === 'ignored' ? { expectation: exp, outcome: 'ignored', confidence: conf, targetUserId: exp.target_user_id } : null
  }

  /** 扫描到期期待并判定（由 onMessage/维护调用）。返回需产生 ignored 事件的列表。 */
  async sweepExpired({ botId, groupId, now = Date.now() }) {
    const cfg = this._cfgFn(); const ec = cfg.expectations || {}
    const expired = await this.dao.all(
      "SELECT * FROM ss_expectations WHERE bot_id=? AND group_id=? AND status='pending' AND expires_at<?",
      [botId, groupId, now],
    )
    const ignoredEvents = []
    for (const exp of expired) {
      const r = await this._judgeExpiry(exp, groupId, now, ec)
      if (r) ignoredEvents.push(r)
    }
    return ignoredEvents
  }

  /** §16.3 repaired 态：道歉/修复事件后，把该成员的 ignored/uncertain 期待标记为已修复（此前从不写入）。 */
  async markRepaired({ botId, groupId, targetUserId, now = Date.now() }) {
    if (!targetUserId) return 0
    const r = await this.dao.run(
      "UPDATE ss_expectations SET status='repaired', outcome='repaired', resolved_at=? WHERE bot_id=? AND group_id=? AND target_user_id=? AND status IN ('ignored','uncertain')",
      [now, botId, groupId, String(targetUserId)],
    ).catch(() => null)
    return r?.changes || 0
  }

  /** 群节奏：近 30min 消息量→估"正常响应窗"（5~20min）。 */
  async _groupPaceMs(groupId, now) {
    try {
      const r = await this.dao.get('SELECT COUNT(*) c FROM gw_messages WHERE group_id=? AND sent_at>=?', [groupId, now - 30 * 60000])
      const perMin = (Number(r?.c) || 0) / 30
      const paceMin = perMin >= 2 ? 5 : perMin >= 0.5 ? 10 : 20
      return paceMin * 60000
    } catch { return 10 * 60000 }
  }

  /** 目标成员近期响应节奏（被回复间隔中位数，钳 1~30min）。 */
  async _targetPaceMs(groupId, userId, now) {
    try {
      const rows = await this.dao.all(
        'SELECT sent_at FROM gw_messages WHERE group_id=? AND sender_id=? AND sent_at>=? ORDER BY sent_at DESC LIMIT 20',
        [groupId, userId, now - 3 * 86400000],
      )
      if (rows.length < 2) return 0
      const gaps = []
      for (let i = 0; i < rows.length - 1; i++) gaps.push(rows[i].sent_at - rows[i + 1].sent_at)
      gaps.sort((a, b) => a - b)
      const med = gaps[Math.floor(gaps.length / 2)] || 0
      return Math.max(60000, Math.min(30 * 60000, med))
    } catch { return 0 }
  }

  async _groupActiveAfter(groupId, since, now) {
    try {
      const r = await this.dao.get('SELECT COUNT(*) c FROM gw_messages WHERE group_id=? AND sent_at>? AND sent_at<=?', [groupId, since, now])
      return Number(r?.c) || 0
    } catch { return 0 }
  }

  async _userActiveAfter(groupId, userId, since, now) {
    try {
      const r = await this.dao.get('SELECT COUNT(*) c FROM gw_messages WHERE group_id=? AND sender_id=? AND sent_at>? AND sent_at<=?', [groupId, userId, since, now])
      return Number(r?.c) || 0
    } catch { return 0 }
  }

  async _targetRepliedOthers(groupId, userId, since, now) {
    try {
      const r = await this.dao.get('SELECT COUNT(*) c FROM gw_messages WHERE group_id=? AND sender_id=? AND sent_at>? AND sent_at<=? AND reply_to_user_id IS NOT NULL', [groupId, userId, since, now])
      return Number(r?.c) || 0
    } catch { return 0 }
  }
}

export { classifyOutgoing }
