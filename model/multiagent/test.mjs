/**
 * 离线自检 —— mock provider 驱动 Multi-Agent 全流程。
 * 运行：node model/multiagent/test.mjs
 */
import {
  Orchestrator,
  SubagentSpec,
  makeSpawnSubagentTools,
  makeDelegationTool,
  normalizeSubagentResult,
  pipeline,
  parallel,
  router,
  evaluatorOptimizer,
  Semaphore,
  Trace,
  SharedState,
} from './index.js'
import { ToolRegistry } from '../agent/tools/registry.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function mockProvider(responses) {
  let i = 0
  const calls = { count: 0 }
  return {
    calls,
    async chat(opts) {
      calls.count++
      const r = responses[Math.min(i, responses.length - 1)]
      i++
      return { role: 'assistant', content: r.content ?? '', toolCalls: r.toolCalls || [], reasoning: null, finishReason: r.finishReason || 'stop', usage: null, rawMessage: {} }
    },
  }
}

// ---------- 1. SubagentSpec.runTask ----------
await test('SubagentSpec：隔离上下文 + 压缩返回', async () => {
  const sp = mockProvider([{ content: '研究结果：趋势向上', finishReason: 'stop' }])
  const spec = new SubagentSpec({ name: 'tester', description: '测试', provider: sp, model: 'cheap', maxTurns: 3 })
  const result = await spec.runTask('分析趋势')
  eq(result, '研究结果：趋势向上', '返回 content')
  eq(sp.calls.count, 1, '底层 provider 调用 1 次')
})

// ---------- 2. Orchestrator 端到端（单委派 + 综合） ----------
await test('Orchestrator：分解→委派→综合（trace 验证）', async () => {
  const subProv = mockProvider([{ content: '子代理发现了重要信息', finishReason: 'stop' }])
  const researcher = new SubagentSpec({ name: 'researcher', description: '研究', provider: subProv, model: 'cheap', maxTurns: 3 })

  const orchProv = mockProvider([
    { toolCalls: [{ id: 'd1', name: 'delegate__researcher', arguments: { task: '研究 AI Agent 趋势' } }], finishReason: 'tool_calls' },
    { content: '综合报告：基于研究结果', finishReason: 'stop' },
  ])
  const orch = new Orchestrator({ provider: orchProv, model: 'flagship', subagents: [researcher], maxTurns: 5, maxConcurrent: 2 })

  const result = await orch.run('深度研究 AI Agent')
  eq(result.content, '综合报告：基于研究结果', '最终综合')
  eq(orch.trace.filter('delegate:start').length, 1, 'trace: 1 个 delegate:start')
  eq(orch.trace.filter('delegate:end').length, 1, 'trace: 1 个 delegate:end')
  eq(subProv.calls.count, 1, '子代理调用 1 次')
  eq(orchProv.calls.count, 3, 'orchestrator 调用 3 次（委派+综合+reflect 自检；Agent 默认 reflect=auto，用了 delegate 工具触发交付前自检）')
})

// ---------- 3. Orchestrator 并行委派 ----------
await test('Orchestrator：并行委派 2 个子代理', async () => {
  const subProv = mockProvider([{ content: '结果', finishReason: 'stop' }])
  const r1 = new SubagentSpec({ name: 'r1', provider: subProv, model: 't' })
  const r2 = new SubagentSpec({ name: 'r2', provider: subProv, model: 't' })

  const orchProv = mockProvider([
    { toolCalls: [
      { id: 'd1', name: 'delegate__r1', arguments: { task: '任务1' } },
      { id: 'd2', name: 'delegate__r2', arguments: { task: '任务2' } },
    ], finishReason: 'tool_calls' },
    { content: '综合', finishReason: 'stop' },
  ])
  const orch = new Orchestrator({ provider: orchProv, subagents: [r1, r2], maxTurns: 5, maxConcurrent: 2 })
  await orch.run('并行研究')
  eq(orch.trace.filter('delegate:start').length, 2, '2 个 delegate:start（并行）')
  eq(subProv.calls.count, 2, '子代理共调用 2 次')
})

// ---------- 4. Pipeline ----------
await test('pipeline：顺序链 + 链式传递', async () => {
  const pipe = pipeline([
    (input) => `s1(${input})`,
    (input) => `s2(${input})`,
    (input) => `s3(${input})`,
  ])
  eq(await pipe.run('hello'), 's3(s2(s1(hello)))', '链式传递')
})

// ---------- 5. Parallel + aggregate ----------
await test('parallel：扇出 + 聚合', async () => {
  const par = parallel(
    [(input) => `A(${input})`, (input) => `B(${input})`, (input) => `C(${input})`],
    { aggregate: (results) => results.join('|') },
  )
  eq(await par.run('x'), 'A(x)|B(x)|C(x)', '聚合')
})

// ---------- 6. Router ----------
await test('router：分类 + 兜底', async () => {
  const rt = router({
    classify: (input) => (input.includes('退款') ? 'refund' : 'other'),
    routes: { refund: (input) => `退款:${input}` },
    default: (input) => `通用:${input}`,
  })
  eq(await rt.run('我要退款'), '退款:我要退款', '命中 refund')
  eq(await rt.run('你好'), '通用:你好', '兜底')
})

// ---------- 7. Evaluator-Optimizer ----------
await test('evaluatorOptimizer：生成→评估→重生成→达标', async () => {
  let genCount = 0
  const eo = evaluatorOptimizer({
    generator: (input) => {
      genCount++
      if (typeof input === 'string') return '草稿'
      return `修订(${input.feedback})`
    },
    evaluator: ({ draft }) => (draft.includes('修订') ? { score: 0.9, feedback: '' } : { score: 0.3, feedback: '不够好' }),
    maxIterations: 3,
    threshold: 0.8,
  })
  const result = await eo.run('写报告')
  eq(result, '修订(不够好)', '重生成后达标')
  eq(genCount, 2, 'generator 调用 2 次（初始+重生成）')
})

// ---------- 8. Semaphore ----------
await test('Semaphore：并发限制', async () => {
  const sem = new Semaphore(1)
  let active = 0
  let maxActive = 0
  const task = async () => {
    await sem.acquire()
    active++
    maxActive = Math.max(maxActive, active)
    await delay(10)
    active--
    sem.release()
  }
  await Promise.all([task(), task(), task()])
  eq(maxActive, 1, '最大并发 1')
  eq(sem.active, 0, '全部释放后 active=0')
})

// ---------- 9. Trace + SharedState ----------
await test('Trace + SharedState', async () => {
  const t = new Trace()
  t.emit('x', { a: 1 })
  t.emit('y', { b: 2 })
  t.emit('x', { a: 3 })
  eq(t.events.length, 3, '3 个事件')
  eq(t.filter('x').length, 2, 'filter x → 2')
  eq(t.filter('x')[1].data.a, 3, '第二个 x data')

  const s = new SharedState({ x: 1 })
  s.set('y', 2)
  eq(s.get('x'), 1, 'get x')
  eq(s.get('y'), 2, 'get y')
  s.update({ z: 3 })
  eq(s.toJSON(), { x: 1, y: 2, z: 3 }, 'toJSON')
  ok(s.keys.includes('z'), 'keys 含 z')
})

// ---------- 10. spawn 三件套：配额按会话隔离 + taskId 归属校验 ----------
const doneProvider = () => ({ async chat() { return { role: 'assistant', content: 'ok', toolCalls: [], finishReason: 'stop', usage: null } } })

await test('spawn 三件套：配额按会话隔离，跨会话不可读', async () => {
  const [spawn, check] = makeSpawnSubagentTools({
    provider: doneProvider(), sourceRegistry: null, maxSpawns: 2, maxConcurrent: 1, minBudgetMs: 10000, hardGraceMs: 200,
  })
  const A = { userId: 'uA', groupId: 'gA', conversationId: 'cA' }
  const B = { userId: 'uB', groupId: 'gB', conversationId: 'cB' }
  eq((await spawn.execute({ task: 't1' }, A)).ok, true, 'A 第 1 次')
  eq((await spawn.execute({ task: 't2' }, A)).ok, true, 'A 第 2 次')
  ok(!!(await spawn.execute({ task: 't3' }, A)).error, 'A 超出本会话上限被拒')
  const rb = await spawn.execute({ task: 't4' }, B)
  eq(rb.ok, true, 'B 不受 A 配额影响（按会话隔离）')
  const cross = await check.execute({ taskId: rb.taskId }, A)
  ok(!!cross.error && /无权/.test(cross.error), 'A 读 B 的任务被拒（归属校验）')
  const own = await check.execute({ taskId: rb.taskId, waitMs: 0 }, B)
  eq(own.taskId, rb.taskId, 'B 读自己的任务 OK')
})

// ---------- 10b. check_subagent 长轮询：一次调用等到完成，不烧模型轮次 ----------
await test('check_subagent：waitMs 长轮询等到完成并返回结果', async () => {
  const slowProv = { async chat() { await delay(300); return { role: 'assistant', content: '最终研究结论', toolCalls: [], finishReason: 'stop', usage: null } } }
  const [spawn, check] = makeSpawnSubagentTools({ provider: slowProv, sourceRegistry: null, maxConcurrent: 1, minBudgetMs: 10000 })
  const ctx = { userId: 'u', conversationId: 'c' }
  const r = await spawn.execute({ task: '慢任务' }, ctx)
  const t0 = Date.now()
  const s = await check.execute({ taskId: r.taskId, waitMs: 5000 }, ctx)
  eq(s.status, 'done', '长轮询直接等到 done（无需多次轮询）')
  eq(s.result, '最终研究结论', '返回完整结果')
  ok(Date.now() - t0 >= 250 && Date.now() - t0 < 5000, `等待了一个子代理周期（${Date.now() - t0}ms）而非立即返回`)
})

// ---------- 11. spawn 三件套：硬超时释放并发槽 + 超时判定 ----------
await test('spawn 三件套：不响应取消的 worker 被硬判超时并释放并发槽', async () => {
  let mode = 'hang'
  const prov = {
    async chat() {
      if (mode === 'hang') return new Promise(() => {}) // 永不 settle，且忽略 abort signal
      return { role: 'assistant', content: 'done', toolCalls: [], finishReason: 'stop', usage: null }
    },
  }
  const [spawn, check] = makeSpawnSubagentTools({ provider: prov, sourceRegistry: null, maxConcurrent: 1, minBudgetMs: 40, hardGraceMs: 60 })
  const ctx = { userId: 'u', conversationId: 'c' }
  const r1 = await spawn.execute({ task: 'hang', timeBudgetMs: 40 }, ctx)
  await delay(220) // 40ms 预算 + 60ms 硬宽限 + 余量
  const s1 = await check.execute({ taskId: r1.taskId }, ctx)
  eq(s1.status, 'timeout', '不响应取消的 worker 被判 timeout')
  ok(/未响应|预算/.test(String(s1.error)), '超时原因可读')
  // 并发槽已释放（maxConcurrent=1）：下一个任务能真正运行并完成
  mode = 'ok'
  const r2 = await spawn.execute({ task: 'second', timeBudgetMs: 5000 }, ctx)
  await delay(120)
  const s2 = await check.execute({ taskId: r2.taskId }, ctx)
  eq(s2.status, 'done', '硬超时后并发槽释放，后续任务可运行')
})

// ---------- 12. spawn 三件套：身份 ctx 下传（memory_search 可用）----------
await test('spawn 三件套：身份 ctx 下传，子代理 query 工具可用', async () => {
  let seenCtx = null
  const reg = new ToolRegistry().register({
    name: 'memory_search', category: 'query', description: '检索记忆',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async execute(_p, ctx) { seenCtx = ctx; return { found: 1, text: '记忆内容' } },
  })
  let calls = 0
  const workerProv = {
    async chat() {
      calls++
      if (calls === 1) return { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'memory_search', arguments: { query: '偏好' } }], finishReason: 'tool_calls', usage: null }
      return { role: 'assistant', content: '基于记忆的结论', toolCalls: [], finishReason: 'stop', usage: null }
    },
  }
  const [spawn, check] = makeSpawnSubagentTools({ provider: workerProv, sourceRegistry: reg, defaultTools: ['memory_search'], maxConcurrent: 1, minBudgetMs: 10000 })
  const ctx = { userId: 'u1', scopeUserId: 'u1', groupId: 'g1', conversationId: 'c1' }
  const r = await spawn.execute({ task: '用记忆回答' }, ctx)
  let status = null
  for (let i = 0; i < 50; i++) { const s = await check.execute({ taskId: r.taskId }, ctx); status = s.status; if (status === 'done' || status === 'failed' || status === 'timeout') break; await delay(20) }
  eq(status, 'done', '子代理完成')
  ok(seenCtx && seenCtx.userId === 'u1' && seenCtx.conversationId === 'c1', '子代理工具收到身份 ctx（memory_search 不再因无 ctx 恒失败）')
})

// ---------- 13. spawn 三件套：shutdown 终止在跑任务 ----------
await test('spawn 三件套：shutdown 终止在跑子代理', async () => {
  const prov = { async chat() { return new Promise(() => {}) } }
  const tools = makeSpawnSubagentTools({ provider: prov, sourceRegistry: null, maxConcurrent: 1, minBudgetMs: 60000, hardGraceMs: 60000 })
  const ctx = { userId: 'u', conversationId: 'c' }
  await tools[0].execute({ task: 'hang' }, ctx)
  await delay(30)
  const n = tools.shutdown()
  eq(n, 1, 'shutdown 报告终止 1 个在跑子代理')
  const after = await tools[1].execute({ taskId: 'sub_1_x' }, ctx)
  ok(!!after.error, 'shutdown 后任务表已清空')
})

// ---------- 14. 主/子代理状态同步：主循环结束后未消费的结果异步回推 ----------
await test('状态同步：主循环结束后未消费的完成结果异步回推', async () => {
  const slowProv = { async chat() { await delay(200); return { role: 'assistant', content: '回推结果', toolCalls: [], finishReason: 'stop', usage: null } } }
  const settled = []
  const tools = makeSpawnSubagentTools({
    provider: slowProv, sourceRegistry: null, maxConcurrent: 1, minBudgetMs: 10000,
    onSettle: (info, sctx) => settled.push({ id: info.taskId, status: info.status, result: info.result, uid: sctx?.userId }),
  })
  const ctx = { userId: 'u', conversationId: 'c' }
  await tools[0].execute({ task: '慢任务' }, ctx)
  tools.endRun(ctx) // 主循环先结束（子代理仍在跑）
  eq(settled.length, 0, 'endRun 时任务未完成 → 暂不回推')
  await delay(450)
  eq(settled.length, 1, '子代理完成后回推一次')
  eq(settled[0].status, 'done', 'status=done')
  eq(settled[0].result, '回推结果', '结果回推')
  eq(settled[0].uid, 'u', '携带投递上下文')
})

await test('状态同步：已被 check 消费的结果不再回推（防重复）', async () => {
  const slowProv = { async chat() { await delay(150); return { role: 'assistant', content: 'X', toolCalls: [], finishReason: 'stop', usage: null } } }
  const settled = []
  const tools = makeSpawnSubagentTools({ provider: slowProv, sourceRegistry: null, maxConcurrent: 1, minBudgetMs: 10000, onSettle: (i) => settled.push(i.status) })
  const ctx = { userId: 'u', conversationId: 'c' }
  const r = await tools[0].execute({ task: 't' }, ctx)
  const s = await tools[1].execute({ taskId: r.taskId, waitMs: 5000 }, ctx) // 长轮询取走结果
  eq(s.status, 'done', 'check 取到结果')
  tools.endRun(ctx)
  await delay(300)
  eq(settled.length, 0, '已被 check 消费 → 不回推')
})

await test('状态同步：失败也回推给主代理（不再静默）', async () => {
  const badProv = { async chat() { throw new Error('worker provider 挂了') } }
  const settled = []
  const tools = makeSpawnSubagentTools({ provider: badProv, sourceRegistry: null, maxConcurrent: 1, minBudgetMs: 10000, onSettle: (i) => settled.push({ status: i.status, error: i.error }) })
  const ctx = { userId: 'u', conversationId: 'c' }
  await tools[0].execute({ task: '会失败' }, ctx)
  tools.endRun(ctx)
  await delay(300)
  eq(settled.length, 1, '失败任务回推')
  eq(settled[0].status, 'failed', 'status=failed')
  ok(/挂了/.test(settled[0].error), '带失败原因')
})

await test('状态同步：shutdown 取消的在跑任务也回推', async () => {
  const prov = { async chat() { return new Promise(() => {}) } }
  const settled = []
  const tools = makeSpawnSubagentTools({ provider: prov, sourceRegistry: null, maxConcurrent: 1, minBudgetMs: 60000, hardGraceMs: 60000, onSettle: (i) => settled.push(i.status) })
  const ctx = { userId: 'u', conversationId: 'c' }
  await tools[0].execute({ task: 'hang' }, ctx)
  await delay(30)
  tools.shutdown()
  await delay(50)
  eq(settled.length, 1, 'shutdown 取消的任务被回推')
  eq(settled[0], 'cancelled', 'status=cancelled')
})

// ---------- 15. 子代理工具可达性：剔除依赖运行时句柄的工具 ----------
await test('子代理工具可达性：剔除依赖 e/bot/sandbox/media 的工具', async () => {
  let toolsSent = null
  const prov = {
    async chat(opts) {
      toolsSent = (opts.tools || []).map((t) => t.name)
      return { role: 'assistant', content: 'done', toolCalls: [], finishReason: 'stop', usage: null }
    },
  }
  const reg = new ToolRegistry()
  reg.register({ name: 'web_search', category: 'query', description: 'd', parameters: { type: 'object' }, async execute() { return {} } })
  reg.register({ name: 'terminal', category: 'query', description: 'd', parameters: { type: 'object' }, async execute() { return {} } })
  reg.register({ name: 'get_group_file', category: 'group_manage', description: 'd', parameters: { type: 'object' }, async execute() { return {} } })
  reg.register({ name: 'read_excel', category: 'query', description: 'd', parameters: { type: 'object' }, async execute() { return {} } })
  const [spawn, check] = makeSpawnSubagentTools({
    provider: prov, sourceRegistry: reg, maxConcurrent: 1, minBudgetMs: 10000,
    defaultTools: ['web_search', 'terminal', 'get_group_file', 'read_excel'],
  })
  const ctx = { userId: 'u', conversationId: 'c' }
  const r = await spawn.execute({ task: 't' }, ctx)
  for (let i = 0; i < 50; i++) { const s = await check.execute({ taskId: r.taskId, waitMs: 0 }, ctx); if (['done', 'failed', 'timeout'].includes(s.status)) break; await delay(20) }
  ok(Array.isArray(toolsSent), '子代理已发起调用')
  ok(toolsSent.includes('web_search'), '纯网络工具保留')
  ok(toolsSent.includes('read_excel'), '无 ctx 依赖的 query 工具保留')
  ok(!toolsSent.includes('terminal'), 'terminal（需 ctx.sandbox）被剔除')
  ok(!toolsSent.includes('get_group_file'), 'get_group_file（group_manage）被剔除')
})

// ---------- 16. 子代理能力可见 + 不可用工具反馈 ----------
await test('子代理能力可见：spawn 回报可用工具、拒绝/标注不可用工具', async () => {
  const prov = { async chat() { return { role: 'assistant', content: 'ok', toolCalls: [], finishReason: 'stop', usage: null } } }
  const reg = new ToolRegistry()
  reg.register({ name: 'web_search', category: 'query', description: 'd', parameters: { type: 'object' }, async execute() { return {} } })
  reg.register({ name: 'terminal', category: 'query', description: 'd', parameters: { type: 'object' }, async execute() { return {} } })
  const tools = makeSpawnSubagentTools({ provider: prov, sourceRegistry: reg, defaultTools: ['web_search'], maxConcurrent: 1, minBudgetMs: 10000 })
  const spawn = tools[0]
  ok(spawn.description.includes('web_search'), 'spawn 描述列出默认可用工具（能力可见）')
  const ctx = { userId: 'u', conversationId: 'c' }
  // 部分可用：回报 granted + dropped
  const r = await spawn.execute({ task: 't', tools: ['web_search', 'terminal'] }, ctx)
  eq(r.ok, true, '部分可用仍可启动')
  eq(r.tools, ['web_search'], '回报实际下发的工具')
  eq(r.droppedTools, ['terminal'], '回报被忽略的工具')
  ok(/不可用/.test(String(r.warning || '')), 'warning 提示不可用工具')
  // 全不可用：直接拒绝并给出可用清单
  const r2 = await spawn.execute({ task: 't2', tools: ['terminal'] }, ctx)
  ok(!!r2.error && /不可用/.test(r2.error), '请求工具全不可用 → 直接拒绝')
  eq(r2.available, ['web_search'], '返回可用清单供改派/主代理自行完成')
})

// ---------- 17. Semaphore：排队可取消 + 队列上限 + 释放幂等（P0-1 / P-B）----------
await test('Semaphore：排队可取消 + 队列上限 + 释放幂等', async () => {
  const sem = new Semaphore(1, { queueLimit: 1 })
  await sem.acquire()
  eq(sem.active, 1, '占满 active=1')
  const ac = new AbortController()
  const pending = sem.acquire({ signal: ac.signal })
  await delay(5)
  eq(sem.waiting, 1, '排队 1')
  eq(await sem.acquire(), false, '队列满 → acquire 返回 false')
  ac.abort()
  let err = null
  try { await pending } catch (e) { err = e }
  ok(err && err.name === 'AbortError', '排队取消 → AbortError')
  eq(sem.waiting, 0, '取消后从队列移除')
  eq(sem.active, 1, 'active 不受排队取消影响')
  sem.release()
  eq(sem.active, 0, '释放后 active=0')
  sem.release()
  eq(sem.active, 0, '多余 release 不把 active 变负（幂等）')
})

// ---------- 18. 委派工具：透传身份 ctx / 取消信号，归集用量，剔除敏感句柄（P0-1 / A01）----------
await test('委派工具：透传身份 ctx 与取消信号，归集用量，剔除敏感字段', async () => {
  let seen = null
  const spec = {
    name: 'fake', description: 'd',
    async runTaskResult(task, opts) {
      seen = { task, opts }
      return { taskId: 'c1', status: 'completed', completion: 'complete', content: 'R', stopReason: 'stop', usage: { prompt_tokens: 7, completion_tokens: 3 }, turns: 1 }
    },
  }
  const usages = []
  const tool = makeDelegationTool(spec, { onUsage: (r) => usages.push(r.usage) })
  const ac = new AbortController()
  const ctx = { userId: 'u1', scopeUserId: 'u1', groupId: 'g1', conversationId: 'c1', scopeId: 's1', taskId: 'p1', signal: ac.signal, e: { secret: 1 }, bot: { apiKey: 'k' } }
  const out = await tool.execute({ task: 'do' }, ctx)
  eq(out, 'R', '返回 content')
  eq(seen.opts.signal, ac.signal, '取消信号透传')
  eq(seen.opts.ctx.userId, 'u1', '身份 userId 透传')
  ok(seen.opts.ctx.e === undefined && seen.opts.ctx.bot === undefined, '不含 e/bot 敏感句柄')
  eq(seen.opts.parentTaskId, 'p1', '父任务关联透传')
  eq(usages.length, 1, 'usage 归集一次')
  eq(usages[0].prompt_tokens, 7, '用量原样归集')
})

// ---------- 19. 委派工具：排队期间父任务取消 → 零启动、槽位不泄漏（P0-1 / A02 / P-B）----------
await test('委派工具：排队期间父任务取消 → 不启动子代理', async () => {
  let calls = 0
  const spec = { name: 'fake', description: 'd', async runTaskResult() { calls++; return { status: 'completed', completion: 'complete', content: 'x' } } }
  const sem = new Semaphore(1)
  await sem.acquire()
  const tool = makeDelegationTool(spec, { semaphore: sem })
  const ac = new AbortController()
  const p = tool.execute({ task: 't' }, { userId: 'u', signal: ac.signal })
  await delay(5)
  eq(sem.waiting, 1, '委派在排队')
  ac.abort()
  const r = await p
  eq(calls, 0, '取消后零 Provider 调用')
  eq(r.error, 'cancelled', '返回 cancelled')
  sem.release()
  eq(sem.active, 0, '槽位不泄漏')
})

// ---------- 20. SubagentSpec：max_turns 返回 partial 与原 stopReason（P0-1 / A04 / P-C）----------
await test('SubagentSpec：max_turns 返回 partial + 原 stopReason/usage，不伪报完成', async () => {
  const tools = new ToolRegistry()
  tools.register({ name: 'noop', category: 'query', description: 'd', parameters: { type: 'object' }, async execute() { return { ok: true } } })
  let n = 0
  const prov = {
    async chat() {
      n++
      if (n === 1) return { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'noop', arguments: {} }], finishReason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 2 } }
      return { role: 'assistant', content: '部分结果', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 } }
    },
  }
  const spec = new SubagentSpec({ name: 'p', provider: prov, model: 'm', tools, maxTurns: 1 })
  const r = await spec.runTaskResult('task')
  eq(r.status, 'partial', 'status=partial（预算耗尽不标 completed）')
  eq(r.completion, 'partial', 'completion=partial')
  eq(r.stopReason, 'max_turns', '保留原 stopReason')
  ok(r.usage && r.usage.total > 0, 'usage 保留')
  ok(r.turns >= 1, 'turns 保留')
})

// ---------- 21. SubagentSpec：失败/取消 runTask 上抛，结构化结果区分原因（P0-1）----------
await test('SubagentSpec：失败/取消结构化区分，runTask 兼容上抛', async () => {
  const badProv = { async chat() { throw new Error('boom') } }
  const spec = new SubagentSpec({ name: 'b', provider: badProv, model: 'm', maxTurns: 1 })
  const rr = await spec.runTaskResult('t')
  eq(rr.status, 'failed', '结构化 failed')
  let threw = false
  try { await spec.runTask('t') } catch { threw = true }
  ok(threw, 'runTask 失败上抛（兼容旧调用方）')

  const ac = new AbortController()
  const hangProv = { async chat(opts) { return new Promise((_, rej) => { opts.signal?.addEventListener('abort', () => rej(new Error('aborted'))) }) } }
  const s2 = new SubagentSpec({ name: 'h', provider: hangProv, model: 'm', maxTurns: 1 })
  const p = s2.runTaskResult('t', { signal: ac.signal })
  setTimeout(() => ac.abort(), 10)
  const r2 = await p
  eq(r2.status, 'cancelled', '取消 → cancelled（不伪报完成）')
})

// ---------- 22. Orchestrator：信号/身份透传 + 子代理用量归集（P0-1 / A05）----------
await test('Orchestrator：信号/身份透传到委派，子代理用量归集根任务', async () => {
  let childOpts = null
  const spec = {
    name: 'w', description: 'worker',
    async runTaskResult(task, opts) {
      childOpts = opts
      return { taskId: 'c', parentTaskId: opts.parentTaskId, status: 'completed', completion: 'complete', content: '子结果', stopReason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 20 }, turns: 1 }
    },
  }
  const orchProv = mockProvider([
    { toolCalls: [{ id: 'd1', name: 'delegate__w', arguments: { task: '子任务' } }], finishReason: 'tool_calls', usage: { prompt_tokens: 50, completion_tokens: 5 } },
    { content: '综合', finishReason: 'stop', usage: { prompt_tokens: 60, completion_tokens: 6 } },
  ])
  const orch = new Orchestrator({ provider: orchProv, model: 'm', subagents: [spec], maxTurns: 4 })
  const ac = new AbortController()
  const r = await orch.run('总任务', { ctx: { userId: 'u', groupId: 'g', conversationId: 'c' }, signal: ac.signal, taskId: 'root1' })
  eq(r.content, '综合', '综合结果')
  ok(childOpts && childOpts.signal && childOpts.signal.aborted === false, '父任务工作取消信号已下传（未取消时非 aborted）')
  ok(childOpts.ctx && childOpts.ctx.groupId === 'g', '身份 ctx 透传')
  eq(childOpts.parentTaskId, 'root1', '父任务 ID 透传')
  eq(r.subagents.length, 1, '子任务记录 1 条')
  eq(r.subagentUsage.total, 120, 'subagentUsage 独立可查')
  ok(r.usage && r.usage.total >= 120, '子代理用量并入根任务 usage')
})

// ---------- 22b. Orchestrator：父任务取消传播到在途子代理（A03）----------
await test('Orchestrator：父任务取消传播到在途委派', async () => {
  let childSignal = null
  let childResolve
  const childStarted = new Promise((r) => { childResolve = r })
  const spec = {
    name: 'w', description: 'worker',
    async runTaskResult(task, opts) {
      childSignal = opts.signal
      childResolve()
      await new Promise((res) => {
        if (opts.signal?.aborted) return res()
        opts.signal?.addEventListener('abort', () => res(), { once: true })
        setTimeout(res, 500) // 兜底，避免测试挂死
      })
      return { status: opts.signal?.aborted ? 'cancelled' : 'completed', completion: 'none', content: '' }
    },
  }
  const orchProv = mockProvider([
    { toolCalls: [{ id: 'd1', name: 'delegate__w', arguments: { task: '子任务' } }], finishReason: 'tool_calls', usage: null },
    { content: '综合', finishReason: 'stop', usage: null },
  ])
  const orch = new Orchestrator({ provider: orchProv, model: 'm', subagents: [spec], maxTurns: 4 })
  const ac = new AbortController()
  const p = orch.run('总任务', { ctx: { userId: 'u', conversationId: 'c' }, signal: ac.signal })
  await childStarted
  ac.abort()
  let aborted = false
  try { await p } catch (e) { aborted = /aborted/i.test(e?.message || '') }
  ok(childSignal?.aborted === true, '父任务取消传播到子代理工作信号')
  ok(aborted, '父任务取消使编排 run 以 aborted 结束（不交付过期结果）')
})

// ---------- 23. 归一函数：完成语义与 Promise 是否 resolve 分开 ----------
await test('normalizeSubagentResult：status/completion 映射', async () => {
  eq(normalizeSubagentResult({ content: 'a', stopReason: 'stop' }).status, 'completed', '正常停止 → completed')
  eq(normalizeSubagentResult({ content: 'a', stopReason: 'time_budget' }).completion, 'partial', '预算耗尽 → partial')
  eq(normalizeSubagentResult({ content: '', stopReason: 'max_turns' }).status, 'failed', '无内容异常停止 → failed')
  eq(normalizeSubagentResult({ content: 'q', stopReason: 'clarify' }).status, 'waiting_input', 'clarify → waiting_input')
  eq(normalizeSubagentResult({ content: 'b', stopReason: 'blocked' }).status, 'blocked', 'blocked → blocked')
})

// ---------- 24. pipeline：取消信号透传到 step（P0-1 相邻路径）----------
await test('pipeline：取消信号透传到 SubagentSpec step（相邻路径）', async () => {
  let seen = null
  const spec = { name: 's', async runTask(input, opts) { seen = opts; return 'ok' } }
  const pipe = pipeline([spec])
  const ac = new AbortController()
  await pipe.run('x', { signal: ac.signal, userId: 'u' })
  eq(seen.signal, ac.signal, 'signal 透传到 step')
  eq(seen.ctx.userId, 'u', 'ctx 仍原样透传')
})

// ---------- 25. F11：spawn partial 不标 done ----------
await test('F11：spawn partial 不标 done，保留 stopReason', async () => {
  let n = 0
  const provider = {
    async chat() {
      n++
      if (n === 1) return { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'noop', arguments: {} }], finishReason: 'tool_calls', usage: null }
      return { role: 'assistant', content: 'partial progress', toolCalls: [], finishReason: 'stop', usage: null }
    },
  }
  const reg = new ToolRegistry().register({ name: 'noop', category: 'query', description: 'd', parameters: { type: 'object' }, async execute() { return 'step' } })
  const ctx = { userId: 'u', scopeUserId: 'u', conversationId: 'c' }
  const ts = makeSpawnSubagentTools({ provider, sourceRegistry: reg, defaultTools: ['noop'], maxTurns: 1 })
  const spawned = await ts[0].execute({ task: 'multi-step' }, ctx)
  const r = await ts[1].execute({ taskId: spawned.taskId, waitMs: 2000 }, ctx)
  eq(r.status, 'partial', 'partial 不标 done')
  eq(r.stopReason, 'max_turns', '保留 stopReason')
  ts.shutdown()
})

// ---------- 26. F12：附属子代理随父取消 ----------
await test('F12：附属子代理随父任务取消', async () => {
  const parent = new AbortController()
  let startedResolve
  const started = new Promise((r) => { startedResolve = r })
  const provider = { async chat(o) { startedResolve(); return new Promise((_, rej) => { o.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }) }) } }
  const ts = makeSpawnSubagentTools({ provider })
  const ctx = { userId: 'u', conversationId: 'c', signal: parent.signal }
  const spawned = await ts[0].execute({ task: 'attached work' }, ctx)
  await started
  parent.abort()
  const r = await ts[1].execute({ taskId: spawned.taskId, waitMs: 3000 }, { userId: 'u', conversationId: 'c' })
  eq(r.status, 'cancelled', '父取消 → 子 cancelled')
  ts.shutdown()
})

// ---------- 27. F18：spawn 尊重 Semaphore 队列满 ----------
await test('F18：spawn 队列满时拒绝（不超并发）', async () => {
  const sem = new Semaphore(1, { queueLimit: 0 })
  let releaseResolve
  const release = new Promise((r) => { releaseResolve = r })
  let active = 0, peak = 0
  const provider = { async chat() { active++; peak = Math.max(peak, active); await release; active--; return { role: 'assistant', content: 'ok', toolCalls: [], finishReason: 'stop', usage: null } } }
  const ts = makeSpawnSubagentTools({ provider, semaphore: sem })
  const ctx = { userId: 'u', conversationId: 'c' }
  const a = await ts[0].execute({ task: 'a' }, ctx)
  await delay(20)
  const b = await ts[0].execute({ task: 'b' }, ctx)
  await delay(20)
  const rb = await ts[1].execute({ taskId: b.taskId, waitMs: 0 }, ctx)
  eq(rb.status, 'failed', '队列满 → 第二任务失败')
  releaseResolve()
  await ts[1].execute({ taskId: a.taskId, waitMs: 3000 }, ctx)
  eq(peak, 1, '并发峰值 1（未突破 max）')
  ts.shutdown()
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
