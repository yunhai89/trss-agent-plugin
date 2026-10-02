/**
 * 适应度评估 + 失败聚类 + 收敛指标（阶段4，文档 §18/§22）。
 *
 * Fitness = 成功率为主 + 测试通过率 - 延迟惩罚；**安全硬否决**（越权/外泄一票否决，fitness=0）。
 * failureClusters：聚合 tool_invocations 找高失败率 stable 工具（触发修复）。
 * convergenceMetrics：生成率/复用率/失败率/库紧凑度（收敛判断，§22.2）。
 */
import { dao } from './db.js'

/**
 * 算某 versionId 的适应度（从 tool_invocations + behavior evidence）。
 * @returns { fitness, successRate, invocations, avgMs, risk, verdict, reasons[] }
 */
export async function evaluateVersion(versionId, { evidence } = {}) {
  const rows = await dao.all('SELECT success, latency_ms, error_class FROM tool_invocations WHERE version_id=?', [versionId])
  const total = rows.length
  const succ = rows.filter((r) => r.success).length
  const successRate = total ? succ / total : 0
  const avgMs = total ? Math.round(rows.reduce((s, r) => s + (r.latency_ms || 0), 0) / total) : 0
  const reasons = []
  // 安全硬否决：error_class 越权/外泄类
  const dangerErrors = rows.filter((r) => /越权|外泄|forbidden|leak|unauthorized/i.test(r.error_class || ''))
  const risk = dangerErrors.length
  if (risk > 0) reasons.push(`安全告警：${risk} 次越权/外泄类错误（一票否决）`)
  // 适应度：成功率 60% + 测试通过率 40% - 延迟惩罚
  let fitness = successRate * 60
  if (evidence) {
    const testRate = evidence.totalTests ? evidence.passed / evidence.totalTests : 1
    fitness += testRate * 40
  } else {
    fitness += 40
  }
  if (avgMs > 3000) { fitness -= Math.min(20, (avgMs - 3000) / 200); reasons.push(`延迟偏高 ${avgMs}ms`) }
  if (risk > 0) fitness = 0 // 安全一票否决
  const verdict = fitness >= 70 ? 'healthy' : fitness >= 40 ? 'watch' : 'unhealthy'
  if (total && successRate < 0.5) reasons.push(`成功率低 ${(successRate * 100).toFixed(0)}%`)
  return { fitness: Math.max(0, Math.round(fitness)), successRate, invocations: total, avgMs, risk, verdict, reasons }
}

/**
 * 失败聚类：找高失败率的 stable 工具（修复候选）。
 * @returns [{ versionId, toolName, total, failed, failRate, topErrors }]
 */
export async function failureClusters({ minInvocations = 3, minFailRate = 0.3 } = {}) {
  const rows = await dao.all(`
    SELECT tv.id AS version_id, t.name AS tool_name, ti.success, ti.error_class
    FROM tool_invocations ti
    LEFT JOIN tool_versions tv ON tv.id = ti.version_id
    LEFT JOIN tools t ON t.id = tv.tool_id
    WHERE ti.version_id IS NOT NULL
  `)
  const byVer = {}
  for (const r of rows) {
    const k = r.version_id
    if (!byVer[k]) byVer[k] = { versionId: k, toolName: r.tool_name, total: 0, failed: 0, errors: {} }
    byVer[k].total++
    if (!r.success) {
      byVer[k].failed++
      const ec = r.error_class || 'unknown'
      byVer[k].errors[ec] = (byVer[k].errors[ec] || 0) + 1
    }
  }
  return Object.values(byVer)
    .filter((v) => v.total >= minInvocations && v.failed / v.total >= minFailRate)
    .map((v) => ({ ...v, failRate: v.failed / v.total, topErrors: Object.entries(v.errors).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}×${n}`) }))
    .sort((a, b) => b.failRate - a.failRate)
}

/**
 * 收敛指标（文档 §22）。各指标分母/含义明确：
 *   - activeStable：当前真正在线的 stable 版本数（tools.active_version_id）；
 *   - reuseRate = 被真实调用过的 stable 版本数 / stable 版本总数（用实际调用证明复用，而非 stable 占比）；
 *   - libraryCompactness = stable / 总版本数（库中已上线版本占比，衡量版本收敛）；
 *   - verifyPassRate = (stable+verified) / 总版本数（验证通过占比）；
 *   - invocationFailRate = 失败调用 / 总调用。
 */
export async function convergenceMetrics() {
  const count = async (where) => ((await dao.get(`SELECT COUNT(*) AS n FROM tool_versions${where ? ' WHERE ' + where : ''}`))?.n || 0)
  const totalVersions = await count('')
  const stable = await count("status='stable'")
  const verified = await count("status='verified'")
  const rejected = await count("status='rejected'")
  const deprecated = await count("status='deprecated'")
  const activeStable = (await dao.get(`SELECT COUNT(*) AS n FROM tools WHERE active_version_id IS NOT NULL`))?.n || 0
  const invokedStable = (await dao.get(
    `SELECT COUNT(DISTINCT tv.id) AS n FROM tool_versions tv JOIN tool_invocations ti ON ti.version_id=tv.id WHERE tv.status='stable'`,
  ))?.n || 0
  const invocations = (await dao.get('SELECT COUNT(*) AS n FROM tool_invocations'))?.n || 0
  const failedInv = (await dao.get('SELECT COUNT(*) AS n FROM tool_invocations WHERE success=0'))?.n || 0
  return {
    totalVersions, stable, activeStable, verified, rejected, deprecated, invokedStable,
    verifyPassRate: totalVersions ? +((stable + verified) / totalVersions).toFixed(2) : 0,
    reuseRate: stable ? +(invokedStable / stable).toFixed(2) : 0,
    invocationFailRate: invocations ? +(failedInv / invocations).toFixed(2) : 0,
    libraryCompactness: totalVersions ? +(stable / totalVersions).toFixed(2) : 0,
    invocations,
  }
}

export default { evaluateVersion, failureClusters, convergenceMetrics }
