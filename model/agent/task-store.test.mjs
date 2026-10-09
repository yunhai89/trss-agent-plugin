/**
 * TaskStore 离线自检 —— P0-3 可恢复任务账本（阶段一）。
 * 运行：node model/agent/task-store.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sqlite3 from 'sqlite3'
import { TaskStore, scopeKeyOfCtx } from './task-store.js'
import { Agent } from './Agent.js'
import { ToolRegistry } from './tools/registry.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'taskstore-'))
const CTX = { groupId: 'g1', userId: 'u1', scopeUserId: 'u1', conversationId: 'c1', scopeId: 'g1_u1' }

function mockProvider(responses) {
  let i = 0
  return { async chat() { const r = responses[Math.min(i, responses.length - 1)]; i++; return { role: 'assistant', content: r.content ?? '', toolCalls: r.toolCalls || [], finishReason: r.finishReason || 'stop', usage: r.usage || null, rawMessage: {} } } }
}

// ---------- 1. begin/get + scopeKey ----------
await test('TaskStore：begin/get 与 scopeKey', async () => {
  const dir = tmp()
  const s = new TaskStore({ dir }); await s.open()
  await s.begin({ taskId: 't1', ctx: CTX, providerRoute: 'm' })
  const t = await s.get('t1')
  eq(t.phase, 'running', 'phase=running')
  eq(t.scopeKey, scopeKeyOfCtx(CTX), 'scopeKey 正确')
  eq(t.revision, 0, '初始 revision=0')
  eq((await s.listEvents('t1')).map((e) => e.kind), ['accepted'], 'accepted 事件')
  await s.close()
})

// ---------- 2. 事件去重 + revision ----------
await test('TaskStore：tool_result 按 call_id 去重', async () => {
  const dir = tmp()
  const s = new TaskStore({ dir }); await s.open()
  await s.begin({ taskId: 't1', ctx: CTX })
  const a = await s.event({ taskId: 't1', kind: 'tool_result', callId: 'c1', payload: { ok: true } })
  const b = await s.event({ taskId: 't1', kind: 'tool_result', callId: 'c1', payload: { ok: true } })
  eq(a.inserted, true, '首次写入')
  eq(b.inserted, false, '重复 call_id 被忽略')
  eq((await s.get('t1')).revision, 1, 'revision 仅 +1（不重复计数）')
  await s.close()
})

// ---------- 3. 重新打开持久化 ----------
await test('TaskStore：关闭重开后数据仍在', async () => {
  const dir = tmp()
  const s1 = new TaskStore({ dir }); await s1.open()
  await s1.begin({ taskId: 't1', ctx: CTX })
  await s1.event({ taskId: 't1', kind: 'tool_planned', callId: 'c9', payload: { name: 'web_search' } })
  await s1.close()
  const s2 = new TaskStore({ dir }); await s2.open()
  const t = await s2.get('t1')
  eq(t.phase, 'running', '任务仍在')
  ok((await s2.listEvents('t1')).some((e) => e.callId === 'c9'), '事件仍在')
  await s2.close()
})

// ---------- 4. 重启标记 interrupted ----------
await test('TaskStore：重启把未结算任务标 interrupted', async () => {
  const dir = tmp()
  const s1 = new TaskStore({ dir }); await s1.open()
  await s1.begin({ taskId: 't1', ctx: CTX })
  await s1.finish({ taskId: 't2', phase: 'completed', completion: 'complete' }).catch(() => {}) // t2 不存在 → 忽略
  await s1.begin({ taskId: 't2', ctx: CTX })
  await s1.finish({ taskId: 't2', phase: 'completed', completion: 'complete' })
  await s1.close()
  const s2 = new TaskStore({ dir }); await s2.open()
  const n = await s2.markInterrupted({ runtimeGeneration: 7 })
  eq(n, 1, '仅未结算的 t1 被标记')
  eq((await s2.get('t1')).phase, 'interrupted', 't1 → interrupted')
  eq((await s2.get('t1')).stopReason, 'process_restart', '原因=process_restart')
  eq((await s2.get('t2')).phase, 'completed', 't2 保持 completed')
  await s2.close()
})

// ---------- 5. 跨 scope 隔离 ----------
await test('TaskStore：跨 scope 拒绝读取/取消/恢复', async () => {
  const dir = tmp()
  const s = new TaskStore({ dir }); await s.open()
  await s.begin({ taskId: 't1', ctx: CTX })
  const other = scopeKeyOfCtx({ groupId: 'gX', userId: 'uX', conversationId: 'cX' })
  eq(await s.get('t1', { scopeKey: other }), null, '跨 scope get → null')
  eq((await s.cancel('t1', { scopeKey: other })).code, 'forbidden', '跨 scope cancel → forbidden')
  eq((await s.resume('t1', { scopeKey: other })).code, 'forbidden', '跨 scope resume → forbidden')
  await s.close()
})

// ---------- 6. 终态与手动恢复 ----------
await test('TaskStore：finish 终态、resume/cancel 语义', async () => {
  const dir = tmp()
  const s = new TaskStore({ dir }); await s.open()
  await s.begin({ taskId: 't1', ctx: CTX })
  await s.finish({ taskId: 't1', phase: 'paused', stopReason: 'time_budget', completion: 'partial', usage: { input: 10, output: 2 } })
  const t = await s.get('t1')
  eq(t.phase, 'paused', 'paused 保留（非终态）')
  eq(t.stopReason, 'time_budget', '保留 stopReason')
  eq(t.completion, 'partial', '保留 completion')
  const r = await s.resume('t1')
  eq(r.ok, true, '非终态可请求恢复')
  ok(r.checkpoint.completedSteps >= 0, '返回检查点')
  await s.cancel('t1')
  eq((await s.get('t1')).phase, 'cancelled', 'cancel → cancelled')
  eq((await s.cancel('t1')).code, 'terminal', '终态再次 cancel → terminal')
  eq((await s.resume('t1')).code, 'terminal', '终态 resume → terminal')
  await s.close()
})

// ---------- 7. 未来 schema_version 拒绝 ----------
await test('TaskStore：未来 schema_version 拒绝读取', async () => {
  const dir = tmp()
  const s1 = new TaskStore({ dir }); await s1.open(); await s1.close()
  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(dir, 'tasks.db'))
    db.run(`UPDATE store_meta SET value='999' WHERE key='schema_version'`, (e) => { db.close(); e ? reject(e) : resolve() })
  })
  const s2 = new TaskStore({ dir })
  let threw = null
  try { await s2.open() } catch (e) { threw = e }
  ok(threw && /schema_version/.test(threw.message), '拒绝按旧结构解析未来版本')
})

// ---------- 8. 未启用 TaskStore 时 Agent 行为不变 ----------
await test('Agent：未注入 taskStore 时零影响', async () => {
  const provider = mockProvider([{ content: 'ok', finishReason: 'stop' }])
  const agent = new Agent({ provider, maxTurns: 3 })
  const r = await agent.run('你好')
  eq(r.content, 'ok', '正常返回')
})

// ---------- 9. Agent 集成：完成任务的账本边界 ----------
await test('Agent + TaskStore：accepted/tool_planned/tool_result/finished 落盘', async () => {
  const dir = tmp()
  const store = new TaskStore({ dir }); await store.open()
  const tools = new ToolRegistry().register({
    name: 'web_search', description: 'd', parameters: { type: 'object' }, async execute() { return { ok: true } },
  })
  const provider = mockProvider([
    { toolCalls: [{ id: 'c1', name: 'web_search', arguments: {} }], finishReason: 'tool_calls' },
    { content: 'done', finishReason: 'stop' },
  ])
  const agent = new Agent({ provider, tools, maxTurns: 5, taskStore: store })
  const r = await agent.run('搜一下', { ctx: CTX })
  const t = await store.get(r.taskId)
  eq(t.phase, 'completed', '正常交付 → completed')
  const kinds = (await store.listEvents(r.taskId)).map((e) => e.kind)
  ok(kinds.includes('accepted'), 'accepted')
  ok(kinds.includes('tool_planned'), 'tool_planned（副作用前）')
  ok(kinds.includes('tool_result'), 'tool_result')
  ok(kinds.includes('finished'), 'finished')
  await store.close()
})

// ---------- 10. Agent 集成：预算耗尽 → paused（不是 completed）----------
await test('Agent + TaskStore：max_turns → paused，不伪报完成', async () => {
  const dir = tmp()
  const store = new TaskStore({ dir }); await store.open()
  const tools = new ToolRegistry().register({
    name: 'web_search', description: 'd', parameters: { type: 'object' }, async execute() { return { ok: true } },
  })
  const provider = mockProvider([
    { toolCalls: [{ id: 'c1', name: 'web_search', arguments: {} }], finishReason: 'tool_calls' },
    { content: '部分结果', finishReason: 'stop' },
  ])
  const agent = new Agent({ provider, tools, maxTurns: 1, taskStore: store })
  const r = await agent.run('搜一下', { ctx: CTX })
  eq(r.stopReason, 'max_turns', '停止原因 max_turns')
  const t = await store.get(r.taskId)
  eq(t.phase, 'paused', '预算耗尽 → paused')
  eq(t.completion, 'partial', 'completion=partial')
  await store.close()
})

// ---------- 11. 会话投影游标幂等（projectOnce）----------
await test('TaskStore：会话投影游标幂等（同批只 append 一次）', async () => {
  const dir = tmp()
  const s = new TaskStore({ dir }); await s.open()
  await s.begin({ taskId: 't1', ctx: CTX })
  let runs = 0
  const r1 = await s.projectOnce('t1', { sessionKey: 'k', cursor: 5 }, async () => { runs++ })
  eq(r1.skipped, false, '首次执行')
  const r2 = await s.projectOnce('t1', { sessionKey: 'k', cursor: 5 }, async () => { runs++ })
  eq(r2.skipped, true, '相同游标跳过')
  eq(runs, 1, '只执行一次')
  const r3 = await s.projectOnce('t1', { sessionKey: 'k', cursor: 8 }, async () => { runs++ })
  eq(r3.skipped, false, '更大游标执行')
  eq(runs, 2, '推进后再次执行')
  eq((await s.get('t1')).sessionCursor, 8, '游标单调推进')
  await s.close()
})

// ---------- 12. Agent 集成：会话投影游标随会话持久化推进 ----------
await test('Agent + TaskStore：会话持久化后记录投影游标', async () => {
  const dir = tmp()
  const store = new TaskStore({ dir }); await store.open()
  const echoed = []
  const fakeSession = {
    async getConversation() { return [] },
    key: (gid, uid) => `k:${gid}:${uid}`,
    async appendConversation(...args) { echoed.push(args[3].length) },
    async setConversation() {},
    async getConversationState() { return {} },
    async setConversationState() {},
  }
  const provider = mockProvider([{ content: '你好呀', finishReason: 'stop' }])
  const agent = new Agent({ provider, session: fakeSession, maxTurns: 3, taskStore: store })
  const r = await agent.run('hi', { ctx: { ...CTX, conversationId: 1 } })
  const t = await store.get(r.taskId)
  ok(t.sessionCursor > 0, '投影游标已推进')
  ok(String(t.sessionKey || '').startsWith('conv:'), '记录了会话键')
  ok(echoed.length > 0, '会话已 append')
  await store.close()
})

// ---------- 13. 只读有限自动恢复（P0-3 阶段二）----------
await test('TaskStore：recoverReadOnly 仅重跑只读可重放步骤', async () => {
  const dir = tmp()
  const s = new TaskStore({ dir }); await s.open()
  await s.begin({ taskId: 't1', ctx: CTX })
  await s.event({ taskId: 't1', kind: 'tool_planned', callId: 'c1', payload: { name: 'web_search', effect: 'read', replay: 'safe', args: { q: 'x' } } })
  await s.event({ taskId: 't1', kind: 'tool_planned', callId: 'c2', payload: { name: 'kb_search', effect: 'read', replay: 'safe', args: { q: 'y' } } })
  await s.event({ taskId: 't1', kind: 'tool_started', callId: 'c2', payload: { name: 'kb_search', effect: 'read', replay: 'safe', args: { q: 'y' } } })
  const ran = []
  const out = await s.recoverReadOnly('t1', { execute: async (step) => { ran.push(step.callId) } })
  eq(out.ok, true, '自动恢复成功')
  eq(ran.sort(), ['c1', 'c2'], '仅重跑只读步骤')
  const results = (await s.listEvents('t1')).filter((e) => e.kind === 'tool_result')
  eq(results.length, 2, '写入 recovered 结果事件')
  await s.close()
})

await test('TaskStore：存在未知写副作用时 recoverReadOnly 拒绝', async () => {
  const dir = tmp()
  const s = new TaskStore({ dir }); await s.open()
  await s.begin({ taskId: 't1', ctx: CTX })
  await s.event({ taskId: 't1', kind: 'tool_planned', callId: 'w1', payload: { name: 'set_note', effect: 'write', replay: 'never' } })
  await s.event({ taskId: 't1', kind: 'tool_started', callId: 'w1', payload: { name: 'set_note', effect: 'write', replay: 'never' } })
  let ran = 0
  const out = await s.recoverReadOnly('t1', { execute: async () => { ran++ } })
  eq(out.ok, false, '拒绝自动恢复')
  eq(out.code, 'blocked_pending_reconciliation', '原因=blocked_pending_reconciliation')
  eq(ran, 0, '未执行任何副作用')
  await s.close()
})

// ---------- 14. Agent 记录 tool_started + effectState ----------
await test('Agent + TaskStore：记录 tool_started 与 effectState', async () => {
  const dir = tmp()
  const store = new TaskStore({ dir }); await store.open()
  const tools = new ToolRegistry().register({
    name: 'web_search', description: 'd', parameters: { type: 'object' }, async execute() { return { ok: true } },
  })
  const provider = mockProvider([
    { toolCalls: [{ id: 'c1', name: 'web_search', arguments: {} }], finishReason: 'tool_calls' },
    { content: 'done', finishReason: 'stop' },
  ])
  const agent = new Agent({ provider, tools, maxTurns: 5, taskStore: store })
  const r = await agent.run('搜一下', { ctx: CTX })
  const events = await store.listEvents(r.taskId)
  ok(events.some((e) => e.kind === 'tool_started'), '记录 tool_started')
  const tr = events.find((e) => e.kind === 'tool_result' && e.callId === 'c1')
  eq(tr.payload.effect, 'read', '只读工具 effect=read')
  eq(tr.payload.effectState, 'none', '只读成功 effectState=none')
  await store.close()
})

// ---------- 15. F03：失败/拒绝/非法参数记为非成功且不 applied ----------
await test('F03：工具失败/拒绝/非法参数不记成功、不 applied', async () => {
  const dir = tmp()
  const store = new TaskStore({ dir }); await store.open()
  let deniedBody = 0
  const tools = new ToolRegistry().register(
    { name: 'throws', description: 'd', parameters: { type: 'object' }, async execute() { throw new Error('boom') } },
    { name: 'soft_fail', description: 'd', parameters: { type: 'object' }, async execute() { return { ok: false, error: 'timeout' } } },
    { name: 'denied', description: 'd', parameters: { type: 'object' }, async execute() { deniedBody++; return 'ok' } },
    { name: 'bad_args', description: 'd', parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] }, async execute() { return 'ok' } },
  )
  const names = ['throws', 'soft_fail', 'denied', 'bad_args']
  const provider = mockProvider([
    { toolCalls: names.map((n, i) => ({ id: 'c' + i, name: n, arguments: {} })), finishReason: 'tool_calls' },
    { content: 'done', finishReason: 'stop' },
  ])
  const agent = new Agent({ provider, tools, taskStore: store, policy: { decide: (_c, t) => ({ decision: t.name === 'denied' ? 'deny' : 'allow', reason: 'audit' }) }, maxTurns: 3 })
  const r = await agent.run('x', { ctx: CTX })
  const entries = (await store.listEvents(r.taskId)).filter((e) => e.kind === 'tool_result').map((e) => e.payload)
  eq(deniedBody, 0, 'deny 工具体未执行')
  ok(entries.length === 4 && entries.every((e) => e.ok === false), '四项全部记为失败')
  ok(entries.every((e) => e.effectState !== 'applied'), '没有 applied')
  eq(entries.find((e) => e.name === 'denied').effectState, 'none', '策略拒绝 → none')
  eq(entries.find((e) => e.name === 'bad_args').effectState, 'none', '参数非法 → none')
  eq(entries.find((e) => e.name === 'throws').effectState, 'unknown', '执行抛错（写）→ unknown')
  const plan = (await store.recoveryPlan(r.taskId)).plan
  eq(plan.counts.reuse, 0, '恢复计划不复用失败结果')
  await store.close()
})

// ---------- 16. F04：关键账本写失败阻止副作用 ----------
await test('F04：关键账本写失败 → 阻止副作用且不标 completed', async () => {
  const dir = tmp()
  const store = new TaskStore({ dir }); await store.open()
  const orig = store.event.bind(store)
  store.event = (e) => (e.kind === 'tool_started' ? Promise.reject(new Error('injected SQLITE_FULL')) : orig(e))
  let count = 0
  const tools = new ToolRegistry().register({ name: 'write_one', description: 'd', parameters: { type: 'object' }, async execute() { count++; return 'ok' } })
  const provider = mockProvider([
    { toolCalls: [{ id: 'c1', name: 'write_one', arguments: {} }], finishReason: 'tool_calls' },
    { content: 'done', finishReason: 'stop' },
  ])
  const agent = new Agent({ provider, tools, taskStore: store, maxTurns: 3 })
  const r = await agent.run('x', { ctx: CTX })
  eq(count, 0, '关键账本失败 → 副作用未执行')
  eq(r.journalDegraded, true, '结果暴露降级标记')
  const t = await store.get(r.taskId)
  eq(t.phase, 'failed', '不标 completed')
  eq(t.stopReason, 'journal_degraded', 'stopReason=journal_degraded')
  await store.close()
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
