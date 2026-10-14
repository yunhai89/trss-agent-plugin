/**
 * RuntimeScope —— 轻量资源作用域（DeepSeek Harness 优化方案 P0-4）。
 *
 * 目标：把「运行时构建时获取的资源」与「热重载/退出时的清理」绑定为可逆、可等待、幂等的生命周期，
 * 替代散落的手工关闭调用，减少旧任务/定时器/Worker/浏览器会话残留。
 *
 * 语义：
 *   - signal：作用域级 AbortController；abort 时通知所有子作用域与在途任务。
 *   - register(fn, { name, order })：登记 disposer；顺序清理（order 小先清理；缺省按登记顺序）。
 *     返回「注销句柄」，只移除自身这次登记，便于可逆注册且不误删同名新资源。
 *   - child(name)：子作用域，父 abort/close 时联动；关闭顺序=先子后父（依赖方先退出）。
 *   - close(reason)：幂等；abort → 关闭子作用域 → 按序 await 各 disposer（单个失败不影响其余）→ 解绑。
 *   - rollback()：初始化失败时按「逆序」回滚已登记资源。
 *   - stats()：可观测（disposers/children/closed）。不要求引入 Cordis。
 */

/** 进程内未关闭作用域计数（观测用） */
let _openScopes = 0

export class RuntimeScope {
  constructor({ name = 'scope', parent = null } = {}) {
    this.name = name
    this.parent = parent
    this._ctl = new AbortController()
    this._disposers = [] // { id, name, fn, order, seq, done }
    this._children = new Set()
    this._closed = false
    this._closing = null
    this._id = 0
    this._seq = 0
    _openScopes++
    if (parent && parent instanceof RuntimeScope) {
      parent._children.add(this)
      const onAbort = () => { try { this.abort(parent._ctl.signal.reason) } catch { /* noop */ } }
      if (parent._ctl.signal.aborted) this.abort(parent._ctl.signal.reason)
      else parent._ctl.signal.addEventListener('abort', onAbort, { once: true })
      this._onParentAbort = onAbort
    }
  }

  static get openCount() { return _openScopes }

  get signal() { return this._ctl.signal }
  get aborted() { return this._ctl.signal.aborted }
  get closed() { return this._closed }

  abort(reason) {
    if (!this._ctl.signal.aborted) { try { this._ctl.abort(reason) } catch { /* noop */ } }
    for (const c of [...this._children]) { try { c.abort(reason) } catch { /* noop */ } }
  }

  /** 登记一个清理函数（同步或返回 Promise）。返回注销句柄（只移除本次登记）。 */
  register(fn, { name = null, order = null } = {}) {
    const rec = {
      id: ++this._id,
      name,
      fn,
      order: order == null ? this._disposers.length : Number(order),
      seq: this._seq++,
      done: false,
    }
    if (this._closed) {
      // 已关闭：立即执行，避免登记方泄漏资源（best-effort）
      Promise.resolve().then(() => runDisposer(rec)).catch(() => { /* noop */ })
      return () => {}
    }
    this._disposers.push(rec)
    return () => {
      const i = this._disposers.indexOf(rec)
      if (i >= 0) this._disposers.splice(i, 1)
    }
  }

  child(name = 'child') { return new RuntimeScope({ name, parent: this }) }

  async close(reason = 'close') {
    if (this._closing) return this._closing
    this._closed = true
    this.abort(reason)
    const self = this
    this._closing = (async () => {
      // 1. 先关闭子作用域（依赖方先退出）
      for (const c of [...self._children]) { try { await c.close('parent_close') } catch { /* noop */ } }
      self._children.clear()
      // 2. 按 order 顺序 await 各 disposer（单个失败不影响其余）
      const list = [...self._disposers].sort((a, b) => (a.order - b.order) || (a.seq - b.seq))
      let disposed = 0
      let failed = 0
      for (const rec of list) {
        try { await runDisposer(rec); disposed++ } catch { failed++ }
      }
      self._disposers = []
      // 3. 解绑父作用域
      if (self.parent instanceof RuntimeScope) {
        self.parent._children.delete(self)
        if (self._onParentAbort) { try { self.parent._ctl.signal.removeEventListener('abort', self._onParentAbort) } catch { /* noop */ } }
      }
      _openScopes = Math.max(0, _openScopes - 1)
      return { name: self.name, reason, disposed, failed, children: 0 }
    })()
    return this._closing
  }

  /** 初始化失败回滚：按逆序执行已登记 disposer（幂等：已执行的不重复）。 */
  async rollback() {
    const list = [...this._disposers].sort((a, b) => (b.order - a.order) || (b.seq - a.seq))
    for (const rec of list) { try { await runDisposer(rec) } catch { /* noop */ } }
  }

  stats() {
    return {
      name: this.name,
      closed: this._closed,
      aborted: this.aborted,
      disposers: this._disposers.length,
      children: this._children.size,
    }
  }
}

async function runDisposer(rec) {
  if (rec.done) return
  rec.done = true
  if (typeof rec.fn === 'function') return await rec.fn()
}
