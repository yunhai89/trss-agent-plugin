/**
 * 模型能力注册表 —— 离线判定每模型支持的能力位（不发探测请求）。
 * 对应 yunhai lib/llm/capabilities.js。6 bit：tools/vision/thinking/caching/json_mode/file。
 *
 * 优先级（低→高）：BASELINE → 协议默认 → 厂商默认(vendorCaps) → 模型名正则(REGISTRY, 首匹配) → 配置覆盖(caps)。
 * 返回 source 标注哪一层拍板。
 */

const BASELINE = { tools: false, vision: false, thinking: false, caching: false, json_mode: false, file: false, audio: false, video: false }

const PROTOCOL_DEFAULT = {
  openai: { tools: true },
  anthropic: { tools: true, vision: true, caching: true },
}

/** 更具体的正则放前面（首匹配胜出） */
const REGISTRY = [
  // OpenAI
  { match: /^gpt-4o/, caps: { vision: true, tools: true, json_mode: true, file: true } },
  { match: /^gpt-4\.1/, caps: { vision: true, tools: true, json_mode: true, file: true } },
  { match: /^gpt-4-turbo/, caps: { vision: true, tools: true, json_mode: true } },
  { match: /^gpt-4(?!o)/, caps: { tools: true, json_mode: true } },
  { match: /^gpt-3\.5/, caps: { tools: true, json_mode: true } },
  { match: /^o[134]/, caps: { tools: true, thinking: true, vision: true } },
  // Claude
  { match: /claude-(opus|sonnet|haiku)/, caps: { vision: true, tools: true, thinking: true, caching: true, file: true } },
  // DeepSeek
  { match: /deepseek-r|deepseek-reasoner/, caps: { tools: true, thinking: true, caching: true } },
  { match: /deepseek/, caps: { tools: true, caching: true } },
  // Gemini
  { match: /gemini-?(2\.5|2\.0|1\.5)/, caps: { vision: true, tools: true, thinking: true, file: true } },
  // Kimi / Moonshot
  { match: /kimi|moonshot/, caps: { tools: true, vision: true } },
  // Qwen
  { match: /qwen-?vl|qvq/, caps: { vision: true, tools: true } },
  { match: /qwen/, caps: { tools: true } },
  // GLM
  { match: /glm-?4v|glm.*-v/, caps: { vision: true, tools: true } },
  { match: /glm/, caps: { tools: true } },
  // MiMo
  { match: /mimo.*omni/, caps: { vision: true, tools: true, thinking: true } },
  { match: /mimo/, caps: { tools: true, thinking: true } },
]

/**
 * @param {object} opts { protocol:'openai'|'anthropic', vendorCaps?, model:string, caps?:object(覆盖) }
 * @returns {...6bit, source:'baseline'|'default'|'vendor'|'registry'|'config'}
 */
export function detectCapabilities({ protocol = 'openai', vendorCaps, model = '', caps } = {}) {
  let result = { ...BASELINE }
  let source = 'baseline'

  const proto = PROTOCOL_DEFAULT[protocol]
  if (proto) {
    Object.assign(result, proto)
    source = 'default'
  }

  if (vendorCaps && typeof vendorCaps === 'object') {
    Object.assign(result, vendorCaps)
    source = 'vendor'
  }

  for (const r of REGISTRY) {
    if (r.match.test(model)) {
      Object.assign(result, r.caps)
      source = 'registry'
      break
    }
  }

  if (caps && typeof caps === 'object') {
    Object.assign(result, caps)
    source = 'config'
  }

  return { ...result, source }
}

export { BASELINE, PROTOCOL_DEFAULT, REGISTRY }
