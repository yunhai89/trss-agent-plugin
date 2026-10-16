/**
 * 沙箱出口网络诊断（`#沙箱诊断` 命令与 scripts/sandbox-net-diag.mjs 共用同一实现）。
 *
 * 为什么需要它：「沙箱连不上网 / DNS 也不通」有四种完全不同的成因——
 *   ① 配置把出口关了或收窄了（allowInternet:false；白名单只写 IP/CIDR 时 DNS 一起被拦）；
 *   ② 旧语义遗留的 denyOut:['0.0.0.0/0']（v1.24.0 前的默认值，在新语义下=拒绝一切）；
 *   ③ 命令跑在**有意断网**的档位（toolEvo 候选验证 / 进化 stable 工具，purpose=verify|evo）；
 *   ④ 自托管 E2B 的 orchestrator 没做 NAT/DNS。
 * 前两类由 auditEgress/legacyEgressFix 静态判定，后两类必须看沙箱内实测——本模块把两者并排给出。
 *
 * E2B 语义要点（https://docs.e2b.dev/network/internet-access）：
 *   - 沙箱**默认就有出口**；`allowInternetAccess:false` ≡ `denyOut:['0.0.0.0/0']`；
 *   - 白名单**含域名**时 E2B 自动放行默认 nameserver（8.8.8.8:53）保证 DNS；纯 IP/CIDR 白名单不会；
 *   - 域名过滤只作用于 80 端口的 Host 与 443 端口的 SNI，其它端口只能按 IP/CIDR 放行；
 *   - 被拦的 TCP 连接**可能显示成成功**（防火墙先 accept 再判目的地）→ 判定只看应用层响应。
 */
import { auditEgress, buildEgressOpts, withLegacyEgressFixed } from './index.js'
import { runSandboxShell } from './shell.js'

/** 沙箱内 7 项探针（@@N@@ 作分段标记，解析见 parseProbes）。
 *  每段末尾都补一个 echo（换行）——`cat /etc/resolv.conf` 之类的输出**可能不以换行结尾**，
 *  否则下一段的 @@N@@ 会粘在上一段最后一行上（实测踩过：nameserver 被解析成 `8.8.8.8@@2@@`、
 *  getent 段整体丢失导致「系统解析」被误报为失败）。 */
export const PROBE_SCRIPT = [
  'echo "@@1@@ resolv.conf"; cat /etc/resolv.conf 2>&1 | head -6; echo',
  'echo "@@2@@ getent"; getent hosts example.com 2>&1 || echo "FAIL getent"; echo',
  `echo "@@3@@ python-dns"; python3 -c "import socket;socket.setdefaulttimeout(5);print('OK:', socket.gethostbyname('example.com'))" 2>&1 | tail -3; echo`,
  `echo "@@4@@ udp53"; python3 -c "
import socket
q=bytes.fromhex('abcd01000001000000000000076578616d706c6503636f6d0000010001')
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(5)
s.sendto(q,('8.8.8.8',53)); d,_=s.recvfrom(512); print('OK:', len(d), 'bytes')
" 2>&1 | tail -2; echo`,
  'echo "@@5@@ https"; curl -sS -m 12 -o /dev/null -w "HTTP %{http_code} %{time_total}s\\n" https://example.com 2>&1; echo',
  'echo "@@6@@ proxy-env"; env | grep -iE "^(http|https|all|no)_proxy=" || echo "(none)"; echo',
  'echo "@@7@@ route"; (ip route 2>/dev/null || cat /proc/net/route) | head -4; echo',
].join('\n')

/** 解析探针输出 → 逐项布尔结论（缺段一律按失败处理，避免「没输出=正常」的误判）。
 *  标记匹配**不限行首**：即便某段输出没换行、@@N@@ 粘在行尾，也能正确切段。 */
export function parseProbes(stdout = '') {
  const text = String(stdout || '')
  const marks = [...text.matchAll(/@@(\d+)@@[^\n]*/g)]
  const sec = {}
  marks.forEach((m, i) => {
    const start = m.index + m[0].length
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length
    sec[Number(m[1])] = text.slice(start, end).trim()
  })
  const resolv = sec[1] || ''
  const getent = sec[2] || ''
  const py = sec[3] || ''
  const udp = sec[4] || ''
  const https = sec[5] || ''
  const proxy = sec[6] || ''
  const route = sec[7] || ''
  const httpCode = (https.match(/HTTP\s+(\d{3})/) || [])[1] || null
  return {
    resolv: { raw: resolv, nameservers: [...resolv.matchAll(/^\s*nameserver\s+(\S+)/gm)].map((m) => m[1]) },
    getent: { raw: getent, ok: !!getent && !/FAIL/.test(getent) },
    pythonDns: { raw: py, ok: /OK:/.test(py) },
    udpDns: { raw: udp, ok: /OK:/.test(udp) },
    https: { raw: https, httpCode, ok: !!httpCode && httpCode !== '000' },
    proxy: { raw: proxy, present: /_proxy=/i.test(proxy) },
    route: { raw: route, hasDefault: /default|00000000/.test(route) },
  }
}

/**
 * 由探针结果给出判定（code 供程序分支，title/advice 给人看）。
 * @param {object} p parseProbes 的结果
 * @param {{audit?:object, mode?:string, selfHosted?:boolean}} [opt]
 */
export function judgeProbes(p, { audit = null, mode = 'e2b', selfHosted = false } = {}) {
  if (String(mode || '').toLowerCase() !== 'e2b') {
    return { code: 'not_enabled', level: 'info', title: '沙箱未启用（agent.sandbox.mode 不是 e2b）——terminal 工具不会注册，不存在沙箱网络', advice: null }
  }
  if (audit && (audit.code === 'offline' || audit.code === 'deny_all_scope')) {
    return {
      code: 'expected_offline',
      level: 'info',
      title: '该档位**有意断网**（配置显式关闭出口，或候选验证/进化档位）——不通是预期行为',
      advice: audit.code === 'offline' ? '需要联网请把 agent.sandbox.network.allowInternet 改回 true' : '这是安全设计：验证/进化跑的是不可信候选代码，需要联网的命令请放到普通会话沙箱',
    }
  }
  if (!p.resolv.nameservers.length) {
    return { code: 'no_resolv', level: 'warn', title: '沙箱内 /etc/resolv.conf 没有可用 nameserver（模板问题，与网络策略无关）', advice: '换模板或让模板写入 nameserver（如 8.8.8.8）；E2B 云模板默认带解析器' }
  }
  const dnsOk = p.pythonDns.ok || p.getent.ok
  if (p.https.ok) {
    return {
      code: 'ok',
      level: 'info',
      title: `出口正常（HTTPS ${p.https.httpCode}${dnsOk ? '，域名解析正常' : '，但域名解析异常'}）`,
      advice: dnsOk ? null : 'HTTPS 用的是 IP 直连？请复查域名解析路径（本机 hosts/白名单）',
    }
  }
  if (!dnsOk && !p.udpDns.ok) {
    return {
      code: 'all_denied',
      level: 'warn',
      title: '出口被整段拒绝：域名解析与 8.8.8.8:53 直查都失败',
      advice: selfHosted
        ? '自托管 E2B：orchestrator 侧没有做 NAT/DNS/转发（部署限制），或本插件下发了 deny-all（见上方实际下发值）'
        : '插件下发了 deny-all（denyOut 含 0.0.0.0/0 或 allowInternet:false）→ 见上方「实际下发」与自检结论；E2B 云默认是放通的',
    }
  }
  if (!dnsOk && p.udpDns.ok) {
    return {
      code: 'dns_blocked',
      level: 'warn',
      title: 'DNS 被拦：系统解析失败，但 UDP 53 直查 8.8.8.8 可通',
      advice: '白名单只写了 IP/CIDR —— E2B 仅在白名单**含域名**时自动放行默认 nameserver；请把域名写进 allowOut，或额外放行 8.8.8.8/32',
    }
  }
  if (dnsOk && !p.https.ok) {
    return {
      code: 'egress_filtered',
      level: 'warn',
      title: 'DNS 正常但 HTTPS 不通：目标不在白名单（或被上游拦截）',
      advice: 'E2B 域名过滤只认 80 端口 Host 与 443 端口 SNI；非 80/443 端口只能按 IP/CIDR 放行——把目标域名/IP 加进 allowOut',
    }
  }
  return {
    code: 'partial',
    level: 'warn',
    title: '部分探针失败（见逐项结果）',
    advice: '按失败项对照判定表：解析失败看 resolv.conf/白名单，HTTPS 失败看白名单与非 80/443 端口',
  }
}

/** 静态部分：按当前配置算出「实际下发什么」+ 自检结论 + 旧值迁移建议（不建沙箱） */
export function egressPlan(cfg = {}) {
  const { cfg: effective, legacy } = withLegacyEgressFixed(cfg)
  return {
    legacy,
    session: buildEgressOpts(effective),
    offline: buildEgressOpts(cfg, { denyAll: true }),
    audit: auditEgress(effective),
  }
}

/**
 * 实测部分：在会话沙箱里跑探针（复用会话 manager，因此跑的就是 terminal 用的那个出口策略）。
 * @param {{manager:object, key?:string, timeout?:number, cfg?:object, mode?:string, selfHosted?:boolean}} opt
 */
export async function diagnoseSandbox({ manager, key = 'net-diag', timeout = 60, cfg = {}, mode = 'e2b', selfHosted = false, maxOutput = 20000 } = {}) {
  const plan = egressPlan(cfg)
  if (!manager) {
    return { ok: false, plan, probes: null, verdict: judgeProbes(parseProbes(''), { audit: plan.audit, mode }), error: '沙箱未启用（mode≠e2b 或未填 apiKey），无法实测' }
  }
  const r = await runSandboxShell(manager, key, PROBE_SCRIPT, { timeout, maxOutput })
  const probes = parseProbes(`${r.stdout || ''}\n${r.stderr || ''}`)
  return { ok: !!r.ok, plan, probes, verdict: judgeProbes(probes, { audit: plan.audit, mode, selfHosted }), raw: r }
}

const mask = (s) => (s ? `${String(s).slice(0, 6)}…（长度 ${String(s).length}）` : '(空)')

/** 静态计划的人话（`#沙箱诊断 预览` / 脚本 --plan） */
export function formatPlan(plan, { cfg = {} } = {}) {
  const net = cfg.network || {}
  const lines = [
    '🧪 沙箱出口自检（静态）',
    `模式：${cfg.mode || 'off'} · 模板：${cfg.template || 'base'} · apiKey：${mask(cfg.apiKey)} · 自托管：${cfg.apiUrl || cfg.domain ? '是' : '否（E2B 云）'}`,
    `配置：allowInternet=${net.allowInternet ?? '(未配，默认放通)'} · allowOut=${JSON.stringify(net.allowOut || [])} · denyOut=${JSON.stringify(net.denyOut || [])}`,
    `实际下发（会话沙箱）：network=${JSON.stringify(plan.session.network)} · allowInternetAccess=${plan.session.allowInternetAccess}`,
    `验证/进化档位：network=${JSON.stringify(plan.offline.network)} · allowInternetAccess=${plan.offline.allowInternetAccess}（有意断网）`,
  ]
  if (plan.legacy) {
    lines.push(`\n⚠ 检测到 v1.24.0 之前的默认值 denyOut:["${plan.legacy.from}"]（= 拒绝一切出口，含 DNS）`)
    lines.push('  本次已按「清理后的有效值」计算；执行 #沙箱诊断 修复 可写回 config.yaml 永久生效。')
  }
  lines.push(`\n自检结论：${plan.audit.level === 'warn' ? '⚠' : '✓'} ${plan.audit.summary}`)
  if (plan.audit.message) lines.push(`  ${plan.audit.message}`)
  if (plan.audit.advice) lines.push(`  建议：${plan.audit.advice}`)
  return lines.join('\n')
}

/** 实测报告的人话（`#沙箱诊断` / 脚本实测） */
export function formatReport(report, { cfg = {} } = {}) {
  const p = report.probes
  const lines = []
  if (report.error) {
    lines.push(`⚠ ${report.error}`)
    lines.push(formatPlan(report.plan, { cfg }))
    return lines.join('\n')
  }
  const mark = (b) => (b ? '✓' : '✗')
  const first = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(空)'
  lines.push(`🔎 沙箱出口实测（沙箱 ${report.raw?.sandboxId || '—'} · 耗时 ${Math.round((report.raw?.duration || 0) / 1000)}s）`)
  lines.push(`${mark(p.resolv.nameservers.length)} resolv.conf：${p.resolv.nameservers.length ? p.resolv.nameservers.join(', ') : first(p.resolv.raw)}`)
  lines.push(`${mark(p.getent.ok)} 系统解析：${first(p.getent.raw)}`)
  lines.push(`${mark(p.pythonDns.ok)} python 解析：${first(p.pythonDns.raw)}`)
  lines.push(`${mark(p.udpDns.ok)} UDP 53 直查 8.8.8.8：${first(p.udpDns.raw)}`)
  lines.push(`${mark(p.https.ok)} HTTPS example.com：${p.https.httpCode ? `HTTP ${p.https.httpCode}` : first(p.https.raw)}`)
  if (p.proxy.present) lines.push(`· 代理环境变量：${first(p.proxy.raw)}`)
  if (!p.route.hasDefault) lines.push('✗ 默认路由：未看到 default 路由')
  lines.push(`\n判定：${report.verdict.level === 'warn' ? '⚠' : '✓'} ${report.verdict.title}`)
  if (report.verdict.advice) lines.push(`建议：${report.verdict.advice}`)
  lines.push(`\n实际下发：network=${JSON.stringify(report.plan.session.network)} · allowInternetAccess=${report.plan.session.allowInternetAccess}`)
  if (report.plan.audit.level === 'warn') lines.push(`自检：⚠ ${report.plan.audit.message}`)
  lines.push('提示：被拦的 TCP 连接可能「看起来成功」（防火墙先 accept 再判定），因此判定只看应用层响应。')
  return lines.join('\n')
}
