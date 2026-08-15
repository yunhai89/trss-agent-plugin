#!/usr/bin/env node
/**
 * 伪人链路 × SelfState 集成层离线回归（只读检查，不改任何现有文件）。
 *
 * 覆盖：
 *  1. apps/humanize.js Humanize 类作用域静态检查（防 onAmbient 类 ssLazy/rt 越域引用复发）
 *  2. HumanizePlanner getSelfProjection 注入 + 失败降级（fake provider 拦截 system）
 *  3. HumanizeReplyer getSelfCapsule 注入 + 失败降级
 *  4. TurnScheduler._notifyDelivered info 字段（sentText/replyGuide/sourceMessageId）
 *  5. buildPlannerSystem/buildReplyerSystem 空块无 {{xxx}} 残留
 *
 * 运行：node stress/integration.mjs   （纯离线：不 import apps/humanize.js——它依赖 Yunzai 全局
 *  plugin/Bot，import 即炸；作用域检查用纯文本分析，其余四项直接 import model/ 下无 Yunzai 依赖的模块。）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const results = []
function report(name, ok, evidence) {
  results.push({ name, ok, evidence })
  console.log(`${ok ? '✓' : '✗'} ${name}${evidence ? ` — ${evidence}` : ''}`)
}
function assert(name, cond, evidence) { report(name, !!cond, evidence) }

// ════════════════════ 1. Humanize 类作用域静态检查 ════════════════════
// 方法：纯文本分析。无法 import apps/humanize.js（import '../../../lib/plugins/plugin.js'
// 在 Yunzai 之外不存在），故用 new Function 同样不可行——直接对源码做词法级清理 +
// 方法体抽取 + 标识符/声明比对。

const KEYWORDS = new Set(('const let var function return if else for of in while do try catch finally new await async class extends super this typeof instanceof void throw switch case break continue default delete yield static get set true false null undefined arguments import export from as of').split(' '))
const GLOBALS = new Set(('console JSON Math Date Number String Boolean Array Object Promise Set Map WeakSet WeakMap Symbol RegExp Error TypeError RangeError SyntaxError AbortController AbortSignal parseInt parseFloat isNaN isNaN setTimeout clearTimeout setInterval clearInterval fetch globalThis NaN Infinity undefined Bot process require module exports window document TextEncoder TextDecoder URL URLSearchParams BigInt Proxy Reflect Function structuredClone queueMicrotask crypto global self scheduleMicrotask structuredClone atob btoa Intl').split(' '))

/** 词法级清理：去掉注释/字符串/模板字面量正文（保留 ${} 内表达式）/正则字面量 → 只剩代码骨架。 */
function stripCode(src) {
  let out = ''
  let i = 0, n = src.length
  const prevSig = () => { for (let j = out.length - 1; j >= 0; j--) { if (!/\s/.test(out[j])) return out[j] } return '' }
  while (i < n) {
    const c = src[i], c2 = src[i + 1]
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
    if (c === "'" || c === '"') { const q = c; i++; while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++ } i++; out += '""'; continue }
    if (c === '`') {
      i++
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '$' && src[i + 1] === '{') {
          // 保留插值表达式：找匹配 }（粗略：嵌套计数）
          let depth = 0, j = i + 1
          for (; j < n; j++) {
            if (src[j] === '{') depth++
            else if (src[j] === '}') { depth--; if (!depth) break }
          }
          out += '(' + stripCode(src.slice(i + 2, j)) + ')'
          i = j + 1; continue
        }
        i++
      }
      i++; out += '``'; continue
    }
    if (c === '/') {
      // 正则字面量判定：前一个有效字符不是标识符/数字/')'/']' → 是正则而非除法
      const p = prevSig()
      if (!/[\w$)\]]/.test(p)) {
        let j = i + 1, cls = false
        for (; j < n; j++) {
          const d = src[j]
          if (d === '\\') { j++; continue }
          if (d === '[') cls = true
          else if (d === ']') cls = false
          else if (d === '/' && !cls) break
          else if (d === '\n') break
        }
        if (j < n && src[j] === '/') { j++; while (j < n && /[gimsuy]/.test(src[j])) j++; out += '0'; i = j; continue }
      }
    }
    out += c; i++
  }
  return out
}

/** 抽取 class Humanize 的各方法体。 */
function extractMethods(cleanClass) {
  const methods = []
  const re = /(?:^|\n)[ \t]*(?:(?:async|static|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\(/g
  let m
  while ((m = re.exec(cleanClass))) {
    const name = m[1]
    if (KEYWORDS.has(name)) continue
    // 找方法头参数表的匹配 ')'，再找方法体 '{...}'
    let i = re.lastIndex, depth = 1
    while (i < cleanClass.length && depth) { if (cleanClass[i] === '(') depth++; else if (cleanClass[i] === ')') depth--; i++ }
    while (i < cleanClass.length && cleanClass[i] !== '{') { if (cleanClass[i] === ';') break; i++ }
    if (cleanClass[i] !== '{') continue
    const bodyStart = i + 1
    let j = bodyStart, d = 1
    while (j < cleanClass.length && d) { if (cleanClass[j] === '{') d++; else if (cleanClass[j] === '}') d--; j++ }
    methods.push({ name, params: cleanClass.slice(re.lastIndex, i - 1), body: cleanClass.slice(bodyStart, j - 1) })
    re.lastIndex = j
  }
  return methods
}

/** 从一段参数/声明文本里抽标识符（去掉默认值部分）。 */
function identsOf(text) {
  const out = new Set()
  const re = /(?<![.\w$'"`])([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(text))) if (!KEYWORDS.has(m[1])) out.add(m[1])
  return out
}

function scopeCheck() {
  const src = fs.readFileSync(path.join(ROOT, 'apps/humanize.js'), 'utf8')
  const cleaned = stripCode(src)
  const clsMatch = cleaned.match(/export\s+class\s+Humanize\b/)
  if (!clsMatch) { report('1.作用域检查：找到 Humanize 类', false, 'apps/humanize.js 中未找到 export class Humanize'); return }
  // 类体：从 class 后首个 '{' 到匹配 '}'
  const clsStart = cleaned.indexOf('{', clsMatch.index + clsMatch[0].length - 1)
  let d = 1, j = clsStart + 1
  while (j < cleaned.length && d) { if (cleaned[j] === '{') d++; else if (cleaned[j] === '}') d--; j++ }
  const clsBody = cleaned.slice(clsStart + 1, j - 1)

  // 模块级已知名：类体之外的 import 绑定 + 顶层/嵌套函数声明 + const/let/var（取超集，安全方向=少误报）
  const outside = cleaned.slice(0, clsStart) + cleaned.slice(j)
  const moduleKnown = new Set()
  for (const mm of outside.matchAll(/\bimport\s+([^'"]+?)\s+from/g)) {
    for (const part of mm[1].split(',')) {
      const t = part.trim()
      let k = t.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/); if (k) { moduleKnown.add(k[1]); continue }
      k = t.match(/^([A-Za-z_$][\w$]*)$/); if (k) { moduleKnown.add(k[1]); continue }
      k = t.match(/\{(.*)\}/s); if (k) for (const b of k[1].split(',')) { const nm = b.trim().split(/\s+as\s+/).pop().trim(); if (/^[A-Za-z_$][\w$]*$/.test(nm)) moduleKnown.add(nm) }
    }
  }
  for (const mm of outside.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) moduleKnown.add(mm[1])
  for (const mm of outside.matchAll(/\b(?:const|let|var)\s+([^\n;=]+)/g)) for (const id of identsOf(mm[1])) moduleKnown.add(id)
  for (const mm of outside.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) moduleKnown.add(mm[1])

  const methods = extractMethods(clsBody)
  const summary = []
  let bad = 0
  for (const m of methods) {
    // 方法内声明：参数、const/let/var、function、class、catch 参数、箭头函数参数、for 头
    const local = new Set()
    for (const p of m.params.split(',')) { const seg = p.split('=')[0]; for (const id of identsOf(seg)) local.add(id) }
    for (const mm of m.body.matchAll(/\b(?:const|let|var)\s+([^\n;=]+)/g)) for (const id of identsOf(mm[1])) local.add(id)
    for (const mm of m.body.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) local.add(mm[1])
    for (const mm of m.body.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) local.add(mm[1])
    for (const mm of m.body.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) local.add(mm[1])
    for (const mm of m.body.matchAll(/\(([^()=]*)\)\s*=>/g)) for (const id of identsOf(mm[1])) local.add(id)
    for (const mm of m.body.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) local.add(mm[1])

    // 引用：去对象字面量键（ident: 形式）后抽非属性标识符
    const bodyNoKeys = m.body.replace(/([{,(]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1')
    const refs = identsOf(bodyNoKeys)
    const unknown = [...refs].filter((r) => !local.has(r) && !moduleKnown.has(r) && !GLOBALS.has(r))
    if (unknown.length) {
      bad++
      summary.push(`  方法 ${m.name}(): 疑似未定义引用 → ${unknown.join(', ')}`)
    }
  }
  const focus = methods.find((m) => m.name === 'onAmbient')
  report('1a.Humanize 类方法抽取（含 onAmbient）', !!focus, `共 ${methods.length} 个方法：${methods.map((m) => m.name).join('、')}`)
  if (summary.length) {
    report('1b.作用域静态检查（无未定义引用）', false, '\n' + summary.join('\n'))
  } else {
    report('1b.作用域静态检查（无未定义引用）', true, `${methods.length} 个方法全部通过（引用 ⊆ 局部声明 ∪ 模块级 ∪ 全局白名单）`)
  }
  // onAmbient 专项：必须通过 h.* 前缀引用装配期闭包产物，禁止裸引用 ssLazy/rt/cfgFn/manager/store/trace
  const raw = src  // 用原始源码看真实引用形态（含前缀）
  const ambStart = raw.indexOf('async onAmbient()')
  const ambEnd = raw.indexOf('async humanizeStatus()')
  const ambSrc = raw.slice(ambStart, ambEnd > 0 ? ambEnd : undefined)
  const bare = [...ambSrc.matchAll(/(?<![.\w$'"`])(ssLazy|rt|cfgFn|manager|store|trace|memory|getPersona|gwLazy|ssPlannerProj|ssReplyerCap|ssOnDelivered|gwOnDelivered|EMPTY_SCENE|NEUTRAL)\b/g)]
  report('1c.onAmbient 无裸引用装配期闭包变量（ssLazy/rt/...）', bare.length === 0,
    bare.length ? `发现裸引用 ${bare.length} 处: ${bare.map((b) => `行${raw.slice(0, b.index).split('\n').length}「${b[1]}」`).join(' ')}` : `h.ssLazy/h.getPersona 走前缀（h.* 出现 ${ambSrc.match(/\bh\./g)?.length || 0} 次）`)
  return bad
}

// ════════════════════ 2/3. Planner / Replyer 注入（fake provider） ════════════════════

const PROJ_TEXT = '【自我状态偏置】心境：有点低落（分值 38/100），对复读/玩梗意愿降低，倾向短句。'
const CAP_TEXT = '【自我状态胶囊】当前心境偏低谷：多用短句，少用感叹号，不主动抛梗。'

function fakeProvider(capture, respond) {
  return {
    chat: async (params) => { capture.push(params); return respond() },
  }
}

const msg = {
  id: 'm1', groupId: 'g1', userId: 'u1', displayName: '阿卡', text: '你们觉得这个插件的新功能怎么样',
  timestamp: Date.now(), segments: [{ type: 'text', text: '你们觉得这个插件的新功能怎么样' }], media: [],
  isSelf: false, isCommand: false, handledByDirectAgent: false, atBot: false, quotesBot: false,
  mentionsBotName: false, replyToId: null,
}
const runtimeStub = () => ({ groupId: 'g1', trace: { record() {} } })

async function plannerTests() {
  const { HumanizePlanner } = await import('../model/humanize/planner.js')

  // 2a. 注入命中
  {
    const cap = []
    const p = new HumanizePlanner({
      provider: fakeProvider(cap, () => ({ content: '(内部分析)', toolCalls: [{ id: 'c1', name: 'human_ignore', arguments: { reason: 'test' } }], usage: null })),
      cfg: {}, readTools: [],
      getSelfProjection: async () => ({ neutral: false, text: PROJ_TEXT }),
    })
    const action = await p.decide({
      snapshot: [msg],
      decision: { finalScore: 90, threshold: 80, shouldPlan: true, positiveReasons: ['a'], negativeReasons: [], targetMessage: msg },
      runtime: runtimeStub(), cfg: {},
    })
    const sys = cap[0]?.system || ''
    report('2a.Planner 注入 getSelfProjection 文本进 system', sys.includes(PROJ_TEXT),
      `action=${action.type}；system 含偏置段=${sys.includes(PROJ_TEXT)}（system 长度 ${sys.length}）`)
  }
  // 2b. 抛错降级（零影响）
  {
    const cap = []
    let threw = false
    const p = new HumanizePlanner({
      provider: fakeProvider(cap, () => ({ content: '(内部分析)', toolCalls: [{ id: 'c1', name: 'human_ignore', arguments: { reason: 'test' } }], usage: null })),
      cfg: {}, readTools: [],
      getSelfProjection: async () => { throw new Error('boom') },
    })
    let action
    try {
      action = await p.decide({
        snapshot: [msg],
        decision: { finalScore: 90, threshold: 80, shouldPlan: true, positiveReasons: ['a'], negativeReasons: [], targetMessage: msg },
        runtime: runtimeStub(), cfg: {},
      })
    } catch (e) { threw = true }
    const sys = cap[0]?.system || ''
    report('2b.Planner getSelfProjection 抛错 → 不抛错且 prompt 无该段', !threw && !sys.includes('自我状态偏置') && !/\{\{selfStateBlock\}\}/.test(sys),
      `planner 抛错=${threw}；action=${action?.type}；system 残留偏置=${sys.includes(PROJ_TEXT)}；残留占位=${/\{\{\w+\}\}/.test(sys)}`)
  }
  // 2c. 中性（neutral:true）不注入
  {
    const cap = []
    const p = new HumanizePlanner({
      provider: fakeProvider(cap, () => ({ content: '', toolCalls: [{ id: 'c1', name: 'human_ignore', arguments: { reason: 'test' } }], usage: null })),
      cfg: {}, readTools: [],
      getSelfProjection: async () => ({ neutral: true, text: '' }),
    })
    await p.decide({
      snapshot: [msg],
      decision: { finalScore: 90, threshold: 80, shouldPlan: true, positiveReasons: ['a'], negativeReasons: [], targetMessage: msg },
      runtime: runtimeStub(), cfg: {},
    })
    report('2c.Planner neutral:true → prompt 无偏置段', !(cap[0]?.system || '').includes('【自我状态'), '中性投影被过滤（text 空 → selfStateBlock 空）')
  }
}

async function replyerTests() {
  const { HumanizeReplyer } = await import('../model/humanize/replyer.js')
  const action = { type: 'human_reply', targetMessageId: 'm1', replyGuide: '对新功能表达好奇', toneHint: '随口', quote: false }

  // 3a. 注入命中
  {
    const cap = []
    const r = new HumanizeReplyer({
      provider: fakeProvider(cap, () => ({ content: '我觉得还行，就是文档有点绕' })),
      cfg: {},
      getPersonaVoice: async () => '角色声音：低调群友',
      getSelfCapsule: async () => ({ neutral: false, text: CAP_TEXT }),
    })
    const res = await r.generate({ action, batch: [msg], target: msg, runtime: runtimeStub(), cfg: {} })
    const sys = cap[0]?.system || ''
    report('3a.Replyer 注入 getSelfCapsule 文本进 system', sys.includes(CAP_TEXT),
      `生成文本「${res.text.slice(0, 20)}…」cancel=${res.cancelReason || '无'}；system 含胶囊=${sys.includes(CAP_TEXT)}`)
  }
  // 3b. 抛错降级
  {
    const cap = []
    let threw = false
    const r = new HumanizeReplyer({
      provider: fakeProvider(cap, () => ({ content: '好耶' })),
      cfg: {},
      getPersonaVoice: async () => '角色声音：低调群友',
      getSelfCapsule: async () => { throw new Error('boom') },
    })
    let res
    try { res = await r.generate({ action, batch: [msg], target: msg, runtime: runtimeStub(), cfg: {} }) } catch (e) { threw = true }
    const sys = cap[0]?.system || ''
    report('3b.Replyer getSelfCapsule 抛错 → 不抛错且 prompt 无该段', !threw && !sys.includes('自我状态胶囊') && !/\{\{\w+\}\}/.test(sys),
      `replyer 抛错=${threw}；生成文本「${res?.text}」；system 残留=${/\{\{\w+\}\}/.test(sys)}`)
  }
}

// ════════════════════ 4. TurnScheduler._notifyDelivered ════════════════════

async function schedulerTests() {
  const { TurnScheduler } = await import('../model/humanize/turn-scheduler.js')
  const infos = []
  const runtime = { groupId: 'g1', bindDriver() {} }
  const sched = new TurnScheduler({ runtime, cfg: {}, planner: null, replyer: null, composer: null, send: null, onDelivered: async (info) => { infos.push(info) } })

  const target = { userId: 'u9', quotesBot: true, atBot: false }
  await sched._notifyDelivered(target, { sentText: '这是真实发出的回复', replyGuide: '回应提问', sourceMessageId: 'sm-42' })
  const info = infos[0]
  report('4a._notifyDelivered info 含非空 sentText/replyGuide/sourceMessageId',
    info && info.sentText === '这是真实发出的回复' && info.replyGuide === '回应提问' && info.sourceMessageId === 'sm-42',
    info ? `groupId=${info.groupId} targetUserId=${info.targetUserId} kind=${info.kind} sentText="${info.sentText}" replyGuide="${info.replyGuide}" sourceMessageId=${info.sourceMessageId}` : 'onDelivered 未被调用')
  report('4b.kind 判定（quotesBot → reply_to_bot）', info?.kind === 'reply_to_bot', `kind=${info?.kind}`)

  // onDelivered 抛错不影响发送链路（_notifyDelivered 吞异常）
  let boomCaught = false
  const sched2 = new TurnScheduler({ runtime, cfg: {}, planner: null, replyer: null, composer: null, send: null, onDelivered: async () => { throw new Error('ss down') } })
  try { await sched2._notifyDelivered(target, { sentText: 'x' }) } catch { boomCaught = true }
  report('4c.onDelivered 抛错被吞（不影响主链路）', !boomCaught, '异常静默，主流程继续')

  // 无 onDelivered / 无 target：直接返回不炸
  const sched3 = new TurnScheduler({ runtime, cfg: {}, planner: null, replyer: null, composer: null, send: null })
  let ok3 = true
  try { await sched3._notifyDelivered(null) } catch { ok3 = false }
  report('4d.无 target / 无 onDelivered 安全跳过', ok3, '空 target 短路返回')
}

// ════════════════════ 5. 空块模板无 {{xxx}} 残留 ════════════════════

async function templateTests() {
  const { buildPlannerSystem, buildReplyerSystem } = await import('../model/humanize/prompts.js')
  const ps = buildPlannerSystem({})
  const rs = buildReplyerSystem({})
  const leftP = ps.match(/\{\{\w+\}\}/g) || []
  const leftR = rs.match(/\{\{\w+\}\}/g) || []
  report('5a.buildPlannerSystem 全空 → 无 {{xxx}} 残留', leftP.length === 0, `残留=${JSON.stringify(leftP)}；兜底文案齐备=${['（未提供行为政策）', '（本轮未提供评分）', '（暂无上下文）', '（无可用群公开记忆）'].every((t) => ps.includes(t))}`)
  report('5b.buildReplyerSystem 全空 → 无 {{xxx}} 残留', leftR.length === 0, `残留=${JSON.stringify(leftR)}；兜底文案齐备=${['（未提供具体回复意图）', '（暂无）'].every((t) => rs.includes(t))}`)
  // 顺带：空 socialScene/selfState 块不应留下孤行「【可用群公开记忆】」后的多余空结构
  report('5c.空 selfState/socialScene 不残留自我状态措辞', !ps.includes('自我状态') && !rs.includes('胶囊'), '空块被整段移除')
}

// ════════════════════ 执行 ════════════════════

console.log('== 伪人链路 × SelfState 集成层离线回归 ==\n')
let failed = 0
try { scopeCheck() } catch (e) { report('1.作用域静态检查（执行本身）', false, String(e?.stack || e).split('\n')[0]) }
await plannerTests()
await replyerTests()
await schedulerTests()
await templateTests()

failed = results.filter((r) => !r.ok).length
console.log(`\n== 结果：${results.length - failed}/${results.length} 通过 ==`)
process.exit(failed ? 1 : 0)
