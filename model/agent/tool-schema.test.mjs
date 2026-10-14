/**
 * tool-schema 校验回归 —— F19：fail-closed，校验实际执行的同一个值。
 * 运行：node model/agent/tool-schema.test.mjs
 */
import { validateToolArgs } from './tool-schema.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

const objSchema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] }

await test('无 schema：显式放行（旧工具兼容）', async () => {
  eq(validateToolArgs({ name: 'no_schema' }, { anything: 1 }).ok, true, '无 parameters 放行')
})

await test('数组/原始类型参数：拒绝（不再偷偷换成 {}）', async () => {
  const a = validateToolArgs({ name: 'arr', parameters: { type: 'object', additionalProperties: false } }, ['unexpected'])
  eq(a.ok, false, '数组 → 拒绝')
  eq(a.code, 'invalid_arguments', '错误码')
  const b = validateToolArgs({ name: 'n', parameters: { type: 'object' } }, null)
  eq(b.ok, false, 'null → 拒绝')
})

await test('无法编译的 schema：fail-closed', async () => {
  const r = validateToolArgs({ name: 'bad', parameters: { type: 'object', properties: { x: { $ref: '#/nonexistent' } } } }, { x: 5 })
  eq(r.ok, false, '编译失败 → 拒绝')
  eq(r.code, 'schema_invalid', '契约错误码')
})

await test('合法对象通过；缺参/类型/多余参数拒绝', async () => {
  eq(validateToolArgs({ name: 'o', parameters: objSchema }, { x: 1 }).ok, true, '合法通过')
  eq(validateToolArgs({ name: 'o', parameters: objSchema }, {}).ok, false, '缺 required 拒绝')
  eq(validateToolArgs({ name: 'o', parameters: objSchema }, { x: 'str' }).ok, false, '类型错误拒绝')
  const strict = { type: 'object', properties: { x: { type: 'number' } }, additionalProperties: false }
  eq(validateToolArgs({ name: 'o', parameters: strict }, { x: 1, extra: 2 }).ok, false, '多余参数拒绝')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
