/**
 * Stagehand LLM generate 回调 —— 复用插件已配的 OpenAI 兼容 provider（apiKey/baseURL/model）。
 *
 * Stagehand 每次原语调用都要一次 LLM 推理（把自然语言指令映射到页面元素）。集成点是
 * Stagehand.create({ model: { generate } })：传一个回调，Stagehand 调它做推理。
 *
 * 回调契约（已对照 @browserbasehq/stagehand 4.0.0 的 LLMGenerateParamsSchema / ResultSchema）：
 *   入参 { messages, systemPrompt?, temperature?, stopSequences?, responseFormat?:{type:'json_schema',name,schema} }
 *   返回 { role:'assistant', content:{type:'text',text}, outputFormat:'json_schema',
 *          structuredContent:<object>, usage?:{inputTokens,outputTokens,totalTokens,...} }
 *
 * 可靠性：
 *  - 复用主 provider 的代理 fetch（llm.fetch），海外端点可走代理；
 *  - 截止时间覆盖「请求发出 + 响应体读取」全过程，而非只覆盖响应头；
 *  - 贯穿会话操作级取消信号（llm.getSignal()）；
 *  - 解析并保留 token usage；
 *  - 错误信息/日志不泄露 apiKey。
 *
 * 限制：仅支持 OpenAI 兼容 endpoint（response_format:json_schema）。插件协议为 anthropic 或
 * provider 不支持结构化输出时，用户应改用 stagehand.modelName 原生模型（见 index.js buildModel）。
 */

const DEFAULT_TIMEOUT_MS = 30000

/** 错误信息脱敏：抹掉 apiKey（防止上游回显或异常串里带出） */
function redact(text, apiKey) {
  let s = String(text == null ? '' : text)
  if (apiKey) s = s.split(String(apiKey)).join('***')
  return s
}

function resolveSignal(getSignal) {
  try {
    const s = typeof getSignal === 'function' ? getSignal() : getSignal
    return s && typeof s.aborted === 'boolean' ? s : null
  } catch { return null }
}

/**
 * @param {object} llm { apiKey, baseURL, model, fetch?, timeoutMs?, getSignal? }
 * @returns {(params:object)=>Promise<object>} generate 回调
 */
export function makeGenerate(llm = {}) {
  const { apiKey, baseURL, model } = llm
  const fetchImpl = typeof llm.fetch === 'function' ? llm.fetch : globalThis.fetch
  const timeoutMs = Math.max(20, Number(llm.timeoutMs) || DEFAULT_TIMEOUT_MS)
  return async function generate(params) {
    if (!apiKey || !model) throw new Error('stagehand 复用 provider 需 agent.apiKey + agent.model')
    if (params?.responseFormat?.type !== 'json_schema') {
      // Stagehand act/observe/extract 都发 json_schema；text 形态理论上不会出现，保守拒绝
      throw new TypeError('stagehand generate 仅处理 json_schema 结构化请求')
    }
    const { name, schema } = params.responseFormat
    const body = {
      model,
      messages: toOpenAIMessages(params.messages, params.systemPrompt),
      temperature: typeof params.temperature === 'number' ? params.temperature : 0,
      response_format: {
        type: 'json_schema',
        json_schema: { name: name || 'result', schema, strict: false },
      },
      stream: false,
    }
    if (Array.isArray(params.stopSequences) && params.stopSequences.length) body.stop = params.stopSequences.slice(0, 4)

    const url = String(baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions'
    const controller = new AbortController()
    const ext = resolveSignal(llm.getSignal)
    let cancelled = false
    const onAbort = () => { cancelled = true; controller.abort(ext?.reason) }
    if (ext) {
      if (ext.aborted) { const e = new Error('stagehand LLM 请求已取消'); e.name = 'AbortError'; throw e }
      ext.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(new Error(`stagehand LLM 请求超时（${timeoutMs}ms）`)), timeoutMs)
    try {
      let res
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (e) {
        if (cancelled) { const err = new Error('stagehand LLM 请求已取消'); err.name = 'AbortError'; throw err }
        throw new Error(`stagehand LLM 请求失败：${redact(e?.message || e, apiKey)}`)
      }
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw new Error(`stagehand LLM 请求失败 ${res.status}: ${redact(t.slice(0, 300), apiKey)}`)
      }
      // 响应体读取同样在截止时间内（fetch 的 signal 会中止 body 流）
      let data
      try {
        data = await res.json()
      } catch (e) {
        if (cancelled) { const err = new Error('stagehand LLM 请求已取消'); err.name = 'AbortError'; throw err }
        if (controller.signal.aborted) throw new Error(`stagehand LLM 响应读取超时（${timeoutMs}ms）`)
        throw new Error(`stagehand LLM 响应体解析失败：${redact(e?.message || e, apiKey)}`)
      }
      const text = data?.choices?.[0]?.message?.content || ''
      let structured
      try {
        structured = typeof text === 'string' ? JSON.parse(text) : text
      } catch {
        throw new Error(`stagehand LLM 返回非合法 JSON（provider 可能不支持 json_schema）: ${redact(String(text).slice(0, 200), apiKey)}`)
      }
      const out = {
        role: 'assistant',
        content: { type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) },
        outputFormat: 'json_schema',
        structuredContent: structured,
      }
      const usage = normalizeUsage(data?.usage)
      if (usage) out.usage = usage
      const finish = data?.choices?.[0]?.finish_reason
      if (finish) out.stopReason = String(finish)
      return out
    } finally {
      clearTimeout(timer)
      if (ext) ext.removeEventListener('abort', onAbort)
    }
  }
}

/** OpenAI usage → Stagehand LLMUsage（字段名不同：prompt_tokens/completion_tokens → inputTokens/outputTokens） */
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0
  const total = Number(u.total_tokens ?? (input + output)) || input + output
  const out = { inputTokens: input, outputTokens: output, totalTokens: total }
  const reasoning = Number(u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens)
  if (Number.isFinite(reasoning)) out.reasoningTokens = reasoning
  const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens)
  if (Number.isFinite(cached)) out.cachedInputTokens = cached
  return out
}

/** Stagehand messages → OpenAI chat messages（content 可能是单 block 或 block 数组；图像块忽略，仅取文本） */
function toOpenAIMessages(messages = [], systemPrompt) {
  const out = []
  if (systemPrompt) out.push({ role: 'system', content: String(systemPrompt) })
  for (const m of messages) {
    const blocks = Array.isArray(m?.content) ? m.content : [m?.content]
    const text = blocks
      .filter((b) => b && b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('\n')
    out.push({ role: m?.role || 'user', content: text })
  }
  return out
}
