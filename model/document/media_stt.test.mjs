/**
 * media_stt 安全回归 —— F01：ffmpeg 走 argv（shell:false），文件名按字面传递，杜绝命令替换。
 * 运行：node model/document/media_stt.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFfmpegArgs, runFfmpeg } from './media_stt.js'

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

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
