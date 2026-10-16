#!/usr/bin/env python3
"""crawl4ai 一次性抓取子进程（Node 端 model/crawl/crawl4ai.js 监管）。

对齐官方能力面（docs.crawl4ai.com，v0.9.x 核对；老版本按参数过滤优雅降级）：
  - 同态渲染（CSR/SPA）：wait_for（css:/js: 等渲染完成）+ js_code（滚动/点击触发懒加载）
    + js_code_before_wait（先触发再等待）+ delay_ms（hydration 余量，默认 800ms）
    —— 官方执行顺序：goto → js_before_wait → wait_for → delay → js_code → capture
  - 结构化抽取：extract（JsonCssExtractionStrategy：baseSelector + fields schema）
  - 虚拟滚动：virtual_scroll（VirtualScrollConfig：容器选择器/次数/间隔——懒加载长列表）
  - 整页滚动：scan_full_page + max_scroll_steps（无限加载、内容追加型站点）
  - 页面链接清单：links（内部/外部分开）
  - 反检测：stealth（浏览器级 playwright-stealth enable_stealth + 行为级 simulate_user/
    override_navigator/magic）、undetected（UndetectedAdapter 深度补丁，可与 stealth 叠加）、
    proxy（走 agent.proxy；浏览器与 fetch 一致地处理受限网络）
  - Shadow DOM 组件页：flat_shadow_dom（flatten_shadow_dom）
  - 会话复用：storage_state（宿主把该站点已有 cookie 注入浏览器上下文 → cf_clearance 等
    清关凭证可跨次复用）、user_data_dir（显式 opt-in 的持久 profile）、
    session_capture（抓完尽力导出浏览器 cookie 回传宿主，供下次注入）

协议（python-subprocess-supervision 契约）：
  - stdin  ：单行 JSON 请求；stdout：单行 JSON 结果；stderr：日志（父进程留尾部）
  - 退出码 ：0=成功 | 2=抓取失败（stdout 仍有 ok:false 结果体）| 3=请求非法
             | 4=内部异常 | 124=总看门狗超时
  - 结果码 ：blocked/challenge（反爬拦截或挑战页）| empty（无有效正文）| crawl_failed
             | request_timeout | crashed | invalid_request

运行前提：本脚本由 crawl4ai 专用 venv 的 python 启动（scripts/install-crawl4ai.sh 创建）。
失败时 Node 端自动降级 fetch+cheerio（静态抓取兜底；本脚本的高级参数在降级时不可用）。
"""
import asyncio
import inspect
import json
import re
import signal
import sys
from http.cookies import SimpleCookie
from urllib.parse import urlparse

MAX_CHARS_DEFAULT = 60000
MIN_FIT_CHARS = 200        # fit_markdown 低于此长度视为修剪过度，回退 raw_markdown
DEFAULT_DELAY_MS = 800     # hydration 余量：同态渲染组件挂载后 DOM 仍在变化（官方建议 1~3s，取保守值）
JS_MAX_CHARS = 10_000      # 单段 JS 上限（防超长注入目标页）
JS_MAX_ITEMS = 10          # js_code 数组段数上限
PROXY_MAX_CHARS = 500      # 代理 URL 上限
COOKIE_MAX_ITEMS = 200     # 会话 cookie 条数上限（注入与回传同一口径）
COOKIE_VALUE_MAX = 4096    # 单条 cookie 值上限（防超长注入）
WAIT_UNTIL_ALLOWED = ("domcontentloaded", "load", "networkidle", "commit")

# 反爬拦截 / 挑战页识别（保守：只在标题或 Cloudflare 挑战运行时变量命中，
# 避免正常页面正文含 "captcha/challenge" 等词被误判——nowsecure.nl 这类页
# 会带 challenge-platform 脚本但确实已通过验证，不能只看脚本标记）
_CHALLENGE_TITLE_RE = re.compile(r"just a moment|attention required|正在验证|请稍候.*验证|人机验证", re.I)
_CHALLENGE_BODY_RE = re.compile(
    r"enable javascript and cookies to continue|cf_chl_opt|__cf_chl|checking if the site connection is secure",
    re.I,
)
_BLOCK_TITLE_RE = re.compile(r"access denied|you have been blocked|request blocked|errors\.edgesuite\.net", re.I)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _bounded(v, lo, hi, default):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    return min(max(n, lo), hi)


def _s(v, max_len, field):
    s = str(v if v is not None else "").strip()
    if len(s) > max_len:
        emit({"ok": False, "code": "invalid_request", "error": f"{field} 超长（>{max_len} 字符）"})
        sys.exit(3)
    return s


def parse_request():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw or "{}")
    except Exception as e:
        emit({"ok": False, "code": "invalid_request", "error": f"请求 JSON 解析失败: {e}"})
        sys.exit(3)
    if not isinstance(req, dict):
        emit({"ok": False, "code": "invalid_request", "error": "请求必须是 JSON 对象"})
        sys.exit(3)

    url = _s(req.get("url"), 2000, "url")
    if not url.lower().startswith(("http://", "https://")):
        emit({"ok": False, "code": "invalid_request", "error": "url 需以 http:// 或 https:// 开头"})
        sys.exit(3)

    # wait_for：官方两种形态 css:SELECTOR / js:() => bool——前缀白名单之外拒绝（防歧义注入）
    wait_for = _s(req.get("wait_for"), 4000, "wait_for")
    if wait_for and not (wait_for.startswith("css:") or wait_for.startswith("js:")):
        emit({"ok": False, "code": "invalid_request", "error": "wait_for 需以 css: 或 js: 开头"})
        sys.exit(3)

    # js_code：str 或 list[str]（官方多段依序执行）；单段与段数上限
    raw_js = req.get("js_code")
    js_items = []
    if isinstance(raw_js, list):
        if len(raw_js) > JS_MAX_ITEMS:
            emit({"ok": False, "code": "invalid_request", "error": f"js_code 段数 >{JS_MAX_ITEMS}"})
            sys.exit(3)
        js_items = [_s(j, JS_MAX_CHARS, "js_code") for j in raw_js if str(j).strip()]
    elif raw_js:
        js_items = [_s(raw_js, JS_MAX_CHARS, "js_code")]
    js_code = js_items if len(js_items) > 1 else (js_items[0] if js_items else None)

    js_before_wait = _s(req.get("js_before_wait"), JS_MAX_CHARS, "js_before_wait") or None

    # extract：JsonCssExtractionStrategy schema（baseSelector + fields[]），形状校验
    extract = req.get("extract")
    if extract is not None:
        if not isinstance(extract, dict) or not str(extract.get("baseSelector") or "").strip():
            emit({"ok": False, "code": "invalid_request", "error": "extract 需为 {baseSelector, fields} 结构化抽取 schema"})
            sys.exit(3)
        fields = extract.get("fields")
        if not isinstance(fields, list) or not fields or len(fields) > 50 \
                or not all(isinstance(f, dict) and str(f.get("name") or "").strip() for f in fields):
            emit({"ok": False, "code": "invalid_request", "error": "extract.fields 需为非空 [{name, selector, type}] 数组（≤50 字段）"})
            sys.exit(3)

    # virtual_scroll：VirtualScrollConfig 白名单映射
    vs = req.get("virtual_scroll")
    if vs is not None and not isinstance(vs, dict):
        emit({"ok": False, "code": "invalid_request", "error": "virtual_scroll 需为对象"})
        sys.exit(3)

    # wait_until：Playwright 导航完成条件白名单（domcontentloaded/load/networkidle/commit）
    wait_until = _s(req.get("wait_until"), 32, "wait_until") or None
    if wait_until and wait_until not in WAIT_UNTIL_ALLOWED:
        emit({"ok": False, "code": "invalid_request", "error": f"wait_until 需为 {'/'.join(WAIT_UNTIL_ALLOWED)} 之一"})
        sys.exit(3)

    # extra_args：浏览器启动附加 flag（仅内部策略注入，不做 LLM 参数；形状仍校验）
    extra_args = req.get("extra_args")
    if extra_args is not None:
        if not isinstance(extra_args, list) or len(extra_args) > 20 \
                or not all(isinstance(a, str) and 0 < len(a) <= 200 for a in extra_args):
            emit({"ok": False, "code": "invalid_request", "error": "extra_args 需为 ≤20 个非空字符串（每个 ≤200 字符）"})
            sys.exit(3)

    return {
        "url": url,
        "timeout_s": _bounded(req.get("timeout_s"), 5, 300, 60),
        "max_chars": int(_bounded(req.get("max_chars"), 1000, 400000, MAX_CHARS_DEFAULT)),
        "wait_for": wait_for or None,
        "js_code": js_code,
        "js_before_wait": js_before_wait,
        "delay_ms": int(_bounded(req.get("delay_ms"), 0, 10000, DEFAULT_DELAY_MS)),
        "css_selector": _s(req.get("css_selector"), 500, "css_selector") or None,
        "extract": extract,
        "links": req.get("links") is True,
        "stealth": req.get("stealth") is True,
        "undetected": req.get("undetected") is True,
        "headless": req.get("headless") is not False,   # 默认无头（服务器环境）
        "proxy": _s(req.get("proxy"), PROXY_MAX_CHARS, "proxy") or None,
        "wait_until": wait_until,
        "scan_full_page": req.get("scan_full_page") is True,
        "max_scroll_steps": req.get("max_scroll_steps"),
        "flat_shadow_dom": req.get("flat_shadow_dom") is True,
        "virtual_scroll": vs,
        "extra_args": extra_args,
        "user_data_dir": _s(req.get("user_data_dir"), 500, "user_data_dir") or None,
        "storage_state": parse_storage_state(req.get("storage_state"), urlparse(url).hostname or ""),
        "session_capture": req.get("session_capture") is True,
    }


def sanitize_cookie(c, fallback_domain):
    """把宿主注入或浏览器导出的 cookie 归一为 playwright/crawl4ai 认得的形态（非法项返回 None）。"""
    if not isinstance(c, dict):
        return None
    name = str(c.get("name") or "").strip()
    if not name or len(name) > 200:
        return None
    domain = str(c.get("domain") or fallback_domain or "").strip()
    if not domain:
        return None
    out = {
        "name": name,
        "value": str(c.get("value") or "")[:COOKIE_VALUE_MAX],
        "domain": domain,
        "path": str(c.get("path") or "/") or "/",
        "secure": bool(c.get("secure")),
        "httpOnly": bool(c.get("httpOnly", c.get("http_only", False))),
        "sameSite": str(c.get("sameSite") or c.get("same_site") or "Lax"),
    }
    exp = c.get("expires", c.get("expiry"))
    if exp is not None:
        try:
            exp = float(exp)
            if exp > 0:
                out["expires"] = exp
        except (TypeError, ValueError):
            pass
    return out


def parse_storage_state(raw, fallback_domain):
    """宿主 storage_state → CrawlerRunConfig.storage_state（只保留白名单字段，防注入垃圾参数）。"""
    if not isinstance(raw, dict):
        return None
    cookies = raw.get("cookies")
    if not isinstance(cookies, list):
        return None
    items = [c for c in (sanitize_cookie(c, fallback_domain) for c in cookies[:COOKIE_MAX_ITEMS]) if c]
    if not items:
        return None
    origins = raw.get("origins") if isinstance(raw.get("origins"), list) else []
    return {"cookies": items, "origins": origins}


def cookies_from_set_cookie(header, fallback_domain):
    """Set-Cookie 头 → cookie 列表（回退通道；主通道是宿主 fetch 路径的 getSetCookie）。"""
    if not header:
        return []
    values = header if isinstance(header, list) else [header]
    out = []
    for v in values:
        # 组合头（多个 Set-Cookie 被并成一行）按「, 后紧跟 name=」切分；SimpleCookie 对组合串会整体失配
        for part in re.split(r",\s*(?=[^=;,\s]+\s*=)", str(v)):
            part = part.strip()
            if not part:
                continue
            try:
                jar = SimpleCookie()
                jar.load(part)
            except Exception:
                continue
            for name, morsel in jar.items():
                out.append({
                    "name": name, "value": morsel.value,
                    "domain": morsel["domain"] or fallback_domain,
                    "path": morsel["path"] or "/",
                    "secure": bool(morsel["secure"]), "httpOnly": bool(morsel["httponly"]),
                })
    return out


async def collect_browser_cookies(crawler, result, fallback_domain):
    """尽力导出浏览器 cookie（crawl4ai 各版本落点不同，全部 guarded）；cookie 值不进日志。"""
    raw = []
    for attr in ("cookies", "response_cookies"):
        v = getattr(result, attr, None)
        if isinstance(v, list):
            raw.extend(v)
        elif isinstance(v, dict):
            raw.extend({"name": k, "value": val} for k, val in v.items())
    headers = getattr(result, "response_headers", None)
    if isinstance(headers, dict):
        raw.extend(cookies_from_set_cookie(headers.get("set-cookie") or headers.get("Set-Cookie"), fallback_domain))
    try:
        ctx = getattr(getattr(crawler, "crawler_strategy", None), "browser_context", None)
        ctx = getattr(ctx, "browser_context", None) or ctx
        if ctx is not None and hasattr(ctx, "cookies"):
            raw.extend(await ctx.cookies())
    except Exception as e:  # 版本差异/上下文已关闭都不影响抓取结果
        sys.stderr.write(f"浏览器 cookie 导出失败（{type(e).__name__}: {e}）\n")
    out, seen = [], set()
    for c in (sanitize_cookie(c, fallback_domain) for c in raw):
        if not c:
            continue
        key = f'{c["domain"]}|{c["path"]}|{c["name"]}'
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out[:COOKIE_MAX_ITEMS]


def _init_params(cls):
    """取类的 __init__ 参数名集合；失败返回 None（调用方视为「不过滤」）。"""
    try:
        return set(inspect.signature(cls.__init__).parameters.keys())
    except (TypeError, ValueError):
        return None


def filter_kwargs(cls, kwargs, label):
    """按已安装版本过滤构造参数：老版本 crawl4ai 缺新字段时跳过并在 stderr 说明，
    不因版本差异整单失败（升级由 install-crawl4ai.sh 负责）。"""
    params = _init_params(cls)
    if params is None:
        return dict(kwargs)
    accepted = {k: v for k, v in kwargs.items() if k in params and k != "self"}
    dropped = sorted(k for k in kwargs if k not in accepted)
    if dropped:
        sys.stderr.write(f"crawl4ai 版本不支持 {label} 参数，已跳过: {', '.join(dropped)}\n")
    return accepted


def build_browser_config(BrowserConfig, p):
    kwargs = {"headless": p["headless"], "verbose": False}
    if p["stealth"]:
        kwargs["enable_stealth"] = True  # playwright-stealth（v0.7+ 字段，老版本经 filter_kwargs 跳过）
    if p["proxy"]:
        params = _init_params(BrowserConfig) or set()
        if "proxy_config" in params:
            kwargs["proxy_config"] = p["proxy"]  # v0.8+ 推荐字段
        elif "proxy" in params:
            kwargs["proxy"] = p["proxy"]         # 老字段（deprecated 但可用）
        else:
            sys.stderr.write("crawl4ai 版本不支持浏览器代理配置，已忽略 proxy\n")
    if p["extra_args"]:
        kwargs["extra_args"] = list(p["extra_args"])
    if p["user_data_dir"]:
        kwargs["user_data_dir"] = p["user_data_dir"]  # 持久 profile（显式 opt-in；与并发浏览器互斥）
    return BrowserConfig(**filter_kwargs(BrowserConfig, kwargs, "BrowserConfig"))


def build_run_config(deps, p):
    run_kwargs = dict(
        cache_mode=deps.CacheMode.BYPASS,       # 每次实抓（知识库刷新依赖真实最新内容）
        page_timeout=int(p["timeout_s"] * 1000),
        word_count_threshold=5,
        excluded_tags=["nav", "footer", "header", "aside", "form"],
        remove_overlay_elements=True,
        # 正文去外链（markdown 已 ignore_links，这里防 cleaned_html 混入外站导航）；
        # links 清单请求时让位——用户要的就是完整内外链列表（曾把 external 清单也剥空）
        exclude_external_links=not p["links"],
        # 同态渲染：导航后等 hydration 余量再取 HTML（组件挂载后 DOM 仍在变）
        delay_before_return_html=p["delay_ms"] / 1000.0,
    )
    if p["wait_until"]:
        run_kwargs["wait_until"] = p["wait_until"]
    if p["wait_for"]:
        run_kwargs["wait_for"] = p["wait_for"]
    if p["js_before_wait"]:
        # 官方顺序：goto → js_code_before_wait（触发）→ wait_for（等内容出现）
        run_kwargs["js_code_before_wait"] = p["js_before_wait"]
    if p["js_code"]:
        run_kwargs["js_code"] = p["js_code"]
    if p["css_selector"]:
        run_kwargs["css_selector"] = p["css_selector"]
    if p["stealth"]:
        # 行为级反检测（浏览器级 enable_stealth 见 build_browser_config）
        run_kwargs.update(simulate_user=True, override_navigator=True, magic=True)
    if p["scan_full_page"]:
        run_kwargs["scan_full_page"] = True
        if p["max_scroll_steps"] is not None:
            run_kwargs["max_scroll_steps"] = int(_bounded(p["max_scroll_steps"], 1, 200, 30))
    if p["flat_shadow_dom"]:
        run_kwargs["flatten_shadow_dom"] = True
    if p["virtual_scroll"]:
        try:
            from crawl4ai import VirtualScrollConfig
            v = p["virtual_scroll"]
            run_kwargs["virtual_scroll_config"] = VirtualScrollConfig(
                container_selector=str(v.get("container_selector") or "body")[:500],
                scroll_count=int(_bounded(v.get("scroll_count"), 1, 50, 10)),
                scroll_by=str(v.get("scroll_by") or "container_height"),
                wait_after_scroll=_bounded(v.get("wait_after_scroll"), 0.1, 5.0, 1.0),
            )
        except ImportError:
            sys.stderr.write("此版本 crawl4ai 不支持 VirtualScrollConfig，忽略 virtual_scroll\n")
    if p["storage_state"]:
        # 该站点已有 cookie（含 cf_clearance 等清关凭证）注入浏览器上下文；老版本经 filter_kwargs 跳过
        run_kwargs["storage_state"] = p["storage_state"]
    if p["extract"]:
        from crawl4ai import JsonCssExtractionStrategy
        schema = {"name": str(p["extract"].get("name") or "Items"), **{k: v for k, v in p["extract"].items() if k != "name"}}
        run_kwargs["extraction_strategy"] = JsonCssExtractionStrategy(schema)
    else:
        run_kwargs["markdown_generator"] = deps.DefaultMarkdownGenerator(
            content_filter=deps.PruningContentFilter(threshold=0.45),
            options={"ignore_links": True, "body_width": 0},
        )
    return deps.CrawlerRunConfig(**filter_kwargs(deps.CrawlerRunConfig, run_kwargs, "CrawlerRunConfig"))


def extract_markdown(result):
    """跨版本稳健取 markdown：v0.5+ 是 MarkdownContainer（raw/fit），旧版可能是 str。"""
    md = getattr(result, "markdown", None)
    if md is None:
        return "", False
    if isinstance(md, str):
        return md, False
    raw = getattr(md, "raw_markdown", None) or ""
    fit = getattr(md, "fit_markdown", None) or ""
    # fit 是 PruningContentFilter 修剪后正文；过短（中文页阈值失配等）回退 raw
    if fit and len(fit) >= MIN_FIT_CHARS:
        return fit, True
    return raw or fit, False


def links_payload(result, cap=200):
    """result.links：{internal: [{href,text}...], external: [...]} → 精简 {href,text} 列表。"""
    out = {}
    links = getattr(result, "links", None)
    if not isinstance(links, dict):
        return None
    for kind in ("internal", "external"):
        slim = []
        for it in (links.get(kind) or [])[:cap]:
            if isinstance(it, dict):
                href = str(it.get("href") or "")[:300]
                text = str(it.get("text") or "").strip()[:60]
                if href:
                    slim.append({"href": href, "text": text})
            elif it:
                slim.append({"href": str(it)[:300], "text": ""})
        out[kind] = slim
    return out


def blocked_kind(title, status, html):
    """成功抓取但内容实为反爬挑战/拦截页的识别（返回 'challenge' / 'blocked' / None）。

    保守策略：只认标题特征与 Cloudflare 挑战运行时变量/兜底文案——它们不会出现在
    正常正文里；不能只看 challenge-platform 脚本（多数通过验证的 CF 站点也会加载它）。"""
    t = str(title or "")
    body = str(html or "")[:300000]
    if _CHALLENGE_TITLE_RE.search(t) or _CHALLENGE_BODY_RE.search(body):
        return "challenge"
    if _BLOCK_TITLE_RE.search(t):
        return "blocked"
    try:
        sc = int(status or 0)
    except (TypeError, ValueError):
        sc = 0
    if sc in (401, 403, 429) and re.search(r"captcha|人机验证|安全验证|滑动验证", body, re.I):
        return "challenge"
    return None


def crawl_stats_payload(result):
    """crawl_stats（v0.9+ anti-bot 重试登记）：attempts/retries/resolved_by 等，跨版本缺失为 None。"""
    stats = getattr(result, "crawl_stats", None)
    if not isinstance(stats, dict):
        return None
    keep = {}
    for k in ("attempts", "retries", "resolved_by", "fallback_fetch_used"):
        v = stats.get(k)
        if v is not None and isinstance(v, (int, float, str, bool)):
            keep[k] = v
    return keep or None


class _Deps:
    """crawl4ai 运行期依赖集合（显式注入 build_* 助手，避免隐式全局引用漏导入）。"""

    def __init__(self, **kw):
        self.__dict__.update(kw)


async def crawl(p):
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
    from crawl4ai.content_filter_strategy import PruningContentFilter
    from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

    deps = _Deps(
        CrawlerRunConfig=CrawlerRunConfig, CacheMode=CacheMode,
        PruningContentFilter=PruningContentFilter, DefaultMarkdownGenerator=DefaultMarkdownGenerator,
    )
    browser_config = build_browser_config(BrowserConfig, p)
    run_config = build_run_config(deps, p)

    crawler = None
    if p["undetected"]:
        try:
            from crawl4ai import UndetectedAdapter
            from crawl4ai.async_crawler_strategy import AsyncPlaywrightCrawlerStrategy
            strategy_kwargs = filter_kwargs(
                AsyncPlaywrightCrawlerStrategy,
                {"browser_config": browser_config, "browser_adapter": UndetectedAdapter()},
                "AsyncPlaywrightCrawlerStrategy",
            )
            crawler = AsyncWebCrawler(crawler_strategy=AsyncPlaywrightCrawlerStrategy(**strategy_kwargs), config=browser_config)
        except (ImportError, TypeError) as e:
            sys.stderr.write(f"undetected 模式不可用（{type(e).__name__}: {e}），回退常规浏览器\n")
            crawler = None
    if crawler is None:
        crawler = AsyncWebCrawler(config=browser_config)

    fallback_domain = urlparse(p["url"]).hostname or ""
    async with crawler:
        result = await crawler.arun(url=p["url"], config=run_config)
        status = getattr(result, "status_code", None) or getattr(result, "status", None)
        meta = getattr(result, "metadata", None) or {}
        title = str(meta.get("title") or "") if isinstance(meta, dict) else ""
        if not title:
            title = str(getattr(result, "title", "") or "")
        # 会话回传：失败/挑战路径同样要导出（CF 在挑战响应里也下发 __cf_bm 等）
        session_cookies = await collect_browser_cookies(crawler, result, fallback_domain) if p["session_capture"] else []
        if session_cookies:
            sys.stderr.write(f"导出浏览器 cookie {len(session_cookies)} 条（供宿主按站点复用）\n")

        if not result.success:
            err = getattr(result, "error_message", None) or f"HTTP {status or '?'}"
            err = str(err)
            # crawl4ai v0.9+ 自带反爬检测（"Blocked by anti-bot protection: ..."）→ 结构化 blocked
            code = "blocked" if re.search(r"anti-bot|blocked", err, re.I) else "crawl_failed"
            payload = {"ok": False, "url": p["url"], "status_code": status, "code": code, "error": err}
            if session_cookies:
                payload["cookies"] = session_cookies
            emit(payload)
            return 2

        kind = blocked_kind(title, status, getattr(result, "html", ""))
        if kind:
            payload = {
                "ok": False, "url": p["url"], "status_code": status, "code": kind,
                "error": f"内容为反爬{'挑战页' if kind == 'challenge' else '拦截页'}（title={title[:80]}）",
            }
            if session_cookies:
                payload["cookies"] = session_cookies
            emit(payload)
            return 2

        out = {"ok": True, "url": str(getattr(result, "url", None) or p["url"]), "status_code": status, "title": title}
        if session_cookies:
            out["cookies"] = session_cookies
        stats = crawl_stats_payload(result)
        if stats:
            out["crawl_stats"] = stats

        # 结构化抽取模式：新版字段 extracted_content（旧版/文档写作 extracted_data），可能已是
        # list、{schemaName: [items]} 或 JSON 字符串——三者都归一到 items 列表
        if p["extract"]:
            data = getattr(result, "extracted_content", None)
            if data is None:
                data = getattr(result, "extracted_data", None)
            if isinstance(data, str):
                try:
                    data = json.loads(data)
                except (ValueError, TypeError):
                    data = None
            items = []
            if isinstance(data, dict):
                for v in (data or {}).values():
                    if isinstance(v, list):
                        items = v
                        break
            elif isinstance(data, list):
                items = data
            if not items:
                out.update(code="extract_empty", error="extract 未命中任何条目（检查 baseSelector/fields 与页面结构）", extracted=[])
                emit(out)  # out 已含 cookies（若有）
                return 2
            out["extracted"] = items[:500]
            out["extracted_count"] = len(items)
        else:
            markdown, fit_used = extract_markdown(result)
            if not markdown or len(markdown.strip()) < 20:
                payload = {"ok": False, "url": p["url"], "status_code": status, "code": "empty", "error": "页面无有效正文"}
                if session_cookies:
                    payload["cookies"] = session_cookies
                emit(payload)
                return 2
            full_len = len(markdown)
            truncated = full_len > p["max_chars"]
            if truncated:
                markdown = markdown[: p["max_chars"]]
            out.update(markdown=markdown, fit_used=fit_used, raw_len=full_len, truncated=truncated)

        if p["links"]:
            lp = links_payload(result)
            if lp:
                out["links"] = lp
        emit(out)
        return 0


async def main():
    p = parse_request()
    # 总看门狗：页面超时 + 延时 + 浏览器启停余量；再兜一层防无限挂起（父侧也有独立超时）
    watchdog = p["timeout_s"] + (p["delay_ms"] / 1000.0) + 45
    try:
        return await asyncio.wait_for(crawl(p), timeout=watchdog)
    except asyncio.TimeoutError:
        emit({"ok": False, "url": p["url"], "code": "request_timeout", "error": f"总超时（>{watchdog:.0f}s，含浏览器启停）"})
        return 124
    except SystemExit:
        raise
    except ImportError as e:
        sys.stderr.write(f"crawl4ai 未安装或缺依赖: {e}\n")
        emit({"ok": False, "url": p["url"], "code": "crashed", "error": f"crawl4ai 不可用: {e}"})
        return 4
    except Exception as e:  # noqa: BLE001 —— 边界进程：任何异常都要结构化汇报给父侧
        sys.stderr.write(f"Unhandled: {type(e).__name__}: {e}\n")
        emit({"ok": False, "url": p["url"], "code": "crashed", "error": f"{type(e).__name__}: {e}"})
        return 4


if __name__ == "__main__":
    # SIGTERM → SystemExit：让 asyncio 上下文管理器关掉浏览器（父侧 kill 是最后手段）
    def _on_term(signum, frame):
        raise SystemExit(124)
    signal.signal(signal.SIGTERM, _on_term)
    try:
        sys.exit(asyncio.run(main()))
    except SystemExit:
        raise
