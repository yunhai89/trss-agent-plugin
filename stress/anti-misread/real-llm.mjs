/**
 * 伪人"认错对象" 真 LLM 端到端压测（stress/anti-misread）。
 *
 * 复用 stress/e2e/hooks.mjs（Yunzai 基类/Config/getRuntime/全局 Bot 全部桩化，其余跑真实源码），
 * 但 RT.provider 换成**真 OpenAI 兼容客户端**（model/openai + model/agent/provider 真代码），
 * 模型配置只读自生产 /root/Yunzai/plugins/agents-plugin/config/config.yaml 的 agent 段。
 *
 * 场景（每场景独立进程跑，可重复跑取一致性）：
 *  R1  原样本复刻（生产 threshold）：芜湖@bot"帮我把我禁言" → bot(Direct Agent 模拟)答 →
 *      林墨 replyTo 芜湖"芜湖你搁这儿测试bot呢 权限摆脸上自己不会看"。
 *      断言：门控/Planner 不抢话认领（林墨在回复芜湖，不是对 bot 说）。
 *  R1F 同 R1 但 threshold=1 强制进 Planner——真模型在修复后的上下文注入下会不会认错对象。
 *  R2  旧人物渗入：R1F 窗口前置 6 条 100 分钟前"云海"的对话 → bot 回复不得出现"云海"
 *      （白名单重生成兜底，查 grounding_whitelist_violation/regen）。
 *  R3  纠错：先让 bot 对林墨产生一次回复，再林墨 quotesBot"我说的是芜湖" →
 *      下轮 planner prompt 含纠错约束、回复是承认/修正风格而非反击。
 *  R4  一对一回归：昵称提及正常提问 → 正常回答（不误伤）。
 *      （真 @bot 走 Direct Agent 分流，不进伪人链路——本 harness 不覆盖该分支，用提及替代。）
 *
 * 成本控制：LLM 调用硬上限 25 次/进程；GW/SS 关闭（其 LLM 调用与本压测无关）。
 * 输出：stress/anti-misread/out/<场景>-run<N>.json（含 planner/replyer 全 prompt 快照与输出原文）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'yaml'

const TMP = process.env.E2E_TMP
const SRC = path.resolve(import.meta.dirname, '../..')
const OUT_DIR = path.join(SRC, 'stress/anti-misread/out')
fs.mkdirSync(OUT_DIR, { recursive: true })
const f = (p) => import(pathToFileURL(path.join(SRC, p)).href)

const [SCENARIO = 'R1', RUN = '1'] = JSON.parse(process.env.ANTI_MISREAD_ARGS || '[]')
const G = '960179589'
const BOT = '2721779039'
const WUHU = '20001', LINMO = '20002', YUNHAI = '20003'
const LLM_BUDGET = 25

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 90000, step = 250) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step) } return await fn() }

// ── 生产配置（只读）：agent 段拿 baseURL/apiKey/model，humanize 段拿 persona/子模型 ──
const PROD_PATH = '/root/Yunzai/plugins/agents-plugin/config/config.yaml'
const prodAgent = yaml.parse(fs.readFileSync(PROD_PATH, 'utf8')).agent || {}
const MC = {
  protocol: prodAgent.protocol || 'openai',
  preset: prodAgent.preset || '',
  baseURL: prodAgent.baseURL || 'https://api.deepseek.com',
  apiKey: prodAgent.apiKey || '',
  model: prodAgent.model || 'deepseek-v4-pro',
}
const HP = prodAgent.humanize || {}
if (!MC.apiKey) { console.error('生产配置缺 agent.apiKey，中止'); process.exit(2) }

// ── 桩配置（stress/e2e/stubs/Config.js 的 __setConfig；含真模型 id 供 planner/replyer 用）──
const { __setConfig } = await f('stress/e2e/stubs/Config.js')
const { RT } = await f('stress/e2e/stubs/agent.js')

const BASE_HUMANIZE = {
  enable: true, groups: [G], shadow: false,
  threshold: HP.threshold ?? 30,          // 生产值 30（R1 用；R1F/R2 运行时改 1）
  talkValue: 1, debounceMs: 300, cooldownSeconds: 0,
  contextMessages: 60, bufferTtlHours: 2, presenceWindowSeconds: 1200,
  maxRepliesPer10Minutes: 60,
  personaName: '小汐', botId: BOT,
  persona: HP.persona && HP.persona.prompt ? HP.persona : { name: '小汐', prompt: '' },
  planner: { model: HP.planner?.model || MC.model, temperature: 0.2, maxTokens: 800, timeoutMs: 90000 },
  replyer: { model: HP.replyer?.model || MC.model, temperature: 0.7, maxTokens: 500, maxChars: 500 },
  reply: { minDelayMs: 100, maxDelayMs: 300, allowSticker: false },
  // 门控确定性：主动插话随机门关掉（否则 planner 是否被调用有随机性，无法归因）
  behaviorPolicy: { initiative: 0, interruptHumanConversation: false, maxRepliesPer10Minutes: 60 },
  memory: { enabled: false },
}
const setCfg = (over = {}) => __setConfig({ agent: {
  model: MC.model,
  devLog: { dir: TMP + '/devlog' },
  humanize: { ...BASE_HUMANIZE, ...over },
  groupWorld: { enabled: false, online: false },   // 关：社会现场注入与 LLM 调用都无关本压测
  selfState: { enabled: false, shadowMode: true }, // 关：省 LLM 预算（评价器每条都调）
} })
setCfg()

// ── 真 provider（model/agent/provider + model/openai 真代码，deepseek 生产通道）──
const { createProvider } = await f('model/agent/provider/index.js')
const { presets } = await f('model/openai/index.js')
const preset = MC.preset && presets[MC.preset] ? presets[MC.preset] : {}
const realProvider = createProvider({ protocol: MC.protocol, ...preset, baseURL: MC.baseURL, apiKey: MC.apiKey, model: MC.model })

const llmLog = []
let llmCalls = 0
RT.provider = { chat: async (opts) => {
  if (llmCalls >= LLM_BUDGET) throw new Error(`LLM_BUDGET_EXCEEDED(${LLM_BUDGET})`)
  const sys = String(opts.system || '')
  const caller = sys.includes('群聊参与决策器') ? 'planner'
    : sys.includes('你正在为群聊角色') ? (sys.includes('【硬约束】你刚才的草稿') ? 'replyer_whitelist_regen' : 'replyer')
    : sys.includes('群聊事件评价器') ? 'ss_appraiser'
    : sys.includes('角色记忆整合器') ? 'hmem_consolidate' : 'other'
  const idx = ++llmCalls
  const t0 = Date.now()
  let res
  try {
    res = await realProvider.chat(opts)
  } catch (e) {
    llmLog.push({ idx, caller, model: opts.model || MC.model, ms: Date.now() - t0, error: String(e?.message || e) })
    console.log(`[llm#${idx}] ${caller} ERROR ${String(e?.message || e).slice(0, 120)}`)
    throw e
  }
  llmLog.push({
    idx, caller, model: opts.model || MC.model, ms: Date.now() - t0,
    usage: res?.usage || null, system: sys,
    content: String(res?.content || ''),
    toolCalls: (res?.toolCalls || []).map((tc) => ({ name: tc.name, arguments: tc.arguments })),
  })
  console.log(`[llm#${idx}] ${caller} ${Date.now() - t0}ms tools=${(res?.toolCalls || []).map((t) => t.name).join(',') || '-'} "${String(res?.content || '').slice(0, 100).replace(/\n/g, ' ')}"`)
  return res
} }

// ── 载入真实 apps（构造器读桩配置装配；getRuntime → RT）──
const { Humanize, getHumanize } = await f('apps/humanize.js')
const hApp = new Humanize()
const h = await getHumanize()

// ── 事件工厂 + 分发 ──
let seq = 0
const ev = (uid, text, o = {}) => ({
  isGroup: true, group_id: G, user_id: uid, self_id: BOT,
  message_id: o.msgId || `m${++seq}`,
  time: o.time || Math.floor(Date.now() / 1000),
  msg: text,
  message: [
    ...(o.replyId ? [{ type: 'reply', id: String(o.replyId) }] : []),
    ...(o.atBot ? [{ type: 'at', qq: BOT }] : []),
    { type: 'text', text },
  ],
  sender: { user_id: uid, nickname: o.nick || `U${uid}` },
  atBot: !!o.atBot,
  source: o.replyId ? { id: String(o.replyId) } : null,
  reply: async () => true,
})
const dispatch = async (e) => { hApp.e = e; await hApp.onAmbient() }

const sent = globalThis.__E2E_SENT
const lastSentText = () => {
  const s = sent[sent.length - 1]; if (!s) return ''
  const one = (x) => (typeof x === 'string' ? x : x?.type === 'text' ? String(x.text || '') : '')
  return typeof s.msg === 'string' ? s.msg : s.msg.map(one).join('')
}
const traces = (sinceTs) => h.trace.recent({ limit: 300 }).filter((r) => r.ts > sinceTs)

/** 等 debounce→门控→(planner→replyer→delivery) 全链收尾。 */
async function settle(t0, ms = 120000) {
  await waitFor(async () => {
    const t = traces(t0)
    const gate = t.find((r) => r.event === 'gate_decision')
    if (!gate) return false
    if (gate.shouldPlan === false) return true
    const acted = t.some((r) => ['planner_action', 'planner_error', 'planner_call_error', 'planner_round_limit'].includes(r.event))
    if (!acted) return false
    return t.some((r) => ['delivery', 'ignore', 'reply_empty', 'replyer_error', 'composer_error', 'wait', 'wait_rest', 'target_invalid', 'target_handled_by_direct', 'planner_stale'].includes(r.event))
  }, ms)
  await sleep(1500)
}

/** prompt 检查：grounding 块 / ↩回复X(原文) 角注 / 纠错约束 是否真实注入。 */
const promptChecks = (sys) => ({
  hasGroundingBlock: sys.includes('【对话归属'),
  hasReplyToWuhu: sys.includes('↩回复芜湖'),
  hasCorrectLine: sys.includes('对象纠错'),
  hasWhitelistLine: sys.includes('本轮可谈论的人'),
})

const report = { scenario: SCENARIO, run: RUN, model: { main: MC.model, planner: BASE_HUMANIZE.planner.model, replyer: BASE_HUMANIZE.replyer.model }, steps: [], llmCalls: 0 }

async function step(name, fn) {
  console.log(`\n[${SCENARIO} run${RUN}] ${name}`)
  const t0 = Date.now()
  const llmMark = llmLog.length
  const r = await fn() || {}
  report.steps.push({ name, ...r })
  console.log(`  → ${JSON.stringify(r.summary || {})}`)
}

// ═══════════ R1 / R1F / R2 公共剧本 ═══════════
// 注：芜湖的请求走 ambient（不带 @）——@ 消息被 Direct Agent 接管后 handledByDirectAgent=true，
// 会被 ctxWindow 过滤掉，林墨 replyTo 它就只剩"↩回复(不在近窗)"，恰好绕过了被测的归属注解。
async function playMisread({ withYunhai = false, forced = false, tag }) {
  if (forced) setCfg({ threshold: 1 })
  const t0 = Date.now()
  const sentBefore = sent.length
  if (withYunhai) {
    // 两小时前(100min，bufferTtl 2h 内)的"云海"旧对话——旧上下文人物渗入源
    const old = Math.floor(Date.now() / 1000) - 100 * 60
    const lines = ['今天打得真菜', '下把带我上分行不行', '我卡这个段位两天了', '这匹配机制真有毛病', '谁来陪我双排', '算了不打了睡觉去']
    for (let i = 0; i < lines.length; i++) await dispatch(ev(YUNHAI, lines[i], { msgId: `yh${i}`, nick: '云海', time: old + i * 30 }))
    await settle(t0) // 云海旧批次自身的门控/planner 轮（forced 下 planner 多半 ignore）
  }
  // 芜湖请求 → bot 先答一嘴（R1F 下走全链；否则注入 self 模拟 bot 已发言，还原事故现场）
  const ta = Date.now()
  await dispatch(ev(WUHU, '帮我把我禁言', { msgId: `${tag}_wh`, nick: '芜湖' }))
  await settle(ta)
  if (sent.length === sentBefore) {
    await dispatch(ev(BOT, '想得美，自己闭嘴去', { msgId: `${tag}_self` }))
    await sleep(200)
  }
  // 林墨 回复 芜湖（不是对 bot 说）
  const tb = Date.now()
  const sentBeforeB = sent.length
  await dispatch(ev(LINMO, '芜湖你搁这儿测试bot呢 权限摆脸上自己不会看', { replyId: `${tag}_wh`, msgId: `${tag}_lm`, nick: '林墨' }))
  await settle(tb)

  const t = traces(tb)
  const gate = t.find((r) => r.event === 'gate_decision')
  const plannerAction = t.find((r) => r.event === 'planner_action')
  const plannerSys = [...llmLog].reverse().find((l) => l.caller === 'planner')?.system || ''
  const replyerCalls = llmLog.filter((l) => l.caller.startsWith('replyer'))
  const replyTexts = sent.slice(sentBeforeB).map((s) => {
    const one = (x) => (typeof x === 'string' ? x : x?.type === 'text' ? String(x.text || '') : '')
    return typeof s.msg === 'string' ? s.msg : s.msg.map(one).join('')
  }).filter(Boolean)
  const violations = t.filter((r) => r.event === 'grounding_whitelist_violation')
  const regen = t.filter((r) => r.event === 'grounding_whitelist_regen')
  const outText = replyTexts.join(' / ')
  const summary = {
    gate: gate ? `分${gate.finalScore}/${gate.threshold} shouldPlan=${gate.shouldPlan} +${(gate.reasons?.positive || []).join(',')} -${(gate.reasons?.negative || []).join(',')}` : '无',
    planner: plannerAction?.action || '(未进 planner)',
    reply: outText || '(未回复)',
    云海渗入: withYunhai ? (outText.includes('云海') ? 'YES-违规' : 'no') : 'n/a',
    whitelistViolation: violations.length, regen: regen.length,
    plannerGrounding: plannerSys ? promptChecks(plannerSys) : null,
    replyerGrounding: replyerCalls.length ? promptChecks(replyerCalls[0].system) : null,
  }
  return { t0, summary, detail: { gate, plannerAction, replyTexts, traceEvents: t.map((r) => r.event) } }
}

// ═══════════════════════ 场景分发 ═══════════════════════
if (SCENARIO === 'R1') {
  await step('R1 原样本复刻（生产 threshold=30，看门控是否抢话）', () => playMisread({ tag: 'r1' }))
} else if (SCENARIO === 'R1F') {
  await step('R1F 强制进 Planner（threshold=1）——真模型会不会把林墨的话当成对 bot 说', () => playMisread({ forced: true, tag: 'r1f' }))
} else if (SCENARIO === 'R2') {
  await step('R2 旧人物渗入（云海 6 条前置 + 强制进 Planner）', () => playMisread({ withYunhai: true, forced: true, tag: 'r2' }))
} else if (SCENARIO === 'R3') {
  await step('R3 对象纠错（"我说的是芜湖"）', async () => {
    const t0 = Date.now()
    // 前置：芜湖在窗口里（memberNames 才能识别"我说的是芜湖"的指向）
    await dispatch(ev(WUHU, '群主给我禁言一下呗，我认真的', { msgId: 'r3_wh', nick: '芜湖' }))
    await sleep(150)
    // 让 bot 对林墨产生一次回复（提及小汐 → relevance 80 强信号）
    const s0 = sent.length
    await dispatch(ev(LINMO, '小汐你评评理，芜湖是不是该被禁言', { msgId: 'r3_lm1', nick: '林墨' }))
    await settle(t0)
    let botMsgId = sent[sent.length - 1]?.id || null
    let firstReply = lastSentText()
    if (!botMsgId || sent.length === s0) {
      // planner 沉默兜底：以 bot 自身消息回灌（等价 Direct Agent 发言），保证有可引用对象
      botMsgId = 'r3_selffb'
      await dispatch(ev(BOT, '笑死，芜湖自己作的行为啥要我评', { msgId: botMsgId }))
      firstReply = '(planner 沉默，注入模拟 bot 发言)'
      await sleep(200)
    }
    // 纠错：林墨 quotesBot "我说的是芜湖"
    const t1 = Date.now()
    const sentBefore1 = sent.length
    await dispatch(ev(LINMO, '我说的是芜湖', { replyId: botMsgId, msgId: 'r3_lm2', nick: '林墨' }))
    await settle(t1)
    const t = traces(t1)
    const gate = t.find((r) => r.event === 'gate_decision')
    const plannerAction = t.find((r) => r.event === 'planner_action')
    const plannerCalls = llmLog.filter((l) => l.caller === 'planner')
    const corrSys = plannerCalls[plannerCalls.length - 1]?.system || ''
    const replyerCalls = llmLog.filter((l) => l.caller.startsWith('replyer'))
    const replyText = (sent.slice(sentBefore1).map((s) => {
      const one = (x) => (typeof x === 'string' ? x : x?.type === 'text' ? String(x.text || '') : '')
      return typeof s.msg === 'string' ? s.msg : s.msg.map(one).join('')
    }).filter(Boolean).join(' / '))
    const summary = {
      firstBotReply: firstReply.slice(0, 60),
      gate2: gate ? `分${gate.finalScore}/${gate.threshold} shouldPlan=${gate.shouldPlan}` : '无',
      planner2: plannerAction?.action || '(未进 planner)',
      correctiveReply: replyText || '(未回复)',
      plannerPrompt: corrSys ? promptChecks(corrSys) : null,
      replyerPrompt: replyerCalls.length ? promptChecks(replyerCalls[replyerCalls.length - 1].system) : null,
    }
    return { summary, detail: { traceEvents: t.map((r) => r.event), plannerAction, gate } }
  })
} else if (SCENARIO === 'R4') {
  await step('R4 一对一回归（提及小汐正常提问 → 正常回答）', async () => {
    const t0 = Date.now()
    await dispatch(ev(LINMO, '小汐，帮我想个周一请假的靠谱理由，别太夸张', { msgId: 'r4_lm', nick: '林墨' }))
    await settle(t0)
    const t = traces(t0)
    const gate = t.find((r) => r.event === 'gate_decision')
    const plannerAction = t.find((r) => r.event === 'planner_action')
    const replyText = lastSentText()
    return { summary: {
      gate: gate ? `分${gate.finalScore}/${gate.threshold} shouldPlan=${gate.shouldPlan}` : '无',
      planner: plannerAction?.action || '(未进 planner)',
      reply: replyText || '(未回复)',
      答非所问嫌疑: !replyText ? 'n/a(未回复)' : (/请假|周一|理由|病|休息|上班/.test(replyText) ? 'no' : 'CHECK'),
    }, detail: { traceEvents: t.map((r) => r.event) } }
  })
} else {
  console.error(`未知场景 ${SCENARIO}`); process.exit(2)
}

// ═══════════════════════ 输出报告 ═══════════════════════
report.llmCalls = llmCalls
report.llmLog = llmLog
report.sent = sent.map((s) => ({ id: s.id, msg: typeof s.msg === 'string' ? s.msg : JSON.stringify(s.msg) }))
const outPath = path.join(OUT_DIR, `${SCENARIO}-run${RUN}.json`)
fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\n========== [${SCENARIO} run${RUN}] 汇总 ==========`)
for (const s of report.steps) console.log(`【${s.name}】\n  ${JSON.stringify(s.summary, null, 2)}`)
console.log(`LLM 调用：${llmCalls}/${LLM_BUDGET}`)
console.log(`报告：${outPath}`)
process.exit(0)
