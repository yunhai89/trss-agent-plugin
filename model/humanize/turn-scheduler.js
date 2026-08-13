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
import Log, { ANSI } from '../../utils/Log.js'
import { topicMatchScore, hitsAvoidTopic } from './behavior-policy.js'

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
    if (!this._enabled()) {  rt.setPhase('idle'); return }

    let snapshot, external, ctxWindow, decision
    try {
      snapshot = rt.buffer.snapshotAfter(rt.lastProcessedSeq)
      // 防 cursor > buffer（重启后 buffer 清空但 cursor 从持久化恢复 → 所有消息被当"已处理"跳过）
      if (!snapshot.length && rt.buffer.size > 0 && rt.lastProcessedSeq > 0) {
        rt.lastProcessedSeq = 0
        snapshot = rt.buffer.snapshotAfter(0)
      }
      external = snapshot.filter((m) => m && !m.isSelf && !m.handledByDirectAgent && !m.isCommand)
      // 对话上下文窗口：rolling 最近 N 条（**含 bot 自己的话**），仅去掉命令/已被直答接管的消息。
      // 含 isSelf 是关键——让 Planner/Replyer/打分器都能看清"谁在回复谁、是否接着 bot 的话说"，
      // 否则 LLM 只看到一批孤立新消息，分不清对话关系、上下文断裂（曾用 external 切片导致此问题）。
      ctxWindow = rt.buffer.snapshot(c.contextMessages ?? 30)
        .filter((m) => m && !m.isCommand && !m.handledByDirectAgent)
    } catch (e) { Log.warn('[humanize] snapshot 异常', e?.message || e); rt.setPhase('idle'); return }
    if (!external.length) {  return }

    const now = Date.now()
    const hasStrongSignal = external.some((m) => m.atBot || m.quotesBot || m.mentionsBotName)

    // 硬冷却：强信号绕过
    if (rt.isCoolingDown(now) && !hasStrongSignal) {
      Log.info('[humanize] debounce 跳过：冷却中 剩余' + Math.ceil((rt.cooldownUntil - now) / 1000) + 's')
      rt.setPhase('cooldown'); return
    }

    // 回复频率上限
    const maxRate = c.behaviorPolicy?.maxRepliesPer10Minutes ?? rt.maxRepliesPer10Minutes
    if (maxRate > 0 && rt.replyCountIn(10 * 60 * 1000, now) >= maxRate && !hasStrongSignal) {
      Log.info('[humanize] debounce 跳过：频率上限 ' + rt.replyCountIn(10 * 60 * 1000, now) + '/' + maxRate)
      rt.setPhase('idle'); return
    }


    // presence + 评分
    const presence = rt.buffer.presenceStats((c.presenceWindowSeconds ?? 300) * 1000)
    const policy = c.behaviorPolicy || {}
    const topicText = (external[external.length - 1] || {}).text || ''
    const topicBonus = topicMatchScore(topicText, policy.topics)
    // avoidTopics 回避主题：命中则给负分（避免在不该参与的话题上插话）
    const avoidHit = Array.isArray(policy.avoidTopics) && policy.avoidTopics.length > 0 && hitsAvoidTopic(topicText, policy.avoidTopics)
    const avoidPenalty = avoidHit ? 25 : 0

    try {
      decision = evaluate({
      messages: ctxWindow,          // 完整 rolling window（含 self）→ isFollowupToBot(+55) 可触发
      candidates: external,         // 目标只从本批新消息里选
      pendingCount: external.length, // 压力分按本批条数，不按窗口长度（避免恒满）
      presence, now,
      cfg: {
        threshold: c.threshold ?? 80,
        talkValue: c.talkValue ?? 0.35,
        cooldownUntil: rt.cooldownUntil,
        bypassPendingCount: c.bypassPendingCount ?? 6,
        topicBonus,
        avoidPenalty,
        behaviorPolicy: policy,
      },
    })
    } catch (e) { Log.warn('[humanize] 评分异常', e?.message || e); rt.setPhase('idle'); return }
    // 主动型群友（interruptHumanConversation=true）：环境对话（非 @/引用/提及/追问）未达阈值时，
    // 按 initiative 概率给一次"插话机会"→ 强制进 Planner，由 LLM 判断该不该插（多数会沉默）。
    // 成本/防刷复用现有冷却+频率上限+退避+presence；initiative 概率把 Planner 调用压到 ~initiative 比例。
    if (!decision.shouldPlan
        && policy.interruptHumanConversation === true
        && (decision.components?.relevance ?? 0) < 55
        && Math.random() < (Number(policy.initiative) || 0)) {
      // forcedCandidate 必须 falsy：idle-backoff.shouldDelay 对真值 forcedCandidate 会 reset 退避并放行，
      // 用 'ambient'（真值）会击穿退避 → 主动模式退避永不 escalate。这里 false 让 ambient 正常受退避约束。
      decision = {
        ...decision, shouldPlan: true, forcedCandidate: false, isAmbient: true,
        positiveReasons: [...(decision.positiveReasons || []), 'ambient_chance'],
      }
    }
    const turnId = rt.trace?.newTurnId?.() || null
    rt.trace?.record('gate_decision', {
      turnId, batchSize: external.length, finalScore: decision.finalScore,
      threshold: decision.threshold, shouldPlan: decision.shouldPlan,
      forcedCandidate: decision.forcedCandidate, reasons: { positive: decision.positiveReasons, negative: decision.negativeReasons },
      targetMessageId: decision.targetMessage?.id || null,
    })
    Log.mark('[humanize] 门控', `群${rt.groupId} 批${external.length}条 分${decision.finalScore}/${decision.threshold}`, `+${(decision.positiveReasons || []).join('/') || '0'}`, `-${(decision.negativeReasons || []).join('/') || '0'}`, decision.shouldPlan ? `${ANSI.c}→ 进Planner${ANSI.R}` : `${ANSI.gry}→ 跳过(沉默)${ANSI.R}`)

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
        snapshot: ctxWindow, decision, signal: rt.signal, runtime: rt, cfg: c,
      })
      if (!rt.isCurrent(gen)) {
        rt.trace?.record('planner_stale', { gen, current: rt.plannerGeneration })
        return
      }
      rt.trace?.record('planner_action', { turnId, gen, action: { type: action.type, target: action.targetMessageId || null, reason: action.reason || '' } })
      // 把 ctxWindow（含 self + 近期上下文）作为 batch 透传给 Replyer；
      // markObserved 取其末尾 seq 前移游标（命令类已在 onMessage 即时标记，无副作用）。
      await this._applyAction(action, ctxWindow, decision, gen, turnId)
    } catch (e) {
      rt.trace?.record('planner_error', { turnId, gen, msg: String(e?.message || e) })
      rt.backoff.recordNoAction(now)
      rt.setPhase('idle')
    } finally {
      await rt.store.releaseReplyLock(rt.groupId, batchId, holderId)
      await rt.persist()
    }
  }

  /**
   * 把 bot 自己刚发的回复主动入 buffer（isSelf:true）——解锁 presencePenalty / quotesBot /
   * isFollowupToBot / getRecentBotText 四个信号，不再依赖平台 report-self-message 回抛。
   * 用 sentId 作 id：report-self-message 开启时平台回抛同 id 会被 buffer 去重，不会重复。
   */
  _appendSelf(text, sentId) {
    const rt = this.runtime
    const c = this.cfg()
    try {
      rt.buffer.append({
        id: String(sentId || `self_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
        groupId: rt.groupId,
        userId: c.botId || 'self',
        displayName: c.personaName || '我',
        text: String(text || ''),
        timestamp: Date.now(),
        segments: [], media: [],
        isSelf: true, isCommand: false, handledByDirectAgent: false,
        atBot: false, mentionsBotName: false, quotesBot: false, replyToId: null,
      })
    } catch { /* noop */ }
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
      Log.info('[humanize] Replyer 开始生成回复', `${ANSI.c}群${rt.groupId}${ANSI.R}`)
      const res = await this.replyer.generate({ action, batch, decision, target, runtime: rt, signal: rt.signal, cfg: c })
      if (!rt.isCurrent(gen)) { Log.info('[humanize] Replyer 完成但代已过期，取消'); return }
      text = (res?.text || '').trim()
      Log.mark('[humanize] Replyer 完成', `${ANSI.g}len=${text.length}${ANSI.R}`, res?.cancelReason ? `${ANSI.y}取消:${res.cancelReason}${ANSI.R}` : `${ANSI.g}"${text.slice(0, 60)}"${ANSI.R}`)
    } catch (e) {
      Log.warn('[humanize] Replyer 失败', e?.message || e)
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
      Log.mark('[humanize] shadow 回复', `${ANSI.m}群${rt.groupId}${ANSI.R}`, `${ANSI.m}"${text.slice(0, 80)}"${ANSI.R}`)
      rt.trace?.record('shadow_reply', { turnId, text: text.slice(0, 200), target: action.targetMessageId, quote: !!action.quote })
      try { await rt.store.markSent(rt.groupId, action.targetMessageId) } catch { /* noop */ }
      rt.enterCooldown(c.cooldownSeconds ?? 45)
      rt.recordReply(null)
      this._appendSelf(text, null) // shadow 也计入自身在场（presence/上下文）
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
      this._appendSelf(text, result.sentIds[0]) // 自身发言入 buffer（解锁 presence/引用/追问信号）
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
        this._appendSelf(action.intent ? `[表情:${action.intent}]` : '[表情]', sentId)
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
    // 若已在规划/发送，wait 的"稍后再看"已无意义，别踩 phase（防孤儿定时器用过期上下文发言）
    if (rt.phase === 'planning' || rt.phase === 'sending') return
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
