/**
 * 发送前脱敏：屏蔽 AI 回复中的敏感信息（API Key / token 等）。
 *
 * 两层覆盖：
 *  1) 已知密钥值：从当前配置实时收集（agent.apiKey / fallback / 厂商·模型注册表 /
 *     vision / sandbox / recall.embed / search 各源 / stagehand / pixiv /
 *     miyoushe / mcp servers env·headers），命中即整体替换为 ***——最准、基本无误伤（密钥值长度≥16 才参与）。
 *  2) 常见密钥模式：sk-xxx / sk-ant- / Bearer xxx / ghp_ / AKIA / xox[bpoa]- / AIza / hf_ 等，正则兜底。
 *
 * 纯字符串操作、内部 try/catch，绝不抛错阻塞回复；非字符串原样返回。
 */

import Config from '../../utils/Config.js'

/** 常见密钥/token 模式（高置信度，避免误伤普通文本） */
const PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI / DeepSeek / Moonshot 等
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\bsk-or-[A-Za-z0-9_-]{16,}/g, // OpenRouter
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi, // Authorization 头
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{16,}/g, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bAKIA[0-9A-Z]{16}/g, // AWS access key
  /\bxox[bpoa]-[A-Za-z0-9-]{10,}/g, // Slack token
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API key
  /\bhf_[A-Za-z0-9]{20,}/g, // HuggingFace token
]

/** 从当前配置收集已知密钥值（实际值，用于精确命中替换） */
function collectSecrets() {
  const cfg = Config.get()?.agent || {}
  const out = []
  const push = (v) => {
    if (typeof v === 'string' && v.length >= 16) out.push(v)
  }
  push(cfg.apiKey)
  // 引用式配置：真实 Key 存在厂商/模型条目里，镜像字段可能为空——两者都要收
  for (const p of cfg.llmProviders || []) push(p?.apiKey)
  for (const m of cfg.llmModels || []) push(m?.apiKey)
  push(cfg.vision?.apiKey)
  push(cfg.jev?.apiKey) // TypeSafe Jev API Key（发往第三方判断模型；绝不入日志/回复）
  push(cfg.sandbox?.apiKey) // E2B（云/自托管）团队 key：与 LLM key 同等敏感，必须脱敏
  push(cfg.recall?.embedApiKey)
  push(cfg.kb?.embedApiKey)
  push(cfg.fallbackApiKey)
  for (const f of cfg.fallbackModels || []) push(f?.apiKey)
  for (const k of ['tavily', 'exa', 'perplexity', 'brave']) push(cfg.search?.[k]?.apiKey)
  push(cfg.search?.searxng?.url && cfg.search.searxng.url.includes('@') ? cfg.search.searxng.url : '') // 带鉴权的 url
  push(cfg.stagehand?.browserbaseApiKey) // Browserbase 云 key
  push(cfg.stagehand?.apiKey)
  push(cfg.stagehand?.modelApiKey)
  // QQ 官方机器人自实现适配器：AppSecret 与 access_token 同等敏感（泄露可冒充机器人发消息）
  push(cfg.qqBot?.appSecret)
  for (const a of cfg.qqBot?.accounts || []) push(a?.appSecret)
  push(cfg.tools?.pixiv?.refreshToken) // Pixiv 已迁为外置工具：值存 agent.tools.pixiv
  push(cfg.miyoushe?.cookie)
  // mcp servers 的 env / headers 值（常含 API Key），以及部分服务端的鉴权 token
  const servers = cfg.mcp?.servers || {}
  for (const s of Object.values(servers)) {
    const env = s && typeof s === 'object' ? s.env : null
    if (env && typeof env === 'object') {
      for (const v of Object.values(env)) if (typeof v === 'string' && v.length >= 16) out.push(v)
    }
    if (s?.headers && typeof s.headers === 'object') {
      for (const v of Object.values(s.headers)) if (typeof v === 'string' && v.length >= 16) out.push(v)
    }
    if (s?.apiKey) push(s.apiKey)
  }
  return out
}

/**
 * 各模式正则的「字面起始标记」（流式尾部暂存判定用；与上方 PATTERNS 一一对应）。
 * ci=true 表示该模式带 i 标志（大小写不敏感）。
 */
const PATTERN_HEADS = [
  { head: 'sk-ant-', ci: false, b: false }, { head: 'sk-or-', ci: false, b: false },
  // 注意：PATTERNS 里 sk- 这条没有 \b 前缀，故 b=false（'catsk-xxx' 同样会被脱敏）
  { head: 'sk-', ci: false, b: false },
  { head: 'Bearer ', ci: true, b: true },
  { head: 'github_pat_', ci: false, b: true },
  { head: 'ghp_', ci: false, b: true }, { head: 'gho_', ci: false, b: true },
  { head: 'ghu_', ci: false, b: true }, { head: 'ghs_', ci: false, b: true },
  { head: 'ghr_', ci: false, b: true },
  { head: 'AKIA', ci: false, b: true }, { head: 'AIza', ci: false, b: true },
  { head: 'hf_', ci: false, b: true },
  { head: 'xoxb-', ci: false, b: true }, { head: 'xoxp-', ci: false, b: true },
  { head: 'xoxo-', ci: false, b: true }, { head: 'xoxa-', ci: false, b: true },
]

/** 模式里的 \b：标记起点必须落在词边界上（否则该模式本就不会命中，无需暂存） */
const WORD_CHAR = /[A-Za-z0-9_]/
const atBoundary = (s, i) => i === 0 || !WORD_CHAR.test(s[i - 1])

/** 模式 {16,} 类里出现过的字符：标记之后仍是这类字符 → 密钥可能还在延伸，不能先发 */
const KEY_CHAR = /[A-Za-z0-9._-]/

/** 暂存窗口上界：避免异常长的「疑似密钥」把流式彻底卡死（真实密钥远小于此） */
const MAX_HOLD = 512

/**
 * 流式安全切点：返回 raw 中「可以立即脱敏外发」的前缀长度。
 *
 * 为什么需要它：redactSecrets 是**整串**语义（已知密钥靠 includes 精确命中、模式正则要求
 * 密钥在同一字符串内完整出现）。流式逐片调用时，密钥被分片边界切开 → 两片都不命中 →
 * 明文外发。故凡「尾部可能是不完整密钥」的部分一律先扣住不发，等后续增量补齐后再判定：
 *   1) 尾部是某个已知密钥值的前缀（如配置里 sk-xxx 的 'sk-xx'）；
 *   2) 已出现模式起始标记（sk- / Bearer / AKIA …）且其后的密钥字符一直延伸到串尾
 *      （即可能还在增长，尚未定型）；
 *   3) 尾部本身就是某个标记的真前缀（'s' / 'sk' / 'Bear' …）。
 * 三种情况之外照常即时发送，故正常文本的流式体验不受影响（不会一律压到收尾）。
 *
 * @param {string} text 累积原文
 * @param {string[]} [secrets] 预先收集的已知密钥（不传则实时收集）
 * @returns {number} 可安全外发的前缀长度（0..text.length）
 */
export function redactSafeCut(text, secrets) {
  if (typeof text !== 'string' || !text) return 0
  let cut = text.length
  try {
    // 1) 已知密钥：尾部是某密钥的真前缀 → 从该前缀起点扣住
    const list = Array.isArray(secrets) ? secrets : collectSecrets()
    for (const sec of list) {
      if (!sec) continue
      const max = Math.min(sec.length - 1, text.length)
      for (let L = max; L > 0; L--) {
        if (text.endsWith(sec.slice(0, L))) { cut = Math.min(cut, text.length - L); break }
      }
    }
    // 2) 已出现的起始标记：其后全是密钥字符且直到串尾 → 可能仍在延伸
    const low = text.toLowerCase()
    for (const { head, ci, b } of PATTERN_HEADS) {
      const hay = ci ? low : text
      const needle = ci ? head.toLowerCase() : head
      for (let idx = hay.indexOf(needle); idx !== -1; idx = hay.indexOf(needle, idx + 1)) {
        if (b && !atBoundary(text, idx)) continue
        const after = idx + head.length
        let extending = true
        for (let i = after; i < text.length; i++) {
          if (!KEY_CHAR.test(text[i])) { extending = false; break }
        }
        if (extending) cut = Math.min(cut, idx)
      }
    }
    // 3) 尾部只是标记的一半（'s'/'sk'/'Bear'）→ 也会被下片补成完整密钥
    for (const { head, ci, b } of PATTERN_HEADS) {
      const max = Math.min(head.length - 1, text.length)
      let L = max
      for (; L > 0; L--) {
        const tail = text.slice(text.length - L)
        const same = ci ? tail.toLowerCase() === head.slice(0, L).toLowerCase() : tail === head.slice(0, L)
        if (same) break
      }
      if (L > 0 && (!b || atBoundary(text, text.length - L))) cut = Math.min(cut, text.length - L)
    }
    if (text.length - cut > MAX_HOLD) cut = text.length - MAX_HOLD
    return Math.max(0, Math.min(cut, text.length))
  } catch {
    return 0 // 判定失败一律全量扣住（fail-closed：宁可延迟，不可明文外发）
  }
}

/**
 * 脱敏一段文本：已知密钥值 + 常见模式 → ***。
 * 纯字符串操作；异常时原样返回，绝不阻塞发送。
 * @param {string} text 待脱敏文本
 * @param {string[]} [secrets] 预先收集的已知密钥（流式侧按流缓存，避免每片重扫配置）
 */
export function redactSecrets(text, secrets) {
  if (typeof text !== 'string' || !text) return text
  try {
    let out = text
    // 1) 已知密钥值（split/join 免正则转义问题）
    for (const sec of (Array.isArray(secrets) ? secrets : collectSecrets())) {
      if (sec && out.includes(sec)) out = out.split(sec).join('***')
    }
    // 2) 模式兜底
    for (const re of PATTERNS) out = out.replace(re, '***')
    return out
  } catch {
    return text
  }
}
