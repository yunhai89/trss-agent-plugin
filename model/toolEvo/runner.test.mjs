/**
 * toolEvo 隔离 runner 离线自检（审计 §4.2 / P0-1，F 阻断级）。
 * 验证：① 正常纯计算工具跑通；② capability ctx 只含 now/log（无 bot/fetcher/process 暴露）；
 *       ③ worker env 最小化（主进程敏感 env 不泄漏到子进程）；④ 超时 kill + 自愈。
 * 运行：node model/toolEvo/runner.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { RunnerClient } from './runner.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

async function writeArtifact(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tevo-art-'))
  const file = path.join(dir, 'index.js')
  fs.writeFileSync(file, source)
  return pathToFileURL(file).href
}
const cleanup = (url) => { try { fs.rmSync(new URL(url), { recursive: true, force: true }) } catch { /* noop */ } }

// ---------- 1. 正常纯计算工具 ----------
await test('runner：正常纯计算工具跑通', async () => {
  const url = await writeArtifact(`export async function run(input, ctx) { return { doubled: (input.x||0)*2 } }`)
  const r = new RunnerClient({ logger: () => {}, timeoutMs: 3000 })
  try {
    const out = await r.invoke('v1', { artifactPath: url, params: { x: 21 } })
    ok(out.ok, '调用成功')
    eq(out.output.doubled, 42, '结果正确（21*2）')
  } finally { await r.stop(); cleanup(url) }
})

// ---------- 2. capability ctx 只含 now/log ----------
await test('runner：capability ctx 只含 now/log，无 bot/fetcher 暴露', async () => {
  const url = await writeArtifact(`export async function run(input, ctx) { return { keys: Object.keys(ctx).sort(), hasBot: 'bot' in ctx, hasFetcher: 'fetcher' in ctx, nowIsFn: typeof ctx.now === 'function', logIsFn: typeof ctx.log === 'function' } }`)
  const r = new RunnerClient({ logger: () => {}, timeoutMs: 3000 })
  try {
    const out = await r.invoke('v1', { artifactPath: url, params: {} })
    ok(out.ok, '调用成功')
    eq(out.output.keys, ['log', 'now'], 'ctx 仅含 now/log（冻结白名单）')
    ok(out.output.hasBot === false, 'ctx 无 bot（审计 §4.2：不暴露宿主）')
    ok(out.output.hasFetcher === false, 'ctx 无 fetcher')
    ok(out.output.nowIsFn && out.output.logIsFn, 'now/log 均为函数')
  } finally { await r.stop(); cleanup(url) }
})

// ---------- 3. worker env 最小化（主进程敏感变量不泄漏）----------
await test('runner：worker env 最小化，主进程敏感 env 不泄漏', async () => {
  process.env.LEAKED_SECRET = 'should-not-leak-to-worker'
  const url = await writeArtifact(`export async function run(input, ctx) { return { leaked: process.env.LEAKED_SECRET || null, hasPath: !!process.env.PATH, hasHome: !!process.env.HOME } }`)
  const r = new RunnerClient({ logger: () => {}, timeoutMs: 3000 })
  try {
    const out = await r.invoke('v1', { artifactPath: url, params: {} })
    ok(out.ok, '调用成功')
    eq(out.output.leaked, null, 'worker 看不到主进程 LEAKED_SECRET（env 白名单：仅 PATH/HOME）')
    ok(out.output.hasPath === true && out.output.hasHome === true, 'worker 仍有 PATH/HOME（最小必要）')
  } finally { await r.stop(); cleanup(url); delete process.env.LEAKED_SECRET }
})

// ---------- 4. 超时 kill + 自愈 ----------
await test('runner：超时返回 error + kill worker', async () => {
  const url = await writeArtifact(`export async function run(input, ctx) { await new Promise(r=>setTimeout(r, 5000)); return {ok:true} }`)
  const r = new RunnerClient({ logger: () => {}, timeoutMs: 800 })
  try {
    const out = await r.invoke('v1', { artifactPath: url, params: {} })
    ok(!out.ok, '超时返回失败')
    ok(/超时/.test(out.error || ''), '错误信息含超时')
  } finally { await r.stop(); cleanup(url) }
})

// ============================================================
// 沙箱档（agent.sandbox.mode=e2b）：工具代码在 E2B microVM 内执行
// ============================================================
const { SandboxManager } = await import('../sandbox/manager.js')
const { ToolEvoRegistry } = await import('./registry.js')

function stubSandboxTransport({ writeError = null, runStdout = null, hang = false } = {}) {
  const calls = { create: 0, run: 0, writes: [], runs: [], envs: [] }
  let seq = 0
  return {
    calls,
    async init() { return this },
    async ping() { return true },
    async create() { calls.create++; return { id: `sbx-${++seq}`, raw: {} } },
    async connect() { return { id: 'c', raw: {} } },
    async write(h, p, data) { if (writeError) throw writeError; calls.writes.push({ path: p, len: String(data).length }) },
    async writeMany(h, files) { for (const f of files) calls.writes.push({ path: f.path, len: String(f.data).length }) },
    async run(h, cmd, opts) {
      calls.run++
      calls.runs.push(cmd)
      calls.envs.push(opts?.envs || {})
      if (hang) return { async wait() { return new Promise(() => {}) }, async kill() { return true } }
      const out = runStdout ?? JSON.stringify({ ok: true, output: { doubled: 42 } })
      return { async wait() { return { exitCode: 0, stdout: out, stderr: '' } }, async kill() { return true } }
    },
    async kill() { return true },
    async setTimeout() {},
    async list() { return [] },
    async updateNetwork() {},
  }
}
const mkRunnerSandbox = (t) => ({ manager: new SandboxManager({ transport: t, idleMs: 60000, sweepIntervalMs: 100000 }) })

await test('沙箱档：invoke 走 microVM（env 传制品路径与参数文件，不拼 shell）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tevo-art-sbx-'))
  const file = path.join(dir, 'index.js')
  fs.writeFileSync(file, `export async function run(input, ctx) { return { doubled: (input.x||0)*2 } }`)
  const t = stubSandboxTransport()
  const sbx = mkRunnerSandbox(t)
  const r = new RunnerClient({ logger: () => {}, timeoutMs: 3000, sandbox: sbx, artifactsDir: dir })
  try {
    eq(r.backend, 'sandbox', '启用沙箱档')
    const out = await r.invoke('v1', { artifactPath: pathToFileURL(file).href, artifactRel: 'demo/1.0.0/index.js', params: { x: 21 } })
    ok(out.ok, '调用成功')
    eq(out.output.doubled, 42, '结果正确')
    eq(t.calls.runs, ['node runner.mjs'], '在沙箱内执行 runner.mjs')
    const env = t.calls.envs[0]
    eq(env.EVO_ENTRY, '/home/user/evo/demo/1.0.0/index.js', '制品路径按相对路径拼进沙箱')
    eq(env.EVO_PARAMS_FILE, '/home/user/evo/params.json', '参数走文件（不走 shell 拼接）')
    ok(!('EVO_PARAMS' in env), '不再用 EVO_PARAMS 环境变量传参（避免 E2BIG 与转义问题）')
    const paths = t.calls.writes.map((w) => w.path)
    ok(paths.some((p) => p.endsWith('demo/1.0.0/index.js')), '制品已上传')
    ok(paths.some((p) => p.endsWith('params.json')), '参数文件已写入')
  } finally { await r.stop(); await sbx.manager.shutdown(); cleanup(pathToFileURL(file).href) }
})

await test('沙箱档：制品只上传一次（同版本复用沙箱内副本）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tevo-art-sbx2-'))
  const f1 = path.join(dir, 'a.js'); const f2 = path.join(dir, 'b.js')
  fs.writeFileSync(f1, `export async function run() { return { v: 'a' } }`)
  fs.writeFileSync(f2, `export async function run() { return { v: 'b' } }`)
  const t = stubSandboxTransport()
  const sbx = mkRunnerSandbox(t)
  const r = new RunnerClient({ logger: () => {}, timeoutMs: 3000, sandbox: sbx, artifactsDir: dir })
  try {
    await r.invoke('v1', { artifactPath: pathToFileURL(f1).href, artifactRel: 'a/1.0.0/index.js', params: {} })
    await r.invoke('v1', { artifactPath: pathToFileURL(f1).href, artifactRel: 'a/1.0.0/index.js', params: {} })
    const uploadsA = t.calls.writes.filter((w) => w.path.endsWith('a/1.0.0/index.js')).length
    eq(uploadsA, 1, '同一 versionId 只上传一次制品')
    await r.invoke('v2', { artifactPath: pathToFileURL(f2).href, artifactRel: 'b/1.0.0/index.js', params: {} })
    eq(t.calls.writes.filter((w) => w.path.endsWith('b/1.0.0/index.js')).length, 1, '换版本上传新制品')
    eq(t.calls.create, 1, '三次调用复用同一沙箱会话')
  } finally { await r.stop(); await sbx.manager.shutdown(); cleanup(pathToFileURL(f1).href) }
})

await test('沙箱档：上传失败 → fail-closed（不落回本地 fork，也不主进程执行）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tevo-art-sbx3-'))
  const file = path.join(dir, 'index.js')
  fs.writeFileSync(file, `export async function run() { return { ok: true } }`)
  const t = stubSandboxTransport({ writeError: Object.assign(new Error('sandbox not found'), { name: 'SandboxNotFoundError' }) })
  const sbx = mkRunnerSandbox(t)
  const r = new RunnerClient({ logger: () => {}, timeoutMs: 3000, sandbox: sbx, artifactsDir: dir })
  try {
    const out = await r.invoke('v1', { artifactPath: pathToFileURL(file).href, artifactRel: 'x/1.0.0/index.js', params: {} })
    ok(!out.ok, '调用失败')
    ok(/沙箱不可用/.test(out.error || ''), `错误说明是沙箱不可用（${String(out.error).slice(0, 60)}）`)
    ok(r._worker === null, '没有回退到本地 fork worker')
    eq(t.calls.run, 0, '没有执行任何命令')
    eq(sbx.manager.stats().leases, 0, '坏会话已丢弃（下次重建）')
  } finally { await r.stop(); await sbx.manager.shutdown(); cleanup(pathToFileURL(file).href) }
})

await test('沙箱档：超时 → 报超时并丢弃会话', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tevo-art-sbx4-'))
  const file = path.join(dir, 'index.js')
  fs.writeFileSync(file, `export async function run() { await new Promise(() => {}) }`)
  const t = stubSandboxTransport({ hang: true })
  const sbx = mkRunnerSandbox(t)
  const r = new RunnerClient({ logger: () => {}, timeoutMs: 600, sandbox: sbx, artifactsDir: dir })
  try {
    const out = await r.invoke('v1', { artifactPath: pathToFileURL(file).href, artifactRel: 'y/1.0.0/index.js', params: {} })
    ok(!out.ok, '超时返回失败')
    ok(/超时/.test(out.error || ''), '错误信息含超时（文案与本地档一致）')
  } finally { await r.stop(); await sbx.manager.shutdown(); cleanup(pathToFileURL(file).href) }
})

await test('registry：无 runner → fail-closed（拒绝在主进程执行进化工具）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tevo-reg-'))
  const reg = new ToolEvoRegistry({ artifactsDir: dir })
  const stable = { versionId: 'v1', semver: '1.0.0', manifest: { name: 'demo_tool', description: 'd', inputSchema: { type: 'object' }, permissions: { sideEffects: ['none'] }, provenance: { kind: 'generated' } } }
  const contract = await reg.toToolContract(stable, null)
  let err = null
  try { await contract.execute({}) } catch (e) { err = e }
  ok(!!err, '无隔离面时 execute 抛错')
  ok(/隔离执行面未就绪/.test(err?.message || ''), `错误说明原因（${String(err?.message).slice(0, 60)}）`)
  ok(!/import/.test(String(err?.message)), '不再是"加载制品后主进程执行"的老路径')
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
