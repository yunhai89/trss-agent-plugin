/**
 * IdleBackoff —— 连续「不采取动作」规划后的指数退避（指南 §9.3、MaiBot idle_backoff.py）。
 *
 * 公式（指南 §9.3）：第1次 no_action 不退避；第2次起 base*2^(count-startCount)，cap 封顶。
 * 默认 base=15 / cap=300 / startCount=2 → 序列 0,15,30,60,120,240,300,300…
 *
 * 累加条件：Planner 本轮以 {no_tool, wait, wait_rest/ignore} 终结（即「未发送」）。
 * 绕过条件：强关联候选(forcedCandidate) / 待处理新消息 >= bypassPendingCount / 非群聊。
 * 成功回复：清零 no_action 计数，进入普通 cooldown（由 group-runtime 单独维护 cooldownUntil）。
 *
 * 状态可序列化（count + until），用于重启后恢复（指南 §16：只存重启后仍有意义的）。
 */

export class IdleBackoff {
  /**
   * @param {object} cfg { baseSeconds?:number, capSeconds?:number, startCount?:number, bypassPendingCount?:number }
   */
  constructor(cfg = {}) {
    this.baseSeconds = Math.max(1, cfg.baseSeconds ?? 15)
    this.capSeconds = Math.max(this.baseSeconds, cfg.capSeconds ?? 300)
    this.startCount = Math.max(1, cfg.startCount ?? 2)
    this.bypassPendingCount = Math.max(1, cfg.bypassPendingCount ?? 6)
    this._count = 0
    this._until = 0 // ms 时间戳：在此之前应延迟（0=无延迟）
  }

  /** 当前 no_action 连续计数 */
  get count() { return this._count }

  /** 根据当前 count 计算退避秒数（不修改状态）。 */
  currentDelaySec() {
    if (this._count < this.startCount) return 0
    const exponent = this._count - this.startCount
    return Math.min(this.capSeconds, this.baseSeconds * (2 ** exponent))
  }

  /**
   * 记录一次「未发送」结果（no_tool/wait/ignore）。
   * @returns {number} 本次产生的延迟秒数（0=不退避）
   */
  recordNoAction(now = Date.now()) {
    this._count += 1
    const delay = this.currentDelaySec()
    this._until = delay > 0 ? now + delay * 1000 : 0
    return delay
  }

  /** 成功回复：清零计数 + 清延迟。 */
  recordSuccess() {
    this._count = 0
    this._until = 0
  }

  /** 重置（强信号/配置变更/手动）。 */
  reset() {
    this._count = 0
    this._until = 0
  }

  /**
   * 是否应延迟（阻断下一轮 Planner）。
   * @param {object} opts { pendingCount, forcedCandidate?, isGroup?, now? }
   * @returns {boolean}
   */
  shouldDelay({ pendingCount = 0, forcedCandidate = false, isGroup = true, now = Date.now() } = {}) {
    // 非群聊不退避（私聊不在本模式范围）
    if (!isGroup) return false
    // 强信号绕过
    if (forcedCandidate) { this.reset(); return false }
    // 未在退避期
    if (this._until <= now) { this._until = 0; return false }
    // 待处理新消息累积到门槛 → 绕过（一组新消息压过退避）
    if (pendingCount >= this.bypassPendingCount) return false
    return true
  }

  /** 剩余延迟秒数（0=无）。 */
  remainingSec(now = Date.now()) {
    return this._until > now ? Math.ceil((this._until - now) / 1000) : 0
  }

  /** 序列化（持久化恢复用）。 */
  snapshot() { return { count: this._count, until: this._until } }
  restore(s) {
    if (!s) return
    this._count = Math.max(0, s.count | 0)
    this._until = Number.isFinite(s.until) ? s.until : 0
  }
}
