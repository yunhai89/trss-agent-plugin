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
import { planEmotion, splitByPunctuation, normalizeContext, MAX_SEGMENTS, MAX_SEGMENT_CHARS } from './emotion.js'
import { stripForSpeech } from './speech-text.js'
import { RefLibrary } from './refs.js'
import { concatSegments, runFfmpeg } from './audio.js'
import { enhanceVoice } from './enhance.js'
import { createKeyedLock } from '../agent/store/lock.js'

export const TTS_LANGS = ['ZH', 'EN', 'JA', 'AR', 'ES']
export const TTS_TEXT_MAX = 5000

/** 配置默认值（config/default_config/config.yaml 的 agent.tts 同口径） */
export const TTS_DEFAULTS = {
  enable: true,
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
    judgeTimeoutMs: 30000,  // 情绪判定单次调用总预算（毫秒；超时中止请求并回退默认向量，不拖语音）
    durationFactor: 1.0,
    maxTextTokensPerSegment: 100,
  },
}

const _isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

/** 归一配置：缺省回落默认（旧配置/面板缺字段均安全） */
export function normalizeTtsConfig(cfg = {}) {
  const out = { ...TTS_DEFAULTS, ...(cfg || {}) }
  out.indextts = { ...TTS_DEFAULTS.indextts, ...(cfg?.indextts || {}) }
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
    this.client = new IndexTtsClient({ endpoint: ix.endpoint, apiKey: ix.apiKey, timeoutMs: ix.timeoutMs, fetchImpl, logger: this.logger })
    this.ffmpegRunner = ffmpegRunner || runFfmpeg
  }

  /** 当前服务商 id（多服务商预留；尚未接第二个时恒为 indextts） */
  get provider() { return this.cfg.provider || 'indextts' }

  /** 参考音频列表（可按 kind 过滤） */
  voices(kind) { return this.refs.list(kind) }

  /** 连通性自检（Web「测试连接」+ 服务状态） */
  async check() {
    return this.client.check()
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
    const ix = this.cfg.indextts
    const notes = []
    const fail = (msg) => { this.logger('warn', `[tts] 合成未执行：${msg}`); return { ok: false, error: msg } }
    const rawText = String(p.text || '').trim()
    if (!rawText) return fail('合成文本为空')
    if (rawText.length > TTS_TEXT_MAX) return fail(`文本过长（${rawText.length} 字，上限 ${TTS_TEXT_MAX}）；请分段调用或多轮发送`)
    // 讲稿清洗统一在合成入口做（自动回复与 tts_speak 点播同一条链路）：剥 md/代码/链接/emoji、破折号转停顿；
    // maxChars（自动回复传入）时按句截断，0/缺省不截断（点播原文由调用方决定长度）。
    const text = stripForSpeech(rawText, { maxChars: Number(p.maxChars) || 0 })
    if (!text) return fail('文本清洗后无可朗读内容（仅符号/代码/链接？）')

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
      let baseVector = parseVectorParam(p.vector) || parseVectorParam(ix.vector)
      let segments = null
      let reason = ''
      if (ix.autoEmotion !== false && this.llm) {
        const plan = await planEmotion(this.llm, {
          text, tier: 'max', voiceName: voice.name, logger: this.logger,
          context: normalizeContext(p.context?.messages),
          maxSegments: MAX_SEGMENTS, maxSegmentChars: Number(ix.maxSegmentChars) || MAX_SEGMENT_CHARS,
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
        segments = splitByPunctuation(text, Number(ix.maxSegmentChars) || MAX_SEGMENT_CHARS)
          .slice(0, MAX_SEGMENTS)
          .map((t) => ({ text: t, vector: baseVector || clampVector(null) }))
        if (segments.length > 1) notes.push(`已按标点拆分为 ${segments.length} 段`)
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
        this.logger('info', `[tts] 合成完成：${mode}/max ${files.length}段 音色=${voice.name} ${text.length}字 用时=${Date.now() - t0}ms${hd.enhanced ? '（已高清增强）' : ''}`)
        return {
          ok: true, file: hd.file, rawFile: finalFile, enhanced: hd.enhanced, tier: 'max', mode, voice: voice.name, lang, chars: text.length,
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
