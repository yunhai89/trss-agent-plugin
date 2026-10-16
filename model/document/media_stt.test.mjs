/**
 * media_stt 安全回归 —— F01：ffmpeg 走 argv（shell:false），文件名按字面传递，杜绝命令替换。
 * 运行：node model/document/media_stt.test.mjs
 *
 * 另覆盖（2025-10）沙箱档：显式选择 E2B 后音频提取在会话沙箱内执行（上传→ffmpeg→拉回），
 * 沙箱不可用 fail-closed，模板缺 ffmpeg 可读失败。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { buildFfmpegArgs, runFfmpeg, extractAudioInSandbox, transcribeMediaTool } from './media_stt.js'
import { SandboxManager } from '../sandbox/manager.js'
import { makeCommandCounter } from '../sandbox/index.js'
import Config from '../../utils/Config.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

await test('buildFfmpegArgs：恶意文件名按字面进入 argv', async () => {
  const evil = '/tmp/clip$(touch PWNED).mp4'
  const args = buildFfmpegArgs(evil, '/tmp/out.mp3')
  ok(Array.isArray(args), '返回数组（非 shell 字符串）')
  eq(args[2], evil, '输入路径原样作为独立参数')
  ok(args.every((a) => typeof a === 'string'), '全为字符串参数')
})

await test('runFfmpeg：shell:false，命令替换不执行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-sec-'))
  // 伪造 ffmpeg：把收到的 argv 写入文件
  const argvOut = path.join(dir, 'argv.json')
  const fake = path.join(dir, 'ffmpeg')
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.env.FFMPEG_ARGV_OUT, JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o755 })
  const marker = path.join(dir, 'PWNED')
  const evilInput = path.join(dir, 'clip$(touch PWNED).mp4')
  fs.writeFileSync(evilInput, 'not a real video')

  const oldPath = process.env.PATH
  const oldOut = process.env.FFMPEG_ARGV_OUT
  const oldCwd = process.cwd()
  process.env.PATH = `${dir}:${oldPath}`
  process.env.FFMPEG_ARGV_OUT = argvOut
  process.chdir(dir)
  try {
    const r = await runFfmpeg(buildFfmpegArgs(evilInput, path.join(dir, 'out.mp3')))
    ok(r.ok, '伪 ffmpeg 执行成功')
    const received = JSON.parse(fs.readFileSync(argvOut, 'utf8'))
    ok(received.includes(evilInput), 'ffmpeg 收到的输入路径与文件名逐字一致')
    eq(fs.existsSync(marker), false, '命令替换未执行（无标记文件）')
  } finally {
    process.chdir(oldCwd)
    process.env.PATH = oldPath
    if (oldOut === undefined) delete process.env.FFMPEG_ARGV_OUT
    else process.env.FFMPEG_ARGV_OUT = oldOut
  }
})

// ---------- 沙箱档：stub transport ----------
function makeHandle({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  return { async wait() { return { exitCode, stdout, stderr } }, async kill() { return true } }
}
function stubTransport({ runImpl = null, audio = 'mp3-bytes' } = {}) {
  const calls = { create: 0, run: 0, cmds: [], writes: [], reads: [] }
  let seq = 0
  return {
    calls,
    async init() { return this },
    async ping() { return true },
    async create() { calls.create++; return { id: `sbx-${++seq}`, raw: {} } },
    async connect() { return { id: 'c', raw: {} } },
    async run(h, cmd, opts) { calls.run++; calls.cmds.push(cmd); return runImpl ? runImpl(h, cmd, opts) : makeHandle({ exitCode: 0 }) },
    async write(_h, p, data) { calls.writes.push({ path: p, stream: typeof data?.getReader === 'function' }) },
    async writeMany(_h, files, opts) { void opts; for (const f of files) calls.writes.push({ path: f.path, stream: typeof f.data?.getReader === 'function' }) },
    async read(_h, p, { format } = {}) {
      calls.reads.push({ path: p, format })
      if (format === 'stream') return Readable.toWeb(Readable.from([Buffer.from(audio)]))
      return audio
    },
    async list() { return [] },
    async kill() { return true }, async setTimeout() {}, async updateNetwork() {},
  }
}
const mkBox = (t) => new SandboxManager({ transport: t, idleMs: 60000, sandboxTtlMs: 600000, sweepIntervalMs: 100000 })
const boxOf = (box) => ({ manager: box, key: 'k-stt', commands: makeCommandCounter(50), maxTimeout: 600, defaultCwd: '/home/user', audit: false })

await test('沙箱档：上传 → 沙箱内 ffmpeg 提取 → 拉回宿主（API Key 不进沙箱）', async () => {
  const t = stubTransport()
  const box = mkBox(t)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-sbx-'))
  const input = path.join(dir, 'clip.mp4')
  fs.writeFileSync(input, 'fake video')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-out-'))
  try {
    const r = await extractAudioInSandbox(boxOf(box), input, { hostTmpDir: home })
    ok(!r.error && r.path, '返回拉回的音频路径')
    ok(t.calls.writes.some((w) => w.path.endsWith('/in.mp4') && w.stream), '输入文件流式上传进沙箱')
    ok(/^ffmpeg -y -i \/home\/user\/\.agent-tmp\/stt-[\w-]+\/in\.mp4 -vn -acodec libmp3lame -q:a 4 \/home\/user\/\.agent-tmp\/stt-[\w-]+\/out\.mp3$/.test(t.calls.cmds[0]), `沙箱内 ffmpeg 参数拼装（${t.calls.cmds[0]}）`)
    eq(t.calls.reads[0].format, 'stream', '输出 mp3 流式拉回')
    eq(fs.readFileSync(r.path, 'utf8'), 'mp3-bytes', '音频内容落地正确')
    eq(path.dirname(r.path), home, '落在调用方指定目录（测试不写仓库 data/）')
    eq(t.calls.create, 1, '会话沙箱只创建一次')
  } finally { await box.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }) }
})

await test('沙箱档：模板缺 ffmpeg（exit 127）→ 可读失败点名模板', async () => {
  const t = stubTransport({ runImpl: () => makeHandle({ exitCode: 127, stderr: 'sh: ffmpeg: not found' }) })
  const box = mkBox(t)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-sbx-'))
  const input = path.join(dir, 'clip.mp4')
  fs.writeFileSync(input, 'fake video')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-out-'))
  try {
    const r = await extractAudioInSandbox(boxOf(box), input, { hostTmpDir: home })
    ok(r.error && r.error.includes('ffmpeg') && r.error.includes('模板'), '错误点名缺 ffmpeg + 提示装模板')
    eq(r.missing, 'ffmpeg', '标记 missing')
  } finally { await box.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }) }
})

await test('工具层：mode=e2b 但沙箱未就绪 → 拒绝转录（不在宿主提取）', async () => {
  // 工具先校验 STT apiKey：测试注入（config 进程内 set，不落盘）
  Config.set('agent', { ...(Config.get().agent || {}), stt: { apiKey: 'test-key' } })
  // 同上：夹具必须在插件 data/temp 内（路径白名单），否则测不到沙箱 fail-closed 分支
  const dir = fs.mkdtempSync(path.join(Config.path.temp, 'stt-fc-'))
  const input = path.join(dir, 'clip.mp4')
  fs.writeFileSync(input, 'fake video')
  try {
    const r = await transcribeMediaTool.execute({ path: input }, { sandbox: { mode: 'e2b', manager: null } })
    ok(r.error && r.error.includes('沙箱不可用'), '返回 fail-closed 错误')
    ok(!r.text, '无转录结果（没有宿主兜底）')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
