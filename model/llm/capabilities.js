/**
 * 模型能力注册表 —— 离线判定每模型支持的能力位（不发探测请求）。
 * 对应 yunhai lib/llm/capabilities.js。8 bit：tools/vision/thinking/caching/json_mode/file/audio/video。
 *
 * 优先级（低→高）：BASELINE → 协议默认 → 厂商默认(vendorCaps) → 模型名正则(REGISTRY, 首匹配)
 *   → 官方数据(getApiCaps, 从厂商 /models 拉取的模态元数据) → 配置覆盖(caps)。
 * 返回 source 标注哪一层拍板。
 */
import { getApiCaps } from './caps-source.js'

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
  // MiMo（小米）：v2.5/v2.6 为全模态（文本/图像/视频/音频）；asr/tts 为语音专用，别当多模态对话模型
  { match: /mimo.*(asr|tts)/, caps: { tools: false, thinking: false, audio: true } },
  { match: /mimo.*(omni|v?2\.[56])/, caps: { vision: true, video: true, audio: true, tools: true, thinking: true } },
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

  // 官方数据层：厂商 /models 暴露的模态（OpenRouter 等）。仅叠加“正向能力”，不因缺字段而关闭。
  const apiCaps = getApiCaps(model)
  if (apiCaps) {
    for (const k of Object.keys(apiCaps)) if (apiCaps[k]) result[k] = true
    source = 'api'
  }

  if (caps && typeof caps === 'object') {
    Object.assign(result, caps)
    source = 'config'
  }

  return { ...result, source }
}

export { BASELINE, PROTOCOL_DEFAULT, REGISTRY }
