/**
 * GroupWorld（群聊小世界）离线压测 —— 模拟群聊数据灌入全链路。
 *
 * 运行：node stress/gw-basic.mjs
 * 套路同 model/selfstate/test.mjs：tmpdir + fakeProvider（即时返回合法 JSON），
 * 直接构造 GroupWorldService（等价 apps/groupworld.js 装配，绕过 Yunzai plugin 运行时：
 * apps 层的 getRuntime()/Bot 全局/定时任务调度不可离线复现，但 Service 的
 * ingestMessage/runHourlyAnalysis/runDailyMaintenance/runWeeklyCommunity/
 * buildPlannerContext/buildReplyerContext/recordInteraction 均为纯模块依赖，可完整跑通）。
 *
 * 覆盖：①消息入库 ②画像/特征统计 ③gw_bot_rel 单调性 ④Planner/Replyer 现场与异常输入
 *      ⑤SelfState _relation 联动 ⑥全链路耗时。
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import * as Db from '../model/groupworld/db.js'
import { GroupWorldService } from '../model/groupworld/service.js'
import { SelfStateService } from '../model/selfstate/service.js'
import { estTokens } from '../model/groupworld/scoring.js'

let passed = 0, failed = 0, notes = []
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }

// ───────────────────────── 环境 ─────────────────────────
const TMP = path.join(os.tmpdir(), `gw-stress-${process.pid}`)
fs.rmSync(TMP, { recursive: true, force: true })

const GROUP = '880001'
const BOT = '999'
const GW_CFG = { enabled: true, groups: [GROUP], online: true }
const SS_CFG = {
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
const noTrace = { record() {} }

// fake provider：解析 prompt 里的真实 message_id / u<n>，回吐合法抽取 JSON（模拟轻量模型）
const TRAITS = [
  ['interest', 'server_ops', '常聊服务器运维和部署'],
  ['interest', 'gaming', '喜欢周末联机开黑'],
  ['speech_habit', 'short_reply', '常用短句接话'],
  ['expertise', 'linux', '懂 Linux 排障'],
  ['participation', 'night_owl', '夜间活跃'],
  ['self_disclosed_fact', 'city_south', '自称在南方城市'],
]
let llmCalls = 0
const fakeProvider = {
  chat: async ({ messages }) => {
    llmCalls++
    const prompt = String(messages?.[0]?.content || '')
    const ids = [...new Set([...prompt.matchAll(/\[(m\d+)\]/g)].map((x) => x[1]))]
    const us = [...new Set([...prompt.matchAll(/^(u\d+)/gm)].map((x) => x[1]))]
    if (!ids.length || !us.length) return { content: '{}' }
    const [type, key, value] = TRAITS[llmCalls % TRAITS.length]
    const other = us.find((u) => u !== us[0]) || us[0]
    return {
      content: JSON.stringify({
        topics: [{ name: '群聊话题', participant_ids: [us[0]], confidence: 0.4 }],
        trait_candidates: [
          { user_id: us[0], trait_type: type, trait_key: key, trait_value: value, confidence: 0.4, evidence_message_ids: [ids[0], ids[1] || ids[0]] },
          { user_id: us[us.length - 1], trait_type: 'interest', trait_key: 'group_chat', trait_value: '爱参与群聊讨论', confidence: 0.35, evidence_message_ids: [ids[ids.length - 1]] },
        ],
        relation_candidates: other !== us[0]
          ? [{ from_user_id: us[0], to_user_id: other, relation_hint: '常互相接话讨论', confidence: 0.4, evidence_message_ids: [ids[Math.min(2, ids.length - 1)]] }]
          : [],
        episode_candidates: [{ episode_type: 'ongoing_topic', title: '群日常闲聊', summary: '群友常聚在一起闲聊近况', importance: 0.5, evidence_message_ids: [ids[0]] }],
        sensitive_inferences: [],
      }),
    }
  },
}

// ───────────────────────── 群聊数据生成器 ─────────────────────────
// 16 成员 + 多话题（话题间静默 >10min 触发切片）+ @bot/回复/引用bot/表情/媒体/刷屏
const MEMBERS = Array.from({ length: 16 }, (_, i) => `u${101 + i}`)
const NAMES = Object.fromEntries(MEMBERS.map((u, i) => [u, `群友${i + 1}号`]))
const rnd = (() => { let s = 20260814; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 })()
const pick = (a) => a[Math.floor(rnd() * a.length)]

const TOPICS = [
  ['服务器运维', ['这台机器又炸了，谁帮忙看看日志', 'nginx 502 大概率是后端挂了', '我这边 docker 起不来，报端口占用', '看下磁盘是不是满了', 'df 一看 99%，经典', '清理完日志好了，谢啦', '回头写个监控告警吧', 'prometheus 加个 node_exporter 就行', '你们说的我一个字都听不懂哈哈', '运维就是背锅侠，习惯了', '这个部署脚本能发我一份吗', '晚上我发群里，标好注释', '又回滚了，这次改动没过测试', '所以说上 CI 是有道理的']],
  ['周末开黑', ['今晚有人打排位吗', '我来我来，晚上八点', '上号上号，就差一个辅助', '我只会混子英雄可以吗', '越塔下饭实录预定', '昨天那把 0-8 的别说话', '草我刀了呢', '笑死，经典下饭', '这周末新本开了记得上线', '行，周六下午集合', '记得带药，别又空手去', '收到，我先做日常']],
  ['美食奶茶', ['中午吃什么，选择困难了', '楼下新开了家螺蛳粉', '加臭加辣加双份腐竹', '那你晚上别挨着我睡', '哈哈笑死', '奶茶拼单，三分糖的去哪了', '我无糖，谢谢', '无糖喝什么奶茶', '仪式感懂不懂', '这家烤肉周末排队两小时', '可以扫码排，晚点去', '行，那周六先取号再逛街']],
  ['追剧动画', ['昨晚更新那集看了吗', '看了，结尾刀死了', '编剧是真的敢写', '我还没看别剧透', '放心不透，就说好看', '这季度最强没跑了', 'op 我已经循环一天了', '同款歌单推我一下', '周末补完前两季再来', '第一季节奏更好，真的', '那我从第一季开始看']],
]

const genMessages = () => {
  const msgs = []
  let ts = Date.now() - 3 * 3600e3
  let n = 0
  let rot = 0
  const push = (userId, text, extra = {}) => {
    n++
    msgs.push({
      id: `m${String(n).padStart(3, '0')}`, groupId: GROUP, userId,
      displayName: NAMES[userId], timestamp: ts, text,
      segments: [], replyToId: null, atBot: false, mentionsBotName: false, quotesBot: false,
      isCommand: false, isSelf: false, handledByDirectAgent: false, media: [], ...extra,
    })
    return msgs[msgs.length - 1]
  }
  TOPICS.forEach(([name, lines], ti) => {
    if (ti > 0) ts += 700e3 // 话题切换：静默 >10min → 片段闭合
    const count = 72 + Math.floor(rnd() * 10)
    for (let i = 0; i < count; i++) {
      const uid = MEMBERS[(rot + Math.floor(rnd() * 3)) % MEMBERS.length]; rot++
      const kind = i % 9
      if (kind === 0) { // @bot
        push(uid, `小汐 你觉得${name}这事怎么看`, { atBot: true, mentionsBotName: true, segments: [{ type: 'at', qq: BOT }] })
      } else if (kind === 1 && msgs.length) { // 回复近邻消息
        const prev = msgs[Math.max(0, msgs.length - 1 - Math.floor(rnd() * 12))]
        push(uid, pick(['确实', '同感+1', '不至于吧', '哈哈哈哈真的', '我早就说过了', '有道理']), { replyToId: prev.id })
      } else if (kind === 2) { // 引用机器人消息（bot 消息不在 gw_messages，replyToUser 解析不到 → 无边，符合线上）
        push(uid, pick(['引用你的话不成立', '你上次说的我不同意', '正想回你这条']), { replyToId: `bm${1 + Math.floor(rnd() * 3)}`, quotesBot: true })
      } else if (kind === 3) { // 纯表情/短反应（低价值）
        push(uid, pick(['[表情]', '[图片]', '哈哈哈', '6', '笑死', '?', '好']))
      } else if (kind === 4) { // 媒体
        push(uid, '', { media: [{ type: 'image', url: 'https://example.com/x.jpg' }], text: pick(['', '看图', '[图片]配文']) })
      } else if (kind === 5) { // @其他成员
        const target = pick(MEMBERS.filter((m) => m !== uid))
        push(uid, `${NAMES[target]} 你也来说说`, { segments: [{ type: 'at', qq: target }] })
      } else {
        push(uid, lines[(i + ti) % lines.length])
      }
      ts += 8e3 + Math.floor(rnd() * 30e3)
    }
    // 刷屏段落：单一成员 12 连发，间隔 1~2s
    const spammer = MEMBERS[(ti * 5) % MEMBERS.length]
    const spam = ['哈哈哈哈哈', '6', '[表情]', '笑死我了', '真的假的', '?', '卧槽', '牛', '666', '啊?', '好家伙', '没了?']
    for (const s of spam) { push(spammer, s); ts += 1500 }
  })
  return msgs
}

const msgs = genMessages()
const dao = () => Db.dao

// ───────────────────────── 装配 + 全链路（计时） ─────────────────────────
const gw = new GroupWorldService({ provider: fakeProvider, cfg: () => GW_CFG, dataDir: TMP, botId: BOT, trace: noTrace })
await gw.init()
ok(gw.isReady() === true, `GroupWorldService 离线装配成功（无 Yunzai 运行时依赖）`)

const T0 = Date.now()
let newCount = 0
for (const m of msgs) { const r = await gw.ingestMessage(m); if (r.isNew) newCount++ }
const tIngest = Date.now() - T0
const hourly = await gw.runHourlyAnalysis(GROUP)
const daily = await gw.runDailyMaintenance(GROUP)
const weekly = await gw.runWeeklyCommunity(GROUP)
// recordInteraction：u101 互动 12 次（friendly×8 / reliable×4）
const relSeq = []
for (let i = 0; i < 12; i++) {
  await gw.recordInteraction({ groupId: GROUP, targetUserId: 'u101', kind: i % 3 === 2 ? 'reliable' : 'friendly' })
  relSeq.push(await dao().get('SELECT familiarity,affinity,trust FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [BOT, GROUP, 'u101']))
}
// 冲突 ×2（u101 affinity 应下降）
const beforeConflict = await dao().get('SELECT familiarity,affinity,trust FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [BOT, GROUP, 'u101'])
await gw.recordInteraction({ groupId: GROUP, targetUserId: 'u101', kind: 'conflict' })
await gw.recordInteraction({ groupId: GROUP, targetUserId: 'u101', kind: 'conflict' })
// 现场构造
const pc = await gw.buildPlannerContext({ groupId: GROUP, focusUserId: 'u101', relatedUserIds: ['u102', 'u103'], topicText: '服务器运维 部署' })
const rc = await gw.buildReplyerContext({ groupId: GROUP, focusUserId: 'u101', relatedUserIds: ['u102'], topicText: '周末开黑' })
const tFull = Date.now() - T0
console.log(`\n[耗时] 消息 ${msgs.length} 条｜ingest ${tIngest}ms｜全链路(摄入+切片+LLM分析+日维护+周聚类+关系写回+现场) ${tFull}ms｜LLM 调用 ${llmCalls} 次｜小时分析 ${JSON.stringify(hourly)}`)

// ───────────────────────── ① 消息入库 ─────────────────────────
await test('① 消息入库（gw_messages）', async () => {
  const row = await dao().get('SELECT COUNT(*) c, COUNT(DISTINCT sender_id) m FROM gw_messages WHERE group_id=?', [GROUP])
  ok(row.c === msgs.length, `计数正确：${row.c} / ${msgs.length}`)
  ok(row.m === MEMBERS.length, `成员覆盖：${row.m} / ${MEMBERS.length} 个发送者`)
  ok(newCount === msgs.length, `全部为新消息（isNew）：${newCount}`)
  // 幂等：重复摄入不重复统计
  for (const m of msgs.slice(0, 10)) await gw.ingestMessage(m)
  const row2 = await dao().get('SELECT COUNT(*) c FROM gw_messages WHERE group_id=?', [GROUP])
  ok(row2.c === msgs.length, `幂等重放 10 条不重复（仍 ${row2.c}）`)
  const types = await dao().all('SELECT message_type, COUNT(*) c FROM gw_messages WHERE group_id=? GROUP BY message_type', [GROUP])
  ok(types.some((t) => t.message_type === 'media') && types.some((t) => t.message_type === 'text'), `message_type 分布正常：${types.map((t) => `${t.message_type}=${t.c}`).join(' ')}`)
})

// ───────────────────────── ② 画像 / 特征 / 互动统计 ─────────────────────────
await test('② 成员画像与互动统计', async () => {
  const prof = await dao().all('SELECT user_id,message_count_30d,active_days_30d,avg_message_length,activity_tier FROM gw_member_profiles WHERE group_id=? AND opt_out=0', [GROUP])
  ok(prof.length === MEMBERS.length, `画像行数 = ${MEMBERS.length}（实际 ${prof.length}）`)
  const sum = prof.reduce((a, p) => a + Number(p.message_count_30d || 0), 0)
  ok(sum === msgs.length, `30d 计数总和 = 消息数（${sum}/${msgs.length}）`)
  ok(prof.every((p) => p.message_count_30d >= 1 && p.message_count_30d <= msgs.length && p.avg_message_length >= 0 && p.avg_message_length <= 100), '计数/均长数值在合理范围')
  ok(prof.every((p) => ['hot', 'warm', 'cold', 'archived'].includes(p.activity_tier)), `活跃等级合法（分布 ${['hot','warm','cold'].map(t => t+'='+prof.filter(p=>p.activity_tier===t).length).join(' ')}）`)
  const traits = await dao().all("SELECT user_id,confidence,evidence_count,status FROM gw_traits WHERE group_id=? AND status='active'", [GROUP])
  ok(traits.length > 0, `gw_traits 非空（${traits.length} 条，覆盖 ${new Set(traits.map((t) => t.user_id)).size} 人）`)
  ok(traits.every((t) => t.confidence > 0 && t.confidence <= 1 && t.evidence_count >= 1), `特征置信/证据数合理（conf ∈ ${(Math.min(...traits.map(t=>t.confidence))).toFixed(2)}~${Math.max(...traits.map(t=>t.confidence)).toFixed(2)}，inferred 单证据 <0.55 不进在线 → 符合 §7.2）`)
  const edges = await dao().all('SELECT reply_count_30d r,mention_count_30d m,interaction_strength s FROM gw_edges WHERE group_id=?', [GROUP])
  const sumHit = edges.reduce((a, e) => a + e.r + e.m, 0)
  ok(edges.length > 0 && sumHit > 0, `关系边非空：${edges.length} 条（reply/mention 合计 ${sumHit}）`)
  ok(edges.every((e) => e.s >= 0 && e.s <= 1), `互动强度 ∈ [0,1]（max ${Math.max(...edges.map(e=>e.s)).toFixed(3)}）`)
  const eps = await dao().get("SELECT COUNT(*) c FROM gw_episodes WHERE group_id=? AND status='active'", [GROUP])
  ok(eps.c > 0, `事件记忆 gw_episodes 非空（${eps.c} 条）`)
})

// ───────────────────────── ③ gw_bot_rel 单调性 ─────────────────────────
await test('③ gw_bot_rel（机器人主观关系）单调方向', async () => {
  ok(relSeq.length === 12 && relSeq[0].familiarity > 0, `首次 recordInteraction 建行（fam=${relSeq[0].familiarity.toFixed(2)} aff=${relSeq[0].affinity.toFixed(2)}）`)
  let mono = true
  for (let i = 1; i < relSeq.length; i++) {
    if (relSeq[i].familiarity < relSeq[i - 1].familiarity || relSeq[i].affinity < relSeq[i - 1].affinity || relSeq[i].trust < relSeq[i - 1].trust) { mono = false; break }
  }
  ok(mono, 'friendly/reliable 交替 12 次：familiarity/affinity/trust 逐次单调不减')
  ok(relSeq[relSeq.length - 1].trust > 0, `reliable 提升信任（trust=${relSeq[relSeq.length - 1].trust.toFixed(2)} = 4×0.04）`)
  const after = await dao().get('SELECT affinity,familiarity,trust FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [BOT, GROUP, 'u101'])
  ok(after.affinity < beforeConflict.affinity, `conflict ×2 → affinity 下降（${beforeConflict.affinity.toFixed(2)} → ${after.affinity.toFixed(2)}）`)
  ok(after.familiarity === beforeConflict.familiarity && after.trust === beforeConflict.trust, 'conflict 不动 familiarity/trust（§5.6 单次冲突只记）')
  // 钳制上限：reply_to_bot ×60 → familiarity 封顶 1
  for (let i = 0; i < 60; i++) await gw.recordInteraction({ groupId: GROUP, targetUserId: 'u102', kind: 'reply_to_bot' })
  const cap = await dao().get('SELECT familiarity FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [BOT, GROUP, 'u102'])
  ok(Number(cap.familiarity.toFixed(4)) <= 1 && cap.familiarity > 0.9, `上限钳制 ≤1（60×0.04 → ${cap.familiarity.toFixed(4)}）`)
})

// ───────────────────────── ④ Planner/Replyer 现场 ─────────────────────────
await test('④ buildPlannerContext / buildReplyerContext', async () => {
  ok(pc.empty === false && pc.text.length > 0, `Planner 现场非空（${pc.text.length} 字符）`)
  ok(/【你与TA的关系】|【当前发言者|【相关/.test(pc.text), 'Planner 现场含关系/画像块')
  const pTok = estTokens(pc.text)
  ok(pTok <= 800, `Planner 预算可控（estTokens=${pTok} ≤ 800）`)
  ok(rc.empty === false && rc.text.length > 0, `Replyer 现场非空（${rc.text.length} 字符）`)
  const rTok = estTokens(rc.text)
  ok(rTok <= 500, `Replyer 预算可控（estTokens=${rTok} ≤ 500）`)
  ok(!/【所在圈子】/.test(rc.text), 'Replyer 不带圈子摘要（按角色裁剪）')
  // 异常输入不抛错
  const a1 = await gw.buildPlannerContext({ groupId: GROUP, focusUserId: null })
  const a2 = await gw.buildReplyerContext({ groupId: 'ghost-group-000', focusUserId: 'ghost-user' })
  const a3 = await gw.buildPlannerContext(null)
  const a4 = await gw.buildReplyerContext({ groupId: '', focusUserId: 'x' })
  ok(a1.empty === true, '无焦点用户 → 空现场不抛错')
  ok(a2 && typeof a2.text === 'string', `未知群/未知用户不抛错（陌生人现场兜底：${a2.empty ? 'empty' : `text=${a2.text.length} 字符`}）`)
  ok(a3.empty === true, 'null 输入不抛错')
  ok(a4.empty === true, '空群号不抛错')
})

// ───────────────────────── ⑤ SelfState 联动（gw_bot_rel → _relation） ─────────────────────────
await test('⑤ SelfState._relation 读 gw_bot_rel + reciprocalTeasing', async () => {
  await dao().run(
    'INSERT OR REPLACE INTO gw_bot_rel(bot_id,group_id,user_id,familiarity,affinity,trust,interaction_style,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [BOT, GROUP, 'F1', 0.8, 0.7, 0.5, '双方平时允许轻微互损', Date.now()],
  )
  const ss = new SelfStateService({ provider: fakeProvider, cfg: () => SS_CFG, botId: BOT, botNames: ['小汐'], trace: noTrace, dataDir: TMP })
  await ss.init()
  ok(ss.isReady() === true, 'SelfStateService 复用同一 gw.db 装配成功')
  const rel = await ss._relation(GROUP, 'F1')
  ok(rel.familiarity === 0.8 && rel.affinity === 0.7 && rel.trust === 0.5, `字段名/值与 gw_bot_rel 一致（fam=${rel.familiarity} aff=${rel.affinity} trust=${rel.trust}）`)
  ok(rel.reciprocalTeasing === true, `interaction_style='双方平时允许轻微互损' → reciprocalTeasing=true`)
  const rel2 = await ss._relation(GROUP, 'u101')
  ok(rel2.reciprocalTeasing === false, '无互损标记 → reciprocalTeasing=false')
  const rel3 = await ss._relation(GROUP, 'nobody')
  ok(rel3.familiarity === 0.15, '陌生人兜底 familiarity=0.15')
  // 端到端：熟人互损 → 事件入 ss_events + amusement ≥ annoyance（复用 test.mjs §23.1 场景）
  const norm = (id, userId, text, extra = {}) => ({ id, groupId: GROUP, userId, displayName: userId, timestamp: Date.now(), text, segments: [], replyToId: null, atBot: false, mentionsBotName: false, quotesBot: false, isCommand: false, isSelf: false, handledByDirectAgent: false, media: [], ...extra })
  const omr = await ss.onMessage(norm('t1', 'F1', '你这代码写得也太菜了', { replyToId: 'botmsg' }), { groupId: GROUP, quoteIsBot: true })
  ok(omr && omr.events >= 1, `熟人互损端到端：事件入 ss_events（onMessage=${JSON.stringify(omr)}）`)
  const ev = await dao().get("SELECT emotion_impulse_json FROM ss_events WHERE group_id=? ORDER BY id DESC LIMIT 1", [GROUP])
  ok(!!ev?.emotion_impulse_json, `事件带情绪脉冲（impulse=${ev?.emotion_impulse_json}）`)
  const em = await dao().all("SELECT emotion_type,intensity FROM ss_emotions WHERE bot_id=? AND group_id=? AND status='active'", [BOT, GROUP])
  const amuse = em.find((e) => e.emotion_type === 'amusement')?.intensity || 0
  const annoy = em.find((e) => e.emotion_type === 'annoyance')?.intensity || 0
  ok(amuse >= annoy, `amusement(${amuse.toFixed(2)}) ≥ annoyance(${annoy.toFixed(2)})（实际主导情绪 ${em.map((e) => `${e.emotion_type}=${e.intensity.toFixed(3)}`).join(',') || '无'}，低于可见阈值 0.18 不外显）`)
  const relF1 = await dao().get('SELECT resentment FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [BOT, GROUP, 'F1'])
  ok((relF1?.resentment || 0) <= 0.03, `玩笑不留怨气（resentment=${relF1?.resentment || 0}）`)
  await ss.resetGroupState(GROUP)
})

// ───────────────────────── ⑥ 附带验证：统计/预算/已知问题 ─────────────────────────
await test('⑥ 附带：统计接口 + 切片/预算 + 已知 bug 复现', async () => {
  const st = await gw.getStats(GROUP)
  ok(st && st.members === MEMBERS.length && st.traits > 0 && st.edges > 0, `getStats：members=${st.members} traits=${st.traits} edges=${st.edges} episodes=${st.episodes} communities=${st.communities}`)
  const dead = await dao().get("SELECT COUNT(*) c FROM gw_segments WHERE group_id=? AND status='dead_letter'", [GROUP])
  ok(dead.c === 0, `无 dead_letter 片段（${hourly.analyzed} 成功 / ${hourly.failed} 失败）`)
  const cursor = await dao().get('SELECT daily_calls_today FROM gw_cursor WHERE group_id=?', [GROUP])
  ok(cursor.daily_calls_today === hourly.analyzed && cursor.daily_calls_today <= 100, `每日预算记账一致（calls=${cursor.daily_calls_today} ≤ 100）`)
  // 回归：evidence.js fallback INSERT 占位符已修（8 列 8 ?）——空 evidenceMsgs 时证据留痕应成功
  await gw.resolver.mergeRelationCandidate({ groupId: GROUP, fromUserId: 'u101', toUserId: 'u116', hint: '空证据fallback测试', evidenceMsgs: [], now: Date.now() })
  const ev = await dao().get("SELECT id FROM gw_evidence WHERE target_type='edge' AND evidence_text LIKE '%空证据fallback测试%'", )
  ok(ev != null, '（回归）evidence.js:186 空 evidenceMsgs 时 fallback 证据成功留痕（占位符已修）')
  // 未知 kind 的容错
  await gw.recordInteraction({ groupId: GROUP, targetUserId: 'u103', kind: 'whatever' })
  const unk = await dao().get('SELECT familiarity FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [BOT, GROUP, 'u103'])
  ok(unk && unk.familiarity > 0, `未知 kind 走 neutral 默认增量（fam=${unk.familiarity.toFixed(3)}）`)
})

// ───────────────────────── ⑥ 性能 ─────────────────────────
await test('⑥ 性能（fake provider 同步返回）', async () => {
  ok(tFull < 30000, `${msgs.length} 条消息全链路耗时 ${tFull}ms < 30s（ingest ${tIngest}ms，分析/维护/写回/现场 ${tFull - tIngest}ms）`)
})

// ───────────────────────── 总结 ─────────────────────────
console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
if (notes.length) console.log('发现的问题：\n - ' + notes.join('\n - '))
console.log('========================================')
Db.closeDb()
fs.rmSync(TMP, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
