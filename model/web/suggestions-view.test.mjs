/**
 * 前端「进化建议」视图回归：KIND/ACTION/STATUS 必须覆盖后端可产出的取值，未知值也走兜底不抛。
 *
 * 背景（bug）：后端 review.js 产出 action='update'（ALLOWED_KIND 含 'tool'），
 * 而 views/suggestions.js 的 ACTION 只有 add/remove/replace、KIND 无 'tool'，
 * 模板里 `ACTION[s.action].cls` 未加保护 → 渲染时 TypeError → 整页空白（"进化建议还是空"）。
 * 本测试在 vm 沙箱中加载真实视图（真实 Vue），调用 setup 拿到的 meta 助手并逐一断言。
 * 运行：node model/web/suggestions-view.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))

/* Vue 运行时编译器用 div.innerHTML 解码 HTML 实体，需要一个能解析属性的 stub 元素（同 web/dev/smoke.mjs） */
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
function el() {
  let html = ''
  return {
    style: {}, setAttribute() {}, appendChild() {}, removeChild() {}, insertBefore() {},
    nodeType: 1, tagName: 'DIV',
    set innerHTML(v) { html = v },
    get innerHTML() { return html },
    get textContent() { return unescape(html.replace(/<[^>]*>/g, '')) },
    get children() {
      const m = html.match(/<div foo="([\s\S]*?)"/)
      return [{ getAttribute: (k) => (k === 'foo' && m ? unescape(m[1]) : null) }]
    },
  }
}

function loadView() {
  const vueCode = fs.readFileSync(path.join(root, 'web/vendor/vue.global.prod.js'), 'utf8')
  const viewCode = fs.readFileSync(path.join(root, 'web/assets/js/views/suggestions.js'), 'utf8')
  const sandbox = {
    console, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    location: { hash: '', search: '', pathname: '/' },
    document: {
      getElementById: () => null, querySelector: () => null, addEventListener() {},
      body: el(), createElement: el, createElementNS: el, createTextNode: el, createComment: el,
    },
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.UI = { toast() {}, fmt: {} }
  sandbox.MOCK = { suggestions: [] }
  sandbox.store = { loadSuggestions: async () => {} }
  vm.createContext(sandbox)
  vm.runInContext(vueCode, sandbox, { filename: 'vue.global.prod.js' })
  vm.runInContext(viewCode, sandbox, { filename: 'suggestions.js' })
  return sandbox
}

await test('模板编译通过', () => {
  const sb = loadView()
  sb.Vue.compile(sb.VIEWS.suggestions.template)
  ok(true, 'Vue.compile 无语法错误')
})

await test('meta 助手覆盖后端全部 kind/action/status（不再因缺映射渲染抛错）', () => {
  const sb = loadView()
  const b = sb.VIEWS.suggestions.setup({}, {})
  // 后端：ALLOWED_KIND / action(add|replace|remove|update|create) / status(pending|applied|apply_failed)
  for (const k of ['memory', 'skill', 'prompt', 'tool']) {
    const m = b.kindMeta(k)
    ok(m && m.name && m.cls && m.icon, `kindMeta('${k}') = ${m && m.name}`)
  }
  for (const a of ['add', 'replace', 'remove', 'update', 'create']) {
    const m = b.actionMeta(a)
    ok(m && m.name && m.cls, `actionMeta('${a}') = ${m && m.name}`)
  }
  for (const s of ['pending', 'applied', 'apply_failed']) {
    const m = b.statusMeta(s)
    ok(m && m.name && m.cls, `statusMeta('${s}') = ${m && m.name}`)
  }
})

await test('未知取值/缺失字段兜底：不抛异常（原崩溃点）', () => {
  const sb = loadView()
  const b = sb.VIEWS.suggestions.setup({}, {})
  ok(b.actionMeta('weird_action').name === 'weird_action', '未知 action → 原样展示，不抛')
  ok(b.kindMeta(undefined).name === '?', '缺失 kind → ?，不抛')
  ok(b.statusMeta(undefined).cls === 'p-line', '缺失 status → 兜底样式，不抛')
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
