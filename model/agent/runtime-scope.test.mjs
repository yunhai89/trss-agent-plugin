/**
 * RuntimeScope + ToolRegistry.registerScoped 离线自检 —— P0-4 生命周期作用域。
 * 运行：node model/agent/runtime-scope.test.mjs
 */
import { RuntimeScope } from './runtime-scope.js'
import { ToolRegistry } from './tools/registry.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

await test('RuntimeScope：按序 await 清理', async () => {
  const s = new RuntimeScope({ name: 't' })
  const order = []
  s.register(async () => { await delay(10); order.push('a') })
  s.register(() => { order.push('b') })
  const r = await s.close()
  eq(order, ['a', 'b'], '按登记顺序等待完成')
  eq(r.disposed, 2, 'disposed=2')
  eq(s.closed, true, 'closed=true')
})

await test('RuntimeScope：close 幂等', async () => {
  const s = new RuntimeScope()
  let n = 0
  s.register(() => { n++ })
  const p1 = s.close()
  const p2 = s.close()
  await Promise.all([p1, p2])
  eq(n, 1, 'disposer 只执行一次')
  const r = await s.close()
  eq(n, 1, '重复 close 不重复执行')
  ok(r && r.disposed === 1, '返回首次关闭结果（幂等）')
})

await test('RuntimeScope：可逆登记（注销只移除自身）', async () => {
  const s = new RuntimeScope()
  let a = 0, b = 0
  const off = s.register(() => { a++ })
  s.register(() => { b++ })
  off()
  await s.close()
  eq(a, 0, '已注销的不执行')
  eq(b, 1, '其余正常执行')
})

await test('RuntimeScope：失败隔离（单个 disposer 抛错不影响其余）', async () => {
  const s = new RuntimeScope()
  const order = []
  s.register(() => { order.push('x'); throw new Error('boom') })
  s.register(() => { order.push('y') })
  const r = await s.close()
  eq(order, ['x', 'y'], '后续仍执行')
  eq(r.failed, 1, 'failed=1')
  eq(r.disposed, 1, 'disposed=1')
})

await test('RuntimeScope：abort 传播 + 子作用域联动', async () => {
  const parent = new RuntimeScope({ name: 'p' })
  const child = parent.child('c')
  ok(!child.aborted, '子初始未 abort')
  parent.abort(new Error('reload'))
  ok(parent.aborted && child.aborted, '父 abort 传播到子')
  const childOrder = []
  child.register(() => childOrder.push('child'))
  parent.register(() => childOrder.push('parent'), { name: 'parent' })
  await parent.close()
  eq(childOrder, ['child', 'parent'], '先关子作用域再关父')
  eq(parent.stats().children, 0, '父无子作用域残留')
  eq(child.stats().closed, true, '子已关闭')
})

await test('RuntimeScope：rollback 逆序回滚', async () => {
  const s = new RuntimeScope()
  const order = []
  s.register(() => order.push(1))
  s.register(() => order.push(2))
  s.register(() => order.push(3))
  await s.rollback()
  eq(order, [3, 2, 1], '逆序回滚')
})

await test('RuntimeScope：openCount 归零', async () => {
  const base = RuntimeScope.openCount
  const a = new RuntimeScope(); const b = new RuntimeScope()
  eq(RuntimeScope.openCount, base + 2, '登记 openCount')
  await Promise.all([a.close(), b.close()])
  eq(RuntimeScope.openCount, base, '关闭后归零')
})

await test('ToolRegistry.registerScoped：scope.close 注销工具；不误删同名新版本', async () => {
  const mk = (name, desc) => ({ name, description: desc, parameters: { type: 'object' }, async execute() { return {} } })

  const scope = new RuntimeScope()
  const reg = new ToolRegistry()
  reg.registerScoped(scope, mk('scoped_tool', 'v1'))
  eq(reg.has('scoped_tool'), true, '注册成功')
  await scope.close()
  eq(reg.has('scoped_tool'), false, 'scope 关闭后注销')

  // 旧 disposer 不误删同名新版本
  const scope2 = new RuntimeScope()
  const reg2 = new ToolRegistry()
  reg2.registerScoped(scope2, mk('same', 'old'))
  reg2.register(mk('same', 'new')) // 同名新版本覆盖
  await scope2.close()
  eq(reg2.has('same'), true, '旧 disposer 不移除同名新版本')
  await reg2.get('same').execute({}, {})
  ok(true, '新版本仍可执行')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
