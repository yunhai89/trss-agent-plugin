#!/usr/bin/env node
/**
 * E2B 沙箱网络诊断 CLI —— 判断「沙箱连不上网 / DNS 也不通」到底是**插件配置**、**有意断网的档位**，
 * 还是 **E2B 侧/自托管部署**的问题。判定与探针实现见 model/sandbox/net-diag.js（与 `#沙箱诊断` 命令同一份代码）。
 *
 * 用法（在插件根目录执行；云端需要 apiKey，自托管还需要 apiUrl/domain）：
 *   node scripts/sandbox-net-diag.mjs             # 按 config.yaml 的 agent.sandbox 实测
 *   node scripts/sandbox-net-diag.mjs --plan      # 只做静态自检（不建沙箱、不需要 key）
 *   node scripts/sandbox-net-diag.mjs --control   # 额外建一个「全放通」对照沙箱
 *   node scripts/sandbox-net-diag.mjs --keep      # 诊断后不杀沙箱（默认杀掉）
 *   node scripts/sandbox-net-diag.mjs --json      # 机器可读输出
 *
 * 判定要点（E2B 官方语义，https://docs.e2b.dev/network/internet-access）：
 *   - 每个沙箱**默认就有出口**；`allowInternetAccess:false` ≡ `denyOut:['0.0.0.0/0']`；
 *   - 白名单里**有域名**时，E2B 会自动放行默认 nameserver（8.8.8.8:53）以保证 DNS 可解析；
 *     只写 IP/CIDR 的白名单**不会**自动放行 DNS —— 于是「网络不通 + DNS 不通」同时出现；
 *   - 被防火墙拦掉的 TCP 连接**可能显示成成功**（先 accept 再判定），所以要用应用层响应判断。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const has = (k) => args.has(k) || [...args].some((a) => a.startsWith(`${k}=`))
const planOnly = has('--plan')
const wantControl = has('--control')
const keep = has('--keep')
const asJson = has('--json')

const { parse: parseYaml } = await import('yaml')
const { makeTransport } = await import('../model/sandbox/transport.js')
const { PROBE_SCRIPT, auditEgress, egressPlan, formatPlan, formatReport, judgeProbes, parseProbes } = await import('../model/sandbox/net-diag.js')

function readYaml(file) {
  try { return parseYaml(fs.readFileSync(file, 'utf8')) || {} } catch { return {} }
}
const defaults = readYaml(path.join(ROOT, 'config/default_config/config.yaml'))
const user = readYaml(path.join(ROOT, 'config/config.yaml'))
const cfg = { ...(defaults?.agent?.sandbox || {}), ...(user?.agent?.sandbox || {}) }
if (!cfg.apiKey) cfg.apiKey = process.env.E2B_API_KEY || ''
for (const [k, v] of [['apiUrl', 'E2B_API_URL'], ['domain', 'E2B_DOMAIN'], ['sandboxUrl', 'E2B_SANDBOX_URL']]) {
  if (!cfg[k] && process.env[v]) cfg[k] = process.env[v]
}
const selfHosted = !!(cfg.apiUrl || cfg.domain)
const plan = egressPlan(cfg)

if (!asJson) console.log(formatPlan(plan, { cfg }))

if (planOnly || !cfg.apiKey) {
  if (!asJson) {
    if (!cfg.apiKey) console.log('\n（未找到 apiKey / E2B_API_KEY —— 只做静态判定；填好 key 后重跑可实测）')
    console.log('\n--plan 模式结束。')
  } else {
    console.log(JSON.stringify({ phase: 'plan', config: { ...cfg, apiKey: cfg.apiKey ? '(已设置)' : '' }, plan }, null, 2))
  }
  process.exit(0)
}

async function runProbe(label, egress, audit) {
  const t = makeTransport(cfg, { logger: (lv, m) => { if (!asJson) console.log(`  [transport:${lv}] ${m}`) } })
  await t.init()
  const t0 = Date.now()
  const handle = await t.create({
    template: cfg.template || 'base',
    timeoutMs: Math.min(Number(cfg.sandboxTtlMs) || 600000, 300000),
    metadata: { purpose: 'net-diag' },
    network: egress.network,
    allowInternetAccess: egress.allowInternetAccess,
  })
  let out = ''
  try {
    const h = await t.run(handle, PROBE_SCRIPT, {
      timeoutMs: 60000,
      onStdout: (d) => { out += String(d) },
      onStderr: (d) => { out += String(d) },
    })
    const res = await h.wait()
    const probes = parseProbes(`${res?.stdout || out || ''}\n${res?.stderr || ''}`)
    const verdict = judgeProbes(probes, { audit, mode: cfg.mode, selfHosted })
    const report = {
      ok: Number(res?.exitCode ?? 0) === 0,
      plan: { session: egress, audit },
      probes,
      verdict,
      raw: { sandboxId: handle.id, duration: Date.now() - t0 },
    }
    if (asJson) console.log(JSON.stringify({ phase: 'probe', label, report }, null, 2))
    else { console.log(`\n=== ${label} ===`); console.log(formatReport(report, { cfg })) }
    return report
  } finally {
    if (!keep) { try { await t.kill(handle) } catch { /* best-effort */ } }
  }
}

await runProbe('会话沙箱实测（按你的配置）', plan.session, plan.audit)
if (wantControl) {
  const openCfg = { network: {} }
  await runProbe('对照沙箱（无 network 规则 · allowInternetAccess=true）', { network: {}, allowInternetAccess: true }, auditEgress(openCfg))
}
if (!asJson) {
  console.log(`
=== 判定表 ===
  resolv.conf 无 nameserver            → 模板问题（与网络策略无关）
  解析与 8.8.8.8:53 直查都失败          → 出口被整段拒绝（denyOut 含 0.0.0.0/0，或 allowInternet:false）
  解析失败但 8.8.8.8:53 可通            → 白名单只含 IP/CIDR，DNS 没被放行
  解析正常但 HTTPS 失败                 → 目标不在白名单（域名过滤只认 80 端口 Host / 443 端口 SNI）
  全部成功但业务仍失败                  → 多半跑在**有意断网**的验证/进化档位（日志 purpose=verify|evo）
  自托管（apiUrl/domain 非空）下全失败   → orchestrator 侧没做 NAT/DNS/转发，属部署限制
提示：被拦的 TCP 连接**可能显示成成功**（防火墙先 accept 再判定），务必看应用层响应（HTTP 码/TLS 握手）。
`)
}
