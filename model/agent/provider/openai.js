/**
 * OpenAIProvider —— 包装 model/openai，统一消息↔OpenAI Chat Completions 格式。
 */
import { createClient, extractReasoning, splitInlineThink, createThinkStripper, extractToolCallsOpenAI } from '../../openai/index.js'
import { Provider, toolsToList, mapToolChoice, clientOpts } from './base.js'
import { stringifyArgs } from '../messages.js'

export class OpenAIProvider extends Provider {
  constructor(config = {}) {
    super(config)
    this.client = config.client || createClient(clientOpts(config))
    this.reasoningFields = config.reasoningFields || this.client.reasoningFields || []
    this.systemRole = config.systemRole || 'system' // 'system' | 'developer'
    this._modelsNoTemp = new Set() // 自适应记忆：拒绝过 temperature 的模型（推理模型如 kimi-k2.6/r1/o1），后续不传
    this._modelsNoStructuredOutput = new Set() // 自适应记忆：拒绝过 response_format 的模型，后续只靠 prompt，本地校验兜底
  }

  async chat(opts) {
    const {
      model, messages, system, tools, tool_choice, temperature, max_tokens, thinking, top_p,
      reasoning_effort, enable_thinking, thinking_budget,
      signal, stream, onDelta, onReasoning, cacheControl: _cacheControl, sessionId, ...rest
    } = opts // cacheControl（Anthropic 专用 prompt 缓存断点）在此吞掉：OpenAI 兼容端为自动前缀缓存，
    // 该字段既无意义、又不能随 ...rest 泄漏进请求体（部分端点对未知字段直接 400）
    // sessionId：会话级标识（如 OpenCode Go 的 x-opencode-session），走请求头而非请求体
    // reasoning_effort / enable_thinking / thinking_budget：各厂商思考档位的原生字段（见 model/llm/thinking.js）

    const body = {
      model: model || this.defaultModel,
      messages: this._toMessages(messages, system),
      ...rest,
    }
    // 已记忆该模型不支持结构化输出 → 不再发送（避免每轮原样重试）
    if (body.response_format && this._modelsNoStructuredOutput.has(body.model)) delete body.response_format

    const list = toolsToList(tools)
    if (list.length) {
      body.tools = list.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} },
        },
      }))
      const tc = mapToolChoice(tool_choice, 'openai')
      if (tc) body.tool_choice = tc
    }
    // 推理模型（kimi-k2.6 / deepseek-r1 / o1 等）常只允许固定 temperature；
    // 记住拒绝过 temperature 的模型，直接不传（用模型默认），避免每轮失败重试。
    const useTemp = temperature != null && !this._modelsNoTemp.has(body.model)
    if (useTemp) body.temperature = temperature
    if (top_p != null) body.top_p = top_p
    if (max_tokens != null) body.max_tokens = max_tokens
    if (thinking) body.thinking = thinking
    if (reasoning_effort != null) body.reasoning_effort = reasoning_effort
    if (enable_thinking != null) body.enable_thinking = enable_thinking
    if (thinking_budget != null) body.thinking_budget = thinking_budget
    if (stream) {
      body.stream = true
      body.stream_options = { include_usage: true }
    }

    // 记录本轮的"思考类"字段名，供"厂商不认该字段"时剥离重试
    const reasoningKeys = ['thinking', 'reasoning_effort', 'enable_thinking', 'thinking_budget'].filter((k) => body[k] !== undefined)
    try {
      return await this._create(body, { signal, stream, onDelta, onReasoning, sessionId })
    } catch (e) {
      // 自适应：API 报 temperature 非法 → 去掉 temperature 用模型默认重试一次，并记住该模型
      if (body.temperature != null && this._isTempError(e)) {
        this._modelsNoTemp.add(body.model)
        delete body.temperature
        return await this._create(body, { signal, stream, onDelta, onReasoning, sessionId })
      }
      // 自适应：厂商不认思考字段（不同兼容端字段名/支持度不一）→ 剥离思考参数重试一次（降级为不思考，不阻断对话）
      if (reasoningKeys.length && this._isUnsupportedParam(e)) {
        for (const k of reasoningKeys) delete body[k]
        return await this._create(body, { signal, stream, onDelta, onReasoning, sessionId })
      }
      // 自适应：兼容端不认结构化输出 → 剥离 response_format 重试一次并记住该模型，降级后由调用方本地校验兜底
      if (body.response_format && !this._modelsNoStructuredOutput.has(body.model) && this._isStructuredOutputError(e)) {
        this._modelsNoStructuredOutput.add(body.model)
        delete body.response_format
        return await this._create(body, { signal, stream, onDelta, onReasoning, sessionId })
      }
      throw e
    }
  }

  /** 实际发起 create（流式/非流式），供 chat 的 temperature 自适应重试复用 */
  async _create(body, { signal, stream, onDelta, onReasoning, sessionId }) {
    if (stream) {
      const s = await this.client.chat.completions.create(body, { signal, sessionId }) // signal/sessionId 走 opts 第二参（曾 {...body, signal} 并入请求体）
      // 流式 live 旁路：剥掉内联 <think> 推理块，避免中途播报(onDelta)把思考泄漏给用户
      const stripper = onDelta ? createThinkStripper() : null
      for await (const part of s) {
        const dc = part.delta?.content
        if (dc && onDelta) { const c = stripper.feed(dc); if (c) onDelta(c) }
        if (part.delta?.reasoning && onReasoning) onReasoning(part.delta.reasoning)
      }
      return this._resultFromStream(s)
    }
    const res = await this.client.chat.completions.create(body, { signal, sessionId })
    return this._resultFromResponse(res)
  }

  /** 是否"temperature 不被模型接受"类错误（按错误信息判定，不硬编码模型清单） */
  _isTempError(e) {
    const m = String(e?.message || e).toLowerCase()
    return m.includes('temperature') || m.includes('only 1 is allowed')
  }

  /** 是否"厂商不认结构化输出"类错误：报错点名 response_format/json_schema，或 4xx 参数非法 */
  _isStructuredOutputError(e) {
    const m = String(e?.message || e).toLowerCase()
    const named = /response_format|json_schema|structured|schema/.test(m)
    const param = /unknown|unsupported|unrecognized|invalid|not supported|extra|unexpected|400/.test(m)
    return named && param
  }

  /** 是否"厂商不认某思考字段"类错误：报错点名思考相关字段，或 4xx 参数非法 */
  _isUnsupportedParam(e) {
    const m = String(e?.message || e).toLowerCase()
    const named = /thinking|reasoning_effort|enable_thinking|thinking_budget|reasoning/.test(m)
    const param = /unknown|unsupported|unrecognized|invalid|not supported|extra|unexpected|400/.test(m)
    return named && param
  }

  _toMessages(messages, system) {
    const out = []
    if (system) out.push({ role: this.systemRole, content: system })
    for (const m of messages) {
      if (m.role === 'system') {
        out.push({ role: this.systemRole, content: m.content })
        continue
      }
      out.push(this._convert(m))
    }
    return out
  }

  _convert(m) {
    const out = { role: m.role, content: normalizeOpenAIContent(m.content) }
    if (m.tool_calls) {
      out.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id,
        type: tc.type || 'function',
        function: {
          name: tc.function?.name || tc.name,
          arguments:
            typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : stringifyArgs(tc.function?.arguments ?? tc.arguments),
        },
      }))
    }
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id
    if (m.name) out.name = m.name
    if (m.reasoning) out.reasoning_content = m.reasoning // deepseek 等多轮需回传 reasoning_content
    return out
  }

  _resultFromResponse(res) {
    const choice = res.choices?.[0]
    const message = choice?.message || {}
    const toolCalls = extractToolCallsOpenAI(message)
    const fieldReasoning = extractReasoning(message, this.reasoningFields)
    // 剥离内联 <think> 推理块：部分通道把思考内联在 content 里，不剥离会泄漏进最终回复
    const { content: cleanContent, reasoning: inlineReasoning } = splitInlineThink(message.content ?? '')
    const content = cleanContent
    const reasoning = [fieldReasoning, inlineReasoning].filter(Boolean).join('\n\n').trim()
    // 注：绝不拿 reasoning/思考文本填空正文（审计 B7）。content 为空即空——上层据 finishReason
    // （length/max_tokens 等）走确定性收尾，而不是把内部推理当最终答案外发。
    return {
      role: 'assistant',
      content,
      toolCalls,
      reasoning,
      finishReason: choice?.finish_reason ?? null,
      usage: res.usage ?? null,
      rawMessage: message,
    }
  }

  _resultFromStream(s) {
    const toolCalls = s.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments }))
    const { content, reasoning: inlineReasoning } = splitInlineThink(s.content ?? '')
    const reasoning = [s.reasoning, inlineReasoning].filter(Boolean).join('\n\n').trim()
    return {
      role: 'assistant',
      content,
      toolCalls,
      reasoning,
      finishReason: s.finishReason,
      usage: s.usage,
      rawMessage: s.assistantMessage,
    }
  }
}

/**
 * 跨协议历史兜底：把非 OpenAI 原生内容块归一为 Chat Completions 块。
 *
 * 历史消息按会话持久化，可能携带另一协议的原生块（如切模型/跨协议回退到 OpenAI 端点时留下
 * Anthropic `{type:'image',source}` 或 Gemini `{type:'image',data,mime_type}`）。原样透传会被
 * 端点拒收：`unknown variant 'image', expected text/image_url/file`。发送前统一转成 image_url。
 * 未知块降级为文本占位，绝不原样透传（宁可丢图也不 400 中断整轮对话）。
 */
export function normalizeOpenAIContent(content) {
  if (!Array.isArray(content)) return content
  const out = []
  for (const b of content) {
    if (b == null) continue
    if (typeof b !== 'object') { out.push({ type: 'text', text: String(b) }); continue }
    if (b.type === 'text') { out.push({ type: 'text', text: String(b.text ?? '') }); continue }
    if (b.type === 'image_url' || b.type === 'input_audio' || b.type === 'video_url') { out.push(b); continue }
    if (b.type === 'image') {
      const url = imageBlockToUrl(b)
      if (url) out.push({ type: 'image_url', image_url: { url } })
      continue
    }
    if (b.type === 'document' || b.type === 'file') {
      out.push({ type: 'text', text: `[附件（${b.type} 块）在 OpenAI 协议下不支持，已忽略]` })
      continue
    }
    out.push({ type: 'text', text: `[${b.type || 'unknown'} 内容块已忽略]` })
  }
  return out
}

/** Anthropic `{source:{type:base64|url}}` 或 Gemini `{data,mime_type}` → image_url */
function imageBlockToUrl(b) {
  const src = b.source || {}
  if (src.type === 'base64' && src.data) return `data:${src.media_type || b.mime_type || 'image/png'};base64,${src.data}`
  if (src.type === 'url' && src.url) return src.url
  if (b.data) return `data:${b.mime_type || 'image/png'};base64,${b.data}`
  if (b.image_url?.url) return b.image_url.url
  if (typeof b.url === 'string') return b.url
  return null
}
