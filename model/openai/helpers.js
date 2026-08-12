/**
 * 响应/消息相关的纯工具函数，供 stream、index 及上层复用。
 */

/**
 * 解析 tool_call.function.arguments（JSON 字符串）为对象。
 * 解析失败时返回原始字符串，避免上层因模型偶发输出非完整 JSON 而崩溃。
 * @param {object|string|null} toolCall 标准 tool_call 对象 / arguments 字符串
 */
export function parseToolArguments(toolCall) {
  if (toolCall == null) return null
  const raw =
    typeof toolCall === 'string'
      ? toolCall
      : toolCall.function?.arguments ?? toolCall.arguments
  if (raw == null) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** 取 tool_call 的 arguments 字符串形式（便于原样回传到下一轮 messages） */
export function toolArgumentsString(toolCall) {
  if (!toolCall) return ''
  if (typeof toolCall === 'string') return toolCall
  if (toolCall.function?.arguments != null) return toolCall.function.arguments
  if (typeof toolCall.arguments === 'string') return toolCall.arguments
  try {
    return JSON.stringify(toolCall.arguments ?? {})
  } catch {
    return ''
  }
}

let _callSeq = 0
const synthCallId = () => `call_${++_callSeq}`

/**
 * 从 message 提取工具调用，归一为 [{id, name, arguments(对象)}]。
 * 兼容两种形态，避免「模型要调工具但 tool_call 结构丢失 → 循环误判为纯文本最终回复」
 * （见 OpenAI-Anthropic-Coding-Plan 文档 §9.2）：
 *   - 标准 chat-completions：message.tool_calls = [{id, type, function:{name, arguments}}]
 *   - 旧版 v1 单调用：message.function_call = {name, arguments}（无 id → 合成）
 */
export function extractToolCallsOpenAI(message) {
  if (!message) return []
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return message.tool_calls
      .filter((tc) => tc && (tc.function?.name || tc.name))
      .map((tc) => ({ id: tc.id || synthCallId(), name: tc.function?.name || tc.name, arguments: parseToolArguments(tc) }))
  }
  const fc = message.function_call
  if (fc && (fc.name || fc.function?.name)) {
    return [{ id: fc.id || synthCallId(), name: fc.function?.name || fc.name, arguments: parseToolArguments(fc) }]
  }
  return []
}

/**
 * 按候选字段名从 message 提取推理/思考内容（厂商归一化）。
 * 例如 DeepSeek/Zhipu/DashScope 用 reasoning_content，Moonshot 用 reasoning_content 或 reasoning。
 */
export function extractReasoning(message, fields = []) {
  if (!message) return null
  // 先查自定义字段
  for (const f of fields) {
    const v = message?.[f]
    if (v) return v
  }
  // 兜底：deepseek/智通/Moonshot 等常见字段名
  const fallback = message.reasoning_content || message.reasoning
  return fallback || null
}

/**
 * 从 content 里剥离内联的 <think>…</think> 推理块，路由到 reasoning。
 *
 * 部分模型/通道（某些 OpenAI 兼容的 Coding Plan、推理模型聚合层）不提供独立的
 * reasoning_content 字段，而是把思考用 <think>…</think> 包裹后内联在 content 里。
 * 若不剥离，推理内容会泄漏进最终用户回复（见 OpenAI-Anthropic-Coding-Plan 文档 §9.1）。
 *
 * 规则：成对 <think>…</think> 整块移除；未闭合的 <think>（流式中断/残缺）视为思考丢弃。
 * @param {string} content 原始 content
 * @param {string} reasoning 已有 reasoning（来自 reasoning_content 字段），与内联 think 合并
 * @returns {{content: string, reasoning: string}} 剥离后的 content 与合并后的 reasoning
 */
export function splitInlineThink(content, reasoning = '') {
  if (typeof content !== 'string' || !content) return { content: content || '', reasoning: reasoning || '' }
  if (!content.includes('<think')) return { content, reasoning: reasoning || '' }
  const thoughts = []
  // 成对的 <think>…</think>（DOTALL；容忍 <think> 上可能的属性/空白、</think > 的尾空格）
  const paired = /<think\b[^>]*>([\s\S]*?)<\/think\s*>/g
  let cleaned = content.replace(paired, (_m, t) => { thoughts.push(String(t).trim()); return '' })
  // 容错：只剩开标签、未闭合 —— 开标签之后的全部视为思考
  const openIdx = cleaned.indexOf('<think')
  if (openIdx >= 0) {
    thoughts.push(cleaned.slice(openIdx).replace(/^<think\b[^>]*>/, '').replace(/<\/think\s*>$/, '').trim())
    cleaned = cleaned.slice(0, openIdx)
  }
  // 去掉 think 块剥离后留下的首尾空白/空行
  cleaned = cleaned.replace(/^\s+|\s+$/g, '')
  const merged = [reasoning, ...thoughts].filter(Boolean).join('\n\n').trim()
  return { content: cleaned, reasoning: merged }
}

/**
 * 流式 <think> 剥离器（有状态，跨 delta 累积），用于流式 live 旁路（onDelta）。
 * 标签可能被拆到多个 delta（如 "<thi"｜"nk>…"），靠尾部前缀缓冲处理。
 * feed(chunk) 返回本轮可安全外发的文本（已剔除 <think>…</think>）。
 * @returns {{feed:(chunk:string)=>string, end:()=>string}}
 */
export function createThinkStripper() {
  let buf = ''
  let inThink = false
  const OPEN = '<think>'
  const CLOSE = '</think>'
  // buf 尾部是否是 tag 的前缀（如 "<th"），是则保留不外发，等下个 delta 再判
  const tailPrefix = (s, tag) => {
    for (let n = tag.length - 1; n > 0; n--) if (s.endsWith(tag.slice(0, n))) return n
    return 0
  }
  const flush = () => {
    let safe = ''
    while (true) {
      if (!inThink) {
        const i = buf.indexOf(OPEN)
        if (i < 0) {
          const keep = tailPrefix(buf, OPEN)
          safe += buf.slice(0, buf.length - keep)
          buf = buf.slice(buf.length - keep)
          break
        }
        safe += buf.slice(0, i)
        buf = buf.slice(i + OPEN.length)
        inThink = true
      } else {
        const j = buf.indexOf(CLOSE)
        if (j < 0) {
          const keep = tailPrefix(buf, CLOSE)
          buf = buf.slice(buf.length - keep)
          break
        }
        buf = buf.slice(j + CLOSE.length)
        inThink = false
      }
    }
    return safe
  }
  return {
    feed(chunk) { buf += chunk; return flush() },
    // 流结束：未闭合 think 内的残余丢弃；否则把残留（非 think）发出
    end() { const r = inThink ? '' : buf; buf = ''; return r },
  }
}
