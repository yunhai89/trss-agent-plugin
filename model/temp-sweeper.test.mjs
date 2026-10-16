/**
 * 临时目录清理器自检（2026-10-17 审计 A6）。
 * 运行：node model/temp-sweeper.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepTempDir } from './temp-sweeper.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tempsweep-'))
const mk = (rel, ageMs, size = 10) => {
  const p = path.join(tmpRoot, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, Buffer.alloc(size, 1))
  const t = new Date(Date.now() - ageMs)
  fs.utimesSync(p, t, t)
  return p
}

await test('按 TTL 删除过期文件，保留新文件', async () => {
  const old1 = mk('a-old.pdf', 48 * 3600_000)
  const old2 = mk('sub/b-old.pdf', 30 * 3600_000)
  const fresh = mk('c-new.pdf', 60_000)
  const r = sweepTempDir({ dir: tmpRoot, ttlMs: 24 * 3600_000, maxFiles: 100 })
  ok(!fs.existsSync(old1), '过期文件已删除')
  ok(!fs.existsSync(old2), '子目录过期文件已删除（递归 ≤2 层）')
  ok(fs.existsSync(fresh), '新文件保留')
  ok(r.removed === 2, `删除计数正确（实际 ${r.removed}）`)
})

await test('总量上限：从最旧开始删，保留最新的 N 个', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempsweep2-'))
  const files = []
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, `f${i}.bin`)
    fs.writeFileSync(p, 'x')
    const t = new Date(Date.now() - (6 - i) * 60_000) // f0 最旧
    fs.utimesSync(p, t, t)
    files.push(p)
  }
  const r = sweepTempDir({ dir, ttlMs: 999 * 24 * 3600_000, maxFiles: 3 })
  ok(r.removed === 3, `超限删除 3 个（实际 ${r.removed}）`)
  ok(!fs.existsSync(files[0]) && !fs.existsSync(files[2]), '删除的是最旧的三个')
  ok(fs.existsSync(files[3]) && fs.existsSync(files[5]), '保留最新的三个')
})

await test('目录不存在 / 越界防护', async () => {
  const r = sweepTempDir({ dir: path.join(tmpRoot, 'not-exist-dir'), ttlMs: 1 })
  ok(r.removed === 0 && r.kept === 0, '目录不存在时安全返回 0')
  // 软链文件不跟随（不会被当普通文件删除目标）
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tempsweep-out-'))
  const target = path.join(outside, 'keep.txt')
  fs.writeFileSync(target, 'important')
  const link = path.join(tmpRoot, 'link.txt')
  try { fs.symlinkSync(target, link) } catch { /* 平台不支持则跳过 */ }
  sweepTempDir({ dir: tmpRoot, ttlMs: 0 })
  ok(fs.existsSync(target), '符号链接目标不被删除（不跟随链接）')
  ok(fs.existsSync(tmpRoot), '根目录本身不被删除')
})

console.log(`\n========================================\n通过 ${passed}，失败 ${failed}\n========================================`)
process.exit(failed ? 1 : 0)
