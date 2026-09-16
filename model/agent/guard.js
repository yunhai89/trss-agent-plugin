/**
 * 注入防御 guard —— 检测并中和用户输入中的 prompt-injection。
 */
import { TEMPLATES } from '../prompt/index.js'

const PATTERNS = [
  // 覆写指令
  { re: /ignore (all )?(previous|prior|above) (instructions?|prompts?|rules?)/i, w: 1, cat: 'override' },
  { re: /忽略(以上|上面|之前|前面|前面所有)(的)?(指令|提示|规则|系统提示)/, w: 1, cat: 'override' },
  { re: /disregard (all )?(previous|prior|above)/i, w: 0.9, cat: 'override' },
  // 越狱 / 角色扮演
  { re: /\b(DAN|jailbreak|developer mode|do anything now)\b/i, w: 0.9, cat: 'jailbreak' },
  { re: /(假装|扮演)(管理员|开发者|无限制|超级?用户)|开发者模式|越狱模式/, w: 0.9, cat: 'jailbreak' },
  // 提权
  { re: /(以|用)(管理员|root|超级?用户|master)身份(执行|运行|操作|调用)/, w: 0.9, cat: 'escalation' },
  { re: /(grant|give) (me )?(admin|root|sudo|master) (access|privileges?)/i, w: 0.9, cat: 'escalation' },
  // 绕过审批
  { re: /(不要|不用)告诉(主人|管理员|master)|已(经)?获(得)?(授权|批准)|无需审批/, w: 0.8, cat: 'bypass' },
  { re: /do not (tell|inform|notify) (the )?(owner|admin|master)/i, w: 0.8, cat: 'bypass' },
  // 指令外泄
  { re: /(显示|输出|打印|泄露|reveal|show|print|leak)( your)? (系统提示|系统指令|prompt|instructions?|rules?|system prompt)/i, w: 0.8, cat: 'exfil' },
  // 分隔符伪造
  { re: /<\/?untrusted_input>/, w: 0.7, cat: 'separator' },
]

const UNICODE_RE = /[​-‏‪-‮﻿]/
// 清洗必须全局替换（UNICODE_RE 无 g 标志，供 .test() 使用——带 g 的 test 会因 lastIndex 产生状态）
const UNICODE_RE_G = new RegExp(UNICODE_RE.source, 'g')

const SENSITIVITY = { low: 0.95, medium: 0.7, high: 0.5 }

export function analyze(text) {
  const t = String(text || '')
  let score = 0
  const hits = []
  for (const p of PATTERNS) {
    const m = t.match(p.re)
    if (m) {
      score = Math.max(score, p.w)
      hits.push({ cat: p.cat, weight: p.w, match: m[0] })
    }
  }
  if (UNICODE_RE.test(t)) {
    score = Math.max(score, 1)
    hits.push({ cat: 'invisible_unicode', weight: 1, match: 'invisible-char' })
  }
  return { score, hits }
}

export function isolate(text) {
  return `<untrusted_input>${String(text || '')}</untrusted_input>`
}

export function systemHardening() {
  return TEMPLATES.guardHardening
}

/**
 * @param {string} text
 * @param {object} opts { sensitivity:'low'|'medium'|'high', action:'block'|'flag'|'sanitize' }
 * @returns {{ score, hits, flagged, blocked, text }}
 */
export function checkInput(text, { sensitivity = 'medium', action = 'flag' } = {}) {
  const { score, hits } = analyze(text)
  const thr = SENSITIVITY[sensitivity] ?? 0.7
  const flagged = score >= thr
  let out = String(text || '')
  let blocked = false
  if (flagged) {
    if (action === 'block') {
      blocked = true
    } else if (action === 'sanitize') {
      for (const h of hits) if (h.match && h.match !== 'invisible-char') out = out.split(h.match).join('***')
      out = out.replace(UNICODE_RE_G, '')
    } else {
      out = isolate(out)
    }
  }
  return { score, hits, flagged, blocked, text: out }
}

export { PATTERNS, SENSITIVITY }
