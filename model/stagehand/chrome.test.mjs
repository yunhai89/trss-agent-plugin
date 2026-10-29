/**
 * Stagehand 本地 Chrome 探测离线自检。
 *
 * 背景（线上故障 2026-10）：`stagehand__goto` 报
 *   `The CHROME_PATH environment variable must be set to a Chrome/Chromium executable no older than Chrome stable.`
 * Stagehand v4 未给 executablePath 时用 chrome-launcher 找**系统** Chrome，服务器上通常只有
 * Yunzai 的 Puppeteer 自带 Chromium → 直接失败。本模块负责探测并交给 SDK。
 *
 * 覆盖：
 *  ① 优先级：显式配置 → 环境变量 → Puppeteer 自带 → 缓存目录（puppeteer/playwright）→ 系统路径；
 *  ② 显式配置了但文件不存在 → 返回 null（不让用户误以为生效）；
 *  ③ 空环境 → null，且 missingChromeMessage 给出可执行安装/配置建议；
 *  ④ 缓存目录扫描（~/.cache/puppeteer/chrome/linux-<ver>/chrome-linux64/chrome、
 *     ~/.cache/ms-playwright/chromium-<rev>/chrome-linux64/chrome，及自定义缓存目录）。
 *
 * 运行：node model/stagehand/chrome.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveChromeExecutable, missingChromeMessage } from './chrome.js'

let passed = 0, failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => { const A = JSON.stringify(a), B = JSON.stringify(b); ok(A === B, `${m}${A === B ? '' : `（实际 ${A}，期望 ${B}）`}`) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stagehand-chrome-'))
/** 造一个假的可执行文件（非空即可；探测只看 file+size） */
function fakeExe(rel) {
  const p = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'fake-chromium')
  return p
}
const home = path.join(tmp, 'home')
fs.mkdirSync(home, { recursive: true })

console.log('\n[1] 显式配置优先，且必须真实存在')
{
  const p = fakeExe('bin/chrome')
  eq(await resolveChromeExecutable({ executablePath: p }, { env: {}, home }), { path: p, source: 'config' }, 'config 路径存在 → source=config')
  eq(await resolveChromeExecutable({ executablePath: path.join(tmp, 'nope/chrome') }, { env: {}, home, puppeteerLoader: async () => p }), null, 'config 路径不存在 → null（不静默落到自动探测）')
}

console.log('\n[2] 环境变量（PUPPETEER_EXECUTABLE_PATH / CHROME_PATH）')
{
  const p = fakeExe('env/chromium')
  eq(await resolveChromeExecutable({}, { env: { CHROME_PATH: p }, home }), { path: p, source: 'env:CHROME_PATH' }, 'CHROME_PATH 生效')
  eq(await resolveChromeExecutable({}, { env: { PUPPETEER_EXECUTABLE_PATH: p }, home }), { path: p, source: 'env:PUPPETEER_EXECUTABLE_PATH' }, 'PUPPETEER_EXECUTABLE_PATH 生效且优先级更高')
  eq(await resolveChromeExecutable({}, { env: { CHROME_PATH: path.join(tmp, 'missing') }, home, puppeteerLoader: async () => '' }), null, '环境变量指向不存在的文件 → 跳过')
}

console.log('\n[3] Puppeteer 自带 Chromium（Yunzai 常见路径）')
{
  const p = fakeExe('puppeteer/chrome')
  eq(await resolveChromeExecutable({}, { env: {}, home, puppeteerLoader: async () => p }), { path: p, source: 'puppeteer' }, 'puppeteer.executablePath() 命中')
  eq(await resolveChromeExecutable({}, { env: {}, home, puppeteerLoader: async () => { throw new Error('not installed') } }), null, 'puppeteer 未安装不影响（继续探测）')
}

console.log('\n[4] 缓存目录扫描')
{
  const h1 = path.join(tmp, 'home1')
  const p1 = path.join(h1, '.cache', 'puppeteer', 'chrome', '131.0.6778.204', 'chrome-linux64', 'chrome')
  fs.mkdirSync(path.dirname(p1), { recursive: true }); fs.writeFileSync(p1, 'x')
  eq(await resolveChromeExecutable({}, { env: {}, home: h1, puppeteerLoader: async () => '' }), { path: p1, source: 'cache' }, 'puppeteer 缓存目录命中（chrome-linux64）')

  const h2 = path.join(tmp, 'home2')
  const p2 = path.join(h2, '.cache', 'ms-playwright', 'chromium-1148', 'chrome-linux', 'chrome')
  fs.mkdirSync(path.dirname(p2), { recursive: true }); fs.writeFileSync(p2, 'x')
  eq(await resolveChromeExecutable({}, { env: {}, home: h2, puppeteerLoader: async () => '' }), { path: p2, source: 'cache' }, 'playwright 缓存目录命中（chromium-*）')

  // 真实布局（v1.45.10 漏探测的两种）：Puppeteer v19+ 带平台前缀，Playwright 新版 chrome-linux64
  const h3 = path.join(tmp, 'home3')
  const p3 = path.join(h3, '.cache', 'puppeteer', 'chrome', 'linux-156.0.8078.47', 'chrome-linux64', 'chrome')
  fs.mkdirSync(path.dirname(p3), { recursive: true }); fs.writeFileSync(p3, 'x')
  eq(await resolveChromeExecutable({}, { env: {}, home: h3, puppeteerLoader: async () => '' }), { path: p3, source: 'cache' }, 'puppeteer 真实布局命中（linux-<ver>/chrome-linux64）')

  const h4 = path.join(tmp, 'home4')
  const p4 = path.join(h4, '.cache', 'ms-playwright', 'chromium-1248', 'chrome-linux64', 'chrome')
  fs.mkdirSync(path.dirname(p4), { recursive: true }); fs.writeFileSync(p4, 'x')
  eq(await resolveChromeExecutable({}, { env: {}, home: h4, puppeteerLoader: async () => '' }), { path: p4, source: 'cache' }, 'playwright 真实布局命中（chrome-linux64）')

  // 多版本按数字取最新（避免 linux-99 排在 linux-156 前面）
  const h5 = path.join(tmp, 'home5')
  for (const ver of ['linux-99.0.0.0', 'linux-156.0.8078.47']) {
    const p = path.join(h5, '.cache', 'puppeteer', 'chrome', ver, 'chrome-linux64', 'chrome')
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x')
  }
  const newest = path.join(h5, '.cache', 'puppeteer', 'chrome', 'linux-156.0.8078.47', 'chrome-linux64', 'chrome')
  eq(await resolveChromeExecutable({}, { env: {}, home: h5, puppeteerLoader: async () => '' }), { path: newest, source: 'cache' }, '多版本按数字选最新')

  // 自定义缓存目录（PUPPETEER_CACHE_DIR / PLAYWRIGHT_BROWSERS_PATH）
  const custom = path.join(tmp, 'custom-puppeteer')
  const p6 = path.join(custom, 'chrome', 'linux-156.0.8078.47', 'chrome-linux64', 'chrome')
  fs.mkdirSync(path.dirname(p6), { recursive: true }); fs.writeFileSync(p6, 'x')
  eq(await resolveChromeExecutable({}, { env: { PUPPETEER_CACHE_DIR: custom }, home: path.join(tmp, 'empty-home'), puppeteerLoader: async () => '' }), { path: p6, source: 'cache' }, 'PUPPETEER_CACHE_DIR 生效')
}

console.log('\n[5] 系统常见路径与完全找不到')
{
  const p = fakeExe('system/chromium')
  eq(await resolveChromeExecutable({}, { env: {}, home, puppeteerLoader: async () => '', systemCandidates: [p] }), { path: p, source: 'system' }, '系统候选路径命中（可注入）')
  eq(await resolveChromeExecutable({}, { env: {}, home, puppeteerLoader: async () => '', systemCandidates: [] }), null, '全部落空 → null')
}

console.log('\n[6] missingChromeMessage：可执行的安装/配置建议')
{
  const msg = missingChromeMessage('/opt/nope/chrome')
  ok(/未找到可用的 Chrome\/Chromium/.test(msg), '标题明确')
  ok(msg.includes('/opt/nope/chrome'), '回显用户配置的无效路径')
  ok(/apt install -y chromium/.test(msg), '给出 apt 安装建议')
  ok(/npx puppeteer browsers install chrome/.test(msg), '给出 puppeteer 安装建议')
  ok(/executablePath/.test(msg) && /CHROME_PATH/.test(msg), '给出两种显式配置方式')
  ok(/mode: cloud/.test(msg), '给出云端替代方案')
  ok(!missingChromeMessage('').includes('配置的 agent.stagehand.executablePath'), '未配置时不误导为「配置路径不存在」')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
