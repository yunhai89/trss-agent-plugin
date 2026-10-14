/**
 * ToolRegistry AOP 观测隔离回归 —— F21：sink 抛错不污染工具真实结果。
 * 运行：node model/agent/tools/registry.test.mjs
 */
import { ToolRegistry } from './registry.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

const mkTool = (execute) => ({ name: 'write', description: 'd', parameters: { type: 'object' }, async execute() { return execute() } })

await test('同步抛错的 sink：不改变工具成功结果', async () => {
  let effects = 0
  const reg = new ToolRegistry().register(mkTool(() => { effects++; return { ok: true } }))
  reg.setInvocationSink(() => { throw new Error('telemetry down') })
  const r = await reg.get('write').execute({}, {})
  eq(effects, 1, '副作用执行一次')
  eq(r, { ok: true }, '结果仍为成功（未被观测错误改写）')
})

await test('异步 reject 的 sink：不产生未处理 rejection、结果不变', async () => {
  const reg = new ToolRegistry().register(mkTool(() => ({ ok: true })))
  reg.setInvocationSink(() => Promise.reject(new Error('async telemetry down')))
  let unhandled = 0
  const onU = () => { unhandled++ }
  process.on('unhandledRejection', onU)
  const r = await reg.get('write').execute({}, {})
  await new Promise((res) => setImmediate(res))
  process.removeListener('unhandledRejection', onU)
  eq(r, { ok: true }, '结果不变')
  eq(unhandled, 0, '无未处理 rejection')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
