/**
 * TTS Agent 工具 —— tts_speak：把文字合成为语音并发送到当前聊天。
 *
 * 工具 description/schema 随当前服务商动态生成：
 *  - IndexTTS：音色参考名单 + same/audio/vector 情绪模式 + pro/max 档位；
 *  - 云服务商（豆包/MiniMax/MiMo）：音色为服务商 ID/预置名，情绪由 LLM 判定（可显式覆盖），
 *    pro/max 档位同样可用（max=分段逐段情绪后 ffmpeg 合并）。
 * 让模型不用猜就能正确调用；更细的说明见 skills/tts.md（按需加载，不占常驻上下文）。
 */
import { sendVoice } from '../toolkit/media.js'
import { VECTOR_KEYS, VECTOR_ZH } from './indextts.js'
import { EMOTION_LABELS, MIMO_VOICES } from './providers.js'

const VECTOR_SCHEMA = {
  type: 'object',
  description: '显式情绪向量（0~1.2，总和≤1.5；省略=由 LLM 结合文本与上下文自动调节）',
  properties: Object.fromEntries(VECTOR_KEYS.map((k) => [k, { type: 'number', description: VECTOR_ZH[k] }])),
}

/** 从工具执行上下文取近期对话消息（给情绪判定用） */
export function messagesOf(ctx) {
  return ctx?.executionContext?.messages || ctx?.messages || []
}

function refsTool(service) {
  const voiceNames = service.voices('voice').map((v) => v.name)
  const emoNames = service.voices('emotion').map((r) => r.name)
  const voiceHint = voiceNames.length
    ? `可用音色参考：${voiceNames.slice(0, 12).join('、')}${voiceNames.length > 12 ? ' 等' : ''}（voice 参数按名字选；省略=默认音色）`
    : '尚未上传音色参考音频（需先在 Web 面板「语音合成」上传并命名，voice 参数按名字引用）'
  const emoHint = emoNames.length ? `（可用情绪参考：${emoNames.join('、')}）` : '（还没有情绪参考音频）'
  return {
    description: [
      '把文字合成为语音并发送到当前聊天（TTS / IndexTTS 2.5）。仅在需要指定音色/情绪点播时调用：普通回复在开启自动语音（agent.tts.autoReply）时会自动出声，本工具调用后本轮不再自动补发。',
      '文本会先自动清洗成讲稿（剥除 md/代码/链接/表情，破折号转停顿）再合成，无需自己处理格式。',
      voiceHint + '。',
      '情绪模式 emotionMode（默认 same）：same=沿用音色参考音频的情绪；audio=另提供情绪参考音频（emotionRef + emotionWeight 控制影响强度）' + emoHint + '；vector=8 维情绪向量（默认由 LLM 结合要说的文本与近期对话上下文自动调节，不需要手填）。',
      '档位 tier（仅 vector 模式）：pro=整段文本一套情绪一次合成（默认，快）；max=按文本语义按需拆分、逐段判定情绪分别合成再用 ffmpeg 合并（更细腻、耗时更长，适合长文本/情绪起伏大）。',
      '重复要求、闲聊式的短句别用语音；生成失败会把错误如实告诉你，不要编造已发送。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要朗读的文本（必填；支持 <字|拼音> 注音标注，如 <行|HANG2>）' },
        voice: { type: 'string', description: '音色参考名字（省略=默认音色）' },
        emotionMode: { type: 'string', enum: ['same', 'audio', 'vector'], description: '情绪模式（省略=配置默认）' },
        emotionRef: { type: 'string', description: '情绪参考音频名字（audio 模式；省略=配置默认）' },
        emotionWeight: { type: 'number', description: '情绪参考影响强度 0~1（audio 模式，默认 0.65）' },
        vector: VECTOR_SCHEMA,
        tier: { type: 'string', enum: ['pro', 'max'], description: '档位（vector 模式，省略=配置默认）' },
        lang: { type: 'string', enum: ['ZH', 'EN', 'JA', 'AR', 'ES'], description: '语言（省略=配置默认 ZH）' },
      },
      required: ['text'],
    },
  }
}

function cloudTool(service, id) {
  const cfg = service.cfg?.[id] || {}
  const name = service.provider === id ? service._providerName(id) : id
  const defaultVoice = { doubao: cfg.speaker, minimax: cfg.voiceId, mimo: cfg.voice }[id] || ''
  const voiceDesc = defaultVoice
    ? `音色（省略=默认「${defaultVoice}」；仅支持该服务商的音色 ID/名称）`
    : '音色（该服务商尚未配置默认音色，必须显式给或先去 Web 面板配置）'
  const props = {
    text: { type: 'string', description: '要朗读的文本（必填）' },
    voice: { type: 'string', description: voiceDesc },
    tier: { type: 'string', enum: ['pro', 'max'], description: '档位：pro=整段一次合成（默认，快）；max=按语义分段、逐段判定情绪分别合成后合并（更细腻，长文本更慢）' },
  }
  let emotionHint = ''
  if (id === 'doubao') {
    props.emotion = { type: 'string', enum: EMOTION_LABELS.doubao, description: '固定情感标签（1.0 音色）；省略=由 LLM 结合文本与上下文自动判定' }
    emotionHint = '情绪由 LLM 判定后自动下发（2.0 音色→自然语言语音指令；1.0 音色→多情感标签），无需手填。'
  } else if (id === 'minimax') {
    props.emotion = { type: 'string', enum: EMOTION_LABELS.minimax, description: '固定情绪标签；省略=由 LLM 结合文本与上下文自动判定' }
    emotionHint = '情绪由 LLM 判定为 8 维情绪后自动映射为 MiniMax 标签，无需手填。'
  } else {
    props.style = { type: 'string', description: '风格/音色指令（自然语言，如「用轻快上扬的语调说，语速稍快」）；省略=由 LLM 判定情绪后自动生成' }
    if (cfg.model === 'mimo-v2.5-tts-voicedesign') {
      props.voice = { type: 'string', description: `该模型用文字设计音色（会忽略 voice；请用 style 描述音色）；常见预置音色：${MIMO_VOICES.join('、')}` }
    } else {
      props.voice = { type: 'string', description: `预置音色（省略=默认「${cfg.voice || 'mimo_default'}」）：${MIMO_VOICES.join('、')}` }
    }
    emotionHint = '情绪由 LLM 判定后自动生成自然语言风格指令（也可用 style 直接指定），无需手填。'
  }
  return {
    description: [
      `把文字合成为语音并发送到当前聊天（TTS / ${name}）。仅在需要指定音色/情绪点播时调用：普通回复在开启自动语音（agent.tts.autoReply）时会自动出声，本工具调用后本轮不再自动补发。`,
      '文本会先自动清洗成讲稿（剥除 md/代码/链接/表情，破折号转停顿）再合成，无需自己处理格式。',
      emotionHint,
      '重复要求、闲聊式的短句别用语音；生成失败会把错误如实告诉你，不要编造已发送。',
    ].join(''),
    parameters: { type: 'object', properties: props, required: ['text'] },
  }
}

/**
 * 构造 tts_speak 工具（schema 按当前服务商能力生成）。
 * @param {import('./service.js').TtsService} service
 */
export function makeTtsSpeakTool(service) {
  const id = service.provider
  const base = service.capabilities().refs ? refsTool(service) : cloudTool(service, id)
  return {
    name: 'tts_speak',
    description: base.description,
    category: 'message',
    meta: { summary: 'TTS语音合成发送', interactive: true, sideEffects: ['message'] },
    parameters: base.parameters,

    async execute(p = {}, ctx = {}) {
      const r = await service.synthesize({
        text: p.text,
        voice: p.voice,
        emotionMode: p.emotionMode,
        emotionRef: p.emotionRef,
        emotionWeight: p.emotionWeight,
        vector: p.vector,
        emotion: p.emotion,
        style: p.style,
        tier: p.tier,
        lang: p.lang,
        context: { messages: messagesOf(ctx) },
      })
      if (!r.ok) return { error: r.error }
      const sent = await sendVoice(ctx, r.file)
      if (!sent) return { error: '语音已生成但发送失败（当前会话不支持语音消息？文件已保留在 data/tts/out）', file: r.file }
      const out = { ok: true, sent: true, voice: r.voice, tier: r.tier, mode: r.mode }
      if (r.vector) out.emotion = r.vector
      if (r.segments) out.segments = r.segments.length
      if (r.reason) out.emotionReason = r.reason
      if (r.notes?.length) out.notes = r.notes
      return out
    },
  }
}
