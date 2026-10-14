/**
 * continuation 续跑重建回归 —— F06：合法 tool_call/tool_result 配对 + 未完成指引。
 * 运行：node model/agent/continuation.test.mjs
 */
import { buildResumeMessages, classifySteps } from './continuation.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

const cp = {
  input: '原始任务：搜集资料并写总结',
  steps: [
    { callId: 'c1', name: 'web_search', args: { q: 'x' }, ok: true, resultPreview: '{"found":1}' },
    { callId: 'c2', name: 'set_note', ok: true, args: undefined }, // 已完成但未保留正文（写操作）
    { callId: 'c3', name: 'kb_search', ok: null }, // 未完成
    { callId: 'c4', name: 'web_crawl', ok: false }, // 失败
  ],
}

await test('classifySteps 分类', async () => {
  const c = classifySteps(cp)
  eq(c.completed.length, 2, 'completed=2')
  eq(c.pending.length, 1, 'pending=1')
  eq(c.failed.length, 1, 'failed=1')
})

await test('buildResumeMessages：合法配对 + 指引', async () => {
  const msgs = buildResumeMessages(cp)
  eq(msgs[0], { role: 'user', content: '原始任务：搜集资料并写总结' }, '首条为原始输入')
  const asst = msgs.find((m) => m.role === 'assistant' && m.tool_calls)
  ok(!!asst && asst.tool_calls[0].function.name === 'web_search', '重建 assistant tool_call')
  const tool = msgs.find((m) => m.role === 'tool')
  ok(!!tool, '存在配对的 tool 结果')
  eq(tool.tool_call_id, asst.tool_calls[0].id, 'tool_call_id 配对一致')
  eq(tool.content, '{"found":1}', '使用已提交结果正文')
  const last = msgs[msgs.length - 1]
  eq(last.role, 'user', '末条为续跑指引')
  ok(last.content.includes('set_note'), '已完成无正文步骤以文字保留')
  ok(last.content.includes('kb_search'), '未完成步骤列出')
  ok(last.content.includes('web_crawl'), '失败步骤列出')
})

await test('buildResumeMessages：无完成步骤也可续跑', async () => {
  const msgs = buildResumeMessages({ input: 'go', steps: [{ callId: 'c', name: 't', ok: null }] })
  eq(msgs.length, 2, '仅 input + 指引')
  eq(msgs[1].role, 'user', '指引为 user')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
