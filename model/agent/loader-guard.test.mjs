/**
 * 插件导出过滤测试：Yunzai 加载器只应加载 class（函数声明有 prototype 会被误当插件）。
 * 运行：node model/agent/loader-guard.test.mjs
 */
import { isPluginClass } from '../../utils/plugin-class.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function test(name, fn) {
  console.log(`\n[${name}]`)
  try { fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) }
}

test('isPluginClass：仅 class 为真', () => {
  class A {}
  class B extends A {}
  ok(isPluginClass(A) === true, '普通 class')
  ok(isPluginClass(B) === true, 'extends class')
  ok(isPluginClass(class extends A {}) === true, '匿名 class')
})

test('isPluginClass：函数声明/箭头/变量为假', () => {
  function fn() {}
  const arrow = () => {}
  const asyncArrow = async () => {}
  ok(isPluginClass(fn) === false, '函数声明（有 prototype，会被 Yunzai 误当插件）')
  ok(isPluginClass(arrow) === false, '箭头函数')
  ok(isPluginClass(asyncArrow) === false, 'async 箭头')
  ok(isPluginClass({}) === false, '普通对象')
  ok(isPluginClass(null) === false, 'null')
  ok(isPluginClass(undefined) === false, 'undefined')
  ok(isPluginClass('x') === false, '字符串')
})

test('apps 过滤：函数声明被剔除，class 保留', () => {
  function makeDeltaStreamer() { return {} }
  class Chat {}
  class Help {}
  const modules = { Chat, makeDeltaStreamer, Help, autoReply: () => {}, VERSION: '1' }
  const apps = {}
  for (const [k, v] of Object.entries(modules)) if (isPluginClass(v)) apps[k] = v
  const keys = Object.keys(apps)
  ok(keys.includes('Chat') && keys.includes('Help'), 'class 保留')
  ok(!keys.includes('makeDeltaStreamer'), '函数声明（回归用例）被剔除')
  ok(!keys.includes('autoReply') && !keys.includes('VERSION'), '箭头/常量被剔除')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
process.exit(failed > 0 ? 1 : 0)
