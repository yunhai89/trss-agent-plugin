/**
 * 统一内部消息格式（OpenAI 风格，两种协议进出 API 前后都映射到它）+ 工具与 token 辅助。
 *
 * 消息结构：
 *   { role: 'system'|'user'|'assistant'|'tool',
 *     content: string|null,
 *     tool_calls?: [{ id, type:'function', function:{ name, arguments(JSON 字符串) } }],
 *     tool_call_id?: string, name?: string, reasoning?: string, isError?: boolean }
 */

/** 解析 tool_call 的 arguments（JSON 字符串）→ 对象；失败返回原值 */
export function parseArgs(value) {
  if (value == null) return {}
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** 把对象序列化为 arguments 字符串 */
export function stringifyArgs(value) {
  if (value == null) return '{}'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

export function cloneMessage(m) {
  return JSON.parse(JSON.stringify(m))
}

/**
 * token 估算：默认 char/4（与 Hermes 网关层粗略估算一致）。
 * 可经 Agent({ estimateTokens }) 注入精确计数器（如 gpt-tokenizer）。
 */
export function tokenEstimate(text) {
  if (!text) return 0
  if (typeof text !== 'string') {
    try {
      text = JSON.stringify(text)
    } catch {
      return 0
    }
  }
  return Math.ceil(text.length / 4)
}

/** 估算一组统一消息的 token 总量（含 content/tool_calls/reasoning） */
export function estimateMessages(messages) {
  let n = 0
  for (const m of messages || []) {
    n += 4 // 每条消息的结构开销近似
    if (typeof m.content === 'string') n += tokenEstimate(m.content)
    if (m.reasoning) n += tokenEstimate(m.reasoning)
    if (m.tool_calls) n += tokenEstimate(m.tool_calls)
  }
  return n
}

/** 把任一协议的 usage 统一为 { input, output, total, raw } */
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null
  const input = u.input_tokens ?? u.prompt_tokens ?? 0
  const output = u.output_tokens ?? u.completion_tokens ?? 0
  // 缓存命中 token（多协议字段归一：DeepSeek prompt_cache_hit_tokens / OpenAI
  // prompt_tokens_details.cached_tokens / Anthropic cache_read_input_tokens）
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0
  return { input, output, total: input + output, cached, raw: u }
}

/** 累计多轮 usage */
export function mergeUsage(acc, u) {
  const n = normalizeUsage(u)
  if (!n) return acc
  if (!acc) return n
  return {
    input: acc.input + n.input,
    output: acc.output + n.output,
    total: acc.total + n.total,
    cached: (acc.cached || 0) + (n.cached || 0),
    raw: n.raw,
  }
}

/** 消息构造器（统一格式） */
export const msg = {
  system: (content, name) => {
    const m = { role: 'system', content }
    if (name) m.name = name
    return m
  },
  user: (content) => ({ role: 'user', content }),
  assistant: (content, extra = {}) => ({ role: 'assistant', content, ...extra }),
  tool: (toolCallId, content, name) => ({ role: 'tool', tool_call_id: toolCallId, content, ...(name ? { name } : {}) }),
}
