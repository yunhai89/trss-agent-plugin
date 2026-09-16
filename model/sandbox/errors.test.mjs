/**
 * 沙箱失败分类回归（离线，无需 e2b / 联网）。
 * 运行：node model/sandbox/errors.test.mjs
 *
 * 契约（对应实现计划 §4）：
 *   - 每类基础设施故障映射到稳定 kind，且可重试类只有 unreachable/quota
 *   - **业务退出码不是基础设施故障**（CommandExitError → classify 返回 null），
 *     否则会把"命令失败"误报成"沙箱坏了"，并把 ok:false 的工具结果污染成 infra error
 *   - 结构化失败不变式：ok===false && exitCode===null && sandboxError.kind 存在
 */
import { SandboxError, classify, isExitError, isSandboxInfra, toToolFailure, truncateOutput, FAIL_KINDS } from './errors.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`)
}
function test(name, fn) {
  console.log(`\n[${name}]`)
  try { fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) }
}
const err = (fields) => Object.assign(new Error(fields.message || 'boom'), fields)

test('基础设施故障分类', () => {
  eq(classify(err({ name: 'AuthenticationError', status: 401 }))?.kind, 'auth', 'AuthenticationError → auth')
  eq(classify(err({ status: 403 }))?.kind, 'auth', '403 → auth')
  eq(classify(err({ name: 'RateLimitError', status: 429 }))?.kind, 'quota', 'RateLimitError/429 → quota')
  eq(classify(err({ name: 'ServiceBusyError' }))?.kind, 'quota', 'ServiceBusyError → quota')
  eq(classify(err({ name: 'RateLimitError', status: 429 }))?.retryable, true, 'quota 可重试')
  eq(classify(err({ name: 'TemplateError', message: 'You need to update the template' }))?.kind, 'template_missing', 'TemplateError → template_missing')
  eq(classify(err({ name: 'TimeoutError' }))?.kind, 'timeout', 'TimeoutError → timeout')
  eq(classify(err({ name: 'AbortError' }))?.kind, 'killed', 'AbortError → killed')
  eq(classify(err({ name: 'SandboxNotFoundError' }))?.kind, 'killed', 'SandboxNotFoundError → killed')
  eq(classify(err({ code: 'ENOTFOUND' }))?.kind, 'unreachable', 'ENOTFOUND → unreachable')
  eq(classify(err({ message: 'fetch failed' }))?.kind, 'unreachable', 'fetch failed → unreachable')
  eq(classify(err({ code: 'ENOTFOUND' }))?.retryable, true, 'unreachable 可重试')
  eq(classify(err({ message: 'something odd' }))?.kind, 'unknown', '认不出的错误 → unknown')
  ok(FAIL_KINDS.includes('unconfigured'), 'unconfigured 属于失败分类全集')
})

test('业务退出码不是基础设施故障（不得污染失败分类）', () => {
  const exitErr = err({ name: 'CommandExitError', exitCode: 3, stdout: 'out', stderr: 'bad' })
  ok(isExitError(exitErr), 'isExitError 识别 CommandExitError')
  eq(classify(exitErr), null, 'CommandExitError → classify 返回 null（业务语义）')
  ok(!isSandboxInfra(exitErr), 'isSandboxInfra(CommandExitError) === false')
  // 跨版本稳健：丢掉 name 只留 CommandResult 三字段形态也要认出
  const shaped = err({ exitCode: 0, stdout: '', stderr: '' })
  ok(isExitError(shaped), '按 CommandResult 形态识别（不依赖 name）')
  eq(classify(shaped), null, '形态识别同样判为业务语义')
  ok(isSandboxInfra(err({ code: 'ECONNREFUSED' })), '真实基础设施故障仍判 true')
})

test('SandboxError 自身透传（kind 与文案不丢）', () => {
  const e = new SandboxError('quota', '本会话命令数已达上限（50）')
  const info = classify(e)
  eq(info.kind, 'quota', 'kind 透传')
  eq(info.retryable, true, 'quota 默认可重试')
  eq(classify(e).detail, '本会话命令数已达上限（50）', '文案透传为 detail')
  const e2 = new SandboxError('template_missing')
  ok(String(e2.message).length > 0, '未给文案时用 KIND 默认文案')
  eq(classify(e2).retryable, false, 'template_missing 不可重试')
  const e3 = new SandboxError('不存在的kind')
  eq(e3.kind, 'unknown', '未知 kind 归一到 unknown')
})

test('结构化失败不变式（不冒充成功）', () => {
  const r = toToolFailure(new SandboxError('unreachable', 'E2B 沙箱服务不可达'), { maxOutput: 8000, duration: 12 })
  eq(r.ok, false, 'ok=false')
  eq(r.exitCode, null, 'exitCode=null（不冒充"命令跑了但失败"）')
  eq(r.stdout, '', 'stdout 空')
  ok(String(r.stderr).includes('不可达'), 'stderr 带可读原因')
  eq(r.sandboxError.kind, 'unreachable', 'sandboxError.kind 存在')
  eq(r.duration, 12, 'duration 透传')
  const r2 = toToolFailure(err({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }), { duration: 3 })
  eq(r2.sandboxError.kind, 'unreachable', '非 SandboxError 也归类')
  ok(String(r2.stderr).includes('不可达'), '用 KIND 文案而非原始网络栈')
  // 不变式对每个 kind 都成立
  for (const k of FAIL_KINDS) {
    const x = toToolFailure(new SandboxError(k), {})
    ok(x.ok === false && x.exitCode === null && x.sandboxError.kind === k, `kind=${k} 保持不变式`)
  }
})

test('输出截断沿用宿主实现的可见文案', () => {
  eq(truncateOutput('abc', 10), 'abc', '未超限原样返回')
  const t = truncateOutput('x'.repeat(50), 10)
  ok(t.startsWith('x'.repeat(10)), '截断到上限')
  ok(t.includes('…[已截断，共 50 字符]'), '保留旧文案（替换执行面不改变用户可见行为）')
  eq(truncateOutput(null, 10), '', 'null 安全')
  eq(truncateOutput('abcdef', 0), 'abcdef', '非法上限回落默认值')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
