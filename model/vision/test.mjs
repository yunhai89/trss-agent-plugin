/**
 * 图片识别离线自检 —— mock provider 驱动 VisionService + describeImages。
 * 运行：node model/vision/test.mjs
 */
import { VisionService, describeImages, DEFAULT_DESCRIBE } from './index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// 捕获 provider.chat 收到的 messages，返回固定描述
function mockProvider(reply, { protocol = 'openai' } = {}) {
  let received = null
  return {
    received: () => received,
    provider: {
      async chat({ messages, model, max_tokens }) {
        received = { messages, model, max_tokens }
        return { content: reply, toolCalls: [], finishReason: 'stop', usage: null }
      },
    },
  }
}

// ---------- 1. recognize：构造多模态请求 ----------
await test('VisionService.recognize：发图+指令 → 返回描述', async () => {
  const m = mockProvider('图中是一只橘猫，桌上有咖啡。')
  const v = new VisionService({ provider: m.provider, model: 'mimo-2.5', protocol: 'openai' })
  const desc = await v.recognize({ buffer: PNG, mime: 'image/png', name: 'cat.png' })
  eq(desc, '图中是一只橘猫，桌上有咖啡。', '返回描述文本')
  const recv = m.received()
  eq(recv.model, 'mimo-2.5', '用视觉 model')
  ok(Array.isArray(recv.messages[0].content), 'OpenAI content 为数组')
  ok(recv.messages[0].content.some((b) => b.type === 'image_url'), '含 image_url 块')
  ok(recv.messages[0].content.some((b) => b.type === 'text' && b.text.includes('描述')), '含描述指令')
})

// ---------- 2. question 注入 ----------
await test('recognize：带 question 时注入用户问题', async () => {
  const m = mockProvider('回答')
  const v = new VisionService({ provider: m.provider, model: 'v', protocol: 'anthropic' })
  await v.recognize({ buffer: PNG, mime: 'image/png' }, { question: '这是什么品牌？' })
  const recv = m.received()
  ok(recv.messages[0].content.some((b) => b.type === 'text' && b.text.includes('这是什么品牌')), '指令含用户问题')
  ok(recv.messages[0].content.some((b) => b.type === 'image'), 'Anthropic image 块')
})

// ---------- 3. 失败降级 ----------
await test('recognize：provider 抛错 → 返回空串（不中断）', async () => {
  const v = new VisionService({
    provider: { async chat() { throw new Error('boom') } },
    model: 'v',
  })
  const desc = await v.recognize({ buffer: PNG, mime: 'image/png' })
  eq(desc, '', '失败返回空串')
  // 无 buffer → 空串
  eq(await v.recognize({}), '', '缺 buffer → 空串')
})

// ---------- 4. 自定义 describePrompt ----------
await test('recognize：自定义 describePrompt 生效', async () => {
  const m = mockProvider('x')
  const v = new VisionService({ provider: m.provider, model: 'v', describePrompt: '只读OCR' })
  await v.recognize({ buffer: PNG, mime: 'image/png' })
  ok(m.received().messages[0].content.some((b) => b.text === '只读OCR'), '自定义指令覆盖默认')
  ok(DEFAULT_DESCRIBE.includes('OCR'), '默认指令含 OCR')
})

// ---------- 5. describeImages：图片 → 文本媒体 ----------
await test('describeImages：图片替换为文本载体，非图片保留', async () => {
  const m = mockProvider('一只猫')
  const v = new VisionService({ provider: m.provider, model: 'v' })
  const media = [
    { name: 'a.png', mime: 'image/png', buffer: PNG, bytes: 8, kind: 'image' },
    { name: 'note.txt', mime: 'text/plain', buffer: Buffer.from('hi'), bytes: 2, kind: 'file' },
  ]
  const out = await describeImages(v, media, '图里有什么')
  eq(out.length, 2, '数量不变')
  eq(out[0].kind, 'file', '图片→file')
  eq(out[0].mime, 'text/plain', 'mime→text/plain')
  ok(out[0].buffer.toString().includes('一只猫'), '含描述')
  ok(out[0].buffer.toString().includes('[图片 a.png]'), '含图片名标注')
  ok(out[0].__visionDescribed, '标记已识别')
  // 非图片原样保留
  eq(out[1].mime, 'text/plain', '非图片 mime 不变')
  eq(out[1].buffer.toString(), 'hi', '非图片内容不变')
})

// ---------- 6. describeImages：识别失败 → 降级标注 ----------
await test('describeImages：识别失败保留标注', async () => {
  const v = new VisionService({ provider: { async chat() { throw new Error('x') } }, model: 'v' })
  const out = await describeImages(v, [{ name: 'b.png', mime: 'image/png', buffer: PNG, kind: 'image' }], '')
  ok(out[0].buffer.toString().includes('识别失败'), '失败标注')
})

// ---------- 7. describeImages：无 vision / 空列表 ----------
await test('describeImages：边界', async () => {
  eq(await describeImages(null, [{ a: 1 }]), [{ a: 1 }], '无 vision 原样返回')
  eq(await describeImages({}, []), [], '空列表')
})

// ---------- 8. 端到端语义：描述能被 buildContent 当文本抽出 ----------
await test('端到端：描述媒体经 buildContent 抽为文本（主模型可见）', async () => {
  const { buildUserContent } = await import('../media/convert.js')
  const m = mockProvider('图表显示 Q1 上升')
  const v = new VisionService({ provider: m.provider, model: 'v' })
  const described = await describeImages(v, [{ name: 'chart.png', mime: 'image/png', buffer: PNG, kind: 'image' }], '趋势？')
  // 主模型不支持视觉：caps.vision=false
  const content = buildUserContent('这是什么趋势', described, { protocol: 'openai', caps: { vision: false } })
  ok(typeof content === 'string', '非视觉 → 字符串')
  ok(content.includes('Q1 上升'), '主模型拿到描述文本')
})

// ---------- 9. 空返回必须告警（旧实现静默返回空串，导致"识图/表情打标无反应"无从排查）----------
await test('VisionService：模型返回空内容时告警（不再静默）', async () => {
  const logs = []
  const v = new VisionService({
    provider: { async chat() { return { content: '' } } },
    model: 'text-only-model',
    logger: (lvl, msg) => logs.push([lvl, msg]),
  })
  eq(await v.recognize({ buffer: PNG, mime: 'image/png', name: 'x.png' }), '', '空返回 → 空串')
  ok(logs.some(([lvl, msg]) => lvl === 'warn' && /返回空/.test(msg)), 'recognize 空返回有 warn')
  eq(await v.analyze({ buffer: PNG, mime: 'image/png', name: 'y.png' }, 'judge'), '', 'analyze 空返回 → 空串')
  ok(logs.filter(([lvl, msg]) => lvl === 'warn' && /返回空/.test(msg)).length >= 2, 'analyze 空返回也告警')
})

// ---------- 10. 只返回思考内容时不能当作结果 ----------
await test('VisionService：只返回 reasoning 占位时不当作结果', async () => {
  const logs = []
  const reasoning = '首先，用户要求我作为一个表情包库的策展器，判断这张图……'
  const v = new VisionService({
    provider: { async chat() { return { content: reasoning, reasoning, finishReason: 'length' } } },
    model: 'mimo-v2.5',
    logger: (lvl, msg) => logs.push([lvl, msg]),
  })
  eq(await v.analyze({ buffer: PNG, mime: 'image/png', name: 'z.png' }, 'judge'), '', '思考占位 → 空串（不当作结果）')
  ok(logs.some(([lvl, msg]) => lvl === 'warn' && /只返回了思考内容/.test(msg)), '有明确 warn 指明原因')
})

// ---------- 11. thinking/temperature 透传（模型列表"禁思考"应对视觉子模型生效）----------
await test('VisionService：thinking/temperature 透传给 provider', async () => {
  let got = null
  const v = new VisionService({
    provider: { async chat(opts) { got = opts; return { content: 'x' } } },
    model: 'mimo-v2.5',
    thinking: { type: 'disabled' },
    temperature: 0.2,
  })
  await v.analyze({ buffer: PNG, mime: 'image/png' }, 'judge')
  eq(got.thinking, { type: 'disabled' }, 'thinking 透传')
  eq(got.temperature, 0.2, 'temperature 透传')
  // 未配置时不下发（避免不支持该字段的端点 400）
  let got2 = null
  const v2 = new VisionService({ provider: { async chat(opts) { got2 = opts; return { content: 'x' } } }, model: 'm' })
  await v2.recognize({ buffer: PNG, mime: 'image/png' })
  ok(!('thinking' in got2) && !('temperature' in got2), '未配置则不下发')
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
