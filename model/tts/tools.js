/**
 * TTS Agent 工具 —— tts_speak：把文字合成为语音并发送到当前聊天。
 *
 * 工具 description 是动态的：把「可用音色参考名单」与三种情绪模式、pro/max 档位差异写清楚，
 * 让模型不用猜就能正确调用；更细的模式说明见 skills/tts.md（技能按需加载，不占常驻上下文）。
 */
import { sendVoice } from '../toolkit/media.js'
import { VECTOR_KEYS, VECTOR_ZH } from './indextts.js'

const VECTOR_SCHEMA = {
  type: 'object',
  description: '显式情绪向量（0~1.2，总和≤1.5；省略=由 LLM 结合文本与上下文自动调节）',
  properties: Object.fromEntries(VECTOR_KEYS.map((k) => [k, { type: 'number', description: VECTOR_ZH[k] }])),
}

/** 从工具执行上下文取近期对话消息（给情绪判定用） */
export function messagesOf(ctx) {
  return ctx?.executionContext?.messages || ctx?.messages || []
}

/**
 * 构造 tts_speak 工具。
 * @param {import('./service.js').TtsService} service
 */
export function makeTtsSpeakTool(service) {
  const voiceNames = service.voices('voice').map((v) => v.name)
  const emoNames = service.voices('emotion').map((v) => v.name)
  const voiceHint = voiceNames.length
    ? `可用音色参考：${voiceNames.slice(0, 12).join('、')}${voiceNames.length > 12 ? ' 等' : ''}（voice 参数按名字选；省略=默认音色）`
    : '尚未上传音色参考音频（需先在 Web 面板「语音合成」上传并命名，voice 参数按名字引用）'
  const emoHint = emoNames.length ? `（可用情绪参考：${emoNames.join('、')}）` : '（还没有情绪参考音频）'

  return {
    name: 'tts_speak',
    description: [
      '把文字合成为语音并发送到当前聊天（TTS / IndexTTS 2.5）。仅在需要指定音色/情绪点播时调用：普通回复在开启自动语音（agent.tts.autoReply）时会自动出声，本工具调用后本轮不再自动补发。',
      '文本会先自动清洗成讲稿（剥除 md/代码/链接/表情，破折号转停顿）再合成，无需自己处理格式。',
      voiceHint + '。',
      '情绪模式 emotionMode（默认 same）：same=沿用音色参考音频的情绪；audio=另提供情绪参考音频（emotionRef + emotionWeight 控制影响强度）' + emoHint + '；vector=8 维情绪向量（默认由 LLM 结合要说的文本与近期对话上下文自动调节，不需要手填）。',
      '档位 tier（仅 vector 模式）：pro=整段文本一套情绪一次合成（默认，快）；max=按文本语义按需拆分、逐段判定情绪分别合成再用 ffmpeg 合并（更细腻、耗时更长，适合长文本/情绪起伏大）。',
      '重复要求、闲聊式的短句别用语音；生成失败会把错误如实告诉你，不要编造已发送。',
    ].join(''),
    category: 'message',
    meta: { summary: 'TTS语音合成发送', interactive: true, sideEffects: ['message'] },
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

    async execute(p = {}, ctx = {}) {
      const r = await service.synthesize({
        text: p.text,
        voice: p.voice,
        emotionMode: p.emotionMode,
        emotionRef: p.emotionRef,
        emotionWeight: p.emotionWeight,
        vector: p.vector,
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
