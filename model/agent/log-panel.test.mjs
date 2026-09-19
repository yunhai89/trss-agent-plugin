/**
 * 启动面板渲染测试（utils/Log.js 的 renderPanel / strWidth）。
 * 运行：node model/agent/log-panel.test.mjs  （无需联网 / API Key）
 */
import { renderPanel, strWidth } from '../../utils/Log.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) {
    passed++
    console.log('  ✓', m)
  } else {
    failed++
    console.error('  ✗ FAIL', m)
  }
}
function test(name, fn) {
  console.log(`\n[${name}]`)
  try { fn() } catch (e) {
    failed++
    console.error('  ✗ THROW', e?.message || e)
    console.error(e?.stack)
  }
}

test('strWidth：CJK / ASCII 显示宽度', () => {
  ok(strWidth('应用') === 4, '中文按 2 列')
  ok(strWidth('ab') === 2, 'ASCII 按 1 列')
  ok(strWidth('a中') === 3, '混排 3 列')
  ok(strWidth('') === 0, '空串 0')
})

test('renderPanel：对齐、跳过空值、统一边框', () => {
  const out = renderPanel('测试面板', [
    ['应用', '2 个'],
    ['运行时', 'Node v20'],
    ['空', ''],
    ['缺', null],
    ['长标签', 'x'],
  ], { minWidth: 20 })
  const lines = out.split('\n')
  ok(lines[0].startsWith('┌─ 测试面板'), '含标题顶边')
  ok(lines[lines.length - 1].startsWith('└'), '含底边')
  ok(lines.some((l) => l === '│ 应用    2 个'), 'CJK 标签按显示宽度补齐')
  ok(lines.some((l) => l === '│ 运行时  Node v20'), '最长标签零补齐')
  ok(lines.some((l) => l === '│ 长标签  x'), '等宽标签对齐')
  ok(!out.includes('空') && !out.includes('缺'), '空/缺值行被跳过')
})

test('renderPanel：空行时仍输出完整边框', () => {
  const out = renderPanel('仅标题', [], { minWidth: 20 })
  const lines = out.split('\n')
  ok(lines.length === 2, '仅顶边+底边')
  ok(lines[0].startsWith('┌─ 仅标题') && lines[1].startsWith('└'), '边框完整')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
process.exit(failed > 0 ? 1 : 0)
