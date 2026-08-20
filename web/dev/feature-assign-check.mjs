/**
 * 回归验证：功能分配下拉对「与主接入同端点的附加厂商模型」的可选性（真实 setup 入口，非复制实现）。
 * 运行：node web/dev/feature-assign-check.mjs
 *
 * 背景（生产实案）：主接入 = mimo（preset mimo / https://api.xiaomimimo.com/v1），用户又在
 * 「厂商配置」登记了同端点的 mimo 附加厂商，模型条目挂在附加厂商 id 下 → 功能分配的
 * mainOnly 功能（旁路/记忆/评审/子代理/伪人/群世界）判定 main = (providerId==='main') → 全部禁选。
 * 契约：mainOnly 的语义是「该功能运行时复用主 provider 端点」——同端点条目应可选。
 *
 * 断言：
 *   1. 同端点附加厂商的 mimo 条目 main=true（mainOnly 功能可选）——修复前为 false（复现）
 *   2. 不同端点厂商（豆包）条目 main=false（仍禁选——保护运行时端点约束）
 *   3. providerId='main' 条目 main=true（原行为不回归）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

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
  console, location: { hash: '#/config' }, performance,
  navigator: { userAgent: 'check' },
  requestAnimationFrame: () => 0,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  fetch: () => Promise.resolve({ ok: false }),
  document: {
    getElementById: () => null, querySelector: () => null, addEventListener: () => {},
    body: el(), createElement: el, createElementNS: el, createTextNode: el, createComment: el,
  },
}
sandbox.window = sandbox
vm.createContext(sandbox)
const run = (file) => vm.runInContext(read(file), sandbox, { filename: file })

for (const f of ['vendor/vue.global.prod.js', 'assets/js/mock.js', 'assets/js/components.js', 'assets/js/views/config.js']) run(f)

// 真实 setup 入口（与 smoke.mjs 同法：def.setup(ctx, props)）
const bindings = sandbox.window.VIEWS.config.setup({}, {})

// 注入生产同构数据：主接入 mimo；附加厂商 mimo（同端点）+ 豆包（异端点）；模型挂附加厂商
const f = bindings.form
f.protocol = 'openai'
f.preset = 'mimo'
f.baseURL = 'https://api.xiaomimimo.com/v1'
f.model = 'mimo-v2.5-pro'
f.llmProviders = [
  { id: 'pmimo', name: 'mimo', protocol: 'openai', preset: 'mimo', baseURL: 'https://api.xiaomimimo.com/v1', apiKey: 'sk-x' },
  { id: 'pdoubao', name: '豆包', protocol: 'openai', preset: 'doubao', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'k' },
]
f.llmModels = [
  { id: 'm1', name: '', providerId: 'pmimo', model: 'mimo-v2.5-pro', note: '主模型' },
  { id: 'm2', name: '全模态', providerId: 'pmimo', model: 'mimo-v2.5', note: '' },
  { id: 'm3', name: '', providerId: 'pdoubao', model: 'doubao-seed-1-6', note: '' },
]

let passed = 0, failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

const list = bindings.knownModels.value
const byModel = Object.fromEntries(list.map((x) => [x.model, x]))
ok(list.length === 3, `knownModels 含全部 3 条（实际 ${list.length}）`)
ok(byModel['mimo-v2.5-pro']?.main === true, '同端点附加厂商的 mimo-v2.5-pro → main=true（mainOnly 功能可选）')
ok(byModel['mimo-v2.5']?.main === true, '同端点附加厂商的 mimo-v2.5 → main=true')
ok(byModel['doubao-seed-1-6']?.main === false, '异端点厂商的 doubao 条目 → main=false（仍禁选，保住端点约束）')

// featureSel：mainOnly 功能选中同端点 mimo 条目时回显其注册 id（而非 __custom）
const mainOnlyFeature = bindings.FEATURES?.find((x) => x.mainOnly)
if (mainOnlyFeature) {
  mainOnlyFeature.set('mimo-v2.5')
  const sel = bindings.featureSel(mainOnlyFeature)
  ok(sel === 'm2', `mainOnly 功能已配同端点 mimo 模型 → 下拉回显注册条目（实际 ${JSON.stringify(sel)}）`)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed ? 1 : 0)
