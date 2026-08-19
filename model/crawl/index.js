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
import { runCrawl4ai, isCrawl4aiAvailable } from './crawl4ai.js'

function kbCfg() {
  return Config.get?.()?.agent?.kb || {}
}

/** 真实浏览器 UA + 常用头（减少 403/反爬拒抓） */
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

/** Node fetch HTML → cheerio 正文提取（去 script/style/nav/footer 等 + 优先正文区 + 文本清洗）。 */
export async function crawlWithFetch(url, { timeout = 30 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout * 1000)
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, signal: ctrl.signal, redirect: 'follow' })
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` }
    const html = await res.text()
    clearTimeout(timer)
    const $ = load(html)
    const title = $('title').first().text().trim() || $('h1').first().text().trim() || ''
    // 去噪：脚本/样式/模板/隐藏/导航/页眉页脚/侧栏/表单/iframe/svg
    $([
      'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas',
      'nav', 'footer', 'header', 'aside', 'form', 'button',
    ].join(',')).remove()
    $('[style*="display:none"],[style*="display: none"],[hidden],aria-hidden').remove()

    // 优先正文区（article/main/[role=main]/常见内容容器），否则退回 body
    const rootSel = ['article', 'main', '[role="main"]', '#content', '#main', '.content', '.article', '.post-content', '.entry-content'].join(',')
    let root = $(rootSel).first()
    if (!root.length) root = $('body')
    let text = root.text().replace(/\s+/g, ' ').trim()

    // 正文区太短（疑似误选或 SPA 空壳）→ 降级全 body
    if (text.length < 50) {
      text = $('body').text().replace(/\s+/g, ' ').trim()
    }
    if (!text || text.length < 20) return { success: false, error: '页面无有效正文（可能是 JS 动态渲染页）' }
    return { success: true, markdown: text, title, via: 'fetch' }
  } catch (e) {
    clearTimeout(timer)
    return { success: false, error: `fetch 失败：${e?.name === 'AbortError' ? '超时' : (e?.message || e)}` }
  }
}

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
    let ok = false
    try { ok = !!(await avail()).ok } catch { ok = false }
    if (ok) {
      try { r = await doC4ai(url, c4aiOpts) } catch (e) { r = { success: false, code: 'crashed', error: e?.message || String(e) } }
      if (r?.success) Log.info(`[crawl] ${url} via=crawl4ai${r.extractedCount != null ? ` extracted=${r.extractedCount}` : ''} len=${r.markdown?.length ?? 0}`)
      else Log.warn(`[crawl] ${url} crawl4ai 失败（${r?.code || '?'} ${r?.error || ''}），降级 fetch`)
    } else {
      Log.warn(`[crawl] crawl4ai 不可用（venv 未安装；跑 scripts/install-crawl4ai.sh 启用真浏览器渲染），走 fetch`)
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
    if (!r.success) return { error: r.error || '抓取失败', ...(r.skipped ? { degraded: true, skipped: r.skipped } : {}) }
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
