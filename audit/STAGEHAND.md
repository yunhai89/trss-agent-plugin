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

## 自动探测仍失败：缓存目录布局漏匹配（v1.45.11）

**现象**：v1.45.10 上线后 `stagehand__goto` 仍报
`未找到可用的 Chrome/Chromium`，但机器上确实有 Chromium：
`/root/.cache/puppeteer/chrome/linux-156.0.8078.47/chrome-linux64/chrome`。

**根因**：缓存扫描写死了旧布局：
- Puppeteer v19+：`~/.cache/puppeteer/chrome/linux-<ver>/chrome-linux64/chrome`，
  旧实现按 `/^\d+/` 过滤版本目录，`linux-156...` 直接跳过；
- Playwright 新版：`~/.cache/ms-playwright/chromium-<rev>/chrome-linux64/chrome`，
  旧实现只找 `chrome-linux/chrome`，少了 `64`。

**修复**：
- Puppeteer 缓存改为扫描 `chrome/*` 全部版本目录，兼容 `chrome-linux64`/`chrome-linux`、
  Chrome for Testing 的 macOS 目录名、Windows 32/64；
- Playwright 同时兼容 `chrome-linux64`/`chrome-linux` 与各平台目录；
- 支持 `PUPPETEER_CACHE_DIR`、`PLAYWRIGHT_BROWSERS_PATH` 自定义缓存根；
- 多版本按版本号**数字**倒序取最新（避免 `linux-99` 排在 `linux-156` 前）。

**验证**：`chrome.test.mjs` 扩到 22 断言（新增两种真实布局、多版本取最新、自定义缓存根）；
全量 `node scripts/run-tests.mjs`；并用解析结果实际启动 Stagehand 本地浏览器成功（launch/close）。
