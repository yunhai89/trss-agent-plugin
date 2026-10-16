/**
 * 离线自检 —— 抓取会话持久化 + 站点难度记忆 + 同站限速（P0 抗反爬）。
 * 运行：node model/crawl/session.test.mjs
 *
 * 被测不变量：
 *  - cookie 基础件：Set-Cookie 解析（HttpOnly/过期/跨域）、jar 预置与导出、playwright 形态互转；
 *  - session-store：按 host 存取、TTL 过期丢弃、损坏文件自愈、条数上限；
 *  - site-memory：有效档位记忆（fetch 够用 / crawl4ai 被拦 → undetected）、TTL、落盘复读；
 *  - host-gate：同 host 串行 + 最小间隔（FIFO），不同 host 互不影响；
 *  - crawlUrl 集成：记忆命中先 fetch / 直接用 undetected；会话 cookie 注入 fetch 并在抓取后回写。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseSetCookie, splitCombinedSetCookie, getSetCookieLines, createCookieJar,
  toPlaywrightCookie, fromPlaywrightCookie,
} from './cookies.js'
import { createSessionStore, sessionStoreFor, resetSessionStore, SESSION_FILE } from './session-store.js'
import { createHostGate, createSiteMemory, SITE_FILE } from './host-policy.js'
import { crawlUrl, resetCrawlSchedulers } from './index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const same = JSON.stringify(a) === JSON.stringify(b); ok(same, `${m}${same ? '' : `（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-session-test-'))
const pubLookup = async () => [{ address: '93.184.216.34', family: 4 }]

// ───────────────────────── cookies.js ─────────────────────────

await test('parseSetCookie：HttpOnly/Secure/过期/跨域', () => {
  const c = parseSetCookie('cf_clearance=abc123; Path=/; Domain=.a.com; Expires=Wed, 01 Jan 2098 00:00:00 GMT; Secure; HttpOnly', 'a.com', '/')
  ok(c && c.name === 'cf_clearance' && c.value === 'abc123', '主机 cookie 解析')
  eq(c.httpOnly, true, 'HttpOnly 保留（清关 cookie 的关键属性）')
  eq(c.secure, true, 'Secure 保留')
  eq(c.domain, 'a.com', 'Domain 归一化（去前导点，匹配时按后缀）')
  ok(c.expires > Date.now(), '过期时间晚于现在')
  eq(parseSetCookie('x=1; Domain=.b.com', 'a.com', '/'), null, '跨域 Domain 拒绝')
  eq(parseSetCookie('x=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'a.com', '/'), null, '已过期拒绝')
  const hostOnly = parseSetCookie('sid=1', 'a.com', '/deep/page')
  eq(hostOnly.domain, 'a.com', '无 Domain → 主机域')
  eq(hostOnly.path, '/deep', '无 Path → 请求路径的目录（RFC6265 默认路径）')
})

await test('splitCombinedSetCookie / getSetCookieLines', () => {
  const parts = splitCombinedSetCookie('a=1; Path=/, b=2; Path=/x')
  eq(parts.length, 2, '组合头按「, 后紧跟 name=」切分')
  const res = { headers: { getSetCookie: () => ['a=1', 'b=2'] } }
  eq(getSetCookieLines(res), ['a=1', 'b=2'], '优先 getSetCookie()')
  const legacy = { headers: { get: (k) => (String(k).toLowerCase() === 'set-cookie' ? 'a=1; Path=/, b=2' : null), getSetCookie: undefined } }
  eq(getSetCookieLines(legacy).length, 2, '回退组合头')
})

await test('createCookieJar：预置 seed / 导出 / 按域携带 / 上限淘汰', () => {
  const jar = createCookieJar({ seed: [{ name: 'cf_clearance', value: 'v1', domain: '.a.com', path: '/', expires: Date.now() + 3600_000 }] })
  const h = jar.header('https://a.com/x')
  ok(/cf_clearance=v1/.test(h), '预置 cookie 参与请求头')
  eq(jar.header('https://b.com/x'), '', '不跨域携带')
  jar.store('https://a.com/', ['sid=1; Path=/; HttpOnly'])
  eq(jar.size(), 2, 'store 追加')
  eq(jar.cookies().length, 2, 'cookies() 导出全部')
  const small = createCookieJar({ max: 2 })
  small.store('https://a.com/', ['a=1', 'b=2', 'c=3'])
  eq(small.size(), 2, 'max 上限生效')
})

await test('toPlaywrightCookie / fromPlaywrightCookie 互转', () => {
  const c = parseSetCookie('cf_clearance=abc; Path=/; Domain=.a.com; Expires=Wed, 01 Jan 2098 00:00:00 GMT; HttpOnly', 'a.com', '/')
  const pw = toPlaywrightCookie(c)
  eq(pw.name, 'cf_clearance', '转换为 playwright cookie')
  ok(pw.expires > 1e9 && pw.expires < 1e10, 'expires 用秒级时间戳')
  const back = fromPlaywrightCookie(pw)
  eq(back?.name, 'cf_clearance', '回程保留 name')
  eq(fromPlaywrightCookie({ name: 'x', value: '1', expires: 1 }), null, '已过期丢弃')
  const session = fromPlaywrightCookie({ name: 's', value: '1', expires: -1, domain: 'a.com' })
  eq(session.expires, null, '会话 cookie expires=null')
})

// ───────────────────────── session-store.js ─────────────────────────

await test('session-store：按 host 存取 / TTL 过期 / 损坏自愈 / 条数上限', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'store-'))
  let t = 1_700_000_000_000
  const store = createSessionStore({ dir, ttlHours: 1, maxPerHost: 2, now: () => t })
  store.merge('a.com', [{ name: 'cf_clearance', value: 'v', domain: '.a.com', path: '/', expires: t + 3600_000 }])
  eq(store.cookiesFor('a.com').length, 1, '写入后可读')
  eq(store.storageStateFor('a.com').cookies.map((c) => c.name), ['cf_clearance'], 'storageState 形态供浏览器注入')
  equal(store.flush(), true, '落盘')
  ok(fs.existsSync(path.join(dir, SESSION_FILE)), '会话文件已生成')
  const reread = createSessionStore({ dir, ttlHours: 1, now: () => t })
  eq(reread.cookiesFor('a.com').length, 1, '重新打开仍可读（跨进程复用）')
  // maxPerHost：超出保留最新
  store.merge('a.com', [{ name: 'a', value: '1', domain: 'a.com' }, { name: 'b', value: '2', domain: 'a.com' }])
  eq(store.cookiesFor('a.com').length, 2, 'maxPerHost 上限生效')
  // TTL：超出后丢弃（且不再回写）
  t += 2 * 3600_000
  const expired = createSessionStore({ dir, ttlHours: 1, now: () => t })
  eq(expired.cookiesFor('a.com').length, 0, '超 TTL 视为过期')
  // 损坏自愈
  const dir2 = fs.mkdtempSync(path.join(TMP, 'bad-'))
  fs.writeFileSync(path.join(dir2, SESSION_FILE), '{ not json')
  const healed = createSessionStore({ dir: dir2, logger: () => {} })
  eq(healed.cookiesFor('a.com'), [], '损坏文件重置为空')
  ok(fs.existsSync(path.join(dir2, `${SESSION_FILE}.bad`)), '损坏文件已备份为 .bad')
})

function equal(a, b, m) { eq(a, b, m) }

await test('session-store：sessionStoreFor 按 sessionDir/ttl 缓存', () => {
  resetSessionStore()
  const dir = fs.mkdtempSync(path.join(TMP, 'for-'))
  const a = sessionStoreFor({ sessionDir: dir, sessionTtlHours: 6 })
  const b = sessionStoreFor({ sessionDir: dir, sessionTtlHours: 6 })
  ok(a === b, '同配置复用单例')
  const c = sessionStoreFor({ sessionDir: dir, sessionTtlHours: 1 })
  ok(a !== c, '配置变化换新实例')
  resetSessionStore()
})

// ───────────────────────── host-policy.js ─────────────────────────

await test('host-gate：同 host 串行 + 最小间隔，不同 host 不受影响', async () => {
  let t = 0
  const gate = createHostGate({ intervalMs: 100, concurrency: 1, jitterMs: 0, now: () => t, sleep: async (ms) => { t += ms } })
  const order = []
  const rel1 = await gate.acquire('a.com')
  const p2 = gate.acquire('a.com').then((rel) => { order.push('second'); return rel })
  const p3 = gate.acquire('a.com').then((rel) => { order.push('third'); return rel })
  const other = await gate.acquire('b.com')
  order.push('other')
  other()
  const t0 = t
  rel1() // 释放第一个 → 第二个应等满 100ms 间隔
  const rel2 = await p2
  ok(t - t0 >= 100, `第二个请求等到最小间隔（${t - t0}ms）`)
  ok(order[0] === 'other', '不同 host 不被同站排队阻塞')
  rel2()
  const rel3 = await p3
  ok(order.includes('third'), 'FIFO 依次放行')
  rel3()
  eq(gate.stats('a.com').active, 0, '全部释放后无占用')
})

await test('host-gate：并发排队只放行 concurrency 个（防一次性全放行）', async () => {
  // 回归：pump 曾在 active 尚未自增时循环放行全部等待者（实测 concurrency=1 时 maxActive=3、间隔被绕过），
  // 使「同站串行 + 最小间隔」的反爬节奏保护形同虚设。
  let t = 0
  const gate = createHostGate({ intervalMs: 100, concurrency: 1, jitterMs: 0, now: () => t, sleep: async (ms) => { t += ms } })
  let active = 0
  let maxActive = 0
  const starts = []
  await Promise.all([1, 2, 3, 4].map(async () => {
    const rel = await gate.acquire('x.com')
    active += 1
    maxActive = Math.max(maxActive, active)
    starts.push(t)
    await new Promise((r) => setImmediate(r))
    active -= 1
    rel()
  }))
  eq(maxActive, 1, '并发上限恒为 1（曾一次性放行全部排队者）')
  ok(starts[1] - starts[0] >= 100, `第二个开始时间受限速间隔约束（+${starts[1] - starts[0]}ms）`)
  ok(starts[2] - starts[1] >= 100, `第三个同样受限速间隔约束（+${starts[2] - starts[1]}ms）`)
  eq(gate.stats('x.com').active, 0, '全部释放后无占用')
})

await test('site-memory：有效档位记忆与 TTL', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'mem-'))
  let t = 1_700_000_000_000
  const mem = createSiteMemory({ dir, ttlDays: 1, now: () => t })
  eq(mem.preferredTier('new.com'), null, '无记录 → 默认阶梯')
  mem.note('f.com', { ok: true, tier: 'fetch' })
  eq(mem.preferredTier('f.com'), 'fetch', 'fetch 成功 → 下次先 fetch')
  mem.note('c.com', { ok: false, tier: 'crawl4ai', code: 'blocked' })
  eq(mem.preferredTier('c.com'), 'undetected', '普通档被拦 → 直接用 undetected')
  mem.note('c.com', { ok: true, tier: 'undetected' })
  eq(mem.preferredTier('c.com'), 'undetected', '强化档成功 → 继续用强化档')
  mem.note('x.com', { ok: false, tier: 'crawl4ai', code: 'protocol_error' })
  eq(mem.preferredTier('x.com'), null, '非拦截失败不改变档位')
  mem.flush()
  ok(fs.existsSync(path.join(dir, SITE_FILE)), '记忆已落盘')
  const reread = createSiteMemory({ dir, ttlDays: 1, now: () => t })
  eq(reread.preferredTier('c.com'), 'undetected', '重新打开仍记得')
  t += 2 * 86400_000
  const stale = createSiteMemory({ dir, ttlDays: 1, now: () => t })
  stale.prune()
  eq(stale.preferredTier('c.com'), null, '超 TTL 遗忘')
})

// ───────────────────────── crawlUrl 集成 ─────────────────────────

const C4AI_OK = async () => ({ success: true, via: 'crawl4ai', markdown: 'C'.repeat(50), title: 'C' })

await test('crawlUrl：站点记忆「fetch 够用」→ 跳过浏览器', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'int1-'))
  resetCrawlSchedulers(); resetSessionStore()
  let c4aiCalls = 0
  const opts = {
    engine: 'crawl4ai', _lookup: pubLookup, sessionDir: dir,
    _avail: async () => ({ ok: true }), _c4ai: async () => { c4aiCalls++; return C4AI_OK() },
    _fetch: async () => ({ success: true, via: 'fetch', markdown: 'F'.repeat(30), title: 'F' }),
  }
  const first = await crawlUrl('https://mem.example/page', opts)
  eq(first.via, 'crawl4ai', '首次走默认档位（浏览器）')
  // 手动把该站记为 fetch 足够（模拟「浏览器失败 → fetch 成功」）
  const { createSiteMemory: mk } = await import('./host-policy.js')
  const mem = mk({ dir })
  mem.note('mem.example', { ok: true, tier: 'fetch' })
  mem.flush()
  resetCrawlSchedulers()
  c4aiCalls = 0
  const second = await crawlUrl('https://mem.example/page2', opts)
  eq(second.via, 'fetch', '记忆命中：直接 fetch')
  eq(c4aiCalls, 0, '不再启动浏览器')
})

await test('crawlUrl：站点记忆「普通档被拦」→ 首次即 undetected', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'int2-'))
  resetCrawlSchedulers(); resetSessionStore()
  const { createSiteMemory: mk } = await import('./host-policy.js')
  const mem = mk({ dir })
  mem.note('hard.example', { ok: false, tier: 'crawl4ai', code: 'blocked' })
  mem.flush()
  const seen = []
  const r = await crawlUrl('https://hard.example/x', {
    engine: 'crawl4ai', _lookup: pubLookup, sessionDir: dir,
    _avail: async () => ({ ok: true }),
    _c4ai: async (url, o) => { seen.push(o); return C4AI_OK() },
    _fetch: async () => { throw new Error('不应走 fetch') },
  })
  eq(seen.length, 1, '只尝试一次（不再打注定被拦的普通档）')
  eq(seen[0].undetected, true, '首次即 undetected')
  eq(seen[0].waitUntil, 'load', '强化档等待策略')
  ok(r.success && r.escalated === true, '结果标记为强化档命中')
})

await test('crawlUrl：会话 cookie 注入 fetch 并回写（含失败路径）', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'int3-'))
  resetCrawlSchedulers(); resetSessionStore()
  // 预置上轮拿到的清关 cookie
  const store = sessionStoreFor({ sessionDir: dir, sessionTtlHours: 12 })
  store.merge('site.example', [{ name: 'cf_clearance', value: 'OLD', domain: 'site.example', path: '/', expires: Date.now() + 3600_000 }])
  store.flush()
  resetSessionStore()
  const seenHeaders = []
  const r = await crawlUrl('https://site.example/a', {
    engine: 'fetch', _lookup: pubLookup, sessionDir: dir,
    _fetch: async (url, o) => {
      seenHeaders.push(o.jar ? o.jar.header(url) : '')
      if (o.jar) o.jar.store(url, ['__cf_bm=NEW; Path=/; HttpOnly'])
      return { success: true, via: 'fetch', markdown: 'F'.repeat(30), title: 'F' }
    },
  })
  ok(/cf_clearance=OLD/.test(seenHeaders[0]), '持久会话 cookie 已注入本次请求')
  ok(r.success, '抓取成功')
  resetSessionStore()
  const reread = sessionStoreFor({ sessionDir: dir, sessionTtlHours: 12 })
  const names = reread.cookiesFor('site.example').map((c) => c.name).sort()
  eq(names, ['__cf_bm', 'cf_clearance'], '本次拿到的新 cookie 已回写（下一轮复用）')
  eq(reread.cookiesFor('site.example').find((c) => c.name === '__cf_bm')?.httpOnly, true, 'HttpOnly 属性随会话保存')
})

await test('crawlUrl：浏览器回传 cookie 合并 + 同站限速生效', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'int4-'))
  resetCrawlSchedulers(); resetSessionStore()
  const r = await crawlUrl('https://browser.example/a', {
    engine: 'crawl4ai', _lookup: pubLookup, sessionDir: dir, perHostIntervalMs: 150,
    _avail: async () => ({ ok: true }),
    _c4ai: async () => ({ ...(await C4AI_OK()), cookies: [{ name: 'sess', value: 'S', domain: 'browser.example', path: '/', expires: -1 }] }),
    _fetch: async () => { throw new Error('不应走 fetch') },
  })
  ok(r.success, '浏览器抓取成功')
  resetSessionStore()
  const store = sessionStoreFor({ sessionDir: dir, sessionTtlHours: 12 })
  eq(store.cookiesFor('browser.example').map((c) => c.name), ['sess'], '浏览器回传的 cookie 已入库')
  // 同站限速：第二次抓取必须等满最小间隔
  const t0 = Date.now()
  await crawlUrl('https://browser.example/b', {
    engine: 'crawl4ai', _lookup: pubLookup, sessionDir: dir, perHostIntervalMs: 150,
    _avail: async () => ({ ok: true }), _c4ai: C4AI_OK, _fetch: async () => { throw new Error('不应走 fetch') },
  })
  ok(Date.now() - t0 >= 130, `第二次同站抓取受最小间隔约束（${Date.now() - t0}ms）`)
})

// ───────────────────────── 收尾 ─────────────────────────

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
process.exit(failed ? 1 : 0)
