/**
 * 回归验证：配置中心搜索（v1.28.0 引入 / v1.29.0 修复三处缺陷）。
 * 纯逻辑层（vm 沙箱 + 伪 DOM），无需浏览器。运行：node web/dev/config-search-check.mjs
 *
 * 修复回归（每项都先复现再断言）：
 *   1. 长说明（>40 字，只进「?」气泡、不在 DOM）也能按说明关键词搜到（cfg-row 的 data-cf-desc）；
 *   2. 命中标题不带「高危」徽标与「?」（data-cf-name）；
 *   3. 跳转到折叠分区的主区行时，不再顺带展开该分区的「高级参数」块；
 *      命中在高级块（[data-cf-adv]）内时才展开；
 *   4. 中文输入法组词中的 Enter（isComposing）不触发「下一个」。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const el = () => {
  let html = ''
  const node = {
    style: {}, setAttribute: () => {}, appendChild: () => {}, removeChild: () => {}, insertBefore: () => {},
    nodeType: 1, tagName: 'DIV',
    set innerHTML(v) { html = v },
    get innerHTML() { return html },
    get textContent() { return html.replace(/<[^>]*>/g, '') },
    get children() { return [] },
  }
  return node
}
const sandbox = {
  console,
  location: { hash: '#/config' },
  performance,
  navigator: { userAgent: 'check' },
  requestAnimationFrame: () => 0,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  document: {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
    body: el(), createElement: el, createElementNS: el, createTextNode: el, createComment: el,
  },
}
sandbox.window = sandbox
vm.createContext(sandbox)
const run = (file) => vm.runInContext(read(file), sandbox, { filename: file })

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `（实际 ${JSON.stringify(a)}）`}`)

for (const f of ['vendor/vue.global.prod.js', 'assets/js/mock.js', 'assets/js/components.js', 'assets/js/views/config.js']) run(f)
const { Vue, UI, VIEWS } = sandbox
ok(!!Vue && !!UI && !!VIEWS, '前端脚本加载')

/* cfg-row 必须把名称/说明挂到 data 属性上（长说明搜索 + 干净标题的前提） */
const cfgRowTpl = UI.makeCfgRow().template
ok(/data-cf-name/.test(cfgRowTpl) && /data-cf-desc/.test(cfgRowTpl), 'cfg-row 输出 data-cf-name/data-cf-desc')

const bindings = VIEWS.config.setup({}, {})

/* ── 伪 DOM：四类命中行 ── */
const mkRow = ({ name, desc = '', valueText = '', secId = 'reason', advBox = false, danger = false }) => {
  const classes = new Set()
  return {
    getAttribute: (k) => (k === 'data-cf-name' ? name : k === 'data-cf-desc' ? desc : null),
    querySelector: (sel) => (sel === '.name' ? null : sel === '.desc' ? (desc && desc.length <= 40 ? { textContent: desc } : null) : null),
    get textContent() { return [name, danger ? '高危' : '', desc && desc.length <= 40 ? desc : '?', valueText].filter(Boolean).join(' ') },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    isConnected: true,
    offsetParent: {},
    closest: (sel) => (sel === '.cf-sec' ? (secId ? { id: `cfg-${secId}` } : null) : sel === '[data-cf-adv]' ? (advBox ? {} : null) : null),
    scrollIntoView: () => {},
  }
}
const LONG_DESC = '单次对话累计「有效 token」上限(0=不限;缓存命中读按 0.1x 折算,收尾不占)（属于长说明，只进气泡）'
const rows = [
  mkRow({ name: 'Token 预算', desc: LONG_DESC, valueText: '1800000' }), // 长说明行
  mkRow({ name: '主人任务免确认', desc: '主人发起的确认类工具跳过审批', danger: true, secId: 'security' }), // 高危行
  mkRow({ name: '重复动作上限', desc: '同工具+相同参数连续允许次数', secId: 'reason' }), // 折叠分区主区行
  mkRow({ name: '压缩归档目录', desc: 'compaction.archiveDir', secId: 'reason', advBox: true }), // 高级参数块内行
]
sandbox.document.querySelectorAll = (sel) => (sel === '[data-cf-row], .mem-row' ? rows : [])
sandbox.document.querySelector = () => null

const search = (q) => { bindings.search.q = q; bindings.onSearchInput() }

/* 1. 长说明关键词可搜到 */
search('收尾不占')
eq(bindings.search.hits.length, 1, '长说明关键词「收尾不占」命中 1 条（修复前 0）')
eq(bindings.hitName(bindings.search.hits[0]), 'Token 预算', '命中标题为名称')
search('缓存命中读按')
eq(bindings.search.hits.length, 1, '长说明关键词「缓存命中读按」命中 1 条')

/* 2. 高危行标题不带徽标文字 */
search('主人任务免确认')
eq(bindings.search.hits.length, 1, '高危行可搜到')
eq(bindings.hitName(bindings.search.hits[0]), '主人任务免确认', '命中标题不含「高危」（修复前为「主人任务免确认高危」）')

/* 3. 折叠分区展开：主区行不碰高级块；高级块内行才展开 */
bindings.open.reason = false
bindings.adv.reason = false
search('重复动作上限')
bindings.nextHit()
eq(bindings.open.reason, true, '跳转展开所在分区')
eq(bindings.adv.reason, false, '主区行不展开高级参数块（修复前被顺带展开）')
bindings.open.reason = false
bindings.adv.reason = false
search('压缩归档目录')
bindings.nextHit()
eq(bindings.adv.reason, true, '高级块内行照常展开高级参数')

/* 4. IME 组词 Enter 不触发「下一个」 */
search('工具')
ok(bindings.search.hits.length >= 2, '准备多条命中用于循环')
const idx0 = bindings.search.idx
let prevented = false
bindings.onSearchKey({ key: 'Enter', isComposing: true, preventDefault: () => { prevented = true } })
eq(bindings.search.idx, idx0, 'IME 组词 Enter 不跳转')
ok(!prevented, 'IME 组词 Enter 不 preventDefault')
bindings.onSearchKey({ key: 'Enter', preventDefault: () => { prevented = true } })
eq(bindings.search.idx, (idx0 + 1) % bindings.search.hits.length, '普通 Enter 照常「下一个」')
ok(prevented, '普通 Enter preventDefault')

/* 5. 新版面：子代理独立卡片 + 字段布线 + 无卡死的 max=50 */
const src = read('assets/js/views/config.js')
ok(/cfg-multiagent/.test(src), '存在子代理独立卡片（cfg-multiagent）')
ok(/'multiagent', name: '子代理'/.test(src), '左栏导航含「子代理」分区')
ok(/workerTimeBudgetMs/.test(src) && /workerMaxTokens/.test(src) && /resultCap/.test(src), '时间/输出/结果回传预算字段已上卡')
const wmt = src.split('\n').find((l) => l.includes('v-model.number="form.multiagent.workerMaxTurns"'))
ok(!!wmt && !/max="50"/.test(wmt), 'workerMaxTurns 输入不再被 max=50 卡死（须容忍默认 200）')
const advLines = src.split('\n').filter((l) => /v-show="adv\./.test(l))
ok(advLines.length >= 6 && advLines.every((l) => l.includes('data-cf-adv')), `全部 ${advLines.length} 个高级参数块已标记 data-cf-adv`)

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
