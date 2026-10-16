/**
 * SearchManager —— 多源搜索管理器（回退链）。
 * 优先级：API key providers（Tavily/Exa/Perplexity/Brave）→ SearXNG（自建）→ DDG（本地兜底）。
 * 任一 provider 失败则自动尝试下一个，直到成功或全部失败。
 */
import { createTavilyProvider } from './providers/tavily.js'
import { createExaProvider } from './providers/exa.js'
import { createPerplexityProvider } from './providers/perplexity.js'
import { createBraveProvider } from './providers/brave.js'
import { createSearXNGProvider } from './providers/searxng.js'
import { createDDGProvider } from './providers/ddg.js'

/**
 * 合并多查询搜索结果（供 web_search 多角度核验）。
 *  - 按 URL 去重（忽略协议外差异：大小写/hash/尾斜杠；同一页面被多个查询命中只保留一次）；
 *  - answers 按查询汇总；失败查询单列 failures——覆盖缺口必须让模型看见，才能如实说明"没查到"；
 *  - sources 汇总实际参与的去重源名，便于判断是否真正多源。
 * @param {Array<{query:string,result?:object,error?:string}>} items
 * @param {{maxResults?:number}} opts
 */
export function mergeSearchResults(items, { maxResults = 12 } = {}) {
  const norm = (u) => String(u || '').trim().toLowerCase().replace(/#.*$/, '').replace(/\/+$/, '')
  const seen = new Set()
  const results = []
  const answers = []
  const failures = []
  const providers = new Set()
  const queries = []
  for (const it of items || []) {
    const query = String(it?.query || '').trim()
    if (query) queries.push(query)
    if (it?.error) { failures.push({ query, error: String(it.error).slice(0, 200) }); continue }
    const res = it?.result
    if (!res) continue
    if (res.provider) providers.add(res.provider)
    for (const s of res.sources || []) providers.add(s)
    if (res.answer) answers.push({ query, answer: res.answer })
    for (const r of res.results || []) {
      const key = norm(r?.url)
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      if (results.length < maxResults) results.push({ ...r, query, source: res.provider || '' })
    }
  }
  return { provider: 'multi', queries, results, answers, failures, sources: [...providers] }
}

export class SearchManager {
  constructor({ providers = [], logger = () => {} } = {}) {
    this.providers = providers
    this.logger = logger
  }

  get availableProviders() {
    return this.providers.filter((p) => p.available()).map((p) => p.name)
  }

  async search(query, opts = {}) {
    const errs = []
    let tried = 0
    const triedNames = []
    let empty = null // 首个「源可用但无结果」的返回：全部源都空时作为兜底返回
    for (const p of this.providers) {
      if (!p.available()) continue
      tried++
      triedNames.push(p.name)
      try {
        const result = await p.search(query, opts)
        const n = result?.results?.length || 0
        this.logger('debug', `[search] ${p.name} → ${n} results`)
        // 有结果或带 AI 答案才算成功；否则继续尝试下一源（SearXNG 实例常返回 200 但 results=[]，
        // 此前直接 return 空结果 → 永不回退 DDG，表现为"搜索无结果"）
        if (n > 0 || result?.answer) return result
        if (!empty) empty = result
      } catch (e) {
        this.logger('warn', `[search] ${p.name} failed: ${e?.message || e}`)
        errs.push(`${p.name}: ${e?.message || e}`)
      }
    }
    if (!tried) throw new Error('无可用搜索源（未配置任何搜索 API Key，且未部署 SearXNG）')
    if (empty) {
      // 所有源都可用但都无结果：附上已尝试的源，便于模型/用户判断是"确实没有"还是"源有问题"
      this.logger('warn', `[search] 所有源均返回 0 结果（已试：${triedNames.join(', ')}）query=${String(query).slice(0, 80)}`)
      return { ...empty, sources: triedNames }
    }
    // 聚合每个源的真实失败原因，避免只抛出最后一个 "fetch failed" 让人无从排查
    throw new Error(`所有搜索源均失败 → ${errs.join('；')}`)
  }

  /**
   * 多查询并行搜索（同一主题换角度/换来源/找反证）→ 去重合并。
   * 单查询失败不影响其他查询；失败与覆盖缺口通过 failures 如实返回（不静默）。
   * @param {string[]} queries 查询列表（最多 4 条）
   * @param {object} opts 同 search()
   */
  async searchMany(queries, opts = {}) {
    const list = (Array.isArray(queries) ? queries : [queries])
      .map((q) => String(q || '').trim())
      .filter(Boolean)
      .slice(0, 4)
    if (!list.length) throw new Error('缺少查询词（queries 为空）')
    const settled = await Promise.allSettled(list.map((q) => this.search(q, opts)))
    const items = settled.map((s, i) => (s.status === 'fulfilled'
      ? { query: list[i], result: s.value }
      : { query: list[i], error: s.reason?.message || String(s.reason) }))
    const merged = mergeSearchResults(items)
    const n = merged.results.length
    this.logger('debug', `[search] searchMany ${list.length} queries → ${n} merged results${merged.failures.length ? `（${merged.failures.length} 条查询失败）` : ''}`)
    return merged
  }

  async extract(urls, opts = {}) {
    const errs = []
    let tried = 0
    for (const p of this.providers) {
      if (!p.available() || !p.extract) continue
      tried++
      try {
        return await p.extract(urls, opts)
      } catch (e) {
        this.logger('warn', `[extract] ${p.name} failed: ${e?.message || e}`)
        errs.push(`${p.name}: ${e?.message || e}`)
      }
    }
    if (!tried) throw new Error('无可用提取源（未配置搜索 API Key，且未部署 SearXNG）')
    throw new Error(`所有提取源均失败 → ${errs.join('；')}`)
  }
}

/**
 * 从配置构建 SearchManager。
 * config: { tavily:{apiKey,timeout?}, exa:{apiKey,timeout?}, perplexity:{apiKey,timeout?}, brave:{apiKey,timeout?},
 *           searxng:{url,timeout?}, ddg:true|{timeout?}, timeout?, fetcher, logger }
 * 回退链：已配置的 API key provider → SearXNG → DDG（始终兜底）
 *
 * timeout：各 provider 工厂都支持 timeout，但旧实现从不传 → 用户配的超时被各源默认值静默覆盖
 * （本轮外部服务客户端审计第 4 条 / 既有 L-106，DDG 更是完全没地方配）。现在接上：
 * 单个来源的 timeout 优先，其次全局 config.timeout；都没配就不传，保持各 provider 原默认值（向后兼容）。
 */
export function createSearchManager(config = {}) {
  const providers = []
  const fetcher = config.fetcher

  const timeoutOf = (name) => {
    const per = (name === 'ddg' && typeof config.ddg === 'object') ? config.ddg?.timeout : config?.[name]?.timeout
    const n = Number(per ?? config.timeout)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const withTimeout = (name, opts) => {
    const t = timeoutOf(name)
    return t ? { ...opts, timeout: t } : opts
  }

  if (config.tavily?.apiKey) providers.push(createTavilyProvider(withTimeout('tavily', { ...config.tavily, fetcher })))
  if (config.exa?.apiKey) providers.push(createExaProvider(withTimeout('exa', { ...config.exa, fetcher })))
  if (config.perplexity?.apiKey) providers.push(createPerplexityProvider(withTimeout('perplexity', { ...config.perplexity, fetcher })))
  if (config.brave?.apiKey) providers.push(createBraveProvider(withTimeout('brave', { ...config.brave, fetcher })))

  // SearXNG（自建，无需 key）
  if (config.searxng?.url) providers.push(createSearXNGProvider(withTimeout('searxng', { ...config.searxng, fetcher })))

  // DDG 本地兜底（始终最后）
  if (config.ddg !== false) providers.push(createDDGProvider(withTimeout('ddg', { fetcher })))

  return new SearchManager({ providers, logger: config.logger || (() => {}) })
}
