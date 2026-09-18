/** SearXNG provider —— 自建元搜索引擎（无需 API Key，部署即用） */
export function createSearXNGProvider({ url = 'http://localhost:8080', fetcher, timeout = 15000 } = {}) {
  const f = fetcher || globalThis.fetch
  const base = url.replace(/\/+$/, '')
  return {
    name: 'searxng',
    available: () => !!url,
    async search(query, options = {}) {
      const params = new URLSearchParams({ q: query, format: 'json', pageno: '1' })
      if (options.language) params.set('language', options.language)
      if (options.time_range) params.set('time_range', options.time_range)
      if (options.categories) params.set('categories', options.categories)
      const res = await f(`${base}/search?${params}`, { signal: AbortSignal.timeout(timeout) })
      if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`)
      // SearXNG 默认只返回 HTML；必须带 format=json（上面已带），且实例 settings.yml 的
      // search.formats 需启用 json。若实例未开启，会回 HTML —— 这里给出可执行的报错，而不是 JSON 解析异常。
      const ctype = String(res.headers?.get?.('content-type') || '')
      if (ctype && !/json/i.test(ctype)) {
        const sample = await res.text().catch(() => '')
        throw new Error(`SearXNG 未返回 JSON（Content-Type: ${ctype}）——该实例未开启 json 格式：请在 settings.yml 的 search.formats 加入 json 后重启实例${sample ? `（响应片段：${String(sample).replace(/\s+/g, ' ').slice(0, 80)}）` : ''}`)
      }
      const json = await res.json()
      const results = (json.results || []).slice(0, options.max_results || 10).map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content || '',
        score: r.score != null ? r.score : null,
      }))
      return { provider: 'searxng', query, answer: null, results, citations: null, raw: json }
    },
  }
}
