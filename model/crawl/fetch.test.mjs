/**
 * web_crawl fetch 层离线自检 —— 代理/重试/UA 轮换/错误分类/正文提取。
 * 运行：node model/crawl/fetch.test.mjs
 */
import { crawlWithFetch } from './index.js'

let passed = 0
let failed = 0
function okf(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); okf(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

const htmlResponse = (html, status = 200) => ({ ok: status >= 200 && status < 300, status, async text() { return html } })
const HTML = '<html><head><title>标题</title></head><body><article><h1>H</h1><p>第一段内容足够长足够长足够长。</p><p>第二段内容足够长足够长足够长。</p></article></body></html>'

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

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
