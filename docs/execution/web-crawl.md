# 网页抓取（web_crawl / crawl4ai）

> 本文是主 README 的拆分文档。返回 [README](../../README.md)。

## 🕸️ 网页抓取（web_crawl / crawl4ai）

> `web_crawl` 常驻工具（query 类，全员可用）与知识库 URL 入库/刷新共用同一抓取链路。默认走 [crawl4ai](https://docs.crawl4ai.com) 真浏览器渲染（Playwright Chromium）：SPA/JS 动态页、同态渲染页都能拿到渲染后正文；未安装或失败自动降级纯 HTTP + cheerio（静态兜底）。

**安装真浏览器渲染（可选，强烈建议）**：

```sh
sh plugins/agents-plugin/scripts/install-crawl4ai.sh   # 独立 venv + Playwright Chromium（约 300~500MB）
# 国内镜像加速示例：
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple sh scripts/install-crawl4ai.sh
```

安装后 `web_crawl` 默认走浏览器；`config.yaml → agent.kb.crawl.engine: fetch` 可强制纯 HTTP。多个插件副本时注意 venv 装在**正在运行的那一份**目录下（日志会打印实际解释器路径）。

**反爬链**（`agent.kb.crawl`）：

```yaml
kb:
  crawl:
    engine: crawl4ai      # crawl4ai（默认真浏览器）| fetch（纯 HTTP+cheerio）
    stealth: true         # 浏览器路径反检测（playwright-stealth + 模拟用户行为），默认开
    retryBlocked: true    # 被反爬拦截（403/CF 挑战等）时自动 undetected+stealth 强化再试一轮
    allowPrivateHosts: false  # 允许抓取本机/内网/元数据地址（防 SSRF，默认禁）
    sessionPersist: true      # 按站点持久化 cookie（清关凭证 12h 内复用；data/crawl/sessions.json，0600）
    sessionTtlHours: 12       # 会话有效期（小时）
    sessionProfile: false     # 持久浏览器 profile（user_data_dir，显式 opt-in；开启后浏览器全局串行）
    siteMemory: true          # 站点难度记忆：上次 fetch 够用就不再起浏览器；上次被拦就直接 undetected
    perHostIntervalMs: 1200   # 同站点最小抓取间隔（毫秒，含抖动）
    hostConcurrency: 1        # 同站点并发上限（1=串行）
```

- **代理**：`agent.proxy` 同时作用于浏览器渲染与降级 fetch（配了代理则浏览器也走代理）；目标为本地/内网地址时始终直连。
- **降级 fetch 的加固**：自动字符集（GBK/Big5 老站不乱码）、Cookie Jar（跳转携带会话）、反爬挑战页/JS 空壳识别（不把「Just a moment」「加载中」当正文）、Retry-After 退避重试。
- **高级能力**（仅 crawl4ai 生效）：`wait_for` 等渲染完成、`js_code` 滚动/点击触发懒加载、`extract` CSS schema 结构化抽取、`links` 链接清单、`scroll` 虚拟滚动；降级纯 HTTP 时结果带 `degraded:true + skipped:[...]`（诚实标注）。
- **PDF**：URL/content-type 识别为 PDF（或 crawl4ai 返回 `%PDF-` 原始字节）时，自动用 `pdfjs-dist` 提取文本，返回 `via: "pdf"` + `pdf.pages`；不会把 `%PDF-1.5` / `FlateDecode` 流当正文。扫描版/加密 PDF 无法提取文本时返回 `pdf_no_text` / `pdf_extract_failed` 明确提示。
- **失败提示**：结果区分 `blocked`（403/429 反爬）、`challenge`（CF 等挑战页）、`js_required`（JS 空壳）、`empty`、`ssrf_blocked`，并给出下一步建议；crawl4ai 与 fetch 双路失败时附带两路错误。
- **会话复用（抗反爬的关键一环）**：`sessionPersist` 打开时，该站点拿到的 cookie（含 Cloudflare `cf_clearance`/`__cf_bm` 等清关凭证）会按 host 存到 `data/crawl/sessions.json`，下次抓取（fetch 与浏览器两条路径）自动带上——不再"每次都是第一次访客"。fetch 路径是可靠的捕获通道（能拿到 HttpOnly 凭证），浏览器路径按 crawl4ai 版本尽力回传。清除会话：删 `data/crawl/` 下对应文件即可。
- **站点难度记忆**：`siteMemory` 按 host 记住有效档位（上次纯 HTTP 就够 → 下次不再起浏览器；上次普通档被拦 → 下次直接用 `undetected`），避免反复用注定失败的档位去打同一站。
- **抓取节奏**：`perHostIntervalMs`/`hostConcurrency` 约束同站点请求节奏（默认 1200ms、串行）——同一对话里连问几个页面时，节奏比单次快慢更容易触发风控。
- **安全**：默认拒绝抓取环回/私有/链路本地/元数据地址（含混淆 IPv4、IPv6、域名解析结果），fetch 重定向逐跳复验；持久化 cookie 落盘 `data/crawl/sessions.json`（权限 0600，**cookie 值不写日志**，可随时删除）；`sessionProfile` 打开的浏览器 profile 会保留更多站点状态（默认关）。crawl4ai 浏览器内的子资源/内部重定向不受此层约束（已知边界）。

---
