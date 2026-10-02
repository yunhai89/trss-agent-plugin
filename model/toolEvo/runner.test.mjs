/**
 * toolEvo 隔离 runner 离线自检（审计 §4.2 / P0-1，F 阻断级）。
 * 验证：① 正常纯计算工具跑通；② capability ctx 只含 now/log（无 bot/fetcher/process 暴露）；
 *       ③ worker env 最小化（主进程敏感 env 不泄漏到子进程）；④ 超时 kill + 自愈。
 * 运行：node model/toolEvo/runner.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { RunnerClient } from './runner.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

/** 写一份宿主制品文件，返回 { url, source }（源以不可变 source 传入执行面） */
async function writeArtifact(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tevo-art-'))
  const file = path.join(dir, 'index.js')
  fs.writeFileSync(file, source)
  return { url: pathToFileURL(file).href, source }
}
const cleanup = (url) => { try { fs.rmSync(new URL(url), { recursive: true, force: true }) } catch { /* noop */ } }

// ---------- 1. 正常纯计算工具 ----------
await test('runner：正常纯计算工具跑通', async () => {
  const { url, source } = await writeArtifact(`export async function run(input, ctx) { return { doubled: (input.x||0)*2 } }`)
  const r = new RunnerClient({ logger: () => {}, timeoutMs: 3000 })
  try {
    const out = await r.invoke('v1', { source, artifactPath: url, expectedHash: sha256(source), params: { x: 21 } })
    ok(out.ok, '调用成功')
    eq(out.output.doubled, 42, '结果正确（21*2）')
  } finally { await r.stop(); cleanup(url) }
})

// ---------- 2. capability ctx 只含 now/log ----------
await test('runner：capability ctx 只含 now/log，无 bot/fetcher 暴露', async () => {
  const { url, source } = await writeArtifact(`export async function run(input, ctx) { return { keys: Object.keys(ctx).sort(), hasBot: 'bot' in ctx, hasFetcher: 'fetcher' in ctx, nowIsFn: typeof ctx.now === 'function', logIsFn: typeof ctx.log === 'function' } }`)
  const r = new RunnerClient({ logger: () => {}, timeoutMs: 3000 })
  try {
    const out = await r.invoke('v1', { source, artifactPath: url, expectedHash: sha256(source), params: {} })
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
  const { url, source } = await writeArtifact(`export async function run(input, ctx) { return { leaked: process.env.LEAKED_SECRET || null, hasPath: !!process.env.PATH, hasHome: !!process.env.HOME } }`)
  const r = new RunnerClient({ logger: () => {}, timeoutMs: 3000 })
  try {
    const out = await r.invoke('v1', { source, artifactPath: url, expectedHash: sha256(source), params: {} })
    ok(out.ok, '调用成功')
    eq(out.output.leaked, null, 'worker 看不到主进程 LEAKED_SECRET（env 白名单：仅 PATH/HOME）')
    ok(out.output.hasPath === true && out.output.hasHome === true, 'worker 仍有 PATH/HOME（最小必要）')
  } finally { await r.stop(); cleanup(url); delete process.env.LEAKED_SECRET }
})

// ---------- 4. 超时 kill + 自愈 ----------
await test('runner：超时返回 error + kill worker', async () => {
  const { url, source } = await writeArtifact(`export async function run(input, ctx) { await new Promise(r=>setTimeout(r, 5000)); return {ok:true} }`)
  const r = new RunnerClient({ logger: () => {}, timeoutMs: 800 })
  try {
    const out = await r.invoke('v1', { source, artifactPath: url, expectedHash: sha256(source), params: {} })
    ok(!out.ok, '超时返回失败')
    ok(/超时/.test(out.error || ''), '错误信息含超时')
  } finally { await r.stop(); cleanup(url) }
})

// ---------- 5. 串行队列：同 tick 并发也串行，且用后即弃无残留（审计 P1-6 / P0-1）----------
await test('runner：并发 invoke 串行化（宿主时间区间不重叠）+ worker 用后即弃', async () => {
  const { url, source } = await writeArtifact(`export async function run(input, ctx) {
    const t0 = Date.now(); ctx.log('start', t0)
    await new Promise(r=>setTimeout(r,120))
    const t1 = Date.now(); ctx.log('end', t1)
    return { t0, t1 } }`)
  const starts = [], ends = []
  const logger = (_lvl, ...args) => {
    if (args[1] === 'start') starts.push(args[2])
    else if (args[1] === 'end') ends.push(args[2])
  }
  const r = new RunnerClient({ logger, timeoutMs: 5000 })
  try {
    const outs = await Promise.all([1, 2, 3].map(() => r.invoke('v1', { source, artifactPath: url, expectedHash: sha256(source), params: {} })))
    ok(outs.every((o) => o.ok), '三次调用均成功')
    starts.sort((a, b) => a - b); ends.sort((a, b) => a - b)
    ok(starts.length === 3 && ends.length === 3, '收到 3 组 start/end')
    let overlap = false
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] > ends[i]) overlap = true
      if (i > 0 && starts[i] < ends[i - 1]) overlap = true
    }
    ok(!overlap, '三个执行区间两两不重叠（真正串行）')
    ok(r._worker === null, '调用结束后 worker 已回收（无跨调用残留状态）')
  } finally { await r.stop(); cleanup(url) }
})

// ---------- 6. 隔离：别名 process.getBuiltinModule 无法写宿主/读越界/联网（审计 P0-1）----------
await test('runner：本地隔离面阻断 fs 写入/越界读取/网络', async () => {
  const marker = path.join(os.tmpdir(), `tevo-escape-${Date.now()}`)
  const src = `export async function run(input, ctx) {
    const p = process
    const out = {}
    try { p.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); out.fsWrite='WROTE' } catch(e){ out.fsWrite=e.code||e.message }
    try { out.fsRead=String(p.getBuiltinModule('node:fs').readFileSync('/etc/hostname','utf8')).length } catch(e){ out.fsRead=e.code||e.message }
    try { const net=p.getBuiltinModule('node:net'); out.net=await new Promise(res=>{const s=net.connect({host:'1.1.1.1',port:53});s.on('connect',()=>{s.destroy();res('CONNECTED')});s.on('error',e=>res('ERR:'+e.code));setTimeout(()=>{s.destroy();res('TIMEOUT')},1200)}) } catch(e){ out.net=e.code||e.message }
    return out }`
  const { url } = await writeArtifact(src)
  const r = new RunnerClient({ logger: () => {}, timeoutMs: 4000 })
  try {
    const out = await r.invoke('v1', { source: src, artifactPath: url, expectedHash: sha256(src), params: {} })
    ok(out.ok, '调用返回')
    ok(!/WROTE/.test(String(out.output.fsWrite)), '别名 getBuiltinModule 无法写宿主文件')
    ok(fs.existsSync(marker) === false, '宿主标记文件不存在')
    ok(/ERR_ACCESS_DENIED|not a function/.test(String(out.output.fsRead)), `越界读取被拒（${out.output.fsRead}）`)
    ok(/ERR:|not a function/.test(String(out.output.net)), `未授权网络被拒（${out.output.net}）`)
  } finally { await r.stop(); cleanup(url); try { fs.rmSync(marker, { force: true }) } catch { /* noop */ } }
})

// ---------- 7. 制品篡改：哈希不匹配拒绝执行（审计 P1-7）----------
await test('runner：验证后篡改制品 → 拒绝执行', async () => {
  const good = `export async function run() { return { v: 4 } }`
  const { url } = await writeArtifact(good)
  const expectedHash = sha256(good)
  // 模拟“验证后把 index.js 改成 999”
  fs.writeFileSync(new URL(url), `export async function run() { return { v: 999 } }`)
  const r = new RunnerClient({ logger: () => {}, timeoutMs: 3000 })
  try {
    const out = await r.invoke('v1', { source: good, artifactPath: url, expectedHash, params: {} })
    ok(!out.ok, '篡改后拒绝执行')
    ok(out.errorClass === 'artifact_tampered', '错误类别标注制品篡改')
  } finally { await r.stop(); cleanup(url) }
})

// ============================================================
// 沙箱档（agent.sandbox.mode=e2b）：工具代码在 E2B microVM 内执行
// ============================================================
const { SandboxManager } = await import('../sandbox/manager.js')
const { ToolEvoRegistry } = await import('./registry.js')

function stubSandboxTransport({ writeError = null, runStdout = null, hang = false } = {}) {
  const calls = { create: 0, run: 0, kills: [], writes: [], runs: [], envs: [] }
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
    async kill(h) { calls.kills.push(h?.id); return true },
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
    ok(/^\/home\/user\/evo\/params-[0-9a-f]+\.json$/.test(String(env.EVO_PARAMS_FILE)), '参数走每调用独立文件（不走 shell 拼接、不互相覆盖）')
    ok(!('EVO_PARAMS' in env), '不再用 EVO_PARAMS 环境变量传参（避免 E2BIG 与转义问题）')
    const paths = t.calls.writes.map((w) => w.path)
    ok(paths.some((p) => p.endsWith('demo/1.0.0/index.js')), '制品已上传')
    ok(paths.some((p) => /params-[0-9a-f]+\.json$/.test(p)), '参数文件已写入')
  } finally { await r.stop(); await sbx.manager.shutdown(); cleanup(pathToFileURL(file).href) }
})

await test('沙箱档：每次调用独立沙箱（用后即毁，无跨调用残留状态）', async () => {
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
    await r.invoke('v2', { artifactPath: pathToFileURL(f2).href, artifactRel: 'b/1.0.0/index.js', params: {} })
    eq(t.calls.create, 3, '三次调用各开一次沙箱（无共享会话残留）')
    eq(t.calls.kills.length, 3, '每次调用后销毁沙箱')
    eq(sbx.manager.stats().leases, 0, '调用后无遗留租约')
    eq(t.calls.writes.filter((w) => w.path.endsWith('b/1.0.0/index.js')).length, 1, '换版本上传对应制品')
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
