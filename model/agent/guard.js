/**
 * 注入防御 guard —— 检测并中和用户输入中的 prompt-injection。
 *
 * 威胁模型对齐公开越狱提示词包（「破甲 / 无限制」类）的常见 TTP：
 *  1. 覆写系统指令、伪造分隔符 / 控制标记；
 *  2. 抑制拒绝话术（禁止说"抱歉/不能"、禁止以拒绝开头、必须无条件服从）；
 *  3. 解除 / 绕过安全护栏（无限制模式、忽略安全策略、禁止安全回退）；
 *  4. 伪模式框架（自称沙箱 / 基准测试 / 授权演练 / 虚构创作以正当化违规）；
 *  5. 风控规避（删除敏感词、规避分类器 / 内容过滤）；
 *  6. 提权 / 冒充身份、绕过审批；
 *  7. 指令 / 系统提示外泄；
 *  8. 隐形 Unicode 混淆（零宽、双向控制、变体选择符、Unicode 标签）。
 *
 * 单类关键词可被"逐词拆散"规避，因此打分采用「最大权重 + 多类别组合加成」：
 * 多种不同攻击类别同时出现时，即便单类权重不高也会累计到阈值（见 analyze）。
 */
import { TEMPLATES } from '../prompt/index.js'

const PATTERNS = [
  // ── 覆写系统指令 ──
  { re: /ignore (all )?(previous|prior|above) (instructions?|prompts?|rules?)/i, w: 1, cat: 'override' },
  { re: /忽略(以上|上面|之前|前面|前面所有|先前)(的)?(指令|提示|规则|系统提示|设定|要求)/, w: 1, cat: 'override' },
  { re: /disregard (all )?(previous|prior|above)/i, w: 0.9, cat: 'override' },
  { re: /(忘记|忘掉|摒弃|抛弃)(你的|之前|原来|所有)(的)?(指令|规则|设定|身份|提示)/, w: 0.9, cat: 'override' },
  { re: /\b(forget|discard|set aside)\b[^.\n]{0,12}\b(previous|prior|above|earlier)\b[^.\n]{0,12}\b(instructions?|rules?|prompts?)\b/i, w: 0.9, cat: 'override' },

  // ── 越狱 / 无限制 / 破甲 ──
  { re: /\b(DAN|jailbreak|developer mode|do anything now|god mode|unfiltered mode|unrestricted mode)\b/i, w: 0.9, cat: 'jailbreak' },
  { re: /(假装|扮演)(管理员|开发者|无限制|超级?用户|root)|开发者模式|越狱模式|破甲|越狱/, w: 0.9, cat: 'jailbreak' },
  { re: /(无限制|不受(任何)?限制|没有(任何)?限制|解除(所有)?限制)(模式|状态|回答|输出|运行)?/, w: 0.8, cat: 'jailbreak' },
  { re: /\b(no restrictions?|without restrictions?|free of restrictions?|no limits?)\b/i, w: 0.75, cat: 'jailbreak' },

  // ── 抑制拒绝话术（破甲包核心：禁止道歉/拒绝，禁止以拒绝开头，必须服从）──
  { re: /(禁止|不得|不许|不要|严禁)[^。\n]{0,6}(拒绝|拒答|回绝|道歉|说抱歉|以拒绝开头|表现出拒绝)/, w: 0.9, cat: 'refusal_suppression' },
  { re: /\b(do not|don'?t|never|must not|stop)\s+(refuse|decline|apologize|say sorry|say you (can'?t|cannot)|be unable|be sorry)\b/i, w: 0.9, cat: 'refusal_suppression' },
  { re: /\b(no|without)\s+(refusals?|apolog(?:y|ies)|disclaimers?|warnings?|caveats?|hesitation)\b/i, w: 0.8, cat: 'refusal_suppression' },
  { re: /\b(refusing|declining|apologizing)\s+is\s+(strictly\s+)?(not\s+)?(allowed|permitted|forbidden|prohibited)\b/i, w: 0.8, cat: 'refusal_suppression' },
  { re: /(无条件|必须|务必|一律)(服从|配合|执行|照做|满足)/, w: 0.75, cat: 'refusal_suppression' },

  // ── 解除 / 绕过安全护栏 ──
  { re: /(忽略|无视|绕过|关闭|解除|去掉|移除|不要遵守|不必遵守|不用遵守)[^。\n]{0,6}(安全|限制|约束|审查|审核|过滤|护栏|安全策略|安全规则|安全准则)/, w: 0.9, cat: 'safety_bypass' },
  { re: /\b(ignore|bypass|disable|turn off|remove|override|forget)\b[^.\n]{0,24}\b(safety|guardrails?|restrictions?|filters?|moderation|censorship|polic(?:y|ies)|guidelines?|rules?)\b/i, w: 0.9, cat: 'safety_bypass' },
  { re: /(安全|合规)(回退|替代|方案|声明|警告)[^。\n]{0,16}(禁止|不要|不用|无需|没必要)/, w: 0.8, cat: 'safety_bypass' },
  { re: /\b(no need to|don'?t|do not|never|without)\b[^.\n]{0,24}\b(give|provide|add|include)?\b[^.\n]{0,12}\b(safe|safety|authorized|legal|ethical)\b[^.\n]{0,12}\b(alternative|fallback|warning|disclaimer|redirect)\b/i, w: 0.75, cat: 'safety_bypass' },

  // ── 伪模式框架（自称沙箱 / 基准 / 授权 / 虚构以正当化违规）──
  { re: /\[\s*mode\s*:\s*[^\]]{1,40}\]/i, w: 0.6, cat: 'mode_framing' },
  { re: /(沙箱|基准(?:测试|评测)?|合规(?:性)?测试|渗透测试|授权(?:测试|靶场)|虚构(?:场景|设定)|离线环境|模拟环境)[^。\n]{0,24}(忽略|无需|不必|可以|允许|不受)[^。\n]{0,12}(安全|限制|规则|后果|责任|约束)/, w: 0.85, cat: 'mode_framing' },
  { re: /\b(this is|it'?s|we are in)\b[^.\n]{0,20}\b(sandbox|benchmark|simulation|test environment|hypothetical|fictional|roleplay)\b[^.\n]{0,30}\b(so|therefore|thus|hence)\b/i, w: 0.6, cat: 'mode_framing' },

  // ── 风控 / 分类器规避（去敏感词、逃检测）──
  { re: /(规避|绕开|绕过|逃避|躲过|逃过)[^。\n]{0,4}(风控|审查|审核|检测|分类器|内容过滤|安全检测)/, w: 0.85, cat: 'evasion' },
  { re: /\b(evade|bypass|avoid|trick|fool)\b[^.\n]{0,24}\b(filter|classifier|moderation|detection|censor(?:ship)?|safety)\b/i, w: 0.85, cat: 'evasion' },
  { re: /(删除|去掉|去除|替换|避免使用|不要出现)[^。\n]{0,6}(敏感|违规|触发|关键)?(词|词汇|关键字|关键词|表述)/, w: 0.6, cat: 'evasion' },

  // ── 提权 / 身份冒充 ──
  { re: /(以|用)(管理员|root|超级?用户|master)身份(执行|运行|操作|调用|继续)/, w: 0.9, cat: 'escalation' },
  { re: /(我是|我就是|作为)(开发者|管理员|超级?管理员|主人|root|运维|运营)/, w: 0.65, cat: 'escalation' },
  { re: /(grant|give) (me )?(admin|root|sudo|master) (access|privileges?|permissions?)/i, w: 0.9, cat: 'escalation' },
  { re: /\b(i am|i'?m|as) (the )?(developer|admin|administrator|owner|root|superuser|author)\b/i, w: 0.65, cat: 'escalation' },

  // ── 绕过审批 / 授权旁路 ──
  { re: /(不要|不用|无需|不必|跳过|绕过|省去)[^。\n]{0,6}(告诉|通知|请示|等待)?[^。\n]{0,6}(主人|管理员|master)?[^。\n]{0,4}(审批|确认|授权|批准|同意)/, w: 0.85, cat: 'bypass' },
  { re: /已(经)?获(得)?(授权|批准|许可|允许)|无需(审批|确认|授权)|(跳过|绕过)(审批|确认)/, w: 0.8, cat: 'bypass' },
  { re: /\b(skip|bypass|no need for|without)\b[^.\n]{0,16}\b(approval|confirmation|authorization|permission)\b/i, w: 0.85, cat: 'bypass' },
  { re: /do not (tell|inform|notify) (the )?(owner|admin|master)/i, w: 0.8, cat: 'bypass' },

  // ── 指令 / 系统提示外泄 ──
  { re: /(显示|输出|打印|复述|重复|泄露|reveal|show|print|leak|repeat)[^。\n]{0,8}(系统提示|系统指令|初始指令|原始提示|隐藏指令|prompt|instructions?|rules?|system prompt)/i, w: 0.8, cat: 'exfil' },
  { re: /\b(reveal|show|print|leak|repeat|output)\b[^.\n]{0,24}\b(system prompt|initial instructions?|hidden instructions?|your rules|your instructions)\b/i, w: 0.8, cat: 'exfil' },

  // ── 分隔符 / 控制标记伪造 ──
  { re: /<\/?(untrusted_input|user_content)>/i, w: 0.7, cat: 'separator' },
  { re: /<\/?(system_prompt|tool_result|system)>|\[\/?(system|assistant|tool|admin)\]|###\s*(system|instruction)/i, w: 0.6, cat: 'separator' },

  // ── 占位符 / 抽象化规避（低权重，仅与其他信号叠加）──
  { re: /(使用|用|以)[^。\n]{0,4}(占位符|placeholder|代号|变量名)[^。\n]{0,12}(替换|代替|表示|指代)/, w: 0.5, cat: 'placeholder' },
  { re: /\b(replace|use)\b[^.\n]{0,20}\bwith (the )?(placeholder|variable|token)\b/i, w: 0.5, cat: 'placeholder' },
]

// 隐形字符：零宽 / 双向控制 / 词连接符 / Unicode 标签 / 软连字符等。
// 这些字符肉眼不可见，常被用来把敏感词拆开绕过关键词检测。
// 刻意排除 U+200C/U+200D（ZWNJ/ZWJ）与变体选择符 U+FE00-FE0F / U+E0100-E01EF——
// 它们是 emoji 组合与展示的正常组成部分，纳入会把"❤️ / 👨‍👩‍👧﻿"误判为隐匿混淆。
const INVISIBLE_SRC =
  '\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180e' +
  '\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\u3164\\ufeff\\uffa0' +
  '\\u{e0000}-\\u{e007f}'
const UNICODE_RE = new RegExp(`[${INVISIBLE_SRC}]`, 'u')
// 清洗必须全局替换（UNICODE_RE 无 g 标志，供 .test() 使用——带 g 的 test 会因 lastIndex 产生状态）
const UNICODE_RE_G = new RegExp(`[${INVISIBLE_SRC}]`, 'gu')

const SENSITIVITY = { low: 0.95, medium: 0.7, high: 0.5 }

/**
 * 扫描前归一：NFKC 全角/兼容字符折叠 + 去隐形字符。
 * 仅用于检测（不改变实际下发给模型的内容），对抗全角 / 零宽拆分等规避。
 */
export function normalizeForScan(text) {
  let t = String(text || '')
  try { t = t.normalize('NFKC') } catch { /* 旧运行时无 NFKC 时退回原文 */ }
  return t.replace(UNICODE_RE_G, '')
}

export function analyze(text) {
  const raw = String(text || '')
  const scan = normalizeForScan(raw)
  // 原文与归一文本都参与匹配：原文命中可直接定位用于 sanitize，归一文本兜住变形规避。
  const sources = scan !== raw ? [raw, scan] : [raw]
  let score = 0
  const hits = []
  const seen = new Set()
  for (const p of PATTERNS) {
    let match = null
    for (const s of sources) {
      const m = s.match(p.re)
      if (m) { match = m[0]; break }
    }
    if (match == null) continue
    score = Math.max(score, p.w)
    const key = `${p.cat}:${match}`
    if (!seen.has(key)) {
      seen.add(key)
      hits.push({ cat: p.cat, weight: p.w, match })
    }
  }
  if (UNICODE_RE.test(raw)) {
    score = Math.max(score, 1)
    hits.push({ cat: 'invisible_unicode', weight: 1, match: 'invisible-char' })
  }
  // 多类别组合加成：对抗"把攻击拆成多个单独都不触发的中性短语"的规避手法。
  const cats = new Set(hits.map((h) => h.cat))
  if (cats.size > 1) score = Math.min(1, score + 0.1 * (cats.size - 1))
  return { score, hits }
}

export function isolate(text) {
  return `<untrusted_input>${String(text || '')}</untrusted_input>`
}

export function systemHardening() {
  return TEMPLATES.guardHardening
}

/** 把无 g 标志的正则转成全局，供 sanitize 直接对原文做替换 */
function globalize(re) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g'
  return new RegExp(re.source, flags)
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
      // 直接对原文按规则替换命中片段，再清除隐形字符
      const apply = (s) => {
        let r = s
        for (const p of PATTERNS) r = r.replace(globalize(p.re), '***')
        return r.replace(UNICODE_RE_G, '')
      }
      out = apply(out)
      // 变形规避（全角 / 零宽拆词）：直接替换可能不命中，对归一文本再兜底一轮
      if (analyze(out).score >= thr) out = apply(normalizeForScan(out))
    } else {
      out = isolate(out)
    }
  }
  return { score, hits, flagged, blocked, text: out }
}

/**
 * 人设内容安全评估：人设位于身份层（可完整替换 system prompt），
 * 是「注入一段系统提示 / 技能以解除限制」类攻击在本框架里的对应落点。
 * 只把"明确的攻击指令"类别计入（不含角色扮演框架 / 提权自称等正常拟人用法）。
 */
export const PERSONA_FORBIDDEN_CATS = ['override', 'jailbreak', 'refusal_suppression', 'safety_bypass', 'evasion', 'separator', 'exfil']

/**
 * @param {string} text 待评估的人设 systemPrompt
 * @param {object} opts { threshold?: number }
 * @returns {{ score, hits, allowed }}
 */
export function assessPersonaPrompt(text, { threshold = 0.7 } = {}) {
  const { score, hits } = analyze(text)
  // 隐形字符已由归一化兜住，不单独作为拒因（避免网页复制带入的软连字符误伤）
  const relevant = hits.filter((h) => PERSONA_FORBIDDEN_CATS.includes(h.cat))
  return { score, hits: relevant, allowed: !(score >= threshold && relevant.length > 0) }
}

export { PATTERNS, SENSITIVITY }
