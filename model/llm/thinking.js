/**
 * 思考（reasoning）自动决策 —— 按用户提问复杂度决定「是否思考」与「思考深度/预算」，
 * 并按各厂商**文档规定的传输字段**编码成 provider 原生参数（不把统一语义硬塞给厂商）。
 *
 * 决策链：
 *   classifyComplexity(text) → { depth: off|low|medium|high, score, reasons, budget }
 *   encodeThinking({ depth, budget, protocol, preset, model, style }) → provider 字段对象
 *
 * 厂商传输形式（依据各厂商官方文档，随 presets.thinkingStyle 单一真源）：
 *   - reasoning_effort     OpenAI 系（o/gpt-5）、Azure、Gemini(OpenAI 兼容)、OpenRouter
 *   - deepseek             DeepSeek：thinking:{type} + reasoning_effort(low|high|max)
 *   - enable_thinking      DashScope/Qwen：enable_thinking + thinking_budget
 *   - thinking_toggle      MiMo/Kimi/GLM/豆包 等：thinking:{type:'enabled'|'disabled'}
 *   - minimax              MiniMax-M3：thinking:{type:'adaptive'|'disabled'}
 *   - anthropic_budget     Anthropic 及兼容：thinking:{type:'enabled', budget_tokens}
 *   - auto                 网关（opencode 等）：按 model 名回退到上面之一
 */

/** 深度档位（从低到高） */
import { presets as openaiPresets } from '../openai/presets.js'
import { presets as anthropicPresets } from '../anthropic/presets.js'

export const DEPTHS = ['off', 'low', 'medium', 'high']
/** 各深度默认思考预算（tokens；质量优先，取值偏宽松） */
export const DEFAULT_BUDGETS = { low: 4096, medium: 8192, high: 16384 }
/** 自动预算硬顶（防单轮烧太多） */
export const DEFAULT_MAX_BUDGET = 32768

// ── 复杂度信号 ──
const CASUAL_RE = /^(?:哈+|嘿+|嗨+|在吗|在么|你好|您好|hi|hello|早|早安|晚安|谢谢|多谢|好的|好|嗯|哦|噢|收到|ok|okk|哈哈+|笑死|6+|？+|…+|\.{3,})[\s!！。.?？~～,，]*$/i
const CODE_RE = /```|`[^`\n]+`|\b(?:func|def|class|const|let|var|import|export|return|SELECT|INSERT|UPDATE|npm|pnpm|docker|git|curl|api|json|regex)\b/i
const MATH_RE = /计算|求解|证明|推导|方程|积分|导数|概率|排列|组合|复利|矩阵|复杂度|多少|几[个次倍%]|[\d(]\s*[\d\s+\-*/^().%]{3,}/
const ANALYSIS_RE = /为什么|为何|原理|机制|架构|设计|实现|重构|优化|排查|调试|debug|报错|异常|分析|对比|区别|评估|方案|规划|推理|逻辑|策略|权衡|优缺点|步骤|流程|怎么|如何|原因|思路|算法|选型|影响|风险|取舍/g
const MULTI_RE = /然后|接着|分别|先.{0,12}再|并且|同时|批量|逐个|逐条|一一|列表|分点/
const TASK_RE = /搜索|搜一下|查一下|查查|爬取|抓取|下载|部署|安装|写(?:个|一个)?(?:脚本|代码|程序|函数|工具)|定时|监控|发(?:给|到)|整理成|导出|生成.{0,10}(?:图|表|文档|报告)|翻译|润色|改写|总结|帮我(?:做|查|找|写|整理)/
const HEAVY_RE = /架构|系统设计|分布式|并发|性能优化|安全审计|逆向|论证|论文|综述|深度研究|调研报告|完整实现|从零|端到端|设计方案|技术选型|微服务|数据库设计|高可用|一致性|容错/
// 显式要求"讲深/讲透" → 升档；显式要求"简短/快点" → 降档
const DEPTH_ASK_RE = /详细|深入|严谨|系统(?:性)?|全面|逐[一二三]步|一步一步|逐步|慢慢|认真|仔细|多角度|批判|充分论证|展开讲|长一点|长篇|深度(?:分析|讲解|探讨)/
const BREVITY_RE = /简短|一句话|简单说|简明|别废话|不用解释|不用太详细|简单点|大概|粗略|随便说|快点|急用|越短越好/
// 约束/边界条件：往往需要更谨慎地推理
const CONSTRAINT_RE = /至少|至多|不超过|必须|不能|禁止|约束|限制|边界条件|极端情况|异常情况|前提|假设条件|兼容性/
// 创作类：需要一些构思，但不必深度推理
const CREATIVE_RE = /写(?:一?首|一?段|个故事|篇)|起名|取名|文案|吐槽|段子|写诗|对联|创意|头脑风暴/

/**
 * 提问复杂度分类（确定性规则，零额外调用；可测）。
 * @returns {{depth:'off'|'low'|'medium'|'high', score:number, budget:number, reasons:string[]}}
 */
export function classifyComplexity(text, { budgets = DEFAULT_BUDGETS, maxBudget = DEFAULT_MAX_BUDGET, forceDepth = null } = {}) {
  const s = String(text || '').trim()
  const reasons = []
  if (forceDepth && DEPTHS.includes(forceDepth)) {
    return { depth: forceDepth, score: 0, budget: clampBudget(forceDepth, budgets, maxBudget), reasons: ['forced'] }
  }
  if (!s) return { depth: 'off', score: 0, budget: 0, reasons: ['empty'] }
  // 纯寒暄/短应答 → 不思考
  if (CASUAL_RE.test(s)) return { depth: 'off', score: 0, budget: 0, reasons: ['casual'] }

  let score = 0
  const len = s.length
  if (len >= 600) { score += 3; reasons.push('len>=600') }
  else if (len >= 250) { score += 2; reasons.push('len>=250') }
  else if (len >= 80) { score += 1; reasons.push('len>=80') }

  if (CODE_RE.test(s)) { score += 2; reasons.push('code') }
  if (MATH_RE.test(s)) { score += 2; reasons.push('math') }
  const ana = (s.match(ANALYSIS_RE) || []).length
  if (ana) { score += Math.min(ana, 3); reasons.push(`analysis×${ana}`) }
  if (MULTI_RE.test(s)) { score += 1; reasons.push('multi-step') }
  if (TASK_RE.test(s)) { score += 1; reasons.push('task') }
  if (HEAVY_RE.test(s)) { score += 3; reasons.push('heavy') }
  if (CONSTRAINT_RE.test(s)) { score += 1; reasons.push('constraint') }
  if (CREATIVE_RE.test(s)) { score += 1; reasons.push('creative') }
  if ((s.match(/[?？]/g) || []).length >= 2) { score += 1; reasons.push('multi-question') }
  if ((s.match(/[。；;!！?？]/g) || []).length >= 3) { score += 1; reasons.push('multi-clause') }
  if (DEPTH_ASK_RE.test(s)) { score += 2; reasons.push('depth-ask') }
  if (BREVITY_RE.test(s)) { score -= 2; reasons.push('brevity-ask') }
  // 大段代码/数据往往需要理解而非泛泛回答（小段则不再额外加）
  if (/```/.test(s) && len >= 200) { score += 1; reasons.push('long-code') }

  let depth
  if (score >= 5) depth = 'high'
  else if (score >= 3) depth = 'medium'
  else if (score >= 1) depth = 'low'
  else depth = (len >= 30 ? 'low' : 'off') // 无信号但话题较长的普通提问给最低档
  return { depth, score, budget: clampBudget(depth, budgets, maxBudget), reasons }
}

function clampBudget(depth, budgets, maxBudget) {
  if (depth === 'off') return 0
  const b = Number(budgets?.[depth]) || DEFAULT_BUDGETS[depth] || 0
  const cap = Number(maxBudget) || DEFAULT_MAX_BUDGET
  return Math.max(0, Math.min(b, cap))
}

/** depth → reasoning_effort 档（low/medium/high） */
function effortOf(depth) {
  return depth === 'high' ? 'high' : depth === 'low' ? 'low' : 'medium'
}
/** DeepSeek effort 映射（官方：medium/xhigh→high；low→low） */
function deepseekEffort(depth) {
  return depth === 'low' ? 'low' : 'high'
}

/**
 * 按协议/预设/模型选择思考传输风格。presets.thinkingStyle 为单一真源，缺失时按协议回退。
 */
export function resolveThinkingStyle({ protocol = 'openai', preset = '', model = '', presetStyle = '' } = {}) {
  if (presetStyle) return presetStyle
  if (protocol === 'gemini') return 'gemini_level' // 原生 Gemini SDK 用 thinking_level
  // 厂商预设表为单一真源（model/openai|anthropic/presets.js 的 thinkingStyle）
  const table = protocol === 'anthropic' ? anthropicPresets : openaiPresets
  const fromPreset = table?.[preset]?.thinkingStyle
  if (fromPreset && fromPreset !== 'auto') return fromPreset
  if (protocol === 'anthropic') return 'anthropic_budget'
  // 网关（thinkingStyle='auto'）或未知预设：按模型名回退
  if (/^o[134]|^gpt-5/i.test(model)) return 'reasoning_effort'
  if (/gemini/i.test(model)) return 'reasoning_effort'
  if (/claude/i.test(model)) return protocol === 'anthropic' ? 'anthropic_budget' : 'thinking_toggle'
  return 'thinking_toggle'
}

/**
 * 编码为 provider 原生字段（合并进 chat opts）。
 * @returns {object} 例如 { thinking:{type:'enabled'} } / { reasoning_effort:'high' } / { enable_thinking:true, thinking_budget:N }
 */
export function encodeThinking({ depth = 'off', budget = 0, protocol = 'openai', preset = '', model = '', style = '' } = {}) {
  const st = resolveThinkingStyle({ protocol, preset, model, presetStyle: style })
  const on = depth !== 'off'
  const b = on ? (Number(budget) || DEFAULT_BUDGETS[depth] || 0) : 0
  switch (st) {
    case 'reasoning_effort':
      return on ? { reasoning_effort: effortOf(depth) } : {}
    case 'deepseek':
      return on ? { thinking: { type: 'enabled' }, reasoning_effort: deepseekEffort(depth) } : { thinking: { type: 'disabled' } }
    case 'enable_thinking':
      return on ? { enable_thinking: true, thinking_budget: b } : { enable_thinking: false }
    case 'minimax':
      return on ? { thinking: { type: 'adaptive' } } : { thinking: { type: 'disabled' } }
    case 'gemini_level':
      return on ? { thinking: { thinking_level: effortOf(depth) } } : {}
    case 'anthropic_budget':
      return on ? { thinking: { type: 'enabled', budget_tokens: b } } : { thinking: { type: 'disabled' } }
    case 'thinking_toggle':
    default:
      return on ? { thinking: { type: 'enabled' } } : { thinking: { type: 'disabled' } }
  }
}

/** 自动思考决策一步到位（规则版，供 Agent 调用/测试）。 */
export function decideThinking(text, { protocol, preset, model, style, budgets, maxBudget } = {}) {
  const c = classifyComplexity(text, { budgets, maxBudget })
  const encoded = encodeThinking({ depth: c.depth, budget: c.budget, protocol, preset, model, style })
  return { ...c, ...encoded, style: resolveThinkingStyle({ protocol, preset, model, presetStyle: style }) }
}

/**
 * [chat] 日志的思考字段（纯函数，供应用层调用）：
 *  - thinkingAuto=on：depth=档位 budget=预算 by=model|rule（小模型还是规则判的）
 *  - thinkingAuto=off：thinking=on/off（静态）+ 其 budget（若有）
 */
export function thinkingLogFields({ thinkInfo = null, thinking = null } = {}) {
  if (thinkInfo && thinkInfo.auto) {
    const by = thinkInfo.source === 'model' ? 'model' : ((thinkInfo.source === 'rule' || thinkInfo.source === 'rule-fallback') ? 'rule' : '-')
    const budget = thinkInfo.budget != null ? thinkInfo.budget : '-'
    return `thinkingAuto=on depth=${thinkInfo.depth || '-'} budget=${budget} by=${by}`
  }
  const on = !!thinking && thinking.type !== 'disabled'
  const cap = thinking && thinking.budget_tokens != null ? ` budget=${thinking.budget_tokens}` : ''
  return `thinkingAuto=off thinking=${on ? 'on' : 'off'}${cap}`
}

// ───────────────────────── 小模型分类器（hybrid） ─────────────────────────

const CLASSIFIER_PROMPT = [
  '你是对话复杂度判别器：判断用户这句话在回答前是否需要"思考(reasoning)"，以及思考深度档位。',
  '档位定义：',
  '- off：闲聊/寒暄/情绪应答/简单事实/纯执行指令/不需要推理的短问答；',
  '- low：简单问答、轻量改写翻译、单一明确请求；',
  '- medium：需要解释推理、读代码/改写、多步任务、常规排错、有约束条件的请求；',
  '- high：复杂设计/架构、数学推导或证明、多约束权衡、长篇深度任务、需要严谨论证。',
  '判断要点：用户表述很短但问题本身需要推理→不要只看长度；表面啰嗦但无推理需求→可给低档。',
  '只输出 JSON，不要解释：{"depth":"off|low|medium|high","reason":"不超过12字"}。不确定时取较低档。',
].join('\n')

/** 从模型输出提取合法 depth（容错 code fence / 前后缀 / 大小写）。非法返回 null。 */
export function parseClassifierOutput(text) {
  if (!text) return null
  const s = String(text)
  const i = s.indexOf('{'); const j = s.lastIndexOf('}')
  const body = (i >= 0 && j > i) ? s.slice(i, j + 1) : s
  let obj = null
  try { obj = JSON.parse(body) } catch { /* 退化为正则 */ }
  let depth = obj?.depth
  if (depth == null) {
    const m = s.match(/"depth"\s*:\s*"?\s*(off|low|medium|high)/i) || s.match(/depth\s*[:：=]\s*"?\s*(off|low|medium|high)/i)
    depth = m?.[1]
  }
  depth = String(depth || '').trim().toLowerCase()
  return DEPTHS.includes(depth) ? depth : null
}

function _withTimeout(p, ms) {
  if (!ms || ms <= 0) return p
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms) })
  return Promise.race([Promise.resolve(p).catch(() => null), timeout]).finally(() => clearTimeout(timer))
}

/**
 * 用小模型判档。返回 { depth, reasons:['model'], source:'model' } 或 null（失败/超时/解析失败）。
 * llm 兼容 recallLlm 形态：llm.run(prompt) 或 llm(prompt)，返回 {content} 或字符串。
 */
export async function classifyWithModel(text, { llm, timeoutMs = 2500, context = '' } = {}) {
  if (!llm || !text) return null
  const prompt = `${CLASSIFIER_PROMPT}\n\n${context ? `【最近对话】\n${context}\n\n` : ''}【用户消息】\n${text}`
  const call = (typeof llm.run === 'function') ? llm.run(prompt) : llm(prompt)
  const res = await _withTimeout(call, timeoutMs)
  const content = res?.content ?? res
  const depth = parseClassifierOutput(content)
  if (!depth) return null
  return { depth, score: null, reasons: ['model'], source: 'model' }
}

// 判档缓存：同一问题短时间内重复问不重复调用小模型；有界 LRU。
const _cache = new Map()
const _CACHE_MAX = 500
function _cacheKey(text) { return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 400) }
function _cacheGet(k) { if (!_cache.has(k)) return null; const v = _cache.get(k); _cache.delete(k); _cache.set(k, v); return v }
function _cacheSet(k, v) { _cache.set(k, v); if (_cache.size > _CACHE_MAX) _cache.delete(_cache.keys().next().value) }
export function clearThinkingCache() { _cache.clear() }

/**
 * 是否该问小模型（hybrid 节流，降延迟/成本）：
 *   'off'    → 从不（纯规则）
 *   'always' → 总是
 *   'auto'   → 只在规则"不确定"时（非明显寒暄/空、且分数落在灰区 0..5）
 */
export function shouldAskModel(text, c, mode = 'auto') {
  if (mode === 'off') return false
  if (mode === 'always') return true
  const s = String(text || '').trim()
  if (!s) return false
  if ((c?.reasons || []).includes('casual')) return false
  if ((c?.score ?? 0) >= 6) return false // 规则很确定是 high
  return true
}

/**
 * 小模型优先、规则兜底、缓存加速的自动决策（Agent 调用）。
 * @param {object} o { text, llm, classifier:'auto'|'off'|'always', timeoutMs, context, protocol, preset, model, style, budgets, maxBudget }
 */
export async function decideThinkingSmart(text, {
  llm = null, classifier = 'auto', timeoutMs = 2500, context = '',
  protocol, preset, model, style, budgets, maxBudget,
} = {}) {
  const rule = classifyComplexity(text, { budgets, maxBudget })
  let chosen = null
  const key = _cacheKey(text)
  if (key) {
    const hit = _cacheGet(key)
    if (hit) chosen = hit
  }
  if (!chosen && classifier !== 'off' && llm && shouldAskModel(text, rule, classifier)) {
    const m = await classifyWithModel(text, { llm, timeoutMs, context })
    if (m) { chosen = { depth: m.depth, reasons: m.reasons, source: 'model' }; if (key) _cacheSet(key, chosen) }
  }
  if (!chosen) chosen = { depth: rule.depth, reasons: rule.reasons, source: classifier === 'off' ? 'rule' : 'rule-fallback' }
  const budget = clampBudget(chosen.depth, budgets, maxBudget)
  const encoded = encodeThinking({ depth: chosen.depth, budget, protocol, preset, model, style })
  return {
    ...chosen, score: rule.score, budget,
    ...encoded, style: resolveThinkingStyle({ protocol, preset, model, presetStyle: style }),
  }
}
