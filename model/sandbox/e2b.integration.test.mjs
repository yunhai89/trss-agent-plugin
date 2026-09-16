/**
 * E2B 真连接集成测试（默认 SKIPPED，与 kroki.integration.test.mjs 同模式）。
 *
 * 运行：
 *   E2B_INTEGRATION=1 E2B_API_KEY=e2b_xxx node model/sandbox/e2b.integration.test.mjs
 *   自托管再加 E2B_API_URL / E2B_DOMAIN / E2B_SANDBOX_URL（见 sdk.env）
 *
 * 纪律（绝不宣称未运行的测试通过）：
 *   - 未设 E2B_INTEGRATION=1 → 打印 SKIPPED + `通过 0，失败 0` + exit 0（CI 不因此失败）
 *   - 设了但端点不可达/鉴权失败（3s 预检）→ 同样 SKIPPED + exit 0
 *   - 环境缺失 ≠ 代码失败；本文件只做「真连接行为」核对，纯逻辑断言在 manager/errors/terminal 测试里
 */
const ENABLED = process.env.E2B_INTEGRATION === '1'
if (!ENABLED) {
  console.log('SKIPPED：未设置 E2B_INTEGRATION=1（真连接测试默认不跑）')
  console.log('通过 0，失败 0')
  process.exit(0)
}

const { makeTransport } = await import('./transport.js')
const { SandboxManager } = await import('./manager.js')
const { createSandboxRuntime } = await import('./index.js')

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `  (got ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`)

const cfg = {
  mode: 'e2b',
  apiKey: process.env.E2B_API_KEY || '',
  apiUrl: process.env.E2B_API_URL || '',
  domain: process.env.E2B_DOMAIN || '',
  sandboxUrl: process.env.E2B_SANDBOX_URL || '',
  template: process.env.E2B_TEMPLATE || 'base',
  maxSandboxes: 2,
  idleMs: 120000,
  sandboxTtlMs: 300000,
  concurrencyWaitMs: 30000,
  audit: false,
  network: { allowInternet: false, denyOut: ['0.0.0.0/0'], allowOut: ['pypi.org'] },
}

// ── 可达性/鉴权预检：失败即 SKIPPED（环境问题不是代码失败）──
if (!cfg.apiKey) {
  console.log('SKIPPED：未设置 E2B_API_KEY')
  console.log('通过 0，失败 0')
  process.exit(0)
}
const probeTransport = makeTransport(cfg, { logger: null })
try {
  await probeTransport.init()
  await probeTransport.ping(3000)
} catch (e) {
  console.log(`SKIPPED：E2B 不可达或鉴权失败（${e?.message || e}）`)
  console.log('通过 0，失败 0')
  process.exit(0)
}
console.log('[E2B 真连接可用，开始集成断言]\n')

const { runSandboxShell } = await import('./index.js')
const rt = await createSandboxRuntime(cfg, { transport: probeTransport })
if (!rt.manager) {
  console.error(`✗ FAIL 沙箱运行时装配失败：${rt.error?.message}`)
  console.log('\n通过 0，失败 1')
  process.exit(1)
}
const box = rt.manager
const KEY = `integration:${Date.now()}`

try {
  console.log('[1. 基本执行与退出码]')
  const r1 = await runSandboxShell(box, KEY, 'echo hello && uname -s', { timeout: 30 })
  eq(r1.ok, true, 'echo 成功')
  ok(String(r1.stdout).includes('hello'), 'stdout 含 hello')
  ok(!!r1.sandboxId, '返回 sandboxId')

  const r2 = await runSandboxShell(box, KEY, 'exit 3', { timeout: 30 })
  eq(r2.ok, false, '非零退出 → ok:false')
  eq(r2.exitCode, 3, 'exitCode=3（业务语义）')
  eq(r2.sandboxError, undefined, '非零退出不带 sandboxError（不是基础设施故障）')

  console.log('\n[2. 会话内状态连续（同 key 复用沙箱）]')
  await runSandboxShell(box, KEY, 'echo persisted > /home/user/state.txt', { timeout: 30 })
  const r3 = await runSandboxShell(box, KEY, 'cat /home/user/state.txt', { timeout: 30 })
  ok(String(r3.stdout).includes('persisted'), '同会话文件系统连续（多步任务可先写后用）')
  eq(box.stats().leases, 1, '同 key 只占一个沙箱')

  console.log('\n[3. 超时终止]')
  const r4 = await runSandboxShell(box, KEY, 'sleep 30', { timeout: 1, maxTimeout: 1 })
  eq(r4.timedOut, true, '超时标记 timedOut')
  eq(r4.exitCode, null, '超时 exitCode=null')
  eq(r4.signal, 'SIGKILL', 'signal=SIGKILL')

  console.log('\n[4. 取消传播]')
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 300)
  const r5 = await runSandboxShell(box, KEY, 'sleep 30', { timeout: 30, signal: ac.signal })
  eq(r5.aborted, true, 'abort → aborted=true')
  ok(r5.duration < 10000, `abort 后快速结算（${r5.duration}ms）`)

  console.log('\n[5. 网络出口白名单]')
  const r6 = await runSandboxShell(box, KEY, 'curl -sS -m 10 -o /dev/null -w "%{http_code}" https://pypi.org/ || echo FAILED', { timeout: 30 })
  ok(!/FAILED/.test(String(r6.stdout)) || /200|301|302|403/.test(String(r6.stdout)), `白名单域名 pypi.org 可达（${String(r6.stdout).trim().slice(0, 20)}）`)
  const r7 = await runSandboxShell(box, KEY, 'curl -sS -m 10 https://example.com/ >/dev/null 2>&1 && echo OPEN || echo BLOCKED', { timeout: 30 })
  ok(String(r7.stdout).includes('BLOCKED'), '未在白名单的域名被拒绝（可选断言：自托管网络拓扑异常时可能抖动）')

  console.log('\n[6. 销毁与 fail-closed]')
  const n = await box.destroy(KEY)
  ok(n === true, '显式销毁成功')
  eq(box.stats().leases, 0, '租约清空')
} finally {
  try { await rt.shutdown() } catch { /* noop */ }
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
process.exit(failed ? 1 : 0)
