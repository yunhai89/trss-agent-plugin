/**
 * 离线自检 —— 注入 mock fetch，无需联网 / API Key。
 * 运行：node model/openai/test.mjs
 */
import {
  createClient,
  presets,
  msg,
  parseToolArguments,
  extractReasoning,
  splitInlineThink,
  createThinkStripper,
  extractToolCallsOpenAI,
  APIError,
  TimeoutError,
} from './index.js'

let passed = 0
let failed = 0

function ok(cond, m) {
  if (cond) {
    passed++
    console.log('  [32m✓[0m', m)
  } else {
    failed++
    console.error('  [31m✗ FAIL[0m', m)
  }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)})`}`)
}
async function test(name, fn) {
  console.log(`\n[${name}]`)
  try {
    await fn()
  } catch (e) {
    failed++
    console.error('  [31m✗ THROW[0m', e?.message || e)
    console.error(e?.stack)
  }
}

// ---------- mock helpers ----------
function mkHeaders(obj = {}) {
  const map = {}
  for (const k in obj) map[String(k).toLowerCase()] = obj[k]
  return {
    get: (k) => (k ? map[String(k).toLowerCase()] ?? null : null),
  }
}
function jsonRes(data, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: mkHeaders(headers),
    async text() {
      return JSON.stringify(data)
    },
  }
}
function errRes(status, error, headers = {}) {
  return {
    ok: false,
    status,
    headers: mkHeaders(headers),
    async text() {
      return JSON.stringify({ error })
    },
  }
}
function sseRes(sseString, { status = 200, headers = {} } = {}) {
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(sseString))
      c.close()
    },
  })
  return { ok: status >= 200 && status < 300, status, headers: mkHeaders(headers), body }
}
function counter() {
  const calls = { count: 0 }
  const fn = (responder) => async (url, opts) => {
    calls.count++
    return typeof responder === 'function' ? responder(calls.count, url, opts) : responder
  }
  return { calls, fn }
}

// ---------- 1. 非流式 + 解析 ----------
await test('非流式：返回 spec 原始响应 + 工具参数/推理解析', async () => {
  const canned = {
    id: 'chatcmpl-x',
    object: 'chat.completion',
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: '你好',
          reasoning_content: '我的思考',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
          ],
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  }
  const client = createClient({ ...presets.deepseek, fetch: async () => jsonRes(canned) })
  const res = await client.chat.completions.create({
    model: 'deepseek-chat',
    messages: [msg.user('hi')],
  })
  eq(res.id, 'chatcmpl-x', '原样透传 id')
  eq(res.choices[0].message.content, '你好', '提取 content')
  eq(
    extractReasoning(res.choices[0].message, client.reasoningFields),
    '我的思考',
    'extractReasoning 读到 reasoning_content',
  )
  eq(parseToolArguments(res.choices[0].message.tool_calls[0]), { a: 1 }, 'parseToolArguments 解析为对象')
})

// ---------- 2. 流式聚合 + 增量顺序 ----------
await test('流式：增量顺序与聚合结果', async () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":" world"}}]}',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"思A"}}]}',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"思B"}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"北京\\"}"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
    'data: [DONE]',
    '',
  ].join('\n\n')

  const client = createClient({ ...presets.deepseek, fetch: async () => sseRes(sse) })
  const stream = await client.chat.completions.create({
    model: 'deepseek-reasoner',
    messages: [msg.user('北京天气？')],
    stream: true,
    stream_options: { include_usage: true },
  })

  const contents = []
  const reasonings = []
  const toolNames = []
  for await (const part of stream) {
    if (part.delta.content) contents.push(part.delta.content)
    if (part.delta.reasoning) reasonings.push(part.delta.reasoning)
    if (part.delta.toolCalls) for (const t of part.delta.toolCalls) if (t.name) toolNames.push(t.name)
  }

  eq(contents, ['Hello', ' world'], 'content 增量顺序')
  eq(reasonings, ['思A', '思B'], 'reasoning 增量顺序（字段归一化）')
  eq(toolNames, ['get_weather'], '工具名增量')
  eq(stream.content, 'Hello world', '聚合 content')
  eq(stream.reasoning, '思A思B', '聚合 reasoning')
  eq(stream.finishReason, 'tool_calls', 'finishReason')
  eq(stream.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, 'usage 原样保留')
  eq(
    stream.toolCalls,
    [
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        name: 'get_weather',
        arguments: { city: '北京' },
        argumentsRaw: '{"city":"北京"}',
      },
    ],
    'toolCalls 聚合并解析参数',
  )
  eq(
    stream.assistantMessage,
    {
      role: 'assistant',
      content: 'Hello world',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
      ],
    },
    'assistantMessage spec 对齐',
  )
})

// ---------- 2b. 流式 CRLF 分隔（SSE 规范允许 \r\n\r\n；曾只切 '\n\n' 导致整流解析不出任何事件） ----------
await test('流式：CRLF 行尾服务端可正常解析', async () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"你"}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\r\n\r\n') + '\r\n\r\n'

  const client = createClient({ ...presets.deepseek, fetch: async () => sseRes(sse) })
  const stream = await client.chat.completions.create({ model: 'deepseek-chat', messages: [msg.user('hi')], stream: true })
  const contents = []
  for await (const part of stream) if (part.delta.content) contents.push(part.delta.content)
  eq(contents, ['Hi', '你'], 'CRLF 流增量顺序')
  eq(stream.content, 'Hi你', 'CRLF 流聚合 content')
  eq(stream.finishReason, 'stop', 'CRLF 流 finishReason')
})

// ---------- 3. 重试：429 → 200 ----------
await test('重试：429(rate_limit_exceeded) 后成功', async () => {
  const { calls, fn } = counter()
  const fetcher = fn((n) =>
    n === 1
      ? errRes(429, { message: 'rate', type: 'rate_limit_error', code: 'rate_limit_exceeded' }, { 'retry-after': '0' })
      : jsonRes({ id: 'ok', choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }),
  )
  const retries = []
  const client = createClient({
    ...presets.openai,
    fetch: fetcher,
    maxRetries: 4,
    retryDelay: () => 0,
    onRetry: (r) => retries.push(r),
  })
  const res = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [msg.user('x')] })
  eq(res.id, 'ok', '最终成功')
  eq(calls.count, 2, '共请求 2 次（1 失败 + 1 成功）')
  eq(retries.length, 1, 'onRetry 触发 1 次')
})

// ---------- 4. 400 不重试 ----------
await test('错误：400 不重试，抛 APIError', async () => {
  const { calls, fn } = counter()
  const fetcher = fn(() => errRes(400, { message: 'bad req', type: 'invalid_request_error', code: 'invalid_model' }))
  const client = createClient({ ...presets.openai, fetch: fetcher, maxRetries: 4, retryDelay: () => 0 })
  let caught = null
  try {
    await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [msg.user('x')] })
  } catch (e) {
    caught = e
  }
  ok(caught instanceof APIError, '抛出 APIError')
  eq(caught?.status, 400, 'status=400')
  eq(caught?.code, 'invalid_model', 'code 透传')
  eq(caught?.isRetryable, false, '不可重试')
  eq(calls.count, 1, '仅请求 1 次')
})

// ---------- 429 insufficient_quota 不重试 ----------
await test('错误：429 insufficient_quota 不重试', async () => {
  const { calls, fn } = counter()
  const fetcher = fn(() => errRes(429, { message: 'no quota', code: 'insufficient_quota' }))
  const client = createClient({ ...presets.openai, fetch: fetcher, maxRetries: 4, retryDelay: () => 0 })
  let caught = null
  try {
    await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [msg.user('x')] })
  } catch (e) {
    caught = e
  }
  eq(caught?.status, 429, 'status=429')
  eq(caught?.isRetryable, false, '额度不足不可重试')
  eq(calls.count, 1, '仅请求 1 次')
})

// ---------- 5. 超时 ----------
await test('超时：永不响应 → TimeoutError 并耗尽重试', async () => {
  const { calls, fn } = counter()
  const fetcher = fn((_n, _url, opts) =>
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      })
    }),
  )
  const client = createClient({
    ...presets.openai,
    fetch: fetcher,
    timeout: 20,
    maxRetries: 1,
    retryDelay: () => 0,
  })
  let caught = null
  try {
    await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [msg.user('x')] })
  } catch (e) {
    caught = e
  }
  ok(caught instanceof TimeoutError, '抛出 TimeoutError')
  eq(calls.count, 2, '尝试 2 次（maxRetries=1）')
})

// ---------- 6. 重新适配：MiMo 预设 + reasoning_content + 非标字段透传 ----------
await test('重新适配：MiMo 预设 baseURL + reasoning_content + 非标字段透传', async () => {
  let sentUrl = null
  let sentBody = null
  const fetcher = async (url, opts) => {
    sentUrl = url
    sentBody = JSON.parse(opts.body)
    return jsonRes({
      id: 'ok',
      choices: [{ index: 0, message: { role: 'assistant', content: '答案', reasoning_content: '推理' }, finish_reason: 'stop' }],
    })
  }
  const client = createClient({ ...presets.mimo, apiKey: 'sk-mimo', fetch: fetcher })
  const res = await client.chat.completions.create({
    model: 'mimo-v2.5-pro',
    messages: [msg.user('x')],
    thinking: { type: 'enabled' },
    temperature: 0.7,
  })
  ok(sentUrl.startsWith('https://api.xiaomimimo.com/v1/chat/completions'), 'MiMo OpenAI baseURL')
  eq(res.choices[0].message.reasoning_content, '推理', 'reasoning_content 透传')
  eq(extractReasoning(res.choices[0].message, client.reasoningFields), '推理', 'extractReasoning 读到 reasoning_content')
  eq(sentBody.thinking, { type: 'enabled' }, 'thinking 非标字段原样进 body')
  eq(sentBody.temperature, 0.7, 'temperature 透传')
})

// ---------- 6b. 重新适配：Moonshot 不再强制 temperature=1 ----------
await test('重新适配：Moonshot temperature 原样透传（移除强制钩子）', async () => {
  let sentUrl = null
  let sentBody = null
  const fetcher = async (url, opts) => {
    sentUrl = url
    sentBody = JSON.parse(opts.body)
    return jsonRes({ id: 'ok', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })
  }
  const client = createClient({ ...presets.moonshot, apiKey: 'k', fetch: fetcher })
  await client.chat.completions.create({
    model: 'kimi-k2.6',
    messages: [msg.user('x')],
    temperature: 0.3,
  })
  eq(sentBody.temperature, 0.3, 'temperature 原样保留（不再强制为 1）')
  ok(sentUrl.startsWith('https://api.moonshot.'), 'moonshot baseURL')
})

// ---------- 6c. MiniMax 预设：reasoning_split 注入（从根上避免 <think> 内联泄漏）----------
await test('MiniMax 预设：注入 reasoning_split + baseURL + reasoning_content', async () => {
  let sentUrl = null
  let sentBody = null
  const fetcher = async (url, opts) => {
    sentUrl = url
    sentBody = JSON.parse(opts.body)
    return jsonRes({ id: 'ok', choices: [{ index: 0, message: { role: 'assistant', content: '答案', reasoning_content: '推理' }, finish_reason: 'stop' }] })
  }
  const client = createClient({ ...presets.minimax, apiKey: 'sk-mm', fetch: fetcher })
  await client.chat.completions.create({
    model: 'MiniMax-M3',
    messages: [msg.user('x')],
    thinking: { type: 'adaptive' },
  })
  ok(sentUrl.startsWith('https://api.minimaxi.com/v1/chat/completions'), 'MiniMax OpenAI baseURL（中国区）')
  eq(sentBody.reasoning_split, true, '默认注入 reasoning_split:true（思考分离到 reasoning_content，避免 <think> 内联泄漏）')
  eq(sentBody.thinking, { type: 'adaptive' }, 'thinking 透传')
  eq(extractReasoning({ reasoning_content: 'r' }, client.reasoningFields), 'r', 'reasoningFields 含 reasoning_content')

  // 用户显式设置 reasoning_split 时不被覆盖
  const fetcher2 = async (url, opts) => { sentBody = JSON.parse(opts.body); return jsonRes({ id: 'ok', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }) }
  const client2 = createClient({ ...presets.minimax, apiKey: 'sk-mm', fetch: fetcher2 })
  await client2.chat.completions.create({ model: 'MiniMax-M3', messages: [msg.user('x')], reasoning_split: false })
  eq(sentBody.reasoning_split, false, '用户显式 reasoning_split:false 时不被 preset 覆盖')
})

// ---------- <think> 内联推理剥离（文档 §9.1：中间说明泄漏修复）----------
test('splitInlineThink 剥离内联 <think>', () => {
  // 1. 生产日志里的实际形态：思考 + 真实回复
  eq(
    splitInlineThink('<think>解除成功。回复用户即可。</think>\n\n已解禁 ✅ 3876826150 现在可以正常发言了').content,
    '已解禁 ✅ 3876826150 现在可以正常发言了',
    'think 块被剥离，只剩真实回复'
  )
  // 2. 思考内容路由到 reasoning
  eq(
    splitInlineThink('<think>我要澄清一下目标对象。</think>\n\n要禁言哪位群友呢？').reasoning,
    '我要澄清一下目标对象。',
    'think 内容进入 reasoning 通道'
  )
  // 3. 多个 think 块全剥离 + 与字段 reasoning 合并
  const r = splitInlineThink('<think>a</think>中间<think>b</think>正文', 'field')
  eq(r.content, '中间正文', '多个 think 块全剥离')
  eq(r.reasoning, 'field\n\na\n\nb', '字段 reasoning + 内联 think 合并')
  // 4. 无 think 标签：原样
  eq(splitInlineThink('普通回复', 'rr'), { content: '普通回复', reasoning: 'rr' }, '无 think 原样返回')
  // 5. 未闭合 think（流式残缺）：视为思考，content 清空
  eq(splitInlineThink('<think>未闭合的思考').content, '', '未闭合 think 视为思考丢弃')
  // 6. 容忍 <think> 上的属性
  eq(splitInlineThink('<think type="x">t</think>答案').content, '答案', '容忍 <think> 属性')
  // 7. 边界：空 content 安全
  eq(splitInlineThink('').content, '', '空 content 安全')
})

test('createThinkStripper 流式跨 delta 剥离', () => {
  // 整块在一个 delta
  const s = createThinkStripper()
  eq(s.feed('<think>x</think>ok'), 'ok', '整块一次 feed 剥离')
  // 标签拆到多个 delta
  const s2 = createThinkStripper()
  eq(s2.feed('abc<thi'), 'abc', '<thi 缓冲，abc 外发')
  eq(s2.feed('nk>隐藏'), '', '进入 think，隐藏不外发')
  eq(s2.feed('</thin'), '', '</thin 缓冲')
  eq(s2.feed('k>可见'), '可见', '闭合后外发可见')
  // 普通文本里的 < > 不误伤（只有尾部前缀才缓冲）
  const s3 = createThinkStripper()
  eq(s3.feed('a < b && c > d'), 'a < b && c > d', '普通 < > 不误伤')
  // 字面 "<thinking" 不含 '>'，不当作 think 标签
  const s4 = createThinkStripper()
  eq(s4.feed('see <thinking hard'), 'see <thinking hard', '字面 <think 前缀（无 >）不误剥')
})

// ---------- extractToolCallsOpenAI（文档 §9.2：tool_call 结构不丢失）----------
test('extractToolCallsOpenAI 兼容标准 + 旧版 function_call', () => {
  // 标准 chat-completions tool_calls
  const std = extractToolCallsOpenAI({ tool_calls: [
    { id: 'call_1', type: 'function', function: { name: 'group_mute', arguments: '{"userId":"123","duration":60}' } },
  ] })
  eq(std.length, 1, '标准 tool_calls 解析出 1 个')
  eq(std[0].id, 'call_1', '保留 id')
  eq(std[0].name, 'group_mute', '取到 name')
  eq(std[0].arguments, { userId: '123', duration: 60 }, 'arguments 解析为对象')
  // 多个并行工具调用
  const multi = extractToolCallsOpenAI({ tool_calls: [
    { id: 'a', function: { name: 'x', arguments: '{}' } },
    { id: 'b', function: { name: 'y', arguments: '{}' } },
  ] })
  eq(multi.map((t) => t.name).join(','), 'x,y', '多个工具调用都解析')
  // 旧版 v1 单调用 function_call（无 id → 合成）
  const legacy = extractToolCallsOpenAI({ function_call: { name: 'unban_user', arguments: '{"user_id":"387"}' } })
  eq(legacy.length, 1, '旧版 function_call 解析出 1 个')
  eq(legacy[0].name, 'unban_user', '旧版 name 取到')
  eq(legacy[0].arguments, { user_id: '387' }, '旧版 arguments 解析')
  ok(!!legacy[0].id, '旧版无 id 时合成 id（避免回传 tool_call_id 为空）')
  // 无工具调用
  eq(extractToolCallsOpenAI({ content: '纯文本回复' }), [], '无工具调用返回空数组')
  eq(extractToolCallsOpenAI({}), [], '空 message 安全')
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`[1m通过 ${passed}，失败 ${failed}[0m`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
