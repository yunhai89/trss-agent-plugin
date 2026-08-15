/**
 * 全链路 E2E 压测（吸取教训版）——真实 apps 层入口（Humanize/GroupWorld 插件类 onAmbient/hourlyTask），
 * 仅桩三类环境依赖（Yunzai plugin 基类 / Config / getRuntime / 全局 Bot）。
 *
 * 覆盖面（此前压测的盲区 = apps 装配层）：
 *  S0 装配：双服务就绪、DB 单例共享
 *  S1 旁听基线：闲聊 → GW 入库建档、SS 零事件、伪人不触发
 *  S2 @bot 辱骂：SS 检测→评价→情绪→关系残留 全链；@ 走 Direct Agent 不触发伪人
 *  S3 伪人触发→Planner→Replyer→发送→onDelivered：投影/胶囊注入 prompt、问句登记期待、GW 关系写回
 *  S4 回应闭环：目标回复 bot → 期待 fulfilled + response_received 正反馈
 *  S5 冷落：目标绕开 + 到期 → sweep → ignored_expectation
 *  S6 切片+小时分析（apps 层 hourlyTask 入口）→ traits/episodes 落库
 *  S7 隐私指令：#关闭我的群聊建模 → optout 落库
 *  S8 配置门回归（今日修的键名 bug 直接回归）：enabled/enable 开关真的控门
 *
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/run.mjs
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const TMP = process.env.E2E_TMP
const SRC = path.resolve(import.meta.dirname, '../..')
const f = (p) => import(pathToFileURL(path.join(SRC, p)).href)

// ── 先配置桩，再 import apps（构造器会异步读配置装配） ──
const { __setConfig } = await f('stress/e2e/stubs/Config.js')
const { RT } = await f('stress/e2e/stubs/agent.js')

const G = '960179589'
const BOT = '2721779039'
const U1 = '10001', U2 = '10002', U3 = '10003' // 群友
let passed = 0, failed = 0, bugs = []
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m); bugs.push(m) } }
const test = async (name, fn) => { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 4).join('\n')); bugs.push(`${name}: ${e?.message}`) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 15000, step = 200) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step) } return await fn() }

const setCfg = (over = {}) => __setConfig({ agent: {
  devLog: { dir: TMP + '/devlog' },
  humanize: { enable: true, groups: [G], shadow: false, threshold: 30, debounceMs: 200, cooldownSeconds: 1, personaName: '小汐', persona: { name: '小汐', prompt: '' }, ...over.humanize },
  groupWorld: { enabled: true, groups: [G], online: true, analysis: { maxDailyCallsPerGroup: 100 }, ...over.groupWorld },
  selfState: { enabled: true, shadowMode: false, eventDetection: { minEventConfidence: 0.5 }, ...over.selfState },
  recall: {},
} })

// ── LLM 桩：按 system prompt 区分调用方 ──
const LLM = { plannerMode: 'ignore', plannerTarget: null, replyGuide: '自然接话', replyText: '好的呀', appraisal: null }
const promptLog = []
setCfg()
RT.provider = { chat: async (opts) => {
  const sys = String(opts.system || '')
  promptLog.push(sys)
  if (sys.includes('群聊参与决策器')) {
    if (LLM.plannerMode === 'ignore') return { content: '先看看再说', toolCalls: [] }
    return { content: '值得接一句', toolCalls: [{ id: 'tc1', name: 'human_reply', arguments: { targetMessageId: String(LLM.plannerTarget), replyGuide: LLM.replyGuide } }] }
  }
  if (sys.includes('你正在为群聊角色')) return { role: 'assistant', content: LLM.replyText }
  if (sys.includes('群聊事件评价器')) return { role: 'assistant', content: JSON.stringify(LLM.appraisal || { event_type: 'directed_message', semantic_signals: { playfulness: 0.2, hostility: 0.2, repair_signal: 0, sincerity: 0.5 }, directed_at_bot: 0.5, intent_confidence: 0.5 }) }
  if (sys.includes('群聊社会记忆抽取器')) {
    const ids = [...new Set(String(opts.messages?.[0]?.content || '').match(/m\d+/g) || [])].slice(0, 3)
    if (!ids.length) return { role: 'assistant', content: JSON.stringify({ trait_candidates: [], relation_candidates: [], episode_candidates: [], sensitive_inferences: [] }) }
    return { role: 'assistant', content: JSON.stringify({
      trait_candidates: [{ user_id: 'u1', trait_type: 'interest', trait_key: 'game_chat', trait_value: '常聊游戏话题', confidence: 0.4, evidence_message_ids: ids }],
      relation_candidates: [{ from_user_id: 'u1', to_user_id: 'u2', relation_hint: '常互相接话', confidence: 0.4, evidence_message_ids: ids }],
      episode_candidates: [{ episode_type: 'ongoing_topic', title: '游戏话题', summary: '群里在聊游戏', participant_ids: ['u1', 'u2'], importance: 0.5, evidence_message_ids: ids }],
      sensitive_inferences: [],
    }) }
  }
  return { role: 'assistant', content: '{}' }
} }

// ── 载入真实 apps ──
const { Humanize, getSelfState } = await f('apps/humanize.js')
const { GroupWorld, getGroupWorld } = await f('apps/groupworld.js')
const Db = await f('model/groupworld/db.js')
const dao = Db.dao
const hApp = new Humanize()
const gwApp = new GroupWorld()

// ── 事件工厂 + 分发（模拟 Yunzai dispatch 到两个 app）──
let seq = 0
const replies = []
const ev = (uid, text, o = {}) => ({
  isGroup: true, group_id: G, user_id: uid, self_id: BOT,
  message_id: o.msgId || `m${++seq}`,
  time: Math.floor(Date.now() / 1000),
  msg: text,
  message: [
    ...(o.replyId ? [{ type: 'reply', id: String(o.replyId) }] : []),
    ...(o.atBot ? [{ type: 'at', qq: BOT }] : []),
    { type: 'text', text },
  ],
  sender: { user_id: uid, nickname: o.nick || `U${uid}` },
  atBot: !!o.atBot,
  source: o.replyId ? { id: String(o.replyId) } : null,
  reply: async (t) => { replies.push(t); return true },
})
const dispatch = async (e) => { hApp.e = e; gwApp.e = e; await Promise.all([hApp.onAmbient(), gwApp.onAmbient()]) }

const sent = globalThis.__E2E_SENT
const cnt = async (sql, p = []) => { try { const r = await dao.get(sql, p); return Number(r?.c) || Number(r?.n) || 0 } catch { return 0 } }
const ssEvents = async (type) => cnt("SELECT COUNT(*) c FROM ss_events WHERE event_type=?", [type])
// 出站消息可能是 string / [string] / [{type:'text',text}]（composer 分段 → makeSend 包装）
const lastSentText = () => {
  const s = sent[sent.length - 1]; if (!s) return ''
  const one = (x) => (typeof x === 'string' ? x : x?.type === 'text' ? String(x.text || '') : '')
  return typeof s.msg === 'string' ? s.msg : s.msg.map(one).join('')
}

// ═══════════════ S0 装配 ═══════════════
await test('S0 装配：humanize/GW/SS 服务就绪、共库', async () => {
  const ss = await getSelfState()
  ok(!!ss, 'SelfStateService 装配成功（ssLazy 就绪）')
  const gw = await getGroupWorld()
  ok(!!gw?.ingester, 'GroupWorldService 装配成功')
  ok(Db.dao != null, 'dao 单例可用')
})

// ═══════════════ S1 旁听基线 ═══════════════
await test('S1 旁听：闲聊入库建档、SS 零事件、伪人静默', async () => {
  const before = await cnt('SELECT COUNT(*) c FROM gw_messages')
  for (const [uid, t] of [[U1, '今天好困啊'], [U2, '中午吃什么'], [U1, '这游戏也太难了'], [U3, '笑死我了'], [U2, '刚下班，累']])
    await dispatch(ev(uid, t))
  await sleep(800)
  const msgs = await cnt('SELECT COUNT(*) c FROM gw_messages')
  ok(msgs - before === 5, `GW 摄入 5 条（实际 +${msgs - before}）`)
  const profiles = await cnt('SELECT COUNT(*) c FROM gw_member_profiles')
  ok(profiles >= 3, `3 名成员建档（实际 ${profiles}）`)
  ok(await ssEvents('direct_insult') === 0 && await cnt("SELECT COUNT(*) c FROM ss_events") === 0, '闲聊不产生 SS 事件')
  ok(sent.length === 0, '伪人未触发（无发送）')
})

// ═══════════════ S2 @bot 辱骂（SS 全链 + Direct Agent 分流）═══════════════
await test('S2 @bot 辱骂：检测→评价→情绪→残留；@ 不触发伪人', async () => {
  LLM.appraisal = { event_type: 'direct_insult', semantic_signals: { playfulness: 0.1, hostility: 0.9, repair_signal: 0, sincerity: 0.5 }, directed_at_bot: 0.9, intent_confidence: 0.85 }
  const sentBefore = sent.length
  await dispatch(ev(U1, '你就是个垃圾废物', { atBot: true, msgId: 'mInsult' }))
  await waitFor(async () => (await ssEvents('direct_insult')) >= 1)
  ok(await ssEvents('direct_insult') >= 1, 'SS 产生 direct_insult 事件')
  const anger = await dao.get("SELECT intensity FROM ss_emotions WHERE emotion_type='anger' AND status='active'")
  ok(Number(anger?.intensity) > 0, `anger 情绪产生（${Number(anger?.intensity || 0).toFixed(3)}）`)
  // 残留写在 applyEvent 链路最后（事件→情绪→心境→残留）——waitFor 只返回 boolean，行数据须经闭包带出
  let rel = null
  await waitFor(async () => {
    const r = await dao.get('SELECT resentment,guardedness FROM gw_bot_rel WHERE user_id=?', [U1])
    if (r && (Number(r.resentment) > 0 || Number(r.guardedness) > 0)) { rel = r; return true }
    return false
  })
  ok(Number(rel?.resentment || 0) > 0 || Number(rel?.guardedness || 0) > 0, `关系残留（resentment=${Number(rel?.resentment || 0).toFixed(3)}, guardedness=${Number(rel?.guardedness || 0).toFixed(3)}）`)
  ok(sent.length === sentBefore, '@ 消息走 Direct Agent，伪人不触发')
  LLM.appraisal = null // 重置：防 S3 的普通消息被陈旧辱骂评价误标
})

// ═══════════════ S3 伪人全链：触发→决策→生成→发送→期待登记 ═══════════════
await test('S3 伪人全链：昵称提及触发→planner/replyer→发送→onDelivered', async () => {
  LLM.plannerMode = 'reply'; LLM.plannerTarget = 'mTrig3'; LLM.replyGuide = '接游戏话题'; LLM.replyText = '你们觉得这个方案怎么样？'
  promptLog.length = 0
  const sentBefore = sent.length
  await dispatch(ev(U1, '小汐你觉得呢', { msgId: 'mTrig3' }))
  const got = await waitFor(() => sent.length > sentBefore)
  ok(got, '伪人真实发送（Bot.sendMsg 捕获）')
  ok(lastSentText().includes('方案'), `发出 replyer 生成的问句（"${lastSentText().slice(0, 20)}"）`)
  await sleep(1200)
  const plannerSys = promptLog.find((s) => s.includes('群聊参与决策器')) || ''
  ok(plannerSys.includes('自我状态偏置'), 'Planner prompt 注入 SelfState 投影（shadow=false）')
  ok(plannerSys.includes('当前发言者'), 'Planner prompt 注入 GroupWorld 社会现场（online=true）')
  const replyerSys = promptLog.find((s) => s.includes('你正在为群聊角色')) || ''
  ok(replyerSys.includes('当前表达状态'), 'Replyer prompt 注入表达胶囊')
  const exp = await dao.get("SELECT * FROM ss_expectations WHERE status='pending' ORDER BY id DESC LIMIT 1")
  ok(!!exp, `出站问句登记期待（id=${exp?.id}, type=${exp?.expectation_type}）`)
  const rel = await dao.get('SELECT familiarity FROM gw_bot_rel WHERE user_id=?', [U1])
  ok(Number(rel?.familiarity || 0) > 0, `onDelivered 写回 GW 关系（familiarity=${Number(rel?.familiarity || 0).toFixed(3)}）`)
  LLM.plannerMode = 'ignore'
})

// ═══════════════ S4 回应闭环 ═══════════════
await test('S4 回应闭环：回复 bot 消息 → 期待 fulfilled + response_received', async () => {
  const botMsgId = sent[sent.length - 1]?.id
  await dispatch(ev(U1, '我觉得还行吧，就按这个来', { replyId: botMsgId, msgId: 'mResp4' }))
  await waitFor(async () => (await ssEvents('response_received')) >= 1)
  const exp = await dao.get("SELECT status,outcome FROM ss_expectations ORDER BY id DESC LIMIT 1")
  ok(exp?.status === 'fulfilled', `期待 fulfilled（实际 ${exp?.status}）`)
  ok(await ssEvents('response_received') >= 1, '产生 response_received 正反馈事件')
})

// ═══════════════ S5 冷落 ═══════════════
await test('S5 冷落：目标绕开他人 + 到期 → sweep 判 ignored', async () => {
  // bot 再发一问（引用触发）
  LLM.plannerMode = 'reply'; LLM.plannerTarget = 'mTrig5'; LLM.replyText = '那你们到底要不要一起？'
  const sentBefore = sent.length
  await dispatch(ev(U2, '', { replyId: sent[sent.length - 1]?.id, msgId: 'mTrig5', nick: U2 }))
  await dispatch(ev(U2, '继续刚才那个话题', { replyId: 'mTrig5', msgId: 'mFollow5' }))
  await waitFor(() => sent.length > sentBefore)
  await sleep(800)
  LLM.plannerMode = 'ignore'
  const exp = await dao.get("SELECT * FROM ss_expectations WHERE status='pending' ORDER BY id DESC LIMIT 1")
  ok(!!exp, `第二问句登记期待（id=${exp?.id}）`)
  if (!exp) return
  const target = exp.target_user_id
  // 目标活跃但绕开：回复"他人"×2（不回 bot）+ 群持续活跃（ignore_score 的 groupAct/10 需要 ~10 条）
  await dispatch(ev(U2, '哈哈确实', { replyId: 'm2', msgId: 'mByp1' }))
  await dispatch(ev(U2, '对对就是这个', { replyId: 'm1', msgId: 'mByp2' }))
  for (let i = 0; i < 10; i++) await dispatch(ev(U3, `闲聊填充第${i}条`, { msgId: `mFill${i}` }))
  await dao.run('UPDATE ss_expectations SET expires_at=? WHERE id=?', [Date.now() - 1000, exp.id])
  await dispatch(ev(U3, '话说回来', { msgId: 'mTrigger' })) // 任意消息触发 sweep
  await waitFor(async () => !!(await dao.get("SELECT id FROM ss_expectations WHERE id=? AND status='ignored'", [exp.id]))
    || (await ssEvents('ignored_expectation')) >= 1)
  const judged = await dao.get('SELECT status,outcome FROM ss_expectations WHERE id=?', [exp.id])
  ok(judged?.status === 'ignored', `到期判定 ignored（实际 ${judged?.status}，target=${target}）`)
  ok(await ssEvents('ignored_expectation') >= 1, '产生 ignored_expectation 事件（修复回归：不再丢失）')
})

// ═══════════════ S6 切片 + 小时分析（apps 层定时任务入口）═══════════════
await test('S6 切片+小时分析：hourlyTask → segments/traits/episodes', async () => {
  for (let i = 0; i < 10; i++) await dispatch(ev(U1, `游戏配置第${i}条讨论，这个天赋怎么点`, { msgId: `mGame${i}` }))
  await sleep(500)
  await gwApp.hourlyTask() // 真实 apps 定时任务入口（含 enabled 门）
  await waitFor(async () => (await cnt("SELECT COUNT(*) c FROM gw_segments WHERE status='analyzed'")) >= 1)
  ok(await cnt("SELECT COUNT(*) c FROM gw_segments WHERE status='analyzed'") >= 1, '片段被分析（analyzed）')
  const traits = await cnt("SELECT COUNT(*) c FROM gw_traits")
  const eps = await cnt("SELECT COUNT(*) c FROM gw_episodes")
  ok(traits >= 1, `画像特征落库（${traits}）`)
  ok(eps >= 1, `事件落库（${eps}）`)
})

// ═══════════════ S7 隐私指令 ═══════════════
await test('S7 隐私指令：#关闭我的群聊建模', async () => {
  const e = ev(U3, '#关闭我的群聊建模', { msgId: 'mOpt' })
  gwApp.e = e
  await gwApp.gwOptOut()
  const row = await dao.get('SELECT * FROM gw_optout WHERE user_id=?', [U3])
  ok(!!row, 'optout 落库')
  ok(replies.length >= 1, '指令有回复')
})

// ═══════════════ S8 配置门回归（键名 bug 直接回归）═══════════════
await test('S8 配置门：groupWorld.enabled=false 停摄入；humanize.enable=false 停触发', async () => {
  setCfg({ groupWorld: { enabled: false, groups: [G] } })
  const before = await cnt('SELECT COUNT(*) c FROM gw_messages')
  await dispatch(ev(U1, '关掉之后的闲聊', { msgId: 'mGate1' }))
  await sleep(500)
  ok(await cnt('SELECT COUNT(*) c FROM gw_messages') === before, 'groupWorld.enabled=false → 零摄入（enable/enabled 键名回归）')

  setCfg({ humanize: { enable: false, groups: [G] } })
  const sentBefore = sent.length
  LLM.plannerMode = 'reply'
  await dispatch(ev(U2, '小汐你说句话啊', { msgId: 'mGate2' }))
  await sleep(2500)
  ok(sent.length === sentBefore, 'humanize.enable=false → 不触发不发送')
  LLM.plannerMode = 'ignore'
  setCfg() // 恢复
})

// ═══════════════ S9 伪人独立记忆库：整合→检索→遗忘 ═══════════════
await test('S9 伪人记忆：睡眠整合→检索→遗忘（独立 sqlite，与主 Agent 隔离）', async () => {
  const { getHumanize } = await f('apps/humanize.js')
  const hobj = await getHumanize()
  ok(!!hobj?.hmem, 'HumanizeMemoryStore 装配成功')
  const origChat = RT.provider.chat
  RT.provider.chat = async (opts) => {
    const sys = String(opts.system || '')
    if (sys.includes('角色记忆整合器')) {
      return { role: 'assistant', content: JSON.stringify({ memories: [
        { kind: 'impression', about_user: U1, content: 'U10001 老爱拿我玩梗，算损友', keywords: ['玩梗', '损友'], importance: 0.7 },
        { kind: 'jargon', about_user: null, content: '群里"咕嘎"是起哄的叫声', keywords: ['咕嘎', '起哄'], importance: 0.8 },
      ] }) }
    }
    return origChat(opts)
  }
  const cons = await hobj.hmem.consolidate({ groupId: G, messages: [
    { id: 'x1', userId: U1, displayName: 'U1', timestamp: Date.now(), text: '咕嘎', isSelf: false },
    { id: 'x2', userId: U2, displayName: 'U2', timestamp: Date.now(), text: '咕咕嘎嘎', isSelf: false },
    { id: 'x3', userId: BOT, displayName: '我', timestamp: Date.now(), text: '你们在咕嘎什么', isSelf: true },
    { id: 'x4', userId: U1, displayName: 'U1', timestamp: Date.now(), text: '又玩我梗是吧', isSelf: false },
    { id: 'x5', userId: U2, displayName: 'U2', timestamp: Date.now(), text: '这个梗好上头', isSelf: false },
    { id: 'x6', userId: U3, displayName: 'U3', timestamp: Date.now(), text: '笑死，跟着咕嘎', isSelf: false },
    { id: 'x7', userId: U1, displayName: 'U1', timestamp: Date.now(), text: '明天继续', isSelf: false },
  ] })
  ok(cons.created >= 1, `整合产出（created=${cons.created} merged=${cons.merged}）`)
  const txt = await hobj.hmem.recallText({ groupId: G, query: '咕嘎是什么意思', topK: 3 })
  ok(txt.includes('咕嘎') && txt.includes('主观印象'), `检索命中群梗记忆并带主观标注（${txt.slice(0, 50).replace(/\n/g, ' ')}…）`)
  const st = await hobj.hmem.stats(G)
  ok(st.total >= 2, `记忆入库（${st.total} 条）`)
  await hobj.hmem.decay(G)
  const after = await hobj.hmem.stats(G)
  ok(after.total === st.total, `新记忆不被遗忘误删（${after.total}/${st.total}）`)
  // 对象印象定向检索（Replyer 注入路径的检索语义）
  const imp = await hobj.hmem.recallText({ groupId: G, userId: U1, query: '玩梗', topK: 2, kinds: ['impression'] })
  ok(imp.includes('损友'), `按目标用户检索印象命中（${imp.slice(0, 50).replace(/\n/g, ' ')}…）`)
  // 语义召回：正交假向量下"同义换说"（零词面重叠）也能命中——词面召回做不到这一点
  const AX = { A: [1, 0, 0], B: [0, 1, 0], X: [0, 0, 1] }
  hobj.hmem.embedder = {
    model: 'fake-e2e',
    embed: async (t) => {
      const s = String(t)
      if (/玩梗|损友|调侃|打趣|开玩笑/.test(s)) return Float32Array.from(AX.A)
      if (/咕嘎|起哄/.test(s)) return Float32Array.from(AX.B)
      return Float32Array.from(AX.X)
    },
  }
  // 查询"他总是调侃打趣开玩笑"与"爱玩梗算损友"零词面重叠（jaccard=0），但共享 A 轴向量 → 语义命中
  const sem = await hobj.hmem.recallText({ groupId: G, query: '他总是调侃打趣开玩笑', topK: 3 })
  ok(sem.includes('损友'), `语义召回：同义换说零词面重叠仍命中（${sem.slice(0, 60).replace(/\n/g, ' ')}…）`)
  hobj.hmem.embedder = null
  RT.provider.chat = origChat
})

// ═══════════════ S10 伪人看图：视觉描述注入 Planner/Replyer ═══════════════
await test('S10 伪人看图：图片 → 视觉描述 → 注入 prompt', async () => {
  // 本地图床（1x1 PNG）+ 真 MediaDescriber（RT.vision 桩）
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const srv = (await import('node:http')).createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  RT.vision = { analyze: async () => '一张猫咪表情包，配字哈哈' }
  const { MediaDescriber } = await f('model/humanize/vision-context.js')
  const md = new MediaDescriber({ vision: RT.vision })
  ok(md.available, 'MediaDescriber 可用（vision 已配）')
  const annotated = await md.annotate([
    { id: 'img1', userId: U1, displayName: 'U1', timestamp: Date.now(), isSelf: false, text: '看这个 [图片]', media: [{ kind: 'image', url: `http://127.0.0.1:${port}/cat.png` }] },
  ], { targetId: 'img1' })
  ok(/\[图:.*猫咪.*\]/.test(annotated[0].text), `'[图片]' 注成描述（${annotated[0].text}）`)
  // 缓存：第二次同 URL 不再调 vision（计数验证）
  let calls = 0
  RT.vision = { analyze: async () => { calls++; return 'x' } }
  const md2 = new MediaDescriber({ vision: RT.vision })
  await md2.describeUrl(`http://127.0.0.1:${port}/cat.png`)
  await md2.describeUrl(`http://127.0.0.1:${port}/cat.png`)
  ok(calls === 1, `同图走缓存不重复调 API（calls=${calls}）`)
  // 未配视觉：no-op
  RT.vision = null
  const md3 = new MediaDescriber({ vision: null })
  const passthrough = await md3.annotate([{ id: 'a', text: '看 [图片]', media: [{ kind: 'image', url: 'http://x/1.png' }], timestamp: Date.now() }])
  ok(passthrough[0].text.includes('[图片]'), '未配视觉模型 → 原样保留占位（零影响）')
  srv.close()
})

// ═══════════════ 汇总 ═══════════════
console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
if (bugs.length) { console.log('失败明细:'); for (const b of bugs) console.log(' -', b) }
console.log('========================================')
process.exit(failed ? 1 : 0)
