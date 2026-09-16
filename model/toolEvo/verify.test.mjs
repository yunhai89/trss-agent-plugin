/**
 * toolEvo 候选执行双档自检（离线；本地档真跑子进程，沙箱档用桩 transport）。
 * 运行：node model/toolEvo/verify.test.mjs
 *
 * 覆盖：
 *   - 本地档：合法/死循环超时/抛错/断言失败，以及「一个候选只建一个会话」（N 用例复用 bundle）
 *   - 沙箱档：合法 JSON / 非 JSON 文案 / 超时文案 / 建一次沙箱跑 N 用例 / 结束后销毁
 *   - 失败语义：执行面不可用 → 整组用例判失败并留原因（不静默通过、不本地兜底）
 */
import { runCandidate, createSandboxCandidateSession, createLocalCandidateSession } from './sandbox.js'
import { verifyBehavior } from './verifier/behavior.js'
import { SandboxManager } from '../sandbox/manager.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

const src = 'export async function run(input,ctx){const m=String(input.text||"").match(/[a-z0-9._%+-]+@[a-z0-9.-]+/gi)||[];return{emails:m}}'

// ---------- 桩：toolEvo 候选用的沙箱 transport ----------
function stubTransport({ stdoutFor = null, throwOnRun = null } = {}) {
  const calls = { create: 0, run: 0, kill: [], writeMany: 0, files: [], envs: [] }
  let seq = 0
  return {
    calls,
    async init() { return this },
    async ping() { return true },
    async create() { calls.create++; return { id: `sbx-${++seq}`, raw: {} } },
    async connect() { return { id: 'c', raw: {} } },
    async write() {},
    async writeMany(handle, files) { calls.writeMany++; calls.files = files },
    async run(handle, cmd, opts) {
      calls.run++
      calls.envs.push(opts?.envs || {})
      if (throwOnRun) throw throwOnRun
      const raw = stdoutFor ? stdoutFor(opts?.envs || {}) : null
      if (raw && raw.timedOut) return { async wait() { return new Promise(() => {}) }, async kill() { return true } }
      const out = raw?.stdout ?? JSON.stringify({ ok: true, output: { emails: ['a@b.com'] } })
      return { async wait() { return { exitCode: raw?.exitCode ?? 0, stdout: out, stderr: raw?.stderr ?? '' } }, async kill() { return true } }
    },
    async kill(h) { calls.kill.push(h.id); return true },
    async setTimeout() {},
    async list() { return [] },
    async updateNetwork() {},
  }
}
const mkVerifyManager = (t) => new SandboxManager({ transport: t, maxSandboxes: 2, idleMs: 60000, sweepIntervalMs: 100000 })

// ============================================================
await test('本地档：runCandidate 合法 / 死循环超时 / 抛错', async () => {
  const r1 = await runCandidate({ source: src, input: { text: '联系 a@b.com 或 c@d.com' }, timeoutMs: 3000 })
  ok(r1.ok, '合法候选执行成功')
  eq(r1.output.emails, ['a@b.com', 'c@d.com'], '输出正确')

  const r2 = await runCandidate({ source: 'export async function run(){while(true){}}', input: {}, timeoutMs: 1000 })
  ok(r2.timedOut === true, '死循环被判超时')
  ok(/超时/.test(r2.error || ''), '超时错误文案保留')

  const r3 = await runCandidate({ source: 'export async function run(){throw new Error("爆炸")}', input: {}, timeoutMs: 1500 })
  ok(!r3.ok, '抛错候选失败')
  eq(r3.errorClass, 'Error', 'errorClass 透出')
})

await test('本地档：verifyBehavior 断言语义 + 一个候选一个会话（N 用例复用 bundle）', async () => {
  let sessions = 0
  const countingFactory = (args) => { sessions++; return createLocalCandidateSession(args) }
  const vb = await verifyBehavior({
    source: src,
    tests: [
      { name: '单邮箱', input: { text: 'a@b.com' }, expected: { emails: ['a@b.com'] } },
      { name: '无邮箱', input: { text: '无邮箱文本' }, expected: { emails: [] } },
      { name: '多邮箱', input: { text: 'x@y.com z@w.org' }, expected: { emails: ['x@y.com', 'z@w.org'] } },
    ],
    createSession: countingFactory,
  })
  eq(vb.passed, true, '3 个用例全过')
  eq(vb.evidence.totalTests, 3, 'evidence.totalTests=3')
  eq(vb.evidence.backend, 'local', 'evidence 标注 backend=local')
  eq(sessions, 1, '一个候选只建一个会话（不是每个用例一次冷启动）')

  const vb2 = await verifyBehavior({ source: src, tests: [{ input: { text: 'a@b.com' }, expected: { emails: ['wrong'] } }] })
  eq(vb2.passed, false, '断言不符 → 整体失败')
  ok(/≠ 期望/.test(vb2.results[0].reason || ''), '失败原因含期望对比')

  const vb3 = await verifyBehavior({ source: src, tests: [] })
  eq(vb3.passed, false, '无用例 → 不算通过（防空候选蒙过）')
})

await test('沙箱档：合法 JSON / 非 JSON 文案 / 超时文案', async () => {
  const t1 = stubTransport()
  const m1 = mkVerifyManager(t1)
  try {
    const vb = await verifyBehavior({
      source: src,
      tests: [{ input: { text: 'a@b.com' }, expected: { emails: ['a@b.com'] } }, { input: { text: 'x@y.org' }, expected: { emails: ['a@b.com'] } }],
      createSession: (args) => createSandboxCandidateSession(m1, args),
    })
    eq(vb.passed, true, '沙箱档 2 用例全过')
    eq(vb.evidence.backend, 'sandbox', 'evidence 标注 backend=sandbox')
    eq(t1.calls.create, 1, '一个候选只开一个沙箱（N 用例复用）')
    eq(t1.calls.run, 2, '每个用例一次命令执行')
    eq(t1.calls.kill.length, 1, '验证结束销毁一次性沙箱')
    const files = (t1.calls.files || []).map((f) => String(f.path).split('/').pop()).sort()
    eq(files, ['index.js', 'runner.mjs'], 'bundle（候选 + runner 入口）已上传到沙箱')
    ok(String(t1.calls.envs[0].TOOL_INPUT_JSON || '').includes('a@b.com'), '用例输入经 env 传入（不拼 shell）')
  } finally { await m1.shutdown() }

  const t2 = stubTransport({ stdoutFor: () => ({ stdout: '不是 JSON 的输出' }) })
  const m2 = mkVerifyManager(t2)
  try {
    const vb = await verifyBehavior({ source: src, tests: [{ input: {} }], createSession: (args) => createSandboxCandidateSession(m2, args) })
    eq(vb.passed, false, '非 JSON 输出 → 判失败')
    ok(/候选输出非 JSON/.test(vb.results[0].reason || ''), '保留原文案「候选输出非 JSON」')
  } finally { await m2.shutdown() }

  const t3 = stubTransport({ stdoutFor: () => ({ timedOut: true }) })
  const m3 = mkVerifyManager(t3)
  try {
    const vb = await verifyBehavior({ source: src, tests: [{ input: {} }], timeoutMs: 500, createSession: (args) => createSandboxCandidateSession(m3, args) })
    eq(vb.passed, false, '超时 → 判失败')
    ok(/超时/.test(vb.results[0].reason || ''), '超时原因可见')
  } finally { await m3.shutdown() }
})

await test('沙箱档：执行面不可用 → 整组失败并留原因（不静默通过、不本地兜底）', async () => {
  const t = stubTransport({ throwOnRun: Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }) })
  const m = mkVerifyManager(t)
  try {
    const vb = await verifyBehavior({ source: src, tests: [{ input: {} }], createSession: (args) => createSandboxCandidateSession(m, args) })
    eq(vb.passed, false, '判失败')
    ok(/ENOTFOUND|沙箱|不可用/.test(vb.results[0].reason || ''), `原因可见（${vb.results[0].reason}）`)
    eq(t.calls.create, 1, '只在沙箱内尝试（无本地兜底路径）')
  } finally { await m.shutdown() }
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
