/**
 * 审批门 confirm —— OpenClaw 式 human-in-the-loop。对应 yunhai lib/agent/confirm.js。
 *
 * policy 返回 'confirm' 时，loop 阻塞在 request() 直到 master 经 #确认/#拒绝 解除，或超时自拒。
 * 内存 pending Map、短 id（便于 QQ 输入）、一次性（每次动作都需新审批）。
 */

export class ConfirmStore {
  constructor({ timeout = 300000, now = Date.now } = {}) {
    this.timeout = timeout
    this._now = now
    this._pending = new Map()
    this._seq = 0
  }

  _nextId() {
    this._seq = (this._seq + 1) % 10000
    return String(this._seq).padStart(4, '0')
  }

  /**
   * 发起一次审批请求；返回 Promise<bool>（true=批准）。
   * @param {function} notify(id, info)  把待审请求投递给 master 的回调（失败不影响，超时兜底）
   * @param {AbortSignal} [signal]  当前任务取消信号：取消即撤销 pending 并结算 false，
   *   此后迟到的 resolve(id, true) 找不到 pending → 返回 false（迟到批准无效，不得放行副作用）
   */
  request({ tool, args, ctx, notify, signal = null } = {}) {
    return new Promise((resolve) => {
      let done = false
      const id = this._nextId()
      const settle = (val) => {
        if (done) return
        done = true
        const p = this._pending.get(id)
        if (p) {
          clearTimeout(p.timer)
          this._pending.delete(id)
        }
        if (signal) { try { signal.removeEventListener('abort', onAbort) } catch { /* noop */ } }
        resolve(val)
      }
      const onAbort = () => settle(false)
      const timer = setTimeout(() => settle(false), this.timeout)
      this._pending.set(id, { resolve: settle, timer, info: { id, tool, args, ctx, createdAt: this._now() } })
      if (signal) {
        if (signal.aborted) { settle(false); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      if (typeof notify === 'function') {
        try { notify(id, { tool, args, ctx }) } catch { /* noop */ }
      }
    })
  }

  /** master 端调用：批准/拒绝某个待审 id。pending 已因取消/超时撤销时返回 false（迟到批准无效） */
  resolve(id, approved) {
    const p = this._pending.get(String(id))
    if (!p) return false
    p.resolve(!!approved)
    return true
  }

  list() {
    return [...this._pending.values()].map((p) => ({ id: p.info.id, tool: p.info.tool, args: p.info.args, createdAt: p.info.createdAt }))
  }

  get size() { return this._pending.size }

  /** 撤销全部待审（任务取消/关闭）：结算 false，避免悬挂的审批 Promise 永不返回 */
  clear() {
    for (const p of [...this._pending.values()]) p.resolve(false)
    this._pending.clear()
  }
}
