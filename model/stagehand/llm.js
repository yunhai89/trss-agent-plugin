/**
 * Stagehand LLM generate 回调 —— 复用插件已配的 OpenAI 兼容 provider（apiKey/baseURL/model）。
 *
 * Stagehand 每次原语调用都要一次 LLM 推理（把自然语言指令映射到页面元素）。集成点是
 * Stagehand.create({ model: { generate } })：传一个回调，Stagehand 调它做推理。
 *
 * 回调契约（docs 已确认）：
 *   入参 { messages, systemPrompt?, temperature?, responseFormat?:{type:'json_schema',name,schema} }
 *   返回 { role:'assistant', content:{type:'text',text}, outputFormat:'json_schema', structuredContent:<object> }
 *
 * 限制：仅支持 OpenAI 兼容 endpoint（response_format:json_schema）。插件协议为 anthropic 或
 * provider 不支持结构化输出时，用户应改用 stagehand.modelName 原生模型（见 index.js buildModel）。
 */

/**
 * @param {object} llm { apiKey, baseURL, model } —— 来自插件 agent 配置
 * @returns {(params:object)=>Promise<object>} generate 回调
 */
export function makeGenerate(llm = {}) {
  const { apiKey, baseURL, model } = llm
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
    const url = String(baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions'
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`stagehand LLM 请求失败 ${res.status}: ${t.slice(0, 300)}`)
    }
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content || ''
    let structured
    try {
      structured = JSON.parse(text)
    } catch {
      throw new Error(`stagehand LLM 返回非合法 JSON（provider 可能不支持 json_schema）: ${String(text).slice(0, 200)}`)
    }
    return {
      role: 'assistant',
      content: { type: 'text', text },
      outputFormat: 'json_schema',
      structuredContent: structured,
    }
  }
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
