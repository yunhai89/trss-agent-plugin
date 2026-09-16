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
 *  - cacheObserved 布尔：本次 usage（单次响应，或 mergeUsage 累加流）是否有**任一部分**报告了
 *    缓存字段——**缺失≠0 命中**。
 *  - observedInput / observedOutput / observedUncached  观测口径：只含「报告了缓存字段」的那部分。
 *    命中率分母必须用 observedInput，不能用 input（否则未观测请求被当 0 命中稀释）。
 *    单次响应只能整体计入/整体剔除；mergeUsage 累加流精确到轮，混合流只计观测到的轮。
 *    **已归一对象恒带 cacheRead/cached(=0) 键**，因此绝不能用「字段是否存在」推断是否观测——
 *    必须认 cacheObserved 布尔（曾按存在性 sniff，把未观测流判为已观测，80% 被稀释成 60%）。
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
    if (typeof u.cacheObserved === 'boolean') {
      // 显式布尔是权威信号（本模块/mergeUsage 的产出都带它）
      cacheObserved = u.cacheObserved
    } else {
      // 旧日志形态（仅 input/output/total，无缓存字段也无该布尔）：按字段存在性嗅探 + last raw 兜底
      cacheObserved = cacheRead > 0 || cacheWrite > 0
        || u.cacheRead != null || u.cached != null || uncached > 0
      if (!cacheObserved && u.raw && typeof u.raw === 'object' && u.raw !== u) {
        const rn = normalizeUsage(u.raw)
        if (rn && rn.cacheObserved) {
          cacheRead = rn.cacheRead
          cacheWrite = rn.cacheWrite
          uncached = rn.uncached
          cacheObserved = true
        }
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
  // 观测口径（单一收敛点）：只把「报告了缓存字段」的那部分计入命中率分母与成本口径。
  //  - fine：已归一的累加对象自带细粒度 observed* → 直接用（混合流只计观测到的轮）
  //  - 否则（单次响应 / 旧日志对象）：无法再拆分，整体计入或整体剔除
  const fine = preNormalized && typeof u.cacheObserved === 'boolean'
    && (u.observedInput != null || u.observedOutput != null)
  const observedInput = fine ? Number(u.observedInput) || 0 : (cacheObserved ? input : 0)
  const observedOutput = fine ? Number(u.observedOutput) || 0 : (cacheObserved ? output : 0)
  const observedUncached = fine ? Number(u.observedUncached) || 0 : (cacheObserved ? uncached : 0)
  return {
    input, output, total, cacheRead, cacheWrite, uncached, cacheObserved,
    observedInput, observedOutput, observedUncached,
    cached: cacheRead, raw: u,
  }
}

/** 累计多轮 usage（完整 Agent 流口径：全字段逐项求和；raws 保留每轮原始值，封顶 64 条防膨胀）
 *  观测口径按轮累加（observedInput/Output/Uncached）：只有报告了缓存字段的轮才进命中率分母，
 *  混合流（部分轮不报字段）不会被整轮剔除、也不会把未观测轮灌进分母。 */
export function mergeUsage(acc, u) {
  const n = normalizeUsage(u)
  if (!n) return acc
  if (!acc) return { ...n, raws: [n.raw] }
  const observedInput = (acc.observedInput || 0) + (n.observedInput || 0)
  const observedOutput = (acc.observedOutput || 0) + (n.observedOutput || 0)
  const observedUncached = (acc.observedUncached || 0) + (n.observedUncached || 0)
  return {
    input: acc.input + n.input,
    output: acc.output + n.output,
    total: acc.total + n.total,
    cacheRead: (acc.cacheRead || 0) + n.cacheRead,
    cacheWrite: (acc.cacheWrite || 0) + n.cacheWrite,
    uncached: (acc.uncached || 0) + n.uncached,
    // 有任一片段被观测到即算「已观测」（cacheRead>0 必然来自已观测片段，作兜底证据）
    cacheObserved: observedInput > 0 || observedOutput > 0 || observedUncached > 0 || ((acc.cacheRead || 0) + n.cacheRead) > 0,
    observedInput,
    observedOutput,
    observedUncached,
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
