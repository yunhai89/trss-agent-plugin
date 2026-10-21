/**
 * web_crawl fetch 层离线自检 —— 代理/重试/UA 轮换/错误分类/正文提取
 * + 字符集解码（GBK/Big5 老站）/ Cookie Jar（跳转携带会话）/ 挑战页与 JS 空壳识别/退避。
 * 运行：node model/crawl/fetch.test.mjs
 */
import { crawlWithFetch, decodeHtmlBuffer, createCookieJar, looksLikeChallenge, looksLikeJsShell } from './index.js'

let passed = 0
let failed = 0
function okf(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); okf(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

const htmlResponse = (html, status = 200) => ({ ok: status >= 200 && status < 300, status, async text() { return html } })
const HTML = '<html><head><title>标题</title></head><body><article><h1>H</h1><p>第一段内容足够长足够长足够长。</p><p>第二段内容足够长足够长足够长。</p></article></body></html>'

/** 带状态/头/字节体的响应桩（验证字符集与 Cookie 需要 arrayBuffer/headers） */
function resp({ status = 200, headers = {}, body = '', ok = null, setCookie = null, combined = null } = {}) {
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[String(k).toLowerCase()] = v
  return {
    ok: ok == null ? status >= 200 && status < 300 : ok,
    status,
    headers: {
      get: (n) => lower[String(n).toLowerCase()] ?? null,
      ...(setCookie ? { getSetCookie: () => setCookie } : {}),
      ...(combined ? { get: (n) => (String(n).toLowerCase() === 'set-cookie' ? combined : lower[String(n).toLowerCase()] ?? null) } : {}),
    },
    async arrayBuffer() { return Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8') },
    async text() { return Buffer.isBuffer(body) ? body.toString('utf8') : String(body) },
  }
}

await test('成功：提取正文 + 保留段落换行', async () => {
  const f = async () => htmlResponse(HTML)
  const r = await crawlWithFetch('https://x.test/a', { fetcher: f, retries: 1 })
  eq(r.success, true, 'success')
  eq(r.via, 'fetch', 'via=fetch')
  eq(r.title, '标题', 'title')
  okf(r.markdown.includes('第一段') && r.markdown.includes('第二段'), '正文两段都在')
  okf(/\n/.test(r.markdown), '保留换行（非单行挤压）')
})

await test('403 → 重试后成功（UA 轮换）', async () => {
  let n = 0
  const f = async () => { n++; return n === 1 ? htmlResponse('', 403) : htmlResponse(HTML) }
  const r = await crawlWithFetch('https://x.test/b', { fetcher: f, retries: 2 })
  eq(r.success, true, '重试成功')
  eq(n, 2, '尝试 2 次')
})

await test('持续 403 → code=blocked + hint', async () => {
  const f = async () => htmlResponse('', 403)
  const r = await crawlWithFetch('https://x.test/c', { fetcher: f, retries: 1 })
  eq(r.success, false, '失败')
  eq(r.code, 'blocked', 'code=blocked')
  okf(/反爬|crawl4ai|proxy/.test(r.hint || ''), '给出可操作 hint')
})

await test('网络错误 → code=network + hint', async () => {
  const f = async () => { const e = new Error('getaddrinfo ENOTFOUND x.test'); e.code = 'ENOTFOUND'; throw e }
  const r = await crawlWithFetch('https://x.test/d', { fetcher: f, retries: 1 })
  eq(r.code, 'network', 'code=network')
  okf(/代理|DNS/.test(r.hint || ''), 'hint 提示代理/DNS')
})

await test('超时 → code=timeout', async () => {
  const f = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
  const r = await crawlWithFetch('https://x.test/e', { fetcher: f, retries: 1, timeout: 5 })
  eq(r.code, 'timeout', 'code=timeout')
})

await test('空正文（SPA 空壳）→ code=empty', async () => {
  const f = async () => htmlResponse('<html><body></body></html>')
  const r = await crawlWithFetch('https://x.test/f', { fetcher: f, retries: 1 })
  eq(r.code, 'empty', 'code=empty')
  okf(/crawl4ai/.test(r.hint || ''), 'hint 指向 crawl4ai')
})

await test('字符集：Content-Type 声明 GBK → 中文不乱码（修 undici text() 固定 UTF-8）', async () => {
  const gbk = Buffer.concat([
    Buffer.from('<html><head><title>', 'latin1'),
    Buffer.from([0xD6, 0xD0, 0xB9, 0xFA, 0xC8, 0xCB]), // 中国人（GBK 编码）
    Buffer.from('</title></head><body><article><p>', 'latin1'),
    Buffer.from([0xD6, 0xD0, 0xB9, 0xFA, 0xC8, 0xCB]),
    Buffer.from(' website content long enough for extraction.</p></article></body></html>', 'latin1'),
  ])
  const f = async () => resp({ body: gbk, headers: { 'content-type': 'text/html; charset=gb2312' } })
  const r = await crawlWithFetch('https://x.test/gbk', { fetcher: f, retries: 1 })
  eq(r.success, true, 'success')
  eq(r.title, '中国人', 'title 按 GBK 正确解码')
  okf(r.markdown.includes('中国人'), '正文按 GBK 正确解码')
  okf(!r.markdown.includes('\uFFFD'), '无替换符乱码')
})

await test('字符集：Content-Type 无 charset 时嗅探 <meta charset>；未知编码回退不抛错', async () => {
  const gbk = Buffer.concat([
    Buffer.from('<html><head><meta charset="gb2312"><title>', 'latin1'),
    Buffer.from([0xD6, 0xD0, 0xB9, 0xFA, 0xC8, 0xCB]),
    Buffer.from('</title></head><body><p>', 'latin1'),
    Buffer.from([0xD6, 0xD0, 0xB9, 0xFA, 0xC8, 0xCB]),
    Buffer.from(' meta sniffed content long enough for extraction.</p></body></html>', 'latin1'),
  ])
  const f = async () => resp({ body: gbk, headers: { 'content-type': 'text/html' } })
  const r = await crawlWithFetch('https://x.test/meta', { fetcher: f, retries: 1 })
  eq(r.title, '中国人', 'meta 嗅探生效')
  eq(decodeHtmlBuffer(Buffer.from('abc'), 'charset=not-a-real-encoding'), 'abc', '未知编码回退 UTF-8（不抛错）')
})

await test('Cookie Jar：跳转逐跳携带 Set-Cookie（跨跳会话保持）；domain/path/secure 匹配', async () => {
  const calls = []
  const f = async (url, opts) => {
    calls.push({ url, cookie: opts.headers?.Cookie || '' })
    if (calls.length === 1) return resp({ status: 302, headers: { location: '/next' }, setCookie: ['sid=abc123; Path=/; HttpOnly'] })
    if (calls.length === 2) return resp({ status: 302, headers: { location: 'https://x.test/final' }, setCookie: ['_n=1; Path=/'] })
    return resp({ body: HTML })
  }
  const jar = createCookieJar()
  const r = await crawlWithFetch('https://x.test/start', { fetcher: f, retries: 1, jar })
  eq(r.success, true, 'success')
  eq(r.finalUrl, 'https://x.test/final', '跟随到最终地址')
  eq(calls.length, 3, '跟随两次跳转')
  eq(calls[0].cookie, '', '首跳无 Cookie')
  okf(calls[1].cookie.includes('sid=abc123'), '第二跳携带首跳 Set-Cookie')
  okf(calls[1].cookie.includes('sid=abc123') && calls[2].cookie.includes('_n=1'), '第三跳携带累积 Cookie')
  eq(jar.size(), 2, 'jar 记录两个 cookie')
  // 组合 Set-Cookie 头（无 getSetCookie）按 `, name=` 切分，Expires 内逗号不误切
  const jar2 = createCookieJar()
  const f2 = async (url, opts) => {
    if (opts.headers?.Cookie) return resp({ body: HTML })
    return resp({
      status: 302, headers: { location: '/x' },
      combined: 'a=1; Path=/, b=2; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/',
    })
  }
  const r2 = await crawlWithFetch('https://y.test/', { fetcher: f2, retries: 1, jar: jar2 })
  eq(jar2.size(), 2, '组合头解析出两个 cookie')
  eq(r2.success, true, 'success（组合头）')
  // 跨域 Domain 伪造拒绝：evil.test 的响应不能给 x.test 设 cookie
  const jar3 = createCookieJar()
  jar3.store('https://evil.test/', ['x=1; Domain=x.test; Path=/'])
  eq(jar3.size(), 0, '跨域 Domain 伪造拒绝')
})

await test('挑战页：403 + Cloudflare 挑战特征 → code=challenge 且不重试（交给浏览器路径）', async () => {
  let n = 0
  const challengeHtml = '<html><head><title>Just a moment...</title></head><body><script src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>Enable JavaScript and cookies to continue</body></html>'
  const f = async () => { n++; return resp({ status: 403, body: challengeHtml, headers: { 'content-type': 'text/html' } }) }
  const r = await crawlWithFetch('https://x.test/cf', { fetcher: f, retries: 3 })
  eq(r.code, 'challenge', 'code=challenge')
  eq(n, 1, '挑战页不浪费重试')
  okf(/crawl4ai/.test(r.hint || ''), 'hint 指向真浏览器渲染')
  // 误伤防护：正常页面加载 challenge-platform 脚本（CF 通过后）不判挑战
  okf(!looksLikeChallenge({ status: 200, title: '正常文章', html: '<script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js"></script><p>正文正文</p>' }), '不误伤已通过 CF 的正常页面')
  // 误伤防护：正文提到“验证码”的正常文章（状态 200、正文长）不判挑战
  okf(!looksLikeChallenge({ status: 200, title: '如何设计安全验证', html: `<p>${'这是一篇讨论人机验证与安全验证的文章。'.repeat(200)}</p>` }), '不误伤正文含验证关键词的长文')
})

await test('JS 空壳：200 但正文极短 + #app 挂载点 → code=js_required（提示装 crawl4ai）', async () => {
  const shell = '<html><head><title>站点</title></head><body><div id="app">加载中...</div><script src="/vendor.js"></script><script src="/main.js"></script></body></html>'
  const f = async () => htmlResponse(shell)
  const r = await crawlWithFetch('https://x.test/spa', { fetcher: f, retries: 1 })
  eq(r.code, 'js_required', 'code=js_required')
  okf(/crawl4ai/.test(r.hint || ''), 'hint 指向 crawl4ai')
  // 纯静态小页面（无框架挂载点）不误判
  const r2 = await crawlWithFetch('https://x.test/tiny', { fetcher: async () => htmlResponse('<html><head><title>Info</title></head><body><p>This domain is for illustrative examples in documents.</p></body></html>'), retries: 1 })
  eq(r2.success, true, '静态小页面仍成功')
  okf(looksLikeJsShell({ text: 'Sina Visitor System', html: '<html><body><span id="message"></span></body></html>', title: 'Sina Visitor System' }), '访客系统型空壳识别')
})

await test('退避：429 + Retry-After:0 → 重试成功；重试次数受预算约束', async () => {
  let n = 0
  const f = async () => {
    n++
    return n === 1
      ? resp({ status: 429, headers: { 'retry-after': '0' }, body: 'slow down' })
      : resp({ body: HTML })
  }
  const r = await crawlWithFetch('https://x.test/ra', { fetcher: f, retries: 3 })
  eq(r.success, true, '重试后成功')
  eq(n, 2, '命中 Retry-After 后重试一次')
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
