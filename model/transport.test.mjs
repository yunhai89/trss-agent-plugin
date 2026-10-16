/**
 * 传输层回归：流式请求在 headers 到手后仍可被取消（离线，本地 SSE 服务，无外网）。
 *
 * 2026-10-17 审计 B2：`requestWithRetry` 的 `finally` 对**流式**分支也执行 `linked.cleanup?.()`，
 * 一拿到响应头就把 caller signal 上的 abort 监听摘掉 —— 此后用户点「停止」/上层取消都无法中断
 * 正在传输的 SSE：模型继续生成、连接继续占用、token 继续计费（上层只是不读了，请求没断）。
 *
 * 运行：node model/transport.test.mjs
 * 反向验证：把 transport-base.js 的 `if (!keepSignalLink) linked.cleanup?.()` 改回无条件执行，
 * 本文件两条断言都会失败（已实测）。
 */
import http from 'node:http'
import { requestWithRetry } from './openai/transport.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

await test('流式请求：headers 之后 abort 仍能中断传输（连接真的断）', async () => {
  let closedByClient = false
  const timers = new Set()
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const t = setInterval(() => { try { res.write('data: {}\n\n') } catch { /* noop */ } }, 20)
    timers.add(t)
    const stop = () => { clearInterval(t); timers.delete(t) }
    req.on('close', () => { closedByClient = true; stop() })
    res.on('close', stop)
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const ctl = new AbortController()
  try {
    const res = await requestWithRetry({
      url: `http://127.0.0.1:${port}/sse`, method: 'GET', stream: true, signal: ctl.signal,
    })
    const reader = res.body.getReader()
    const first = await reader.read()
    ok(!first.done, '拿到首个 chunk（已进入 body 传输阶段）')
    ctl.abort(new Error('user cancelled')) // 模拟用户点「停止」
    let aborted = false
    try {
      for (let i = 0; i < 500; i++) { const { done } = await reader.read(); if (done) break }
    } catch { aborted = true }
    ok(aborted, 'abort 后读取被中断（旧实现仍可继续读到数据）')
    await new Promise((r) => setTimeout(r, 300))
    ok(closedByClient, '服务端检测到客户端断开（旧实现连接仍挂着）')
  } finally {
    for (const t of timers) clearInterval(t)
    srv.close()
  }
})

console.log(`\n========================================\n通过 ${passed}，失败 ${failed}\n========================================`)
process.exit(failed ? 1 : 0)
