/**
 * 沙箱运行时装配（E2B Firecracker microVM）。
 *
 * 对外职责：
 *   - 读 agent.sandbox 配置 → 构造 transport + manager（可注入桩 transport 做离线测试）
 *   - 装配失败**不抛穿**：返回 manager:null + error，由工具层落成 fail-closed 结构化失败
 *     （配置错/未装包不该把整个 buildRuntime 拖垮，与 stagehand/toolEvo 的降级姿态一致）
 *   - 提供会话绑定键、网络出口选项、单会话命令数计数器的构造
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
 * 组合（denyAll 用于候选验证这类不需要出口的一次性沙箱）：
 *   - 有白名单 → allowOut 白名单 + denyOut 全拒 + allowInternetAccess:true（白名单可达，其余全拒）；
 *   - 无白名单 + allowInternet:true → 不下发 allowOut/denyOut + allowInternetAccess:true（显式全网放行）；
 *   - 无白名单 + allowInternet:false（默认）→ denyOut 全拒 + allowInternetAccess:false（全网拒绝）。
 * @param {object} cfg agent.sandbox
 * @param {{denyAll?:boolean}} [opt]
 * @returns {{network:object, allowInternetAccess:boolean}}
 */
export function buildEgressOpts(cfg = {}, { denyAll = false } = {}) {
  const net = cfg.network || {}
  const allowOut = denyAll ? [] : (Array.isArray(net.allowOut) ? net.allowOut.map((s) => String(s)).filter(Boolean) : [])
  const denyOut = Array.isArray(net.denyOut) && net.denyOut.length ? net.denyOut.map((s) => String(s)) : ['0.0.0.0/0']
  // 白名单存在时也必须放通"互联网开关"，否则 deny 语义可能盖过 allow；实际可达范围由 allowOut 收窄。
  const allowInternetAccess = !denyAll && (net.allowInternet === true || allowOut.length > 0)
  const network = { allowPublicTraffic: cfg.allowPublicTraffic === true }
  if (allowOut.length) {
    network.allowOut = allowOut
    network.denyOut = denyOut
  } else if (!allowInternetAccess) {
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
    const egress = buildEgressOpts(cfg)
    const manager = new SandboxManager({
      ...common,
      maxSandboxes: cfg.maxSandboxes,
      network: egress.network,
      allowInternetAccess: egress.allowInternetAccess,
    })
    // 候选验证用独立 manager：出口**全关**（跑的是不可信候选代码，不需要任何网络）、
    // 一次性用完即毁、并发上限更小（避免候选验证挤占会话沙箱额度）
    const verifyEgress = buildEgressOpts(cfg, { denyAll: true })
    const verifyManager = new SandboxManager({
      ...common,
      template: cfg.verifyTemplate || cfg.template || 'base',
      maxSandboxes: Math.max(1, Math.min(2, Number(cfg.maxSandboxes) || 4)),
      network: verifyEgress.network,
      allowInternetAccess: verifyEgress.allowInternetAccess,
    })
    return {
      ...base,
      transport: t,
      manager,
      verifyManager,
      /** 可达性/鉴权预检（不抛：调用方据此决定提示用户还是继续） */
      async probe(timeoutMs = 3000) {
        try { await t.ping(timeoutMs); return true } catch (e) { base.error = e; return false }
      },
      async shutdown() {
        commands.clear()
        let n = 0
        try { n += await verifyManager.shutdown() } catch { /* noop */ }
        try { n += await manager.shutdown() } catch { /* noop */ }
        return n
      },
    }
  } catch (e) {
    const info = classify(e) || { kind: 'unknown', retryable: false, detail: null }
    const err = e instanceof SandboxError ? e : new SandboxError(info.kind, `沙箱初始化失败：${info.detail || '未知原因'}`, { retryable: info.retryable, cause: e })
    try { logger?.warn?.(`[sandbox] 初始化失败（terminal 将不可用，fail-closed）：${err.message}`) } catch { /* noop */ }
    return { ...base, error: err }
  }
}
