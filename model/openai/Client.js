/**
 * OpenAIClient —— OpenAI 兼容 Chat Completions 客户端。
 *
 * 定位：纯传输层。只负责发请求、收响应、流式聚合与错误重试。
 * 工具自动执行循环 / 对话状态管理 / Agent 编排由上层负责。
 *
 * 库本身不依赖插件的 Config/Log：apiKey/baseURL 由上层传入，日志与重试通过可选钩子注入。
 */

import { requestWithRetry, defaultRetryDelay } from './transport.js'
import { createStream } from './stream.js'

const DEFAULT_TIMEOUT = 60_000
const DEFAULT_MAX_RETRIES = 4

export class OpenAIClient {
  constructor(config = {}) {
    this.baseURL = (config.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '')
    this.apiKey = config.apiKey || ''
    this.organization = config.organization || null
    this.project = config.project || null

    // 行为
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
    this.retryDelay = config.retryDelay || defaultRetryDelay
    this.fetcher = config.fetch || globalThis.fetch
    this.onRetry = config.onRetry || (() => {})
    this.log = config.log || (() => {})

    // 厂商适配钩子（来自 preset 或自定义）
    this.reasoningFields = config.reasoningFields || []
    this.prepareBody = config.prepareBody || null
    this.buildURLHook = config.buildURL || null
    this.authHeadersHook = config.authHeaders || null

    // 自定义默认请求头
    this.headers = { ...(config.headers || {}) }
    // 会话头：某些网关（如 OpenCode Go）要求每会话稳定标识用于路由/缓存。
    // 未配置 sessionHeader 的 provider 不发该头（保持原行为）。
    this.sessionHeader = config.sessionHeader || null
    this._defaultSessionId = config.sessionId || (globalThis.crypto?.randomUUID?.() || `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)

    // 透传其余配置字段到实例（如 azure 的 resource/deployment/apiVersion），供钩子读取
    for (const [k, v] of Object.entries(config)) {
      if (!(k in this)) this[k] = v
    }

    // OpenAI SDK 风格命名空间
    this.chat = {
      completions: {
        create: (body, opts) => this.create(body, opts),
      },
    }
  }

  resolveURL(path) {
    if (this.buildURLHook) return this.buildURLHook(this, path)
    return `${this.baseURL}${path}`
  }

  buildHeaders(opts = {}) {
    const h = {
      'Content-Type': 'application/json',
      ...this.headers,
      ...(opts.headers || {}),
    }
    // 会话头：优先调用方按会话传入的 sessionId，否则用实例级稳定 id（保证头始终存在）
    if (this.sessionHeader) h[this.sessionHeader] = opts.sessionId || this._defaultSessionId
    if (this.authHeadersHook) {
      Object.assign(h, this.authHeadersHook(this))
    } else if (this.apiKey) {
      h['Authorization'] = `Bearer ${this.apiKey}`
    }
    if (this.organization) h['OpenAI-Organization'] = this.organization
    if (this.project) h['OpenAI-Project'] = this.project
    return h
  }

  applyPrepareBody(body) {
    if (!this.prepareBody) return body
    const b = { ...body } // 浅拷贝顶层，避免污染调用方
    return this.prepareBody(b) || b
  }

  /**
   * 调用 chat/completions。
   * - 非流式：返回 spec 原始响应对象（不变形）。
   * - 流式（body.stream=true）：返回「异步可迭代 + 聚合」对象，见 stream.js。
   * 所有 spec 参数（tools/tool_choice/response_format/reasoning_effort/stream_options/...）原样透传。
   * @param {object} opts opts.signal 调用方取消；opts.timeout/opts.maxRetries/opts.headers 可覆盖。
   */
  async create(body, opts = {}) {
    if (!body || !body.model) throw new Error('chat.completions.create 需要提供 body.model')
    const prepared = this.applyPrepareBody(body)
    const isStream = !!prepared.stream
    const url = this.resolveURL('/chat/completions')
    const headers = this.buildHeaders(opts)
    if (isStream) headers['Accept'] = 'text/event-stream'

    const common = {
      url,
      method: 'POST',
      headers,
      body: prepared,
      fetcher: this.fetcher,
      signal: opts.signal,
      timeout: opts.timeout ?? this.timeout,
      maxRetries: opts.maxRetries ?? this.maxRetries,
      retryDelay: this.retryDelay,
      onRetry: this.onRetry,
      log: this.log,
    }

    if (isStream) {
      const res = await requestWithRetry({ ...common, stream: true })
      return createStream(res, { reasoningFields: this.reasoningFields, idleMs: opts.timeout ?? this.timeout })
    }

    const { data } = await requestWithRetry({ ...common, stream: false })
    return data
  }

  /** 通用 POST 入口（预留 /embeddings、/models 等），返回 spec 原始响应 */
  async post(path, body, opts = {}) {
    const url = this.resolveURL(path)
    const headers = this.buildHeaders(opts)
    const { data } = await requestWithRetry({
      url,
      method: 'POST',
      headers,
      body,
      fetcher: this.fetcher,
      signal: opts.signal,
      timeout: opts.timeout ?? this.timeout,
      maxRetries: opts.maxRetries ?? this.maxRetries,
      retryDelay: this.retryDelay,
      stream: false,
      onRetry: this.onRetry,
      log: this.log,
    })
    return data
  }
}
