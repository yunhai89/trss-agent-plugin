/**
 * 豆包语音合成客户端（火山引擎 Seed-TTS，HTTP Chunked 单向流式，零第三方依赖）。
 *
 * 协议（官方文档 2026-09 版：豆包语音 → 同步语音合成 → 单向流式语音合成(HTTP)）：
 *   POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 *   Headers: X-Api-Key / X-Api-Resource-Id / X-Api-Request-Id(uuid) / Content-Type
 *   Body: { req_params: { text, speaker, model?, audio_params:{...}, additions? } }
 *   响应：HTTP Chunked，按行 NDJSON；每行一个事件：
 *     - code 0 / 3000：音频分片（data 为 base64，按到达顺序拼接）；
 *     - code 20000000：合成结束（可带 usage）；
 *     - 其他 code：失败（45000000 客户端通用 / 45000001 参数错误 / 55000000 服务端 / 55000001 session）。
 *
 * 情绪：
 *   - 1.0 多情感音色：audio_params.emotion（happy/sad/angry/...）+ emotion_scale(1~5)；
 *   - 2.0 音色：additions.context_texts 传自然语言语音指令（由 LLM 判定的情绪向量映射生成）。
 *
 * 供 service.js 调用；fetchImpl/logger 可注入便于离线自检。
 */
import crypto from 'node:crypto'

export const DOUBAO_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
export const DOUBAO_RESOURCE_IDS = ['seed-tts-2.0', 'seed-tts-1.0', 'seed-tts-1.0-concurr']
export const DOUBAO_MODELS = ['', 'seed-tts-2.0-standard', 'seed-tts-2.0-expressive']

/** 业务错误码 → 可读提示（官方错误码查询：docs.volcengine.com/docs/6561/2534853） */
export function doubaoHint(code) {
  const c = Number(code)
  if (c === 45000000) return '客户端通用错误（检查 API Key/资源版本/请求格式）'
  if (c === 45000001) return '请求参数错误（检查音色 ID 是否属于所选资源版本、文本长度是否超限）'
  if (c === 55000000) return '服务端通用错误，请稍后重试'
  if (c === 55000001) return '服务端 session 错误，请重试'
  if (c === 20000001) return '合成失败（文本命中风控/非法内容？）'
  return ''
}

/** HTTP 状态码 → 提示 */
export function doubaoHttpHint(status) {
  if (status === 401) return '鉴权失败：API Key 缺失或无效（控制台 → API Key 管理）'
  if (status === 403) return '无权限：请确认已在控制台开通「语音合成」并选择正确资源版本'
  if (status === 429) return '触发限流（QPS/并发超限），请稍后重试'
  if (status >= 500) return '火山引擎服务端异常，请稍后重试'
  return ''
}

/**
 * 解析 NDJSON 流式响应（导出供离线测试）。
 * @param {string} raw 完整响应文本（每行一个 JSON 事件）
 * @returns {{ audio: Buffer, usage: object|null }}
 */
export function parseDoubaoNdjson(raw) {
  const chunks = []
  let usage = null
  let ended = false
  for (const line of String(raw || '').split('\n')) {
    const s = line.trim()
    if (!s) continue
    let obj
    try { obj = JSON.parse(s) } catch { continue } // 容忍非 JSON 行
    const code = Number(obj?.code)
    if (code === 0 || code === 3000) {
      if (obj.data) chunks.push(Buffer.from(String(obj.data), 'base64'))
      if (obj.usage) usage = obj.usage
      continue
    }
    if (code === 20000000) { ended = true; if (obj.usage) usage = obj.usage; continue }
    const hint = doubaoHint(code)
    throw new Error(`豆包合成失败（code ${code}）：${String(obj?.message || '未知错误').slice(0, 160)}${hint ? ` —— ${hint}` : ''}`)
  }
  if (!chunks.length) throw new Error(ended ? '豆包合成结束但没有音频数据（可重试；仍失败请检查文本是否可朗读）' : '豆包合成响应为空（网络中断或服务异常）')
  return { audio: Buffer.concat(chunks), usage }
}

export class DoubaoTtsClient {
  /**
   * @param {object} opts
   *   endpoint/apiKey/resourceId/model；timeoutMs 单次请求超时；fetchImpl/logger 可注入
   */
  constructor({ endpoint, apiKey, resourceId = 'seed-tts-2.0', model = '', speaker = '', timeoutMs = 120000, fetchImpl, logger } = {}) {
    this.endpoint = String(endpoint || DOUBAO_ENDPOINT).trim().replace(/\/+$/, '')
    this.apiKey = String(apiKey || '').trim()
    this.resourceId = DOUBAO_RESOURCE_IDS.includes(resourceId) ? resourceId : 'seed-tts-2.0'
    this.model = DOUBAO_MODELS.includes(model) ? model : ''
    this.speaker = String(speaker || '').trim()
    this.timeoutMs = Math.max(10000, Number(timeoutMs) || 120000)
    this.fetch = fetchImpl || fetch
    this.logger = logger || (() => {})
  }

  /**
   * 合成一段文本。
   * @param {object} p
   *   text 必填；speaker 音色 ID 必填；format/sampleRate/speechRate/loudnessRate；
   *   emotionLabel（1.0）emotionScale（1~5）；instruct（2.0 语音指令）；useTagParser
   * @returns {Promise<{buffer: Buffer, ext: string, usage: object|null}>}
   */
  async synthesize(p = {}) {
    if (!this.apiKey) throw new Error('豆包 API Key 未配置（Web 面板 → 语音合成 → 豆包）')
    const speaker = String(p.speaker || this.speaker || '').trim()
    if (!speaker) throw new Error('豆包音色 ID 未配置（控制台「音色库」中的 voice_type）')
    const format = ['wav', 'mp3'].includes(p.format) ? p.format : 'wav'
    const audioParams = {
      format,
      sample_rate: Number(p.sampleRate) || 24000,
    }
    if (Number.isFinite(Number(p.speechRate)) && Number(p.speechRate) !== 0) audioParams.speech_rate = Number(p.speechRate)
    if (Number.isFinite(Number(p.loudnessRate)) && Number(p.loudnessRate) !== 0) audioParams.loudness_rate = Number(p.loudnessRate)
    if (p.emotionLabel) {
      audioParams.emotion = String(p.emotionLabel)
      const scale = Number(p.emotionScale)
      if (Number.isFinite(scale) && scale >= 1) audioParams.emotion_scale = Math.max(1, Math.min(5, Math.round(scale)))
    }
    const additions = {}
    if (p.instruct) additions.context_texts = [String(p.instruct)]
    if (p.useTagParser) additions.use_tag_parser = true
    if (p.explicitLanguage) additions.explicit_language = String(p.explicitLanguage)
    const reqParams = {
      text: String(p.text || ''),
      speaker,
      audio_params: audioParams,
    }
    if (this.model) reqParams.model = this.model
    if (Object.keys(additions).length) reqParams.additions = JSON.stringify(additions)

    let r
    try {
      r = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.apiKey,
          'X-Api-Resource-Id': this.resourceId,
          'X-Api-Request-Id': crypto.randomUUID(),
        },
        body: JSON.stringify({ req_params: reqParams }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(`豆包合成超时（${Math.round(this.timeoutMs / 1000)}s）`)
      throw new Error(`豆包请求失败（网络错误）：${e?.message || e}`)
    }
    if (!r.ok) {
      const hint = doubaoHttpHint(r.status)
      let detail = ''
      try { const t = await r.text(); detail = t ? `：${t.slice(0, 160)}` : '' } catch { /* noop */ }
      throw new Error(`豆包合成失败（HTTP ${r.status}）${detail}${hint ? ` —— ${hint}` : ''}`)
    }
    if (Number(r.headers.get('content-length')) > 64 * 1024 * 1024) throw new Error('豆包响应体过大（>64MB），已拒绝')
    const raw = await r.text()
    const { audio, usage } = parseDoubaoNdjson(raw)
    return { buffer: audio, ext: format, usage }
  }

  /** 连通性自检：真实合成 2 个字（占用极少计费字符，是官方唯一无副作用的探活方式） */
  async check() {
    const t0 = Date.now()
    if (!this.apiKey) return { ok: false, endpoint: this.endpoint, error: 'API Key 未配置', tookMs: 0 }
    if (!this.speaker) return { ok: false, endpoint: this.endpoint, error: '音色 ID 未配置（控制台音色库的 voice_type）', tookMs: 0 }
    try {
      const r = await this.synthesize({ text: '你好', speaker: this.speaker, format: 'mp3', sampleRate: 24000 })
      return { ok: true, endpoint: this.endpoint, resourceId: this.resourceId, bytes: r.buffer.length, tookMs: Date.now() - t0 }
    } catch (e) {
      return { ok: false, endpoint: this.endpoint, error: e?.message || String(e), tookMs: Date.now() - t0 }
    }
  }
}
