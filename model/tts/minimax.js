/**
 * MiniMax 语音合成客户端（T2A V2，HTTP 同步接口，零第三方依赖）。
 *
 * 协议（官方文档 2026 版：MiniMax 开放平台 → 同步语音合成 HTTP）：
 *   POST https://api.minimaxi.com/v1/t2a_v2 （国际站 https://api.minimax.io/v1/t2a_v2）
 *   Headers: Authorization: Bearer <api_key>；旧版账号可加 ?GroupId=<id>
 *   Body: { model, text, stream:false, voice_setting:{ voice_id, speed, vol, pitch, emotion? },
 *           audio_setting:{ sample_rate, bitrate, format, channel }, language_boost? }
 *   响应: { data:{ audio: <hex编码音频>, status }, extra_info:{ usage_characters, ... },
 *           base_resp:{ status_code, status_msg } } —— audio 是 **hex**（非 base64），需按 hex 解码。
 *
 * 情绪：voice_setting.emotion 支持 happy/sad/angry/fearful/disgusted/surprised/calm/fluent/whisper
 * （2.6/2.8 全量；文档建议一般让模型按文本自动匹配，本插件由 LLM 判定后显式下发以保持与 IndexTTS 一致）。
 *
 * 供 service.js 调用；fetchImpl/logger 可注入便于离线自检。
 */

export const MINIMAX_ENDPOINT = 'https://api.minimaxi.com/v1/t2a_v2'
export const MINIMAX_MODELS = ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo', 'speech-01-hd', 'speech-01-turbo']

/** base_resp.status_code → 可读提示（官方错误码查询：platform.minimaxi.com/docs/api-reference/errorcode） */
export function minimaxHint(code) {
  const c = Number(code)
  if (c === 0) return ''
  if (c === 1000) return '未知错误，请重试'
  if (c === 1001) return '合成超时，请重试或缩短文本'
  if (c === 1002) return '触发限流（RPM 超限），请稍后重试'
  if (c === 1004) return '鉴权失败：API Key 无效或未实名（平台 → 接口密钥）'
  if (c === 1039) return '触发 TPM 限流，请降低频率或缩短文本'
  if (c === 1042) return '非法字符超过 10%：请清理文本中的异常符号'
  if (c === 2013) return '输入参数异常（检查音色 ID / 模型 / emotion 是否受支持）'
  return ''
}

/** HTTP 状态码 → 提示 */
export function minimaxHttpHint(status) {
  if (status === 401) return '鉴权失败：API Key 缺失或无效'
  if (status === 429) return '触发限流，请稍后重试'
  if (status >= 500) return 'MiniMax 服务端异常，请稍后重试'
  return ''
}

export class MinimaxTtsClient {
  constructor({ endpoint, apiKey, groupId = '', model = 'speech-2.8-hd', voiceId = '', timeoutMs = 120000, fetchImpl, logger } = {}) {
    this.endpoint = String(endpoint || MINIMAX_ENDPOINT).trim().replace(/\/+$/, '')
    this.apiKey = String(apiKey || '').trim()
    this.groupId = String(groupId || '').trim()
    this.model = MINIMAX_MODELS.includes(model) ? model : 'speech-2.8-hd'
    this.voiceId = String(voiceId || '').trim()
    this.timeoutMs = Math.max(10000, Number(timeoutMs) || 120000)
    this.fetch = fetchImpl || fetch
    this.logger = logger || (() => {})
  }

  _url() {
    if (!this.groupId) return this.endpoint
    return this.endpoint + (this.endpoint.includes('?') ? '&' : '?') + 'GroupId=' + encodeURIComponent(this.groupId)
  }

  /**
   * 合成一段文本。
   * @param {object} p
   *   text/voiceId（可覆盖构造默认）/emotion（标签，可空）/speed/vol/pitch/format/sampleRate/bitrate/languageBoost
   * @returns {Promise<{buffer: Buffer, ext: string, usage: object|null}>}
   */
  async synthesize(p = {}) {
    if (!this.apiKey) throw new Error('MiniMax API Key 未配置（Web 面板 → 语音合成 → MiniMax）')
    const voiceId = String(p.voiceId || this.voiceId || '').trim()
    if (!voiceId) throw new Error('MiniMax 音色 ID 未配置（系统音色或复刻音色 ID）')
    const format = ['wav', 'mp3', 'flac'].includes(p.format) ? p.format : 'wav'
    const voiceSetting = { voice_id: voiceId }
    if (Number.isFinite(Number(p.speed))) voiceSetting.speed = Number(p.speed)
    if (Number.isFinite(Number(p.vol))) voiceSetting.vol = Number(p.vol)
    if (Number.isFinite(Number(p.pitch))) voiceSetting.pitch = Math.round(Number(p.pitch))
    if (p.emotion) voiceSetting.emotion = String(p.emotion)
    const audioSetting = {
      sample_rate: Number(p.sampleRate) || 32000,
      format,
      channel: 1,
    }
    if (format === 'mp3') audioSetting.bitrate = Number(p.bitrate) || 128000
    const body = {
      model: this.model,
      text: String(p.text || ''),
      stream: false,
      voice_setting: voiceSetting,
      audio_setting: audioSetting,
    }
    if (p.languageBoost) body.language_boost = String(p.languageBoost)

    let r
    try {
      r = await this.fetch(this._url(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(`MiniMax 合成超时（${Math.round(this.timeoutMs / 1000)}s）`)
      throw new Error(`MiniMax 请求失败（网络错误）：${e?.message || e}`)
    }
    if (!r.ok) {
      const hint = minimaxHttpHint(r.status)
      let detail = ''
      try { const t = await r.text(); detail = t ? `：${t.slice(0, 160)}` : '' } catch { /* noop */ }
      throw new Error(`MiniMax 合成失败（HTTP ${r.status}）${detail}${hint ? ` —— ${hint}` : ''}`)
    }
    if (Number(r.headers.get('content-length')) > 64 * 1024 * 1024) throw new Error('MiniMax 响应体过大（>64MB），已拒绝')
    const j = await r.json().catch(() => null)
    const code = Number(j?.base_resp?.status_code)
    if (!j || !Number.isFinite(code)) throw new Error('MiniMax 响应格式异常（缺少 base_resp）')
    if (code !== 0) {
      const msg = String(j?.base_resp?.status_msg || '未知错误').slice(0, 160)
      const hint = minimaxHint(code)
      throw new Error(`MiniMax 合成失败（code ${code}）：${msg}${hint ? ` —— ${hint}` : ''}`)
    }
    const hex = String(j?.data?.audio || '')
    if (!hex) throw new Error('MiniMax 合成成功但未返回音频数据（data.audio 为空）')
    const buffer = Buffer.from(hex, 'hex')
    if (!buffer.length) throw new Error('MiniMax 音频数据解码为空（hex 格式异常）')
    return { buffer, ext: format, usage: j?.extra_info || null }
  }

  /** 连通性自检：真实合成 2 个字（官方唯一无副作用的探活方式） */
  async check() {
    const t0 = Date.now()
    if (!this.apiKey) return { ok: false, endpoint: this.endpoint, error: 'API Key 未配置', tookMs: 0 }
    if (!this.voiceId) return { ok: false, endpoint: this.endpoint, error: '音色 ID 未配置', tookMs: 0 }
    try {
      const r = await this.synthesize({ text: '你好', format: 'mp3', sampleRate: 32000 })
      return { ok: true, endpoint: this.endpoint, model: this.model, bytes: r.buffer.length, tookMs: Date.now() - t0 }
    } catch (e) {
      return { ok: false, endpoint: this.endpoint, error: e?.message || String(e), tookMs: Date.now() - t0 }
    }
  }
}
