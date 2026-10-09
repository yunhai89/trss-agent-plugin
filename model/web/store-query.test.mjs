/**
 * 前端数据层查询串回归：web store.js 的 request() 必须丢弃 null/undefined 查询参数。
 *
 * 背景（bug）：loadSuggestions() 传 {scopeId: undefined, status: undefined}，
 * 旧实现 new URLSearchParams(query) 会序列化成字面量 "scopeId=undefined&status=undefined"，
 * 后端据此当有效值过滤 → Web「进化建议」页恒空（磁盘有 pending 也看不见）。
 * 本测试在 vm 沙箱中加载真实 store.js（桩 Vue/fetch），断言真实请求 URL。
 * 运行：node model/web/store-query.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

const storePath = path.resolve(fileURLToPath(new URL('../../web/assets/js/store.js', import.meta.url)))
const code = fs.readFileSync(storePath, 'utf8')

function loadStore() {
  const sandbox = {
    Vue: { reactive: (o) => o },
    localStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    URLSearchParams,
    setTimeout, clearTimeout, console,
    fetch: async (url) => { sandbox.__lastUrl = url; return { json: async () => ({ code: 0, data: [] }) } },
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'store.js' })
  return sandbox
}

await test('request()：undefined/null 查询参数不进入 URL（修真「进化建议」页恒空）', async () => {
  const sb = loadStore()
  await sb.api.get('/suggestions', { scopeId: undefined, status: undefined })
  ok(sb.__lastUrl === '/api/suggestions', `省略 undefined 参数（实际 ${sb.__lastUrl}）`)
  ok(!/undefined|status=/.test(sb.__lastUrl), 'URL 不含字面量 undefined')

  await sb.api.get('/memories', { scopeId: undefined })
  ok(sb.__lastUrl === '/api/memories', `单 undefined 参数也省略（实际 ${sb.__lastUrl}）`)

  await sb.api.get('/suggestions', { scopeId: null, status: null })
  ok(sb.__lastUrl === '/api/suggestions', `null 同样省略（实际 ${sb.__lastUrl}）`)
})

await test('request()：有值参数正常拼接；空对象/缺省不带 "?"', async () => {
  const sb = loadStore()
  await sb.api.get('/suggestions', { scopeId: 'g1', status: 'pending' })
  ok(sb.__lastUrl === '/api/suggestions?scopeId=g1&status=pending', `有值参数保留（实际 ${sb.__lastUrl}）`)

  await sb.api.get('/suggestions', { scopeId: 'g1', status: undefined })
  ok(sb.__lastUrl === '/api/suggestions?scopeId=g1', `部分有值只带该参数（实际 ${sb.__lastUrl}）`)

  await sb.api.get('/overview', {})
  ok(sb.__lastUrl === '/api/overview', `空对象不带尾 "?"（实际 ${sb.__lastUrl}）`)

  await sb.api.get('/logs/files')
  ok(sb.__lastUrl === '/api/logs/files', `缺省 query 不带 "?"（实际 ${sb.__lastUrl}）`)
})

await test('request()：空字符串参数保留（语义可能与缺省不同）', async () => {
  const sb = loadStore()
  await sb.api.get('/x', { q: '' })
  ok(sb.__lastUrl === '/api/x?q=', `空串保留为 q=（实际 ${sb.__lastUrl}）`)
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
