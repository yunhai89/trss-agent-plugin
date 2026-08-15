/**
 * SelfState 期待/冷落链路离线压测（设计文档 v1.1 §11/§16）。
 *
 * 只读源码不改库；复用 model/selfstate/test.mjs 套路：fakeProvider + tmpdir + 手插 gw_messages 制造活跃证据。
 * 运行：node stress/ss-expectation.mjs
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import * as Db from '../model/groupworld/db.js'
import { SelfStateService } from '../model/selfstate/service.js'
import { ExpectationManager, classifyOutgoing } from '../model/selfstate/expectations.js'

let passed = 0, failed = 0, bugs = []
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function bug(file, line, desc, repro) { bugs.push({ file, line, desc, repro }); console.error(`  🐛 BUG ${file}:${line} ${desc}\n     复现: ${repro}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 4).join('\n')) } }

const TMP = path.join(os.tmpdir(), `ss-stress-${process.pid}`)
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
/** 手插 gw_messages 制造活跃证据（SS 的 judge 只认 gw_messages，不认 norm 本身） */
const insMsg = (gid, mid, sender, sentAt, replyToUser = null) =>
  dao.run('INSERT INTO gw_messages(group_id,message_id,sender_id,plain_text,message_type,sent_at,reply_to_user_id,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [gid, mid, sender, '聊天内容', 'text', sentAt, replyToUser, sentAt])
const expRow = (id) => dao.get('SELECT * FROM ss_expectations WHERE id=?', [id])
const ignoredEvents = (gid) => dao.all("SELECT * FROM ss_events WHERE bot_id='999' AND group_id=? AND event_type='ignored_expectation'", [gid])
const clearGw = (gid) => dao.run('DELETE FROM gw_messages WHERE group_id=?', [gid])
/** 把期待改为"刚过期"：created_at 拉回 10min 前，expires_at = now-1s（证据须落在 (created_at, now] 内） */
const forceExpire = async (id, backMs = 600000) => {
  const now = Date.now()
  await dao.run('UPDATE ss_expectations SET created_at=?, not_before_at=?, expires_at=? WHERE id=?', [now - backMs, now - backMs, now - 1000, id])
  return now
}
/** 造"活跃+绕开"证据：others 条无关消息 + targetReplies 条目标回复他人的消息 */
const seedBypassEvidence = async (gid, target, others, targetReplies, now) => {
  for (let i = 0; i < others; i++) await insMsg(gid, `ob${gid}_${i}`, 'OTHER', now - 590000 + i * 1000)
  for (let i = 0; i < targetReplies; i++) await insMsg(gid, `tr${gid}_${i}`, target, now - 580000 + i * 1000, 'SOMEONE')
}
const QUESTION = '你上次说的那个方案后来怎么样了？'

// ═══════════════ 1. 回归（核心）：高置信冷落事件不丢 ═══════════════
await test('1. 回归：到期期待 + 同一条后续消息 → sweepExpired 接住并产出 ignored_expectation 事件', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'R1'
  const expId = await ss.registerOutgoingExpectation({ groupId: G, sourceMessageId: 'bot_q', sentText: QUESTION, targetUserId: 'T1' })
  ok(expId != null, `注册带 target 的强期待（id=${expId}）`)
  const now = await forceExpire(expId)
  await seedBypassEvidence(G, 'T1', 12, 3, now) // 群活跃 + 目标回复他人绕开机器人
  // 同一条后续消息（模拟活跃群节奏）：目标回复他人、非机器人
  const r = await ss.onMessage(norm('after1', 'T1', '这游戏挺好玩的', { replyToId: 'othermsg' }), { groupId: G, quoteIsBot: false })
  const row = await expRow(expId)
  ok(row?.status === 'ignored' && row?.outcome === 'ignored', `期待 status/outcome=ignored（实际 ${row?.status}/${row?.outcome}）`)
  const evs = await ignoredEvents(G)
  ok(evs.length === 1 && evs[0].actor_user_id === 'T1', `ss_events 产出 1 条 ignored_expectation（实际 ${evs.length} 条，actor=${evs[0]?.actor_user_id}）`)
  ok(evs[0] && JSON.parse(evs[0].source_message_ids || '[]')[0] === 'bot_q', `事件锚定源消息 bot_q（实际 ${evs[0]?.source_message_ids}）`)
  ok(r && r.ignored >= 1, `onMessage 返回 ignored>=1（实际 ${r?.ignored}）——修复前此处内联判定后丢弃返回值，事件永久丢失`)
  const emo = await dao.all("SELECT emotion_type,intensity FROM ss_emotions WHERE bot_id='999' AND group_id=? AND status='active'", [G])
  ok(emo.some((e) => e.emotion_type === 'disappointment'), `冷落产生 disappointment 情绪（${emo.map((e) => e.emotion_type).join(',')}）`)
  await clearGw(G)
})

// ═══════════════ 2. 五种生命周期路径 ═══════════════
await test('2a. fulfilled：目标直接回复机器人', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'F1'
  const expId = await ss.registerOutgoingExpectation({ groupId: G, sourceMessageId: 'bot_f', sentText: QUESTION, targetUserId: 'TF' })
  await ss.onMessage(norm('ansTF', 'TF', '还行吧，我觉得方案A更好', { replyToId: 'botmsg' }), { groupId: G, quoteIsBot: true })
  const row = await expRow(expId)
  ok(row?.status === 'fulfilled' && row?.outcome === 'fulfilled', `status/outcome=fulfilled（实际 ${row?.status}/${row?.outcome}）`)
  ok(row?.fulfilled_by_message_id === 'ansTF' && row.resolved_at != null, `fulfilled_by_message_id=ansTF（实际 ${row?.fulfilled_by_message_id}）`)
})

await test('2b. uncertain：目标无活跃证据（可能没看见）', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'F2'
  const expId = await ss.registerOutgoingExpectation({ groupId: G, sourceMessageId: 'bot_u', sentText: QUESTION, targetUserId: 'TU' })
  const now = await forceExpire(expId)
  for (let i = 0; i < 5; i++) await insMsg(G, `o${i}`, 'OTHER', now - 500000 + i * 1000) // 群活跃但目标沉默
  await ss.onMessage(norm('n1', 'OTHER', '今天天气不错'), { groupId: G, quoteIsBot: false })
  const row = await expRow(expId)
  ok(row?.status === 'uncertain' && row?.outcome === 'uncertain', `status/outcome=uncertain（实际 ${row?.status}/${row?.outcome}）`)
  ok((await ignoredEvents(G)).length === 0, '不产生 ignored_expectation 事件（uncertain 不影响关系）')
  await clearGw(G)
})

await test('2c. naturally_expired：全群沉默', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'F3'
  const expId = await ss.registerOutgoingExpectation({ groupId: G, sourceMessageId: 'bot_n', sentText: QUESTION, targetUserId: 'TN' })
  const now = await forceExpire(expId)
  await ss.onMessage(norm('n2', 'QUIET', '嗯'), { groupId: G, quoteIsBot: false }) // norm 不入 gw_messages，群证据仍为空
  const row = await expRow(expId)
  // 实测：目标+全群都沉默时走到的是 uncertain 分支（requireTargetActivityEvidence 先于 groupActiveAfter<2 判定）
  if (row?.status !== 'naturally_expired') {
    bug('model/selfstate/expectations.js', '115-119', `§11.4"群集体沉默→naturally_expired"分支被"目标无活跃→uncertain"遮蔽：目标沉默的群沉默场景永远判 uncertain（两分支判定顺序颠倒，naturally_expired 仅在"目标恰好活跃但全群<2条"时可达）`, `群F3: 目标TN+全群均零消息，到期 → status=${row.status}`)
    ok(row?.status === 'uncertain', `目标+全群均沉默 → 降级 uncertain（实际 ${row?.status}，反证仍生效不判冷落）`)
  } else {
    ok(row?.status === 'naturally_expired', '全群沉默 → naturally_expired')
  }
  ok((await ignoredEvents(G)).length === 0, '全群沉默不产生冷落事件')
})

await test('2c-2. naturally_expired 可达路径：目标仅 1 条消息且全群 <2 条', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'F3B'
  const expId = await ss.registerOutgoingExpectation({ groupId: G, sourceMessageId: 'bot_n2', sentText: QUESTION, targetUserId: 'TN2' })
  const now = await forceExpire(expId)
  await insMsg(G, 'only1', 'TN2', now - 300000) // 目标唯一 1 条、无回复他人
  await ss.onMessage(norm('n2b', 'QUIET', '嗯'), { groupId: G, quoteIsBot: false })
  const row = await expRow(expId)
  ok(row?.status === 'naturally_expired' && row?.outcome === 'naturally_expired', `status/outcome=naturally_expired（实际 ${row?.status}/${row?.outcome}）`)
  ok((await ignoredEvents(G)).length === 0, '无冷落事件')
  await clearGw(G)
})

await test('2f. 无 target 的群级期待：到期判定', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'F6'
  const expId = await ss.registerOutgoingExpectation({ groupId: G, sourceMessageId: 'bot_g', sentText: '大家觉得这个方案怎么样？', targetUserId: null })
  ok(expId != null, '群级提问建期待')
  const now = await forceExpire(expId)
  await seedBypassEvidence(G, 'ANY', 12, 0, now) // 群很活跃、无人回应机器人
  await ss.onMessage(norm('n8', 'OTHER', '继续聊'), { groupId: G, quoteIsBot: false })
  const row = await expRow(expId)
  // 回归（已修）：无 target 的群级期待以群活跃度为证据，群活跃+无人应可正常判定
  ok(row?.status === 'ignored' || row?.status === 'naturally_expired', `群级期待到期可正常判定（实际 ${row?.status}，不再恒 uncertain）`)
  await clearGw(G)
})

await test('2d. ignored：活跃 + 绕开（同 1，独立群复核）', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'F4'
  const expId = await ss.registerOutgoingExpectation({ groupId: G, sourceMessageId: 'bot_i', sentText: QUESTION, targetUserId: 'TI' })
  const now = await forceExpire(expId)
  await seedBypassEvidence(G, 'TI', 12, 3, now)
  await ss.onMessage(norm('n3', 'OTHER', '哈哈哈哈'), { groupId: G, quoteIsBot: false })
  const row = await expRow(expId)
  ok(row?.status === 'ignored' && row?.outcome === 'ignored', `status/outcome=ignored（实际 ${row?.status}/${row?.outcome}，conf=${row?.outcome_confidence}）`)
  ok((await ignoredEvents(G)).length === 1, '产生 1 条 ignored_expectation 事件')
  await clearGw(G)
})

await test('2e. repaired：冷落后目标补回应（道歉）', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'F5'
  const expId = await ss.registerOutgoingExpectation({ groupId: G, sourceMessageId: 'bot_r', sentText: QUESTION, targetUserId: 'TR' })
  const now = await forceExpire(expId)
  await seedBypassEvidence(G, 'TR', 12, 3, now)
  await ss.onMessage(norm('n4', 'OTHER', '随便聊聊'), { groupId: G, quoteIsBot: false })
  ok((await expRow(expId))?.status === 'ignored', '前置：已判 ignored')
  const relBefore = await dao.get('SELECT unresolved_event_count FROM gw_bot_rel WHERE bot_id="999" AND group_id=? AND user_id="TR"', [G])
  // 后续补回应：目标回复机器人并道歉
  await ss.onMessage(norm('n5', 'TR', '刚才没看到消息，不好意思，我来补充一下那个方案', { replyToId: 'botmsg' }), { groupId: G, quoteIsBot: true })
  const apol = await dao.all("SELECT id,event_type FROM ss_events WHERE bot_id='999' AND group_id=? AND event_type IN ('apology','repair')", [G])
  ok(apol.length >= 1, `补回应产出 apology/repair 事件（${apol.length} 条）`)
  const relAfter = await dao.get('SELECT unresolved_event_count,disappointment FROM gw_bot_rel WHERE bot_id="999" AND group_id=? AND user_id="TR"', [G])
  ok((relAfter?.unresolved_event_count ?? 1) === 0, `修复清零 unresolved_event_count（${relBefore?.unresolved_event_count}→${relAfter?.unresolved_event_count}）`)
  const row = await expRow(expId)
  if (row?.status !== 'repaired') {
    bug('model/selfstate/expectations.js', 107, `§16.3 七态生命周期含 repaired，但代码从不写 status='repaired'（全库无该字面量）——补回应只修关系(gw_bot_rel/ss_concerns)，期待本身永远停在 ignored`, `群F5: 期待判 ignored 后目标回帖道歉 → ss_expectations.status=${row?.status}（无 repaired 态）`)
  }
  await clearGw(G)
})

// ═══════════════ 3. 反证清单（§11.4） ═══════════════
await test('3a. 刷屏淹没：40 条无关消息 → visibility 低 → 不判 ignored', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'C1'
  const expId = await ss.registerOutgoingExpectation({ groupId: G, sourceMessageId: 'bot_c1', sentText: QUESTION, targetUserId: 'TC' })
  const now = await forceExpire(expId)
  await seedBypassEvidence(G, 'TC', 40, 3, now) // 40 无关 + 目标活跃绕开 → groupActiveAfter=43≥30 → visibility 0.6
  await ss.onMessage(norm('n6', 'OTHER', '继续聊天'), { groupId: G, quoteIsBot: false })
  const row = await expRow(expId)
  ok(row?.status !== 'ignored', `刷屏淹没不判 ignored（实际 ${row?.status}，conf=${row?.outcome_confidence}）`)
  ok((await ignoredEvents(G)).length === 0, '无冷落事件')
  await clearGw(G)
})

await test('3b. 群整体沉默 → naturally_expired', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'C2'
  const expId = await ss.registerOutgoingExpectation({ groupId: G, sourceMessageId: 'bot_c2', sentText: QUESTION, targetUserId: 'TC2' })
  await forceExpire(expId)
  await ss.onMessage(norm('n7', 'ANYONE', '打卡'), { groupId: G, quoteIsBot: false })
  const row = await expRow(expId)
  ok(row?.status !== 'ignored', `群沉默不判冷落（实际 ${row?.status}——目标也沉默时被 uncertain 分支遮蔽，见 2c bug）`)
  ok((await ignoredEvents(G)).length === 0, '无冷落事件')
})

// ═══════════════ 4. 动态窗口 ═══════════════
const windowOf = async (gid, cfg, { target = null, targetGaps = null, active = false } = {}) => {
  const ss = mkSvc(cfg); await ss.init()
  const now = Date.now()
  if (active) for (let i = 0; i < 61; i++) await insMsg(gid, `w_${i}`, 'OTHER', now - 60000 - i * 20000) // 近30min ≥61 条 → perMin≥2 → 5min
  if (target && targetGaps) {
    let t = now - 60000
    for (let i = 0; i < 5; i++) { await insMsg(gid, `wt_${i}`, target, t); t -= targetGaps } // 近3天内目标发言等间隔
  }
  const id = await ss.registerOutgoingExpectation({ groupId: gid, sourceMessageId: 'bot_w', sentText: QUESTION, targetUserId: target })
  const row = await expRow(id)
  return { win: row.expires_at - row.created_at, pace: row.normal_response_ms, id }
}

await test('4. 动态窗口：min/max 钳制 + 群活跃度影响 deadline', async () => {
  const dead = await windowOf('W1', {}) // 死群：pace 20min
  ok(dead.win === 1200000, `死群窗口=群节奏20min（实际 ${dead.win / 1000}s）`)
  const act = await windowOf('W2', {}, { active: true }) // 活跃群：pace 5min
  ok(act.win === 300000, `活跃群窗口=群节奏5min（实际 ${act.win / 1000}s）`)
  const minBound = await windowOf('W3', { expectations: { minimumWindowSeconds: 1800 } }, { active: true })
  ok(minBound.win === 1800000, `minimumWindowSeconds=1800 抬高下限（实际 ${minBound.win / 1000}s）`)
  ok(minBound.win >= 1800000, `窗口恒 ≥ minimumWindowSeconds（W1 ${dead.win / 1000}s ≥ 90s ✓, W3 ✓）`)
  const maxBound = await windowOf('W4', { expectations: { maximumWindowSeconds: 120 } }) // 死群 20min 但 maxW=120s 封顶
  ok(maxBound.win === 120000, `maximumWindowSeconds=120 封顶（实际 ${maxBound.win / 1000}s）`)
  const tSlow = await windowOf('W5', {}, { target: 'WT', targetGaps: 25 * 60000 }) // 目标响应节奏=发言间隔中位数 25min（未触 30min 钳制）
  ok(tSlow.win === 1500000, `目标节奏 25min 拉长 deadline 至 1500s（实际 ${tSlow.win / 1000}s，pace=${tSlow.pace}ms）`)
  const tClamp = await windowOf('W6', {}, { target: 'WT2', targetGaps: 40 * 60000 }) // 间隔 40min → 钳 30min
  ok(tClamp.win === 1800000, `目标节奏钳制上限 30min（实际 ${tClamp.win / 1000}s，pace=${tClamp.pace}ms）`)
  ok(dead.win <= 3600000 && act.win <= 3600000, `默认窗口恒 ≤ maximumWindowSeconds=3600s（${dead.win / 1000}s / ${act.win / 1000}s）`)
  for (const g of ['W1', 'W2', 'W3', 'W4', 'W5', 'W6']) await clearGw(g)
})

// ═══════════════ 5. 出站分类 ═══════════════
await test('5. classifyOutgoing：陈述/提问/带@引导', async () => {
  const ss = mkSvc(); await ss.init()
  const stmt = classifyOutgoing('今天好困啊，随便说说')
  ok(stmt.expectationType === null && stmt.isQuestion === false, `纯陈述不建期待（type=${stmt.expectationType}）`)
  const q = classifyOutgoing('你觉得怎么样？')
  ok(q.isQuestion === true && q.expectationType === 'direct_answer', `提问 → direct_answer`)
  const at = classifyOutgoing('@小明 你怎么看？')
  ok(at.isQuestion === true && at.directTarget === true && at.expectationType === 'direct_answer', `带@提问 → direct_answer + directTarget`)
  const atNoQ = classifyOutgoing('@小明 你说一下你的看法')
  if (atNoQ.expectationType !== null) bug('model/selfstate/expectations.js', 17, `带@引导但非问句被判为提问建期待`, `classifyOutgoing('@小明 你说一下你的看法') → ${JSON.stringify(atNoQ)}`)
  else ok(true, '带@引导但非问句 → 不建期待')
  const you = classifyOutgoing('你觉得这游戏不行')
  if (you.isQuestion) bug('model/selfstate/expectations.js', 17, `^(?:那?你|...) 前缀过宽：以"你"开头的陈述句被判为提问`, `classifyOutgoing('你觉得这游戏不行') → isQuestion=${you.isQuestion}（陈述句误建期待）`)
  else ok(true, '"你"开头陈述句不误判')
  const id1 = await ss.registerOutgoingExpectation({ groupId: 'CLS', sourceMessageId: 'b1', sentText: '今天好困啊' })
  ok(id1 == null, 'register 层：纯陈述返回 null')
})

// ═══════════════ 6. 压力：并发 50 注册 + 100 解析 ═══════════════
await test('6. 压力：并发 50 注册 + 100 并发 onMessage，无脏状态', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'S1'
  const now = Date.now()
  for (let i = 0; i < 61; i++) await insMsg(G, `s_${i}`, 'OTHER', now - 60000 - i * 20000) // 活跃群（5min 窗口，压测期间不会到期）
  const targets = ['U1', 'U2', 'U3', 'U4', 'U5']
  const regIds = (await Promise.all(Array.from({ length: 50 }, (_, i) =>
    ss.registerOutgoingExpectation({ groupId: G, sourceMessageId: `bot_s${i}`, sentText: QUESTION, targetUserId: targets[i % 5] })))).filter(Boolean)
  ok(regIds.length === 50, `并发注册 50 条期待全部落库（${regIds.length}）`)
  // 100 条并发解析消息：50 条目标回机器人（应 fulfill）+ 50 条无关噪声
  const jobs = []
  for (let i = 0; i < 50; i++) jobs.push(ss.onMessage(norm(`ans${i}`, targets[i % 5], '我来回答一下这个问题', { replyToId: 'botmsg' }), { groupId: G, quoteIsBot: true }))
  for (let i = 0; i < 50; i++) jobs.push(ss.onMessage(norm(`noise${i}`, `N${i}`, '路人闲聊内容'), { groupId: G, quoteIsBot: false }))
  await Promise.all(jobs)
  const rows = await dao.all("SELECT * FROM ss_expectations WHERE bot_id='999' AND group_id=?", [G])
  const pending = rows.filter((r) => r.status === 'pending')
  const fulfilled = rows.filter((r) => r.status === 'fulfilled')
  ok(rows.length === 50, `期待共 50 行（实际 ${rows.length}）`)
  ok(pending.length === 0, `无 pending 幽灵行（实际残留 ${pending.length}）`)
  ok(fulfilled.length === 50, `50 条全部 fulfilled（实际 ${fulfilled.length}）`)
  ok(fulfilled.every((r) => r.fulfilled_by_message_id && /^ans\d+$/.test(r.fulfilled_by_message_id)), 'fulfilled_by_message_id 全部指向正确回帖消息')
  ok(fulfilled.every((r) => r.resolved_at != null && r.outcome === 'fulfilled'), 'fulfilled 行 outcome/resolved_at 完整')
  const dirty = rows.filter((r) => (r.status === 'fulfilled' && !r.fulfilled_by_message_id) || (r.status === 'pending' && r.resolved_at != null))
  ok(dirty.length === 0, `无脏状态行（status/fulfilled_by/resolved_at 交叉异常 ${dirty.length} 条）`)
  const dup = await dao.get("SELECT COUNT(DISTINCT id) c, COUNT(*) t FROM ss_expectations WHERE bot_id='999' AND group_id=? AND source_message_id LIKE 'bot_s%'", [G])
  ok(dup.c === dup.t, `无重复行（${dup.c}/${dup.t}）`)
  await clearGw(G)
})

// ═══════════════ 附加：实时误 fulfill 反证 ═══════════════
await test('附加. 未到期期待：目标回复"他人"的闲聊是否被误判为回应', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'B1'
  const expId = await ss.registerOutgoingExpectation({ groupId: G, sourceMessageId: 'bot_b', sentText: QUESTION, targetUserId: 'TB' })
  await ss.onMessage(norm('casual', 'TB', '哈哈哈', { replyToId: 'othermsg' }), { groupId: G, quoteIsBot: false })
  const row = await expRow(expId)
  if (row?.status === 'fulfilled') {
    bug('model/selfstate/expectations.js', '92-93', `semanticAnswer 的 (repliedToBotMsg || mentionsBot || isTarget) 含 isTarget：目标成员回复"他人"的任意无问号消息（如"哈哈哈"）即 fulfill 期待——未到期的"活跃+绕开"场景永远走不到 ignored 判定`, `群B1: 注册 target=TB 的期待 → TB 回别人"哈哈哈"(quoteIsBot=false) → status=${row.status}, fulfilled_by=${row.fulfilled_by_message_id}`)
  } else {
    ok(true, `目标闲聊不误判（status=${row?.status}）`)
  }
})

// ═══════════════ 总结 ═══════════════
console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}，bug ${bugs.length}`)
for (const b of bugs) console.log(`  🐛 ${b.file}:${b.line} ${b.desc}`)
console.log('========================================')
Db.closeDb()
fs.rmSync(TMP, { recursive: true, force: true })
if (failed > 0 || bugs.length > 0) process.exitCode = 1
