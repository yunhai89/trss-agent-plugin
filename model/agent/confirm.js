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

  /**
   * 递增 id（**不回绕**）。此前 `(seq+1) % 10000` + `padStart(4)`：id 复用会覆盖同 id 的
   * pending 条目——旧条目的超时定时器按 id 反查时清掉新条目的 timer 并删除其登记，
   * 使新条目的审批 Promise 永不结算（会话永久挂起）。数字递增无副作用（仅显示变长）。
   */
  _nextId() {
    this._seq += 1
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
      const entry = { resolve: null, timer: null, info: { id, tool, args, ctx, createdAt: this._now() } }
      const settle = (val) => {
        if (done) return
        done = true
        // 按**对象身份**清理（而非按 id 反查）：同 id 的其它条目绝不会被误删/误清定时器
        if (this._pending.get(id) === entry) {
          clearTimeout(entry.timer)
          this._pending.delete(id)
        }
        if (signal) { try { signal.removeEventListener('abort', onAbort) } catch { /* noop */ } }
        resolve(val)
      }
      const onAbort = () => settle(false)
      entry.resolve = settle
      entry.timer = setTimeout(() => settle(false), this.timeout)
      this._pending.set(id, entry)
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
    // 容错：id 形如 '0001'，主人手输 `#确认 1` 时补零后仍能命中（此前会静默"未找到"）
    const raw = String(id ?? '').trim()
    const p = this._pending.get(raw) || (/^\d+$/.test(raw) ? this._pending.get(raw.padStart(4, '0')) : null)
    if (!p) return false
    p.resolve(!!approved)
    return true
  }

  list() {
    // ctx 必须一并返回：面板「审批门」要显示申请人/群/事由（views/confirm.js 读 c.ctx.user 等）。
    // 曾漏返回 → 前端 `undefined.user` TypeError → 整块渲染成注释节点、审批门页面全白。
    return [...this._pending.values()].map((p) => ({
      id: p.info.id, tool: p.info.tool, args: p.info.args, createdAt: p.info.createdAt,
      // 字段名必须与 ctxOf() 的真实产出对齐（userId/groupId）：曾按 user/gid 取名 → 面板对任何真实
      // 待审都显示「申请人 未知 · 私聊」，其中「私聊」还是错的（真实来源是群消息）；
      // mock.js 的假数据恰好用 user/gid 形态，所以只跑 mock 的冒烟看不出来（2026-10-17 回归审计 medium）。
      ctx: p.info.ctx
        ? { user: p.info.ctx.userId, userId: p.info.ctx.userId, gid: p.info.ctx.groupId, reason: p.info.ctx.reason }
        : null,
    }))
  }

  get size() { return this._pending.size }

  /** 撤销全部待审（任务取消/关闭）：结算 false，避免悬挂的审批 Promise 永不返回 */
  clear() {
    for (const p of [...this._pending.values()]) p.resolve(false)
    this._pending.clear()
  }
}
