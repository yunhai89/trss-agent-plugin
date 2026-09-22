/**
 * 发送前脱敏：屏蔽 AI 回复中的敏感信息（API Key / token 等）。
 *
 * 两层覆盖：
 *  1) 已知密钥值：从当前配置实时收集（agent.apiKey / fallback / 厂商·模型注册表 /
 *     vision / sandbox / recall.embed / search 各源 / stagehand / comfyui / pixiv /
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
  push(cfg.comfyui?.apiKey)
  push(cfg.pixiv?.refreshToken)
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
 * 脱敏一段文本：已知密钥值 + 常见模式 → ***。
 * 纯字符串操作；异常时原样返回，绝不阻塞发送。
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text
  try {
    let out = text
    // 1) 已知密钥值（split/join 免正则转义问题）
    for (const sec of collectSecrets()) {
      if (sec && out.includes(sec)) out = out.split(sec).join('***')
    }
    // 2) 模式兜底
    for (const re of PATTERNS) out = out.replace(re, '***')
    return out
  } catch {
    return text
  }
}
