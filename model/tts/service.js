/**
 * TTS 服务编排层 —— 面向 Agent 的唯一入口（合成→分段/情绪→合并→返回文件）。
 *
 * 职责：
 *  - 配置归一（agent.tts.*，多服务商预留 provider 字段；当前实现 indextts）；
 *  - 音色/情绪参考解析（RefLibrary 按名字引用）；
 *  - 情绪模式：same=沿用参考情绪 / audio=情绪参考音频 / vector=8 维向量（默认 LLM 结合上下文自动调节）；
 *  - 档位：pro=整段一套情绪一次合成；max=LLM 按需拆分逐段情绪 → 逐段合成 → ffmpeg 合并（发送由工具层负责）；
 *  - 失败如实回退（LLM 不可用→标点分段+默认向量；拼接失败→报错不假装成功）。
 *
 * 依赖全部可注入（fetchImpl/llm/ffmpegRunner/now），离线自检不需要真实服务与网络。
 */
import fs from 'node:fs'
import path from 'node:path'
import { IndexTtsClient, clampVector, vectorToObject, VECTOR_ZH } from './indextts.js'
import { DoubaoTtsClient, DOUBAO_ENDPOINT } from './doubao.js'
import { MinimaxTtsClient, MINIMAX_ENDPOINT } from './minimax.js'
import { MimoTtsClient, MIMO_ENDPOINT } from './mimo.js'
import {
  PROVIDER_IDS, providerCaps, providerConfigured, labelFor, doubaoScaleFor, styleInstructionFor, langFor,
} from './providers.js'
import { planEmotion, splitByPunctuation, normalizeContext, MAX_SEGMENTS, MAX_SEGMENT_CHARS } from './emotion.js'
import { stripForSpeech } from './speech-text.js'
import { RefLibrary } from './refs.js'
import { concatSegments, runFfmpeg } from './audio.js'
import { enhanceVoice } from './enhance.js'
import { createKeyedLock } from '../agent/store/lock.js'

/**
 * 分段数硬上限：MAX_SEGMENTS（12）是给 LLM 规划提示词的"建议段数"，不能当作合成时的截断阈值——
 * 超过 12 段的长文本会被静默丢弃（只合成前 12 段却返回 ok:true 且 chars 为全文长度）。
 * 这里按文本长度推导实际需要的段数（保证覆盖全文），并留 4 倍余量作为成本/时延硬闸。
 */
const MAX_SEGMENTS_HARD = MAX_SEGMENTS * 4

/**
 * 分段上限：max(MAX_SEGMENTS, 覆盖全文所需段数)，并受 hardMax 约束。
 * 下限必须是 MAX_SEGMENTS——短文本拆成多段是"逐段情绪"的正常用法（不能因为字数少就把
 * LLM 规划好的多段压回 1 段）；上限随文本增长，保证长文本不被静默截断。
 */
export function segmentsNeeded(text, perSeg, hardMax = MAX_SEGMENTS_HARD) {
  const len = String(text || '').length
  const per = Math.max(20, Number(perSeg) || MAX_SEGMENT_CHARS)
  const hard = Math.max(MAX_SEGMENTS, Number(hardMax) || MAX_SEGMENTS_HARD)
  const need = Math.ceil(len / per) || 1
  return Math.max(MAX_SEGMENTS, Math.min(hard, need))
}

/** 截断说明：返回 null 表示未截断（段数在覆盖全文所需之内） */
function truncationNote(kept, all) {
  const charsOf = (arr) => arr.reduce((n, x) => n + String(x?.text ?? x ?? '').length, 0)
  return `内容超长：仅合成前 ${kept}/${all.length} 段（${charsOf(all.slice(0, kept))}/${charsOf(all)} 字），其余未合成。可缩短文本或调大 agent.tts.*.maxSegmentChars`
}

export const TTS_LANGS = ['ZH', 'EN', 'JA', 'AR', 'ES']
export const TTS_TEXT_MAX = 5000

/** 配置默认值（config/default_config/config.yaml 的 agent.tts 同口径） */
export const TTS_DEFAULTS = {
  enable: false,          // 总开关默认关（opt-in）：开启后才注册 tts_speak 且自动语音才生效
  provider: 'indextts',
  autoReply: true,        // 开启后每条最终回复自动合成语音（文字/图片照常发，随后追加语音）
  replyMaxChars: 300,     // 自动语音最大字符数（超长按句截断；0=不限）
  hdVoice: true,          // 发送前高清化：响度标准化 + 存在感补偿（失败自动回退原始音频）
  indextts: {
    endpoint: '',
    apiKey: '',             // 网关 API Key（可选，itts_xxx；官方无鉴权时留空）
    lang: 'ZH',
    timeoutMs: 300000,
    voice: '',              // 默认音色参考名（留空=取最新上传的 voice）
    emotionMode: 'same',    // same | audio | vector
    emotionRef: '',         // audio 模式默认情绪参考名
    emotionWeight: 0.65,    // audio 模式情绪混合强度 0~1
    vector: null,           // vector 模式默认向量（LLM 自动调节失败时的回退；留空=全 0）
    autoEmotion: true,      // vector 模式由 LLM 结合文本+上下文自动调节（关=用上面默认向量）
    tier: 'pro',            // pro=整段一套 / max=按需拆分逐段
    segmentGapMs: 300,      // max 档段间静音毫秒
    maxSegmentChars: MAX_SEGMENT_CHARS,
    model: '',              // 情绪判定用模型（模型条目 id/模型名；留空=utilityModel→主模型）
    judgeTimeoutMs: 300000, // 情绪判定单次调用总预算（毫秒；超时中止请求并回退默认向量，不拖语音）
    durationFactor: 1.0,
    maxTextTokensPerSegment: 100,
  },
  // 云服务商（默认关闭/未配置状态；enable 总开关 + provider 选中 + 密钥/音色齐全才会真正出网）
  doubao: {
    endpoint: DOUBAO_ENDPOINT,
    apiKey: '',
    resourceId: 'seed-tts-2.0',   // seed-tts-2.0 | seed-tts-1.0 | seed-tts-1.0-concurr
    speaker: '',                  // 音色 ID（控制台音色库 voice_type）
    model: '',                    // '' | seed-tts-2.0-standard | seed-tts-2.0-expressive
    autoEmotion: true,            // LLM 判定情绪（2.0→语音指令 / 1.0→情感标签）
    instruct: '',                 // 固定语音指令（context_texts；留空=LLM 判定生成）
    emotion: '',                  // 固定情感标签（1.0；LLM 失败/关闭时回退）
    emotionScale: 0,              // 0=按判定强度自动；1~5=固定 emotion_scale
    speechRate: 0,                // -50~100（100=2 倍速）
    loudnessRate: 0,              // -50~100（100=2 倍音量）
    sampleRate: 24000,
    format: 'wav',                // wav | mp3
    useTagParser: false,          // 声音复刻 2.0 表现力增强版 Cot 标签解析
    tier: 'pro',                  // pro=整段一次 | max=LLM 分段逐段情绪后 ffmpeg 合并
    segmentGapMs: 300,            // max 档段间静音（毫秒）
    maxSegmentChars: MAX_SEGMENT_CHARS, // max 档单段字符上限（LLM 分段/标点回退）
    timeoutMs: 120000,
  },
  minimax: {
    endpoint: MINIMAX_ENDPOINT,
    apiKey: '',
    groupId: '',                  // 旧版账号查询参数（可选）
    model: 'speech-2.8-hd',
    voiceId: '',                  // 系统音色/复刻音色 ID
    autoEmotion: true,            // LLM 判定 8 维情绪 → MiniMax 标签
    emotion: '',                  // 固定情绪标签（LLM 失败/关闭时回退）
    speed: 1.0,
    vol: 1.0,
    pitch: 0,
    sampleRate: 32000,
    format: 'wav',                // wav | mp3 | flac
    bitrate: 128000,              // 仅 mp3 生效
    languageBoost: '',            // ''=自动 | Chinese/English/... | auto
    tier: 'pro',
    segmentGapMs: 300,            // max 档段间静音（毫秒）
    maxSegmentChars: MAX_SEGMENT_CHARS, // max 档单段字符上限（LLM 分段/标点回退）
    timeoutMs: 120000,
  },
  mimo: {
    endpoint: MIMO_ENDPOINT,
    apiKey: '',
    model: 'mimo-v2.5-tts',       // mimo-v2.5-tts | mimo-v2.5-tts-voicedesign
    voice: 'mimo_default',        // 预置音色（voicedesign 模型忽略）
    autoEmotion: true,            // LLM 判定 → 自然语言风格指令（复合情绪/语速/发声方式）+ 音频标签
    style: '',                    // 固定风格/音色描述指令（留空=LLM 判定生成；voicedesign 必填）
    tagMode: 'auto',              // 音频标签：auto=句首 (风格) + 行内 [标签]（经原文保真校验）| style=只加句首 | off=不用
    format: 'wav',                // wav | mp3
    tier: 'pro',
    segmentGapMs: 300,            // max 档段间静音（毫秒）
    maxSegmentChars: MAX_SEGMENT_CHARS, // max 档单段字符上限（LLM 分段/标点回退）
    timeoutMs: 120000,
  },
  judgeModel: '',                 // 情绪判定模型（留空=indextts.model → utilityModel → 主模型）
  judgeTimeoutMs: 300000,         // 情绪判定总预算（毫秒；对全部服务商生效）
}

const _isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

/** 归一配置：缺省回落默认（旧配置/面板缺字段均安全；各服务商子配置同样补齐） */
export function normalizeTtsConfig(cfg = {}) {
  const src = cfg || {}
  const out = { ...TTS_DEFAULTS, ...src }
  for (const id of ['indextts', 'doubao', 'minimax', 'mimo']) {
    out[id] = { ...TTS_DEFAULTS[id], ...(src[id] || {}) }
  }
  return out
}

/** 向量参数（对象或数组）→ 8 维数组；未提供（空对象/全 0 且未显式给键）返回 null */
export function parseVectorParam(v) {
  if (v == null) return null
  if (Array.isArray(v)) {
    if (!v.some((n) => Number(n) > 0)) return null
    return clampVector(v)
  }
  if (_isObj(v)) {
    if (!Object.values(v).some((x) => Number(x) > 0)) return null
    return clampVector(v)
  }
  return null
}

export class TtsService {
  /**
   * @param {object} cfg agent.tts 配置
   * @param {object} opts { dataDir, logger, llm, fetchImpl, ffmpegRunner, now }
   */
  constructor(cfg, { dataDir, logger, llm, fetchImpl, ffmpegRunner, now } = {}) {
    this.cfg = normalizeTtsConfig(cfg)
    this.dataDir = dataDir || path.resolve(process.cwd(), 'data', 'tts')
    this.logger = logger || (() => {})
    this.llm = llm || null
    this.now = now || Date.now
    this.refs = new RefLibrary({ dir: this.dataDir, logger: this.logger })
    this.lock = createKeyedLock({ maxKeys: 4 })
    const ix = this.cfg.indextts
    // 各服务商客户端（构造无网络请求；只在实际调用时才出网，未配置的服务商不会产生任何流量）
    this.clients = {
      indextts: new IndexTtsClient({ endpoint: ix.endpoint, apiKey: ix.apiKey, timeoutMs: ix.timeoutMs, fetchImpl, logger: this.logger }),
      doubao: new DoubaoTtsClient({ ...this.cfg.doubao, fetchImpl, logger: this.logger }),
      minimax: new MinimaxTtsClient({ ...this.cfg.minimax, fetchImpl, logger: this.logger }),
      mimo: new MimoTtsClient({ ...this.cfg.mimo, fetchImpl, logger: this.logger }),
    }
    this.client = this.clients.indextts // 兼容既有引用（IndexTTS 主客户端）
    this.ffmpegRunner = ffmpegRunner || runFfmpeg
  }

  /** 当前服务商 id（非法值安全回落 indextts） */
  get provider() {
    const id = String(this.cfg.provider || '').trim()
    return PROVIDER_IDS.includes(id) ? id : 'indextts'
  }

  /** 当前服务商能力（tools/服务路由用） */
  capabilities() { return providerCaps(this.provider) }

  /** 当前服务商配置是否齐全（启动日志/面板状态） */
  status() {
    const st = providerConfigured(this.provider, this.cfg)
    return { provider: this.provider, ...st }
  }

  /** 参考音频列表（可按 kind 过滤；云服务商不用参考库，恒为空） */
  voices(kind) { return this.capabilities().refs ? this.refs.list(kind) : [] }

  /** 连通性自检（Web「测试连接」+ 服务状态）；默认当前服务商 */
  async check(providerId) {
    const id = PROVIDER_IDS.includes(providerId) ? providerId : this.provider
    return this.clients[id].check()
  }

  /** 解析音色参考：参数（名字/id）> 配置默认名 > 最新 voice 条目 */
  _resolveVoice(voice) {
    const key = String(voice || '').trim()
    if (key) return this.refs.getByName(key, 'voice') || this.refs.get(key)
    const dft = String(this.cfg.indextts.voice || '').trim()
    if (dft) return this.refs.getByName(dft, 'voice') || this.refs.get(dft)
    return this.refs.list('voice')[0] || null
  }

  /** 解析情绪参考（audio 模式）：参数名 > 配置默认名 > 最新情绪参考；未命中给出可选清单 */
  _resolveEmotionRef(name) {
    const key = String(name || '').trim() || String(this.cfg.indextts.emotionRef || '').trim()
    if (!key) return this.refs.list('emotion')[0] || null
    return this.refs.getByName(key, 'emotion') || this.refs.get(key)
  }

  /**
   * 合成（不发送；由工具层发送）。串行执行（IndexTTS 单卡实际串行，排队不压测）。
   * @param {object} p
   *   text 必填；voice 音色参考名；emotionMode same|audio|vector；tier pro|max；
   *   emotionRef 情绪参考名；emotionWeight 0~1；vector 显式向量（给定则不跑 LLM）；
   *   lang；context { messages } 情绪判定用近期对话
   * @returns {Promise<{ok:true,file,tier,mode,voice,vector?,segments?,reason?,notes:[]}|{ok:false,error}>}
   */
  async synthesize(p = {}) {
    return this.lock.withLock('synth', () => this._synthesize(p))
  }

  async _synthesize(p) {
    const notes = []
    const fail = (msg) => { this.logger('warn', `[tts] 合成未执行：${msg}`); return { ok: false, error: msg } }
    const rawText = String(p.text || '').trim()
    if (!rawText) return fail('合成文本为空')
    if (rawText.length > TTS_TEXT_MAX) return fail(`文本过长（${rawText.length} 字，上限 ${TTS_TEXT_MAX}）；请分段调用或多轮发送`)
    // 讲稿清洗统一在合成入口做（自动回复与 tts_speak 点播同一条链路）：剥 md/代码/链接/emoji、破折号转停顿；
    // maxChars（自动回复传入）时按句截断，0/缺省不截断（点播原文由调用方决定长度）。
    const text = stripForSpeech(rawText, { maxChars: Number(p.maxChars) || 0 })
    if (!text) return fail('文本清洗后无可朗读内容（仅符号/代码/链接？）')

    if (this.provider !== 'indextts') return this._synthesizeCloud(text, p, { fail, notes })
    return this._synthesizeIndexTts(text, p, { fail, notes })
  }

  /** IndexTTS 专属路径（参考音频库 + same/audio/vector 模式 + pro/max 档位） */
  async _synthesizeIndexTts(text, p, { fail, notes }) {
    const ix = this.cfg.indextts
    const voice = this._resolveVoice(p.voice)
    if (!voice) {
      const want = String(p.voice || '').trim()
      const pool = this.voices('voice').map((r) => r.name)
      return fail(
        want
          ? `音色参考「${want}」不存在；可用：${pool.join('、') || '（尚未上传，请到 Web 面板「语音合成」上传并命名）'}`
          : '没有可用的音色参考音频：请在 Web 面板「语音合成 → IndexTTS」上传参考音频并命名',
      )
    }
    const voicePath = this.refs.filePath(voice)
    if (!voicePath || !fs.existsSync(voicePath)) return fail(`音色参考「${voice.name}」的文件不存在，请重新上传`)

    const mode = ['same', 'audio', 'vector'].includes(p.emotionMode) ? p.emotionMode : (['same', 'audio', 'vector'].includes(ix.emotionMode) ? ix.emotionMode : 'same')
    const lang = TTS_LANGS.includes(String(p.lang || ix.lang).toUpperCase()) ? String(p.lang || ix.lang).toUpperCase() : 'ZH'

    // 情绪参考（audio 模式）
    let emoRef = null
    if (mode === 'audio') {
      emoRef = this._resolveEmotionRef(p.emotionRef)
      if (!emoRef) {
        const pool = this.voices('emotion').map((r) => r.name)
        return fail(pool.length ? `情绪参考音频未指定或不存在；可用：${pool.join('、')}` : '情绪参考模式需要先上传情绪参考音频（Web 面板「语音合成 → IndexTTS → 参考音频」）')
      }
    }
    const emoWeight = Number.isFinite(Number(p.emotionWeight)) ? Math.min(1, Math.max(0, Number(p.emotionWeight))) : ix.emotionWeight

    // 档位：仅 vector 模式有 pro/max 之分
    let tier = ['pro', 'max'].includes(p.tier) ? p.tier : (['pro', 'max'].includes(ix.tier) ? ix.tier : 'pro')
    if (mode !== 'vector') tier = 'pro'

    // 可观测性：合成开始即可在控制台看到（此前只有 debug 级"合成完成"，用户无法判断是否在合成）
    const autoPlan = mode === 'vector' && !parseVectorParam(p.vector) && ix.autoEmotion !== false && !!this.llm
    this.logger('info', `[tts] 合成开始：音色=${voice.name} 模式=${mode}${autoPlan ? '(LLM自动调节)' : ''} 档位=${tier} 文本=${text.length}字${emoRef ? ` 情绪参考=${emoRef.name}` : ''}`)

    const t0 = this.now()
    const session = { voiceServerPath: null, emoServerPath: null }
    const uploadRef = async () => {
      if (!session.voiceServerPath) {
        const buf = fs.readFileSync(voicePath)
        session.voiceServerPath = await this.client.upload(buf, path.basename(voicePath))
      }
      return session.voiceServerPath
    }
    const uploadEmo = async () => {
      if (!session.emoServerPath) {
        const buf = fs.readFileSync(this.refs.filePath(emoRef))
        session.emoServerPath = await this.client.upload(buf, path.basename(this.refs.filePath(emoRef)))
      }
      return session.emoServerPath
    }

    const outDir = path.join(this.dataDir, 'out')
    const _writeOut = (buf, ext) => {
      fs.mkdirSync(outDir, { recursive: true })
      this._pruneOut(outDir)
      const f = path.join(outDir, `tts_${this.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`)
      fs.writeFileSync(f, buf)
      return f
    }

    try {
      // ── same / audio / vector-pro：一次合成 ──
      if (tier !== 'max') {
        let vectorArr = null
        let reason = ''
        if (mode === 'vector') {
          vectorArr = parseVectorParam(p.vector)
          if (vectorArr) reason = '调用方显式指定向量'
          else if (ix.autoEmotion !== false && this.llm) {
            const plan = await planEmotion(this.llm, {
              text, tier: 'pro', voiceName: voice.name, logger: this.logger,
              context: normalizeContext(p.context?.messages),
              timeoutMs: Number(ix.judgeTimeoutMs) || TTS_DEFAULTS.indextts.judgeTimeoutMs,
            })
            if (plan?.vector) { vectorArr = clampVector(plan.vector); reason = plan.reason }
            else notes.push('情绪判定不可用，已回退默认向量')
          }
          if (!vectorArr) vectorArr = parseVectorParam(ix.vector)
        }
        const refRemotePath = await uploadRef()
        const emoRemotePath = emoRef ? await uploadEmo() : null
        const r = await this.client.synthesize({
          text, lang, refRemotePath, mode,
          emoRemotePath, emoWeight, vector: vectorArr,
          durationFactor: ix.durationFactor, maxTextTokensPerSegment: ix.maxTextTokensPerSegment,
        })
        const file = _writeOut(r.buffer, 'wav')
        const hd = await this._applyHd(file)
        this.logger('info', `[tts] 合成完成：${mode}/${tier} 音色=${voice.name} ${text.length}字 用时=${Date.now() - t0}ms${hd.enhanced ? '（已高清增强）' : ''}`)
        return {
          ok: true, file: hd.file, rawFile: file, enhanced: hd.enhanced, tier, mode, voice: voice.name, lang, chars: text.length,
          ...(mode === 'vector' && vectorArr ? { vector: vectorToObject(vectorArr) } : {}),
          ...(reason ? { reason } : {}),
          notes,
        }
      }

      // ── max：LLM 按需拆分 → 逐段情绪 → 逐段合成 → ffmpeg 合并 ──
      const segCap = segmentsNeeded(text, Number(ix.maxSegmentChars) || MAX_SEGMENT_CHARS)
      let baseVector = parseVectorParam(p.vector) || parseVectorParam(ix.vector)
      let segments = null
      let reason = ''
      if (ix.autoEmotion !== false && this.llm) {
        const plan = await planEmotion(this.llm, {
          text, tier: 'max', voiceName: voice.name, logger: this.logger,
          context: normalizeContext(p.context?.messages),
          // 段数按文本长度推导（同一上限也写进 LLM 提示词），否则长文本必然丢内容
          maxSegments: segCap, maxSegmentChars: Number(ix.maxSegmentChars) || MAX_SEGMENT_CHARS,
          timeoutMs: Number(ix.judgeTimeoutMs) || TTS_DEFAULTS.indextts.judgeTimeoutMs,
        })
        if (plan?.segments?.length) {
          segments = plan.segments.map((s) => ({ text: s.text, vector: clampVector(s.vector) }))
          baseVector = baseVector || clampVector(plan.vector)
          reason = plan.reason
        } else {
          notes.push('情绪判定不可用，已按标点分段并使用默认向量')
        }
      } else {
        notes.push('LLM 自动调节已关闭，max 档按标点分段并使用默认向量')
      }
      if (!segments) {
        const allSegs = splitByPunctuation(text, Number(ix.maxSegmentChars) || MAX_SEGMENT_CHARS)
        if (allSegs.length > segCap) notes.push(truncationNote(segCap, allSegs))
        segments = allSegs
          .slice(0, segCap)
          .map((t) => ({ text: t, vector: baseVector || clampVector(null) }))
        if (segments.length > 1) notes.push(`已按标点拆分为 ${segments.length} 段`)
      } else if (segments.length > segCap) {
        // LLM 规划给出的段数超上限（长文本）：如实标注后再截断
        notes.push(truncationNote(segCap, segments))
        segments = segments.slice(0, segCap)
      }
      if (!segments.length) return { ok: false, error: '文本分段为空' }

      // 单段 → 等同 pro（避免无谓 ffmpeg）
      const refRemotePath = await uploadRef()
      const emoRemotePath = emoRef ? await uploadEmo() : null
      const tmpDir = path.join(this.dataDir, 'tmp')
      fs.mkdirSync(tmpDir, { recursive: true })
      const files = []
      try {
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i]
          const r = await this.client.synthesize({
            text: seg.text, lang, refRemotePath, mode,
            emoRemotePath, emoWeight, vector: seg.vector,
            durationFactor: ix.durationFactor, maxTextTokensPerSegment: ix.maxTextTokensPerSegment,
          })
          const f = path.join(tmpDir, `seg_${this.now()}_${process.pid}_${i}.wav`)
          fs.writeFileSync(f, r.buffer)
          files.push(f)
        }
        let finalFile
        if (files.length === 1) {
          finalFile = _writeOut(fs.readFileSync(files[0]), 'wav')
        } else {
          fs.mkdirSync(outDir, { recursive: true })
          this._pruneOut(outDir)
          finalFile = path.join(outDir, `tts_${this.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`)
          const merged = await concatSegments(files, finalFile, {
            gapMs: ix.segmentGapMs, tempDir: tmpDir, runner: this.ffmpegRunner, logger: this.logger,
          })
          if (!merged.ok) return { ok: false, error: `分段合成完成但合并失败：${merged.error}` }
        }
        const hd = await this._applyHd(finalFile)
        // chars 报"实际合成的字数"而非全文长度：曾恒定返回 text.length，配合静默截断
        // 让调用方以为全文都合成了
        const synthChars = segments.reduce((n, x) => n + String(x.text || '').length, 0)
        const truncated = synthChars < text.length
        this.logger('info', `[tts] 合成完成：${mode}/max ${files.length}段 音色=${voice.name} ${synthChars}/${text.length}字 用时=${Date.now() - t0}ms${hd.enhanced ? '（已高清增强）' : ''}`)
        return {
          ok: true, file: hd.file, rawFile: finalFile, enhanced: hd.enhanced, tier: 'max', mode, voice: voice.name, lang, chars: synthChars,
          ...(truncated ? { truncated: true, totalChars: text.length } : {}),
          segments: segments.map((s) => ({ text: s.text, vector: vectorToObject(s.vector) })),
          ...(baseVector ? { vector: vectorToObject(baseVector) } : {}),
          ...(reason ? { reason } : {}),
          notes,
        }
      } finally {
        for (const f of files) { try { fs.unlinkSync(f) } catch { /* noop */ } }
      }
    } catch (e) {
      this.logger('warn', '[tts] 合成失败：', e?.message || e)
      return { ok: false, error: e?.message || String(e) }
    }
  }

  /* ── 云服务商通用路径（豆包 / MiniMax / MiMo）──
   * 情绪判定仍走 emotion.js 的 LLM 链路（与 IndexTTS 同一套提示词与向量），
   * 再由 providers.js 映射为目标服务商参数：离散标签（豆包 1.0 / MiniMax）或
   * 自然语言指令（豆包 2.0 context_texts / MiMo user 指令）。 */

  /** 解析云端音色（参数覆盖 > 配置默认）；未配置返回 null */
  _resolveCloudVoice(id, override) {
    const key = String(override || '').trim()
    const dft = { doubao: this.cfg.doubao.speaker, minimax: this.cfg.minimax.voiceId, mimo: this.cfg.mimo.voice }
    const voice = key || String(dft[id] || '').trim()
    return voice || null
  }

  /** 情绪判定预算（全局 judgeTimeoutMs → 历史 indextts.judgeTimeoutMs → 默认 5 分钟） */
  _judgeTimeoutMs() {
    return Math.max(1000, Number(this.cfg.judgeTimeoutMs) || Number(this.cfg.indextts.judgeTimeoutMs) || TTS_DEFAULTS.judgeTimeoutMs)
  }

  async _synthesizeCloud(text, p, { fail, notes }) {
    const id = this.provider
    const cfgProv = this.cfg[id] || {}
    const voice = this._resolveCloudVoice(id, p.voice)
    if (!voice) {
      const missing = providerConfigured(id, this.cfg).missing.join('、')
      return fail(`${this._providerName(id)} 未配置${missing ? `（缺少：${missing}）` : ''}；请到 Web 面板「语音合成 → ${this._providerName(id)}」补全`)
    }
    const auto = cfgProv.autoEmotion !== false && !!this.llm
    const tier = ['pro', 'max'].includes(p.tier) ? p.tier : (['pro', 'max'].includes(cfgProv.tier) ? cfgProv.tier : 'pro')
    const maxSegChars = Math.max(20, Number(cfgProv.maxSegmentChars) || MAX_SEGMENT_CHARS) // max 档单段字符上限（面板可调）
    const segCap = segmentsNeeded(text, maxSegChars)
    const explicitVec = parseVectorParam(p.vector)
    let planVector = explicitVec
    let segments = null
    let reason = ''
    let planStyle = ''
    let planTag = ''
    let planTagged = ''
    let judgeFailed = false
    if (explicitVec) {
      reason = '调用方显式指定向量'
    } else if (auto) {
      const plan = await planEmotion(this.llm, {
        text, tier: tier === 'max' ? 'max' : 'pro',
        voiceName: voice, logger: this.logger,
        context: normalizeContext(p.context?.messages),
        timeoutMs: this._judgeTimeoutMs(),
        maxSegments: segCap, maxSegmentChars: maxSegChars,
      })
      if (plan?.vector) {
        planVector = clampVector(plan.vector)
        reason = plan.reason || ''
        planStyle = plan.style || ''
        planTag = plan.tag || ''
        planTagged = plan.tagged || ''
        segments = plan.segments ? plan.segments.map((s) => ({
          text: s.text, vector: clampVector(s.vector),
          style: s.style || '', tag: s.tag || '', tagged: s.tagged || '',
        })) : null
      } else {
        judgeFailed = true
        notes.push('情绪判定不可用，已按配置默认情绪回退')
      }
    }
    // 日志如实区分：自动判定失败回退 ≠ 主动关闭/固定（此前两者都显示"固定/关闭"，排查时误导）
    const emoDesc = explicitVec ? '显式向量'
      : (planVector ? 'LLM自动判定'
        : (judgeFailed ? '自动判定失败→回退默认' : '固定/关闭'))
    this.logger('info', `[tts] 合成开始：服务商=${id} 音色=${voice} 情绪=${emoDesc} 档位=${tier} 文本=${text.length}字`)

    const t0 = this.now()
    const outDir = path.join(this.dataDir, 'out')
    const writeOut = (buf, ext) => {
      fs.mkdirSync(outDir, { recursive: true })
      this._pruneOut(outDir)
      const f = path.join(outDir, `tts_${this.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`)
      fs.writeFileSync(f, buf)
      return f
    }
    const _segReturn = (segs) => ({
      segments: segs.map((s) => ({ text: s.text, ...(s.vector ? { vector: vectorToObject(s.vector) } : {}) })),
    })
    try {
      if (tier === 'max') {
        let segs
        if (segments && segments.length) {
          if (segments.length > segCap) {
            notes.push(truncationNote(segCap, segments))
            segs = segments.slice(0, segCap)
          } else segs = segments
        } else {
          const allSegs = splitByPunctuation(text, maxSegChars)
          if (allSegs.length > segCap) notes.push(truncationNote(segCap, allSegs))
          segs = allSegs.slice(0, segCap).map((t) => ({ text: t, vector: planVector }))
        }
        if (segs.length > 1) {
          if (!segments) notes.push(`已按标点拆分为 ${segs.length} 段`)
          const tmpDir = path.join(this.dataDir, 'tmp')
          fs.mkdirSync(tmpDir, { recursive: true })
          const files = []
          try {
            for (let i = 0; i < segs.length; i++) {
              const r = await this._cloudCall(id, {
                text: segs[i].text, voice, vector: segs[i].vector || planVector,
                style: segs[i].style || planStyle, tag: segs[i].tag || planTag, tagged: segs[i].tagged || '',
                p, forceWav: true,
              })
              const f = path.join(tmpDir, `cloud_${this.now()}_${process.pid}_${i}.${r.ext}`)
              fs.writeFileSync(f, r.buffer)
              files.push(f)
            }
            fs.mkdirSync(outDir, { recursive: true })
            this._pruneOut(outDir)
            const finalFile = path.join(outDir, `tts_${this.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`)
            const merged = await concatSegments(files, finalFile, {
              gapMs: Number(cfgProv.segmentGapMs) || 300, tempDir: tmpDir, runner: this.ffmpegRunner, logger: this.logger,
              sampleRate: Number(cfgProv.sampleRate) || 24000,
            })
            if (!merged.ok) return { ok: false, error: `分段合成完成但合并失败：${merged.error}` }
            const hd = await this._applyHd(finalFile)
            // chars = 实际合成的字数（曾恒为全文长度，掩盖静默截断）
            const synthChars = segs.reduce((n, x) => n + String(x.text || '').length, 0)
            const truncated = synthChars < text.length
            this.logger('info', `[tts] 合成完成：${id}/max ${files.length}段 音色=${voice} ${synthChars}/${text.length}字 用时=${Date.now() - t0}ms${hd.enhanced ? '（已高清增强）' : ''}`)
            return {
              ok: true, file: hd.file, rawFile: finalFile, enhanced: hd.enhanced, tier: 'max', mode: 'cloud', voice, chars: synthChars,
              ...(truncated ? { truncated: true, totalChars: text.length } : {}),
              ..._segReturn(segs),
              ...(planVector ? { vector: vectorToObject(planVector) } : {}),
              ...(reason ? { reason } : {}),
              notes,
            }
          } finally {
            for (const f of files) { try { fs.unlinkSync(f) } catch { /* noop */ } }
          }
        }
        // 单段等同 pro：继续走下方一次合成
      }
      const r = await this._cloudCall(id, { text, voice, vector: planVector, style: planStyle, tag: planTag, tagged: planTagged, p })
      const file = writeOut(r.buffer, r.ext)
      const hd = await this._applyHd(file)
      this.logger('info', `[tts] 合成完成：${id}/${tier} 音色=${voice} ${text.length}字 用时=${Date.now() - t0}ms${hd.enhanced ? '（已高清增强）' : ''}`)
      return {
        ok: true, file: hd.file, rawFile: file, enhanced: hd.enhanced, tier, mode: 'cloud', voice, chars: text.length,
        ...(planVector ? { vector: vectorToObject(planVector) } : {}),
        ...(segments?.length ? _segReturn(segments) : {}),
        ...(reason ? { reason } : {}),
        notes,
      }
    } catch (e) {
      this.logger('warn', '[tts] 合成失败：', e?.message || e)
      return { ok: false, error: e?.message || String(e) }
    }
  }

  /** 构造目标服务商的合成参数并调用（text 为已清洗讲稿；style/tag/tagged 为 LLM 判定的风格字段） */
  async _cloudCall(id, { text, voice, vector, style = '', tag = '', tagged = '', p, forceWav = false }) {
    const cfgProv = this.cfg[id] || {}
    const format = forceWav ? 'wav' : (['wav', 'mp3', 'flac'].includes(cfgProv.format) ? cfgProv.format : 'wav')
    const overrideEmotion = String(p.emotion || '').trim()
    const overrideStyle = String(p.style || '').trim()
    const lang = langFor(id, p.lang)
    if (id === 'doubao') {
      const is20 = String(cfgProv.resourceId || '').startsWith('seed-tts-2.0')
      // 2.0 语音指令优先用 LLM 判定的风格指令（比向量模板更细腻），回退模板
      const instruct = is20
        ? (overrideStyle || overrideEmotion || String(cfgProv.instruct || '').trim() || style || (vector ? styleInstructionFor(vector) : ''))
        : ''
      const label = overrideEmotion || String(cfgProv.emotion || '').trim()
        || (!is20 && vector ? labelFor('doubao', vector) : '')
      const scale = Number(cfgProv.emotionScale) > 0 ? Number(cfgProv.emotionScale) : (vector ? doubaoScaleFor(vector) : 0)
      const out = await this.clients.doubao.synthesize({
        text, speaker: voice, format,
        sampleRate: Number(cfgProv.sampleRate) || 24000,
        speechRate: Number(cfgProv.speechRate) || 0,
        loudnessRate: Number(cfgProv.loudnessRate) || 0,
        emotionLabel: label, emotionScale: scale, instruct,
        useTagParser: cfgProv.useTagParser === true,
        explicitLanguage: lang,
      })
      return { ...out, ext: format }
    }
    if (id === 'minimax') {
      const emotion = overrideEmotion || String(cfgProv.emotion || '').trim() || (vector ? labelFor('minimax', vector) : '')
      const out = await this.clients.minimax.synthesize({
        text, voiceId: voice, emotion, format,
        sampleRate: Number(cfgProv.sampleRate) || 32000,
        bitrate: Number(cfgProv.bitrate) || 128000,
        speed: Number(cfgProv.speed), vol: Number(cfgProv.vol), pitch: Number(cfgProv.pitch),
        languageBoost: String(cfgProv.languageBoost || '').trim() || lang,
      })
      return { ...out, ext: format }
    }
    // mimo：自然语言风格指令（LLM 判定 > 固定 > 向量模板）+ 音频标签（tagMode）
    const isDesign = cfgProv.model === 'mimo-v2.5-tts-voicedesign'
    const mimoStyle = overrideStyle || overrideEmotion || String(cfgProv.style || '').trim()
      || (!isDesign ? (style || (vector ? styleInstructionFor(vector) : '')) : '')
    const tagMode = ['off', 'style', 'auto'].includes(cfgProv.tagMode) ? cfgProv.tagMode : 'auto'
    let content = String(text || '')
    if (!isDesign && tagMode !== 'off') {
      const prefix = tag ? `(${tag})` : ''
      const body = (tagMode === 'auto' && tagged) ? tagged : content
      content = prefix + body
    }
    const out = await this.clients.mimo.synthesize({ text: content, style: mimoStyle, voice, format })
    return { ...out, ext: format }
  }

  /** 服务商中文名（错误信息用） */
  _providerName(id) {
    return { indextts: 'IndexTTS', doubao: '豆包语音合成', minimax: 'MiniMax 语音', mimo: '小米 MiMo TTS' }[id] || id
  }

  /** 高清化（agent.tts.hdVoice）：响度标准化 + 存在感补偿；失败回退原始文件（不阻断发送） */
  async _applyHd(file) {
    if (this.cfg.hdVoice === false) return { file, enhanced: false }
    const r = await enhanceVoice(file, { runner: this.ffmpegRunner, logger: this.logger, timeout: 90 })
    return r.ok ? { file: r.path, enhanced: true } : { file, enhanced: false }
  }

  /** 输出目录清理：只保留最近 200 个文件 / 7 天（best-effort，失败不影响合成） */
  _pruneOut(dir) {
    try {
      const now = this.now()
      const files = fs.readdirSync(dir)
        .map((name) => ({ name, p: path.join(dir, name) }))
        .filter((x) => { try { return fs.statSync(x.p).isFile() } catch { return false } })
        .map((x) => ({ ...x, m: fs.statSync(x.p).mtimeMs }))
        .sort((a, b) => b.m - a.m)
      for (let i = 0; i < files.length; i++) {
        if (i >= 200 || now - files[i].m > 7 * 86400000) { try { fs.unlinkSync(files[i].p) } catch { /* noop */ } }
      }
    } catch { /* noop */ }
  }
}

export { VECTOR_ZH }
