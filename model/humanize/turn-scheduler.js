/**
 * TurnScheduler —— 单群门控编排（指南 §9.1 调度顺序、§10 中断）。
 *
 * 流程：
 *   收到消息 → 写 buffer
 *     → (self/command/direct-handled 不触发，仅推进游标)
 *     → 取消旧 debounce、等 debounceMs 安静窗
 *     → 校验启用/白名单/冷却
 *     → 计算 presence + 必要性评分（含主题加成）
 *     → 未达阈值：记录、推进游标
 *     → 达阈值：acquireReplyLock → beginPlanning(代) → planner.decide
 *       → 落地前 isCurrent(gen) 校验 → applyAction(reply/react/wait/ignore)
 *
 * 中断：新外部消息到达且 phase=planning → abortPlanning + 重排 debounce；旧代结果丢弃。
 * shadow 模式：只 trace、虚拟 markSent/冷却，不真实发送。
 *
 * 服务注入：planner / replyer / composer / send（由 apps/humanize.js 装配）。
 */

import { evaluate } from './necessity-scorer.js'
import { topicMatchScore } from './behavior-policy.js'

export class TurnScheduler {
  /**
   * @param {object} opts { runtime, cfg:()=>object, planner, replyer, composer, send, now? }
   *   cfg() 返回本群已解析的人类化配置（含 shadow/threshold/talkValue/debounceMs/cooldownSeconds/
   *         presenceWindowSeconds/bypassPendingCount/contextMessages/behaviorPolicy）
   *   send: async (text:string, opts:{quoteTargetId?:string}) => sentMessageId|null
   */
  constructor({ runtime, cfg, planner, replyer, composer, send }) {
    this.runtime = runtime
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.planner = planner
    this.replyer = replyer
    this.composer = composer
    this.send = send
    runtime.bindDriver({
      onDebounced: (rt) => this._onDebounced(rt),
      onWaitDue: (rt) => this._onWaitDue(rt),
    })
  }

  cfg() { return this._cfgFn() || {} }

  /** 入口：旁听到的消息。返回 false（不阻断其他插件，由 app 层 return false）。 */
  async onMessage(msg) {
    const rt = this.runtime
    const buffer = rt.buffer
    buffer.append(msg)

    // self 消息：只入 buffer（presence/上下文），不触发、不中断自己的规划
    if (msg.isSelf) return false
    // 命令 / 已被 Direct Agent 接管：推进游标，绝不触发
    if (msg.isCommand || msg.handledByDirectAgent) {
      rt.markObserved(buffer.lastSeq)
      return false
    }

    const c = this.cfg()
    // 规划中收到新外部消息：中止旧规划，重排 debounce（用最新上下文重决策）
    if (rt.phase === 'planning') {
      rt.abortPlanning('new_message')
      rt.trace?.record('planner_interrupted', { by: msg.id })
    }
    rt.scheduleDebounce(c.debounceMs ?? 1200)
    return false
  }

  /** debounce 到期：门控 + 规划。 */
  async _onDebounced(rt) {
    const c = this.cfg()
    if (!this._enabled()) { rt.setPhase('idle'); return }

    const snapshot = rt.buffer.snapshotAfter(rt.lastProcessedSeq)
    const external = snapshot.filter((m) => m && !m.isSelf && !m.handledByDirectAgent && !m.isCommand)
    if (!external.length) { rt.setPhase('idle'); return }

    const now = Date.now()
    const hasStrongSignal = external.some((m) => m.atBot || m.quotesBot || m.mentionsBotName)

    // 硬冷却：强信号绕过（指南 §10 Cooldown→Debouncing：强关联消息绕过）
    if (rt.isCoolingDown(now) && !hasStrongSignal) {
      rt.trace?.record('cooldown_block', { remaining: Math.ceil((rt.cooldownUntil - now) / 1000) })
      rt.setPhase('cooldown')
      return
    }

    // 回复频率上限（behaviorPolicy.maxRepliesPer10Minutes）
    const maxRate = c.behaviorPolicy?.maxRepliesPer10Minutes ?? rt.maxRepliesPer10Minutes
    if (maxRate > 0 && rt.replyCountIn(10 * 60 * 1000, now) >= maxRate && !hasStrongSignal) {
      rt.trace?.record('rate_limit', { count: rt.recentReplyTs.length, max: maxRate })
      rt.setPhase('idle')
      return
    }

    // presence + 评分
    const presence = rt.buffer.presenceStats((c.presenceWindowSeconds ?? 300) * 1000)
    const policy = c.behaviorPolicy || {}
    const topicText = (external[external.length - 1] || {}).text || ''
    const topicBonus = topicMatchScore(topicText, policy.topics)

    const decision = evaluate({
      messages: external, presence, now,
      cfg: {
        threshold: c.threshold ?? 80,
        talkValue: c.talkValue ?? 0.35,
        cooldownUntil: rt.cooldownUntil,
        bypassPendingCount: c.bypassPendingCount ?? 6,
        topicBonus,
        behaviorPolicy: policy,
      },
    })
    const turnId = rt.trace?.newTurnId?.() || null
    rt.trace?.record('gate_decision', {
      turnId, batchSize: external.length, finalScore: decision.finalScore,
      threshold: decision.threshold, shouldPlan: decision.shouldPlan,
      forcedCandidate: decision.forcedCandidate, reasons: { positive: decision.positiveReasons, negative: decision.negativeReasons },
      targetMessageId: decision.targetMessage?.id || null,
    })

    if (!decision.shouldPlan) {
      rt.markObserved(external) // 推进游标，避免重复评估
      rt.setPhase('idle')
      return
    }

    // idle backoff（规划触发后、连续无动作时；强信号/批量绕过）
    if (rt.backoff.shouldDelay({ pendingCount: external.length, forcedCandidate: decision.forcedCandidate, isGroup: true, now })) {
      rt.trace?.record('backoff_delay', { remaining: rt.backoff.remainingSec(now), count: rt.backoff.count })
      rt.markObserved(external)
      rt.setPhase('idle')
      return
    }

    // 获取规划锁
    const batchId = external[external.length - 1].seq
    const holderId = rt.holderId
    const lockOk = await rt.store.acquireReplyLock(rt.groupId, batchId, holderId)
    if (!lockOk) {
      rt.trace?.record('lock_busy', { batchId })
      rt.setPhase('idle')
      return
    }

    const gen = rt.beginPlanning(batchId)
    rt.trace?.record('planner_start', { turnId, gen, batchId, batchSize: external.length, targetMessageId: decision.targetMessage?.id || null })
    try {
      const action = await this.planner.decide({
        snapshot: external, decision, signal: rt.signal, runtime: rt, cfg: c,
      })
      if (!rt.isCurrent(gen)) {
        rt.trace?.record('planner_stale', { gen, current: rt.plannerGeneration })
        return
      }
      rt.trace?.record('planner_action', { turnId, gen, action: { type: action.type, target: action.targetMessageId || null, reason: action.reason || '' } })
      await this._applyAction(action, external, decision, gen, turnId)
    } catch (e) {
      rt.trace?.record('planner_error', { turnId, gen, msg: String(e?.message || e) })
      rt.backoff.recordNoAction(now)
      rt.setPhase('idle')
    } finally {
      await rt.store.releaseReplyLock(rt.groupId, batchId, holderId)
      await rt.persist()
    }
  }

  async _applyAction(action, batch, decision, gen, turnId) {
    const rt = this.runtime
    if (!rt.isCurrent(gen)) return
    switch (action.type) {
      case 'human_reply': return this._doReply(action, batch, decision, gen, turnId)
      case 'human_react': return this._doReact(action, batch, decision, gen, turnId)
      case 'human_wait':
        rt.scheduleWait(action.seconds || 5)
        rt.backoff.recordNoAction()
        rt.markObserved(batch)
        rt.trace?.record('wait', { turnId, seconds: action.seconds, reason: action.reason })
        return
      case 'human_ignore':
      default:
        rt.backoff.recordNoAction()
        rt.markObserved(batch)
        rt.setPhase('idle')
        rt.trace?.record('ignore', { turnId, reason: action.reason })
        return
    }
  }

  async _doReply(action, batch, decision, gen, turnId) {
    const rt = this.runtime
    const c = this.cfg()
    const target = rt.buffer.get(action.targetMessageId) || decision.targetMessage
    if (!target) {
      rt.trace?.record('target_invalid', { turnId, targetMessageId: action.targetMessageId })
      rt.backoff.recordNoAction()
      rt.markObserved(batch)
      rt.setPhase('idle')
      return
    }
    // 目标已被 Direct Agent 接管 → 取消
    if (target.handledByDirectAgent) {
      rt.trace?.record('target_handled_by_direct', { turnId })
      rt.setPhase('idle')
      return
    }

    // Replyer 生成可见文本（内部含输出校验/泄漏拦截）
    let text = ''
    try {
      const res = await this.replyer.generate({ action, batch, decision, target, runtime: rt, signal: rt.signal, cfg: c })
      if (!rt.isCurrent(gen)) return
      text = (res?.text || '').trim()
    } catch (e) {
      rt.trace?.record('replyer_error', { turnId, msg: String(e?.message || e) })
      rt.backoff.recordNoAction()
      rt.setPhase('idle')
      return
    }
    if (!text) {
      rt.trace?.record('reply_empty', { turnId })
      rt.backoff.recordNoAction()
      rt.markObserved(batch)
      rt.setPhase('idle')
      return
    }

    // 落地前再次校验：代未变 + 仍启用（热重载关停 / 新消息重规划后取消发送；防 Provider 忽略 abort 信号）
    if (!rt.isCurrent(gen) || !this._enabled()) {
      rt.trace?.record('delivery_cancelled', { turnId, reason: !rt.isCurrent(gen) ? 'stale_gen' : 'disabled' })
      rt.markObserved(batch)
      rt.setPhase('idle')
      return
    }

    // shadow 模式：只记录，不真实发送
    if (c.shadow !== false) {
      rt.trace?.record('shadow_reply', { turnId, text: text.slice(0, 200), target: action.targetMessageId, quote: !!action.quote })
      try { await rt.store.markSent(rt.groupId, action.targetMessageId) } catch { /* noop */ }
      rt.enterCooldown(c.cooldownSeconds ?? 45)
      rt.recordReply(null)
      rt.backoff.recordSuccess()
      rt.markObserved(batch)
      rt.setPhase('idle')
      return
    }

    // 真实发送（分段/延迟/引用/取消由 composer 编排，逐段校验当前代）
    rt.setPhase('sending')
    let result
    try {
      result = await this.composer.deliver({
        text, action, target, runtime: rt, send: this.send, signal: rt.signal, cfg: c,
      })
    } catch (e) {
      rt.trace?.record('composer_error', { turnId, msg: String(e?.message || e) })
      result = { sentIds: [], cancelled: true, cancelReason: String(e?.message || e) }
    }

    if (result?.sentIds?.length) {
      try { await rt.store.markSent(rt.groupId, action.targetMessageId) } catch { /* noop */ }
      rt.recordReply(result.sentIds[0])
      rt.enterCooldown(c.cooldownSeconds ?? 45)
      rt.backoff.recordSuccess()
      rt.trace?.record('delivery', { turnId, sent: true, count: result.sentIds.length, cancelled: !!result.cancelled })
    } else {
      rt.trace?.record('delivery', { turnId, sent: false, cancelReason: result?.cancelReason || 'unknown' })
    }
    rt.markObserved(batch)
    rt.setPhase('idle')
  }

  // 第一版：react 走 sticker 简单通道或等同 trace（不强制发文字）。
  async _doReact(action, batch, decision, gen, turnId) {
    const rt = this.runtime
    const c = this.cfg()
    const target = rt.buffer.get(action.targetMessageId) || decision.targetMessage
    // shadow 或无 sticker：只 trace 意图
    if (c.shadow !== false || !this.composer?.react) {
      rt.trace?.record('shadow_react', { turnId, target: action.targetMessageId, intent: action.intent })
      rt.markObserved(batch)
      rt.setPhase('idle')
      return
    }
    try {
      const sentId = await this.composer.react({ action, target, runtime: rt, send: this.send, signal: rt.signal, cfg: c })
      if (rt.isCurrent(gen) && sentId) {
        rt.recordReply(sentId)
        rt.enterCooldown((c.cooldownSeconds ?? 45) / 2) // react 冷却减半
        rt.backoff.recordSuccess()
        rt.trace?.record('delivery', { turnId, kind: 'react', sent: true })
      }
    } catch (e) {
      rt.trace?.record('react_error', { turnId, msg: String(e?.message || e) })
    }
    rt.markObserved(batch)
    rt.setPhase('idle')
  }

  /** wait 到期：重新评估（若有新消息则正常门控，否则轻量再判断）。 */
  async _onWaitDue(rt) {
    rt.setPhase('idle')
    // 若有待处理新消息，重新 debounce 评估；否则保持沉默（纯时间流逝不强制唤醒）
    const pending = rt.buffer.snapshotAfter(rt.lastProcessedSeq).filter((m) => m && !m.isSelf && !m.handledByDirectAgent && !m.isCommand)
    if (pending.length) {
      rt.trace?.record('wait_due_replan', { pending: pending.length })
      rt.scheduleDebounce(this.cfg().debounceMs ?? 1200)
    } else {
      rt.trace?.record('wait_due_idle', {})
    }
  }

  _enabled() {
    const c = this.cfg()
    return c.enable === true && Array.isArray(c.groups) && c.groups.includes(this.runtime.groupId)
  }
}
