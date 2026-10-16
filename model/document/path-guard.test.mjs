/**
 * 宿主路径白名单自检（2026-10-17 审计 A1/A2）。
 *
 * 背景：`file_to_pdf` / `read_pdf` / `read_excel` / `transcribe_media` 都是 category='query'
 * （任意群成员免审批），此前 path 参数只校验「存在 + 扩展名」，等于任意成员都能把
 * config/config.yaml、.env、data/logs/*.log 原样转成 PDF 发进群（不可撤回）。
 *
 * 运行：node model/document/path-guard.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Config from '../../utils/Config.js'
import { allowedReadRoots, isUnderRoots, hostPathError, realOrResolve } from './path-guard.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

const tempRoot = Config.path.temp
fs.mkdirSync(tempRoot, { recursive: true })
const mkTmp = (rel, content = 'x') => {
  const p = path.join(tempRoot, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  return p
}

await test('临时目录内的文件放行', async () => {
  const inside = mkTmp(`pg-ok-${process.pid}.txt`)
  ok(allowedReadRoots().includes(tempRoot), '白名单包含插件 data/temp')
  ok(isUnderRoots(inside, allowedReadRoots()), 'temp 内文件判定为允许')
  ok(hostPathError(inside) === null, 'hostPathError 返回 null（不阻断）')
})

await test('目录外的宿主文件一律拒绝（含子目录穿越）', async () => {
  const out = path.join(os.tmpdir(), `pg-out-${process.pid}.txt`)
  fs.writeFileSync(out, 'secret')
  const e1 = hostPathError(out) || ''
  ok(!!e1, 'os.tmpdir() 下的文件被拒绝')
  ok(/路径越界/.test(e1), `错误含「路径越界」：${e1.slice(0, 60)}…`)
  ok(/data\/temp/.test(e1), '错误里说明允许的目录')
  const repo = path.resolve(Config.path.temp, '../../config/config.yaml')
  ok(!!hostPathError(repo), '插件 config/ 下的文件被拒绝（审计复现路径）')
  fs.unlinkSync(out)
})

await test('符号链接不能绕过白名单（realpath 判定）', async () => {
  const target = path.join(os.tmpdir(), `pg-target-${process.pid}.txt`)
  fs.writeFileSync(target, 'secret')
  const link = path.join(tempRoot, `pg-link-${process.pid}.txt`)
  try { fs.symlinkSync(target, link) } catch { console.log('  （平台不支持符号链接，跳过）'); return }
  ok(fs.existsSync(link), '链接文件存在于 temp 内（但真实目标在外部）')
  ok(!!hostPathError(link), '指向外部的软链被拒绝')
  ok(realOrResolve(link) === fs.realpathSync(target), 'realOrResolve 解析到真实目标')
  fs.unlinkSync(link); fs.unlinkSync(target)
})

await test('不存在的路径也按越界拒绝（不给存在性探测）', async () => {
  ok(!!hostPathError(path.resolve(Config.path.temp, '../../.env')), '不存在 + 越界 → 直接拒绝')
})

console.log(`\n========================================\n通过 ${passed}，失败 ${failed}\n========================================`)
process.exit(failed ? 1 : 0)
