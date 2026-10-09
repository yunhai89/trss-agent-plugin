/**
 * 离线回归 —— ephemeral 临时任务模式的隔离语义（人设补齐复用主任务账本时用）。
 *
 * 覆盖：
 *  - ephemeral=true：不读写会话历史、不注入/抽取召回记忆、不读/写用户画像；
 *  - ephemeral=false（对照）：上述路径照常触发。
 * 运行：node model/agent/ephemeral.test.mjs
 */
import { Agent, ToolRegistry } from './index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 4).join('\n')) } }
const tick = () => new Promise((r) => setImmediate(r))

function makeSession(rec) {
  const impl = {
    key: () => 'k',
    async getConversation() { rec.push('getConversation'); return [] },
    async appendConversation() { rec.push('appendConversation') },
    async setConversation() { rec.push('setConversation') },
    async get() { return [] },
    async set() {},
    async getConversationState() { return null },
    async setConversationState() {},
    async historyLength() { return 0 },
  }
  return new Proxy(impl, { get(t, p) { return p in t ? t[p] : async () => undefined } })
}
function makeRecall(rec) {
  const impl = {
    async retrieve() { rec.push('retrieve'); return [] },
    formatForPrompt() { return '' },
    async extractAndWrite() { rec.push('extractAndWrite') },
    async recordUsage() {},
    async listByUser() { return [] },
  }
  return new Proxy(impl, { get(t, p) { return p in t ? t[p] : async () => undefined } })
}
function makeProfile(rec) {
  const impl = {
    async build() { rec.push('build'); return '' },
    async ingest() { rec.push('ingest') },
  }
  return new Proxy(impl, { get(t, p) { return p in t ? t[p] : async () => undefined } })
}

const provider = { async chat() { return { role: 'assistant', content: 'ok', toolCalls: [], finishReason: 'stop' } } }
const ctx = { userId: 'u1', scopeUserId: 'u1', groupId: null, conversationId: 'c1' }

await test('ephemeral=true：不碰会话/召回/画像', async () => {
  const srec = [], rrec = [], prec = []
  const agent = new Agent({ provider, tools: new ToolRegistry(), session: makeSession(srec), recall: makeRecall(rrec), profile: makeProfile(prec), reflect: 'off', governor: false })
  await agent.run('补齐研究', { ctx, ephemeral: true })
  await tick()
  ok(!srec.includes('getConversation'), '未加载会话历史')
  ok(!srec.includes('appendConversation') && !srec.includes('setConversation'), '未持久化会话历史')
  ok(!rrec.includes('retrieve'), '未注入召回记忆')
  ok(!rrec.includes('extractAndWrite'), '未抽取记忆')
  ok(!prec.includes('build'), '未读取用户画像')
})

await test('ephemeral=false（对照）：会话/召回/画像照常触发', async () => {
  const srec = [], rrec = [], prec = []
  const agent = new Agent({ provider, tools: new ToolRegistry(), session: makeSession(srec), recall: makeRecall(rrec), profile: makeProfile(prec), reflect: 'off', governor: false })
  await agent.run('普通对话', { ctx })
  await tick()
  ok(srec.includes('getConversation'), '加载了会话历史')
  ok(srec.includes('appendConversation') || srec.includes('setConversation'), '持久化了会话历史')
  ok(rrec.includes('retrieve'), '注入了召回记忆')
  ok(rrec.includes('extractAndWrite'), '抽取了记忆')
  ok(prec.includes('build'), '读取了用户画像')
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
