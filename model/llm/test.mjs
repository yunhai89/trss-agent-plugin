/**
 * 离线自检 —— LLM 能力探测与 embedding。运行：node model/llm/test.mjs
 * （原 LLM facade / CircuitBreaker / ProviderPool 已删除——生产链路从未接入，
 *   实际容灾 = transport-base 单请求重试 + Agent __tries fallback，见 model/agent/Agent.js。）
 */
import { detectCapabilities } from './capabilities.js'
import { capsFromModelItem, primeModelCaps, getApiCaps, clearApiCaps, learnThinkingCapability, getLearnedThinking, clearLearnedThinking } from './caps-source.js'
import { embed } from './embed.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) {
    passed++
    console.log('  ✓', m)
  } else {
    failed++
    console.error('  ✗ FAIL', m)
  }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)})`}`)
}
async function test(name, fn) {
  console.log(`\n[${name}]`)
  try {
    await fn()
  } catch (e) {
    failed++
    console.error('  ✗ THROW', e?.message || e)
    console.error(e?.stack)
  }
}

// ---------- 1. 能力注册表 ----------
await test('capabilities：分层判定', async () => {
  eq(detectCapabilities({ protocol: 'openai', model: 'gpt-4o' }).vision, true, 'gpt-4o vision')
  eq(detectCapabilities({ protocol: 'openai', model: 'gpt-4o' }).source, 'registry', 'source=registry')
  eq(detectCapabilities({ protocol: 'anthropic', model: 'claude-sonnet-4-5' }).thinking, true, 'claude thinking')
  // GPT-5 系：推理模型（reasoning_effort）；-chat 变体不判 thinking（否则思考自动决策被静默跳过，见 v1.26.41）
  eq(detectCapabilities({ protocol: 'openai', model: 'gpt-5.5' }).thinking, true, 'gpt-5 thinking')
  eq(detectCapabilities({ protocol: 'openai', model: 'gpt-5.6-luna' }).thinking, true, 'gpt-5.6-luna thinking')
  eq(detectCapabilities({ protocol: 'openai', model: 'gpt-5.6-luna' }).vision, true, 'gpt-5.6-luna vision')
  eq(detectCapabilities({ protocol: 'openai', model: 'gpt-5-chat-latest' }).thinking, false, 'gpt-5 -chat 变体不判 thinking')
  eq(detectCapabilities({ protocol: 'openai', model: 'gpt-5-chat-latest' }).tools, true, 'gpt-5 -chat 变体仍走 gpt-5 规则（tools）')
  eq(detectCapabilities({ protocol: 'anthropic', model: 'claude-sonnet-4-5' }).caching, true, 'claude caching')
  eq(detectCapabilities({ protocol: 'openai', model: 'deepseek-reasoner' }).thinking, true, 'deepseek-reasoner thinking')
  eq(detectCapabilities({ protocol: 'openai', model: 'mimo-v2.5-pro' }).thinking, true, 'mimo thinking')
  eq(detectCapabilities({ protocol: 'openai', model: 'mimo-v2.6-pro' }).vision, true, 'mimo-v2.6-pro vision')
  eq(detectCapabilities({ protocol: 'openai', model: 'mimo-v2.6-pro' }).video, true, 'mimo-v2.6-pro video')
  eq(detectCapabilities({ protocol: 'openai', model: 'mimo-v2.6-flash' }).audio, true, 'mimo-v2.6-flash audio')
  eq(detectCapabilities({ protocol: 'openai', model: 'mimo-v2.5-asr' }).tools, false, 'mimo asr 非对话模型 tools=false')
  eq(detectCapabilities({ protocol: 'openai', model: 'qwen-vl-max' }).vision, true, 'qwen-vl vision')
  // 协议默认：未知模型 openai 仍有 tools
  eq(detectCapabilities({ protocol: 'openai', model: 'totally-unknown' }).tools, true, '未知模型 protocol default tools')
  eq(detectCapabilities({ protocol: 'openai', model: 'totally-unknown' }).source, 'default', 'source=default')
  // 思考能力：明写 false 的才算「知道」；泛化家族规则未表态 → 乐观假定 true（thinkingAssumed 标注）
  eq(detectCapabilities({ protocol: 'openai', model: 'gpt-4o' }).thinking, false, 'gpt-4o 明确声明不支持思考')
  eq(detectCapabilities({ protocol: 'openai', model: 'gpt-4o' }).thinkingAssumed, undefined, '明确声明无假定标记')
  eq(detectCapabilities({ protocol: 'openai', model: 'deepseek-v4.1-flash' }).thinking, true, '新型号（泛化规则未表态）→ 乐观 thinking')
  eq(detectCapabilities({ protocol: 'openai', model: 'deepseek-v4.1-flash' }).thinkingAssumed, true, 'thinkingAssumed=true')
  eq(detectCapabilities({ protocol: 'openai', model: 'totally-unknown-2027' }).thinking, true, '完全未知模型 → 乐观 thinking')
  // 配置覆盖最高
  eq(detectCapabilities({ protocol: 'openai', model: 'gpt-4o', caps: { vision: false } }).vision, false, 'config 覆盖 vision=false')
  eq(detectCapabilities({ protocol: 'openai', model: 'gpt-4o', caps: { vision: false } }).source, 'config', 'source=config')
})

// ---------- 1b. 运行时学习：思考能力自动纠正 ----------
await test('caps-source：思考能力学习层（乐观假定 → 厂商拒绝纠正 → 可清除）', async () => {
  clearLearnedThinking()
  eq(getLearnedThinking('learn-model'), undefined, '初始无记录')
  eq(detectCapabilities({ protocol: 'openai', model: 'learn-model' }).thinking, true, '未表态 → 乐观 true')

  learnThinkingCapability('learn-model', false)
  eq(getLearnedThinking('learn-model'), false, '拒绝后记录 false')
  const d = detectCapabilities({ protocol: 'openai', model: 'learn-model' })
  eq(d.thinking, false, '学习层纠正为 false')
  eq(d.source, 'learned', 'source=learned')
  eq(d.thinkingAssumed, undefined, '学习记录不是假定')

  // 学习层高于注册表（厂商真实拒绝 > 名单声明），低于配置覆盖
  learnThinkingCapability('mimo-v2.5-pro', false)
  eq(detectCapabilities({ protocol: 'openai', model: 'mimo-v2.5-pro' }).thinking, false, '学习层覆盖注册表声明')
  eq(detectCapabilities({ protocol: 'openai', model: 'mimo-v2.5-pro', caps: { thinking: true } }).thinking, true, 'config 覆盖 > 学习层')

  // 官方数据（api 层）声明 thinking=true 时不算假定
  clearApiCaps(); clearLearnedThinking()
  const item = { id: 'omni-reasoner', architecture: { input_modalities: ['text'], supported_parameters: ['reasoning'] } }
  const fakeFetch = async () => ({ ok: true, status: 200, async json() { return { data: [item] } } })
  await primeModelCaps({ baseURL: 'https://x/v1', apiKey: 'k', models: ['omni-reasoner'], fetchImpl: fakeFetch })
  eq(detectCapabilities({ protocol: 'openai', model: 'omni-reasoner' }).thinkingAssumed, undefined, 'api 数据声明后无假定')

  clearLearnedThinking(); clearApiCaps()
  eq(detectCapabilities({ protocol: 'openai', model: 'mimo-v2.5-pro' }).thinking, true, '清除学习后回到注册表声明')
  eq(detectCapabilities({ protocol: 'openai', model: 'learn-model' }).thinking, true, '清除学习后回到乐观假定')
})

// ---------- 2. 官方能力数据源 ----------
await test('caps-source：解析 OpenRouter 模态 + prime 后叠加', async () => {
  const item = { id: 'some-omni-model', architecture: { input_modalities: ['text', 'image', 'video', 'audio'], supported_parameters: ['tools', 'reasoning'] } }
  const caps = capsFromModelItem(item)
  eq(caps, { vision: true, audio: true, video: true, tools: true, thinking: true }, 'OpenRouter 模态 → caps')
  eq(capsFromModelItem({ id: 'x', object: 'model' }), null, '无模态字段 → null')
  eq(capsFromModelItem({ id: 'y', capabilities: { vision: true, function_calling: true } }), { vision: true, tools: true }, 'capabilities 对象')

  clearApiCaps()
  const fakeFetch = async () => ({ ok: true, status: 200, async json() { return { data: [item] } } })
  await primeModelCaps({ baseURL: 'https://x/v1', apiKey: 'k', models: ['some-omni-model'], fetchImpl: fakeFetch })
  eq(getApiCaps('some-omni-model').video, true, 'prime 后缓存命中')
  // detectCapabilities 叠加官方层（未知模型本无 vision，来自 api 数据）
  const d = detectCapabilities({ protocol: 'openai', model: 'some-omni-model' })
  eq(d.vision, true, 'api 层 vision')
  eq(d.video, true, 'api 层 video')
  eq(d.source, 'api', 'source=api')
  clearApiCaps()
  eq(getApiCaps('some-omni-model'), null, 'clear 后失效')
})

// ---------- 3. embed ----------
await test('embed：按 index 排序 + 形状保持', async () => {
  const fetcher = async (url, opts) => ({
    ok: true,
    status: 200,
    async json() {
      return { data: [{ index: 1, embedding: [0.2, 0.2] }, { index: 0, embedding: [0.1, 0.1] }] }
    },
  })
  const client = { baseURL: 'https://x/v1', apiKey: 'k', fetcher }
  const vec = await embed('hello', { client, fetcher })
  eq(vec, [0.1, 0.1], '单串 → index0 向量')
  const arr = await embed(['a', 'b'], { client, fetcher })
  eq(arr, [[0.1, 0.1], [0.2, 0.2]], '数组 → 排序后的向量数组')

  // 校验请求体
  let sentBody = null
  const f2 = async (url, opts) => { sentBody = JSON.parse(opts.body); return { ok: true, status: 200, async json() { return { data: [{ index: 0, embedding: [1] }] } } } }
  await embed('x', { client, fetcher: f2, model: 'text-embedding-3-large' })
  eq(sentBody.model, 'text-embedding-3-large', 'model 透传')
  eq(sentBody.input, ['x'], 'input 数组')
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
