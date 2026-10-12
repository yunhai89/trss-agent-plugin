/**
 * TTS 模块离线自检 —— 协议客户端 / 参考音频库 / 情绪规划 / 拼接 / 服务编排 / Agent 工具。
 * 全部依赖注入（fetch / llm / ffmpeg / 时钟），不联网、不需要 IndexTTS 服务与 ffmpeg。
 * 运行：node model/tts/test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  IndexTtsClient, clampVector, vectorToObject, fileData, VECTOR_KEYS,
  RefLibrary, normalizeTtsConfig, parseVectorParam, TtsService, makeTtsSpeakTool,
  planEmotion, parsePlan, splitByPunctuation, buildConcatListContent, buildConcatArgs, concatSegments,
} from './index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-test-'))

// ─────────────────────── 1. 向量工具 ───────────────────────
await test('clampVector：范围夹取 + 总和 ≤1.5 等比缩放', () => {
  eq(clampVector({ happy: 0.8, angry: -1, sad: 0.5 }), [0.8, 0, 0.5, 0, 0, 0, 0, 0], '单值夹到 0~1.2')
  eq(clampVector({ happy: 0.8, angry: -1, sad: 99 })[2], 0.9, '超限时总和缩放（1.2+0.8=2.0 → 按比例缩放）')
  const scaled = clampVector([0.8, 0.8, 0.8, 0, 0, 0, 0, 0])
  const sum = scaled.reduce((a, b) => a + b, 0)
  ok(Math.abs(sum - 1.5) < 0.01, `总和缩放到 1.5（实际 ${sum.toFixed(2)}）`)
  ok(scaled[0] > scaled[2] || scaled[0] === scaled[2], '等比缩放保持相对强弱')
  eq(vectorToObject([1, 0, 0, 0, 0, 0, 0, 0]).happy, 1, 'vectorToObject 键序正确')
  eq(VECTOR_KEYS.length, 8, '8 维键')
  eq(fileData('/tmp/x.wav'), { path: '/tmp/x.wav', meta: { _type: 'gradio.FileData' } }, 'fileData 结构含 meta')
})

await test('parseVectorParam：空/全 0 视为未指定；对象/数组归一', () => {
  eq(parseVectorParam(null), null, 'null → null')
  eq(parseVectorParam([]), null, '空数组 → null')
  eq(parseVectorParam({ happy: 0 }), null, '全 0 → null')
  eq(parseVectorParam({ happy: 0.7 }), [0.7, 0, 0, 0, 0, 0, 0, 0], '对象 → 8 维数组')
})

// ─────────────────────── 2. 参考音频库 ───────────────────────
await test('RefLibrary：命名/查重/列表/删除 + 文件落盘', async () => {
  const lib = new RefLibrary({ dir: path.join(tmp, 'lib1') })
  const buf = Buffer.from('RIFFfake')
  const a = await lib.add({ name: ' 芙宁娜 ', kind: 'voice', filename: 'a.wav', buffer: buf })
  eq(a.name, '芙宁娜', '名称去空白')
  ok(fs.existsSync(lib.filePath(a)), '音频文件已写盘')
  const b = await lib.add({ name: '悲伤示例', kind: 'emotion', filename: 'b.mp3', buffer: buf })
  eq(lib.list('voice').length, 1, '按 kind 过滤')
  eq(lib.getByName('芙宁娜').id, a.id, '按名字查找')
  await lib.remove(b.id)
  eq(lib.list().length, 1, '删除后仅剩 1 条')
  ok(!fs.existsSync(path.join(lib.filesDir, `${b.id}.mp3`)), '文件随条目删除')

  let dupErr = ''
  try { await lib.add({ name: '芙宁娜', kind: 'voice', filename: 'c.wav', buffer: buf }) } catch (e) { dupErr = e.message }
  ok(/已存在/.test(dupErr), '重名拒绝（模型按名引用不能歧义）')

  let extErr = ''
  try { await lib.add({ name: 'x', kind: 'voice', filename: 'evil.js', buffer: buf }) } catch (e) { extErr = e.message }
  ok(/不支持的音频格式/.test(extErr), '非音频扩展名拒绝')

  let nameErr = ''
  try { await lib.add({ name: 'a/b', kind: 'voice', filename: 'a.wav', buffer: buf }) } catch (e) { nameErr = e.message }
  ok(/名称非法/.test(nameErr), '含 / 的名称拒绝')
})

// ─────────────────────── 3. IndexTTS 协议客户端 ───────────────────────
function jsonResponse(x, status = 200) {
  return new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 模拟 Gradio 5.45：/config 解析 + 上传 + join + SSE + 下载。
 *  /config 结构对齐真实服务（2026-10 实测）：依赖 id ≠ 数组下标、情绪组件 type=radio、
 *  choices 为 [label, value] 元组（取 value，界面语言无关）、另有 4 项干扰组件。
 *  noRadio=true 时去掉 radio 组件，用于验证回退英文默认。 */
function fakeGradio({ fail = false, noRadio = false } = {}) {
  const calls = { uploads: 0, joins: [], downloads: 0, sseOpened: 0 }
  const fetchImpl = async (url, opt = {}) => {
    const u = String(url)
    if (u.endsWith('/config')) {
      return jsonResponse({
        dependencies: [
          { id: 2, api_name: null },
          { id: 7, api_name: 'on_experimental_change' },
          { id: 9, api_name: 'gen_single' }, // id=9 而数组下标=2：必须按 id 解析
        ],
        components: [
          { id: 1, type: 'checkboxgroup', props: { choices: ['a', 'b', 'c', 'd'] } }, // 干扰：4 项但非 radio
          ...(noRadio ? [] : [{
            id: 28,
            type: 'radio',
            props: {
              value: '沿用音色参考情绪',
              choices: [
                ['高兴/沿用', '沿用音色参考情绪'],
                ['情绪参考', '使用情绪参考音频'],
                ['向量', '使用情绪向量'],
                ['文本', '使用文本描述'],
              ],
            },
          }]),
        ],
      })
    }
    if (u.endsWith('/gradio_api/upload')) { calls.uploads++; return jsonResponse([{ path: '/tmp/gradio/abc/ref.wav' }]) }
    if (u.endsWith('/gradio_api/queue/join')) {
      const body = JSON.parse(opt.body)
      calls.joins.push(body)
      return jsonResponse({ event_id: 'ev' + calls.joins.length })
    }
    if (u.includes('/gradio_api/queue/data')) {
      calls.sseOpened++
      const eventId = 'ev' + calls.joins.length
      const payload = fail
        ? { msg: 'process_completed', event_id: eventId, success: false, output: { error: 'Value: 模型炸了' } }
        : { msg: 'process_completed', event_id: eventId, success: true, output: { data: [{ value: { path: '/tmp/gradio/abc/out.wav', url: `${u.split('/gradio_api')[0]}/gradio_api/file=/tmp/gradio/abc/out.wav` } }] } }
      return new Response(`data: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (u.includes('/gradio_api/file=')) { calls.downloads++; return new Response(Buffer.from('RIFFwavbytes'), { status: 200 }) }
    if (u === 'http://127.0.0.1:1/config') throw new Error('connect ECONNREFUSED')
    throw new Error('unexpected url ' + u)
  }
  return { fetchImpl, calls }
}

await test('IndexTtsClient：动态解析 fn_index/情绪选项 + 完整合成链路', async () => {
  const { fetchImpl, calls } = fakeGradio()
  const client = new IndexTtsClient({ endpoint: 'http://127.0.0.1:7860/', fetchImpl })
  const info = await client.configInfo()
  eq(info.fnIndex, 9, 'fn_index 按依赖 id 解析（非数组下标）')
  eq(info.emoMethods.same, '沿用音色参考情绪', 'radio 元组 choices 取 value（界面语言无关）')
  eq(info.emoMethods.vector, '使用情绪向量', '情绪选项文案按索引解析')
  ok(client.endpoint === 'http://127.0.0.1:7860', 'endpoint 去尾部斜杠')

  const refPath = await client.upload(Buffer.from('RIFF'), 'ref.wav')
  eq(refPath, '/tmp/gradio/abc/ref.wav', '上传返回服务端路径')

  const r = await client.synthesize({
    text: '你好', lang: 'ZH', refRemotePath: refPath,
    mode: 'vector', vector: { happy: 0.6 },
  })
  eq(r.buffer.toString(), 'RIFFwavbytes', '下载结果 buffer')
  const join = calls.joins[0]
  eq(join.fn_index, 9, 'join 用解析出的 fn_index')
  eq(join.data[0], '使用情绪向量', 'data[0] 情绪模式字符串（服务端语言文案）')
  // 同模式 same 也应使用解析出的文案
  await client.synthesize({ text: '嗯', refRemotePath: refPath, mode: 'same' })
  eq(calls.joins[1].data[0], '沿用音色参考情绪', 'same 模式同样用解析文案')
  eq(join.data[1], fileData(refPath), 'data[1] 文件结构含 meta')
  eq(join.data[2], '你好', 'data[2] 文本')
  eq(join.data[6], 0.6, 'data[6] 高兴分量')
  eq(join.data.length, 26, '参数数组 26 项')
  ok(join.session_hash && join.batched === false, '会话与 batched 字段')
  eq(calls.uploads, 1, '上传一次')
})

await test('IndexTtsClient：合成失败（process_completed success=false）如实报错', async () => {
  const { fetchImpl } = fakeGradio({ fail: true })
  const client = new IndexTtsClient({ endpoint: 'http://127.0.0.1:7860', fetchImpl })
  let err = ''
  try { await client.synthesize({ text: 'x', refRemotePath: '/tmp/a.wav', mode: 'same' }) } catch (e) { err = e.message }
  ok(/合成失败/.test(err) && /模型炸了/.test(err), `错误信息透传（实际 ${err}）`)
})

await test('IndexTtsClient：/config 无 radio 组件 → 回退英文默认（不抛）', async () => {
  const { fetchImpl } = fakeGradio({ noRadio: true })
  const warns = []
  const client = new IndexTtsClient({ endpoint: 'http://127.0.0.1:7860', fetchImpl, logger: (l, m) => { if (l === 'warn') warns.push(m) } })
  const info = await client.configInfo()
  eq(info.emoMethods.same, 'Same as the voice reference', '回退英文默认文案')
  ok(warns.some((w) => /回退英文默认/.test(w)), '有回退告警日志（不静默）')
})

await test('IndexTtsClient：check 失败（地址不可达）返回 ok:false 不抛', async () => {
  const client = new IndexTtsClient({ endpoint: 'http://127.0.0.1:1', fetchImpl: globalThis.fetch })
  const r = await client.check()
  eq(r.ok, false, 'check 返回 ok:false')
  ok(/配置获取失败|ECONNREFUSED|fetch failed/.test(r.error || ''), '带可读错误')
})

// ─────────────────────── 4. 情绪规划 ───────────────────────
await test('planEmotion：pro 解析（容忍围栏）+ 非法输出回退 null', async () => {
  const llm = { run: async () => ({ content: '```json\n{"vector":{"happy":0.9,"calm":0.2},"reason":"夸奖"}\n```' }) }
  const plan = await planEmotion(llm, { text: '你真棒！', tier: 'pro' })
  eq(plan.vector.happy, 0.9, '解析出向量')
  eq(plan.reason, '夸奖', '带 reason')

  const bad = await planEmotion({ run: async () => ({ content: '我不会' }) }, { text: 'x', tier: 'pro' })
  eq(bad, null, '非 JSON → null（调用方回退）')

  const thrown = await planEmotion({ run: async () => { throw new Error('boom') } }, { text: 'x', tier: 'pro' })
  eq(thrown, null, 'LLM 抛错 → null')
})

await test('planEmotion：max 分段忠实性校验（改写台词 → 拒绝）', () => {
  const good = parsePlan(JSON.stringify({ vector: { calm: 0.6 }, segments: [{ text: '今天天气不错。', vector: { calm: 0.7 } }, { text: '我们出去玩吧！', vector: { happy: 0.8 } }] }), { tier: 'max', text: '今天天气不错。我们出去玩吧！' })
  ok(good?.segments?.length === 2, '忠实分段通过')
  const rewritten = parsePlan(JSON.stringify({ segments: [{ text: '今天天气真好。', vector: { calm: 0.7 } }] }), { tier: 'max', text: '今天天气不错。我们出去玩吧！' })
  eq(rewritten, null, 'LLM 改写台词 → 拒绝')
  const tooMany = parsePlan(JSON.stringify({ segments: Array.from({ length: 13 }, (_, i) => ({ text: `第${i}段`, vector: { calm: 0.5 } })) }), { tier: 'max', text: '第0段第1段第2段第3段第4段第5段第6段第7段第8段第9段第10段第11段第12段' })
  eq(tooMany, null, '超过段数上限 → 拒绝')
})

await test('splitByPunctuation：按标点切分 + 超长强切（确定性回退）', () => {
  const segs = splitByPunctuation('今天真好。但是明天要下雨！你带伞了吗？', 8)
  ok(segs.length >= 3, `短上限切出多段（${segs.length}）`)
  ok(segs.every((s) => s.length <= 8), '每段不超上限')
  eq(splitByPunctuation('短句。').length, 1, '单句一段')
})

// ─────────────────────── 5. 拼接 ───────────────────────
await test('concatSegments：静音插入顺序 + 单段短路 + runner 注入', async () => {
  const dir = path.join(tmp, 'concat')
  fs.mkdirSync(dir, { recursive: true })
  const a = path.join(dir, 'a.wav'); const b = path.join(dir, 'b.wav')
  fs.writeFileSync(a, 'a'); fs.writeFileSync(b, 'b')
  const seen = []
  let listContent = ''
  const runner = async (args, opts) => {
    seen.push({ args, opts })
    const out = args[args.length - 1]
    if (args.includes('concat')) {
      try { listContent = fs.readFileSync(args[args.indexOf('-i') + 1], 'utf8') } catch { /* 见断言 */ }
    }
    fs.writeFileSync(out, 'out')
    return { ok: true, exitCode: 0, stderr: '' }
  }
  const out1 = path.join(dir, 'merged.mp3')
  const r = await concatSegments([a, b], out1, { gapMs: 300, tempDir: dir, runner })
  ok(r.ok, '拼接成功')
  const concatCall = seen.find((x) => x.args.includes('concat'))
  ok(concatCall, '调用了 concat demuxer')
  ok(seen.some((x) => x.args.some((v) => String(v).includes('anullsrc'))), '生成了段间静音')
  eq(listContent.trim().split('\n').length, 3, '两段音频之间插一个静音（共 3 项）')
  ok(listContent.includes(`file '${a}'`) && listContent.includes(`file '${b}'`), '列表含两段文件')
  const single = await concatSegments([a], path.join(dir, 'x.mp3'), { runner })
  eq(single.single, true, '单段短路不跑 ffmpeg')
  eq(buildConcatListContent(["it's.wav"]).trim(), `file 'it'\\''s.wav'`, '单引号路径转义')
  ok(buildConcatArgs('l.txt', 'o.mp3').includes('-safe'), 'concat 带 -safe 0')
})

// ─────────────────────── 6. 服务编排 ───────────────────────
function makeService({ cfg = {}, llm = null, ffmpegRunner } = {}) {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'svc-'))
  const { fetchImpl, calls } = fakeGradio()
  // 服务层测试统一带上假端点（协议细节已由 IndexTtsClient 测试覆盖）
  const merged = { ...cfg, indextts: { endpoint: 'http://fake-indextts:7860', ...(cfg.indextts || {}) } }
  const svc = new TtsService(merged, { dataDir, llm, fetchImpl, ffmpegRunner })
  return { svc, calls, dataDir }
}
const REF = Buffer.from('RIFFvoice')

await test('TtsService：pro + 显式向量（单次合成、结果落盘、模式/向量透传）', async () => {
  const { svc, calls } = makeService()
  await svc.refs.add({ name: '芙宁娜', kind: 'voice', filename: 'v.wav', buffer: REF })
  const r = await svc.synthesize({ text: '你好呀', voice: '芙宁娜', emotionMode: 'vector', vector: { happy: 0.7 }, tier: 'pro' })
  ok(r.ok, `合成成功（${r.error || ''}）`)
  eq(r.tier, 'pro', '档位 pro')
  eq(r.voice, '芙宁娜', '音色名回传')
  ok(fs.existsSync(r.file) && r.file.endsWith('.wav'), '产物 wav 落盘')
  eq(calls.joins.length, 1, '一次合成调用')
  eq(calls.joins[0].data[0], '使用情绪向量', '模式字符串')
  eq(calls.joins[0].data[6], 0.7, '向量透传')
  eq(r.vector.happy, 0.7, '结果回传向量')
})

await test('TtsService：pro + LLM 自动调节（结合上下文；无显式向量）', async () => {
  let seenPrompt = ''
  const llm = { run: async (p) => { seenPrompt = p; return { content: '{"vector":{"sad":0.8},"reason":"安慰"}' } } }
  const { svc, calls } = makeService({ llm })
  await svc.refs.add({ name: '芙宁娜', kind: 'voice', filename: 'v.wav', buffer: REF })
  const r = await svc.synthesize({
    text: '别难过了，我在。', voice: '芙宁娜', emotionMode: 'vector',
    context: { messages: [{ role: 'user', content: '我今天很难过' }, { role: 'assistant', content: '怎么啦' }] },
  })
  ok(r.ok, '合成成功')
  eq(r.vector.sad, 0.8, 'LLM 判定向量生效')
  eq(r.reason, '安慰', 'reason 回传')
  ok(seenPrompt.includes('我今天很难过'), '提示词带上了近期对话上下文')
  eq(calls.joins[0].data[8], 0.8, 'data[8] 悲伤分量')
})

await test('TtsService：LLM 不可用时回退配置默认向量', async () => {
  const { svc, calls } = makeService({ cfg: { indextts: { vector: [0.1, 0, 0, 0, 0, 0, 0, 0.4] } } })
  await svc.refs.add({ name: '甲', kind: 'voice', filename: 'v.wav', buffer: REF })
  const r = await svc.synthesize({ text: '嗯。', voice: '甲', emotionMode: 'vector' })
  ok(r.ok, '兜底合成成功')
  eq(r.vector.calm, 0.4, '配置默认向量生效')
  eq(calls.joins[0].data[13], 0.4, 'data[13] 平静分量')
})

await test('TtsService：audio 模式缺情绪参考 → 明确报错含可用清单', async () => {
  const { svc } = makeService()
  await svc.refs.add({ name: '芙宁娜', kind: 'voice', filename: 'v.wav', buffer: REF })
  const bad = await svc.synthesize({ text: 'x', voice: '芙宁娜', emotionMode: 'audio' })
  ok(!bad.ok && /情绪参考/.test(bad.error), `缺情绪参考报错（${bad.error}）`)
  await svc.refs.add({ name: '悲伤范例', kind: 'emotion', filename: 'e.wav', buffer: REF })
  const r = await svc.synthesize({ text: 'x', voice: '芙宁娜', emotionMode: 'audio' })
  ok(r.ok, '上传后可合成')
})

await test('TtsService：max 档（LLM 分段逐段合成 → ffmpeg 合并为 mp3）', async () => {
  const llm = {
    run: async (p) => ({
      content: JSON.stringify({
        vector: { calm: 0.5 },
        segments: [
          { text: '很久很久以前。', vector: { calm: 0.7 } },
          { text: '突然，天亮了！', vector: { surprised: 0.9 } },
        ],
        reason: '叙事转折',
      }),
    }),
  }
  const ffmpegRunner = async (args) => {
    const out = args[args.length - 1]
    fs.writeFileSync(out, 'merged')
    return { ok: true, exitCode: 0, stderr: '' }
  }
  const { svc, calls, dataDir } = makeService({ llm, ffmpegRunner })
  await svc.refs.add({ name: '说书人', kind: 'voice', filename: 'v.wav', buffer: REF })
  const r = await svc.synthesize({ text: '很久很久以前。突然，天亮了！', voice: '说书人', emotionMode: 'vector', tier: 'max' })
  ok(r.ok, `max 合成成功（${r.error || ''}）`)
  eq(r.tier, 'max', '档位 max')
  eq(r.segments.length, 2, '两段')
  eq(r.segments[1].vector.surprised, 0.9, '第二段情绪透传')
  ok(r.file.endsWith('.mp3') && fs.existsSync(r.file), '合并产物 mp3 落盘')
  eq(calls.joins.length, 2, '两次合成调用')
  eq(calls.uploads, 1, '音色参考只上传一次（复用服务端路径）')
  ok(!fs.readdirSync(path.join(dataDir, 'tmp')).some((f) => f.startsWith('seg_')), '临时分段已清理')
})

await test('TtsService：max 档 LLM 失败 → 标点分段回退并如实备注', async () => {
  const ffmpegRunner = async (args) => { fs.writeFileSync(args[args.length - 1], 'merged'); return { ok: true } }
  const { svc } = makeService({ cfg: { indextts: { vector: [0.5, 0, 0, 0, 0, 0, 0, 0] } }, llm: { run: async () => ({ content: '无法判断' }) }, ffmpegRunner })
  await svc.refs.add({ name: '甲', kind: 'voice', filename: 'v.wav', buffer: REF })
  const r = await svc.synthesize({ text: '第一句。第二句！', voice: '甲', emotionMode: 'vector', tier: 'max' })
  ok(r.ok, '回退合成成功')
  ok(r.notes.some((n) => /标点/.test(n)), `备注标点回退（${r.notes.join('；')}）`)
})

await test('TtsService：缺音色参考 / 传错音色名 / 超长文本 → 可读错误，不假装成功', async () => {
  const { svc } = makeService()
  const noVoice = await svc.synthesize({ text: '你好' })
  ok(!noVoice.ok && /音色参考/.test(noVoice.error), '缺音色参考报错')
  await svc.refs.add({ name: '甲', kind: 'voice', filename: 'v.wav', buffer: REF })
  const wrong = await svc.synthesize({ text: '你好', voice: '不存在的音色' })
  ok(!wrong.ok && /不存在；可用：甲/.test(wrong.error), `传错音色名 → 列出可用音色（${wrong.error}）`)
  const tooLong = await svc.synthesize({ text: '字'.repeat(5001), voice: '甲' })
  ok(!tooLong.ok && /过长/.test(tooLong.error), '超长文本报错')
})

// ─────────────────────── 7. Agent 工具 ───────────────────────
await test('tts_speak 工具：合成成功 → 发送语音；描述含音色名单与模式说明', async () => {
  const { svc } = makeService()
  await svc.refs.add({ name: '芙宁娜', kind: 'voice', filename: 'v.wav', buffer: REF })
  const tool = makeTtsSpeakTool(svc)
  ok(tool.description.includes('芙宁娜'), '动态列出可用音色')
  ok(tool.description.includes('vector'), '描述含情绪模式说明')
  eq(tool.category, 'message', '消息类工具（发送语音）')

  const sent = []
  globalThis.segment = { record: (f) => ({ type: 'record', data: { file: f } }) }
  const ctx = { e: { reply: async (seg) => { sent.push(seg) } }, executionContext: { messages: [] } }
  const r = await tool.execute({ text: '早安！', voice: '芙宁娜', emotionMode: 'vector', vector: { happy: 0.6 } }, ctx)
  ok(r.ok && r.sent, `工具返回已发送（${JSON.stringify(r)}）`)
  eq(sent.length, 1, '发送了一次语音段')
  eq(sent[0].type, 'record', 'record 语音段')
  delete globalThis.segment
})

await test('tts_speak 工具：服务报错 → 原样返回 error（不编造已发送）', async () => {
  const { svc } = makeService()
  const tool = makeTtsSpeakTool(svc)
  globalThis.segment = { record: (f) => ({ type: 'record', data: { file: f } }) }
  const r = await tool.execute({ text: '你好' }, { e: { reply: async () => {} } })
  ok(!r.ok && /音色参考/.test(r.error), '错误透传')
  delete globalThis.segment
})

// ─────────────────────── 8. 配置归一 ───────────────────────
await test('normalizeTtsConfig：缺省字段回落默认（旧配置安全）', () => {
  const c = normalizeTtsConfig({ indextts: { endpoint: 'http://a:1' } })
  eq(c.enable, true, 'enable 默认开')
  eq(c.provider, 'indextts', 'provider 默认')
  eq(c.indextts.endpoint, 'http://a:1', '覆盖端点保留')
  eq(c.indextts.emotionMode, 'same', '情绪模式默认 same')
  eq(c.indextts.tier, 'pro', '档位默认 pro')
  eq(c.indextts.autoEmotion, true, '自动调节默认开')
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
