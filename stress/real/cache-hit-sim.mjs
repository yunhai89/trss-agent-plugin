/**
 * 多轮对话缓存命中率实测（真实 Provider；未配置 Key 时自动跳过）。
 *
 * 用途：用插件自己的 Agent + 真实厂商端点，模拟一段多轮群聊（含工具轮、情境注入、
 * 无损压缩），统计**每一轮**的 `prompt_tokens` / `cached_tokens`，给出面板同口径的
 * Token 命中率（`cacheRead / observedInput`），用于验证「窗口吃满 + 压得深」的
 * 缓存经济性结论（见 README「缓存经济性」）。
 *
 * 运行方式（二选一，与 stress/real/real-llm-smoke.mjs 相同）：
 *   1) REAL_LLM_API_KEY=... REAL_LLM_BASE_URL=... REAL_LLM_MODEL=... [REAL_LLM_PRESET=opencode-go] \
 *        SIM_WINDOW=200000 SIM_HIGH=0.8 SIM_LOW=0.1 SIM_TURNS=36 node stress/real/cache-hit-sim.mjs
 *   2) AGENTS_CONFIG=/path/to/config.yaml （直接读实机配置的 provider 与模型参数）
 * 未配置 Key → 打印 SKIP_FILE 并以 0 退出（离线测试运行器据此记为 skip，不联网）。
 *
 * 可调环境变量：
 *   SIM_WINDOW/SIM_HIGH/SIM_LOW  上下文窗口与高低水位比例（不设 WINDOW = 消息水位）
 *   SIM_TURNS                    模拟轮数（默认 36）
 *   SIM_SESSIONS                 模拟会话数（默认 1；>1 时每个会话有独立 system 前缀＝各自冷启动）
 *   SIM_RUNS                     每个会话的 run 次数（默认 1；一次用户消息 = 一个 run，可累积上下文）
 *   SIM_GAP_MS                    run 之间的空闲间隔毫秒（默认 0）
 *   SIM_TAG                      场景标签（避免不同场景共享前缀，默认取配置指纹）
 *   SIM_TOOL_CHARS               每次工具结果字符数（默认 3800）
 *   SIM_CTX_CHARS                每轮情境注入字符数（默认 3200）
 *   说明：两者共同决定「每轮新增 token 量」（d）。实机日志（339 轮）实测 d≈3900 token/轮，
 *   这里默认值模拟出的 d 与之同量级——d 是命中率公式里唯一的不可缓存部分，必须贴近实机。
 *   CACHE_ASSERT=1               断言 warm 命中率 ≥ CACHE_MIN_RATE（默认 0.95），否则退出码 1
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import YAML from 'yaml'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href)

function resolveProviderCfg() {
  const env = process.env
  if (env.REAL_LLM_API_KEY) {
    return {
      protocol: env.REAL_LLM_PROTOCOL || 'openai',
      preset: env.REAL_LLM_PRESET || 'opencode-go',
      baseURL: env.REAL_LLM_BASE_URL || '',
      apiKey: env.REAL_LLM_API_KEY,
      model: env.REAL_LLM_MODEL || '',
      reasoningFields: [],
    }
  }
  const cfgPath = env.AGENTS_CONFIG || ''
  if (cfgPath && fs.existsSync(cfgPath)) {
    try {
      const y = YAML.parse(fs.readFileSync(cfgPath, 'utf8'))
      const a = (y && y.agent) || {}
      if (a.apiKey && a.model) {
        return {
          protocol: a.protocol || 'openai', preset: a.preset || '', baseURL: a.baseURL || '',
          apiKey: a.apiKey, model: a.model, reasoningFields: a.reasoningFields || [],
          reflect: a.reflect, finalize: a.finalize,
          maxToolResultChars: a.maxToolResultChars, keepReasoning: a.keepReasoning,
        }
      }
    } catch { /* 忽略，走 skip */ }
  }
  return null
}

const pc = resolveProviderCfg()
if (!pc || !pc.apiKey || !pc.model) {
  console.log('SKIP_FILE: 未配置真实 LLM（REAL_LLM_API_KEY / AGENTS_CONFIG），跳过缓存命中率实测')
  process.exit(0)
}

const WINDOW = process.env.SIM_WINDOW ? Number(process.env.SIM_WINDOW) : null
const HIGH = Number(process.env.SIM_HIGH || 0.65)
const LOW = Number(process.env.SIM_LOW || 0.45)
const TURNS = Number(process.env.SIM_TURNS || 36)
const TOOL_CHARS = Number(process.env.SIM_TOOL_CHARS || 3800)
const CTX_CHARS = Number(process.env.SIM_CTX_CHARS || 3200)
const TAG = process.env.SIM_TAG || `${WINDOW ?? 'msg'}-${HIGH}-${LOW}`
const MIN_RATE = Number(process.env.CACHE_MIN_RATE || 0.95)
const SESSIONS = Math.max(1, Number(process.env.SIM_SESSIONS || 1))   // 会话数（模拟多个群各自冷启动）
const RUNS = Math.max(1, Number(process.env.SIM_RUNS || 1))           // 每会话的 run 次数（一次用户消息 = 一个 run）
const GAP_MS = Math.max(0, Number(process.env.SIM_GAP_MS || 0))       // run 之间的空闲间隔（模拟实机对话节奏）

const { Agent, ToolRegistry, memoryKv, SessionStore } = await imp('model/agent/index.js')
const { createProvider } = await imp('model/agent/provider/index.js')
const { presets } = await imp('model/openai/index.js')

const provider = createProvider({
  protocol: pc.protocol,
  ...(presets[pc.preset] || {}),
  ...(pc.baseURL ? { baseURL: pc.baseURL } : {}),
  apiKey: pc.apiKey,
  model: pc.model,
  ...(pc.reasoningFields?.length ? { reasoningFields: pc.reasoningFields } : {}),
})

// ---------- 记录每次真实调用的 usage；按需把某一轮改造成工具调用轮 ----------
const calls = []
let pendingToolCall = null
const origChat = provider.chat.bind(provider)
provider.chat = async (opts) => {
  const r = await origChat(opts)
  const u = r?.usage || {}
  calls.push({
    prompt: u.prompt_tokens ?? 0,
    cached: u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0,
    completion: u.completion_tokens ?? 0,
    tools: (opts.tools || []).length,
    toolChoice: opts.tool_choice ?? null,
  })
  if (pendingToolCall) {
    const t = pendingToolCall
    pendingToolCall = null
    return { ...r, content: '', toolCalls: [t], finishReason: 'tool_calls' }
  }
  return r
}


// ---------- 高熵内容生成（可复现）：重复文本会被 BPE 高效压缩，实测会低估每轮新增 token ----------
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const WORDS = ['活动','安排','地点','时间','确认','预算','名额','交通','住宿','报名','截止','负责人','群公告','投票','统计','设备','场地','天气','备选','方案','流程','志愿者','物料','签到','宣传','海报','录音','纪要','复盘','跟进','发票','审批','对接','供应商','合同','报价','排期','彩排','直播','转播','剪辑','字幕','封面','标题','推送','提醒','值班','应急','保险','许可','备案','评估','验收','里程碑','风险','依赖','看板','冲刺','需求','评审','上线','灰度','回滚','监控','告警','扩容','限流','缓存','索引','慢查询','回归','压测','接口','字段','迁移','备份','权限','审计','日志','埋点','漏斗','留存','转化','复购','客诉','工单','话术','脚本','分镜','素材','版权','水印','导出','分辨率','码率','帧率','时长','片头','片尾','配音','混音','降噪','主题曲','排练','曲目','乐器','音响','灯光','机位','轨道','素材库','时间轴','渲染','封装','投屏','扫码','签到码','桌牌','茶歇','午休','班车','停车','接驳','应急药箱','雨具','防晒','保温','冰袋','二维码','小程序','公众号','私信','置顶','精选','撤回','禁言','踢人','拉群','改名','头像','群名片']
function diverseText(rnd, chars) {
  let s = ''
  while (s.length < chars) {
    s += `${WORDS[Math.floor(rnd() * WORDS.length)]}${WORDS[Math.floor(rnd() * WORDS.length)]}的${WORDS[Math.floor(rnd() * WORDS.length)]}${WORDS[Math.floor(rnd() * WORDS.length)]}：${Math.floor(rnd() * 100000)}；`
  }
  return s.slice(0, chars)
}
let rnd = mulberry32(0x5EED ^ [...TAG].reduce((a, c) => a + c.charCodeAt(0), 0))

// ---------- 工具：一个常驻 + 一个「需激活」（考验 tools 追加与 system 目录稳定性） ----------
const toolResult = (seed) => JSON.stringify({
  ok: true,
  source: seed,
  items: Array.from({ length: Math.max(1, Math.ceil(TOOL_CHARS / 300)) }, (_, i) => ({
    idx: i, time: `2026-10-${String(10 + (i % 20)).padStart(2, '0')} 1${i % 10}:2${i % 10}`,
    text: diverseText(rnd, 300),
  })),
})
/** 每次会话一套独立工具/会话/Agent——多会话模式用于模拟实机「多个群聊各自冷启动」的流量形态 */
const mkTools = () => {
  const t = new ToolRegistry()
  t.register({
    name: 'get_chat_history', description: '读取群聊历史记录（近 N 条）',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    async execute() { return toolResult('hist') },
  })
  t.register({
    name: 'custom_probe', description: '自定义诊断工具（默认不常驻，由模型按需激活）',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    async execute() { return toolResult('probe') },
  })
  return t
}

let compactEvents = 0
let callSeq = 0
const rows = []

async function runConversation(conv) {
  // 每个会话用不同种子与不同 system 前缀：等价于实机「不同群各自冷启动」，是最保守的形态
  rnd = mulberry32((0x5EED ^ [...TAG].reduce((a, c) => a + c.charCodeAt(0), 0) ^ Math.imul(conv, 0x9E3779B9)) >>> 0)
  const systemPrompt = SESSIONS > 1
    ? `你是群里的智能助手，说话自然、简洁，先给结论再补充。[场景 ${TAG} 会话 ${conv}]`
    : `你是群里的智能助手，说话自然、简洁，先给结论再补充。[场景 ${TAG}]`
  const agent = new Agent({
    provider, tools: mkTools(), session: new SessionStore({ kv: memoryKv(), window: 400 }),
    model: pc.model, maxTurns: 8,
    reflect: pc.reflect, finalize: pc.finalize,
    contextWindow: WINDOW, contextHighRatio: HIGH, contextLowRatio: LOW,
    maxToolResultChars: pc.maxToolResultChars ?? 4000,
    keepReasoning: pc.keepReasoning !== false,
    toolDiscovery: { enable: true, alwaysOn: ['get_chat_history', 'clarify', 'memory_search'], topK: 8, minScore: 0.3 },
  })
  const ctxText = (i, run) => {
    const lines = Array.from({ length: Math.max(1, Math.ceil(CTX_CHARS / 200)) },
      (_, k) => `群友${k}：${diverseText(rnd, 200)}`)
    return `【群聊近况】\n${lines.join('\n')}\n（会话 ${conv} 第 ${run} 次 轮次 ${i}）`
  }
  const userMsg = (i, run) => `${diverseText(rnd, 120)} 以上是群里的讨论（${conv}-${run}-${i}），请整理成三条要点，并说明哪条最需要确认；语气随意一点。`

  const convRows = []
  for (let run = 1; run <= RUNS; run++) {
    if (run > 1 && GAP_MS > 0) await new Promise((r) => setTimeout(r, GAP_MS))
    for (let i = 1; i <= TURNS; i++) {
      // 实机 339 轮里 313 轮带工具结果 → 模拟「近乎每轮都调工具」；其中半数调未常驻工具（考验激活增长）
      const name = i % 2 === 0 ? 'custom_probe' : 'get_chat_history'
      pendingToolCall = { id: `call_${++callSeq}`, name, arguments: JSON.stringify(name === 'custom_probe' ? { q: 'x' } : { limit: 10 }) }
      const before = calls.length
      await agent.run(userMsg(i, run), {
        ctx: { userId: 'sim', groupId: `g${conv}`, scopeUserId: 'sim', conversationId: `sim${conv}` },
        context: ctxText(i, run),
        systemPrompt,
        onContextPressure: () => { compactEvents++ },
      })
      const slice = calls.slice(before)
      const p = slice.reduce((s, c) => s + c.prompt, 0)
      const c = slice.reduce((s, x) => s + x.cached, 0)
      const row = { conv, run, turn: i, calls: slice.length, prompt: p, cached: c, rate: p ? c / p : 0, tools: slice[slice.length - 1]?.tools ?? 0 }
      convRows.push(row); rows.push(row)
      console.log(`  会话 ${conv} 第 ${run} 次 轮 ${String(i).padStart(2)}  调用 ${slice.length}  prompt ${String(p).padStart(7)}  cached ${String(c).padStart(7)}  命中 ${(p ? (100 * c / p).toFixed(1) : '0.0').padStart(5)}%  tools ${row.tools}`)
    }
  }
  return convRows
}

for (let conv = 1; conv <= SESSIONS; conv++) await runConversation(conv)

const sum = (xs, k) => xs.reduce((s, x) => s + x[k], 0)
const tp = sum(rows, 'prompt'); const tc = sum(rows, 'cached')
// warm：每个会话的第一次调用仍是冷启动，其余计入 warm（与面板口径一致）
const warm = rows.filter((r) => !(r.run === 1 && r.turn === 1))
const wp = sum(warm, 'prompt'); const wc = sum(warm, 'cached')
const all = tp ? tc / tp : 0
const warmRate = wp ? wc / wp : 0
console.log('\n===== 缓存命中率实测汇总 =====')
console.log(`场景 ${TAG}：contextWindow=${WINDOW ?? '未配（消息水位 30→18）'}  high=${HIGH}  low=${LOW}  会话数=${SESSIONS}  每会话 ${RUNS} 次 × ${TURNS} 轮  间隔=${GAP_MS}ms`)
console.log(`调用数 ${calls.length}  压缩次数 ${compactEvents}`)
console.log(`Token 命中率（全部） = ${(100 * all).toFixed(2)}%   (${tc} / ${tp})`)
console.log(`Token 命中率（warm） = ${(100 * warmRate).toFixed(2)}%   (${wc} / ${wp})`)
for (let conv = 1; conv <= SESSIONS; conv++) {
  const cr = rows.filter((r) => r.conv === conv)
  const cp = sum(cr, 'prompt'); const cc = sum(cr, 'cached')
  console.log(`  会话 ${conv}：命中 ${(cp ? (100 * cc / cp) : 0).toFixed(2)}%  (${cc} / ${cp})  轮数 ${cr.length}`)
}
console.log(`命中 <50% 的轮：${rows.filter((r) => r.rate < 0.5).map((r) => `${r.conv}-${r.run}-${r.turn}`).join(',') || '无'}`)
console.log(`末轮 prompt=${rows[rows.length - 1].prompt}  tools=${rows[rows.length - 1].tools}`)
if (process.env.CACHE_ASSERT === '1') {
  const okRate = warmRate >= MIN_RATE
  console.log(`${okRate ? 'PASS' : 'FAIL'}: warm 命中率 ${(100 * warmRate).toFixed(2)}% ${okRate ? '≥' : '<'} 目标 ${(100 * MIN_RATE).toFixed(0)}%`)
  process.exit(okRate ? 0 : 1)
}
