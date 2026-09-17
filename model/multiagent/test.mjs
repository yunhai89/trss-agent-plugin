/**
 * 离线自检 —— mock provider 驱动 Multi-Agent 全流程。
 * 运行：node model/multiagent/test.mjs
 */
import {
  Orchestrator,
  SubagentSpec,
  makeSpawnSubagentTools,
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

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
