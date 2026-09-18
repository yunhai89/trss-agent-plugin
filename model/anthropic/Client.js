/**
 * AnthropicClient —— Anthropic Messages API 客户端。
 *
 * 定位：纯传输层（与 model/openai 平级、自包含）。
 * 仅负责发请求、收响应、流式聚合与错误重试；工具循环 / Agent 编排由上层负责。
 *
 * 协议要点（区别于 OpenAI）：
 *  - 认证头 x-api-key（MiMo 用 api-key）+ anthropic-version 头
 *  - 端点 /v1/messages
 *  - system 是顶层参数；messages 角色仅 user/assistant
 *  - max_tokens 必填
 *  - 工具用 input_schema；tool_use / tool_result 是 content block
 *  - thinking 块带 signature，回传必须原样
 */

import { requestWithRetry, defaultRetryDelay } from './transport.js'
import { createMessageStream } from './stream.js'

const DEFAULT_TIMEOUT = 60_000
const DEFAULT_MAX_RETRIES = 4
const DEFAULT_VERSION = '2023-06-01'

export class AnthropicClient {
  constructor(config = {}) {
    this.baseURL = (config.baseURL || 'https://api.anthropic.com').replace(/\/+$/, '')
    this.apiKey = config.apiKey || ''

    // Anthropic 协议头
    this.version = config.version || DEFAULT_VERSION
    this.authHeader = config.authHeader || 'x-api-key'
    this.beta = config.beta || null

    // 行为
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
    this.retryDelay = config.retryDelay || defaultRetryDelay
    this.fetcher = config.fetch || globalThis.fetch
    this.onRetry = config.onRetry || (() => {})
    this.log = config.log || (() => {})

    // 自定义默认头
    this.headers = { ...(config.headers || {}) }
    // 会话头（OpenCode Go 等要求每会话稳定标识）；未配置则不发
    this.sessionHeader = config.sessionHeader || null
    this._defaultSessionId = config.sessionId || (globalThis.crypto?.randomUUID?.() || `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)

    // 透传其余配置字段到实例（便于钩子读取）
    for (const [k, v] of Object.entries(config)) {
      if (!(k in this)) this[k] = v
    }

    this.messages = {
      create: (body, opts) => this.create(body, opts),
    }
  }

  resolveURL(path) {
    return `${this.baseURL}${path}`
  }

  buildHeaders(opts = {}) {
    const h = {
      'Content-Type': 'application/json',
      'anthropic-version': this.version,
      ...this.headers,
      ...(opts.headers || {}),
    }
    h[this.authHeader] = this.apiKey
    // 会话头：优先调用方按会话传入，否则实例级稳定 id（保证头始终存在）
    if (this.sessionHeader) h[this.sessionHeader] = opts.sessionId || this._defaultSessionId
    if (this.beta) {
      h['anthropic-beta'] = Array.isArray(this.beta) ? this.beta.join(',') : this.beta
    }
    return h
  }

  /**
   * 调用 /v1/messages。
   * - 非流式：返回 spec 原始 message 响应对象。
   * - 流式（body.stream=true）：返回「异步可迭代 + 聚合」对象，见 stream.js。
   * 所有 spec 参数（system/messages/max_tokens/tools/tool_choice/thinking/stop_sequences/...）原样透传。
   */
  async create(body, opts = {}) {
    if (!body || !body.model) throw new Error('messages.create 需要提供 body.model')
    if (body.max_tokens == null) throw new Error('messages.create 需要提供 body.max_tokens（Anthropic 必填）')

    const isStream = !!body.stream
    const url = this.resolveURL('/v1/messages')
    const headers = this.buildHeaders(opts)
    if (isStream) headers['Accept'] = 'text/event-stream'

    const common = {
      url,
      method: 'POST',
      headers,
      body,
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
      return createMessageStream(res, { idleMs: opts.timeout ?? this.timeout })
    }

    const { data } = await requestWithRetry({ ...common, stream: false })
    return data
  }

  /** 通用 POST（预留 /v1/messages/batches 等），返回 spec 原始响应 */
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
