/**
 * 沙箱出口配置自检 + 网络诊断回归（离线，桩 transport；无需 e2b / 联网）。
 * 运行：node model/sandbox/egress.test.mjs
 *
 * 覆盖：
 *   - legacyEgressFix：只认「旧默认逐字一致」的形状（allowInternet:false / 有白名单 / 多条 denyOut 都不动）
 *   - auditEgress：全放通 / 白名单（含纯 IP 给 DNS 建议）/ 显式断网 / deny-all（旧值与手写两种）/ 验证档位
 *   - withLegacyEgressFixed + buildEgressOpts：修正后的有效值不再下发 deny-all（原对象不被改）
 *   - createSandboxRuntime：旧配置 → handle.egress.migrated=true、无 denyOut、日志含告警与出口摘要
 *   - net-diag：parseProbes 分段解析、judgeProbes 全拒/DNS被拦/正常/无 nameserver/有意断网/未启用、
 *     egressPlan 旧值识别、formatPlan/formatReport 人话、diagnoseSandbox 无 manager 的降级
 */
import {
  DENY_ALL_ENTRIES, auditEgress, buildEgressOpts, createSandboxRuntime,
  isDenyAllEntry, legacyEgressFix, withLegacyEgressFixed,
} from './index.js'
import { diagnoseSandbox, egressPlan, formatPlan, formatReport, judgeProbes, parseProbes, PROBE_SCRIPT } from './net-diag.js'

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

/** 旧默认形状（v1.24.0 之前） */
const LEGACY_CFG = { mode: 'e2b', apiKey: 'e2b_test_key', template: 'base', network: { allowInternet: true, allowOut: [], denyOut: ['0.0.0.0/0'] } }

function probeOut({
  ns = 'nameserver 8.8.8.8\nnameserver 1.1.1.1',
  getent = '93.184.216.34      example.com',
  py = 'OK: 93.184.216.34',
  udp = 'OK: 45 bytes',
  https = 'HTTP 200 0.123456s',
  proxy = '(none)',
  route = 'default via 10.0.0.1 dev eth0',
} = {}) {
  return [
    `@@1@@ resolv.conf\n${ns}`,
    `@@2@@ getent\n${getent}`,
    `@@3@@ python-dns\n${py}`,
    `@@4@@ udp53\n${udp}`,
    `@@5@@ https\n${https}`,
    `@@6@@ proxy-env\n${proxy}`,
    `@@7@@ route\n${route}`,
  ].join('\n')
}

function stubTransport() {
  const calls = { init: 0, create: 0, kill: 0, run: 0 }
  return {
    calls,
    async init() { calls.init++; return this },
    async ping() { return true },
    async create() { calls.create++; return { id: `sbx-${calls.create}`, raw: {} } },
    async kill() { calls.kill++; return true },
    async run() { calls.run++; return { async wait() { return { exitCode: 0, stdout: probeOut(), stderr: '' } }, async kill() { return true } } },
    async renew() { return true },
  }
}

await test('isDenyAllEntry / DENY_ALL_ENTRIES', () => {
  eq(DENY_ALL_ENTRIES, ['0.0.0.0/0', '::/0'], '常量列出两种全拒写法')
  ok(isDenyAllEntry('0.0.0.0/0') && isDenyAllEntry(' ::/0 ') && isDenyAllEntry('0/0'), '识别 0.0.0.0/0、::/0、0/0（含空白）')
  ok(!isDenyAllEntry('169.254.169.254/32') && !isDenyAllEntry('10.0.0.0/8') && !isDenyAllEntry(''), '普通网段/空值不算全拒')
})

await test('legacyEgressFix 只认旧默认逐字一致的形状', () => {
  eq(legacyEgressFix(LEGACY_CFG), { from: '0.0.0.0/0', entries: ['0.0.0.0/0'] }, '旧默认（allowInternet:true + 空白名单 + 单条 0.0.0.0/0）→ 可迁移')
  eq(legacyEgressFix({ network: { denyOut: ['::/0'] } }), { from: '::/0', entries: ['::/0'] }, 'IPv6 全拒同样识别')
  eq(legacyEgressFix({ network: { allowInternet: false, denyOut: ['0.0.0.0/0'] } }), null, '显式 allowInternet:false → 语义清楚，不动')
  eq(legacyEgressFix({ network: { allowOut: ['pypi.org'], denyOut: ['0.0.0.0/0'] } }), null, '有白名单 → denyOut 正是兜底拒绝，不能删')
  eq(legacyEgressFix({ network: { denyOut: ['0.0.0.0/0', '169.254.169.254/32'] } }), null, '多条 denyOut（用户手写）→ 不迁移')
  eq(legacyEgressFix({ network: { denyOut: ['10.0.0.0/8'] } }), null, '普通网段 → 不迁移')
  eq(legacyEgressFix({}), null, '无 network → null')
  eq(legacyEgressFix(), null, '无参调用不抛')
})

await test('withLegacyEgressFixed 不改原对象 + 修正后不再下发 deny-all', () => {
  const raw = JSON.parse(JSON.stringify(LEGACY_CFG))
  const { cfg: fixed, legacy } = withLegacyEgressFixed(raw)
  ok(!!legacy, '返回迁移信息')
  eq(fixed.network.denyOut, [], '修正后的有效配置清空了 denyOut')
  eq(raw.network.denyOut, ['0.0.0.0/0'], '原对象（用户配置引用）未被就地修改')
  const before = buildEgressOpts(raw)
  const after = buildEgressOpts(fixed)
  eq(before.network, { allowPublicTraffic: false, denyOut: ['0.0.0.0/0'] }, '未修正时确实会下发 deny-all（=事故根因）')
  eq(after.network, { allowPublicTraffic: false }, '修正后不再下发 denyOut')
  eq([before.allowInternetAccess, after.allowInternetAccess], [true, true], '两种情况的 allowInternetAccess 都是 true（问题全在 deny 规则）')
})

await test('auditEgress 判定与文案', () => {
  const legacyAudit = auditEgress(LEGACY_CFG)
  eq([legacyAudit.level, legacyAudit.code], ['warn', 'legacy_deny_all'], '旧默认值 → warn/legacy_deny_all')
  ok(/v1\.24\.0/.test(legacyAudit.message) && /DNS/.test(legacyAudit.message), '文案点明旧版本来源与「含 DNS」')
  ok(/拒绝一切出口/.test(legacyAudit.summary), '摘要说明拒绝一切')

  const handWritten = auditEgress({ network: { denyOut: ['0.0.0.0/0', '169.254.169.254/32'] } })
  eq([handWritten.level, handWritten.code], ['warn', 'deny_all'], '手写的 deny-all（多条）→ warn/deny_all')
  ok(/169\.254\.169\.254\/32/.test(handWritten.advice), '建议里给出正确的元数据写法')

  const ipOnly = auditEgress({ network: { allowOut: ['8.8.8.8/32'] } })
  eq([ipOnly.level, ipOnly.code], ['info', 'whitelist'], '纯 IP 白名单 → info/whitelist')
  ok(/DNS/.test(ipOnly.advice || ''), '纯 IP 白名单给出 DNS 相关建议')
  const domainWl = auditEgress({ network: { allowOut: ['pypi.org', '*.npmjs.org'] } })
  eq(domainWl.advice, null, '含域名的白名单不再提示 DNS')

  eq(auditEgress({ network: { allowInternet: false } }).code, 'offline', 'allowInternet:false → offline（有意断网）')
  eq(auditEgress({ network: {} }).code, 'open', '默认 → open')
  eq(auditEgress({}).code, 'open', '无 network → open')
  const extra = auditEgress({ network: { denyOut: ['169.254.169.254/32'] } })
  eq([extra.code, /额外拒绝 1 条/.test(extra.summary)], ['open', true], '放通 + 额外封禁 → open 且摘要点出额外拒绝')
  eq(auditEgress({}, { denyAll: true }).code, 'deny_all_scope', 'denyAll 档位 → deny_all_scope（有意断网）')
})

await test('createSandboxRuntime：旧配置就地修正 + 出口摘要进日志与 handle', async () => {
  const logs = []
  const logger = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) }
  const rt = await createSandboxRuntime(LEGACY_CFG, { logger, transport: stubTransport() })
  try {
    eq(rt.egress.migrated, true, 'handle.egress.migrated=true')
    eq(rt.egress.migratedFrom, '0.0.0.0/0', '记录被清理的旧值')
    eq(rt.egress.network, { allowPublicTraffic: false }, '实际下发的 network 不再含 denyOut')
    eq(rt.egress.allowInternetAccess, true, '放通开关保持 true')
    eq([rt.egress.audit.level, rt.egress.audit.code], ['info', 'open'], '修正后自检结论回到 open')
    ok(rt.manager.networkSummary.includes('全网放通'), 'manager 拿到出口摘要（创建日志会带上）')
    const warn = logs.find(([lv]) => lv === 'warn')
    ok(!!warn && /拒绝一切出口，含 DNS/.test(warn[1]), '启动告警说明「拒绝一切出口，含 DNS」')
    ok(logs.some(([lv, m]) => lv === 'info' && m.includes('[sandbox] 出口网络：')), 'info 日志打印实际下发的出口摘要')
  } finally {
    await rt.shutdown()
  }
})

await test('createSandboxRuntime：正常配置不误报迁移', async () => {
  const logs = []
  const rt = await createSandboxRuntime({ mode: 'e2b', apiKey: 'e2b_test_key', network: { allowOut: ['pypi.org'] } }, { logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) }, transport: stubTransport() })
  try {
    eq(rt.egress.migrated, false, '没有旧值 → migrated=false')
    eq(rt.egress.network.allowOut, ['pypi.org'], '白名单照常下发')
    ok(logs.some((m) => /白名单收紧/.test(m)), '摘要显示白名单收紧')
    ok(!logs.some((m) => /^WARN/.test(m)), '无告警')
  } finally {
    await rt.shutdown()
  }
})

await test('parseProbes 分段解析', () => {
  const p = parseProbes(probeOut())
  eq(p.resolv.nameservers, ['8.8.8.8', '1.1.1.1'], '解析出两个 nameserver')
  eq([p.getent.ok, p.pythonDns.ok, p.udpDns.ok, p.https.ok, p.https.httpCode], [true, true, true, true, '200'], '全绿探针判为成功')
  eq(p.proxy.present, false, '(none) 不算代理变量')
  eq(p.route.hasDefault, true, '识别 default 路由')
  const empty = parseProbes('')
  eq([empty.getent.ok, empty.pythonDns.ok, empty.https.ok, empty.resolv.nameservers.length], [false, false, false, 0], '空输出全判失败（不误判为正常）')
  const failed = parseProbes(probeOut({ getent: 'FAIL getent', py: 'socket.gaierror', udp: 'TimeoutError', https: 'curl: (28) timeout\nHTTP 000 12.0s', proxy: 'https_proxy=http://127.0.0.1:7890', route: '' }))
  eq([failed.getent.ok, failed.pythonDns.ok, failed.udpDns.ok, failed.https.ok, failed.https.httpCode], [false, false, false, false, '000'], '失败探针全部识别（HTTP 000 不算成功）')
  eq([failed.proxy.present, failed.route.hasDefault], [true, false], '识别代理变量与缺失的默认路由')
  ok(PROBE_SCRIPT.includes('@@7@@') && PROBE_SCRIPT.includes('8.8.8.8'), '探针脚本含全部分段标记与 DNS 直查')
  // 真实 E2B 沙箱踩到过的形状：resolv.conf 不以换行结尾 → 下一个 @@2@@ 粘在 nameserver 行尾。
  // 按「行首标记」切段会把 nameserver 解析成 "8.8.8.8@@2@@"、并整体丢掉 getent 段（误报系统解析失败）。
  const glued = '@@1@@ resolv.conf\nnameserver 8.8.8.8@@2@@ getent\n2606:4700:10::6814:179a example.com\n@@3@@ python-dns\nOK: 104.20.23.154\n@@4@@ udp53\nOK: 61 bytes\n@@5@@ https\nHTTP 200 0.078285s'
  const gp = parseProbes(glued)
  eq(gp.resolv.nameservers, ['8.8.8.8'], '标记粘连时 nameserver 仍解析正确（不带 @@2@@）')
  eq(gp.getent.ok, true, '标记粘连时 getent 段不丢（系统解析不再误报失败）')
  eq([gp.pythonDns.ok, gp.udpDns.ok, gp.https.httpCode], [true, true, '200'], '粘连输出的其余段照常解析')
})

await test('judgeProbes 判定分支', () => {
  const open = auditEgress({ network: {} })
  const okAll = judgeProbes(parseProbes(probeOut()), { audit: open, mode: 'e2b' })
  eq([okAll.code, okAll.level], ['ok', 'info'], '全部成功 → ok')

  const denied = parseProbes(probeOut({ ns: 'nameserver 8.8.8.8', getent: 'FAIL getent', py: 'socket.gaierror', udp: 'TimeoutError', https: 'HTTP 000 24.0s' }))
  const j1 = judgeProbes(denied, { audit: open, mode: 'e2b' })
  eq([j1.code, j1.level], ['all_denied', 'warn'], '解析与 8.8.8.8:53 都失败 → all_denied')
  const j1sh = judgeProbes(denied, { audit: open, mode: 'e2b', selfHosted: true })
  ok(/orchestrator/.test(j1sh.advice), '自托管时建议指向部署侧 NAT/DNS')

  const dnsBlocked = parseProbes(probeOut({ getent: 'FAIL getent', py: 'socket.gaierror', udp: 'OK: 45 bytes', https: 'HTTP 000 12.0s' }))
  const j2 = judgeProbes(dnsBlocked, { audit: open, mode: 'e2b' })
  eq([j2.code, j2.level], ['dns_blocked', 'warn'], 'UDP53 可通但系统解析失败 → dns_blocked（纯 IP 白名单）')
  ok(/8\.8\.8\.8/.test(j2.advice), '建议给出放行 DNS 的具体做法')

  const filtered = parseProbes(probeOut({ https: 'HTTP 000 12.0s' }))
  eq(judgeProbes(filtered, { audit: open, mode: 'e2b' }).code, 'egress_filtered', 'DNS 通但 HTTPS 不通 → egress_filtered')

  const noResolv = judgeProbes(parseProbes(probeOut({ ns: '' })), { audit: open, mode: 'e2b' })
  eq(noResolv.code, 'no_resolv', '无 nameserver → no_resolv（模板问题）')

  eq(judgeProbes(parseProbes(probeOut()), { audit: auditEgress({ network: { allowInternet: false } }), mode: 'e2b' }).code, 'expected_offline', '有意断网配置 → expected_offline（不误判为 bug）')
  eq(judgeProbes(parseProbes(probeOut()), { audit: open, mode: 'off' }).code, 'not_enabled', 'mode≠e2b → not_enabled')
})

await test('egressPlan / format* 人话输出', () => {
  const plan = egressPlan(LEGACY_CFG)
  ok(!!plan.legacy, 'plan 报出旧值')
  eq(plan.session.network, { allowPublicTraffic: false }, 'plan 按「清理后的有效值」计算')
  eq(plan.offline.allowInternetAccess, false, '验证/进化档位恒断网')
  const text = formatPlan(plan, { cfg: LEGACY_CFG })
  ok(text.includes('#沙箱诊断 修复') && text.includes('拒绝一切出口'), '静态计划给出迁移入口与结论')
  const report = {
    ok: true,
    plan: { session: plan.session, audit: plan.audit },
    probes: parseProbes(probeOut()),
    verdict: judgeProbes(parseProbes(probeOut()), { audit: plan.audit, mode: 'e2b' }),
    raw: { sandboxId: 'sbx-1', duration: 1500 },
  }
  const rep = formatReport(report, { cfg: LEGACY_CFG })
  ok(rep.includes('sbx-1') && rep.includes('判定：') && rep.includes('实际下发：'), '实测报告含沙箱 id、判定与实际下发值')
})

await test('diagnoseSandbox：无 manager 时降级为静态结论', () => {
  return diagnoseSandbox({ manager: null, cfg: LEGACY_CFG, mode: 'e2b' }).then((r) => {
    eq(r.ok, false, 'withoutManager → ok=false')
    ok(/无法实测/.test(r.error), '错误说明无法实测')
    ok(!!r.plan && !!r.verdict, '仍返回静态 plan 与 verdict（命令可照常展示）')
    ok(formatReport(r, { cfg: LEGACY_CFG }).includes('无法实测'), 'formatReport 也能渲染该分支')
  })
})

await test('diagnoseSandbox：桩 manager 走完探针链路', async () => {
  const rt = await createSandboxRuntime({ mode: 'e2b', apiKey: 'e2b_test_key', network: {} }, { transport: stubTransport() })
  try {
    const r = await diagnoseSandbox({ manager: rt.manager, cfg: { mode: 'e2b', apiKey: 'e2b_test_key', network: {} }, mode: 'e2b', key: 'net-diag:test' })
    eq([r.ok, r.verdict.code], [true, 'ok'], '桩沙箱输出全绿 → ok')
    eq(r.raw.sandboxId, 'sbx-1', '报告带上沙箱 id')
  } finally {
    await rt.shutdown()
  }
})

console.log(`\n=== ${passed} passed, ${failed} failed ===`)
process.exit(failed ? 1 : 0)
