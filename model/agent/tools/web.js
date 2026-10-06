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

const VOID_TAGS = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr'])

/** 解析一个标签串的属性（单/双引号、无引号均支持，属性顺序无关） */
function parseAttrs(attrStr) {
  const attrs = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m
  while ((m = re.exec(attrStr))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  return attrs
}

/**
 * 收集 class 含 needle 的元素（任意标签、属性顺序/引号样式无关）。
 * DDG 改版可能把 class 放在 `<a>` 或外层 `<td>`，也可能把 href 放在 class 之前——旧正则只认
 * 「双引号 + class 在 href 前 + class 在 <a> 上」，改版即整页解析为空。这里按「逐个开标签 + 找同名闭标签」
 * 扫描，兼容这些形态。
 */
function elementsByClass(html, needle) {
  const out = []
  const src = String(html || '')
  const openRe = /<([a-zA-Z][\w:-]*)\b([^>]*)>/g
  let m
  while ((m = openRe.exec(src))) {
    const tag = m[1].toLowerCase()
    if (VOID_TAGS.has(tag)) continue
    const attrs = parseAttrs(m[2])
    if (!attrs.class) continue
    if (!attrs.class.split(/\s+/).includes(needle)) continue
    const rest = src.slice(openRe.lastIndex)
    const cm = new RegExp(`</${tag}\\s*>`, 'i').exec(rest)
    out.push({ tag, attrs, inner: cm ? rest.slice(0, cm.index) : '' })
  }
  return out
}

/** 取结果链接：元素自身是 <a> 用其 href；class 在外层（如 <td>）则取内部第一个 <a> 的 href */
function hrefOf(el) {
  if (el.attrs.href) return decodeDDG(el.attrs.href)
  const a = /<a\b([^>]*)>/i.exec(el.inner || '')
  if (a) {
    const at = parseAttrs(a[1])
    if (at.href) return decodeDDG(at.href)
  }
  return ''
}

function parseByClasses(html, linkClass, snippetClass, limit = 5) {
  const linkEls = elementsByClass(html, linkClass)
  const snippetEls = elementsByClass(html, snippetClass)
  const out = []
  const n = Math.min(limit, linkEls.length)
  for (let i = 0; i < n; i++) {
    const el = linkEls[i]
    out.push({ title: stripHtml(el.inner), url: hrefOf(el), snippet: snippetEls[i] ? stripHtml(snippetEls[i].inner) : '' })
  }
  return out
}

/** 解析 DDG Lite HTML → [{title,url,snippet}] */
export function parseDDG(html, limit = 5) {
  return parseByClasses(html, 'result-link', 'result-snippet', limit)
}

/** 解析 DDG HTML 版（html.duckduckgo.com/html/）→ [{title,url,snippet}] */
export function parseDDGHtml(html, limit = 5) {
  return parseByClasses(html, 'result__a', 'result__snippet', limit)
}

/**
 * 反爬/验证页识别：没有结果标记，但含验证/拦截特征 → 视为该端点失败（而非"确实无结果"）。
 * 这样上层会给出真实原因，而不是静默返回空让模型/用户以为"搜不到"。
 */
export function looksBlocked(html) {
  const s = String(html || '')
  if (/result-link|result__a/i.test(s)) return false
  return /(unusual traffic|automated queries|are you a robot|captcha|challenge-|enable javascript|access denied|too many requests)/i.test(s)
}

const DDG_ENDPOINTS = [
  { name: 'lite', url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseDDG },
  { name: 'html', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDDGHtml },
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
  // 真实浏览器 UA：旧值 `Mozilla/5.0 (agents-plugin)` 不是合法浏览器标识，容易被 DDG 反爬判定为
  // 机器人并返回验证页（表现为"所有查询都无结果"）。带 Accept/Accept-Language 提升正常返回概率。
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  for (const ep of DDG_ENDPOINTS) {
    try {
      const opts = {
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        ...fetchOpts,
      }
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' && !opts.signal) {
        opts.signal = AbortSignal.timeout(timeout)
      }
      const res = await f(ep.url(query), opts)
      // 仅显式失败才算失败（注入的 mock fetcher 可能不带 ok 字段）
      if (res.ok === false || (typeof res.status === 'number' && res.status >= 400)) {
        lastErr = new Error(`DDG HTTP ${res.status ?? 'error'}`)
        continue
      }
      const body = await res.text()
      // 反爬/验证页：当作该端点失败，交上层与其它源比较（不要静默变成"无结果"）
      if (looksBlocked(body)) { lastErr = new Error(`DDG ${ep.name} 返回反爬/验证页（未解析到结果）`); continue }
      anyOk = true
      const results = ep.parse(body, limit)
      if (results.length) return results
    } catch (e) { lastErr = e }
  }
  if (anyOk) return [] // 端点可用但确实没结果
  throw lastErr || new Error('DDG 搜索失败')
}
