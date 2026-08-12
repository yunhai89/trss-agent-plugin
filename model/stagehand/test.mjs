/**
 * Stagehand 工具离线自检 —— SessionManager 会话管理 + makeGenerate 回调 + jsonSchemaToZod 转换。
 * 运行：node model/stagehand/test.mjs
 *
 * 不启动真实浏览器：SessionManager 用注入 launcher 返回 fake browser/stagehand；
 * makeGenerate 用 mock fetch；jsonSchemaToZod 需 zod（未装则 skip 该段，其余照跑）。
 */
import { SessionManager } from './session.js'
import { makeGenerate } from './llm.js'
import { jsonSchemaToZod } from './index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// fake launcher：返回带 page 的假 browser + 假 stagehand
let launchCount = 0
function makeFakeLauncher() {
  return async () => {
    launchCount++
    const page = { goto: async () => {}, title: async () => 'Fake Title' }
    const browser = { context: { pages: async () => [page] } }
    const stagehand = { observe: async () => ({ data: ['elem1', 'elem2'] }), extract: async () => ({ data: { a: 1 } }), act: async () => ({ data: { done: true } }), close: async () => {} }
    return { browser, close: async () => {}, stagehand }
  }
}

// ---------- 1. SessionManager：acquire 复用 ----------
await test('SessionManager：同 scope acquire 复用，不重复启动', async () => {
  launchCount = 0
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 60000 }, launcher: makeFakeLauncher() })
  const a1 = await sm.acquire('u1')
  const a2 = await sm.acquire('u1')
  ok(a1.stagehand === a2.stagehand, '同 scope 返回同一 stagehand 实例')
  ok(launchCount === 1, `只启动 1 次（实际 ${launchCount}）`)
  ok(sm.size() === 1, '会话数=1')
  await sm.closeAll()
})

// ---------- 2. SessionManager：不同 scope 各自启动 ----------
await test('SessionManager：不同 scope 各自启动', async () => {
  launchCount = 0
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 60000 }, launcher: makeFakeLauncher() })
  await sm.acquire('u1')
  await sm.acquire('u2')
  ok(launchCount === 2, `两个 scope 启动 2 次（实际 ${launchCount}）`)
  ok(sm.size() === 2, '会话数=2')
  await sm.closeAll()
})

// ---------- 3. SessionManager：get 命中/未命中 ----------
await test('SessionManager：get 命中返回会话，未命中返回 null', async () => {
  launchCount = 0
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 60000 }, launcher: makeFakeLauncher() })
  ok(sm.get('u1') === null, '未 acquire 时 get 返回 null')
  await sm.acquire('u1')
  ok(sm.get('u1') !== null, 'acquire 后 get 返回会话')
  ok(sm.get('u2') === null, '另一 scope get 仍 null')
  await sm.closeAll()
})

// ---------- 4. SessionManager：并发 acquire 同 key 去重 ----------
await test('SessionManager：并发 acquire 同 scope 去重（单次启动）', async () => {
  launchCount = 0
  let resolveLaunch
  // 慢 launcher：让两个并发 acquire 同时在等
  const slowLauncher = () => new Promise((res) => { resolveLaunch = () => res(makeFakeLauncher()()) })
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 60000 }, launcher: slowLauncher })
  const p1 = sm.acquire('u1')
  const p2 = sm.acquire('u1')
  resolveLaunch()
  const [r1, r2] = await Promise.all([p1, p2])
  ok(r1.stagehand === r2.stagehand, '并发 acquire 返回同一实例')
  ok(launchCount === 1, `并发去重只启动 1 次（实际 ${launchCount}）`)
  await sm.closeAll()
})

// ---------- 5. SessionManager：idle 超时自动关 ----------
await test('SessionManager：idle 超时自动关闭会话', async () => {
  launchCount = 0
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 50 }, launcher: makeFakeLauncher() })
  await sm.acquire('u1')
  ok(sm.size() === 1, '启动后会话数=1')
  await sleep(130) // 等 idle 超时触发
  ok(sm.size() === 0, `idle 超时后会话清零（实际 ${sm.size()}）`)
  await sm.closeAll()
})

// ---------- 6. SessionManager：closeAll 全清 ----------
await test('SessionManager：closeAll 关闭全部', async () => {
  launchCount = 0
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 60000 }, launcher: makeFakeLauncher() })
  await sm.acquire('u1')
  await sm.acquire('u2')
  await sm.closeAll()
  ok(sm.size() === 0, 'closeAll 后会话数=0')
})

// ---------- 7. makeGenerate：正常结构化返回 ----------
await test('makeGenerate：构建正确请求 + 解析 structuredContent', async () => {
  let captured
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opt) => {
    captured = { url, body: JSON.parse(opt.body) }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"hi","n":3}' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const gen = makeGenerate({ apiKey: 'sk-x', baseURL: 'https://api.test.com/v1', model: 'test-model' })
    const out = await gen({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'find it' }] }],
      systemPrompt: 'sys',
      temperature: 0.1,
      responseFormat: { type: 'json_schema', name: 'r', schema: { type: 'object', properties: { title: { type: 'string' } } } },
    })
    ok(captured.url === 'https://api.test.com/v1/chat/completions', 'URL 拼接正确')
    ok(captured.body.model === 'test-model', 'body 带 model')
    ok(captured.body.messages[0].role === 'system' && captured.body.messages[0].content === 'sys', 'systemPrompt 置顶')
    ok(captured.body.response_format.type === 'json_schema', 'response_format=json_schema')
    ok(captured.body.response_format.json_schema.name === 'r', 'schema name 透传')
    ok(out.role === 'assistant' && out.outputFormat === 'json_schema', '返回角色/格式正确')
    ok(out.structuredContent.title === 'hi' && out.structuredContent.n === 3, 'structuredContent 解析正确')
  } finally { globalThis.fetch = origFetch }
})

// ---------- 8. makeGenerate：非 JSON 返回 → 抛错 ----------
await test('makeGenerate：LLM 返回非 JSON → 抛错', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  let threw = false
  try {
    const gen = makeGenerate({ apiKey: 'sk', baseURL: 'https://x/v1', model: 'm' })
    await gen({ messages: [], responseFormat: { type: 'json_schema', name: 'r', schema: {} } })
  } catch { threw = true } finally { globalThis.fetch = origFetch }
  ok(threw, '非 JSON 返回抛错')
})

// ---------- 9. makeGenerate：responseFormat 非 json_schema → 抛错 ----------
await test('makeGenerate：responseFormat 非 json_schema → 抛错', async () => {
  const gen = makeGenerate({ apiKey: 'sk', baseURL: 'https://x/v1', model: 'm' })
  let threw = false
  try { await gen({ messages: [], responseFormat: { type: 'text' } }) } catch { threw = true }
  ok(threw, 'text 格式抛错')
})

// ---------- 10. makeGenerate：HTTP 错误 → 抛错 ----------
await test('makeGenerate：HTTP 非 200 → 抛错', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('bad', { status: 500 })
  let threw = false
  try {
    const gen = makeGenerate({ apiKey: 'sk', baseURL: 'https://x/v1', model: 'm' })
    await gen({ messages: [], responseFormat: { type: 'json_schema', name: 'r', schema: {} } })
  } catch { threw = true } finally { globalThis.fetch = origFetch }
  ok(threw, 'HTTP 500 抛错')
})

// ---------- 11. jsonSchemaToZod：转换正确性（需 zod）----------
await test('jsonSchemaToZod：object/array/类型 + required（需 zod，未装则 skip）', async () => {
  let z
  try { z = (await import('zod')).z } catch { console.log('  ⊘ skip（zod 未装）'); return }
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      count: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
      meta: { type: 'object', properties: { a: { type: 'boolean' } } },
      opt: { type: 'string' },
    },
    required: ['title', 'count'],
  }
  const zodSchema = jsonSchemaToZod(z, schema)
  ok(typeof zodSchema?.safeParse === 'function', '产出 zod schema（有 safeParse）')
  // 合法输入通过
  const good = zodSchema.safeParse({ title: 't', count: 1, tags: ['x'], meta: { a: true } })
  ok(good.success === true, '合法输入通过校验')
  // 缺 required → 失败
  const bad = zodSchema.safeParse({ count: 1 })
  ok(bad.success === false, '缺 required 字段被拒')
  // 非 required 缺失 → 通过
  const noOpt = zodSchema.safeParse({ title: 't', count: 1 })
  ok(noOpt.success === true, '可选字段缺失仍通过')
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
