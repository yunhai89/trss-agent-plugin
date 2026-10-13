/**
 * 云服务商 TTS 离线自检（豆包 / MiniMax / MiMo）：
 *  - providers.js 情绪映射与配置完备性；
 *  - 三家客户端协议（NDJSON / hex / base64）、鉴权头、错误提示（fetchImpl 注入，零真实网络）；
 *  - TtsService 云端路由：LLM 情绪判定 → 服务商参数、固定情绪回退、max 档分段拼接（runner 注入）；
 *  - tts_speak 工具 schema 随服务商切换。
 * 运行：node model/tts/cloud.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  TtsService, makeTtsSpeakTool,
  providerConfigured, dominantEmotion, labelFor, doubaoScaleFor, styleInstructionFor, langFor,
  parseDoubaoNdjson, DoubaoTtsClient, MinimaxTtsClient, MimoTtsClient,
  doubaoHint, minimaxHint, MIMO_VOICES,
  parsePlan, stripAudioTags, isFaithfulTagged, buildEmotionSystemPrompt,
} from './index.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { ok(Object.is(a, b), `${m}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-cloud-'))
const JSON_HDR = { 'Content-Type': 'application/json' }
const NDJSON_OK = [
  JSON.stringify({ code: 0, message: '', data: Buffer.from('RIFFdoubao').toString('base64') }),
  JSON.stringify({ code: 20000000, message: 'ok', usage: { text_words: 2 } }),
].join('\n')
const fakeRunner = (args) => {
  const out = args[args.length - 1]
  // 注意：volumedetect 的输出占位是 '-'（stdout），不能当文件写
  if (out && out !== '-') { try { fs.writeFileSync(out, Buffer.from('FAKEWAV')) } catch { /* noop */ } }
  return Promise.resolve({ ok: true, exitCode: 0, stdout: '', stderr: '' })
}
const mkFetch = (routes) => async (url, init = {}) => {
  const key = Object.keys(routes).find((k) => String(url).includes(k))
  if (!key) return new Response('not found', { status: 404 })
  return routes[key](String(url), init)
}
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSON_HDR })

/* ─────────────────────── 1. providers.js 情绪映射 ─────────────────────── */
await test('providers：向量主导情绪/标签映射/强度/风格指令/语言映射', () => {
  eq(dominantEmotion({ happy: 0.9, calm: 0.3 }).key, 'happy', '主导情绪')
  eq(labelFor('doubao', { afraid: 1 }), 'fear', '豆包：害怕→fear')
  eq(labelFor('doubao', { melancholic: 0.8 }), 'depressed', '豆包：忧郁→depressed')
  eq(labelFor('minimax', { melancholic: 0.8 }), 'sad', 'MiniMax：忧郁→sad')
  eq(labelFor('minimax', { disgusted: 0.7 }), 'disgusted', 'MiniMax：厌恶→disgusted')
  eq(labelFor('mimo', { happy: 1 }), '', '无标签服务商返回空')
  eq(doubaoScaleFor({ happy: 1.2 }), 5, '强度换算上限 5')
  eq(doubaoScaleFor({ calm: 0 }), 1, '强度换算下限 1')
  const ins = styleInstructionFor({ happy: 0.95, calm: 0.3 })
  ok(/开心愉悦/.test(ins) && /情绪饱满/.test(ins), `风格指令含主导情绪与强度：${ins}`)
  eq(styleInstructionFor({ calm: 0.2 }), '用平静自然的语气说，语气自然些', '平静低强度指令')
  eq(langFor('doubao', 'ZH'), 'zh-cn', '豆包语言映射')
  eq(langFor('minimax', 'JA'), 'Japanese', 'MiniMax 语言映射')
  eq(langFor('mimo', 'ZH'), '', 'MiMo 无语言字段')
  ok(MIMO_VOICES.includes('冰糖'), 'MiMo 预置音色表')
})

await test('providers：配置完备性判定（缺什么列出什么）', () => {
  eq(providerConfigured('doubao', { doubao: { apiKey: 'k' } }).configured, false, '豆包缺音色=未配置')
  ok(providerConfigured('doubao', { doubao: { apiKey: 'k' } }).missing.includes('音色 ID'), '缺音色提示')
  eq(providerConfigured('minimax', { minimax: { apiKey: 'k', voiceId: 'v' } }).configured, true, 'MiniMax 齐全')
  eq(providerConfigured('mimo', { mimo: { apiKey: '' } }).configured, false, 'MiMo 缺 key')
  eq(providerConfigured('indextts', { indextts: { endpoint: 'http://x' } }).configured, true, 'IndexTTS 有地址')
})

/* ─────────────────────── 2. 豆包协议 ─────────────────────── */
await test('豆包：NDJSON 解析（分片拼接/结束标记/错误码）', () => {
  const r = parseDoubaoNdjson(NDJSON_OK)
  eq(r.audio.toString(), 'RIFFdoubao', 'base64 分片拼接')
  eq(r.usage.text_words, 2, 'usage 透出')
  const multi = [
    JSON.stringify({ code: 3000, data: Buffer.from('ab').toString('base64') }),
    JSON.stringify({ code: 0, data: Buffer.from('cd').toString('base64') }),
    JSON.stringify({ code: 20000000, message: 'ok' }),
  ].join('\n')
  eq(parseDoubaoNdjson(multi).audio.toString(), 'abcd', 'code 3000/0 都是音频分片')
  let err = ''
  try { parseDoubaoNdjson(JSON.stringify({ code: 45000001, message: 'bad speaker' })) } catch (e) { err = e.message }
  ok(/bad speaker/.test(err) && /请求参数错误/.test(err), `业务错误 → 可读提示：${err}`)
  let empty = ''
  try { parseDoubaoNdjson('') } catch (e) { empty = e.message }
  ok(/响应为空/.test(empty), '空响应报错')
  ok(/参数错误/.test(doubaoHint(45000001)) && /服务端/.test(doubaoHint(55000000)), '错误码提示表')
})

await test('豆包客户端：鉴权头/2.0 语音指令/1.0 情感标签/HTTP 错误', async () => {
  const calls = []
  const fetchImpl = mkFetch({
    'unidirectional': async (url, init) => { calls.push({ url, init }); return new Response(NDJSON_OK, { status: 200 }) },
  })
  const c = new DoubaoTtsClient({ apiKey: 'key-1', speaker: 'zh_female_vv_uranus_bigtts', resourceId: 'seed-tts-2.0', fetchImpl })
  const r = await c.synthesize({ text: '你好', format: 'wav', sampleRate: 24000, instruct: '用痛心的语气', explicitLanguage: 'zh-cn' })
  eq(r.buffer.toString(), 'RIFFdoubao', '响应音频')
  eq(r.ext, 'wav', '输出扩展名')
  eq(calls[0].init.headers['X-Api-Key'], 'key-1', 'X-Api-Key 鉴权')
  eq(calls[0].init.headers['X-Api-Resource-Id'], 'seed-tts-2.0', '资源版本头')
  ok(typeof calls[0].init.headers['X-Api-Request-Id'] === 'string' && calls[0].init.headers['X-Api-Request-Id'].length > 8, '随机 Request-Id')
  const body = JSON.parse(calls[0].init.body)
  eq(body.req_params.speaker, 'zh_female_vv_uranus_bigtts', 'speaker 透传')
  const adds = JSON.parse(body.req_params.additions)
  eq(adds.context_texts[0], '用痛心的语气', '2.0 语音指令进 additions.context_texts')
  eq(adds.explicit_language, 'zh-cn', '语言显式声明')
  eq(body.req_params.audio_params.emotion, undefined, '2.0 不带 emotion 标签')

  const c10 = new DoubaoTtsClient({ apiKey: 'k', speaker: 's', resourceId: 'seed-tts-1.0', fetchImpl })
  await c10.synthesize({ text: 'x', emotionLabel: 'sad', emotionScale: 3, format: 'mp3' })
  const b10 = JSON.parse(calls[1].init.body)
  eq(b10.req_params.audio_params.emotion, 'sad', '1.0 emotion 标签')
  eq(b10.req_params.audio_params.emotion_scale, 3, 'emotion_scale')
  eq(b10.req_params.additions, undefined, '1.0 不带语音指令')

  const bad = new DoubaoTtsClient({ apiKey: 'k', speaker: 's', fetchImpl: async () => new Response('unauthorized', { status: 401 }) })
  let err = ''
  try { await bad.synthesize({ text: 'x' }) } catch (e) { err = e.message }
  ok(/HTTP 401/.test(err) && /API Key/.test(err), `401 提示：${err}`)

  const noKey = new DoubaoTtsClient({ fetchImpl })
  const chk = await noKey.check()
  eq(chk.ok, false, '未配置 check 失败')
  ok(/API Key/.test(chk.error), '未配置原因可读')
})

/* ─────────────────────── 3. MiniMax 协议 ─────────────────────── */
await test('MiniMax 客户端：hex 解码/情绪与音频参数/业务错误码/GroupId', async () => {
  const calls = []
  const audioHex = Buffer.from('MINIMAXAUDIO').toString('hex')
  const fetchImpl = mkFetch({
    't2a_v2': async (url, init) => { calls.push({ url, init }); return jsonRes({ data: { audio: audioHex, status: 2 }, extra_info: { usage_characters: 2 }, base_resp: { status_code: 0, status_msg: 'success' } }) },
  })
  const c = new MinimaxTtsClient({ apiKey: 'mm-key', voiceId: 'male-qn-qingse', groupId: 'G123', fetchImpl })
  const r = await c.synthesize({ text: '你好', emotion: 'happy', format: 'mp3', sampleRate: 32000, speed: 1.1, pitch: 2 })
  eq(r.buffer.toString(), 'MINIMAXAUDIO', 'hex → Buffer 解码')
  ok(calls[0].url.includes('GroupId=G123'), 'GroupId 查询参数')
  eq(calls[0].init.headers.Authorization, 'Bearer mm-key', 'Bearer 鉴权')
  const body = JSON.parse(calls[0].init.body)
  eq(body.voice_setting.emotion, 'happy', '情绪标签')
  eq(body.voice_setting.voice_id, 'male-qn-qingse', '音色')
  eq(body.audio_setting.bitrate, 128000, 'mp3 带比特率')
  eq(r.usage.usage_characters, 2, '计费字符透出')

  const fail = new MinimaxTtsClient({ apiKey: 'k', voiceId: 'v', fetchImpl: async () => jsonRes({ base_resp: { status_code: 1004, status_msg: 'auth failed' } }) })
  let err = ''
  try { await fail.synthesize({ text: 'x' }) } catch (e) { err = e.message }
  ok(/1004/.test(err) && /鉴权失败/.test(err), `业务错误码 → 提示：${err}`)
  ok(/限流/.test(minimaxHint(1002)) && /非法字符/.test(minimaxHint(1042)), '错误码提示表')
  const wav = new MinimaxTtsClient({ apiKey: 'k', voiceId: 'v', fetchImpl: mkFetch({ 't2a_v2': async () => jsonRes({ data: { audio: audioHex }, base_resp: { status_code: 0 } }) }) })
  await wav.synthesize({ text: 'x', format: 'wav' })
  ok(true, 'wav 格式可用')
})

/* ─────────────────────── 4. MiMo 协议 ─────────────────────── */
await test('MiMo 客户端：OpenAI 兼容调用/风格指令/音色/错误体', async () => {
  const calls = []
  const fetchImpl = mkFetch({
    'chat/completions': async (url, init) => {
      calls.push({ url, init })
      return jsonRes({ choices: [{ message: { audio: { data: Buffer.from('MIMOAUDIO').toString('base64') } } }] })
    },
  })
  const c = new MimoTtsClient({ apiKey: 'mimo-key', voice: '冰糖', fetchImpl })
  const r = await c.synthesize({ text: '你好呀', style: '用开心的语气说', format: 'wav' })
  eq(r.buffer.toString(), 'MIMOAUDIO', 'base64 解码')
  eq(calls[0].init.headers['api-key'], 'mimo-key', 'api-key 鉴权头')
  const body = JSON.parse(calls[0].init.body)
  eq(body.model, 'mimo-v2.5-tts', '模型')
  eq(body.messages[0].role, 'user', '风格指令在 user')
  eq(body.messages[1].role, 'assistant', '朗读文本在 assistant')
  eq(body.audio.voice, '冰糖', '预置音色')
  eq(body.stream, false, '非流式')

  const noStyle = new MimoTtsClient({ apiKey: 'k', fetchImpl })
  await noStyle.synthesize({ text: 'x' })
  eq(JSON.parse(calls[1].init.body).messages.length, 1, '无风格指令时不发 user 消息')

  const design = new MimoTtsClient({ apiKey: 'k', model: 'mimo-v2.5-tts-voicedesign', fetchImpl })
  let err = ''
  try { await design.synthesize({ text: 'x' }) } catch (e) { err = e.message }
  ok(/固定风格指令/.test(err), 'voicedesign 缺音色描述报错')

  const errBody = new MimoTtsClient({ apiKey: 'k', fetchImpl: async () => jsonRes({ error: { message: 'quota exceeded' } }, 429) })
  let err2 = ''
  try { await errBody.synthesize({ text: 'x' }) } catch (e) { err2 = e.message }
  ok(/quota exceeded/.test(err2) && /限流/.test(err2), `HTTP 错误体透出：${err2}`)
})

/* ─────────────────────── 5. TtsService 云路由 ─────────────────────── */
await test('TtsService：豆包 2.0 = LLM 情绪 → 语音指令（无 emotion 标签）', async () => {
  const calls = []
  const fetchImpl = mkFetch({ 'unidirectional': async (url, init) => { calls.push({ url, init }); return new Response(NDJSON_OK, { status: 200 }) } })
  const llm = { run: async () => ({ content: JSON.stringify({ vector: { happy: 0.9, calm: 0.2 }, reason: '测试判定' }) }) }
  const svc = new TtsService({
    enable: true, provider: 'doubao',
    doubao: { apiKey: 'k', speaker: 'spk_20', resourceId: 'seed-tts-2.0', format: 'wav', sampleRate: 24000 },
  }, { dataDir, logger: () => {}, llm, fetchImpl, ffmpegRunner: fakeRunner })
  const r = await svc.synthesize({ text: '今天真开心！' })
  ok(r.ok, `合成成功：${r.error || ''}`)
  ok(fs.existsSync(r.file), '输出文件已写入')
  const body = JSON.parse(calls[0].init.body)
  ok(/开心/.test(JSON.parse(body.req_params.additions).context_texts[0]), 'LLM 向量 → 自然语言语音指令')
  eq(body.req_params.audio_params.emotion, undefined, '2.0 不发 emotion 标签')
  eq(r.vector.happy, 0.9, '返回向量透出')
})

await test('TtsService：豆包 1.0 + autoEmotion 关 = 固定情感标签，不调 LLM', async () => {
  const calls = []
  let llmCalls = 0
  const fetchImpl = mkFetch({ 'unidirectional': async (url, init) => { calls.push(init); return new Response(NDJSON_OK, { status: 200 }) } })
  const llm = { run: async () => { llmCalls++; return { content: '{}' } } }
  const svc = new TtsService({
    enable: true, provider: 'doubao',
    doubao: { apiKey: 'k', speaker: 'spk_10', resourceId: 'seed-tts-1.0', autoEmotion: false, emotion: 'sad', format: 'wav', sampleRate: 24000 },
  }, { dataDir, logger: () => {}, llm, fetchImpl, ffmpegRunner: fakeRunner })
  const r = await svc.synthesize({ text: '不太开心。' })
  ok(r.ok, '合成成功')
  eq(llmCalls, 0, '关闭自动判定后不调用 LLM')
  eq(JSON.parse(calls[0].body).req_params.audio_params.emotion, 'sad', '固定标签下发')
})

await test('TtsService：MiniMax LLM 判定 → 标签；max 档分段逐段情绪 + 拼接', async () => {
  const calls = []
  const fetchImpl = mkFetch({
    't2a_v2': async (url, init) => {
      calls.push(JSON.parse(init.body))
      return jsonRes({ data: { audio: Buffer.from('SEG').toString('hex') }, base_resp: { status_code: 0 } })
    },
  })
  const llmPro = { run: async () => ({ content: JSON.stringify({ vector: { melancholic: 0.8 }, reason: '低落' }) }) }
  const svc = new TtsService({
    enable: true, provider: 'minimax',
    minimax: { apiKey: 'k', voiceId: 'v1', model: 'speech-2.6-hd', format: 'wav', sampleRate: 32000 },
  }, { dataDir, logger: () => {}, llm: llmPro, fetchImpl, ffmpegRunner: fakeRunner })
  const r1 = await svc.synthesize({ text: '有点失落。' })
  ok(r1.ok, 'pro 合成成功')
  eq(calls[0].voice_setting.emotion, 'sad', '忧郁 → MiniMax sad')

  const segPlan = { vector: { calm: 0.5 }, segments: [{ text: '第一句。', vector: { happy: 0.9 } }, { text: '第二句。', vector: { angry: 0.8 } }], reason: '两段' }
  const llmMax = { run: async () => ({ content: JSON.stringify(segPlan) }) }
  const svcMax = new TtsService({
    enable: true, provider: 'minimax',
    minimax: { apiKey: 'k', voiceId: 'v1', tier: 'max', format: 'wav', sampleRate: 32000 },
  }, { dataDir, logger: () => {}, llm: llmMax, fetchImpl, ffmpegRunner: fakeRunner })
  const r2 = await svcMax.synthesize({ text: '第一句。第二句。' })
  ok(r2.ok, `max 合成成功：${r2.error || ''}`)
  eq(r2.tier, 'max', '档位 max')
  eq(r2.segments.length, 2, '两段返回')
  eq(calls[1].voice_setting.emotion, 'happy', '第一句情绪')
  eq(calls[2].voice_setting.emotion, 'angry', '第二句情绪')
})

await test('TtsService：MiMo = LLM 情绪 → 风格指令；固定 style 优先', async () => {
  const calls = []
  const fetchImpl = mkFetch({
    'chat/completions': async (url, init) => {
      calls.push(JSON.parse(init.body))
      return jsonRes({ choices: [{ message: { audio: { data: Buffer.from('M').toString('base64') } } }] })
    },
  })
  const llm = { run: async () => ({ content: JSON.stringify({ vector: { surprised: 0.9 } }) }) }
  const svc = new TtsService({
    enable: true, provider: 'mimo',
    mimo: { apiKey: 'k', voice: 'Mia', format: 'wav' },
  }, { dataDir, logger: () => {}, llm, fetchImpl, ffmpegRunner: fakeRunner })
  const r = await svc.synthesize({ text: '真的吗？' })
  ok(r.ok, '合成成功')
  eq(calls[0].messages[0].role, 'user', '风格指令消息')
  ok(/惊讶/.test(calls[0].messages[0].content), `LLM 情绪 → 风格指令：${calls[0].messages[0].content}`)
  eq(calls[0].audio.voice, 'Mia', '配置音色')

  const fixed = new TtsService({
    enable: true, provider: 'mimo',
    mimo: { apiKey: 'k', autoEmotion: true, style: '用极快的语速说', format: 'wav' },
  }, { dataDir, logger: () => {}, llm, fetchImpl, ffmpegRunner: fakeRunner })
  await fixed.synthesize({ text: 'x' })
  eq(calls[1].messages[0].content, '用极快的语速说', '固定 style 优先于 LLM 生成')
})

/* ─────────────────────── 5b. MiMo 情绪控制补全：LLM 风格指令 + 音频标签 ─────────────────────── */
await test('parsePlan：style/tag/tagged 清洗与原文保真校验', () => {
  const plan = parsePlan(JSON.stringify({
    vector: { happy: 0.8 },
    style: '用轻快上扬的语调说，语速稍快\n换行会被压平',
    tag: '（开心）',
    tagged: '(开心)太好了[笑]，终于成了！',
  }), { tier: 'pro', text: '太好了，终于成了！' })
  eq(plan.style, '用轻快上扬的语调说，语速稍快 换行会被压平', 'style 清洗换行')
  eq(plan.tag, '开心', 'tag 去括号')
  eq(plan.tagged, '(开心)太好了[笑]，终于成了！', '忠实 tagged 保留')
  const bad = parsePlan(JSON.stringify({ vector: { happy: 0.8 }, tagged: '太棒了[笑]，终于成了！' }), { tier: 'pro', text: '太好了，终于成了！' })
  eq(bad.tagged, undefined, '改写原文的 tagged 丢弃')
  const noTag = parsePlan(JSON.stringify({ vector: { calm: 0.6 }, tagged: '太好了，终于成了！' }), { tier: 'pro', text: '太好了，终于成了！' })
  eq(noTag.tagged, undefined, '没插标签的 tagged 丢弃')
  const max = parsePlan(JSON.stringify({
    vector: { calm: 0.5 },
    segments: [
      { text: '第一句。', vector: { happy: 0.9 }, style: '轻快上扬', tag: '开心', tagged: '第一句[笑]。' },
      { text: '第二句。', vector: { sad: 0.8 }, tagged: '第二句。[叹气]' },
      { text: '第三句。', vector: { sad: 0.7 }, tagged: '第三句。[叹气]吧' },
    ],
  }), { tier: 'max', text: '第一句。第二句。第三句。' })
  eq(max.segments.length, 3, 'max 三段')
  eq(max.segments[0].style, '轻快上扬', '段级 style 保留')
  eq(max.segments[0].tagged, '第一句[笑]。', '段级 tagged 保留')
  eq(max.segments[1].tagged, '第二句。[叹气]', '句尾标签也算忠实')
  eq(max.segments[2].tagged, undefined, '段级不忠实 tagged 丢弃')
  ok(stripAudioTags('(开心)太好了[笑]，终于成了！') === '太好了，终于成了！', 'stripAudioTags 去句首与行内标签')
  ok(isFaithfulTagged('太好了[笑]，终于成了！', '太好了，终于成了！'), '保真判定通过')
  ok(!isFaithfulTagged('太棒了[笑]，终于成了！', '太好了，终于成了！'), '改写判定失败')
  const prompt = buildEmotionSystemPrompt()
  ok(prompt.includes('风格指令 style') && prompt.includes('音频标签'), '判定提示词含 style/标签契约')
  ok(prompt.includes('逐字保留原文'), '提示词明确保真约束')
})

await test('TtsService：MiMo LLM 风格指令 + 标签（保真）/tagMode 开关', async () => {
  const calls = []
  const fetchImpl = mkFetch({
    'chat/completions': async (url, init) => {
      calls.push(JSON.parse(init.body))
      return jsonRes({ choices: [{ message: { audio: { data: Buffer.from('M').toString('base64') } } }] })
    },
  })
  const llm = { run: async () => ({ content: JSON.stringify({ vector: { happy: 0.9 }, style: '用压抑的狂喜说，语速偏快', tag: '兴奋', tagged: '太好了[笑]，终于成了！' }) }) }
  const mk = (mimo) => new TtsService({ enable: true, provider: 'mimo', mimo: { apiKey: 'k', voice: '冰糖', format: 'wav', ...mimo } },
    { dataDir, logger: () => {}, llm, fetchImpl, ffmpegRunner: fakeRunner })
  const r = await mk({}).synthesize({ text: '太好了，终于成了！' })
  ok(r.ok, '合成成功')
  eq(calls[0].messages[0].content, '用压抑的狂喜说，语速偏快', 'user = LLM 风格指令（复合情绪）')
  eq(calls[0].messages[1].content, '(兴奋)太好了[笑]，终于成了！', 'assistant = 句首(风格) + 行内标签')

  await mk({ tagMode: 'style' }).synthesize({ text: '太好了，终于成了！' })
  eq(calls[1].messages[1].content, '(兴奋)太好了，终于成了！', 'tagMode=style 只加句首标签')
  await mk({ tagMode: 'off' }).synthesize({ text: '太好了，终于成了！' })
  eq(calls[2].messages[1].content, '太好了，终于成了！', 'tagMode=off 不加标签')
  eq(calls[2].messages[0].content, '用压抑的狂喜说，语速偏快', 'off 仍使用 LLM 风格指令')

  const llmBad = { run: async () => ({ content: JSON.stringify({ vector: { happy: 0.9 }, tag: '开心', tagged: '太棒了[笑]，成了！' }) }) }
  const svcBad = new TtsService({ enable: true, provider: 'mimo', mimo: { apiKey: 'k', format: 'wav' } },
    { dataDir, logger: () => {}, llm: llmBad, fetchImpl, ffmpegRunner: fakeRunner })
  await svcBad.synthesize({ text: '太好了，终于成了！' })
  eq(calls[3].messages[1].content, '(开心)太好了，终于成了！', '改写原文的 tagged 被丢弃（只保留句首标签）')
})

await test('TtsService：豆包 2.0 语音指令优先用 LLM style（无 style 时回退向量模板）', async () => {
  const calls = []
  const fetchImpl = mkFetch({ 'unidirectional': async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(NDJSON_OK, { status: 200 }) } })
  const llm = { run: async () => ({ content: JSON.stringify({ vector: { sad: 0.9 }, style: '用特别痛心的语气说' }) }) }
  const svc = new TtsService({ enable: true, provider: 'doubao', doubao: { apiKey: 'k', speaker: 's20', resourceId: 'seed-tts-2.0', format: 'wav', sampleRate: 24000 } },
    { dataDir, logger: () => {}, llm, fetchImpl, ffmpegRunner: fakeRunner })
  await svc.synthesize({ text: '他走了。' })
  eq(JSON.parse(calls[0].req_params.additions).context_texts[0], '用特别痛心的语气说', 'LLM style → context_texts')
  const llmVecOnly = { run: async () => ({ content: JSON.stringify({ vector: { sad: 0.9 } }) }) }
  const svc2 = new TtsService({ enable: true, provider: 'doubao', doubao: { apiKey: 'k', speaker: 's20', resourceId: 'seed-tts-2.0', format: 'wav', sampleRate: 24000 } },
    { dataDir, logger: () => {}, llm: llmVecOnly, fetchImpl, ffmpegRunner: fakeRunner })
  await svc2.synthesize({ text: '他走了。' })
  ok(/难过低落/.test(JSON.parse(calls[1].req_params.additions).context_texts[0]), '无 style 回退向量模板')
})

await test('TtsService：情绪判定慢超时 → 一个 slice 内回退（不重试）+ 日志如实标注', async () => {
  const logs = []
  let judgeCalls = 0
  const llm = { run: () => { judgeCalls++; return new Promise(() => {}) } } // 永不返回：只能被超时中止
  const fetchImpl = mkFetch({
    'chat/completions': async () => jsonRes({ choices: [{ message: { audio: { data: Buffer.from('M').toString('base64') } } }] }),
  })
  const svc = new TtsService({ enable: true, provider: 'mimo', judgeTimeoutMs: 1000, mimo: { apiKey: 'k', format: 'wav' } },
    { dataDir, logger: (l, ...a) => logs.push([l, a.join(' ')]), llm, fetchImpl, ffmpegRunner: fakeRunner })
  const t0 = Date.now()
  const r = await svc.synthesize({ text: '你好呀' })
  const ms = Date.now() - t0
  ok(r.ok, '合成照常成功（回退默认情绪）')
  ok(ms < 2000, `一个 slice 内回退（${ms}ms；此前会等满两个 slice 才回退）`)
  eq(judgeCalls, 1, '慢超时不重试')
  ok(logs.some(([l, m]) => l === 'info' && m.includes('自动判定失败→回退默认')), '日志如实标注"自动判定失败→回退默认"（不再误报固定/关闭）')
  ok(r.notes?.some((n) => /回退/.test(n)), 'notes 告知回退')
})

await test('TtsService：max 档单段字数/段间静音按配置生效（与 IndexTTS 同口径）', async () => {
  const calls = []
  const runnerArgs = []
  const fetchImpl = mkFetch({
    'chat/completions': async (url, init) => {
      calls.push(JSON.parse(init.body))
      return jsonRes({ choices: [{ message: { audio: { data: Buffer.from('S').toString('base64') } } }] })
    },
  })
  const runner = (args) => {
    runnerArgs.push(args)
    const out = args[args.length - 1]
    if (out && out !== '-') { try { fs.writeFileSync(out, Buffer.from('X')) } catch { /* noop */ } }
    return Promise.resolve({ ok: true, exitCode: 0, stdout: '', stderr: '' })
  }
  const svc = new TtsService({
    enable: true, provider: 'mimo',
    mimo: { apiKey: 'k', autoEmotion: false, tier: 'max', maxSegmentChars: 20, segmentGapMs: 500, format: 'wav' },
  }, { dataDir, logger: () => {}, llm: null, fetchImpl, ffmpegRunner: runner })
  const text = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥。' // 23 字 → 20 + 3 两段
  const r = await svc.synthesize({ text })
  ok(r.ok, `合成成功：${r.error || ''}`)
  ok(calls.length >= 2, `按 maxSegmentChars=20 拆分（实际 ${calls.length} 段）`)
  ok(calls.every((c) => c.messages[c.messages.length - 1].content.length <= 20), '每段不超单段字数上限')
  ok(runnerArgs.some((a) => a.some((x) => String(x).includes('anullsrc')) && a.includes('0.500')), '段间静音 500ms 生效')
  ok(r.tier === 'max' && r.segments?.length >= 2, '返回档位/分段信息')
})

await test('TtsService：云服务商未配置 → 可读错误，不发请求', async () => {
  let hit = 0
  const svc = new TtsService({ enable: true, provider: 'doubao', doubao: {} }, {
    dataDir, logger: () => {}, llm: null, fetchImpl: async () => { hit++; return new Response('') }, ffmpegRunner: fakeRunner,
  })
  const r = await svc.synthesize({ text: '你好' })
  eq(r.ok, false, '未配置失败')
  ok(/豆包/.test(r.error) && /API Key/.test(r.error), `错误可读：${r.error}`)
  eq(hit, 0, '未配置不产生任何网络请求')
})

/* ─────────────────────── 6. 工具 schema ─────────────────────── */
await test('tts_speak 工具 schema 随服务商切换', () => {
  const ixTool = makeTtsSpeakTool(new TtsService({ enable: true, provider: 'indextts' }, { dataDir, logger: () => {}, fetchImpl: async () => new Response('') }))
  ok(ixTool.parameters.properties.emotionMode && ixTool.parameters.properties.emotionRef, 'IndexTTS：情绪模式参数')
  const dbTool = makeTtsSpeakTool(new TtsService({ enable: true, provider: 'doubao', doubao: { apiKey: 'k', speaker: 's' } }, { dataDir, logger: () => {}, fetchImpl: async () => new Response('') }))
  ok(dbTool.parameters.properties.emotion?.enum?.includes('happy'), '豆包：情感标签枚举')
  ok(!dbTool.parameters.properties.emotionMode, '豆包：无 IndexTTS 专属参数')
  const mmTool = makeTtsSpeakTool(new TtsService({ enable: true, provider: 'minimax', minimax: { apiKey: 'k', voiceId: 'v' } }, { dataDir, logger: () => {}, fetchImpl: async () => new Response('') }))
  ok(mmTool.parameters.properties.emotion?.enum?.includes('whisper'), 'MiniMax：含 whisper 标签')
  const miTool = makeTtsSpeakTool(new TtsService({ enable: true, provider: 'mimo', mimo: { apiKey: 'k' } }, { dataDir, logger: () => {}, fetchImpl: async () => new Response('') }))
  ok(miTool.parameters.properties.style && miTool.parameters.properties.voice, 'MiMo：style + 预置音色')
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* noop */ }
if (failed > 0) process.exitCode = 1
