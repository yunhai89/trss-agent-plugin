/**
 * 真实 Provider 冒烟（默认跳过；仅配置真实 Key 时运行）。
 *
 * 用途：用真实模型端到端验证关键修复（账本业务状态、检查点、spawn 结构化结果、编排用量、收尾上限）。
 * 运行方式（二选一）：
 *   1) 环境变量：REAL_LLM_API_KEY=... REAL_LLM_BASE_URL=... REAL_LLM_MODEL=... [REAL_LLM_PRESET=opencode-go] node stress/real/real-llm-smoke.mjs
 *   2) 指向插件配置：AGENTS_CONFIG=/path/to/config.yaml node stress/real/real-llm-smoke.mjs
 * 未配置 Key → 打印 SKIP_FILE 并以 0 退出（离线测试运行器据此记为 skip，不联网）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import YAML from 'yaml'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href)

function resolveProviderCfg() {
  const env = process.env
  if (env.REAL_LLM_API_KEY) {
    return { protocol: env.REAL_LLM_PROTOCOL || 'openai', preset: env.REAL_LLM_PRESET || 'opencode-go', baseURL: env.REAL_LLM_BASE_URL || '', apiKey: env.REAL_LLM_API_KEY, model: env.REAL_LLM_MODEL || '' }
  }
  const cfgPath = env.AGENTS_CONFIG || ''
  if (cfgPath && fs.existsSync(cfgPath)) {
    try {
      const y = YAML.parse(fs.readFileSync(cfgPath, 'utf8'))
      const a = (y && y.agent) || {}
      if (a.apiKey) return { protocol: a.protocol || 'openai', preset: a.preset || '', baseURL: a.baseURL || '', apiKey: a.apiKey, model: a.model || '' }
    } catch { /* 忽略，走 skip */ }
  }
  return null
}

const pc = resolveProviderCfg()
if (!pc || !pc.apiKey || !pc.model) {
  console.log('SKIP_FILE: 未配置真实 LLM（REAL_LLM_API_KEY / AGENTS_CONFIG），跳过真实冒烟')
  process.exit(0)
}

const { createProvider } = await imp('model/agent/provider/index.js')
const { Agent } = await imp('model/agent/Agent.js')
const { ToolRegistry } = await imp('model/agent/tools/registry.js')
const { TaskStore } = await imp('model/agent/task-store.js')
const { makeSpawnSubagentTools } = await imp('model/multiagent/spawn-tool.js')

let presetsMod = null
try { presetsMod = await imp('model/openai/presets.js') } catch { /* 可选 */ }
const presetObj = (pc.preset && presetsMod?.presets?.[pc.preset]) ? presetsMod.presets[pc.preset] : {}
const mkProvider = () => createProvider({ protocol: pc.protocol, ...presetObj, ...(pc.baseURL ? { baseURL: pc.baseURL } : {}), apiKey: pc.apiKey, model: pc.model })

const CTX = { userId: 'real-smoke', scopeUserId: 'real-smoke', groupId: 'g-real', conversationId: 'real-smoke', scopeId: 'g-real_real-smoke' }
let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

const store = new TaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'real-smoke-')) })
await store.open()

await test('真实模型：只读工具调用 → 账本/检查点（F03/F06）', async () => {
  const tools = new ToolRegistry().register({
    name: 'get_weather', description: '查询城市天气', category: 'query', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    async execute(p) { return { city: p.city || '北京', temperature: 22, condition: '晴' } },
  })
  const agent = new Agent({ provider: mkProvider(), model: pc.model, tools, taskStore: store, maxTurns: 6 })
  const r = await agent.run('请调用 get_weather 工具查询北京天气，然后用一句话告诉我结果。', { ctx: CTX })
  ok((r.content || '').length > 0, '返回真实回复')
  const ev = await store.listEvents(r.taskId)
  ok(ev.some((e) => e.kind === 'accepted'), 'accepted 事件')
  const cp = await store.getCheckpoint(r.taskId)
  ok(typeof cp.input === 'string' && cp.input.includes('get_weather'), 'F06 检查点保存原始输入')
  const tr = ev.find((e) => e.kind === 'tool_result' && e.callId)
  if (tr) {
    ok(tr.payload.effect === 'read' && tr.payload.effectState === 'none', 'F03 只读成功 effectState=none')
  } else {
    console.log('  （模型本轮未调用工具，跳过工具结算断言）')
  }
})

await test('真实模型：失败写工具 → 不记成功（F03）', async () => {
  const tools = new ToolRegistry().register({
    name: 'always_fail', description: '总是失败的工具', category: 'query', parameters: { type: 'object' },
    meta: { effect: 'write', replay: 'never' },
    async execute() { throw new Error('deliberate failure') },
  })
  const agent = new Agent({ provider: mkProvider(), model: pc.model, tools, taskStore: store, maxTurns: 4 })
  const r = await agent.run('请调用 always_fail 工具一次。', { ctx: CTX })
  const tr = (await store.listEvents(r.taskId)).find((e) => e.kind === 'tool_result' && e.payload?.name === 'always_fail')
  if (tr) {
    ok(tr.payload.ok === false, '失败工具 ok=false')
    ok(tr.payload.effectState !== 'applied', `失败 effectState=${tr.payload.effectState}（非 applied）`)
  } else {
    console.log('  （模型本轮未调用失败工具，跳过）')
  }
})

await test('真实模型：spawn 子代理结构化结果（F11）', async () => {
  const ts = makeSpawnSubagentTools({ provider: mkProvider(), model: pc.model, sourceRegistry: new ToolRegistry(), maxTurns: 4, minBudgetMs: 10000 })
  const sp = await ts[0].execute({ task: '只回复一个词：收到。不要做其它事。' }, CTX)
  const res = await ts[1].execute({ taskId: sp.taskId, waitMs: 60000 }, CTX)
  ok(res.status === 'done', `F11 子代理完成 status=${res.status}`)
  ok(typeof res.stopReason === 'string', 'F11 保留 stopReason')
  ok(res.usage != null, 'F11 保留 usage')
  ts.shutdown()
})

await store.close()
console.log(`\n真实冒烟 通过 ${passed}，失败 ${failed}`)
console.log('（提示：真实冒烟依赖模型可用性，非确定性断言已尽量放宽）')
if (failed > 0) process.exitCode = 1
