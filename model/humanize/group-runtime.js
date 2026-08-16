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
  constructor({ groupId, buffer, store, backoff, trace, holderId, presenceWindowMs = 5 * 60 * 1000, cooldownSeconds = 45, maxRepliesPer10Minutes = 4, seqFloor = null } = {}) {
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
    this.seqFloor = seqFloor // { get(groupId):Promise<number>, set(groupId,n):Promise } —— 持久单调 seq 地板（sqlite 锚）

    // 状态机
    this.phase = 'idle' // idle|debouncing|planning|waiting|sending|cooldown
    this.lastProcessedSeq = 0
    this.cooldownUntil = 0
    this.plannerGeneration = 0
    this.abortController = null
    this.activeTargetMessageId = null

    // 最近回复时间戳（频率上限）
    this.recentReplyTs = []

    // 人际轮次控制（进程内）：按用户隔离，避免一个人耗尽豁免后误伤同群其他人。
    this._strongReplyByUser = new Map()
    this._postCorrectionByUser = new Map()

    // 本轮检索并注入 prompt 的记忆 id（Planner/Replyer 收集；仅真实发送成功才经 onDelivered 登记使用）
    this.turnMemoryIds = new Set()

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

  /** 进入冷却（成功回复后）。显式 0 = 不冷却（Number.isFinite 判定，不再用 || 兜底吞掉合法 0）。 */
  enterCooldown(seconds, now = Date.now()) {
    const sec = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : this.cooldownSeconds
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

  /**
   * 中止当前规划（新消息到达 / 配置变更 / 取消时）。
   * 关键：除 abort 信号外，**必须 bump generation**——部分 Provider 可能忽略 AbortSignal，
   * 单调代是真正的兜底（指南 §10）。bump 后，任何旧代异步结果 isCurrent() 必为 false，只写 trace、不发送。
   */
  abortPlanning(reason = 'new_message') {
    if (this.abortController) {
      try { this.abortController.abort(new Error(reason)) } catch { /* noop */ }
    }
    // 即使 Provider 忽略 abort 信号，代已变化 → 旧结果落地时 isCurrent 检查会丢弃
    this.plannerGeneration += 1
  }

  // ─────────────── debounce 定时器 ───────────────

  /**
   * 安排一次 debounce 回调（新消息到达时重置）。
   * @param {number} ms
   */
  scheduleDebounce(ms) {
    this.cancelDebounce()
    this.cancelWait() // 新消息到达 → 取消悬空的 wait 定时器（否则它 later 会踩塌 planning 相位，用过期上下文发言）
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
    // 钳位与 action-tools 的 human_wait 校验一致（3-120 秒）。
    // 旧写法 Math.max(1000, Math.min(120, s)) * 1000 在秒级取 max(1000,·)，恒为 1000 秒——
    // 任何 wait 实际都等约 17 分钟（Planner 决策的 seconds 完全失效）。
    const t = setTimeout(() => {
      this._waitTimer = null
      try { this._driver?.onWaitDue(this) } catch (e) { this.trace?.record('error', { where: 'onWaitDue', msg: String(e?.message || e) }) }
    }, Math.max(3, Math.min(120, seconds | 0)) * 1000)
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

  /** 近 windowMs 内对该用户的强信号回复次数。过期自动清理。 */
  strongReplyCount(userId, now = Date.now(), windowMs = 10 * 60 * 1000) {
    const key = String(userId || '')
    if (!key) return 0
    const state = this._strongReplyByUser.get(key)
    if (!state) return 0
    if (now - Number(state.lastAt || 0) > windowMs) {
      this._strongReplyByUser.delete(key)
      return 0
    }
    return Math.max(0, Number(state.count) || 0)
  }

  /** 成功回复一条强信号消息；shadow 与真实发送均调用。 */
  recordStrongReply(userId, now = Date.now()) {
    const key = String(userId || '')
    if (!key) return 0
    const count = this.strongReplyCount(key, now) + 1
    this._strongReplyByUser.set(key, { count, lastAt: now })
    return count
  }

  /** 当前纠错消息允许处理一次，随后只暂停同一发送者，不静音整个群。 */
  markReferenceCorrection(userId, messageId, until) {
    const key = String(userId || '')
    if (!key) return
    this._postCorrectionByUser.set(key, {
      allowMessageId: messageId != null ? String(messageId) : null,
      until: Number(until) || Date.now(),
    })
  }

  referenceCorrectionFor(userId, now = Date.now()) {
    const key = String(userId || '')
    if (!key) return null
    const state = this._postCorrectionByUser.get(key)
    if (!state) return null
    if (Number(state.until || 0) <= now) {
      this._postCorrectionByUser.delete(key)
      return null
    }
    return state
  }

  // ─────────────── 观察游标（标记已处理，防重复评估） ───────────────

  /** 把批次标记为已观察（lastProcessedSeq 前移到 batch 末尾）。 */
  /**
   * 标记批次已处理，推进游标——**连续 ACK 水位**语义：
   * 只推进到「区间内所有需评估消息都已处理」的最大 seq；命令/Direct/self 消息无需评估，
   * 可被越过；未评估的普通消息挡住水位（命令消息到达不得把更早待评估消息一并吞掉）。
   */
  markObserved(batch) {
    const items = (Array.isArray(batch) ? batch : [batch]).filter(Boolean)
    const batchIds = new Set(items.map((m) => String(m.id || '')))
    // seq 可能不在传入对象上（append 不回写原对象）——按 id 从 buffer 回查
    const seqOf = (m) => {
      const own = Number(m?.seq)
      if (Number.isFinite(own)) return own
      const inBuf = m?.id != null ? this.buffer.get(m.id) : null
      return Number(inBuf?.seq)
    }
    const seqs = items.map(seqOf).filter(Number.isFinite)
    if (!seqs.length && !Number.isFinite(batch)) return
    const maxSeq = seqs.length ? Math.max(...seqs) : Number(batch)
    if (!(maxSeq > this.lastProcessedSeq)) return
    let wm = this.lastProcessedSeq
    for (const m of this.buffer.snapshotAfter(this.lastProcessedSeq)) {
      // 无需评估的消息（self/命令/Direct 接管）可直接越过；需评估的未入批普通消息挡住水位。
      // 不设 maxSeq 上界：处理 A 后，其后紧邻的命令 B 应被越过（B 不需要评估）。
      const needsEval = !m.isSelf && !m.isCommand && !m.handledByDirectAgent
      if (needsEval && !batchIds.has(String(m.id))) break
      wm = m.seq
    }
    this.lastProcessedSeq = wm
  }

  // ─────────────── 取消所有 / 清场 ───────────────

  /** 取消所有进行中的规划与未发送分段（配置变更/热重载/失锁）。 */
  cancelAll(reason = 'cancel_all') {
    this.cancelDebounce()
    this.cancelWait()
    this.abortPlanning(reason)
    this.phase = 'idle'
  }

  /** 持久化轻状态 + 消息缓冲尾部（重启后恢复游标/冷却/近期上下文；不恢复进行中的 Planner）。 */
  async persist() {
    try {
      // 缓冲尾部：近期消息（含 bot 自身发言）随状态一起存——重启后 Planner/Replyer 不至于面对空上下文。
      // 条数取 bufferCapacity 与 100 的较大值，且天然受 TTL 约束（adopt/append 时淘汰过期）。
      const tail = this.buffer?.snapshot(Math.max(this.buffer?.capacity || 0, 100), { includeSelf: true }) || []
      await this.store?.setState?.(this.groupId, {
        lastProcessedSeq: this.lastProcessedSeq,
        cooldownUntil: this.cooldownUntil,
        backoff: this.backoff?.snapshot?.(),
        bufferTail: tail.map(({ seq, id, groupId, userId, displayName, timestamp, text, segments, replyToId, replySource, atBot, mentionsBotName, quotesBot, isCommand, isSelf, handledByDirectAgent, media }) => ({ seq, id, groupId, userId, displayName, timestamp, text, segments, replyToId, replySource, atBot, mentionsBotName, quotesBot, isCommand, isSelf, handledByDirectAgent, media })),
        phase: 'idle', // 重启后一律从 idle 开始（不恢复 planning）
      })
      await this.persistSeqFloor() // seq 地板随去抖持久化一并落 sqlite（崩窗 ≤2.5s 的序号空洞无害——单调即可）
    } catch { /* noop */ }
  }

  /** 去抖持久化（消息路由路径高频调用，2.5s 尾沿合并写盘）。 */
  schedulePersist() {
    if (this._persistTimer) return
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null
      this.persist().catch(() => {})
    }, 2500)
    if (this._persistTimer.unref) this._persistTimer.unref()
  }

  /** 持久化 seq 地板（跨重启单调）。KV 状态可能丢失（无 redis 时），地板锚在 sqlite 才可靠。 */
  async persistSeqFloor() {
    try {
      const n = Number(this.buffer?.lastSeq)
      if (Number.isFinite(n) && n > 0) await this.seqFloor?.set?.(this.groupId, n)
    } catch { /* noop */ }
  }

  /** 从持久化恢复轻状态 + 近期消息缓冲。 */
  async restore() {
    try {
      const s = await this.store?.getState?.(this.groupId)
      if (s) {
        if (Number.isFinite(s.lastProcessedSeq)) this.lastProcessedSeq = s.lastProcessedSeq
        if (Number.isFinite(s.cooldownUntil)) this.cooldownUntil = s.cooldownUntil
        this.backoff?.restore?.(s.backoff)
        // 恢复消息尾部（TTL 外的会被 adopt 过滤；游标若仍超出缓冲则归零，防"全跳过"——坑#4 同型防线）
        if (Array.isArray(s.bufferTail) && s.bufferTail.length) {
          const n = this.buffer?.adopt(s.bufferTail) || 0
          if (Number.isFinite(this.lastProcessedSeq) && this.lastProcessedSeq > (this.buffer?.lastSeq || 0)) {
            this.lastProcessedSeq = 0
          }
          if (n) this.trace?.record?.('buffer_restore', { groupId: this.groupId, restored: n })
        }
      }
      // seq 地板（持久单调）：缓冲全部过期时 adopt 无从续号，用持久化 floor 保证 seq 跨重启不回退，
      // 否则 hm 库的 consolidated_seq 高水位会长期压制新序列的整合（项4根因）。
      const floor = await this.seqFloor?.get?.(this.groupId).catch(() => null)
      if (Number.isFinite(floor) && floor > 0) this.buffer?.raiseSeqFloor?.(Number(floor))
    } catch { /* noop */ }
  }

  /** 恢复一次性保证（memoize）：首条消息 append 前完成恢复，
   *  杜绝"先 append → restore 完成后 adopt 整体重建缓冲 → 首条消息被清掉"的竞态。 */
  restored() {
    this._restoredPromise ||= this.restore().catch(() => {})
    return this._restoredPromise
  }
}
