/**
 * McpManager —— 多 MCP 服务端编排。
 * 按配置连接多个服务端（stdio 子进程 / HTTP），各自工具以 `${prefix}__${tool}` 命名空间
 * 注册进同一个 ToolRegistry，避免跨服务端工具名冲突；提供统一 status / remove / stop。
 *
 * 服务端配置：
 *   { transport?: 'stdio'|'http', command?, args?, env?, cwd?      // stdio
 *     url?, headers?, listen?, sessionId?, fetcher?                 // http
 *     prefix?, category?, filter?, enabled?, clientInfo?, requestTimeout?,
 *     onSampling?, onRoots?, onElicitation? }
 */

import { MCPClient } from './client.js'
import { StdioTransport } from './transport/stdio.js'
import { HttpTransport } from './transport/http.js'
import { loadMcpTools } from './bridge.js'

/**
 * 归一化单个服务端配置：兼容 Claude Desktop / Z.AI 等标准格式。
 *   - type: 'stdio'|'http'|'sse'|'streamable' → transport
 *   - 其余字段（command/args/env/cwd、url/headers...）原样保留
 */
export function normalizeServerCfg(cfg = {}) {
  const c = { ...cfg }
  if (c.type && !c.transport) {
    const t = String(c.type).toLowerCase()
    if (t === 'http' || t === 'sse' || t === 'streamable' || t === 'streamable-http') c.transport = 'http'
    else c.transport = 'stdio'
  }
  return c
}

/** 解包 { mcpServers: {...} } 包装（Claude Desktop 格式），返回 { name: cfg } */
export function unwrapServers(servers = {}) {
  if (servers && typeof servers === 'object' && servers.mcpServers && typeof servers.mcpServers === 'object') {
    return servers.mcpServers
  }
  return servers
}

export function buildTransport(cfg = {}) {
  const c = normalizeServerCfg(cfg)
  // 预构建的传输实例直接复用（便于测试注入）
  if (c.transport && typeof c.transport === 'object') return c.transport
  if (c.transport === 'http' || (!c.transport && c.url)) {
    return new HttpTransport({
      url: c.url,
      headers: c.headers || {},
      sessionId: c.sessionId,
      listen: c.listen,
      fetcher: c.fetcher,
      requestTimeout: c.requestTimeout,
    })
  }
  // 默认 stdio
  if (!c.command) throw new Error(`MCP 服务端配置需要 command(stdio) 或 url(http)`)
  return new StdioTransport({ command: c.command, args: c.args || [], env: c.env, cwd: c.cwd })
}

export class McpManager {
  constructor({ registry, logger = () => {}, requestTimeout } = {}) {
    if (!registry) throw new Error('McpManager 需要 registry')
    this.registry = registry
    this.logger = logger
    this.requestTimeout = requestTimeout
    this._entries = new Map()
  }

  _prefix(cfg, name) {
    // 前缀决定命名空间：必须非空。曾允许空串（显式 `prefix: ""` 或服务端名为空）→
    // 工具以原名注册，可静默覆盖内置工具。这里逐级回退：配置前缀 → 服务端名 → 'mcp'
    const raw = cfg.prefix != null ? cfg.prefix : name
    const p = String(raw ?? '').trim()
    return p || String(name ?? '').trim() || 'mcp'
  }

  async add(name, cfg = {}) {
    if (this._entries.has(name)) await this.remove(name)
    const transport = buildTransport({ ...cfg, name })
    // 上报子进程 stderr（npx 下载失败/包不存在/服务端崩溃等原因才可见，否则只剩 timeout）。
    // BaseTransport 的 onLog 只有 setter、没有 getter，读 transport.onLog 恒为 undefined——
    // 曾用 `typeof transport.onLog !== 'undefined'` 判断，恒为 false，stderr 实时上报从未生效。
    if (transport) {
      try { transport.onLog = (chunk) => this.logger('warn', `${name} stderr: ${String(chunk).trim()}`) } catch { /* 非 BaseTransport：忽略 */ }
    }
    const client = new MCPClient({
      logger: this.logger,
      transport,
      clientInfo: cfg.clientInfo,
      requestTimeout: cfg.requestTimeout || this.requestTimeout,
    })
    if (cfg.onSampling) client.onSampling = cfg.onSampling
    if (cfg.onRoots) client.onRoots = cfg.onRoots
    if (cfg.onElicitation) client.onElicitation = cfg.onElicitation

    const entry = { name, client, config: cfg, status: 'connecting', tools: 0, error: null }
    this._entries.set(name, entry)
    try {
      await client.connect()
      const prefix = this._prefix(cfg, name)
      const count = await loadMcpTools(client, this.registry, { prefix, category: cfg.category, filter: cfg.filter, logger: this.logger })
      entry.tools = count
      entry.status = 'connected'
      this.logger('info', `${name} 已连接，注册 ${count} 个工具（${prefix}__*）`)
    } catch (e) {
      entry.status = 'error'
      entry.error = this._formatConnectError(e, cfg)
      // 握手失败也必须关闭 transport：stdio 服务端此时已 spawn（起得来但握手失败：鉴权错/协议不兼容/
      // 挂起超时），不 close 会留下常驻僵尸子进程，直到 #停止mcp / 配置重载 / 进程退出才回收。
      try { await client.close() } catch { /* noop */ }
      this.logger('error', `${name} 连接失败：${entry.error}`)
    }
    return entry
  }

  /** 握手失败时补充命令行与排查提示，避免只剩一句看不懂的 "request timeout: initialize" */
  _formatConnectError(e, cfg) {
    const msg = e?.message || String(e)
    if (!/initialize|transport closed|request timeout|传输关闭|channel closed/i.test(msg)) return msg
    const cmd = cfg.command ? `${cfg.command} ${(cfg.args || []).join(' ')}`.trim() : (cfg.url || '')
    return `${msg}${cmd ? `\n  命令：${cmd}` : ''}\n  常见原因：① command 不在运行环境 PATH（pm2/systemd/docker 常见，改用 node/npx 绝对路径）② 服务端启动即崩溃（缺 API Key / 依赖 / Node 版本，看上方 stderr 末尾）③ npx 首次下载超时（网络慢或被墙，先手动 npm i -g 装好）`
  }

  async remove(name) {
    const e = this._entries.get(name)
    if (!e) return
    const prefix = this._prefix(e.config, name)
    for (const t of this.registry.list()) {
      if (t.name === prefix || t.name.startsWith(`${prefix}__`)) this.registry.unregister(t.name)
    }
    try { await e.client.close() } catch { /* noop */ }
    this._entries.delete(name)
  }

  /** 批量启动；servers 为 { name: cfg } 或 [{ name, ...cfg }] 或 { mcpServers: {...} }；enabled:false 跳过 */
  async start(servers = {}) {
    servers = unwrapServers(servers)
    const list = Array.isArray(servers)
      ? servers.map((s) => [s.name, s]).filter(([_, c]) => c && c.enabled !== false)
      : Object.entries(servers).filter(([_, c]) => c && c.enabled !== false)
    await Promise.allSettled(list.map(([n, c]) => this.add(n, c)))
  }

  async stop() {
    for (const name of [...this._entries.keys()]) await this.remove(name)
  }

  status() {
    const out = {}
    for (const [name, e] of this._entries) {
      out[name] = { status: e.status, tools: e.tools, serverInfo: e.client.serverInfo, error: e.error }
    }
    return out
  }

  get(name) { return this._entries.get(name)?.client || null }
  get size() { return this._entries.size }
}
