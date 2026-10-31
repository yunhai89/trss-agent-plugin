# Stagehand 浏览器自动化

> 本文是主 README 的拆分文档。返回 [README](../../README.md)。

## 🌐 Stagehand 浏览器自动化（🧪 早期）

> 基于 [@browserbasehq/stagehand](https://docs.stagehand.dev) v4。Agent 用自然语言驱动真实浏览器：打开页面、点击、填表、抽取动态渲染后的结构化数据（适合多步交互/登录态任务，弥补 `web_crawl` 单页只读抓取的局限）。

**4 个工具**（访问权限由 `agent.stagehand.permission` 控制，**默认 `master` 仅框架主人**；`permission=all` 时 `category:'query'` 全员可用，`stagehand__act` 作为多步浏览器任务的一部分**不单独审批**）：
- `stagehand__goto({url})` — 打开 URL（多步任务起点，页面跨调用保持）。成功返回 `{ok:true, url, title, status?}`（同时提供 `data` 别名）
- `stagehand__observe({instruction?})` — 列出可交互元素（只读）。成功返回 `{ok:true, data, metadata?}`
- `stagehand__extract({instruction, schema})` — 按自然语言 + JSON Schema 抽结构化数据。成功返回 `{ok:true, data, metadata?}`
- `stagehand__act({instruction})` — 点击/输入/提交（写动作，会改变页面状态；不单独审批）。仅 SDK 返回 `data.success===true` 才算成功，返回 `{ok:true, data}`

> ⚠️ `permission: all` 时群成员可直接驱动宿主浏览器执行点击/输入/提交（act 无单独审批），仅建议在可信群开启。

**会话**：按「机器人 + 群/私聊 + 真实操作者 + 对话」隔离懒启动 + 5min idle 自动关；同一会话复用同一页面并**串行**执行 goto/observe/extract/act（不同会话并行），支持"打开 A 站→登录→抓数据"多步任务。限流绑定「机器人 + 真实操作者」，切换对话不重置配额；缺少机器人/用户标识直接拒绝。并发启动前同步预约名额，全局容量含已启动/启动中/关闭中。

**配置**（`agent.stagehand`，默认关）：
```yaml
stagehand:
  enable: true
  permission: master   # master(默认，仅框架主人) | all(全部成员可用 goto/observe/extract/act；act 不单独审批)
  mode: local          # local(本地 Playwright+chromium，默认) | cloud(Browserbase)
  headless: true
  executablePath: ""   # 本地 Chrome/Chromium 路径；留空=自动探测（见下方「本地 Chrome 自动探测」）
  browserbaseApiKey: ""# 云模式必填
  modelName: ""        # Stagehand 原生模型(如 google/gemini-2.5-flash)；空=复用插件 provider(仅 OpenAI 兼容)；云模式空=自动选
  modelApiKey: ""
  idleTimeoutMs: 300000
  maxSessions: 3
  opTimeoutMs: 60000   # 单次浏览器操作截止时间（含排队后的执行，超时拒绝迟到结果并清理会话）
  llmTimeoutMs: 30000  # 单次 LLM 推理截止时间（覆盖请求 + 响应体读取；复用主 provider 代理 fetch）
```

- **LLM**：Stagehand 每次原语调用要一次 LLM 推理。`modelName` 留空时**复用插件已配的 OpenAI 兼容 provider**（deepseek/openai/mimo 等，走 json_schema 结构化输出），并复用主 provider 已配置的代理；插件协议为 anthropic 或想用更强模型，填 `modelName`（五大 provider：openai/anthropic/google/groq/cerebras）。
- **依赖**：`@browserbasehq/stagehand` v4 + `zod-stagehand`（Zod 4 别名，仅 Stagehand extract 用；其余模块仍用根依赖 Zod 3）。`zod-stagehand` 缺失时会回退复用 Stagehand 自带的同版本 Zod 4，因此不会导致插件加载失败；建议仍在云崽根 `pnpm install` 装入插件。本地模式另需 chromium + 系统库（`libnss3 libatk-bridge2.0-dev libgtk-3-dev libxss1 libasound2`）。
- **本地 Chrome 自动探测（v1.45.10 / v1.45.11）**：Stagehand v4 在未给 `executablePath` 时只认**系统 Chrome**，找不到就报 `The CHROME_PATH environment variable must be set…`（服务器上通常只有 Yunzai 的 Puppeteer 自带 Chromium）。现在插件按顺序自动探测并传给 SDK：`agent.stagehand.executablePath` → 环境变量 `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` → **Puppeteer 自带 Chromium**（`puppeteer.executablePath()`）→ **Puppeteer 缓存**（`~/.cache/puppeteer/chrome/linux-<ver>/chrome-linux64/chrome`，兼容旧版 `chrome-linux`；支持 `PUPPETEER_CACHE_DIR`）→ **Playwright 缓存**（`~/.cache/ms-playwright/chromium-<rev>/chrome-linux64/chrome`；支持 `PLAYWRIGHT_BROWSERS_PATH`）→ 系统常见路径（`/usr/bin/chromium`、`/usr/bin/google-chrome`、`/snap/bin/chromium`、macOS/Windows 默认安装位）。多版本按数字倒序取最新；v1.45.11 修复了只匹配纯数字版本目录/`chrome-linux` 导致本机已装的 Puppeteer/Playwright Chromium 全部漏探测。全部落空时返回**可执行的排查提示**（apt/yum 安装、`npx puppeteer browsers install chrome`、显式配置、或改用云端模式），不再抛 SDK 原文。
- **模型侧请求头（v1.45.12）**：`observe` / `extract` / `act` 需要 Stagehand 调一次 LLM。复用主 provider 时，现在会把主 provider preset 的 `User-Agent` 和会话头一并透传（OpenCode Zen/Go 的 `x-opencode-session`，值绑定当前浏览器会话 key）。此前只传 `Authorization`，OpenCode 网关会返回 `400 MissingSessionID: Request is missing x-opencode-session and cannot be routed efficiently`，表现为「页面打开成功、goto 可用，但 observe/extract/act 全部失败」。
- **兼容性影响**：早期版本把 SDK 返回值直接展开到结果根（数组会变成数字键、`result.title` 是原始 SDK 字段）；现统一为 `goto` 顶层 `url/title/status`、`observe/extract/act` 的载荷在 `result.data`（`goto` 同时提供 `result.data` 别名）。外部脚本请改读 `result.data`。
- **安全边界**：入口对顶层导航做协议/IP/域名解析校验（含混淆 IPv4、尾点、空 DNS、取消/超时），并在请求级安装 Stagehand DomainPolicy（精确域名 + 子域通配 + IPv4 字面量）；IPv6/CIDR/单标签主机无法表达为域名规则，仅入口校验兜底；DNS 重绑定与"子资源访问私有 IP"不被 DomainPolicy 覆盖。因此**不宣称完整 SSRF 出口隔离**。
- 云模式（Browserbase）不在主机跑浏览器、无需本地 chromium，但需 apiKey + 外网。

---
