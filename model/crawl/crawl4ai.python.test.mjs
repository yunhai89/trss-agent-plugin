/**
 * crawl4ai_fetch.py 假库离线自检 —— 用「假 crawl4ai 包」在纯 Python 下跑通子进程脚本全流程
 * （真实 venv 不可用时也能回归）：请求解析/参数过滤（新旧版本）/BrowserConfig 与 RunConfig
 * 映射/挑战页与反爬识别/空正文/结构化抽取/链接清单/undetected 策略。
 *
 * 为什么需要它：Node 侧测试用桩子进程验证协议层，但 python 脚本自身的名字作用域、
 * 版本过滤、字段映射错误（如 CacheMode/DefaultMarkdownGenerator 未导入）只有真跑才暴露。
 * 运行：node model/crawl/crawl4ai.python.test.mjs（未装 python3 时打印 SKIP_FILE 跳过）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

const PY = process.env.PYTHON || 'python3'
const probe = spawnSync(PY, ['-c', 'print("ok")'], { encoding: 'utf8' })
if (probe.status !== 0) {
  console.log('SKIP_FILE: 未找到可用的 python3，跳过 crawl4ai_fetch.py 假库自检')
  process.exit(0)
}

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'python', 'crawl4ai_fetch.py')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl4ai-py-test-'))
const PKG = path.join(TMP, 'crawl4ai')
fs.mkdirSync(PKG, { recursive: true })

/** 假 crawl4ai 包：签名严格（验证版本过滤）、结果按 URL 分支、收到参数落盘供断言 */
const INIT_PY = `
import json, os, sys

MODE = os.environ.get("FAKE_C4AI_MODE", "full")

class CacheMode:
    BYPASS = "bypass"

class _Rec:
    def __init__(self, label, **kw):
        self._label = label
        self._kw = kw
    def dump(self):
        return {self._label: self._kw}

def _echo(*recs):
    p = os.environ.get("FAKE_C4AI_ECHO")
    if not p:
        return
    out = {}
    for r in recs:
        out.update(r.dump())
    with open(p, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

class _MD:
    def __init__(self, raw="", fit=""):
        self.raw_markdown = raw
        self.fit_markdown = fit

class _Result:
    def __init__(self, **kw):
        self.__dict__.update(kw)

class AsyncWebCrawler:
    def __init__(self, config=None, crawler_strategy=None, **kw):
        self.config = config
        self.strategy = crawler_strategy
    async def __aenter__(self):
        return self
    async def __aexit__(self, *a):
        return False
    async def arun(self, url=None, config=None):
        _echo(
            _Rec("browser", **self.config._kw),
            _Rec("run", **config._kw),
            _Rec("strategy", adapter=getattr(self.strategy, "adapter_name", None)),
        )
        if url and "challenge" in url:
            return _Result(success=True, status_code=200, metadata={"title": "Just a moment..."},
                           html="<html><body>cf_chl_opt</body></html>", url=url, crawl_stats={"attempts": 1, "resolved_by": "direct"})
        if url and "blocked" in url:
            return _Result(success=False, status_code=403, error_message="Blocked by anti-bot protection: HTTP 403 with HTML content (34854 bytes)", url=url)
        if url and "empty" in url:
            return _Result(success=True, status_code=200, metadata={"title": "空"}, html="<html><body></body></html>", markdown=_MD("", ""), url=url)
        if url and "extract" in url:
            return _Result(success=True, status_code=200, metadata={"title": "抽取"}, html="<html><body>ok</body></html>", url=url,
                           extracted_content=json.dumps([{"t": "a"}, {"t": "b"}]),
                           links={"internal": [{"href": "/x", "text": "X"}], "external": [{"href": "https://e.com/", "text": "E"}]})
        return _Result(success=True, status_code=200, metadata={"title": "标题"}, html="<html><body>ok</body></html>", url=url,
                       markdown=_MD("原始正文" * 80, "修剪正文" * 80))

if MODE == "full":
    class BrowserConfig(_Rec):
        def __init__(self, headless=True, verbose=False, enable_stealth=False, proxy_config=None, proxy=None,
                     extra_args=None, user_agent=None, **_ignore):
            super().__init__("browser", headless=headless, verbose=verbose, enable_stealth=enable_stealth,
                             proxy_config=proxy_config, proxy=proxy, extra_args=extra_args)

    class CrawlerRunConfig(_Rec):
        def __init__(self, cache_mode=None, page_timeout=60000, word_count_threshold=200, excluded_tags=None,
                     remove_overlay_elements=False, exclude_external_links=False, delay_before_return_html=0.1,
                     wait_until=None, wait_for=None, js_code_before_wait=None, js_code=None, css_selector=None,
                     simulate_user=False, override_navigator=False, magic=False, scan_full_page=False,
                     max_scroll_steps=None, flatten_shadow_dom=False, virtual_scroll_config=None,
                     extraction_strategy=None, markdown_generator=None, **_ignore):
            super().__init__("run", cache_mode=cache_mode, page_timeout=page_timeout, wait_until=wait_until, wait_for=wait_for,
                             js_code=js_code, js_code_before_wait=js_code_before_wait, css_selector=css_selector,
                             simulate_user=simulate_user, override_navigator=override_navigator, magic=magic,
                             scan_full_page=scan_full_page, max_scroll_steps=max_scroll_steps,
                             flatten_shadow_dom=flatten_shadow_dom, has_virtual_scroll=virtual_scroll_config is not None,
                             has_extraction=extraction_strategy is not None, has_markdown_generator=markdown_generator is not None,
                             delay_before_return_html=delay_before_return_html)

    class JsonCssExtractionStrategy:
        def __init__(self, schema, **kw):
            self.schema = schema

    class VirtualScrollConfig:
        def __init__(self, **kw):
            self.kw = kw

    class UndetectedAdapter:
        pass

    class AsyncPlaywrightCrawlerStrategy:
        def __init__(self, browser_config=None, browser_adapter=None):
            self.adapter_name = type(browser_adapter).__name__ if browser_adapter else None
else:
    # 旧版本形态：缺 enable_stealth/proxy_config/extra_args/wait_until/scan_full_page/... 且无 undetected 支持
    class BrowserConfig(_Rec):
        def __init__(self, headless=True, verbose=False, **_ignore):
            super().__init__("browser", headless=headless, verbose=verbose)

    class CrawlerRunConfig(_Rec):
        def __init__(self, cache_mode=None, page_timeout=60000, word_count_threshold=200, excluded_tags=None,
                     remove_overlay_elements=False, exclude_external_links=False, delay_before_return_html=0.1,
                     wait_for=None, js_code=None, css_selector=None, simulate_user=False, override_navigator=False, magic=False, **_ignore):
            super().__init__("run", cache_mode=cache_mode, page_timeout=page_timeout, wait_for=wait_for, js_code=js_code,
                             css_selector=css_selector, simulate_user=simulate_user, override_navigator=override_navigator,
                             magic=magic, delay_before_return_html=delay_before_return_html)
`
fs.writeFileSync(path.join(PKG, '__init__.py'), INIT_PY)
fs.writeFileSync(path.join(PKG, 'content_filter_strategy.py'), 'class PruningContentFilter:\n    def __init__(self, threshold=0.45):\n        self.threshold = threshold\n')
fs.writeFileSync(path.join(PKG, 'markdown_generation_strategy.py'), 'class DefaultMarkdownGenerator:\n    def __init__(self, content_filter=None, options=None):\n        self.content_filter = content_filter\n        self.options = options\n')
// 子模块形态与真实包一致（脚本按 crawl4ai.async_crawler_strategy 导入；旧版模式无此类 → ImportError 回退）
fs.writeFileSync(path.join(PKG, 'async_crawler_strategy.py'), 'from crawl4ai import AsyncPlaywrightCrawlerStrategy  # noqa: F401  （仅 full 模式存在）\n')

/**
 * 跑脚本。返回 { status, stdout, stderr, echo }（echo=假库收到的构造参数）
 */
function runPy(req, { mode = 'full', echo = true } = {}) {
  const echoFile = echo ? path.join(TMP, `echo-${Math.random().toString(36).slice(2)}.json`) : ''
  const r = spawnSync(PY, [SCRIPT], {
    input: JSON.stringify(req) + '\n',
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, PYTHONPATH: TMP, FAKE_C4AI_MODE: mode, ...(echoFile ? { FAKE_C4AI_ECHO: echoFile } : {}) },
  })
  let parsed = null
  for (const line of String(r.stdout || '').split('\n').reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try { parsed = JSON.parse(t); break } catch { /* 坏帧继续 */ }
  }
  let echoed = null
  if (echoFile && fs.existsSync(echoFile)) { try { echoed = JSON.parse(fs.readFileSync(echoFile, 'utf8')) } catch { /* noop */ } }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', parsed, echoed }
}

await test('正常路径：请求字段 → BrowserConfig/RunConfig 映射（stealth/代理/等待条件/滚动）', () => {
  const { status, parsed, echoed, stderr } = runPy({
    url: 'https://example.com/ok',
    timeout_s: 30, max_chars: 2000,
    stealth: true, proxy: 'http://user:pass@127.0.0.1:7890', extra_args: ['--disable-dev-shm-usage'],
    wait_until: 'load', scan_full_page: true, max_scroll_steps: 12, flat_shadow_dom: true,
    links: true,
  })
  eq(status, 0, `退出码 0（stderr=${String(stderr).slice(0, 150)}）`)
  eq(parsed?.ok, true, 'stdout ok:true')
  eq(parsed?.title, '标题', 'title 透传')
  ok(String(parsed?.markdown || '').includes('修剪正文'), 'fit_markdown 优先（≥200 字）')
  eq(echoed?.browser?.enable_stealth, true, 'enable_stealth 进入 BrowserConfig')
  eq(echoed?.browser?.proxy_config, 'http://user:pass@127.0.0.1:7890', 'proxy 进入 BrowserConfig.proxy_config')
  eq(echoed?.browser?.extra_args?.[0], '--disable-dev-shm-usage', 'extra_args 透传')
  eq(echoed?.run?.wait_until, 'load', 'wait_until 映射到 RunConfig')
  eq(echoed?.run?.scan_full_page, true, 'scan_full_page 映射到 RunConfig')
  eq(echoed?.run?.max_scroll_steps, 12, 'max_scroll_steps 映射到 RunConfig')
  eq(echoed?.run?.simulate_user, true, 'behavior 级 stealth（simulate_user）开启')
  eq(echoed?.run?.has_markdown_generator, true, '正文模式挂 markdown_generator（PruningContentFilter）')
})

await test('挑战页/反爬拦截/空正文：分别结构化返回 challenge/blocked/empty（退出 2）', () => {
  let r = runPy({ url: 'https://example.com/challenge', timeout_s: 20 })
  eq(r.status, 2, 'challenge 退出码 2')
  eq(r.parsed?.code, 'challenge', '成功但挑战页 → code=challenge')
  r = runPy({ url: 'https://example.com/blocked', timeout_s: 20 })
  eq(r.status, 2, 'blocked 退出码 2')
  eq(r.parsed?.code, 'blocked', 'crawl4ai 反爬报错 → code=blocked')
  r = runPy({ url: 'https://example.com/empty', timeout_s: 20 })
  eq(r.status, 2, 'empty 退出码 2')
  eq(r.parsed?.code, 'empty', '空正文 → code=empty')
})

await test('结构化抽取 + 链接清单：extracted 数组与 links 载荷映射', () => {
  const r = runPy({
    url: 'https://example.com/extract', timeout_s: 20,
    extract: { baseSelector: '.item', fields: [{ name: 't', selector: '.t', type: 'text' }] },
    links: true,
  })
  eq(r.status, 0, '退出码 0')
  eq(r.parsed?.extracted?.length, 2, 'extracted 归一为数组')
  eq(r.parsed?.extracted_count, 2, 'extracted_count 输出')
  eq(r.echoed?.run?.has_extraction, true, 'extraction_strategy 进入 RunConfig')
  eq(r.echoed?.run?.has_markdown_generator, false, '抽取模式不挂正文 markdown_generator')
  eq(r.parsed?.links?.internal?.[0]?.href, '/x', 'links.internal 精简映射')
  eq(r.parsed?.links?.external?.[0]?.href, 'https://e.com/', 'links.external 精简映射')
})

await test('undetected 模式：走 UndetectedAdapter + AsyncPlaywrightCrawlerStrategy', () => {
  const r = runPy({ url: 'https://example.com/ok', timeout_s: 20, undetected: true, stealth: true })
  eq(r.status, 0, `退出码 0（stderr=${String(r.stderr).slice(0, 150)}）`)
  eq(r.echoed?.strategy?.adapter, 'UndetectedAdapter', '适配器为 UndetectedAdapter')
})

await test('新参数在旧版 crawl4ai（参数缺失）下优雅降级：不崩溃 + stderr 说明跳过项', () => {
  const r = runPy({
    url: 'https://example.com/ok', timeout_s: 20,
    stealth: true, proxy: 'http://127.0.0.1:7890', wait_until: 'load', scan_full_page: true,
  }, { mode: 'old' })
  eq(r.status, 0, `旧版下仍成功（stderr=${String(r.stderr).slice(0, 200)}）`)
  ok(/已跳过/.test(r.stderr), 'stderr 说明跳过的新参数')
  eq(r.echoed?.browser?.enable_stealth, undefined, '旧版 BrowserConfig 未收到 enable_stealth')
  eq(r.echoed?.run?.wait_until, undefined, '旧版 RunConfig 未收到 wait_until')
})

await test('旧版 + undetected：ImportError 回退常规浏览器（stderr 提示，不整单失败）', () => {
  const r = runPy({ url: 'https://example.com/ok', timeout_s: 20, undetected: true }, { mode: 'old' })
  eq(r.status, 0, '退出码 0')
  ok(/undetected 模式不可用/.test(r.stderr), 'stderr 提示 undetected 不可用并回退')
  eq(r.echoed?.strategy?.adapter, null, '未走 UndetectedAdapter')
})

await test('请求校验：非法 wait_until / 非法 extract / 非 http URL → invalid_request（退出 3）', () => {
  let r = runPy({ url: 'https://example.com/', wait_until: 'weird' }, { echo: false })
  eq(r.status, 3, '非法 wait_until 退出 3')
  eq(r.parsed?.code, 'invalid_request', 'code=invalid_request')
  r = runPy({ url: 'https://example.com/', extract: { fields: [] } }, { echo: false })
  eq(r.status, 3, '非法 extract 退出 3')
  r = runPy({ url: 'ftp://example.com/' }, { echo: false })
  eq(r.status, 3, '非 http(s) URL 退出 3')
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
fs.rmSync(TMP, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
