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
import { toGeminiContent } from './content-blocks.js'
import { isToolErrorContent } from '../tool-result.js'

/** Agent OpenAI 风格 messages → Interactions Step[]（无状态全量历史） */
export function toGeminiSteps(messages) {
  const steps = []
  for (const m of messages || []) {
    if (m.role === 'system') {
      // 首部 system 由 system_instruction 承载；**尾部** system 是本轮自检反馈（Agent 在 messages 末尾追加），
      // 直接 continue 会静默丢掉反馈 → 草稿已 pop、重生成却没有任何修正指令（实测 Gemini 上自检=白跑）。
      // Interactions 无 per-message system 角色，故转成 user 输入（文案本身已标明「系统自检，非用户输入」）。
      if (steps.length) steps.push({ type: 'user_input', content: toContentBlocks(m.content) })
      continue
    }
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

/** user content → Content_2[]（apps 经 media.toGeminiBlocks 产的块直接用；跨协议块经 content-blocks 兜底归一） */
function toContentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) {
    const out = toGeminiContent(content).filter(Boolean)
    return out.length ? out : [{ type: 'text', text: '' }]
  }
  return [{ type: 'text', text: String(content ?? '') }]
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

// 2026-10-17 审计 B5：原来是「前 200 字符里出现 `"error":` 就算错误」的子串判定 —— 正常正文里
// 引用一段 JSON（例如文档片段、代码示例）会被误判成工具失败，且与 Agent 侧的结构化判定不一致
//（`isToolErrorContent` 才判断 JSON 对象/数组里的 error 字段）。这里直接复用同一实现。
function isToolError(s) {
  return isToolErrorContent(s)
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

/**
 * 中性 tool_choice → Gemini Interactions 的 `generation_config.tool_choice` 取值。
 *
 * 两代错误形态的最终修正：
 *  ① 最早 `mapGeminiToolChoice` 产出 `{functionCallingConfig:{mode}}` —— 那是**旧 generateContent**
 *     接口的 ToolConfig 形态，写到 Interactions 请求上无效；
 *  ② 中间形态把 any/required「无法表达」静默降级 auto —— 依据（「接口没有该字段」）是事实错误。
 * SDK .d.ts 明确：`GenerationConfig_2.tool_choice?: ToolChoiceConfig | ToolChoiceType`
 * （ToolChoiceType = 'auto'|'any'|'none'|'validated'；ToolChoiceConfig = {allowed_tools?:{mode?,tools?[]}}），
 * 而 Interactions create 的 `generation_config` 正是该类型 —— 强制调用、禁调用、指定函数名都能如实下发。
 *
 * @param {*} tc 中性形态：'auto'|'none'|'any'|'required'|'tool' 或 {mode,name}
 * @returns {string|{allowed_tools:{mode:string,tools:string[]}}|null} null = 不显式下发（用接口默认 auto）
 */
export function toolChoiceConfig(tc) {
  if (!tc) return null
  const mode = String((typeof tc === 'string' ? tc : (tc?.mode || (tc?.name ? 'tool' : 'auto'))) || 'auto').toLowerCase()
  if (mode === 'none') return 'none'
  if (mode === 'any' || mode === 'required') return 'any'
  if (mode === 'validated') return 'validated'
  if (mode === 'tool' || mode === 'function') {
    const name = typeof tc === 'object' && tc?.name ? String(tc.name) : ''
    return name ? { allowed_tools: { mode: 'any', tools: [name] } } : 'any'
  }
  return null // auto / 未知模式：不显式下发
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

/**
 * ThoughtSummaryDelta.content（Content_2）→ 文本。
 * SDK 类型为 `ThoughtSummaryDelta = { content?: Content_2; type:'thought_summary' }`：
 * 增量文本在 **content** 上，此前按 `d.text` 读（恒为 undefined）导致 onReasoning 从不触发、
 * reasoning 永远为空（L-084）。兼容 {text} / {parts:[{text}]} / 字符串 / 块数组多种形态。
 */
function deltaContentText(c) {
  if (!c) return ''
  if (typeof c === 'string') return c
  if (typeof c.text === 'string') return c.text
  if (Array.isArray(c.parts)) return c.parts.map((p) => p?.text || '').join('')
  if (Array.isArray(c)) return textOf(c)
  return ''
}

/** Interaction.status → AssistantResult.finishReason（Agent 据此判终止） */
function mapFinish(status) {
  if (status === 'completed') return 'stop'
  if (status === 'incomplete') return 'max_tokens'
  if (status === 'budget_exceeded') return 'max_tokens'
  if (status === 'failed') return 'error'
  if (status === 'cancelled') return 'incomplete' // 审计 B6：取消/中断不是正常收尾，回报 'stop' 会让上层当成完整回复
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
    // tool_choice 语义落地（M-023 + 复核 #6 返工）：
    //   none → 既**不下发 tools**（与 model/humanize/replyer.js 等处 `tools:undefined, tool_choice:{mode:'none'}`
    //          的双保险写法一致），也显式下发 tool_choice:'none'；
    //   any/required/指定函数名 → 经 generation_config.tool_choice 如实下发（接口支持），不再静默降级 auto。
    const tc = toolChoiceConfig(opts.tool_choice)
    const hasTools = !!tools?.length
    if (hasTools && tc !== 'none') baseParams.tools = tools
    if (tc === 'none' || (hasTools && tc)) baseParams.generation_config.tool_choice = tc
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
          } else if (d.type === 'thought_summary') {
            const rt = deltaContentText(d.content) || deltaContentText(d.text)
            if (rt) {
              reasoning += rt
              try { opts.onReasoning?.(rt) } catch { /* noop */ }
            }
          }
        } else if (ev.event_type === 'error') {
          // 流内错误事件（SDK 类型 ErrorEvent：{event_type:'error', error}）：此前被忽略，
          // 于是"中途报错 + 已产出半截正文"会被当成正常结束（截断当成功）。显式上抛。
          const em = ev.error?.message || ev.error?.code || '流式响应返回 error 事件'
          throw new Error(`gemini stream error: ${typeof em === 'string' ? em : JSON.stringify(em)}`)
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
      // 未收到 interaction.completed 说明流被中断/截断（拿到半截正文也不算正常结束）：
      // 此前 `mapFinish(undefined)` 走 `status || 'stop'` 兜底成 'stop'，截断与完整回复无法区分。
      // 这里如实标 'incomplete'（不列入 GOVERNOR_STOP，故不会给用户追加"未产出正文"话术，
      // 但 turn 日志、账本 lastTurn.finish、Web 时间线都能看出这次是截断）。
      finishReason: interaction
        ? (mapFinish(interaction.status) || fromInteraction.finishReason || 'stop')
        : (fromInteraction.finishReason || 'incomplete'),
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
