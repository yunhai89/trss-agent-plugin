/**
 * 网页内容抓取（crawl）—— Node fetch 拿 HTML + cheerio 正文提取（选择器去噪 + 正文区优先）。
 *
 * 用途：
 *  - web_crawl 常驻工具：Agent 对话中抓取任意网页正文（区别于 web_search 的关键词搜索）
 *  - KnowledgeStore.ingestUrl / refreshDoc：知识库 URL 入库 + 定时拉取最新内容
 *
 * 依赖 cheerio（npm，结构化选择器去噪，比正则精准）。纯 HTTP 抓取，无浏览器/子进程；
 * JS 动态渲染页（SPA）拿不到渲染后内容——静态正文够用。
 */

import { load } from 'cheerio'
import Config from '../../utils/Config.js'
import Log from '../../utils/Log.js'
import { runCrawl4ai, isCrawl4aiAvailable, resetCrawl4aiProbe } from './crawl4ai.js'
export { resetCrawl4aiProbe }

function kbCfg() {
  return Config.get?.()?.agent?.kb || {}
}

/** 浏览器 UA 池（重试时轮换，降低被固定指纹拦截概率） */
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
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

let _netFetch = null
let _netKey = ''
/**
 * 代理感知 fetch（与搜索一致）：agent.proxy → 环境变量代理 → 直连；本地/内网地址始终直连。
 * 配置热加载后 key 变化自动重建。受限网络下（如被墙站点）配 agent.proxy 即可抓取。
 */
async function netFetch() {
  const cfg = Config.get?.()?.agent || {}
  const proxy = cfg.proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY
    || process.env.HTTP_PROXY || process.env.http_proxy || ''
  const key = String(proxy)
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

/**
 * Node fetch HTML → cheerio 正文提取。带代理支持、重试、UA 轮换与结构化错误。
 * @param {object} o { timeout, fetcher, retries }
 * @returns {Promise<{success, markdown?, title?, via?, code?, error?, hint?, status?}>}
 */
export async function crawlWithFetch(url, { timeout = 30, fetcher, retries = 3 } = {}) {
  const f = fetcher || await netFetch()
  if (typeof f !== 'function') return { success: false, code: 'network', error: '运行环境缺少 fetch' }
  const attempts = Math.max(1, Number(retries) || 3)
  let last = null
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout * 1000)
    try {
      const res = await f(url, { headers: headersFor(url, UA_POOL[i % UA_POOL.length]), signal: ctrl.signal, redirect: 'follow' })
      if (res.ok) {
        const html = await res.text()
        const { title, text } = htmlToText(html)
        if (!text || text.length < 20) {
          return { success: false, code: 'empty', error: '页面无有效正文（可能是 JS 动态渲染页）', hint: '该页需真浏览器渲染；安装 crawl4ai（scripts/install-crawl4ai.sh）后重试' }
        }
        return { success: true, markdown: text, title, via: 'fetch' }
      }
      const retryable = [403, 429, 500, 502, 503, 504].includes(res.status)
      last = res.status === 403
        ? { success: false, code: 'blocked', status: 403, error: 'HTTP 403（疑似反爬）', hint: '目标站点拒绝非浏览器请求；建议安装 crawl4ai 真浏览器渲染（scripts/install-crawl4ai.sh），或配置 agent.proxy' }
        : res.status === 429
          ? { success: false, code: 'http', status: 429, error: 'HTTP 429（被限流）', hint: '稍后重试或配置代理' }
          : { success: false, code: 'http', status: res.status, error: `HTTP ${res.status}`, hint: res.status >= 500 ? '目标站点 5xx，稍后重试' : '' }
      if (retryable && i < attempts - 1) { await sleep(300 * (i + 1)); continue }
      return last
    } catch (e) {
      last = classifyFetchError(e)
      if (i < attempts - 1) { await sleep(300 * (i + 1)); continue }
      return last
    } finally { clearTimeout(timer) }
  }
  return last || { success: false, code: 'network', error: '抓取失败' }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 统一抓取入口：crawl4ai（默认，真浏览器渲染——SPA/JS 动态页可抓 + JS 交互/结构化抽取）→ 失败/未装自动降级 fetch+cheerio。
 *  engine: 'crawl4ai'（默认）| 'fetch'（强制纯 HTTP，零子进程）。
 *  高级参数（waitFor/jsCode/jsBeforeWait/delayMs/cssSelector/extract/links/stealth/flatShadowDom/virtualScroll）
 *  仅 crawl4ai 路径生效；降级 fetch 时结果带 degraded:true + skipped:[未生效能力]（诚实标注，不静默吞）。
 *  保留 crawlUrl 名兼容 KnowledgeStore 调用。 */
export async function crawlUrl(url, opts = {}) {
  const cfg = kbCfg()
  const o = { timeout: cfg.crawlTimeout ?? 60, ...opts }
  const engine = o.engine || cfg.crawl?.engine || 'crawl4ai'
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
    cssSelector: o.cssSelector, extract: o.extract, links: o.links === true, stealth: o.stealth === true,
    flatShadowDom: o.flatShadowDom === true, virtualScroll: o.virtualScroll,
  }
  let r = null
  if (engine !== 'fetch') {
    let probe = null
    try { probe = await avail() } catch { probe = { ok: false } }
    const ok = !!(probe && probe.ok)
    if (ok) {
      try { r = await doC4ai(url, c4aiOpts) } catch (e) { r = { success: false, code: 'crashed', error: e?.message || String(e) } }
      if (r?.success) Log.info(`[crawl] ${url} via=crawl4ai${r.extractedCount != null ? ` extracted=${r.extractedCount}` : ''} len=${r.markdown?.length ?? 0}`)
      else Log.warn(`[crawl] ${url} crawl4ai 失败（${r?.code || '?'} ${r?.error || ''}），降级 fetch`)
    } else {
      // 打印探测失败原因 + 实际解释器路径：多个插件副本时能直接看出「venv 装到了另一个目录」
      const why = probe?.reason || 'venv 未安装'
      const py = probe?.python ? `；解释器 ${probe.python}` : ''
      Log.warn(`[crawl] crawl4ai 不可用（${why}${py}；跑 scripts/install-crawl4ai.sh 启用真浏览器渲染），走 fetch`)
    }
  }
  if (!r?.success) {
    // 降级标注：本次请求的高级能力未生效（fetch 无浏览器/无 JS），调用方据 degraded 决定是否重试或提示
    r = await doFetch(url, o)
    if (advancedUsed.length) r = { ...r, degraded: true, skipped: advancedUsed }
    if (r.success) Log.info(`[crawl] ${url} via=fetch len=${r.markdown.length}${advancedUsed.length ? `（降级：跳过 ${advancedUsed.join('/')}）` : ''}`)
  }
  if (!r?.success) Log.warn(`[crawl] ${url} 抓取失败：${r?.error}`)
  return r
}

/** web_crawl 常驻工具：抓取网页正文（category=query，人人可用，只读）。
 *  crawl4ai 完整交互能力（同态渲染处理）：wait_for 等 JS 渲染完成、js_code 滚动/点击触发懒加载、
 *  extract 结构化抽取（CSS schema → JSON）、links 链接清单、stealth 反检测、scroll 虚拟滚动长列表。
 *  降级 fetch 时这些高级参数不可用——结果带 degraded:true + skipped 列表。 */
export const webCrawlTool = {
  name: 'web_crawl',
  description: '抓取网页内容（默认 crawl4ai 真浏览器渲染，SPA/JS 动态页可抓）。基础用法返回正文 {title, text}。同态渲染页（内容由 JS 生成）：js_code 滚动/点击触发加载 + wait_for 等元素出现；需要表格/列表等结构化数据时用 extract（CSS schema → JSON 数组）；需要页面全部链接时 links:true。降级纯 HTTP 时高级参数自动跳过并在结果标注 degraded。',
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
      stealth: { type: 'boolean', description: '模拟真人浏览器指纹（绕过基础反爬检测）' },
      scroll: { type: 'object', description: '虚拟滚动加载懒加载长列表：{container_selector, scroll_count, wait_after_scroll}。适用无限滚动信息流' },
    },
    required: ['url'],
  },
  async execute(args = {}) {
    const { url, maxLength, wait_for, js_code, css_selector, extract, links, delay_ms, stealth, scroll } = args
    const u = String(url || '').trim()
    if (!/^https?:\/\//i.test(u)) return { error: 'url 需以 http:// 或 https:// 开头' }
    if (wait_for && !/^(css:|js:)/.test(String(wait_for).trim())) return { error: 'wait_for 需以 css: 或 js: 开头' }
    const r = await crawlUrl(u, {
      ...(args.engine ? { engine: String(args.engine) } : {}), // 调用方强制引擎（测试/诊断；生产走配置默认）
      waitFor: wait_for, jsCode: js_code, cssSelector: css_selector,
      extract, links: links === true, delayMs: delay_ms, stealth: stealth === true,
      virtualScroll: scroll && typeof scroll === 'object' ? scroll : null,
    })
    if (!r.success) return { error: r.error || '抓取失败', ...(r.code ? { code: r.code } : {}), ...(r.hint ? { hint: r.hint } : {}), ...(r.skipped ? { degraded: true, skipped: r.skipped } : {}) }
    const cap = Math.max(1000, Number(maxLength) || 12000)
    const out = { ok: true, url: u, title: r.title || '', via: r.via || 'fetch' }
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
