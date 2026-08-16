/**
 * 离线自检 —— LLM 能力探测与 embedding。运行：node model/llm/test.mjs
 * （原 LLM facade / CircuitBreaker / ProviderPool 已删除——生产链路从未接入，
 *   实际容灾 = transport-base 单请求重试 + Agent __tries fallback，见 model/agent/Agent.js。）
 */
import { detectCapabilities } from './capabilities.js'
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
  eq(detectCapabilities({ protocol: 'anthropic', model: 'claude-sonnet-4-5' }).caching, true, 'claude caching')
  eq(detectCapabilities({ protocol: 'openai', model: 'deepseek-reasoner' }).thinking, true, 'deepseek-reasoner thinking')
  eq(detectCapabilities({ protocol: 'openai', model: 'mimo-v2.5-pro' }).thinking, true, 'mimo thinking')
  eq(detectCapabilities({ protocol: 'openai', model: 'qwen-vl-max' }).vision, true, 'qwen-vl vision')
  // 协议默认：未知模型 openai 仍有 tools
  eq(detectCapabilities({ protocol: 'openai', model: 'totally-unknown' }).tools, true, '未知模型 protocol default tools')
  eq(detectCapabilities({ protocol: 'openai', model: 'totally-unknown' }).source, 'default', 'source=default')
  // 配置覆盖最高
  eq(detectCapabilities({ protocol: 'openai', model: 'gpt-4o', caps: { vision: false } }).vision, false, 'config 覆盖 vision=false')
  eq(detectCapabilities({ protocol: 'openai', model: 'gpt-4o', caps: { vision: false } }).source, 'config', 'source=config')
})

// ---------- 2. embed ----------
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
