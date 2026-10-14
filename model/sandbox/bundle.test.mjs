/**
 * 沙箱「文件包 + 命令」原语离线自检（桩 transport；无需 e2b / 联网）。
 * 运行：node model/sandbox/bundle.test.mjs
 *
 * 覆盖（内置工具沙箱执行面新增的文件进出能力）：
 *   - shellQuote：安全字符直出、危险字符单引号包裹（注入面为零）、空串
 *   - sandboxTmp：工具临时目录形态与唯一性
 *   - write/read/list：文本与二进制
 *   - upload：宿主文件流式上传（web stream；不整块进内存）+ 上限拒绝
 *   - downloadTo：流式落盘（web stream → 宿主文件）；字节上限；中断清理半成品
 *   - oneShot close：销毁沙箱
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { openSandboxBundle, runSandboxBundle, shellQuote, sandboxTmp } from './bundle.js'
import { SandboxManager } from './manager.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

function makeHandle({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  return { async wait() { return { exitCode, stdout, stderr } }, async kill() { return true } }
}
function stubTransport({ textData = 'hello', bytesData = Buffer.from('bin'), entries = [] } = {}) {
  const calls = { create: 0, run: 0, writes: [], lists: [], reads: [], killed: [] }
  let seq = 0
  return {
    calls,
    async init() { return this },
    async ping() { return true },
    async create() { calls.create++; return { id: `sbx-${++seq}`, raw: {} } },
    async connect() { return { id: 'c', raw: {} } },
    async run() { calls.run++; return makeHandle({ exitCode: 0, stdout: 'ok' }) },
    async write(_h, p, data) { calls.writes.push({ path: p, stream: typeof data?.getReader === 'function' || typeof data?.pipe === 'function' }) },
    async writeMany(_h, files) { for (const f of files) calls.writes.push({ path: f.path, stream: false, size: String(f.data).length }) },
    async read(_h, p, { format } = {}) {
      calls.reads.push({ path: p, format })
      if (format === 'stream') return Readable.toWeb(Readable.from([Buffer.from('streamed')]))
      return format === 'bytes' ? new Uint8Array(bytesData) : textData
    },
    async list(_h, p, opts) { calls.lists.push({ path: p, depth: opts?.depth }); return entries },
    async kill(h) { calls.killed.push(h.id); return true }, async setTimeout() {}, async updateNetwork() {},
  }
}
const mkBox = (t) => new SandboxManager({ transport: t, idleMs: 60000, sandboxTtlMs: 600000, sweepIntervalMs: 100000 })
const tmpFile = (content = 'x') => { const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-')), 'f.bin'); fs.writeFileSync(p, content); return p }

// ---------- 1. shellQuote ----------
await test('shellQuote：安全字符直出 / 危险字符强引用 / 空串', () => {
  eq(shellQuote('pypi.org'), 'pypi.org', '安全字符直出（命令可读）')
  eq(shellQuote('a b'), "'a b'", '含空格 → 单引号包裹')
  eq(shellQuote("it's"), "'it'\\''s'", '单引号转义为标准形态')
  eq(shellQuote('a; rm -rf /'), "'a; rm -rf /'", '注入载荷被整体包裹（无语法意义）')
  eq(shellQuote(''), "''", '空串 → 空参数')
  eq(shellQuote(null), "''", 'null → 空参数')
})

// ---------- 2. sandboxTmp ----------
await test('sandboxTmp：形态稳定且不重名', () => {
  const a = sandboxTmp('calc')
  const b = sandboxTmp('calc')
  ok(a.startsWith('/home/user/.agent-tmp/calc-'), `前缀正确（${a}）`)
  ok(a !== b, '两次调用不同（每次调用独立目录）')
  eq(sandboxTmp('a/b c').includes('/'), true, '非法字符被清洗（仍是合法路径段）')
})

// ---------- 3. write / read / list ----------
await test('session：写（绝对/相对）、读文本/二进制、列目录', async () => {
  const t = stubTransport({ textData: 'hello', bytesData: Buffer.from([1, 2, 3]), entries: [{ name: 'a.txt', type: 'file', size: 5 }] })
  const box = mkBox(t)
  try {
    const s = await openSandboxBundle(box, 'k-basic', { execCwd: '/home/user' })
    await s.write({ path: 'rel.txt', data: 'x' })
    await s.write({ path: '/abs/rel.txt', data: 'y' })
    eq(t.calls.writes.map((w) => w.path), ['/home/user/rel.txt', '/abs/rel.txt'], '相对路径按 execCwd 绝对化')
    eq(await s.read('rel.txt'), 'hello', '读文本')
    eq(Array.from(await s.read('/abs/rel.txt', { binary: true })), [1, 2, 3], '读二进制 → Buffer')
    eq((await s.list('.', { depth: 2 }))[0].name, 'a.txt', '列目录透传')
    eq(t.calls.lists[0].path, '/home/user/.', 'list 相对路径同样绝对化')
  } finally { await box.shutdown() }
})

// ---------- 4. upload ----------
await test('session：宿主文件流式上传（web stream）+ 上限拒绝', async () => {
  const t = stubTransport()
  const box = mkBox(t)
  const host = tmpFile('upload-me')
  try {
    const s = await openSandboxBundle(box, 'k-upload', { execCwd: '/home/user' })
    const r = await s.upload(host, 'in/video.mp4')
    eq(r.path, '/home/user/in/video.mp4', '上传到沙箱路径')
    eq(r.bytes, 9, '回报字节数')
    ok(t.calls.writes[0].stream, '走流式（不整块读进内存）')
    let err = null
    try { await s.upload(host, 'in/video2.mp4', { maxBytes: 2 }) } catch (e) { err = e }
    ok(err && /上限/.test(err.message), `超上限拒绝（${err?.message}）`)
  } finally { await box.shutdown(); fs.rmSync(path.dirname(host), { recursive: true, force: true }) }
})

// ---------- 5. downloadTo ----------
await test('session：沙箱文件流式落盘 + 字节上限 + 中断清理', async () => {
  const t = stubTransport()
  const box = mkBox(t)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-dl-'))
  try {
    const s = await openSandboxBundle(box, 'k-dl', { execCwd: '/home/user' })
    const r = await s.downloadTo('/home/user/out.txt', path.join(dir, 'out.txt'))
    eq(fs.readFileSync(r.path, 'utf8'), 'streamed', '内容流式落盘正确')
    eq(r.bytes, 8, '回报字节数')

    // 上限：桩改小上限重开会话（transport.read 每次返回 8 字节）
    let err = null
    try { await s.downloadTo('/home/user/out2.txt', path.join(dir, 'out2.txt'), { maxBytes: 3 }) } catch (e) { err = e }
    ok(err && /上限/.test(err.message), `超上限失败（${err?.message}）`)
    ok(!fs.existsSync(path.join(dir, 'out2.txt')), '超限半成品已清理')

    // 中断：先给数据再炸 → 半成品清理
    t.read = async () => {
      const src = new Readable({ read() {} })
      src.push(Buffer.from('partial'))
      setTimeout(() => src.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 5)
      return Readable.toWeb(src)
    }
    err = null
    try { await s.downloadTo('/home/user/out3.txt', path.join(dir, 'out3.txt')) } catch (e) { err = e }
    ok(err && /中断/.test(err.message), `中断结构化失败（${err?.message}）`)
    ok(!fs.existsSync(path.join(dir, 'out3.txt')), '中断半成品已清理')
  } finally { await box.shutdown(); fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------- 6. oneShot ----------
await test('runSandboxBundle：一次性会话跑完即销毁', async () => {
  const t = stubTransport()
  const box = mkBox(t)
  try {
    const r = await runSandboxBundle(box, 'oneshot', { command: 'echo hi', timeoutMs: 5000 })
    eq(r.ok, true, '命令执行')
    eq(t.calls.killed.length, 1, '沙箱已销毁（一次性）')
  } finally { await box.shutdown() }
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
