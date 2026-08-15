/**
 * humanize 离线自检（指南 §19 测试计划）。
 * 覆盖：normalizer / buffer / store / scorer / backoff / action-tools / behavior-policy /
 *   memory-adapter / prompts / reply-composer / trace。
 * 运行：node model/humanize/test.mjs
 */
import { memoryKv } from '../agent/store/kv.js'
import {
  normalizeYunzaiEvent, normalizeReplySource, isSelfEvent, collectSelfIds, fingerprintId, textMentionsName, segmentsToText,
} from './message-normalizer.js'
import { MessageBuffer } from './message-buffer.js'
import { HumanizeStore, newHolderId } from './store.js'
import { evaluate, pressureScore, presencePenalty, cooldownPenalty } from './necessity-scorer.js'
import { IdleBackoff } from './idle-backoff.js'
import { validateActionCall, pickSingleAction, ACTION_TOOLS } from './action-tools.js'
import { resolveBehaviorPolicy, topicMatchScore, withinReplyRate } from './behavior-policy.js'
import { MemoryAdapter } from './memory-adapter.js'
import { fillTemplate, buildPlannerSystem, buildReplyerSystem, formatGroupContext, highlightTarget, buildHumanizePersonaBlock } from './prompts.js'
import { splitSegments, typingDelayMs, protect, restore } from './reply-composer.js'
import { Trace, redactForLog } from './trace.js'
import { validateHumanizeConfig, resolveHumanizeConfig, DEFAULT_HUMANIZE_CONFIG } from './default-config.js'
import { DEFAULT_HUMANIZE_PERSONA } from './default-persona.js'
import { resolveGrounding } from './grounding.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

// ───────── normalizer ─────────
await test('normalizer：self/@/引用/命令/图片/缺 id 指纹', async () => {
  const e1 = { user_id: 100, sender: { card: '小明' }, group_id: 999, message_id: 'm1', time: 1700000000, msg: '你好', message: [{ type: 'text', text: '你好' }] }
  const m1 = normalizeYunzaiEvent(e1, { selfIds: ['99999'], botNames: [], isCommand: () => false })
  ok(m1.id === 'm1' && m1.groupId === '999' && m1.displayName === '小明' && !m1.isSelf && !m1.atBot, '基础归一化')

  const e2 = { ...e1, user_id: 99999, sender: { user_id: 99999, nickname: 'bot' }, message_id: 'm2', msg: '思考中' }
  const m2 = normalizeYunzaiEvent(e2, { selfIds: ['99999'], botNames: [], isCommand: () => false })
  ok(m2.isSelf === true, 'self 判定（防环）')

  const e3 = { ...e1, message_id: 'm3', atBot: true, msg: '@bot 在吗' }
  const m3 = normalizeYunzaiEvent(e3, { selfIds: ['99999'], botNames: ['bot'], isCommand: () => false })
  ok(m3.atBot === true, '@机器人')

  const e4 = { ...e1, message_id: 'm4', msg: 'bot 帮个忙', reply_id: 'm_prev' }
  const m4 = normalizeYunzaiEvent(e4, { selfIds: ['99999'], botNames: ['bot'], isCommand: () => false })
  ok(m4.mentionsBotName === true && m4.replyToId === 'm_prev', '提及昵称 + 引用 id')

  const e5 = { ...e1, message_id: 'm5', msg: '#ai 帮我' }
  const m5 = normalizeYunzaiEvent(e5, { selfIds: ['99999'], isCommand: (t) => t.startsWith('#') })
  ok(m5.isCommand === true, '命令判定')

  const e6 = { ...e1, message_id: null, msg: '无id消息', message: [{ type: 'image', url: 'u1' }, { type: 'text', text: '无id消息' }] }
  const m6 = normalizeYunzaiEvent(e6, { selfIds: ['99999'], isCommand: () => false })
  ok(m6.id.startsWith('fp_'), '缺 message_id → 指纹 fp_')
  ok(m6.media.length === 1 && m6.media[0].kind === 'image', '媒体提取')
})

await test('normalizer：提及昵称边界匹配（避免子串误判）', async () => {
  ok(textMentionsName('我发了个EMAIL', ['AI']) === false, 'AI 不命中 EMAIL')
  ok(textMentionsName('问问AI看', ['AI']) === true, 'AI 边界命中')
  ok(textMentionsName('小猫在吗', ['小猫']) === true, '中文昵称 includes 命中')
  ok(textMentionsName('啊', ['啊']) === false, '单字昵称不参与（误判率高）')
  ok(isSelfEvent({ user_id: '123' }, ['123']) === true, 'isSelfEvent 字符串匹配')
  ok(Array.isArray(collectSelfIds({ self_id: 1 })), 'collectSelfIds 返回数组')
  ok(fingerprintId({ text: 'x' }).startsWith('fp_'), 'fingerprintId 前缀')
})

await test('跨窗口引用：get_msg 快照参与归属、prompt 与追问判定，但不伪造新消息', async () => {
  const source = normalizeReplySource({
    data: {
      message_id: 'old_w', user_id: 'uW', sender: { nickname: '芜湖' },
      message: [{ type: 'text', data: { text: '帮我把我禁言' } }],
    },
  }, { selfIds: ['bot'] })
  ok(source?.id === 'old_w' && source?.displayName === '芜湖' && source?.text === '帮我把我禁言', 'OneBot 嵌套段压成轻量引用快照')

  const bot = mkMsg('这我哪有权限啊', true, { userId: 'bot' }, 'self_old')
  const reply = mkMsg('权限摆脸上自己不会看？', false, {
    userId: 'uL', replyToId: 'old_w', replySource: source,
  }, 'new_l', '林墨')
  const grounding = resolveGrounding([bot, reply])
  ok(grounding?.semanticTarget === '芜湖' && grounding?.quoted?.text === '帮我把我禁言', '窗口外被回复者与原文进入 grounding')
  ok(grounding?.threadUserIds.includes('uW'), '被回复者进入记忆作用域')
  const ctx = formatGroupContext([bot, reply])
  ok(ctx.includes('↩回复芜湖(帮我把我禁言)'), 'prompt 渲染窗口外回复关系与原文')

  const decision = evaluate({
    messages: [bot, reply], candidates: [reply], pendingCount: 1, presence: {},
    cfg: { threshold: 80, talkValue: 0.35 },
  })
  ok(!decision.positiveReasons.includes('followup_to_bot'), '虽紧跟 bot 发言，引用窗口外真人时不误判为追问 bot')
})

// ───────── buffer ─────────
await test('buffer：容量/去重/批次游标/presence', async () => {
  const buf = new MessageBuffer({ capacity: 5, ttlMs: 60 * 60 * 1000 })
  for (let i = 0; i < 7; i++) buf.append({ id: `k${i}`, groupId: 'g', userId: `u${i}`, text: `t${i}`, timestamp: Date.now() + i, segments: [], isSelf: false })
  ok(buf.size === 5, '容量淘汰到 5')
  ok(buf.has('k6') && !buf.has('k0'), '淘汰最旧 k0')
  ok(buf.append({ id: 'k6' }) === buf.get('k6').seq, '同 id 去重返回原 seq')
  const after = buf.snapshotAfter(buf.get('k3').seq)
  ok(after.length === 3 && after[0].id === 'k4', 'snapshotAfter 批次游标')
  buf.append({ id: 'self1', groupId: 'g', userId: 'bot', text: '我说', timestamp: Date.now(), segments: [], isSelf: true })
  const ps = buf.presenceStats(60 * 60 * 1000)
  ok(ps.bot === 1 && ps.other >= 3, 'presence 统计 bot/other')
})

// ───────── store（锁互斥/过期/sent） ─────────
await test('store：reply-lock 互斥 + holder 安全释放 + sent', async () => {
  const kv = memoryKv()
  const s = new HumanizeStore({ kv })
  const holder = newHolderId()
  ok(await s.acquireReplyLock('g', 'b1', holder) === true, '首次获取锁')
  ok(await s.acquireReplyLock('g', 'b1', 'other') === false, '他人被互斥')
  await s.releaseReplyLock('g', 'b1', holder)
  ok(await s.acquireReplyLock('g', 'b1', 'other') === true, '释放后他人可取')
  await s.releaseReplyLock('g', 'b1', 'other')
  // direct-handled / sent
  await s.markDirectHandled('g', 'mx')
  ok(await s.isDirectHandled('g', 'mx') === true, 'direct-handled 标记')
  await s.markSent('g', 'fp_123')
  ok(await s.isSent('g', 'fp_123') === true, 'sent 标记')
})

// ───────── scorer ─────────
await test('scorer：pressure / presence / cooldown 公式', async () => {
  ok(pressureScore(0, 9) === 0, 'pressure 0')
  ok(pressureScore(9, 9) >= 24 && pressureScore(9, 9) <= 25, 'pressure 达门槛≈25')
  ok(pressureScore(20, 9) > pressureScore(9, 9), 'pressure overflow 更高')
  ok(presencePenalty(0, 10) === 0, 'presence 低占比无惩罚')
  ok(presencePenalty(6, 10) === 25, 'presence 60% 满罚 25')
  ok(presencePenalty(3, 10) > 0 && presencePenalty(3, 10) < 25, 'presence 30% 中等惩罚')
  ok(cooldownPenalty(Date.now() + 30000) > 30, 'cooldown 剩余 30s 惩罚>30')
  ok(cooldownPenalty(Date.now()) === 0, 'cooldown 已过 0')
})

await test('scorer：强信号不乘频率倍率 + 沉默消息不触发', async () => {
  // 纯普通闲聊（无关联）+ 少量消息 → 不应触发
  const dec1 = evaluate({ messages: [mkMsg('今天天气不错', false)], presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(dec1.finalScore < 80 && !dec1.shouldPlan, '普通无关消息不触发')
  // 提及机器人（强信号 relevance=80）+ 疑问句 → 强制候选不乘倍率
  const dec2 = evaluate({ messages: [mkMsg('小猫你觉得怎么样？', false, { mentionsBotName: true })], presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(dec2.forcedCandidate === true && dec2.shouldPlan === true, '提及昵称+疑问 强信号触发')
  ok(dec2.finalScore >= 80, '强信号分数达阈值')
  // 在场惩罚降低分数
  const dec3 = evaluate({ messages: [mkMsg('小猫你觉得怎么样？', false, { mentionsBotName: true })], presence: { bot: 6, other: 4, total: 10 }, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(dec3.finalScore < dec2.finalScore, '在场惩罚降低分数')
  // 极短反应 -25
  const dec4 = evaluate({ messages: [mkMsg('哈哈', false)], presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(dec4.components.content === -25, '极短反应 -25')
})

await test('scorer：quotesBot 强信号 + 空批次', async () => {
  const dec = evaluate({ messages: [mkMsg('接得好', false, { quotesBot: true })], presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(dec.forcedCandidate && dec.shouldPlan, 'quotesBot(+90) 强信号触发')
  const empty = evaluate({ messages: [], presence: {}, cfg: {} })
  ok(empty.finalScore === 0 && !empty.shouldPlan, '空批次不触发')
})

await test('scorer：followup_to_bot 需窗口含 self（修复死代码）+ pressure 走 pendingCount', async () => {
  const bot = mkMsg('我说了个梗', true, { seq: 1 }, 'b1')
  const q = mkMsg('那具体怎么操作？', false, { seq: 2 }, 'q1')
  // 窗口含 bot 自己的话 → 能识别 q 是接着 bot 的追问（旧版传 external 切片→self 被滤→死代码）
  const d1 = evaluate({ messages: [bot, q], candidates: [q], pendingCount: 1, presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(d1.components.relevance === 55 && d1.positiveReasons.includes('followup_to_bot'), '窗口含 self → followup_to_bot(+55) 触发')
  ok(d1.targetMessage?.id === 'q1', '目标选为追问消息')
  // 窗口不含 self → followup_to_bot 不触发（回归保护）
  const d2 = evaluate({ messages: [q], candidates: [q], pendingCount: 1, presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(d2.components.relevance === 0 && !d2.positiveReasons.includes('followup_to_bot'), '窗口无 self → 不触发（保护回归）')
  // pressure 用 pendingCount（本批条数），不被 rolling window 长度放大
  const pendingThreshold = Math.ceil(1 / (0.35 * 0.35))
  ok(d1.components.pressure === pressureScore(1, pendingThreshold), 'pressure 走 pendingCount=1，非窗口长度')
  const d3 = evaluate({ messages: [bot, q], candidates: [q], pendingCount: 8, presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(d3.components.pressure === pressureScore(8, pendingThreshold) && d3.bypassBackoff === true, 'pendingCount=8 → 压力升高 + 绕过退避')
})

await test('scorer：bot 焦点信号（近窗 @/引用/提及/自言 → ambient 也给 +30）', async () => {
  // 近窗有人 @bot → ambient 后续消息拿到 focusBonus
  const atMe = mkMsg('@bot 在吗', false, { atBot: true }, 'a1')
  const amb = mkMsg('那具体咋弄', false, {}, 'a2')
  const dFocus = evaluate({ messages: [atMe, amb], candidates: [amb], pendingCount: 1, presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(dFocus.components.focusBonus === 30 && dFocus.positiveReasons.includes('bot_focus'), '近窗 @bot → ambient 目标得 bot_focus +30')
  // bot 刚发过言（isSelf 在最近 3 条）→ 也算焦点
  const self = mkMsg('我说了个梗', true, { seq: 1 }, 's1')
  const amb2 = mkMsg('然后呢', false, {}, 'a3')
  const dSelf = evaluate({ messages: [self, amb2], candidates: [amb2], pendingCount: 1, presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(dSelf.components.focusBonus === 30, 'bot 最近发过言 → 也触发 bot_focus')
  // 既无 @/引用/提及，bot 也没最近发言 → 不给 focus
  const idle1 = mkMsg('今天天气不错', false, {}, 'i1'), idle2 = mkMsg('呵呵', false, {}, 'i2')
  const dIdle = evaluate({ messages: [idle1, idle2], candidates: [idle2], pendingCount: 1, presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(dIdle.components.focusBonus === 0 && !dIdle.positiveReasons.includes('bot_focus'), '无关闲聊 → 无 focus')
  // 强信号目标(relevance>=55)不叠加 focus（避免重复）
  const q = mkMsg('接得好', false, { quotesBot: true }, 'q1')
  const dStrong = evaluate({ messages: [q], candidates: [q], pendingCount: 1, presence: {}, cfg: { threshold: 80, talkValue: 0.35 } })
  ok(dStrong.components.focusBonus === 0, '强信号目标不再叠加 focusBonus')
})

// ───────── backoff ─────────
await test('backoff：序列 0,15,30,60,120,240… + 绕过 + 清零', async () => {
  const b = new IdleBackoff({ baseSeconds: 15, capSeconds: 300, startCount: 2, bypassPendingCount: 6 })
  ok(b.recordNoAction(1000) === 0, '第1次不退避')
  ok(b.recordNoAction(1000) === 15, '第2次 15s')
  ok(b.recordNoAction(1000) === 30, '第3次 30s')
  ok(b.recordNoAction(1000) === 60, '第4次 60s')
  ok(b.recordNoAction(1000) === 120, '第5次 120s')
  ok(b.recordNoAction(1000) === 240, '第6次 240s')
  ok(b.recordNoAction(1000) === 300, '第7次 cap 300s')
  ok(b.shouldDelay({ pendingCount: 8, forcedCandidate: false, isGroup: true }) === false, '批量消息绕过')
  ok(b.shouldDelay({ pendingCount: 1, forcedCandidate: true, isGroup: true }) === false, '强信号绕过并 reset')
  b.recordSuccess()
  ok(b.count === 0, '成功清零')
})

await test('backoff：ambient 必须用 falsy forcedCandidate（否则击穿退避）', async () => {
  const b = new IdleBackoff({ baseSeconds: 15, capSeconds: 300, startCount: 2, bypassPendingCount: 6 })
  const t = 1_000_000
  b.recordNoAction(t); b.recordNoAction(t) // count=2，_until=t+15s，进入退避
  // ambient 用 forcedCandidate:false → 受退避约束（被延迟）
  ok(b.shouldDelay({ pendingCount: 1, forcedCandidate: false, isGroup: true, now: t + 1000 }) === true, 'ambient(false) 在退避期 → 延迟')
  ok(b.count === 2, 'falsy forcedCandidate 不 reset 退避计数')
  // 真值 forcedCandidate（旧 bug 用的 'ambient'）→ reset 并放行
  ok(b.shouldDelay({ pendingCount: 1, forcedCandidate: 'ambient', isGroup: true, now: t + 2000 }) === false, '真值 forcedCandidate 仍放行')
  ok(b.count === 0, '真值 forcedCandidate reset 计数 → 故 ambient 必须用 false')
})

// ───────── action-tools ─────────
await test('action-tools：校验 + 多动作只取一个', async () => {
  const buf = ['t1', 't2']
  const hasTarget = (id) => buf.includes(id)
  ok(ACTION_TOOLS.length === 4, '4 个动作工具')
  const r1 = validateActionCall({ name: 'human_reply', id: 'a', arguments: { targetMessageId: 't1', replyGuide: '答复' } }, { hasTarget })
  ok(r1.ok && r1.action.type === 'human_reply' && r1.action.targetMessageId === 't1', 'human_reply 合法')
  const r2 = validateActionCall({ name: 'human_reply', id: 'a', arguments: { targetMessageId: 'nope', replyGuide: 'x' } }, { hasTarget })
  ok(!r2.ok, '非法目标拒绝')
  const r3 = validateActionCall({ name: 'human_wait', id: 'a', arguments: { seconds: 999, reason: '等' } })
  ok(r3.ok && r3.action.seconds === 120, 'wait seconds 钳到 120')
  // 多发送动作：取最高优先级 reply
  const { action, violations } = pickSingleAction([
    { name: 'human_ignore', id: '1', arguments: { reason: 'r' } },
    { name: 'human_reply', id: '2', arguments: { targetMessageId: 't1', replyGuide: 'g' } },
    { name: 'human_react', id: '3', arguments: { targetMessageId: 't2', intent: '赞' } },
  ], { hasTarget })
  ok(action.type === 'human_reply', '多发送动作取 reply')
  ok(violations.includes('multi_send_drop:human_react'), '多余的 react 记 violation')
})

// ───────── behavior-policy ─────────
await test('behavior-policy：主题打分 + 频率上限', async () => {
  const p = resolveBehaviorPolicy({ topics: ['游戏', 'AI'], maxRepliesPer10Minutes: 3 })
  ok(topicMatchScore('聊聊游戏和AI', p.topics) === 18, '2 主题命中 +18')
  ok(topicMatchScore('聊聊游戏', p.topics) === 10, '1 主题命中 +10')
  const w = withinReplyRate([Date.now(), Date.now(), Date.now()], 3)
  ok(w.within === false, '已达上限 3 不再允许')
})

// ───────── memory-adapter（隐私边界） ─────────
await test('memory-adapter：private scope 抛错 + group_public 可读', async () => {
  const mem = new MemoryAdapter({ recall: null, kv: memoryKv() })
  let threw = false
  try { mem.assertPublicScope('user_private') } catch { threw = true }
  ok(threw === true, 'user_private scope 抛隐私边界错误')
  ok(mem.assertPublicScope('group_public') === true, 'group_public 允许')
  ok((await mem.retrieveGroupPublic('g', 'q')).length === 0, '无 recall 时返回空（不抛）')
})

// ───────── prompts ─────────
await test('prompts：槽位替换 + Planner 含红线、无任务措辞', async () => {
  ok(fillTemplate('a {{x}} b', { x: 'Y' }) === 'a Y b', 'fillTemplate 替换')
  const sys = buildPlannerSystem({ personaName: '小猫', necessityDecision: null, groupContext: '甲: hi [m1]', publicMemories: '' })
  ok(sys.includes('你不是「小猫」本人') && sys.includes('human_reply'), 'Planner 含红线 + 工具')
  ok(!/始终完成|失败后继续/.test(sys), 'Planner 无任务 Agent 措辞')
  const rsys = buildReplyerSystem({ replyGuide: '赞同', recentMessages: '甲: hi' })
  ok(rsys.includes('只输出消息正文'), 'Replyer 含只输出正文约束')
  const ctx = formatGroupContext([mkMsg('hi', false, {}, 'm1', '甲')])
  ok(ctx.includes('甲') && ctx.includes('[m1]'), 'formatGroupContext 含 id')
})

await test('prompts：formatGroupContext 渲染对话关系（@我/引用我/回复某人/self/时间）', async () => {
  const lines = formatGroupContext([
    mkMsg('在吗', false, { atBot: true }, 'm1', '甲'),
    mkMsg('接得好', false, { quotesBot: true }, 'm2', '乙'),
    mkMsg('也说一句', false, { replyToId: 'm9' }, 'm3', '丙'),
    mkMsg('我刚说的', true, {}, 'm4'),
  ])
  ok(lines.includes('@我'), '@bot 标注')
  ok(lines.includes('引用我'), 'quotesBot 标注')
  ok(lines.includes('↩回复(不在近窗)'), 'replyToId 标注（窗口外明示；窗口内升级为 ↩回复<人名>，见对话关系消歧测试）')
  ok(lines.includes('（我）'), 'self 标注')
  // highlightTarget 关系提示
  const ht = highlightTarget(mkMsg('在吗', false, { atBot: true, id: 'm1' }, 'm1', '甲'))
  ok(ht.includes('@我') && ht.includes('m1'), 'highlightTarget 含关系 + id')
})

// ───────── batch2: normalizer / URL / avoidTopics ─────────
await test('normalizer：segmentsToText 补全 forward/json/poke/location 等（不再隐形）', async () => {
  ok(segmentsToText([{ type: 'forward' }, { type: 'text', text: '看' }, { type: 'json', title: '小程序' }, { type: 'poke' }, { type: 'location' }]) === '[合并转发]看[卡片:小程序][戳一戳][位置]', 'forward/json/poke/location 有占位')
  ok(segmentsToText([{ type: 'reply', id: '1' }, { type: 'text', text: 'hi' }]) === 'hi', 'reply 不占位（由 replyToId 表达）')
  ok(segmentsToText([{ type: 'xml' }, { type: 'mystery' }]) === '[卡片][mystery]', 'xml + 未知类型兜底占位')
})

await test('reply-composer：URL 不吞中文标点（，。！ 等）', async () => {
  const { masked, tokens } = protect('看 https://x.com，超好笑')
  ok(restore(masked, tokens) === '看 https://x.com，超好笑', 'URL+中文标点 完整还原')
  const urls = [...tokens.values()]
  ok(urls[0] === 'https://x.com', 'URL 在中文逗号前截断（不吃" ，超好笑"）')
})

await test('scorer：avoidTopics 命中给负分 + reason', async () => {
  const msg = mkMsg('聊聊政治吧', false, {}, 'p1')
  const base = evaluate({ messages: [msg], candidates: [msg], pendingCount: 1, presence: {}, cfg: { threshold: 80, talkValue: 0.35, avoidPenalty: 0 } })
  const avd = evaluate({ messages: [msg], candidates: [msg], pendingCount: 1, presence: {}, cfg: { threshold: 80, talkValue: 0.35, avoidPenalty: 25 } })
  ok(avd.rawScore === base.rawScore - 25, 'avoidPenalty -25 进 rawScore')
  ok(avd.negativeReasons.includes('avoid_topic'), '记 avoid_topic 负向原因')
})

// ───────── persona block（MaiBot 式人设）─────────
await test('persona：buildHumanizePersonaBlock + Planner 注入 + 空回落', async () => {
  ok(buildHumanizePersonaBlock({ prompt: '' }) === '', '空 prompt 返回空串（调用方回落旧来源）')
  ok(buildHumanizePersonaBlock() === '', '无参返回空串')
  const blk = buildHumanizePersonaBlock({ name: '小汐', prompt: '你是小汐，爱接梗。【语气】轻松口语。' })
  ok(blk.includes('小汐') && blk.includes('角色人设'), '人设块含角色名 + 标题')
  ok(blk.includes('底线'), '人设块含事实准确红线')
  // Planner system 注入 personaBlock
  const sys = buildPlannerSystem({ personaName: '小汐', personaBlock: blk, groupContext: '甲: hi' })
  ok(sys.includes('角色人设') && sys.includes('轻松口语'), 'Planner system 含人设块')
  // 未注入时不残留空行异常（"角色人设"字样会出现在原则里，但人设块标题不应出现）
  const sys2 = buildPlannerSystem({ personaName: '机器人', groupContext: '甲: hi' })
  ok(sys2.includes('行为政策') && !sys2.includes('角色人设参考'), '无人设时 Planner 正常、不含人设块')
})

await test('persona：内置默认人设（去 AI 味、尊重看人、非空可渲染）', async () => {
  ok(typeof DEFAULT_HUMANIZE_PERSONA.prompt === 'string' && DEFAULT_HUMANIZE_PERSONA.prompt.length > 200, '默认人设非空且有实质内容')
  // 核心主张：尊重是看人的（不是“尊重每个用户”这类 AI 味措辞）
  ok(/看人下菜|态度跟关系走|没有“尊重每个人”/.test(DEFAULT_HUMANIZE_PERSONA.prompt), '默认人设强调态度因人而异（非无差别尊重）')
  ok(!/尊重每一位用户|尊重所有用户|礼貌对待每一个人/.test(DEFAULT_HUMANIZE_PERSONA.prompt), '不含“尊重每个用户”式 AI 味套话')
  // 防 AI 味红线在
  ok(DEFAULT_HUMANIZE_PERSONA.prompt.includes('很高兴帮你') || DEFAULT_HUMANIZE_PERSONA.prompt.includes('客服'), '默认人设含防 AI 味红线')
  // 渲染成块可用
  const blk = buildHumanizePersonaBlock({ name: DEFAULT_HUMANIZE_PERSONA.name, prompt: DEFAULT_HUMANIZE_PERSONA.prompt })
  ok(blk.includes('角色人设') && blk.includes('看人下菜'), '默认人设可正确渲染为 Planner/Replyer 注入块')
})

// ───────── reply-composer ─────────
await test('reply-composer：splitSegments 不拆 URL/代码 + 上限 + typingDelay', async () => {
  const segs = splitSegments('第一句。第二句见 https://example.com/a/b 吧。第三句。', { maxBubbles: 3 })
  ok(segs.length <= 3, '不超过 maxBubbles')
  ok(segs.some((s) => s.includes('https://example.com/a/b')), 'URL 完整保留不被切断')
  const code = splitSegments('看这段 `for (let i=0;i<10;i++)` 然后说。', { maxBubbles: 2 })
  ok(code.some((s) => s.includes('for (let i=0;i<10;i++)')), '代码块不被切断')
  const d = typingDelayMs('一句话测试', { typingSpeed: 1, minDelayMs: 0, maxDelayMs: 5000 })
  ok(d > 0 && d <= 5000, 'typingDelay 正数且受限')
  // protect/restore 往返
  const { masked, tokens } = protect('x https://a.com y')
  ok(restore(masked, tokens) === 'x https://a.com y', 'protect/restore 往返')
})

// ───────── trace（脱敏） ─────────
await test('trace：记录/最近/脱敏（不含密钥）', async () => {
  const t = new Trace({ limit: 5 })
  const id = t.newTurnId()
  ok(id.startsWith('ht_'), 'turnId 前缀')
  t.record('gate_decision', { turnId: id, finalScore: 90, apiKey: 'sk-abcdefghijklxxxxx' })
  const rec = t.recent({ limit: 1 })[0]
  ok(rec.finalScore === 90, '记录可读')
  ok(!JSON.stringify(rec).includes('sk-abcdefghijkl'), 'apiKey 被脱敏')
  ok(redactForLog('sk-abcdefghijklmnopqrstuvwxyz').includes('[REDACTED]'), 'redactForLog 屏蔽 sk-')
})

// ───────── config（校验硬约束） ─────────
await test('config：enable&空群不开 + 危险工具剔除 + privateMemory 强制 false', async () => {
  const r = validateHumanizeConfig({ enable: true, groups: [], planner: { allowedReadTools: ['terminal', 'web_search'] }, safety: { privateMemoryInGroup: true }, reply: { typos: true } }, new Set(['web_search']))
  ok(r.config.enable === false, 'enable&空群 → 不开启')
  ok(r.config.safety.privateMemoryInGroup === false, 'privateMemory 强制 false')
  ok(r.config.reply.typos === false, 'typos 强制 false')
  ok(!r.config.planner.allowedReadTools.includes('terminal'), 'terminal 被剔除')
  ok(r.config.planner.allowedReadTools.includes('web_search'), 'web_search 保留')
  // resolve 合并
  const resolved = resolveHumanizeConfig(DEFAULT_HUMANIZE_CONFIG)
  ok(resolved.threshold === 80 && resolved.behaviorPolicy.initiative === 0.35, 'resolve 默认值')
})

await test('config：persona 块结构 + prompt 超长裁剪', async () => {
  ok(DEFAULT_HUMANIZE_CONFIG.persona && DEFAULT_HUMANIZE_CONFIG.persona.prompt === '', '默认 persona 块存在且 prompt 空')
  const r = validateHumanizeConfig({ persona: { name: '小汐', prompt: 'p'.repeat(5000), fromPersonaId: 'raiden-ei' } })
  ok(r.config.persona.name === '小汐', 'persona.name 保留')
  ok(r.config.persona.fromPersonaId === 'raiden-ei', 'persona.fromPersonaId 保留')
  ok(r.config.persona.prompt.length === 4000, 'persona.prompt 裁剪到 4000')
  ok(r.errors.some((e) => e.includes('裁剪')), '超长裁剪记 error')
  // 缺 persona 字段时归一为对象（防 v-model/解析报错）
  const r2 = validateHumanizeConfig({})
  ok(r2.config.persona && typeof r2.config.persona === 'object', '无 persona 时归一为对象')
})

// ───────── 对话关系消歧（A说B不再误判为说bot；MaiBot关系链+三处升级）─────────
await test('对话关系：A 回复 B（非bot）时不误判为对 bot 的追问', async () => {
  const { evaluate } = await import('./necessity-scorer.js')
  // 场景：bot 发言 → B 发言 → A 回复 B 的消息（疑问句）——旧逻辑 followup +55 误触发
  const bot = mkMsg('我刚才说完了', true, {}, 'b1')
  const b = mkMsg('这游戏太难了', false, { userId: 'uB' }, 'mB', '小王')
  const a = mkMsg('小王你怎么不早点说？', false, { userId: 'uA', replyToId: 'mB' }, 'mA', '阿三')
  const r = evaluate({ messages: [bot, b, a], candidates: [a], presence: { bot: 1, other: 2 }, cfg: { threshold: 25, talkValue: 0.35 } })
  ok(r.components.relevance < 55, `A 回复 B：不再触发 followup_to_bot（relevance=${r.components.relevance}）`)
  ok(!r.positiveReasons.includes('followup_to_bot'), 'followup 原因不出现')
  // 对照：A 无回复目标、紧跟 bot 的疑问句 → followup 仍生效（不误伤正常追问）
  const a2 = mkMsg('那要怎么办？', false, { userId: 'uA' }, 'mA2', '阿三')
  const r2 = evaluate({ messages: [bot, a2], candidates: [a2], presence: { bot: 1, other: 1 }, cfg: { threshold: 25, talkValue: 0.35 } })
  ok(r2.positiveReasons.includes('followup_to_bot'), '正常追问 bot 仍触发 followup')
})

await test('对话关系：提及 bot 名但同时叫别人 → 歧义降级；纯文本叫人名 → 方向惩罚', async () => {
  const { evaluate } = await import('./necessity-scorer.js')
  const bot = mkMsg('我在', true, {}, 'b1')
  const b = mkMsg('嗯嗯', false, { userId: 'uB' }, 'mB', '小王')
  // A 一句话里既有 bot 名又叫了小王 → 80 降 45（灰区交 Planner）
  const a = mkMsg('小汐你觉得呢，还是问小王吧', false, { userId: 'uA', mentionsBotName: true }, 'mA', '阿三')
  const r = evaluate({ messages: [bot, b, a], candidates: [a], presence: { bot: 1, other: 2 }, cfg: { threshold: 25, talkValue: 0.35 } })
  ok(r.components.relevance === 45, `昵称歧义降级（relevance=${r.components.relevance}，期望 45）`)
  ok(r.positiveReasons.includes('mentions_bot_name_ambiguous'), '原因标记为歧义')
  // 对照：只提 bot 名、无他人指向 → 80 不降
  const a2 = mkMsg('小汐你觉得呢', false, { userId: 'uA', mentionsBotName: true }, 'mA2', '阿三')
  const r2 = evaluate({ messages: [bot, a2], candidates: [a2], presence: { bot: 1, other: 1 }, cfg: { threshold: 25, talkValue: 0.35 } })
  ok(r2.components.relevance === 80, `纯提及 bot 名不降级（relevance=${r2.components.relevance}）`)
  // 纯文本叫他人名（不@）→ directionPenalty 生效
  const a3 = mkMsg('小王你说句话啊', false, { userId: 'uA' }, 'mA3', '阿三')
  const r3 = evaluate({ messages: [bot, b, a3], candidates: [a3], presence: { bot: 1, other: 2 }, cfg: { threshold: 25, talkValue: 0.35 } })
  ok(r3.negativeReasons.includes('other_addressee'), '纯文本叫人名进方向惩罚')
})

await test('对话关系：上下文标注解析到人名（↩回复小王 / @小王 / ↩回复我）', async () => {
  const bot = mkMsg('我发过言', true, { userId: '999' }, 'b1')
  const b = mkMsg('有人问我问题', false, { userId: 'uB' }, 'mB', '小王')
  const a = mkMsg('@123456 你看看这个？', false, { userId: 'uA', replyToId: 'mB', segments: [{ type: 'at', qq: '123456' }, { type: 'text', text: ' 你看看这个？' }] }, 'mA', '阿三')
  const c = mkMsg('收到', false, { userId: '123456' }, 'mC', '老六')
  const ctx = formatGroupContext([bot, b, a, c])
  ok(ctx.includes('↩回复小王'), `回复标注带人名（含 ↩回复小王）`)
  ok(ctx.includes('@老六'), `@QQ号 解析为人名（@老六）`)
  const a2 = mkMsg('原来是这样', false, { userId: 'uA', replyToId: 'b1', quotesBot: true }, 'mA2', '阿三')
  const ctx2 = formatGroupContext([bot, a2])
  ok(ctx2.includes('↩引用我'), '回复 bot 消息仍标 ↩引用我')
  // 窗口外回复目标明示
  const a3 = mkMsg('嗯？', false, { userId: 'uA', replyToId: 'gone' }, 'mA3', '阿三')
  const ctx3 = formatGroupContext([a3])
  ok(ctx3.includes('↩回复(不在近窗)'), '窗口外回复目标明示不在近窗')
})

await test('对话关系：引用原文注入（指代消解）', async () => {
  const w = mkMsg('帮我把我禁言', false, { userId: 'uW' }, 'mW', '芜湖')
  const linmo = mkMsg('你搁这儿测试bot呢 权限摆脸上自己不会看', false, { userId: 'uL', replyToId: 'mW' }, 'mL', '林墨')
  const ctx = formatGroupContext([w, linmo])
  ok(ctx.includes('↩回复芜湖(帮我把我禁言)'), `回复标注带被引原文（${ctx.split('\n')[1]}）`)
})

// ───────── helper ─────────
function mkMsg(text, isSelf, extra = {}, id, name) {
  return {
    id: id || ('m_' + text.slice(0, 4)), groupId: 'g', userId: isSelf ? 'bot' : 'u',
    displayName: name || (isSelf ? '我' : '甲'), timestamp: Date.now(), text, segments: [{ type: 'text', text }],
    replyToId: null, atBot: false, mentionsBotName: false, quotesBot: false, isCommand: false, isSelf, handledByDirectAgent: false, media: [],
    seq: extra.seq, ...extra,
  }
}

// ───────── 总结 ─────────
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
