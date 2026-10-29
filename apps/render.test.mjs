/**
 * apps/render.js 回归自检（纯离线：桩掉 Yunzai 渲染器与 puppeteer 包，不启动真实 Chromium、不联网）。
 * 运行：node apps/render.test.mjs
 *
 * 锁住 2026-10-17 审计的三条修复：
 *   ① renderCardImage 降级 Yunzai 渲染器失败后不再用完全相同的参数重截第二次
 *      （原先 Chromium 卡住时要白等 2×timeoutMs）——失败路径 screenshot 也只调用 1 次；
 *   ② screenshot 的 tplFile 唯一化（时间戳+随机串）且清理只删「超过保留窗口」的同名前缀文件
 *      ——并发/连续同名截图不会互删对方刚写入的模板；
 *   ③ renderPdf 的 page.pdf 与 renderHd 的 page.screenshot 带总超时（≥ HEAVY_TIMEOUT_FLOOR_MS），
 *      抛错时按契约返回 null，调用方才能按 PDF→高清图→文本 降级。
 *
 * 桩法：registerHooks 把 apps/render.js 里的动态 import
 *   - '../../../lib/puppeteer/puppeteer.js'（Yunzai 渲染器，仅生产目录存在）
 *   - 'puppeteer'（独立浏览器，dev/CI 未安装）
 * 两个 specifier 都重定向到本测试临时目录里的假模块（真文件 URL），行为经 globalThis.__RENDER_TEST__ 注入。
 * 临时目录在 /tmp 下自建、结束时清理，绝不往仓库写数据。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import Config from '../utils/Config.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

// ── 自有临时目录（桩文件 + 截图模板都放这里；Config.path.temp 被指到 TEMP_DIR）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'render-test-'))
const TEMP_DIR = path.join(TMP, 'tempshots')
fs.mkdirSync(TEMP_DIR, { recursive: true })
/** 兜底清理：即使中途异常退出（含 unsettled TLA 之类的提前退出）也不留临时文件 */
const cleanupTmp = () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* noop */ } }
process.on('exit', cleanupTmp)
const YUNZAI_STUB = path.join(TMP, 'stub-yunzai-puppeteer.mjs')
const NPM_STUB = path.join(TMP, 'stub-npm-puppeteer.mjs')

fs.writeFileSync(YUNZAI_STUB, `const m = globalThis.__RENDER_TEST__
export default {
  async screenshot(name, data) {
    m.yunzaiCalls.push({ name, data })
    if (m.yunzaiBehavior === 'hang') return new Promise(() => {})
    if (m.yunzaiBehavior === 'fail') throw new Error('mock: yunzai screenshot failed')
    return 'mock-yunzai-image'
  },
}
`)
fs.writeFileSync(NPM_STUB, `const m = globalThis.__RENDER_TEST__
export default {
  async launch() {
    m.launches = (m.launches || 0) + 1
    return { async newPage() { m.newPages = (m.newPages || 0) + 1; return m.makePage() } }
  },
}
`)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\/lib\/puppeteer\/puppeteer\.js$/.test(specifier)) return { url: pathToFileURL(YUNZAI_STUB).href, shortCircuit: true }
    if (specifier === 'puppeteer') return { url: pathToFileURL(NPM_STUB).href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

// ── 假 page / 假行为注入 ──
const mock = {
  yunzaiCalls: [],      // 假 Yunzai 渲染器收到的 (name, data)
  yunzaiBehavior: 'ok', // ok | fail | hang
  pageCalls: [],        // 假 page 方法调用流水
  containerBox: null,   // null → 独立浏览器路径拿不到 #container → shotCard 返回 null（走降级）
  element: null,        // 设成 { screenshot } 可让独立浏览器路径成功
  failScreenshot: false,
  failPdf: false,
  launches: 0,
  newPages: 0,
}
mock.makePage = () => {
  const calls = mock.pageCalls
  return {
    async setJavaScriptEnabled(v) { calls.push(['setJavaScriptEnabled', v]) },
    async setViewport(o) { calls.push(['setViewport', o]) },
    async setContent(html, o) { calls.push(['setContent', o]) },
    async waitForSelector(sel, o) { calls.push(['waitForSelector', sel, o]); if (mock.failWaitForSelector) throw new Error('mock: selector timeout') },
    async $(sel) { calls.push(['$', sel]); return mock.element },
    async evaluate() { calls.push(['evaluate']); return mock.containerBox === undefined ? null : mock.containerBox },
    async screenshot(opt) {
      calls.push(['screenshot', opt])
      if (mock.hangScreenshot) return new Promise(() => {})
      if (mock.failScreenshot) throw new Error('mock: screenshot timeout')
      return Buffer.from('mock-hd-shot')
    },
    async pdf(opt) {
      calls.push(['pdf', opt])
      if (mock.failPdf) throw new Error('mock: pdf timeout')
      return Buffer.from('mock-pdf')
    },
    async close() { calls.push(['close']) },
  }
}
globalThis.__RENDER_TEST__ = mock
globalThis.segment = { image: (u) => ({ type: 'image', data: { file: u } }) }

function reset() {
  mock.yunzaiCalls.length = 0
  mock.pageCalls.length = 0
  mock.yunzaiBehavior = 'ok'
  mock.containerBox = null
  mock.element = null
  mock.failScreenshot = false
  mock.failPdf = false
  mock.failWaitForSelector = false
  mock.hangScreenshot = false
}

// 生产代码的 Config.path.temp 指向仓库 data/temp → 本测试一律改写到自己临时目录
Config.path.temp = TEMP_DIR

const render = await import('./render.js')
const pdfCallOf = () => mock.pageCalls.find((c) => c[0] === 'pdf')
const shotCallOf = () => mock.pageCalls.find((c) => c[0] === 'screenshot')

await test('① renderCardImage：独立浏览器失败 → 降级 Yunzai，且 screenshot 只调用一次', async () => {
  reset()
  const img = await render.renderCardImage('<div>卡片</div>', { timeoutMs: 3000 })
  eq(mock.yunzaiCalls.length, 1, 'screenshot 恰好 1 次')
  eq(img, 'mock-yunzai-image', '返回 Yunzai 渲染结果')
  eq(mock.yunzaiCalls[0].name, 'agents-plugin/card', '默认 name 不变')
})

await test('① renderCardImage：Yunzai 也失败 → 仍只一次（不再同参重截第二次）', async () => {
  reset()
  mock.yunzaiBehavior = 'fail'
  const img = await render.renderCardImage('<div>卡片</div>', { timeoutMs: 3000 })
  eq(img, null, '全失败 → null（调用方降级文本）')
  eq(mock.yunzaiCalls.length, 1, '失败路径 screenshot 仍恰好 1 次')
})

await test('① renderCardImage：Yunzai 挂住不返回 → 到点返回 null，且只调用一次', async () => {
  reset()
  mock.yunzaiBehavior = 'hang'
  // timeoutMs 要留足「独立浏览器路径失败」的耗时（含 shotCard 内 200ms 稳定等待），
  // 否则还没走到降级就超时了 —— 与本条要验证的「Yunzai 挂住」就不是同一个场景。
  // 另：withTimeout 的超时定时器是 unref 的，真实环境有别的句柄兜底；测试里必须自己保活，
  // 否则事件循环先空转 → Node 以「unsettled top-level await」(exit 13) 结束。
  const keepAlive = setInterval(() => {}, 50)
  try {
    const t0 = Date.now()
    const img = await render.renderCardImage('<div>卡片</div>', { timeoutMs: 1000 })
    const dt = Date.now() - t0
    eq(img, null, '超时 → null')
    eq(mock.yunzaiCalls.length, 1, '挂住时也只调用一次（不会等到第二次）')
    ok(dt >= 900 && dt < 4000, `总耗时受 timeoutMs 约束（实际 ${dt}ms）`)
  } finally { clearInterval(keepAlive) }
})

await test('② tplFile 唯一化：连续两次渲染文件名不同，且不删掉对方刚写入的模板', async () => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true })
  fs.mkdirSync(TEMP_DIR, { recursive: true })
  reset()
  await render.screenshot('agents-plugin/card', '<p>1</p>')
  const f1 = mock.yunzaiCalls[0].data.tplFile
  ok(fs.existsSync(f1), '第一次的 tplFile 已写入临时目录')
  eq(fs.readFileSync(f1, 'utf8'), '<p>1</p>', '模板内容为本次 HTML（渲染器读到最新内容）')

  await render.screenshot('agents-plugin/card', '<p>2</p>')
  const f2 = mock.yunzaiCalls[1].data.tplFile
  ok(f1 !== f2, '两次 tplFile 名不同（不会命中渲染器陈旧模板缓存）')
  ok(fs.existsSync(f1), '第二次的清理没有删掉第一次刚写入的模板（并发互删根因已修）')
  ok(fs.existsSync(f2), '第二次自己的模板存在')
  eq(path.basename(f1).startsWith('agents-plugin_card__'), true, `safe 前缀（/ → _）：${path.basename(f1)}`)
})

await test('② 清理只删「超过保留窗口」的同名前缀文件，其它前缀不碰', async () => {
  const KEEP_MS = 10 * 60 * 1000 // SHOT_KEEP_MS
  const oldSame = path.join(TEMP_DIR, 'agents-plugin_card__old.html')
  const oldOther = path.join(TEMP_DIR, 'agents-other__old.html')
  fs.writeFileSync(oldSame, 'old')
  fs.writeFileSync(oldOther, 'old')
  const old = new Date(Date.now() - KEEP_MS - 60_000)
  fs.utimesSync(oldSame, old, old)
  fs.utimesSync(oldOther, old, old)
  const before = fs.readdirSync(TEMP_DIR).length

  reset()
  await render.screenshot('agents-plugin/card', '<p>3</p>')
  ok(!fs.existsSync(oldSame), '过期同名前缀文件被清理')
  ok(fs.existsSync(oldOther), '其它前缀的过期文件不动（清理按 safe 前缀限定）')
  eq(fs.readdirSync(TEMP_DIR).length, before, '本次只增一个模板、删一个过期文件 → 数量不变')
  ok(fs.existsSync(mock.yunzaiCalls[0].data.tplFile), '本次模板保留（刚写入的不在清理窗口内）')
})

await test('③ renderPdf：page.pdf 收到 ≥30000ms 总超时；成功写文件、抛错返回 null', async () => {
  reset()
  const out = path.join(TEMP_DIR, 'out.pdf')
  const p = await render.renderPdf('<p>pdf</p>', { path: out })
  eq(p, out, '成功返回写入路径')
  eq(fs.readFileSync(out, 'utf8'), 'mock-pdf', 'PDF 内容落地正确')
  const c = pdfCallOf()
  ok(c, 'page.pdf 被调用')
  ok(Number(c[1]?.timeout) >= 30000, `page.pdf timeout ≥ 30000（实际 ${c[1]?.timeout}）`)

  reset()
  mock.failPdf = true
  const p2 = await render.renderPdf('<p>pdf</p>', { path: path.join(TEMP_DIR, 'out2.pdf') })
  eq(p2, null, 'page.pdf 抛错（超时）→ 返回 null，调用方降级')
})

await test('③ renderHd：page.screenshot 收到 ≥30000ms 总超时且 fullPage；抛错返回 null', async () => {
  reset()
  const buff = await render.renderHd('agents-plugin/hd', '<p>hd</p>', { scale: 2 })
  ok(Buffer.isBuffer(buff) && buff.toString() === 'mock-hd-shot', '成功返回 Buffer')
  const c = shotCallOf()
  ok(c, 'page.screenshot 被调用')
  ok(Number(c[1]?.timeout) >= 30000, `page.screenshot timeout ≥ 30000（实际 ${c[1]?.timeout}）`)
  eq(c[1]?.fullPage, true, 'fullPage 长图')
  eq(c[1]?.type, 'png', '默认 png')

  reset()
  mock.failScreenshot = true
  const b2 = await render.renderHd('agents-plugin/hd', '<p>hd</p>')
  eq(b2, null, '截图抛错（超时）→ null')
})

await test('④ 帮助图渲染超时：默认 5 分钟，可配 helpTimeoutMs（不拖累普通卡片）', async () => {
  eq(render.HELP_RENDER_TIMEOUT_DEFAULT_MS, 300000, '默认 300000ms（5 分钟）')
  eq(render.helpRenderTimeoutMs({}), 300000, '未配置 → 默认 300000')
  eq(render.helpRenderTimeoutMs(undefined), 300000, 'undefined → 默认 300000')
  eq(render.helpRenderTimeoutMs({ helpTimeoutMs: 60000 }), 60000, '显式配置生效')
  eq(render.helpRenderTimeoutMs({ helpTimeoutMs: 0 }), 300000, '0/非法 → 默认 300000')
  eq(render.helpRenderTimeoutMs({ helpTimeoutMs: -1 }), 300000, '负数 → 默认 300000')
  eq(render.helpRenderTimeoutMs({ timeoutMs: 8000 }), 300000, '普通卡片 timeoutMs 不影响帮助图（各自独立预算）')
})

cleanupTmp()

console.log('\n========================================')
console.log(`apps/render 测试：通过 ${passed}，失败 ${failed}`)
console.log('========================================')
process.exitCode = failed ? 1 : 0
