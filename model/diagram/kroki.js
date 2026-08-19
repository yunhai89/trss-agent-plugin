/**
 * Kroki HTTP Client —— 自托管渲染服务客户端（POST JSON API）。
 *
 * 安全/可靠性边界：
 *   - endpoint 仅来自服务器配置（加载期校验 http/https、公共模式强制 https）；LLM 无参数可覆盖；
 *   - redirect:'error' 不跟随重定向（防 SSRF 跳转）；
 *   - 超时三段式：connectTimeoutMs（到响应头）→ requestTimeoutMs（全程，覆盖 body 读取）→ 组合 Agent AbortSignal；
 *     取消后停止读取、不写缓存、不发送迟到图片（cancelled 终态）；
 *   - 响应体流式字节计数（不信 Content-Length），超 maxResponseBytes 立即中断；
 *   - 错误映射：400/422→invalid_compiled_dsl、408→timeout、413→output_too_large、429/502/503/网络→可重试一次、
 *     Abort→cancelled、非法 SVG→invalid_renderer_output（上层检查）；
 *   - circuit breaker：连续失败达阈值 → open（立即失败，不等待超时）→ cooldown 后 half-open 放行一个探测 → 成功恢复 closed。
 *   - maxConcurrency 信号量；日志只记 endpointId/specHash/dslHash，不记完整 DSL/URL。
 */

import { createHash } from 'node:crypto'

const sha16 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16)

/** 公共 Kroki 域名黑名单（默认禁用；allowPublicEndpoint 也不允许静默回退公共服务） */
const PUBLIC_KROKI_HOSTS = ['kroki.io', 'demo.kroki.io', 'www.kroki.io']

/**
 * 校验/规范化 endpoint 配置。
 * @returns {{ok:true, url, origin, endpointId, isPublic}|{ok:false, reason}}
 */
export function validateEndpoint(rawUrl, { allowPublicEndpoint = false } = {}) {
  let u
  try { u = new URL(String(rawUrl || '')) } catch { return { ok: false, reason: 'endpoint 不是合法 URL' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `endpoint 协议不允许（${u.protocol}），仅 http/https` }
  if (u.username || u.password) return { ok: false, reason: 'endpoint 不允许携带认证信息' }
  const host = u.hostname.toLowerCase()
  const isPublic = PUBLIC_KROKI_HOSTS.includes(host)
  if (isPublic) {
    if (!allowPublicEndpoint) return { ok: false, reason: '默认禁用公共 Kroki 服务（用户内容不得发往第三方）；如确需使用请在配置显式开启 allowPublicEndpoint' }
    if (u.protocol !== 'https:') return { ok: false, reason: '公共 Kroki endpoint 必须使用 HTTPS' }
  }
  return { ok: true, url: u.origin + (u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : ''), origin: u.origin, endpointId: sha16(u.origin), isPublic }
}

/** 熔断器：closed → open（连续失败≥阈值）→ cooldown 后 half-open（放一个探测）→ 成功 closed / 失败再 open */
export class CircuitBreaker {
  constructor({ failureThreshold = 3, cooldownMs = 30000, onEvent } = {}) {
    this.failureThreshold = failureThreshold
    this.cooldownMs = cooldownMs
    this.onEvent = onEvent || (() => {})
    this.state = 'closed'
    this.failures = 0
    this.openedAt = 0
    this.halfOpenInFlight = false
  }
  /** 进入请求前调用：返回 null 可放行；否则返回拒绝原因 */
  acquire(now = Date.now()) {
    if (this.state === 'closed') return null
    if (this.state === 'open') {
      if (now - this.openedAt >= this.cooldownMs) {
        this.state = 'half_open'
        this.halfOpenInFlight = false
        this.onEvent({ event: 'kroki_circuit_half_open' })
      } else return 'circuit_open'
    }
    if (this.state === 'half_open') {
      if (this.halfOpenInFlight) return 'circuit_half_open_busy' // 半开只放一个探测
      this.halfOpenInFlight = true
      return null
    }
    return null
  }
  onSuccess() {
    if (this.state !== 'closed') this.onEvent({ event: 'kroki_circuit_closed' })
    this.state = 'closed'; this.failures = 0; this.halfOpenInFlight = false
  }
  onFailure(now = Date.now()) {
    this.failures++
    this.halfOpenInFlight = false
    if (this.state === 'half_open' || this.failures >= this.failureThreshold) {
      const was = this.state
      this.state = 'open'; this.openedAt = now
      if (was !== 'open') this.onEvent({ event: 'kroki_circuit_open' })
    }
  }
}

/** 简单信号量（等待也响应 abort） */
class Semaphore {
  constructor(n) { this.n = Math.max(1, n | 0); this.active = 0; this.queue = [] }
  async acquire(signal) {
    if (this.active < this.n) { this.active++; return }
    await new Promise((resolve, reject) => {
      const item = { resolve, reject }
      this.queue.push(item)
      const onAbort = () => {
        const i = this.queue.indexOf(item)
        if (i >= 0) { this.queue.splice(i, 1); reject(makeAbortError('cancelled')) }
      }
      if (signal) {
        if (signal.aborted) return reject(makeAbortError('cancelled'))
        signal.addEventListener('abort', onAbort, { once: true })
        item.cleanup = () => signal.removeEventListener('abort', onAbort)
      }
    })
    this.active++
  }
  release() {
    this.active = Math.max(0, this.active - 1)
    const next = this.queue.shift()
    if (next) { next.cleanup?.(); next.resolve() }
  }
}

function makeAbortError(kind) { const e = new Error(kind); e.name = 'AbortError'; e.kind = kind; return e }

/** 错误归一：{errorClass, message, httpStatus?, retryable} */
function classifyHttpStatus(status, bodySnippet) {
  if (status === 400 || status === 422) return { errorClass: 'invalid_compiled_dsl', message: `Kroki 拒绝编译后的 DSL（HTTP ${status}）${bodySnippet ? '：' + bodySnippet.slice(0, 200) : ''}`, httpStatus: status, retryable: false }
  if (status === 408) return { errorClass: 'timeout', message: 'Kroki 渲染超时（HTTP 408）', httpStatus: status, retryable: false }
  if (status === 413) return { errorClass: 'output_too_large', message: '图形过大（HTTP 413）', httpStatus: status, retryable: false }
  if (status === 429) return { errorClass: 'retryable_external', message: 'Kroki 限流（HTTP 429）', httpStatus: status, retryable: true }
  if (status === 502 || status === 503) return { errorClass: 'renderer_unavailable', message: `Kroki 上游不可用（HTTP ${status}）`, httpStatus: status, retryable: true }
  if (status >= 500) return { errorClass: 'render_failed', message: `Kroki 服务错误（HTTP ${status}）`, httpStatus: status, retryable: false }
  return { errorClass: 'render_failed', message: `Kroki 意外响应（HTTP ${status}）`, httpStatus: status, retryable: false }
}

export class KrokiClient {
  /**
   * @param {object} cfg { endpoint, allowPublicEndpoint, connectTimeoutMs, requestTimeoutMs, maxSourceBytes,
   *                       maxResponseBytes, maxConcurrency, circuitBreaker:{enabled,failureThreshold,cooldownMs}, onEvent }
   */
  constructor(cfg = {}) {
    this.cfg = {
      endpoint: 'http://127.0.0.1:8000',
      allowPublicEndpoint: false,
      connectTimeoutMs: 2000,
      requestTimeoutMs: 12000,
      maxSourceBytes: 131072,
      maxResponseBytes: 4194304,
      maxConcurrency: 2,
      circuitBreaker: { enabled: true, failureThreshold: 3, cooldownMs: 30000 },
      onEvent: () => {},
      ...cfg,
    }
    this.endpoint = null
    const v = validateEndpoint(this.cfg.endpoint, { allowPublicEndpoint: this.cfg.allowPublicEndpoint })
    if (v.ok) this.endpoint = v
    else this.endpointError = v.reason
    this.onEvent = (e) => { try { this.cfg.onEvent?.(e) } catch { /* 日志失败不影响渲染 */ } }
    this.cb = new CircuitBreaker({ ...this.cfg.circuitBreaker, onEvent: this.onEvent })
    this.sem = new Semaphore(this.cfg.maxConcurrency)
  }

  get endpointId() { return this.endpoint?.endpointId || 'invalid' }

  /**
   * 渲染 DSL 为 SVG。
   * @param {object} args { dsl, diagramType='d2', options={}, specHash, agentSignal }
   * @returns {Promise<{ok:true, svg:string, bytes:number, httpStatus:number, durationMs:number}|{ok:false,errorClass,message,retryable?}>}
   */
  async render({ dsl, diagramType = 'd2', options = {}, specHash = '', agentSignal = null, toolCallId = '' }) {
    if (this.endpointError) return { ok: false, errorClass: 'renderer_unavailable', message: `Kroki endpoint 配置无效：${this.endpointError}`, retryable: false }
    const source = String(dsl ?? '')
    const sourceBytes = Buffer.byteLength(source, 'utf8')
    if (sourceBytes > this.cfg.maxSourceBytes) return { ok: false, errorClass: 'output_too_large', message: `编译后 DSL ${sourceBytes}B 超过 maxSourceBytes`, retryable: false }

    const dslHash = sha16(source)
    const base = { endpointId: this.endpointId, diagramType, specHash, dslHash, toolCallId }

    const gate = this.cb.acquire()
    if (gate) {
      this.onEvent({ event: 'kroki_request_error', ...base, errorClass: 'renderer_unavailable', circuitState: this.cb.state, reason: gate })
      return { ok: false, errorClass: 'renderer_unavailable', message: `Kroki 熔断中（${gate}），稍后自动恢复`, retryable: false, circuitState: this.cb.state }
    }

    await this.sem.acquire(agentSignal)
    try {
      let attempt = 0
      // 自动重试：仅可重试错误且未取消，最多一次
      for (;;) {
        const r = await this.#once({ source, sourceBytes, diagramType, options, base, agentSignal, attempt })
        if (r.ok) { this.cb.onSuccess(); return r }
        const canRetry = r.retryable && attempt === 0 && !(agentSignal?.aborted)
        if (!canRetry) { this.cb.onFailure(); return r }
        attempt++
        this.onEvent({ event: 'kroki_request_error', ...base, errorClass: r.errorClass, retryCount: attempt, httpStatus: r.httpStatus })
        await new Promise((res) => setTimeout(res, 300)) // 短退避（无抖动，渲染失败不应占用 Agent 预算太久）
      }
    } finally {
      this.sem.release()
    }
  }

  /** 单次请求（含三段超时/流式计数/错误映射） */
  async #once({ source, sourceBytes, diagramType, options, base, agentSignal, attempt }) {
    const { connectTimeoutMs, requestTimeoutMs, maxResponseBytes } = this.cfg
    const ctl = new AbortController()
    const t0 = Date.now()
    // 组合 Agent 取消信号（用户取消/时间预算）
    const onAgentAbort = () => ctl.abort('cancelled')
    if (agentSignal) {
      if (agentSignal.aborted) { ctl.abort('cancelled') }
      else agentSignal.addEventListener('abort', onAgentAbort, { once: true })
    }
    // 阶段 1：连接/响应头超时
    const connectTimer = setTimeout(() => ctl.abort('connect_timeout'), connectTimeoutMs)

    this.onEvent({ event: 'kroki_request_start', ...base, requestBytes: sourceBytes, retryCount: attempt, circuitState: this.cb.state })
    const cleanupSignals = () => {
      clearTimeout(connectTimer); clearTimeout(totalTimer)
      if (agentSignal) agentSignal.removeEventListener('abort', onAgentAbort)
    }
    let totalTimer = null
    try {
      const body = JSON.stringify({ diagram_source: source, diagram_type: diagramType, output_format: 'svg', diagram_options: options })
      let res
      try {
        res = await fetch(this.endpoint.url + '/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'image/svg+xml' },
          body,
          redirect: 'error',
          signal: ctl.signal,
        })
      } catch (e) {
        // 重定向/网络/Abort 归一
        if (ctl.signal.aborted) return this.#abortResult(ctl.signal.reason, base, t0)
        if (e?.name === 'AbortError') return this.#abortResult(e?.kind || 'timeout', base, t0)
        const msg = String(e?.message || e)
        if (/redirect|socket hang up/i.test(msg)) return { ok: false, errorClass: 'renderer_unavailable', message: `Kroki 请求被拒（可能为重定向或断连）：${msg.slice(0, 160)}`, retryable: true }
        return { ok: false, errorClass: 'renderer_unavailable', message: `Kroki 网络错误：${msg.slice(0, 160)}`, retryable: true }
      }
      // 响应头已到：撤连接定时器，换全程总超时（剩余预算）
      clearTimeout(connectTimer)
      const elapsed = Date.now() - t0
      const remain = requestTimeoutMs - elapsed
      if (remain <= 0) return this.#abortResult('timeout', base, t0)
      totalTimer = setTimeout(() => ctl.abort('timeout'), remain)

      this.onEvent({ event: 'kroki_response_headers', ...base, httpStatus: res.status, contentType: res.headers.get('content-type') || '' })

      if (res.status !== 200) {
        const errText = await this.#readCapped(res, 4096, ctl.signal)
        const cls = classifyHttpStatus(res.status, errText)
        this.onEvent({ event: 'kroki_request_error', ...base, httpStatus: res.status, errorClass: cls.errorClass, durationMs: Date.now() - t0 })
        return cls
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      if (!ct.includes('image/svg+xml') || ct.includes('text/html')) {
        this.onEvent({ event: 'kroki_request_error', ...base, httpStatus: 200, errorClass: 'invalid_renderer_output', contentType: ct, durationMs: Date.now() - t0 })
        return { ok: false, errorClass: 'invalid_renderer_output', message: `Kroki 返回了非 SVG 内容（Content-Type: ${ct || '空'}）`, retryable: false }
      }
      // 阶段 3：流式读取 body（字节计数；超时/取消随时中断）
      const chunks = []
      let total = 0
      const reader = res.body.getReader()
      // fire-and-forget 的 cancel 必须挂 catch：cancel() 返回的 promise 在连接已断时会 reject（abort reason），
      // 不捕获会成为 unhandled rejection 崩掉宿主进程
      const onLateAbort = () => { Promise.resolve(reader.cancel()).catch(() => {}) }
      ctl.signal.addEventListener('abort', onLateAbort, { once: true })
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.length
          if (total > maxResponseBytes) {
            try { await reader.cancel() } catch { /* 忽略 */ }
            this.onEvent({ event: 'kroki_request_error', ...base, httpStatus: 200, errorClass: 'output_too_large', responseBytes: total, durationMs: Date.now() - t0 })
            return { ok: false, errorClass: 'output_too_large', message: `Kroki 响应超过 ${maxResponseBytes}B 上限`, retryable: false }
          }
          chunks.push(Buffer.from(value))
        }
      } catch (e) {
        if (ctl.signal.aborted) return this.#abortResult(ctl.signal.reason, base, t0)
        return { ok: false, errorClass: 'renderer_unavailable', message: `读取 Kroki 响应失败：${String(e?.message || e).slice(0, 160)}`, retryable: true }
      } finally {
        ctl.signal.removeEventListener('abort', onLateAbort)
      }
      const svg = Buffer.concat(chunks).toString('utf8')
      this.onEvent({ event: 'kroki_response_end', ...base, httpStatus: 200, responseBytes: total, durationMs: Date.now() - t0 })
      return { ok: true, svg, bytes: total, httpStatus: 200, durationMs: Date.now() - t0 }
    } finally {
      cleanupSignals()
    }
  }

  #abortResult(kind, base, t0) {
    const errorClass = kind === 'cancelled' ? 'cancelled' : 'timeout'
    this.onEvent({ event: 'kroki_request_error', ...base, errorClass, aborted: kind, durationMs: Date.now() - t0 })
    const msg = kind === 'cancelled' ? '渲染被取消（用户中止/预算到点）' : kind === 'connect_timeout' ? `连接 Kroki 超时（${this.cfg.connectTimeoutMs}ms 内无响应头）` : `Kroki 渲染总超时（${this.cfg.requestTimeoutMs}ms）`
    return { ok: false, errorClass, message: msg, retryable: false }
  }

  /** 有上限地读小 body（错误页文本），超时也中断 */
  async #readCapped(res, cap, signal) {
    try {
      const reader = res.body.getReader()
      const chunks = []; let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        chunks.push(Buffer.from(value))
        if (total >= cap) { try { await reader.cancel() } catch { } break }
      }
      return Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').trim()
    } catch { return signal?.aborted ? '' : '' }
  }
}
