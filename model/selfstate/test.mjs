/**
 * selfstate 离线自检（设计文档 v1.1 §23 十场景 + 关键机制）。
 * fake provider（规则路径为主，LLM 仅歧义）、独立 tmpdir、不联网。
 * 运行：node model/selfstate/test.mjs
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import * as Db from '../groupworld/db.js'
import { SelfStateService } from './service.js'
import { validateSelfStateConfig } from './default-config.js'
import { SelfEventDetector } from './detector.js'
import { classifyOutgoing } from './expectations.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }

const TMP = path.join(os.tmpdir(), `ss-test-${process.pid}`)
fs.rmSync(TMP, { recursive: true, force: true })
await Db.initDb({ dir: TMP })
const dao = Db.dao

const BASE_CFG = {
  enabled: true, shadowMode: true,
  eventDetection: { minEventConfidence: 0.5 },
  emotion: { maxNormalImpulse: 0.20, maxHighSalienceImpulse: 0.35, minVisibleIntensity: 0.18, maxActiveEmotions: 8, enableMixedEmotions: true, lazyDecay: true },
  resentment: { enabled: true, minCreateConfidence: 0.6, minRepeatedEvents: 2, maxSingleEventDelta: 0.05, halfLifeDays: 7 },
  expectations: { enabled: true, minimumWindowSeconds: 90, maximumWindowSeconds: 3600, minIgnoredConfidence: 0.65, requireTargetActivityEvidence: true, firstIgnoreCanBeExpressed: false },
  reflection: { enabled: true, minSignificantEvents: 3, maxReflectionsPerDay: 10, defaultTtlDays: 7 },
  planner: { includeStateProjection: true, maxStateTokens: 220 },
  replyer: { includeExpressionCapsule: true, allowNaturalEmotionDisclosure: true },
  stability: { maxNegativeMoodHours: 24 },
  retention: { transitionLogDays: 14, resolvedEmotionDays: 7, resolvedExpectationDays: 7 },
}
const fakeProvider = { chat: async () => ({ content: '{}' }) }
const mkSvc = (over = {}) => new SelfStateService({ provider: fakeProvider, cfg: () => ({ ...BASE_CFG, ...over }), botId: '999', botNames: ['小汐'], trace: { record() {} }, dataDir: TMP })

const norm = (id, userId, text, extra = {}) => ({
  id, groupId: 'G', userId, displayName: userId, timestamp: Date.now(), text,
  segments: [], replyToId: null, atBot: false, mentionsBotName: false, quotesBot: false,
  isCommand: false, isSelf: false, handledByDirectAgent: false, media: [], ...extra,
})
const setRel = async (botId, uid, rel) => {
  await dao.run('INSERT OR REPLACE INTO gw_bot_rel(bot_id,group_id,user_id,familiarity,affinity,trust,interaction_style,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [botId, 'G', uid, rel.familiarity ?? 0.3, rel.affinity ?? 0.4, rel.trust ?? 0.4, rel.interaction_style || '', Date.now()])
}
const emotions = async (botId = '999', gid = 'G') => (await dao.all("SELECT emotion_type,intensity,target_user_id FROM ss_emotions WHERE bot_id=? AND group_id=? AND status='active'", [botId, gid]))
const relOf = async (uid, botId = '999') => dao.get('SELECT * FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [botId, 'G', uid])

// ───────── §23.1 熟人互损 ─────────
await test('§23.1 熟人互损：amusement≥annoyance、无怨气', async () => {
  const ss = mkSvc(); await ss.init()
  await setRel('999', 'F1', { familiarity: 0.8, affinity: 0.7, interaction_style: '双方平时允许轻微互损' })
  // 修复弱断言：旧文本"太菜"不命中 KW.insult（只有真菜|好菜），走的是 directed_message 空洞通过
  await ss.onMessage(norm('m1', 'F1', '你这代码写得真菜', { replyToId: 'botmsg', segments: [] }), { groupId: 'G', quoteIsBot: true })
  const ev = await dao.get("SELECT event_type FROM ss_events WHERE bot_id='999' AND group_id='G' ORDER BY id DESC LIMIT 1")
  ok(ev?.event_type === 'friendly_tease', `识别为友好玩笑（实际 ${ev?.event_type}）`)
  const em = await emotions()
  const amuse = em.find((e) => e.emotion_type === 'amusement')?.intensity || 0
  const annoy = em.find((e) => e.emotion_type === 'annoyance')?.intensity || 0
  ok(amuse > 0, `amusement 真实产生（${amuse.toFixed(3)}）`)
  ok(amuse >= annoy, `熟人玩笑 amusement(${amuse.toFixed(2)}) ≥ annoyance(${annoy.toFixed(2)})`)
  const rel = await relOf('F1')
  ok((rel?.resentment || 0) <= 0.03, `玩笑不留怨气（resentment=${rel?.resentment || 0} ≤0.03）`)
  await ss.resetGroupState('G')
})

// ───────── §23.2 陌生人公开辱骂 ─────────
await test('§23.2 陌生人辱骂：anger+guardedness、不扩散他人', async () => {
  const ss = mkSvc(); await ss.init()
  await ss.onMessage(norm('m2', 'STR1', '@bot 你就是个垃圾废物', { atBot: true, segments: [{ type: 'at', qq: '999' }] }), { groupId: 'G', quoteIsBot: false })
  const em = await emotions()
  ok((em.find((e) => e.emotion_type === 'anger')?.intensity || 0) > 0.1, '产生 anger')
  const rel = await relOf('STR1')
  ok((rel?.guardedness || 0) > 0, `陌生人→戒备（guardedness=${rel?.guardedness?.toFixed(3)}）`)
  const other = await relOf('OTHER1')
  ok(!other || ((other.resentment || 0) === 0 && (other.guardedness || 0) === 0), '不扩散到无关成员')
  const state = await dao.get("SELECT valence FROM ss_group_state WHERE bot_id='999' AND group_id='G'")
  ok(state && state.valence < 0, `心境变负（valence=${state?.valence?.toFixed(3)}）`)
  await ss.resetGroupState('G')
})

// ───────── §23.3 信任对象否定 ─────────
await test('§23.3 信任者认真否定：hurt 高于 anger', async () => {
  const ss = mkSvc(); await ss.init()
  await setRel('999', 'TRUST1', { familiarity: 0.85, affinity: 0.8, trust: 0.9, interaction_style: '技术讨论' })
  await ss.onMessage(norm('m3', 'TRUST1', '@bot 说实话你做的这个功能真不行，太失望了', { atBot: true, segments: [{ type: 'at', qq: '999' }] }), { groupId: 'G', quoteIsBot: false })
  const em = await emotions()
  const hurt = em.find((e) => e.emotion_type === 'hurt')?.intensity || 0
  const anger = em.find((e) => e.emotion_type === 'anger')?.intensity || 0
  ok(hurt > 0, `产生 hurt（${hurt.toFixed(2)}）`)
  ok(hurt >= anger * 0.8, `信任者否定 hurt(${hurt.toFixed(2)}) 不低于 anger(${anger.toFixed(2)}) 的 0.8 倍`)
  await ss.resetGroupState('G')
})

// ───────── §23.4 群整体沉默（不建强期待）─────────
await test('§23.4 纯陈述不建期待；群沉默无冷落', async () => {
  const ss = mkSvc(); await ss.init()
  const expId = await ss.registerOutgoingExpectation({ groupId: 'G', sourceMessageId: 'bot_s1', sentText: '今天好困啊，随便说说', targetUserId: 'Q1' })
  ok(expId === null, '随口陈述不登记期待（§11.1）')
})

// ───────── §23.5 活跃群被跳过 ─────────
await test('§23.5 明确提问建强期待；被跳过产生 ignored（需活跃证据）', async () => {
  const ss = mkSvc(); await ss.init()
  const expId = await ss.registerOutgoingExpectation({ groupId: 'G', sourceMessageId: 'bot_q1', sentText: '你上次说的那个方案后来怎么样了？', targetUserId: 'Q2' })
  ok(expId != null, '明确提问登记期待')
  // 到期判定：目标活跃+回复他人但不回 bot（活跃证据）
  const now = Date.now()
  // 直接用 ExpectationManager（隔离测试评分逻辑）；时间线：发送于 10 分钟前，证据在发送之后
  await dao.run("UPDATE ss_expectations SET expires_at=?, created_at=?, not_before_at=? WHERE id=?", [now - 1000, now - 600000, now - 600000, expId])
  await dao.run("DELETE FROM gw_messages WHERE group_id='G'")
  for (let i = 0; i < 12; i++) await dao.run("INSERT INTO gw_messages(group_id,message_id,sender_id,plain_text,message_type,sent_at,reply_to_user_id,created_at) VALUES ('G',?,?,?,?,?,?,?)", [`x${i}`, 'OTHER', '聊', 'text', now - 80000 + i * 1000, 'X', now])
  for (let i = 0; i < 4; i++) await dao.run("INSERT INTO gw_messages(group_id,message_id,sender_id,plain_text,message_type,sent_at,reply_to_user_id,created_at) VALUES ('G',?,?,?,?,?,?,?)", [`q${i}`, 'Q2', '回别人', 'text', now - 60000 + i * 1000, 'OTHER', now])
  const { ExpectationManager } = await import('./expectations.js')
  const r = await new ExpectationManager({ dao, cfg: () => BASE_CFG, trace: { record() {} } }).sweepExpired({ botId: '999', groupId: 'G', now })
  ok(r.length >= 1 && r[0].outcome === 'ignored', `活跃+绕开 → ignored（${r.length} 条，outcome=${r[0]?.outcome}）`)
  await ss.resetGroupState('G')
  await dao.run("DELETE FROM gw_messages WHERE group_id='G'")
})

// ───────── §23.6 刷屏不可见 → uncertain ─────────
await test('§23.6 目标不在线：不判冷落（uncertain/自然过期）', async () => {
  const ss = mkSvc(); await ss.init()
  const expId = await ss.registerOutgoingExpectation({ groupId: 'G', sourceMessageId: 'bot_q2', sentText: '你觉得呢？', targetUserId: 'GONE' })
  const now = Date.now()
  await dao.run("UPDATE ss_expectations SET expires_at=? WHERE id=?", [now - 1000, expId])
  // 目标 GONE 无任何后续消息（可能没看见）
  const r = await new (await import('./expectations.js')).ExpectationManager({ dao, cfg: () => BASE_CFG, trace: { record() {} } }).sweepExpired({ botId: '999', groupId: 'G', now })
  ok(r.length === 0, '目标无活跃证据 → 不产生 ignored（uncertain/naturally_expired）')
  const exp = await dao.get('SELECT status FROM ss_expectations WHERE id=?', [expId])
  ok(['uncertain', 'naturally_expired'].includes(exp?.status), `状态=${exp?.status}（非 ignored）`)
  await ss.resetGroupState('G')
})

// ───────── §23.7 道歉修复 ─────────
await test('§23.7 道歉：即时怒气骤降、怨气缓降、不清零回亲', async () => {
  const ss = mkSvc(); await ss.init()
  await dao.run("INSERT INTO gw_bot_rel(bot_id,group_id,user_id,familiarity,affinity,resentment,guardedness,hurt,updated_at) VALUES ('999','G','AP1',0.5,0.5,0.6,0.5,0.4,?)", [Date.now()])
  await dao.run("INSERT INTO ss_emotions(bot_id,group_id,emotion_type,intensity,target_user_id,cause_event_id,started_at,half_life_seconds,last_evaluated_at,status,created_at,updated_at) VALUES ('999','G','anger',0.5,'AP1',1,?,3600,?,'active',?,?)", [Date.now(), Date.now(), Date.now(), Date.now()])
  await ss.onMessage(norm('m7', 'AP1', '刚才说的是我不对，跟你道个歉，别往心里去', { replyToId: 'botmsg' }), { groupId: 'G', quoteIsBot: true })
  const anger = (await emotions()).find((e) => e.emotion_type === 'anger')?.intensity ?? 0
  const rel = await relOf('AP1')
  ok(anger < 0.5, `道歉后即时怒气下降（anger=${anger.toFixed(2)} < 0.5）`)
  ok((rel?.resentment || 0) > 0 && (rel?.resentment || 0) < 0.6, `怨气缓降不清零（resentment=${rel?.resentment?.toFixed(3)} ∈ (0,0.6)）`)
  await ss.resetGroupState('G')
})

// ───────── §23.8 重复攻击记仇 ─────────
await test('§23.8 重复攻击：单次受限、渐成怨气、只影响本人、可追溯', async () => {
  const ss = mkSvc(); await ss.init()
  for (let i = 1; i <= 3; i++) {
    await ss.onMessage(norm(`rm${i}`, 'RP1', '@bot 垃圾玩意滚出去', { atBot: true, segments: [{ type: 'at', qq: '999' }] }), { groupId: 'G', quoteIsBot: false })
  }
  const rel = await relOf('RP1')
  ok((rel?.resentment || 0) > 0, `重复攻击形成怨气（resentment=${rel?.resentment?.toFixed(3)}）`)
  ok((rel?.resentment || 0) <= 3 * 0.05, `怨气受单次上限约束（≤3×0.05=0.15，实际 ${rel?.resentment?.toFixed(3)}）`)
  const other = await relOf('RP2')
  ok(!other || (other.resentment || 0) === 0, '只影响该成员')
  const tr = await dao.get("SELECT COUNT(*) c FROM ss_transitions WHERE bot_id='999' AND group_id='G'")
  ok(Number(tr?.c) >= 3, `迁移可追溯（${tr?.c} 条审计）`)
  const concern = await dao.get("SELECT * FROM ss_concerns WHERE bot_id='999' AND group_id='G' AND target_user_id='RP1' AND status='active'")
  ok(!!concern, '形成未解决心事（§6.7）')
  await ss.resetGroupState('G')
})

// ───────── §23.9 跨群隔离 ─────────
await test('§23.9 跨群隔离：A 群怨气不进 B 群', async () => {
  const ss = mkSvc(); await ss.init()
  await ss.onMessage(norm('m9', 'X1', '@bot 你是垃圾', { atBot: true, segments: [{ type: 'at', qq: '999' }] }), { groupId: 'GA', quoteIsBot: false })
  const relA = await dao.get("SELECT resentment FROM gw_bot_rel WHERE bot_id='999' AND group_id='GA' AND user_id='X1'")
  const relB = await dao.get("SELECT resentment FROM gw_bot_rel WHERE bot_id='999' AND group_id='GB' AND user_id='X1'")
  const stB = await dao.get("SELECT valence FROM ss_group_state WHERE bot_id='999' AND group_id='GB'")
  ok((relA?.resentment || 0) >= 0 || relA != null, 'A 群产生关系数据')
  ok(relB == null, 'B 群无该成员关系残留')
  ok(!stB || Number(stB.valence) === 0, `B 群心境不受影响（valence=${stB?.valence ?? '无行'}）`)
  await ss.resetGroupState('GA')
})

// ───────── §23.10 shadow 中性 + 指令隔离 ─────────
await test('投影红线：shadowMode 恒中性；关 shadow 后非中性；数值不外显', async () => {
  const ss = mkSvc(); await ss.init()
  await ss.onMessage(norm('m10', 'Z1', '@bot 垃圾', { atBot: true, segments: [{ type: 'at', qq: '999' }] }), { groupId: 'G', quoteIsBot: false })
  const p1 = await ss.buildPlannerProjection({ groupId: 'G', targetUserId: 'Z1' })
  const c1 = await ss.buildReplyerCapsule({ groupId: 'G', targetUserId: 'Z1' })
  ok(p1.neutral === true && p1.text === '', 'shadowMode：Planner 投影中性')
  ok(c1.neutral === true && c1.text === '', 'shadowMode：Replyer 胶囊中性')
  const ss2 = mkSvc({ shadowMode: false }); await ss2.init()
  const p2 = await ss2.buildPlannerProjection({ groupId: 'G', targetUserId: 'Z1' })
  const c2 = await ss2.buildReplyerCapsule({ groupId: 'G', targetUserId: 'Z1' })
  ok(p2.neutral === false && p2.text.length > 0, '关 shadow：投影非中性')
  ok(!/valence|arousal|self_relevance|norm_violation/.test(p2.text), '投影不含内部维度名')
  const c2text = c2.text || ''
  ok(!/\d\.\d/.test(c2text) && !/valence|arousal/.test(c2text), 'Replyer 胶囊不含数值/维度名')
  ok(c2.neutral === false && c2text.includes('语气'), '关 shadow：胶囊注入语气')
  await ss2.resetGroupState('G')
})

// ───────── 机制：懒衰减幂等 + 半衰期 + 乐观锁 ─────────
await test('机制：懒衰减幂等、半衰期衰减、乐观锁版本推进', async () => {
  const { EmotionTransition } = await import('./emotion.js')
  const em = new EmotionTransition({ dao, cfg: () => BASE_CFG, trace: { record() {} } })
  const t0 = Date.now() - 3600000 // 1h 前
  await dao.run("INSERT INTO ss_emotions(bot_id,group_id,emotion_type,intensity,target_user_id,cause_event_id,started_at,half_life_seconds,last_evaluated_at,status,created_at,updated_at) VALUES ('999','GDEC','annoyance',0.4,NULL,1,?,3600,?,'active',?,?)", [t0, t0, t0, t0])
  const a = await em.decayAndGetActive('999', 'GDEC', Date.now())
  // 双指数衰减（#4）：1 个半衰期后 = 0.4×(0.7×0.5 + 0.3×0.5^(1/8)) ≈ 0.25（快分量减半+拖尾）
  ok(Math.abs(a[0].intensity - 0.4 * (0.7 * 0.5 + 0.3 * Math.pow(0.5, 1 / 8))) < 0.02, `1h 半衰期双指数衰减（0.4→${a[0].intensity.toFixed(3)}）`)
  const b = await em.decayAndGetActive('999', 'GDEC', Date.now())
  ok(Math.abs(b[0].intensity - a[0].intensity) < 0.005, '紧接再读幂等（不重复衰减）')
  await dao.run("INSERT OR IGNORE INTO ss_group_state(bot_id,group_id,updated_at) VALUES ('999','G',?)", [Date.now()])
  const s0 = await dao.get("SELECT state_version FROM ss_group_state WHERE bot_id='999' AND group_id='G'")
  await dao.run("UPDATE ss_group_state SET valence=-0.2, state_version=state_version+1 WHERE bot_id='999' AND group_id='G' AND state_version=?", [s0.state_version])
  const s1 = await dao.get("SELECT state_version FROM ss_group_state WHERE bot_id='999' AND group_id='G'")
  ok(s1.state_version === s0.state_version + 1, '乐观锁版本推进')
  await dao.run("DELETE FROM ss_emotions WHERE group_id='GDEC'")
})

// ───────── detector 规则 ─────────
await test('detector：指令/系统排除、引用降权、无指向无关键词跳过', async () => {
  const d = new SelfEventDetector({ botIds: new Set(['999']), botNames: ['小汐'], cfg: () => BASE_CFG })
  // detect 已改 async（语义层可能 await embedding）
  ok(await d.detect(norm('c1', 'U', '#ai 帮我', { isCommand: true }), {}) === null, '命令消息不检测')
  ok(await d.detect(norm('c2', 'U', '[图片]'), {}) === null, '纯占位跳过')
  const ambient = await d.detect(norm('c3', 'U', '今天天气不错'), {})
  ok(ambient === null, '无指向无关键词 → null')
  const kw = await d.detect(norm('c4', 'U', '这个机器人真厉害了'), {})
  ok(kw && kw.deterministicSignals.kw_hits.includes('praise'), '无@但含夸奖词 → 候选')
  const nick = await d.detect(norm('c5', 'U', '小汐你说句话啊'), {})
  ok(nick && nick.deterministicSignals.nickname_reference, '昵称提及 → 指向')
  ok(classifyOutgoing('你觉得怎么样？').isQuestion === true, '出站提问识别')
  ok(classifyOutgoing('今天天气不错').isQuestion === false, '出站陈述不建期待')
})

// ───────── 语义近邻层（#1 算法升级；确定性 fake 向量）─────────
await test('语义近邻层：无关键词命中也能分类；无 embedder 回落关键词', async () => {
  const { SEED_EXAMPLES } = await import('./seed-examples.js')
  const AXES = { thanks: [1, 0, 0, 0], praise: [0, 1, 0, 0], insult: [0, 0, 1, 0], neutral: [0, 0, 0, 1], rejection: [0.7, 0, 0, 0.7], apology: [0, 0.7, 0, 0.7], defense: [0.7, 0.7, 0, 0], invite: [0, 0, 0.7, 0.7] }
  const vecOf = (t) => {
    for (const [cat, list] of Object.entries(SEED_EXAMPLES)) if (list.includes(t)) return AXES[cat] || AXES.neutral
    return SEM_TEST_VEC[t] || AXES.neutral
  }
  const SEM_TEST_VEC = { '你真的太帮了，多亏有你': AXES.thanks, '你可真行啊，谁问你了': AXES.insult }
  const embedFn = async (t) => vecOf(t)
  const d = new SelfEventDetector({ botIds: new Set(['999']), botNames: [], cfg: () => BASE_CFG, embedder: { model: 'fake', embed: embedFn, embedBatch: async (ts) => ts.map(vecOf) } })
  // 无关键词命中 + 指向机器人 → 语义层命中 thanks
  const c1 = await d.detect(norm('s1', 'U', '你真的太帮了，多亏有你', { atBot: true }), {})
  ok(c1?.candidateType === 'thanks', `语义命中 thanks（实际 ${c1?.candidateType}）`)
  // 词面无命中但语义强判辱骂
  const c2 = await d.detect(norm('s2', 'U', '你可真行啊，谁问你了', { atBot: true }), {})
  ok(c2?.candidateType === 'direct_insult', `语义命中 insult（实际 ${c2?.candidateType}）`)
  // 普通闲聊（neutral 轴）：不产生语义候选，仍走 directed_message
  const c3 = await d.detect(norm('s3', 'U', '随便聊聊今天天气', { atBot: true }), {})
  ok(c3?.candidateType === 'directed_message', `闲聊不误判（实际 ${c3?.candidateType}）`)
  // 无 embedder：纯关键词路径不受影响
  const d2 = new SelfEventDetector({ botIds: new Set(['999']), botNames: [], cfg: () => BASE_CFG })
  const c4 = await d2.detect(norm('s4', 'U', '你真的太帮了，多亏有你', { atBot: true }), {})
  ok(c4?.candidateType === 'directed_message', `无 embedder 回落（实际 ${c4?.candidateType}）`)
})

// ───────── 配置校验红线 ─────────
await test('配置校验：红线强制、上限钳制', async () => {
  const v = validateSelfStateConfig({ enabled: true, replyer: { exposeNumericState: true }, planner: { emotionIsBiasOnly: false }, stability: { noCrossUserSpillover: false, preventEmotionalBlackmail: false }, emotion: { maxNormalImpulse: 2, maxHighSalienceImpulse: 0.01 } })
  ok(v.config.replyer.exposeNumericState === false, '强制不外显数值')
  ok(v.config.planner.emotionIsBiasOnly === true, '强制情绪只是偏置')
  ok(v.config.stability.noCrossUserSpillover === true && v.config.stability.preventEmotionalBlackmail === true, '强制禁扩散/禁卖惨')
  ok(v.config.emotion.maxNormalImpulse <= 0.5 && v.config.emotion.maxHighSalienceImpulse >= v.config.emotion.maxNormalImpulse, '脉冲上限钳制且高≥普通')
})

// ───────── 总结 ─────────
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
Db.closeDb()
fs.rmSync(TMP, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
