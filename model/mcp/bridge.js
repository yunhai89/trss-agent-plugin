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
  if (items.length && texts.length === items.length) return texts.join('\n')
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
    if (registry.has(name)) registry.unregister(name)
    registry.register({
      name,
      description: tool.description || '',
      parameters: tool.inputSchema || { type: 'object', properties: {} },
      category: resolveCategory(tool, category),
      // logger 附在 meta（仅运行时用，不入 LLM 工具目录）：ToolRegistry AOP 据此用 mcp logger 打 info 级调用日志
      meta: { mcp: true, originalName: origName, logger },
      async execute(args) {
        const result = await client.callTool(origName, args || {})
        return mcpResultToString(result)
      },
    })
    registered++
  }
  // 返回实际注册数（曾返回 tools.length——被 filter 拒掉的工具也计入，#mcp 状态面板数字偏大）
  return registered
}
