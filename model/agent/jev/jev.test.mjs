/**
 * 离线自检 —— Jev 接入：客户端错误分类/重试、决策置信度门控、回退、工具与 shell 风险。
 * 运行：node model/agent/jev/jev.test.mjs  （mock fetch，无需联网 / API Key）
 */
import { JevClient, JevError, createJevClient } from './client.js'
import {
  decideThinkingWithJev, selectToolsWithJev, assessShellRiskWithJev, decideReflectWithJev, evaluateShellRisk,
} from './decisions.js'
import { makeJevTool, validateJevInput } from './tool.js'
import { THRESHOLDS, resolveThresholds } from './spec.js'
import { Agent } from '../Agent.js'
import { ToolRegistry } from '../tools/registry.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** 造一个最小 Response：client 只读 ok/status/headers.get/text/json */
function res(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body) },
    async json() { if (typeof body === 'string') return JSON.parse(body); return body },
  }
}
const okBody = (answers, model = 'jev-1.13.0', usage = { input_tokens: 42, output_tokens: 0 }) => ({ answers, model, usage })

/** 记录调用次数并按序返回响应的 fetch */
function seqFetch(responses) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, opts })
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]
    if (typeof r === 'function') return r(url, opts, calls.length)
    return r
  }
  return { fn, calls }
}

await test('client：成功解析 answers/model/usage，且 Authorization 带 key', async () => {
  const { fn, calls } = seqFetch([res(200, okBody({ x: { type: 'noul', noul: 0.9 } }))])
  const c = new JevClient({ apiKey: 'tsk_secret', fetch: fn })
  const r = await c.systemOne({ state: { message: 'hi' }, questions: { x: { type: 'noul', instructions: 'Is `message` hi?' } } })
  eq(r.answers.x.noul, 0.9, '答案透传')
  eq(r.model, 'jev-1.13.0', '模型版本')
  eq(calls.length, 1, '仅一次调用')
  ok(calls[0].opts.headers.Authorization === 'Bearer tsk_secret', 'Authorization 头正确')
  ok(!JSON.stringify(calls[0].opts.headers).includes('undefined'), '头部无 undefined')
  eq(calls[0].url, 'https://api.typesafe.ai/v1/systemone', '默认端点')
})

await test('client：401/422 不重试（配置/请求错误）', async () => {
  const a = seqFetch([res(401, { error: 'bad key' })])
  const c1 = new JevClient({ apiKey: 'k', fetch: a.fn, retry: { backoffInitialMs: 1 } })
  let e1 = null
  try { await c1.systemOne({ state: {}, questions: { q: { type: 'noul', instructions: 'x' } } }) } catch (e) { e1 = e }
  ok(e1 instanceof JevError && e1.kind === 'auth' && e1.retriable === false, '401 → auth 不重试')
  eq(a.calls.length, 1, '401 只调一次')

  const b = seqFetch([res(422, { error: 'bad field' })])
  const c2 = new JevClient({ apiKey: 'k', fetch: b.fn, retry: { backoffInitialMs: 1 } })
  let e2 = null
  try { await c2.systemOne({ state: {}, questions: { q: { type: 'noul', instructions: 'x' } } }) } catch (e) { e2 = e }
  ok(e2?.kind === 'invalid_request' && e2.retriable === false, '422 → invalid_request 不重试')
  eq(b.calls.length, 1, '422 只调一次')
})

await test('client：429 遵守 Retry-After 后退避重试，最终成功', async () => {
  const { fn, calls } = seqFetch([
    res(429, { error: 'slow down' }, { 'retry-after-ms': '5' }),
    res(200, okBody({ q: { type: 'noul', noul: 0.5 } })),
  ])
  const c = new JevClient({ apiKey: 'k', fetch: fn, maxRetries: 2, retry: { backoffInitialMs: 1 } })
  const t0 = Date.now()
  const r = await c.systemOne({ state: {}, questions: { q: { type: 'noul', instructions: 'x' } } })
  ok(r.answers.q.noul === 0.5, '重试后成功')
  eq(calls.length, 2, '429 触发一次重试')
  ok(Date.now() - t0 >= 4, '等待了 Retry-After（≥5ms 量级）')
})

await test('client：5xx 指数退避重试至上限后抛出', async () => {
  const { fn, calls } = seqFetch([res(503, { error: 'overloaded' })])
  const c = new JevClient({ apiKey: 'k', fetch: fn, maxRetries: 2, retry: { backoffInitialMs: 1 } })
  let e = null
  try { await c.systemOne({ state: {}, questions: { q: { type: 'noul', instructions: 'x' } } }) } catch (err) { e = err }
  ok(e?.kind === 'server' && e.retriable === true, '503 → server 可重试')
  eq(calls.length, 3, '1 次 + 2 重试')
})

await test('client：网络错误重试；超时可重试；取消不重试', async () => {
  let n = 0
  const netFail = async () => { n++; throw new Error('ECONNRESET') }
  const c = new JevClient({ apiKey: 'k', fetch: netFail, maxRetries: 1, retry: { backoffInitialMs: 1 } })
  let e = null
  try { await c.systemOne({ state: {}, questions: { q: { type: 'noul', instructions: 'x' } } }) } catch (err) { e = err }
  ok(e?.kind === 'network', '网络错误归类')
  eq(n, 2, '网络错误重试一次')

  // 超时：fetch 监听 signal，abort 时 reject（模拟真实 fetch）
  const timeoutFetch = (url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
  const c2 = new JevClient({ apiKey: 'k', fetch: timeoutFetch, timeout: 10, maxRetries: 0 })
  let e2 = null
  try { await c2.systemOne({ state: {}, questions: { q: { type: 'noul', instructions: 'x' } } }) } catch (err) { e2 = err }
  ok(e2?.kind === 'timeout' && e2.retriable === true, '超时归类且可重试')

  const ac = new AbortController()
  ac.abort()
  const c3 = new JevClient({ apiKey: 'k', fetch: netFail, maxRetries: 2 })
  let e3 = null
  try { await c3.systemOne({ state: {}, questions: { q: { type: 'noul', instructions: 'x' } }, signal: ac.signal }) } catch (err) { e3 = err }
  ok(e3?.kind === 'aborted' && e3.retriable === false, '已取消 → aborted 不重试')
})

await test('createJevClient：无 apiKey 返回 null（fail-closed）', async () => {
  eq(createJevClient({ apiKey: '' }), null, '空 key → null')
  const c = createJevClient({ apiKey: 'tsk_x', baseURL: 'https://proxy.local', model: 'jev-latest' })
  ok(c instanceof JevClient && c.configured, '有 key → 可用客户端')
  eq(c.baseURL, 'https://proxy.local', 'baseURL 覆盖')
})

await test('decideThinkingWithJev：高置信采用、低置信/失败回退 null', async () => {
  const mk = (body) => new JevClient({ apiKey: 'k', fetch: async () => res(200, body) })
  const hi = mk(okBody({ depth: { type: 'choice', choice: 'high', confidence: 0.95 } }))
  const r = await decideThinkingWithJev({ client: hi, text: '设计分布式架构', protocol: 'openai', preset: 'mimo' })
  eq(r.depth, 'high', '高置信 → high')
  eq(r.source, 'jev', '来源 jev')
  eq(r.thinking, { type: 'enabled' }, '编码思考开启')
  ok(r.jevModel === 'jev-1.13.0' && r.jevUsage.input_tokens === 42, '记录 model/usage')

  const lo = mk(okBody({ depth: { type: 'choice', choice: 'high', confidence: 0.2 } }))
  eq(await decideThinkingWithJev({ client: lo, text: 'x' }), null, '低置信 → null（回退）')

  const bad = mk(okBody({ depth: { type: 'choice', choice: 'extreme', confidence: 0.99 } }))
  eq(await decideThinkingWithJev({ client: bad, text: 'x' }), null, '非法档位 → null')

  const err = new JevClient({ apiKey: 'k', fetch: async () => { throw new Error('boom') }, maxRetries: 0 })
  eq(await decideThinkingWithJev({ client: err, text: 'x' }), null, '调用失败 → null')

  eq(await decideThinkingWithJev({ client: null, text: 'x' }), null, '未配置 → null')
})

await test('selectToolsWithJev：按 noul 阈值聚合，忽略低于阈值/非法的项', async () => {
  const client = new JevClient({
    apiKey: 'k',
    fetch: async () => res(200, okBody({
      tool_0: { type: 'noul', noul: 0.92 },
      tool_1: { type: 'noul', noul: 0.3 },
      tool_2: { type: 'noul', noul: 'NaN' },
    })),
  })
  const catalog = [{ name: 'terminal', summary: 'run shell' }, { name: 'web_search', summary: 'search' }, { name: 'pixiv', summary: 'pixiv' }]
  const r = await selectToolsWithJev({ client, catalog, request: '在沙箱跑个脚本' })
  eq(r.selected, ['terminal'], '仅高概率工具被选中')
  eq(r.candidateCount, 3, '候选数')
  eq(await selectToolsWithJev({ client: null, catalog, request: 'x' }), null, '未配置 → null')
  eq(await selectToolsWithJev({ client, catalog: [], request: 'x' }), null, '空目录 → null')
})

await test('assessShellRiskWithJev + evaluateShellRisk：破坏性默认拒绝，allowDestructive 才高置信放行', async () => {
  const mk = (body) => new JevClient({ apiKey: 'k', fetch: async () => res(200, body) })
  const dest = await assessShellRiskWithJev({ client: mk(okBody({ risk: { type: 'choice', choice: 'destructive', confidence: 0.33 } })), command: 'rm -rf /' })
  const v1 = evaluateShellRisk(dest)
  eq(v1.allow, false, '破坏性低置信 → 拒绝')
  ok(/默认拒绝/.test(v1.reason), '默认拒绝原因可读')

  const destHi = await assessShellRiskWithJev({ client: mk(okBody({ risk: { type: 'choice', choice: 'destructive', confidence: 0.95 } })), command: 'rm -rf /tmp/x' })
  eq(evaluateShellRisk(destHi).allow, false, '破坏性高置信但未开 allowDestructive → 仍拒绝（fail-closed）')
  eq(evaluateShellRisk(destHi, {}, { allowDestructive: true }).allow, true, 'allowDestructive=true 且高置信 → 放行')
  eq(evaluateShellRisk(dest, {}, { allowDestructive: true }).allow, false, 'allowDestructive=true 但低置信 → 拒绝')

  const ro = await assessShellRiskWithJev({ client: mk(okBody({ risk: { type: 'choice', choice: 'readonly', confidence: 0.3 } })), command: 'ls -la' })
  eq(evaluateShellRisk(ro).allow, true, '只读低置信仍放行（不静默阻断正常命令）')

  const bad = await assessShellRiskWithJev({ client: mk(okBody({ risk: { type: 'choice', choice: 'nonsense', confidence: 0.9 } })), command: 'x' })
  eq(bad, null, '非法风险档 → null')
  eq(evaluateShellRisk(null).fallback, true, '不可用 → fallback 放行')
  ok(evaluateShellRisk(null).allow, '不可用不阻断')
})

await test('client：连续失败达阈值后熔断，冷却期内不再发请求（circuit_open）', async () => {
  let calls = 0
  const fail = async () => { calls++; return res(503, { error: 'overloaded' }) }
  const c = new JevClient({ apiKey: 'k', fetch: fail, maxRetries: 0, circuit: { failureThreshold: 2, cooldownMs: 10000 } })
  const one = async () => { try { await c.systemOne({ state: {}, questions: { q: { type: 'noul', instructions: 'x' } } }); return null } catch (e) { return e } }
  const e1 = await one(); ok(e1?.kind === 'server', '第 1 次失败')
  const e2 = await one(); ok(e2?.kind === 'server', '第 2 次失败（达阈值）')
  const before = calls
  const e3 = await one(); ok(e3?.kind === 'circuit_open' && e3.retriable === false, '熔断后直接 circuit_open')
  eq(calls, before, '熔断期内未再发请求')
})

await test('validateJevInput / makeJevTool：结构校验 + 成功/失败返回', async () => {
  eq(validateJevInput('hi', { q: { type: 'noul', instructions: 'ok?' } }), null, '合法输入通过')
  ok(/type/.test(validateJevInput({}, { q: { type: 'bad', instructions: 'x' } })), '非法 type 拒绝')
  ok(/instructions/.test(validateJevInput({}, { q: { type: 'noul' } })), '缺 instructions 拒绝')
  ok(/criteria/.test(validateJevInput({}, { q: { type: 'choice', instructions: 'x' } })), 'choice 缺 criteria 拒绝')
  ok(/state/.test(validateJevInput(null, {})), 'state 非法拒绝')
  ok(/过大/.test(validateJevInput('x'.repeat(50), { q: { type: 'noul', instructions: 'x' } }, { maxStateChars: 10 })), 'state 过大拒绝')

  const client = new JevClient({ apiKey: 'k', fetch: async () => res(200, okBody({ q: { type: 'noul', noul: 0.8 } })) })
  const tool = makeJevTool({ client })
  const out = await tool.execute({ state: { m: 'x' }, questions: { q: { type: 'noul', instructions: 'is `m` x?' } } })
  eq(out.answers.q.noul, 0.8, '工具成功返回答案')
  eq(out.model, 'jev-1.13.0', '工具返回 model')
  const bad = await tool.execute({ state: {}, questions: { q: { type: 'bad', instructions: 'x' } } })
  ok(!!bad.error, '工具对非法输入返回 error 而非抛错')
  const off = await makeJevTool({ client: null }).execute({ state: {}, questions: {} })
  ok(/未配置/.test(off.error), '未配置工具返回 error')
})

await test('Agent 集成：Jev 判档失败 → 回退规则；工具选择写入 activeTools', async () => {
  // 1) thinking 回退：Jev client 抛错，闲聊文本 → 规则判 off（thinking disabled）
  const hist1 = []
  const provider1 = { async chat(o) { hist1.push(o); return { content: 'ok', finishReason: 'stop' } } }
  const failingJev = {
    client: { configured: true, async systemOne() { throw new Error('down') } },
    decisions: { thinking: true }, thresholds: {},
  }
  await new Agent({ provider: provider1, maxTurns: 2, reflect: 'off', thinkingAuto: { enable: true }, thinkingCapable: true, protocol: 'openai', preset: 'mimo', jev: failingJev })
    .run('在吗', { ctx: { userId: 'u1', groupId: 'g1' } })
  eq(hist1[0].thinking, { type: 'disabled' }, 'Jev 失败 → 回退规则（闲聊 off）')

  // 2) toolSelection：Jev 对 web_search 高概率 → 激活并进入 tools
  const tools = new ToolRegistry()
  tools.register(
    { name: 'web_search', description: '搜索网页', parameters: { type: 'object', properties: {}, required: [] }, async execute() { return 'r' } },
    { name: 'terminal', description: '沙箱执行', parameters: { type: 'object', properties: {}, required: [] }, async execute() { return 'r' } },
  )
  const hist2 = []
  const provider2 = { async chat(o) { hist2.push(o); return { content: 'ok', finishReason: 'stop' } } }
  const jevSel = {
    client: {
      configured: true,
      async systemOne() { return { answers: { tool_0: { type: 'noul', noul: 0.95 }, tool_1: { type: 'noul', noul: 0.1 } }, model: 'jev-1.13.0', usage: { input_tokens: 10 } } },
    },
    decisions: { toolSelection: true }, thresholds: {}, toolSelectionMaxTools: 10,
  }
  const agent = new Agent({ provider: provider2, tools, maxTurns: 1, reflect: 'off', toolDiscovery: { enable: true, alwaysOn: ['tool_search'] }, jev: jevSel })
  await agent.run('帮我搜一下今天的新闻', { ctx: { userId: 'u1', groupId: 'g1' } })
  const sent = (hist2[0].tools || []).map((t) => t.name)
  ok(sent.includes('web_search'), 'Jev 选中的 web_search 进入 tools')
  ok(!sent.includes('terminal'), '未选中的 terminal 不进入 tools')

  // 3) 纯寒暄不触发 Jev 工具选择（高价值轮次门）
  let casualCalls = 0
  const jevCasual = {
    client: { configured: true, async systemOne() { casualCalls++; return { answers: {}, model: 'm', usage: {} } } },
    decisions: { toolSelection: true }, thresholds: {}, toolSelectionMaxTools: 10,
  }
  await new Agent({ provider: provider2, tools, maxTurns: 1, reflect: 'off', toolDiscovery: { enable: true, alwaysOn: ['tool_search'] }, jev: jevCasual })
    .run('在吗', { ctx: { userId: 'u1', groupId: 'g1' } })
  eq(casualCalls, 0, '闲聊「在吗」不调用 Jev 工具选择')

  // 4) Jev 激活但未实际调用的工具不跨轮持久化（防工具集膨胀）
  const store = { messages: [], extra: null }
  const session = {
    async getConversation() { return store.messages },
    async getConversationState() { return store.extra || {} },
    async appendConversation(u, g, c, m, e) { store.messages.push(...m); store.extra = e },
    async setConversation(u, g, c, m, e) { store.messages = m; store.extra = e },
    key() { return 'k' }, async get() { return [] }, async set() {},
  }
  let tn = 0
  const provider3 = {
    async chat() {
      tn++
      if (tn === 1) return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: '1', name: 'web_search', arguments: {} }] }
      return { content: 'done', finishReason: 'stop' }
    },
  }
  const jevBoth = {
    client: { configured: true, async systemOne() { return { answers: { tool_0: { type: 'noul', noul: 0.95 }, tool_1: { type: 'noul', noul: 0.95 } }, model: 'm', usage: {} } } },
    decisions: { toolSelection: true }, thresholds: {}, toolSelectionMaxTools: 10,
  }
  await new Agent({ provider: provider3, tools, session, maxTurns: 3, reflect: 'off', toolDiscovery: { enable: true, alwaysOn: ['tool_search'] }, jev: jevBoth })
    .run('帮我执行一个任务', { ctx: { userId: 'u1', groupId: 'g1', conversationId: 'c1' } })
  const persisted = store.extra.activeTools
  ok(persisted.includes('web_search'), '实际调用过的工具跨轮持久化')
  ok(!persisted.includes('terminal'), 'Jev 激活但未调用的工具不跨轮持久化')
})

await test('decideReflectWithJev：按 noul 阈值判定，失败回退 null', async () => {
  const mk = (body) => new JevClient({ apiKey: 'k', fetch: async () => res(200, body) })
  const yes = await decideReflectWithJev({ client: mk(okBody({ reflect: { type: 'noul', noul: 0.9 } })), request: 'q', draft: 'd' })
  eq(yes.revise, true, '高概率 → 需要反思')
  const no = await decideReflectWithJev({ client: mk(okBody({ reflect: { type: 'noul', noul: 0.1 } })), request: 'q', draft: 'd' })
  eq(no.revise, false, '低概率 → 不需要反思')
  eq(await decideReflectWithJev({ client: null, request: 'q', draft: 'd' }), null, '未配置 → null')
  eq(await decideReflectWithJev({ client: mk(okBody({})), request: 'q', draft: '' }), null, '空草稿 → null')
})

await test('Agent：shell 自定义拦截命中即拒绝（确定性，不执行、不调 Jev）', async () => {
  const tools = new ToolRegistry()
  let executed = 0
  tools.register({ name: 'terminal', description: '沙箱执行', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, meta: { shell: true }, async execute() { executed++; return 'ran' } })
  let jevCalled = 0
  const provider = { async chat() { return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: '1', name: 'terminal', arguments: { command: 'rm -rf /data' } }] } } }
  const jev = { client: { configured: true, async systemOne() { jevCalled++; return { answers: {}, model: 'm', usage: {} } } }, decisions: { terminalRisk: true }, thresholds: {} }
  const agent = new Agent({ provider, tools, maxTurns: 2, reflect: 'off', shellIntercept: ['rm -rf /'], jev })
  await agent.run('清理一下数据', { ctx: { userId: 'u', groupId: 'g' } })
  eq(executed, 0, '命中拦截的命令不执行')
  eq(jevCalled, 0, '本地拦截优先于 Jev（不发往第三方）')
  const toolMsg = agent.messages.find((m) => m.role === 'tool' && m.name === 'terminal')
  ok(/rejected_by_shell_intercept/.test(toolMsg?.content || ''), '返回结构化拦截错误')
})

await test('Agent：reflect=jev 由 Jev 判定是否反思', async () => {
  const tools = new ToolRegistry()
  tools.register({ name: 'noop', description: 'x', parameters: { type: 'object', properties: {}, required: [] }, async execute() { return 'r' } })
  const mkAgent = (noul) => {
    const provider = { async chat() { return { content: '草稿回复', finishReason: 'stop' } } }
    const jev = { client: { configured: true, async systemOne() { return { answers: { reflect: { type: 'noul', noul } }, model: 'm', usage: {} } } }, decisions: { reflect: true }, thresholds: {} }
    return new Agent({ provider, tools, maxTurns: 2, reflect: 'jev', jev })
  }
  const a1 = mkAgent(0.9)
  eq(await a1._shouldReflect(false, 1, 'draft'), true, 'Jev 高概率 → 反思')
  const a2 = mkAgent(0.1)
  eq(await a2._shouldReflect(false, 1, 'draft'), false, 'Jev 低概率 → 不反思（闲聊也不反思）')
})

await test('Agent：Jev 决策写入 devLog（jev 事件）并打印 [jev] info 日志', async () => {
  const events = []
  const logs = []
  const tools = new ToolRegistry()
  tools.register({ name: 'web_search', description: '搜索', parameters: { type: 'object', properties: {}, required: [] }, async execute() { return 'r' } })
  const provider = { async chat() { return { content: 'ok', finishReason: 'stop' } } }
  const jev = {
    client: { configured: true, async systemOne() { return { answers: { tool_0: { type: 'noul', noul: 0.9 } }, model: 'jev-1.3.0', usage: { input_tokens: 12 } } } },
    decisions: { toolSelection: true, thinking: true }, thresholds: {}, toolSelectionMaxTools: 10,
  }
  const agent = new Agent({
    provider, tools, maxTurns: 1, reflect: 'off',
    logger: (lvl, ...a) => logs.push([lvl, ...a]),
    devLog: (e, d) => events.push({ event: e, ...d }),
    toolDiscovery: { enable: true, alwaysOn: ['tool_search'] },
    thinkingAuto: { enable: true }, thinkingCapable: true, protocol: 'openai', preset: 'mimo', jev,
  })
  await agent.run('帮我搜一下今天的新闻', { ctx: { userId: 'u', groupId: 'g' } })
  const jevEvents = events.filter((e) => e.event === 'jev')
  ok(jevEvents.some((e) => e.kind === 'tool_select' && (e.selected || []).includes('web_search')), 'devLog 含 jev tool_select（含 selected）')
  ok(jevEvents.some((e) => e.kind === 'thinking'), 'devLog 含 jev thinking')
  ok(logs.some(([lvl, msg]) => lvl === 'info' && String(msg).startsWith('[jev]')), '控制台 info 打印 [jev] 日志')
})

await test('Agent：shell 工具执行写入 devLog sandbox 事件', async () => {
  const events = []
  const tools = new ToolRegistry()
  tools.register({ name: 'terminal', description: 'x', meta: { shell: true }, parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, async execute() { return { command: 'ls', exitCode: 0, ok: true, stdout: 'a' } } })
  let n = 0
  const provider = { async chat() { n++; if (n === 1) return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: '1', name: 'terminal', arguments: { command: 'ls' } }] }; return { content: 'done', finishReason: 'stop' } } }
  const agent = new Agent({ provider, tools, maxTurns: 3, reflect: 'off', devLog: (e, d) => events.push({ event: e, ...d }) })
  await agent.run('执行 ls', { ctx: { userId: 'u', groupId: 'g' } })
  const sb = events.find((e) => e.event === 'sandbox')
  ok(sb && sb.command === 'ls' && sb.exitCode === 0, 'devLog 含 sandbox 事件（命令/退出码）')
})

await test('resolveThresholds：默认值兜底 + 用户覆盖', async () => {
  eq(resolveThresholds({}).toolNoulFloor, THRESHOLDS.toolNoulFloor, '空覆盖 → 默认')
  eq(resolveThresholds({ toolNoulFloor: 0.8 }).toolNoulFloor, 0.8, '数值覆盖生效')
  eq(resolveThresholds({ toolNoulFloor: 'x' }).toolNoulFloor, THRESHOLDS.toolNoulFloor, '非法覆盖 → 默认兜底')
})

console.log(`\n========================================`)
console.log(`jev 测试：通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
process.exit(failed > 0 ? 1 : 0)
