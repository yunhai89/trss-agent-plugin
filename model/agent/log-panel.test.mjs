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

test('renderPanel 默认 flat：每行自包含、不依赖对齐', () => {
  const out = renderPanel('测试面板', [
    ['应用', '2 个'],
    ['运行时', 'Node v20'],
    ['空', ''],
    ['缺', null],
    ['长标签', 'x'],
  ])
  const lines = out.split('\n')
  ok(lines[0] === `${'─'.repeat(20)} 测试面板`, '标题行带下划线')
  ok(lines[1] === '· 应用：2 个', '标签：值 自包含（无需补齐）')
  ok(lines[2] === '· 运行时：Node v20', '第二行独立成形')
  ok(lines[3] === '· 长标签：x', '标签长短不影响排版')
  ok(!out.includes('空') && !out.includes('缺'), '空/缺值行被跳过')
  ok(lines.length === 4, '仅有效行 + 标题')
})

test('renderPanel flat：无有效行时仅标题', () => {
  const out = renderPanel('仅标题', [], { rule: 6 })
  ok(out === '────── 仅标题', '仅标题行')
})

test('renderPanel box（可选）：保留盒式排版', () => {
  const out = renderPanel('测试面板', [['应用', '2 个'], ['运行时', 'Node v20']], { style: 'box', minWidth: 20 })
  const lines = out.split('\n')
  ok(lines[0].startsWith('┌─ 测试面板'), '含标题顶边')
  ok(lines[lines.length - 1].startsWith('└'), '含底边')
  ok(lines.some((l) => l.startsWith('│ ')), '含内容行')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
process.exit(failed > 0 ? 1 : 0)
