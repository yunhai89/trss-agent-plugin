/**
 * ConversationScene + 自然表达 行为回归（聊天意境理解 / 默认人设 AI 味专项）。
 * 覆盖 12 个验收场景：不抢话 / 吐槽接情绪 / 讽刺识别 / 技术问答 / 话题关闭 /
 * 距离感 / 口头禅复读 / 身份一致 / Planner 无 PersonaVoice / SS scene 非空 / 降级 / 不覆盖 Grounding。
 * 运行：node model/humanize/scene.test.mjs（离线，fake provider，不联网）
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import { memoryKv } from '../agent/store/kv.js'
import * as Db from '../groupworld/db.js'
import { SelfStateService } from '../selfstate/service.js'
import { GroupRuntime } from './group-runtime.js'
import { MessageBuffer } from './message-buffer.js'
import { IdleBackoff } from './idle-backoff.js'
import { HumanizeStore, newHolderId } from './store.js'
import { Trace } from './trace.js'
import { TurnScheduler } from './turn-scheduler.js'
import { HumanizePlanner } from './planner.js'
import { HumanizeReplyer, detectAiFlavor } from './replyer.js'
import { buildPlannerSystem, buildReplyerSystem } from './prompts.js'
import { ConversationSceneAnalyzer, ruleScene, formatSceneBlock, sceneLengthHint } from './scene.js'
import { pickStyleExamples, DEFAULT_STYLE_EXAMPLES } from './style-examples.js'
import { validateHumanizeConfig, resolvePersonaIdentity } from './default-config.js'
import { DEFAULT_HUMANIZE_PERSONA } from './default-persona.js'
import { resolveGrounding } from './grounding.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 4).join('\n')) } }
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
    displayName: '甲', timestamp: Date.now(), text, segments: [],
    replyToId: null, atBot: false, mentionsBotName: false, quotesBot: false,
    isCommand: false, isSelf: false, handledByDirectAgent: false, media: [], ...extra,
  }
}
const selfMsg = (text, id) => mkMsg(text, { isSelf: true, userId: 'bot', displayName: '我' }, id)

/** 场景工厂（schema 合法对象）。 */
const mkScene = (over = {}) => ({
  sceneType: 'banter', speechAct: 'tease', tones: ['playful'], phase: 'rising',
  participants: [{ userId: 'u1', role: 'speaker' }], directedAtBot: 0, replyAffordance: 0.2,
  humanMomentum: 0.8, ambiguity: 0.1, confidence: 0.8, evidenceMessageIds: [], source: 'llm', degraded: null, ...over,
})

// ───────── 1. A 调侃 B、机器人未被叫到 → 不抢话 ─────────
await test('S1 不抢话：群友互怼动量高且未叫机器人 → Planner 不被调用', async () => {
  const { runtime } = mkCtx()
  const cfg = () => validateHumanizeConfig({ enable: true, groups: ['g1'], shadow: true, threshold: 20, talkValue: 1, debounceMs: 200 }).config
  let plannerCalled = false
  const sched = new TurnScheduler({
    runtime, cfg,
    getScene: async () => mkScene({ sceneType: 'banter', humanMomentum: 0.9, directedAtBot: 0, phase: 'peak' }),
    planner: { decide: async () => { plannerCalled = true; return { type: 'human_ignore' } } },
    replyer: { generate: async () => ({ text: '' }) },
    composer: { deliver: async () => ({ sentIds: [] }) }, send: async () => null,
  })
  // 机器人之前说过话（在场），当前消息是甲调侃乙（普通消息，低阈值下本会进 Planner）
  await sched.onMessage(selfMsg('我上次说的就是这事', 'self_prev'))
  await sched.onMessage(mkMsg('你这操作也太下饭了吧', { userId: 'uA', displayName: '甲', id: 'banter_a', replyToId: 'other_b' }))
  await sched.onMessage(mkMsg('再说话题没了', { userId: 'uB', displayName: '乙', id: 'banter_b' }))
  runtime.cancelDebounce()
  await sched._onDebounced(runtime)
  ok(plannerCalled === false, `群友动量 0.9 且 directedAtBot=0 → 门控拦截不进 Planner（plannerCalled=${plannerCalled}）`)
  // 对照：被 @（强信号）同样场景必须放行
  const { runtime: rt2 } = mkCtx()
  let plannerCalled2 = false
  const sched2 = new TurnScheduler({
    runtime: rt2, cfg,
    getScene: async () => mkScene({ sceneType: 'banter', humanMomentum: 0.9, directedAtBot: 1, phase: 'peak' }),
    planner: { decide: async () => { plannerCalled2 = true; return { type: 'human_ignore' } } },
    replyer: { generate: async () => ({ text: '' }) },
    composer: { deliver: async () => ({ sentIds: [] }) }, send: async () => null,
  })
  await sched2.onMessage(mkMsg('你觉得呢', { userId: 'uA', mentionsBotName: true, id: 'at_bot_x' }))
  rt2.cancelDebounce()
  await sched2._onDebounced(rt2)
  ok(plannerCalled2 === true, '强信号（提及机器人）不受动量压制，照常进 Planner')
})

// ───────── 2. 吐槽先接情绪，不自动给方案 ─────────
await test('S2 吐槽识别：venting/complain + Replyer 口径「先接情绪」+ 五步方案被 AI 味检查命中', async () => {
  const now = Date.now()
  const win = [
    mkMsg('今天发布真的搞了一晚上', { userId: 'uA', displayName: '甲', id: 'v1', timestamp: now - 60000 }),
    mkMsg('真服了，部署又炸了', { userId: 'uA', displayName: '甲', id: 'v2', timestamp: now - 30000 }),
  ]
  const scene = ruleScene(win, null, { now })
  ok(scene.sceneType === 'venting' && scene.speechAct === 'complain', `「真服了，部署又炸了」→ venting/complain（实际 ${scene.sceneType}/${scene.speechAct}）`)
  const block = formatSceneBlock(scene, { role: 'replyer' })
  ok(block.includes('先接住情绪') && block.includes('别急着分析'), 'Replyer 场景块含「先接情绪、别急着分析」口径')
  const pblock = formatSceneBlock(scene, { role: 'planner' })
  ok(pblock.includes('吐槽') && pblock.includes('≠求方案') || pblock.includes('不自动给步骤'), 'Planner 场景块含「吐槽≠求方案」纪律')
  // 客服式五步方案在吐槽场景被判 AI 味
  const flavor = detectAiFlavor('当然可以。建议您按以下步骤排查：\n1. 查看日志\n2. 回滚版本\n3. 清理缓存\n4. 重启服务', { scene, recentBotTexts: [] })
  ok(flavor.hit && flavor.reasons.includes('service_tone'), `五步客服方案命中 AI 味（reasons=${flavor.reasons}）`)
  // 而一句情绪接话不误伤
  const fine = detectAiFlavor('唉，它就爱挑你下班的时候炸', { scene, recentBotTexts: [] })
  ok(!fine.hit, '一句情绪共鸣不误伤')
})

// ───────── 3. 讽刺不按字面表扬 ─────────
await test('S3 讽刺识别：「你可真会挑时候」→ sarcastic，不是表扬/求方案', async () => {
  const now = Date.now()
  const win = [mkMsg('你可真会挑时候', { userId: 'uA', displayName: '甲', id: 's1', timestamp: now })]
  const scene = ruleScene(win, null, { now })
  ok(scene.tones.includes('sarcastic'), `tones 含 sarcastic（实际 ${JSON.stringify(scene.tones)}）`)
  ok(scene.speechAct === 'tease', `言语行为=tease 而非 inform/ask（实际 ${scene.speechAct}）`)
  ok(!scene.tones.includes('playful') || scene.tones.includes('sarcastic'), '不按字面当轻松表扬')
})

// ───────── 4. 技术问题：默认程序员人设能答 + 场景允许展开 ─────────
await test('S4 技术问答：serious_qna + expandable + 默认人设为程序员（非不懂技术）', async () => {
  const now = Date.now()
  const win = [mkMsg('P40 能跑多大的向量模型？', { userId: 'uA', displayName: '甲', id: 'q1', atBot: true, timestamp: now })]
  const scene = ruleScene(win, resolveGrounding(win), { now })
  ok(scene.sceneType === 'serious_qna' && scene.speechAct === 'ask', `@机器人问技术 → serious_qna/ask（实际 ${scene.sceneType}/${scene.speechAct}）`)
  ok(sceneLengthHint(scene) === 'expandable', '长度档位 expandable（允许展开讲明白）')
  ok(/程序员|写代码/.test(DEFAULT_HUMANIZE_PERSONA.prompt), '默认人设是程序员背景')
  ok(!/听不懂或不感兴趣|不硬接/.test(DEFAULT_HUMANIZE_PERSONA.prompt), '不再设置「不懂技术的普通上班族」')
  const rsys = buildReplyerSystem({ personaName: '小舟', personaVoice: DEFAULT_HUMANIZE_PERSONA.prompt, sceneBlock: formatSceneBlock(scene, { role: 'replyer' }) })
  ok(rsys.includes('该讲明白就讲明白'), 'Replyer 模板允许技术问答展开')
})

// ───────── 5. 「行了睡了」→ 话题关闭沉默 ─────────
await test('S5 话题关闭：「行了睡了」→ phase=closed + 门控默认沉默', async () => {
  const now = Date.now()
  const win = [
    mkMsg('今天先聊到这', { userId: 'uA', displayName: '甲', id: 'c1', timestamp: now - 120_000 }),
    mkMsg('行了睡了', { userId: 'uA', displayName: '甲', id: 'c2', timestamp: now - 40_000 }),
  ]
  const scene = ruleScene(win, null, { now })
  ok(scene.phase === 'closed' && scene.speechAct === 'close_topic', `识别话题关闭（实际 ${scene.phase}/${scene.speechAct}）`)
  const { runtime } = mkCtx()
  const cfg = () => validateHumanizeConfig({ enable: true, groups: ['g1'], shadow: true, threshold: 20, talkValue: 1, debounceMs: 200 }).config
  let plannerCalled = false
  const sched = new TurnScheduler({
    runtime, cfg,
    getScene: async () => mkScene({ phase: 'closed', sceneType: 'idle', directedAtBot: 0, speechAct: 'close_topic' }),
    planner: { decide: async () => { plannerCalled = true; return { type: 'human_ignore' } } },
    replyer: { generate: async () => ({ text: '' }) },
    composer: { deliver: async () => ({ sentIds: [] }) }, send: async () => null,
  })
  await sched.onMessage(mkMsg('行了睡了', { id: 'close_x' }))
  runtime.cancelDebounce()
  await sched._onDebounced(runtime)
  ok(plannerCalled === false, 'phase=closed 且未被直接叫 → 门控沉默')
})

// ───────── 6. 熟人调侃 vs 陌生人提问：距离感 ─────────
await test('S6 距离感：同场景下按熟悉度选不同款示例 + 人设含分寸描述', async () => {
  const scene = mkScene({ sceneType: 'banter', speechAct: 'tease', tones: ['playful'] })
  const fam = pickStyleExamples(DEFAULT_STYLE_EXAMPLES, scene, { familiarity: 1, recentBotTexts: [] })
  const stranger = pickStyleExamples(DEFAULT_STYLE_EXAMPLES, scene, { familiarity: 0.2, recentBotTexts: [] })
  ok(fam.length >= 2 && stranger.length >= 2, `各取 2~4 条（熟 ${fam.length}/生 ${stranger.length}）`)
  ok(fam[0].familiarity > stranger[0].familiarity, `熟人首选损友款（fam=${fam[0].familiarity}）＞陌生人首选收着款（fam=${stranger[0].familiarity}）`)
  ok(/熟人.*嘴欠|不熟.*收着|陌生人.*收/.test(DEFAULT_HUMANIZE_PERSONA.prompt), '默认人设写明熟人/生人分寸')
  const blkFam = formatSceneBlock(scene, { role: 'replyer' })
  ok(blkFam.includes('指向机器人') && blkFam.includes('动量'), '场景块给 Replyer 提供距离感上下文')
})

// ───────── 7. 连续多轮同一口头禅 → 重生成换款 ─────────
await test('S7 口头禅复读：同一开头连续出现 → AI 味检查命中并重生成一次（不循环）', async () => {
  const { runtime } = mkCtx()
  let calls = 0
  const outputs = ['笑死，这波又是经典', '哈哈这操作真没谁了']
  const provider = { chat: async () => { calls++; return { content: outputs[Math.min(calls - 1, outputs.length - 1)] } } }
  const replyer = new HumanizeReplyer({
    provider, cfg: () => ({}),
    getRecentBotTexts: () => ['笑死，真服了', '笑死，绷不住了'], // 近期两条同款开头
  })
  const target = mkMsg('你看这个操作', { id: 't7' })
  const res = await replyer.generate({ action: { replyGuide: '接一句' }, batch: [target], target, runtime, signal: null, cfg: {}, scene: mkScene({ sceneType: 'banter' }) })
  ok(calls === 2, `repeat_opener 命中 → 恰好重生成一次（calls=${calls}，禁止循环）`)
  ok(res.text === outputs[1] && !res.text.startsWith('笑死'), `换款后不再同开头（实际「${res.text.slice(0, 8)}」）`)
  // 重生成仍同款 → 不再循环，保留其一
  let calls2 = 0
  const provider2 = { chat: async () => { calls2++; return { content: '笑死，又来了' } } }
  const replyer2 = new HumanizeReplyer({ provider: provider2, cfg: () => ({}), getRecentBotTexts: () => ['笑死，真服了', '笑死，绷不住了'] })
  await replyer2.generate({ action: { replyGuide: '接一句' }, batch: [target], target, runtime, signal: null, cfg: {}, scene: mkScene({ sceneType: 'banter' }) })
  ok(calls2 === 2, `重生成仍同款也只重试一次（calls=${calls2}）`)
})

// ───────── 8. 自定义 personaName：全链路同一身份，无「机器人/江野」残留 ─────────
await test('S8 身份单一来源：personaName=小舟 → Planner/Replyer/persona 均为小舟，无旧名残留', async () => {
  const cfg = validateHumanizeConfig({ personaName: '小舟' }).config
  const identity = resolvePersonaIdentity(cfg)
  ok(identity.name === '小舟', `resolvePersonaIdentity 取旧字段 personaName（实际 ${identity.name}）`)
  const psys = buildPlannerSystem({ personaName: identity.name, groupContext: '甲: hi' })
  ok(psys.includes('「小舟」') && !psys.includes('江野') && !psys.includes('机器人「'), 'Planner 标题为小舟，无机器人/江野')
  const rsys = buildReplyerSystem({ personaName: identity.name, personaVoice: DEFAULT_HUMANIZE_PERSONA.prompt })
  ok(rsys.includes('你就是小舟') && !rsys.includes('江野') && !rsys.includes('机器人「'), 'Replyer 第一人称为小舟，无江野/机器人')
  ok(!DEFAULT_HUMANIZE_PERSONA.prompt.includes('小舟') && !DEFAULT_HUMANIZE_PERSONA.prompt.includes('江野'), '默认人设正文不写死姓名（配任何显示名都自洽）')
})

// ───────── 9. Planner prompt 快照不含完整 PersonaVoice ─────────
await test('S9 Planner 无 PersonaVoice：人设正文只进 Replyer，决策器只见角色名', async () => {
  const { runtime } = mkCtx()
  let plannerSystem = ''
  let replyerSystem = ''
  const MARK = ' uniquely-marked-persona-voice-content 独占标记：爱在深夜部署前吃螺蛳粉 '
  const planner = new HumanizePlanner({
    provider: { chat: async ({ system }) => { plannerSystem = system; return { content: '', toolCalls: [], finishReason: 'stop' } } },
    cfg: () => ({ planner: { maxRounds: 1 } }),
    getPersonaName: () => '小舟',
  })
  const target = mkMsg('怎么看这个方案', { id: 't9' })
  await planner.decide({ snapshot: [target], decision: { targetMessage: target }, runtime, cfg: { planner: { maxRounds: 1 } }, scene: mkScene() })
  const replyer = new HumanizeReplyer({
    provider: { chat: async ({ system }) => { replyerSystem = system; return { content: '嗯' } } },
    cfg: () => ({}), getPersonaVoice: () => MARK,
  })
  await replyer.generate({ action: { replyGuide: '接一句' }, batch: [target], target, runtime, signal: null, cfg: {}, scene: mkScene() })
  ok(!plannerSystem.includes('uniquely-marked-persona-voice-content') && !plannerSystem.includes('螺蛳粉'), 'Planner system 不含 PersonaVoice 正文')
  ok(plannerSystem.includes('「小舟」'), 'Planner 仍知道角色名（态度决策够用）')
  ok(replyerSystem.includes('螺蛳粉'), 'Replyer system 含完整 PersonaVoice')
})

// ───────── 10. SelfState Appraiser 收到真实 scene ─────────
await test('S10 SS appraiser scene 非空：onMessage 透传 ConversationScene（规则场景）', async () => {
  const TMP = path.join(os.tmpdir(), `ss-scene-${process.pid}`)
  fs.rmSync(TMP, { recursive: true, force: true })
  const svc = new SelfStateService({
    provider: { chat: async () => ({ content: '{}' }) },
    cfg: () => ({ enabled: true, shadowMode: true, eventDetection: { directReply: true, minEventConfidence: 0.3 }, emotion: {}, expectations: { enabled: true }, planner: {}, replyer: {}, stability: {}, retention: {} }),
    botId: '999', botNames: ['小舟'], trace: { record() {} }, dataDir: TMP,
  })
  await svc.init()
  let captured = 'NEVER'
  svc.appraiser = { appraise: async (args) => { captured = args.scene; return null } }
  const norm = mkMsg('小舟 你这代码写得真菜', { userId: 'uA', groupId: 'G', quotesBot: true, replyToId: 'b1', id: 'ss_s10' })
  const scene = ruleScene([norm], null)
  await svc.onMessage(norm, { groupId: 'G', quoteIsBot: true, scene })
  ok(captured !== 'NEVER' && captured != null && Object.keys(captured).length > 0, `appraiser 收到 scene（此前恒 {}；实际 ${JSON.stringify(captured && captured.sceneType)}）`)
  ok(captured?.sceneType === 'banter' || captured?.sceneType, `scene 为 ConversationScene 产物（sceneType=${captured?.sceneType}）`)
  Db.closeDb()
  fs.rmSync(TMP, { recursive: true, force: true })
})

// ───────── 11. LLM 非法 JSON / 超时 / 低置信 → 安全降级 ─────────
await test('S11 降级：非法 JSON / 超时 / 低置信都回落规则场景且不阻塞', async () => {
  const win = [mkMsg('真服了，部署又炸了', { id: 'd1' })]
  // 非法 JSON
  const a1 = new ConversationSceneAnalyzer({ provider: { chat: async () => ({ content: '这不是JSON' }) }, trace: { record() {} } })
  const s1 = await a1.analyze({ groupId: 'g', messages: win })
  ok(s1.degraded === 'invalid_json' && s1.sceneType === 'venting', `非法 JSON → 降级规则场景（degraded=${s1.degraded}, type=${s1.sceneType}）`)
  // 超时/异常
  const a2 = new ConversationSceneAnalyzer({ provider: { chat: async () => { throw new Error('aborted: timeout') } }, trace: { record() {} } })
  const s2 = await a2.analyze({ groupId: 'g2', messages: win })
  ok(s2.degraded === 'timeout' && s2.sceneType === 'venting', `超时 → 降级（degraded=${s2.degraded}）`)
  // 低置信
  const a3 = new ConversationSceneAnalyzer({ provider: { chat: async () => ({ content: JSON.stringify({ sceneType: 'debate', confidence: 0.1 }) }) }, trace: { record() {} } })
  const s3 = await a3.analyze({ groupId: 'g3', messages: win })
  ok(s3.degraded === 'low_confidence' && s3.sceneType === 'venting', `低置信 → 降级规则结果（degraded=${s3.degraded}, type=${s3.sceneType}）`)
  // 无 provider（纯规则模式）
  const a4 = new ConversationSceneAnalyzer({ trace: { record() {} } })
  const s4 = await a4.analyze({ groupId: 'g4', messages: win })
  ok(s4.degraded === 'no_provider' && s4.sceneType === 'venting', '无 provider → 规则模式')
})

// ───────── 12. ConversationScene 不覆盖 Grounding 事实 ─────────
await test('S12 Grounding 事实保护：LLM 伪参与者/伪造证据被丢弃，发言对象不被改写', async () => {
  const bMsg = mkMsg('服务器又炸了', { userId: 'uB', displayName: '乙', id: 'gb' })
  const aMsg = mkMsg('乙你可真会挑时候', { userId: 'uA', displayName: '甲', id: 'ga', replyToId: 'gb' })
  const grounding = resolveGrounding([bMsg, aMsg])
  ok(grounding.quoted?.userId === 'uB', '前置：Grounding 判定被回复者=uB')
  // LLM 声称 speaker 是 u9、证据是伪造 id
  const provider = { chat: async () => ({ content: JSON.stringify({
    sceneType: 'banter', speechAct: 'tease', tones: ['sarcastic'], phase: 'peak',
    directedAtBot: 0.9, replyAffordance: 0.9, humanMomentum: 0.1, ambiguity: 0, confidence: 0.9,
    evidenceMessageIds: ['FAKE_ID_1'],
    participants: [{ userId: 'u9', role: 'speaker' }, { userId: 'uB', role: 'audience' }],
  }) }) }
  const analyzer = new ConversationSceneAnalyzer({ provider, trace: { record() {} } })
  const scene = await analyzer.analyze({ groupId: 'g', messages: [bMsg, aMsg], grounding })
  ok(scene.source === 'llm' && scene.sceneType === 'banter', 'LLM 分类被采纳')
  ok(!scene.evidenceMessageIds.includes('FAKE_ID_1'), `伪造证据 id 被丢弃（实际 ${JSON.stringify(scene.evidenceMessageIds)}）`)
  const roles = scene.participants.map((p) => `${p.userId}:${p.role}`).join(',')
  ok(scene.participants.some((p) => p.userId === 'uA' && p.role === 'speaker'), `speaker=uA 来自 Grounding（实际 ${roles}）`)
  ok(scene.participants.some((p) => p.userId === 'uB' && p.role === 'target'), `target=uB 来自 Grounding（实际 ${roles}）`)
  ok(!scene.participants.some((p) => p.userId === 'u9'), 'LLM 伪造参与者 u9 不入结果')
  // 数值也回归 Grounding 口径：指向机器人仍是 0（甲在回复乙，不是在叫我）
  ok(scene.directedAtBot <= 0.5, `directedAtBot 不被 LLM 抬高到认领（实际 ${scene.directedAtBot}；hysteresis 数值取规则基线）`)
})

// ───────── 附：缓存失效 + hysteresis 平滑 ─────────
await test('附：场景缓存按 lastMessageId 失效 + 场景翻转 hysteresis', async () => {
  let calls = 0
  const provider = { chat: async () => { calls++; return { content: JSON.stringify({ sceneType: 'banter', tones: ['playful'], confidence: 0.9 }) } } }
  const a = new ConversationSceneAnalyzer({ provider, trace: { record() {} } })
  const w1 = [mkMsg('哈哈这图绝了', { id: 'h1' })]
  await a.analyze({ groupId: 'gc', messages: w1 })
  await a.analyze({ groupId: 'gc', messages: w1 }) // 同 lastMessageId → 缓存
  ok(calls === 1, `同 lastMessageId 命中缓存（calls=${calls}）`)
  await a.analyze({ groupId: 'gc', messages: [mkMsg('哈哈这图绝了', { id: 'h1' }), mkMsg('再发一张', { id: 'h2' })] })
  ok(calls === 2, '新消息到达 → 缓存失效重分析')
  // hysteresis：低优势翻转被平滑、足够优势才翻转
  const seq = [
    { sceneType: 'banter', confidence: 0.6 },  // 首轮：banter 0.6
    { sceneType: 'debate', confidence: 0.9 },  // 0.9 ≥ 0.6+0.15 → 允许翻转为 debate
    { sceneType: 'banter', confidence: 0.8 },  // 0.8 < 0.9+0.15 → 优势不足，平滑回 debate
  ]
  let i = 0
  const a2 = new ConversationSceneAnalyzer({ provider: { chat: async () => ({ content: JSON.stringify(seq[Math.min(i++, seq.length - 1)]) }) }, trace: { record() {} } })
  const t0 = Date.now()
  const s1 = await a2.analyze({ groupId: 'gh', messages: [mkMsg('x', { id: 'z1', timestamp: t0 })] })
  ok(s1.sceneType === 'banter' && !s1.smoothed, `首轮 banter（实际 ${s1.sceneType}）`)
  const s2 = await a2.analyze({ groupId: 'gh', messages: [mkMsg('x', { id: 'z1', timestamp: t0 }), mkMsg('y', { id: 'z2', timestamp: t0 + 1000 })] })
  ok(s2.sceneType === 'debate' && !s2.smoothed, `优势足够（0.9≥0.75）→ 翻转成立（实际 ${s2.sceneType}）`)
  const s3 = await a2.analyze({ groupId: 'gh', messages: [mkMsg('x', { id: 'z1', timestamp: t0 }), mkMsg('y', { id: 'z2', timestamp: t0 + 1000 }), mkMsg('w', { id: 'z3', timestamp: t0 + 2000 })] })
  ok(s3.smoothed === true && s3.sceneType === 'debate' && s3.ambiguity > s2.ambiguity, `低优势翻转（0.8<1.05）被平滑回 debate 且歧义上调（smoothed=${s3.smoothed}）`)
})

// ───────── 总结 ─────────
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
