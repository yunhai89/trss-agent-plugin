/**
 * 离线自检 —— mock fetch 驱动多源搜索。
 * 运行：node model/search/test.mjs
 */
import {
  createSearchManager,
  makeSearchTools,
  createTavilyProvider,
  createExaProvider,
  createPerplexityProvider,
  createBraveProvider,
  createSearXNGProvider,
  createDDGProvider,
  formatResults,
  formatExtract,
} from './index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

function mockFetch(json, { status = 200 } = {}) {
  return async () => ({
    ok: status < 400, status, headers: { get: () => null },
    async json() { return json }, async text() { return JSON.stringify(json) },
  })
}

function mockHtmlFetch(html) {
  return async () => ({ ok: true, status: 200, headers: { get: () => null }, async text() { return html } })
}

// ---------- 1. Tavily provider ----------
await test('provider/tavily：搜索 + 归一化', async () => {
  const f = mockFetch({ answer: '42', results: [{ title: 'A', url: 'https://a.com', content: '内容A', score: 0.9 }] })
  const p = createTavilyProvider({ apiKey: 'tvly-test', fetcher: f })
  ok(p.available(), 'available')
  const r = await p.search('test')
  eq(r.provider, 'tavily', 'provider name')
  eq(r.answer, '42', 'answer')
  eq(r.results[0].title, 'A', 'result title')
  eq(r.results[0].score, 0.9, 'score 透传')
})

// ---------- 2. Exa provider ----------
await test('provider/exa：语义搜索 + highlights', async () => {
  const f = mockFetch({ results: [{ title: '论文', url: 'https://arxiv.org/1', score: 0.82, highlights: ['关键段落1', '关键段落2'] }] })
  const p = createExaProvider({ apiKey: 'exa-test', fetcher: f })
  ok(p.available(), 'available')
  const r = await p.search('AI agent')
  eq(r.provider, 'exa', 'provider')
  eq(r.results[0].content, '关键段落1\n关键段落2', 'highlights → content')
})

// ---------- 3. Perplexity provider ----------
await test('provider/perplexity：答案引擎 + 引用', async () => {
  const f = mockFetch({
    choices: [{ message: { role: 'assistant', content: '答案是42' }, finish_reason: 'stop' }],
    citations: ['https://a.com', 'https://b.com'],
    search_results: [{ title: '来源A', url: 'https://a.com', date: '2026-01-01' }],
  })
  const p = createPerplexityProvider({ apiKey: 'pplx-test', fetcher: f })
  ok(p.available(), 'available')
  const r = await p.search('答案是什么')
  eq(r.answer, '答案是42', 'answer from content')
  eq(r.citations.length, 2, '2 citations')
  eq(r.results[0].title, '来源A', 'search_results → results')
})

// ---------- 4. Brave provider ----------
await test('provider/brave：独立索引搜索', async () => {
  const f = mockFetch({ web: { results: [{ title: 'B', url: 'https://b.com', description: '描述B' }] } })
  const p = createBraveProvider({ apiKey: 'bsa-test', fetcher: f })
  ok(p.available(), 'available')
  const r = await p.search('test')
  eq(r.provider, 'brave', 'provider')
  eq(r.results[0].content, '描述B', 'description → content')
})

// ---------- 5. SearXNG provider ----------
await test('provider/searxng：自建元搜索', async () => {
  const f = mockFetch({ results: [{ title: 'S', url: 'https://s.com', content: '内容S', score: 0.8 }] })
  const p = createSearXNGProvider({ url: 'http://localhost:8080', fetcher: f })
  ok(p.available(), 'available (有 URL)')
  const r = await p.search('test')
  eq(r.provider, 'searxng', 'provider')
  eq(r.results[0].title, 'S', 'result')
})

await test('provider/searxng：实例只回 HTML → 给出可执行报错（需开启 json 格式）', async () => {
  const f = async () => ({
    ok: true, status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    async text() { return '<!doctype html><html><body>searxng html</body></html>' },
    async json() { throw new Error('not json') },
  })
  const p = createSearXNGProvider({ url: 'http://localhost:8080', fetcher: f })
  let err = null
  try { await p.search('test') } catch (e) { err = e }
  ok(err && /json/i.test(err.message) && /formats|settings\.yml/i.test(err.message), '提示在 settings.yml 开启 json')
})

// ---------- 6. DDG provider ----------
await test('provider/ddg：本地兜底（始终可用）', async () => {
  const html = '<a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example</a><td class="result-snippet">an example site</td>'
  const f = mockHtmlFetch(html)
  const p = createDDGProvider({ fetcher: f })
  ok(p.available(), 'always available')
  const r = await p.search('test')
  eq(r.provider, 'ddg', 'provider')
  eq(r.results[0].url, 'https://example.com', 'URL 解码')
  eq(r.results[0].title, 'Example', 'title')
})

// ---------- 7. 管理器回退链 ----------
await test('manager：provider 失败 → 自动回退下一个', async () => {
  // tavily 抛错 → brave 成功
  const tavily = { name: 'tavily', available: () => true, async search() { throw new Error('tavily down') } }
  const brave = createBraveProvider({ apiKey: 'bsa', fetcher: mockFetch({ web: { results: [{ title: 'OK', url: 'https://ok.com', description: 'fallback works' }] } }) })
  const mgr = new (await import('./manager.js')).SearchManager({ providers: [tavily, brave] })
  const r = await mgr.search('test')
  eq(r.provider, 'brave', '回退到 brave')
  eq(r.results[0].title, 'OK', 'brave 结果')
})

// ---------- 8. createSearchManager：无 key → DDG 兜底 ----------
await test('createSearchManager：无 key → SearXNG → DDG', async () => {
  // 无 key、无 searxng → 只有 DDG
  const mgr1 = createSearchManager({ fetcher: mockHtmlFetch('<a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com">X</a><td class="result-snippet">snip</td>') })
  eq(mgr1.availableProviders, ['ddg'], '无 key → 只有 DDG')

  // 有 searxng → searxng + DDG
  const mgr2 = createSearchManager({ searxng: { url: 'http://localhost:8080' }, fetcher: mockFetch({ results: [{ title: 'S', url: 'https://s.com', content: 'c' }] }) })
  eq(mgr2.availableProviders, ['searxng', 'ddg'], 'SearXNG + DDG')

  // 有 tavily key → tavily + DDG
  const mgr3 = createSearchManager({ tavily: { apiKey: 'tvly-x' }, fetcher: mockFetch({ results: [] }) })
  eq(mgr3.availableProviders, ['tavily', 'ddg'], 'Tavily + DDG')
})

// ---------- 9. formatResults + formatExtract ----------
await test('formatResults / formatExtract', async () => {
  const text = formatResults({ answer: '42', results: [{ title: 'A', url: 'https://a.com', content: '内容', score: 0.9 }], citations: ['https://c.com'] })
  ok(text.includes('42') && text.includes('A') && text.includes('https://a.com') && text.includes('引用'), 'formatResults')
  ok(formatResults({ results: [] }) === '(无搜索结果)', '空结果')
  const ext = formatExtract({ results: [{ url: 'https://x.com', raw_content: '正文' }] })
  ok(ext.includes('正文'), 'formatExtract')
})

// ---------- 10. tools ----------
await test('makeSearchTools：注册 web_search + web_extract', async () => {
  const mgr = createSearchManager({ fetcher: mockHtmlFetch('<a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com">X</a><td class="result-snippet">snip</td>') })
  const tools = makeSearchTools(mgr)
  eq(tools.length, 2, '2 tools')
  eq(tools[0].name, 'web_search', 'web_search')
  eq(tools[1].name, 'web_extract', 'web_extract')
  const result = await tools[0].execute({ query: 'test' })
  ok(result.includes('X'), 'search 返回格式化结果')
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
