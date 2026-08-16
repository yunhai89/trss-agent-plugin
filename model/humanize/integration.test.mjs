/**
 * humanize 集成测试 —— Planner 工具循环 / 代取消 / shadow 端到端（指南 §19.2 集成场景）。
 * 用 mock provider 验证决策逻辑，不依赖真实 LLM。
 * 运行：node model/humanize/integration.test.mjs
 */
import { memoryKv } from '../agent/store/kv.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GroupRuntime } from './group-runtime.js'
import { MessageBuffer } from './message-buffer.js'
import { IdleBackoff } from './idle-backoff.js'
import { HumanizeStore, newHolderId } from './store.js'
import { Trace } from './trace.js'
import { HumanizePlanner } from './planner.js'
import { HumanizeMemoryStore } from './memory-store.js'
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

await test('Planner：Provider 指定上下文旧消息 → 拒绝旧目标', async () => {
  const { runtime } = mkCtx()
  const provider = mockProvider([{
    content: '模型选择了旧消息',
    toolCalls: [{ id: 'old', name: 'human_reply', arguments: { targetMessageId: 'old-id', replyGuide: '旧话题' } }],
    finishReason: 'tool_calls',
  }])
  const planner = new HumanizePlanner({ provider, cfg: () => ({ planner: { maxRounds: 1 } }) })
  const oldMsg = mkMsg('旧的马赛克话题', { id: 'old-id' })
  const current = mkMsg('现在的P40部署问题', { id: 'current-id' })
  const action = await planner.decide({
    snapshot: [oldMsg, current],
    decision: { targetMessage: current },
    runtime,
    cfg: { planner: { maxRounds: 1 } },
  })
  ok(action.type === 'human_ignore' && action.reason === 'all_invalid', '旧上下文消息不能成为 Planner 发送目标')
})

await test('Memory：合法空结果推进整合水位，避免同批消息反复整合', async () => {
  const dir = path.join(os.tmpdir(), `humanize-empty-memory-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const store = new HumanizeMemoryStore({
    dataDir: dir,
    provider: { chat: async () => ({ content: '{"memories":[],"suspected_jargon":[]}' }) },
    cfg: () => ({ memory: { enabled: true, minConsolidateMessages: 2 } }),
  })
  const msgs = [
    { seq: 1, timestamp: Date.now() - 2000, text: '第一条', isSelf: false },
    { seq: 2, timestamp: Date.now(), text: '第二条', isSelf: false },
  ]
  const result = await store.consolidate({ groupId: 'g-empty', messages: msgs })
  ok(result.skipped === 'empty', `合法空结果返回 skipped=empty（实际 ${result.skipped}）`)
  ok(await store.consolidatedSeq('g-empty') === 2, `空结果也推进水位到 2（实际 ${await store.consolidatedSeq('g-empty')}）`)
  fs.rmSync(dir, { recursive: true, force: true })
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

await test('P0：Planner 先解析 grounding，再按 threadUserIds 检索并注入记忆', async () => {
  const { runtime } = mkCtx()
  let memoryScope = null
  let sentSystem = ''
  const provider = {
    chat: async ({ system }) => {
      sentSystem = system
      return { content: '', toolCalls: [], finishReason: 'stop', usage: null }
    },
  }
  const planner = new HumanizePlanner({
    provider,
    cfg: () => ({ planner: { maxRounds: 1 } }),
    getGrounding: () => ({
      grounding: { threadUserIds: ['u1', 'u2'] },
      block: 'GROUNDING_SCOPE_MARK',
    }),
    getMemories: async (_query, opts) => {
      memoryScope = opts?.threadUserIds
      return 'MEMORY_SCOPE_MARK'
    },
  })
  const target = mkMsg('这个权限问题应该怎么处理', { id: 'scope_target', userId: 'u1' })
  await planner.decide({
    snapshot: [target], decision: { targetMessage: target, finalScore: 90, threshold: 80 },
    runtime, cfg: { planner: { maxRounds: 1 } },
  })
  ok(JSON.stringify(memoryScope) === JSON.stringify(['u1', 'u2']), '记忆检索收到 grounding.threadUserIds')
  ok(sentSystem.includes('GROUNDING_SCOPE_MARK') && sentSystem.includes('MEMORY_SCOPE_MARK'), 'Planner system 同时注入归属块与作用域内记忆')
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

await test('GroupRuntime：强信号与纠错状态均按用户隔离并会过期', async () => {
  const { runtime } = mkCtx()
  const t = 1_000_000
  runtime.recordStrongReply('u1', t)
  runtime.recordStrongReply('u1', t + 1)
  ok(runtime.strongReplyCount('u1', t + 2) === 2 && runtime.strongReplyCount('u2', t + 2) === 0, '强信号次数不跨用户')
  ok(runtime.strongReplyCount('u1', t + 10 * 60 * 1000 + 2) === 0, '10 分钟后强信号次数自动过期')
  runtime.markReferenceCorrection('u1', 'fix_once', t + 1000)
  ok(runtime.referenceCorrectionFor('u1', t + 1)?.allowMessageId === 'fix_once', '纠错消息保留一次处理许可')
  ok(runtime.referenceCorrectionFor('u2', t + 1) === null, '纠错暂停不跨用户')
  ok(runtime.referenceCorrectionFor('u1', t + 1001) === null, '纠错暂停到期自动清理')
})

// ───────── shadow 端到端 ─────────
await test('shadow 端到端：消息→门控→reply→只 trace 不实发', async () => {
  const { runtime, trace, store } = mkCtx()
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
  const cooldownBefore = runtime.cooldownUntil
  let shadowSuccessCalled = false
  const originalRecordSuccess = runtime.backoff.recordSuccess.bind(runtime.backoff)
  runtime.backoff.recordSuccess = (...args) => { shadowSuccessCalled = true; return originalRecordSuccess(...args) }

  const sched = new TurnScheduler({ runtime, cfg, planner, replyer, composer, send })
  // 强关联消息（mentionsBotName）→ 必触发门控
  await sched.onMessage(mkMsg('小猫你觉得呢', { mentionsBotName: true, id: targetId }))
  await sleep(350) // 等 debounce(5ms) + 规划 + replyer

  ok(sentCount === 0, 'shadow 模式：composer.deliver 未被调用 → 真实 send 0 次')
  const events = trace.recent({ limit: 50 })
  ok(events.some((e) => e.event === 'shadow_reply'), '记录了 shadow_reply')
  ok(runtime.cooldownUntil === cooldownBefore, 'shadow 不进入真实冷却')
  ok(shadowSuccessCalled === false, 'shadow 不触发 backoff.recordSuccess')
  ok(runtime.strongReplyCount('u1') === 0, 'shadow 不消耗强信号额度')
  ok(runtime.replyCountIn(10 * 60 * 1000) === 0, 'shadow 不计入回复频率')
  ok(runtime.buffer.snapshot(20, { includeSelf: true }).every((m) => !m.isSelf || m.id === targetId) && !runtime.buffer.get('shadow-self'), 'shadow 不写入伪造自身消息')
  ok(await store.isSent('g1', targetId) === false, 'shadow 不 markSent')
})

await test('强信号限制按用户隔离：甲耗尽不影响乙，评分目标落到乙', async () => {
  const { runtime } = mkCtx()
  const cfg = () => validateHumanizeConfig({
    enable: true, groups: ['g1'], shadow: true, threshold: 80, talkValue: 0.35,
    debounceMs: 200, cooldownSeconds: 1,
  }).config
  const t = Date.now()
  runtime.recordStrongReply('u1', t)
  runtime.recordStrongReply('u1', t + 1)
  runtime.recordStrongReply('u1', t + 2)
  runtime.cooldownUntil = Date.now() + 1000
  let plannerTarget = null
  const planner = {
    decide: async ({ decision }) => {
      plannerTarget = decision.targetMessage?.id || null
      return { type: 'human_ignore', reason: 'test' }
    },
  }
  const sched = new TurnScheduler({
    runtime, cfg, planner,
    replyer: { generate: async () => ({ text: '' }) },
    composer: { deliver: async () => ({ sentIds: [] }) }, send: async () => null,
  })
  await sched.onMessage(mkMsg('小猫你能不能帮我看看怎么做？', { userId: 'u1', mentionsBotName: true, id: 'u1_limited' }))
  await sched.onMessage(mkMsg('小猫你能不能帮我看看怎么做？', { userId: 'u2', displayName: '乙', mentionsBotName: true, id: 'u2_fresh' }))
  runtime.cancelDebounce()
  await sched._onDebounced(runtime)
  ok(plannerTarget === 'u2_fresh', '甲的 3 次配额只移除甲的强信号，乙仍可绕过冷却并成为目标')
  ok(runtime.strongReplyCount('u2') === 0, 'Planner ignore 不误计乙的强信号回复')
})

await test('强信号耗尽后硬失去豁免，冷却跳过会推进游标避免旧消息复活', async () => {
  const { runtime } = mkCtx()
  const cfg = () => validateHumanizeConfig({
    enable: true, groups: ['g1'], shadow: true, threshold: 20, talkValue: 1,
    debounceMs: 200, cooldownSeconds: 60,
  }).config
  const t = Date.now()
  for (let i = 0; i < 3; i++) runtime.recordStrongReply('u1', t + i)
  runtime.cooldownUntil = Date.now() + 60_000
  let plannerCalled = false
  const sched = new TurnScheduler({
    runtime, cfg, planner: { decide: async () => { plannerCalled = true; return { type: 'human_ignore' } } },
    replyer: { generate: async () => ({ text: '' }) },
    composer: { deliver: async () => ({ sentIds: [] }) }, send: async () => null,
  })
  await sched.onMessage(mkMsg('小猫你觉得呢？', { userId: 'u1', mentionsBotName: true, id: 'u1_fourth' }))
  runtime.cancelDebounce()
  await sched._onDebounced(runtime)
  ok(plannerCalled === false, '即使阈值较低，第 4 次也不能保留强信号冷却豁免')
  ok(runtime.lastProcessedSeq === runtime.buffer.lastSeq, '被冷却跳过的消息已观察，不会在下一条消息时复活')
})

await test('纠错退场按发送者隔离：拦甲后续但仍处理同批乙消息', async () => {
  const { runtime } = mkCtx()
  const cfg = () => validateHumanizeConfig({
    enable: true, groups: ['g1'], shadow: true, threshold: 80, talkValue: 0.35, debounceMs: 200,
  }).config
  runtime.markReferenceCorrection('u1', 'correction_once', Date.now() + 120_000)
  let plannerTarget = null
  const sched = new TurnScheduler({
    runtime, cfg,
    planner: { decide: async ({ decision }) => { plannerTarget = decision.targetMessage?.id; return { type: 'human_ignore', reason: 'test' } } },
    replyer: { generate: async () => ({ text: '' }) },
    composer: { deliver: async () => ({ sentIds: [] }) }, send: async () => null,
  })
  await sched.onMessage(mkMsg('你怎么还在说', { userId: 'u1', quotesBot: true, id: 'u1_after_correction' }))
  await sched.onMessage(mkMsg('小猫你觉得呢？', { userId: 'u2', displayName: '乙', mentionsBotName: true, id: 'u2_after_correction' }))
  runtime.cancelDebounce()
  await sched._onDebounced(runtime)
  ok(plannerTarget === 'u2_after_correction', '只过滤纠错者甲，乙仍进入 Planner')
  ok(runtime.lastProcessedSeq === runtime.buffer.lastSeq, '混合批次整体推进游标')
})

await test('端到端：shadow=false 时真实发送 + markSent + 记录回复', async () => {
  const { runtime, store } = mkCtx()
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
