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

// ───────── 项7回归：命令/Direct 不吞更早待评估消息 ─────────
await test('命令消息不吞更早待评估的普通消息（连续 ACK 水位）', async () => {
  const { runtime } = mkCtx()
  const cfg = () => validateHumanizeConfig({ enable: true, groups: ['g1'], shadow: true, threshold: 80, talkValue: 0.35, debounceMs: 200 }).config
  const plannerTargets = []
  const sched = new TurnScheduler({
    runtime, cfg,
    planner: { decide: async ({ decision }) => { plannerTargets.push(decision.targetMessage?.id); return { type: 'human_ignore', reason: 't' } } },
    replyer: { generate: async () => ({ text: '' }) },
    composer: { deliver: async () => ({ sentIds: [] }) }, send: async () => null,
  })
  await sched.onMessage(mkMsg('帮我看看这个方案行不行', { id: 'A_ord', mentionsBotName: true })) // A：普通待评估
  await sched.onMessage(mkMsg('#ai 查天气', { id: 'B_cmd', isCommand: true }))                     // B：命令到达
  runtime.cancelDebounce()
  await sched._onDebounced(runtime)
  ok(plannerTargets.includes('A_ord'), `A 仍进入 Planner（命令 B 不吞更早待评估消息；实际 targets=${JSON.stringify(plannerTargets)}）`)
  ok(!plannerTargets.includes('B_cmd'), '命令 B 本身不进 Planner 候选')
})

await test('游标水位：命令消息可被越过但不复活、未评估普通消息挡住水位', async () => {
  const { runtime, buffer } = mkCtx()
  const a = mkMsg('A 话题', { id: 'wA' })
  const b = mkMsg('#命令', { id: 'wB', isCommand: true })
  const c = mkMsg('C 话题', { id: 'wC' })
  buffer.append(a); buffer.append(b); buffer.append(c)
  // 只结算 A：水位应推进到 A（越过其后紧邻的命令 B 不需要评估），但不能越过未评估的 C
  runtime.markObserved([a])
  ok(runtime.lastProcessedSeq === buffer.get('wB').seq, `水位越过命令 B 停在 C 前（实际 ${runtime.lastProcessedSeq}/${buffer.lastSeq}）`)
  ok(runtime.buffer.snapshotAfter(runtime.lastProcessedSeq).some((m) => m.id === 'wC'), 'C 仍待评估')
  // 全部结算后水位正常到顶
  runtime.markObserved([c])
  ok(runtime.lastProcessedSeq === buffer.lastSeq, `全部处理后水位到顶（实际 ${runtime.lastProcessedSeq}/${buffer.lastSeq}）`)
  ok(runtime.buffer.snapshotAfter(runtime.lastProcessedSeq).length === 0, '命令消息不因水位推进而复活进批次')
})

// ───────── 项6回归：部分发送只登记已发内容 ─────────
await test('真实 composer：三段只发出一段（中途代变）→ sentIds/sentTexts 只含首段', async () => {
  const { runtime } = mkCtx()
  const { HumanizeReplyComposer } = await import('./reply-composer.js')
  const composer = new HumanizeReplyComposer({ cfg: () => ({ reply: { maxBubbles: 3 } }) })
  const target = mkMsg('嗯？', { id: 'pp_t' })
  const sendCalls = []
  const send = async (seg) => {
    sendCalls.push(seg)
    if (sendCalls.length === 1) { runtime.beginPlanning('batch'); return 'pp_s1' } // 首段发出后立刻 bump 代 → 后续段 superseded_mid
    return 'pp_s2'
  }
  // 确定性：splitSegments 的概率合并依赖 rand()——注入恒 1（永不 < mergeProb → 永不合并），保证三段拆分
  const origRandom = Math.random
  Math.random = () => 1
  let res
  try {
    res = await composer.deliver({ text: '第一段内容\n第二段内容\n第三段内容', action: {}, target, runtime, send, signal: null, cfg: { reply: { maxBubbles: 3 } } })
  } finally { Math.random = origRandom }
  ok(res.sentIds.length === 1 && res.sentIds[0] === 'pp_s1', `只发出首段（实际 ${JSON.stringify(res.sentIds)}）`)
  ok(res.sentTexts && res.sentTexts.length === 1 && res.sentTexts[0] === '第一段内容', `sentTexts 只含已发段（实际 ${JSON.stringify(res.sentTexts)}）`)
  ok(res.cancelled === true, `中断标记（${res.cancelReason}）`)
})

await test('调度层：部分发送只登记已发段（buffer/通知只用 deliveredText）', async () => {
  const { runtime } = mkCtx()
  const cfg = () => validateHumanizeConfig({ enable: true, groups: ['g1'], shadow: false, threshold: 80, talkValue: 0.35, debounceMs: 200, cooldownSeconds: 1, replyer: { maxChars: 500 } }).config
  const targetId = 'p_target'
  let deliveredInfo = null
  const sched = new TurnScheduler({
    runtime, cfg,
    planner: { decide: async () => ({ type: 'human_reply', targetMessageId: targetId, replyGuide: 'g', quote: false, toolCallId: 'c1' }) },
    replyer: { generate: async () => ({ text: '第一段\n第二段\n第三段' }) },
    composer: { deliver: async () => ({ sentIds: ['p_sent_1'], sentTexts: ['第一段'], cancelled: true, cancelReason: 'superseded_mid' }) },
    send: async () => 'p_sent_1',
    onDelivered: async (info) => { deliveredInfo = info },
  })
  await sched.onMessage(mkMsg('小猫你觉得呢', { mentionsBotName: true, id: targetId }))
  await sleep(350)
  ok(deliveredInfo && deliveredInfo.sentText === '第一段', `GW/SS/梗登记只见首段（实际 ${JSON.stringify(deliveredInfo?.sentText)}）`)
  const selfMsg = runtime.buffer.get('p_sent_1')
  ok(selfMsg && selfMsg.text === '第一段', `buffer 自身消息只记已发段（实际 ${JSON.stringify(selfMsg?.text)}）`)
})

await test('调度层：首段发送失败 → 零 delivered 状态', async () => {
  const { runtime } = mkCtx()
  const cfg = () => validateHumanizeConfig({ enable: true, groups: ['g1'], shadow: false, threshold: 80, talkValue: 0.35, debounceMs: 200, cooldownSeconds: 1, replyer: { maxChars: 500 } }).config
  const targetId = 'f_target'
  let deliveredInfo = null
  const sched = new TurnScheduler({
    runtime, cfg,
    planner: { decide: async () => ({ type: 'human_reply', targetMessageId: targetId, replyGuide: 'g', quote: false, toolCallId: 'c1' }) },
    replyer: { generate: async () => ({ text: '要发的内容' }) },
    composer: { deliver: async () => ({ sentIds: [], sentTexts: [], cancelled: true, cancelReason: 'send_failed' }) },
    send: async () => null,
    onDelivered: async (info) => { deliveredInfo = info },
  })
  await sched.onMessage(mkMsg('小猫你觉得呢', { mentionsBotName: true, id: targetId }))
  await sleep(350)
  ok(deliveredInfo == null, '发送失败不产生 delivered 状态（onDelivered 不触发）')
  ok(!runtime.buffer.snapshot(20, { includeSelf: true }).some((m) => m.isSelf && m.id === 'any_sent'), '失败内容不写入 buffer 自身消息')
})

await test('调度层：全部发送成功 → deliveredText 与实际发送内容一致', async () => {
  const { runtime } = mkCtx()
  const cfg = () => validateHumanizeConfig({ enable: true, groups: ['g1'], shadow: false, threshold: 80, talkValue: 0.35, debounceMs: 200, cooldownSeconds: 1, replyer: { maxChars: 500 } }).config
  const targetId = 'ok_target'
  let deliveredInfo = null
  const sched = new TurnScheduler({
    runtime, cfg,
    planner: { decide: async () => ({ type: 'human_reply', targetMessageId: targetId, replyGuide: 'g', quote: false, toolCallId: 'c1' }) },
    replyer: { generate: async () => ({ text: '首段\n次段' }) },
    composer: { deliver: async () => ({ sentIds: ['ok1', 'ok2'], sentTexts: ['首段', '次段'], cancelled: false }) },
    send: async () => 'okx',
    onDelivered: async (info) => { deliveredInfo = info },
  })
  await sched.onMessage(mkMsg('小猫你觉得呢', { mentionsBotName: true, id: targetId }))
  await sleep(350)
  ok(deliveredInfo && deliveredInfo.sentText === '首段\n次段', `deliveredText=实际发送内容（实际 ${JSON.stringify(deliveredInfo?.sentText)}）`)
})

// ───────── 项5回归：被检索≠被使用 ─────────
await test('memory：recall 不增使用计数，markUsed 才登记', async () => {
  const dir = path.join(os.tmpdir(), `hm-use-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const store = new HumanizeMemoryStore({
    dataDir: dir,
    provider: { chat: async () => ({ content: JSON.stringify({ memories: [{ kind: 'impression', about_user: 'u1', content: '对甲的印象=爱聊服务器', keywords: ['服务器'], importance: 0.7 }], suspected_jargon: [] }) }) },
    cfg: () => ({ memory: { enabled: true, minConsolidateMessages: 2 } }),
  })
  await store.consolidate({ groupId: 'gu', messages: [{ seq: 1, timestamp: Date.now() - 1000, text: '甲聊服务器', isSelf: false }, { seq: 2, timestamp: Date.now(), text: '乙聊服务器', isSelf: false }] })
  const rows = await store.recall({ groupId: 'gu', query: '服务器', topK: 5 })
  ok(rows.length >= 1, '召回命中')
  const rowOf = async (id) => store.dao.get('SELECT hit_count, last_used_at FROM hm_memories WHERE id=?', [id])
  let after = await rowOf(rows[0].id)
  ok(Number(after.hit_count) === 0, `recall 本身不增 hit_count（实际 ${after.hit_count}）`)
  ok(after.last_used_at == null, 'recall 不推进 last_used_at')
  await store.markUsed('gu', rows.map((r) => r.id))
  after = await rowOf(rows[0].id)
  ok(Number(after.hit_count) === 1 && after.last_used_at != null, `markUsed 登记真实使用（hit=${after.hit_count}）`)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('memory：整合原子性——中途写失败整批回滚、水位不推进', async () => {
  const dir = path.join(os.tmpdir(), `hm-txn-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const store = new HumanizeMemoryStore({
    dataDir: dir,
    provider: { chat: async () => ({ content: JSON.stringify({ memories: [
      { kind: 'event', content: '事件A：群里讨论了部署', keywords: ['部署'], importance: 0.6 },
      { kind: 'event', content: '事件B：群里讨论了回滚', keywords: ['回滚'], importance: 0.6 },
    ], suspected_jargon: [] }) }) },
    cfg: () => ({ memory: { enabled: true, minConsolidateMessages: 2 } }),
  })
  await store.init()
  // 注入：第二条 INSERT 失败 → 整批必须回滚（无部分记忆、水位不推进）
  const orig = store.dao.run.bind(store.dao)
  let insertN = 0
  store.dao.run = async (sql, p = []) => {
    if (/INSERT INTO hm_memories/.test(sql) && ++insertN === 2) throw new Error('injected write failure')
    return orig(sql, p)
  }
  let threw = false
  try { await store.consolidate({ groupId: 'gt', messages: [{ seq: 1, timestamp: Date.now() - 1000, text: 'a', isSelf: false }, { seq: 2, timestamp: Date.now(), text: 'b', isSelf: false }] }) } catch { threw = true }
  ok(threw, '写失败时 consolidate 抛错（不静默当成功）')
  const left = await store.dao.all('SELECT * FROM hm_memories WHERE group_id=?', ['gt'])
  ok(left.length === 0, `无部分记忆残留（实际 ${left.length} 条）`)
  ok(await store.consolidatedSeq('gt') === 0, `水位未推进（实际 ${await store.consolidatedSeq('gt')}）`)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('memory：同一批同来源候选不重复 +0.05 强化', async () => {
  const dir = path.join(os.tmpdir(), `hm-boost-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const store = new HumanizeMemoryStore({
    dataDir: dir,
    provider: { chat: async () => ({ content: JSON.stringify({ memories: [
      { kind: 'jargon', content: '雨伞=形容离谱', keywords: ['雨伞'], importance: 0.5 },
      { kind: 'jargon', content: '雨伞=形容离谱啦', keywords: ['雨伞'], importance: 0.5 }, // 同义近重复（同批；词面 sim 0.8）
    ], suspected_jargon: [] }) }) },
    cfg: () => ({ memory: { enabled: true, minConsolidateMessages: 2 } }),
  })
  await store.consolidate({ groupId: 'gb', messages: [{ seq: 1, timestamp: Date.now() - 1000, text: 'x', isSelf: false }, { seq: 2, timestamp: Date.now(), text: 'y', isSelf: false }] })
  const rows = await store.dao.all("SELECT * FROM hm_memories WHERE group_id='gb'")
  ok(rows.length === 1, `近重复合并为一条（实际 ${rows.length}）`)
  ok(Math.abs(Number(rows[0].importance) - 0.5) < 1e-9, `同批只允许一次重要性提升上限（合并不加权；实际 ${rows[0].importance}）`)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ───────── 项4回归：整合水位跨重启 ─────────
await test('整合水位：buffer seq 回退（重启过期）仍触发整合——安全重置到合法边界', async () => {
  const dir = path.join(os.tmpdir(), `hm-wm-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const store = new HumanizeMemoryStore({
    dataDir: dir,
    provider: { chat: async () => ({ content: JSON.stringify({ memories: [{ kind: 'event', content: '新纪元事件', keywords: [], importance: 0.5 }], suspected_jargon: [] }) }) },
    cfg: () => ({ memory: { enabled: true, minConsolidateMessages: 2 } }),
  })
  await store.init()
  await store.markConsolidated('gw', 5000) // 旧 incarnation 的高水位（buffer 已全部过期丢失）
  ok(await store.shouldConsolidate('gw', 3, 2) === true, `current(3) < watermark(5000) → 判定需要整合（重置路径），而非长期 false`)
  // cron 同款逻辑：回退时安全重置水位到 0，再取全部当前缓冲消息整合（旧消息已不在 buffer，不会重复强化）
  const { runtime: rt2 } = mkCtx()
  for (let i = 1; i <= 3; i++) rt2.buffer.append(mkMsg(`新消息${i}`, { id: `wm${i}` }))
  let since = await store.consolidatedSeq('gw')
  if (since > rt2.buffer.lastSeq) { await store.markConsolidated('gw', 0); since = 0 }
  const msgs = rt2.buffer.snapshotAfter(since)
  ok(msgs.length === 3, `重置后取到全部 3 条新消息（实际 ${msgs.length}）`)
  const r = await store.consolidate({ groupId: 'gw', messages: msgs })
  ok(r.created === 1, `整合执行（created=${r.created}）`)
  ok(await store.consolidatedSeq('gw') === 3, `水位推进到新边界 3（实际 ${await store.consolidatedSeq('gw')}）`)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('整合水位：正常重启（buffer 恢复）不重复整合', async () => {
  const dir = path.join(os.tmpdir(), `hm-wm2-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const store = new HumanizeMemoryStore({
    dataDir: dir,
    provider: { chat: async () => ({ content: JSON.stringify({ memories: [], suspected_jargon: [] }) }) },
    cfg: () => ({ memory: { enabled: true, minConsolidateMessages: 2 } }),
  })
  await store.init()
  const { buffer: buf1 } = mkCtx()
  for (let i = 1; i <= 5; i++) buf1.append(mkMsg(`旧消息${i}`, { id: `o${i}` }))
  await store.consolidate({ groupId: 'gn', messages: buf1.snapshotAfter(0) })
  ok(await store.consolidatedSeq('gn') === 5, '第一轮水位 5')
  // 模拟重启：新 buffer 恢复了尾部（seq 延续），无新增 → 不再整合
  const { buffer: buf2 } = mkCtx()
  buf2.adopt(buf1.snapshot(50, { includeSelf: true }))
  ok(await store.shouldConsolidate('gn', buf2.lastSeq, 2) === false, `无新增不整合（lastSeq=${buf2.lastSeq}）`)
  // 新增 2 条 → 触发，且只整合新增
  buf2.append(mkMsg('新1', { id: 'n1' })); buf2.append(mkMsg('新2', { id: 'n2' }))
  ok(await store.shouldConsolidate('gn', buf2.lastSeq, 2) === true, '新增达标触发')
  const fresh = buf2.snapshotAfter(await store.consolidatedSeq('gn'))
  ok(fresh.length === 2 && fresh.every((m) => m.id.startsWith('n')), `只整合新增 2 条（实际 ${fresh.length}）`)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('buffer：raiseSeqFloor 单调——重启后 seq 不回退', async () => {
  const { buffer } = mkCtx()
  buffer.append(mkMsg('a', { id: 'fa' }))
  ok(buffer.lastSeq === 1, '初始 seq=1')
  buffer.raiseSeqFloor(5000)
  ok(buffer.lastSeq === 5000, `floor 抬升后 lastSeq=${buffer.lastSeq}`)
  buffer.append(mkMsg('b', { id: 'fb' }))
  ok(buffer.get('fb').seq === 5001, `新消息 seq=5001（实际 ${buffer.get('fb').seq}）`)
  buffer.raiseSeqFloor(100) // 回退型 floor 不生效
  ok(buffer.lastSeq === 5001, 'floor 只增不减')
})

// ───────── 项9回归 ─────────
await test('cooldownSeconds=0 显式配置 → 不进入冷却', async () => {
  const { runtime } = mkCtx({ cooldownSeconds: 0 })
  runtime.enterCooldown(0)
  ok(runtime.isCoolingDown() === false, `显式 0 不冷却（实际 cooldownUntil=${runtime.cooldownUntil}）`)
  runtime.enterCooldown(5)
  ok(runtime.isCoolingDown() === true, '正数仍正常冷却')
})

// ───────── 旧事回流根治：话题硬门 + 使用冷却 + 高热变体合并（压图/马赛克式自我强化） ─────────
await test('记忆回流：弱共词过不了话题门，明确相关才召回', async () => {
  const dir = path.join(os.tmpdir(), `hm-backflow-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const store = new HumanizeMemoryStore({
    dataDir: dir,
    provider: { chat: async () => ({ content: JSON.stringify({ memories: [{ kind: 'event', content: '昨天把图压成了马赛克，大家笑死', keywords: ['压图'], importance: 0.6 }], suspected_jargon: [] }) }) },
    cfg: () => ({ memory: { enabled: true, minConsolidateMessages: 2 } }),
  })
  await store.consolidate({ groupId: 'gbf', messages: [{ seq: 1, timestamp: Date.now() - 1000, text: 'a', isSelf: false }, { seq: 2, timestamp: Date.now(), text: 'b', isSelf: false }] })
  // 弱共词（sim≈0.11，旧实现 0.05 地板放行 → 得分≈0.35 注入）：话题门拦截
  const weak = await store.recall({ groupId: 'gbf', query: '那个马赛克图还有吗', topK: 5 })
  ok(weak.length === 0, `弱共词被话题门拦下（实际召回 ${weak.length} 条；sim≈0.11 < 0.20）`)
  // 明确相关（sim≈0.27 ≥ 0.20）：正常召回
  const rel = await store.recall({ groupId: 'gbf', query: '图压成马赛克那事', topK: 5 })
  ok(rel.length === 1, `明确相关仍可召回（实际 ${rel.length} 条）`)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('记忆回流：真实使用后 72h 冷却，用户明确再提才绕过', async () => {
  const dir = path.join(os.tmpdir(), `hm-cool-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const store = new HumanizeMemoryStore({
    dataDir: dir,
    provider: { chat: async () => ({ content: JSON.stringify({ memories: [{ kind: 'event', content: '昨天把图压成了马赛克，大家笑死', keywords: ['压图'], importance: 0.6 }], suspected_jargon: [] }) }) },
    cfg: () => ({ memory: { enabled: true, minConsolidateMessages: 2 } }),
  })
  await store.consolidate({ groupId: 'gc', messages: [{ seq: 1, timestamp: Date.now() - 1000, text: 'a', isSelf: false }, { seq: 2, timestamp: Date.now(), text: 'b', isSelf: false }] })
  const rows = await store.recall({ groupId: 'gc', query: '图压成马赛克那事', topK: 5 })
  ok(rows.length === 1, '冷却前可召回（sim≈0.27 过话题门）')
  await store.markUsed('gc', rows.map((r) => r.id)) // 真实发送登记使用
  // 中等相关（sim 0.20~0.35、未命中关键词「压图」）→ 冷却期内不再主动注入
  const mid = await store.recall({ groupId: 'gc', query: '图压成马赛克那事', topK: 5 })
  ok(mid.length === 0, `冷却中不重复注入（实际 ${mid.length}）`)
  // 用户明确再提（query 含关键词「压图」）→ 同时过话题门与冷却旁路
  const strong = await store.recall({ groupId: 'gc', query: '上次压图那件事怎么样了', topK: 5 })
  ok(strong.length === 1, `明确再提绕过冷却（实际 ${strong.length}）`)
  // 冷却到期（手动把 last_used_at 挪到 73h 前）→ 恢复可召回
  await store.dao.run('UPDATE hm_memories SET last_used_at=? WHERE group_id=?', [Date.now() - 73 * 3600e3, 'gc'])
  const after = await store.recall({ groupId: 'gc', query: '图压成马赛克那事', topK: 5 })
  ok(after.length === 1, '冷却到期恢复召回')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('记忆回流：高热行换皮变体并回同一行（不再四行各逃冷却）', async () => {
  const dir = path.join(os.tmpdir(), `hm-merge-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const store = new HumanizeMemoryStore({
    dataDir: dir,
    provider: { chat: async () => ({ content: JSON.stringify({ memories: [{ kind: 'event', content: '我又把图压成了马赛克被嫌弃', keywords: ['压图'], importance: 0.5 }], suspected_jargon: [] }) }) },
    cfg: () => ({ memory: { enabled: true, minConsolidateMessages: 2 } }),
  })
  await store.init()
  // 造高热旧行（hit_count=6、群级 user_id=NULL 与候选同域，同事件不同措辞，词面 sim≈0.32 < 常规 0.6）
  await store.dao.run("INSERT INTO hm_memories(group_id,user_id,kind,content,keywords,importance,hit_count,last_used_at,created_at,updated_at) VALUES ('gm',NULL,'event','我把30张图极限压缩，压成了马赛克，被嫌弃说太多','[\"压图\"]',0.6,6,?,?,?)", [Date.now(), Date.now(), Date.now()])
  await store.consolidate({ groupId: 'gm', messages: [{ seq: 1, timestamp: Date.now() - 1000, text: 'a', isSelf: false }, { seq: 2, timestamp: Date.now(), text: 'b', isSelf: false }] })
  const rows = await store.dao.all("SELECT * FROM hm_memories WHERE group_id='gm' AND kind='event'")
  ok(rows.length === 1, `高热行变体合并为同一行（实际 ${rows.length}；旧实现 0.6 阈值下会 +1 成两行各自逃冷却）`)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ───────── 总结 ─────────
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
