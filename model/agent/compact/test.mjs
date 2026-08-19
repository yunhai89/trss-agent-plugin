/**
 * 离线自检 —— 无损上下文压缩（Hermes 式四阶段 + 内容寻址归档 + context_recall 恢复）。
 * 运行：node model/agent/compact/test.mjs  （无需联网 / API Key）
 *
 * 被测不变量（对照 agent-context-compaction skill 验证矩阵）：
 *  - 原子束：assistant(tool_calls) + 其全部 tool results 整块移动，绝不撕裂；
 *  - 可逆：被移出窗口的原文进内容寻址归档，hash 可校验、可完整找回（reversible 模式）；
 *  - 台账：结构化 ledger（facts/tool_state/archive_refs），多次压缩合并而非重总结（防漂移）；
 *  - 协议合法：压缩后无孤立 tool_result、无缺结果 tool_call（sanitizeToolPairs）；
 *  - 水位：压缩后（含档案消息自身 token）回到低水位以下；messages[0] 首条意图恒保留。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  splitTurnBlocks,
  sanitizeToolPairs,
  buildLedger,
  mergeLedger,
  renderCompactionMessage,
  compactMessages,
} from './index.js'
import { CompactionArchive } from './archive.js'
import { makeContextRecallTool } from './recall.js'
import { Agent, ToolRegistry, SessionStore, memoryKv } from '../index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }

// ---------- 消息构造 ----------
const um = (content) => ({ role: 'user', content })
const am = (content) => ({ role: 'assistant', content })
const atm = (calls) => ({ role: 'assistant', content: '', tool_calls: calls.map((c, i) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } })) })
const tm = (callId, content) => ({ role: 'tool', tool_call_id: callId, content })
// 本仓库 Agent 内部消息形态（tool_calls 扁平），compact 必须两种形态都接受
const atmFlat = (calls) => ({ role: 'assistant', content: '', tool_calls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments || {} })) })
const tmFlat = (callId, content) => ({ role: 'tool', tool_call_id: callId, content })

const estFn = (t) => Math.ceil(String(t || '').length / 4)

await test('splitTurnBlocks：首意图独立 + user 边界分块 + 并行 tool 结果同块（原子束）', async () => {
  const msgs = [
    um('首条意图'),
    um('问题A'), atmFlat([{ id: 'c1', name: 't1' }]), tmFlat('c1', 'r1'), tmFlat('c1x', 'r1x'), am('答A'),
    um('问题B'), am('答B'),
  ]
  const blocks = splitTurnBlocks(msgs)
  eq(blocks.length, 3, '三块：首意图 + 问题A 整轮 + 问题B 整轮')
  eq(blocks[0].length, 1, 'messages[0] 首意图独立成块')
  eq(blocks[0][0].content, '首条意图', '首意图内容不变')
  eq(blocks[1].length, 5, '问题A 块含 user+assistant(tool_calls)+2 并行结果+收尾 assistant（整块原子）')
  ok(blocks[1].every((m) => m.role !== 'user' || m === blocks[1][0]), '块内除块首无 user（边界不撕裂轮次）')
  eq(blocks[2].length, 2, '问题B 块 = user+assistant')
  // 防御形态：messages[1] 是孤儿 assistant 头（无 user 起始）→ 并入独立块，不与首意图混合
  const orphan = [um('首'), am('孤儿头'), tmFlat('x', 'r'), um('Q'), am('A')]
  const b2 = splitTurnBlocks(orphan)
  eq(b2[0].length, 1, '孤儿头形态：首意图仍独立')
  eq(b2[1][0].role, 'assistant', '孤儿 assistant/tool 头自成一块（不混入首意图）')
})

await test('sanitizeToolPairs：孤儿 tool_result 删除 + 缺结果 tool_call 注入 stub', async () => {
  const out = sanitizeToolPairs([
    um('Q'),
    atmFlat([{ id: 'ok1', name: 't1' }]),
    tmFlat('orphan', '无主结果'),
    am('中间'),
    atmFlat([{ id: 'missing', name: 't2' }, { id: 'ok2', name: 't1' }]),
    tmFlat('ok2', '有结果'),
    am('尾'),
  ])
  const ids = new Set()
  for (const m of out) for (const tc of m.tool_calls || []) ids.add(tc.id)
  const results = out.filter((m) => m.role === 'tool')
  ok(results.every((m) => ids.has(m.tool_call_id)), '剩余 tool_result 全部有主')
  ok(!results.some((m) => m.tool_call_id === 'orphan'), '孤儿 tool_result 被移除')
  ok(results.some((m) => m.tool_call_id === 'missing'), '缺结果的 tool_call 被注入 stub 结果')
  eq(out.filter((m) => m.role === 'user').length, 1, 'user 消息不受影响')
})

await test('buildLedger：确定性台账——facts/tool_state/completed_steps 从原文结构提取', async () => {
  const dropped = [
    um('帮我部署版本 2.3.1 到生产环境'),
    atmFlat([{ id: 'c1', name: 'terminal' }]),
    tmFlat('c1', 'deploy ok'),
    am('部署完成了'),
    um('不对，版本号写错了，是 2.3.2'),
    atmFlat([{ id: 'c2', name: 'terminal' }]),
    tmFlat('c2', '{"error":"权限不足"}'),
    am('需要提权'),
  ]
  const led = buildLedger(dropped, { msgStart: 1 })
  ok(led.facts.length >= 2, `facts 含用户消息摘录（实际 ${led.facts.length} 条）`)
  ok(led.facts.some((f) => String(f.text).includes('2.3.2')), '数字/纠正原样保留（2.3.2 不被改写）')
  const term = led.tool_state.find((t) => t.tool === 'terminal')
  ok(term && term.calls === 2 && term.failures === 1, `tool_state 统计 calls/failures（实际 ${JSON.stringify(term)}）`)
  ok(led.completed_steps.some((s) => String(s.text).includes('部署完成')), 'completed_steps 含 assistant 步骤摘录')
  // 确定性：同输入两次构建结果逐字节一致（防漂移要求 ledger 是结构化提取物而非生成物）
  eq(JSON.stringify(buildLedger(dropped, { msgStart: 1 })), JSON.stringify(led), '同输入 → 同 ledger（确定性）')
})

await test('mergeLedger：多次压缩合并——prev facts 保留、archive_refs 追加、不重新总结', async () => {
  const prev = { facts: [{ text: '早期事实A' }], completed_steps: [], tool_state: [], archive_refs: [{ ref: 'r1', hash: 'h1', msgs: 4 }], open_questions: [] }
  const next = { facts: [{ text: '新事实B' }], completed_steps: [], tool_state: [], archive_refs: [{ ref: 'r2', hash: 'h2', msgs: 6 }], open_questions: [] }
  const m = mergeLedger(prev, next)
  ok(m.facts.some((f) => f.text === '早期事实A') && m.facts.some((f) => f.text === '新事实B'), '新旧 facts 并存（旧的未被静默覆盖）')
  eq(m.archive_refs.length, 2, 'archive_refs 追加')
  eq(m.archive_refs[0].ref, 'r2', '新归档排前（近因优先）')
})

await test('renderCompactionMessage：系统生成标注 + archive ref + context_recall 指引 + role 规则', async () => {
  const led = { facts: [{ text: 'F1' }], completed_steps: [], tool_state: [], archive_refs: [{ ref: 'abc123', hash: 'deadbeef', msgs: 8, tokens: 1200 }], open_questions: [] }
  const m1 = renderCompactionMessage({ ledger: led, nextRole: 'user' })
  eq(m1.role, 'assistant', '下一条是 user → 档案消息取 assistant（保持交替）')
  const m2 = renderCompactionMessage({ ledger: led, nextRole: 'assistant' })
  eq(m2.role, 'user', '下一条是 assistant → 档案消息取 user（避免连续同 role）')
  for (const m of [m1, m2]) {
    ok(String(m.content).includes('上下文压缩档案'), '含「上下文压缩档案」标注')
    ok(String(m.content).includes('系统生成'), '标注系统生成（非用户/助手发言）')
    ok(String(m.content).includes('abc123'), '含归档 ref')
    ok(String(m.content).includes('context_recall'), '指引用 context_recall 恢复')
  }
})

await test('CompactionArchive：内容寻址写入 + hash 校验往返 + 篡改检测 + 关键词检索', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-arch-'))
  const arch = new CompactionArchive({ dir })
  const originals = [um('查一下 Hermes 架构'), atmFlat([{ id: 'c1', name: 'web_crawl' }]), tmFlat('c1', 'Hermes 用可插拔 context engine')]
  const saved = await arch.save({ convKey: 'u1:p:c1', epoch: 1, messages: originals })
  ok(/^[0-9a-f]{16,}$/.test(saved.hash), `内容寻址 hash（实际 ${saved.hash}）`)
  ok(saved.ref && saved.count === 3, `ref + 条数（实际 ${saved.count}）`)
  const got = await arch.get(saved.ref)
  ok(got.ok, '读取成功')
  eq(got.messages, originals, '原文完整往返（无损核心证据）')
  // 关键词检索（先于篡改：篡改会改掉唯一含 Hermes 的归档）
  const s2 = await arch.save({ convKey: 'u1:p:c1', epoch: 2, messages: [um('另一个话题：crawl4ai 安装')] })
  const hits = await arch.search('u1:p:c1', 'Hermes')
  ok(hits.some((h) => h.ref === saved.ref), '关键词检索命中含 Hermes 的归档')
  ok(hits.every((h) => h.ref !== s2.ref), '不含关键词的归档不命中')
  // 篡改检测：改文件内容 → hash 校验失败
  const files = fs.readdirSync(path.join(dir, 'u1_p_c1'))
  const fp = path.join(dir, 'u1_p_c1', files[0])
  fs.writeFileSync(fp, JSON.stringify({ ...JSON.parse(fs.readFileSync(fp, 'utf8')), messages: [um('篡改')] }))
  const bad = await arch.get(saved.ref)
  ok(!bad.ok && bad.code === 'hash_mismatch', `篡改被检出（${bad.code}）`)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('compactMessages：四阶段集成——归档找回全部原文 + 协议合法 + 含档案消息回到低水位', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-cm-'))
  const arch = new CompactionArchive({ dir })
  // 6 轮长历史，tool result 撑大 token
  const msgs = [um('总目标：完成部署')]
  for (let i = 1; i <= 6; i++) {
    msgs.push(um(`问题${i}`))
    msgs.push(atmFlat([{ id: `c${i}`, name: 'terminal' }]))
    msgs.push(tmFlat(`c${i}`, `结果${i}：`.padEnd(400, 'x'))) // ~100 token/条
    msgs.push(am(`回复${i}：已完成步骤${i}`.padEnd(200, 'y')))
  }
  const low = 500 // 低水位（token）
  const out = await compactMessages(msgs, { kind: 'token', value: low, archive: arch, convKey: 'u1:p:c1', estimateTokens: estFn, minKeep: 4 })
  ok(out.dropped >= 4, `真实移出了中段块（实际 ${out.dropped} 条）`)
  eq(out.messages[0].content, '总目标：完成部署', 'messages[0] 首条意图原样保留')
  ok(String(out.messages[1].content || '').includes('上下文压缩档案'), '第二条是压缩档案消息')
  // 原子束 + 协议合法
  const ids = new Set()
  for (const m of out.messages) for (const tc of m.tool_calls || []) ids.add(tc.id)
  ok(out.messages.filter((m) => m.role === 'tool').every((m) => ids.has(m.tool_call_id)), '无孤立 tool_result')
  // 水位（含档案消息自身）
  const est = out.messages.reduce((n, m) => n + 4 + estFn(typeof m.content === 'string' ? m.content : JSON.stringify(m.tool_calls || '')), 0)
  ok(est <= low + 60, `压缩后总 token（含档案消息）≈ 低水位（实际 ${est} ≤ ${low + 60}）`)
  // 无损核心：被移出的每一条原文都能从归档完整找回
  const kept = new Set(out.messages)
  const removed = msgs.filter((m) => !kept.has(m))
  ok(removed.length >= out.dropped - 1, `移出消息数对齐（removed=${removed.length}, dropped=${out.dropped}）`)
  const archivedAll = (await Promise.all(out.ledger.archive_refs.map((r) => arch.get(r.ref)))).flatMap((g) => g.ok ? g.messages : [])
  for (const m of removed) {
    ok(archivedAll.some((a) => JSON.stringify(a) === JSON.stringify(m)), `原文进归档：${String(m.content || m.tool_call_id).slice(0, 20)}…`)
    if (failed > 0) break // 首条失配即报，避免刷屏
  }
  ok(out.ledger.archive_refs.length >= 1, 'ledger 含 archive_refs')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('compactMessages：Phase 1 兜底——floorKeep 保护下修剪长 tool result（占位 + 原文进归档）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-p1-'))
  const arch = new CompactionArchive({ dir })
  // 尾部 4 条全是大 tool result，块不能再丢（floorKeep），靠 Phase 1 修剪达标
  const msgs = [um('目标'), um('Q1'), atmFlat([{ id: 'c1', name: 't' }]), tmFlat('c1', 'R'.repeat(4000)), um('Q2'), atmFlat([{ id: 'c2', name: 't' }]), tmFlat('c2', 'S'.repeat(4000))]
  const out = await compactMessages(msgs, { kind: 'token', value: 600, archive: arch, convKey: 'u1:p:c1', estimateTokens: estFn, minKeep: 6, pruneToolResultChars: 300 })
  const pruned = out.messages.filter((m) => m.role === 'tool' && m.content.length < 4000 && m.content !== 'R'.repeat(4000) && m.content !== 'S'.repeat(4000))
  ok(pruned.length >= 1, `长 tool result 被修剪占位（实际 ${pruned.length} 条）`)
  ok(pruned.every((m) => String(m.content).includes('归档') || String(m.content).includes('archive')), '占位符标注归档去向')
  // 修剪掉的原文同样可从归档找回
  const archivedAll = (await Promise.all(out.ledger.archive_refs.map((r) => arch.get(r.ref)))).flatMap((g) => g.ok ? g.messages : [])
  ok(archivedAll.some((x) => x.role === 'tool' && x.content === 'R'.repeat(4000)), '被修剪的 tool result 原文进归档（无损）')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('context_recall 工具：按 ref 读原文 + 按 query 检索 + 越权/损坏返回结构化错误', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-rc-'))
  const arch = new CompactionArchive({ dir })
  const saved = await arch.save({ convKey: 'u1:p:c1', epoch: 1, messages: [um('关于 Kubernetes 滚动更新的讨论')] })
  const tool = makeContextRecallTool({ archiveFor: () => arch })
  const byRef = await tool.execute({ ref: saved.ref }, { userId: 'u1', groupId: null, conversationId: 'c1' })
  ok(byRef.ok && byRef.text.includes('Kubernetes'), '按 ref 找回原文')
  const byQuery = await tool.execute({ query: 'Kubernetes' }, { userId: 'u1', groupId: null, conversationId: 'c1' })
  ok(byQuery.ok && byQuery.hits.length >= 1, '按 query 检索命中')
  const bad = await tool.execute({ ref: 'nonexistent' }, { userId: 'u1', groupId: null, conversationId: 'c1' })
  ok(!bad.ok && bad.error, '不存在的 ref → 结构化错误（非崩溃）')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('Agent 集成：token 水位触发无损压缩——归档可恢复 + 配对完整 + 首条意图保留 + ledger 持久化', async () => {
  const kv = memoryKv()
  const session = new SessionStore({ kv })
  await session.createConversation('u1', null, 'c1')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-agent-'))
  const arch = new CompactionArchive({ dir })
  const long = '这是用于撑大 token 估算的长内容。'.repeat(60) // ~240 token
  let turn = 0
  const provider = {
    async chat(opts) {
      turn++
      if (turn % 2 === 1) return { content: '旁白' + turn, toolCalls: [{ id: 'c' + turn, name: 't1', arguments: {} }], finishReason: 'tool_calls', usage: { prompt_tokens: 5, completion_tokens: 1 } }
      return { content: '回复' + turn, finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 } }
    },
  }
  const tools = new ToolRegistry().register({ name: 't1', description: 'd', parameters: { type: 'object' }, async execute() { return '工具结果原文' } })
  const agent = new Agent({
    provider, tools, session, maxTurns: 5, reflect: 'off',
    contextWindow: 1600, contextKeepRecent: 4,
    compactArchive: arch,
  })
  for (let i = 1; i <= 5; i++) {
    await agent.run(`问题${i} ${long}`, {
      ctx: { userId: 'u1', groupId: null, scopeUserId: 'u1', conversationId: 'c1' },
      systemPrompt: '短身份',
    })
  }
  const hist = await session.getConversation('u1', null, 'c1')
  ok(String(hist[0]?.content || '').includes('问题1'), '首条用户意图保留')
  ok(hist.length >= 2 && String(hist[1]?.content || '').includes('上下文压缩档案'), `第二消息是压缩档案（实际 role=${hist[1]?.role}）`)
  // 配对完整
  const callIds = new Set()
  for (const m of hist) for (const tc of m.tool_calls || []) callIds.add(tc.id)
  ok(hist.filter((m) => m.role === 'tool').every((m) => callIds.has(m.tool_call_id)), '压缩后 tool_call/tool_result 配对完整')
  // ledger 持久化 + 原文可恢复（无损端到端）
  const st = await session.getConversationState('u1', null, 'c1')
  ok(st.cacheEpoch >= 1, `epoch 持久化（${st.cacheEpoch}）`)
  const led = st.compactLedger
  ok(led && Array.isArray(led.archive_refs) && led.archive_refs.length >= 1, 'compactLedger 持久化且含 archive_refs')
  if (led?.archive_refs?.length) {
    const g = await arch.get(led.archive_refs[0].ref)
    ok(g.ok && g.messages.some((m) => String(m.content || '').includes('工具结果原文') || String(m.content || '').includes('问题')), '被压缩原文可从归档完整找回（无损）')
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
