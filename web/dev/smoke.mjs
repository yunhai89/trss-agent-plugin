/**
 * 前端冒烟测试(无浏览器):
 * 1. node --check 已由 lint 覆盖语法;本脚本在 vm 沙箱中加载全部前端脚本
 * 2. Vue.compile 编译所有组件/视图模板,捕获模板语法错误
 * 3. 调用每个视图的 setup(),捕获初始化逻辑错误
 * 运行:node web/dev/smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

/* Vue 运行时编译器用 div.innerHTML 解码 HTML 实体(浏览器才有真实解析),
 * 这里给 stub 元素实现同款行为:解析 <div foo="..."> 属性 + 常见实体反转义 */
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const el = () => {
  let html = ''
  const node = {
    style: {}, setAttribute: () => {}, appendChild: () => {}, removeChild: () => {}, insertBefore: () => {},
    nodeType: 1, tagName: 'DIV',
    set innerHTML(v) { html = v },
    get innerHTML() { return html },
    get textContent() { return unescape(html.replace(/<[^>]*>/g, '')) },
    get children() {
      const m = html.match(/<div foo="([\s\S]*?)"/)
      return [{ getAttribute: (k) => (k === 'foo' && m ? unescape(m[1]) : null) }]
    },
  }
  return node
}
const sandbox = {
  console,
  location: { hash: '#/dashboard' },
  performance,
  navigator: { userAgent: 'smoke' },
  requestAnimationFrame: () => 0,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  document: {
    getElementById: () => null, querySelector: () => null, addEventListener: () => {},
    body: el(), createElement: el, createElementNS: el, createTextNode: el, createComment: el,
  },
}
sandbox.window = sandbox
vm.createContext(sandbox)
const run = (file) => vm.runInContext(read(file), sandbox, { filename: file })

let failed = 0
const ok = (msg) => console.log('  ✔ ' + msg)
const bad = (msg, e) => { failed++; console.error('  ✘ ' + msg + '\n    ' + (e?.message || e)) }

/* 1. 加载脚本 */
for (const f of ['vendor/vue.global.prod.js', 'assets/js/mock.js', 'assets/js/components.js']) {
  try { run(f); ok('load ' + f) } catch (e) { bad('load ' + f, e) }
}
for (const f of ['dashboard', 'config', 'memory', 'recall', 'personas', 'skills', 'sessions', 'logs', 'schedule', 'confirm', 'suggestions', 'evolution', 'kb', 'humanize']) {
  try { run(`assets/js/views/${f}.js`); ok(`load views/${f}.js`) } catch (e) { bad(`load views/${f}.js`, e) }
}

const { Vue, MOCK, UI, VIEWS } = sandbox
if (!Vue || !MOCK || !UI || !VIEWS) { console.error('全局对象缺失'); process.exit(1) }

/* 2. 编译所有视图模板 + 执行 setup */
for (const [name, def] of Object.entries(VIEWS)) {
  try { Vue.compile(def.template); ok(`compile <${name}> template`) } catch (e) { bad(`compile <${name}> template`, e) }
  try {
    if (def.setup) def.setup({}, {})
    ok(`setup <${name}>`)
  } catch (e) { bad(`setup <${name}>`, e) }
}

/* 3. 编译共享组件模板(经 UI.register 收集) */
const collected = {}
UI.register({ component: (n, d) => { collected[n] = d } })
for (const [n, d] of Object.entries(collected)) {
  if (!d.template) { ok(`component <${n}> (render fn)`); continue }
  try { Vue.compile(d.template); ok(`compile component <${n}>`) } catch (e) { bad(`compile component <${n}>`, e) }
}

/* 4. App 外壳:拦截 createApp 拿到根组件后编译其模板 */
try {
  let rootDef = null
  const origCreateApp = Vue.createApp
  Vue.createApp = (def) => { rootDef = def; return { use: () => {}, component: () => {}, mount: () => {} } }
  run('assets/js/app.js')
  Vue.createApp = origCreateApp
  Vue.compile(rootDef.template)
  ok('compile <App> shell template')
} catch (e) { bad('app shell', e) }

/* 5. mock 结构抽样断言(对齐数据规范 §1-§3) */
const assert = (cond, msg) => (cond ? ok(msg) : (failed++, console.error('  ✘ ' + msg)))
assert(MOCK.config.apiKey.configured === true && typeof MOCK.config.apiKey.preview === 'string', 'config.apiKey 为 MaskedValue')
assert(MOCK.scopes.every((s) => /^(u_|g)/.test(s.scopeId)), 'scopeId 规则合法')
assert(Object.values(MOCK.memories).every((m) => m.memory && m.user), 'memories 含 MEMORY/USER 双文件')
const evts = new Set(MOCK.logFiles.flatMap((f) => f.events.map((e) => e.event)))
const need = ['trigger', 'media', 'input', 'run_start', 'turn', 'tool', 'tool_discovery', 'reflect', 'recall_extract', 'run_end', 'reply', 'error']
assert(need.every((n) => evts.has(n)), `devLog 12 种 event 全覆盖(实际 ${evts.size} 种)`)
assert(MOCK.suggestions.some((s) => s.action === 'replace' && s.newPayload), 'suggestions 含 replace diff 示例')

console.log(failed ? `\n共 ${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
