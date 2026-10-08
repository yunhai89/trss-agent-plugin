/**
 * Stagehand 真实浏览器集成测试（本地 Chrome + 本地 HTTP fixture + 可控模型响应）。
 *
 * 运行（需本机 Chrome）：
 *   STAGEHAND_BROWSER_PATH=/path/to/chrome node model/stagehand/browser.integration.test.mjs
 *
 * 未设置 STAGEHAND_BROWSER_PATH 时打印 SKIP_FILE 并以 0 退出（由 scripts/run-tests.mjs 计为「跳过」，
 * 不计入通过）。本测试验证：真实启动、init script（stealth）、真实 SDK extract（走 Zod4 序列化路径）、
 * 导航、以及 DomainPolicy 请求级访问策略。云模式（Browserbase）不在此覆盖，需真实账号与计费模型。
 */
import http from 'node:http'
import { SessionManager } from './session.js'
import { jsonSchemaToZod } from './schema.js'

const CHROME = process.env.STAGEHAND_BROWSER_PATH || process.env.CHROME_PATH
if (!CHROME) {
  console.log('SKIP_FILE: 未设置 STAGEHAND_BROWSER_PATH/CHROME_PATH，跳过真实浏览器集成测试')
  process.exit(0)
}

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 4).join('\n')) } }

/** 从 JSON Schema 生成一个最小合法值（可控模型响应，不依赖真实 LLM） */
function fakeValue(s) {
  const t = Array.isArray(s?.type) ? (s.type.find((x) => x !== 'null') || s.type[0]) : s?.type
  switch (t) {
    case 'object': {
      const o = {}
      for (const [k, v] of Object.entries(s.properties || {})) if ((s.required || []).includes(k)) o[k] = fakeValue(v)
      return o
    }
    case 'array': return []
    case 'string': return 'fixture-value'
    case 'integer':
    case 'number': return 1
    case 'boolean': return true
    case 'null': return null
    default: return null
  }
}
function fakeGenerate(params) {
  const schema = params?.responseFormat?.schema || { type: 'object', properties: {} }
  const structured = fakeValue(schema)
  return {
    role: 'assistant',
    content: { type: 'text', text: JSON.stringify(structured) },
    outputFormat: 'json_schema',
    structuredContent: structured,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/blocked') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><head><title>BLOCKED</title></head><body>blocked</body></html>'); return }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><head><title>Fixture Page</title></head><body><h1 id="t">Hello Fixture</h1><button id="b">Click</button></body></html>')
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

let sm = null
try {
  sm = new SessionManager({
    cfg: { mode: 'local', headless: true, stealth: true, executablePath: CHROME, idleTimeoutMs: 60000, opTimeoutMs: 60000, maxSessions: 2 },
    buildModel: () => ({ generate: fakeGenerate }),
  })

  await test('真实启动 + 导航 + 访问策略安装', async () => {
    const entry = await sm.acquire('itest', {})
    ok(!!entry.stagehand && !!entry.context && !!entry.page, '真实 Stagehand/context/page 就绪')
    const pol = await entry.context.getDomainPolicy()
    ok(pol && Array.isArray(pol.blockedDomains) && pol.blockedDomains.length > 0, 'DomainPolicy 已安装（含默认禁访域名）')
    const res = await entry.page.goto(base + '/')
    ok(res && res.status() === 200, `导航成功（status=${res && res.status()}）`)
    const title = await entry.page.title()
    ok(title === 'Fixture Page', `页面标题正确（${title}）`)
    const h1 = await entry.page.evaluate(() => document.getElementById('t')?.textContent)
    ok(h1 === 'Hello Fixture', '页面 DOM 可读')
  })

  await test('init script（stealth）：navigator.webdriver 被抹除', async () => {
    const entry = sm.get('itest')
    const wd = await entry.page.evaluate(() => navigator.webdriver)
    // evaluate 会把 undefined 序列化为 null；真实浏览器默认自动化时为 true，抹除后为 undefined/null/false
    ok(wd === undefined || wd === false || wd === null, `navigator.webdriver 已抹除（${wd}）`)
    const lang = await entry.page.evaluate(() => navigator.languages)
    ok(Array.isArray(lang) && lang.length > 0, 'navigator.languages 已注入')
  })

  await test('真实 SDK extract：Zod4 schema 序列化 + 可控模型响应', async () => {
    const entry = sm.get('itest')
    const zodSchema = jsonSchemaToZod({
      type: 'object',
      properties: { title: { type: 'string' }, count: { type: 'integer', minimum: 0, maximum: 9 } },
      required: ['title', 'count'],
    })
    const r = await entry.stagehand.extract('抽取页面标题与计数', zodSchema, { page: entry.page })
    ok(r && r.data && r.data.title === 'fixture-value', 'extract 经真实 SDK 返回结构化数据')
    ok(r.data.count === 1, 'integer 字段按 schema 生成')
  })

  await test('DomainPolicy 请求级拦截：被禁 IPv4 无法导航', async () => {
    const entry = sm.get('itest')
    await entry.context.setDomainPolicy({ blockedDomains: ['127.0.0.1'] })
    let blocked = false
    try {
      const res = await entry.page.goto(base + '/blocked')
      // 某些实现返回 null 而非抛错；HTTP 状态 0 或非 200 也视为被拦
      blocked = !res || res.status() === 0 || res.status() !== 200
    } catch { blocked = true }
    ok(blocked, '被禁 IPv4 的导航被 DomainPolicy 拦截')
    // 还原策略，避免影响后续
    await entry.context.setDomainPolicy({ blockedDomains: [] })
  })

  await test('同一会话串行执行两个真实操作', async () => {
    const entry = sm.get('itest')
    const order = []
    const p1 = sm.run('itest', async ({ page }) => { order.push('start1'); await page.evaluate(() => 1); order.push('end1'); return 1 })
    const p2 = sm.run('itest', async ({ page }) => { order.push('start2'); await page.evaluate(() => 2); order.push('end2'); return 2 })
    await Promise.all([p1, p2])
    ok(order.indexOf('end1') < order.indexOf('start2'), '同会话操作严格串行')
    ok(!!entry, '会话保持')
  })
} finally {
  try { if (sm) await sm.closeAll() } catch { /* noop */ }
  await new Promise((r) => server.close(r))
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
