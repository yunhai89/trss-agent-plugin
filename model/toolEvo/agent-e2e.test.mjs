/**
 * Tool Evolution × Agent 真实入口正例（保留并扩展原离线检查）：
 * 生成→验证→采纳 stable→注册契约→Agent.run：第一轮 tool_search 激活工具，
 * 第二轮该工具完整 schema 出现在 provider 请求中并被调用，第三轮正常收尾。
 * 只 mock LLM（OpenAI 兼容 client）；registry/engine/runner/ToolRegistry/Agent 均跑真实实现。
 * 运行：node model/toolEvo/agent-e2e.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDb, closeDb } from './db.js'
import { ToolEvoRegistry } from './registry.js'
import { ToolSynthesizer } from './synthesizer.js'
import { EvolutionEngine } from './engine.js'
import { RunnerClient } from './runner.js'
import { Agent, ToolRegistry, OpenAIProvider } from '../agent/index.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tevo-agent-'))
await initDb({ dir })
const reg = new ToolEvoRegistry({ artifactsDir: path.join(dir, 'tools') })

const candidate = {
  manifest: { name: 'double_it', description: '把输入数字加倍返回', category: 'query', useWhen: [], doNotUseWhen: [], tags: [], inputSchemaJson: JSON.stringify({ type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }), permissions: { sideEffects: ['none'] } },
  source: 'export async function run(input){ return { doubled: (input.n||0)*2 } }',
  tests: [
    { name: 'a', inputJson: '{"n":2}', expectedJson: '{"doubled":4}' },
    { name: 'b', inputJson: '{"n":0}', expectedJson: '{"doubled":0}' },
  ],
  assumptions: [],
}
const synth = new ToolSynthesizer({ provider: { async chat() { return { content: JSON.stringify(candidate) } } }, model: 'mock', maxRepairAttempts: 0 })
const engine = new EvolutionEngine({ synthesizer: synth, registry: reg })
const gen = await engine.evolve({ goal: '把数字加倍' })
assert.equal(gen.ok, true, gen.reason)
await reg.setStatus(gen.versionId, 'stable', { actor: 'master', reason: '采纳' })

const requests = []
const client = { chat: { completions: { async create(body) {
  requests.push(structuredClone(body))
  if (requests.length === 1) {
    return { choices: [{ message: { content: '', tool_calls: [{ id: 's1', type: 'function', function: { name: 'tool_search', arguments: JSON.stringify({ query: '把数字加倍' }) } }] }, finish_reason: 'tool_calls' }] }
  }
  if (requests.length === 2) {
    return { choices: [{ message: { content: '', tool_calls: [{ id: 'e1', type: 'function', function: { name: 'double_it', arguments: JSON.stringify({ n: 21 }) } }] }, finish_reason: 'tool_calls' }] }
  }
  return { choices: [{ message: { content: '结果是 42' }, finish_reason: 'stop' }] }
} } } }

const tools = new ToolRegistry({ logger: () => {} })
const runner = new RunnerClient({ logger: () => {}, timeoutMs: 5000 })
try {
  const stable = (await reg.listStable()).find((s) => s.versionId === gen.versionId)
  tools.register(await reg.toToolContract(stable, runner))

  const agent = new Agent({
    provider: new OpenAIProvider({ client }), model: 'fixture', tools,
    toolDiscovery: { enable: true, minScore: 0.1 }, reflect: 'off', governor: false, maxTurns: 5,
  })
  const result = await agent.run('请把 21 加倍')

  ok(requests.length >= 3, `至少三轮请求（实际 ${requests.length}）`)
  const names0 = (requests[0].tools || []).map((t) => t.function?.name)
  ok(!names0.includes('double_it'), '第一轮工具未激活（不在 schema 列表）')
  const toolSearchMsg = (requests[0].tools || []).find((t) => t.function?.name === 'tool_search')
  ok(!!toolSearchMsg, '第一轮常驻 tool_search')

  const names1 = (requests[1].tools || []).map((t) => t.function?.name)
  ok(names1.includes('double_it'), '第二轮 tool_search 激活后出现 double_it 完整 schema')
  const sig = (requests[1].tools || []).find((t) => t.function?.name === 'double_it')
  ok(sig?.function?.parameters?.properties?.n, 'schema 含入参定义')

  const executed = requests[2]?.messages?.some((m) => m.role === 'tool' && /doubled/.test(String(m.content)))
  ok(executed, '第二轮实际调用进化工具，结果回填进消息')
  ok(/42/.test(String(result.content)), `第三轮正常收尾（content=${result.content}）`)
} finally {
  await runner.stop()
  await closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
