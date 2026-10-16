/**
 * 真实模型冒烟：会话内写记忆不得打穿前缀缓存（第 7 个真因回归，v1.26.22）。
 *
 * 背景：声明式记忆快照原先注入 **system 参数**，于是「会话内写一条记忆」会改变 system，
 * 使其后全部历史失去前缀复用。实机 2026-10-16 窗口里 `break:memory_snapshot` 三次
 * 就吃掉 263,317 tok（占总 miss 71.8%，命中率 4.5%）。修复后快照改注入 user 消息尾部。
 *
 * 本冒烟用真实 relay 验证四条不变量：
 *   1) 同一会话内写记忆后，两轮的 system 参数**逐字节相同**；
 *   2) system 里**不含**刚写的记忆；它出现在第二轮 user 消息里；
 *   3) 两轮的 tools 数组逐项相同（`toolDiscovery.stableList` 默认开）；
 *   4) 第二轮真实命中缓存（cached_tokens > 0）。
 *
 * 运行：AGENTS_CONFIG=/path/to/config.yaml node stress/real/memory-cache-smoke.mjs
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
      if (a.apiKey) return { protocol: a.protocol || 'openai', preset: a.preset || '', baseURL: a.baseURL || '', apiKey: a.apiKey, model: a.model || '', reflect: a.reflect, finalize: a.finalize }
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
const { MemoryStore } = await imp('model/agent/memory/store.js')
const { createMemoryTool } = await imp('model/agent/memory/index.js')

let presetsMod = null
try { presetsMod = await imp('model/openai/presets.js') } catch { /* 可选 */ }
const presetObj = (pc.preset && presetsMod?.presets?.[pc.preset]) ? presetsMod.presets[pc.preset] : {}

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

const CTX = { userId: 'mem-cache', scopeUserId: 'mem-cache', groupId: 'g-mem', conversationId: 'mem-cache', scopeId: 'g-mem_mem-cache' }
const SYS = '你是群里的服务型 AI，回答简短。'

function mkProvider(record) {
  const inner = createProvider({ protocol: pc.protocol, ...presetObj, ...(pc.baseURL ? { baseURL: pc.baseURL } : {}), apiKey: pc.apiKey, model: pc.model })
  return {
    async chat(opts) {
      const r = await inner.chat(opts)
      record.push({ system: opts.system, tools: opts.tools, messages: opts.messages, usage: r.usage, content: r.content })
      return r
    },
  }
}

const cachedTokens = (u) => Number(u?.prompt_tokens_details?.cached_tokens ?? u?.cached_tokens ?? u?.cache_read_input_tokens ?? 0)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cache-smoke-'))
const store = new MemoryStore({ dir })
const tools = new ToolRegistry().register(createMemoryTool(store))

console.log(`\n[会话内写记忆 → 前缀缓存不被打穿]  provider=${pc.protocol}/${pc.preset || '-'} model=${pc.model}`)
const record = []
const agent = new Agent({ provider: mkProvider(record), tools, memory: store, maxTurns: 2, reflect: 'off', finalize: 'off' })
try {
  await agent.run('第一轮：随便聊一句，比如今天天气。', { ctx: CTX, systemPrompt: SYS })
  // 模拟会话内模型调用 memory 工具（等价于 store.add），随后立刻进入第二轮
  store.add('user', '用户希望被称呼为「小汐」。（据用户原话："以后叫我小汐吧"）', CTX.scopeId)
  await agent.run('第二轮：我们换个话题。', { ctx: CTX, systemPrompt: SYS })

  const [r1, r2] = record
  ok(!!r1 && !!r2, `两轮都拿到了 provider 记录（${record.length} 次调用）`)
  if (r1 && r2) {
    ok(String(r1.system) === String(r2.system), '两轮 system 参数逐字节相同（写记忆不改 system）')
    ok(!String(r1.system || '').includes('小汐') && !String(r2.system || '').includes('小汐'), 'system 里不含刚写的记忆')
    const lastUser = [...(r2.messages || [])].reverse().find((m) => m.role === 'user')
    const lastText = String(lastUser?.content || '')
    ok(lastText.includes('小汐'), '第二轮 user 消息里带上了新写的记忆（快照走 user 尾部）')
    ok(lastText.includes('untrusted_data'), '注入的记忆仍带不可信边界标注')
    ok(JSON.stringify(r1.tools || null) === JSON.stringify(r2.tools || null), '两轮 tools 数组逐项相同（stableList 默认开）')
    const c2 = cachedTokens(r2.usage)
    console.log(`    第二轮 usage: prompt=${r2.usage?.prompt_tokens ?? r2.usage?.input_tokens} cached=${c2}`)
    ok(c2 > 0, `第二轮命中前缀缓存（cached=${c2}）`)
  }
} catch (e) {
  failed++
  console.error('  ✗ THROW', e?.message || e)
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
fs.rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
