/**
 * 共享传输基座 —— model/openai 与 model/anthropic 的 transport.js 共用的高可用 HTTP 外围。
 * 协议特定的错误映射（APIError/TimeoutError/ConnectionError/buildAPIError/isRetryableError）由 createRequestWithRetry 注入。
 *
 * 统一的 retryDelay 调用约定：retryDelay(attempt, status) —— status 为上次失败的 HTTP 状态（网络错误为 null）。
 *   - openai 默认实现忽略 status；anthropic 自带 529 过载感知版。
 */

/** 合并多个 AbortSignal：任一触发则合并 signal abort。返回的 ctl 带 cleanup()（移除 listener，防泄漏） */
export function linkSignals(sources) {
  const ctl = new AbortController()
  const cleanups = []
  const onAbort = (s) => () => ctl.abort(s.reason)
  for (const s of sources) {
    if (!s) continue
    if (s.aborted) {
      ctl.abort(s.reason)
      break
    }
    const fn = onAbort(s)
    s.addEventListener('abort', fn, { once: true })
    cleanups.push(() => s.removeEventListener('abort', fn))
  }
  ctl.cleanup = () => { for (const c of cleanups) { try { c() } catch { /* noop */ } } }
  return ctl
}

/** 构建超时 signal 与清理函数 */
function makeTimeout(timeout) {
  if (!timeout || timeout === Infinity) return { signal: null, clear: () => {} }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeout)
  return { signal: ac.signal, clear: () => clearTimeout(timer) }
}

/** 可被外部 signal 提前打断的 sleep（中止抛普通 Error，由调用方归一） */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve()
    const t = setTimeout(resolve, ms)
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t)
        reject(new Error('Aborted'))
      } else {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            reject(new Error('Aborted'))
          },
          { once: true },
        )
      }
    }
  })
}

function lowerKey(k) {
  return String(k).toLowerCase()
}

/**
 * 解析限流相关响应头，返回应等待的秒数（无则 null）。
 * 支持 retry-after-ms / Retry-After（秒数或 HTTP-日期）/ x-ratelimit-reset-requests。
 */
export function parseRetryAfter(headers) {
  if (!headers) return null
  const get = (k) => (headers.get ? headers.get(k) : headers[lowerKey(k)] ?? headers[k])

  const ms = get('retry-after-ms')
  if (ms != null && ms !== '') {
    const n = Number(ms)
    if (!Number.isNaN(n)) return n / 1000
  }

  const ra = get('retry-after')
  if (ra != null && ra !== '') {
    const n = Number(ra)
    if (!Number.isNaN(n)) return n
    const dt = Date.parse(ra)
    if (!Number.isNaN(dt)) return Math.max(0, (dt - Date.now()) / 1000)
  }
  return null
}

/** 默认指数退避（秒）：min(cap, base * 2^attempt) + 抖动；忽略 status（openai 风格）。 */
export function defaultRetryDelay(attempt, _status = null, { base = 0.5, cap = 20, jitter = 0.3 } = {}) {
  const exp = Math.min(cap, base * 2 ** attempt)
  return exp + exp * jitter * Math.random()
}

/**
 * 构造协议感知的 requestWithRetry。
 * @param {object} errs { APIError, TimeoutError, ConnectionError, buildAPIError, isRetryableError }
 * @returns {function} requestWithRetry(opts)
 *
 * @returns 非流式：{ status, headers, data }；流式：原始 Response（未读 body）
 */
export function createRequestWithRetry({ APIError, TimeoutError, ConnectionError, buildAPIError, isRetryableError }) {
  if (!APIError || !TimeoutError || !ConnectionError || !buildAPIError || !isRetryableError) {
    throw new Error('createRequestWithRetry 需要完整错误工具集')
  }

  return async function requestWithRetry({
    url,
    method = 'POST',
    headers,
    body,
    fetcher = globalThis.fetch,
    signal,
    timeout = 60_000,
    maxRetries = 4,
    retryDelay = defaultRetryDelay,
    stream = false,
    onRetry = () => {},
    log = () => {},
  }) {
    let attempt = 0
    let lastErr = null

    while (attempt <= maxRetries) {
      const to = makeTimeout(timeout)
      const linked = linkSignals([to.signal, signal])

      // timeout 覆盖全周期（长任务稳定性审计 P0-4）：建立连接 → 等待响应头 → 响应体读取（成功与错误两种）。
      // 曾在 fetch() 刚返回响应头后就 clearTimeout——body 永不到达时请求悬挂且 signal 不 abort。
      // 唯一例外：流式（stream=true）在 headers 到手后交还响应，空闲超时由 stream.js 的 idleMs 管理。
      let res = null
      let phaseErr = null
      let text = null
      let errBody = null
      try {
        res = await fetcher(url, {
          method,
          headers,
          body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
          signal: linked.signal,
        })
        if (res.ok) {
          if (stream) return res
          text = await res.text()
        } else {
          // 错误响应体同样受 timeout 管辖：text() 的 abort/超时必须向外抛（不吞），
          // 只有 JSON 解析失败才降级为 null（保留"非 JSON 错误体"的原语义）
          const t = await res.text()
          if (t) { try { errBody = JSON.parse(t) } catch { errBody = null } }
        }
      } catch (err) {
        phaseErr = err
      } finally {
        to.clear()
        linked.cleanup?.()
      }

      if (phaseErr) {
        if (phaseErr instanceof APIError) {
          lastErr = phaseErr
        } else if (signal?.aborted) {
          lastErr = new APIError({ message: 'Request aborted by caller', cause: phaseErr })
        } else if (to.signal?.aborted) {
          lastErr = new TimeoutError(`Request timed out after ${timeout}ms`, { cause: phaseErr })
        } else {
          lastErr = new ConnectionError(phaseErr?.message || 'Network error', { cause: phaseErr })
        }
      } else if (res.ok) {
        let data = null
        if (text) {
          try {
            data = JSON.parse(text)
          } catch {
            data = text
          }
        }
        return { status: res.status, headers: res.headers, data }
      } else {
        lastErr = buildAPIError(res.status, errBody, res.headers)
      }

      if (!isRetryableError(lastErr) || attempt >= maxRetries) break

      let delay = typeof retryDelay === 'function' ? retryDelay(attempt, lastErr.status) : retryDelay
      if (lastErr.status === 429) {
        const ra = parseRetryAfter(lastErr.headers)
        if (ra != null) delay = Math.max(delay, ra)
      }
      log('warn', `请求失败（${lastErr.name}/${lastErr.status ?? 'net'}），第 ${attempt + 1} 次重试，等待 ${delay.toFixed(2)}s`)
      onRetry({ attempt: attempt + 1, delay, error: lastErr })

      try {
        await sleep(delay * 1000, signal)
      } catch (e) {
        lastErr = new APIError({ message: 'Request aborted by caller', cause: e })
        break
      }
      attempt++
    }

    log('error', `请求失败（${lastErr?.name ?? 'Error'}/${lastErr?.status ?? 'net'}），共 ${attempt + 1} 次尝试后放弃`)
    throw lastErr || new APIError({ message: 'Request failed' })
  }
}
