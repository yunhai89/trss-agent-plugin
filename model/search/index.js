/**
 * 统一搜索服务 —— 公共出口。
 *
 * 多源自动路由：Tavily / Exa / Perplexity / Brave → SearXNG → DDG 兜底。
 * 未配置任何 API Key 时自动回退 SearXNG（若部署），再回退 DDG 本地抓取。
 *
 * 用法：
 *   import { createSearchManager, makeSearchTools } from '../../model/search/index.js'
 *   const mgr = createSearchManager({
 *     tavily: { apiKey: 'tvly-...' },   // 可选
 *     exa: { apiKey: '...' },           // 可选
 *     searxng: { url: 'http://localhost:8080' }, // 可选
 *     // ddg: true (默认开启兜底)
 *   })
 *   const result = await mgr.search('AI Agent 2026')
 *   // 或注册为 Agent 工具：
 *   const tools = new ToolRegistry().register(...makeSearchTools(mgr))
 */

export { formatResults, formatExtract } from './base.js'
export { SearchManager, createSearchManager, mergeSearchResults } from './manager.js'
export { makeSearchTools } from './tools.js'
export { createTavilyProvider } from './providers/tavily.js'
export { createExaProvider } from './providers/exa.js'
export { createPerplexityProvider } from './providers/perplexity.js'
export { createBraveProvider } from './providers/brave.js'
export { createSearXNGProvider } from './providers/searxng.js'
export { createDDGProvider } from './providers/ddg.js'
