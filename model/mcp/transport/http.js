/**
 * Streamable HTTP 传输（MCP 2025-03-25+ 远程传输）。
 *
 * 单端点：每次请求 POST JSON-RPC，`Accept: application/json, text/event-stream`；
 * 响应可能是直接 JSON，或 SSE 流（其中含本请求的结果 + 可能交织的通知/进度，且可长连）。
 * 从响应头 `Mcp-Session-Id` 记录会话 id，并在后续请求带上；close() 尝试 DELETE 结束会话。
 *
 * SSE 响应按 getReader() 增量解析、逐事件投递 —— 即便服务端把流保持打开、在其中推送
 * 通知或服务端发起的请求（sampling/roots），客户端也能即时处理；对服务端请求的响应经 POST 回送。
 *
 * startListen() 可选：GET Accept:text/event-stream 打开常驻推送流（断线自动退避重连），
 * 用于在没有待处理请求时也能接收服务端主动发起的请求。
 */

import { BaseTransport } from './base.js'

function sleep(ms, signal) {
  return new Promise((r) => {
    if (ms <= 0) return r()
    const t = setTimeout(r, ms)
    t.unref?.()
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true })
  })
}

/** 解析 SSE 文本为消息对象数组（按空行分块、合并多 data: 行、忽略 [DONE]/注释） */
export function parseSSE(text) {
  const out = []
  const events = String(text || '').split(/\r?\n\r?\n/)
  for (const ev of events) {
    const dataLines = []
    for (const line of ev.split(/\r?\n/)) {
      const l = line.replace(/\s+$/, '')
      if (!l || l.startsWith(':')) continue
      if (l.startsWith('data:')) dataLines.push(l.slice(5).replace(/^[\t ]/, ''))
    }
    if (!dataLines.length) continue
    const data = dataLines.join('\n')
    if (data === '[DONE]') continue
    try { out.push(JSON.parse(data)) } catch { /* 跳过非 JSON */ }
  }
  return out
}

export class HttpTransport extends BaseTransport {
  constructor({ url, headers = {}, sessionId, fetcher, requestTimeout = 60000, listen = false, listenRetry = 2000 } = {}) {
    super()
    if (!url) throw new Error('HttpTransport 需要 url')
    this.url = url
    this.headers = headers
    this.sessionId = sessionId || null
    this.fetcher = fetcher || globalThis.fetch
    this.requestTimeout = requestTimeout
    this.listen = listen
    this.listenRetry = listenRetry
    this._listening = false
    this._listenCtl = null      // 常驻 GET SSE 流的取消控制器（stopListen/close 用）
    this._inflight = new Set()  // 在途请求的取消控制器（close 时统一 abort）
    this._closed = false
  }

  /** 为一次请求建取消控制器：requestTimeout 到点自动 abort；close() 也会 abort。
   *  此前 requestTimeout 被保存却从不使用——所有 fetch 既无超时、也无法取消。
   *  返回 clearTimer：拿到响应头后解除超时（长连 SSE 流不能被请求超时掐断），
   *  done()：结算该请求（清定时器 + 移出 _inflight）。 */
  _newCtl() {
    const ctl = new AbortController()
    const ms = Number(this.requestTimeout) || 0
    const timer = ms > 0 ? setTimeout(() => { try { ctl.abort(new Error(`请求超时（${ms}ms）`)) } catch { /* noop */ } }, ms) : null
    timer?.unref?.()
    if (this._closed) ctl.abort(new Error('transport closed'))
    this._inflight.add(ctl)
    const clearTimer = () => { if (timer) clearTimeout(timer) }
    const done = () => { clearTimer(); this._inflight.delete(ctl) }
    return { signal: ctl.signal, done, clearTimer }
  }

  async start() {
    if (this.listen) this.startListen()
  }

  /** 增量读取 SSE body，逐事件 onMessage；流保持打开期间持续投递 */
  async _readStream(body) {
    if (!body) return
    if (typeof body.getReader !== 'function') {
      const text = await new Response(body).text()
      for (const m of parseSSE(text)) this._onMessage(m)
      return
    }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // 先归一 CRLF：只认 '\n\n' 时，行结束为 CRLF 的服务端事件会被无限缓冲
        // （永远等不到空行），表现为长连流下请求必然超时
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
        let i
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i)
          buffer = buffer.slice(i + 2)
          for (const m of parseSSE(`${block}\n\n`)) this._onMessage(m)
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) for (const m of parseSSE(`${buffer}\n\n`)) this._onMessage(m)
    } catch (e) {
      this._onError(e)
    } finally {
      try { reader.releaseLock?.() } catch { /* noop */ }
    }
  }

  async send(obj) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.headers,
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId

    const { signal, done, clearTimer } = this._newCtl()
    let res
    try {
      res = await this.fetcher(this.url, { method: 'POST', headers, body: JSON.stringify(obj), signal })
    } catch (e) {
      done()
      // 抛给 JsonRpcChannel.request 的 send().catch → 该 pending 立刻以真实原因失败
      // （曾只 _onError 后 return，pending 空等到超时，报误导性的 "request timeout: initialize"）
      throw new Error(`MCP 请求失败（${this.url}）：${e?.message || e}`)
    }

    const sid = res.headers?.get ? res.headers.get('mcp-session-id') : null
    if (sid) this.sessionId = sid

    if (!res.ok) {
      const t = await res.text().catch(() => '')
      done()
      throw new Error(`MCP HTTP ${res.status}: ${String(t).slice(0, 200)}`)
    }

    const ct = (res.headers?.get ? res.headers.get('content-type') : '') || ''
    if (ct.includes('text/event-stream')) {
      // 响应头已到 → 解除请求超时：POST-SSE 流可长连（服务端交织通知/请求），
      // 用 requestTimeout 掐断会丢通知；_inflight 仍保留以便 close() 能 abort 它
      clearTimer()
      if (res.body && typeof res.body.getReader === 'function') {
        // 流自然结束/出错都要 done()：否则 _inflight 只增不减（close() 会遍历它，缓慢泄漏）
        this._readStream(res.body).then(() => done(), (e) => { done(); this._onError(e) })
      } else {
        try {
          const text = await res.text().catch(() => '')
          for (const m of parseSSE(text)) this._onMessage(m)
        } finally {
          done()
        }
      }
    } else {
      let text = ''
      try {
        text = await res.text()
      } finally {
        done()
      }
      if (!text) return
      try {
        this._onMessage(JSON.parse(text))
      } catch {
        // 必须抛出：只 _onError 不会结算 pending，调用方会空等到 connectTimeout，
        // 报出误导性的 "request timeout: initialize"（真实原因是响应体不是 JSON）
        throw new Error(`MCP HTTP 响应解析失败: ${String(text).slice(0, 200)}`)
      }
    }
  }

  /** 打开常驻 GET SSE 推送流（断线退避重连）；用于接收无待处理请求时的服务端主动消息/请求 */
  async startListen() {
    if (this._listening || this._closed) return
    this._listening = true
    this._listenCtl = new AbortController()
    this._listenLoop().catch((e) => this._onError(e))
  }

  async stopListen() {
    this._listening = false
    // 仅置标志位不够：常驻 GET SSE 流仍在读、连接不释放，停止后还会继续投递消息
    try { this._listenCtl?.abort(new Error('listen stopped')) } catch { /* noop */ }
    this._listenCtl = null
  }

  async _listenLoop() {
    while (this._listening) {
      try {
        const headers = { Accept: 'text/event-stream', ...this.headers }
        if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
        const res = await this.fetcher(this.url, { method: 'GET', headers, ...(this._listenCtl ? { signal: this._listenCtl.signal } : {}) })
        const sid = res.headers?.get ? res.headers.get('mcp-session-id') : null
        if (sid) this.sessionId = sid
        const ct = (res.headers?.get ? res.headers.get('content-type') : '') || ''
        if (res.ok && ct.includes('text/event-stream')) {
          await this._readStream(res.body) // 长连，流断开后自动重连
        } else {
          // 服务端不支持专用 GET 推送流
          this._listening = false
          this._onLog(`listen 不被服务端支持（status ${res.status}）`)
          return
        }
      } catch (e) {
        this._onError(e)
      }
      if (this._listening) await sleep(this.listenRetry)
    }
  }

  async close() {
    this._closed = true
    await this.stopListen()
    // 在途请求统一取消：否则 close() 之后它们仍会占用连接直到超时
    for (const ctl of [...this._inflight]) { try { ctl.abort(new Error('transport closed')) } catch { /* noop */ } }
    this._inflight.clear()
    if (!this.sessionId) return
    try {
      const headers = { ...this.headers, 'Mcp-Session-Id': this.sessionId }
      await this.fetcher(this.url, { method: 'DELETE', headers, signal: AbortSignal.timeout(Number(this.requestTimeout) || 60000) })
    } catch { /* best-effort */ }
  }
}
