/**
 * humanize 集成测试 —— Planner 工具循环 / 代取消 / shadow 端到端（指南 §19.2 集成场景）。
 * 用 mock provider 验证决策逻辑，不依赖真实 LLM。
 * 运行：node model/humanize/integration.test.mjs
 */
import { memoryKv } from '../agent/store/kv.js'
import { GroupRuntime } from './group-runtime.js'
import { MessageBuffer } from './message-buffer.js'
import { IdleBackoff } from './idle-backoff.js'
import { HumanizeStore, newHolderId } from './store.js'
import { Trace } from './trace.js'
import { HumanizePlanner } from './planner.js'
import { TurnScheduler } from './turn-scheduler.js'
import { validateHumanizeConfig } from './default-config.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** mock provider：按脚本队列返回 chat 结果。 */
function mockProvider(scripts) {
  const q = [...scripts]
  return {
    chat: async () => {
      const s = q.shift()
      if (!s) return { content: '', toolCalls: [], finishReason: 'stop', usage: null }
      if (typeof s === 'function') return s()
      return s
    },
  }
}

function mkCtx(overrides = {}) {
  const buffer = new MessageBuffer({ capacity: 50 })
  const store = new HumanizeStore({ kv: memoryKv() })
  const backoff = new IdleBackoff()
  const trace = new Trace()
  const runtime = new GroupRuntime({ groupId: 'g1', buffer, store, backoff, trace, holderId: newHolderId(), ...overrides })
  return { buffer, store, backoff, trace, runtime }
}

function mkMsg(text, extra = {}, id) {
  return {
    id: id || ('m_' + Math.random().toString(36).slice(2, 8)), groupId: 'g1', userId: 'u1',
    displayName: '甲', timestamp: Date.now(), text, segments: [{ type: 'text', text }],
    replyToId: null, atBot: false, mentionsBotName: false, quotesBot: false,
    isCommand: false, isSelf: false, handledByDirectAgent: false, media: [], ...extra,
  }
}

// ───────── Planner：工具循环 ─────────
await test('Planner：无工具 → ignore（永不发送 content）', async () => {
  const { runtime } = mkCtx()
  const provider = mockProvider([{ content: '我分析了一下，不该插话', toolCalls: [], finishReason: 'stop' }])
  const planner = new HumanizePlanner({ provider, cfg: () => ({ planner: { maxRounds: 4 } }) })
  const snapshot = [mkMsg('今天聊啥')]
  const action = await planner.decide({ snapshot, decision: { targetMessage: snapshot[0], finalScore: 85, threshold: 80 }, runtime, cfg: { planner: { maxRounds: 4 } } })
  ok(action.type === 'human_ignore' && action.reason === 'no_tool', '无工具 → ignore')
})

await test('Planner：human_reply 工具调用 → 返回 reply 动作', async () => {
  const { runtime } = mkCtx()
  const targetId = 't_reply'
  const provider = mockProvider([{
    content: '该回复',
    toolCalls: [{ id: 'c1', name: 'human_reply', arguments: { targetMessageId: targetId, replyGuide: '赞同并补充' } }],
    finishReason: 'tool_calls',
  }])
  const planner = new HumanizePlanner({ provider, cfg: () => ({ planner: { maxRounds: 4 } }) })
  const snapshot = [mkMsg('我觉得不错', { id: targetId })]
  const action = await planner.decide({ snapshot, decision: { targetMessage: snapshot[0] }, runtime, cfg: { planner: { maxRounds: 4 } } })
  ok(action.type === 'human_reply', '返回 reply 动作')
  ok(action.targetMessageId === targetId && action.replyGuide === '赞同并补充', '携带目标与意图')
})

await test('Planner：非法目标 → violation 后 ignore/丢弃', async () => {
  const { runtime } = mkCtx()
  const provider = mockProvider([{
    content: '回',
    toolCalls: [{ id: 'c1', name: 'human_reply', arguments: { targetMessageId: '不存在', replyGuide: 'x' } }],
    finishReason: 'tool_calls',
  }])
  const planner = new HumanizePlanner({ provider, cfg: () => ({ planner: { maxRounds: 4 } }) })
  const snapshot = [mkMsg('hi', { id: 'real1' })]
  const action = await planner.decide({ snapshot, decision: { targetMessage: snapshot[0] }, runtime, cfg: { planner: { maxRounds: 4 } } })
  // 非法目标 → pickSingleAction 返回 ignore（all_invalid）
  ok(action.type === 'human_ignore', '非法目标 → 不产生发送')
})

await test('Planner：只读工具回灌后继续，最终 reply', async () => {
  const { runtime } = mkCtx()
  let memCalled = false
  const provider = mockProvider([
    { content: '先查记忆', toolCalls: [{ id: 'r1', name: 'memory_search', arguments: { query: '群规' } }], finishReason: 'tool_calls' },
    { content: '查到了，回复', toolCalls: [{ id: 'c1', name: 'human_reply', arguments: { targetMessageId: 't2', replyGuide: '按群规' } }], finishReason: 'tool_calls' },
  ])
  const readTools = [{
    name: 'memory_search', description: '查记忆', parameters: { type: 'object', properties: { query: { type: 'string' } } },
    execute: async () => { memCalled = true; return '记忆：群规禁止刷屏' },
  }]
  const planner = new HumanizePlanner({ provider, cfg: () => ({ planner: { maxRounds: 4 } }), readTools })
  const snapshot = [mkMsg('群里能刷屏吗', { id: 't2' })]
  const action = await planner.decide({ snapshot, decision: { targetMessage: snapshot[0] }, runtime, cfg: { planner: { maxRounds: 4 } } })
  ok(memCalled === true, '只读工具被执行')
  ok(action.type === 'human_reply', '第二轮返回 reply')
})

// ───────── 代取消 ─────────
await test('GroupRuntime：单代 token，旧代结果丢弃', async () => {
  const { runtime } = mkCtx()
  const gen1 = runtime.beginPlanning('b1')
  ok(runtime.isCurrent(gen1) === true, 'gen1 当前')
  const gen2 = runtime.beginPlanning('b2')
  ok(gen2 > gen1, 'gen2 递增')
  ok(runtime.isCurrent(gen1) === false, 'gen1 不再当前')
  ok(runtime.isCurrent(gen2) === true, 'gen2 当前')
  runtime.abortPlanning('new_message')
  ok(runtime.signal?.aborted === true, 'signal 已中止')
})

// ───────── shadow 端到端 ─────────
await test('shadow 端到端：消息→门控→reply→只 trace 不实发', async () => {
  const { runtime, trace } = mkCtx()
  const cfg = () => validateHumanizeConfig({
    enable: true, groups: ['g1'], shadow: true, threshold: 80, talkValue: 0.35,
    debounceMs: 200, cooldownSeconds: 1, planner: { maxRounds: 2 }, replyer: { maxChars: 200 },
  }).config

  // planner 固定返回 reply；replyer 固定返回文本
  const targetId = 'at_target'
  const planner = { decide: async () => ({ type: 'human_reply', targetMessageId: targetId, replyGuide: '接话', quote: false, toolCallId: 'c1' }) }
  const replyer = { generate: async () => ({ text: '确实是这样哈哈' }) }
  const composer = { deliver: async () => ({ sentIds: ['sent1'], cancelled: false }) }
  let sentCount = 0
  const send = async () => { sentCount++; return 'sent_' + sentCount }

  const sched = new TurnScheduler({ runtime, cfg, planner, replyer, composer, send })
  // 强关联消息（mentionsBotName）→ 必触发门控
  await sched.onMessage(mkMsg('小猫你觉得呢', { mentionsBotName: true, id: targetId }))
  await sleep(350) // 等 debounce(5ms) + 规划 + replyer

  ok(sentCount === 0, 'shadow 模式：composer.deliver 未被调用 → 真实 send 0 次')
  const events = trace.recent({ limit: 50 })
  ok(events.some((e) => e.event === 'shadow_reply'), '记录了 shadow_reply')
  ok(runtime.cooldownUntil > Date.now(), '已进入冷却')
  ok(runtime.backoff.count === 0, 'reply 成功 → backoff 清零')
})

await test('端到端：shadow=false 时真实发送 + markSent + 记录回复', async () => {
  const { runtime, trace, store } = mkCtx()
  const cfg = () => validateHumanizeConfig({
    enable: true, groups: ['g1'], shadow: false, threshold: 80, talkValue: 0.35,
    debounceMs: 200, cooldownSeconds: 1, planner: { maxRounds: 2 }, replyer: { maxChars: 200 },
  }).config
  const targetId = 'at_target2'
  const planner = { decide: async () => ({ type: 'human_reply', targetMessageId: targetId, replyGuide: '接话', quote: false, toolCallId: 'c1' }) }
  const replyer = { generate: async () => ({ text: '好的' }) }
  const composer = { deliver: async () => ({ sentIds: ['real_sent_1'], cancelled: false }) }
  const send = async () => 'real_sent_1'
  const sched = new TurnScheduler({ runtime, cfg, planner, replyer, composer, send })
  await sched.onMessage(mkMsg('小猫来', { mentionsBotName: true, id: targetId }))
  await sleep(350)
  ok(await store.isSent('g1', targetId) === true, 'markSent 已记录（at-most-once）')
  ok(runtime.recentReplyTs.length >= 1, '记录了回复时间戳（频率计数）')
})

await test('端到端：普通无关消息不触发 Planner（规则先于 LLM）', async () => {
  const { runtime } = mkCtx()
  const cfg = () => validateHumanizeConfig({ enable: true, groups: ['g1'], shadow: true, threshold: 80, talkValue: 0.35, debounceMs: 200 }).config
  let plannerCalled = false
  const planner = { decide: async () => { plannerCalled = true; return { type: 'human_ignore' } } }
  const sched = new TurnScheduler({ runtime, cfg, planner, replyer: { generate: async () => ({ text: '' }) }, composer: { deliver: async () => ({ sentIds: [] }) }, send: async () => null })
  await sched.onMessage(mkMsg('哈哈')) // 极短反应 -25，普通无关
  await sleep(350)
  ok(plannerCalled === false, '普通无关消息未进 Planner')
})

await test('端到端：handledByDirectAgent 消息不触发', async () => {
  const { runtime } = mkCtx()
  const cfg = () => validateHumanizeConfig({ enable: true, groups: ['g1'], shadow: true, debounceMs: 200 }).config
  let plannerCalled = false
  const planner = { decide: async () => { plannerCalled = true; return { type: 'human_ignore' } } }
  const sched = new TurnScheduler({ runtime, cfg, planner, replyer: { generate: async () => ({ text: '' }) }, composer: { deliver: async () => ({ sentIds: [] }) }, send: async () => null })
  await sched.onMessage(mkMsg('@bot 帮我', { atBot: true, handledByDirectAgent: true }))
  await sleep(350)
  ok(plannerCalled === false, '@消息（Direct 接管）不触发环境模式')
})

// ───────── P0 回归：晚到的 planner 结果（Provider 忽略 AbortSignal）不能发送 ─────────
await test('P0：cancelAll 后晚到的 planner 结果不发送（代兜底）', async () => {
  const { runtime } = mkCtx()
  const cfg = () => validateHumanizeConfig({
    enable: true, groups: ['g1'], shadow: false, threshold: 80, talkValue: 0.35,
    debounceMs: 200, cooldownSeconds: 1, planner: { maxRounds: 2 }, replyer: { maxChars: 200 },
  }).config
  // planner.decide 挂起，直到外部手动 resolve（模拟 Provider 忽略 abort、晚返回）
  let resolvePlanner = null
  const planner = {
    decide: () => new Promise((res) => { resolvePlanner = () => res({ type: 'human_reply', targetMessageId: 'late_t', replyGuide: 'g', quote: false, toolCallId: 'c1' }) }),
  }
  let composerDelivered = false
  const replyer = { generate: async () => ({ text: '晚到的回复' }) }
  const composer = { deliver: async () => { composerDelivered = true; return { sentIds: ['late'], cancelled: false } } }
  const send = async () => 'late_sent'
  const sched = new TurnScheduler({ runtime, cfg, planner, replyer, composer, send })

  await sched.onMessage(mkMsg('小猫你觉得呢', { mentionsBotName: true, id: 'late_t' }))
  await sleep(320) // 等 debounce(200ms) → 进 planner.decide（挂起中）
  // 此时 planner 正挂起；模拟配置热重载关闭 / 新消息取消：cancelAll 应 bump 代
  runtime.cancelAll('test_cancel')
  ok(resolvePlanner != null, 'planner.decide 已挂起')
  // 模拟 Provider 忽略 abort 信号、晚返回结果
  resolvePlanner()
  await sleep(60)
  ok(composerDelivered === false, 'cancelAll 后晚到的 planner 结果被代兜底丢弃，不发送（P0）')
})

await test('P0：新消息中断规划后，旧代结果不发送', async () => {
  const { runtime } = mkCtx()
  const cfg = () => validateHumanizeConfig({
    enable: true, groups: ['g1'], shadow: false, threshold: 80, talkValue: 0.35,
    debounceMs: 200, cooldownSeconds: 1, planner: { maxRounds: 2 }, replyer: { maxChars: 200 },
  }).config
  let resolvePlanner = null
  const planner = {
    decide: () => new Promise((res) => { resolvePlanner = () => res({ type: 'human_reply', targetMessageId: 'm1', replyGuide: 'g', quote: false, toolCallId: 'c1' }) }),
  }
  let composerDelivered = false
  const composer = { deliver: async () => { composerDelivered = true; return { sentIds: ['x'], cancelled: false } } }
  const sched = new TurnScheduler({ runtime, cfg, planner, replyer: { generate: async () => ({ text: 'r' }) }, composer, send: async () => 'x' })
  await sched.onMessage(mkMsg('小猫你觉得呢', { mentionsBotName: true, id: 'm1' }))
  await sleep(320) // 进 planner（挂起）
  // 新消息到达 → onMessage 中止规划（abortPlanning bump 代）+ 重排 debounce
  await sched.onMessage(mkMsg('继续聊', { id: 'm2' }))
  ok(resolvePlanner != null, 'planner 已挂起')
  resolvePlanner() // 旧代晚返回
  await sleep(60)
  ok(composerDelivered === false, '新消息中断后，旧代 planner 结果不发送')
})

// ───────── 总结 ─────────
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
