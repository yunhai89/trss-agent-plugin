/**
 * GPT-SoVITS 客户端（api_v2 原生 HTTP，零第三方依赖）。
 *
 * 协议（API v2，本地常驻服务 https://github.com/RVC-Boss/GPT-SoVITS）：
 *   POST http://127.0.0.1:9880/tts
 *   Body: {
 *     text,                       // 要朗读的文本
 *     text_lang: 'zh',            // zh/en/ja/ko/yue/auto
 *     ref_audio_path: '<wav>',    // 音色参考（服务端本地路径，3~10 秒）
 *     prompt_text: '<参考文本>',  // 参考音频的逐字文本（v2ProPlus 必填且要与音频一致）
 *     prompt_lang: 'zh',
 *     text_split_method: 'cut5',  // cut0 不切 / cut5 按标点+长度切
 *     batch_size: 1,
 *     media_type: 'wav',          // wav = 整段返回；raw = 裸 PCM（流式）
 *     streaming_mode: false,      // 本客户端取整段（服务端 RTF≈0.4，无需流式）
 *     parallel_infer: false
 *   }
 *   响应: audio/wav（单声道 32 kHz，16 bit）
 *
 * 说明：GPT-SoVITS 没有情绪参数——音色与语气完全由参考音频决定，所以 providers.js 里
 * 该服务商 caps.emotions = 'none'，不参与 LLM 情绪判定，也不下发任何风格字段。
 * 长文本由服务端 text_split_method 自行切段，本客户端一次请求拿完整音频。
 *
 * 供 service.js 调用；fetchImpl/logger 可注入便于离线自检。
 */

export const SOVITS_ENDPOINT = 'http://127.0.0.1:9880'
export const SOVITS_SPLIT_METHODS = ['cut0', 'cut1', 'cut2', 'cut3', 'cut4', 'cut5']
/**
 * 插件统一语言码 → GPT-SoVITS text_lang。
 * 注意：v2/v2Pro/v2ProPlus 只认 zh/en/ja/ko/yue/auto，阿拉伯语/西班牙语会直接 400；
 * 这里不映射 AR/ES，调用方传这两个语言码时由 `_body` 回落到配置的 textLang（默认 zh）。
 */
export const SOVITS_LANG = { ZH: 'zh', EN: 'en', JA: 'ja', KO: 'ko', YUE: 'yue', AUTO: 'auto' }

/** 把面板/配置里的 zh、ZH、auto 等统一成服务端认识的语言码；非法值回落到 zh */
function normalizeLang(v, fallback = 'zh') {
  return SOVITS_LANG[String(v || '').trim().toUpperCase()] || fallback
}

/** HTTP 状态码 → 提示 */
export function sovitsHttpHint(status) {
  if (status === 400) return '服务返回 400：多半是参考音频路径不存在、参考文本与音频不匹配，或 v2ProPlus 权重未加载'
  if (status === 404) return '接口路径不存在：请确认地址是 GPT-SoVITS api_v2（默认 http://127.0.0.1:9880）'
  if (status === 503) return '服务暂不可用（api_v2 未就绪或模型正在加载）'
  if (status >= 500) return 'GPT-SoVITS 服务端异常，请查看服务日志 api.err'
  return ''
}

export class SovitsClient {
  /**
   * @param {object} opts
   *   endpoint       服务地址，如 http://127.0.0.1:9880（自动去尾部 /）
   *   refAudioPath   音色参考音频的【服务端本地绝对路径】（不经过上传，服务端直接读盘）
   *   promptText     参考音频对应的逐字文本
   *   promptLang     参考音频语种（默认 zh）
   *   textLang       默认合成语种（默认 zh；调用方传 lang 时会被覆盖）
   *   textSplitMethod 切段方式（默认 cut5）
   *   timeoutMs      单次合成超时（默认 120s；8 GB 卡 30 秒长文本约 7 秒）
   *   fetchImpl/logger 注入便于离线自检
   */
  constructor({
    endpoint,
    refAudioPath = '',
    promptText = '',
    promptLang = 'zh',
    textLang = 'zh',
    textSplitMethod = 'cut5',
    timeoutMs = 120000,
    fetchImpl,
    logger,
  } = {}) {
    this.base = String(endpoint || SOVITS_ENDPOINT).trim().replace(/\/+$/, '')
    this.refAudioPath = String(refAudioPath || '').trim()
    this.promptText = String(promptText || '').trim()
    this.promptLang = normalizeLang(promptLang, 'zh')
    this.textLang = normalizeLang(textLang, 'zh')
    this.textSplitMethod = SOVITS_SPLIT_METHODS.includes(textSplitMethod) ? textSplitMethod : 'cut5'
    this.timeoutMs = Math.max(10000, Number(timeoutMs) || 120000)
    this.fetch = fetchImpl || fetch
    this.logger = logger || (() => {})
  }

  /** 请求体（reference 路径必须由服务端可读；跨机器部署时需自行保证路径一致） */
  _body(text, lang) {
    const code = String(lang || '').toUpperCase()
    // 不支持的语言（AR/ES）回落到默认 textLang，避免把服务端会 400 的代码发出去
    const textLang = SOVITS_LANG[code] || this.textLang
    return {
      text: String(text || ''),
      text_lang: textLang,
      ref_audio_path: this.refAudioPath,
      prompt_text: this.promptText,
      prompt_lang: this.promptLang,
      text_split_method: this.textSplitMethod,
      batch_size: 1,
      media_type: 'wav',
      streaming_mode: false,
      parallel_infer: false,
    }
  }

  /**
   * 合成一段文本。
   * @param {object} p
   *   text 必填；lang 插件语言码（ZH/EN/JA/AR/ES）
   * @returns {Promise<{buffer: Buffer, ext: string}>}
   */
  async synthesize(p = {}) {
    const text = String(p.text || '').trim()
    if (!text) throw new Error('合成文本为空')
    if (!this.refAudioPath) throw new Error('GPT-SoVITS 参考音频路径未配置（Web 面板 → 语音合成 → GPT-SoVITS）')

    let r
    try {
      r = await this.fetch(`${this.base}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._body(text, p.lang)),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new Error(`GPT-SoVITS 合成超时（${Math.round(this.timeoutMs / 1000)}s）；文本过长时可调大超时或改用 cut5 切段`)
      }
      throw new Error(`GPT-SoVITS 连接失败（${this.base}）：${e?.message || e}。请确认 api_v2 已启动`)
    }

    if (!r.ok) {
      // api_v2 的错误体是 {"message":"tts failed","Exception":"..."}，把 Exception 摘要带出去便于排查
      let detail = ''
      try {
        const body = await r.text()
        const j = JSON.parse(body)
        detail = String(j?.Exception || j?.message || '').split('\n')[0].slice(0, 200)
      } catch { /* noop */ }
      const hint = sovitsHttpHint(r.status)
      throw new Error(`GPT-SoVITS 合成失败（HTTP ${r.status}）${detail ? `：${detail}` : ''}${hint ? ` —— ${hint}` : ''}`)
    }

    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length) throw new Error('GPT-SoVITS 返回了空音频（检查参考音频与参考文本是否匹配）')
    return { buffer: buf, ext: 'wav' }
  }

  /** 连通性自检（真实合成 2 个字，与面板「测试连接」一致） */
  async check() {
    const t0 = Date.now()
    if (!this.refAudioPath) return { ok: false, endpoint: this.base, error: '参考音频路径未配置', tookMs: 0 }
    const sample = { en: 'Hello', ja: 'こんにちは', ko: '안녕하세요', yue: '你好', zh: '你好' }[this.textLang] || '你好'
    try {
      const r = await this.synthesize({ text: sample })
      return { ok: true, endpoint: this.base, bytes: r.buffer.length, tookMs: Date.now() - t0 }
    } catch (e) {
      return { ok: false, endpoint: this.base, error: e?.message || String(e), tookMs: Date.now() - t0 }
    }
  }
}
