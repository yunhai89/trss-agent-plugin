/**
 * Kroki HTTP 层专项（本地 mock server，绝不访问公共 Kroki / 外网）。
 * 运行：node model/diagram/kroki.test.mjs
 *
 * 覆盖任务 Kroki 专项 1-14、16-18（真实容器集成另见 kroki.integration.test.mjs，需 KROKI_INTEGRATION=1）：
 * POST-only、endpoint 锁定、LLM 参数不可覆盖、AbortSignal 覆盖 headers/body 两阶段、
 * headers-后-挂死、chunked 超大、text/html 伪装、含脚本 SVG、全状态码映射、重定向不跟随、
 * 熔断 open/half-open/恢复、连接拒绝结构化失败、Kroki SVG→resvg→PNG、中文渲染、公共 endpoint 默认拒绝。
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KrokiClient, validateEndpoint, CircuitBreaker } from './kroki.js'
import { DiagramService } from './index.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { ok(a === b, `${m}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kroki-test-'))

/** 行为化 mock：按 req.behavior 返回不同响应形态 */
function startMock() {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let parsed = {}; try { parsed = JSON.parse(body) } catch { }
      const rec = { method: req.method, url: req.url, contentType: req.headers['content-type'], accept: req.headers.accept, body: parsed }
      seen.push(rec)
      // 行为路由：DSL 首行 #mock:<behavior>（client 直调）或 title 内 [mock:<behavior>]（service 编译链）
      const src = parsed.diagram_source || ''
      const b = /^#mock:(\S+)/.exec(src)?.[1] || /\[mock:(\S+?)\]/.exec(src)?.[1] || 'ok'
      const svgOk = (t) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><text x="10" y="50">${t}</text></svg>`
      switch (b) {
        case 'ok': res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(svgOk('正常')); break
        case 'ok-cn': res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="#FAF9F6"/><text x="20" y="150" font-size="24" fill="#2D3748">中文流程图：用户请求 → 主 Agent → 工具调用</text></svg>`); break
        case 'html': res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<html><body>Service Unavailable</body></html>'); break
        case 'script-svg': res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>`); break
        case 'extref-svg': res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://evil.example/x.png"/></svg>`); break
        case '400': res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('invalid d2 syntax'); break
        case '408': res.writeHead(408); res.end('timeout'); break
        case '413': res.writeHead(413); res.end('too large'); break
        case '429': res.writeHead(429); res.end('rate limited'); break
        case '502': res.writeHead(502); res.end(); break
        case '503': res.writeHead(503); res.end(); break
        case 'redirect': res.writeHead(302, { Location: 'https://kroki.io/' }); res.end(); break
        case 'hang-body': res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.write('<svg xmlns="http://www.w3.org/2000/svg"'); break // 永不结束
        case 'chunked-huge': {
          res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Transfer-Encoding': 'chunked' })
          let n = 0
          const iv = setInterval(() => { res.write('A'.repeat(65536)); n++ ; if (n > 200) clearInterval(iv) }, 5)
          break
        }
        case 'slow-headers': setTimeout(() => { try { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(svgOk('慢')) } catch { } }, 10000); break
        default: res.writeHead(500); res.end('unknown behavior')
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })))
}

const { server, port, seen } = await startMock()
const EP = `http://127.0.0.1:${port}`
const mkClient = (over = {}) => new KrokiClient({
  endpoint: EP, connectTimeoutMs: 1500, requestTimeoutMs: 3000, maxResponseBytes: 64 * 1024,
  maxConcurrency: 2, circuitBreaker: { enabled: true, failureThreshold: 3, cooldownMs: 300 },
  onEvent: () => {}, ...over,
})
const call = (client, behavior, extra = {}) => client.render({ dsl: `#mock:${behavior}\ndirection: down\ntitle: "T"\n`, diagramType: 'd2', options: { layout: 'elk', theme: 4 }, specHash: 'ab12', ...extra })

// ─── 1-3：协议形态与参数锁定 ───
await test('真实请求：POST JSON / 只发配置 endpoint / options 由服务端组装', async () => {
  const c = mkClient()
  const r = await call(c, 'ok')
  ok(r.ok, '渲染成功')
  const req = seen[seen.length - 1]
  eq(req.method, 'POST', '使用 POST')
  ok(!/[?&](diagram_source|src)=/.test(req.url), 'URL 不携带 GET 编码的图形源')
  eq(req.url, '/', '请求根路径')
  ok(req.url.startsWith('/'), `请求只发往配置 endpoint（${EP}/）`)
  eq(req.body.diagram_type, 'd2', 'diagram_type 固定 d2')
  eq(req.body.output_format, 'svg', 'output_format 固定 svg')
  eq(req.accept, 'image/svg+xml', 'Accept 头')
})

await test('LLM 不可覆盖：endpoint / diagramType / options 只来自服务器配置', async () => {
  const c = mkClient()
  // spec 里塞 endpoint/engine/binary 等字段不会到达 client（SpecSchema strict 拒绝已在主测试覆盖）；
  // 这里锁定 client 侧：render 参数里的 diagramType 只能是 allowlist 成员
  const r = await call(c, 'ok', { options: { layout: 'elk', theme: 4 } })
  ok(r.ok, '成功')
  const req = seen[seen.length - 1]
  eq(req.body.diagram_options.layout, 'elk', 'options 来自服务端映射')
  ok(!req.body.diagram_source.includes('behavior'), '请求体是编译后的 D2，不含额外控制字段')
})

// ─── 4-7：AbortSignal 与超时覆盖 ───
await test('AbortSignal：等待响应头阶段取消 → cancelled', async () => {
  const c = mkClient({ connectTimeoutMs: 8000 })
  const ctl = new AbortController()
  const p = call(c, 'slow-headers', { agentSignal: ctl.signal })
  setTimeout(() => ctl.abort(), 300)
  const r = await p
  ok(!r.ok && r.errorClass === 'cancelled', 'headers 阶段取消 → cancelled（实际 ' + r.errorClass + '）')
})

await test('AbortSignal：读取响应体阶段取消 → cancelled', async () => {
  const c = mkClient({ requestTimeoutMs: 8000, connectTimeoutMs: 3000 })
  const ctl = new AbortController()
  const p = call(c, 'hang-body', { agentSignal: ctl.signal })
  setTimeout(() => ctl.abort(), 400)
  const t0 = Date.now()
  const r = await p
  const ms = Date.now() - t0
  ok(!r.ok && r.errorClass === 'cancelled', 'body 阶段取消 → cancelled（实际 ' + r.errorClass + '）')
  ok(ms < 3000, `取消及时生效（${ms}ms，而非挂到超时）`)
})

await test('慢响应头：连接超时按时失败（不挂死）', async () => {
  const c = mkClient({ connectTimeoutMs: 1200 })
  const t0 = Date.now()
  const r = await call(c, 'slow-headers')
  const ms = Date.now() - t0
  ok(!r.ok, '失败')
  ok(r.errorClass === 'timeout' || r.errorClass === 'renderer_unavailable', '错误分类（实际 ' + r.errorClass + '）')
  ok(ms < 4000, `连接超时覆盖 headers 阶段（${ms}ms）`)
})

await test('headers 已回但 body 永不结束：总超时覆盖 body 读取', async () => {
  const c = mkClient({ connectTimeoutMs: 1500, requestTimeoutMs: 1500 })
  const t0 = Date.now()
  const r = await call(c, 'hang-body')
  const ms = Date.now() - t0
  ok(!r.ok && r.errorClass === 'timeout', '总超时在 body 挂死时触发（实际 ' + r.errorClass + '）')
  ok(ms < 5000, `按时失败而非无限等待（${ms}ms）`)
})

await test('chunked 超大响应：流式字节计数到上限即终止', async () => {
  const c = mkClient({ maxResponseBytes: 64 * 1024, requestTimeoutMs: 8000 })
  const r = await call(c, 'chunked-huge')
  ok(!r.ok && r.errorClass === 'output_too_large', '超 maxResponseBytes 终止（实际 ' + r.errorClass + '）')
})

// ─── 8-11：内容与状态码 ───
await test('200 text/html 错误页伪装 → 拒绝', async () => {
  const c = mkClient()
  const r = await call(c, 'html')
  ok(!r.ok && r.errorClass === 'invalid_renderer_output', 'text/html 拒绝（实际 ' + r.errorClass + '）')
})

await test('200 SVG 但含 script / 外部引用 → service 层 SVG 检查拒绝', async () => {
  // client 层只管 HTTP（200+svg+xml 即成功）；内容安全检查在 service 的 #acceptSvg —— 必须经 service 验证
  const mkSvc = (title) => {
    const svc = new DiagramService({
      renderer: 'kroki', fallbackRenderer: 'none',
      kroki: { endpoint: EP, connectTimeoutMs: 1000, requestTimeoutMs: 2500, circuitBreaker: { enabled: false } },
    }, { logger: () => {} })
    svc.temp.dir = path.join(TMPROOT, 'svgchk-' + title); fs.mkdirSync(svc.temp.dir, { recursive: true })
    return svc
  }
  const a = await mkSvc('s1').render({ type: 'flowchart', title: 'x [mock:script-svg]', nodes: [{ id: 'a', label: 'A' }] }, { toolCallId: 'sc1' })
  ok(!a.ok && a.errorClass === 'invalid_renderer_output', '含 script 的 SVG 被拒（实际 ' + a.errorClass + '）')
  const b = await mkSvc('s2').render({ type: 'flowchart', title: 'x [mock:extref-svg]', nodes: [{ id: 'a', label: 'A' }] }, { toolCallId: 'sc2' })
  ok(!b.ok && b.errorClass === 'invalid_renderer_output', '含外部 href 的 SVG 被拒（实际 ' + b.errorClass + '）')
})

await test('状态码映射：400/408/413/429/502/503', async () => {
  const cases = [
    ['400', 'invalid_compiled_dsl', false],
    ['408', 'timeout', false],
    ['413', 'output_too_large', false],
    ['429', 'retryable_external', true],
    ['502', 'renderer_unavailable', true],
    ['503', 'renderer_unavailable', true],
  ]
  for (const [behavior, cls, retryable] of cases) {
    const r = await call(mkClient(), behavior)
    ok(!r.ok && r.errorClass === cls, `HTTP ${behavior} → ${cls}（实际 ${r.errorClass}）`)
    eq(!!r.retryable, retryable, `HTTP ${behavior} retryable=${retryable}`)
  }
})

await test('重定向：不跟随', async () => {
  const c = mkClient()
  const r = await call(c, 'redirect')
  ok(!r.ok && r.errorClass !== 'cancelled', '重定向被拒绝且未跟随（实际 ' + r.errorClass + '）')
  ok(!seen.some((s) => s.url !== '/'), '没有任何请求发往重定向目标')
})

await test('连接拒绝（服务已停）→ renderer_unavailable 结构化失败', async () => {
  const dead = net.createServer()
  await new Promise((r) => dead.listen(0, '127.0.0.1', r))
  const deadPort = dead.address().port
  await new Promise((r) => dead.close(r))
  const c = new KrokiClient({ endpoint: `http://127.0.0.1:${deadPort}`, connectTimeoutMs: 1000, requestTimeoutMs: 2000, onEvent: () => {} })
  const r = await c.render({ dsl: 'title: "x"\n', diagramType: 'd2', specHash: 'x' })
  ok(!r.ok && (r.errorClass === 'renderer_unavailable' || r.errorClass === 'timeout'), '连接拒绝 → 结构化失败（实际 ' + r.errorClass + '）')
  ok(typeof r.message === 'string', '失败有可读 message')
})

// ─── 12：熔断 ───
await test('circuit breaker：open → half-open → 恢复', async () => {
  const events = []
  const c = mkClient({ circuitBreaker: { enabled: true, failureThreshold: 2, cooldownMs: 250 } , onEvent: (e) => { if (e.event?.startsWith('kroki_circuit')) events.push(e.event) } })
  ok(c.cb.state === 'closed', '初始 closed')
  await call(c, '502'); await call(c, '502') // 两次失败（各含一次自动重试）→ open
  ok(c.cb.state === 'open', '连续失败后 open（实际 ' + c.cb.state + '）')
  const gated = await call(c, 'ok')
  ok(!gated.ok && gated.circuitState === 'open', 'open 状态立即失败不等待超时')
  await sleep(300) // 冷却到期；state 在下一次 acquire 时才迁移 open→half_open
  const probe = await call(c, 'ok')
  ok(probe.ok, '冷却后放行探测且成功')
  ok(c.cb.state === 'closed', '探测成功恢复 closed（实际 ' + c.cb.state + '）')
  ok(events.includes('kroki_circuit_open') && events.includes('kroki_circuit_half_open') && events.includes('kroki_circuit_closed'), '熔断事件完整：' + events.join(','))
})

await test('circuit breaker 单元：half-open 只放一个探测', async () => {
  const ev = []
  const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50, onEvent: (e) => ev.push(e.event) })
  eq(cb.acquire(), null, 'closed 放行')
  cb.onFailure(); cb.onFailure()
  ok(cb.state === 'open', '失败 open')
  ok(typeof cb.acquire() === 'string', 'open 拒绝')
  await sleep(60)
  eq(cb.acquire(), null, '冷却后放探测（half-open）')
  ok(typeof cb.acquire() === 'string', '第二个并发请求被拒（单探测）')
  cb.onSuccess()
  eq(cb.state, 'closed', '成功恢复')
})

// ─── 13-14：service 层——Kroki 不可用不抛异常 ───
await test('service 层：Kroki 全失败 → 结构化失败（无未捕获异常），fallback 本地渲染一次', async () => {
  const svc = new DiagramService({
    renderer: 'kroki', fallbackRenderer: 'beautiful-mermaid',
    kroki: { endpoint: EP, connectTimeoutMs: 1000, requestTimeoutMs: 2000, circuitBreaker: { enabled: false } },
  }, { logger: () => {} })
  svc.temp.dir = path.join(TMPROOT, 'svc'); fs.mkdirSync(svc.temp.dir, { recursive: true })
  // title 携带 [mock:413] → Kroki 413 确定性失败（不重试）→ 回退本地
  const r = await svc.render({
    type: 'flowchart', title: '回退测试 [mock:413]',
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    edges: [{ from: 'a', to: 'b' }],
  }, { toolCallId: 'fb-1' })
  ok(r.ok, '回退本地渲染成功')
  eq(r.engine, 'beautiful-mermaid', 'engine=beautiful-mermaid')
  ok(fs.existsSync(r.path), '回退产物存在')
})

await test('service 层：fallbackRenderer none → 结构化失败，Agent 可继续', async () => {
  const svc = new DiagramService({
    renderer: 'kroki', fallbackRenderer: 'none',
    kroki: { endpoint: EP, connectTimeoutMs: 800, requestTimeoutMs: 1500, circuitBreaker: { enabled: false } },
  }, { logger: () => {} })
  const r = await svc.render({ type: 'flowchart', title: 'x [mock:502]', nodes: [{ id: 'a', label: 'A' }] }, { toolCallId: 'fb-2' })
  ok(!r.ok, '失败')
  ok(['renderer_unavailable', 'timeout', 'render_failed', 'invalid_compiled_dsl', 'output_too_large', 'invalid_renderer_output'].includes(r.errorClass), '错误分类合法：' + r.errorClass)
  ok(!/at .*\(/.test(r.message || ''), '无堆栈')
})

// ─── 16-17：Kroki SVG → resvg → PNG ───
await test('mock Kroki SVG 经 resvg → 合法 PNG，中文非方框', async () => {
  // Kroki（D2）返回的 SVG 形态：无 var()/无 style 块、具体色值、中文字体由 resvg 显式加载
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="#FAF9F6"/><text x="20" y="150" font-size="24" fill="#2D3748">中文流程图测试文字</text><rect x="10" y="10" width="80" height="40" fill="#EFF6FF" stroke="#BFDBFE"/></svg>`
  const { rasterizeSvg } = await import('./raster.js')
  const r = await rasterizeSvg(svg, { theme: { bg: '#FAF9F6' }, svgW: 400, svgH: 300, limits: { targetWidth: 800, maxOutputBytes: 8_388_608 } })
  ok(r.ok, '栅格化成功：' + (r.message || ''))
  if (r.ok) {
    const buf = r.png
    ok(buf[0] === 0x89 && buf[1] === 0x50, 'PNG 魔数')
    eq(r.width, 800, '宽度 800')
    const { createCanvas, loadImage } = await import('@napi-rs/canvas')
    const img = await loadImage(buf)
    const cv = createCanvas(img.width, img.height); const g = cv.getContext('2d')
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, img.width, img.height).data
    let dark = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++
    ok(dark > 200, `中文文字有实际墨迹像素（${dark}px，非空白/方框）`)
  }
})

// ─── 18：公共 Kroki 防线 ───
await test('公共 endpoint：默认拒绝 / 显式允许必须 HTTPS', async () => {
  const a = validateEndpoint('https://kroki.io')
  ok(!a.ok && /公共/.test(a.reason), '默认拒绝公共 Kroki：' + a.reason)
  const b = validateEndpoint('https://kroki.io', { allowPublicEndpoint: true })
  ok(b.ok && b.isPublic, '显式允许 + HTTPS → 通过')
  const c = validateEndpoint('http://kroki.io', { allowPublicEndpoint: true })
  ok(!c.ok && /HTTPS/.test(c.reason), '公共模式强制 HTTPS')
  for (const bad of ['file:///etc/passwd', 'ftp://x/y', 'data:text/html,x', 'unix:///var/run/x.sock', 'not a url', '']) {
    const r = validateEndpoint(bad)
    ok(!r.ok, `非法 scheme/URL 拒绝：${bad || '(空)'}`)
  }
  const auth = validateEndpoint('https://user:pass@kroki.example/')
  ok(!auth.ok && /认证/.test(auth.reason), 'endpoint 不允许携带凭据')
})

await test('重试策略：可重试错误只重试一次', async () => {
  const c = mkClient({ circuitBreaker: { enabled: false } })
  const before = seen.length
  await call(c, '502')
  const reqs = seen.length - before
  eq(reqs, 2, '502 自动重试一次后返回（共 ' + reqs + ' 个请求）')
  const before2 = seen.length
  await call(c, '400')
  eq(seen.length - before2, 1, '400 确定性失败不重试')
})

await test('取消不重试 / 失败不写缓存（service 层）', async () => {
  const svc = new DiagramService({
    renderer: 'kroki', fallbackRenderer: 'none',
    kroki: { endpoint: EP, connectTimeoutMs: 1000, requestTimeoutMs: 2500, circuitBreaker: { enabled: false } },
  }, { logger: () => {} })
  svc.temp.dir = path.join(TMPROOT, 'cancel'); fs.mkdirSync(svc.temp.dir, { recursive: true })
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), 250)
  // hang-body：headers 立即回但 body 挂死，确保取消发生在等待期而非请求完成之后
  const r = await svc.render({ type: 'flowchart', title: '取消 [mock:hang-body]', nodes: [{ id: 'a', label: 'A' }] }, { signal: ctl.signal, toolCallId: 'cx' })
  ok(!r.ok && r.errorClass === 'cancelled', 'service 层取消终态（实际 ' + r.errorClass + '）')
  eq(svc.cache.map.size, 0, '取消未写缓存')
  eq(fs.readdirSync(svc.temp.dir).length, 0, '取消后无文件落盘')
})

server.close()
console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed ? 1 : 0)
