/**
 * install_skill 安全回归：产物校验必须拒绝可执行/符号链接/非 .md，且工具仅主人、名字白名单。
 * 运行：node model/skill/install.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateSkillArtifact, makeInstallSkillTool } from './install.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltest-'))

// ── validateSkillArtifact ──
const good = path.join(tmp, 'good')
fs.mkdirSync(good)
fs.writeFileSync(path.join(good, 'SKILL.md'), '# x')
fs.mkdirSync(path.join(good, 'ref'))
fs.writeFileSync(path.join(good, 'ref', 'a.md'), 'a')
ok(validateSkillArtifact(good).length === 0, '纯 .md 技能目录：通过')

const badJs = path.join(tmp, 'badjs')
fs.mkdirSync(badJs)
fs.writeFileSync(path.join(badJs, 'SKILL.md'), 'x')
fs.writeFileSync(path.join(badJs, 'evil.js'), 'process.exit(1)')
ok(validateSkillArtifact(badJs).some((e) => /不允许的文件类型/.test(e)), '含 .js（可执行）→ 拒绝')

const link = path.join(tmp, 'link')
fs.mkdirSync(link)
fs.writeFileSync(path.join(link, 'SKILL.md'), 'x')
try { fs.symlinkSync('/etc/passwd', path.join(link, 'l')) } catch { /* 忽略无权限 */ }
ok(validateSkillArtifact(link).some((e) => /符号链接/.test(e)), '含符号链接 → 拒绝')

const empty = path.join(tmp, 'empty')
fs.mkdirSync(empty)
ok(validateSkillArtifact(empty).some((e) => /未找到/.test(e)), '空目录 → 拒绝')

const img = path.join(tmp, 'img')
fs.mkdirSync(img)
fs.writeFileSync(path.join(img, 'a.png'), 'x')
ok(validateSkillArtifact(img).some((e) => /不允许/.test(e)), '含 .png → 拒绝')

const flat = path.join(tmp, 'x.md')
fs.writeFileSync(flat, 'x')
ok(validateSkillArtifact(flat).length === 0, '扁平 .md 文件：通过')
fs.writeFileSync(path.join(tmp, 'x.js'), 'x')
ok(validateSkillArtifact(path.join(tmp, 'x.js')).length > 0, '扁平 .js 文件：拒绝')

// ── 工具权限/参数校验（不触发 CLI 调用）──
const tool = makeInstallSkillTool({ skillsDir: tmp, registry: { skills: new Map(), register() {}, list() { return [] } } })
const r1 = await tool.execute({ name: 'abc' }, { isMaster: false })
ok(r1 && /仅主人/.test(r1.error), '非主人 → 拒绝')
const r2 = await tool.execute({ name: 'bad name!' }, { isMaster: true })
ok(r2 && /不合法/.test(r2.error), '非法技能名 → 拒绝（无 shell 注入面）')
const r3 = await tool.execute({ name: '../../etc' }, { isMaster: true })
ok(r3 && /不合法/.test(r3.error), '路径穿越式名字 → 拒绝')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
