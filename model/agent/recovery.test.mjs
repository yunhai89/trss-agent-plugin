/**
 * Recovery planner 离线自检 —— P0-3 阶段二崩溃/重复执行语义映射。
 * 运行：node model/agent/recovery.test.mjs
 */
import { planRecovery } from './recovery.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

await test('planRecovery：崩溃语义映射（read/write/idempotent/未开始/已完成）', async () => {
  const ev = [
    { kind: 'tool_planned', callId: 'c1', payload: { name: 'web_search', effect: 'read', replay: 'safe' } },
    { kind: 'tool_started', callId: 'c1', payload: { name: 'web_search', effect: 'read', replay: 'safe' } },
    { kind: 'tool_planned', callId: 'c2', payload: { name: 'set_note', effect: 'write', replay: 'never' } },
    { kind: 'tool_started', callId: 'c2', payload: { name: 'set_note', effect: 'write', replay: 'never' } },
    { kind: 'tool_planned', callId: 'c3', payload: { name: 'pay', effect: 'external', replay: 'idempotent', idempotencyKey: 'k3' } },
    { kind: 'tool_started', callId: 'c3', payload: { name: 'pay', effect: 'external', replay: 'idempotent', idempotencyKey: 'k3' } },
    { kind: 'tool_planned', callId: 'c4', payload: { name: 'web_search', effect: 'read', replay: 'safe', args: { q: 'x' } } },
    { kind: 'tool_planned', callId: 'c5', payload: { name: 'web_search', effect: 'read', replay: 'safe' } },
    { kind: 'tool_started', callId: 'c5', payload: { name: 'web_search', effect: 'read', replay: 'safe' } },
    { kind: 'tool_result', callId: 'c5', payload: { name: 'web_search', ok: true, effectState: 'none' } },
  ]
  const p = planRecovery(ev)
  const by = Object.fromEntries(p.steps.map((s) => [s.callId, s]))
  eq(by.c1.action, 'retry', '只读已开始无结果 → retry')
  eq(by.c1.reason, 'safe_read_interrupted', '原因 safe_read_interrupted')
  eq(by.c2.action, 'block', '写操作未知 → block')
  eq(by.c2.reason, 'write_interrupted_unknown', '原因 write_interrupted_unknown')
  eq(by.c3.action, 'reconcile', '幂等写 → reconcile')
  eq(by.c3.idempotencyKey, 'k3', '携带幂等键')
  eq(by.c4.action, 'retry', '未开始 → retry')
  eq(by.c4.reason, 'not_started', '原因 not_started')
  eq(by.c4.args, { q: 'x' }, '携带可重放入参')
  eq(by.c5.action, 'reuse', '已完成 → reuse')
  eq(p.hasBlocking, true, 'hasBlocking')
  eq(p.autoResumable, false, '有阻断 → 不可自动恢复')
  eq(p.counts, { reuse: 1, retry: 2, reconcile: 1, block: 1 }, '计数')
})

await test('planRecovery：全只读/未开始 → autoResumable', async () => {
  const ev = [
    { kind: 'tool_planned', callId: 'a', payload: { name: 'web_search', effect: 'read', replay: 'safe', args: { q: 1 } } },
    { kind: 'tool_planned', callId: 'b', payload: { name: 'kb_search', effect: 'read', replay: 'safe' } },
    { kind: 'tool_started', callId: 'b', payload: { name: 'kb_search', effect: 'read', replay: 'safe', args: { q: 2 } } },
    { kind: 'tool_result', callId: 'b', payload: { name: 'kb_search', ok: true } },
  ]
  const p = planRecovery(ev)
  eq(p.autoResumable, true, '可自动恢复')
  eq(p.hasBlocking, false, '无阻断')
})

await test('planRecovery：无元数据时保守按写/never', async () => {
  const p = planRecovery([
    { kind: 'tool_planned', callId: 'x', payload: { name: 'mystery' } },
    { kind: 'tool_started', callId: 'x', payload: { name: 'mystery' } },
  ])
  eq(p.steps[0].action, 'block', '无声明写操作 → block')
})

await test('planRecovery：resolveMeta 回退（工具表在外部解析）', async () => {
  const p = planRecovery(
    [
      { kind: 'tool_planned', callId: 'x', payload: { name: 'web_search' } },
      { kind: 'tool_started', callId: 'x', payload: { name: 'web_search' } },
    ],
    { resolveMeta: (name) => (name === 'web_search' ? { effect: 'read', replay: 'safe' } : { effect: 'write', replay: 'never' }) },
  )
  eq(p.steps[0].action, 'retry', '外层解析为只读 → retry')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
