/**
 * GroupRuntime —— 单群运行时：状态机 / 单调代（generation）/ AbortController / 定时器（指南 §10）。
 *
 * 设计要点：
 *  - 中断不依赖 AbortSignal 唯一保证：用单调递增 plannerGeneration。每次 beginPlanning 记代，
 *    任何异步结果落地前验证 isCurrent(gen)；旧请求晚返回只写 trace、绝不发送（指南 §10）。
 *  - phase 状态机：idle→debouncing→planning→waiting→sending→cooldown（指南 §10 mermaid）。
 *  - 进程内状态（AbortController/Timer/事件对象不可序列化）；只把 lastProcessedSeq/cooldownUntil/
 *    consecutiveNoAction 等重启后仍有意义的存 KV（指南 §16）。
 *  - 不持有 Planner/Replyer/Composer（避免循环依赖）；由 TurnScheduler 注入服务并驱动。
 */

/**
 * @typedef {import('./message-buffer.js').MessageBuffer} MessageBuffer
 * @typedef {import('./store.js').HumanizeStore} HumanizeStore
 * @typedef {import('./idle-backoff.js').IdleBackoff} IdleBackoff
 * @typedef {import('./trace.js').Trace} Trace
 */

export class GroupRuntime {
  /**
   * @param {object} opts { groupId, buffer, store, backoff, trace, holderId, presenceWindowMs, cooldownSeconds }
   */
  constructor({ groupId, buffer, store, backoff, trace, holderId, presenceWindowMs = 5 * 60 * 1000, cooldownSeconds = 45, maxRepliesPer10Minutes = 4 } = {}) {
    if (!groupId) throw new Error('GroupRuntime 需要 groupId')
    this.groupId = String(groupId)
    this.buffer = buffer
    this.store = store
    this.backoff = backoff
    this.trace = trace
    this.holderId = holderId
    this.presenceWindowMs = presenceWindowMs
    this.cooldownSeconds = cooldownSeconds
    this.maxRepliesPer10Minutes = maxRepliesPer10Minutes

    // 状态机
    this.phase = 'idle' // idle|debouncing|planning|waiting|sending|cooldown
    this.lastProcessedSeq = 0
    this.cooldownUntil = 0
    this.plannerGeneration = 0
    this.abortController = null
    this.activeTargetMessageId = null

    // 最近回复时间戳（频率上限）
    this.recentReplyTs = []

    // 定时器（进程内，不序列化）
    this._debounceTimer = null
    this._waitTimer = null

    // 注入的驱动器（由 TurnScheduler.bind 设置）
    this._driver = null
  }

  /** 绑定驱动器（TurnScheduler），含 onDebounced / onWaitDue。 */
  bindDriver(driver) { this._driver = driver }

  // ─────────────── phase / 取消 ───────────────

  setPhase(p) { this.phase = p }

  /** 是否仍在冷却（强制候选可绕过——由 scheduler 判定，这里只报状态）。 */
  isCoolingDown(now = Date.now()) { return this.cooldownUntil > now }

  /** 进入冷却（成功回复后）。 */
  enterCooldown(seconds, now = Date.now()) {
    const sec = Math.max(0, Number(seconds) || this.cooldownSeconds)
    this.cooldownUntil = now + sec * 1000
    this.phase = 'cooldown'
  }

  /**
   * 开始一轮规划：自增代、新建 AbortController、记 phase。
   * @returns {number} 当代 generation
   */
  beginPlanning(batchId) {
    this.abortController?.abort(new Error('superseded'))
    this.plannerGeneration += 1
    this.abortController = new AbortController()
    this.phase = 'planning'
    this.activeBatchId = batchId ?? null
    this.activeTargetMessageId = null
    return this.plannerGeneration
  }

  /** 当代信号（传给 provider.chat 的 signal）。 */
  get signal() {
    return this.abortController?.signal || null
  }

  /** 该 generation 是否仍是当前代（异步结果落地前必验）。 */
  isCurrent(gen) { return gen === this.plannerGeneration }

  /** 中止当前规划（新消息到达时）。 */
  abortPlanning(reason = 'new_message') {
    if (this.abortController) {
      try { this.abortController.abort(new Error(reason)) } catch { /* noop */ }
    }
  }

  // ─────────────── debounce 定时器 ───────────────

  /**
   * 安排一次 debounce 回调（新消息到达时重置）。
   * @param {number} ms
   */
  scheduleDebounce(ms) {
    this.cancelDebounce()
    this.phase = this.phase === 'planning' ? this.phase : 'debouncing'
    const t = setTimeout(() => {
      this._debounceTimer = null
      try { this._driver?.onDebounced(this) } catch (e) { this.trace?.record('error', { where: 'onDebounced', msg: String(e?.message || e) }) }
    }, Math.max(0, ms | 0))
    if (t.unref) t.unref()
    this._debounceTimer = t
  }

  cancelDebounce() {
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null }
  }

  // ─────────────── wait 定时器 ───────────────

  scheduleWait(seconds) {
    this.cancelWait()
    this.phase = 'waiting'
    const t = setTimeout(() => {
      this._waitTimer = null
      try { this._driver?.onWaitDue(this) } catch (e) { this.trace?.record('error', { where: 'onWaitDue', msg: String(e?.message || e) }) }
    }, Math.max(1000, Math.min(120, seconds | 0)) * 1000)
    if (t.unref) t.unref()
    this._waitTimer = t
  }

  cancelWait() {
    if (this._waitTimer) { clearTimeout(this._waitTimer); this._waitTimer = null }
  }

  // ─────────────── 回复频率上限 ───────────────

  /** 最近 windowMs 内回复数。 */
  replyCountIn(windowMs = 10 * 60 * 1000, now = Date.now()) {
    const cutoff = now - windowMs
    this.recentReplyTs = this.recentReplyTs.filter((ts) => ts >= cutoff)
    return this.recentReplyTs.length
  }

  /** 记一次回复（频率计数 + presence 统计需要 buffer 标 self）。 */
  recordReply(messageId, now = Date.now()) {
    this.recentReplyTs.push(now)
    this.recentReplyTs = this.recentReplyTs.filter((ts) => ts >= now - 10 * 60 * 1000)
    if (messageId) this.buffer?.markSelf?.(messageId)
  }

  // ─────────────── 观察游标（标记已处理，防重复评估） ───────────────

  /** 把批次标记为已观察（lastProcessedSeq 前移到 batch 末尾）。 */
  markObserved(batch) {
    if (Array.isArray(batch) && batch.length) {
      const lastSeq = batch[batch.length - 1].seq
      if (Number.isFinite(lastSeq) && lastSeq > this.lastProcessedSeq) this.lastProcessedSeq = lastSeq
    } else if (Number.isFinite(batch)) {
      if (batch > this.lastProcessedSeq) this.lastProcessedSeq = batch
    }
  }

  // ─────────────── 取消所有 / 清场 ───────────────

  /** 取消所有进行中的规划与未发送分段（配置变更/热重载/失锁）。 */
  cancelAll(reason = 'cancel_all') {
    this.cancelDebounce()
    this.cancelWait()
    this.abortPlanning(reason)
    this.phase = 'idle'
  }

  /** 持久化轻状态（重启后恢复游标/冷却；不恢复进行中的 Planner）。 */
  async persist() {
    try {
      await this.store?.setState?.(this.groupId, {
        lastProcessedSeq: this.lastProcessedSeq,
        cooldownUntil: this.cooldownUntil,
        backoff: this.backoff?.snapshot?.(),
        phase: 'idle', // 重启后一律从 idle 开始（不恢复 planning）
      })
    } catch { /* noop */ }
  }

  /** 从持久化恢复轻状态。 */
  async restore() {
    try {
      const s = await this.store?.getState?.(this.groupId)
      if (s) {
        if (Number.isFinite(s.lastProcessedSeq)) this.lastProcessedSeq = s.lastProcessedSeq
        if (Number.isFinite(s.cooldownUntil)) this.cooldownUntil = s.cooldownUntil
        this.backoff?.restore?.(s.backoff)
      }
    } catch { /* noop */ }
  }
}
