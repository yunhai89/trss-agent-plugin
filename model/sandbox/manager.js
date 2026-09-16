/**
 * 沙箱生命周期管理：会话绑定 + 闲置回收 + 全局并发上限 + 并发创建去重（singleflight）。
 *
 * 关键不变量：
 *   - acquire 只做「拿一个可用沙箱」，**绝不在失败时降级到本地执行**（fail-closed 的第一道闸）。
 *   - 名额记账在整个创建期都占用（`_active` = 租约数 + 在飞行创建数），创建失败必须归还，
 *     否则一次失败会把并发额度永久吃掉。
 *   - 定时器只有一个（全局 sweeper）且 `unref()`：热重载/shutdown 后不留悬挂定时器。
 *   - `now` 可注入，闲置回收可离线确定性测试（不 sleep）。
 */
import { SandboxError, classify } from './errors.js'

const DEFAULTS = {
  template: 'base',
  idleMs: 300000,
  sandboxTtlMs: 600000,
  maxSandboxes: 4,
  concurrencyWaitMs: 15000,
  sweepIntervalMs: 30000,
}

export class SandboxManager {
  constructor({
    transport,
    template = DEFAULTS.template,
    idleMs = DEFAULTS.idleMs,
    sandboxTtlMs = DEFAULTS.sandboxTtlMs,
    maxSandboxes = DEFAULTS.maxSandboxes,
    concurrencyWaitMs = DEFAULTS.concurrencyWaitMs,
    sweepIntervalMs = DEFAULTS.sweepIntervalMs,
    network = null,
    allowInternetAccess = false,
    envs = null,
    now = Date.now,
    logger = null,
  } = {}) {
    if (!transport) throw new SandboxError('unconfigured', 'SandboxManager 需要 transport')
    this.transport = transport
    this.template = template
    this.idleMs = Math.max(1000, Number(idleMs) || DEFAULTS.idleMs)
    this.sandboxTtlMs = Math.max(10000, Number(sandboxTtlMs) || DEFAULTS.sandboxTtlMs)
    this.maxSandboxes = Math.max(1, Number(maxSandboxes) || DEFAULTS.maxSandboxes)
    this.concurrencyWaitMs = Math.max(0, Number(concurrencyWaitMs) || 0)
    this.network = network
    this.allowInternetAccess = !!allowInternetAccess
    this.envs = envs || null
    this._now = typeof now === 'function' ? now : Date.now
    this._log = logger

    this._leases = new Map() // key -> { handle, lastUsed, lastRenew, purpose }
    this._creating = new Map() // key -> Promise<handle>（singleflight）
    this._waiters = [] // [{ resolve, reject, timer }]
    this._active = 0 // 租约 + 在飞行创建（并发额度占用）
    this._closed = false
    this._timer = setInterval(() => { this._sweep().catch(() => {}) }, Math.max(1000, Number(sweepIntervalMs) || DEFAULTS.sweepIntervalMs))
    this._timer.unref?.()
  }

  _warn(msg) { try { this._log?.warn?.(msg) } catch { /* noop */ } }
  _info(msg) { try { this._log?.info?.(msg) } catch { /* noop */ } }

  /** 当前占用（租约 + 在飞行创建） */
  get pending() { return this._active }

  stats() {
    return { leases: this._leases.size, creating: this._creating.size, active: this._active, waiters: this._waiters.length, closed: this._closed }
  }

  /** 命中则返回 { id, lastUsed, purpose }，不触发创建 */
  peek(key) {
    const lease = this._leases.get(String(key))
    return lease ? { id: lease.handle.id, lastUsed: lease.lastUsed, purpose: lease.purpose } : null
  }

  /**
   * 取一个绑定到 key 的沙箱（命中复用 / 未命中创建）。
   * @throws {SandboxError} quota=并发满等待超时；unconfigured/…=创建失败（一律 fail-closed）
   */
  async acquire(key, { metadata = {}, purpose = 'shell' } = {}) {
    const k = String(key)
    if (this._closed) throw new SandboxError('killed', '沙箱管理器已关闭（配置已热加载或插件正在退出）')
    const lease = this._leases.get(k)
    if (lease) {
      lease.lastUsed = this._now()
      await this._renewIfStale(lease)
      return lease.handle
    }
    const inflight = this._creating.get(k)
    if (inflight) return inflight // 并发同键：共享同一次创建
    const p = this._create(k, metadata, purpose)
    this._creating.set(k, p)
    try {
      return await p
    } finally {
      this._creating.delete(k)
    }
  }

  async _create(k, metadata, purpose) {
    await this._acquireSlot()
    try {
      const handle = await this.transport.create({
        template: this.template,
        timeoutMs: this.sandboxTtlMs,
        metadata: { ...metadata, key: k, purpose },
        envs: this.envs || {},
        network: this.network,
        allowInternetAccess: this.allowInternetAccess,
      })
      const t = this._now()
      this._leases.set(k, { handle, lastUsed: t, lastRenew: t, purpose })
      this._info(`[sandbox] 已创建沙箱 ${handle.id}（key=${k} · ${purpose} · 占用 ${this._active}/${this.maxSandboxes}）`)
      return handle
    } catch (e) {
      this._releaseSlot() // 创建失败必须归还名额，否则并发额度被永久吃掉
      throw this._wrap(e, '创建沙箱失败')
    }
  }

  /** 手动销毁某键（含 kill；失败只告警） */
  async destroy(key) {
    const k = String(key)
    const lease = this._leases.get(k)
    if (!lease) return false
    this._leases.delete(k)
    try { await this.transport.kill(lease.handle) } catch (e) { this._warn(`[sandbox] 销毁 ${lease.handle.id} 失败：${e?.message || e}`) }
    this._releaseSlot()
    return true
  }

  /** 只丢弃租约不 kill（沙箱已不存在时用，避免对已回收 id 再发 kill） */
  drop(key) {
    const k = String(key)
    const lease = this._leases.get(k)
    if (!lease) return false
    this._leases.delete(k)
    this._releaseSlot()
    return true
  }

  /** 闲置回收（公开给测试：不依赖定时器） */
  async _sweep() {
    if (this._closed) return 0
    const now = this._now()
    let n = 0
    for (const [k, lease] of [...this._leases.entries()]) {
      if (now - lease.lastUsed > this.idleMs) {
        if (await this.destroy(k)) n++
      }
    }
    if (n) this._info(`[sandbox] 闲置回收 ${n} 个沙箱（idleMs=${this.idleMs}）`)
    return n
  }

  /** 关闭：停 sweeper + 清空租约 + 拒绝在等调用方（热重载/退出用） */
  async shutdown() {
    this._closed = true
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    for (const w of this._waiters.splice(0)) {
      clearTimeout(w.timer)
      w.reject(new SandboxError('killed', '沙箱管理器已关闭'))
    }
    const keys = [...this._leases.keys()]
    await Promise.all(keys.map((k) => this.destroy(k).catch(() => false)))
    return keys.length
  }

  async _renewIfStale(lease) {
    if (this._now() - lease.lastRenew < this.sandboxTtlMs / 2) return
    try {
      await this.transport.setTimeout(lease.handle, this.sandboxTtlMs)
      lease.lastRenew = this._now()
    } catch (e) {
      // 续期失败不阻断本次调用：沙箱可能刚好到期，后续命令失败会触发 §"只重建一次"
      this._warn(`[sandbox] 续期 ${lease.handle.id} 失败：${e?.message || e}`)
    }
  }

  _acquireSlot() {
    if (this._active < this.maxSandboxes) {
      this._active++
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null }
      const ms = this.concurrencyWaitMs
      // 注意：等待名额的定时器**不能 unref** —— 它是"在飞行操作"的超时，
      // unref 后事件循环一空就不会触发，等待者会永久悬挂（实测踩到）。只有 sweeper 才 unref。
      w.timer = setTimeout(() => {
        const i = this._waiters.indexOf(w)
        if (i >= 0) this._waiters.splice(i, 1)
        reject(new SandboxError('quota', `沙箱并发已满（maxSandboxes=${this.maxSandboxes}），等待 ${ms}ms 未获得名额`, { retryable: true }))
      }, ms)
      this._waiters.push(w)
    })
  }

  _releaseSlot() {
    this._active = Math.max(0, this._active - 1)
    while (this._waiters.length && this._active < this.maxSandboxes) {
      const w = this._waiters.shift()
      clearTimeout(w.timer)
      this._active++
      w.resolve()
      break // 一个名额只唤醒一个等待者
    }
  }

  /** 把任意异常折成 SandboxError（保留已分类的 kind；业务退出码不该走到这里） */
  _wrap(e, prefix) {
    if (e instanceof SandboxError) return e
    const info = classify(e) || { kind: 'unknown', retryable: false, detail: null }
    return new SandboxError(info.kind, `${prefix}：${info.detail || '未知原因'}`, { retryable: info.retryable, cause: e })
  }
}
