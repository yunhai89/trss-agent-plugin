/**
 * TTS（语音合成）模块公共出口。
 *
 * 设计：多服务商预留（agent.tts.provider），当前实现 IndexTTS 2.5（Gradio HTTP 协议）；
 * 情绪模式与 pro/max 档位见 service.js / emotion.js，面向 Agent 的说明见 skills/tts.md。
 */
export { TtsService, normalizeTtsConfig, TTS_DEFAULTS, TTS_LANGS, TTS_TEXT_MAX, parseVectorParam } from './service.js'
export { stripForSpeech } from './speech-text.js'
export { makeTtsSpeakTool } from './tools.js'
export { RefLibrary, REF_KINDS, AUDIO_EXTS, normalizeRefName, extOf } from './refs.js'
export {
  PROVIDER_IDS, PROVIDERS, providerMeta, providerCaps, providerConfigured,
  EMOTION_LABELS, VECTOR_LABEL_MAPS, MIMO_VOICES,
  dominantEmotion, labelFor, doubaoScaleFor, styleInstructionFor, langFor,
} from './providers.js'
export { DoubaoTtsClient, parseDoubaoNdjson, doubaoHint, doubaoHttpHint, DOUBAO_ENDPOINT, DOUBAO_RESOURCE_IDS, DOUBAO_MODELS } from './doubao.js'
export { MinimaxTtsClient, minimaxHint, minimaxHttpHint, MINIMAX_ENDPOINT, MINIMAX_MODELS } from './minimax.js'
export { MimoTtsClient, mimoHttpHint, MIMO_ENDPOINT, MIMO_MODELS } from './mimo.js'
export {
  IndexTtsClient, clampVector, vectorToObject, fileData, VECTOR_KEYS, VECTOR_ZH,
  VECTOR_ALIASES, normalizeVectorKeys, httpHint,
} from './indextts.js'
export {
  planEmotion, buildPlanPrompt, buildEmotionSystemPrompt, normalizeContext,
  splitByPunctuation, parsePlan, extractJson, EMOTION_MODE_DOCS, EMOTION_GUIDE,
  MAX_SEGMENTS, MAX_SEGMENT_CHARS,
} from './emotion.js'
export { concatSegments, runFfmpeg, buildConcatArgs, buildSilenceArgs, buildConcatListContent } from './audio.js'
export { enhanceVoice, buildEnhanceArgs, hdOutputPath, hdFilter, presenceGainFor, measurePresenceRatio, HD_LOUDNORM } from './enhance.js'
