/**
 * 终端能力离线自检 —— runShell（echo/node/超时/截断/退出码）+ terminal 工具（主人/黑名单/审批门）。
 * 运行：node model/terminal/test.mjs
 *
 * 现在直接在主机执行（无 docker）；CI/本机均跑。纯逻辑测试（黑名单/matchesAny）照常。
 */
import { runShell, makeTerminalTool, DEFAULT_BLOCKLIST, matchesAny } from './index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

// 主机执行探测：runShell 现在直接在主机跑；找不到 shell 才 skip（极少见）。
const HOST_OK = await (async () => { try { const r = await runShell('echo ok'); return !!(r?.ok && r.stdout?.includes('ok')) } catch { return false } })()
if (!HOST_OK) console.log('⊘ 主机 shell 不可用：跳过 runShell 相关测试')
const skipShell = () => { if (!HOST_OK) { console.log('  ⊘ skip（无 shell）'); return true } return false }

// ---------- 1. runShell：正常命令 ----------
await test('runShell：echo / node 正常执行', async () => {
  if (skipShell()) return
  const r = await runShell('echo hello')
  ok(r.ok && r.exitCode === 0, 'exitCode=0')
  ok(r.stdout.includes('hello'), 'stdout 含 hello')
  ok(typeof r.duration === 'number', '有 duration')
  const r2 = await runShell('node -e "process.stdout.write(String(6*7))"')
  ok(r2.stdout.includes('42'), 'node 计算 42')
})

// ---------- 2. runShell：非零退出码 ----------
await test('runShell：非零退出码不抛错，返回 exitCode', async () => {
  if (skipShell()) return
  const r = await runShell('node -e "process.exit(3)"')
  ok(!r.ok, 'ok=false')
  ok(r.exitCode === 3, 'exitCode=3')
  ok(r.timedOut !== true, '非超时')
})

// ---------- 3. runShell：超时 ----------
await test('runShell：超时返回 timedOut', async () => {
  if (skipShell()) return
  const r = await runShell('node -e "setTimeout(()=>{},5000)"', { timeout: 1 })
  ok(!r.ok, 'ok=false')
  ok(r.timedOut === true, 'timedOut=true')
})

// ---------- 4. runShell：输出截断 ----------
await test('runShell：超长输出截断', async () => {
  if (skipShell()) return
  const r = await runShell('node -e "process.stdout.write(\'x\'.repeat(5000))"', { maxOutput: 100 })
  ok(r.stdout.length < 200, 'stdout 被截断')
  ok(r.stdout.includes('已截断'), '含截断提示')
})

// ---------- 5. runShell：stderr 捕获 ----------
await test('runShell：stderr 捕获', async () => {
  if (skipShell()) return
  const r = await runShell('node -e "process.stderr.write(\'errmark\')"')
  ok(r.stderr.includes('errmark'), 'stderr 含 errmark')
})

// ---------- 6. terminal 工具：非主人拒绝（不触发审批） ----------
await test('terminal 工具：非主人直接拒（不触发审批）', async () => {
  let approveCalled = false
  const t = makeTerminalTool({ isMasterFn: () => false })
  const r = await t.execute({ command: 'echo hi' }, { userId: '999', terminal: { approve: async () => { approveCalled = true; return true } } })
  ok(r.error && r.error.includes('主人'), '非主人被拒')
  ok(!approveCalled, '未触发审批（非主人提前返回）')
})

// ---------- 7. terminal 工具：黑名单拦截（即使主人 + 已审批）----------
await test('terminal 工具：黑名单拦截 rm -rf /（在审批之前）', async () => {
  let approveCalled = false
  const t = makeTerminalTool({ isMasterFn: () => true })
  const r = await t.execute({ command: 'rm -rf / --no-preserve-root' }, { userId: '1', terminal: { approve: async () => { approveCalled = true; return true } } })
  ok(r.error && r.error.includes('安全策略'), '灾难命令被拦')
  ok(!approveCalled, '黑名单在审批之前（未触发审批）')
  const r2 = await t.execute({ command: 'mkfs.ext4 /dev/sda1' }, { userId: '1', terminal: { approve: async () => true } })
  ok(r2.error && r2.error.includes('安全策略'), 'mkfs 被拦')
})

// ---------- 8. terminal 工具：主人 + 审批通过 + 安全命令 → 执行 ----------
await test('terminal 工具：主人 + 审批通过执行', async () => {
  if (skipShell()) return
  const t = makeTerminalTool({ isMasterFn: () => true })
  const r = await t.execute({ command: 'echo approved' }, { userId: '1', terminal: { approve: async () => true } })
  ok(r.ok !== false && r.stdout?.includes('approved'), '主人审批通过后执行成功')
  ok(r.command === 'echo approved', '回显命令')
})

// ---------- 9. terminal 工具：审批被拒 → 不执行 ----------
await test('terminal 工具：主人但审批被拒 → 不执行', async () => {
  const t = makeTerminalTool({ isMasterFn: () => true })
  const r = await t.execute({ command: 'echo nope' }, { userId: '1', terminal: { approve: async () => false } })
  ok(r.error && r.error.includes('未获主人批准'), '审批被拒返回错误')
  ok(r.stdout === undefined, '未执行 shell（无 stdout）')
})

// ---------- 10. terminal 工具：自定义 blocklist ----------
await test('terminal 工具：自定义 blocklist 生效', async () => {
  const t = makeTerminalTool({ isMasterFn: () => true })
  const r = await t.execute({ command: 'forbidden-cmd run' }, { userId: '1', terminal: { blocklist: ['forbidden-cmd'], approve: async () => true } })
  ok(r.error && r.error.includes('安全策略'), '自定义黑名单拦截')
})

// ---------- 11. DEFAULT_BLOCKLIST 含关键灾难模式 ----------
await test('DEFAULT_BLOCKLIST：覆盖灾难模式', async () => {
  const joined = DEFAULT_BLOCKLIST.join('|')
  ok(joined.includes('rm'), '含 rm')
  ok(joined.includes('mkfs'), '含 mkfs')
  ok(joined.includes('shutdown'), '含 shutdown')
  ok(matchesAny('rm -rf /', DEFAULT_BLOCKLIST), 'rm -rf / 命中')
  ok(matchesAny('dd if=/dev/zero of=/dev/sda', DEFAULT_BLOCKLIST), 'dd 写设备命中')
  ok(!matchesAny('ls -la', DEFAULT_BLOCKLIST), 'ls 不命中黑名单')
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
