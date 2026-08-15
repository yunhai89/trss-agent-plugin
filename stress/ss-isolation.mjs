/**
 * SelfState 隔离性 / 误判 / 维护 离线压测（只读源码，不改现有文件）。
 * 覆盖：
 *  1. 回归A：ambient 辱骂（无@/无回复/无昵称/无 pending）×10 → 零显著事件 / 零关系残留 / 零心事
 *  2. 回归B：ambient 骂街不抬高 appraisal.repetition（对比全新用户单次 @ 辱骂 impulse 同量级）
 *  3. 跨群隔离：A 群辱骂不污染 B 群关系与 ss_group_state
 *  4. 跨用户不扩散：对 A 记仇后投影对 B 仍 normal（shadowMode=false）
 *  5. 维护全流程：懒衰减兜底 / 过期清理 / 负残留衰减 / 负心境 24h 上限恢复 / retention 清 ss_transitions
 *  6. 投影红线：shadow 与 expression_frozen 恒中性；关 shadow 后文本不含数值/维度名/系统措辞
 *  7. web 查询：getOverview/getRelations/getStats 空库与有数据均不抛错且结构完整
 * 运行：node stress/ss-isolation.mjs
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import * as Db from '../model/groupworld/db.js'
import { SelfStateService } from '../model/selfstate/service.js'

let passed = 0, failed = 0
const evidence = []
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m); evidence.push(m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 4).join('\n')); evidence.push(`[${name}] THROW ${e?.message}`) } }

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
const atBot = (id, userId, text, groupId = 'G') => norm(id, userId, text, { atBot: true, segments: [{ type: 'at', qq: '999' }], groupId })
const relOf = async (gid, uid, botId = '999') => dao.get('SELECT * FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [botId, gid, uid])
const angerOf = async (gid, uid, botId = '999') => dao.get("SELECT intensity FROM ss_emotions WHERE bot_id=? AND group_id=? AND emotion_type='anger' AND target_user_id=? AND status='active'", [botId, gid, uid])
const nEvents = async (gid, uid, botId = '999') => dao.get("SELECT COUNT(*) c, MAX(significance) maxsig FROM ss_events WHERE bot_id=? AND group_id=? AND actor_user_id=?", [botId, gid, uid])
const nConcerns = async (gid, uid, botId = '999') => dao.get("SELECT COUNT(*) c FROM ss_concerns WHERE bot_id=? AND group_id=? AND target_user_id=?", [botId, gid, uid])
const AMBIENT = '你他妈真菜 垃圾东西'   // 无@、无回复、无昵称：对象是别人的骂街

// ══════════════ 1. 回归A：ambient 辱骂 ×10 ══════════════
await test('回归A：ambient 辱骂 ×10 → 零显著事件/零残留/零心事', async () => {
  const ss = mkSvc(); await ss.init()
  let lastRet = null
  for (let i = 1; i <= 10; i++) {
    lastRet = await ss.onMessage(norm(`a1_${i}`, 'AMB1', AMBIENT, { groupId: 'GA1' }), { groupId: 'GA1', quoteIsBot: false })
  }
  ok(lastRet && lastRet.events === 0, `onMessage 不产事件（events=0，实际 ${lastRet?.events}）`)
  const ev = await nEvents('GA1', 'AMB1')
  ok(Number(ev?.c) === 0 || Number(ev?.maxsig) < 0.2, `ss_events 无显著事件（count=${ev?.c}, maxSignificance=${ev?.maxsig}）`)
  const rel = await relOf('GA1', 'AMB1')
  ok(!rel || ((rel.resentment || 0) === 0 && (rel.hurt || 0) === 0 && (rel.guardedness || 0) === 0),
    `gw_bot_rel 零怨恨残留（行存在=${!!rel}, resentment=${rel?.resentment ?? '无'}, hurt=${rel?.hurt ?? '无'}, guardedness=${rel?.guardedness ?? '无'}）`)
  const cn = await nConcerns('GA1', 'AMB1')
  ok(Number(cn?.c) === 0, `不建 ss_concerns（count=${cn?.c}）`)

  // 变体：压低 minEventConfidence=0.3 强制 ambient 事件入库，验证 base<0.2 门槛本身
  const ssLow = mkSvc({ eventDetection: { minEventConfidence: 0.3 } }); await ssLow.init()
  for (let i = 1; i <= 3; i++) await ssLow.onMessage(norm(`a2_${i}`, 'AMB2', AMBIENT, { groupId: 'GA2' }), { groupId: 'GA2', quoteIsBot: false })
  const ev2 = await nEvents('GA2', 'AMB2')
  const rel2 = await relOf('GA2', 'AMB2')
  const cn2 = await nConcerns('GA2', 'AMB2')
  ok(Number(ev2?.maxsig) < 0.2, `强制入库后 significance 仍 <0.2（maxsig=${ev2?.maxsig}，count=${ev2?.c}）`)
  ok(!rel2 || ((rel2.resentment || 0) === 0 && (rel2.hurt || 0) === 0 && (rel2.guardedness || 0) === 0), `低门槛下也无关系残留（resentment=${rel2?.resentment ?? '无行'}）`)
  ok(Number(cn2?.c) === 0, `低门槛下也不建心事（count=${cn2?.c}）`)
  const emo = await dao.all("SELECT * FROM ss_emotions WHERE bot_id='999' AND group_id='GA2'")
  ok(emo.every((e) => e.intensity < 0.01), `ambient 事件不产生可感情绪（${emo.length} 行，max=${Math.max(0, ...emo.map((e) => e.intensity))}）`)
})

// ══════════════ 2. 回归B：重复度污染 ══════════════
await test('回归B：ambient 骂 3 次不抬高 repetition；@ 辱骂 impulse 与全新用户同量级', async () => {
  const ss = mkSvc({ eventDetection: { minEventConfidence: 0.3 } }); await ss.init()
  // REP1：ambient ×3（会入库但 sig=0）后对机器人 @ 辱骂
  for (let i = 1; i <= 3; i++) await ss.onMessage(norm(`b1_${i}`, 'REP1', AMBIENT, { groupId: 'GB1' }), { groupId: 'GB1', quoteIsBot: false })
  await ss.onMessage(atBot('b1_at', 'REP1', '@bot 你就是个垃圾废物', 'GB1'), { groupId: 'GB1', quoteIsBot: false })
  // FRESH：全新用户单次 @ 辱骂
  await ss.onMessage(atBot('b2_at', 'FRESH1', '@bot 你就是个垃圾废物', 'GB1'), { groupId: 'GB1', quoteIsBot: false })

  // 纯 ambient 用户（只有 ambient 骂街事件，无 @）——repetition 必须为 0
  for (let i = 1; i <= 3; i++) await ss.onMessage(norm(`b3_${i}`, 'AMB_ONLY', AMBIENT, { groupId: 'GB1' }), { groupId: 'GB1', quoteIsBot: false })
  const repAmbOnly = await ss.appraiser._repetition('999', 'GB1', 'AMB_ONLY', 'direct_insult', Date.now())
  ok(repAmbOnly === 0, `纯 ambient 用户 repetition=0（实际 ${repAmbOnly}）`)
  const repREP = await ss.appraiser._repetition('999', 'GB1', 'REP1', 'direct_insult', Date.now())
  const repFRESH = await ss.appraiser._repetition('999', 'GB1', 'FRESH1', 'direct_insult', Date.now())
  ok(repREP === repFRESH, `ambient 骂 3 次后 @ 辱骂的 repetition 与全新用户同值（REP1=${repREP} vs FRESH1=${repFRESH}，即 ambient 事件未计入）`)

  const a1 = await angerOf('GB1', 'REP1'); const a2 = await angerOf('GB1', 'FRESH1')
  const d = Math.abs((a1?.intensity || 0) - (a2?.intensity || 0))
  ok(d < 0.005, `anger impulse 同量级（REP1=${a1?.intensity?.toFixed(4)} vs FRESH1=${a2?.intensity?.toFixed(4)}，diff=${d.toFixed(4)}）`)

  // 边界直查：手插 sig=0.19 / 0.2 的敌意事件，验证 significance>=0.2 过滤
  const now = Date.now()
  await dao.run("INSERT INTO ss_events(bot_id,group_id,event_type,actor_user_id,source_message_ids,appraisal_json,emotion_impulse_json,confidence,significance,occurred_at,processed_at,status,created_at) VALUES ('999','GB2','direct_insult','EDGE1','[]','{}','{}',0.9,0.19,?,?,'active',?)", [now, now, now])
  const r19 = await ss.appraiser._repetition('999', 'GB2', 'EDGE1', 'direct_insult', now)
  await dao.run("INSERT INTO ss_events(bot_id,group_id,event_type,actor_user_id,source_message_ids,appraisal_json,emotion_impulse_json,confidence,significance,occurred_at,processed_at,status,created_at) VALUES ('999','GB3','direct_insult','EDGE2','[]','{}','{}',0.9,0.2,?,?,'active',?)", [now, now, now])
  const r20 = await ss.appraiser._repetition('999', 'GB3', 'EDGE2', 'direct_insult', now)
  ok(r19 === 0 && r20 > 0, `significance 门槛边界：0.19→不计（${r19}），0.2→计入（${r20}）`)
})

// ══════════════ 3. 跨群隔离 ══════════════
await test('跨群隔离：A 群辱骂不污染 B 群关系与 ss_group_state', async () => {
  const ss = mkSvc(); await ss.init()
  await ss.onMessage(atBot('i1', 'X1', '@bot 你是垃圾废物', 'IA'), { groupId: 'IA', quoteIsBot: false })
  // B 群正常聊（X1 在 B 群夸机器人）
  await ss.onMessage(atBot('i2', 'X1', '@bot 小汐今天真厉害', 'IB'), { groupId: 'IB', quoteIsBot: false })
  await ss.onMessage(norm('i3', 'Y1', '今天天气不错', { groupId: 'IB' }), { groupId: 'IB', quoteIsBot: false })

  const relA = await relOf('IA', 'X1'); const relB = await relOf('IB', 'X1')
  ok(!!relA, `A 群产生关系数据（resentment=${relA?.resentment}, guardedness=${relA?.guardedness}）`)
  ok((relA?.guardedness || 0) > 0 || (relA?.resentment || 0) > 0, `A 群辱骂留痕（resentment=${relA?.resentment?.toFixed(3)}, guardedness=${relA?.guardedness?.toFixed(3)}）`)
  ok(!relB || ((relB.resentment || 0) === 0 && (relB.hurt || 0) === 0 && (relB.guardedness || 0) === 0), `B 群无该成员负面残留（resentment=${relB?.resentment ?? '无行'}, guardedness=${relB?.guardedness ?? '无行'}）`)
  ok(!relB || (relB.gratitude || 0) > 0, `B 群正向事件独立记账（gratitude=${relB?.gratitude?.toFixed(3)}）`)

  const stA = await dao.get("SELECT * FROM ss_group_state WHERE bot_id='999' AND group_id='IA'")
  const stB = await dao.get("SELECT * FROM ss_group_state WHERE bot_id='999' AND group_id='IB'")
  ok(stA && stB, `两群 ss_group_state 各自建行（A=${!!stA}, B=${!!stB}）`)
  ok(stA.state_version !== stB.state_version || stA.valence !== stB.valence || stA.updated_at !== stB.updated_at, '两群状态行独立（非共享行）')
  ok((stA?.valence ?? 0) < 0 && (stB?.valence ?? 0) >= 0, `A 群负心境不携带进 B 群（A.valence=${stA?.valence?.toFixed(3)}, B.valence=${stB?.valence?.toFixed(3)}）`)

  const evCross = await dao.get("SELECT COUNT(*) c FROM ss_events WHERE bot_id='999' AND group_id='IB' AND event_type='direct_insult'")
  ok(Number(evCross?.c) === 0, `B 群无辱骂事件（count=${evCross?.c}）`)
})

// ══════════════ 4. 跨用户不扩散 ══════════════
await test('跨用户不扩散：对 A 记仇后投影对 B 仍 normal', async () => {
  const ss = mkSvc(); await ss.init()
  await ss.onMessage(atBot('s1', 'SP_A', '@bot 垃圾玩意滚出去', 'SP'), { groupId: 'SP', quoteIsBot: false })
  // 手动放大 A 的怨气（模拟长期记仇后状态）
  await dao.run("UPDATE gw_bot_rel SET resentment=0.6, guardedness=0.5, hurt=0.4, updated_at=? WHERE bot_id='999' AND group_id='SP' AND user_id='SP_A'", [Date.now()])
  await dao.run("INSERT OR IGNORE INTO ss_group_state(bot_id,group_id,valence,updated_at) VALUES ('999','SP',-0.3,?)", [Date.now()])

  const ssOff = mkSvc({ shadowMode: false }); await ssOff.init()
  const pB = await ssOff.buildPlannerProjection({ groupId: 'SP', targetUserId: 'SP_B' })
  const pA = await ssOff.buildPlannerProjection({ groupId: 'SP', targetUserId: 'SP_A' })
  const cB = await ssOff.buildReplyerCapsule({ groupId: 'SP', targetUserId: 'SP_B' })
  ok(pB.neutral === false && pB.projection?.target_stance === 'normal', `对 B 投影 target_stance=normal（实际 ${pB.projection?.target_stance}）`)
  ok(pA.projection?.target_stance !== 'normal', `对 A 立场确实非 normal（${pA.projection?.target_stance}）——对照有效`)
  ok(!/疏远|有所保留/.test(pB.text || ''), `对 B 投影文本无疏远/保留措辞（text=${JSON.stringify(pB.text?.slice(0, 80))}）`)
  ok(!/保持边界|收着点/.test(cB.text || ''), `对 B 胶囊无边界措辞（target_distance=${cB.capsule?.target_distance}）`)
})

// ══════════════ 5. 维护全流程 ══════════════
await test('维护：懒衰减兜底/过期清理/负残留衰减/负心境24h恢复/retention', async () => {
  const ss = mkSvc(); await ss.init()
  const now = Date.now()
  const D = 86400000, H = 3600000

  // — M1：负心境 24h 上限恢复 —
  await dao.run("INSERT OR IGNORE INTO ss_group_state(bot_id,group_id,valence,energy,updated_at) VALUES ('999','M1',-0.8,0.3,?)", [now])
  await dao.run("UPDATE ss_group_state SET valence=-0.8, energy=0.3, last_transition_at=?, state_version=1 WHERE bot_id='999' AND group_id='M1'", [now - 25 * H])
  await dao.run("INSERT INTO ss_emotions(bot_id,group_id,emotion_type,intensity,target_user_id,cause_event_id,started_at,half_life_seconds,last_evaluated_at,status,created_at,updated_at) VALUES ('999','M1','sadness',0.4,NULL,1,?,?,?,'active',?,?)", [now - 30 * H, 12 * 3600, now - 30 * H, now, now])
  // 对照组 M1C：负心境仅 2h → 不触发
  await dao.run("INSERT OR IGNORE INTO ss_group_state(bot_id,group_id,valence,last_transition_at,updated_at) VALUES ('999','M1C',-0.8,?,?)", [now - 2 * H, now])
  const r1 = await ss.runMaintenance('M1')
  const st1 = await dao.get("SELECT valence,energy FROM ss_group_state WHERE bot_id='999' AND group_id='M1'")
  const st1c = await dao.get("SELECT valence FROM ss_group_state WHERE bot_id='999' AND group_id='M1C'")
  const emo1 = await dao.get("SELECT intensity FROM ss_emotions WHERE bot_id='999' AND group_id='M1'")
  ok(r1?.recoveries === 1, `25h 负心境触发恢复（recoveries=${r1?.recoveries}）`)
  ok(Math.abs(st1.valence - (-0.4)) < 0.01, `valence -0.8 → 减半 ${st1.valence.toFixed(3)}`)
  ok(st1.energy >= 0.5, `energy 抬回 ≥0.5（${st1.energy.toFixed(3)}）`)
  ok(emo1 && emo1.intensity < 0.4, `即时情绪强度被减半（${emo1?.intensity?.toFixed(3)} < 0.4）`)
  const audit = await dao.get("SELECT COUNT(*) c FROM ss_transitions WHERE bot_id='999' AND group_id='M1' AND transition_reason='stability_ceiling_recovery'")
  ok(Number(audit?.c) >= 1, `恢复写入稳定性审计（${audit?.c} 条）`)
  const rc1 = await ss.runMaintenance('M1C')
  ok(rc1?.recoveries === 0 && st1c.valence === -0.8, `未到 24h 不触发（recoveries=${rc1?.recoveries}, valence=${st1c.valence}）`)

  // — M2：负残留衰减（3 天无新证据 ×0.8）—
  await dao.run("INSERT OR REPLACE INTO gw_bot_rel(bot_id,group_id,user_id,resentment,guardedness,hurt,last_affective_event_at,updated_at) VALUES ('999','M2','U_STALE',0.6,0.5,0.5,?,?)", [now - 4 * D, now])
  await dao.run("INSERT OR REPLACE INTO gw_bot_rel(bot_id,group_id,user_id,resentment,last_affective_event_at,updated_at) VALUES ('999','M2','U_FRESH',0.6,?,?)", [now, now])
  const r2 = await ss.runMaintenance('M2')
  const stale = await relOf('M2', 'U_STALE'); const fresh = await relOf('M2', 'U_FRESH')
  ok(Math.abs(stale.resentment - 0.6 * 0.8) < 0.001, `3天无新证据 resentment×0.8（0.6→${stale.resentment.toFixed(4)}）`)
  ok(Math.abs(stale.guardedness - 0.5 * 0.85) < 0.001, `guardedness×0.85（0.5→${stale.guardedness.toFixed(4)}）`)
  ok(Math.abs(fresh.resentment - 0.6) < 0.001, `近期有证据不衰减（0.6→${fresh.resentment.toFixed(4)}）`)

  // — M3：懒衰减兜底 + 过期清理 + retention —
  const t0 = now - 2 * H
  const HL_S = 3600 // half_life_seconds 单位是秒
  await dao.run("INSERT INTO ss_emotions(bot_id,group_id,emotion_type,intensity,target_user_id,cause_event_id,started_at,half_life_seconds,last_evaluated_at,status,created_at,updated_at) VALUES ('999','M3','annoyance',0.4,NULL,1,?,?,?,'active',?,?)", [t0, HL_S, t0, now, now])
  await dao.run("INSERT INTO ss_emotions(bot_id,group_id,emotion_type,intensity,target_user_id,cause_event_id,started_at,half_life_seconds,last_evaluated_at,resolved_at,status,created_at,updated_at) VALUES ('999','M3','joy',0.3,NULL,1,?,?,?,?,'resolved',?,?)", [now, HL_S, now, now - 8 * D, now, now])
  await dao.run("INSERT INTO ss_expectations(bot_id,group_id,source_message_id,target_user_id,expectation_type,expectation_strength,not_before_at,expires_at,status,created_at) VALUES ('999','M3','x','U','answer',0.8,?,?, 'pending',?)", [now - 9 * D, now - 8 * D, now - 9 * D])
  await dao.run("INSERT INTO ss_reflections(bot_id,group_id,summary,scope,target_user_id,confidence,source_event_ids,recommended_concern,expires_at,status,created_at) VALUES ('999','M3','测试反思','self_pattern',NULL,0.8,'[]','none',?,'active',?)", [now - 1 * D, now - 2 * D])
  await dao.run("INSERT INTO ss_transitions(bot_id,group_id,source_event_id,before_state_json,delta_json,after_state_json,transition_reason,engine_version,created_at) VALUES ('999','M3',NULL,'{}','{}','{}','t','v',?)", [now - 15 * D])
  await dao.run("INSERT INTO ss_transitions(bot_id,group_id,source_event_id,before_state_json,delta_json,after_state_json,transition_reason,engine_version,created_at) VALUES ('999','M3',NULL,'{}','{}','{}','t','v',?)", [now - 1 * D])
  const r3 = await ss.runMaintenance('M3')
  const lazyEmo = await dao.get("SELECT intensity FROM ss_emotions WHERE bot_id='999' AND group_id='M3' AND status='active'")
  // 双指数（#4）：2 个半衰期后 = 0.4×(0.7×0.25 + 0.3×0.5^(2/8)) ≈ 0.1709
  const dualExp = 0.4 * (0.7 * 0.25 + 0.3 * Math.pow(0.5, 2 / 8))
  ok(r3?.decayed >= 1 && lazyEmo && Math.abs(lazyEmo.intensity - dualExp) < 0.02, `懒衰减兜底（双指数）：2h 半衰期1h → 0.4→${lazyEmo?.intensity?.toFixed(4)}（≈${dualExp.toFixed(4)}，decayed=${r3?.decayed}）`)
  const oldTr = await dao.get("SELECT COUNT(*) c FROM ss_transitions WHERE bot_id='999' AND group_id='M3' AND created_at<?", [now - 14 * D])
  const newTr = await dao.get("SELECT COUNT(*) c FROM ss_transitions WHERE bot_id='999' AND group_id='M3' AND created_at>=?", [now - 14 * D])
  ok(Number(oldTr?.c) === 0 && Number(newTr?.c) >= 1, `retention：>14d transitions 清除（旧=${oldTr?.c}，近=${newTr?.c}，cleaned=${r3?.cleaned}）`)
  const resEmo = await dao.get("SELECT status FROM ss_emotions WHERE bot_id='999' AND group_id='M3' AND emotion_type='joy'")
  ok(resEmo?.status === 'expired', `resolved>7d 情绪清为 expired（status=${resEmo?.status}）`)
  const oldExp = await dao.get("SELECT status FROM ss_expectations WHERE bot_id='999' AND group_id='M3'")
  ok(oldExp?.status === 'expired' || oldExp?.status === 'naturally_expired', `过期 pending 期待被清（status=${oldExp?.status}）——若 pending：maintenance._expire 通用 SET 引用 ss_expectations 不存在的 updated_at 列，静默失败（maintenance.js:42→72）`)
  const oldRef = await dao.get("SELECT status FROM ss_reflections WHERE bot_id='999' AND group_id='M3'")
  ok(oldRef?.status === 'expired', `过期 ss_reflections 被清（status=${oldRef?.status}）——同因：ss_reflections 亦无 updated_at 列（maintenance.js:45→72）`)
})

// ══════════════ 6. 投影红线 ══════════════
await test('投影红线：shadow/frozen 恒中性；关 shadow 后文本无数值/维度名/系统措辞', async () => {
  const ss = mkSvc(); await ss.init()  // shadowMode=true
  await ss.onMessage(atBot('p1', 'PR_A', '@bot 垃圾玩意滚出去蠢货', 'PR'), { groupId: 'PR', quoteIsBot: false })
  const pS = await ss.buildPlannerProjection({ groupId: 'PR', targetUserId: 'PR_A' })
  const cS = await ss.buildReplyerCapsule({ groupId: 'PR', targetUserId: 'PR_A' })
  ok(pS.neutral === true && pS.text === '', 'shadowMode：Planner 投影恒中性')
  ok(cS.neutral === true && cS.text === '', 'shadowMode：Replyer 胶囊恒中性')

  const ssOff = mkSvc({ shadowMode: false }); await ssOff.init()
  await ssOff.setExpressionFrozen('PR', true)
  const pF = await ssOff.buildPlannerProjection({ groupId: 'PR', targetUserId: 'PR_A' })
  const cF = await ssOff.buildReplyerCapsule({ groupId: 'PR', targetUserId: 'PR_A' })
  ok(pF.neutral === true && pF.text === '', 'expression_frozen=1：Planner 投影恒中性')
  ok(cF.neutral === true && cF.text === '', 'expression_frozen=1：Replyer 胶囊恒中性')

  await ssOff.setExpressionFrozen('PR', false)
  const p = await ssOff.buildPlannerProjection({ groupId: 'PR', targetUserId: 'PR_A' })
  const c = await ssOff.buildReplyerCapsule({ groupId: 'PR', targetUserId: 'PR_A' })
  ok(p.neutral === false && (p.text || '').length > 0, `解冻+关 shadow：投影非中性（text.len=${(p.text || '').length}）`)
  ok(c.neutral === false && (c.text || '').length > 0, `解冻+关 shadow：胶囊非中性（text.len=${(c.text || '').length}）`)
  const DIM = /valence|arousal|self_relevance|norm_violation|social_security|directedness|significance|repetition/i
  ok(!DIM.test(p.text || ''), `Planner 文本不含内部维度名`)
  ok(!DIM.test(c.text || ''), `Replyer 胶囊不含内部维度名`)
  ok(!/\d/.test(c.text || ''), `Replyer 胶囊不含任何数值（text=${JSON.stringify((c.text || '').slice(0, 90))}）`)
  const numInPlanner = (((p.text || '').match(/-?\d+\.?\d*/g) || []))
  ok(numInPlanner.length === 0, `Planner 文本不含数值${numInPlanner.length ? `（发现 ${numInPlanner.join(',')} 于 ${JSON.stringify(p.text)}）` : ''}`)
  // "系统"措辞：正文体排除【】指令头（指令头里的"不说系统判断"是给模型的约束，非表达内容）
  const stripHead = (t) => String(t || '').replace(/【[^】]*】/g, '')
  ok(!/系统/.test(stripHead(p.text)) && !/系统/.test(stripHead(c.text)), '投影正文不含"系统"措辞（【】指令头除外）')
  if (/系统/.test(c.text || '')) console.log('  ⚠ note: 胶囊指令头含「不说"系统判断"」字样（projector.js:125，prompt 约束措辞，非输出内容）')
})

// ══════════════ 7. web 查询 ══════════════
await test('web 查询：getOverview/getRelations/getStats 空库与有数据', async () => {
  const ss = mkSvc(); await ss.init()
  // 空库（全新群）
  const ov0 = await ss.getOverview('WEB0')
  ok(ov0 !== null && typeof ov0 === 'object', 'getOverview 空库不抛错')
  ok(ov0 && ['state', 'emotions', 'expectations', 'concerns', 'reflections', 'lastTransition', 'shadowMode', 'enabled'].every((k) => k in ov0), `getOverview 结构完整（keys=${Object.keys(ov0 || {}).join(',')}）`)
  ok(ov0?.state == null && Array.isArray(ov0?.emotions) && ov0.emotions.length === 0, '空库 state=null / emotions=[]')
  const rel0 = await ss.getRelations('WEB0')
  ok(Array.isArray(rel0) && rel0.length === 0, `getRelations 空库返回 []（${JSON.stringify(rel0)}）`)
  const st0 = await ss.getStats('WEB0')
  ok(st0 && typeof st0 === 'object' && ['events', 'emotions', 'pendingExpectations', 'concerns', 'reflections'].every((k) => Number.isFinite(st0[k])), `getStats 空库结构完整（${JSON.stringify(st0)}）`)

  // 有数据（PR 群已有辱骂事件/情绪/心事/心境）
  const ov1 = await ss.getOverview('PR')
  ok(ov1?.state != null && ov1?.emotions?.length > 0, `getOverview 有数据：state 存在、emotions=${ov1?.emotions?.length} 条且带 cause（cause=${JSON.stringify(ov1?.emotions?.[0]?.cause)}）`)
  ok(ov1?.lastTransition != null, `getOverview lastTransition 有值（reason=${JSON.stringify(ov1?.lastTransition?.transition_reason)}）`)
  const rel1 = await ss.getRelations('PR')
  ok(Array.isArray(rel1) && rel1.some((r) => r.user_id === 'PR_A'), `getRelations 含辱骂者行（${rel1.map((r) => `${r.user_id}:res${r.resentment}`).join(' ')}）`)
  ok(rel1.every((r) => 'resentment' in r && 'guardedness' in r && 'hurt' in r), 'getRelations 字段完整（含 ss 扩列）')
  const st1 = await ss.getStats('PR')
  ok((st1?.events || 0) >= 1 && (st1?.emotions || 0) >= 1, `getStats 有数据（${JSON.stringify(st1)}）`)
})

// ══════════════ 总结 ══════════════
console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
if (evidence.length) { console.log('失败明细：'); for (const e of evidence) console.log(' -', e) }
console.log('========================================')
Db.closeDb()
fs.rmSync(TMP, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
