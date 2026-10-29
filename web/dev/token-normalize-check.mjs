/**
 * 前端登录 token 归一化离线自检（无浏览器，vm 沙箱加载真实 store.js）。
 *
 * 背景（线上故障 2026-10）：Web 人设页打开即报
 *   `Failed to execute 'fetch' on 'Window': Failed to read the 'headers' property from
 *    'RequestInit': String contains non ISO-8859-1 code point`
 * 原因：用户把 `#agents登录` 返回的整段内容（含「🌐 公网地址：」等中文）粘进登录框，
 * 旧代码原样存进 localStorage 并塞进 Authorization 头 → 浏览器拒绝该 RequestInit，
 * 之后所有页面（人设库等）的接口全失败。
 *
 * 覆盖：
 *  ① normalizeToken：48 位 hex / 完整链接 / 带中文的整段消息 / 非法输入；
 *  ② setToken：非法值直接清空，不会写入 localStorage；
 *  ③ 历史脏 token 自愈：读到时归一 + 清理，Authorization 头始终只含 ASCII；
 *  ④ storeLoginFromUrl：?token= 归一后落地。
 *
 * 运行：node web/dev/token-normalize-check.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const A = JSON.stringify(a), B = JSON.stringify(b); ok(A === B, `${m}${A === B ? '' : `（实际 ${A}，期望 ${B}）`}`) }

/** 建一个跑 store.js 的最小沙箱；fetch 记录请求头 */
function makeSandbox({ token = '', fetchResult = { code: 0, data: [] } } = {}) {
  const store = new Map()
  if (token) store.set('agents_token', token)
  const calls = []
  const sandbox = {
    console,
    location: { search: '', hash: '', pathname: '/' },
    history: { replaceState: () => {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: async (url, opt = {}) => {
      calls.push({ url, headers: opt.headers || {}, body: opt.body })
      return { json: async () => fetchResult }
    },
    URLSearchParams,
    Event: class { constructor(t) { this.type = t } },
    dispatchEvent: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
  }
  sandbox.window = sandbox
  sandbox.Vue = { reactive: (o) => o }
  vm.createContext(sandbox)
  vm.runInContext(read('assets/js/store.js'), sandbox, { filename: 'store.js' })
  return { sandbox, store, calls, api: sandbox.api }
}

const HEX = 'a'.repeat(48)
const HEX2 = 'b'.repeat(48)

console.log('\n[1] normalizeToken：合法形态与常见粘贴方式')
{
  const { api } = makeSandbox()
  eq(api.normalizeToken(HEX), HEX, '48 位 hex 原样通过')
  eq(api.normalizeToken('  ' + HEX + '  '), HEX, '首尾空白自动去掉')
  eq(api.normalizeToken(`http://127.0.0.1:6098/?token=${HEX}`), HEX, '完整本地登录链接 → 抽 token')
  eq(api.normalizeToken(`https://example.com:6098/?token=${HEX}&x=1#/dashboard`), HEX, '带其它参数/锚点也能抽')
  eq(api.normalizeToken(`🌐 公网地址：\nhttp://1.2.3.4:6098/?token=${HEX}\n💻 本地地址：...`), HEX, '带中文的整段消息 → 抽 token')
  eq(api.normalizeToken(`token: ${HEX}`), HEX, '文本里含裸 token 也能抽')
  eq(api.normalizeToken(''), '', '空串 → 空')
  eq(api.normalizeToken('短token'), '', '过短/中文 → 空（拒绝）')
  eq(api.normalizeToken('🌐🌐🌐'), '', '纯中文/emoji → 空')
  eq(api.normalizeToken(`http://x/?token=%E4%B8%AD%E6%96%87`), '', 'URL 编码的中文 token → 空')
  eq(api.normalizeToken(`${HEX2}!@#$`), HEX2, '尾部脏字符被剥离后仍取合法段')
}

console.log('\n[2] setToken：非法值不得写入 localStorage')
{
  const { api, store } = makeSandbox()
  eq(api.setToken('中文非法值'), '', '非法 token 返回空')
  eq(store.has('agents_token'), false, '非法 token 不落库（旧值已被清）')
  eq(api.setToken(HEX), HEX, '合法 token 返回规范化值')
  eq(store.get('agents_token'), HEX, '合法 token 落库')
}

console.log('\n[3] 历史脏 token 自愈：Authorization 头只含 ASCII')
{
  const dirty = `🌐 公网地址：http://1.2.3.4:6098/?token=${HEX}`
  const { api, store, calls } = makeSandbox({ token: dirty })
  await api.get('/personas')
  const auth = calls[0]?.headers?.Authorization || ''
  eq(auth, 'Bearer ' + HEX, '请求头用归一后的 token（不再是整段中文）')
  // eslint-disable-next-line no-control-regex
  ok(!/[^\x20-\x7e]/.test(auth), 'Authorization 头不含非 ISO-8859-1 字符（浏览器不会再抛 RequestInit 错）')
  eq(store.get('agents_token'), HEX, 'localStorage 中的脏值已自愈')
}

console.log('\n[4] 无法归一的历史脏值：清空并按未登录处理')
{
  const { api, store, calls } = makeSandbox({ token: '🌐中文垃圾', fetchResult: { code: 4010, msg: '未认证或 token 已失效' } })
  let err = null
  try { await api.get('/scopes') } catch (e) { err = e }
  eq(store.has('agents_token'), false, '不可归一 → 直接清掉')
  eq(calls[0]?.headers?.Authorization, undefined, '不发送 Authorization 头（避免浏览器 header 编码异常）')
  ok(/未登录|未认证/.test(String(err?.message || '')), `按 4010 处理并提示重新登录（${err?.message || ''}）`)
}

console.log('\n[5] storeLoginFromUrl：登录直跳链接')
{
  const { sandbox, store, calls, api } = makeSandbox()
  sandbox.location.search = '?token=' + HEX
  const r = sandbox.storeLoginFromUrl()
  eq(r, true, '识别到合法 token 返回 true')
  eq(store.get('agents_token'), HEX, 'token 落地 localStorage')
  sandbox.location.search = '?token=中文坏值'
  eq(sandbox.storeLoginFromUrl(), false, '非法 token 返回 false（不落地）')
  eq(store.get('agents_token'), HEX, '保留原合法 token')
  await api.get('/scopes')
  eq(calls[0]?.headers?.Authorization, 'Bearer ' + HEX, '后续请求仍用合法 token')
}

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
process.exit(failed ? 1 : 0)
