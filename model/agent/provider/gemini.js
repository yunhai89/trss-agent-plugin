/**
 * GeminiProvider —— 用官方 @google/genai SDK 的 Interactions API 适配 Gemini。
 *
 * 定位：与 OpenAIProvider/AnthropicProvider 平级，实现 Provider.chat → AssistantResult。
 * 不手写 REST：HTTP/stream/tools/thinking 细节交给 SDK，本层只做
 *   Agent 的 OpenAI 风格消息模型 ↔ Interactions 的 Step[] 转换。
 *
 * 多轮策略：无状态 store:false（Agent 自管 messages 历史，每次全量下发），
 *   input = messages → Step[]（user_input / model_output / function_call / function_result）。
 *   注：Gemini thought steps（含签名）默认不回传（Agent 默认 keepReasoning=false，不持久化思考），
 *   故每轮独立推理；如需跨轮延续深度推理，后续可按 scope 持久化 interaction_id 走有状态模式。
 *
 * 参考：Gemini_API_完整开发文档.md（Interactions API，2026-06 GA）。
 */
import { Provider, toolsToList, jsonSchemaOf } from './base.js'

/** Agent OpenAI 风格 messages → Interactions Step[]（无状态全量历史） */
export function toGeminiSteps(messages) {
  const steps = []
  for (const m of messages || []) {
    if (m.role === 'system') continue // system 经 system_instruction 单独传，不进 input
    if (m.role === 'user') {
      steps.push({ type: 'user_input', content: toContentBlocks(m.content) })
    } else if (m.role === 'assistant') {
      // 模型本轮既可能产文本(model_output)也可能产工具调用(function_call)
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || tc
          steps.push({ type: 'function_call', id: tc.id || fn.name, name: fn.name, arguments: parseArgs(fn.arguments) })
        }
      }
      const text = typeof m.content === 'string' ? m.content : textOf(m.content)
      if (text) steps.push({ type: 'model_output', content: [{ type: 'text', text }] })
    } else if (m.role === 'tool') {
      // 工具结果：function_result step（call_id 关联上一步 function_call）
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? {})
      steps.push({ type: 'function_result', call_id: m.tool_call_id, name: m.name, result: c, is_error: isToolError(c) })
    }
  }
  return steps
}

/** user content → Content_2[]（apps 经 media.toGeminiBlocks 产的块直接用；兼容 openai 块兜底） */
function toContentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) {
    const out = []
    for (const b of content) {
      const g = toGeminiBlock(b)
      if (g) out.push(g)
    }
    return out.length ? out : [{ type: 'text', text: '' }]
  }
  return [{ type: 'text', text: String(content ?? '') }]
}

/** 单个内容块 → Gemini Content_2（gemini 块直通；openai image_url/input_audio 兜底转换） */
function toGeminiBlock(b) {
  if (!b) return null
  if (b.type === 'text' && b.text != null) return { type: 'text', text: String(b.text) }
  if (b.type === 'image') {
    // 原生 Gemini 块（data/mime_type）直通；Anthropic 块（source）跨协议兜底归一
    if (b.data) return { type: 'image', data: b.data, mime_type: b.mime_type }
    const src = b.source || {}
    if (src.type === 'base64' && src.data) return { type: 'image', data: src.data, mime_type: src.media_type || 'image/png' }
    if (src.type === 'url' && src.url) {
      const m = /^data:([^;]+);base64,(.+)$/.exec(src.url)
      if (m) return { type: 'image', data: m[2], mime_type: m[1] }
    }
    return null
  }
  if (b.type === 'audio') return { type: 'audio', data: b.data, mime_type: b.mime_type }
  if (b.type === 'document') return { type: 'document', data: b.data, mime_type: b.mime_type }
  if (b.type === 'video') return { type: 'video', data: b.data, mime_type: b.mime_type }
  // 兜底：openai 风格块（protocol 配错 / 旧路径产出）
  if (b.type === 'image_url' && b.image_url?.url) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(b.image_url.url)
    if (m) return { type: 'image', data: m[2], mime_type: m[1] }
  }
  if (b.type === 'input_audio' && b.input_audio?.data) {
    return { type: 'audio', data: b.input_audio.data, mime_type: 'audio/' + (b.input_audio.format || 'mp3') }
  }
  return null
}

function textOf(content) {
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('')
  return ''
}

function parseArgs(a) {
  if (a == null) return {}
  if (typeof a === 'object') return a
  try { return JSON.parse(a) } catch { return { _raw: String(a) } }
}

function isToolError(s) {
  return typeof s === 'string' && /"error"\s*:/.test(s.slice(0, 200))
}

/** Agent 工具列表 → Gemini FunctionT[]（{type:'function', name, description, parameters}） */
export function toGeminiTools(tools) {
  return toolsToList(tools).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description || '',
    parameters: t.parameters || { type: 'object', properties: {} },
  }))
}

/** 中性 tool_choice → Gemini toolConfig.functionCallingConfig.mode（AUTO/ANY/NONE） */
export function mapGeminiToolChoice(tc) {
  if (!tc) return undefined
  const mode = typeof tc === 'string' ? tc : tc?.mode
  if (mode === 'none') return { functionCallingConfig: { mode: 'NONE' } }
  if (mode === 'any' || mode === 'required') {
    const name = typeof tc === 'object' ? tc.name : null
    return name
      ? { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } }
      : { functionCallingConfig: { mode: 'ANY' } }
  }
  return { functionCallingConfig: { mode: 'AUTO' } } // auto / 默认
}

/** Agent 生成参数 → Gemini generation_config（temperature/maxOutputTokens/thinkingLevel） */
function toGenConfig(opts = {}) {
  const cfg = {}
  if (opts.temperature != null) cfg.temperature = opts.temperature
  if (opts.max_tokens != null) cfg.max_output_tokens = opts.max_tokens
  if (opts.thinking) {
    // Agent thinking: {type:'enabled', budget_tokens} 或 Gemini 专属 {thinking_level}
    if (opts.thinking.thinking_level) cfg.thinking_level = opts.thinking.thinking_level
    else if (opts.thinking.type === 'enabled') cfg.thinking_level = 'medium'
  }
  return cfg
}

/** Interaction.status → AssistantResult.finishReason（Agent 据此判终止） */
function mapFinish(status) {
  if (status === 'completed') return 'stop'
  if (status === 'incomplete') return 'max_tokens'
  if (status === 'budget_exceeded') return 'max_tokens'
  if (status === 'failed') return 'error'
  if (status === 'cancelled') return 'stop'
  return status || 'stop'
}

/** Interaction → AssistantResult（从 steps 提取 model_output 文本 / function_call / thought） */
export function toAssistantResult(interaction) {
  const steps = interaction?.steps || []
  let content = ''
  const toolCalls = []
  let reasoning = null
  for (const s of steps) {
    if (s.type === 'model_output' && Array.isArray(s.content)) {
      for (const c of s.content) if (c && c.type === 'text' && c.text) content += c.text
    } else if (s.type === 'function_call') {
      toolCalls.push({ id: s.id, name: s.name, arguments: s.arguments || {} })
    } else if (s.type === 'thought') {
      // thought summary（thinking_summaries 开启时才有）；signature 不入消息（无状态模式不下发）
      const sum = s.summary
      const t = sum && (sum.text || (Array.isArray(sum) ? sum.map((x) => x.text || '').join('') : ''))
      if (t) reasoning = (reasoning || '') + t
    }
  }
  // output_text 兜底（SDK 便捷属性 = 最后一段连续文本）
  if (!content && interaction?.output_text) content = interaction.output_text
  const u = interaction?.usage || {}
  return {
    role: 'assistant',
    content,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    reasoning: reasoning || null,
    finishReason: mapFinish(interaction?.status),
    usage: {
      input: u.total_input_tokens ?? null,
      output: u.total_output_tokens ?? null,
      total: u.total_tokens ?? null,
      raw: u,
    },
    rawMessage: interaction,
  }
}

export class GeminiProvider extends Provider {
  constructor(config = {}) {
    super(config)
    // @google/genai 懒加载（chat 时才动态 import）：未装此包的环境也能加载本模块、用别的协议；
    // 仅真正用 gemini 协议时才要求该包，缺失时给友好安装提示。
    this._sdk = null
    this._apiKey = config.apiKey || process.env.GEMINI_API_KEY
    this._client = config.client || null
    this.defaultModel = config.model || config.defaultModel || null
    this._noStructuredOutput = false // 记忆：兼容端拒绝过结构化输出，后续不再发送
  }

  _isStructuredUnsupported(e) {
    const m = String(e?.message || e).toLowerCase()
    return /response_format|json_schema|structured|schema/.test(m)
      && /unknown|unsupported|unrecognized|invalid|not supported|400/.test(m)
  }

  /** 首次 chat 时动态 import @google/genai 并构造客户端 */
  async _ensureClient() {
    if (this._client) return this._client
    if (!this._sdk) {
      let GoogleGenAI
      try { ({ GoogleGenAI } = await import('@google/genai')) }
      catch (e) {
        throw new Error('Gemini 原生适配器需要 @google/genai 包：在插件目录执行 `pnpm add @google/genai`（或 npm i @google/genai）安装。原始错误：' + (e?.message || e))
      }
      this._sdk = GoogleGenAI
    }
    this._client = new this._sdk({ apiKey: this._apiKey })
    return this._client
  }

  async chat(opts = {}) {
    const model = opts.model || this.defaultModel
    if (!model) throw new Error('GeminiProvider.chat 需要 model')
    const signal = opts.signal || null
    // 已取消的 signal：不建连、不发请求，直接以 aborted 结束（避免迟到结果写回会话）
    if (signal?.aborted) throw new Error('aborted')
    const ai = await this._ensureClient()
    const wantStream = opts.stream === true || !!opts.onDelta

    const baseParams = {
      model,
      input: toGeminiSteps(opts.messages),
      store: false, // 无状态：Agent 自管历史，每次全量下发
      generation_config: toGenConfig(opts),
    }
    if (opts.system) baseParams.system_instruction = typeof opts.system === 'string' ? opts.system : textOf(opts.system)
    const tools = opts.tools ? toGeminiTools(opts.tools) : null
    if (tools?.length) baseParams.tools = tools
    const tc = mapGeminiToolChoice(opts.tool_choice)
    if (tc) baseParams.tool_config = tc
    // 结构化输出：Interactions API 原生形态 response_format{type:'text',mime_type:'application/json',schema}；
    // 绝不把 OpenAI 的 response_format.json_schema 原样透传（审计 P1-2）。
    const jsonSchema = jsonSchemaOf(opts.response_format)
    if (jsonSchema && !this._noStructuredOutput) {
      baseParams.response_format = { type: 'text', mime_type: 'application/json', schema: jsonSchema }
    }

    if (wantStream) return this._chatStream(baseParams, opts, ai, signal)
    // 取消信号走 SDK 第二参 RequestOptions（其类型含 RequestInit.signal）——建连/读响应阶段
    // 由 SDK 主动中止，不再只靠调用方协作轮询；budget 到点也能中止在途请求。
    try {
      const interaction = await ai.interactions.create(baseParams, { signal })
      return toAssistantResult(interaction)
    } catch (e) {
      // 兼容端/模型不支持结构化输出 → 剥离重试一次并记住，由调用方本地校验兜底，不伪装成功
      if (baseParams.response_format && this._isStructuredUnsupported(e)) {
        this._noStructuredOutput = true
        delete baseParams.response_format
        const interaction = await ai.interactions.create(baseParams, { signal })
        return toAssistantResult(interaction)
      }
      throw e
    }
  }

  /** 流式：step.delta 的 text/thought_summary 逐块回调；function_call 等结束后从 interaction 提取 */
  async _chatStream(baseParams, opts, ai, signal) {
    if (signal?.aborted) throw new Error('aborted')
    const stream = await ai.interactions.create({ ...baseParams, stream: true }, { signal })
    let content = ''
    let reasoning = ''
    let interaction = null
    try {
      for await (const ev of stream) {
        // 迭代阶段取消：终止读取并释放流资源，迟到增量不得回调/写回
        if (signal?.aborted) throw new Error('aborted')
        if (!ev) continue
        if (ev.event_type === 'step.delta' && ev.delta) {
          const d = ev.delta
          if (d.type === 'text' && d.text) {
            content += d.text
            try { opts.onDelta?.(d.text) } catch { /* noop */ }
          } else if (d.type === 'thought_summary' && d.text) {
            reasoning += d.text
            try { opts.onReasoning?.(d.text) } catch { /* noop */ }
          }
        } else if (ev.event_type === 'interaction.completed' && ev.interaction) {
          interaction = ev.interaction
        }
      }
    } catch (e) {
      // 取消/异常：显式关闭迭代器（SDK 取消底层请求），再上抛——不把迟到结果当成功
      try { await stream.return?.() } catch { /* noop */ }
      throw e
    }
    // interaction.completed 携带完整对象（含 steps/usage）；用其提取 toolCalls/usage，文本用流式累加
    const fromInteraction = interaction ? toAssistantResult(interaction) : {}
    const u = interaction?.usage || {}
    return {
      role: 'assistant',
      content: content || fromInteraction.content || '',
      toolCalls: fromInteraction.toolCalls,
      reasoning: reasoning || fromInteraction.reasoning || null,
      finishReason: mapFinish(interaction?.status) || fromInteraction.finishReason || 'stop',
      usage: {
        input: u.total_input_tokens ?? fromInteraction.usage?.input ?? null,
        output: u.total_output_tokens ?? fromInteraction.usage?.output ?? null,
        total: u.total_tokens ?? fromInteraction.usage?.total ?? null,
        raw: u,
      },
      rawMessage: interaction || null,
    }
  }
}

export default GeminiProvider
