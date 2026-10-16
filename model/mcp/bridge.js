/**
 * MCP 工具 → Agent ToolRegistry 桥接。
 * 一次 loadMcpTools，把某 MCP 服务端的所有工具注册为 Agent 统一工具；Agent 调用时经 client.callTool 回去。
 * 支持按工具粒度指定 RBAC category（接 policy.decide），实现"读工具放行、写工具审批、不同服务端不同信任级"。
 */

/**
 * 解析单个 MCP 工具的 RBAC 类别。
 * @param {object} tool MCP 工具（含 name）
 * @param categorySpec string | function(tool)=>string | { [toolName]: string, default?: string }
 * @returns {string} 类别名（如 'query'/'system'/'mcp_write'）
 */
export function resolveCategory(tool, categorySpec) {
  if (categorySpec == null) return 'query'
  if (typeof categorySpec === 'string') return categorySpec
  if (typeof categorySpec === 'function') {
    return categorySpec(tool) || 'query'
  }
  if (typeof categorySpec === 'object') {
    return categorySpec[tool.name] || categorySpec.default || 'query'
  }
  return 'query'
}

/**
 * 把 MCP tools/call 结果归一为 Agent 工具返回（字符串）。
 * 全文本内容 → 拼接文本；否则 → 结构化 JSON（含 content 与 isError）。
 */
export function mcpResultToString({ content, isError } = {}) {
  const items = Array.isArray(content) ? content : []
  const texts = items
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
  // 纯文本分支同样必须保留 isError：曾直接返回拼接文本，MCP 工具失败在
  // Agent（失败提示/账本 effectState）/AOP 日志/用量统计全链路被当成成功。
  if (items.length && texts.length === items.length) {
    const text = texts.join('\n')
    return isError ? JSON.stringify({ error: text || 'MCP 工具返回错误', isError: true }) : text
  }
  if (!items.length) return isError ? '{"error":true}' : ''
  return JSON.stringify({ content: items, isError: !!isError })
}

/**
 * @param {MCPClient} client
 * @param {ToolRegistry} registry
 * @param {object} opts { prefix?, category?(string|function|map), filter? }
 * @returns {Promise<number>} 注册的工具数
 */
export async function loadMcpTools(client, registry, { prefix, category = 'query', filter, logger } = {}) {
  if (!client || !registry) throw new Error('loadMcpTools 需要 client 与 registry')
  const { tools = [] } = await client.listTools()
  let registered = 0
  for (const tool of tools) {
    if (typeof filter === 'function' && !filter(tool)) continue
    const origName = tool.name
    const name = prefix ? `${prefix}__${origName}` : origName
    // 命名冲突防护：同名工具若已存在且不是 MCP 工具（内置/外置/进化工具），拒绝注册。
    // 曾无条件 unregister 再注册——服务端名/prefix 为空时 MCP 工具会以原名静默顶掉内置工具，
    // 连带摘除其 meta.shell / meta.alwaysConfirm 等沙箱与审批语义（registry.register 本身不查重）。
    const existing = registry.has(name) ? registry.get(name) : null
    if (existing && !existing.meta?.mcp) {
      logger?.('warn', `[mcp] 工具名冲突：${name} 已被内置工具占用，已跳过该 MCP 工具（请为该服务端配置 prefix）`)
      continue
    }
    if (existing) registry.unregister(name) // 同一 MCP 命名空间内的重连/刷新：允许重注册
    registry.register({
      name,
      description: tool.description || '',
      parameters: tool.inputSchema || { type: 'object', properties: {} },
      category: resolveCategory(tool, category),
      // logger 附在 meta（仅运行时用，不入 LLM 工具目录）：ToolRegistry AOP 据此用 mcp logger 打 info 级调用日志
      meta: { mcp: true, originalName: origName, logger },
      async execute(args) {
        try {
          const result = await client.callTool(origName, args || {})
          return mcpResultToString(result)
        } catch (e) {
          // 旁路传输错误（推送流断开/响应体非法等）会被 request() 归为超时类文案，
          // 这里补一句真实原因，否则调用方只能看到误导性的 "request timeout"（client.lastTransportError 曾无读取者）
          const te = client.lastTransportError
          const msg = e?.message || String(e)
          throw te && !String(msg).includes(te?.message || '\u0000')
            ? new Error(`${msg}（最近传输错误：${te?.message || te}）`)
            : e
        }
      },
    })
    registered++
  }
  // 返回实际注册数（曾返回 tools.length——被 filter 拒掉的工具也计入，#mcp 状态面板数字偏大）
  return registered
}
