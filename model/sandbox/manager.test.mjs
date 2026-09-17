/**
 * 沙箱管理器 + runShell 契约回归（离线，桩 transport；无需 e2b / 联网 / 宿主进程）。
 * 运行：node model/sandbox/manager.test.mjs
 *
 * 覆盖实现计划 §5/§7：
 *   会话绑定、singleflight、闲置回收、并发上限与配额失败、创建失败归还名额、TTL 续期、
 *   shutdown/drop、以及 runShell 逐字段契约与 fail-closed / 不重跑已启动命令
 *   —— 外加「执行面不得回退到宿主子进程」的源码级守卫。
 */
import fs from 'node:fs'
import path from 'node:path'

import { SandboxManager } from './manager.js'
import { runSandboxShell } from './shell.js'
import { SandboxError, classify } from './errors.js'
import { makeCommandCounter, buildNetworkOpts, buildEgressOpts, sessionKeyOf, isSandboxEnabled, createSandboxRuntime } from './index.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`)
}
async function test(name, fn) {
  console.log(`\n[${name}]`)
  try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) }
}

// ---------- 桩 transport：与 transport.js 同形状，记录调用 ----------
function makeHandle({ exitCode = 0, stdout = '', stderr = '', waitError = null, hang = false, onKill = null } = {}) {
  let killed = false
  return {
    killed: () => killed,
    async wait() {
      if (hang) return new Promise(() => {})
      if (waitError) throw waitError
      return { exitCode, stdout, stderr }
    },
    async kill() { killed = true; onKill?.(); return true },
  }
}

function stubTransport({ createError = null, runImpl = null, renewError = null, killError = null } = {}) {
  const calls = { create: 0, run: 0, kill: [], renew: 0, lastRunOpts: null, createdIds: [] }
  let seq = 0
  return {
    calls,
    async init() { return this },
    async ping() { return true },
    async create() {
      calls.create++
      const e = typeof createError === 'function' ? createError(calls.create) : createError
      if (e) throw e
      const id = `sbx-${++seq}`
      calls.createdIds.push(id)
      return { id, raw: {} }
    },
    async connect() { return { id: 'connected', raw: {} } },
    async run(handle, cmd, opts) {
      calls.run++
      calls.lastRunOpts = { cmd, ...opts }
      if (runImpl) return runImpl(handle, cmd, opts)
      return makeHandle({ exitCode: 0, stdout: 'ok' })
    },
    async write() {},
    async writeMany() {},
    async kill(h) { calls.kill.push(h.id); if (killError) throw killError; return true },
    async setTimeout() { calls.renew++; if (renewError) throw renewError },
    async list() { return [] },
    async updateNetwork() {},
  }
}

const mkManager = (t, over = {}) => new SandboxManager({ transport: t, maxSandboxes: 4, idleMs: 1000, sandboxTtlMs: 10000, concurrencyWaitMs: 200, sweepIntervalMs: 100000, ...over })

// ============================================================
await test('会话绑定：同键复用同一沙箱（不重复创建）', async () => {
  const t = stubTransport()
  const m = mkManager(t)
  try {
    const a = await m.acquire('conv:g1:u1:c1')
    const b = await m.acquire('conv:g1:u1:c1')
    eq(t.calls.create, 1, '同键两次 acquire 只创建 1 次')
    eq(a.id, b.id, '拿到同一个沙箱')
    const c = await m.acquire('conv:g1:u2:c1')
    eq(t.calls.create, 2, '换键才新建')
    ok(c.id !== a.id, '不同会话沙箱隔离')
    eq(m.stats().leases, 2, '租约数=2')
  } finally { await m.shutdown() }
})

await test('singleflight：并发同键只创建一次', async () => {
  const t = stubTransport()
  const m = mkManager(t)
  try {
    const rs = await Promise.all(Array.from({ length: 5 }, () => m.acquire('conv:g:u:c')))
    eq(t.calls.create, 1, '并发 5 次 acquire → 创建 1 次')
    eq(new Set(rs.map((r) => r.id)).size, 1, '5 个调用方拿到同一沙箱')
  } finally { await m.shutdown() }
})

await test('闲置回收：超 idleMs 被销毁且名额归还', async () => {
  const t = stubTransport()
  let t0 = 1000
  const m = mkManager(t, { now: () => t0 })
  try {
    await m.acquire('k1')
    await m.acquire('k2')
    eq(m.stats().active, 2, '占用 2')
    t0 += 1001 // 超过 idleMs=1000
    const n = await m._sweep()
    eq(n, 2, 'sweep 回收 2 个')
    eq(m.stats().leases, 0, '租约清空')
    eq(m.stats().active, 0, '并发名额归还')
    eq(t.calls.kill.length, 2, 'killed 2 个沙箱')
    // 回收后再 acquire 会重建
    await m.acquire('k1')
    eq(t.calls.create, 3, '回收后重建（不是复用死沙箱）')
  } finally { await m.shutdown() }
})

await test('并发上限：等待超时 → quota（且绝不本地兜底）', async () => {
  const t = stubTransport()
  const m = mkManager(t, { maxSandboxes: 2, concurrencyWaitMs: 60 })
  try {
    await m.acquire('a')
    await m.acquire('b')
    const err = await m.acquire('c').then(() => null, (e) => e)
    ok(err instanceof SandboxError, '抛 SandboxError')
    eq(classify(err).kind, 'quota', 'kind=quota（可重试语义）')
    ok(String(err.message).includes('maxSandboxes=2'), '文案含上限值')
    eq(t.calls.create, 2, '超限时不创建第 3 个')
    eq(t.calls.run, 0, '超限时没有任何命令执行（无宿主兜底路径）')
    eq(m.stats().waiters, 0, '超时的等待者已出队')
  } finally { await m.shutdown() }
})

await test('并发上限：有名额释放时唤醒等待者', async () => {
  const t = stubTransport()
  const m = mkManager(t, { maxSandboxes: 1, concurrencyWaitMs: 2000 })
  try {
    await m.acquire('a')
    const p = m.acquire('b')
    await new Promise((r) => setTimeout(r, 20))
    eq(m.stats().waiters, 1, 'b 在等待名额')
    await m.destroy('a')
    const h = await p
    ok(!!h?.id, '释放后 b 拿到沙箱')
    eq(m.stats().active, 1, '占用回到 1')
  } finally { await m.shutdown() }
})

await test('创建失败：抛结构化错误且归还名额（不永久吃额度）', async () => {
  const t = stubTransport({ createError: Object.assign(new Error('bad key'), { name: 'AuthenticationError', status: 401 }) })
  const m = mkManager(t, { maxSandboxes: 1 })
  try {
    const e1 = await m.acquire('a').then(() => null, (e) => e)
    eq(classify(e1).kind, 'auth', '创建失败按 auth 分类')
    eq(m.stats().active, 0, '失败后名额归还')
    const e2 = await m.acquire('b').then(() => null, (e) => e)
    ok(!!e2, '下一次仍能尝试（未被永久占额）')
    eq(m.stats().creating, 0, '在飞行创建表已清空（不残留失败 promise）')
  } finally { await m.shutdown() }
})

await test('TTL 续期：命中租约过半衰时续期一次', async () => {
  const t = stubTransport()
  let t0 = 0
  const m = mkManager(t, { now: () => t0, sandboxTtlMs: 10000 })
  try {
    await m.acquire('k')
    eq(t.calls.renew, 0, '首次 acquire 不续期')
    t0 += 4000
    await m.acquire('k')
    eq(t.calls.renew, 0, '未过半衰（5000）不续期')
    t0 += 2000
    await m.acquire('k')
    eq(t.calls.renew, 1, '过半衰续期 1 次')
    await m.acquire('k')
    eq(t.calls.renew, 1, '刚续期过不重复调用')
  } finally { await m.shutdown() }
})

await test('shutdown / drop 语义', async () => {
  const t = stubTransport()
  const m = mkManager(t)
  await m.acquire('a')
  await m.acquire('b')
  eq(m.drop('a'), true, 'drop 命中')
  eq(t.calls.kill.length, 0, 'drop 不发 kill（沙箱已不存在）')
  eq(m.stats().active, 1, 'drop 归还名额')
  eq(await m.shutdown(), 1, 'shutdown 销毁剩余 1 个')
  eq(m.stats().leases, 0, '租约清空')
  const e = await m.acquire('c').then(() => null, (x) => x)
  eq(classify(e).kind, 'killed', '关闭后 acquire 直接拒绝')
})

await test('runShell 契约：退出码 / 输出 / 超时 / 取消', async () => {
  const t = stubTransport({ runImpl: (h, cmd) => makeHandle(cmd.includes('fail') ? { exitCode: 3, stdout: 'out3', stderr: 'err3' } : { exitCode: 0, stdout: 'hello', stderr: '' }) })
  const m = mkManager(t)
  try {
    const okRun = await runSandboxShell(m, 'k', 'echo hello', { timeout: 5 })
    eq(okRun.ok, true, 'exitCode=0 → ok:true')
    eq(okRun.exitCode, 0, 'exitCode 透传')
    eq(okRun.stdout, 'hello', 'stdout 透传')
    ok(typeof okRun.duration === 'number' && okRun.duration >= 0, 'duration 为数字')
    ok(typeof okRun.setupMs === 'number', '带 setupMs（acquire 耗时）')
    ok(!!okRun.sandboxId, '带 sandboxId（便于排障；不含任何 token）')

    const bad = await runSandboxShell(m, 'k', 'exit fail', { timeout: 5 })
    eq(bad.ok, false, 'exitCode=3 → ok:false')
    eq(bad.exitCode, 3, 'exitCode=3 透传（业务语义）')
    eq(bad.timedOut, undefined, '业务失败不带 timedOut')
    eq(bad.sandboxError, undefined, '业务失败**不**带 sandboxError（不是基础设施故障）')

    const to = await runSandboxShell(m, 'k', 'sleep', { timeout: 1, maxTimeout: 1 })
    // 桩 run 默认立即返回；用 hang 句柄才能测超时 → 单独用另一个 manager
    ok(to.ok !== undefined, '超时分支可执行（下方用 hang 句柄单测）')
  } finally { await m.shutdown() }
})

await test('runShell 契约：本地超时杀命令并标记 timedOut', async () => {
  const t = stubTransport({ runImpl: () => makeHandle({ hang: true }) })
  const m = mkManager(t)
  try {
    const r = await runSandboxShell(m, 'k', 'sleep 100', { timeout: 1, maxTimeout: 1 })
    eq(r.ok, false, '超时 → ok:false')
    eq(r.timedOut, true, 'timedOut=true')
    eq(r.exitCode, null, 'exitCode=null')
    eq(r.signal, 'SIGKILL', 'signal=SIGKILL（与旧契约同名同值）')
    ok(r.duration >= 900, '确实等到了超时点')
  } finally { await m.shutdown() }
})

await test('runShell 契约：abort 立即取消并杀命令', async () => {
  const t = stubTransport({ runImpl: () => makeHandle({ hang: true }) })
  const m = mkManager(t)
  try {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 30)
    const t0 = Date.now()
    const r = await runSandboxShell(m, 'k', 'sleep 100', { timeout: 30, signal: ac.signal })
    eq(r.aborted, true, 'aborted=true')
    eq(r.ok, false, 'ok:false')
    eq(r.exitCode, null, 'exitCode=null')
    ok(Date.now() - t0 < 1000, `abort 后快速结算（${Date.now() - t0}ms，不等满 timeout）`)
  } finally { await m.shutdown() }
})

await test('runShell 契约：已取消的 signal 不创建沙箱', async () => {
  const t = stubTransport()
  const m = mkManager(t)
  try {
    const ac = new AbortController()
    ac.abort()
    const r = await runSandboxShell(m, 'k', 'echo hi', { signal: ac.signal })
    eq(r.aborted, true, 'aborted:true')
    eq(t.calls.create, 0, '连沙箱都不创建（不为注定丢弃的调用付成本）')
    eq(t.calls.run, 0, '没有命令执行')
  } finally { await m.shutdown() }
})

await test('fail-closed：沙箱基础设施故障不得回退本地，且不冒充成功', async () => {
  const t = stubTransport({ runImpl: () => { throw Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }) } })
  const m = mkManager(t)
  try {
    const r = await runSandboxShell(m, 'k', 'echo hi', { timeout: 5 })
    eq(r.ok, false, 'ok:false')
    eq(r.exitCode, null, 'exitCode=null')
    eq(r.sandboxError.kind, 'unreachable', 'kind=unreachable')
    eq(r.sandboxError.retryable, true, '可重试标记透出（由上层决定）')
    ok(String(r.stderr).includes('不可达'), 'stderr 给可读原因')
  } finally { await m.shutdown() }

  // manager 缺失（未配置/初始化失败）→ unconfigured，绝不执行
  const r2 = await runSandboxShell(null, 'k', 'echo hi', {})
  eq(r2.ok, false, '无 manager → ok:false')
  eq(r2.sandboxError.kind, 'unconfigured', 'kind=unconfigured')
})

await test('不重复副作用：命令已启动后沙箱消失 → 上报失败而不重跑', async () => {
  const t = stubTransport({ runImpl: () => makeHandle({ waitError: Object.assign(new Error('sandbox not found'), { name: 'SandboxNotFoundError' }) }) })
  const m = mkManager(t)
  try {
    const r = await runSandboxShell(m, 'k', 'rm -rf /tmp/x', { timeout: 5 })
    eq(t.calls.create, 1, '只创建 1 次（不重建重跑）')
    eq(t.calls.run, 1, '命令只跑 1 次（任意命令可能有副作用，绝不重放）')
    eq(r.ok, false, 'ok:false')
    eq(r.sandboxError.kind, 'killed', 'kind=killed')
  } finally { await m.shutdown() }
})

await test('可安全重建：acquire 阶段沙箱消失 → 重建一次后成功', async () => {
  const t = stubTransport({
    createError: (n) => (n === 1 ? Object.assign(new Error('sandbox not found'), { name: 'SandboxNotFoundError' }) : null),
    runImpl: () => makeHandle({ exitCode: 0, stdout: 'recovered' }),
  })
  const m = mkManager(t)
  try {
    const r = await runSandboxShell(m, 'k', 'echo hi', { timeout: 5 })
    eq(t.calls.create, 2, '重建恰好一次')
    eq(r.ok, true, '重建后成功')
    eq(r.stdout, 'recovered', '结果来自新沙箱')
  } finally { await m.shutdown() }
})

await test('模式判定 / 网络选项 / 会话键 / 命令数闸', async () => {
  eq(isSandboxEnabled({ mode: 'off', apiKey: 'x' }), false, 'mode=off 不启用')
  eq(isSandboxEnabled({ mode: 'e2b' }), false, '缺 apiKey 不启用（fail-closed）')
  eq(isSandboxEnabled({ mode: 'e2b', apiKey: 'k' }), true, 'mode=e2b + apiKey 启用')

  // 白名单模式：allowOut 透传 + denyOut 兜底全拒 + 必须 allowInternetAccess:true（否则 allow 被 deny 压掉）
  const wl = buildEgressOpts({ network: { allowOut: ['pypi.org'], denyOut: [] } })
  eq(wl.network.allowOut, ['pypi.org'], 'allowOut 透传')
  eq(wl.network.denyOut, ['0.0.0.0/0'], 'denyOut 空 → 默认拒绝全部')
  eq(wl.network.allowPublicTraffic, false, '默认沙箱公开 URL 也要 token')
  eq(wl.allowInternetAccess, true, '白名单模式放通互联网开关（可达范围由 allowOut 收窄）')
  // 关键回归：无白名单 + 默认（allowInternet 未开）→ 绝不下发空 allowOut，走 allowInternetAccess:false 全拒
  const def = buildEgressOpts({ network: {} })
  eq(def.network.allowOut, undefined, '无白名单不下发空 allowOut（避免被归一成“未指定=放行全部”）')
  eq(def.network.denyOut, ['0.0.0.0/0'], '无白名单显式 denyOut 全拒')
  eq(def.allowInternetAccess, false, '默认 allowInternetAccess:false（官方等价 deny 全部）')
  // 显式放开互联网（无白名单）→ 不下发 denyOut，allowInternetAccess:true
  const open = buildEgressOpts({ network: { allowInternet: true } })
  eq(open.network.denyOut, undefined, 'allowInternet:true 无白名单时不下发 denyOut')
  eq(open.allowInternetAccess, true, 'allowInternet:true → allowInternetAccess:true')
  // denyAll（候选验证）：无白名单 + 全拒
  const deny = buildEgressOpts({ network: { allowOut: ['pypi.org'] } }, { denyAll: true })
  eq(deny.network.allowOut, undefined, 'denyAll 时不下发白名单')
  eq(deny.network.denyOut, ['0.0.0.0/0'], 'denyAll 拒绝全部出口')
  eq(deny.allowInternetAccess, false, 'denyAll → allowInternetAccess:false')
  eq(buildNetworkOpts({ network: {} }).allowOut, undefined, 'buildNetworkOpts 兼容出口同样不下发空 allowOut')

  eq(sessionKeyOf({ groupId: 'g1', scopeUserId: 'u1', conversationId: 'c9' }), 'conv:g1:u1:c9', '会话键含群/用户/会话')
  eq(sessionKeyOf({ scopeUserId: 'u1' }), 'conv:private:u1:default', '私聊缺省值稳定')

  const c = makeCommandCounter(2)
  eq(c.hit('k'), false, '第 1 条不超限')
  eq(c.hit('k'), false, '第 2 条不超限')
  eq(c.hit('k'), true, '第 3 条超限')
  eq(c.get('k'), 3, '计数累计（超限也计，便于观测意图）')
  eq(c.hit('other'), false, '按会话独立计数')
  c.reset('k')
  eq(c.hit('k'), false, 'reset 后重新计数')
  eq(makeCommandCounter(0).hit('k'), false, 'limit=0 表示不限')
})

await test('createSandboxRuntime：未启用/初始化失败都不抛穿（由工具层 fail-closed）', async () => {
  const off = await createSandboxRuntime({ mode: 'off' })
  eq(off.enabled, false, 'mode=off → enabled=false')
  eq(off.manager, null, 'manager 为空（terminal 不注册）')

  const bad = await createSandboxRuntime({ mode: 'e2b', apiKey: 'k' }, {
    transport: { async init() { throw Object.assign(new Error('bad key'), { name: 'AuthenticationError', status: 401 }) } },
  })
  eq(bad.enabled, true, '启用但初始化失败')
  eq(bad.manager, null, 'manager 为空')
  ok(String(bad.error?.message || '').length > 0, '错误被记录（供日志/排障）')
  eq(classify(bad.error).kind, 'auth', '错误按 auth 分类')

  const stub = stubTransport()
  const okRt = await createSandboxRuntime({ mode: 'e2b', apiKey: 'k', maxCommandsPerSession: 3 }, { transport: stub })
  ok(!!okRt.manager, '注入桩 transport → manager 就绪')
  eq(await okRt.probe(), true, 'probe 走 transport.ping')
  eq(await okRt.shutdown(), 0, 'shutdown 可调用（无租约）')
})

// ============================================================
await test('防回退守卫：沙箱模块不得引入宿主子进程执行', async () => {
  const dir = path.dirname(new URL(import.meta.url).pathname)
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
  ok(files.length >= 4, `扫描到 ${files.length} 个沙箱模块`)
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    ok(!/child_process/.test(src), `${f} 不引用 child_process`)
    ok(!/\bspawn\s*\(/.test(src), `${f} 不出现 spawn(`)
    ok(!/execSync/.test(src), `${f} 不出现 execSync`)
  }
  // 唯一允许接触 e2b SDK 的文件是 transport.js
  const others = files.filter((f) => f !== 'transport.js' && !f.endsWith('.test.mjs'))
  for (const f of others) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    ok(!/from 'e2b'|require\('e2b'\)|import\('e2b'\)/.test(src), `${f} 不直接 import e2b（只在 transport.js）`)
  }
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
process.exit(process.exitCode || 0)
