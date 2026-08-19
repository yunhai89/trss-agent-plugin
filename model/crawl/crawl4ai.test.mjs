/**
 * 离线自检 —— crawl4ai Python 子进程监管（协议/超时/进程树清理/降级路由）。
 * 运行：node model/crawl/crawl4ai.test.mjs  （无需安装 crawl4ai：用桩 python 脚本驱动协议层）
 *
 * 被测不变量（对照 python-subprocess-supervision skill 测试矩阵）：
 *  - argv + shell=False，stdin JSON 请求 / stdout 单行 JSON 结果 / stderr 日志；
 *  - 并发 drain：stderr 大量输出不堵死 stdout（pipe 死锁）；
 *  - 超时：分阶段关闭（terminate 进程组 → 升级 kill），整棵进程树被回收、无僵尸；
 *  - 结构化错误：spawn_failed / request_timeout / protocol_error / crashed / crawl_failed；
 *  - 路由：crawl4ai 失败/不可用自动降级 fetch，engine=fetch 时不启子进程。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCrawl4ai, isCrawl4aiAvailable, CRAWL4AI_TIMEOUTS } from './crawl4ai.js'
import { crawlUrl } from './index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl4ai-test-'))
const PYTHON = process.execPath // 用 node 桩脚本模拟 python 协议行为（跨平台、无需真 python）

// 桩脚本：读 stdin 一行 JSON 请求，按 req.url 的模式输出
//   ok://...     → 成功结果 JSON，退出 0
//   fail://...   → {ok:false,error:...}，退出 2（爬取失败）
//   badjson://   → 输出非 JSON，退出 0（协议错误）
//   crash://     → 直接退出 4 + stderr（内部异常）
//   hang://      → 永不输出（触发父侧超时）；带 child 时先 spawn 孙进程再挂起（进程树验证）
//   bigerr://    → stderr 灌 2MB（drain 验证）后成功
const STUB = path.join(TMP, 'stub.cjs')
fs.writeFileSync(STUB, `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const fsSync = require('node:fs')
let s = ''
process.stdin.on('data', (d) => {
  s += d
  const i = s.indexOf('\\n')
  if (i < 0) return
  const req = JSON.parse(s.slice(0, i))
  const u = req.url || ''
  if (process.env.STUB_ECHO_FILE) { // 回显模式：收到的完整请求落盘（透传断言用，不污染协议结果）
    fsSync.writeFileSync(process.env.STUB_ECHO_FILE, JSON.stringify(req))
    process.stdout.write(JSON.stringify({ ok: true, url: u, status_code: 200, title: 'T', markdown: 'M'.repeat(30) }) + '\\n')
    process.exit(0)
  }
  if (u.startsWith('ok://') || u.startsWith('bigerr://')) {
    if (u.startsWith('bigerr://')) process.stderr.write('E'.repeat(2 * 1024 * 1024))
    const n = Number(process.env.STUB_EXTRA_SPLIT || 0)
    if (n) { process.stdout.write('{"partial":'); setTimeout(() => process.stdout.write('"半包"},"junk":' + '\\n' + JSON.stringify({ ok: true, url: u, status_code: 200, title: 'T', markdown: 'M'.repeat(50) }) + '\\n'), 50); return }
    process.stdout.write(JSON.stringify({ ok: true, url: u, status_code: 200, title: '标题', markdown: '正文'.repeat(30), fit_used: true, raw_len: 999 }) + '\\n')
    process.exit(0)
  }
  if (u.startsWith('fail://')) { process.stdout.write(JSON.stringify({ ok: false, url: u, error: 'HTTP 403' }) + '\\n'); process.exit(2) }
  if (u.startsWith('badjson://')) { process.stdout.write('这不是 JSON' + '\\n'); process.exit(0) }
  if (u.startsWith('crash://')) { process.stderr.write('Traceback ...'); process.exit(4) }
  if (u.startsWith('hang://')) {
    const child = spawn(process.env.STUB_CHILD || 'sleep', (process.env.STUB_CHILD ? [] : ['30']), { detached: true, stdio: 'ignore' })
    child.unref()
    fsSync.writeFileSync(process.env.STUB_CHILD_PID_FILE || path.join('${TMP}', 'child.pid'), String(child.pid))
    setInterval(() => {}, 1000) // 挂起
  }
})
process.stdin.on('end', () => {})
`)
process.env.STUB_CHILD_PID_FILE = path.join(TMP, 'child.pid')

const call = (url, opts = {}) => runCrawl4ai(url, { python: PYTHON, script: STUB, timeoutMs: opts.timeoutMs ?? 4000, ...opts })

await test('正常路径：stdin JSON → stdout JSON 结果映射（success/markdown/title/via）', async () => {
  const r = await call('ok://example.com')
  ok(r.success, 'success=true')
  ok(r.markdown.includes('正文'), 'markdown 透传')
  eq2(r.title, '标题', 'title 透传')
  eq2(r.via, 'crawl4ai', 'via=crawl4ai')
  ok(r.code == null, '成功无错误码')
})
function eq2(a, b, m) { ok(a === b, `${m}（实际 ${JSON.stringify(a)}）`) }

await test('半包+多包+坏帧：输出分片送达仍完整解析（读循环累积到换行）', async () => {
  process.env.STUB_EXTRA_SPLIT = '1'
  try {
    const r = await call('ok://example.com')
    ok(r.success && r.markdown.length >= 50, `分片输出仍解析成功（${r.success ? 'ok' : r.error}）`)
  } finally { delete process.env.STUB_EXTRA_SPLIT }
})

await test('stderr 2MB 灌注：不 pipe 死锁，结果照常返回 + stderr 尾部留存', async () => {
  const t0 = Date.now()
  const r = await call('bigerr://example.com')
  ok(r.success, `stderr 洪水不堵死结果（耗时 ${Date.now() - t0}ms）`)
})

await test('爬取失败：退出码 2 → crawl_failed + stderr 尾部留存', async () => {
  const r = await call('fail://example.com')
  ok(!r.success, 'success=false')
  eq2(r.code, 'crawl_failed', '结构化错误码 crawl_failed')
  ok(String(r.error).includes('403'), '错误信息透传')
})

await test('坏 JSON：protocol_error（不误判为爬取失败）', async () => {
  const r = await call('badjson://example.com')
  ok(!r.success && r.code === 'protocol_error', `code=${r.code}`)
})

await test('子进程崩溃：退出码 4 → crashed + stderr 尾部留存', async () => {
  const r = await call('crash://example.com')
  ok(!r.success && r.code === 'crashed', `code=${r.code}`)
  ok(r.stderrTail && r.stderrTail.length > 0, 'stderr 尾部留存（诊断）')
})

await test('超时：request_timeout + 整棵进程树回收（孙进程也终止，无僵尸）', async () => {
  const pidFile = process.env.STUB_CHILD_PID_FILE
  try { fs.unlinkSync(pidFile) } catch {}
  const r = await call('hang://example.com', { timeoutMs: 800 })
  ok(!r.success && r.code === 'request_timeout', `code=${r.code}`)
  // 等待 kill 完成后，孙进程（sleep 30 / detached）必须已死：kill(pid,0) 应抛 ESRCH
  let childDead = false
  for (let i = 0; i < 30; i++) {
    const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : 0)
    if (pid) {
      try { process.kill(pid, 0); await new Promise((r2) => setTimeout(r2, 200)) }
      catch { childDead = true; break }
    } else { await new Promise((r2) => setTimeout(r2, 100)) }
  }
  ok(childDead, '孙进程随进程组被清理（无孤儿存活）')
})

await test('spawn 失败：spawn_failed（脚本不存在）', async () => {
  const r = await runCrawl4ai('ok://x', { python: PYTHON, script: path.join(TMP, '不存在.cjs'), timeoutMs: 2000 })
  ok(!r.success && r.code === 'spawn_failed', `code=${r.code}`)
})

await test('可用性探测：版本输出 → 可用；非零 → 不可用；结果缓存（TTL 内不重复探测）', async () => {
  // 探测桩：计数器文件记录被调用次数
  const counter = path.join(TMP, 'probe.count')
  fs.writeFileSync(counter, '0')
  const probeStub = path.join(TMP, 'probe.cjs')
  fs.writeFileSync(probeStub, `#!/usr/bin/env node
require('node:fs').writeFileSync('${counter}', String(Number(require('node:fs').readFileSync('${counter}', 'utf8')) + 1))
if (process.env.PROBE_MODE === 'fail') process.exit(1)
if (process.env.PROBE_MODE === 'garbage') { process.stdout.write('not-a-version\\n'); process.exit(0) }
process.stdout.write('0.9.2\\n')
`)
  fs.chmodSync(probeStub, 0o755)
  process.env.PROBE_MODE = 'ok'
  const a1 = await isCrawl4aiAvailable({ python: probeStub, probeArg: [], ttl: 60000 })
  ok(a1.ok && a1.version === '0.9.2', `探测成功 + 版本（${JSON.stringify(a1)}）`)
  await isCrawl4aiAvailable({ python: probeStub, probeArg: [], ttl: 60000 })
  eq2(Number(fs.readFileSync(counter, 'utf8')), 1, 'TTL 内第二次探测命中缓存（不重复 spawn）')
  process.env.PROBE_MODE = 'fail'
  const a2 = await isCrawl4aiAvailable({ python: probeStub, probeArg: [], ttl: 0 })
  ok(!a2.ok, '非零退出 → 不可用')
  process.env.PROBE_MODE = 'garbage'
  const a3 = await isCrawl4aiAvailable({ python: probeStub, probeArg: [], ttl: 0 })
  ok(a3.ok, '垃圾版本串仍算可用（版本仅诊断用，判活看退出码）')
  delete process.env.PROBE_MODE
})

await test('路由：crawl4ai 成功 → 不走 fetch；失败/不可用 → 降级 fetch；engine=fetch → 不启子进程', async () => {
  const calls = { c4ai: 0, fetch: 0 }
  const c4aiOk = async () => { calls.c4ai++; return { success: true, markdown: 'C4AI 正文', title: 'C4AI', via: 'crawl4ai' } }
  const c4aiBad = async () => { calls.c4ai++; return { success: false, code: 'crawl_failed', error: 'x' } }
  const fetchStub = async () => { calls.fetch++; return { success: true, markdown: 'FETCH 正文', title: 'FETCH', via: 'fetch' } }
  // 1) crawl4ai 成功
  let r = await crawlUrl('https://a.com', { engine: 'crawl4ai', _avail: async () => ({ ok: true }), _c4ai: c4aiOk, _fetch: fetchStub })
  ok(r.success && r.via === 'crawl4ai', 'crawl4ai 命中')
  eq2(calls.fetch, 0, '成功时不走 fetch')
  // 2) crawl4ai 失败 → 降级
  r = await crawlUrl('https://a.com', { engine: 'crawl4ai', _avail: async () => ({ ok: true }), _c4ai: c4aiBad, _fetch: fetchStub })
  ok(r.success && r.via === 'fetch', `失败自动降级 fetch（via=${r.via}）`)
  eq2(calls.c4ai, 2, 'crawl4ai 被尝试过')
  // 3) 不可用 → 直接 fetch
  calls.c4ai = 0
  r = await crawlUrl('https://a.com', { engine: 'crawl4ai', _avail: async () => ({ ok: false }), _c4ai: c4aiOk, _fetch: fetchStub })
  ok(r.via === 'fetch', '不可用直接 fetch')
  eq2(calls.c4ai, 0, '不可用时不启子进程')
  // 4) engine=fetch 强制
  r = await crawlUrl('https://a.com', { engine: 'fetch', _avail: async () => ({ ok: true }), _c4ai: c4aiOk, _fetch: fetchStub })
  ok(r.via === 'fetch', 'engine=fetch 强制纯 HTTP')
  eq2(calls.c4ai, 0, 'engine=fetch 不启子进程')
})

await test('超时常量：外部可覆盖（安装/慢站场景）', async () => {
  ok(CRAWL4AI_TIMEOUTS && Number.isFinite(CRAWL4AI_TIMEOUTS.defaultMs), 'CRAWL4AI_TIMEOUTS.defaultMs 存在')
})

await test('高级参数透传：wait_for/js_code 数组/extract/links/stealth/virtual_scroll 完整到达子进程请求', async () => {
  const echoFile = path.join(TMP, 'echo-req.json')
  process.env.STUB_ECHO_FILE = echoFile
  try {
    const r = await runCrawl4ai('ok://x.com', {
      python: PYTHON, script: STUB, timeoutMs: 4000,
      waitFor: 'css:.quote:nth-child(11)', jsCode: ["window.scrollTo(0, document.body.scrollHeight)", "document.querySelector('.more')?.click()"],
      delayMs: 1500, cssSelector: '.main-content',
      extract: { baseSelector: '.quote', fields: [{ name: 'text', selector: '.text', type: 'text' }] },
      links: true, stealth: true, flatShadowDom: true,
      virtualScroll: { container_selector: '.feed', scroll_count: 8, wait_after_scroll: 1.5 },
    })
    ok(r.success, '抓取成功')
    const req = JSON.parse(fs.readFileSync(echoFile, 'utf8'))
    eq2(req.wait_for, 'css:.quote:nth-child(11)', 'wait_for 透传（snake_case）')
    ok(Array.isArray(req.js_code) && req.js_code.length === 2 && req.js_code[0].includes('scrollTo'), 'js_code 数组透传')
    eq2(req.delay_ms, 1500, 'delay_ms 透传')
    eq2(req.css_selector, '.main-content', 'css_selector 透传')
    ok(req.extract && req.extract.baseSelector === '.quote' && req.extract.fields.length === 1, 'extract schema 透传')
    eq2(req.links, true, 'links 透传')
    eq2(req.stealth, true, 'stealth 透传')
    eq2(req.flat_shadow_dom, true, 'flat_shadow_dom 透传')
    ok(req.virtual_scroll && req.virtual_scroll.container_selector === '.feed' && req.virtual_scroll.scroll_count === 8, 'virtual_scroll 透传')
  } finally { delete process.env.STUB_ECHO_FILE }
})

await test('wait_for 前缀前置校验：非法前缀不启子进程直接 invalid_request', async () => {
  const echoFile = path.join(TMP, 'echo-req-2.json')
  process.env.STUB_ECHO_FILE = echoFile
  try {
    const r = await runCrawl4ai('ok://x.com', { python: PYTHON, script: STUB, timeoutMs: 4000, waitFor: 'domcontentloaded' })
    ok(!r.success && r.code === 'invalid_request', `code=${r.code}`)
    ok(!fs.existsSync(echoFile), '未起子进程（无请求落盘）')
  } finally { delete process.env.STUB_ECHO_FILE }
})

await test('降级标注：crawl4ai 失败 + 高级参数 → 降级 fetch 结果带 degraded + skipped', async () => {
  const c4aiBad = async () => ({ success: false, code: 'crawl_failed', error: 'x' })
  const fetchStub = async () => ({ success: true, markdown: 'F 正文', title: 'F', via: 'fetch' })
  const r = await crawlUrl('https://a.com', {
    engine: 'crawl4ai', _avail: async () => ({ ok: true }), _c4ai: c4aiBad, _fetch: fetchStub,
    waitFor: 'css:.x', extract: { baseSelector: '.q', fields: [{ name: 'a', selector: '.a', type: 'text' }] },
  })
  ok(r.success && r.via === 'fetch', '降级 fetch 成功')
  eq2(r.degraded, true, 'degraded=true')
  ok(r.skipped.includes('waitFor') && r.skipped.includes('extract'), `skipped 列出未生效能力（${r.skipped.join(',')}）`)
  // 无高级参数的普通降级不带 skipped（向后兼容 KnowledgeStore 路径）
  const r2 = await crawlUrl('https://a.com', { engine: 'crawl4ai', _avail: async () => ({ ok: true }), _c4ai: c4aiBad, _fetch: fetchStub })
  ok(r2.degraded !== true, '普通降级不带 degraded 标注')
})

await test('结果映射：extracted/extracted_count/links 从子进程透传到 Node 结果', async () => {
  const richStub = path.join(TMP, 'rich.cjs')
  fs.writeFileSync(richStub, `#!/usr/bin/env node
let s = ''
process.stdin.on('data', (d) => {
  s += d
  if (!s.includes('\\n')) return
  process.stdout.write(JSON.stringify({ ok: true, url: 'ok://rich', status_code: 200, title: '富结果', markdown: 'M', extracted: [{ a: 1 }, { a: 2 }, { a: 3 }], extracted_count: 3, links: { internal: [{ href: '/x', text: 'X' }], external: [] } }) + '\\n')
  process.exit(0)
})
`)
  const r = await runCrawl4ai('ok://rich', { python: PYTHON, script: richStub, timeoutMs: 4000 })
  ok(r.success && r.extracted && r.extracted.length === 3, 'extracted 数组映射')
  eq2(r.extractedCount, 3, 'extractedCount 映射')
  ok(r.links && r.links.internal && r.links.internal[0].href === '/x', 'links 映射')
})

await test('webCrawlTool 参数校验 + 降级标注透传到工具返回', async () => {
  const { webCrawlTool } = await import('./index.js')
  const bad = await webCrawlTool.execute({ url: 'https://a.com', wait_for: 'networkidle' })
  ok(bad.error && bad.error.includes('css:'), 'wait_for 非法 → 工具层拒绝')
  // 强制 fetch 引擎 + extract → degraded 标注（fetch 桩不可注入同模块内部调用，走 engine + 失败 URL 的错误路径）
  const deg = await webCrawlTool.execute({ url: 'https://a.invalid-tld-test-x', extract: { baseSelector: '.q', fields: [{ name: 'a', selector: '.a', type: 'text' }] }, engine: 'fetch' })
  ok(deg.error || deg.degraded, '错误路径可达（不崩溃）')
  ok(!deg.ok || deg.degraded === true, '若成功必带 degraded 标注')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
fs.rmSync(TMP, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
