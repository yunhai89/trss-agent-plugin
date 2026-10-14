/**
 * calculate 工具离线自检（桩 transport；无需 e2b / 联网）。
 * 运行：node model/calc/test.mjs
 *
 * 覆盖：
 *   - 沙箱档（agent.sandbox.mode=e2b）：模型提交的代码在会话沙箱内执行（wrapper+code 上传、stdin 重定向）
 *   - fail-closed：mode=e2b 但沙箱未就绪 → 拒绝执行，绝不在宿主跑
 *   - 成本闸：单会话命令数上限对沙箱化工具同样生效（与 terminal 共享计数）
 *   - 模板缺依赖：沙箱内无 python3（exit 127）→ 可读失败
 *   - 宿主档（mode=off）：无 python3 时优雅跳过
 */
import { spawnSync } from 'node:child_process'

import { calcTool } from './index.js'
import { SandboxManager } from '../sandbox/manager.js'
import { makeCommandCounter } from '../sandbox/index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

// ---------- 桩 transport（与 transport.js 同形状；只实现用到的原语） ----------
function stubTransport({ runImpl = null } = {}) {
  const calls = { create: 0, run: 0, cmds: [], writes: [] }
  let seq = 0
  return {
    calls,
    async init() { return this },
    async ping() { return true },
    async create() { calls.create++; return { id: `sbx-${++seq}`, raw: {} } },
    async connect() { return { id: 'c', raw: {} } },
    async run(h, cmd, opts) { calls.run++; calls.cmds.push(cmd); return runImpl ? runImpl(h, cmd, opts) : makeHandle({ exitCode: 0, stdout: '2' }) },
    async write() {}, async writeMany(h, files) { calls.writes.push(...files.map((f) => f.path)) },
    async read() { return '' }, async list() { return [] },
    async kill() { return true }, async setTimeout() {}, async updateNetwork() {},
  }
}
function makeHandle({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  return { async wait() { return { exitCode, stdout, stderr } }, async kill() { return true } }
}
const mkBox = (t, over = {}) => new SandboxManager({ transport: t, idleMs: 60000, sandboxTtlMs: 600000, sweepIntervalMs: 100000, ...over })

/** 装配一个沙箱档 ctx（commands 可覆盖） */
function sandboxCtx(box, over = {}) {
  return {
    sandbox: {
      mode: 'e2b', manager: box, sessionKey: 'conv:g:u:c', audit: false,
      maxTimeout: 600, defaultCwd: '/home/user',
      commands: makeCommandCounter(50), ...over,
    },
  }
}

// ---------- 1. 沙箱档：代码在沙箱内执行 ----------
await test('calculate：沙箱档在沙箱内执行并回读结果', async () => {
  const t = stubTransport()
  const box = mkBox(t)
  try {
    const r = await calcTool.execute({ code: 'print(6*7)' }, sandboxCtx(box))
    eq(r.ok, true, 'ok:true')
    eq(r.result, '2', '结果来自沙箱 stdout（桩）')
    eq(r.sandboxed, true, '标注 sandboxed（可观测执行面）')
    eq(t.calls.create, 1, '创建会话沙箱')
    eq(t.calls.run, 1, '执行一条命令')
    ok(/python3 .*wrapper\.py < .*code\.py/.test(t.calls.cmds[0]), '命令 = wrapper.py + stdin 重定向（无代码拼接）')
    ok(t.calls.writes.some((p) => p.endsWith('/wrapper.py')), '上传固定 wrapper')
    ok(t.calls.writes.some((p) => p.endsWith('/code.py')), '上传用户代码文件')
    ok(t.calls.writes.every((p) => p.startsWith('/home/user/.agent-tmp/')), '文件落在沙箱工具临时目录')
  } finally { await box.shutdown() }
})

// ---------- 2. fail-closed：显式 e2b 但沙箱未就绪 ----------
await test('calculate：mode=e2b 但沙箱不可用 → 拒绝执行（不在宿主跑代码）', async () => {
  const r = await calcTool.execute({ code: 'print(1)' }, { sandbox: { mode: 'e2b', manager: null } })
  ok(r.error && r.error.includes('沙箱不可用'), '返回 fail-closed 错误')
  ok(r.result === undefined, '没有结果（没有宿主兜底）')
})

// ---------- 3. 成本闸：共享单会话命令数上限 ----------
await test('calculate：命令数超限 → 拒绝并提示', async () => {
  const t = stubTransport()
  const box = mkBox(t)
  try {
    const ctx = sandboxCtx(box, { commands: makeCommandCounter(1) })
    const r1 = await calcTool.execute({ code: 'print(1)' }, ctx)
    eq(r1.ok, true, '第 1 条放行')
    const r2 = await calcTool.execute({ code: 'print(2)' }, ctx)
    ok(r2.error && r2.error.includes('上限'), '第 2 条被成本闸拦下')
    eq(t.calls.run, 1, '只执行了 1 条命令')
  } finally { await box.shutdown() }
})

// ---------- 4. 模板缺 python3 ----------
await test('calculate：沙箱缺 python3（exit 127）→ 可读失败', async () => {
  const t = stubTransport({ runImpl: () => makeHandle({ exitCode: 127, stderr: 'sh: 1: python3: not found' }) })
  const box = mkBox(t)
  try {
    const r = await calcTool.execute({ code: 'print(1)' }, sandboxCtx(box))
    ok(r.error && r.error.includes('python3') && r.error.includes('模板'), '错误点名缺 python3 + 提示装模板')
    eq(r.missing, 'python3', '标记 missing（可诊断）')
  } finally { await box.shutdown() }
})

// ---------- 5. 沙箱执行超时 ----------
await test('calculate：沙箱执行超时 → 超时提示（不当成功）', async () => {
  const t = stubTransport({ runImpl: () => ({ async wait() { return new Promise(() => {}) }, async kill() { return true } }) })
  const box = mkBox(t)
  try {
    const r = await calcTool.execute({ code: 'while True: pass' }, sandboxCtx(box, { maxTimeout: 1 }))
    // 桩句柄永不结算：靠 runToolCommand 的本地 timer 收尾（1s 上限）
    ok(r.error && (r.error.includes('超时') || r.error.includes('timeout') || r.error.includes('沙箱')), `超时/失败语义可辨（${r.error}）`)
  } finally { await box.shutdown() }
})

// ---------- 6. 宿主档（mode=off）：行为保持 ----------
const hasPython = (() => { try { return spawnSync('python3', ['-V'], { stdio: 'ignore', timeout: 5000 }).status === 0 } catch { return false } })()
if (hasPython) {
  await test('calculate：mode=off 走宿主解释器（行为保持）', async () => {
    const r = await calcTool.execute({ code: 'print(6*7)' }, {})
    eq(r.ok, true, 'ok:true')
    eq(r.result, '42', '宿主 python3 结果正确')
    eq(r.sandboxed, undefined, '不标注 sandboxed（宿主档）')
  })
} else {
  console.log('\n[calculate：mode=off 宿主档] 跳过（本机无 python3）')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
