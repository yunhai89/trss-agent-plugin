# Stagehand 排障记录

## 本地模式报 CHROME_PATH 未设置（v1.45.10）

**现象**：
`stagehand__goto` 失败 —— `The CHROME_PATH environment variable must be set to a Chrome/Chromium executable no older than Chrome stable.`

**根因**：`@browserbasehq/stagehand` v4 的 `localBrowser.launch` 在未提供 `executablePath` 时调用
`chrome-launcher.getChromePath()`——它只探测**系统安装**的 Chrome/Chromium，不会去找 Puppeteer 自带的
Chromium。服务器上通常只有 Yunzai 的 puppeteer Chromium，于是直接抛这个晦涩错误（且报错发生在
`goto` 调用时，看起来像工具坏了）。

**修复**：新增 `model/stagehand/chrome.js` 做本地 Chromium 探测，`browser.js` 启动前解析并作为
`executablePath` 传给 SDK：
1. `agent.stagehand.executablePath`（配了但不存在 → 直接报「配置路径无效」，不静默降级）
2. 环境变量 `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` / `LIGHTHOUSE_CHROMIUM_PATH`
3. **Puppeteer 自带 Chromium**（`puppeteer.executablePath()`；Yunzai 场景最常见）
4. `~/.cache/puppeteer/chrome/<ver>/chrome-linux{64}/chrome`、`~/.cache/ms-playwright/chromium-*`
5. 系统常见路径（`/usr/bin/google-chrome`、`/usr/bin/chromium`、`/snap/bin/chromium`、macOS/Windows 默认位）

全部落空时抛 `missingChromeMessage()`：安装命令（apt/yum）、`npx puppeteer browsers install chrome`、
显式配置 `agent.stagehand.executablePath`/`CHROME_PATH`、或改用 `mode: cloud`。

**验证**：`model/stagehand/chrome.test.mjs` 18 断言（显式配置/不存在、环境变量优先级、Puppeteer、
两级缓存目录、系统候选注入、空环境与提示文案）。
