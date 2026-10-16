/**
 * web_download 工具离线自检（桩 transport；无需 e2b / 联网 / yt-dlp）。
 * 运行：node model/download/test.mjs
 *
 * 覆盖：
 *   - argv 拼装（URL 恒为最后一个参数；audioOnly 走 -x 提取）
 *   - 沙箱档：yt-dlp 在沙箱执行 → 列目录取产物 → 流式拉回宿主 → 发送
 *   - fail-closed：mode=e2b 但沙箱未就绪 → 拒绝，不在宿主跑
 *   - 模板缺 yt-dlp（exit 127）→ 可读失败
 *   - 产物流式下载的字节上限（超限即失败并清理半成品）
 *   - 宿主档取消：abort 立刻 SIGKILL、不等 timeoutSec，且不再把产物发进会话
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { makeDownloadTool, buildYtDlpArgs, runYtDlpInSandbox, runYtDlp } from './index.js'
import { SandboxManager } from '../sandbox/manager.js'
import { makeCommandCounter } from '../sandbox/index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

// ---------- 桩 transport ----------
function makeHandle({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  return { async wait() { return { exitCode, stdout, stderr } }, async kill() { return true } }
}
function stubTransport({ runImpl = null, entries = [], fileData = 'abc' } = {}) {
  const calls = { create: 0, run: 0, cmds: [], listed: 0, read: [] }
  let seq = 0
  return {
    calls,
    async init() { return this },
    async ping() { return true },
    async create() { calls.create++; return { id: `sbx-${++seq}`, raw: {} } },
    async connect() { return { id: 'c', raw: {} } },
    async run(h, cmd, opts) { calls.run++; calls.cmds.push(cmd); return runImpl ? runImpl(h, cmd, opts) : makeHandle({ exitCode: 0 }) },
    async write() {}, async writeMany() {},
    async read(_h, p, { format } = {}) {
      calls.read.push({ path: p, format })
      if (format === 'stream') return Readable.toWeb(Readable.from([Buffer.from(fileData)]))
      return fileData
    },
    async list() { calls.listed++; return entries },
    async kill() { return true }, async setTimeout() {}, async updateNetwork() {},
  }
}
const mkBox = (t) => new SandboxManager({ transport: t, idleMs: 60000, sandboxTtlMs: 600000, sweepIntervalMs: 100000 })
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'))

// ---------- 1. argv 拼装 ----------
await test('web_download：argv 拼装（URL 末位 / audioOnly 提取）', async () => {
  const a = buildYtDlpArgs('https://example.com/v/1', { outTmpl: '/tmp/x/%(title).80B.%(ext)s', audioOnly: true })
  eq(a[a.length - 1], 'https://example.com/v/1', 'URL 恒为最后一个参数')
  ok(a.includes('-x') && a.includes('mp3'), 'audioOnly 走 -x --audio-format mp3')
  const b = buildYtDlpArgs('https://example.com/v/2', { outTmpl: '/tmp/x/y', format: 'best' })
  ok(b.includes('-f') && b.includes('best'), '视频档带 -f format')
  ok(b.includes('--max-filesize'), '带 --max-filesize 上限')
  ok(b.includes('--no-playlist'), '不抓整个播放列表')
})

// ---------- 2. 沙箱档：执行 + 拉回 + 发送 ----------
await test('web_download：沙箱档执行并拉回文件（不落宿主 shell）', async () => {
  const t = stubTransport({ entries: [{ name: 'video.mp4', type: 'file', size: 3 }], fileData: 'abc' })
  const box = mkBox(t)
  const dir = tmpDir()
  try {
    const tool = makeDownloadTool()
    let sent = null
    const ctx = {
      e: { reply: async (seg) => { sent = seg } },
      download: { dir },
      sandbox: { mode: 'e2b', manager: box, sessionKey: 'k1', audit: false, maxTimeout: 600, commands: makeCommandCounter(50) },
    }
    const r = await tool.execute({ url: 'https://example.com/v/1' }, ctx)
    eq(r.ok, true, 'ok:true')
    eq(r.file, 'video.mp4', '产物名回报为沙箱内文件名')
    eq(r.size, 3, '文件大小取自沙箱条目')
    if (r.sent) { ok(!!sent, '走 e.reply 发送 file 段') } else { ok(String(r.path).endsWith('video.mp4'), '未发送时给出宿主路径（可 send_file 重发/SFTP 取）') }
    eq(t.calls.run, 2, '沙箱内 2 条命令（下载 + 清理临时目录）')
    ok(/mkdir -p .*yt-dlp /.test(t.calls.cmds[0]), '第一条 = mkdir + yt-dlp（URL 以引号参数传入）')
    ok(!/https:\/\/example\.com[^\s'"]*[;&|]/.test(t.calls.cmds[0]), 'URL 不裸拼进命令（shellQuote）')
    eq(t.calls.read[0].format, 'stream', '拉回走流式（大文件不整块进内存）')
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    const pulled = walk(dir).find((p) => p.endsWith('video.mp4'))
    ok(!!pulled, '拉回的 video.mp4 落在宿主下载目录')
    eq(pulled ? fs.readFileSync(pulled, 'utf8') : null, 'abc', '文件内容落地正确')
    ok(fs.readdirSync(dir).length <= 1, '发送成功后清理本次下载目录（per-call 子目录回收）')
  } finally { await box.shutdown(); fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------- 3. fail-closed ----------
await test('web_download：mode=e2b 但沙箱未就绪 → 拒绝执行', async () => {
  const tool = makeDownloadTool()
  const r = await tool.execute({ url: 'https://example.com/v/1' }, { sandbox: { mode: 'e2b', manager: null } })
  ok(r.error && r.error.includes('沙箱不可用'), '返回 fail-closed 错误')
})

// ---------- 4. 模板缺 yt-dlp ----------
await test('web_download：沙箱缺 yt-dlp（exit 127）→ 可读失败', async () => {
  const t = stubTransport({ runImpl: () => makeHandle({ exitCode: 127, stderr: 'sh: 1: yt-dlp: not found' }) })
  const box = mkBox(t)
  const dir = tmpDir()
  try {
    const tool = makeDownloadTool()
    const r = await tool.execute({ url: 'https://example.com/v/1' }, {
      download: { dir },
      sandbox: { mode: 'e2b', manager: box, sessionKey: 'k2', audit: false, maxTimeout: 600, commands: makeCommandCounter(50) },
    })
    ok(r.error && r.error.includes('yt-dlp') && r.error.includes('模板'), '错误点名缺 yt-dlp + 提示装模板')
  } finally { await box.shutdown(); fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------- 5. 拉回中断：结构化失败且不留半成品 ----------
await test('web_download：拉回中途中断 → 结构化失败 + 清理半成品', async () => {
  const t = stubTransport({ entries: [{ name: 'big.bin', type: 'file', size: 8 }] })
  t.read = async () => {
    // 先给一段数据再炸：模拟「已落盘一部分后连接中断」，验证半成品被清理
    const src = new Readable({ read() {} })
    src.push(Buffer.from('partial-'))
    setTimeout(() => src.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 5)
    return Readable.toWeb(src)
  }
  const box = mkBox(t)
  const dir = tmpDir()
  try {
    const r = await runYtDlpInSandbox({ manager: box, key: 'k3', commands: makeCommandCounter(50), maxTimeout: 600, defaultCwd: '/home/user', audit: false }, 'https://example.com/v/1', {
      dir, maxBytes: 600 * 1024 * 1024, timeoutSec: 30,
    })
    ok(r.error && r.error.includes('拉回沙箱文件失败'), `拉回中断 → 结构化失败（${r.error}）`)
    const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [])
    eq(walk(dir).length, 0, '半成品文件已清理')
  } finally { await box.shutdown(); fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------- 6. 宿主档取消（本轮外部服务客户端审计第 2 条） ----------
await test('runYtDlp（宿主档）：abort → 立刻 SIGKILL 并返回 aborted', async () => {
  const dir = tmpDir()
  const binDir = tmpDir()
  const bin = path.join(binDir, 'fake-yt-dlp.mjs')
  fs.writeFileSync(bin, '#!/usr/bin/env node\nsetTimeout(() => {}, 30000)\n', { mode: 0o755 })
  try {
    const ac = new AbortController()
    const t0 = Date.now()
    const p = runYtDlp('https://example.com/v/1', { dir, ytDlpBin: bin, timeoutSec: 600, signal: ac.signal })
    setTimeout(() => ac.abort(), 150)
    const r = await p
    const ms = Date.now() - t0
    ok(r.ok === false && r.aborted === true, `取消 → ok:false + aborted:true（${JSON.stringify({ ok: r.ok, aborted: r.aborted, error: r.error })}）`)
    ok(ms < 5000, `不等满 timeoutSec=600s（实测 ${ms}ms）`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(binDir, { recursive: true, force: true }) }
})

// ---------- 7. 宿主档取消：产物不发进会话 ----------
await test('web_download：下载中被取消 → 不发消息 + 清理下载目录', async () => {
  const dir = tmpDir()
  const binDir = tmpDir()
  const bin = path.join(binDir, 'fake-yt-dlp.mjs')
  fs.writeFileSync(bin, '#!/usr/bin/env node\nsetTimeout(() => {}, 30000)\n', { mode: 0o755 })
  const sent = []
  const ac = new AbortController()
  try {
    const tool = makeDownloadTool()
    const ctx = {
      download: { dir, ytDlpBin: bin, allowPrivateHosts: true, maxTimeoutSec: 600 },
      signal: ac.signal,
      groupId: 'g1',
      e: { reply: async (seg) => { sent.push(seg) } },
    }
    setTimeout(() => ac.abort(), 200)
    const r = await tool.execute({ url: 'https://example.com/v/1' }, ctx)
    ok(/取消/.test(r.error || ''), `报错说明已取消（${r.error}）`)
    eq(sent.length, 0, '取消后不发消息到会话')
    eq(fs.readdirSync(dir).length, 0, '未发送的下载目录已清理')
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(binDir, { recursive: true, force: true }) }
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
