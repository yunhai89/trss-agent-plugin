/**
 * TTS 服务商注册表与情绪适配层（多服务商共用）。
 *
 * 职责：
 *  - PROVIDERS：服务商元数据（面板字段 schema、能力、文档链接）——Web 面板按 schema 渲染，
 *    服务层按能力路由，避免在 UI/服务/工具三处各写一份服务商清单；
 *  - 情绪适配：LLM 判定的 8 维情绪向量（indextts.js VECTOR_KEYS）→ 服务商参数：
 *      · 离散标签（豆包 1.0 / MiniMax）：取主导情绪映射为该服务商的合法标签；
 *      · 自然语言风格指令（豆包 2.0 context_texts / MiMo user 指令）：由向量确定性生成，
 *        LLM 仍然只出"向量 + 理由"这一份判定结果，映射规则可测试、可预测；
 *  - langFor：插件统一语言码（ZH/EN/JA/AR/ES）→ 各服务商字段值。
 *
 * 文档（接入依据，2026-10 核对）：
 *  - 豆包：https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http
 *  - MiniMax：https://platform.minimaxi.com/docs/api-reference/speech-t2a-http
 *  - MiMo：https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5
 */
import { VECTOR_KEYS, VECTOR_ZH } from './indextts.js'

export const PROVIDER_IDS = ['indextts', 'doubao', 'minimax', 'mimo']

/** 服务商可选离散情绪标签（豆包为 1.0 音色支持范围；MiniMax 为 2.6/2.8 支持范围） */
export const EMOTION_LABELS = {
  doubao: ['happy', 'sad', 'angry', 'surprised', 'fear', 'hate', 'excited', 'coldness', 'neutral', 'depressed', 'lovey-dovey', 'shy', 'comfort', 'tension', 'tender', 'storytelling', 'radio', 'magnetic', 'advertising', 'vocal-fry', 'ASMR', 'news', 'entertainment', 'dialect'],
  minimax: ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper'],
}

/** 8 维向量主导情绪 → 服务商标签（不一致处：忧郁→豆包 depressed / MiniMax sad） */
export const VECTOR_LABEL_MAPS = {
  doubao: { happy: 'happy', angry: 'angry', sad: 'sad', afraid: 'fear', disgusted: 'hate', melancholic: 'depressed', surprised: 'surprised', calm: 'neutral' },
  minimax: { happy: 'happy', angry: 'angry', sad: 'sad', afraid: 'fearful', disgusted: 'disgusted', melancholic: 'sad', surprised: 'surprised', calm: 'calm' },
}

/** 向量主导情绪 → 中文风格描述词（自然语言指令用） */
const STYLE_ADJ = {
  happy: '开心愉悦', angry: '克制但带点火气', sad: '难过低落', afraid: '紧张不安',
  disgusted: '嫌弃不悦', melancholic: '忧郁感慨', surprised: '惊讶', calm: '平静自然',
}

/** 主导情绪（向量为对象或数组均可）；分数夹到 0~1.2 */
export function dominantEmotion(vector) {
  const arr = Array.isArray(vector) ? vector : VECTOR_KEYS.map((k) => Number(vector?.[k]) || 0)
  let idx = 0
  let max = -1
  arr.forEach((n, i) => { const v = Number(n) || 0; if (v > max) { max = v; idx = i } })
  return { key: VECTOR_KEYS[idx], zh: VECTOR_ZH[VECTOR_KEYS[idx]], score: Math.max(0, Math.min(1.2, max)) }
}

/** 离散标签（provider 不在映射表或向量为空返回 ''） */
export function labelFor(provider, vector) {
  const d = dominantEmotion(vector)
  return VECTOR_LABEL_MAPS[provider]?.[d.key] || ''
}

/** 豆包 emotion_scale：由主导分强度换算 1~5（分值 0→1，1.2→5） */
export function doubaoScaleFor(vector) {
  const d = dominantEmotion(vector)
  return Math.max(1, Math.min(5, Math.round(1 + d.score * 3.5)))
}

/**
 * 向量 → 自然语言风格指令（豆包 2.0 语音指令 / MiMo user 指令）。
 * 确定性映射：主情绪 + 次情绪（≥0.25 且非平静）+ 强度修饰，不引入第二次 LLM 调用。
 */
export function styleInstructionFor(vector, { maxLen = 60 } = {}) {
  const arr = Array.isArray(vector) ? vector.map((n) => Number(n) || 0) : VECTOR_KEYS.map((k) => Number(vector?.[k]) || 0)
  const ranked = arr.map((score, i) => ({ key: VECTOR_KEYS[i], score })).sort((a, b) => b.score - a.score)
  const primary = ranked[0] || { key: 'calm', score: 0 }
  const parts = [`用${STYLE_ADJ[primary.key] || '自然'}的语气说`]
  const second = ranked.find((x, i) => i > 0 && x.score >= 0.25 && x.key !== 'calm' && x.key !== primary.key)
  if (second) parts.push(`带一点${STYLE_ADJ[second.key] || ''}`)
  if (primary.score >= 0.9) parts.push('情绪饱满一些')
  else if (primary.score <= 0.35) parts.push('语气自然些')
  return parts.join('，').slice(0, maxLen)
}

/** 插件统一语言码 → 服务商字段值（未知/留空返回 ''，由服务商自动判定） */
export function langFor(provider, lang) {
  const code = String(lang || '').trim().toUpperCase()
  if (!code) return ''
  const maps = {
    doubao: { ZH: 'zh-cn', EN: 'en', JA: 'ja', AR: 'ar', ES: 'es-mx' },
    minimax: { ZH: 'Chinese', EN: 'English', JA: 'Japanese', AR: 'Arabic', ES: 'Spanish' },
  }
  return maps[provider]?.[code] || ''
}

/** MiMo 内置音色（官方文档「预置音色列表」） */
export const MIMO_VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean']

/** 各服务商是否已配置到可用状态（面板/启动日志用） */
export function providerConfigured(id, cfg = {}) {
  if (id === 'indextts') return { configured: !!String(cfg.indextts?.endpoint || '').trim(), missing: cfg.indextts?.endpoint ? [] : ['接口地址'] }
  if (id === 'doubao') {
    const c = cfg.doubao || {}
    const missing = []
    if (!String(c.apiKey || '').trim()) missing.push('API Key')
    if (!String(c.speaker || '').trim()) missing.push('音色 ID')
    return { configured: missing.length === 0, missing }
  }
  if (id === 'minimax') {
    const c = cfg.minimax || {}
    const missing = []
    if (!String(c.apiKey || '').trim()) missing.push('API Key')
    if (!String(c.voiceId || '').trim()) missing.push('音色 ID')
    return { configured: missing.length === 0, missing }
  }
  if (id === 'mimo') {
    const c = cfg.mimo || {}
    const missing = []
    if (!String(c.apiKey || '').trim()) missing.push('API Key')
    return { configured: missing.length === 0, missing }
  }
  return { configured: false, missing: ['未知服务商'] }
}

/* ── 面板字段 schema（type: text/secret/number/select/switch；由 web 视图动态渲染） ── */
const F_APIKEY = { key: 'apiKey', label: 'API Key', type: 'secret', desc: '仅保存在插件本机配置；不随日志输出' }
const F_ENDPOINT = { key: 'endpoint', label: '接口地址', type: 'text', desc: '默认官方地址；自建网关/代理时可覆盖（http/https）' }

export const PROVIDERS = [
  {
    id: 'indextts',
    name: 'IndexTTS 2.5',
    desc: '本地/自托管服务（Gradio HTTP）· 音色参考 + 情绪参考/向量 + pro/max 档位',
    docs: 'https://github.com/index-tts/index-tts',
    caps: { refs: true, emotions: 'vector' },
    fields: null, // 视图内自定义表单（含参考音频库与向量滑块）
  },
  {
    id: 'doubao',
    name: '豆包语音合成（火山引擎）',
    desc: 'Seed-TTS 2.0 / 1.0 · 语音指令与多情感音色 · 情感由 LLM 判定后自动下发',
    docs: 'https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http',
    caps: { refs: false, emotions: 'instruct+label' },
    fields: [
      F_APIKEY,
      { key: 'speaker', label: '音色 ID', type: 'text', placeholder: 'zh_female_vv_uranus_bigtts', desc: '控制台「音色库」中的 voice_type（2.0 音色以 _uranus_bigtts 结尾）' },
      { key: 'resourceId', label: '资源版本', type: 'select', options: [['seed-tts-2.0', 'seed-tts-2.0（语音合成 2.0）'], ['seed-tts-1.0', 'seed-tts-1.0（语音合成 1.0）'], ['seed-tts-1.0-concurr', 'seed-tts-1.0-concurr（1.0 并发版）']], desc: '决定可用音色与计费；2.0 用语音指令，1.0 用多情感标签' },
      { key: 'model', label: '模型版本', type: 'select', options: [['', '默认（standard）'], ['seed-tts-2.0-standard', 'seed-tts-2.0-standard'], ['seed-tts-2.0-expressive', 'seed-tts-2.0-expressive（高表现力，支持语音指令）']], desc: '留空=服务端默认；使用语音指令建议 expressive' },
      { key: 'autoEmotion', label: 'LLM 自动判定情绪', type: 'switch', desc: '开=与 IndexTTS 同一套 LLM 判定（向量→语音指令/情感标签）；关=只用固定情绪/指令' },
      { key: 'instruct', label: '固定语音指令', type: 'text', desc: '如「用特别痛心的语气说」；留空且自动判定开=由 LLM 判定生成（仅 2.0 音色）' },
      { key: 'emotion', label: '固定情感标签', type: 'select', options: [['', '（自动/不使用）'], ...EMOTION_LABELS.doubao.map((x) => [x, x])], desc: '1.0 多情感音色的 emotion 参数；LLM 判定失败/关闭时的回退' },
      { key: 'emotionScale', label: '情感强度', type: 'number', min: 0, max: 5, step: 1, desc: '0=按 LLM 判定强度自动（1~5）；手动设置时直接作为 emotion_scale' },
      { key: 'speechRate', label: '语速', type: 'number', min: -50, max: 100, step: 5, desc: 'speech_rate：100=2 倍速，-50=0.5 倍速' },
      { key: 'loudnessRate', label: '音量', type: 'number', min: -50, max: 100, step: 5, desc: 'loudness_rate：100=2 倍音量，-50=0.5 倍音量' },
      { key: 'sampleRate', label: '采样率', type: 'select', options: [[24000, '24000'], [16000, '16000'], [32000, '32000'], [44100, '44100'], [48000, '48000']] },
      { key: 'format', label: '音频格式', type: 'select', options: [['wav', 'wav'], ['mp3', 'mp3']], desc: 'max 档分段拼接固定使用 wav' },
      { key: 'useTagParser', label: '语音标签解析', type: 'switch', desc: '声音复刻 2.0 表现力增强版的 Cot 标签解析（use_tag_parser）' },
      { key: 'timeoutMs', label: '超时(ms)', type: 'number', min: 10000, max: 600000, step: 5000, desc: '单次合成请求超时（毫秒）' },
      F_ENDPOINT,
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax 语音',
    desc: 'speech-2.8/2.6/02 · 9 种情绪标签 · 情感由 LLM 判定后自动下发',
    docs: 'https://platform.minimaxi.com/docs/api-reference/speech-t2a-http',
    caps: { refs: false, emotions: 'label' },
    fields: [
      F_APIKEY,
      { key: 'voiceId', label: '音色 ID', type: 'text', placeholder: 'male-qn-qingse / female-tianmei', desc: '系统音色 ID 或复刻音色 ID（控制台「音色管理」）' },
      { key: 'model', label: '模型', type: 'select', options: [['speech-2.8-hd', 'speech-2.8-hd'], ['speech-2.8-turbo', 'speech-2.8-turbo'], ['speech-2.6-hd', 'speech-2.6-hd'], ['speech-2.6-turbo', 'speech-2.6-turbo'], ['speech-02-hd', 'speech-02-hd'], ['speech-02-turbo', 'speech-02-turbo'], ['speech-01-hd', 'speech-01-hd'], ['speech-01-turbo', 'speech-01-turbo']], desc: '2.6/2.8 支持全部 9 种情绪；2.8 自动匹配情感能力更强' },
      { key: 'autoEmotion', label: 'LLM 自动判定情绪', type: 'switch', desc: '开=LLM 判定 8 维情绪后映射为 MiniMax 标签；关=只用固定标签' },
      { key: 'emotion', label: '固定情绪标签', type: 'select', options: [['', '（自动/不使用）'], ...EMOTION_LABELS.minimax.map((x) => [x, x])], desc: 'voice_setting.emotion；LLM 判定失败/关闭时的回退' },
      { key: 'speed', label: '语速', type: 'number', min: 0.5, max: 2, step: 0.1 },
      { key: 'vol', label: '音量', type: 'number', min: 0.1, max: 10, step: 0.1 },
      { key: 'pitch', label: '音调', type: 'number', min: -12, max: 12, step: 1 },
      { key: 'sampleRate', label: '采样率', type: 'select', options: [[32000, '32000'], [24000, '24000'], [16000, '16000'], [22050, '22050'], [44100, '44100'], [8000, '8000']] },
      { key: 'format', label: '音频格式', type: 'select', options: [['wav', 'wav'], ['mp3', 'mp3']], desc: 'wav/mp3 各协议端通用（flac 可手改配置）；max 档分段拼接固定使用 wav' },
      { key: 'languageBoost', label: '语种增强', type: 'select', options: [['', '（自动）'], ['Chinese', 'Chinese'], ['English', 'English'], ['Japanese', 'Japanese'], ['Arabic', 'Arabic'], ['Spanish', 'Spanish'], ['auto', 'auto']] },
      { key: 'groupId', label: 'GroupId', type: 'text', desc: '可选：旧版账号需要（拼在 URL 查询参数）' },
      { key: 'timeoutMs', label: '超时(ms)', type: 'number', min: 10000, max: 600000, step: 5000, desc: '单次合成请求超时（毫秒）' },
      { ...F_ENDPOINT, desc: '默认 https://api.minimaxi.com/v1/t2a_v2（国际站 api.minimax.io，华北 api-bj.minimaxi.com）' },
    ],
  },
  {
    id: 'mimo',
    name: '小米 MiMo TTS',
    desc: 'MiMo-V2.5-TTS · 预置音色 + 自然语言风格指令（OpenAI 兼容）· 情感由 LLM 判定生成',
    docs: 'https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5',
    caps: { refs: false, emotions: 'instruct' },
    fields: [
      F_APIKEY,
      { key: 'model', label: '模型', type: 'select', options: [['mimo-v2.5-tts', 'mimo-v2.5-tts（预置音色）'], ['mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts-voicedesign（文字设计音色）']], desc: 'voicedesign 时用「固定风格指令」描述音色（必填）' },
      { key: 'voice', label: '预置音色', type: 'select', options: MIMO_VOICES.map((v) => [v, v]), desc: '预置音色（voicedesign 模型忽略此项）' },
      { key: 'autoEmotion', label: 'LLM 自动判定情绪', type: 'switch', desc: '开=LLM 判定后直接生成风格指令（支持复合情绪/语速/发声方式/导演式）与音频标签；关=只用固定风格指令' },
      { key: 'style', label: '固定风格指令', type: 'text', desc: '如「用轻快上扬的语调报喜，语速稍快」「用东北话说」「用唱歌的方式唱出来」；留空且自动判定开=LLM 生成' },
      { key: 'tagMode', label: '音频标签', type: 'select', options: [['auto', 'auto · 句首风格 + 行内标签（推荐）'], ['style', 'style · 只加句首 (风格)'], ['off', 'off · 不使用标签']], desc: '行内标签（[笑]/[叹气]/[颤抖]/[语速加快] 等）由 LLM 按原文保真插入，改写原文的一律丢弃' },
      { key: 'format', label: '音频格式', type: 'select', options: [['wav', 'wav'], ['mp3', 'mp3']], desc: 'max 档分段拼接固定使用 wav' },
      { key: 'timeoutMs', label: '超时(ms)', type: 'number', min: 10000, max: 600000, step: 5000, desc: '单次合成请求超时（毫秒）' },
      F_ENDPOINT,
    ],
  },
]

/** 服务商元数据（未知 id 返回 null） */
export function providerMeta(id) {
  return PROVIDERS.find((p) => p.id === id) || null
}

/** 服务商能力（默认按 indextts 处理，保证旧配置安全） */
export function providerCaps(id) {
  return providerMeta(id)?.caps || { refs: true, emotions: 'vector' }
}
