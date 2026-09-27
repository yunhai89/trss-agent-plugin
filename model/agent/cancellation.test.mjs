/**
 * 离线回归 —— 工具执行取消边界（审计 B1）。
 *
 * 覆盖：
 *  - 串行（含交互式）第二项在取消后不得开跑；
 *  - 审批等待中取消：ConfirmStore 撤销 pending、迟到批准无效、工具不执行；
 *  - onBeforeTool 前置回调中取消：真正执行前拦截；
 *  - 工作 deadline：预算耗尽停止剩余工具并进入收尾（time_budget），配对完整；
 *  - 正常未取消路径：全部执行；
 *  - 未执行工具仍有配对的取消结果。
 *
 * 运行：node model/agent/cancellation.test.mjs
 */
import assert from 'node:assert/strict'
import { Agent, ToolRegistry, ConfirmStore } from './index.js'
import { groupMuteAllTool } from '../group/manage.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 4).join('\n')) } }
const reply = (content = 'done') => ({ role: 'assistant', content, toolCalls: [], finishReason: 'stop' })
const call = (name, id, args = {}) => ({ id, name, arguments: args })

await test('B1a 串行第二项：第一项取消后，真实 groupMuteAllTool 不得执行', async () => {
  const ctl = new AbortController()
  const calls = []
  let turn = 0
  const tools = new ToolRegistry().register({
    name: 'wait_then_cancel', description: 'fixture', parameters: { type: 'object' },
    meta: { interactive: true },
    async execute() { ctl.abort(); return { stopped: true } },
  }, groupMuteAllTool)
  const provider = { async chat() {
    if (turn++) return reply()
    return { ...reply(''), toolCalls: [call('wait_then_cancel', 'a'), call('group_mute_all', 'b', { enable: true })], finishReason: 'tool_calls' }
  } }
  const agent = new Agent({ provider, tools, reflect: 'off', governor: false })
  await agent.run('fixture', {
    signal: ctl.signal,
    ctx: { userId: 'u', groupId: 'g', isGroup: true, e: { group: { async muteAll(enable) { calls.push(enable) } } } },
  }).catch((e) => assert.match(e.message, /aborted/))
  assert.deepEqual(calls, [], '取消后不得执行群管副作用')
})

await test('B1b 审批中取消：pending 撤销、迟到批准无效、工具不执行', async () => {
  const ctl = new AbortController()
  const confirm = new ConfirmStore({ timeout: 100 })
  let executed = 0
  let turn = 0
  const tools = new ToolRegistry().register({
    name: 'write_action', category: 'system', description: 'fixture', parameters: { type: 'object' },
    async execute() { executed++; return { ok: true } },
  })
  const provider = { async chat() { return turn++ ? reply() : { ...reply(''), toolCalls: [call('write_action', 'c')], finishReason: 'tool_calls' } } }
  const agent = new Agent({ provider, tools, confirm, policy: { decide: () => ({ decision: 'confirm' }) }, reflect: 'off', governor: false })
  await agent.run('fixture', { signal: ctl.signal, ctx: { userId: 'u', notify(id) { ctl.abort(); confirm.resolve(id, true) } } }).catch((e) => assert.match(e.message, /aborted/))
  assert.equal(executed, 0, '取消后的迟到批准不得执行工具')
  assert.equal(confirm.size, 0, 'pending 已随取消撤销')
})

await test('B1c onBeforeTool 回调中取消：执行前拦截', async () => {
  const ctl = new AbortController()
  let executed = 0
  let turn = 0
  const tools = new ToolRegistry().register({
    name: 'side_effect', description: 'fixture', parameters: { type: 'object' },
    async execute() { executed++; return { ok: true } },
  })
  const provider = { async chat() { return turn++ ? reply() : { ...reply(''), toolCalls: [call('side_effect', 'd')], finishReason: 'tool_calls' } } }
  const agent = new Agent({ provider, tools, reflect: 'off', governor: false })
  await agent.run('fixture', {
    signal: ctl.signal,
    onBeforeTool: () => { ctl.abort(); return null },
    ctx: { userId: 'u' },
  }).catch((e) => assert.match(e.message, /aborted/))
  assert.equal(executed, 0, '前置回调取消后工具不执行')
})

await test('B1d 工作 deadline：预算耗尽停止剩余工具并进入收尾（time_budget）', async () => {
  let blockingRuns = 0
  let secondRuns = 0
  let turn = 0
  const tools = new ToolRegistry().register({
    name: 'blocking', description: 'fixture', parameters: { type: 'object' }, meta: { interactive: true },
    execute: (args, ctx) => new Promise((resolve) => {
      blockingRuns++
      const finish = () => resolve({ waited: true })
      if (ctx?.signal?.aborted) return finish()
      ctx?.signal?.addEventListener('abort', finish, { once: true })
    }),
  }, {
    name: 'second_effect', description: 'fixture', parameters: { type: 'object' },
    async execute() { secondRuns++; return { ok: true } },
  })
  const provider = { async chat(opts) {
    if (opts.tool_choice === 'none' || turn++) return reply('summary after deadline')
    return { ...reply(''), toolCalls: [call('blocking', 'e'), call('second_effect', 'f')], finishReason: 'tool_calls' }
  } }
  const agent = new Agent({ provider, tools, reflect: 'off', loop: { timeBudgetMs: 40 } })
  const result = await agent.run('fixture')
  assert.equal(blockingRuns, 1, '在途工具已启动（不可撤回）')
  assert.equal(secondRuns, 0, '预算耗尽后剩余工具不得开跑')
  assert.equal(result.stopReason, 'time_budget', `stopReason=time_budget（实际 ${result.stopReason}）`)
  ok(result.content.length > 0, '进入收尾并交付非空说明')
  // 配对完整：所有 tool_call 都有 tool result（含未执行项）
  const callIds = new Set()
  for (const m of result.messages) for (const tc of m.tool_calls || []) callIds.add(tc.id)
  const resultIds = new Set(result.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
  ok([...callIds].every((id) => resultIds.has(id)), '每个 tool_call 都有配对 tool result')
})

await test('B1e 未执行工具的配对结果为明确的取消错误，不伪装成功', async () => {
  const ctl = new AbortController()
  let turn = 0
  const tools = new ToolRegistry().register({
    name: 'first', description: 'fixture', parameters: { type: 'object' }, meta: { interactive: true },
    async execute() { ctl.abort(); return { ok: true } },
  }, {
    name: 'second', description: 'fixture', parameters: { type: 'object' },
    async execute() { return { ok: true } },
  })
  const provider = { async chat() { return turn++ ? reply() : { ...reply(''), toolCalls: [call('first', 'g'), call('second', 'h')], finishReason: 'tool_calls' } } }
  const agent = new Agent({ provider, tools, reflect: 'off', governor: false })
  const run = agent.run('fixture', { signal: ctl.signal, ctx: { userId: 'u' } })
  // run 会因用户取消 reject，但 messages 上已写入配对结果
  await run.catch(() => {})
  const cancelled = agent.messages.filter((m) => m.role === 'tool' && /"error"\s*:\s*"cancelled"/.test(m.content))
  ok(cancelled.length >= 1, '未执行工具产出 cancelled 结果')
})

await test('B1f 正常未取消：全部工具执行', async () => {
  let turn = 0
  const ran = []
  const tools = new ToolRegistry().register({
    name: 't1', description: 'fixture', parameters: { type: 'object' },
    async execute() { ran.push('t1'); return { ok: 1 } },
  }, {
    name: 't2', description: 'fixture', parameters: { type: 'object' },
    async execute() { ran.push('t2'); return { ok: 2 } },
  })
  const provider = { async chat() { return turn++ ? reply('final') : { ...reply(''), toolCalls: [call('t1', 'i'), call('t2', 'j')], finishReason: 'tool_calls' } } }
  const agent = new Agent({ provider, tools, reflect: 'off', governor: false })
  const result = await agent.run('fixture')
  assert.deepEqual(ran.sort(), ['t1', 't2'], '正常路径全部执行')
  assert.equal(result.content, 'final')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
