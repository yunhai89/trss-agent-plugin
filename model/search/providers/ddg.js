/** DDG provider —— DuckDuckGo Lite HTML 抓取，零 Key 本地兜底（始终可用） */
import { ddgSearch } from '../../agent/tools/web.js'

export function createDDGProvider({ fetcher, timeout = 15000 } = {}) {
  return {
    name: 'ddg',
    available: () => true,
    async search(query, options = {}) {
      const results = await ddgSearch(query, { limit: options.max_results || 5, fetcher, timeout })
      return {
        provider: 'ddg', query,
        answer: null,
        results: results.map((r) => ({ title: r.title, url: r.url, content: r.snippet || '', score: null })),
        citations: null, raw: results,
      }
    },
  }
}
