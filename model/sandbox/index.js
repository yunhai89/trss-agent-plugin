/**
 * 沙箱运行时装配（E2B Firecracker microVM）。
 *
 * 对外职责：
 *   - 读 agent.sandbox 配置 → 构造 transport + manager（可注入桩 transport 做离线测试）
 *   - 装配失败**不抛穿**：返回 manager:null + error，由工具层落成 fail-closed 结构化失败
 *     （配置错/未装包不该把整个 buildRuntime 拖垮，与 stagehand/toolEvo 的降级姿态一致）
 *   - 提供会话绑定键、网络出口选项、单会话命令数计数器的构造
 *   - 内置 shell 类工具的执行面由 bridge.js 统一接管（见该文件头：mode=e2b 时沙箱内执行/fail-closed）
 */
import { SandboxError, classify } from './errors.js'
import { SandboxManager } from './manager.js'
import { makeTransport } from './transport.js'

export { SandboxManager } from './manager.js'
export { makeTransport } from './transport.js'
export { runSandboxShell } from './shell.js'
export { openSandboxBundle, runSandboxBundle, ensureSandboxError } from './bundle.js'
export {
  FAIL_KINDS, RETRYABLE_KINDS, SandboxError, classify, isExitError, isSandboxInfra, toToolFailure, truncateOutput,
} from './errors.js'

/** 是否启用沙箱执行面（mode: e2b 且填了 apiKey） */
export function isSandboxEnabled(cfg) {
  return !!cfg && String(cfg.mode || 'off').toLowerCase() === 'e2b' && !!String(cfg.apiKey || '').trim()
}

/**
 * agent.sandbox.network → E2B 网络选项 + allowInternetAccess（两者必须成对计算，不能各算各的）。
 *
 * E2B 语义（docs.e2b.dev/network/internet-access）：
 *   - 沙箱**默认放行全部出口**；`allowOut` 未指定同样等于放行全部；allow 规则恒优先于 deny；
 *   - `allowInternetAccess: false` ≡ `denyOut: ['0.0.0.0/0']`（官方默认拒绝全部的方式）。
 * 因此"默认拒绝"**不能**靠下发空 `allowOut: []`——空数组在服务端可能被归一成"未指定=放行全部"，
 * 叠加「allow 优先于 deny」后反而把 denyOut 的兜底拒绝顶掉（曾导致沙箱默认全网可达）。
 * 这里只在白名单非空时下发 allowOut，其余情况用 allowInternetAccess 显式控制。
 *
 * 默认策略（2025-10 变更）：**默认放通全部出口**（与 E2B 自身默认一致）——包管理器/API/下载等
 * 开箱可用；白名单为**可选收紧**（opt-in）：
 *   - 配了 allowOut 白名单 → 只放行白名单 + denyOut 兜底全拒（allow 优先于 deny）；
 *   - 未配白名单 + allowInternet:false（显式断网）→ denyOut 全拒 + allowInternetAccess:false；
 *   - 未配白名单 + 默认 → 不下发 allowOut/denyOut + allowInternetAccess:true（全网放行）；
 *     用户显式配的 denyOut 仍下发（如 169.254.169.254/32 防云元数据）。
 * denyAll 用于候选验证/进化工具这类不需要出口的一次性沙箱（恒全拒）。
 * @param {object} cfg agent.sandbox
 * @param {{denyAll?:boolean}} [opt]
 * @returns {{network:object, allowInternetAccess:boolean}}
 */
export function buildEgressOpts(cfg = {}, { denyAll = false } = {}) {
  const net = cfg.network || {}
  const allowOut = denyAll ? [] : (Array.isArray(net.allowOut) ? net.allowOut.map((s) => String(s)).filter(Boolean) : [])
  const denyOut = Array.isArray(net.denyOut) ? net.denyOut.map((s) => String(s)).filter(Boolean) : []
  const fallbackDeny = denyOut.length ? denyOut : ['0.0.0.0/0']
  const narrowed = allowOut.length > 0
  // allowInternet 缺省 = true（默认放通）；显式 false 且无白名单 = 全拒。白名单恒优先（配了白名单就能用）。
  const internetOff = net.allowInternet === false && !narrowed
  // 白名单存在时也必须放通"互联网开关"，否则 deny 语义可能盖过 allow；实际可达范围由 allowOut 收窄。
  const allowInternetAccess = !denyAll && !internetOff
  const network = { allowPublicTraffic: cfg.allowPublicTraffic === true }
  if (narrowed) {
    network.allowOut = allowOut
    network.denyOut = fallbackDeny
  } else if (denyAll || internetOff) {
    network.denyOut = fallbackDeny
  } else if (denyOut.length) {
    // 默认放通模式下用户仍显式配了 denyOut → 如实下发（allow 优先于 deny 由服务端保证）
    network.denyOut = denyOut
  }
  return { network, allowInternetAccess }
}

/**
 * 兼容出口：仅返回 network 部分（不含 allowInternetAccess）。
 * 新代码请用 buildEgressOpts——空 allowOut 不再下发，默认拒绝由 allowInternetAccess:false 承担。
 */
export function buildNetworkOpts(cfg = {}, opt = {}) {
  return buildEgressOpts(cfg, opt).network
}

/** 「拒绝一切出口」的等价写法（E2B：0.0.0.0/0 覆盖 IPv4，::/0 覆盖 IPv6） */
export const DENY_ALL_ENTRIES = ['0.0.0.0/0', '::/0']

/** 单条 denyOut 是否等于「拒绝一切」 */
export function isDenyAllEntry(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return s === '0.0.0.0/0' || s === '::/0' || s === '0/0'
}

/**
 * 识别 v1.24.0 之前的旧默认出口配置：`allowInternet:false` + `denyOut:['0.0.0.0/0']` + 域名白名单。
 * v1.24.0 起默认改成「全放通 + 可选白名单」，且**旧配置显式值不被覆盖**——于是老配置里那条
 * `denyOut:['0.0.0.0/0']` 在新语义（没有白名单了）下变成「拒绝一切出口，含 DNS」，
 * 沙箱表现为网络与 DNS 一起不通（真实线上事故：云 E2B + 老配置，curl 卡 24s 后 exit=1）。
 *
 * 只在「与旧默认逐字一致」的形状上给出迁移（denyOut 恰好只有一条 0.0.0.0/0、无白名单、
 * 且不是显式 allowInternet:false）——用户有意写的其它组合一律不动，只由 auditEgress 告警。
 * @returns {{from:string, entries:string[]}|null}
 */
export function legacyEgressFix(cfg = {}) {
  const net = cfg?.network
  if (!net || typeof net !== 'object') return null
  const allow = Array.isArray(net.allowOut) ? net.allowOut.map((s) => String(s).trim()).filter(Boolean) : []
  const deny = Array.isArray(net.denyOut) ? net.denyOut.map((s) => String(s).trim()).filter(Boolean) : []
  if (net.allowInternet === false) return null // 显式断网：语义清楚，不动
  if (allow.length) return null // 有白名单：denyOut 正是不该删的兜底拒绝
  if (deny.length !== 1 || !isDenyAllEntry(deny[0])) return null
  return { from: deny[0], entries: deny.slice() }
}

/** 旧配置迁移后的有效配置（不改原对象：调用方决定是否落盘） */
export function withLegacyEgressFixed(cfg = {}) {
  const legacy = legacyEgressFix(cfg)
  if (!legacy) return { cfg, legacy: null }
  return { cfg: { ...cfg, network: { ...(cfg.network || {}), denyOut: [] } }, legacy }
}

/**
 * 出口配置自检：把「实际下发什么」翻译成一句人话 + 风险提示。
 * 启动日志、`#沙箱诊断`、Web 面板共用同一份判定，避免多处漂移。
 *
 * 为什么需要它：`allowInternet:true`（默认放通）与「denyOut 里写了 0.0.0.0/0」是**互相矛盾**的，
 * 而 E2B 侧 allow 规则优先于 deny——没有 allow 规则时 deny-all 就是唯一规则，拒绝一切（含 DNS）。
 * 这种组合以前既不下发告警也不进日志，排障时完全看不见（用户只能看到 curl 超时）。
 * @param {object} cfg agent.sandbox
 * @param {{denyAll?:boolean}} [opt] denyAll=true 表示候选验证/进化档位（有意断网）
 * @returns {{level:'info'|'warn', code:string, summary:string, message:string, advice:string|null}}
 */
export function auditEgress(cfg = {}, { denyAll = false } = {}) {
  if (denyAll) {
    return { level: 'info', code: 'deny_all_scope', summary: '完全断网（候选验证/进化档位，有意为之）', message: '', advice: null }
  }
  const net = cfg?.network || {}
  const allow = Array.isArray(net.allowOut) ? net.allowOut.map((s) => String(s).trim()).filter(Boolean) : []
  const deny = Array.isArray(net.denyOut) ? net.denyOut.map((s) => String(s).trim()).filter(Boolean) : []
  const denyAllEntries = deny.filter(isDenyAllEntry)
  if (net.allowInternet === false && allow.length === 0) {
    return { level: 'info', code: 'offline', summary: '完全断网（network.allowInternet: false，显式配置）', message: '', advice: null }
  }
  if (allow.length) {
    const ipOnly = !allow.some((s) => /[a-zA-Z]/.test(s))
    return {
      level: 'info',
      code: 'whitelist',
      summary: `白名单收紧：放行 ${allow.length} 条，其余一律拒绝`,
      message: '',
      advice: ipOnly
        ? '白名单只含 IP/CIDR：E2B 仅在白名单**含域名**时自动放行默认 DNS(8.8.8.8:53)，纯 IP 白名单下沙箱内域名解析会失败；建议把域名写进 allowOut（如 example.com / "*.example.com"）'
        : null,
    }
  }
  if (denyAllEntries.length) {
    const legacy = legacyEgressFix(cfg)
    return {
      level: 'warn',
      code: legacy ? 'legacy_deny_all' : 'deny_all',
      summary: `拒绝一切出口（denyOut=${JSON.stringify(denyAllEntries)} 且 allowOut 为空）→ 网络与 DNS 都不通`,
      message: legacy
        ? `agent.sandbox.network.denyOut 是 v1.24.0 之前的默认值 ["${legacy.from}"]：在当前语义（默认全放通、无白名单）下它等于「拒绝一切出口，含 DNS」，沙箱会完全无法联网；已自动清理（旧版的「兜底拒绝」现在由 allowInternet:false + 白名单承担）`
        : `agent.sandbox.network.denyOut 含 "${denyAllEntries.join('", "')}" 且 allowOut 为空：E2B 只在**没有 allow 规则时**由 deny 决定，这条会拒绝一切出口（含 DNS），表现正是「网络不通 + DNS 也不通」`,
      advice: legacy
        ? null
        : '若非有意断网，请从 denyOut 删掉 0.0.0.0/0；只想封禁元数据地址请写具体网段（如 169.254.169.254/32），要完全断网请用 network.allowInternet: false',
    }
  }
  const extra = deny.length ? `；额外拒绝 ${deny.length} 条（${deny.slice(0, 3).join(', ')}${deny.length > 3 ? '…' : ''}）` : ''
  return { level: 'info', code: 'open', summary: `全网放通（E2B 默认，无白名单）${extra}`, message: '', advice: null }
}

/**
 * 会话绑定键：同会话复用同一沙箱（文件/进程状态连续）。
 * 与 apps/agent.js 的 ctx（scopeUserId/groupId/conversationId）同源；
 * 群共享模式（isolation=false）下 scopeUserId 是群占位符 → 同群共用一个沙箱（README 已说明）。
 */
export function sessionKeyOf(ctx = {}) {
  const gid = ctx.groupId ? String(ctx.groupId) : 'private'
  const uid = String(ctx.scopeUserId || ctx.userId || 'unknown')
  const conv = ctx.conversationId ? String(ctx.conversationId) : 'default'
  return `conv:${gid}:${uid}:${conv}`
}

/** 单会话命令数计数器（防主人或注入指令发起长任务把配额/账单打爆） */
export function makeCommandCounter(limit = 50) {
  const max = Math.max(0, Number(limit) || 0)
  const counts = new Map()
  return {
    limit: max,
    /** 记一次并返回是否超限（超限也计数，便于观测"还想继续跑"的意图） */
    hit(key) {
      const k = String(key)
      const n = (counts.get(k) || 0) + 1
      counts.set(k, n)
      return max > 0 && n > max
    },
    get(key) { return counts.get(String(key)) || 0 },
    reset(key) { counts.delete(String(key)) },
    clear() { counts.clear() },
  }
}

/**
 * 装配沙箱运行时。
 * @param {object} cfg agent.sandbox
 * @param {object} [opt] { logger, transport } —— transport 注入用于离线测试
 * @returns {Promise<{mode:string, enabled:boolean, transport:object|null, manager:SandboxManager|null, commands:object, error:Error|null, probe:Function, shutdown:Function}>}
 */
export async function createSandboxRuntime(cfg = {}, { logger = null, transport = null } = {}) {
  const mode = String(cfg.mode || 'off').toLowerCase()
  const enabled = isSandboxEnabled(cfg)
  const commands = makeCommandCounter(cfg.maxCommandsPerSession ?? 50)
  const base = {
    mode,
    enabled,
    transport: null,
    manager: null,
    verifyManager: null,
    evoManager: null,
    commands,
    error: null,
    async probe() { return false },
    async shutdown() { return 0 },
  }
  if (!enabled) {
    return base // mode=off：terminal 不注册（宿主执行面已删除），toolEvo 走本地 fork 档
  }
  try {
    const t = transport || makeTransport(cfg, { logger })
    await t.init()
    const common = {
      transport: t,
      template: cfg.template || 'base',
      idleMs: cfg.idleMs,
      sandboxTtlMs: cfg.sandboxTtlMs,
      concurrencyWaitMs: cfg.concurrencyWaitMs,
      sweepIntervalMs: cfg.sweepIntervalMs,
      logger,
    }
    // 出口配置自检（含旧语义遗留的 deny-all 修正）：排障时「沙箱为什么没网」第一眼就能看到答案
    const { cfg: egressCfg, legacy } = withLegacyEgressFixed(cfg)
    const egress = buildEgressOpts(egressCfg)
    const audit = auditEgress(egressCfg)
    if (legacy) {
      // 直接调用本函数（脚本/测试/未来调用方）时也必须能看见这条迁移，不能静默忽略用户配置
      logger?.warn?.(`[sandbox] 出口配置 network.denyOut:["${legacy.from}"] 是 v1.24.0 之前的默认值（旧版语义=「兜底拒绝」）——`
        + '在当前语义（默认全放通、无白名单）下它等于**拒绝一切出口，含 DNS**，已就地忽略该条（本次不再下发 deny-all）；'
        + '请用 #沙箱诊断 修复 或手工删除该配置项以写回文件')
    }
    if (audit.level === 'warn') logger?.warn?.(`[sandbox] ${audit.message}`)
    logger?.info?.(`[sandbox] 出口网络：${audit.summary}`)
    const manager = new SandboxManager({
      ...common,
      maxSandboxes: cfg.maxSandboxes,
      network: egress.network,
      allowInternetAccess: egress.allowInternetAccess,
      networkSummary: audit.summary,
    })
    // 候选验证用独立 manager：出口**全关**（跑的是不可信候选代码，不需要任何网络）、
    // 一次性用完即毁、并发上限更小（避免候选验证挤占会话沙箱额度）
    const verifyEgress = buildEgressOpts(cfg, { denyAll: true })
    const verifyAudit = auditEgress(cfg, { denyAll: true })
    const verifyManager = new SandboxManager({
      ...common,
      template: cfg.verifyTemplate || cfg.template || 'base',
      maxSandboxes: Math.max(1, Math.min(2, Number(cfg.maxSandboxes) || 4)),
      network: verifyEgress.network,
      allowInternetAccess: verifyEgress.allowInternetAccess,
      networkSummary: verifyAudit.summary,
    })
    // 进化 stable 工具专用 manager：出口全关（进化工具只允许 none/read，绝不继承 terminal 的联网白名单）
    const evoManager = new SandboxManager({
      ...common,
      template: cfg.evoTemplate || cfg.template || 'base',
      maxSandboxes: cfg.maxSandboxes,
      network: verifyEgress.network,
      allowInternetAccess: verifyEgress.allowInternetAccess,
      networkSummary: verifyAudit.summary,
    })
    // 先建返回对象再挂方法：probe 失败要写回**调用方持有的那个对象**。
    // 曾写成 `{...base, probe(){ ... base.error = e ... }}`——base 是展开前的字面量，
    // 赋值落在副本上，调用方读 sandbox.error 永远是 null，预检失败被当成「无错误」。
    const handle = {
      ...base,
      transport: t,
      manager,
      verifyManager,
      evoManager,
      /** 实际下发的出口策略 + 自检结论（`#沙箱诊断`/面板/日志共用；migrated=旧语义 deny-all 被就地清理） */
      egress: {
        network: egress.network,
        allowInternetAccess: egress.allowInternetAccess,
        audit,
        migrated: !!legacy,
        migratedFrom: legacy?.from || null,
      },
      /** 可达性/鉴权预检（不抛：调用方据此决定提示用户还是继续） */
      async probe(timeoutMs = 3000) {
        try { await t.ping(timeoutMs); handle.error = null; return true } catch (e) { handle.error = e; return false }
      },
      async shutdown() {
        commands.clear()
        let n = 0
        try { n += await verifyManager.shutdown() } catch { /* noop */ }
        try { n += await evoManager.shutdown() } catch { /* noop */ }
        try { n += await manager.shutdown() } catch { /* noop */ }
        return n
      },
    }
    return handle
  } catch (e) {
    const info = classify(e) || { kind: 'unknown', retryable: false, detail: null }
    const err = e instanceof SandboxError ? e : new SandboxError(info.kind, `沙箱初始化失败：${info.detail || '未知原因'}`, { retryable: info.retryable, cause: e })
    try { logger?.warn?.(`[sandbox] 初始化失败（terminal 将不可用，fail-closed）：${err.message}`) } catch { /* noop */ }
    return { ...base, error: err }
  }
}
