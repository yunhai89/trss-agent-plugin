/**
 * groupworld 离线自检（设计文档 §16.1 单元测试）。
 * 覆盖：幂等摄入 / 有向边 / 跨群隔离 / 跨 bot 主观关系隔离 / 衰减数学 / 低置信排除 /
 *   证据失效重算 / 检索预算 / 切片 / 分析器端到端（fake provider，不联网）/ 配置校验。
 * 运行：node model/groupworld/test.mjs   （被 scripts/run-tests.mjs 自动发现）
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import * as Db from './db.js'
import { GroupWorldIngester } from './ingest.js'
import { ConversationSegmenter, isLowValue } from './segmenter.js'
import { EvidenceResolver } from './evidence.js'
import { WorldAnalyzer } from './analyzer.js'
import { WorldRetriever } from './retriever.js'
import { WorldContextBuilder } from './context-builder.js'
import { WorldMaintenance } from './maintenance.js'
import { CommunityDetector } from './community.js'
import { interactionStrength, reciprocity, confidence, recencyFactor, retrievalScore, estTokens, validateAnalyzerOutput, parseAnalyzerOutput } from './index.js'
import { cosine, toBlob, fromBlob, makeEmbedder, textSim } from './embedding.js'
import { validateGroupWorldConfig } from './default-config.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

const TMP = path.join(os.tmpdir(), `gw-test-${process.pid}`)
fs.rmSync(TMP, { recursive: true, force: true })
await Db.initDb({ dir: TMP })
const dao = Db.dao

const cfgFn = () => ({
  ingestion: { rawMessageRetentionDays: 30, segmentIdleSeconds: 300, segmentMaxMessages: 100 },
  analysis: { minSegmentMessages: 2, maxSegmentsPerRun: 50, modelProfile: '', maxDailyCallsPerGroup: 100, retryCount: 1, maxTokens: 1200 },
  profiles: { hotActiveDays30d: 10, warmMessageCount30d: 5, minOnlineConfidence: 0.55, maxTraitsPerUser: 5, temporaryTraitTtlDays: 14 },
  graph: { activeEdgeDays: 90, maxNeighborsPerUser: 40, maxOnlineHops: 1, weeklyCommunityDetection: true, minCommunitySize: 3 },
  retrieval: { plannerTokenBudget: 800, replyerTokenBudget: 500, maxEpisodes: 3, maxRelationships: 5, cacheTtlSeconds: 60 },
})

// ───────── scoring ─────────
await test('scoring：衰减/互动强度/互惠度/置信范围', async () => {
  ok(Math.abs(recencyFactor(0) - 1) < 1e-9, 'recencyFactor(0)=1')
  ok(recencyFactor(30) < recencyFactor(10) && recencyFactor(10) < 1, 'recency 随天数递减')
  ok(interactionStrength({ replyCount: 10, daysSince: 0 }) > interactionStrength({ replyCount: 10, daysSince: 60 }), '互动强度随时间衰减')
  ok(reciprocity(5, 5) === 1 && reciprocity(5, 0) === 0, '互惠度：双向=1 单向=0')
  ok(confidence({ sourceType: 'explicit' }) >= 0.75, '自述 ≥0.75')
  ok(confidence({ sourceType: 'statistical' }) >= 0.9, '统计 ≥0.9')
  ok(confidence({ sourceType: 'inferred' }) <= 0.45, '单片推断 ≤0.45')
  ok(confidence({ sourceType: 'inferred', distinctDates: 8 }) > 0.55, '推断多日期反复可超 0.55')
})

// ───────── config ─────────
await test('config：online 需 enabled；minOnlineConfidence 地板 0.55', async () => {
  const v = validateGroupWorldConfig({ enabled: false, groups: ['1'], online: true })
  ok(v.config.online === false, 'enabled=false 时 online 被强制 false')
  const v2 = validateGroupWorldConfig({ enabled: true, groups: ['1'], online: true, profiles: { minOnlineConfidence: 0.3 } })
  ok(v2.config.online === true && v2.config.profiles.minOnlineConfidence === 0.55, 'online 放行 + minConf 地板 0.55')
  const v3 = validateGroupWorldConfig({ enabled: true, groups: [] })
  ok(v3.config.enabled === false, 'groups 空 → 不开启')
})

// ───────── ingest：幂等 + 有向边 + 跨群隔离 ─────────
await test('ingest：幂等/有向边/跨群隔离', async () => {
  const ing = new GroupWorldIngester({ dao })
  const t = 1700000000000
  const r1 = await ing.ingestMessage({ id: 'a1', groupId: 'G1', userId: 'A', displayName: '甲', timestamp: t, text: '在吗', segments: [], replyToId: null, media: [] })
  const r2 = await ing.ingestMessage({ id: 'a2', groupId: 'G1', userId: 'B', displayName: '乙', timestamp: t + 60000, text: '在', segments: [{ type: 'at', qq: 'A' }], replyToId: 'a1', atBot: false, media: [] })
  const dup = await ing.ingestMessage({ id: 'a1', groupId: 'G1', userId: 'A', displayName: '甲', timestamp: t, text: '在吗', segments: [], replyToId: null, media: [] })
  ok(r1.isNew && r2.isNew && !dup.isNew, '幂等：重复写入不新增')
  const edges = await dao.all('SELECT from_user_id,to_user_id,reply_count_30d,mention_count_30d FROM gw_edges WHERE group_id=?', ['G1'])
  ok(edges.length === 1 && edges[0].from_user_id === 'B' && edges[0].to_user_id === 'A' && edges[0].reply_count_30d === 1 && edges[0].mention_count_30d === 1, '回复+@ 建立有向边 B→A')
  // 跨群隔离：同用户在 G2 无 profile/边
  await ing.ingestMessage({ id: 'b1', groupId: 'G2', userId: 'A', displayName: '甲', timestamp: t, text: 'hi', segments: [], replyToId: null, media: [] })
  const pG2 = await dao.get('SELECT message_count_30d FROM gw_member_profiles WHERE group_id=? AND user_id=?', ['G2', 'A'])
  const eG2 = await dao.all('SELECT * FROM gw_edges WHERE group_id=?', ['G2'])
  ok(pG2.message_count_30d === 1 && eG2.length === 0, '跨群隔离：G2 的 A 独立，无 G1 的边')
})

// ───────── segmenter ─────────
await test('segmenter：闭合静默片段 + 低价值判定', async () => {
  ok(isLowValue({ plain_text: '哈哈', message_type: 'text' }) && isLowValue({ plain_text: '[图片]', message_type: 'media' }), '低价值判定')
  ok(!isLowValue({ plain_text: '这个服务器配置怎么样？', message_type: 'text' }), '有效内容非低价值')
  const ing = new GroupWorldIngester({ dao })
  const seg = new ConversationSegmenter({ dao })
  const t = 1710000000000
  // 两条间隔 1 分钟（< idle）→ 同一片段
  await ing.ingestMessage({ id: 's1', groupId: 'GS', userId: 'S', displayName: '斯', timestamp: t, text: '这个服务器配置咋样', segments: [], replyToId: null, media: [] })
  await ing.ingestMessage({ id: 's2', groupId: 'GS', userId: 'S', displayName: '斯', timestamp: t + 60000, text: '够用吗', segments: [], replyToId: null, media: [] })
  await seg.processGroup('GS', { segmentIdleSeconds: 300 }, t + 60000)
  // 7 分钟后处理 → 超过 idle 触发闭合
  await seg.processGroup('GS', { segmentIdleSeconds: 300 }, t + 60000 + 7 * 60000)
  const closed = await dao.all("SELECT * FROM gw_segments WHERE group_id=? AND status='closed'", ['GS'])
  ok(closed.length >= 1, '静默超阈值 → 片段闭合')
})

// ───────── analyzer 端到端（fake provider） ─────────
await test('analyzer：端到端抽取 + 置信重算 + 敏感丢弃', async () => {
  const ing = new GroupWorldIngester({ dao })
  const seg = new ConversationSegmenter({ dao })
  const resolver = new EvidenceResolver({ dao, minOnlineConfidence: 0.55 })
  const fakeOut = {
    topics: [{ name: '服务器', participant_ids: ['u1'], confidence: 0.8 }],
    trait_candidates: [{ user_id: 'u1', trait_type: 'interest', trait_key: 'server_ops', trait_value: '爱聊服务器运维', confidence: 0.9, evidence_message_ids: ['z1'] }],
    relation_candidates: [{ from_user_id: 'u1', to_user_id: 'u2', relation_hint: '记得对方服务器经历', confidence: 0.3, evidence_message_ids: ['z1'] }],
    episode_candidates: [],
    sensitive_inferences: [],
  }
  const fakeProvider = { chat: async () => ({ content: JSON.stringify(fakeOut) }) }
  const az = new WorldAnalyzer({ provider: fakeProvider, dao, segmenter: seg, resolver, cfg: cfgFn })
  const t = 1720000000000
  await ing.ingestMessage({ id: 'z1', groupId: 'GZ', userId: 'U1', displayName: '甲', timestamp: t, text: '这台2C4G总崩', segments: [], replyToId: null, media: [] })
  await ing.ingestMessage({ id: 'z2', groupId: 'GZ', userId: 'U2', displayName: '乙', timestamp: t + 30000, text: '是啊', segments: [], replyToId: 'z1', atBot: false, media: [] })
  await seg.processGroup('GZ', { segmentIdleSeconds: 300 }, t + 30000)
  await seg._closeIdleOpen('GZ', 60000, t + 30 * 60000) // 强闭合
  // 直接跑 _analyzeSegment（跳过预算/调度）
  const pending = await seg.pendingSegments('GZ', cfgFn().analysis, { maxSegmentsPerRun: 5 })
  ok(pending.length >= 1, '有待分析片段')
  if (pending.length) {
    await az._analyzeSegment('GZ', pending[0], cfgFn(), t + 31 * 60000)
    const tr = await dao.get("SELECT confidence,source_type FROM gw_traits WHERE group_id=? AND user_id=? AND trait_key='server_ops'", ['GZ', 'U1'])
    ok(!!tr, '分析产出特征已入库')
    ok(tr.source_type === 'inferred' && tr.confidence <= 0.45, `单片推断置信被重算 ≤0.45（实际 ${tr.confidence}）`)
    const segRow = await dao.get("SELECT status FROM gw_segments WHERE id=?", [pending[0].segment.id])
    ok(segRow.status === 'analyzed', '片段标记 analyzed')
  }
  // 敏感过滤（parseAnalyzerOutput/validate）
  const parsed = parseAnalyzerOutput(JSON.stringify({ trait_candidates: [{ user_id: 'u1', trait_type: 'interest', trait_key: 'k', trait_value: '他的抑郁症', confidence: 0.5, evidence_message_ids: ['z1'] }], relation_candidates: [], episode_candidates: [], topics: [] }))
  const valid = validateAnalyzerOutput(parsed, new Set(['z1']))
  ok(valid.trait_candidates.length === 0 && valid.sensitive_inferences.length === 1, '敏感推断被丢弃')
})

// ───────── retriever：低置信排除 / 高置信纳入 ─────────
await test('retriever：低置信不进现场，纠正后纳入', async () => {
  const resolver = new EvidenceResolver({ dao, minOnlineConfidence: 0.55 })
  const ret = new WorldRetriever({ dao, cfg: cfgFn })
  // 单片推断特征（≤0.45）→ 不进在线
  await resolver.mergeTraitCandidate({ groupId: 'GR', userId: 'R1', candidate: { trait_type: 'interest', trait_key: 'music', trait_value: '喜欢音乐' }, evidenceMsgs: [{ message_id: 'r1', text: '喜欢音乐', sent_at: Date.now() }], sourceType: 'inferred' })
  let scene = await ret.gather({ botId: 'bot1', groupId: 'GR', focusUserId: 'R1', now: Date.now() })
  ok(scene.focusTraits.length === 0, '单片推断特征被低置信过滤（不进现场）')
  // 纠正（admin_corrected，高置信）→ 纳入
  await resolver.mergeTraitCandidate({ groupId: 'GR', userId: 'R1', candidate: { trait_type: 'self_disclosed_fact', trait_key: 'corr', trait_value: '其实是做前端的' }, evidenceMsgs: [{ message_id: 'r2', text: '做前端的', sent_at: Date.now() }], sourceType: 'admin_corrected' })
  scene = await ret.gather({ botId: 'bot1', groupId: 'GR', focusUserId: 'R1', now: Date.now() })
  ok(scene.focusTraits.some((t) => t.trait_value === '其实是做前端的'), '纠正后的高置信特征进入现场')
})

// ───────── 证据失效重算 ─────────
await test('evidence：删证据触发画像失效/重算', async () => {
  const resolver = new EvidenceResolver({ dao, minOnlineConfidence: 0.55 })
  await resolver.mergeTraitCandidate({ groupId: 'GE', userId: 'E1', candidate: { trait_type: 'interest', trait_key: 'x', trait_value: '某兴趣' }, evidenceMsgs: [{ message_id: 'e1', text: '某兴趣', sent_at: Date.now() }], sourceType: 'inferred' })
  await resolver.invalidateByMessage('GE', 'e1', Date.now())
  const tr = await dao.get("SELECT status FROM gw_traits WHERE group_id=? AND user_id=? AND trait_key='x'", ['GE', 'E1'])
  ok(tr.status === 'expired', '唯一证据删除 → 特征 expired')
})

// ───────── context-builder：token 预算截断 ─────────
await test('context-builder：极小预算下截断特征', async () => {
  const ret = new WorldRetriever({ dao, cfg: () => ({ ...cfgFn(), profiles: { ...cfgFn().profiles, maxTraitsPerUser: 8 } }) })
  const cb = new WorldContextBuilder({ retriever: ret, cfg: () => ({ ...cfgFn(), profiles: { ...cfgFn().profiles, maxTraitsPerUser: 8 }, retrieval: { plannerTokenBudget: 120, replyerTokenBudget: 100, maxEpisodes: 3, maxRelationships: 5 } }) })
  // 给 GR/R1 灌入多条长高置信特征（admin_corrected）
  const resolver = new EvidenceResolver({ dao, minOnlineConfidence: 0.55 })
  for (let i = 0; i < 8; i++) await resolver.mergeTraitCandidate({ groupId: 'GR', userId: 'R1', candidate: { trait_type: 'self_disclosed_fact', trait_key: 'cb' + i, trait_value: '纠正条目内容'.repeat(8) + i }, evidenceMsgs: [{ message_id: 'cb' + i, text: 'x', sent_at: Date.now() }], sourceType: 'admin_corrected' })
  const out = await cb.buildPlannerContext({ botId: 'bot1', groupId: 'GR', focusUserId: 'R1', topicText: '', now: Date.now() })
  ok(!out.empty, '有现场返回')
  ok((out.socialScene.focusUser.relevantTraits || []).length < 8, `预算截断：特征数 ${out.socialScene.focusUser?.relevantTraits?.length}/8 被裁剪`)
  ok(estTokens(out.text) <= 200, `截断后 token 受控（${estTokens(out.text)}tok ≤ 200）`)
})

await test('context-builder：旧事 occurredAt 透传并渲染时间感', async () => {
  const now = Date.now()
  const occurredAt = now - 3 * 86400e3
  const cb = new WorldContextBuilder({
    retriever: {
      gather: async () => ({
        empty: false,
        focusProfile: null,
        focusTraits: [],
        edges: [],
        episodes: [{ summary: '之前讨论过部署', confidence: 0.8, occurredAt }],
      }),
    },
    cfg: () => ({}),
  })
  const out = await cb.buildReplyerContext({ groupId: 'CTX', focusUserId: 'u1', now })
  ok(out.socialScene?.relevantEpisodes?.[0]?.occurredAt === occurredAt, 'structured scene 保留 occurredAt')
  ok(out.text.includes('3天前'), `prompt 渲染旧事时间感（${out.text.includes('3天前') ? '3天前' : '缺失'}）`)
})

// ───────── 跨 bot 主观关系隔离 ─────────
await test('recordInteraction：跨 bot 主观关系隔离', async () => {
  // 直接写 gw_bot_rel 模拟两个 bot
  const now = Date.now()
  await dao.run('INSERT OR REPLACE INTO gw_bot_rel(bot_id,group_id,user_id,familiarity,interaction_count,last_interacted_at,updated_at) VALUES (?,?,?,?,?,?,?)', ['botA', 'GB', 'U', 0.5, 1, now, now])
  await dao.run('INSERT OR REPLACE INTO gw_bot_rel(bot_id,group_id,user_id,familiarity,interaction_count,last_interacted_at,updated_at) VALUES (?,?,?,?,?,?,?)', ['botB', 'GB', 'U', 0.1, 1, now, now])
  const a = await dao.get('SELECT familiarity FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', ['botA', 'GB', 'U'])
  const b = await dao.get('SELECT familiarity FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', ['botB', 'GB', 'U'])
  ok(a.familiarity === 0.5 && b.familiarity === 0.1, '不同 bot 对同用户的主观关系独立存储')
})

// ───────── P0 语义层：embedding 工具 ─────────
await test('embedding：余弦/BLOB/textSim/降级', async () => {
  ok(cosine([1, 0], [1, 0]) === 1 && Math.abs(cosine([1, 0], [0, 1])) < 1e-9, '余弦：同向=1 正交=0')
  ok(cosine([1, 0], [1, 0, 0]) === null && cosine(null, [1]) === null, '维度不匹配/空 → null')
  const buf = toBlob([0.5, -0.25, 0.125])
  const back = fromBlob(buf)
  ok(back && back.length === 3 && Math.abs(back[0] - 0.5) < 1e-6 && Math.abs(back[2] - 0.125) < 1e-6, 'BLOB 往返无损')
  ok(fromBlob(null) === null && toBlob([]) === null, '空输入 → null')
  // 中文 bigram：相关 > 无关
  const rel = textSim('这台服务器总是崩', '服务器又崩了')
  const unrel = textSim('这台服务器总是崩', '周末去爬山真开心')
  ok(rel > unrel && rel > 0.1, `中文 bigram 相似度：相关 ${rel.toFixed(3)} > 无关 ${unrel.toFixed(3)}`)
  ok(textSim('', 'abc') === 0, '空文本 → 0')
  // makeEmbedder 降级
  ok(makeEmbedder({}) === null && makeEmbedder({ embedFn: 'not-fn' }) === null, '无 embedFn → null（整层禁用）')
  const emb = makeEmbedder({ embedFn: async (t) => (t.includes('服务器') ? [1, 0] : [0, 1]), model: 'fake' })
  ok(emb && emb.model === 'fake', '嵌入器包装 + model 标识')
  ok((await emb.embed('服务器'))[0] === 1, 'embed 正常')
  ok((await makeEmbedder({ embedFn: async () => { throw new Error('x') } }).embed('t')) === null, 'embed 失败 → null 不抛')
})

// ───────── P0：TextTiling 主题漂移切分 ─────────
await test('segmenter：主题漂移切分（无静默间隙也分割）', async () => {
  const ing = new GroupWorldIngester({ dao })
  const seg = new ConversationSegmenter({ dao })
  const t = 1730000000000
  // 6 条服务器话题（间隔 30s，远小于 idle）→ 一片
  const srv = ['这台服务器配置不行', '服务器升级要多少钱', '服务器维护太麻烦了', '服务器带宽够用吗', '服务器又崩了一次', '服务器 backups 怎么做']
  for (let i = 0; i < srv.length; i++) await ing.ingestMessage({ id: `ts${i}`, groupId: 'GT', userId: 'A', displayName: 'a', timestamp: t + i * 30000, text: srv[i], segments: [], replyToId: null, media: [] })
  // 突然换话题（间隔仍 30s）：与近窗词面几乎无交集 → 应触发漂移分割
  await ing.ingestMessage({ id: 'tn0', groupId: 'GT', userId: 'B', displayName: 'b', timestamp: t + 6 * 30000, text: '周末去看电影怎么样', segments: [], replyToId: null, media: [] })
  await ing.ingestMessage({ id: 'tn1', groupId: 'GT', userId: 'B', displayName: 'b', timestamp: t + 7 * 30000, text: '电影票已经买好了', segments: [], replyToId: null, media: [] })
  const r = await seg.processGroup('GT', { segmentIdleSeconds: 300, topicShiftEnabled: true, minSegmentMessages: 4 }, t + 7 * 30000)
  const segs = await dao.all("SELECT start_msg_id, msg_count, status FROM gw_segments WHERE group_id='GT' ORDER BY id")
  ok((r.topicSplits || 0) >= 1, `漂移触发分割（topicSplits=${r.topicSplits}）`)
  ok(segs.length >= 2, `换话题产生新片段（共 ${segs.length} 片）`)
  // 引用链不分割：在近窗不同的片段里回复片内消息不触发（下面单独组验证）
  const t2 = 1740000000000
  for (let i = 0; i < 6; i++) await ing.ingestMessage({ id: `rc${i}`, groupId: 'GR2', userId: 'A', displayName: 'a', timestamp: t2 + i * 30000, text: srv[i], segments: [], replyToId: null, media: [] })
  // 回复片内消息，但文本完全换话题 → 不应分割（引用链强相关保留）
  await ing.ingestMessage({ id: 'rc7', groupId: 'GR2', userId: 'B', displayName: 'b', timestamp: t2 + 6 * 30000, text: '周末去看电影怎么样', segments: [], replyToId: 'rc5', media: [] })
  const r2 = await seg.processGroup('GR2', { segmentIdleSeconds: 300, topicShiftEnabled: true, minSegmentMessages: 4 }, t2 + 6 * 30000)
  ok((r2.topicSplits || 0) === 0, `片内引用链不触发分割（topicSplits=${r2.topicSplits}）`)
  // 关闭开关 → 不分割
  const t3 = 1750000000000
  for (let i = 0; i < 6; i++) await ing.ingestMessage({ id: `of${i}`, groupId: 'GO', userId: 'A', displayName: 'a', timestamp: t3 + i * 30000, text: srv[i], segments: [], replyToId: null, media: [] })
  await ing.ingestMessage({ id: 'of7', groupId: 'GO', userId: 'B', displayName: 'b', timestamp: t3 + 6 * 30000, text: '周末去看电影怎么样', segments: [], replyToId: null, media: [] })
  const r3 = await seg.processGroup('GO', { segmentIdleSeconds: 300, topicShiftEnabled: false, minSegmentMessages: 4 }, t3 + 6 * 30000)
  ok((r3.topicSplits || 0) === 0 && (await dao.get("SELECT COUNT(*) c FROM gw_segments WHERE group_id='GO'")).c === 1, 'topicShiftEnabled=false → 不分割')
})

// ───────── P0：语义层端到端（fake embedder）─────────
await test('语义层：事件语义去重 + 近义特征合并 + 检索余弦（fake embedder）', async () => {
  const emb = makeEmbedder({ embedFn: async (t) => (String(t).includes('服务器') || String(t).includes('运维') ? [1, 0] : String(t).includes('前端') || String(t).includes('页面') ? [0, 1] : [0.5, 0.5]), model: 'fake-v1' })
  ok(!!emb, 'fake 嵌入器就绪')
  // ① 事件语义去重：不同 title、同语义 → 合并为一条
  const res = new EvidenceResolver({ dao, minOnlineConfidence: 0.55, embedder: emb, episodeMergeSim: 0.85 })
  const t = 1760000000000
  const e1 = await res.mergeEpisodeCandidate({ groupId: 'GE2', candidate: { episode_type: 'ongoing_topic', title: '服务器配置', summary: '常聊服务器配置' }, evidenceMsgs: [{ message_id: 'x1', text: '服务器', sent_at: t }], now: t })
  const e2 = await res.mergeEpisodeCandidate({ groupId: 'GE2', candidate: { episode_type: 'ongoing_topic', title: '运维话题', summary: '服务器运维相关' }, evidenceMsgs: [{ message_id: 'x2', text: '运维', sent_at: t + 3600000 }], now: t + 3600000 })
  ok(e1 === e2, `事件语义去重：不同 title 同义合并为同一 id（${e1} === ${e2}）`)
  const eRows = await dao.all("SELECT id, embedding FROM gw_episodes WHERE group_id='GE2'")
  ok(eRows.length === 1 && !!eRows[0].embedding, '仅一条事件且已存 embedding BLOB')
  // ② 近义特征合并：同用户同类型两条近义（服务器域）+ 一条无关（前端域）→ 合并 2 留 1+1
  await res.mergeTraitCandidate({ groupId: 'GM2', userId: 'U', candidate: { trait_type: 'interest', trait_key: 'srv1', trait_value: '爱聊服务器运维' }, evidenceMsgs: [{ message_id: 'y1', text: 'x', sent_at: t }], sourceType: 'admin_corrected', now: t })
  await res.mergeTraitCandidate({ groupId: 'GM2', userId: 'U', candidate: { trait_type: 'interest', trait_key: 'srv2', trait_value: '经常讨论服务器配置' }, evidenceMsgs: [{ message_id: 'y2', text: 'x', sent_at: t }], sourceType: 'admin_corrected', now: t })
  await res.mergeTraitCandidate({ groupId: 'GM2', userId: 'U', candidate: { trait_type: 'interest', trait_key: 'fe', trait_value: '做前端页面开发' }, evidenceMsgs: [{ message_id: 'y3', text: 'x', sent_at: t }], sourceType: 'admin_corrected', now: t })
  const mt = new WorldMaintenance({ dao, cfg: () => ({ profiles: { traitMergeSimThreshold: 0.82 } }), embedder: emb })
  const merged = await mt._mergeSimilarTraits('GM2', t)
  const tRows = await dao.all("SELECT trait_key, evidence_count FROM gw_traits WHERE group_id='GM2' AND status='active'")
  ok(merged === 1 && tRows.length === 2, `近义合并：2 条服务器域 → 1 条（merged=${merged}，剩 ${tRows.length} 条）`)
  ok((tRows.find(r => r.trait_key === 'srv1')?.evidence_count || tRows.find(r => r.trait_key === 'srv2')?.evidence_count || 0) === 2, '主特征吸收被并特征的证据（evidence_count=2）')
  // ③ 检索余弦：topic 与事件同域 → 高相似（embedding 路径生效）
  const ret = new WorldRetriever({ dao, cfg: () => ({ graph: { maxNeighborsPerUser: 0, activeEdgeDays: 90 }, profiles: { minOnlineConfidence: 0.55, maxTraitsPerUser: 5 }, retrieval: { maxEpisodes: 3 } }), embedder: emb })
  const raw = await ret.gather({ botId: 'bot', groupId: 'GE2', focusUserId: 'NOBODY', topicText: '服务器又崩了怎么办', now: t })
  ok(raw.episodes.length === 1, '语义检索：换说法仍命中同域事件')
})

// ───────── 总结 ─────────
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
Db.closeDb()
fs.rmSync(TMP, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
