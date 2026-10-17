/**
 * 模型能力注册表 —— 离线判定每模型支持的能力位（不发探测请求）。
 * 对应 yunhai lib/llm/capabilities.js。8 bit：tools/vision/thinking/caching/json_mode/file/audio/video。
 *
 * 优先级（低→高）：BASELINE → 协议默认 → 厂商默认(vendorCaps) → 模型名正则(REGISTRY, 首匹配)
 *   → 官方数据(getApiCaps, 从厂商 /models 拉取的模态元数据) → 运行时学习(getLearnedThinking)
 *   → 配置覆盖(caps)。返回 source 标注哪一层拍板；thinkingAssumed=true 表示来自乐观假定（见下）。
 *
 * 思考能力的特殊规则（thinking 位）：
 *   注册表靠模型名正则，永远追不上模型迭代（deepseek-v4.1-flash 这类新型号只命中泛化家族规则）。
 *   因此：**只有某一层明确声明过 thinking 布尔值才算「知道」**（注册表明写 / vendorCaps / 官方数据 /
 *   学习记录 / 配置覆盖）；谁都没表态时乐观假定为 true，并把 thinkingAssumed 置位。
 *   假定错了由 provider 侧自动纠正：厂商拒绝思考字段 → 剥离重试 + learnThinkingCapability(false)（见
 *   caps-source.js），后续判定即转为不支持（source='learned'）。
 */
import { getApiCaps, getLearnedThinking } from './caps-source.js'

const BASELINE = { tools: false, vision: false, thinking: false, caching: false, json_mode: false, file: false, audio: false, video: false }

const PROTOCOL_DEFAULT = {
  openai: { tools: true },
  anthropic: { tools: true, vision: true, caching: true },
}

/** 更具体的正则放前面（首匹配胜出）。thinking 明写 true/false = 明确声明（关闭乐观假定）；不写 = 未表态。 */
const REGISTRY = [
  // OpenAI
  // GPT-5：推理模型（reasoning_effort，需 thinking=true 才能启用思考自动决策）；
  // -chat 变体系非推理模型，不判 thinking（下发 reasoning_effort 会被厂商拒绝）。
  { match: /^gpt-5(?!.*-chat)/, caps: { vision: true, tools: true, thinking: true, json_mode: true, file: true } },
  { match: /^gpt-5/, caps: { vision: true, tools: true, thinking: false, json_mode: true, file: true } },
  // GPT-4 系（含 gpt-4o/4.1/turbo）：非推理模型，明确关闭 thinking（避免乐观假定多打一次失败请求）
  { match: /^gpt-4o/, caps: { vision: true, tools: true, thinking: false, json_mode: true, file: true } },
  { match: /^gpt-4\.1/, caps: { vision: true, tools: true, thinking: false, json_mode: true, file: true } },
  { match: /^gpt-4-turbo/, caps: { vision: true, tools: true, thinking: false, json_mode: true } },
  { match: /^gpt-4(?!o)/, caps: { tools: true, thinking: false, json_mode: true } },
  { match: /^gpt-3\.5/, caps: { tools: true, thinking: false, json_mode: true } },
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
 * @returns {...6bit, source:'baseline'|'default'|'vendor'|'registry'|'api'|'learned'|'config', thinkingAssumed?:true}
 */
export function detectCapabilities({ protocol = 'openai', vendorCaps, model = '', caps } = {}) {
  let result = { ...BASELINE }
  let source = 'baseline'
  let thinkingKnown = false // 是否有任意一层明确声明过 thinking（决定是否启用乐观假定）

  const proto = PROTOCOL_DEFAULT[protocol]
  if (proto) {
    Object.assign(result, proto)
    source = 'default'
  }

  if (vendorCaps && typeof vendorCaps === 'object') {
    Object.assign(result, vendorCaps)
    if (typeof vendorCaps.thinking === 'boolean') thinkingKnown = true
    source = 'vendor'
  }

  for (const r of REGISTRY) {
    if (r.match.test(model)) {
      Object.assign(result, r.caps)
      if (typeof r.caps.thinking === 'boolean') thinkingKnown = true
      source = 'registry'
      break
    }
  }

  // 官方数据层：厂商 /models 暴露的模态（OpenRouter 等）。仅叠加“正向能力”，不因缺字段而关闭。
  const apiCaps = getApiCaps(model)
  if (apiCaps) {
    for (const k of Object.keys(apiCaps)) if (apiCaps[k]) result[k] = true
    if (apiCaps.thinking === true) thinkingKnown = true
    source = 'api'
  }

  // 运行时学习层（观察优先于静态名单）：厂商拒绝过思考参数 → false；接受 → true
  const learned = getLearnedThinking(model)
  if (learned !== undefined) {
    result.thinking = learned
    thinkingKnown = true
    source = 'learned'
  }

  if (caps && typeof caps === 'object') {
    Object.assign(result, caps)
    if (typeof caps.thinking === 'boolean') thinkingKnown = true
    source = 'config'
  }

  // 乐观假定：谁都没表态时假定支持思考（名单式判定对新型号必然滞后）。
  // 假定错了由厂商拒绝 → provider 剥离重试 + 学习记录自动纠正，不阻断对话。
  const thinkingAssumed = !thinkingKnown
  if (thinkingAssumed) result.thinking = true

  return { ...result, source, ...(thinkingAssumed ? { thinkingAssumed: true } : {}) }
}

export { BASELINE, PROTOCOL_DEFAULT, REGISTRY }
