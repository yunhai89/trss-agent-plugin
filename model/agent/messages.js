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

/**
 * 把任一协议的 usage 统一为跨协议口径。
 *
 * 字段契约：
 *  - input       真实总输入 token（Anthropic 必须含缓存读+写：input=input_tokens+read+write）
 *  - output / total
 *  - cacheRead   缓存命中读取 token（Anthropic cache_read / DeepSeek hit / OpenAI cached_tokens）
 *  - cacheWrite  缓存写入 token（Anthropic cache_creation / OpenAI cache_write_tokens）
 *  - uncached    未走缓存的输入 token（Anthropic input_tokens / DeepSeek miss）
 *  - cacheObserved 布尔：该响应是否报告了缓存字段——**缺失≠0 命中**，聚合层必须把
 *    未观测请求从命中率分母中剔除（曾把无字段旧日志当 0 命中，稀释面板数字）
 *  - cached      cacheRead 的兼容别名（过渡期保留）
 *  - raw         原始 usage 对象
 */
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null
  // 已归一形态（Gemini provider / 部分聚合层产出 {input,output,total}）：直接识别，不归零
  const preNormalized = u.input_tokens == null && u.prompt_tokens == null
    && Number.isFinite(Number(u.input)) && (Number.isFinite(Number(u.output)) || u.output == null)

  let input, output, total, cacheRead, cacheWrite, uncached, cacheObserved
  if (preNormalized) {
    input = Number(u.input) || 0
    output = Number(u.output) || 0
    total = Number.isFinite(Number(u.total)) ? Number(u.total) : input + output
    // 兼容中间格式（2026-08-17 上午的日志写的是 cached 字段）
    cacheRead = Number(u.cacheRead ?? u.cached) || 0
    cacheWrite = Number(u.cacheWrite) || 0
    uncached = Number(u.uncached) || 0
    cacheObserved = u.cacheObserved === true || cacheRead > 0 || cacheWrite > 0
      || u.cacheRead != null || u.cached != null || (Number(u.uncached) || 0) > 0
    // 顶层无任何缓存标记但带 provider 原始 usage（Agent 累加值 + 末轮 raw 的历史形态）：
    // 缓存字段从 raw 提取（input/output 仍用顶层多轮累加值，更准）
    if (!cacheObserved && u.raw && typeof u.raw === 'object' && u.raw !== u) {
      const rn = normalizeUsage(u.raw)
      if (rn && rn.cacheObserved) {
        cacheRead = rn.cacheRead
        cacheWrite = rn.cacheWrite
        uncached = rn.uncached
        cacheObserved = true
      }
    }
    if (!uncached) uncached = Math.max(0, input - cacheRead)
  } else if (u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null) {
    // Anthropic：input_tokens 不含缓存部分——真实总输入 = 三者之和
    const read = Number(u.cache_read_input_tokens) || 0
    const write = Number(u.cache_creation_input_tokens) || 0
    const plain = Number(u.input_tokens) || 0
    input = plain + read + write
    output = Number(u.output_tokens) || 0
    total = Number.isFinite(Number(u.total_tokens)) ? Number(u.total_tokens) : input + output
    cacheRead = read
    cacheWrite = write
    uncached = plain
    cacheObserved = true
  } else {
    // OpenAI / DeepSeek：prompt_tokens 已是总输入；cached_tokens 在 prompt_tokens_details
    // 或 input_tokens_details，cache_write_tokens 在 input_tokens_details——两个 details 各自独立取
    const hit = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens) || 0
    const write = Number(u.cache_write_tokens ?? u.input_tokens_details?.cache_write_tokens ?? u.prompt_tokens_details?.cache_write_tokens) || 0
    const miss = Number(u.prompt_cache_miss_tokens) || 0
    input = Number(u.prompt_tokens ?? u.input_tokens) || ((hit || miss) ? hit + miss : 0)
    output = Number(u.completion_tokens ?? u.output_tokens) || 0
    total = Number.isFinite(Number(u.total_tokens)) ? Number(u.total_tokens) : input + output
    cacheRead = hit
    cacheWrite = write
    uncached = miss > 0 ? miss : (hit > 0 ? Math.max(0, input - hit) : input)
    cacheObserved = hit > 0 || write > 0 || miss > 0 || u.prompt_cache_hit_tokens != null
      || u.prompt_tokens_details?.cached_tokens != null || u.input_tokens_details?.cached_tokens != null
      || u.input_tokens_details?.cache_write_tokens != null
  }
  return { input, output, total, cacheRead, cacheWrite, uncached, cacheObserved, cached: cacheRead, raw: u }
}

/** 累计多轮 usage（完整 Agent 流口径：全字段逐项求和；raws 保留每轮原始值，封顶 64 条防膨胀） */
export function mergeUsage(acc, u) {
  const n = normalizeUsage(u)
  if (!n) return acc
  if (!acc) return { ...n, raws: [n.raw] }
  return {
    input: acc.input + n.input,
    output: acc.output + n.output,
    total: acc.total + n.total,
    cacheRead: (acc.cacheRead || 0) + n.cacheRead,
    cacheWrite: (acc.cacheWrite || 0) + n.cacheWrite,
    uncached: (acc.uncached || 0) + n.uncached,
    cacheObserved: (acc.cacheObserved && n.cacheObserved) !== false && (acc.cacheObserved || n.cacheObserved),
    cached: (acc.cached || 0) + n.cached,
    raws: [...(acc.raws || []).slice(-63), n.raw],
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
