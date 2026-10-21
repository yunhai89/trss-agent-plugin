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

// 假 TTS 服务（IndexTTS /config + 豆包 NDJSON 单向流式，供「测试连接」成功路径；记录鉴权头）
const fakeTts = http.createServer((req, res) => {
  if (req.url === '/config') {
    fakeTts.lastAuthHeader = req.headers['x-api-key'] || ''
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ dependencies: [{ api_name: 'gen_single' }], components: [] }))
  }
  if (req.url === '/api/v3/tts/unidirectional') {
    fakeTts.lastDoubaoKey = req.headers['x-api-key'] || ''
    res.setHeader('Content-Type', 'application/json')
    const chunk = JSON.stringify({ code: 0, message: '', data: Buffer.from('RIFFfake').toString('base64') })
    const done = JSON.stringify({ code: 20000000, message: 'ok', usage: { text_words: 2 } })
    return res.end(chunk + '\n' + done + '\n')
  }
  res.statusCode = 404
  res.end('nope')
})
const fakePort = await new Promise((resolve) => { fakeTts.listen(0, '127.0.0.1', () => resolve(fakeTts.address().port)) })

await test('GET /api/tts：默认配置 + 服务商列表 + 空参考库', async () => {
  const r = await get('/api/tts')
  ok(r.status === 200 && r.body.code === 0, 'HTTP 200 / code 0')
  ok(r.body.data.enable === false, 'enable 默认关（opt-in）')
  ok(r.body.data.autoReply === true, '自动语音回复默认开')
  ok(r.body.data.replyMaxChars === 300, '自动语音字数上限默认 300')
  ok(r.body.data.hdVoice === true, '高清语音默认开')
  ok(r.body.data.provider === 'indextts', '默认服务商 indextts')
  const ids = (r.body.data.providers || []).map((p) => p.id)
  ok(ids.join(',') === 'indextts,doubao,minimax,mimo', `四家服务商卡片：${ids.join(',')}`)
  ok(r.body.data.providers.find((p) => p.id === 'doubao')?.configured === false, '豆包默认未配置')
  ok(r.body.data.providers.find((p) => p.id === 'minimax')?.fields?.some((f) => f.key === 'voiceId'), 'MiniMax 字段 schema 下发')
  ok(r.body.data.providers.find((p) => p.id === 'mimo')?.fields?.some((f) => f.key === 'style'), 'MiMo 字段 schema 下发')
  for (const id of ['doubao', 'minimax', 'mimo']) {
    const tier = r.body.data.providers.find((p) => p.id === id)?.fields?.find((f) => f.key === 'tier')
    ok(tier && tier.type === 'select' && tier.options.some((o) => o[0] === 'max'), `${id} 面板含 pro/max 档位字段`)
    const keys = (r.body.data.providers.find((p) => p.id === id)?.fields || []).map((f) => f.key)
    ok(keys.includes('segmentGapMs') && keys.includes('maxSegmentChars'), `${id} 面板含 max 档段间静音/单段字数`)
  }
  ok(Array.isArray(r.body.data.refs) && r.body.data.refs.length === 0, '参考库空')
  ok(r.body.data.indextts?.emotionMode === 'same', 'indextts 默认情绪模式 same')
  ok(r.body.data.doubao?.resourceId === 'seed-tts-2.0' && r.body.data.minimax?.model === 'speech-2.8-hd', '云服务商默认配置下发')
  ok(r.body.data.judgeTimeoutMs === 300000, '情绪判定全局超时下发（默认 5 分钟）')
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
    hdVoice: false,
  } })
  ok(r.status === 200 && r.body.code === 0, `保存成功（${r.status}/${r.body.code}）`)
  const cfg = __state.config.agent.tts
  ok(cfg.indextts.endpoint === 'http://127.0.0.1:7860', 'endpoint 写入')
  ok(cfg.indextts.emotionMode === 'vector', '情绪模式写入')
  ok(Array.isArray(cfg.indextts.vector) && cfg.indextts.vector[7] === 0.3, '向量写入')
  ok(cfg.autoReply === false, '自动语音开关写入')
  ok(cfg.replyMaxChars === 123, '自动语音上限写入（数值化）')
  ok(cfg.hdVoice === false, '高清语音开关写入')
  const payload = await get('/api/tts')
  ok(payload.body.data.providers[0].configured === true, 'configured 状态随配置刷新')
  ok(payload.body.data.autoReply === false && payload.body.data.replyMaxChars === 123, 'payload 回读一致')
  ok(payload.body.data.hdVoice === false, 'payload 高清语音回读一致')
  ok(!('apiKey' in payload.body.data.indextts), 'indextts 不再下发 apiKey')

  // 云服务商点路径 + 数值/布尔归一 + provider 合法性
  const cloud = await put('/api/tts/config', { changes: {
    'doubao.apiKey': 'vol_key', 'doubao.speaker': 'zh_female_vv_uranus_bigtts', 'doubao.autoEmotion': 0,
    'doubao.timeoutMs': '90000', 'doubao.emotionScale': 3, 'doubao.endpoint': 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    'minimax.voiceId': 'male-qn-qingse', 'mimo.apiKey': 'mimo_key', 'mimo.style': '用开心的语气说',
    'judgeModel': 'm-judge', 'judgeTimeoutMs': 20000,
  } })
  ok(cloud.status === 200 && cloud.body.code === 0, '云服务商配置写入成功')
  const cfg2 = __state.config.agent.tts
  ok(cfg2.doubao.apiKey === 'vol_key' && cfg2.doubao.speaker.endsWith('bigtts'), '豆包 key/音色写入')
  ok(cfg2.doubao.autoEmotion === false && cfg2.doubao.timeoutMs === 90000 && cfg2.doubao.emotionScale === 3, '布尔/数值归一')
  ok(cfg2.minimax.voiceId === 'male-qn-qingse' && cfg2.mimo.apiKey === 'mimo_key', 'MiniMax/MiMo 写入')
  ok(cfg2.judgeModel === 'm-judge' && cfg2.judgeTimeoutMs === 20000, '情绪判定全局字段写入')

  const badProv = await put('/api/tts/config', { changes: { provider: 'evil' } })
  ok(badProv.status === 400 && badProv.body.code === 4001, '非法 provider 被拒')
  const badEndpoint = await put('/api/tts/config', { changes: { 'doubao.endpoint': 'javascript:alert(1)' } })
  ok(badEndpoint.status === 400 && badEndpoint.body.code === 4001, '非 http(s) endpoint 被拒')
  ok(__state.config.agent.tts.doubao.endpoint === 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', 'endpoint 未被污染')
  const payload2 = await get('/api/tts')
  ok(payload2.body.data.doubao?.speaker === 'zh_female_vv_uranus_bigtts' && payload2.body.data.minimax?.voiceId === 'male-qn-qingse', '云配置回读')
  ok(payload2.body.data.providers.find((p) => p.id === 'doubao')?.configured === true, '豆包 configured 状态刷新')

  const over = await put('/api/tts/config', { changes: { replyMaxChars: 99999 } })
  ok(over.status === 200 && __state.config.agent.tts.replyMaxChars === 5000, '超范围夹到 5000')

  const evil = await put('/api/tts/config', { changes: { 'indextts.__proto__.x': 1, 'agent.apiKey': 'hack' } })
  ok(evil.status === 400 && evil.body.code === 4001, '越权路径被拒（4001）')
  ok(__state.config.agent.apiKey === undefined, '未写入 agent.apiKey')
  const ixKey = await put('/api/tts/config', { changes: { 'indextts.apiKey': 'legacy' } })
  ok(ixKey.status === 400 && ixKey.body.code === 4001, 'IndexTTS 已移除 apiKey，写入被拒')
})

await test('POST /api/tts/test：真实 HTTP 探活（成功解析 fn_index / 不可达返回 5000 / 不发鉴权头）', async () => {
  const okRes = await postJson('/api/tts/test', { endpoint: `http://127.0.0.1:${fakePort}` })
  ok(okRes.status === 200 && okRes.body.code === 0, `连通成功（${okRes.status}/${okRes.body.code}）`)
  ok(okRes.body.data?.fnIndex === 0, 'fn_index 从假服务解析')
  const keyRes = await postJson('/api/tts/test', { endpoint: `http://127.0.0.1:${fakePort}`, apiKey: 'itts_test_123' })
  ok(keyRes.status === 200 && fakeTts.lastAuthHeader === '', '即使传 apiKey 也不发鉴权头（IndexTTS 直连本体）')
  const bad = await postJson('/api/tts/test', { endpoint: 'http://127.0.0.1:1' })
  ok(bad.status === 500 && bad.body.code === 5000, '不可达 5000')

  // 云服务商连通性：草稿覆盖保存配置，真实合成 2 字
  const db = await postJson('/api/tts/test', {
    provider: 'doubao',
    endpoint: `http://127.0.0.1:${fakePort}/api/v3/tts/unidirectional`,
    apiKey: 'draft_key', speaker: 'draft_speaker',
  })
  ok(db.status === 200 && db.body.code === 0, `豆包连通成功（${db.status}/${db.body.code}）`)
  ok(fakeTts.lastDoubaoKey === 'draft_key', '豆包测试透传草稿 X-Api-Key')
  const dbBad = await postJson('/api/tts/test', {
    provider: 'doubao',
    endpoint: `http://127.0.0.1:${fakePort}/api/v3/tts/unidirectional`,
    apiKey: 'draft_key', speaker: '',
  })
  ok(dbBad.status === 500 && dbBad.body.code === 5000, '豆包缺音色 → 5000 且不出网')
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
