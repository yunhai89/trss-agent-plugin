/**
 * 长任务稳定性回归套件（state machine / 预算 / 超时取消 / 并发 / 终态可观测）。
 * 运行：node model/agent/stability.test.mjs （无需联网 / API Key）
 *
 * 覆盖（对应审计 P0/P1 清单）：
 *  1. 旁白 + tool_calls + token_budget：旁白不得成为最终答案（复现一）
 *  2. 反思否决的草稿永不交付（复现二）
 *  3. 六种异常停止（max_turns/token/time/duplicate/no_progress/consecutive_failures）必进无工具 finalizer
 *  4. finalizer 输出写入 session 且等于 run().content
 *  5. finalizer 自身失败 → 代码生成的确定性兜底（非空/含步骤/含继续指引）
 *  6/7. 成功与错误响应体卡死都会被超时中止（复现三）
 *  8. caller abort 能中止 provider / terminal / 异步工具；deadline 主动取消 + 收尾宽限
 *  9. 任务级 timer 清理（不悬挂）
 *  10. contextWindow 配置真实进入 token 压缩路径（epoch 递增/首条意图保留/配对完整/压后低于高水位）
 *  11. 进度/回复 rejection 不产生 unhandledRejection（ReplySender）
 *  12. 同会话并发不丢历史（SessionStore 锁）+ 运行队列串行/跨会话并发
 *  13. 12 步长任务完成；预算不足时交付真总结而非旁白
 *  14. trigger→终态一致性检查器（reply_sent/reply_failed/cancelled/run_error 唯一）
 *  15. 正常路径"旁白+工具"消息形态与持久化一致
 */
import { Agent, ToolRegistry, memoryKv, SessionStore } from './index.js'
import { ReplySender, createRunQueues } from './reply-sender.js'
import { requestWithRetry } from '../openai/transport.js'
import { TimeoutError, createClient, presets as openaiPresets } from '../openai/index.js'
import { runShell } from '../terminal/exec.js'
import { parseDevLog, checkConsistency } from '../../scripts/check-trace-consistency.mjs'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)})`}`)
}
async function test(name, fn) {
  console.log(`\n[${name}]`)
  try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
/** 竞态守护：promise 在 guardMs 内未决则判悬挂（用于证明"卡死"类缺陷） */
async function noHang(promise, guardMs, msg) {
  let fired = false
  const guard = delay(guardMs).then(() => { if (!fired) throw new Error(`悬挂：${msg}（${guardMs}ms 未决）`) })
  try { return await Promise.race([promise, guard]) } finally { fired = true }
}

// ---------- scripted provider：按脚本逐次返回，可悬挂/抛错/记录 tools/tool_choice/signal ----------
function scriptedProvider(script, { onCall } = {}) {
  let i = 0
  const calls = []
  const provider = {
    calls,
    async chat(opts) {
      calls.push({
        n: calls.length + 1,
        tools: opts.tools,
        tool_choice: opts.tool_choice,
        messages: JSON.parse(JSON.stringify(opts.messages)),
        system: opts.system,
        signal: opts.signal,
      })
      onCall?.(calls[calls.length - 1], opts)
      const r = script[Math.min(i, script.length - 1)]
      i++
      if (r.hang) {
        return new Promise((_, rej) => {
          if (opts.signal?.aborted) return rej(new Error('AbortError'))
          opts.signal?.addEventListener('abort', () => rej(new Error('AbortError')), { once: true })
        })
      }
      if (r.throwErr) throw r.throwErr
      return {
        role: 'assistant',
        content: r.content ?? '',
        toolCalls: r.toolCalls || [],
        reasoning: null,
        finishReason: r.finishReason || (r.toolCalls?.length ? 'tool_calls' : 'stop'),
        usage: r.usage || null,
        rawMessage: {},
      }
    },
  }
  return provider
}

const stepTool = {
  name: 'step',
  description: '推进一步',
  parameters: { type: 'object', properties: { i: { type: 'number' } } },
  async execute(p) { return { ok: true, result: 'r' + (p.i ?? 0) } },
}

// ============================================================
// 1. 复现一：旁白 + tool_calls + token_budget
// ============================================================
await test('旁白+tool_calls+token_budget：旁白不得成为最终答案（复现一）', async () => {
  const FINAL = '总结：已完成的进展、遇到的问题与下一步建议。'
  const provider = scriptedProvider([
    { content: '我先处理，马上继续。', toolCalls: [{ id: 'c1', name: 'step', arguments: { i: 1 } }], usage: { prompt_tokens: 70000, completion_tokens: 500 } },
    { content: FINAL, finishReason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 50 } }, // finalizer 调用
  ])
  const tools = new ToolRegistry().register(stepTool)
  const agent = new Agent({
    provider, tools, maxTurns: 10, reflect: 'off',
    loop: { maxSameAction: 99, maxConsecutiveFailures: 99, noProgressWindow: 99, timeBudgetMs: 0, tokenBudget: 65000 },
  })
  const res = await agent.run('长任务')
  eq(res.stopReason, 'token_budget', 'stopReason=token_budget')
  eq(res.content, FINAL, '最终回复是 finalizer 总结，不是旁白"我先处理，马上继续。"')
  const last = res.messages[res.messages.length - 1]
  eq(last.role, 'assistant', '消息历史最后一条是 assistant（不是 tool）')
  eq(last.content, FINAL, '历史末条 assistant 即最终答案')
  eq(provider.calls[1].tools, undefined, 'finalizer 调用不带工具（tools:undefined）')
  eq(provider.calls[1].tool_choice, 'none', 'finalizer 用 tool_choice:"none"')
  ok(!res.content.includes('我先处理'), '旁白文本不出现在最终回复')
})

// ============================================================
// 2. 复现二：反思否决的草稿永不交付
// ============================================================
await test('反思否决草稿：revise 后的旧草稿不可能再次出现（复现二）', async () => {
  const FINAL = '修正后的完整结论：数据与来源已核对。'
  const provider = scriptedProvider([
    { content: '被否决的草稿A', finishReason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 30 } }, // 草稿
    { content: '{"revise":true}\n缺少结论部分', finishReason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 20 } }, // reflect 判 revise
    { toolCalls: [{ id: 'c1', name: 'step', arguments: { i: 1 } }], usage: { prompt_tokens: 70000, completion_tokens: 400 } }, // 回环后调工具（无旁白）→ token_budget
    { content: FINAL, finishReason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 50 } }, // finalizer
  ])
  const tools = new ToolRegistry().register(stepTool)
  const agent = new Agent({
    provider, tools, maxTurns: 10, reflect: 'always', reflectMaxIterations: 1,
    loop: { maxSameAction: 99, maxConsecutiveFailures: 99, noProgressWindow: 99, timeBudgetMs: 0, tokenBudget: 65000 },
  })
  const res = await agent.run('写结论')
  eq(res.stopReason, 'token_budget', 'stopReason=token_budget')
  ok(res.content !== '被否决的草稿A', '被 reflection 否决并 pop 的草稿不作为 result.content 返回')
  eq(res.content, FINAL, '交付 finalizer 修正后的总结')
  ok(!res.messages.some((m) => m.content === '被否决的草稿A'), 'messages 中不存在被否决草稿')
  eq(res.messages[res.messages.length - 1].content, FINAL, '历史末条为最终答案')
})

// ============================================================
// 3. 六种异常停止必进 finalizer（无工具 + tool_choice none + 入历史）
// ============================================================
const abnormalCases = [
  {
    name: 'max_turns（无 governor 也收尾）',
    loop: undefined, maxTurns: 2,
    script: [
      { toolCalls: [{ id: 'c1', name: 'step', arguments: { i: 1 } }] },
      { toolCalls: [{ id: 'c2', name: 'step', arguments: { i: 2 } }] },
    ],
    expect: 'max_turns',
  },
  {
    name: 'duplicate_action',
    loop: { maxSameAction: 1, maxConsecutiveFailures: 99, noProgressWindow: 99, timeBudgetMs: 0, tokenBudget: 0 }, maxTurns: 10,
    script: [
      { toolCalls: [{ id: 'c1', name: 'step', arguments: { i: 1 } }] },
      { toolCalls: [{ id: 'c2', name: 'step', arguments: { i: 1 } }] },
    ],
    expect: 'duplicate_action',
  },
  {
    name: 'consecutive_failures',
    loop: { maxSameAction: 99, maxConsecutiveFailures: 2, noProgressWindow: 99, timeBudgetMs: 0, tokenBudget: 0 }, maxTurns: 10,
    script: [
      { toolCalls: [{ id: 'c1', name: 'boom', arguments: {} }] },
      { toolCalls: [{ id: 'c2', name: 'boom', arguments: {} }] },
    ],
    expect: 'consecutive_failures',
  },
  {
    name: 'no_progress',
    loop: { maxSameAction: 99, maxConsecutiveFailures: 99, noProgressWindow: 3, timeBudgetMs: 0, tokenBudget: 0 }, maxTurns: 10,
    script: [0, 1, 2, 3].map((i) => ({ toolCalls: [{ id: 'c' + i, name: 'stuck', arguments: { q: 'same' } }] })),
    expect: 'no_progress',
  },
  {
    name: 'token_budget',
    loop: { maxSameAction: 99, maxConsecutiveFailures: 99, noProgressWindow: 99, timeBudgetMs: 0, tokenBudget: 65000 }, maxTurns: 10,
    script: [{ toolCalls: [{ id: 'c1', name: 'step', arguments: { i: 1 } }], usage: { prompt_tokens: 70000, completion_tokens: 100 } }],
    expect: 'token_budget',
  },
]
for (const c of abnormalCases) {
  await test(`异常停止[${c.name}] → 无工具 finalizer + 输出入历史`, async () => {
    const FINAL = '收尾交付：进展与下一步。'
    const script = [...c.script, { content: FINAL, finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5 } }]
    const provider = scriptedProvider(script)
    const tools = new ToolRegistry().register(stepTool, {
      name: 'boom', description: '总是失败', parameters: { type: 'object' },
      async execute() { throw new Error('explosion') },
    }, {
      name: 'stuck', description: '总返回同一结果', parameters: { type: 'object' },
      async execute() { return { ok: true, v: 1 } },
    })
    const agent = new Agent({ provider, tools, maxTurns: c.maxTurns, reflect: 'off', loop: c.loop })
    const res = await agent.run('任务')
    eq(res.stopReason, c.expect, `stopReason=${c.expect}`)
    eq(res.content, FINAL, 'finalizer 总结成为最终回复（非空、非旁白）')
    const last = res.messages[res.messages.length - 1]
    eq(last.role, 'assistant', '历史末条是 assistant')
    eq(last.content, FINAL, 'finalizer 输出已追加为最终 assistant 消息')
    const finCall = provider.calls[provider.calls.length - 1]
    eq(finCall.tools, undefined, 'finalizer 请求 tools:undefined')
    eq(finCall.tool_choice, 'none', 'finalizer 请求 tool_choice:"none"')
  })
}
await test('异常停止[time_budget（注入时钟）] → 无工具 finalizer', async () => {
  const FINAL = '时间到，先交付进展。'
  let t = 0
  const provider = scriptedProvider([
    { toolCalls: [{ id: 'c1', name: 'step', arguments: { i: 1 } }] },
    { toolCalls: [{ id: 'c2', name: 'step', arguments: { i: 2 } }] },
    { toolCalls: [{ id: 'c3', name: 'step', arguments: { i: 3 } }] },
    { content: FINAL, finishReason: 'stop' },
  ], { onCall: () => { t += 500 } })
  const tools = new ToolRegistry().register(stepTool)
  const agent = new Agent({
    provider, tools, maxTurns: 10, reflect: 'off',
    loop: { maxSameAction: 99, maxConsecutiveFailures: 99, noProgressWindow: 99, timeBudgetMs: 1000, tokenBudget: 0, now: () => t },
  })
  const res = await agent.run('任务')
  eq(res.stopReason, 'time_budget', 'stopReason=time_budget')
  eq(res.content, FINAL, 'finalizer 交付总结')
  eq(res.messages[res.messages.length - 1].content, FINAL, '总结入历史')
})

// ============================================================
// 4. finalizer 输出写入 session，且等于 run().content
// ============================================================
await test('finalizer 输出持久化进 session 且等于 run().content', async () => {
  const kv = memoryKv()
  const session = new SessionStore({ kv })
  await session.createConversation('u1', null, '会话一')
  const FINAL = '预算内没做完，这是进展总结。'
  const provider = scriptedProvider([
    { content: '旁白：正在处理', toolCalls: [{ id: 'c1', name: 'step', arguments: { i: 1 } }], usage: { prompt_tokens: 70000, completion_tokens: 100 } },
    { content: FINAL, finishReason: 'stop' },
  ])
  const tools = new ToolRegistry().register(stepTool)
  const agent = new Agent({
    provider, tools, session, maxTurns: 10, reflect: 'off',
    loop: { maxSameAction: 99, maxConsecutiveFailures: 99, noProgressWindow: 99, timeBudgetMs: 0, tokenBudget: 65000 },
  })
  const res = await agent.run('任务', { ctx: { userId: 'u1', groupId: null, scopeUserId: 'u1', conversationId: '1' } })
  const hist = await session.getConversation('u1', null, '1')
  const lastAssistant = [...hist].reverse().find((m) => m.role === 'assistant')
  eq(lastAssistant.content, FINAL, '持久化历史的最后一条 assistant 是 finalizer 总结')
  eq(res.content, lastAssistant.content, 'run().content 与持久化历史一致')
})

// ============================================================
// 5. finalizer 自身失败 → 确定性兜底
// ============================================================
await test('finalizer 失败/空输出 → 代码生成确定性兜底（非空、含步骤、含继续指引）', async () => {
  const mk = (finalizerBehavior) => {
    const provider = scriptedProvider([
      { content: '旁白X：正在检索', toolCalls: [{ id: 'c1', name: 'step', arguments: { i: 3 } }], usage: { prompt_tokens: 70000, completion_tokens: 100 } },
      finalizerBehavior,
    ])
    const tools = new ToolRegistry().register(stepTool)
    const agent = new Agent({
      provider, tools, maxTurns: 10, reflect: 'off',
      loop: { maxSameAction: 99, maxConsecutiveFailures: 99, noProgressWindow: 99, timeBudgetMs: 0, tokenBudget: 65000 },
    })
    return agent.run('任务')
  }
  for (const [label, behavior] of [['抛错', { throwErr: new Error('finalizer boom') }], ['空输出', { content: '', finishReason: 'stop' }]]) {
    const res = await mk(behavior)
    ok(res.content && res.content.length > 20, `[${label}] 兜底非空（len=${res.content.length}）`)
    ok(res.content.includes('工具'), `[${label}] 包含已完成步骤说明`)
    ok(/继续|接着/.test(res.content), `[${label}] 包含用户如何继续的指引`)
    ok(res.content.includes('token') || res.content.includes('预算'), `[${label}] 说明为什么停止`)
    ok(!res.content.includes('旁白X'), `[${label}] 兜底不含中间旁白`)
    eq(res.messages[res.messages.length - 1].content, res.content, `[${label}] 兜底入历史且与返回一致`)
    eq(res.stopReason, 'token_budget', `[${label}] stopReason 保留`)
  }
})

// ============================================================
// 6/7. 复现三：响应体卡死必须被超时中止
// ============================================================
function hangingBodyFetcher({ ok = true, status = 200 } = {}) {
  return (url, opts) => Promise.resolve({
    ok, status,
    headers: { get: () => null },
    text: () => new Promise((_, rej) => {
      opts.signal?.addEventListener('abort', () => rej(new Error('AbortError')), { once: true })
    }),
  })
}
await test('成功响应 headers 已回但 body 卡死 → TimeoutError（复现三）', async () => {
  const p = requestWithRetry({
    url: 'https://x.test/v1/chat', method: 'POST', headers: {}, body: {},
    fetcher: hangingBodyFetcher({ ok: true, status: 200 }),
    timeout: 150, maxRetries: 0,
  })
  let err = null
  try { await noHang(p, 2500, '成功响应 body 读取未被超时中止') } catch (e) { err = e }
  ok(err instanceof TimeoutError, `抛 TimeoutError（实际 ${err?.constructor?.name}: ${err?.message}）`)
})
await test('错误响应 body 卡死 → 同样 TimeoutError', async () => {
  const p = requestWithRetry({
    url: 'https://x.test/v1/chat', method: 'POST', headers: {}, body: {},
    fetcher: hangingBodyFetcher({ ok: false, status: 500 }),
    timeout: 150, maxRetries: 0,
  })
  let err = null
  try { await noHang(p, 2500, '错误响应 body 读取未被超时中止') } catch (e) { err = e }
  ok(err instanceof TimeoutError, `抛 TimeoutError（实际 ${err?.constructor?.name}: ${err?.message}）`)
})

// ============================================================
// 8. caller abort / deadline 主动取消
// ============================================================
await test('caller abort 中止 provider 请求（signal 透传 fetch）', async () => {
  const fetcher = (url, opts) => new Promise((_, rej) => {
    opts.signal?.addEventListener('abort', () => rej(new Error('This operation was aborted')), { once: true })
  })
  const client = createClient({ ...openaiPresets.openai, apiKey: 'k', fetch: fetcher })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 60)
  let err = null
  try { await noHang(client.create({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] }, { signal: ac.signal }), 3000, 'provider 请求未响应 abort') }
  catch (e) { err = e }
  ok(/abort/i.test(err?.message || ''), `请求被中止（${err?.message}）`)
})

await test('terminal：abort 杀掉子进程（runShell 支持 signal）', async () => {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 80)
  const r = await noHang(runShell('sleep 4.7', { timeout: 30, signal: ac.signal }), 3000, 'terminal 未响应 abort')
  eq(r.ok, false, 'abort 后 ok=false')
  ok(r.duration < 2500, `快速返回（duration=${r.duration}ms）而非等满超时`)
  // 无悬挂子进程：稍等后 pgrep 不应再见到该 sleep
  await delay(250)
  let leftover = false
  try {
    const { execSync } = await import('node:child_process')
    // 正则里加 [.]：避免 pgrep -f 匹配到 execSync 外壳 sh -c '...' 自身的命令行（自匹配假阳性）
    execSync('pgrep -f "sleep 4[.]7" >/dev/null 2>&1')
    leftover = true
  } catch { /* pgrep 无匹配=已清理（pgrep 不存在也走这里，保守通过） */ }
  ok(!leftover, '子进程已被清理（无悬挂 sleep）')
})

await test('工具拿到合并 ctx 的 signal；abort 中止异步工具后 run 干净退出', async () => {
  let sawSignal = null
  const hangTool = {
    name: 'hangtool', description: '挂起直到 abort', parameters: { type: 'object' },
    async execute(_p, tctx) {
      sawSignal = tctx?.signal || null
      return await new Promise((_, rej) => {
        if (tctx?.signal?.aborted) return rej(new Error('tool aborted'))
        tctx?.signal?.addEventListener('abort', () => rej(new Error('tool aborted')), { once: true })
      })
    },
  }
  const provider = scriptedProvider([
    { toolCalls: [{ id: 'c1', name: 'hangtool', arguments: {} }] },
    { content: 'final', finishReason: 'stop' },
  ])
  const tools = new ToolRegistry().register(hangTool)
  const agent = new Agent({ provider, tools, maxTurns: 5, reflect: 'off' })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 60)
  let err = null
  try { await noHang(agent.run('任务', { signal: ac.signal, ctx: { userId: 'u1', role: 'member', isMaster: false } }), 3000, 'run 未响应 abort') }
  catch (e) { err = e }
  ok(!!sawSignal, '工具收到 ExecutionContext.signal（生产路径 ctx 存在时也合并传入）')
  ok(/aborted/i.test(err?.message || ''), `run 以 aborted 退出（${err?.message}）`)
})

await test('deadline 主动取消在途模型调用 + 独立宽限完成收尾', async () => {
  const FINAL = '时间预算耗尽后的收尾总结。'
  const provider = scriptedProvider([
    { hang: true }, // 第 1 次调用悬挂 → workTimer 到点 abort
    { content: FINAL, finishReason: 'stop' }, // finalizer（宽限期内正常返回）
  ])
  const tools = new ToolRegistry().register(stepTool)
  const agent = new Agent({
    provider, tools, maxTurns: 5, reflect: 'off',
    loop: { maxSameAction: 99, maxConsecutiveFailures: 99, noProgressWindow: 99, timeBudgetMs: 120, tokenBudget: 0 },
  })
  const res = await noHang(agent.run('任务'), 5000, 'deadline 后 run 悬挂（收尾未在宽限内完成）')
  eq(res.stopReason, 'time_budget', 'stopReason=time_budget')
  eq(res.content, FINAL, '宽限期内完成收尾总结')
  eq(provider.calls[1].tools, undefined, '收尾调用无工具')
  ok(res.messages[res.messages.length - 1].role === 'assistant', '收尾输出入历史')
})

// ============================================================
// 9. timer 清理（不悬挂）
// ============================================================
await test('任务级 timer 清理：run 结束后不留活动 Timeout', async () => {
  const countTimeouts = () => (process.getActiveResourcesInfo ? process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length : 0)
  const provider = scriptedProvider([{ content: 'ok', finishReason: 'stop' }])
  const agent = new Agent({
    provider, maxTurns: 3, reflect: 'off',
    loop: { maxSameAction: 99, maxConsecutiveFailures: 99, noProgressWindow: 99, timeBudgetMs: 30000, tokenBudget: 0 },
  })
  const before = countTimeouts()
  await agent.run('hi')
  await delay(120)
  const after = countTimeouts()
  ok(after <= before, `无残留 Timeout（before=${before}, after=${after}；本测试文件若悬挂退出也可被运行器 180s 超时捕获）`)
})

// ============================================================
// 10. contextWindow → token 压缩路径
// ============================================================
await test('contextWindow 配置进入 token 压缩：epoch 递增/首条意图保留/配对完整/压后低于高水位', async () => {
  const kv = memoryKv()
  const session = new SessionStore({ kv })
  await session.createConversation('u1', null, 'c1')
  const long = '这是用于撑大 token 估算的长内容。'.repeat(60) // ~960 字 ≈ 240 token
  let turn = 0
  const provider = {
    async chat() {
      turn++
      if (turn % 2 === 1) return { content: '旁白' + turn, toolCalls: [{ id: 'c' + turn, name: 'step', arguments: { i: turn } }], finishReason: 'tool_calls', usage: { prompt_tokens: 5, completion_tokens: 1 } }
      return { content: '回复' + turn, finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 } }
    },
  }
  const tools = new ToolRegistry().register(stepTool)
  const agent = new Agent({
    provider, tools, session, maxTurns: 5, reflect: 'off',
    contextWindow: 1600, contextKeepRecent: 4,
  })
  const pressures = [] // 每次压缩后立即采样 messages token（应 ≤ 高水位）
  const high = Math.floor(1600 * 0.65)
  const epochs = []
  for (let i = 1; i <= 5; i++) {
    await agent.run(`问题${i} ${long}`, {
      ctx: { userId: 'u1', groupId: null, scopeUserId: 'u1', conversationId: '1' },
      systemPrompt: '短身份',
      onContextPressure: () => pressures.push(agent._estimateMessagesTokens()),
    })
    epochs.push((await session.getConversationState('u1', null, '1')).cacheEpoch || 0)
  }
  ok(epochs[epochs.length - 1] >= 1, `发生 token 水位压缩（最终 cacheEpoch=${epochs[epochs.length - 1]}；5 轮×4 条=20 条消息不触消息数水位 30，只有 token 路径会压）`)
  ok(pressures.length >= 1, `至少一次压缩回调（${pressures.length}）`)
  ok(pressures.every((p) => p <= high), `每次压缩后 messages token ≤ 高水位 ${high}（实际 ${JSON.stringify(pressures)}）`)
  const hist = await session.getConversation('u1', null, '1')
  ok(String(hist[0]?.content || '').includes('问题1'), '首条用户意图保留（含"问题1"）')
  const callIds = new Set()
  for (const m of hist) for (const tc of m.tool_calls || []) callIds.add(tc.id)
  ok(hist.filter((m) => m.role === 'tool').every((m) => callIds.has(m.tool_call_id)), 'tool_call/tool_result 配对完整（无孤立 tool）')
})

// ============================================================
// 11. ReplySender：rejection 不产生 unhandledRejection
// ============================================================
await test('进度/回复 rejection 不产生 unhandledRejection（受控串行队列）', async () => {
  let unhandled = 0
  const onUn = () => { unhandled++ }
  process.on('unhandledRejection', onUn)
  try {
    const order = []
    const sender = new ReplySender({
      send: async (p) => {
        order.push(p)
        if (p === 'boom') throw new Error('adapter exploded')
        if (p === 'retcode') return { retcode: 1, msg: 'send fail' }
        return { retcode: 0, mid: 'id-' + order.length }
      },
    })
    sender.enqueue('a') // fire-and-forget
    sender.enqueue('boom')
    sender.enqueue('retcode')
    const final = await sender.enqueue('FINAL', { tag: 'final' })
    const outcomes = await sender.flush()
    eq(order.join(','), 'a,boom,retcode,FINAL', '串行按入队顺序发送')
    eq(outcomes.length, 4, '4 条发送结果被记录')
    eq(outcomes[0].ok, true, '成功发送 ok=true（含适配器返回值）')
    eq(outcomes[1].ok, false, 'throw 归一为 ok=false（无 unhandledRejection）')
    eq(outcomes[2].ok, false, 'retcode!=0 归一为 ok=false')
    eq(final.ok, true, 'await 最终回复得到 outcome（永不 reject）')
    await delay(30)
    eq(unhandled, 0, '零 unhandledRejection')
  } finally {
    process.off('unhandledRejection', onUn)
  }
})

// ============================================================
// 12. 并发：session 锁 + 运行队列
// ============================================================
/** redis 同构 KV：真实异步边界 + 每次读写深拷贝（redis 的 JSON 序列化语义）。
 *  memoryKv 返回共享引用，会掩盖读改写竞态（并发 mutate 同一对象碰巧"看起来没丢"）——
 *  必须用本包装才能复现生产 redis 下的丢失更新。 */
function asyncBoundaryKv(inner) {
  const copy = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)))
  return {
    get: async (k) => { await delay(2); return copy(await inner.get(k)) },
    set: async (k, v, ttl) => { await delay(2); return inner.set(k, copy(v), ttl) },
    del: async (k) => { await delay(1); return inner.del(k) },
    scan: async (p) => { await delay(1); return inner.scan(p) },
  }
}

await test('同会话并发 append 不丢消息（SessionStore 每键写锁）', async () => {
  const kv = asyncBoundaryKv(memoryKv())
  const s = new SessionStore({ kv })
  await s.createConversation('u1', null, '1')
  await Promise.all(Array.from({ length: 12 }, (_, i) => s.appendConversation('u1', null, '1', [{ role: 'user', content: 'm' + i }])))
  const got = await s.getConversation('u1', null, '1')
  eq(got.length, 12, `12 条并发追加全部持久化（实际 ${got.length}）`)
  eq(new Set(got.map((m) => m.content)).size, 12, '无覆盖/去重（12 条唯一）')
})

await test('同 conversation 并发 Agent run 不丢历史（读改写经锁串行）', async () => {
  const kv = asyncBoundaryKv(memoryKv())
  const session = new SessionStore({ kv })
  await session.createConversation('u1', null, '1')
  const mkAgent = (tag) => {
    const provider = scriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'step', arguments: { i: 1 } }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      { content: '最终' + tag, finishReason: 'stop' },
    ])
    return new Agent({ provider, tools: new ToolRegistry().register(stepTool), session, maxTurns: 5, reflect: 'off' })
  }
  await Promise.all([
    mkAgent('A').run('问题A', { ctx: { userId: 'u1', groupId: null, scopeUserId: 'u1', conversationId: '1' } }),
    mkAgent('B').run('问题B', { ctx: { userId: 'u1', groupId: null, scopeUserId: 'u1', conversationId: '1' } }),
  ])
  const hist = await session.getConversation('u1', null, '1')
  const texts = hist.map((m) => String(m.content || ''))
  ok(texts.some((t) => t.includes('问题A')), 'A 的 user 消息在历史')
  ok(texts.some((t) => t.includes('问题B')), 'B 的 user 消息在历史')
  ok(texts.some((t) => t === '最终A'), 'A 的最终回复在历史')
  ok(texts.some((t) => t === '最终B'), 'B 的最终回复在历史')
})

await test('运行队列：同会话串行、跨会话并发', async () => {
  const q = createRunQueues()
  const events = []
  const track = async (tag, ms) => {
    events.push(`start:${tag}`)
    await delay(ms)
    events.push(`end:${tag}`)
    return tag
  }
  const k1a = q.run('conv1', () => track('a', 60))
  const k1b = q.run('conv1', () => track('b', 30))
  const k2 = q.run('conv2', () => track('c', 30))
  eq(q.depth('conv1'), 2, '同会话 2 个任务排队（depth=2）')
  const [a, b, c] = await Promise.all([k1a, k1b, k2])
  eq([a, b, c].join(','), 'a,b,c', '返回值透传')
  const s = events.join(',')
  ok(s.indexOf('start:a') < s.indexOf('end:a') && s.indexOf('end:a') < s.indexOf('start:b'), `同会话串行（${s}）`)
  ok(s.indexOf('start:c') < s.indexOf('end:a'), '跨会话并发（c 与 a 同时在飞）')
  eq(q.depth('conv1'), 0, '完成后队列清空')
  // fn 抛错也释放队列且错误传播
  let threw = null
  try { await q.run('convE', () => Promise.reject(new Error('boom'))) } catch (e) { threw = e }
  ok(/boom/.test(threw?.message || ''), '错误原样传播')
  eq(q.depth('convE'), 0, '出错后队列释放')
  const after = await q.run('convE', () => 'next')
  eq(after, 'next', '出错后后续任务可继续')
})

// ============================================================
// 13. 长任务：完成 or 真总结
// ============================================================
await test('12 步长任务（每步带旁白）能完成，最终回复非旁白', async () => {
  const FINAL = '全部 12 步已完成，这是最终报告。'
  const script = []
  for (let i = 1; i <= 12; i++) {
    script.push({ content: `第${i}步旁白`, toolCalls: [{ id: 'c' + i, name: 'step', arguments: { i } }], usage: { prompt_tokens: 15000, completion_tokens: 200 } })
  }
  script.push({ content: FINAL, finishReason: 'stop', usage: { prompt_tokens: 15000, completion_tokens: 300 } })
  let exec = 0
  const provider = scriptedProvider(script)
  const tools = new ToolRegistry().register({ ...stepTool, async execute(p) { exec++; return { ok: true, result: 'r' + p.i } } })
  const agent = new Agent({
    provider, tools, maxTurns: 30, reflect: 'off',
    loop: { maxSameAction: 99, maxConsecutiveFailures: 99, noProgressWindow: 99, timeBudgetMs: 0, tokenBudget: 240000 },
  })
  const res = await agent.run('做完整件事')
  eq(exec, 12, '12 次工具全部执行')
  eq(res.stopReason, 'stop', '自然完成（stop）')
  eq(res.content, FINAL, '最终回复是最终报告（不是任何一步旁白）')
})

await test('预算不足的长任务：交付真总结而非"我接下来会…"', async () => {
  const FINAL = '长任务预算总结：已完成的部分与剩余步骤如下，下次可继续。'
  let toolTurn = 0
  const provider = {
    async chat(opts) {
      if (opts.tool_choice === 'none') return { content: FINAL, toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 60 } }
      toolTurn++
      return { content: `第${toolTurn}步旁白：我接下来继续处理`, toolCalls: [{ id: 'c' + toolTurn, name: 'step', arguments: { i: toolTurn } }], finishReason: 'tool_calls', usage: { prompt_tokens: 15000, completion_tokens: 200 } }
    },
  }
  const tools = new ToolRegistry().register(stepTool)
  const agent = new Agent({
    provider, tools, maxTurns: 30, reflect: 'off',
    loop: { maxSameAction: 99, maxConsecutiveFailures: 99, noProgressWindow: 99, timeBudgetMs: 0, tokenBudget: 62000 },
  })
  const res = await agent.run('做完整件事')
  eq(res.stopReason, 'token_budget', '预算耗尽停止（预检在超支轮之前拦下）')
  eq(res.content, FINAL, '用户收到真总结')
  ok(!/接下来/.test(res.content), '不是"我接下来会…"式的旁白')
  ok(toolTurn >= 3, `执行了多步才停（${toolTurn} 步）`)
})

// ============================================================
// 14. trigger → 唯一终态 一致性检查器
// ============================================================
await test('离线一致性检查：找无终态/多终态/孤儿终态 trace', async () => {
  const mkEv = (event, traceId, extra = {}) => JSON.stringify({ level: 'info', time: '2026-08-18T00:00:00Z', event, traceId, ...extra })
  const good = [
    mkEv('trigger', 't-good'),
    mkEv('turn', 't-good', { turn: 1, content: '包含 { 花括号 } 的字符串内容' }),
    mkEv('send_start', 't-good'),
    mkEv('reply_sent', 't-good', { delivered: true }),
  ].join('\n')
  const { events, malformed } = parseDevLog(good)
  eq(malformed, 0, '解析零坏段')
  eq(events.length, 4, '4 个事件（字符串内花括号不干扰切分）')
  eq(checkConsistency(events).problems.length, 0, '正常链路零问题')

  const noTerminal = [mkEv('trigger', 't-hang'), mkEv('turn', 't-hang')].join('\n')
  const p1 = checkConsistency(parseDevLog(noTerminal).events).problems
  ok(p1.some((x) => x.includes('t-hang') && x.includes('没有任何终态')), `识别无终态 trace（${p1}）`)

  const dupTerminal = [mkEv('trigger', 't-dup'), mkEv('reply_sent', 't-dup'), mkEv('reply_failed', 't-dup')].join('\n')
  const p2 = checkConsistency(parseDevLog(dupTerminal).events).problems
  ok(p2.some((x) => x.includes('t-dup') && x.includes('唯一')), `识别多终态 trace（${p2}）`)

  const orphan = [mkEv('reply_failed', 't-orphan')].join('\n')
  const p3 = checkConsistency(parseDevLog(orphan).events).problems
  ok(p3.some((x) => x.includes('t-orphan') && x.includes('孤儿')), '识别孤儿终态')
})

// ============================================================
// 15. 正常路径：旁白+工具的消息形态与持久化一致
// ============================================================
await test('正常多工具轮：旁白留在 assistant(tool_calls) 里，最终回复独占末条 assistant', async () => {
  const kv = memoryKv()
  const session = new SessionStore({ kv })
  await session.createConversation('u1', null, '1')
  const FINAL = '两步都完成了，结论如下。'
  const provider = scriptedProvider([
    { content: '先查第一步', toolCalls: [{ id: 'c1', name: 'step', arguments: { i: 1 } }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
    { content: '再查第二步', toolCalls: [{ id: 'c2', name: 'step', arguments: { i: 2 } }], usage: { prompt_tokens: 110, completion_tokens: 10 } },
    { content: FINAL, finishReason: 'stop', usage: { prompt_tokens: 120, completion_tokens: 30 } },
  ])
  const tools = new ToolRegistry().register(stepTool)
  const agent = new Agent({ provider, tools, session, maxTurns: 6, reflect: 'off' })
  const res = await agent.run('两步任务', { ctx: { userId: 'u1', groupId: null, scopeUserId: 'u1', conversationId: '1' } })
  eq(res.content, FINAL, '最终回复=最终文本')
  const roles = res.messages.map((m) => m.role).join(',')
  eq(roles, 'user,assistant,tool,assistant,tool,assistant', '消息序列合法')
  eq(res.messages[1].content, '先查第一步', '旁白保存在带 tool_calls 的 assistant 消息里（不丢失）')
  const hist = await session.getConversation('u1', null, '1')
  eq(hist[hist.length - 1].content, FINAL, '持久化末条 assistant=最终回复（与 run().content 一致）')
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
