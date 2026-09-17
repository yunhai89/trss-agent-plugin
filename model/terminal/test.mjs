/**
 * 终端能力离线自检（沙箱执行面；桩 transport，无需 e2b / 联网 / 宿主进程）。
 * 运行：node model/terminal/test.mjs
 *
 * 行为语义变更（有意，不是放松测试）：
 *   - 旧宿主执行断言（echo/node/超时/pgrep 子进程）随宿主 spawn 路径一并删除
 *   - 旧「黑名单拦截 / 自定义 blocklist / 审批拒 / 审批通过」四个断言删除：
 *     沙箱化后无审批、无黑名单 —— 这里反向固化为「灾难命令会到达沙箱传输层」，
 *     防止哪天有人把宿主黑名单逻辑又加回来造成"以为安全其实没隔离"
 *   - 旧「terminal 主人验证码认领」访问门删除：产品决策为**全员可用**，
 *     隔离与成本由 E2B microVM + 单会话命令数/并发/超时上限承担（不再有身份校验）。
 */
import { makeTerminalTool } from './index.js'
import { runSandboxShell } from '../sandbox/index.js'
import { SandboxManager } from '../sandbox/manager.js'
import { classify } from '../sandbox/errors.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

// ---------- 桩 transport（与 transport.js 同形状）----------
function makeHandle({ exitCode = 0, stdout = '', stderr = '', waitError = null, hang = false } = {}) {
  return { async wait() { if (hang) return new Promise(() => {}); if (waitError) throw waitError; return { exitCode, stdout, stderr } }, async kill() { return true } }
}
function stubTransport({ runImpl = null } = {}) {
  const calls = { create: 0, run: 0, cmds: [] }
  let seq = 0
  return {
    calls,
    async init() { return this },
    async ping() { return true },
    async create() { calls.create++; return { id: `sbx-${++seq}`, raw: {} } },
    async connect() { return { id: 'c', raw: {} } },
    async run(h, cmd, opts) { calls.run++; calls.cmds.push(cmd); return runImpl ? runImpl(h, cmd, opts) : makeHandle({ exitCode: 0, stdout: 'ok' }) },
    async write() {}, async writeMany() {},
    async kill() { return true }, async setTimeout() {}, async list() { return [] }, async updateNetwork() {},
  }
}
const mkBox = (t, over = {}) => new SandboxManager({ transport: t, idleMs: 60000, sandboxTtlMs: 600000, sweepIntervalMs: 100000, ...over })

// ---------- 1. 全员可用：任意用户都能执行（无身份门槛）----------
await test('terminal：任意用户可执行（不再校验主人）', async () => {
  const t = stubTransport()
  const box = mkBox(t)
  try {
    const tool = makeTerminalTool({ manager: box })
    const r = await tool.execute({ command: 'echo hi' }, { userId: '999', sandbox: { audit: false, manager: box, sessionKey: 'k-any' } })
    ok(!r.error, '普通用户不被拒')
    eq(r.ok, true, '命令执行（沙箱返回 0）')
    eq(t.calls.create, 1, '创建沙箱')
    eq(t.calls.run, 1, '执行命令')
  } finally { await box.shutdown() }
})

// ---------- 2. 沙箱执行：契约字段 ----------
await test('terminal：执行 → 走沙箱并回显契约字段', async () => {
  const t = stubTransport({ runImpl: () => makeHandle({ exitCode: 0, stdout: 'approved' }) })
  const box = mkBox(t)
  try {
    const tool = makeTerminalTool({ manager: box })
    const r = await tool.execute({ command: 'echo approved' }, { userId: '1', sandbox: { audit: false } })
    eq(r.command, 'echo approved', '回显命令')
    eq(r.ok, true, 'ok:true')
    eq(r.exitCode, 0, 'exitCode=0')
    eq(r.stdout, 'approved', 'stdout 透传')
    eq(t.calls.run, 1, '命令送达沙箱传输层')
    ok(!!r.sandboxId, '返回 sandboxId（排障用，不含 token）')
  } finally { await box.shutdown() }
})

// ---------- 3. 无审批、无黑名单（行为变更固化）----------
await test('terminal：审批与黑名单已移除（灾难命令直达沙箱）', async () => {
  const t = stubTransport()
  const box = mkBox(t)
  try {
    const tool = makeTerminalTool({ manager: box })
    // 旧实现在这里有 #确认 审批；现在 approve 就算抛错也不应被调用
    const r = await tool.execute({ command: 'rm -rf / --no-preserve-root' }, {
      userId: '1',
      sandbox: { audit: false, approve: async () => { throw new Error('approve 不应被调用') } },
    })
    ok(!r.error, '不再有"未获主人批准"这类拦截')
    eq(t.calls.cmds, ['rm -rf / --no-preserve-root'], '灾难命令直接送达沙箱（隔离由 microVM 承担，不由字符串黑名单承担）')
    eq(r.ok, true, '命令执行（沙箱返回 0）')
  } finally { await box.shutdown() }
})

// ---------- 4. 沙箱不可用 → fail-closed ----------
await test('terminal：沙箱不可用时拒绝执行（不在本机跑）', async () => {
  const tool = makeTerminalTool({ manager: null })
  const r = await tool.execute({ command: 'echo hi' }, { userId: '1', sandbox: { manager: null } })
  ok(r.error && r.error.includes('沙箱不可用'), '返回失败而非执行')
  eq(r.stdout, undefined, '没有 stdout（没有本地执行兜底）')
})

// ---------- 5. 成本闸：单会话命令数上限 ----------
await test('terminal：单会话命令数超限 → 拒绝并提示', async () => {
  const t = stubTransport()
  const box = mkBox(t)
  try {
    const tool = makeTerminalTool({ manager: box })
    const ctx = { userId: '1', sandbox: { audit: false, manager: box, sessionKey: 'k', maxCommandsPerSession: 2 } }
    const { makeCommandCounter } = await import('../sandbox/index.js')
    ctx.sandbox.commands = makeCommandCounter(2)
    await tool.execute({ command: 'echo 1' }, ctx)
    await tool.execute({ command: 'echo 2' }, ctx)
    const r3 = await tool.execute({ command: 'echo 3' }, ctx)
    ok(r3.error && r3.error.includes('上限'), '第 3 条被成本闸拦下')
    eq(t.calls.run, 2, '只跑了 2 条')
  } finally { await box.shutdown() }
})

// ---------- 6. 空命令 ----------
await test('terminal：空命令直接拒', async () => {
  const t = stubTransport()
  const box = mkBox(t)
  try {
    const tool = makeTerminalTool({ manager: box })
    const r = await tool.execute({ command: '   ' }, { userId: '1', sandbox: { manager: box } })
    eq(r.error, '空命令', '空命令报错')
    eq(t.calls.run, 0, '未送达沙箱')
  } finally { await box.shutdown() }
})

// ---------- 7. 执行面 fail-closed（沙箱层）----------
await test('runShell：基础设施故障 → 结构化失败且不冒充成功', async () => {
  const t = stubTransport({ runImpl: () => { throw Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }) } })
  const box = mkBox(t)
  try {
    const r = await runSandboxShell(box, 'k', 'echo hi', {})
    eq(r.ok, false, 'ok:false')
    eq(r.exitCode, null, 'exitCode=null')
    eq(r.sandboxError.kind, 'unreachable', 'kind=unreachable')
    ok(String(r.stderr).includes('不可达'), 'stderr 给可读原因（不是原始网络栈）')
  } finally { await box.shutdown() }
})

// ---------- 8. 业务退出码不当作基础设施故障 ----------
await test('runShell：命令非零退出 → 业务语义（无 sandboxError）', async () => {
  const t = stubTransport({ runImpl: () => makeHandle({ exitCode: 3, stdout: 'partial', stderr: 'failed' }) })
  const box = mkBox(t)
  try {
    const r = await runSandboxShell(box, 'k', 'exit 3', {})
    eq(r.ok, false, 'ok:false')
    eq(r.exitCode, 3, 'exitCode=3')
    eq(r.sandboxError, undefined, '不带 sandboxError（不是基础设施故障）')
    eq(r.stdout, 'partial', 'stdout 保留')
  } finally { await box.shutdown() }
})

// ---------- 9. 沙箱会话绑定（同会话连续）----------
await test('runShell：同会话复用同一沙箱（文件/进程状态连续）', async () => {
  const t = stubTransport({ runImpl: () => makeHandle({ exitCode: 0, stdout: 'ok' }) })
  const box = mkBox(t)
  try {
    await runSandboxShell(box, 'conv:g:u:c', 'echo a', {})
    await runSandboxShell(box, 'conv:g:u:c', 'echo b', {})
    eq(t.calls.create, 1, '同一会话键只创建一次沙箱')
    eq(t.calls.run, 2, '两条命令都在同一沙箱执行')
    await runSandboxShell(box, 'conv:g:u:other', 'echo c', {})
    eq(t.calls.create, 2, '不同会话才新建')
  } finally { await box.shutdown() }
})

// ---------- 10. abort 语义（不再依赖宿主进程组）----------
await test('runShell：abort 立即结算并杀命令（桩句柄，无宿主子进程）', async () => {
  const t = stubTransport({ runImpl: () => makeHandle({ hang: true }) })
  const box = mkBox(t)
  try {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 20)
    const t0 = Date.now()
    const r = await runSandboxShell(box, 'k', 'sleep 100', { timeout: 30, signal: ac.signal })
    eq(r.aborted, true, 'aborted=true')
    eq(r.exitCode, null, 'exitCode=null')
    eq(r.signal, 'SIGKILL', 'signal=SIGKILL（与旧契约同名）')
    ok(Date.now() - t0 < 1000, `快速结算（${Date.now() - t0}ms）`)
  } finally { await box.shutdown() }
})

// ---------- 11. 语义常量/身份门不再导出（避免误解为仍有黑名单或主人门）----------
await test('导出面：不再暴露黑名单/审批/主人认领 API', async () => {
  const mod = await import('./index.js')
  eq(mod.DEFAULT_BLOCKLIST, undefined, 'DEFAULT_BLOCKLIST 已移除')
  eq(mod.matchesAny, undefined, 'matchesAny 已移除')
  eq(mod.requestTerminalApproval, undefined, 'requestTerminalApproval 已移除')
  eq(mod.resolveApproval, undefined, 'resolveApproval 已移除')
  eq(mod.listApprovals, undefined, 'listApprovals 已移除')
  eq(mod.isMaster, undefined, 'isMaster 已移除（全员可用，无身份门槛）')
  eq(mod.requestClaim, undefined, 'requestClaim 已移除（不再需要认领）')
  ok(typeof mod.makeTerminalTool === 'function', 'makeTerminalTool 保留')
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
