/**
 * SelfState 情绪链路离线压测 + P1 修复回归（fakeProvider / tmpdir / dao 直查，不联网不依赖 Yunzai）。
 * 运行：node stress/ss-emotion.mjs
 *
 * 覆盖：
 *  1. 回归A 心境饱和（绝对投影修复）：强辱骂 + 50 条琐碎 response_received → valence 不饱和、回 0 附近
 *  2. 回归B 情绪复活（同型合并先懒衰减）：anger 峰值回拨 6h → 新弱事件合并 ≈ 衰减值而非旧峰值
 *  3. 全类型周期：friendly_tease / direct_insult / praise / thanks / apology / repair（repair 走脚本化 LLM）
 *  4. 边界：同用户 20 连骂 → impulse ≤ cap、怨气 delta ≤ maxSingleEventDelta、残留有界
 *  5. 衰减：now 推进 24h / 7d / 90d → 半衰期公式、resolved、CoreAffect 回基线
 *  6. 长剧本：320 条混合消息不抛错、无脏数据（intensity∈[0,1]、无重复 active 同型情绪行）
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import * as Db from '../model/groupworld/db.js'
import { SelfStateService } from '../model/selfstate/service.js'
import { EmotionTransition } from '../model/selfstate/emotion.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }

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

// 脚本化 provider：默认规则路径（'{}'），需要 LLM 重判时（repair）往队列塞 JSON
const llmQueue = []
const scriptedProvider = { chat: async () => ({ content: llmQueue.length ? JSON.stringify(llmQueue.shift()) : '{}' }) }
const mkSvc = (over = {}) => new SelfStateService({ provider: scriptedProvider, cfg: () => ({ ...BASE_CFG, ...over }), botId: '999', botNames: ['小汐'], trace: { record() {} }, dataDir: TMP })
const mkEm = () => new EmotionTransition({ dao, cfg: () => BASE_CFG, trace: { record() {} } })

const norm = (id, userId, text, extra = {}) => ({
  id, groupId: 'G', userId, displayName: userId, timestamp: Date.now(), text,
  segments: [], replyToId: null, atBot: false, mentionsBotName: false, quotesBot: false,
  isCommand: false, isSelf: false, handledByDirectAgent: false, media: [], ...extra,
})
const atBot = (id, u, text) => norm(id, u, text, { atBot: true, segments: [{ type: 'at', qq: '999' }] })
const replyBot = (id, u, text) => norm(id, u, text, { replyToId: 'botmsg' })
const setRel = async (gid, uid, rel) => {
  await dao.run('INSERT OR REPLACE INTO gw_bot_rel(bot_id,group_id,user_id,familiarity,affinity,trust,resentment,guardedness,hurt,interaction_style,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['999', gid, uid, rel.familiarity ?? 0.3, rel.affinity ?? 0.4, rel.trust ?? 0.4, rel.resentment ?? 0, rel.guardedness ?? 0, rel.hurt ?? 0, rel.interaction_style || '', Date.now()])
}
const relOf = async (gid, uid) => dao.get('SELECT * FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', ['999', gid, uid])
const stateOf = (gid) => dao.get('SELECT * FROM ss_group_state WHERE bot_id=? AND group_id=?', ['999', gid])
const lastEvent = async (gid) => {
  const r = await dao.get('SELECT * FROM ss_events WHERE bot_id=? AND group_id=? ORDER BY id DESC LIMIT 1', ['999', gid])
  if (!r) return { event_type: null, impulse: {} }
  try { return { event_type: r.event_type, impulse: JSON.parse(r.emotion_impulse_json || '{}') } } catch { return { event_type: r.event_type, impulse: {} } }
}
const insEmotion = async (gid, etype, intensity, target, hl, lastEval) => {
  await dao.run(
    "INSERT INTO ss_emotions(bot_id,group_id,emotion_type,intensity,target_user_id,cause_event_id,started_at,half_life_seconds,last_evaluated_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)",
    ['999', gid, etype, intensity, target, 1, lastEval, hl, lastEval, lastEval, lastEval],
  )
}
// 双指数衰减（与 emotion.js decayIntensity 同型：快分量 0.7×单半衰期 + 拖尾 0.3×8×半衰期）
const HALF = (ms, hl) => { const t = Math.max(0, ms) / 1000 / Math.max(60, hl); return 0.7 * Math.pow(0.5, t) + 0.3 * Math.pow(0.5, t / 8) }

// ═══════════════ 1. 回归A：心境饱和（绝对投影修复） ═══════════════
await test('回归A 心境饱和：强辱骂 + 50 条琐碎事件 → valence 收敛 |v|<0.2 不饱和 -1', async () => {
  const ss = mkSvc({ eventDetection: { minEventConfidence: 0.35 } }); await ss.init()
  const G = 'SA'
  const r0 = await ss.onMessage(atBot('sa-i1', 'STR', '@bot 你就是个垃圾废物'), { groupId: G, quoteIsBot: false })
  ok(r0?.events === 1, `强辱骂产生事件（events=${r0?.events}）`)
  const s1 = await stateOf(G)
  ok(Number(s1.valence) < -0.02, `辱骂后 valence 为负（${Number(s1.valence).toFixed(3)}）`)
  const vals = [Number(s1.valence)]
  let nulls = 0
  for (let i = 0; i < 50; i++) {
    // response_received：登记期待（问句）→ 目标回一句带问号的弱消息（期待不满足 → possible_response）
    await ss.registerOutgoingExpectation({ groupId: G, sourceMessageId: `saq${i}`, targetUserId: 'NEU', sentText: '你觉得这个方案怎么样？' })
    const r = await ss.onMessage(norm(`sar${i}`, 'NEU', '这个要怎么弄？'), { groupId: G, quoteIsBot: false })
    if (r == null) nulls++
    vals.push(Number((await stateOf(G)).valence))
  }
  ok(nulls === 0, `50 条琐碎消息 onMessage 无内部异常（null=${nulls}）`)
  const cnt = await dao.get("SELECT COUNT(*) c FROM ss_events WHERE bot_id='999' AND group_id='SA' AND event_type='response_received'", [])
  ok(Number(cnt.c) === 50, `50 条 response_received 事件入库（实际 ${cnt.c}）`)
  const vmin = Math.min(...vals), vfin = vals[vals.length - 1]
  ok(Math.abs(vfin) < 0.2, `收敛回 0 附近（final valence=${vfin.toFixed(4)}，|v|<0.2）`)
  ok(vmin > -0.5, `全程不饱和（min valence=${vmin.toFixed(4)}，旧 bug 会反复累加 → -1）`)
  // 时间推进 24h（懒衰减+重投影）→ 心境回基线
  const em = mkEm(); const t24 = Date.now() + 24 * 3600e3
  await em.decayAndGetActive('999', G, t24)
  await em._transitionAffect({ botId: '999', groupId: G, entries: [], eventType: 'decay', eventId: null, now: t24 })
  const s2 = await stateOf(G)
  ok(Math.abs(Number(s2.valence)) < 0.05 && Number(s2.arousal) < 0.32, `24h 衰减后回基线（valence=${Number(s2.valence).toFixed(4)}, arousal=${Number(s2.arousal).toFixed(3)}）`)
})

// ═══════════════ 2. 回归B：情绪复活（同型合并先懒衰减） ═══════════════
await test('回归B 情绪复活：anger 峰值 0.5 回拨 6h → 新弱事件合并 ≈ 衰减值', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'SB'
  const tIns = Date.now() - 6 * 3600e3
  await insEmotion(G, 'anger', 0.5, 'WB1', 10800, tIns) // 半衰期 3h，6h 前强度 0.5
  const tMsg = Date.now()
  const r = await ss.onMessage(norm('sb-w1', 'WB1', '小汐你可真菜'), { groupId: G, quoteIsBot: false })
  ok(r?.events === 1, `弱辱骂（昵称指向，非@）产生事件（events=${r?.events}）`)
  const row = await dao.get("SELECT intensity FROM ss_emotions WHERE bot_id='999' AND group_id='SB' AND emotion_type='anger' AND target_user_id='WB1' AND status='active'")
  const expected = 0.5 * HALF(tMsg - tIns, 10800) // 6h = 2 个半衰期 → 0.125
  ok(Math.abs(Number(row.intensity) - expected) < 0.012, `合并后 ≈ 懒衰减值（${Number(row.intensity).toFixed(4)} ≈ ${expected.toFixed(4)}）`)
  ok(Number(row.intensity) < 0.3, `未被旧峰值满血复活（<0.3；旧 bug 取 max(0.5, 新值)=0.5）`)
})

// ═══════════════ 3. 全类型周期 ═══════════════
await test('全类型：friendly_tease / direct_insult / praise / thanks / apology / repair', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'SC'

  // 3.1 friendly_tease：熟人互损 → amusement 主导、无怨气
  await setRel(G, 'TF', { familiarity: 0.8, affinity: 0.7, interaction_style: '双方平时允许轻微互损' })
  await ss.onMessage(replyBot('sc-tf', 'TF', '你写的这功能真菜啊'), { groupId: G, quoteIsBot: true })
  let ev = await lastEvent(G); let imp = ev.impulse
  ok(ev.event_type === 'friendly_tease', `friendly_tease 类型正确（${ev.event_type}）`)
  ok((imp.amusement || 0) > (imp.annoyance || 0), `amusement(${imp.amusement}) > annoyance(${imp.annoyance})`)
  let rel = await relOf(G, 'TF')
  ok((rel?.resentment || 0) <= 0.03, `玩笑不留怨气（resentment=${rel?.resentment}）`)

  // 3.2 direct_insult：陌生人 @辱骂 → anger + hurt/resentment/guardedness 残留
  await ss.onMessage(atBot('sc-ti', 'TI', '@bot 你就是个垃圾废物'), { groupId: G, quoteIsBot: false })
  ev = await lastEvent(G); imp = ev.impulse
  ok(ev.event_type === 'direct_insult', `direct_insult 类型正确（${ev.event_type}）`)
  ok((imp.anger || 0) > 0.05, `impulse 模板触发 anger=${imp.anger}`)
  rel = await relOf(G, 'TI')
  ok((rel?.hurt || 0) > 0 && (rel?.resentment || 0) > 0 && (rel?.guardedness || 0) > 0, `关系残留方向正确（hurt=${rel?.hurt?.toFixed(3)}, resentment=${rel?.resentment?.toFixed(3)}, guardedness=${rel?.guardedness?.toFixed(3)}）`)

  // 3.3 praise：→ joy/pride + gratitude 残留
  await ss.onMessage(atBot('sc-tp', 'TP', '@bot 你太厉害了'), { groupId: G, quoteIsBot: false })
  ev = await lastEvent(G); imp = ev.impulse
  ok(ev.event_type === 'praise' && (imp.joy || 0) > 0 && (imp.pride || 0) > 0, `praise：joy=${imp.joy}, pride=${imp.pride}`)
  rel = await relOf(G, 'TP')
  ok((rel?.gratitude || 0) > 0 && (rel?.resentment || 0) === 0, `praise 残留 gratitude=${rel?.gratitude?.toFixed(3)}、无 resentment`)

  // 3.4 thanks：→ gratitude/joy + gratitude 残留
  await ss.onMessage(atBot('sc-tt', 'TT', '@bot 谢谢你啦'), { groupId: G, quoteIsBot: false })
  ev = await lastEvent(G); imp = ev.impulse
  ok(ev.event_type === 'thanks' && (imp.gratitude || 0) > 0.05, `thanks：gratitude=${imp.gratitude}, joy=${imp.joy}`)
  rel = await relOf(G, 'TT')
  ok((rel?.gratitude || 0) > 0, `thanks 残留 gratitude=${rel?.gratitude?.toFixed(3)}`)

  // 3.5 apology：规则路径 → sootheImmediate + 怨气缓降不清零
  await setRel(G, 'TA', { familiarity: 0.5, affinity: 0.5, resentment: 0.6, guardedness: 0.5, hurt: 0.4 })
  await insEmotion(G, 'anger', 0.5, 'TA', 3600, Date.now())
  await ss.onMessage(replyBot('sc-ta', 'TA', '刚才说的是我不对，跟你道个歉，别往心里去'), { groupId: G, quoteIsBot: true })
  ev = await lastEvent(G); imp = ev.impulse
  ok(ev.event_type === 'apology' && (imp.relief || 0) > 0, `apology：relief=${imp.relief}`)
  const angerA = await dao.get("SELECT intensity FROM ss_emotions WHERE bot_id='999' AND group_id='SC' AND emotion_type='anger' AND target_user_id='TA' AND status='active'")
  ok(Number(angerA?.intensity ?? 0) < 0.5, `道歉后即时怒气下降（anger=${Number(angerA?.intensity ?? 0).toFixed(3)} < 0.5）`)
  rel = await relOf(G, 'TA')
  ok((rel?.resentment || 0) > 0 && (rel?.resentment || 0) < 0.6, `怨气缓降不清零（resentment=${rel?.resentment?.toFixed(3)} ∈ (0,0.6)）`)
  ok((rel?.guardedness || 0) < 0.5, `戒备下降（guardedness=${rel?.guardedness?.toFixed(3)} < 0.5）`)

  // 3.6 repair：LLM 重判路径（脚本化 provider）
  await setRel(G, 'TR', { familiarity: 0.6, affinity: 0.6, resentment: 0.5, guardedness: 0.3 })
  await insEmotion(G, 'anger', 0.4, 'TR', 3600, Date.now())
  llmQueue.push({ event_type: 'repair', semantic_signals: { playfulness: 0.1, hostility: 0, repair_signal: 0.85, sincerity: 0.85 }, directed_at_bot: 0.9, intent_confidence: 0.9 })
  const rr = await ss.onMessage(replyBot('sc-tr', 'TR', '刚才那件事我再补个回应，咱们把话说开吧'), { groupId: G, quoteIsBot: true })
  ok(rr?.events === 1, `repair 事件产生（events=${rr?.events}）`)
  ev = await lastEvent(G); imp = ev.impulse
  ok(ev.event_type === 'repair' && (imp.relief || 0) > 0, `repair：类型=${ev.event_type}，relief=${imp.relief}`)
  const angerR = await dao.get("SELECT intensity FROM ss_emotions WHERE bot_id='999' AND group_id='SC' AND emotion_type='anger' AND target_user_id='TR' AND status='active'")
  ok(Number(angerR?.intensity ?? 0) < 0.4, `repair 后即时怒气下降（anger=${Number(angerR?.intensity ?? 0).toFixed(3)} < 0.4）`)
  rel = await relOf(G, 'TR')
  ok((rel?.resentment || 0) > 0 && (rel?.resentment || 0) < 0.5, `repair 怨气缓降（resentment=${rel?.resentment?.toFixed(3)} ∈ (0,0.5)）`)
})

// ═══════════════ 4. 边界：同用户 20 连骂 ═══════════════
await test('边界：同一用户 20 连骂 → impulse 有界、怨气 delta ≤ maxSingleEventDelta、残留单调有界', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'SD'
  const capHigh = BASE_CFG.emotion.maxHighSalienceImpulse
  const maxDelta = BASE_CFG.resentment.maxSingleEventDelta
  let prevRes = 0, monotonic = true, deltaOK = true, maxImpulse = 0, vals = []
  for (let i = 1; i <= 20; i++) {
    await ss.onMessage(atBot(`sd-${i}`, 'SPAM1', '@bot 垃圾玩意滚出去'), { groupId: G, quoteIsBot: false })
    const ev = await lastEvent(G)
    for (const v of Object.values(ev.impulse)) { if (v > maxImpulse) maxImpulse = v }
    const rel = await relOf(G, 'SPAM1')
    const res = Number(rel?.resentment || 0)
    if (res < prevRes - 1e-9) monotonic = false
    if (res - prevRes > maxDelta + 1e-6) deltaOK = false
    if (!Number.isFinite(res) || res < 0 || res > 1 + 1e-9) { monotonic = false; deltaOK = false }
    prevRes = res
    vals.push(Number((await stateOf(G)).valence))
  }
  ok(maxImpulse <= capHigh + 1e-9, `每次 impulse ≤ maxHighSalienceImpulse 0.35（实测最大 ${maxImpulse}）`)
  ok(deltaOK, `怨气单次增量 ≤ maxSingleEventDelta 0.05（最终 resentment=${prevRes.toFixed(3)}）`)
  ok(monotonic && prevRes <= 1, `怨气单调有界 ≤1（final=${prevRes.toFixed(3)}，20×0.05=1.0 上限内缓慢趋平）`)
  const guard = Number((await relOf(G, 'SPAM1'))?.guardedness || 0)
  ok(guard <= 1, `guardedness 有界 ≤1（=${guard.toFixed(3)}）`)
  ok(Math.min(...vals) > -0.5, `心境不崩（min valence=${Math.min(...vals).toFixed(3)}）`)
  const anger = await dao.get("SELECT intensity FROM ss_emotions WHERE bot_id='999' AND group_id='SD' AND emotion_type='anger' AND target_user_id='SPAM1' AND status='active'")
  ok(Number(anger?.intensity || 0) <= capHigh, `anger 行强度 ≤ 0.35（=${Number(anger?.intensity || 0).toFixed(4)}）`)
  const other = await relOf(G, 'BYSTANDER')
  ok(!other || ((other.resentment || 0) === 0 && (other.guardedness || 0) === 0), '不扩散到无关成员（noCrossUserSpillover）')
})

// ═══════════════ 5. 衰减：now 推进 24h / 7d / 90d ═══════════════
await test('衰减：半衰期公式、resolved、CoreAffect 回基线', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'SE'
  await ss.onMessage(atBot('se-1', 'DE1', '@bot 谢谢你啦'), { groupId: G, quoteIsBot: false })      // gratitude(14d) + joy
  await ss.onMessage(atBot('se-2', 'DE2', '@bot 你太厉害了'), { groupId: G, quoteIsBot: false })    // joy + pride
  await ss.onMessage(atBot('se-3', 'DE3', '@bot 你就是个垃圾废物'), { groupId: G, quoteIsBot: false }) // anger/hurt/annoyance
  const seed = await dao.all("SELECT * FROM ss_emotions WHERE bot_id='999' AND group_id='SE' AND status='active'")
  ok(seed.length >= 5, `播种 ${seed.length} 条活跃情绪（${seed.map((r) => `${r.emotion_type}@${r.target_user_id}:${Number(r.intensity).toFixed(3)}`).join(' ')}）`)
  const t0 = Date.now()
  const em = mkEm()

  // 24h：短半衰期负面/正面全 resolved；gratitude 按公式存活
  const t24 = t0 + 24 * 3600e3
  const d24 = await em.decayAndGetActive('999', G, t24)
  let decayOK = true, resolvedOK = true, gratitude24 = 0
  for (const r of seed) {
    const exp = Number(r.intensity) * HALF(t24 - Number(r.last_evaluated_at), Number(r.half_life_seconds))
    if (exp < 0.01) {
      const row = await dao.get('SELECT status, intensity FROM ss_emotions WHERE id=?', [r.id])
      if (!(row?.status === 'resolved' && Number(row.intensity) === 0)) resolvedOK = false
    } else {
      const got = d24.find((x) => x.id === r.id)
      if (!got || Math.abs(got.intensity - exp) > 0.006) decayOK = false
      if (r.emotion_type === 'gratitude') gratitude24 = got?.intensity ?? 0
    }
  }
  ok(resolvedOK, `24h：短半衰期情绪（joy/pride/anger/hurt/annoyance）全部 resolved（intensity=0）`)
  ok(decayOK && gratitude24 > 0.05, `24h：gratitude 按半衰期存活（${gratitude24.toFixed(4)} ≈ 0.151×0.5^(24h/13.3d)）`)
  await em._transitionAffect({ botId: '999', groupId: G, entries: [], eventType: 'decay', eventId: null, now: t24 })
  const s24 = await stateOf(G)
  ok(Math.abs(Number(s24.valence)) < 0.15 && Number(s24.arousal) < 0.35, `24h 心境接近基线（valence=${Number(s24.valence).toFixed(3)}, arousal=${Number(s24.arousal).toFixed(3)}）`)

  // 7d：gratitude 继续按公式（约 ×0.7，仍不归零——半衰期 13.3d）
  const t7 = t0 + 7 * 86400e3
  const d7 = await em.decayAndGetActive('999', G, t7)
  const g7 = d7.find((x) => x.emotion_type === 'gratitude')
  const gSeed = seed.find((r) => r.emotion_type === 'gratitude')
  const exp7 = Number(gSeed.intensity) * HALF(t7 - Number(gSeed.last_evaluated_at), Number(gSeed.half_life_seconds))
  ok(g7 && Math.abs(g7.intensity - exp7) < 0.006, `7d：gratitude=${g7?.intensity?.toFixed(4)} ≈ 公式值 ${exp7.toFixed(4)}（慢情绪不清零）`)

  // 90d：双指数拖尾——慢情绪（gratitude）允许低强度残留，但低于可见阈值、CoreAffect 回基线
  const t90 = t0 + 90 * 86400e3
  const d90 = await em.decayAndGetActive('999', G, t90)
  const maxR = Math.max(0, ...d90.map((x) => Number(x.intensity)))
  ok(d90.length <= 1 && maxR < 0.03, `90d：仅拖尾残留（active=${d90.length}, max=${maxR.toFixed(4)} <0.03，低于可见阈值 0.18）`)
  await em._transitionAffect({ botId: '999', groupId: G, entries: [], eventType: 'decay', eventId: null, now: t90 })
  const s90 = await stateOf(G)
  const b = (v, t, eps) => Math.abs(Number(v) - t) < eps
  ok(b(s90.valence, 0, 0.03) && b(s90.arousal, 0.2, 0.02) && b(s90.social_security, 0.6, 0.03) && b(s90.energy, 0.7, 0.02),
    `90d CoreAffect 回基线（v=${Number(s90.valence).toFixed(3)}/0, a=${Number(s90.arousal).toFixed(3)}/0.2, sec=${Number(s90.social_security).toFixed(3)}/0.6, en=${Number(s90.energy).toFixed(3)}/0.7）`)

  // 300d：拖尾分量也衰减殆尽 → 全部 resolved
  const t300 = t0 + 300 * 86400e3
  const d300 = await em.decayAndGetActive('999', G, t300)
  ok(d300.length === 0, `300d：全部情绪 resolved（残余 active=${d300.length}）`)
})

// ═══════════════ 6. 长剧本压力：320 条混合消息 ═══════════════
await test('长剧本：320 条混合消息不抛错、无脏数据', async () => {
  const ss = mkSvc(); await ss.init()
  const G = 'SF'
  const mk = [
    (i, u) => atBot(`sf${i}`, u, '@bot 垃圾玩意滚出去'),
    (i, u) => atBot(`sf${i}`, u, '@bot 你太厉害了'),
    (i, u) => norm(`sf${i}`, u, '小汐 谢谢你'),
    (i, u) => replyBot(`sf${i}`, u, '对不起，刚才是我不对，跟你道个歉'),
    (i, u) => atBot(`sf${i}`, u, '@bot 你做的这功能真不行，太失望了'),
    (i, u) => norm(`sf${i}`, u, '小汐，今天群里聊什么呢'),
    (i, u) => norm(`sf${i}`, u, '今天天气不错啊'),
    (i, u) => norm(`sf${i}`, u, '#ai 帮我查一下', { isCommand: true }),
  ]
  const t0 = Date.now()
  let nulls = 0, evCount = 0
  for (let i = 0; i < 320; i++) {
    const u = `U${(i % 8) + 1}`
    const r = await ss.onMessage(mk[i % 8](i, u), { groupId: G, quoteIsBot: i % 8 === 3 })
    if (r == null) nulls++
    else evCount += r.events || 0
  }
  const dur = Date.now() - t0
  ok(nulls === 0, `320 条 onMessage 零异常（null=${nulls}），耗时 ${dur}ms（${(320000 / Math.max(dur, 1)).toFixed(0)} msg/min 单线程）`)
  ok(evCount === 240, `事件数正确（240 = 320 - 40 ambient - 40 command，实际 ${evCount}）`)
  const bad = await dao.get("SELECT COUNT(*) c FROM ss_emotions WHERE status='active' AND (intensity<0 OR intensity>1)", [])
  ok(Number(bad.c) === 0, `活跃情绪 intensity ∈ [0,1]（越界 ${bad.c} 条）`)
  const dup = await dao.all("SELECT group_id, emotion_type, target_user_id, COUNT(*) c FROM ss_emotions WHERE bot_id='999' AND status='active' GROUP BY group_id, emotion_type, target_user_id HAVING c>1", [])
  ok(dup.length === 0, `无重复 active 同型情绪行（含 target_user_id 维度，重复组 ${dup.length}）`)
  const badRel = await dao.get('SELECT COUNT(*) c FROM gw_bot_rel WHERE gratitude<0 OR gratitude>1 OR hurt<0 OR hurt>1 OR resentment<0 OR resentment>1 OR disappointment<0 OR disappointment>1 OR guardedness<0 OR guardedness>1', [])
  ok(Number(badRel.c) === 0, `gw_bot_rel 残留列全部 ∈ [0,1]（越界 ${badRel.c} 行）`)
  const badState = await dao.get('SELECT COUNT(*) c FROM ss_group_state WHERE valence<-1 OR valence>1 OR arousal<0 OR arousal>1 OR energy<0 OR energy>1 OR social_security<0 OR social_security>1', [])
  ok(Number(badState.c) === 0, `ss_group_state 全部维度在界内（越界 ${badState.c} 行）`)
  const st = await stateOf(G)
  console.log(`  · 末态：valence=${Number(st.valence).toFixed(3)} arousal=${Number(st.arousal).toFixed(3)} security=${Number(st.social_security).toFixed(3)}；events=${(await dao.get("SELECT COUNT(*) c FROM ss_events WHERE bot_id='999' AND group_id='SF'")).c}，active emotions=${(await dao.get("SELECT COUNT(*) c FROM ss_emotions WHERE bot_id='999' AND group_id='SF' AND status='active'")).c}`)
  const res1 = await relOf(G, 'U1'); const res2 = await relOf(G, 'U2')
  console.log(`  · U1（辱骂+道歉混合）resentment=${Number(res1?.resentment || 0).toFixed(3)} guardedness=${Number(res1?.guardedness || 0).toFixed(3)} gratitude=${Number(res1?.gratitude || 0).toFixed(3)}；U2（夸+谢）gratitude=${Number(res2?.gratitude || 0).toFixed(3)} resentment=${Number(res2?.resentment || 0).toFixed(3)}`)
})

// ═══════════════ 全局不变量 ═══════════════
await test('全局不变量（跨全部测试群）', async () => {
  const bad = await dao.get("SELECT COUNT(*) c FROM ss_emotions WHERE intensity<0 OR intensity>1", [])
  ok(Number(bad.c) === 0, `全库情绪 intensity ∈ [0,1]（越界 ${bad.c}）`)
  const dup = await dao.all("SELECT bot_id, group_id, emotion_type, target_user_id, COUNT(*) c FROM ss_emotions WHERE status='active' GROUP BY bot_id, group_id, emotion_type, target_user_id HAVING c>1", [])
  ok(dup.length === 0, `全库无重复 active 同型情绪（${dup.length} 组）`)
  const st = await dao.all("SELECT group_id, valence FROM ss_group_state WHERE bot_id='999'")
  ok(st.every((s) => Number(s.valence) >= -1 && Number(s.valence) <= 1), `全库 valence ∈ [-1,1]（${st.map((s) => `${s.group_id}:${Number(s.valence).toFixed(2)}`).join(' ')}）`)
})

// ═══════════════ 总结 ═══════════════
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
Db.closeDb()
fs.rmSync(TMP, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
