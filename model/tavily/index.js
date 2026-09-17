/**
 * Tavily 搜索服务 —— 公共出口。
 *
 * ⚠️ 生产未使用：Tavily 实际经 model/search/providers/tavily.js 调用 client.js；
 * 本 barrel 的 makeTavilyTools 与多源 web_search 重名，勿注册（详见 ./tools.js 头注）。
 *
 * 用法：
 *   import { TavilyClient, makeTavilyTools } from '../../model/tavily/index.js'
 *   const client = new TavilyClient({ apiKey: 'tvly-xxx' })
 *   const tools = new ToolRegistry().register(...makeTavilyTools(client))
 *   // 或直接调用：
 *   const res = await client.search('AI Agent 2026', { include_answer: true, max_results: 5 })
 */

export { TavilyClient, TavilyError } from './client.js'
export {
  makeTavilySearchTool,
  makeTavilyExtractTool,
  makeTavilyTools,
  formatSearchResults,
  formatExtractResults,
} from './tools.js'
