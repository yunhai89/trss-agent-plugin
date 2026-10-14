/**
 * 网页内容抓取（crawl）—— crawl4ai 真浏览器（默认）→ Node fetch + cheerio 自动降级。
 *
 * 用途：
 *  - web_crawl 常驻工具：Agent 对话中抓取任意网页正文（区别于 web_search 的关键词搜索）
 *  - KnowledgeStore.ingestUrl / refreshDoc：知识库 URL 入库 + 定时拉取最新内容
 *
 * 抓取链路（crawlUrl）：
 *  ① SSRF 门禁：本机/内网/元数据地址默认拒绝（kb.crawl.allowPrivateHosts 可放开），
 *     fetch 路径重定向逐跳复验；
 *  ② crawl4ai 真浏览器渲染（SPA/JS 动态页、轻度反爬）：stealth 默认开；
 *     被反爬拦截（403/CF 挑战等）且 kb.crawl.retryBlocked 时用 undetected+stealth 强化再试一轮；
 *  ③ 降级 fetch+cheerio（静态兜底）：Cookie Jar（手动跳转携带会话）、自动字符集
 *     （GBK/Big5 等乱码修复）、挑战页/JS 空壳识别（不把「Just a moment」「加载中」当正文）、
 *     Retry-After 退避重试。
 *
 * 依赖 cheerio（npm，结构化选择器去噪）。未装 crawl4ai 时自动降级 fetch（scripts/install-crawl4ai.sh）。
 */

import { load } from 'cheerio'
import net from 'node:net'
import Config from '../../utils/Config.js'
import Log from '../../utils/Log.js'
import { runCrawl4ai, isCrawl4aiAvailable, resetCrawl4aiProbe, runCrawl4aiInSandbox, probeCrawl4aiInSandbox } from './crawl4ai.js'
import { assertUrlAllowed, hostIsBlocked, isPrivateIp, normalizeHost, parseLooseIPv4 } from '../stagehand/guard.js'
import { toolSandbox, sandboxSelected } from '../sandbox/bridge.js'
export { resetCrawl4aiProbe }

function kbCfg() {
  return Config.get?.()?.agent?.kb || {}
}

/** 浏览器 UA 池（重试时轮换，降低被固定指纹拦截概率；版本与真实桌面浏览器对齐） */
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
]

function headersFor(url, ua) {
  let referer = ''
  try { referer = new URL(url).origin + '/' } catch { /* noop */ }
  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    ...(referer ? { Referer: referer } : {}),
  }
}

const isLocal = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(String(u))

/** 统一代理解析（与搜索一致）：agent.proxy → 环境变量代理 → 直连 */
function netProxy() {
  const cfg = Config.get?.()?.agent || {}
  return String(cfg.proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY
    || process.env.HTTP_PROXY || process.env.http_proxy || '')
}

let _netFetch = null
let _netKey = ''
/**
 * 代理感知 fetch：配置热加载后 key 变化自动重建；本地/内网地址始终直连。
 * 受限网络下（如被墙站点）配 agent.proxy 即可抓取。
 */
async function netFetch() {
  const proxy = netProxy()
  const key = proxy
  if (key === _netKey && _netFetch) return _netFetch
  _netKey = key
  const direct = (typeof fetch !== 'undefined' && fetch) || null
  if (!proxy) { _netFetch = direct; return _netFetch }
  try {
    const { ProxyAgent, fetch: uFetch } = await import('undici')
    const dispatcher = new ProxyAgent(proxy)
    _netFetch = (url, opts = {}) => uFetch(url, isLocal(url) ? opts : { ...opts, dispatcher })
    Log.debug('[crawl] 使用代理抓取')
  } catch (e) {
    Log.warn('[crawl] 代理不可用，直连', e?.message || e)
    _netFetch = direct
  }
  return _netFetch
}

// ───────────────────────── 响应读取与字符集 ─────────────────────────

const CHARSET_ALIASES = {
  'gb2312': 'gbk', 'gb-2312': 'gbk', 'x-gbk': 'gbk', 'csgb2312': 'gbk',
  'big-5': 'big5', 'utf8': 'utf-8', 'shift-jis': 'shift_jis', 'sjis': 'shift_jis',
  'iso-8859-1': 'latin1', 'us-ascii': 'utf-8', 'ascii': 'utf-8',
}

function normalizeCharsetName(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/^["']|["']$/g, '')
  if (!s) return ''
  return CHARSET_ALIASES[s] || s
}

function charsetFromContentType(ct) {
  const m = /charset\s*=\s*["']?([\w.-]+)/i.exec(String(ct || ''))
  return m ? normalizeCharsetName(m[1]) : ''
}

/** 在 HTML 前 4KB 里嗅探 <meta charset>/<meta http-equiv=Content-Type>（老站常只在正文里声明） */
function sniffMetaCharset(buf) {
  const head = Buffer.isBuffer(buf) ? buf.slice(0, 4096).toString('latin1') : String(buf || '').slice(0, 4096)
  const m = /<meta[^>]+charset\s*=\s*["']?([\w.-]+)/i.exec(head)
  if (m) return normalizeCharsetName(m[1])
  const m2 = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w.-]+)/i.exec(head)
  return m2 ? normalizeCharsetName(m2[1]) : ''
}

/**
 * 按 Content-Type / meta 声明解码 HTML 字节（修复 GBK/Big5 老站乱码——undici 的 text() 固定按 UTF-8 解）。
 * 编码名未知/运行环境不支持时回退 UTF-8，再退回 latin1（保底不抛错）。
 */
export function decodeHtmlBuffer(buf, contentType = '') {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '')
  const declared = charsetFromContentType(contentType) || sniffMetaCharset(bytes) || 'utf-8'
  try {
    return new TextDecoder(declared).decode(bytes)
  } catch {
    try { return new TextDecoder('utf-8').decode(bytes) } catch { return bytes.toString('latin1') }
  }
}

const hget = (res, name) => {
  try { return typeof res?.headers?.get === 'function' ? String(res.headers.get(name) || '') : '' } catch { return '' }
}

/** 读响应体：优先整数节读 + 按声明字符集解码；桩/简易 fetcher 只有 text() 时兼容。 */
async function readBody(res) {
  if (typeof res?.arrayBuffer === 'function') {
    return decodeHtmlBuffer(Buffer.from(await res.arrayBuffer()), hget(res, 'content-type'))
  }
  if (typeof res?.text === 'function') return String((await res.text()) || '')
  return ''
}

// ───────────────────────── Cookie Jar（内存，按 host 隔离） ─────────────────────────

function defaultCookiePath(reqPath) {
  const p = String(reqPath || '/')
  if (!p.startsWith('/')) return '/'
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function cookieDomainMatch(cookieDomain, host) {
  const d = String(cookieDomain || '').replace(/^\./, '').toLowerCase()
  if (!d) return false
  return host === d || host.endsWith('.' + d)
}

function cookiePathMatch(cookiePath, reqPath) {
  const cp = String(cookiePath || '/')
  const rp = String(reqPath || '/')
  if (rp === cp) return true
  if (!rp.startsWith(cp)) return false
  return cp.endsWith('/') || rp[cp.length] === '/'
}

function parseSetCookie(line, host, reqPath) {
  const s = String(line || '')
  const semi = s.indexOf(';')
  const pair = (semi === -1 ? s : s.slice(0, semi)).trim()
  const eq = pair.indexOf('=')
  if (eq <= 0) return null
  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim()
  if (!name) return null
  let domain = host
  let path = defaultCookiePath(reqPath)
  let expires = null
  let secure = false
  if (semi !== -1) {
    for (const attr of s.slice(semi + 1).split(';')) {
      const i = attr.indexOf('=')
      const k = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase()
      const v = i === -1 ? '' : attr.slice(i + 1).trim()
      if (k === 'domain' && v) {
        const d = v.replace(/^\./, '').toLowerCase()
        if (!cookieDomainMatch(d, host)) return null // 跨域伪造的 Domain 直接拒绝
        domain = d
      } else if (k === 'path' && v.startsWith('/')) {
        path = v
      } else if (k === 'max-age' && /^-?\d+$/.test(v)) {
        expires = Date.now() + Number(v) * 1000
      } else if (k === 'expires') {
        const t = Date.parse(v)
        if (!Number.isNaN(t)) expires = t
      } else if (k === 'secure') {
        secure = true
      }
    }
  }
  if (expires != null && expires <= Date.now()) return null
  return { key: `${domain}\n${path}\n${name}`, domain, path, name, value, expires, secure }
}

/** 组合 Set-Cookie 头（无 getSetCookie 时）按 `, name=` 切分——Expires 里的逗号不会命中该模式 */
function splitCombinedSetCookie(raw) {
  return String(raw || '').split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=)/g).map((s) => s.trim()).filter(Boolean)
}

function getSetCookieLines(res) {
  const h = res?.headers
  if (!h) return []
  try {
    if (typeof h.getSetCookie === 'function') {
      const list = h.getSetCookie()
      if (Array.isArray(list) && list.length) return list.filter(Boolean).map(String)
    }
  } catch { /* 继续用组合头 */ }
  const raw = typeof h.get === 'function' ? h.get('set-cookie') : null
  return raw ? splitCombinedSetCookie(raw) : []
}

/**
 * 极简 Cookie Jar —— 纯 HTTP 重定向/重试之间保持会话（很多站点首访发 cookie 才给正文）。
 * 安全：只在内存（不落盘）、只发往 domain/path/secure 匹配的 host、容量上限、日志不打印 cookie 值。
 */
export function createCookieJar({ max = 300 } = {}) {
  const store = new Map() // key -> cookie（插入序即 LRU 顺序）
  const evict = () => { while (store.size > max) store.delete(store.keys().next().value) }
  return {
    size: () => store.size,
    clear: () => store.clear(),
    /** 组装请求 Cookie 头（匹配 host/path/secure；顺带清理过期项） */
    header(target) {
      let u
      try { u = new URL(String(target)) } catch { return '' }
      const host = u.hostname.toLowerCase()
      const path = u.pathname || '/'
      const https = u.protocol === 'https:'
      const parts = []
      for (const [key, c] of store) {
        if (c.expires != null && c.expires <= Date.now()) { store.delete(key); continue }
        if (c.secure && !https) continue
        if (!cookieDomainMatch(c.domain, host) || !cookiePathMatch(c.path, path)) continue
        parts.push(`${c.name}=${c.value}`)
      }
      return parts.join('; ')
    },
    /** 存入响应 Set-Cookie（不合法/过期/跨域拒绝） */
    store(target, lines) {
      let u
      try { u = new URL(String(target)) } catch { return }
      const host = u.hostname.toLowerCase()
      for (const line of lines || []) {
        const c = parseSetCookie(line, host, u.pathname || '/')
        if (!c) continue
        store.delete(c.key)
        store.set(c.key, c)
      }
      evict()
    },
  }
}

// ───────────────────────── 挑战页 / JS 空壳识别 ─────────────────────────

// 强特征：只认挑战页运行时变量与兜底文案——多数已通过验证的 Cloudflare 站点也会加载
// challenge-platform 脚本，不能据此判拦截（nowsecure.nl 验证页即为此类）。
const CHALLENGE_TITLE_RE = /just a moment|attention required|checking your browser|performing security verification|请稍候.*验证|正在验证|人机验证/i
const CHALLENGE_BODY_RE = /enable javascript and cookies to continue|cf_chl_opt|__cf_chl|checking if the site connection is secure/i
const CHALLENGE_CN_RE = /(人机验证|安全验证|滑动验证|验证码)/

/** 响应是否为反爬挑战/拦截页（返回 'challenge' 或 null；保守防误伤正常页面） */
export function looksLikeChallenge({ status = 0, html = '', title = '' } = {}) {
  if (CHALLENGE_TITLE_RE.test(String(title || ''))) return 'challenge'
  const body = String(html || '').slice(0, 200000)
  if (CHALLENGE_BODY_RE.test(body)) return 'challenge'
  if (Number(status) >= 400 && body.length < 100000 && CHALLENGE_CN_RE.test(body)) return 'challenge'
  return null
}

const JS_REQUIRED_TEXT_RE = /^(加载中|正在加载|loading|please enable javascript|enable javascript|javascript is required|sina visitor system|正在跳转)/i
const JS_APP_ROOT_RE = /(id=["'](?:app|root|root-app|vue-app)["']|__NEXT_DATA__|__NUXT__|data-reactroot|ng-version=|id=["']q-app["'])/i

/** 页面是否为「等 JS 渲染」的空壳（正文极短 + 框架挂载点/加载文案；返回 true 时提示装 crawl4ai） */
export function looksLikeJsShell({ text = '', html = '', title = '' } = {}) {
  const t = String(text || '').trim()
  if (t.length >= 180) return false
  if (JS_REQUIRED_TEXT_RE.test(t) || JS_REQUIRED_TEXT_RE.test(String(title || ''))) return true
  const scripts = (String(html || '').match(/<script\b/gi) || []).length
  return JS_APP_ROOT_RE.test(String(html || '')) && scripts >= 2
}

/** 归一化 fetch 异常 → 结构化 { code, error, hint } */
function classifyFetchError(e) {
  const code = e?.cause?.code || e?.code || ''
  if (e?.name === 'AbortError') return { code: 'timeout', error: '抓取超时', hint: '目标站点响应慢或被网络阻断；可在 agent.proxy 配置代理后重试，或调大 kb.crawlTimeout' }
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return { code: 'network', error: `域名解析失败（${code}）`, hint: '域名错误或 DNS/网络受限；可在 agent.proxy 配置代理' }
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR|certificate|SSL/i.test(code || e?.message || '')) {
    return { code: 'network', error: `连接失败（${code || e?.message}）`, hint: '网络不可达/被阻断；可在 agent.proxy 配置代理后重试' }
  }
  return { code: 'network', error: `fetch 失败：${e?.message || e}`, hint: '网络异常；可在 agent.proxy 配置代理后重试' }
}

/** HTML → 结构化文本（去噪 + 保留段落/标题换行，供 LLM 阅读） */
function htmlToText(html) {
  const $ = load(html)
  const title = $('title').first().text().trim() || $('h1').first().text().trim() || ''
  $([
    'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas',
    'nav', 'footer', 'header', 'aside', 'form', 'button',
  ].join(',')).remove()
  $('[style*="display:none"],[style*="display: none"],[hidden],aria-hidden').remove()
  // 保留结构：br → 换行；块级元素后补换行（避免全挤成一行）
  $('br').replaceWith('\n')
  $('p,div,section,article,li,h1,h2,h3,h4,h5,h6,tr,blockquote,pre').each((_, el) => { $(el).append('\n') })
  const rootSel = ['article', 'main', '[role="main"]', '#content', '#main', '.content', '.article', '.post-content', '.entry-content'].join(',')
  let root = $(rootSel).first()
  if (!root.length) root = $('body')
  const clean = (s) => String(s).replace(/\r/g, '').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  let text = clean(root.text())
  if (text.length < 50) text = clean($('body').text())
  return { title, text }
}

/** Retry-After 解析（秒或 HTTP 日期），上限 8s 防被远端拖死 */
function retryAfterMs(res) {
  const raw = hget(res, 'retry-after')
  if (!raw) return 0
  let ms = 0
  if (/^\d+$/.test(raw.trim())) ms = Number(raw.trim()) * 1000
  else { const t = Date.parse(raw); if (!Number.isNaN(t)) ms = t - Date.now() }
  return Math.max(0, Math.min(8000, ms))
}

/**
 * 手动跟随重定向：undici fetch 自动跳转不会管理 Cookie，且我们的 SSRF 门禁需要逐跳复验。
 * @returns {{ res?, finalUrl?, blocked? }} blocked 已是结构化失败结果
 */
async function fetchWithRedirects(f, url, { headers, signal, jar, checkUrl = null, maxRedirects = 5 }) {
  let current = url
  let hopHeaders = { ...headers }
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // 首跳由调用方（crawlUrl）已完成门禁；仅重定向目标需要逐跳复验
    if (checkUrl && hop > 0) {
      const v = await checkUrl(current)
      if (!v?.ok) return { blocked: { success: false, code: v?.code || 'ssrf_blocked', error: v?.error || `目标地址被拒绝：${v?.reason || ''}`, ...(v?.hint ? { hint: v.hint } : {}) } }
    }
    const cookieHeader = jar?.header(current) || ''
    const res = await f(current, {
      headers: cookieHeader ? { ...hopHeaders, Cookie: cookieHeader } : hopHeaders,
      signal,
      redirect: 'manual',
    })
    const lines = getSetCookieLines(res)
    if (lines.length && jar) jar.store(current, lines)
    const status = Number(res?.status) || 0
    if ([301, 302, 303, 307, 308].includes(status)) {
      const loc = hget(res, 'location')
      try { res?.body?.cancel?.() } catch { /* 排空失败无碍 */ }
      if (!loc) return { res, finalUrl: current }
      let next = ''
      try { next = new URL(loc, current).href } catch { return { res, finalUrl: current } }
      if (hop === maxRedirects) {
        return { blocked: { success: false, code: 'http', status, error: `重定向次数过多（>${maxRedirects}）`, hint: '可能有跳转循环；可在浏览器路径（crawl4ai）重试' } }
      }
      hopHeaders = { ...headers, Referer: current }
      current = next
      continue
    }
    return { res, finalUrl: current }
  }
  return { blocked: { success: false, code: 'http', error: '重定向异常' } }
}

/**
 * Node fetch HTML → cheerio 正文提取。带代理支持、Cookie Jar、自动字符集、重试与结构化错误。
 * @param {object} o { timeout, fetcher, retries, checkUrl, jar }
 *  - checkUrl: 重定向逐跳校验（crawlUrl 注入 SSRF 门禁；返回 {ok, code?, error?, hint?}）
 * @returns {Promise<{success, markdown?, title?, via?, code?, error?, hint?, status?, finalUrl?}>}
 */
export async function crawlWithFetch(url, { timeout = 30, fetcher, retries = 3, checkUrl = null, jar = null } = {}) {
  const f = fetcher || await netFetch()
  if (typeof f !== 'function') return { success: false, code: 'network', error: '运行环境缺少 fetch' }
  const attempts = Math.max(1, Number(retries) || 3)
  const perAttemptMs = Math.max(1000, (Number(timeout) || 30) * 1000)
  const deadline = Date.now() + perAttemptMs * 2 // 总预算：重试不把等待无限叠加
  const cookies = jar || createCookieJar()
  let last = null
  for (let i = 0; i < attempts; i++) {
    if (i > 0 && Date.now() >= deadline - 200) break
    const remain = Math.max(500, Math.min(perAttemptMs, deadline - Date.now()))
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), remain)
    try {
      const out = await fetchWithRedirects(f, url, {
        headers: headersFor(url, UA_POOL[i % UA_POOL.length]),
        signal: ctrl.signal,
        jar: cookies,
        checkUrl,
      })
      if (out.blocked) return out.blocked
      const res = out.res
      const finalUrl = out.finalUrl || url
      const status = Number(res?.status) || 0
      if (res.ok || (status >= 200 && status < 300)) {
        const html = await readBody(res)
        const { title, text } = htmlToText(html)
        if (looksLikeChallenge({ status, html, title })) {
          return { success: false, code: 'challenge', status, finalUrl, title, error: '命中反爬挑战页（Cloudflare 等）', hint: '目标站点使用 JS 挑战/风控：需真浏览器渲染（crawl4ai 默认引擎，确认已跑 scripts/install-crawl4ai.sh）；仍失败可在 agent.proxy 配置出口代理' }
        }
        if (!text || text.length < 20) {
          if (looksLikeJsShell({ text, html, title })) {
            return { success: false, code: 'js_required', status, finalUrl, title, error: '页面正文由 JS 动态渲染（fetch 只能拿到空壳）', hint: '需真浏览器渲染：跑 scripts/install-crawl4ai.sh 安装 crawl4ai（web_crawl 默认引擎会自动使用）；或对该页传 js_code/wait_for' }
          }
          return { success: false, code: 'empty', status, finalUrl, title, error: '页面无有效正文（可能是 JS 动态渲染页）', hint: '该页需真浏览器渲染；安装 crawl4ai（scripts/install-crawl4ai.sh）后重试' }
        }
        return { success: true, markdown: text, title, via: 'fetch', status, finalUrl }
      }
      // 非 2xx：读取小响应体识别挑战页；挑战页不重试（重试也过不去，交给浏览器路径）
      let body = ''
      try { body = (await readBody(res)).slice(0, 200000) } catch { /* 错误页读取失败可忽略 */ }
      const pageTitle = load(body || '').root().find('title').first().text().trim()
      if (looksLikeChallenge({ status, html: body, title: pageTitle })) {
        return { success: false, code: 'challenge', status, finalUrl, error: `命中反爬挑战页（HTTP ${status || '?'}）`, hint: '目标站点使用 JS 挑战/风控：需真浏览器渲染（crawl4ai）并确认 agent.proxy 出口可用' }
      }
      const retryable = [403, 429, 500, 502, 503, 504].includes(status)
      last = status === 403
        ? { success: false, code: 'blocked', status, error: 'HTTP 403（疑似反爬）', hint: '目标站点拒绝非浏览器请求；建议安装 crawl4ai 真浏览器渲染（scripts/install-crawl4ai.sh），或配置 agent.proxy' }
        : status === 429
          ? { success: false, code: 'blocked', status, error: 'HTTP 429（被限流）', hint: '稍后重试或配置代理' }
          : { success: false, code: 'http', status, error: `HTTP ${status || '?'}`, hint: status >= 500 ? '目标站点 5xx，稍后重试' : '' }
      if (retryable && i < attempts - 1) {
        await sleep(Math.max(retryAfterMs(res), 300 * (i + 1) + Math.floor(Math.random() * 150)))
        continue
      }
      return last
    } catch (e) {
      last = classifyFetchError(e)
      if (i < attempts - 1) {
        await sleep(300 * (i + 1) + Math.floor(Math.random() * 150))
        continue
      }
      return last
    } finally { clearTimeout(timer) }
  }
  return last || { success: false, code: 'network', error: '抓取失败' }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ───────────────────────── 抓取策略与 SSRF 门禁 ─────────────────────────

/**
 * 抓取策略解析（纯函数，可离线测试）：opts 显式值 > kb.crawl 配置 > 内置默认。
 * - stealth：浏览器路径反检测默认开（显式 false 可关）
 * - retryBlocked：被反爬拦截时强化模式再试一轮（默认开）
 * - allowPrivateHosts：允许抓取本机/内网（默认 false，防 SSRF）
 */
export function resolveCrawlPolicy(cfg = {}, opts = {}) {
  const c = cfg?.crawl || {}
  const tri = (v, dflt) => (v === undefined ? dflt : v === true)
  return {
    engine: String(opts.engine || c.engine || 'crawl4ai'),
    stealth: tri(opts.stealth, c.stealth !== false),
    retryBlocked: tri(opts.retryBlocked, c.retryBlocked !== false),
    allowPrivateHosts: tri(opts.allowPrivateHosts, c.allowPrivateHosts === true),
  }
}

/**
 * 目标地址门禁：默认拒绝本机/内网/元数据地址（复用 stagehand 的解析级校验：
 * 混淆 IPv4、IPv6、域名解析结果均覆盖）。
 * - viaProxy：走代理出网时跳过本地 DNS 解析（目标域名由代理解析；字面 IP/黑名单主机仍拦），
 *   避免「本地 DNS 被污染/不可用但代理可用」被误拦；
 * - 域名解析失败按网络错误返回（非 SSRF）。
 */
export async function checkTargetAllowed(target, { allowPrivateHosts = false, lookup = null, viaProxy = false } = {}) {
  const raw = String(target || '')
  if (!/^https?:\/\//i.test(raw)) return { ok: false, code: 'invalid_url', error: '仅支持 http/https 地址' }
  if (allowPrivateHosts) return { ok: true }
  // 字面 IP / 黑名单主机：先于 DNS，恒拦截（代理路径同样适用）
  const literal = checkHostLiteral(raw)
  if (!literal.ok) return literal
  if (viaProxy && !lookup) return { ok: true }
  const v = await assertUrlAllowed(raw, lookup ? { lookup, timeoutMs: 3000 } : { timeoutMs: 3000 })
  if (v.ok) return { ok: true }
  if (/解析失败|无解析结果|解析超时/.test(v.reason || '')) {
    return { ok: false, code: 'network', error: `目标域名无法解析：${v.reason}`, hint: '域名错误或 DNS/网络受限；可在 agent.proxy 配置代理后重试' }
  }
  return {
    ok: false, code: 'ssrf_blocked', error: `目标地址被拒绝：${v.reason}`,
    hint: '默认禁止抓取本机/内网/元数据地址（防 SSRF）；确需抓取请在 config.yaml 设 agent.kb.crawl.allowPrivateHosts: true',
  }
}

/** 仅字面量/黑名单主机校验（不做 DNS）：代理路径与解析前快速拦截共用 */
function checkHostLiteral(target) {
  let u
  try { u = new URL(target) } catch { return { ok: false, code: 'invalid_url', error: 'URL 非法' } }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, code: 'invalid_url', error: '仅支持 http/https 地址' }
  const host = normalizeHost(u.hostname)
  if (!host) return { ok: false, code: 'invalid_url', error: 'URL 缺少主机名' }
  const deny = (reason) => ({
    ok: false, code: 'ssrf_blocked', error: `目标地址被拒绝：${reason}`,
    hint: '默认禁止抓取本机/内网/元数据地址（防 SSRF）；确需抓取请在 config.yaml 设 agent.kb.crawl.allowPrivateHosts: true',
  })
  if (hostIsBlocked(host)) return deny(`禁止访问本地/内网/元数据主机：${host}`)
  const loose = parseLooseIPv4(host)
  if (net.isIPv4(host) || loose) {
    const ip = net.isIPv4(host) ? host : loose
    if (isPrivateIp(ip)) return deny(`禁止访问内网 IP：${ip}`)
    return { ok: true }
  }
  if (net.isIPv6(host)) {
    if (isPrivateIp(host)) return deny(`禁止访问内网 IPv6：${host}`)
    return { ok: true }
  }
  return { ok: true }
}

/** 被反爬拦截的信号：只对确定性拦截/挑战升级重试（协议错误/超时/崩溃不升级） */
export function isBlockSignal(r) {
  if (!r || r.success) return false
  if (r.code === 'blocked' || r.code === 'challenge') return true
  return /anti-bot|blocked|challenge|cloudflare|access denied|captcha|人机验证|安全验证|HTTP 403|HTTP 429/i.test(String(r.error || ''))
}

const mergeHints = (...hints) => [...new Set(hints.filter(Boolean).map(String))].join('；')

/** 统一抓取入口：crawl4ai（默认，真浏览器渲染——SPA/JS 动态页可抓 + JS 交互/结构化抽取）→ 失败/未装自动降级 fetch+cheerio。
 *  engine: 'crawl4ai'（默认）| 'fetch'（强制纯 HTTP，零子进程）。
 *  安全：默认拒绝本机/内网/元数据目标（kb.crawl.allowPrivateHosts 放开）；重定向逐跳复验（fetch 路径）。
 *  高级参数（waitFor/jsCode/jsBeforeWait/delayMs/cssSelector/extract/links/stealth/flatShadowDom/virtualScroll）
 *  仅 crawl4ai 路径生效；降级 fetch 时结果带 degraded:true + skipped:[未生效能力]（诚实标注，不静默吞）。
 *  反爬：stealth 默认开；被拦截时（kb.crawl.retryBlocked）用 undetected+stealth 升级再试一轮（结果带 escalated:true）。
 *  保留 crawlUrl 名兼容 KnowledgeStore 调用。 */
export async function crawlUrl(url, opts = {}) {
  const cfg = kbCfg()
  const o = { timeout: cfg.crawlTimeout ?? 60, ...opts }
  const u = String(url || '').trim()
  const policy = resolveCrawlPolicy(cfg, o)
  const engine = policy.engine
  const proxy = netProxy()
  const browserProxy = proxy && !isLocal(u) ? proxy : null
  const checkTarget = (target) => checkTargetAllowed(target, {
    allowPrivateHosts: policy.allowPrivateHosts,
    lookup: o._lookup || null,
    viaProxy: !!browserProxy,
  })

  // ① SSRF 门禁（入口；fetch 路径在重定向逐跳复验）
  const entry = await checkTarget(u)
  if (!entry.ok) return { success: false, code: entry.code, error: entry.error, ...(entry.hint ? { hint: entry.hint } : {}) }

  const avail = o._avail || isCrawl4aiAvailable
  const doC4ai = o._c4ai || runCrawl4ai
  const doFetch = o._fetch || crawlWithFetch
  const ADVANCED = ['waitFor', 'jsCode', 'jsBeforeWait', 'cssSelector', 'extract', 'links', 'stealth', 'flatShadowDom', 'virtualScroll']
  const advancedUsed = ADVANCED.filter((k) => {
    const v = o[k]
    if (v === true) return true
    if (v == null || v === false || v === '') return false // 显式 false/空 = 未使用（工具层会显式传 false）
    if (Array.isArray(v)) return v.length > 0
    return true
  })
  const c4aiOpts = {
    timeoutMs: o.timeout * 1000, maxChars: o.maxChars,
    waitFor: o.waitFor, jsCode: o.jsCode, jsBeforeWait: o.jsBeforeWait, delayMs: o.delayMs,
    cssSelector: o.cssSelector, extract: o.extract, links: o.links === true,
    stealth: policy.stealth, // 配置默认开；工具显式 stealth:false 可关
    flatShadowDom: o.flatShadowDom === true, virtualScroll: o.virtualScroll,
    proxy: browserProxy,
  }
  let r = null
  let c4aiErr = null
  if (engine !== 'fetch') {
    let probe = null
    try { probe = await avail() } catch { probe = { ok: false } }
    const ok = !!(probe && probe.ok)
    if (ok) {
      try { r = await doC4ai(u, c4aiOpts) } catch (e) { r = { success: false, code: 'crashed', error: e?.message || String(e) } }
      // 反爬拦截 → 强化升级一轮：undetected（patchright 深度补丁）+ stealth + load 等待 + 更长 hydration
      if (r?.success) {
        Log.info(`[crawl] ${u} via=crawl4ai${r.escalated ? '（升级档）' : ''}${r.extractedCount != null ? ` extracted=${r.extractedCount}` : ''} len=${r.markdown?.length ?? 0}`)
      } else {
        c4aiErr = r
        Log.warn(`[crawl] ${u} crawl4ai 失败（${r?.code || '?'} ${r?.error || ''}）`)
        if (policy.retryBlocked && isBlockSignal(r)) {
          Log.info(`[crawl] ${u} 命中反爬，升级模式重试（undetected+stealth）`)
          let r2 = null
          try {
            r2 = await doC4ai(u, {
              ...c4aiOpts, stealth: true, undetected: true, waitUntil: 'load',
              delayMs: Math.max(Number(o.delayMs) || 0, 1500),
            })
          } catch (e) { r2 = { success: false, code: 'crashed', error: e?.message || String(e) } }
          if (r2?.success) {
            r = { ...r2, escalated: true }
            Log.info(`[crawl] ${u} via=crawl4ai（升级档命中）len=${r.markdown?.length ?? 0}`)
          } else {
            c4aiErr = r2 || c4aiErr
            Log.warn(`[crawl] ${u} 升级模式仍失败（${r2?.code || '?'} ${r2?.error || ''}），降级 fetch`)
          }
        } else {
          Log.warn(`[crawl] ${u} 降级 fetch`)
        }
      }
    } else {
      // 打印探测失败原因 + 实际解释器路径：多个插件副本时能直接看出「venv 装到了另一个目录」
      const why = probe?.reason || 'venv 未安装'
      const py = probe?.python ? `；解释器 ${probe.python}` : ''
      Log.warn(`[crawl] crawl4ai 不可用（${why}${py}；跑 scripts/install-crawl4ai.sh 启用真浏览器渲染），走 fetch`)
    }
  }
  if (!r?.success) {
    // 降级标注：本次请求的高级能力未生效（fetch 无浏览器/无 JS），调用方据 degraded 决定是否重试或提示
    r = await doFetch(u, { ...o, checkUrl: checkTarget })
    if (advancedUsed.length) r = { ...r, degraded: true, skipped: advancedUsed }
    if (!r.success && c4aiErr) {
      r = {
        ...r,
        crawl4ai: { code: c4aiErr.code || '', error: String(c4aiErr.error || '').slice(0, 300) },
        ...(mergeHints(r.hint, c4aiErr.hint) ? { hint: mergeHints(r.hint, c4aiErr.hint) } : {}),
      }
    }
    if (r.success) Log.info(`[crawl] ${u} via=fetch len=${r.markdown.length}${advancedUsed.length ? `（降级：跳过 ${advancedUsed.join('/')}）` : ''}`)
  }
  if (!r?.success) Log.warn(`[crawl] ${u} 抓取失败：${r?.error}${r?.crawl4ai ? `（crawl4ai：${r.crawl4ai.code}）` : ''}`)
  return r
}

/** web_crawl 常驻工具：抓取网页正文（category=query，人人可用，只读）。
 *  crawl4ai 完整交互能力：wait_for 等 JS 渲染完成、js_code 滚动/点击触发懒加载、
 *  extract 结构化抽取（CSS schema → JSON）、links 链接清单、scroll 虚拟滚动长列表。
 *  反爬链：stealth 默认开 → 被拦截自动 undetected 升级 → 失败降级 fetch（degraded 标注）。
 *  安全：默认拒绝本机/内网/元数据地址。 */
export const webCrawlTool = {
  name: 'web_crawl',
  description: '抓取网页内容（默认 crawl4ai 真浏览器渲染，SPA/JS 动态页可抓；stealth 反检测默认开，被拦截自动升级 undetected 重试）。基础用法返回正文 {title, text}。同态渲染页（内容由 JS 生成）：js_code 滚动/点击触发加载 + wait_for 等元素出现；需要表格/列表等结构化数据时用 extract（CSS schema → JSON 数组）；需要页面全部链接时 links:true。降级纯 HTTP 时高级参数自动跳过并在结果标注 degraded。',
  category: 'query',
  meta: { summary: '抓取网页正文/结构化数据', resultCap: 12000 },
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '目标网页 URL（http:// 或 https://）' },
      maxLength: { type: 'integer', description: '返回正文最大字符数（默认 12000）' },
      wait_for: { type: 'string', description: '等动态渲染完成再抓：css:选择器（等元素出现）或 js:() => 布尔（等条件成立）。例 css:.quote:nth-child(10)' },
      js_code: { description: '抓取前在页面执行的 JS（字符串或数组依序执行）：滚动到底 window.scrollTo(0,document.body.scrollHeight)、点击展开 document.querySelector(\'.more\')?.click()。只用于加载内容，勿提交表单/登录' },
      css_selector: { type: 'string', description: '只提取该 CSS 选择器内内容（聚焦正文区，如 .article-body）' },
      extract: { type: 'object', description: '结构化抽取 schema（JsonCssExtractionStrategy）：{baseSelector: 行选择器, fields: [{name, selector, type: text|attribute|html, attribute?}]}。命中返回 extracted JSON 数组而非正文' },
      links: { type: 'boolean', description: '额外返回页面链接清单（internal/external 各 ≤200 条）' },
      delay_ms: { type: 'integer', description: '渲染后额外等待毫秒（hydration 余量，默认 800，慢站可调大）' },
      stealth: { type: 'boolean', description: '反检测（默认开；传 false 关闭）。被反爬拦截时会自动用更强的 undetected 模式升级重试' },
      scroll: { type: 'object', description: '虚拟滚动加载懒加载长列表：{container_selector, scroll_count, wait_after_scroll}。适用无限滚动信息流' },
    },
    required: ['url'],
  },
  async execute(args = {}, ctx = {}) {
    const { url, maxLength, wait_for, js_code, css_selector, extract, links, delay_ms, stealth, scroll } = args
    const u = String(url || '').trim()
    if (!/^https?:\/\//i.test(u)) return { error: 'url 需以 http:// 或 https:// 开头' }
    if (wait_for && !/^(css:|js:)/.test(String(wait_for).trim())) return { error: 'wait_for 需以 css: 或 js: 开头' }
    // 执行面：显式选择 E2B 时 crawl4ai 只在会话沙箱内跑（宿主 python 子进程不启动）；
    // 沙箱不可用/模板缺 crawl4ai → crawlUrl 自动降级纯 HTTP fetch（非 shell，结果标注 via/degraded）。
    const box = toolSandbox(ctx)
    const engineOverride = {}
    if (box) {
      engineOverride._avail = () => probeCrawl4aiInSandbox(box)
      engineOverride._c4ai = (target, o) => runCrawl4aiInSandbox(box, target, o)
    } else if (sandboxSelected(ctx)) {
      engineOverride._avail = async () => ({ ok: false, reason: '沙箱未就绪（已显式选择 e2b，不跑宿主 crawl4ai）；修复 E2B 配置后重试' })
    }
    const r = await crawlUrl(u, {
      ...(args.engine ? { engine: String(args.engine) } : {}), // 调用方强制引擎（测试/诊断；生产走配置默认）
      waitFor: wait_for, jsCode: js_code, cssSelector: css_selector,
      extract, links: links === true, delayMs: delay_ms,
      // stealth 未传 → 走配置默认；显式传 false 才关闭（避免把「默认开」误标成降级能力）
      ...(stealth === undefined ? {} : { stealth: stealth === true }),
      virtualScroll: scroll && typeof scroll === 'object' ? scroll : null,
      ...engineOverride,
    })
    if (!r.success) {
      return {
        error: r.error || '抓取失败',
        ...(r.code ? { code: r.code } : {}),
        ...(r.hint ? { hint: r.hint } : {}),
        ...(r.status ? { status: r.status } : {}),
        ...(r.crawl4ai ? { crawl4ai: r.crawl4ai } : {}),
        ...(r.degraded ? { degraded: true, skipped: r.skipped } : {}),
      }
    }
    const cap = Math.max(1000, Number(maxLength) || 12000)
    const out = { ok: true, url: u, title: r.title || '', via: r.via || 'fetch' }
    if (r.escalated) out.escalated = true
    if (r.extracted) {
      out.extracted = r.extracted
      out.count = r.extractedCount ?? r.extracted.length
      let text = JSON.stringify(r.extracted, null, 1)
      if (text.length > cap) text = text.slice(0, cap) + `\n…(已截断 ${text.length - cap} 字)`
      out.text = text
    } else {
      let text = String(r.markdown || '')
      if (text.length > cap) text = text.slice(0, cap) + `\n…(已截断 ${text.length - cap} 字)`
      out.length = text.length
      out.text = text
    }
    if (r.links) {
      out.links = r.links
      out.linksTotal = (r.links.internal?.length || 0) + (r.links.external?.length || 0)
    }
    if (r.degraded) { out.degraded = true; out.skipped = r.skipped }
    return out
  },
}
