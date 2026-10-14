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
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`) }

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

// ── 沙箱档（2025-10）：沙箱内 skillhub → 只回传 .md ──
const { SandboxManager } = await import('../sandbox/manager.js')
const { makeCommandCounter } = await import('../sandbox/index.js')
function stubTransport({ entries = [], missingCli = false, installFail = false, contents = {} } = {}) {
  const calls = { create: 0, run: 0, cmds: [], reads: [] }
  let seq = 0
  return {
    calls,
    async init() { return this },
    async ping() { return true },
    async create() { calls.create++; return { id: `sbx-${++seq}`, raw: {} } },
    async connect() { return { id: 'c', raw: {} } },
    async run(h, cmd, opts) {
      calls.run++; calls.cmds.push(cmd)
      const mk = (exitCode) => ({ async wait() { return { exitCode, stdout: '', stderr: exitCode ? 'ERR' : '' } }, async kill() { return true } })
      if (/command -v skillhub/.test(cmd)) return mk(missingCli ? 1 : 0)
      if (/skillhub install/.test(cmd)) return mk(installFail ? 1 : 0)
      return mk(0)
    },
    async write() {}, async writeMany() {},
    async read(_h, p, { format } = {}) { calls.reads.push({ path: p, format }); return Buffer.from(contents[p] ?? '# skill\n') },
    async list() { return entries },
    async kill() { return true }, async setTimeout() {}, async updateNetwork() {},
  }
}
const mkBox = (t) => new SandboxManager({ transport: t, idleMs: 60000, sandboxTtlMs: 600000, sweepIntervalMs: 100000 })
const sandboxCtxOf = (box) => ({ sandbox: { mode: 'e2b', manager: box, sessionKey: 'k-skill', audit: false, maxTimeout: 600, commands: makeCommandCounter(50) } })
const mkRegistry = () => { const s = new Map(); return { skills: s, register(...arr) { for (const x of arr) s.set(x.name || String(x), x) }, list() { return [...s.values()] }, _s: s } }

const skillsDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sbx-'))
{
  const t = stubTransport({
    entries: [
      { path: '/home/user/skills-out/demo/SKILL.md', type: 'file', size: 8 },
      { path: '/home/user/skills-out/demo/ref/a.md', type: 'file', size: 5 },
    ],
    contents: { '/home/user/skills-out/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n# demo\n', '/home/user/skills-out/demo/ref/a.md': 'a' },
  })
  const box = mkBox(t)
  try {
    const reg = mkRegistry()
    const tool2 = makeInstallSkillTool({ skillsDir: skillsDir2, registry: reg })
    const r = await tool2.execute({ name: 'demo' }, { isMaster: true, ...sandboxCtxOf(box) })
    ok(r.ok === true && r.sandboxed === true, '沙箱档安装成功且标注执行面')
    ok(fs.existsSync(path.join(skillsDir2, 'demo', 'SKILL.md')), '技能文件落到宿主 skills 目录')
    ok(fs.existsSync(path.join(skillsDir2, 'demo', 'ref', 'a.md')), '嵌套 .md 一并回传')
    ok(t.calls.cmds[0].includes('command -v skillhub'), '先预检沙箱内 CLI')
    ok(/^skillhub install demo --dir \/home\/user\/skills-out$/.test(t.calls.cmds[1]), '固定 argv 拼装（无 shell 注入面）')
    eq(t.calls.reads.every((x) => x.format === 'bytes'), true, '产物按二进制读回')
  } finally { await box.shutdown() }
}
{
  const t = stubTransport({ entries: [{ path: '/home/user/skills-out/demo/SKILL.md', type: 'file', size: 8 }, { path: '/home/user/skills-out/demo/evil.js', type: 'file', size: 20 }] })
  const box = mkBox(t)
  try {
    const tool3 = makeInstallSkillTool({ skillsDir: skillsDir2, registry: mkRegistry() })
    const r = await tool3.execute({ name: 'demo2' }, { isMaster: true, ...sandboxCtxOf(box) })
    ok(r.error && /不允许的文件类型/.test(r.error), '含 .js 的沙箱产物 → 拒绝')
    ok(!fs.existsSync(path.join(skillsDir2, 'demo2')), '拒绝时 skillsDir 未被触碰')
  } finally { await box.shutdown() }
}
{
  const t = stubTransport({ entries: [{ path: '/home/user/skills-out/demo/SKILL.md', type: 'symlink', size: 1 }] })
  const box = mkBox(t)
  try {
    const tool4 = makeInstallSkillTool({ skillsDir: skillsDir2, registry: mkRegistry() })
    const r = await tool4.execute({ name: 'demo3' }, { isMaster: true, ...sandboxCtxOf(box) })
    ok(r.error && /符号链接/.test(r.error), '符号链接产物 → 拒绝')
  } finally { await box.shutdown() }
}
{
  const t = stubTransport({ missingCli: true })
  const box = mkBox(t)
  try {
    const tool5 = makeInstallSkillTool({ skillsDir: skillsDir2, registry: mkRegistry() })
    const r = await tool5.execute({ name: 'demo4' }, { isMaster: true, ...sandboxCtxOf(box) })
    ok(r.error && /skillhub/.test(r.error) && /模板/.test(r.error), '沙箱缺 skillhub → 可读失败点名模板')
  } finally { await box.shutdown() }
}
{
  const tool6 = makeInstallSkillTool({ skillsDir: skillsDir2, registry: mkRegistry() })
  const r = await tool6.execute({ name: 'demo5' }, { isMaster: true, sandbox: { mode: 'e2b', manager: null } })
  ok(r.error && /沙箱不可用/.test(r.error), 'mode=e2b 但沙箱未就绪 → fail-closed（不在宿主跑）')
}
fs.rmSync(skillsDir2, { recursive: true, force: true })

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
