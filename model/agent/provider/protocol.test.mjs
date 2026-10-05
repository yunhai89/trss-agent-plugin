/**
 * 离线回归 —— Provider 协议/取消/缓存能力（审计 B2/B3/B4/B7）。
 *
 * 覆盖：
 *  - B2 Anthropic 工具续轮保留原生 thinking(signature)/redacted_thinking 块（非流式 + 流式）；
 *  - B3 Gemini 取消信号透传 SDK（建连/迭代），预先取消不建连；
 *  - B4 回退 provider 缓存能力按【实际选中 provider】判定（真实请求体字段）；
 *  - B7 纯 reasoning 响应不得成为最终答案。
 *
 * 运行：node model/agent/provider/protocol.test.mjs
 */
import assert from 'node:assert/strict'
import { Agent, ToolRegistry, OpenAIProvider, AnthropicProvider, GeminiProvider } from '../index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 4).join('\n')) } }
const reply = (content = 'done') => ({ role: 'assistant', content, toolCalls: [], finishReason: 'stop' })
const call = (name, id, args = {}) => ({ id, name, arguments: args })

// ── B2：Anthropic 原生块 ──────────────────────────────────────────────
const NATIVE_BLOCKS = [
  { type: 'thinking', thinking: 'fixture reasoning', signature: 'fixture-opaque-signature' },
  { type: 'redacted_thinking', data: 'fixture-opaque-data' },
  { type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} },
]

await test('B2 非流式：工具续轮回发 thinking.signature/redacted_thinking（keepReasoning 两档）', async () => {
  for (const keepReasoning of [false, true]) {
    const requests = []
    const client = { messages: { async create(body) {
      requests.push(structuredClone(body))
      return requests.length === 1
        ? { role: 'assistant', content: NATIVE_BLOCKS, stop_reason: 'tool_use' }
        : { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }
    } } }
    const tools = new ToolRegistry().register({ name: 'lookup', description: 'f', parameters: { type: 'object' }, execute: async () => ({ result: 1 }) })
    const agent = new Agent({ provider: new AnthropicProvider({ client }), model: 'fixture', tools, keepReasoning, thinking: { type: 'enabled', budget_tokens: 1024 }, reflect: 'off', governor: false })
    await agent.run('fixture')
    const actual = requests[1].messages.find((m) => m.role === 'assistant')?.content
    assert.deepEqual(actual, NATIVE_BLOCKS, `keepReasoning=${keepReasoning} 第二轮请求必须原样带回原生块`)
  }
})

await test('B2 流式：signature_delta/redacted_thinking 经 assistantMessage 原样回发', async () => {
  const streamBlocks = [
    { type: 'thinking', thinking: 'stream reasoning', signature: 'stream-signature' },
    { type: 'redacted_thinking', data: 'stream-redacted' },
    { type: 'tool_use', id: 'tool-9', name: 'lookup', input: {} },
  ]
  const requests = []
  const makeStream = ({ content, text, thinking, toolUses, stopReason }) => {
    const obj = {
      async *[Symbol.asyncIterator]() {
        if (thinking) yield { thinking }
        yield { text }
      },
      get text() { return text },
      get thinking() { return thinking },
      get toolUses() { return toolUses },
      get assistantMessage() { return { role: 'assistant', content } },
      get stopReason() { return stopReason },
      get usage() { return null },
    }
    return obj
  }
  const client = { messages: { async create(body) {
    requests.push(structuredClone(body))
    if (requests.length === 1) return makeStream({ content: streamBlocks, text: '', thinking: 'stream reasoning', toolUses: [{ id: 'tool-9', name: 'lookup', input: {} }], stopReason: 'tool_use' })
    return makeStream({ content: [{ type: 'text', text: 'done' }], text: 'done', thinking: '', toolUses: [], stopReason: 'end_turn' })
  } } }
  const tools = new ToolRegistry().register({ name: 'lookup', description: 'f', parameters: { type: 'object' }, execute: async () => ({ result: 1 }) })
  const agent = new Agent({ provider: new AnthropicProvider({ client }), model: 'fixture', tools, thinking: { type: 'enabled', budget_tokens: 1024 }, reflect: 'off', governor: false, stream: true })
  await agent.run('fixture', { stream: true, onDelta: () => {} })
  const actual = requests[1].messages.find((m) => m.role === 'assistant')?.content
  assert.deepEqual(actual, streamBlocks, '流式工具续轮也必须原样带回原生块')
})

// ── B3：Gemini 取消 ───────────────────────────────────────────────────
await test('B3 预先取消：不调用 SDK，直接 aborted', async () => {
  const ctl = new AbortController()
  ctl.abort()
  let called = 0
  const client = { interactions: { async create() { called++; return { status: 'completed', steps: [] } } } }
  await assert.rejects(new GeminiProvider({ model: 'fixture', client }).chat({ messages: [{ role: 'user', content: 'x' }], signal: ctl.signal }), /aborted/)
  ok(called === 0, '预先取消不建连/不发请求')
})

await test('B3 请求中取消：signal 透传 SDK 第二参（流式/非流式），有界退出', async () => {
  for (const stream of [false, true]) {
    const ctl = new AbortController()
    let requestOptions
    let release
    let started
    const ready = new Promise((r) => { started = r })
    const client = { interactions: { async create(_body, options) {
      requestOptions = options
      return new Promise((resolve, reject) => {
        release = () => resolve(stream
          ? (async function* () { yield { event_type: 'interaction.completed', interaction: { status: 'completed', steps: [] } } })()
          : { status: 'completed', steps: [] })
        if (options?.signal?.aborted) reject(new Error('aborted'))
        else options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        started()
      })
    } } }
    const pending = new GeminiProvider({ model: 'fixture', client }).chat({ messages: [{ role: 'user', content: 'x' }], stream, signal: ctl.signal })
      .then(() => 'completed', () => 'rejected')
    await ready
    ctl.abort()
    const outcome = await Promise.race([pending, new Promise((r) => setTimeout(() => r('pending'), 60))])
    ok(requestOptions?.signal === ctl.signal, `stream=${stream}：SDK 收到同一 signal`)
    ok(outcome === 'rejected', `stream=${stream}：abort 后有界退出（实际 ${outcome}）`)
    release()
    await pending
  }
})

// ── B4：回退缓存能力 ─────────────────────────────────────────────────
await test('B4 回退不支持 prompt_cache_key：真实请求体不得带该字段', async () => {
  const requests = []
  const fallback = new OpenAIProvider({ client: { chat: { completions: { async create(body) {
    requests.push(body)
    return { choices: [{ message: { content: 'fallback reply' }, finish_reason: 'stop' }] }
  } } } } })
  fallback.cacheCaps = { promptCacheKey: false, cacheControlAuto: false }
  const main = { cacheCaps: { promptCacheKey: true }, async chat() { throw new Error('primary down') } }
  const agent = new Agent({ provider: main, model: 'primary', fallbackProviders: [{ provider: fallback, model: 'fallback' }], promptCacheKey: true, reflect: 'off', governor: false })
  await agent.run('fixture')
  ok(requests.length === 1, '回退被调用一次')
  assert.equal(Object.hasOwn(requests[0], 'prompt_cache_key'), false, '不支持的回退端点不带 prompt_cache_key')
})

await test('B4 回退支持 prompt_cache_key：主不支持时回退仍可下发（且键含回退模型名）', async () => {
  const requests = []
  const fallback = new OpenAIProvider({ client: { chat: { completions: { async create(body) {
    requests.push(body)
    return { choices: [{ message: { content: 'fallback reply' }, finish_reason: 'stop' }] }
  } } } } })
  fallback.cacheCaps = { promptCacheKey: true, cacheControlAuto: false }
  const main = { cacheCaps: { promptCacheKey: false }, async chat() { throw new Error('primary down') } }
  const agent = new Agent({ provider: main, model: 'primary', fallbackProviders: [{ provider: fallback, model: 'fallback' }], promptCacheKey: true, reflect: 'off', governor: false })
  await agent.run('fixture')
  ok(typeof requests[0].prompt_cache_key === 'string' && requests[0].prompt_cache_key.length > 0, '支持的回退端点下发 prompt_cache_key')
})

await test('B4 主路径不支持：显式开启也不下发（不强迫兼容端接受）', async () => {
  const requests = []
  const main = new OpenAIProvider({ client: { chat: { completions: { async create(body) {
    requests.push(body)
    return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }
  } } } } })
  main.cacheCaps = { promptCacheKey: false }
  const agent = new Agent({ provider: main, model: 'fixture', promptCacheKey: true, reflect: 'off', governor: false })
  await agent.run('fixture')
  assert.equal(Object.hasOwn(requests[0], 'prompt_cache_key'), false, 'provider 声明不支持则不下发')
})

// ── B7：纯 reasoning 响应 ────────────────────────────────────────────
const reasoningOnlyProvider = (finish) => new OpenAIProvider({
  reasoningFields: ['reasoning_content'],
  client: { chat: { completions: { async create() {
    return { choices: [{ message: { content: '', reasoning_content: 'INTERNAL_FIXTURE_REASONING_ONLY' }, finish_reason: finish }] }
  } } } },
})

await test('B7 reasoning-only + length：正文不含推理，进入确定性收尾', async () => {
  const result = await new Agent({ provider: reasoningOnlyProvider('length'), model: 'fixture', maxTurns: 1, reflect: 'off', governor: false }).run('fixture')
  assert.notEqual(result.content, 'INTERNAL_FIXTURE_REASONING_ONLY')
  assert.ok(!result.content.includes('INTERNAL_FIXTURE_REASONING_ONLY'), '最终正文不含内部推理')
  ok(result.stopReason === 'provider_incomplete', `stopReason=provider_incomplete（实际 ${result.stopReason}）`)
})

await test('B7 reasoning-only + stop：同样不把推理当答案', async () => {
  const result = await new Agent({ provider: reasoningOnlyProvider('stop'), model: 'fixture', maxTurns: 1, reflect: 'off', governor: false }).run('fixture')
  assert.ok(!String(result.content).includes('INTERNAL_FIXTURE_REASONING_ONLY'), '不泄漏推理')
})

await test('B7 正文伴随 reasoning：正常交付正文', async () => {
  const provider = new OpenAIProvider({ reasoningFields: ['reasoning_content'], client: { chat: { completions: { async create() {
    return { choices: [{ message: { content: 'visible answer', reasoning_content: 'hidden' }, finish_reason: 'stop' }] }
  } } } } })
  const result = await new Agent({ provider, model: 'fixture', maxTurns: 1, reflect: 'off', governor: false }).run('fixture')
  assert.equal(result.content, 'visible answer')
})

await test('B7 空正文无 reasoning：不返回空串，进入确定性收尾', async () => {
  const provider = new OpenAIProvider({ client: { chat: { completions: { async create() {
    return { choices: [{ message: { content: '' }, finish_reason: 'stop' }] }
  } } } } })
  const result = await new Agent({ provider, model: 'fixture', maxTurns: 1, reflect: 'off', governor: false }).run('fixture')
  ok(result.content.trim().length > 0, '非空兜底正文')
})

await test('B7 正常工具调用不受影响', async () => {
  let turn = 0
  const provider = new OpenAIProvider({ client: { chat: { completions: { async create() {
    if (turn++ === 0) return { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
    return { choices: [{ message: { content: 'after tool' }, finish_reason: 'stop' }] }
  } } } } })
  const tools = new ToolRegistry().register({ name: 'ping', description: 'f', parameters: { type: 'object' }, execute: async () => ({ pong: true }) })
  const result = await new Agent({ provider, model: 'fixture', tools, reflect: 'off', governor: false }).run('fixture')
  assert.equal(result.content, 'after tool')
})

// ── 结构化输出：各协议映射到原生参数（审计 P1-2）─────────────────────
const NEUTRAL_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
const NEUTRAL_RF = { type: 'json_schema', json_schema: { name: 'fixture', strict: true, schema: NEUTRAL_SCHEMA } }

await test('结构化输出：OpenAI 原样透传 response_format（不改造）', async () => {
  let captured
  const client = { chat: { completions: { async create(body) { captured = structuredClone(body); return { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] } } } } }
  await new OpenAIProvider({ client }).chat({ model: 'fixture', messages: [{ role: 'user', content: 'x' }], response_format: NEUTRAL_RF })
  assert.deepEqual(captured.response_format, NEUTRAL_RF, 'OpenAI 收到原生 response_format')
})

await test('结构化输出：Anthropic 映射为 output_config.format，不发送 OpenAI response_format', async () => {
  let captured
  const client = { messages: { async create(body) { captured = structuredClone(body); return { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' } } } }
  await new AnthropicProvider({ client }).chat({ model: 'fixture', messages: [{ role: 'user', content: 'x' }], response_format: NEUTRAL_RF })
  assert.equal(Object.hasOwn(captured, 'response_format'), false, '不得把 OpenAI response_format 发给 Anthropic')
  assert.deepEqual(captured.output_config?.format, { type: 'json_schema', schema: NEUTRAL_SCHEMA }, 'Anthropic 原生 output_config.format')
})

await test('结构化输出：Gemini 映射为 response_format{type:text,mime_type,schema}', async () => {
  let captured
  const client = { interactions: { async create(body) { captured = structuredClone(body); return { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"ok":true}' }] }] } } } }
  await new GeminiProvider({ client }).chat({ model: 'fixture', messages: [{ role: 'user', content: 'x' }], response_format: NEUTRAL_RF })
  assert.deepEqual(captured.response_format, { type: 'text', mime_type: 'application/json', schema: NEUTRAL_SCHEMA }, 'Gemini 原生 response_format')
  assert.equal(Object.hasOwn(captured.response_format || {}, 'json_schema'), false, '不透传 json_schema 包装')
})

await test('结构化输出：兼容端拒绝 response_format → 降级一次并记住（不反复原样重试）', async () => {
  const bodies = []
  let calls = 0
  const client = { chat: { completions: { async create(body) {
    bodies.push(structuredClone(body)); calls++
    if (calls === 1) throw new Error('400 unsupported parameter: response_format')
    return { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }
  } } } }
  const p = new OpenAIProvider({ client })
  await p.chat({ model: 'no-struct-model', messages: [{ role: 'user', content: 'x' }], response_format: NEUTRAL_RF })
  await p.chat({ model: 'no-struct-model', messages: [{ role: 'user', content: 'x' }], response_format: NEUTRAL_RF })
  assert.equal(bodies.length, 3, '首次降级重试 2 次 + 第二次直接成功 1 次')
  assert.equal(Object.hasOwn(bodies[1], 'response_format'), false, '降级重试不带 response_format')
  assert.equal(Object.hasOwn(bodies[2], 'response_format'), false, '后续调用主动剥离（记忆生效）')
})

// ── 跨协议历史：内容块发送前归一为当前协议原生块 ─────────────────────
const ANTH_IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QQ==' } }
const OAI_IMAGE = { type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }

await test('跨协议：Anthropic image 块发给 OpenAI 端点 → 转 image_url（不再 unknown variant）', async () => {
  let captured
  const client = { chat: { completions: { async create(body) { captured = structuredClone(body); return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } } } } }
  await new OpenAIProvider({ client }).chat({ model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, ANTH_IMAGE] }] })
  const content = captured.messages.at(-1).content
  assert.equal(content[0].type, 'text')
  assert.equal(content[1].type, 'image_url', 'Anthropic image → image_url')
  assert.equal(content[1].image_url.url, 'data:image/png;base64,QQ==')
})

await test('跨协议：OpenAI image_url 块发给 Anthropic 端点 → 转 image{source}（不再 unknown variant）', async () => {
  let captured
  const client = { messages: { async create(body) { captured = structuredClone(body); return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } } } }
  await new AnthropicProvider({ client }).chat({ model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, OAI_IMAGE] }] })
  const content = captured.messages.at(-1).content
  assert.equal(content[1].type, 'image', 'OpenAI image_url → Anthropic image')
  assert.deepEqual(content[1].source, { type: 'base64', media_type: 'image/png', data: 'QQ==' })
})

await test('跨协议：Anthropic image 块发给 Gemini 端点 → 转 Content_2 image{data,mime_type}', async () => {
  let captured
  const client = { interactions: { async create(body) { captured = structuredClone(body); return { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }] } } } }
  await new GeminiProvider({ model: 'fixture', client }).chat({ messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, ANTH_IMAGE] }] })
  const step = captured.input.find((s) => s.type === 'user_input')
  assert.deepEqual(step.content[1], { type: 'image', data: 'QQ==', mime_type: 'image/png' })
})

await test('跨协议：Anthropic document 块发给 Gemini 端点 → 补齐 data/mime_type（曾丢成空 document）', async () => {
  let captured
  const client = { interactions: { async create(body) { captured = structuredClone(body); return { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }] } } } }
  const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } }
  await new GeminiProvider({ model: 'fixture', client }).chat({ messages: [{ role: 'user', content: [doc] }] })
  const step = captured.input.find((s) => s.type === 'user_input')
  assert.deepEqual(step.content[0], { type: 'document', data: 'JVBERi0=', mime_type: 'application/pdf' })
})

await test('跨协议：Gemini document 块发给 Anthropic 端点 → 补齐 source{base64}', async () => {
  let captured
  const client = { messages: { async create(body) { captured = structuredClone(body); return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } } } }
  const doc = { type: 'document', data: 'JVBERi0=', mime_type: 'application/pdf' }
  await new AnthropicProvider({ client }).chat({ model: 'fixture', messages: [{ role: 'user', content: [doc] }] })
  const content = captured.messages.at(-1).content
  assert.deepEqual(content[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } })
})

await test('跨协议：无法原生表达的块（Anthropic 端点收到 audio/video）→ 降级 text 占位，不透传', async () => {
  let captured
  const client = { messages: { async create(body) { captured = structuredClone(body); return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } } } }
  const audio = { type: 'input_audio', input_audio: { data: 'QQ==', format: 'mp3' } }
  const video = { type: 'video_url', video_url: { url: 'data:video/mp4;base64,QQ==' } }
  await new AnthropicProvider({ client }).chat({ model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, audio, video] }] })
  const content = captured.messages.at(-1).content
  assert.ok(content.every((b) => b.type === 'text'), 'Anthropic 请求中不得出现 audio/video 块')
  assert.ok(content.some((b) => /input_audio|video_url/.test(b.text)), '降级占位保留来源类型')
})

await test('跨协议：OpenAI video_url 块发给 Gemini → 转 Content_2 video{data,mime_type}', async () => {
  let captured
  const client = { interactions: { async create(body) { captured = structuredClone(body); return { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }] } } } }
  const video = { type: 'video_url', video_url: { url: 'data:video/mp4;base64,QUJD' } }
  await new GeminiProvider({ model: 'fixture', client }).chat({ messages: [{ role: 'user', content: [video] }] })
  const step = captured.input.find((s) => s.type === 'user_input')
  assert.deepEqual(step.content[0], { type: 'video', data: 'QUJD', mime_type: 'video/mp4' })
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
