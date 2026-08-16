/**
 * AnthropicProvider —— 包装 model/anthropic。
 * 核心难点：统一消息 → Anthropic 格式（对应 Hermes anthropic_adapter.py）。
 *   - system 提到顶层 system 参数
 *   - assistant tool_calls → content blocks [tool_use]
 *   - role:'tool' 结果 → user 消息内 [tool_result] blocks；连续（并行）合并为单条 user
 *   - 强制 user/assistant 严格交替（相邻同角色合并）
 *   - max_tokens 必填：未给默认 4096
 */
import { createClient, extractText, extractThinking, extractToolUses } from '../../anthropic/index.js'
import { splitInlineThink, createThinkStripper } from '../../openai/index.js' // 纯函数：剥离内联 <think>（防御某些 Anthropic 兼容聚合层把思考内联进 text block）
import { Provider, toolsToList, mapToolChoice, clientOpts } from './base.js'
import { parseArgs } from '../messages.js'

function mergeContent(a, b) {
  const aa = Array.isArray(a) ? a : a ? [{ type: 'text', text: a }] : []
  const bb = Array.isArray(b) ? b : b ? [{ type: 'text', text: b }] : []
  return [...aa, ...bb]
}

/**
 * 统一消息 → Anthropic messages + system。
 * @returns {{ system: string|null, messages: Array }}
 */
export function toAnthropicMessages(messages, system) {
  const sysParts = []
  if (system) sysParts.push(system)

  const raw = []
  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string' && m.content) sysParts.push(m.content)
      continue
    }
    if (m.role === 'user') {
      raw.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      const blocks = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name || tc.name
          const input = parseArgs(tc.function?.arguments ?? tc.arguments)
          blocks.push({ type: 'tool_use', id: tc.id, name, input })
        }
      }
      raw.push({ role: 'assistant', content: blocks.length ? blocks : '' })
    } else if (m.role === 'tool') {
      raw.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: m.content ?? '',
            ...(m.isError ? { is_error: true } : {}),
          },
        ],
      })
    }
  }

  // 合并相邻同角色（含并行工具结果 → 单条 user 多个 tool_result）
  const merged = []
  for (const m of raw) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) {
      last.content = mergeContent(last.content, m.content)
    } else {
      merged.push({ role: m.role, content: m.content })
    }
  }

  // Anthropic 要求首条消息为 user
  if (merged.length && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: '(开始)' })
  }

  const finalSystem = sysParts.filter(Boolean).join('\n\n') || null
  return { system: finalSystem, messages: merged }
}

function resultFromResponse(res) {
  const content = res.content || []
  // 防御：若 text block 里被内联了 <think>，剥离到 reasoning（原生 Anthropic 走 thinking block，此处为 no-op）
  const { content: cleanText, reasoning: inlineReasoning } = splitInlineThink(extractText(content))
  const thinking = extractThinking(content)
  const reasoning = [thinking, inlineReasoning].filter(Boolean).join('\n\n').trim()
  return {
    role: 'assistant',
    content: cleanText,
    toolCalls: extractToolUses(content),
    reasoning: reasoning || null,
    finishReason: res.stop_reason ?? null,
    usage: res.usage ?? null,
    rawMessage: res,
  }
}

function resultFromStream(s) {
  const { content: cleanText, reasoning: inlineReasoning } = splitInlineThink(s.text ?? '')
  const reasoning = [s.thinking, inlineReasoning].filter(Boolean).join('\n\n').trim()
  return {
    role: 'assistant',
    content: cleanText,
    toolCalls: s.toolUses,
    reasoning: reasoning || null,
    finishReason: s.stopReason,
    usage: s.usage,
    rawMessage: s.assistantMessage,
  }
}

export class AnthropicProvider extends Provider {
  constructor(config = {}) {
    super(config)
    this.client = config.client || createClient(clientOpts(config))
  }

  async chat(opts) {
    const {
      model, messages, system, tools, tool_choice, temperature, max_tokens, thinking,
      top_p, top_k, signal, stream, onDelta, onReasoning, stop_sequences, cacheControl = false, ...rest
    } = opts

    const conv = toAnthropicMessages(messages, system)
    const body = {
      model: model || this.defaultModel,
      max_tokens: max_tokens ?? 4096,
      messages: conv.messages,
      ...rest,
    }
    // Prompt caching（Anthropic 需显式 cache_control 断点；写 1.25x / 读 0.1x，命中一次即回本）：
    //   ① tools 末个 ② system（转 block 数组，末块）③ messages 末条末 block。
    // 前缀顺序 tools → system → messages，断点设在各段末尾使「到此为止的前缀」可缓存；
    // 工具循环每轮 messages 增长，上一轮的末条断点即本轮的命中点。
    // 默认关：第三方 Anthropic 兼容网关未必认该字段（agent.cacheControl: true 开启）。
    if (cacheControl) {
      if (conv.system != null) {
        body.system = [{ type: 'text', text: conv.system, cache_control: { type: 'ephemeral' } }]
      }
      const lastMsg = body.messages[body.messages.length - 1]
      if (lastMsg) {
        const blocks = Array.isArray(lastMsg.content) ? lastMsg.content : (lastMsg.content ? [{ type: 'text', text: lastMsg.content }] : [])
        if (blocks.length) {
          blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } }
          lastMsg.content = blocks
        }
      }
    } else if (conv.system != null) {
      body.system = conv.system
    }

    const list = toolsToList(tools)
    if (list.length) {
      body.tools = list.map((t) => ({
        name: t.name,
        description: t.description || '',
        input_schema: t.parameters || { type: 'object', properties: {} },
      }))
      if (cacheControl) body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' }
      const tc = mapToolChoice(tool_choice, 'anthropic')
      if (tc) body.tool_choice = tc
    }
    if (temperature != null) body.temperature = temperature
    if (top_p != null) body.top_p = top_p
    if (top_k != null) body.top_k = top_k
    if (stop_sequences) body.stop_sequences = stop_sequences
    if (thinking) body.thinking = thinking
    if (stream) body.stream = true

    if (stream) {
      const s = await this.client.messages.create({ ...body, signal })
      // 流式 live 旁路：剥掉内联 <think>，避免中途播报(onDelta)泄漏思考
      const stripper = onDelta ? createThinkStripper() : null
      for await (const ev of s) {
        if (ev.text && onDelta) { const c = stripper.feed(ev.text); if (c) onDelta(c) }
        if (ev.thinking && onReasoning) onReasoning(ev.thinking)
      }
      return resultFromStream(s)
    }

    const res = await this.client.messages.create({ ...body, signal })
    return resultFromResponse(res)
  }
}
