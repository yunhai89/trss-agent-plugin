/**
 * Tavily Agent 工具 —— 包装 TavilyClient 为 ToolRegistry 兼容工具。
 * 在 Agent 中替换 DDG 兜底，提供高质量 AI 搜索结果 + 内容提取。
 *
 * ⚠️ 未接入生产（有意保留）：这些工具的 name（web_search/web_extract）与 apps 已注册的
 * 多源工具（model/search/tools.js，经 search/manager 路由到 Tavily 等 provider）重名，
 * 注册会遮蔽现网工具。Tavily 生产路径是 model/tavily/client.js → search/providers/tavily.js；
 * 本文件仅供库导出与离线测试使用，勿在 ToolRegistry 注册。
 */

function truncate(s, n) {
  s = String(s || '')
  return s.length > n ? `${s.slice(0, n)}...` : s
}

function pick(obj, keys) {
  const o = {}
  for (const k of keys) if (obj[k] != null) o[k] = obj[k]
  return o
}

/** 格式化搜索结果为 Agent 可消费的简洁文本 */
export function formatSearchResults(res) {
  const parts = []
  if (res.answer) parts.push(`💡 ${res.answer}`)
  if (res.results?.length) {
    const items = res.results.slice(0, 10).map((r, i) =>
      `[${i + 1}] ${r.title || '(无标题)'} (score: ${(r.score || 0).toFixed(2)})\n    ${r.url}\n    ${truncate(r.content, 500)}`,
    )
    parts.push(items.join('\n\n'))
  }
  if (res.images?.length) parts.push(`📷 ${res.images.slice(0, 3).join(' ')}`)
  return parts.join('\n\n') || '(无搜索结果)'
}

/** 格式化提取结果为简洁文本 */
export function formatExtractResults(res) {
  const ok = (res.results || []).map((r) => `${r.url}:\n${truncate(r.raw_content, 2000)}`)
  const failed = (res.failed_results || []).map((f) => `❌ ${f.url}`)
  const parts = [...ok]
  if (failed.length) parts.push(`提取失败的 URL：\n${failed.join('\n')}`)
  return parts.join('\n\n---\n\n') || '(无内容)'
}

/**
 * 构造 web_search 工具（Tavily Search API）。
 * @param {TavilyClient} client
 * @param {object} defaults 默认参数（include_answer/max_results/search_depth 等）
 */
export function makeTavilySearchTool(client, defaults = {}) {
  return {
    name: 'web_search',
    description: '联网搜索（Tavily API）。输入查询词，返回 AI 排序后的相关结果（标题/链接/摘要）+ 可选 AI 生成答案。用于获取实时信息或超出知识范围的内容。',
    category: 'query',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询' },
        max_results: { type: 'integer', description: '返回结果数（1-20，默认5）' },
        topic: { type: 'string', enum: ['general', 'news', 'finance'], description: '搜索类别' },
        time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '时间过滤' },
        search_depth: { type: 'string', enum: ['basic', 'advanced', 'fast', 'ultra-fast'], description: '搜索深度（basic 省钱，advanced 高精度）' },
      },
      required: ['query'],
    },
    async execute(params = {}) {
      const opts = {
        include_answer: 'basic',
        max_results: 5,
        search_depth: 'basic',
        ...defaults,
        ...pick(params, ['max_results', 'topic', 'time_range', 'search_depth', 'include_answer', 'include_domains', 'exclude_domains', 'country']),
      }
      const res = await client.search(params.query, opts)
      return formatSearchResults(res)
    },
  }
}

/**
 * 构造 web_extract 工具（Tavily Extract API）。
 */
export function makeTavilyExtractTool(client, defaults = {}) {
  return {
    name: 'web_extract',
    description: '从指定 URL 提取干净的正文内容（Markdown）。输入 URL（单个字符串或数组），返回清洗后的正文。用于深入阅读某个网页。',
    category: 'query',
    parameters: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: '要提取的 URL 列表（1-20 个）' },
        extract_depth: { type: 'string', enum: ['basic', 'advanced'], description: '提取深度（advanced 能拿表格等更多内容）' },
      },
      required: ['urls'],
    },
    async execute(params = {}) {
      const opts = { format: 'markdown', ...defaults, ...pick(params, ['extract_depth', 'format', 'query', 'chunks_per_source']) }
      const res = await client.extract(params.urls, opts)
      return formatExtractResults(res)
    },
  }
}

/** 一次返回 [searchTool, extractTool]，便于 registry.register(...makeTavilyTools(client)) */
export function makeTavilyTools(client, defaults = {}) {
  return [makeTavilySearchTool(client, defaults), makeTavilyExtractTool(client, defaults)]
}
