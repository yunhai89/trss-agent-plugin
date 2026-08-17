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
  }

  async chat(opts) {
    const {
      model, messages, system, tools, tool_choice, temperature, max_tokens, thinking, top_p,
      signal, stream, onDelta, onReasoning, cacheControl: _cacheControl, ...rest
    } = opts // cacheControl（Anthropic 专用 prompt 缓存断点）在此吞掉：OpenAI 兼容端为自动前缀缓存，
    // 该字段既无意义、又不能随 ...rest 泄漏进请求体（部分端点对未知字段直接 400）

    const body = {
      model: model || this.defaultModel,
      messages: this._toMessages(messages, system),
      ...rest,
    }

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
    if (stream) {
      body.stream = true
      body.stream_options = { include_usage: true }
    }

    try {
      return await this._create(body, { signal, stream, onDelta, onReasoning })
    } catch (e) {
      // 自适应：API 报 temperature 非法 → 去掉 temperature 用模型默认重试一次，并记住该模型
      if (body.temperature != null && this._isTempError(e)) {
        this._modelsNoTemp.add(body.model)
        delete body.temperature
        return await this._create(body, { signal, stream, onDelta, onReasoning })
      }
      throw e
    }
  }

  /** 实际发起 create（流式/非流式），供 chat 的 temperature 自适应重试复用 */
  async _create(body, { signal, stream, onDelta, onReasoning }) {
    if (stream) {
      const s = await this.client.chat.completions.create(body, { signal }) // signal 走 opts 第二参（曾 {...body, signal} 并入请求体）
      // 流式 live 旁路：剥掉内联 <think> 推理块，避免中途播报(onDelta)把思考泄漏给用户
      const stripper = onDelta ? createThinkStripper() : null
      for await (const part of s) {
        const dc = part.delta?.content
        if (dc && onDelta) { const c = stripper.feed(dc); if (c) onDelta(c) }
        if (part.delta?.reasoning && onReasoning) onReasoning(part.delta.reasoning)
      }
      return this._resultFromStream(s)
    }
    const res = await this.client.chat.completions.create(body, { signal })
    return this._resultFromResponse(res)
  }

  /** 是否"temperature 不被模型接受"类错误（按错误信息判定，不硬编码模型清单） */
  _isTempError(e) {
    const m = String(e?.message || e).toLowerCase()
    return m.includes('temperature') || m.includes('only 1 is allowed')
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
    const out = { role: m.role, content: m.content }
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
    let content = cleanContent
    const reasoning = [fieldReasoning, inlineReasoning].filter(Boolean).join('\n\n').trim()
    // content 空 + 无 tool_calls + 有【字段】reasoning：用 reasoning 占位 content（防空消息进历史）。
    // 注：只用字段 reasoning 占位，不拿刚剥掉的内联 think 凑，避免把推理又塞回正文
    if (!content && !toolCalls.length && fieldReasoning) {
      content = fieldReasoning
    }
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
