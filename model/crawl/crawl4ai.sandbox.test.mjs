/**
 * crawl4ai 沙箱档离线自检（桩 transport；无需 e2b / 浏览器 / 联网 / python）。
 * 运行：node model/crawl/crawl4ai.sandbox.test.mjs
 *
 * 覆盖：
 *   - buildCrawl4aiRequest：请求协议字段映射（宿主/沙箱共用，防两处口径漂移）
 *   - runCrawl4aiInSandbox：脚本按沙箱缓存只传一次、请求文件 stdin 重定向、单行 JSON 协议解析、
 *     失败码映射（ImportError→crashed）、退出码映射、临时目录清理
 *   - probeCrawl4aiInSandbox：可用/不可用判定 + 按沙箱缓存（不重复探测）
 *   - 脚本不可读 → spawn_failed（不伪装成功）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildCrawl4aiRequest, runCrawl4aiInSandbox, probeCrawl4aiInSandbox } from './crawl4ai.js'
import { SandboxManager } from '../sandbox/manager.js'
import { makeCommandCounter } from '../sandbox/index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

function makeHandle({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  return { async wait() { return { exitCode, stdout, stderr } }, async kill() { return true } }
}
let _sbxSeq = 0 // 沙箱 id 全局唯一（真实 E2B 语义；避免不同桩实例复用同一 id 命中探测缓存）
function stubTransport({ runImpl = null } = {}) {
  const calls = { create: 0, run: 0, cmds: [], writes: [] }
  return {
    calls,
    async init() { return this },
    async ping() { return true },
    async create() { calls.create++; return { id: `sbx-${++_sbxSeq}`, raw: {} } },
    async connect() { return { id: 'c', raw: {} } },
    async run(h, cmd, opts) { calls.run++; calls.cmds.push(cmd); return runImpl ? runImpl(h, cmd, opts) : makeHandle({ exitCode: 0 }) },
    async write(_h, p, data) { calls.writes.push({ path: p, data: String(data) }) },
    async writeMany(_h, files) { for (const f of files) calls.writes.push({ path: f.path, data: String(f.data) }) },
    async read() { return '' }, async list() { return [] },
    async kill() { return true }, async setTimeout() {}, async updateNetwork() {},
  }
}
const mkBox = (t) => new SandboxManager({ transport: t, idleMs: 60000, sandboxTtlMs: 600000, sweepIntervalMs: 100000 })
const boxOf = (box) => ({ manager: box, key: 'k-crawl', commands: makeCommandCounter(50), maxTimeout: 600, defaultCwd: '/home/user', audit: false })
const scriptFixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-sbx-'))
  const p = path.join(dir, 'crawl4ai_fetch.py')
  fs.writeFileSync(p, 'import sys\nprint("{}")\n')
  return { dir, p }
}

// ---------- 1. 请求协议 ----------
await test('buildCrawl4aiRequest：字段映射（宿主/沙箱共用）', async () => {
  const r = buildCrawl4aiRequest({
    url: 'https://a.com', timeout: 90000, maxChars: 5000,
    waitFor: 'css:#app', jsCode: ['window.scrollTo(0,9)'], delayMs: 100,
    cssSelector: '.body', extract: { baseSelector: 'li' }, links: true, stealth: true,
    proxy: 'http://127.0.0.1:7890', waitUntil: 'load', headless: false, scanFullPage: true,
    maxScrollSteps: 3, extraArgs: ['--ignore-https-errors'], flatShadowDom: true, virtualScroll: { scroll_count: 2 },
  })
  eq(r.url, 'https://a.com', 'url')
  eq(r.timeout_s, 90, 'timeout_s 由毫秒折算')
  eq(r.max_chars, 5000, 'max_chars')
  eq(r.wait_for, 'css:#app', 'wait_for')
  eq(r.js_code, ['window.scrollTo(0,9)'], 'js_code 数组原样')
  eq(r.delay_ms, 100, 'delay_ms')
  eq(r.css_selector, '.body', 'css_selector')
  eq(r.extract, { baseSelector: 'li' }, 'extract schema')
  eq(r.links, true, 'links')
  eq(r.stealth, true, 'stealth')
  eq(r.proxy, 'http://127.0.0.1:7890', 'proxy')
  eq(r.wait_until, 'load', 'wait_until')
  eq(r.headless, false, 'headless 显式 false 保留')
  eq(r.scan_full_page, true, 'scan_full_page')
  eq(r.max_scroll_steps, 3, 'max_scroll_steps')
  eq(r.extra_args, ['--ignore-https-errors'], 'extra_args')
  eq(r.flat_shadow_dom, true, 'flat_shadow_dom')
  eq(r.virtual_scroll, { scroll_count: 2 }, 'virtual_scroll')
  const min = buildCrawl4aiRequest({ url: 'https://b.com' })
  eq(min.stealth, undefined, '未显式开启的布尔不加进协议（保持默认语义）')
})

// ---------- 2. 沙箱档执行 ----------
await test('runCrawl4aiInSandbox：脚本只传一次 + 请求文件重定向 + 协议解析 + 清理', async () => {
  const t = stubTransport({
    runImpl: (_h, cmd) => {
      if (/rm -rf /.test(cmd)) return makeHandle({ exitCode: 0 })
      return makeHandle({ exitCode: 0, stdout: 'some log\n' + JSON.stringify({ ok: true, url: 'https://a.com', title: 'A', markdown: '# hello', status_code: 200 }) + '\n' })
    },
  })
  const box = mkBox(t)
  const { dir, p } = scriptFixture()
  try {
    const boxRef = boxOf(box)
    const r1 = await runCrawl4aiInSandbox(boxRef, 'https://a.com', { script: p, timeoutMs: 90000, maxChars: 1000 })
    eq(r1.success, true, '解析单行 JSON → 成功')
    eq(r1.markdown, '# hello', 'markdown 透传')
    eq(r1.statusCode, 200, 'statusCode 透传')
    eq(r1.sandbox, true, '标注沙箱执行面')
    ok(t.calls.writes.some((w) => w.path === '/home/user/.agent-tmp/crawl4ai_fetch.py'), '抓取脚本上传到沙箱固定路径')
    ok(t.calls.writes.some((w) => w.path.endsWith('/req.json')), '请求体写文件（stdin 重定向，不占 argv）')
    ok(new RegExp(`^python3 /home/user/\\.agent-tmp/crawl4ai_fetch\\.py < /home/user/\\.agent-tmp/crawl-`).test(t.calls.cmds[0]), `命令为固定拼装 + stdin 重定向（${t.calls.cmds[0]}）`)
    const scriptUploads1 = t.calls.writes.filter((w) => w.path.endsWith('crawl4ai_fetch.py')).length
    eq(scriptUploads1, 1, '脚本首次上传')

    const r2 = await runCrawl4aiInSandbox(boxRef, 'https://a.com', { script: p, timeoutMs: 90000 })
    eq(r2.success, true, '第二次抓取成功')
    const scriptUploads2 = t.calls.writes.filter((w) => w.path.endsWith('crawl4ai_fetch.py')).length
    eq(scriptUploads2, 1, '同一沙箱内脚本不重复上传')
    ok(t.calls.cmds.some((c) => /^rm -rf \/home\/user\/\.agent-tmp\/crawl-/.test(c)), '每次抓取后清理请求临时目录')
  } finally { await box.shutdown(); fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------- 3. 失败映射 ----------
await test('runCrawl4aiInSandbox：ImportError/退出码映射为结构化失败（不伪装成功）', async () => {
  const t = stubTransport({
    runImpl: (_h, cmd) => (/(rm -rf)/.test(cmd)
      ? makeHandle({ exitCode: 0 })
      : makeHandle({ exitCode: 4, stderr: 'crawl4ai 未安装或缺依赖: No module named crawl4ai', stdout: JSON.stringify({ ok: false, code: 'crashed', error: 'crawl4ai 不可用: No module named crawl4ai' }) })),
  })
  const box = mkBox(t)
  const { dir, p } = scriptFixture()
  try {
    const r = await runCrawl4aiInSandbox(boxOf(box), 'https://a.com', { script: p, timeoutMs: 30000 })
    eq(r.success, false, '失败不伪装成功')
    eq(r.code, 'crashed', 'code 透传（crashed）')
    ok(String(r.error).includes('crawl4ai'), '错误含可读原因')
    ok(String(r.stderrTail).includes('No module named'), '保留 stderr 尾部（排障）')
  } finally { await box.shutdown(); fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------- 4. 超时/无协议输出 ----------
await test('runCrawl4aiInSandbox：无协议输出 + 退出码 → 结构化失败', async () => {
  const t = stubTransport({ runImpl: (_h, cmd) => (/(rm -rf)/.test(cmd) ? makeHandle({ exitCode: 0 }) : makeHandle({ exitCode: 1, stderr: 'Traceback...' })) })
  const box = mkBox(t)
  const { dir, p } = scriptFixture()
  try {
    const r = await runCrawl4aiInSandbox(boxOf(box), 'https://a.com', { script: p, timeoutMs: 30000 })
    eq(r.success, false, '失败')
    eq(r.code, 'crashed', '无协议输出 + 非零退出 → crashed')
  } finally { await box.shutdown(); fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------- 5. 探测器 + 缓存 ----------
await test('probeCrawl4aiInSandbox：可用判定 + 按沙箱缓存（不重复探测）', async () => {
  const t = stubTransport({ runImpl: () => makeHandle({ exitCode: 0, stdout: '0.7.4\n' }) })
  const box = mkBox(t)
  try {
    const boxRef = boxOf(box)
    const r1 = await probeCrawl4aiInSandbox(boxRef)
    eq(r1.ok, true, '探测成功')
    eq(r1.version, '0.7.4', '版本透传')
    const runs1 = t.calls.run
    const r2 = await probeCrawl4aiInSandbox(boxRef)
    eq(r2.ok, true, '第二次仍可用（缓存）')
    eq(t.calls.run, runs1, '缓存期内不再执行探测命令')
  } finally { await box.shutdown() }

  const t2 = stubTransport({ runImpl: () => makeHandle({ exitCode: 1, stderr: "ModuleNotFoundError: No module named 'crawl4ai'" }) })
  const box2 = mkBox(t2)
  try {
    const r = await probeCrawl4aiInSandbox(boxOf(box2))
    eq(r.ok, false, '不可用判定')
    ok(String(r.reason).includes('crawl4ai'), '原因可读（模板未装 crawl4ai）')
    ok(!!r.hint, '给出修复提示')
  } finally { await box2.shutdown() }

  // importlib.metadata 对未安装的包抛 PackageNotFoundError（真实 E2B 模板即此形态）——
  // 必须同样报「模板未装 crawl4ai」，不能退化成无信息量的「沙箱内探测失败（1）」
  const t3 = stubTransport({ runImpl: () => makeHandle({ exitCode: 1, stderr: "importlib.metadata.PackageNotFoundError: No package metadata was found for crawl4ai\n" }) })
  const box3 = mkBox(t3)
  try {
    const r = await probeCrawl4aiInSandbox(boxOf(box3))
    eq(r.ok, false, 'PackageNotFoundError 判不可用')
    ok(String(r.reason).includes('模板未装 crawl4ai'), `原因可读（实际 ${r.reason}）`)
    ok(r.sandbox === true, '标注沙箱执行面（日志据此给沙箱修复提示，不再误导跑宿主安装脚本）')
  } finally { await box3.shutdown() }
})

// ---------- 6. 脚本不可读 ----------
await test('runCrawl4aiInSandbox：脚本缺失 → spawn_failed（不执行）', async () => {
  const t = stubTransport()
  const box = mkBox(t)
  try {
    const r = await runCrawl4aiInSandbox(boxOf(box), 'https://a.com', { script: '/nonexistent/crawl4ai_fetch.py', timeoutMs: 1000 })
    eq(r.success, false, '失败')
    eq(r.code, 'spawn_failed', 'code=spawn_failed')
    eq(t.calls.run, 0, '未执行任何命令')
  } finally { await box.shutdown() }
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
