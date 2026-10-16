/**
 * MCPClient —— MCP 客户端全生命周期。
 *
 *   connect()       initialize 握手 → 存 serverCapabilities/serverInfo → 发 notifications/initialized
 *   ping / shutdown / close
 *   listTools / callTool(name, args)
 *   listResources / readResource(uri) / listPrompts / getPrompt(name, args)
 *   setLogLevel(level)
 *   server→client 钩子：onSampling / onRoots / onProgress / onToolsChanged / onResourcesChanged / onPromptsChanged / onLog
 */

import { JsonRpcChannel, JsonRpcError, ERR } from './jsonrpc.js'
import { PROTOCOL_VERSION, METHODS, LOG_LEVELS } from './protocol.js'

export class MCPClient {
  constructor({ transport, clientInfo, protocolVersion, capabilities, requestTimeout, connectTimeout, logger = () => {} } = {}) {
    if (!transport) throw new Error('MCPClient 需要 transport')
    this.transport = transport
    this.clientInfo = clientInfo || { name: 'agents-plugin-mcp', version: '0.1.0' }
    this.requestedProtocolVersion = protocolVersion || PROTOCOL_VERSION
    this.requestedCapabilities = capabilities || {}
    this.requestTimeout = requestTimeout ?? 60000
    // 旁路传输错误的落点：不接住会连告警一起吞掉（见 _onTransportError）
    this.logger = typeof logger === 'function' ? logger : () => {}
    // initialize 握手用更长超时：stdio 服务端常经 npx 首次拉取（下载耗时远超普通请求）
    this.connectTimeout = connectTimeout ?? Math.max(this.requestTimeout, 180000)

    this._serverCapabilities = null
    this._serverInfo = null
    this._negotiatedVersion = null
    this.channel = null

    // server → client 回调（不设则 sampling/roots 返回 method-not-found，通知忽略）
    this.onSampling = null
    this.onRoots = null
    this.onProgress = null
    this.onToolsChanged = null
    this.onResourcesChanged = null
    this.onResourceUpdated = null
    this.onPromptsChanged = null
    this.onLog = null
    this.onElicitation = null
  }

  get serverCapabilities() { return this._serverCapabilities }
  get serverInfo() { return this._serverInfo }
  get protocolVersion() { return this._negotiatedVersion }
  get isConnected() { return !!this.channel && this._serverCapabilities != null }

  async connect() {
    this.channel = new JsonRpcChannel({
      send: (obj) => this.transport.send(obj),
      timeout: this.requestTimeout,
      onRequest: (method, params) => this._onServerRequest(method, params),
      onNotification: (method, params) => this._onServerNotification(method, params),
    })
    this.transport.onMessage = (msg) => this.channel.receive(msg)
    this.transport.onError = (e) => { try { this._onTransportError(e) } catch { /* noop */ } }
    // 子进程退出/传输关闭：立即拒绝 pending 请求（含 initialize），并带上退出码与 stderr 末尾
    this.transport.onClose = (info) => {
      this._closeInfo = info || null
      if (this.channel && !this.channel.closed) this.channel.abort(new JsonRpcError(-1, this._closeReason(info)))
    }

    await this.transport.start()

    const res = await this.channel.request(METHODS.INITIALIZE, {
      protocolVersion: this.requestedProtocolVersion,
      capabilities: this.requestedCapabilities,
      clientInfo: this.clientInfo,
    }, { timeout: this.connectTimeout })
    this._serverCapabilities = res.capabilities || {}
    this._serverInfo = res.serverInfo || {}
    this._negotiatedVersion = res.protocolVersion || this.requestedProtocolVersion

    await this.channel.notify(METHODS.INITIALIZED)
    return res
  }

  _onTransportError(e) {
    // 请求级致命错误已由传输层在 send 内 throw（直接 reject 对应 pending）；
    // 这里到达的是推送/监听/解析等旁路错误。曾只写 this._transportError（**全仓无任何读取者**），
    // 故障与真实原因被静默丢弃，调用方只能等到超时后看到误导性的 "request timeout"。
    this._transportError = e
    this._lastTransportErrorAt = Date.now()
    try { this.logger('warn', `[mcp] 传输错误：${e?.message || e}`) } catch { /* 日志失败不影响主流程 */ }
  }

  /** 最近一次旁路传输错误（超时/诊断文案用；无则 null） */
  get lastTransportError() { return this._transportError || null }

  /** 把传输 close 信息格式化为可读原因（退出码 / spawn 失败 / stderr 末尾） */
  _closeReason(info) {
    if (!info) return 'transport closed（传输关闭）'
    const bits = []
    if (info.code != null && info.code !== '') bits.push(`进程退出码 ${info.code}`)
    if (info.reason) bits.push(info.reason)
    let r = bits.length ? `传输关闭（${bits.join('；')}）` : '传输关闭'
    if (info.stderrTail) r += `\nstderr 末尾:\n${info.stderrTail}`
    return r
  }

  async ping() { return this.channel.request(METHODS.PING, {}) }

  async shutdown() {
    if (!this.channel) return
    try { await this.channel.request(METHODS.SHUTDOWN, null) } catch { /* noop */ }
  }

  async close() {
    try { await this.shutdown() } catch { /* noop */ }
    try { await this.transport.close() } catch { /* noop */ }
    this.channel = null
  }

  // —— tools ——
  async listTools(cursor) {
    return this.channel.request(METHODS.TOOLS_LIST, cursor != null ? { cursor } : {})
  }
  async callTool(name, args) {
    return this.channel.request(METHODS.TOOLS_CALL, { name, arguments: args || {} })
  }

  // —— resources ——
  async listResources(cursor) {
    return this.channel.request(METHODS.RESOURCES_LIST, cursor != null ? { cursor } : {})
  }
  async readResource(uri) {
    return this.channel.request(METHODS.RESOURCES_READ, { uri })
  }
  async subscribeResource(uri) {
    return this.channel.request(METHODS.RESOURCES_SUBSCRIBE, { uri })
  }
  async unsubscribeResource(uri) {
    return this.channel.request(METHODS.RESOURCES_UNSUBSCRIBE, { uri })
  }

  // —— prompts ——
  async listPrompts(cursor) {
    return this.channel.request(METHODS.PROMPTS_LIST, cursor != null ? { cursor } : {})
  }
  async getPrompt(name, args) {
    return this.channel.request(METHODS.PROMPTS_GET, { name, arguments: args || {} })
  }

  // —— logging ——
  async setLogLevel(level) {
    if (!LOG_LEVELS.includes(level)) throw new Error(`未知日志级别：${level}`)
    return this.channel.request(METHODS.LOGGING_SET_LEVEL, { level })
  }

  // —— server → client ——
  async _onServerRequest(method, params) {
    if (method === METHODS.SAMPLING_CREATE) {
      if (this.onSampling) return this.onSampling(params)
      throw new JsonRpcError(ERR.METHOD_NOT_FOUND, 'sampling not supported')
    }
    if (method === METHODS.ROOTS_LIST) {
      if (this.onRoots) return this.onRoots(params)
      throw new JsonRpcError(ERR.METHOD_NOT_FOUND, 'roots not supported')
    }
    if (method === METHODS.ELICITATION_CREATE) {
      if (this.onElicitation) return this.onElicitation(params)
      throw new JsonRpcError(ERR.METHOD_NOT_FOUND, 'elicitation not supported')
    }
    throw new JsonRpcError(ERR.METHOD_NOT_FOUND, `unknown server method: ${method}`)
  }

  _onServerNotification(method, params) {
    switch (method) {
      case METHODS.TOOLS_LIST_CHANGED: this.onToolsChanged?.(params); break
      case METHODS.RESOURCES_LIST_CHANGED: this.onResourcesChanged?.(params); break
      case METHODS.RESOURCES_UPDATED: this.onResourceUpdated?.(params); break
      case METHODS.PROMPTS_LIST_CHANGED: this.onPromptsChanged?.(params); break
      case METHODS.LOGGING_MESSAGE: this.onLog?.(params); break
      case METHODS.PROGRESS: this.onProgress?.(params); break
      default: break
    }
  }
}
