/**
 * DuckDuckGo Lite 搜索底层实现（零 API key）——供 model/search/providers/ddg.js 复用。
 * 注：原 `webSearchTool`（name=web_search）已移除，避免与 model/search/tools.js 的多源版 web_search 重名
 * （误注册会静默覆盖多源版）。多源版已含 DDG 兜底，本文件只保留 ddgSearch/parseDDG/stripHtml/decodeDDG。
 * fetcher 可注入便于离线测试；无则用 globalThis.fetch。
 */

export function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 解码 DDG lite 的 /l/?uddg=<encoded> 跳转 */
export function decodeDDG(u) {
  try {
    const m = String(u).match(/uddg=([^&]+)/)
    if (m) return decodeURIComponent(m[1])
  } catch { /* noop */ }
  return u
}

/** 解析 DDG Lite HTML → [{title,url,snippet}] */
export function parseDDG(html, limit = 5) {
  const out = []
  const links = []
  const snaps = []
  let m
  const reLink = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const reSnippet = /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi
  while ((m = reLink.exec(html))) links.push({ href: decodeDDG(m[1]), title: stripHtml(m[2]) })
  while ((m = reSnippet.exec(html))) snaps.push(stripHtml(m[1]))
  const n = Math.min(limit, links.length)
  for (let i = 0; i < n; i++) out.push({ title: links[i].title, url: links[i].href, snippet: snaps[i] || '' })
  return out
}

/** 解析 DDG HTML 版（html.duckduckgo.com/html/）→ [{title,url,snippet}] */
export function parseDDGHtml(html, limit = 5) {
  const out = []
  const links = []
  const snaps = []
  let m
  const reLink = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const reSnippet = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  while ((m = reLink.exec(html))) links.push({ href: decodeDDG(m[1]), title: stripHtml(m[2]) })
  while ((m = reSnippet.exec(html))) snaps.push(stripHtml(m[1]))
  const n = Math.min(limit, links.length)
  for (let i = 0; i < n; i++) out.push({ title: links[i].title, url: links[i].href, snippet: snaps[i] || '' })
  return out
}

const DDG_ENDPOINTS = [
  { url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseDDG },
  { url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDDGHtml },
]

/**
 * DDG 搜索：依次尝试 lite / html 两个端点（任一被限流/改版时另一个兜底）。
 * 端点正常响应但 0 结果 → 返回 []（交上层决定回退）；全部请求异常 → 抛最后一个错误。
 */
export async function ddgSearch(query, { limit = 5, fetcher, fetchOpts, timeout = 15000 } = {}) {
  const f = fetcher || globalThis.fetch
  if (!f) throw new Error('ddgSearch 需要 fetcher 或 globalThis.fetch')
  let anyOk = false
  let lastErr = null
  for (const ep of DDG_ENDPOINTS) {
    try {
      const opts = { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (agents-plugin)' }, ...fetchOpts }
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' && !opts.signal) {
        opts.signal = AbortSignal.timeout(timeout)
      }
      const res = await f(ep.url(query), opts)
      // 仅显式失败才算失败（注入的 mock fetcher 可能不带 ok 字段）
      if (res.ok === false || (typeof res.status === 'number' && res.status >= 400)) {
        lastErr = new Error(`DDG HTTP ${res.status ?? 'error'}`)
        continue
      }
      anyOk = true
      const results = ep.parse(await res.text(), limit)
      if (results.length) return results
    } catch (e) { lastErr = e }
  }
  if (anyOk) return [] // 端点可用但确实没结果
  throw lastErr || new Error('DDG 搜索失败')
}
