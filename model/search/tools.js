/** Agent 工具 —— 包装 SearchManager 为 ToolRegistry 兼容工具 */
import { formatResults, formatExtract } from './base.js'

function pick(obj, keys) {
  const o = {}
  for (const k of keys) if (obj[k] != null) o[k] = obj[k]
  return o
}

export function makeSearchTools(manager, defaults = {}) {
  return [
    {
      name: 'web_search',
      description: '联网搜索（多源自动路由：Tavily/Exa/Perplexity/Brave → SearXNG → 本地 DDG 兜底）。输入查询词，返回排序后的相关结果 + 可选 AI 答案；用于获取实时信息或超出知识范围的内容。核验关键事实时用 queries 一次并行发 2~4 个不同角度（官方一手/不同措辞/找反证），结果按 URL 去重合并；部分查询失败会显式提示覆盖缺口，不要据此断言"只有一种说法"。',
      category: 'query',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '单个搜索查询（简单问题用它；需要多角度核验时改用 queries）' },
          queries: {
            type: 'array', items: { type: 'string' }, maxItems: 4,
            description: '并行多角度查询（2~4 条：同一事实换措辞/换来源/官方一手/反方观点/辟谣反证），与 query 二选一；结果自动去重合并',
          },
          include_domains: { type: 'array', items: { type: 'string' }, description: '只在指定域名内搜索（如官方站点，用于核对一手来源）' },
          exclude_domains: { type: 'array', items: { type: 'string' }, description: '排除指定域名（如已知内容农场）' },
          max_results: { type: 'integer', description: '返回结果数（默认 5-10）' },
          topic: { type: 'string', description: '搜索类别（general/news/finance）' },
          time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '时间过滤' },
        },
      },
      async execute(params = {}) {
        const opts = { ...defaults, ...pick(params, ['max_results', 'topic', 'time_range', 'search_depth', 'include_domains', 'exclude_domains', 'country']) }
        const queries = []
        if (Array.isArray(params.queries)) {
          for (const q of params.queries) { const s = String(q || '').trim(); if (s) queries.push(s) }
        }
        const single = String(params.query || '').trim()
        if (single) queries.unshift(single)
        const list = [...new Set(queries)].slice(0, 4)
        if (!list.length) return '(未提供查询词：请用 query 或 queries)'
        if (list.length === 1) return formatResults(await manager.search(list[0], opts))
        return formatResults(await manager.searchMany(list, opts))
      },
    },
    {
      name: 'web_extract',
      description: '从指定 URL 提取干净的正文内容。输入 URL 列表，返回清洗后的正文。核对关键来源/交叉验证时用它读一手页面正文（搜索摘要可能断章取义）；多个来源分别提取后对比。',
      category: 'query',
      meta: { resultCap: 12000 },
      parameters: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, description: '要提取的 URL 列表' },
        },
        required: ['urls'],
      },
      async execute(params = {}) {
        try {
          const res = await manager.extract(params.urls)
          return formatExtract(res)
        } catch (e) {
          return `(提取失败：${e?.message || e})`
        }
      },
    },
  ]
}
