/**
 * Web TTS 路由自检（真实 express router，桩 Config/运行时）：
 * GET 配置 / PUT 配置（白名单） / 参考音频上传（raw body）· 试听 · 删除 / 连通性测试。
 * 运行：node --import ./stress/e2e/hooks.mjs model/web/tts.test.mjs
 */
import express from 'express'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { buildApiRouter } from './api.js'
import { errorMiddleware } from './response.js'
import ConfigStub, { __setConfig, __state } from '../../stress/e2e/stubs/Config.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

// 桩 Config 的 save 默认抛错（E2E 语义）；本测试验证写路由，改为 no-op（内存配置照常更新）
ConfigStub.save = () => true
const ttsDir = ConfigStub.path.tts
fs.rmSync(ttsDir, { recursive: true, force: true })

__setConfig({ agent: { tts: {} } })

const app = express()
app.use(express.json())
app.use('/api', buildApiRouter({ runtimeProvider: async () => ({}) }))
app.use(errorMiddleware)
const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() } }
const put = async (p, body) => { const r = await fetch(base + p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
const postJson = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
const postRaw = async (p, buf) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf }); return { status: r.status, body: await r.json() } }
const del = async (p) => { const r = await fetch(base + p, { method: 'DELETE' }); return { status: r.status, body: await r.json() } }

// 假 IndexTTS 服务（供「测试连接」成功路径）
const fakeTts = http.createServer((req, res) => {
  if (req.url === '/config') {
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ dependencies: [{ api_name: 'gen_single' }], components: [] }))
  }
  res.statusCode = 404
  res.end('nope')
})
const fakePort = await new Promise((resolve) => { fakeTts.listen(0, '127.0.0.1', () => resolve(fakeTts.address().port)) })

await test('GET /api/tts：默认配置 + 服务商列表 + 空参考库', async () => {
  const r = await get('/api/tts')
  ok(r.status === 200 && r.body.code === 0, 'HTTP 200 / code 0')
  ok(r.body.data.enable === true, 'enable 默认开')
  ok(r.body.data.autoReply === true, '自动语音回复默认开')
  ok(r.body.data.replyMaxChars === 300, '自动语音字数上限默认 300')
  ok(r.body.data.provider === 'indextts', '默认服务商 indextts')
  ok(r.body.data.providers?.[0]?.id === 'indextts' && r.body.data.providers[0].configured === false, '服务商卡片数据（未配置）')
  ok(Array.isArray(r.body.data.refs) && r.body.data.refs.length === 0, '参考库空')
  ok(r.body.data.indextts?.emotionMode === 'same', 'indextts 默认情绪模式 same')
})

let voiceId = ''
await test('POST /api/tts/refs：二进制直传 + 命名 + 查重/格式校验', async () => {
  const r = await postRaw('/api/tts/refs?name=%E8%8A%99%E5%AE%81%E5%A8%9C&kind=voice&filename=%E8%8A%99.wav', Buffer.from('RIFFvoice'))
  ok(r.status === 200 && r.body.code === 0, `上传成功（${r.status}/${r.body.code}）`)
  ok(r.body.data?.name === '芙宁娜' && r.body.data?.kind === 'voice', '命名与类型回传')
  voiceId = r.body.data.id
  ok(fs.existsSync(path.join(ttsDir, 'refs', `${voiceId}.wav`)), '音频落盘到 data/tts/refs')

  const dup = await postRaw('/api/tts/refs?name=%E8%8A%99%E5%AE%81%E5%A8%9C&kind=voice&filename=b.wav', Buffer.from('RIFF'))
  ok(dup.status === 400 && dup.body.code === 4001, '重名 4001')
  const badExt = await postRaw('/api/tts/refs?name=x&kind=voice&filename=x.js', Buffer.from('xxx'))
  ok(badExt.status === 400 && badExt.body.code === 4001, '非法格式 4001')

  const list = await get('/api/tts')
  ok(list.body.data.refs.length === 1, '列表含 1 条')
})

await test('GET /api/tts/refs/:id/audio：试听可回放（无 Authorization 时 401，?token= 通道另由 auth 测试覆盖）', async () => {
  // 本测试 app 未挂 authMiddleware，直接验证文件服务与类型
  const r = await fetch(`${base}/api/tts/refs/${voiceId}/audio`)
  ok(r.status === 200, 'HTTP 200')
  ok(/audio\/wav/.test(r.headers.get('content-type') || ''), 'Content-Type 按扩展名')
  const buf = Buffer.from(await r.arrayBuffer())
  ok(buf.toString() === 'RIFFvoice', '内容与上传一致')
  const nf = await get('/api/tts/refs/not-exist/audio')
  ok(nf.status === 404 && nf.body.code === 4004, '不存在 4004')
})

await test('PUT /api/tts/config：白名单点路径写入（enable/provider/indextts.*）', async () => {
  const r = await put('/api/tts/config', { changes: {
    'indextts.endpoint': 'http://127.0.0.1:7860',
    'indextts.emotionMode': 'vector',
    'indextts.vector': [0.5, 0, 0, 0, 0, 0, 0, 0.3],
    enable: true,
    provider: 'indextts',
    autoReply: false,
    replyMaxChars: 123,
  } })
  ok(r.status === 200 && r.body.code === 0, `保存成功（${r.status}/${r.body.code}）`)
  const cfg = __state.config.agent.tts
  ok(cfg.indextts.endpoint === 'http://127.0.0.1:7860', 'endpoint 写入')
  ok(cfg.indextts.emotionMode === 'vector', '情绪模式写入')
  ok(Array.isArray(cfg.indextts.vector) && cfg.indextts.vector[7] === 0.3, '向量写入')
  ok(cfg.autoReply === false, '自动语音开关写入')
  ok(cfg.replyMaxChars === 123, '自动语音上限写入（数值化）')
  const payload = await get('/api/tts')
  ok(payload.body.data.providers[0].configured === true, 'configured 状态随配置刷新')
  ok(payload.body.data.autoReply === false && payload.body.data.replyMaxChars === 123, 'payload 回读一致')

  const over = await put('/api/tts/config', { changes: { replyMaxChars: 99999 } })
  ok(over.status === 200 && __state.config.agent.tts.replyMaxChars === 5000, '超范围夹到 5000')

  const evil = await put('/api/tts/config', { changes: { 'indextts.__proto__.x': 1, 'agent.apiKey': 'hack' } })
  ok(evil.status === 400 && evil.body.code === 4001, '越权路径被拒（4001）')
  ok(__state.config.agent.apiKey === undefined, '未写入 agent.apiKey')
})

await test('POST /api/tts/test：真实 HTTP 探活（成功解析 fn_index / 不可达返回 5000）', async () => {
  const okRes = await postJson('/api/tts/test', { endpoint: `http://127.0.0.1:${fakePort}` })
  ok(okRes.status === 200 && okRes.body.code === 0, `连通成功（${okRes.status}/${okRes.body.code}）`)
  ok(okRes.body.data?.fnIndex === 0, 'fn_index 从假服务解析')
  const bad = await postJson('/api/tts/test', { endpoint: 'http://127.0.0.1:1' })
  ok(bad.status === 500 && bad.body.code === 5000, '不可达 5000')
  await put('/api/tts/config', { changes: { 'indextts.endpoint': '' } })
  const empty = await postJson('/api/tts/test', {})
  ok(empty.status === 400 && empty.body.code === 4001, '既无入参也无配置地址 → 4001')
  await put('/api/tts/config', { changes: { 'indextts.endpoint': 'http://127.0.0.1:7860' } })
})

await test('DELETE /api/tts/refs/:id：删条目 + 删文件', async () => {
  const r = await del(`/api/tts/refs/${voiceId}`)
  ok(r.status === 200 && r.body.code === 0, '删除成功')
  ok(!fs.existsSync(path.join(ttsDir, 'refs', `${voiceId}.wav`)), '文件已删')
  const again = await del(`/api/tts/refs/${voiceId}`)
  ok(again.status === 404 && again.body.code === 4004, '重复删除 4004')
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
server.close()
fakeTts.close()
if (failed > 0) process.exitCode = 1
