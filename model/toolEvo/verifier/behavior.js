/**
 * 行为验证（阶段2，文档 §16）：对候选跑 tests + 断言 + 性能/确定性门。
 *
 * Oracle 优先级（文档 §16.1）：程序断言（expected 深比）> 默认。禁同模型自证（生成 ≠ 裁判）。
 * 一个候选通过 AST 静态门 ≠ 正确；行为验证用真实输入跑 + 断言输出。
 *
 * 执行后端：默认本地子进程；传入 createSession 时用沙箱（一个候选一个会话，多个用例复用同一沙箱，
 * 避免每个用例重复上传/冷启动）。
 *
 * @returns { passed, results[], evidence:{totalTests, passed, avgMs, timedOut, backend} }
 */
import { createLocalCandidateSession } from '../sandbox.js'

/** 深比（JSON 规范化后字符串比；候选输出与 expected 须结构一致） */
function deepEqual(a, b) {
  try { return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b)) }
  catch { return false }
}
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize)
  if (v && typeof v === 'object') {
    const o = {}; for (const k of Object.keys(v).sort()) o[k] = normalize(v[k]); return o
  }
  return v
}

/**
 * @param {object} p { source, tests:[{name?,input,expected?}], timeoutMs?, perfMs?（单测耗时上限）, createSession? }
 */
export async function verifyBehavior({ source, tests, timeoutMs = 3000, perfMs = 5000, createSession = null }) {
  const results = []
  let timedOutCount = 0
  let backend = 'local'
  const list = tests || []
  if (!list.length) {
    return { passed: false, results, evidence: { totalTests: 0, passed: 0, avgMs: 0, timedOut: 0, backend } }
  }
  const factory = createSession || createLocalCandidateSession
  // 一个候选一个会话：N 个用例复用同一沙箱/同一 bundle 目录
  let session = null
  try {
    session = await factory({ source, timeoutMs })
    backend = session.backend || (createSession ? 'sandbox' : 'local')
    for (const t of list) {
      const r = await session.run({ input: t.input, timeoutMs })
      let passed = false, reason = ''
      if (r.timedOut) { timedOutCount++; reason = `超时(>${timeoutMs}ms)` }
      else if (!r.ok) { reason = `执行失败：${r.error || ''}${r.errorClass ? '(' + r.errorClass + ')' : ''}` }
      else if (t.expected !== undefined) {
        passed = deepEqual(r.output, t.expected)
        if (!passed) reason = `输出 ${JSON.stringify(r.output).slice(0, 80)} ≠ 期望 ${JSON.stringify(t.expected).slice(0, 80)}`
      } else {
        // 无 expected（属性测试占位，第一版视为通过 if ok）
        passed = true
      }
      // 性能门
      if (passed && r.duration > perfMs) { passed = false; reason = `性能超限：${r.duration}ms > ${perfMs}ms` }
      results.push({ name: t.name || JSON.stringify(t.input).slice(0, 40), passed, reason, duration: r.duration })
    }
  } catch (e) {
    // 会话建立失败（沙箱不可达等）：整组用例判失败并留原因，不静默通过
    for (const t of list) results.push({ name: t.name || JSON.stringify(t.input).slice(0, 40), passed: false, reason: `执行环境不可用：${e?.message || e}`, duration: 0 })
  } finally {
    try { await session?.close?.() } catch { /* noop */ }
  }
  const passedCount = results.filter((r) => r.passed).length
  return {
    passed: results.length > 0 && passedCount === results.length,
    results,
    evidence: {
      totalTests: results.length,
      passed: passedCount,
      avgMs: results.length ? Math.round(results.reduce((s, r) => s + (r.duration || 0), 0) / results.length) : 0,
      timedOut: timedOutCount,
      backend,
    },
  }
}

export default { verifyBehavior, deepEqual }
