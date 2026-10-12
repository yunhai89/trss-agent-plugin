/**
 * 小米 MiMo TTS 客户端（MiMo-V2.5-TTS，OpenAI 兼容 Chat Completions，零第三方依赖）。
 *
 * 协议（官方文档 2026-07 版：MiMo 开放平台 → 使用指南 → 语音合成）：
 *   POST https://api.xiaomimimo.com/v1/chat/completions
 *   Headers: api-key: <api_key>（官方同时兼容 Authorization: Bearer）
 *   Body: { model: mimo-v2.5-tts, messages: [
 *             { role:'user', content:<自然语言风格指令/音色描述> },   // 可选（voicedesign 必填）
 *             { role:'assistant', content:<要朗读的文本> }            // 文本必须在 assistant
 *           ], audio:{ format:'wav'|'mp3'|'pcm16', voice:<预置音色> } }
 *   响应: { choices:[{ message:{ audio:{ data:<base64> } } }] }
 *
 * 情绪：官方没有离散情绪参数——通过 user 指令（自然语言）控制；本插件由 LLM 判定 8 维情绪后
 * 确定性生成风格指令（providers.js styleInstructionFor），与 IndexTTS 走同一条判定链路。
 *
 * 供 service.js 调用；fetchImpl/logger 可注入便于离线自检。
 */

export const MIMO_ENDPOINT = 'https://api.xiaomimimo.com/v1'
export const MIMO_MODELS = ['mimo-v2.5-tts', 'mimo-v2.5-tts-voicedesign']

/** HTTP 状态码 → 提示 */
export function mimoHttpHint(status) {
  if (status === 401) return '鉴权失败：API Key 缺失或无效（MiMo 控制台 → API Key）'
  if (status === 403) return '无权限：请确认账号已开通 MiMo TTS'
  if (status === 429) return '触发限流（RPM 超限），请稍后重试'
  if (status >= 500) return 'MiMo 服务端异常，请稍后重试'
  return ''
}

export class MimoTtsClient {
  constructor({ endpoint, apiKey, model = 'mimo-v2.5-tts', voice = 'mimo_default', timeoutMs = 120000, fetchImpl, logger } = {}) {
    this.endpoint = String(endpoint || MIMO_ENDPOINT).trim().replace(/\/+$/, '')
    this.apiKey = String(apiKey || '').trim()
    this.model = MIMO_MODELS.includes(model) ? model : 'mimo-v2.5-tts'
    this.voice = String(voice || 'mimo_default').trim() || 'mimo_default'
    this.timeoutMs = Math.max(10000, Number(timeoutMs) || 120000)
    this.fetch = fetchImpl || fetch
    this.logger = logger || (() => {})
  }

  /**
   * 合成一段文本。
   * @param {object} p
   *   text 必填；style 自然语言风格指令（可为空）；voice 预置音色覆盖；format wav/mp3
   * @returns {Promise<{buffer: Buffer, ext: string, usage: object|null}>}
   */
  async synthesize(p = {}) {
    if (!this.apiKey) throw new Error('MiMo API Key 未配置（Web 面板 → 语音合成 → MiMo）')
    const format = ['wav', 'mp3'].includes(p.format) ? p.format : 'wav'
    const style = String(p.style || '').trim()
    const isVoiceDesign = this.model === 'mimo-v2.5-tts-voicedesign'
    if (isVoiceDesign && !style) throw new Error('音色设计模型需要「固定风格指令」描述想要的音色（Web 面板 → 语音合成 → MiMo）')
    const messages = []
    if (style) messages.push({ role: 'user', content: style })
    messages.push({ role: 'assistant', content: String(p.text || '') })
    const audio = { format }
    if (!isVoiceDesign) audio.voice = String(p.voice || this.voice || 'mimo_default')

    let r
    try {
      r = await this.fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.apiKey,
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, messages, audio, stream: false }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(`MiMo 合成超时（${Math.round(this.timeoutMs / 1000)}s）`)
      throw new Error(`MiMo 请求失败（网络错误）：${e?.message || e}`)
    }
    if (Number(r.headers.get('content-length')) > 64 * 1024 * 1024) throw new Error('MiMo 响应体过大（>64MB），已拒绝')
    const j = await r.json().catch(() => null)
    if (!r.ok) {
      const hint = mimoHttpHint(r.status)
      const msg = String(j?.error?.message || j?.message || '').slice(0, 160)
      throw new Error(`MiMo 合成失败（HTTP ${r.status}）${msg ? `：${msg}` : ''}${hint ? ` —— ${hint}` : ''}`)
    }
    if (j?.error) throw new Error(`MiMo 合成失败：${String(j.error.message || '未知错误').slice(0, 160)}`)
    const b64 = String(j?.choices?.[0]?.message?.audio?.data || '')
    if (!b64) throw new Error('MiMo 响应缺少音频数据（choices[0].message.audio.data 为空）')
    const buffer = Buffer.from(b64, 'base64')
    if (!buffer.length) throw new Error('MiMo 音频数据解码为空（base64 格式异常）')
    return { buffer, ext: format, usage: j?.usage || null }
  }

  /** 连通性自检：真实合成 2 个字（voicedesign 用固定默认音色描述） */
  async check() {
    const t0 = Date.now()
    if (!this.apiKey) return { ok: false, endpoint: this.endpoint, error: 'API Key 未配置', tookMs: 0 }
    try {
      const r = await this.synthesize({
        text: '你好',
        style: this.model === 'mimo-v2.5-tts-voicedesign' ? '一位声音温和自然的年轻女生' : '',
        format: 'mp3',
      })
      return { ok: true, endpoint: this.endpoint, model: this.model, bytes: r.buffer.length, tookMs: Date.now() - t0 }
    } catch (e) {
      return { ok: false, endpoint: this.endpoint, error: e?.message || String(e), tookMs: Date.now() - t0 }
    }
  }
}
