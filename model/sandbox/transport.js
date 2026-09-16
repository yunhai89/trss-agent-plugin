/**
 * E2B transport —— 全仓**唯一**接触 `e2b` npm 包的地方（懒加载 + 薄封装）。
 *
 * 分层理由：SDK 只在这里出现，上层（manager/shell/toolEvo）只依赖本模块暴露的原语形状，
 * 因此离线单测可以注入同形状的桩 transport，覆盖命令映射/生命周期/限额/失败语义，
 * 不需要装 E2B、不需要联网（与 model/crawl/crawl4ai.test.mjs 的桩子进程范式一致）。
 *
 * 契约（桩必须实现同样形状）：init / ping / create / connect / run / write / writeMany /
 *   kill / setTimeout / list / updateNetwork。handle 是 `{ id, raw }`，raw 为 SDK 实例。
 */
import path from 'node:path'

import { SandboxError } from './errors.js'

/** 沙箱 metadata 标记（用于运维在控制台辨认来源；不做孤儿回收，靠 TTL 自回收） */
export const SANDBOX_METADATA_TAG = 'trss-agent-plugin'

let _sdkPromise = null
/** 懒加载 e2b；装载失败重抛为结构化 SandboxError（不缓存失败，允许装包后热恢复） */
function loadSdk() {
  if (!_sdkPromise) {
    _sdkPromise = import('e2b').catch((e) => {
      _sdkPromise = null
      throw new SandboxError('unconfigured', `e2b SDK 装载失败：${e?.message || e}（请先 pnpm add e2b）`)
    })
  }
  return _sdkPromise
}

/** 给任意 Promise 加超时（ping 用；不依赖 SDK 的 requestTimeoutMs）。
 *  定时器不 unref：它守护的是在飞行调用，unref 会让事件循环一空就永不触发。 */
function withTimeout(fn, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SandboxError('timeout', `操作超过 ${ms}ms 未返回`)), ms)
    Promise.resolve()
      .then(fn)
      .then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

function wrap(raw) {
  if (!raw) throw new SandboxError('unknown', '创建沙箱未返回实例')
  return { id: String(raw.sandboxId || ''), raw }
}

/**
 * 构造 transport。
 * @param {object} cfg agent.sandbox 配置（apiKey/apiUrl/domain/sandboxUrl/requestTimeoutMs/retries/proxy）
 * @param {object} [opt] { logger }
 */
export function makeTransport(cfg = {}, { logger = null } = {}) {
  let SandboxCls = null
  const log = typeof logger === 'function' ? logger : null

  const transport = {
    name: 'e2b',

    /** 装载 SDK 并构造绑定配置的客户端（cloud: 只填 apiKey；自托管: 再填 apiUrl/domain/sandboxUrl） */
    async init() {
      const sdk = await loadSdk()
      const opts = {
        apiKey: String(cfg.apiKey || ''),
        ...(cfg.domain ? { domain: String(cfg.domain) } : {}),
        ...(cfg.apiUrl ? { apiUrl: String(cfg.apiUrl) } : {}),
        ...(cfg.sandboxUrl ? { sandboxUrl: String(cfg.sandboxUrl) } : {}),
        ...(Number(cfg.requestTimeoutMs) > 0 ? { requestTimeoutMs: Number(cfg.requestTimeoutMs) } : {}),
        ...(Number.isFinite(Number(cfg.retries)) ? { retries: Number(cfg.retries) } : {}),
        ...(cfg.proxy ? { proxy: String(cfg.proxy) } : {}),
      }
      // E2B 客户端把连接配置绑到资源类上，避免每次调用都要重传 apiKey/domain
      const client = typeof sdk.E2B === 'function' ? new sdk.E2B(opts) : null
      SandboxCls = client?.Sandbox || sdk.Sandbox
      if (!SandboxCls) throw new SandboxError('unconfigured', 'e2b SDK 未导出 Sandbox（版本不兼容？）')
      return transport
    },

    /** 可达性 + 鉴权预检（限时；失败抛结构化错误，由调用方决定是 SKIPPED 还是失败） */
    async ping(timeoutMs = 3000) {
      await withTimeout(async () => {
        const page = SandboxCls.list({ limit: 1 })
        if (page && typeof page.nextItems === 'function') await page.nextItems()
      }, timeoutMs)
      return true
    },

    async create({ template = 'base', timeoutMs, metadata = {}, envs = {}, network = null, allowInternetAccess = false, secure = true } = {}) {
      const raw = await SandboxCls.create(template, {
        timeoutMs,
        metadata: { ...metadata, plugin: SANDBOX_METADATA_TAG },
        ...(Object.keys(envs).length ? { envs } : {}),
        ...(network ? { network } : {}),
        allowInternetAccess: !!allowInternetAccess,
        secure: secure !== false,
      })
      return wrap(raw)
    },

    async connect(id, { timeoutMs } = {}) {
      const raw = await SandboxCls.connect(String(id), { ...(timeoutMs ? { timeoutMs } : {}) })
      return wrap(raw)
    },

    /**
     * 启动命令并返回 SDK 的 CommandHandle（**必须 background**：前台执行拿不到句柄就无法 abort/kill）。
     * 上层用 handle.wait() / handle.kill() / stdout / stderr / exitCode。
     */
    async run(handle, command, { cwd, envs, timeoutMs, onStdout, onStderr } = {}) {
      return handle.raw.commands.run(String(command), {
        background: true,
        ...(cwd ? { cwd } : {}),
        ...(envs && Object.keys(envs).length ? { envs } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(onStdout ? { onStdout } : {}),
        ...(onStderr ? { onStderr } : {}),
      })
    },

    async write(handle, absPath, content) {
      const dir = path.posix.dirname(String(absPath))
      try { await handle.raw.files.makeDir(dir) } catch { /* 已存在或父目录自动创建失败 → 让 write 报真实错误 */ }
      await handle.raw.files.write(String(absPath), String(content))
    },

    /** 批量写入（一次 RPC；制品多文件场景用）。失败时抛错，由上层转结构化失败 */
    async writeMany(handle, files) {
      const list = (files || []).filter((f) => f && f.path)
      if (!list.length) return
      const dirs = [...new Set(list.map((f) => path.posix.dirname(String(f.path))))]
      for (const d of dirs) {
        try { await handle.raw.files.makeDir(d) } catch { /* noop */ }
      }
      if (typeof handle.raw.files.writeFiles === 'function') {
        await handle.raw.files.writeFiles(list.map((f) => ({ path: String(f.path), data: String(f.data ?? '') })))
        return
      }
      for (const f of list) await handle.raw.files.write(String(f.path), String(f.data ?? ''))
    },

    async kill(handle) {
      try { return await handle.raw.kill() } catch (e) { log?.('warn', `[sandbox] 销毁失败（可能已过期）：${e?.message || e}`); return false }
    },

    /** 续期 TTL（未过期时；过期会重建） */
    async setTimeout(handle, ms) {
      await handle.raw.setTimeout(Number(ms))
    },

    async updateNetwork(handle, network) {
      await handle.raw.updateNetwork(network)
    },

    /** 列表（运维/排障用；不做自动回收） */
    async list({ metadata = null, limit = 20 } = {}) {
      const page = SandboxCls.list({ limit, ...(metadata ? { query: { metadata } } : {}) })
      const items = page && typeof page.nextItems === 'function' ? await page.nextItems() : []
      return (items || []).map((s) => ({ id: String(s.sandboxId || s.id || ''), metadata: s.metadata || {}, endAt: s.endAt || null, state: s.state || null }))
    },
  }

  return transport
}
