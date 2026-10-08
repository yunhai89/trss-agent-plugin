/**
 * Stagehand 会话管理 —— per-sessionKey 持久单例 + idle 超时自动关 + 同会话串行。
 *
 * 设计要点（可靠性审计）：
 *  - **身份隔离**：sessionKey 由调用方按「机器人 + 群/私聊 + 真实操作者 + 对话」拼装（见 index.js identityOf）。
 *    绝不使用可能被群共享模式折叠成 '__group__' 的 scopeUserId，避免不同机器人/群/用户共用 Cookie。
 *  - **容量预约**：并发启动前同步占位（_launching），容量 = 已启动 + 启动中 + 关闭中；
 *    同 key 并发 acquire 复用同一 in-flight Promise。
 *  - **生命周期**：closeAll 永久关闭管理器并等待在途启动；迟到初始化发现已关闭会自行清理、不注册会话。
 *    初始化任一步失败都回收已获得的 SDK 与底层浏览器资源。
 *  - **同会话串行 / 跨会话并行**：每个会话维护一条操作链；排队任务取消只跳过自身、不关浏览器、不插队。
 *  - **idle**：仅在无执行中任务时计时，从操作结束后起算；执行中的任务不被回收。
 *  - **超时/取消**：贯穿排队、取页与操作；超时/取消后拒绝迟到结果，并把该会话推入清理。
 */
import Log from '../../utils/Log.js'
import { launchBrowser, getStagehandClass } from './browser.js'
import { pickDeviceProfile, buildStealthInitScript, compileDomainPolicy, BLOCKED_HOSTS } from './guard.js'

const DEFAULT_OP_TIMEOUT_MS = 60000

function abortError(signal) {
  const e = new Error(signal?.reason?.message || '操作已取消')
  e.name = 'AbortError'
  e.errorClass = 'cancelled'
  return e
}

function raceAbort(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

/** 有界等待：资源关闭/SDK 工厂挂起时不得无界等待；超时返回 'timeout' 并告警。 */
function settleWithin(promise, ms, label) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); resolve(v) }
    const t = setTimeout(() => { Log.warn(`[stagehand] ${label} 超时（${ms}ms），不再等待（资源可能未完全释放）`); finish('timeout') }, ms)
    Promise.resolve(promise).then(() => finish('ok'), () => finish('error'))
  })
}

/** 安全调用可能同步抛错或返回 Promise 的关闭函数，吞掉异常。 */
async function closeQuietly(fn) {
  try { await fn?.() } catch { /* noop */ }
}

export class SessionManager {
  /**
   * @param {object} opt
   *   cfg: agent.stagehand 配置
   *   buildModel: ()=>modelConfig|undefined（传给 Stagehand.create 的 model 配置）
   *   launcher: 可选注入（测试用），签名 (cfg)=>Promise<{browser, close, stagehand, context?}>
   *   installPolicy: 可选注入（测试用），签名 (context, cfg)=>Promise<void>；缺省用 compileDomainPolicy + context.setDomainPolicy
   */
  constructor({ cfg = {}, buildModel, launcher, installPolicy, opTimeoutMs } = {}) {
    this._cfg = cfg
    this._buildModel = typeof buildModel === 'function' ? buildModel : () => undefined
    this._launcher = launcher || null
    this._installPolicy = installPolicy || null
    this._sessions = new Map() // key -> entry
    this._inflight = new Map() // key -> Promise<entry>
    this._launching = new Set() // key（已预约、启动中）
    this._closing = new Set() // key（关闭中）
    this._closed = false
    this._closeAllPromise = null
    this.maxSessions = Math.max(1, Number(cfg.maxSessions) || 3)
    this.opTimeoutMs = Math.max(20, Number(opTimeoutMs || cfg.opTimeoutMs) || DEFAULT_OP_TIMEOUT_MS)
    this.closeTimeoutMs = Math.max(1000, Number(cfg.closeTimeoutMs) || 15000)
  }

  get closed() { return this._closed }
  /** 容量占用：已启动 + 启动中 + 关闭中 */
  get capacityUsed() { return this._sessions.size + this._launching.size + this._closing.size }

  /** 当前会话正在执行操作的操作级 signal（供 LLM generate 回调贯穿取消）；无则 null。 */
  signalOf(key) {
    const entry = this._sessions.get(key)
    return entry?.currentSignal || null
  }

  /** 启动或复用会话，返回 entry（{stagehand, browser, context, page, ...}）。 */
  async acquire(key, { signal } = {}) {
    if (this._closed) { const e = new Error('浏览器管理器已关闭'); e.code = 'manager_closed'; throw e }
    const existing = this._sessions.get(key)
    if (existing) { this._touch(key); return existing }
    if (this._inflight.has(key)) return this._inflight.get(key)
    if (this.capacityUsed >= this.maxSessions) {
      const err = new Error(`浏览器会话已达上限（${this.maxSessions}），请稍后再试`)
      err.code = 'max_sessions'
      throw err
    }
    this._launching.add(key) // 同步预约，防并发超卖
    const p = this._launch(key, signal).finally(() => { this._inflight.delete(key) })
    this._inflight.set(key, p)
    return p
  }

  /** 返回已存在会话（touch），无则 null（不启动）。 */
  get(key) {
    const entry = this._sessions.get(key)
    if (!entry) return null
    this._touch(key)
    return entry
  }

  /**
   * 在同一会话上串行执行 fn；不同会话并行。返回 fn 的结果。
   * @param {string} key
   * @param {(entry:object)=>Promise<any>} fn 入参含 { page, context, signal }（signal 为操作级超时/取消信号）
   * @param {object} [opts] { signal, timeoutMs }
   */
  run(key, fn, { signal, timeoutMs } = {}) {
    const entry = this._sessions.get(key)
    if (!entry) { const e = new Error('当前无打开的页面，请先调用 stagehand__goto'); e.code = 'no_session'; return Promise.reject(e) }
    return this._enqueue(entry, fn, { signal, timeoutMs })
  }

  _enqueue(entry, fn, { signal, timeoutMs }) {
    const prev = entry.tail
    const ms = Math.max(20, Number(timeoutMs || this.opTimeoutMs) || DEFAULT_OP_TIMEOUT_MS)
    let settle
    const result = new Promise((resolve, reject) => { settle = { resolve, reject } })
    const start = async () => {
      if (signal?.aborted) { settle.reject(abortError(signal)); return }
      if (entry.closed) { const e = new Error('会话已关闭'); e.code = 'session_closed'; settle.reject(e); return }
      entry.active++
      this._clearIdle(entry)
      const controller = new AbortController()
      entry.currentSignal = controller.signal // 供该会话内的 LLM generate 回调取用，实现取消贯穿
      let timedOut = false
      let cancelled = false
      const onAbort = () => { cancelled = true; controller.abort(signal.reason) }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => { timedOut = true; controller.abort(new Error(`操作超时（${ms}ms）`)) }, ms)
      try {
        const page = await this._activePage(entry, controller.signal)
        const r = await raceAbort(Promise.resolve(fn({ ...entry, page, signal: controller.signal })), controller.signal)
        settle.resolve(r)
      } catch (e) {
        settle.reject(e)
        if (timedOut || cancelled) {
          // 超时/取消：拒绝迟到结果，并把该会话推入清理（释放底层浏览器/SDK）
          this._close(entry.key, timedOut ? 'timeout' : 'cancel').catch(() => {})
        }
      } finally {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        entry.active--
        if (entry.currentSignal === controller.signal) entry.currentSignal = null
        if (entry.active === 0 && !entry.closed && !this._closed) this._touch(entry.key)
      }
    }
    entry.tail = prev.then(start, start)
    return result
  }

  async _activePage(entry, signal) {
    if (entry.closed) { const e = new Error('会话已关闭'); e.code = 'session_closed'; throw e }
    const ctx = entry.context
    let page = null
    try {
      if (ctx && typeof ctx.activePage === 'function') page = await raceAbort(ctx.activePage(), signal)
    } catch (e) { if (e?.name === 'AbortError') throw e }
    if (!page) {
      try {
        const pages = ctx && typeof ctx.pages === 'function' ? await raceAbort(ctx.pages(), signal) : []
        page = Array.isArray(pages) ? pages[0] : null
        if (!page && ctx && typeof ctx.newPage === 'function') page = await raceAbort(ctx.newPage(), signal)
      } catch (e) { if (e?.name === 'AbortError') throw e }
    }
    if (!page) throw new Error('当前无可用页面')
    entry.page = page
    return page
  }

  async _launch(key, signal) {
    let browser, close, stagehand, context
    try {
      if (this._launcher) {
        const injected = await this._launcher(this._cfg)
        browser = injected.browser
        close = injected.close
        stagehand = injected.stagehand
        context = injected.context || stagehand?.browser?.context || browser?.context
        // 注入路径若显式提供 context，也走同一套访问策略安装（便于测试与保持行为一致）
        if (injected.context && !injected.skipPolicy) {
          await this._installAccessPolicy(context)
          if (injected.profile) await this._installStealth(context, injected.profile)
        }
      } else {
        const Stagehand = await getStagehandClass()
        const profile = this._cfg.stealth === false ? null : pickDeviceProfile(Math.random, this._cfg)
        ;({ browser, close } = await launchBrowser(this._cfg, profile))
        const model = this._buildModel(key)
        stagehand = await Stagehand.create({
          browser,
          ...(model ? { model } : {}),
          domSettleTimeoutMs: Number(this._cfg.domSettleTimeoutMs) || 3000,
        })
        context = stagehand.browser?.context
        if (!context) throw new Error('Stagehand 启动后缺少 browser.context（SDK 版本不兼容？）')
        // 访问策略必需：独立于 stealth；失败即中止初始化并清理资源
        await this._installAccessPolicy(context)
        if (profile) await this._installStealth(context, profile)
      }
      if (this._closed || signal?.aborted) throw new Error('会话在初始化期间已关闭/取消')
      const page = await resolveFirstPage(context)
      if (!page) throw new Error('Stagehand 启动后无可用页面')
      const entry = { key, stagehand, browser, context, page, close, timer: null, active: 0, tail: Promise.resolve(), lastUsed: Date.now(), closed: false }
      this._sessions.set(key, entry)
      this._touch(key)
      Log.info(`[stagehand] 会话已启动 key=${key}`)
      return entry
    } catch (e) {
      // 初始化任一步失败：回收已经获得的 SDK 与底层浏览器（有界等待，防关闭挂起拖死启动）
      await settleWithin(closeQuietly(() => stagehand?.close?.()), this.closeTimeoutMs, `初始化失败回收 stagehand key=${key}`)
      await settleWithin(closeQuietly(() => close?.()), this.closeTimeoutMs, `初始化失败回收浏览器 key=${key}`)
      throw e
    } finally {
      this._launching.delete(key)
    }
  }

  /** 编译并安装请求级域名访问策略（必需）。 */
  async _installAccessPolicy(context) {
    if (this._installPolicy) { await this._installPolicy(context, this._cfg); return }
    const { blockedDomains, unrepresentable } = compileDomainPolicy([...BLOCKED_HOSTS, ...(Array.isArray(this._cfg.blockedHosts) ? this._cfg.blockedHosts : [])])
    if (unrepresentable.length) {
      Log.warn(`[stagehand] 以下禁访主机无法表达为 SDK 域名策略（仅入口校验兜底）：${unrepresentable.join(', ')}`)
    }
    if (!context || typeof context.setDomainPolicy !== 'function') throw new Error('SDK context 不支持 setDomainPolicy')
    await context.setDomainPolicy({ blockedDomains })
  }

  /** 真机化 init script（可选，失败仅告警）。 */
  async _installStealth(context, profile) {
    try {
      if (context && typeof context.addInitScript === 'function') await context.addInitScript(buildStealthInitScript(profile))
    } catch (e) {
      Log.warn('[stagehand] 指纹注入失败（不阻断）', e?.message || e)
    }
  }

  _clearIdle(entry) {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
  }

  _touch(key) {
    const entry = this._sessions.get(key)
    if (!entry || entry.closed || entry.active > 0) return
    entry.lastUsed = Date.now()
    this._clearIdle(entry)
    const ms = Math.max(50, Number(this._cfg.idleTimeoutMs) || 300000)
    const t = setTimeout(() => { this._close(key, 'idle').catch(() => {}) }, ms)
    if (typeof t.unref === 'function') t.unref()
    entry.timer = t
  }

  async _close(key, reason) {
    const entry = this._sessions.get(key)
    if (!entry) return
    this._sessions.delete(key)
    entry.closed = true
    this._clearIdle(entry)
    this._closing.add(key)
    await settleWithin(closeQuietly(() => entry.stagehand?.close?.()), this.closeTimeoutMs, `关闭 stagehand key=${key}`)
    await settleWithin(closeQuietly(() => entry.close?.()), this.closeTimeoutMs, `关闭浏览器 key=${key}`)
    this._closing.delete(key)
    Log.info(`[stagehand] 会话已关闭 key=${key}(${reason})`)
  }

  /** 永久关闭该管理器：等待在途启动、关闭全部会话，之后 acquire 一律拒绝。 */
  async closeAll() {
    if (this._closeAllPromise) return this._closeAllPromise
    this._closed = true
    this._closeAllPromise = (async () => {
      // 等待在途启动结算（有界：SDK 工厂永久挂起时不得无界等待）
      await settleWithin(Promise.allSettled([...this._inflight.values()]), this.closeTimeoutMs, 'closeAll 等待在途启动')
      const keys = [...this._sessions.keys()]
      await Promise.all(keys.map((k) => this._close(k, 'shutdown')))
      this._launching.clear()
    })()
    return this._closeAllPromise
  }

  /** 测试/诊断用：当前会话数。 */
  size() { return this._sessions.size }
}

/** 从 context 取首个可用 page（activePage → pages[0] → newPage）。 */
async function resolveFirstPage(context) {
  if (!context) return null
  try {
    if (typeof context.activePage === 'function') { const p = await context.activePage(); if (p) return p }
  } catch { /* fallthrough */ }
  try {
    const pages = typeof context.pages === 'function' ? await context.pages() : (context.pages || [])
    if (Array.isArray(pages) && pages[0]) return pages[0]
  } catch { /* fallthrough */ }
  try {
    if (typeof context.newPage === 'function') return await context.newPage()
  } catch { /* fallthrough */ }
  return null
}
