#!/usr/bin/env python3
"""crawl4ai 一次性抓取子进程（Node 端 model/crawl/crawl4ai.js 监管）。

对齐官方能力面（docs.crawl4ai.com Page Interaction / Simple Crawl / Extraction）：
  - 同态渲染（CSR/SPA）：wait_for（css:/js: 等渲染完成）+ js_code（滚动/点击触发懒加载）
    + js_code_before_wait（先触发再等待）+ delay_ms（hydration 余量，默认 800ms）
    —— 官方执行顺序：goto → js_before_wait → wait_for → delay → js_code → capture
  - 结构化抽取：extract（JsonCssExtractionStrategy：baseSelector + fields schema）
  - 虚拟滚动：virtual_scroll（VirtualScrollConfig：容器选择器/次数/间隔——懒加载长列表）
  - 页面链接清单：links（内部/外部分开）
  - 反检测：stealth（simulate_user + override_navigator + magic）
  - Shadow DOM 组件页：flat_shadow_dom（flatten_shadow_dom）

协议（python-subprocess-supervision 契约）：
  - stdin  ：单行 JSON 请求；stdout：单行 JSON 结果；stderr：日志（父进程留尾部）
  - 退出码 ：0=成功 | 2=抓取失败（stdout 仍有 ok:false 结果体）| 3=请求非法
             | 4=内部异常 | 124=总看门狗超时

运行前提：本脚本由 crawl4ai 专用 venv 的 python 启动（scripts/install-crawl4ai.sh 创建）。
失败时 Node 端自动降级 fetch+cheerio（静态抓取兜底；本脚本的高级参数在降级时不可用）。
"""
import asyncio
import json
import signal
import sys

MAX_CHARS_DEFAULT = 60000
MIN_FIT_CHARS = 200        # fit_markdown 低于此长度视为修剪过度，回退 raw_markdown
DEFAULT_DELAY_MS = 800     # hydration 余量：同态渲染组件挂载后 DOM 仍在变化（官方建议 1~3s，取保守值）
JS_MAX_CHARS = 10_000      # 单段 JS 上限（防超长注入目标页）
JS_MAX_ITEMS = 10          # js_code 数组段数上限


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
        "flat_shadow_dom": req.get("flat_shadow_dom") is True,
        "virtual_scroll": vs,
    }


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


async def crawl(p):
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
    from crawl4ai.content_filter_strategy import PruningContentFilter
    from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

    run_kwargs = dict(
        cache_mode=CacheMode.BYPASS,            # 每次实抓（知识库刷新依赖真实最新内容）
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
        run_kwargs.update(simulate_user=True, override_navigator=True, magic=True)
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
    if p["extract"]:
        from crawl4ai import JsonCssExtractionStrategy
        schema = {"name": str(p["extract"].get("name") or "Items"), **{k: v for k, v in p["extract"].items() if k != "name"}}
        run_kwargs["extraction_strategy"] = JsonCssExtractionStrategy(schema)
    else:
        run_kwargs["markdown_generator"] = DefaultMarkdownGenerator(
            content_filter=PruningContentFilter(threshold=0.45),
            options={"ignore_links": True, "body_width": 0},
        )

    run_config = CrawlerRunConfig(**run_kwargs)
    browser_config = BrowserConfig(headless=True, verbose=False)
    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await crawler.arun(url=p["url"], config=run_config)
        if not result.success:
            err = getattr(result, "error_message", None) or f"HTTP {getattr(result, 'status_code', '?')}"
            emit({"ok": False, "url": p["url"], "code": "crawl_failed", "error": str(err)})
            return 2

        status = getattr(result, "status_code", None) or getattr(result, "status", None)
        meta = getattr(result, "metadata", None) or {}
        title = str(meta.get("title") or "") if isinstance(meta, dict) else ""
        if not title:
            title = str(getattr(result, "title", "") or "")

        out = {"ok": True, "url": str(getattr(result, "url", None) or p["url"]), "status_code": status, "title": title}

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
                emit(out)
                return 2
            out["extracted"] = items[:500]
            out["extracted_count"] = len(items)
        else:
            markdown, fit_used = extract_markdown(result)
            if not markdown or len(markdown.strip()) < 20:
                emit({"ok": False, "url": p["url"], "status_code": status, "error": "页面无有效正文"})
                return 2
            truncated = len(markdown) > p["max_chars"]
            if truncated:
                markdown = markdown[: p["max_chars"]]
            out.update(markdown=markdown, fit_used=fit_used, raw_len=len(markdown), truncated=truncated)

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
