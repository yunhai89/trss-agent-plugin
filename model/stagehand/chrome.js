/**
 * 本地 Chrome/Chromium 定位（Stagehand 本地模式必需）。
 *
 * 背景（线上故障 2026-10）：
 *   `stagehand__goto` 报
 *   `The CHROME_PATH environment variable must be set to a Chrome/Chromium executable no older than Chrome stable.`
 * 原因：`@browserbasehq/stagehand` v4 的 `localBrowser.launch` 在未提供 `executablePath` 时调用
 * `chrome-launcher.getChromePath()`，它只认系统安装的 Chrome/Chromium，**不会**去找 Puppeteer
 * 自带的 Chromium；服务器上通常只有 Yunzai 的 puppeteer Chromium，于是直接抛这个晦涩错误。
 *
 * 本模块按「显式配置 → 环境变量 → Puppeteer 自带 → 缓存目录 → 常见系统路径」顺序探测，
 * 找到后由 browser.js 作为 `executablePath` 传给 Stagehand（不再依赖 CHROME_PATH 猜测）。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 常见系统安装路径（Linux/macOS/Windows） */
const SYSTEM_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/local/bin/chromium',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
]

/** 环境变量里可能给出的可执行文件 */
const ENV_KEYS = ['PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH', 'LIGHTHOUSE_CHROMIUM_PATH']

async function isFile(filePath) {
  if (!filePath) return false
  try {
    const st = await fs.stat(String(filePath))
    return st.isFile() && st.size > 0
  } catch { return false }
}

/** 列出目录下匹配前缀的子目录（缓存目录探测用；读不到返回 []） */
async function listDirs(dir, prefixRe) {
  try {
    const names = await fs.readdir(dir)
    return names.filter((n) => prefixRe.test(n)).sort().reverse().map((n) => path.join(dir, n))
  } catch { return [] }
}

/**
 * Puppeteer 自带的 Chromium 路径（Yunzai 通常已装 puppeteer；插件从自己的目录向上解析也能找到）。
 * @param {()=>Promise<string>} [loader] 测试注入
 */
async function puppeteerExecutable(loader = null) {
  if (typeof loader === 'function') {
    try { return String((await loader()) || '') } catch { return '' }
  }
  try {
    const mod = await import('puppeteer')
    const p = mod.default || mod
    if (typeof p.executablePath === 'function') {
      const pth = p.executablePath()
      if (pth) return String(pth)
    }
  } catch { /* 未安装 puppeteer 或不可用 */ }
  return ''
}

/**
 * 扫描 Puppeteer / Playwright 缓存里的 Chromium（自装 puppeteer 但 PATH 无 chrome 时常见）。
 * @param {string} home 用户目录
 */
async function cacheCandidates(home) {
  const out = []
  const cacheRoots = [
    path.join(home, '.cache', 'puppeteer'),
    path.join(home, '.cache', 'puppeteer', 'chrome'),
  ]
  // ~/.cache/puppeteer/chrome/<version>/chrome-linux64/chrome
  for (const root of cacheRoots) {
    for (const verDir of await listDirs(root, /^\d+/)) {
      out.push(path.join(verDir, 'chrome-linux64', 'chrome'))
      out.push(path.join(verDir, 'chrome-linux', 'chrome'))
      out.push(path.join(verDir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'))
      out.push(path.join(verDir, 'chrome-mac-x64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'))
      out.push(path.join(verDir, 'chrome-win64', 'chrome.exe'))
      out.push(path.join(verDir, 'chrome-win32', 'chrome.exe'))
    }
  }
  // ~/.cache/ms-playwright/chromium-<rev>/chrome-linux/chrome
  const pwRoot = path.join(home, '.cache', 'ms-playwright')
  for (const revDir of await listDirs(pwRoot, /^chromium-/)) {
    out.push(path.join(revDir, 'chrome-linux', 'chrome'))
    out.push(path.join(revDir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'))
    out.push(path.join(revDir, 'chrome-win', 'chrome.exe'))
  }
  return out
}

/**
 * 解析可用的 Chrome/Chromium 可执行文件。
 * @param {object} cfg agent.stagehand 配置
 * @param {object} [opts] 测试注入：{ env, home, puppeteerLoader, systemCandidates }
 * @returns {Promise<{path:string, source:string}|null>}
 */
export async function resolveChromeExecutable(cfg = {}, opts = {}) {
  const env = opts.env || process.env || {}
  const home = opts.home || (env.HOME || env.USERPROFILE || os.homedir())

  // 1) 显式配置优先；配了但不存在 → 直接返回 null（由调用方给出「配置路径无效」的精确提示，
  //    不再静默落到自动探测，否则用户会以为配置生效了）
  const configured = String(cfg.executablePath || '').trim()
  if (configured) return (await isFile(configured)) ? { path: configured, source: 'config' } : null

  // 2) 环境变量
  for (const key of ENV_KEYS) {
    const v = String(env[key] || '').trim()
    if (v && await isFile(v)) return { path: v, source: `env:${key}` }
  }

  // 3) Puppeteer 自带 Chromium（Yunzai 场景最常见）
  const pp = await puppeteerExecutable(opts.puppeteerLoader)
  if (pp && await isFile(pp)) return { path: pp, source: 'puppeteer' }

  // 4) Puppeteer / Playwright 缓存
  for (const p of await cacheCandidates(home)) {
    if (await isFile(p)) return { path: p, source: 'cache' }
  }

  // 5) 常见系统安装路径
  for (const p of (opts.systemCandidates || SYSTEM_CANDIDATES)) {
    if (await isFile(p)) return { path: p, source: 'system' }
  }
  return null
}

/** 找不到 Chrome 时的可执行提示（比 SDK 原始 CHROME_PATH 报错清楚） */
export function missingChromeMessage(configuredPath = '') {
  const lines = [
    '未找到可用的 Chrome/Chromium（Stagehand 本地模式需要）',
    configuredPath
      ? `· 配置的 agent.stagehand.executablePath 不存在或不可执行：${configuredPath}`
      : '· 依次探测：executablePath → CHROME_PATH/PUPPETEER_EXECUTABLE_PATH → Puppeteer 自带 Chromium → ~/.cache/puppeteer、~/.cache/ms-playwright → 系统常见路径',
    '· 安装示例：apt install -y chromium（Debian/Ubuntu）｜yum install -y chromium（CentOS）',
    '· 或执行：npx puppeteer browsers install chrome（装到当前用户缓存，本插件会自动发现）',
    '· 或显式配置：agent.stagehand.executablePath（如 /usr/bin/chromium），或设置环境变量 CHROME_PATH',
    '· 不想用本地浏览器：agent.stagehand.mode: cloud + browserbaseApiKey（Browserbase 云端）',
  ]
  return lines.join('\n')
}

export default { resolveChromeExecutable, missingChromeMessage }
