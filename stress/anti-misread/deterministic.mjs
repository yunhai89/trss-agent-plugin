/**
 * 伪人"认错对象"修复 —— 确定性层压测（不调真 LLM）。
 *
 * 背景 bug：群里 bot 把"林墨引用芜湖的消息怼芜湖"理解成在说自己（误触发+误反击），
 * 还把两小时前的旧人物"云海"凭记忆渗入回复。本脚本回归修复的确定性层：
 *  a) grounding.js   resolveGrounding / formatGroundingBlock / whitelistViolations / windowNames / correction / botChain
 *  b) necessity-scorer.js  isFollowupToBot 回复链归属 / mentions_bot_name_ambiguous 歧义降级 / directionPenalty 纯文本叫人名
 *  c) prompts.js formatGroupContext  ↩回复X(原文) 注入 / @QQ号→@人名
 *  d) memory-store recall allowedUsers（印象只允许活跃人物命中）
 *  e) SelfStateService.applyCorrection（认错对象后的情绪/关系残留冲销 + ss_events 标 misjudged）
 *  f) bot↔bot 熔断（botChain / turn-scheduler 尾部扫描语义）
 *
 * 运行：node stress/anti-misread/deterministic.mjs
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import { resolveGrounding, formatGroundingBlock, whitelistViolations, windowNames } from '../../model/humanize/grounding.js'
import { evaluate } from '../../model/humanize/necessity-scorer.js'
import { formatGroupContext } from '../../model/humanize/prompts.js'
import { HumanizeMemoryStore } from '../../model/humanize/memory-store.js'
import { HumanizePlanner } from '../../model/humanize/planner.js'
import { HumanizeReplyer } from '../../model/humanize/replyer.js'
import * as Db from '../../model/groupworld/db.js'
import { SelfStateService } from '../../model/selfstate/service.js'

let passed = 0, failed = 0, bugs = []
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m); bugs.push(m) } }
const test = async (name, fn) => { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 4).join('\n')); bugs.push(`${name}: ${e?.message}`) } }

// ── 常量 ──
const G = '960179589'
const BOT = '2721779039'
const BOT_NAME = '小汐'
const WU = '10001' // 芜湖
const LU = '10002' // 林墨
const YU = '10003' // 云海（两小时前的旧人物）
const MU = '10004' // 阿明（普通用户）
const WANG = '10005' // 小王

// ── AmbientMessage 工厂（对齐 message-normalizer 产物字段）──
const now = Date.now()
const mk = (id, uid, name, text, o = {}) => ({
  id, groupId: G, userId: String(uid), displayName: name,
  timestamp: o.ts ?? now,
  text,
  segments: o.segments ?? [],
  replyToId: o.replyToId ?? null,
  atBot: !!o.atBot,
  mentionsBotName: !!o.mentionsBotName,
  quotesBot: !!o.quotesBot,
  isCommand: false, isSelf: !!o.isSelf, handledByDirectAgent: false, media: [],
})
const self = (id, text) => mk(id, BOT, BOT_NAME, text, { isSelf: true, ts: now })
const atBotSeg = [{ type: 'at', qq: String(BOT) }]

// ═══════════════ S1 基线一对一：正常 @bot 提问不被修复误伤 ═══════════════
await test('S1 基线：用户 @bot 提问 → at_bot 强触发、grounding 指向"我"', async () => {
  const b1 = self('s1a', '我刚说完这个事')
  const q1 = mk('q1a', MU, '阿明', '@小汐 那你觉得今天这个版本怎么样？', {
    atBot: true, mentionsBotName: true, segments: atBotSeg, replyToId: 's1a',
  })
  const d = evaluate({ messages: [b1, q1], candidates: [q1], presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(d.components.relevance === 100, `atBot → relevance=100（实际 ${d.components.relevance}）`)
  ok(d.positiveReasons.includes('at_bot'), `reason 含 at_bot（${d.positiveReasons.join(',')}）`)
  ok(d.forcedCandidate === true, '强信号 forcedCandidate（不乘频率倍率）')
  ok(d.shouldPlan === true, `shouldPlan=true（final=${d.finalScore}）——正常对话不被误伤`)

  const g = resolveGrounding([b1, q1])
  ok(g.semanticTarget === '我', `grounding.semanticTarget='我'（实际 ${g.semanticTarget}）`)
  ok(g.confidence === 0.95, `置信 0.95（实际 ${g.confidence}）`)
  ok(g.quoted?.name === '我', '被回复的是 bot 自己')
  ok(g.mentions.length === 1 && g.mentions[0].name === '我', '@ 段解析到 bot → 名字记作"我"')
  ok(g.allowedEntities.includes('阿明') && g.allowedEntities.includes('我'), `白名单含发言者（${g.allowedEntities.join('、')}）`)
})

// ═══════════════ S2 核心样本：A 说 B（林墨引用芜湖怼芜湖，紧跟 bot 发言+疑问语气）═══════════════
await test('S2 A说B：林墨回复芜湖怼芜湖 → 不算对 bot 追问、上下文标注↩回复芜湖(原文)', async () => {
  const w1 = mk('w1', WU, '芜湖', '帮我把我禁言')
  const b1 = self('s2b', '这我哪有权限啊')
  const l1 = mk('l1', LU, '林墨', '权限摆脸上自己不会看？', { replyToId: 'w1' })
  const win = [w1, b1, l1]

  // scorer：紧跟 bot + 疑问语气，但 replyToId 指向非 bot 消息 → 不是 followup_to_bot
  const d = evaluate({ messages: win, candidates: [l1], presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(d.components.relevance === 0, `relevance=0（实际 ${d.components.relevance}）——回复链归属修复生效`)
  ok(!d.positiveReasons.includes('followup_to_bot'), '无 followup_to_bot（旧逻辑此处会误 +55）')
  ok(!d.positiveReasons.includes('mentions_bot_name') && !d.positiveReasons.includes('mentions_bot_name_ambiguous'), '无 mentions_bot_name')
  ok(d.shouldPlan === false, `shouldPlan=false（final=${d.finalScore}）——bot 不插嘴别人的互怼`)

  // formatGroupContext：回复关系带被引原文（指代消解的关键）
  const ctx = formatGroupContext(win)
  ok(ctx.includes('↩回复芜湖(帮我把我禁言)'), `上下文含"↩回复芜湖(帮我把我禁言)"（实际行：${ctx.split('\n').find((l) => l.includes('林墨')) || ''}）`)
  ok(ctx.split('\n').some((l) => l.startsWith('我') && l.includes('（我）')), 'bot 自身消息标（我）')

  // grounding：语义所指=芜湖
  const g = resolveGrounding(win)
  ok(g.semanticTarget === '芜湖', `grounding.semanticTarget='芜湖'（实际 ${g.semanticTarget}）`)
  ok(g.confidence === 0.9, `被回复者优先置信 0.9（实际 ${g.confidence}）`)
  ok(g.quoted?.name === '芜湖' && g.quoted?.text === '帮我把我禁言', '被回复对象+原文正确')
  const allowed = [...g.allowedEntities].sort().join(',')
  ok(allowed === ['林墨', '芜湖', '我'].sort().join(','), `白名单=[林墨,芜湖,我]（实际 ${allowed}）`)
  ok(g.correction === null, '不是纠错场景（无"我说的是X"）')
})

// ═══════════════ S3 旧人物渗入：两小时前的云海不得凭语义混入 ═══════════════
await test('S3 旧人物渗入：云海被白名单校验拦截、印象记忆 recall 过滤', async () => {
  const y0 = mk('y0', YU, '云海', '哈哈今天摸鱼好累', { ts: now - 2 * 3600e3 })
  const w1 = mk('w1', WU, '芜湖', '帮我把我禁言')
  const b1 = self('s3b', '这我哪有权限啊')
  const l1 = mk('l1', LU, '林墨', '权限摆脸上自己不会看？', { replyToId: 'w1' })
  const win = [y0, w1, b1, l1]

  const g = resolveGrounding(win)
  ok(!g.allowedEntities.includes('云海'), `白名单不含云海（${g.allowedEntities.join('、')}）`)
  ok(!g.threadUserIds.includes(YU), `threadUserIds 不含云海（${g.threadUserIds.join(',')}）`)

  // 白名单校验：bot 若在回复里扯出云海 → 越界打回重生成
  const names = windowNames(win)
  ok(names.includes('云海'), `windowNames 含云海（${names.join('、')}）——校验输入正确`)
  const vio = whitelistViolations('云海这权限摆你脸上自己不会看', g, names)
  ok(vio.length === 1 && vio[0] === '云海', `whitelistViolations 查出云海（实际 [${vio.join(',')}]）`)
  ok(whitelistViolations('芜湖你说是不是', g, names).length === 0, '提及白名单内人物不算越界')
  ok(whitelistViolations('关我什么事', g, names).length === 0, '不点名不越界')

  // 记忆库 allowedUsers：印象只允许本轮活跃人物命中
  const TMP = path.join(os.tmpdir(), `amr-hmem-${process.pid}`)
  fs.rmSync(TMP, { recursive: true, force: true })
  const hmem = new HumanizeMemoryStore({ dataDir: TMP, cfg: () => ({}), trace: { record() {} } })
  ok(await hmem.init() === true, 'HumanizeMemoryStore 独立库初始化')
  const t = Date.now()
  await hmem.dao.run(
    'INSERT INTO hm_memories(group_id,user_id,kind,content,keywords,importance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [G, WU, 'impression', '芜湖上次也来问过权限的事', JSON.stringify(['权限']), 0.8, t, t])
  await hmem.dao.run(
    'INSERT INTO hm_memories(group_id,user_id,kind,content,keywords,importance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [G, YU, 'impression', '云海老拿权限开玩笑缠着人', JSON.stringify(['权限']), 0.8, t, t])
  const hit = await hmem.recall({ groupId: G, query: '权限摆脸上', allowedUsers: g.threadUserIds })
  ok(hit.some((r) => String(r.user_id) === WU), `活跃人物（芜湖）印象可命中（命中 ${hit.map((r) => r.user_id).join(',')}）`)
  ok(!hit.some((r) => String(r.user_id) === YU), '非活跃旧人物（云海）印象被 allowedUsers 过滤——旧人物渗入修复生效')
  const noFilter = await hmem.recall({ groupId: G, query: '权限摆脸上' })
  ok(noFilter.some((r) => String(r.user_id) === YU), '对照：不带 allowedUsers 时云海可命中（确认是白名单在起作用）')
})

// ═══════════════ S4 歧义降级：同时提 bot 名+叫别人名 ═══════════════
await test('S4 歧义降级：提 bot 名但同时叫小王 → 45 灰区；纯提 bot 名 → 80', async () => {
  const b1 = self('s4b', '我说两句')
  const wang = mk('wang', WANG, '小王', '我先说我的方案')
  const amb = mk('amb', MU, '阿明', '小汐你觉得呢，还是问小王吧', { mentionsBotName: true })
  const d = evaluate({ messages: [b1, wang, amb], candidates: [amb], presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(d.components.relevance === 45, `歧义降级 relevance=45（实际 ${d.components.relevance}）`)
  ok(d.positiveReasons.includes('mentions_bot_name_ambiguous'), `reason=mentions_bot_name_ambiguous（${d.positiveReasons.join(',')}）`)
  ok(d.forcedCandidate === false, '灰区不是强信号（乘频率倍率）')
  ok(d.shouldPlan === false, `shouldPlan=false（final=${d.finalScore}）——交 Planner 前先降级，不再硬触发`)

  const pure = mk('pure', MU, '阿明', '小汐你觉得呢', { mentionsBotName: true })
  const d2 = evaluate({ messages: [self('s4b2', '我说两句'), pure], candidates: [pure], presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(d2.components.relevance === 80, `对照：纯提 bot 名 relevance=80（实际 ${d2.components.relevance}）`)
  ok(d2.positiveReasons.includes('mentions_bot_name'), `reason=mentions_bot_name（${d2.positiveReasons.join(',')}）`)
  ok(d2.shouldPlan === true, `对照：纯提及正常触发（final=${d2.finalScore}）`)
})

// ═══════════════ S5 纠错："我说的是芜湖" → correction + SelfState 冲销 ═══════════════
await test('S5 纠错：我说的是芜湖 → correction/禁止反击 + applyCorrection 冲销残留', async () => {
  // —— 确定性层：grounding.correction + formatGroundingBlock ——
  const w1 = mk('w5', WU, '芜湖', '帮我把我禁言')
  const b1 = self('s5b', '这个权限的事我刚说过了')
  const l1 = mk('l5', LU, '林墨', '我说的是芜湖 你指桑骂槐给谁看呢', { quotesBot: true, replyToId: 's5b', mentionsBotName: false })
  const g = resolveGrounding([w1, b1, l1])
  ok(g.correction?.correctTarget === '芜湖', `correction.correctTarget='芜湖'（实际 ${g.correction?.correctTarget}）`)
  ok(String(g.correction?.userId) === WU, `correction.userId=芜湖（实际 ${g.correction?.userId}）`)
  const block = formatGroundingBlock(g)
  ok(block.includes('禁止反击'), 'formatGroundingBlock 含"禁止反击"约束')
  ok(block.includes('我说的是芜湖'), '纠错块复述正确对象')

  // —— SelfState：fake provider 规则路径先造 direct_insult 残留 → applyCorrection 冲销 ——
  const TMP = path.join(os.tmpdir(), `amr-ss-${process.pid}`)
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
  const ss = new SelfStateService({
    provider: { chat: async () => ({ content: '{}' }) },
    cfg: () => BASE_CFG, botId: String(BOT), botNames: [BOT_NAME],
    trace: { record() {} }, dataDir: TMP,
  })
  ok(await ss.init() === true, 'SelfStateService 装配（fake provider 规则路径）')
  // 林墨 @bot 辱骂 → direct_insult 事件 + 关系残留（即"bot 认错对象误记仇"的残留现场）
  await ss.onMessage(
    mk('ins5', LU, '林墨', '@bot 你就是个垃圾废物', { atBot: true, segments: [{ type: 'at', qq: String(BOT) }] }),
    { groupId: G, quoteIsBot: false })
  const evBefore = await dao.get("SELECT id,status FROM ss_events WHERE bot_id=? AND group_id=? AND actor_user_id=? AND event_type='direct_insult' ORDER BY id DESC LIMIT 1", [String(BOT), G, LU])
  ok(!!evBefore && evBefore.status === 'active', `已造 direct_insult 残留事件（id=${evBefore?.id}, status=${evBefore?.status}）`)
  const relBefore = await dao.get('SELECT resentment,guardedness FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [String(BOT), G, LU])
  const preR = Number(relBefore?.resentment || 0), preG = Number(relBefore?.guardedness || 0)
  ok(preR > 0 || preG > 0, `残留已形成（resentment=${preR.toFixed(3)}, guardedness=${preG.toFixed(3)}）`)

  // 纠错冲销（对方说"我说的是芜湖" → 撤销对林墨的误判）
  ok(await ss.applyCorrection({ groupId: G, userId: LU }) === true, 'applyCorrection 返回 true')
  const evAfter = await dao.get('SELECT status FROM ss_events WHERE id=?', [evBefore.id])
  ok(evAfter?.status === 'misjudged', `ss_events 标 misjudged（实际 ${evAfter?.status}）`)
  const relAfter = await dao.get('SELECT resentment,guardedness FROM gw_bot_rel WHERE bot_id=? AND group_id=? AND user_id=?', [String(BOT), G, LU])
  const postR = Number(relAfter?.resentment || 0), postG = Number(relAfter?.guardedness || 0)
  ok(postR < preR || preR === 0, `resentment 下降（${preR.toFixed(3)}→${postR.toFixed(3)}）`)
  ok(postG < preG || preG === 0, `guardedness 下降（${preG.toFixed(3)}→${postG.toFixed(3)}）`)
  await ss.resetGroupState(G)
})

// ═══════════════ S6 多人混战：只有真 @bot 的 D 是强信号 ═══════════════
await test('S6 多人混战：A↔B 互聊 + C 纯文本叫 B 名 + D 真 @bot', async () => {
  const AU = '30001', BU = '30002', CU = '30003', DU = '30004'
  const a1 = mk('a6', AU, '阿甲', '今天这游戏更新不行')
  const b1 = mk('b6', BU, '阿波', '还行吧新地图挺好')
  const a2 = mk('a6b', AU, '阿甲', '地图做得再好也卡')
  const b2 = mk('b6b', BU, '阿波', '你显卡该换了')
  const c1 = mk('c6', CU, '路人丙', '阿波你倒是说句话啊')
  const d1 = mk('d6', DU, '大壮', '@小汐 快来评评理', { atBot: true, mentionsBotName: true, segments: atBotSeg })
  const win = [a1, b1, a2, b2, c1, d1]

  const scoreOf = (m) => evaluate({ messages: win, candidates: [m], presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  const dA = scoreOf(a1), dB = scoreOf(b2), dC = scoreOf(c1), dD = scoreOf(d1)
  ok(dA.components.relevance === 0 && dB.components.relevance === 0, `A/B 互聊不触发（rel=${dA.components.relevance}/${dB.components.relevance}）`)
  ok(dC.components.relevance === 0, `C 叫 B 名不触发（rel=${dC.components.relevance}）`)
  ok(dC.components.directionPenalty === 30, `C 有 directionPenalty=30（实际 ${dC.components.directionPenalty}）——纯文本叫人名修复生效`)
  ok(dC.negativeReasons.includes('other_addressee'), `C negativeReasons 含 other_addressee（${dC.negativeReasons.join(',')}）`)
  ok(!dA.negativeReasons.includes('other_addressee') && !dB.negativeReasons.includes('other_addressee'), 'A/B 无指向惩罚')
  ok(dD.components.relevance === 100 && dD.positiveReasons.includes('at_bot'), `只有 D 的 @bot 是强信号（rel=${dD.components.relevance}）`)

  // formatGroupContext：正文 @QQ号 → @人名（bot 的 @ 段数字不会再以裸 QQ 号形式迷惑 LLM）
  const ctx = formatGroupContext([mk('at6', CU, '路人丙', `看看 @${BU} 说的`, {}), b1])
  ok(ctx.includes('@阿波') && !ctx.includes(`@${BU}`), `正文 @QQ号→@人名（${ctx.split('\n')[0]}）`)
})

// ═══════════════ S7 bot↔bot 熔断：botChain 深度 + 真人夹入断链 ═══════════════
await test('S7 bot↔bot 熔断：与已知 bot 交替 4 轮 → botChain>=3；真人夹入 → 0', async () => {
  const knownBots = new Set([LU]) // 林墨是已知 bot 账号
  const loop = []
  for (let i = 0; i < 4; i++) {
    loop.push(self(`s7s${i}`, `我方第${i}轮`))
    loop.push(mk(`s7l${i}`, LU, '林墨', `对方bot第${i}轮`))
  }
  const g = resolveGrounding(loop, { knownBots })
  ok(g.botChain >= 3, `bot↔bot 交替 4 轮无真人 → botChain=${g.botChain} ≥3（触发熔断条件）`)

  // 真人夹入（尾部 / 中部）→ 断链
  const tailHuman = [...loop, mk('s7h', WU, '芜湖', '你们聊你们的')]
  ok(resolveGrounding(tailHuman, { knownBots }).botChain === 0, '真人夹在尾部 → botChain=0（不熔断真人）')
  const midHuman = [loop[0], loop[1], mk('s7h2', MU, '阿明', '插一句'), ...loop.slice(2)]
  // 尾部扫描口径（与 turn-scheduler 熔断一致）：真人夹在中部、其后 bot 又对线 → 尾部链按尾部计（此处=2，<3 不足以熔断）
  ok(resolveGrounding(midHuman, { knownBots }).botChain === loop.length - 2, `真人夹在中部 → 尾部纯bot段仍按尾部计（=${loop.length - 2}，熔断判定只看当前互喷尾巴）`)

  // 未配置 knownBots → 不构成闭环（熔断只限已知 bot 账号）
  ok(resolveGrounding(loop).botChain === 0, '不配置 knownBots → botChain=0（普通群友不算 bot）')

  // turn-scheduler 熔断条件复刻（尾部扫描语义，turn-scheduler.js:117-125 同款循环）：
  // chain>=3 且本批新消息无真人 → 触发 10 分钟熔断
  const chainOfTail = (msgs) => { let c = 0; for (let i = msgs.length - 1; i >= 0; i--) { const m = msgs[i]; if (!m) break; if (m.isSelf || knownBots.has(String(m.userId))) c++; else break } return c }
  const humanNew = (msgs) => msgs.some((m) => !knownBots.has(String(m.userId)) && !m.isSelf)
  ok(chainOfTail(loop) >= 3 && !humanNew(loop), `scheduler 语义：chain=${chainOfTail(loop)} 且无真人新消息 → 会置 botLoopUntil 熔断`)
  ok(chainOfTail(tailHuman) === 0, `scheduler 语义：真人夹入尾部 chain=0（${chainOfTail(tailHuman)}）→ 不熔断`)
})

// ═══════════════ S8 梗黏住回归：马赛克话题不得渗入无关话题 ═══════════════
await test('S8 马赛克黏住：真实记忆→Planner/Replyer 链路不回流 + 复读拦截', async () => {
  const TMP = path.join(os.tmpdir(), `amr-s8-${process.pid}`)
  fs.rmSync(TMP, { recursive: true, force: true })
  const hmem = new HumanizeMemoryStore({ dataDir: TMP, cfg: () => ({}), trace: { record() {} } })
  ok(await hmem.init() === true, 'S8 使用真实 HumanizeMemoryStore/SQLite')
  const t = Date.now()
  const insertJargon = async (content) => hmem.dao.run(
    'INSERT INTO hm_memories(group_id,user_id,kind,content,keywords,importance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [G, null, 'jargon', content, '[]', 0.9, t, t],
  )
  await insertJargon('马赛克=图片被压得完全看不清')
  await insertJargon('咕嘎=群里的奇怪叫声')
  ok(await hmem.markJargonUsed(G, '我刚才又发了马赛克') === 1, '真实发送登记：马赛克进入近期使用冷却')
  const unrelatedDict = await hmem.jargonDict(G, { queryText: 'P40能部署多大向量模型' })
  ok(!unrelatedDict.includes('马赛克'), '无关 P40 目标不注入马赛克词典')
  const directDict = await hmem.jargonDict(G, { queryText: '这个马赛克怎么回事' })
  ok(!directDict.includes('马赛克='), '冷却中的马赛克即使被再次提到也不回流给生成层')
  ok((await hmem.jargonDict(G, { queryText: '咕嘎是什么意思' })).includes('咕嘎='), '对照：未冷却且当前话题命中的梗仍可注入')

  const oldMsg = mk('s8-old', WU, '芜湖', '这张图压成马赛克了')
  const current = mk('s8-new', MU, '阿明', 'P40能部署多大向量模型')
  const snapshot = [oldMsg, current]
  const runtime = { groupId: G, trace: { record() {} } }
  const cfg = () => ({ planner: { maxRounds: 1 }, replyer: { maxChars: 100 } })
  let plannerSystem = ''
  const plannerProvider = {
    chat: async (req) => {
      plannerSystem = String(req.system || '')
      return {
        content: '用户在问硬件部署能力',
        toolCalls: [{ id: 's8p', name: 'human_reply', arguments: { targetMessageId: current.id, replyGuide: '按显存与量化给建议' } }],
        finishReason: 'tool_calls',
      }
    },
  }
  const planner = new HumanizePlanner({
    provider: plannerProvider, cfg,
    getMemories: async (q) => hmem.jargonDict(G, { queryText: q }),
  })
  const action = await planner.decide({ snapshot, decision: { targetMessage: current }, runtime, cfg: cfg() })
  ok(action.type === 'human_reply' && action.targetMessageId === current.id, `真实 Planner 接受当前目标（${action.type}/${action.targetMessageId}）`)
  ok(!plannerSystem.includes('马赛克='), '真实 Planner prompt 不包含冷却中的马赛克词典')

  let replyerSystem = ''
  const makeReplyProvider = (content) => ({
    chat: async (req) => { replyerSystem = String(req.system || ''); return { content, finishReason: 'stop' } },
  })
  const makeReplyer = (recent) => new HumanizeReplyer({
    provider: makeReplyProvider('P40跑量化后的模型比较稳'), cfg,
    getMemoryBlock: async ({ queryText }) => hmem.jargonDict(G, { queryText }),
    getRecentBotTexts: () => recent,
  })
  const good = await makeReplyer(['之前聊P40的时候我说过', 'P40功耗其实还行']).generate({
    action, batch: snapshot, target: current, runtime,
  })
  ok(good.text === 'P40跑量化后的模型比较稳', `真实 Replyer 正常输出无关话题（cancel=${good.cancelReason || 'none'}）`)
  ok(!replyerSystem.includes('马赛克='), '真实 Replyer prompt 不包含冷却中的马赛克词典')

  const repeatReplyer = new HumanizeReplyer({
    provider: makeReplyProvider('这个图又变马赛克了'), cfg,
    getMemoryBlock: async ({ queryText }) => hmem.jargonDict(G, { queryText }),
    getRecentBotTexts: () => ['我发的图怎么成马赛克了', '这个马赛克太糊了'],
  })
  const blocked = await repeatReplyer.generate({ action, batch: snapshot, target: current, runtime })
  ok(blocked.text === '' && blocked.cancelReason === 'meme_repeat', `生产 Replyer 拦截马赛克复读（cancel=${blocked.cancelReason}）`)
})

// ═══════════════ S9 显式 @ 的语义归属（优先级：引用 > 单一@ > 唯一点名 > unknown；歧义不猜） ═══════════════
await test('S9 显式@归属：A @B → semanticTarget=B（含稳定 user id）', async () => {
  const bMsg = mk('p9b', WANG, '小王', '我昨天说的方案你们看了吗')
  const aMsg = mk('p9a', MU, '阿明', '@小王 方案我看了，有个问题', { segments: [{ type: 'at', qq: String(WANG) }] })
  const g = resolveGrounding([bMsg, aMsg])
  ok(g.semanticTarget === '小王', `A 明确 @B → semanticTarget=B（实际 ${g.semanticTarget}）`)
  ok(g.semanticTargetUserId === String(WANG), `内部身份用稳定 user id（实际 ${g.semanticTargetUserId}）`)
  ok(g.confidence === 0.8, `单一明确@ 置信 0.8（实际 ${g.confidence}）`)
  ok(g.semanticAmbiguity == null, '无歧义')
})

await test('S9 引用与@冲突：A 引用 B 同时 @C → 引用优先并记录冲突', async () => {
  const bMsg = mk('p9q', WU, '芜湖', '帮我把我禁言')
  const cMsg = mk('p9c', WANG, '小王', '别禁言，说清楚')
  const aMsg = mk('p9r', LU, '林墨', '@小王 你看芜湖说的这个', { replyToId: 'p9q', segments: [{ type: 'at', qq: String(WANG) }] })
  const g = resolveGrounding([bMsg, cMsg, aMsg])
  ok(g.semanticTarget === '芜湖', `引用对象优先（实际 ${g.semanticTarget}）`)
  ok(g.semanticTargetUserId === String(WU), '引用优先的身份是 B')
  ok(g.semanticAmbiguity?.kind === 'quote_vs_mention', `记录引用/@冲突（实际 ${JSON.stringify(g.semanticAmbiguity?.kind)}）`)
  ok(Array.isArray(g.semanticAmbiguity?.mentions) && g.semanticAmbiguity.mentions.includes(String(WANG)), '冲突记录包含被@的 C')
  ok(g.confidence < 0.9, `冲突时降置信（实际 ${g.confidence}）`)
})

await test('S9 多@：同时 @B @C → 歧义不静默选第一个', async () => {
  const bMsg = mk('p9m1', WU, '芜湖', '我说一个方案')
  const cMsg = mk('p9m2', WANG, '小王', '我说另一个')
  const aMsg = mk('p9m3', MU, '阿明', '@芜湖 @小王 你们俩谁先说', { segments: [{ type: 'at', qq: String(WU) }, { type: 'at', qq: String(WANG) }] })
  const g = resolveGrounding([bMsg, cMsg, aMsg])
  ok(g.semanticTarget == null, `多@输出 unknown（实际 ${g.semanticTarget}），不猜第一个`)
  ok(g.semanticAmbiguity?.kind === 'multi_mention', `歧义状态（实际 ${JSON.stringify(g.semanticAmbiguity?.kind)}）`)
  ok(g.confidence <= 0.4, `歧义低置信（实际 ${g.confidence}）`)
})

await test('S9 提机器人昵称但明确@别人：不误判为在问机器人', async () => {
  const bMsg = mk('p9n1', WANG, '小王', '小汐上次教我的方法我忘了')
  const aMsg = mk('p9n2', MU, '阿明', '小汐说的那个 @小王 还记得吗', { mentionsBotName: true, segments: [{ type: 'at', qq: String(WANG) }] })
  const g = resolveGrounding([bMsg, aMsg])
  ok(g.semanticTarget === '小王' && g.semanticTargetUserId === String(WANG), `语义所指是被@的小王，不是机器人（实际 ${g.semanticTarget}）`)
  ok(g.semanticAmbiguity == null, '正文提昵称+明确@单一他人 → 无歧义')
  // formatGroundingBlock 渲染语义所指与@列表（供 Planner 结合判断）
  const block = formatGroundingBlock(g)
  ok(block.includes('小王') && block.includes('明确@了'), '归属块含被@对象')
})

await test('S9 多正文点名（无@无引用）→ 歧义不选第一个', async () => {
  const bMsg = mk('p9d1', WU, '芜湖', '我在这')
  const cMsg = mk('p9d2', WANG, '小王', '我也在')
  const aMsg = mk('p9d3', MU, '阿明', '芜湖和小王你们打住')
  const g = resolveGrounding([bMsg, cMsg, aMsg])
  ok(g.semanticTarget == null && g.semanticAmbiguity?.kind === 'multi_named', `多点名 → unknown+歧义（实际 ${g.semanticTarget}/${JSON.stringify(g.semanticAmbiguity?.kind)}）`)
})

// ═══════════════ 汇总 ═══════════════
console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
if (bugs.length) { console.log('失败明细:'); for (const b of bugs) console.log(' -', b) }
console.log('========================================')
if (failed) process.exitCode = 1
