/**
 * Jev（TypeSafe AI）客户端 —— 原生 fetch 直调 POST {baseURL}/v1/systemone，不引入新依赖。
 *
 * Jev 不是 OpenAI 兼容 provider：请求是「state + 类型化 questions」，返回每个问题的结构化答案
 * （noul 概率 / choice 选项+置信度 / score 量表位置）。故独立于 model/agent/provider/*，
 * 也不经 createModelRouter（其只解析已注册的 OpenAI/Anthropic 厂商）。
 *
 * 失败语义（接入文档 §11）：401/422 属配置/请求错误，不重试；408/429/5xx 指数退避重试，
 * 并遵守 Retry-After / retry-after-ms 头；网络错误与超时可重试。所有错误归一为 JevError，
 * 调用方据此无感回退现有方案——绝不阻塞对话、绝不 500。
 *
 * 安全：apiKey 仅进 Authorization 头，绝不入日志；错误信息只带状态码与响应体摘要。
 */

const DEFAULT_BASE_URL = 'https://api.typesafe.ai'
const DEFAULT_TIMEOUT_MS = 4000
const DEFAULT_MAX_RETRIES = 1
const DEFAULT_RETRY = {
  backoffInitialMs: 500,
  backoffMaxMs: 5000,
  backoffJitter: 0.25,
  respectRetryAfter: true,
  maxRetryAfterMs: 60000,
}
// 熔断：连续失败达阈值后冷却，冷却期内直接抛 circuit_open（调用方无感回退），
// 避免 TypeSafe 不可用时每条消息都等满「超时×重试」而拖垮对话。
const DEFAULT_CIRCUIT = { failureThreshold: 3, cooldownMs: 30000 }

/** Jev 调用错误：kind 用于分类（auth/invalid_request/rate_limit/server/timeout/network/protocol/config），retriable 决定是否重试 */
export class JevError extends Error {
  constructor(message, { kind = 'error', status = null, retriable = false, body = null } = {}) {
    super(message)
    this.name = 'JevError'
    this.kind = kind
    this.status = status
    this.retriable = retriable
    this.body = body
  }
}

const joinUrl = (baseURL, path) => String(baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '') + path
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const retriableStatus = (s) => s === 408 || s === 429 || (s >= 500 && s <= 599)

function backoffDelay(attempt, retry) {
  const base = Math.min(retry.backoffMaxMs, retry.backoffInitialMs * 2 ** attempt)
  const jitter = retry.backoffJitter > 0 ? base * retry.backoffJitter * (Math.random() * 2 - 1) : 0
  return Math.max(0, Math.round(base + jitter))
}

function retryAfterMs(headers, retry) {
  if (!retry.respectRetryAfter || !headers || typeof headers.get !== 'function') return null
  const ms = Number(headers.get('retry-after-ms'))
  if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, retry.maxRetryAfterMs)
  const sec = Number(headers.get('retry-after'))
  if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, retry.maxRetryAfterMs)
  return null
}

export class JevClient {
  constructor({ apiKey, baseURL = DEFAULT_BASE_URL, model = null, timeout = DEFAULT_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES, retry = {}, circuit = {}, fetch: fetchImpl = null, logger = () => {} } = {}) {
    this.apiKey = apiKey || ''
    this.baseURL = baseURL || DEFAULT_BASE_URL
    this.model = model || null
    this.timeout = Number(timeout) > 0 ? Number(timeout) : DEFAULT_TIMEOUT_MS
    this.maxRetries = Number.isFinite(Number(maxRetries)) ? Math.max(0, Number(maxRetries)) : DEFAULT_MAX_RETRIES
    this.retry = { ...DEFAULT_RETRY, ...(retry || {}) }
    this.circuit = {
      failureThreshold: Number(circuit?.failureThreshold) > 0 ? Number(circuit.failureThreshold) : DEFAULT_CIRCUIT.failureThreshold,
      cooldownMs: Number(circuit?.cooldownMs) > 0 ? Number(circuit.cooldownMs) : DEFAULT_CIRCUIT.cooldownMs,
    }
    this._failCount = 0
    this._openUntil = 0
    this._fetch = fetchImpl || globalThis.fetch
    this.logger = logger
  }

  /** 是否已具备可用配置（有 apiKey） */
  get configured() { return !!this.apiKey && typeof this._fetch === 'function' }

  /** 记录一次"整次调用失败"（重试耗尽）：达阈值则熔断冷却 */
  _recordFailure() {
    this._failCount++
    if (this._failCount >= this.circuit.failureThreshold) {
      this._openUntil = Date.now() + this.circuit.cooldownMs
      this.logger('warn', `[jev] 连续失败 ${this._failCount} 次，熔断 ${this.circuit.cooldownMs}ms（期间直接回退现有方案）`)
      this._failCount = 0
    }
  }

  /** 熔断中 → 抛 circuit_open（非可重试，调用方立即回退） */
  _assertClosed() {
    if (this._openUntil && Date.now() < this._openUntil) {
      throw new JevError(`Jev 熔断中（${Math.ceil((this._openUntil - Date.now()) / 1000)}s 后恢复）`, { kind: 'circuit_open' })
    }
  }

  /**
   * 调 systemOne：一次请求问一组问题（fan-out，state 只发一次）。
   * @returns {Promise<{answers:object, model:string|null, usage:object|null}>}
   * @throws {JevError}
   */
  async systemOne({ state, questions, model = null, timeout = null, signal = null } = {}) {
    if (!this.apiKey) throw new JevError('缺少 Jev API Key', { kind: 'config' })
    if (state == null || (typeof state !== 'string' && typeof state !== 'object')) {
      throw new JevError('state 必须是字符串、对象或数组', { kind: 'invalid_request' })
    }
    if (!questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length) {
      throw new JevError('questions 必须是非空对象', { kind: 'invalid_request' })
    }
    const body = { state, questions }
    const useModel = model || this.model
    if (useModel) body.model = useModel
    const url = joinUrl(this.baseURL, '/v1/systemone')
    this._assertClosed()
    let lastErr = null
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const r = await this._once(url, body, { timeout: Number(timeout) > 0 ? Number(timeout) : this.timeout, signal })
        this._failCount = 0
        this._openUntil = 0
        return r
      } catch (e) {
        if (!(e instanceof JevError)) throw e
        lastErr = e
        if (!e.retriable || attempt >= this.maxRetries) {
          if (e.kind !== 'aborted') this._recordFailure() // 用户主动取消不计入熔断
          throw e
        }
        const wait = Number.isFinite(e.retryAfterMs) ? e.retryAfterMs : backoffDelay(attempt, this.retry)
        this.logger('warn', `[jev] ${e.kind}${e.status ? `(${e.status})` : ''}，${wait}ms 后重试（${attempt + 1}/${this.maxRetries}）`)
        await sleep(wait)
      }
    }
    this._recordFailure()
    throw lastErr || new JevError('Jev 请求失败', { kind: 'error' })
  }

  async _once(url, body, { timeout, signal }) {
    const ctl = new AbortController()
    const onAbort = () => ctl.abort()
    if (signal) {
      if (signal.aborted) throw new JevError('请求已取消', { kind: 'aborted' })
      signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = timeout > 0 ? setTimeout(() => ctl.abort(), timeout) : null
    let res
    try {
      res = await this._fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
    } catch (e) {
      if (signal?.aborted) throw new JevError('请求已取消', { kind: 'aborted' })
      const timedOut = !!timer && ctl.signal.aborted
      throw new JevError(timedOut ? `Jev 请求超时（${timeout}ms）` : `Jev 网络错误：${e?.message || e}`, {
        kind: timedOut ? 'timeout' : 'network', retriable: true,
      })
    } finally {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const status = res.status
      const kind = status === 401 || status === 403 ? 'auth' : status === 422 ? 'invalid_request' : status === 429 ? 'rate_limit' : status >= 500 ? 'server' : 'http'
      const err = new JevError(`Jev API ${status}${text ? `：${text.slice(0, 200)}` : ''}`, { kind, status, retriable: retriableStatus(status), body: text.slice(0, 500) })
      err.retryAfterMs = retryAfterMs(res.headers, this.retry)
      throw err
    }
    let data
    try { data = await res.json() } catch { throw new JevError('Jev 响应不是合法 JSON', { kind: 'protocol' }) }
    if (!data || typeof data !== 'object' || !data.answers || typeof data.answers !== 'object') {
      throw new JevError('Jev 响应缺少 answers', { kind: 'protocol' })
    }
    return { answers: data.answers, model: data.model || null, usage: data.usage || null }
  }
}

/**
 * 从配置造客户端。无 apiKey 返回 null（调用方据此让所有 Jev 决策回退现有方案，fail-closed）。
 * @param {object} cfg agent.jev 配置
 * @param {object} opt { logger, fetch }（fetch 供测试注入）
 */
export function createJevClient(cfg = {}, { logger = () => {}, fetch: fetchImpl = null } = {}) {
  const apiKey = String(cfg.apiKey || '').trim()
  if (!apiKey) return null
  return new JevClient({
    apiKey,
    baseURL: cfg.baseURL || DEFAULT_BASE_URL,
    model: cfg.model || null,
    timeout: cfg.timeoutMs,
    maxRetries: cfg.maxRetries,
    retry: cfg.retry,
    circuit: cfg.circuit,
    fetch: fetchImpl,
    logger,
  })
}

export { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES, DEFAULT_RETRY, DEFAULT_CIRCUIT }
