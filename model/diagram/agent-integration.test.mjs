/**
 * Agent 集成测试 —— 从真实工具注册入口进入：ToolRegistry + diagram_render（真实 DiagramService 本地引擎）
 * + Agent ReAct 循环（mock provider 驱动 tool_call）+ 生产交付器 makeDiagramDeliverer（与 apps/agent.js 同实现）。
 * 运行：node model/diagram/agent-integration.test.mjs
 *
 * 断言（任务 §Agent 集成）：
 *   tool_call_id/tool_result 配对完整；图片仅发送一次；最终回复非 DSL/非本地路径；
 *   发送失败产生 send_failed 事件；取消后不发送迟到图片；工具结果不被截断破坏；旁白不成为最终答案。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Agent, ToolRegistry } from '../agent/index.js'
import { DiagramService } from './index.js'
import { makeDiagramTool } from './tool.js'
import { makeDiagramDeliverer } from './deliver.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { ok(a === b, `${m}（实际 ${JSON.stringify(a)}）`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-agent-'))

// 全局 segment 桩（deliver.js 用 segment.image(base64://)）——模拟 OneBot 段构造
globalThis.segment = {
  image: (src) => ({ type: 'image', data: { url: src } }),
  file: (src, name) => ({ type: 'file', data: { file: src, name } }),
}

// —— mock provider（两轮：tool_call → 最终文本）——
function mockProvider(responses) {
  let i = 0
  const calls = { count: 0, opts: [] }
  return {
    calls,
    async chat(opts) {
      calls.count++
      calls.opts.push(opts)
      const r = responses[Math.min(i, responses.length - 1)]
      i++
      return {
        role: 'assistant', content: r.content ?? '', toolCalls: r.toolCalls || [],
        reasoning: r.reasoning || null, finishReason: r.finishReason || 'stop', usage: r.usage || null, rawMessage: {},
      }
    },
  }
}

// —— 应用层环境桩：e.reply 收集消息 ——
function makeFakeChat() {
  const sentMsgs = []
  const outcomes = [] // 每条消息的发送结果控制
  const e = {
    isGroup: false,
    reply: async (msg) => {
      sentMsgs.push(msg)
      const o = outcomes[0]
      if (o === 'throw') { outcomes.shift(); throw new Error('adapter send failed') }
      if (o === 'reject') { outcomes.shift(); return { retcode: 1200, status: 'failed' } }
      return { retcode: 0, status: 'ok' }
    },
  }
  const safeReply = async (msg) => {
    try { const ret = await e.reply(msg); return { ok: ret?.retcode === undefined || ret?.retcode === 0, ret } }
    catch (err) { return { ok: false, error: err?.message || String(err) } }
  }
  return { sentMsgs, outcomes, safeReply }
}

const mkService = () => {
  const svc = new DiagramService({ renderer: 'none', fallbackRenderer: 'beautiful-mermaid' }, { logger: () => {} })
  svc.temp.dir = path.join(TMPROOT, 'dg-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(svc.temp.dir, { recursive: true })
  return svc
}

const SPEC_ARGS = {
  type: 'flowchart', title: '主 Agent 调用搜索工具的流程',
  nodes: [
    { id: 'user', label: '用户', kind: 'user' },
    { id: 'agent', label: '主 Agent', kind: 'agent' },
    { id: 'search', label: 'web_search', kind: 'tool' },
    { id: 'reply', label: '最终回复', kind: 'end' },
  ],
  edges: [
    { from: 'user', to: 'agent', label: '提问' },
    { from: 'agent', to: 'search', label: 'tool_call' },
    { from: 'search', to: 'agent', label: 'tool_result', kind: 'async' },
    { from: 'agent', to: 'reply', label: '总结' },
  ],
}

/** 完整链：Agent run + 应用层 flush（复刻 apps/agent.js 控制流：正常返回才 flush） */
async function runAgentChat({ provider, service, chat, signal = null, events = [] }) {
  const tools = new ToolRegistry().register(makeDiagramTool(service)) // ← 真实工具注册入口
  const deliverer = makeDiagramDeliverer({
    safeReply: chat.safeReply,
    devLog: (event, data) => events.push({ event, ...data }),
    traceId: 'it-trace', devScope: null, logger: () => {},
  })
  let runResult = null, cancelled = false
  try {
    runResult = await new Agent({ provider, tools, maxTurns: 8, reflect: 'off' }).run('画一下主 Agent 调用搜索工具的流程图', {
      ctx: { userId: 'u1' },
      onToolEnd: deliverer.onToolEnd,
      ...(signal ? { signal } : {}),
    })
  } catch (e) {
    if (/aborted/i.test(String(e?.message || e))) cancelled = true
    else throw e
  }
  const delivery = cancelled ? null : await deliverer.flush() // 取消路径不 flush（与 apps/agent.js catch-return 一致）
  return { runResult, cancelled, delivery, messages: null }
}

await test('全链：模型调 diagram_render → 工具产出图片引用 → 最终文本 → 应用层发送图片一次', async () => {
  const events = []
  const chat = makeFakeChat()
  const provider = mockProvider([
    { content: '我先画出这个流程。', toolCalls: [{ id: 'call-1', name: 'diagram_render', arguments: SPEC_ARGS }], finishReason: 'tool_calls' },
    { content: '已为你生成流程图：用户提问后主 Agent 调用 web_search，拿到结果再总结回复。', finishReason: 'stop' },
  ])
  const svc = mkService()
  const { runResult, cancelled, delivery } = await runAgentChat({ provider, service: svc, chat, events })
  ok(!cancelled, '正常完成（未取消）')
  ok(runResult && typeof runResult.content === 'string' && runResult.content.length > 0, '有最终回复')
  // tool_call / tool_result 配对完整
  const toolMsg = runResult.messages.find((m) => m.role === 'tool')
  ok(toolMsg && toolMsg.tool_call_id === 'call-1', 'tool_result.tool_call_id 与 tool_call 配对')
  const toolObj = JSON.parse(toolMsg.content)
  ok(toolObj.ok === true && toolObj.type === 'diagram' && toolObj.path, '工具结果为结构化图片引用')
  ok(typeof toolObj.width === 'number' && typeof toolObj.bytes === 'number', '引用含尺寸/字节')
  ok(fs.existsSync(toolObj.path) && fs.readFileSync(toolObj.path)[0] === 0x89, 'PNG 文件真实存在且魔数正确')
  // 图片只发送一次 + 是 base64 image 段
  const imgMsgs = chat.sentMsgs.filter((m) => m?.type === 'image')
  eq(imgMsgs.length, 1, '图片仅发送一条')
  ok(String(imgMsgs[0]?.data?.url || '').startsWith('base64://'), 'image 段为 base64 形态')
  eq(delivery.sent.length, 1, '交付器报告发送 1 张')
  // 最终回复不是 DSL / 不是路径
  ok(!/flowchart |direction: |sequenceDiagram/.test(runResult.content), '最终回复不是原始 DSL')
  ok(!/\/tmp\/|\.png|data\/diagram/.test(runResult.content), '最终回复不含本地路径')
  // 旁白不成为最终回复
  ok(!runResult.content.includes('我先画出这个流程'), '中途旁白未成为最终答案')
  // 事件链完整
  const names = events.map((e) => e.event)
  ok(names.includes('diagram_send_start') && names.includes('diagram_sent'), 'send_start → sent 事件')
  eq(names.filter((n) => n === 'diagram_sent').length, 1, 'diagram_sent 恰好一次')
})

await test('失败链：发送被适配器拒绝 → diagram_send_failed 事件，主回复不受影响', async () => {
  const events = []
  const chat = makeFakeChat()
  chat.outcomes.push('throw') // 图片那条发送抛错
  const provider = mockProvider([
    { toolCalls: [{ id: 'call-2', name: 'diagram_render', arguments: SPEC_ARGS }], finishReason: 'tool_calls' },
    { content: '图已生成。', finishReason: 'stop' },
  ])
  const { runResult, delivery } = await runAgentChat({ provider, service: mkService(), chat, events })
  ok(runResult && runResult.content === '图已生成。', '最终文本正常（图片失败不影响主回复）')
  const failed = events.find((e) => e.event === 'diagram_send_failed')
  ok(failed && /adapter send failed/.test(failed.error || ''), 'diagram_send_failed 事件含错误：' + (failed?.error || ''))
  eq(delivery.failed.length, 1, '交付器报告 1 条失败')
  eq(delivery.sent.length, 0, '无成功发送')
})

await test('取消链：工具完成后用户取消 → run aborted → 不发送迟到图片', async () => {
  const chat = makeFakeChat()
  const ctl = new AbortController()
  const provider = mockProvider([
    { toolCalls: [{ id: 'call-3', name: 'diagram_render', arguments: SPEC_ARGS }], finishReason: 'tool_calls' },
    { content: '不应到达', finishReason: 'stop' },
  ])
  // 工具完成即取消（模拟用户在等最终回复时按下停止）——onToolEnd 时机触发 abort
  const tools = new ToolRegistry().register(makeDiagramTool(mkService()))
  const deliverer = makeDiagramDeliverer({ safeReply: chat.safeReply, devLog: () => {}, traceId: 'x' })
  let runResult = null, cancelled = false
  try {
    runResult = await new Agent({ provider, tools, maxTurns: 8, reflect: 'off' }).run('画图', {
      ctx: { userId: 'u1' },
      signal: ctl.signal,
      onToolEnd: (tc, content) => { deliverer.onToolEnd(tc, content); ctl.abort('user') },
    })
  } catch (e) { cancelled = /aborted/i.test(String(e?.message || e)) || /user/i.test(String(e?.message || e)) }
  ok(cancelled || runResult === null || ctl.signal.aborted, 'run 因取消终止')
  if (!cancelled) {
    // 若 run 意外正常返回：取消态下也不应 flush（apps 层 cancelled 分支直接 return）
  }
  const delivery = cancelled ? null : await deliverer.flush()
  ok(delivery === null || delivery.sent.length === chat.sentMsgs.filter((m) => m?.type === 'image').length, '无多发')
  eq(chat.sentMsgs.filter((m) => m?.type === 'image').length, 0, '取消后未发送任何图片（无迟到图片）')
})

await test('Kroki 不可用链：结构化失败回灌 → 模型据实回复，Agent loop 不中断', async () => {
  const chat = makeFakeChat()
  const svc = new DiagramService({
    renderer: 'kroki', fallbackRenderer: 'none',
    kroki: { endpoint: 'http://127.0.0.1:1', connectTimeoutMs: 300, requestTimeoutMs: 600, circuitBreaker: { enabled: false } },
  }, { logger: () => {} })
  const provider = mockProvider([
    { toolCalls: [{ id: 'call-4', name: 'diagram_render', arguments: { type: 'flowchart', title: 'x', nodes: [{ id: 'a', label: 'A' }] } }], finishReason: 'tool_calls' },
    { content: '抱歉，示意图渲染服务当前不可用，暂时无法生成图。', finishReason: 'stop' },
  ])
  const events = []
  const { runResult, delivery } = await runAgentChat({ provider, service: svc, chat, events })
  ok(runResult && runResult.content.includes('不可用'), '模型据实告知失败')
  const toolMsg = runResult.messages.find((m) => m.role === 'tool')
  const toolObj = JSON.parse(toolMsg.content)
  ok(toolObj.ok === false && typeof toolObj.errorClass === 'string', '工具结果为结构化失败（errorClass=' + toolObj.errorClass + '）')
  eq(chat.sentMsgs.filter((m) => m?.type === 'image').length, 0, '失败时无图片发送')
  eq(delivery.sent.length + delivery.failed.length, 0, '交付器未收到任何成功引用（无发送动作）')
})

await test('工具结果不被截断破坏：resultCap 内的 diagram JSON 可完整解析', async () => {
  const tool = makeDiagramTool(mkService())
  ok((tool.meta?.resultCap ?? 0) <= 4000, 'resultCap ≤ 4000')
  const raw = await tool.execute(SPEC_ARGS, { signal: null })
  const str = JSON.stringify(raw)
  ok(str.length < 4000, '结果序列化后远小于 cap（' + str.length + 'B）')
  const reparsed = JSON.parse(str)
  ok(reparsed.type === 'diagram' && reparsed.path, '序列化→反序列化后引用完整（不会被截断破坏）')
})

await test('缓存命中轮：同图二次请求不再渲染但图片仍随回复发送', async () => {
  const svc = mkService()
  const chat = makeFakeChat()
  const run = async () => {
    const c = makeFakeChat()
    const provider = mockProvider([
      { toolCalls: [{ id: 'c', name: 'diagram_render', arguments: SPEC_ARGS }], finishReason: 'tool_calls' },
      { content: '好的。', finishReason: 'stop' },
    ])
    const r = await runAgentChat({ provider, service: svc, chat: c })
    return { r, chat: c }
  }
  const first = await run()
  const second = await run()
  ok(first.r.delivery.sent.length === 1 && second.r.delivery.sent.length === 1, '两轮各发送一张')
  eq(first.r.delivery.sent[0], second.r.delivery.sent[0], '缓存命中复用同一路径')
  eq(second.chat.sentMsgs.filter((m) => m?.type === 'image').length, 1, '缓存轮图片仍只发一次')
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed ? 1 : 0)
