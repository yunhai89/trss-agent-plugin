/**
 * TTS 参考音频库（refs.js）—— 索引损坏时的自愈语义回归。
 *
 * 背景（2026-10-17 回归审计）：
 *  - 读路径（list/get/getByName → _readSafe）也会走 _read 的损坏分支。旧实现按**时间戳**命名备份
 *    （refs.json.bad-<Date.now()>），于是索引修好之前每次面板刷新/每次合成都新增一份副本 → data/tts 无限增长；
 *    现在按**内容哈希**命名，同内容只留一份。
 *  - 写路径必须 fail-closed：索引损坏时 add() 不能把损坏当空表覆盖（否则 refs/ 里的 wav 全成孤儿）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RefLibrary } from './refs.js'

let passed = 0
let failed = 0
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) } else { failed++; console.log(`  ✗ FAIL ${msg}`) }
}
const test = async (name, fn) => {
  console.log(`\n[${name}]`)
  try { await fn() } catch (e) { failed++; console.log(`  ✗ FAIL 抛错：${e?.stack || e}`) }
}

await test('索引损坏：抛错 + 按内容哈希备份，且读多次只留一份', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-test-'))
  try {
    const bad = '{ 这不是 JSON'
    fs.writeFileSync(path.join(dir, 'refs.json'), bad)
    const lib = new RefLibrary({ dir, logger: () => {} })

    let err = null
    try { lib._read() } catch (e) { err = e }
    ok(!!err && /索引损坏/.test(err.message), '写路径（_read）抛错并说明损坏')
    const baks = () => fs.readdirSync(dir).filter((n) => n.startsWith('refs.json.bad-'))
    ok(baks().length === 1, `首次损坏生成 1 份备份（实际 ${baks().length}）`)

    // 读路径三次（面板刷新/合成会反复触发）
    lib.list(); lib.get('x'); lib.getByName('y')
    ok(baks().length === 1, `重复读取不再新增副本（实际 ${baks().length}）`)
    ok(fs.readFileSync(path.join(dir, baks()[0]), 'utf8') === bad, '备份内容 = 损坏原文（可人工找回）')

    // 写路径 fail-closed：索引仍是损坏原文，没有被覆盖成空表/单条
    let addErr = null
    try { await lib.add({ name: '音色A', kind: 'voice', filename: 'a.wav', buffer: Buffer.from('RIFF') }) } catch (e) { addErr = e }
    ok(!!addErr, 'add() 在索引损坏时拒绝写入')
    ok(fs.readFileSync(path.join(dir, 'refs.json'), 'utf8') === bad, '损坏索引未被覆盖（wav 不会变孤儿）')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

await test('正常索引：读不生成备份，写后读回一致', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-test-'))
  try {
    const lib = new RefLibrary({ dir, logger: () => {} })
    const e = await lib.add({ name: '音色B', kind: 'voice', filename: 'b.wav', buffer: Buffer.from('RIFF....') })
    ok(!!e?.id, '写入成功返回条目')
    ok(fs.readdirSync(dir).filter((n) => n.startsWith('refs.json.bad-')).length === 0, '正常索引不生成备份')
    ok(lib.get(e.id)?.name === '音色B' && lib.getByName('音色B')?.id === e.id, '按 id/名称读回一致')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
