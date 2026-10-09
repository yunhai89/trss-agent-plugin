/**
 * tool-effects 执行语义回归 —— F05：发送类工具不得解析为 read/safe。
 * 运行：node model/agent/tool-effects.test.mjs
 */
import { resolveExecutionMeta } from './tool-effects.js'
import { planRecovery } from './recovery.js'
import { makeDownloadTool } from '../download/index.js'
import { readPdfTool } from '../document/pdf.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

await test('web_download / read_pdf：external + never（不自动重放）', async () => {
  const d = resolveExecutionMeta(makeDownloadTool())
  eq(d.effect, 'external', 'web_download effect=external')
  eq(d.replay, 'never', 'web_download replay=never')
  const p = resolveExecutionMeta(readPdfTool)
  eq(p.effect, 'external', 'read_pdf effect=external')
  eq(p.replay, 'never', 'read_pdf replay=never')
})

await test('纯只读工具仍为 read/safe', async () => {
  const w = resolveExecutionMeta({ name: 'web_search', meta: {} })
  eq(w.effect, 'read', 'web_search read')
  eq(w.replay, 'safe', 'web_search safe')
})

await test('恢复计划：发送类工具 started 无结果 → 不 retry（block/reconcile）', async () => {
  const d = resolveExecutionMeta(makeDownloadTool())
  const plan = planRecovery([
    { kind: 'tool_planned', callId: 'c', payload: { name: 'web_download', ...d, args: { url: 'x' } } },
    { kind: 'tool_started', callId: 'c', payload: { name: 'web_download', ...d } },
  ])
  ok(plan.steps[0].action !== 'retry', `发送类工具不标 retry（实际 ${plan.steps[0].action}）`)
  ok(plan.hasBlocking, '存在未知外部副作用 → 阻断自动恢复')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
