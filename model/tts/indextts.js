/**
 * IndexTTS-2.5 HTTP 客户端（Gradio 5.45 原生协议 + 鉴权网关，零第三方依赖）。
 *
 * 协议流程（详见 /root/IndexTTS-2.5/IndexTTS-2.5_API_接入文档.md v1.3）：
 *   1) POST /gradio_api/upload            —— multipart（字段名 files）上传参考音频 → 服务端临时路径
 *   2) POST /gradio_api/queue/join        —— { data:[26 项], fn_index, session_hash, ... } → event_id
 *   3) GET  /gradio_api/queue/data?session_hash=  —— SSE，等 process_completed（按 event_id 过滤）
 *   4) GET  /gradio_api/file=<path>       —— 下载合成结果（wav 22050Hz 单声道）
 *
 * 鉴权（v1.2 起）：对外端口由鉴权网关承接，所有请求需 API Key（可选，官方无鉴权时留空）：
 *   - 请求头 `X-API-Key: itts_xxx`（或 Authorization: Bearer，本客户端用 X-API-Key）；
 *   - 401=未授权（缺/错 key）、429=鉴权失败限流、503=网关配置故障、502/504=上游未就绪；
 *   - 不支持 URL 查询参数传 key。
 *
 * 关键约定（文档实测踩坑）：
 *  - fn_index 与情绪选项文案随服务重启/界面语言变化，**必须从 GET /config 动态解析**，不能写死；
 *  - 参数里的文件必须传 { path, meta:{_type:'gradio.FileData'} }，只传路径字符串会 pydantic 校验失败；
 *  - 情绪向量顺序固定：[高兴, 愤怒, 悲伤, 恐惧, 反感, 低落, 惊讶, 平静]，各分量 0~1.2、总和 ≤ 1.5。
 *
 * 本模块只做协议，不做业务编排（分段/合并/发送见 service.js）；fetchImpl/logger 可注入便于离线自检。
 */

const EMO_METHOD_FALLBACK = {
  same: 'Same as the voice reference',
  audio: 'Use emotion reference audio',
  vector: 'Use emotion vectors',
  text: 'Use text description to control emotion',
}

/** 情绪向量键序（与 IndexTTS 第 6~13 项一一对应） */
export const VECTOR_KEYS = ['happy', 'angry', 'sad', 'afraid', 'disgusted', 'melancholic', 'surprised', 'calm']
export const VECTOR_ZH = { happy: '高兴', angry: '愤怒', sad: '悲伤', afraid: '害怕', disgusted: '厌恶', melancholic: '忧郁', surprised: '惊讶', calm: '平静' }

/** 键名别名 → 规范键（LLM 可能回中文名/近义词/大小写；全部归一，避免静默清零） */
export const VECTOR_ALIASES = {
  高兴: 'happy', 开心: 'happy', 喜悦: 'happy', joy: 'happy', glad: 'happy', excited: 'happy',
  愤怒: 'angry', 生气: 'angry', anger: 'angry', annoyed: 'angry',
  悲伤: 'sad', 难过: 'sad', sadness: 'sad', sorrow: 'sad',
  害怕: 'afraid', 恐惧: 'afraid', fear: 'afraid', scared: 'afraid', frightened: 'afraid',
  厌恶: 'disgusted', 反感: 'disgusted', disgust: 'disgusted', dislike: 'disgusted',
  忧郁: 'melancholic', 低落: 'melancholic', melancholy: 'melancholic', blue: 'melancholic',
  惊讶: 'surprised', surprise: 'surprised', amazed: 'surprised', shocked: 'surprised',
  平静: 'calm', 中性: 'calm', neutral: 'calm', peaceful: 'calm',
}

/** 把 {任意键: 值} 归一到规范键（大小写不敏感；未知键忽略） */
export function normalizeVectorKeys(v) {
  if (!v || typeof v !== 'object') return v
  if (Array.isArray(v)) return v
  const out = {}
  for (const [k, val] of Object.entries(v)) {
    const raw = String(k).trim()
    const key = VECTOR_KEYS.includes(raw) ? raw
      : VECTOR_KEYS.includes(raw.toLowerCase()) ? raw.toLowerCase()
        : VECTOR_ALIASES[raw] || VECTOR_ALIASES[raw.toLowerCase()] || null
    if (key) out[key] = val
  }
  return out
}

/** 文件引用结构（Gradio 5.45 要求显式 meta） */
export function fileData(remotePath) {
  return { path: String(remotePath), meta: { _type: 'gradio.FileData' } }
}

/**
 * 归一化情绪向量：对象/数组 → 8 维数组；分量夹到 0~1.2，总和超 1.5 时按比例缩放（保持相对强弱）。
 * @param {object|number[]|null} v
 * @returns {number[]}
 */
export function clampVector(v) {
  const src = normalizeVectorKeys(v)
  const arr = Array.isArray(src)
    ? VECTOR_KEYS.map((_, i) => Number(src[i]) || 0)
    : VECTOR_KEYS.map((k) => Number(src?.[k]) || 0)
  const out = arr.map((n) => Math.min(1.2, Math.max(0, Number.isFinite(n) ? n : 0)))
  const sum = out.reduce((a, b) => a + b, 0)
  if (sum > 1.5) {
    const k = 1.5 / sum
    return out.map((n) => Math.round(n * k * 100) / 100)
  }
  return out.map((n) => Math.round(n * 100) / 100)
}

/** 向量数组 → { happy: .. } 对象（给日志/返回用） */
export function vectorToObject(arr) {
  const o = {}
  VECTOR_KEYS.forEach((k, i) => { o[k] = Number(arr?.[i]) || 0 })
  return o
}

/** 网关错误码 → 可读提示（v1.3 文档 2.1/12 节） */
export function httpHint(status) {
  if (status === 401) return '鉴权失败：未带或错误的 API Key —— 在 Web 面板「语音合成 → IndexTTS」填写 itts_xxx（官方无鉴权网关时可留空）'
  if (status === 429) return '鉴权失败次数过多被网关限流，请稍后重试'
  if (status === 503) return '网关配置故障（keys.yaml/gateway.yaml 缺失或损坏），需在服务器修复后自动恢复'
  if (status === 502 || status === 504) return '网关上游不可用（IndexTTS 本体未就绪或超时），请确认 indextts-p40 服务正常'
  return ''
}

export class IndexTtsClient {
  /**
   * @param {object} opts
   *   endpoint  服务地址，如 http://127.0.0.1:7860（自动去尾部 /）
   *   apiKey    网关 API Key（可选，itts_xxx；留空=请求不加鉴权头）
   *   timeoutMs 单次合成总超时（默认 300s；文本情绪模式每段约 10~12s）
   *   fetchImpl 注入 fetch（离线自检用）
   *   logger    (level, ...args) => void
   */
  constructor({ endpoint, apiKey, timeoutMs = 300000, fetchImpl, logger } = {}) {
    this.base = String(endpoint || '').trim().replace(/\/+$/, '')
    this.apiKey = String(apiKey || '').trim()
    this.timeoutMs = Number(timeoutMs) || 300000
    this.fetch = fetchImpl || fetch
    this.logger = logger || (() => {})
    this._info = null // { at, fnIndex, callbacks, emoMethods }
  }

  get endpoint() { return this.base }

  /** 鉴权头（仅配置了 key 时附加；网关文档：X-API-Key 或 Bearer 二选一） */
  _authHeaders(extra = {}) {
    const h = { ...extra }
    if (this.apiKey) h['X-API-Key'] = this.apiKey
    return h
  }

  /** 动态解析 fn_index 与情绪选项文案（缓存 10 分钟；失败不缓存，下次重试） */
  async configInfo({ force = false } = {}) {
    const fresh = this._info && Date.now() - this._info.at < 10 * 60 * 1000
    if (!force && fresh) return this._info
    if (!this.base) throw new Error('IndexTTS 接口地址未配置（Web 面板 → 语音合成 → IndexTTS 填写）')
    let cfg
    try {
      cfg = await this._getJson(`${this.base}/config`)
    } catch (e) {
      throw new Error(`IndexTTS 配置获取失败（${this.base}/config）：${e?.message || e}。请确认服务已启动、地址可达`)
    }
    const deps = Array.isArray(cfg?.dependencies) ? cfg.dependencies : []
    // fn_index 解析：与官方参考实现一致，优先用依赖条目的 id（服务重启/升级后 id 可能不等于数组下标）
    const idxOf = (apiName) => {
      const dep = deps.find((d) => d && d.api_name === apiName)
      if (!dep) return null
      return Number.isFinite(dep.id) ? dep.id : deps.indexOf(dep)
    }
    const fnIndex = idxOf('gen_single')
    if (fnIndex == null) throw new Error('IndexTTS /config 未找到 gen_single 依赖（服务版本不匹配？升级后请复核接口文档）')
    // 情绪方法选项：radio 组件 + choices 长度为 4，按索引 0~3 取 value（不依赖界面语言）。
    // 真实 /config 的 choices 是 [label, value] 元组数组（参考 client_http_raw.py 取 c[1]），
    // 也有字符串/对象形态（不同 Gradio 版本），三种都要兼容——曾因只认字符串导致解析失败静默回退英文默认。
    const comps = Array.isArray(cfg?.components) ? cfg.components : []
    let choices = null
    for (const c of comps) {
      const ch = c?.props?.choices
      if (c?.type !== 'radio' || !Array.isArray(ch) || ch.length !== 4) continue
      const vals = ch
        .map((x) => {
          if (Array.isArray(x)) return typeof x[1] === 'string' ? x[1] : x[0]
          return typeof x === 'string' ? x : x?.value
        })
        .filter((x) => typeof x === 'string')
      if (vals.length === 4) { choices = vals; break }
    }
    const emoMethods = { ...EMO_METHOD_FALLBACK }
    if (choices) {
      emoMethods.same = choices[0]
      emoMethods.audio = choices[1]
      emoMethods.vector = choices[2]
      emoMethods.text = choices[3]
    } else {
      this.logger('warn', '[tts] /config 未找到 4 项情绪选项 radio 组件，回退英文默认文案')
    }
    this._info = { at: Date.now(), fnIndex, emoMethods, callbacks: { experimental: idxOf('on_experimental_change') } }
    this.logger('debug', `[tts] IndexTTS 已解析：fn_index=${fnIndex}（gen_single），情绪选项=${Object.values(emoMethods).join(' | ')}`)
    return this._info
  }

  /** 上传参考音频 → 服务端临时路径 */
  async upload(buffer, filename = 'ref.wav') {
    if (!this.base) throw new Error('IndexTTS 接口地址未配置')
    const fd = new FormData()
    fd.append('files', new Blob([buffer]), String(filename))
    let r
    try {
      r = await this.fetch(`${this.base}/gradio_api/upload`, { method: 'POST', body: fd, headers: this._authHeaders(), signal: this._signal() })
    } catch (e) {
      throw new Error(`IndexTTS 上传失败（网络错误）：${e?.message || e}`)
    }
    if (!r.ok) throw new Error(`IndexTTS 上传失败（HTTP ${r.status}）${httpHint(r.status) ? ` —— ${httpHint(r.status)}` : ''}`)
    const arr = await r.json().catch(() => null)
    const first = Array.isArray(arr) ? arr[0] : null
    const p = typeof first === 'string' ? first : first?.path
    if (!p) throw new Error('IndexTTS 上传响应异常（未返回文件路径）')
    return String(p)
  }

  /**
   * 合成一次（26 项参数，见接口文档第 4 节）。
   * @param {object} p
   *   text 要朗读的文本；refRemotePath 音色参考（服务端路径，必填）
   *   mode same|audio|vector|text；emoRemotePath 情绪参考（audio）
   *   emoWeight 0~1；vector 8 维（vector）；emoText 情感描述（text；空=分析 text 本身）
   *   lang ZH|EN|JA|AR|ES；durationFactor；maxTextTokensPerSegment；sampling 高级采样覆盖
   * @returns {Promise<{ buffer: Buffer, remotePath: string, url: string }>}
   */
  async synthesize(p = {}) {
    const { fnIndex, emoMethods } = await this.configInfo()
    const mode = EMO_METHOD_FALLBACK[p.mode] ? p.mode : 'same'
    const method = emoMethods[mode] || EMO_METHOD_FALLBACK[mode]
    const vec = clampVector(p.vector)
    const sampling = {
      do_sample: true, top_p: 0.8, top_k: 30, temperature: 0.8,
      length_penalty: 0.0, num_beams: 3, repetition_penalty: 10.0, max_mel_tokens: 1500,
      ...(p.sampling || {}),
    }
    const data = [
      method,
      fileData(p.refRemotePath),
      String(p.text || ''),
      String(p.lang || 'ZH'),
      mode === 'audio' && p.emoRemotePath ? fileData(p.emoRemotePath) : null,
      Number.isFinite(Number(p.emoWeight)) ? Number(p.emoWeight) : 0.65,
      vec[0], vec[1], vec[2], vec[3], vec[4], vec[5], vec[6], vec[7],
      mode === 'text' ? String(p.emoText || '') : '',
      false,
      Number.isFinite(Number(p.maxTextTokensPerSegment)) ? Number(p.maxTextTokensPerSegment) : 100,
      Number.isFinite(Number(p.durationFactor)) ? Number(p.durationFactor) : 1.0,
      sampling.do_sample, sampling.top_p, sampling.top_k, sampling.temperature,
      sampling.length_penalty, sampling.num_beams, sampling.repetition_penalty, sampling.max_mel_tokens,
    ]
    const sessionHash = `agents-plugin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    let eventId
    try {
      const r = await this.fetch(`${this.base}/gradio_api/queue/join`, {
        method: 'POST',
        headers: this._authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ data, fn_index: fnIndex, session_hash: sessionHash, event_data: null, trigger_id: null, batched: false }),
        signal: this._signal(),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}${await this._errText(r)}${httpHint(r.status) ? ` —— ${httpHint(r.status)}` : ''}`)
      const j = await r.json().catch(() => null)
      eventId = j?.event_id
      if (!eventId) throw new Error('未返回 event_id')
    } catch (e) {
      throw new Error(`IndexTTS 提交任务失败：${e?.message || e}`)
    }
    const out = await this._waitResult(sessionHash, eventId)
    const buf = await this._download(out)
    return { buffer: buf, remotePath: out.path, url: out.url }
  }

  /** 连通性自检（Web「测试连接」）：只探 /config + 解析结果，不做真实合成 */
  async check() {
    const t0 = Date.now()
    try {
      const info = await this.configInfo({ force: true })
      return { ok: true, endpoint: this.base, fnIndex: info.fnIndex, emoMethods: info.emoMethods, tookMs: Date.now() - t0 }
    } catch (e) {
      return { ok: false, endpoint: this.base, error: e?.message || String(e), tookMs: Date.now() - t0 }
    }
  }

  // ─── 内部实现 ───

  _signal() { return AbortSignal.timeout(this.timeoutMs) }

  async _getJson(url) {
    const r = await this.fetch(url, { signal: AbortSignal.timeout(Math.min(this.timeoutMs, 15000)), headers: this._authHeaders() })
    if (!r.ok) throw new Error(`HTTP ${r.status}${httpHint(r.status) ? ` —— ${httpHint(r.status)}` : ''}`)
    return r.json()
  }

  async _errText(r) {
    try { const t = await r.text(); return t ? `：${t.slice(0, 160)}` : '' } catch { return '' }
  }

  /** 等待 SSE 的 process_completed；返回结果文件 { path, url } */
  async _waitResult(sessionHash, eventId) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const r = await this.fetch(`${this.base}/gradio_api/queue/data?session_hash=${encodeURIComponent(sessionHash)}`, { signal: controller.signal, headers: this._authHeaders() })
      if (!r.ok || !r.body) throw new Error(`结果流不可用（HTTP ${r.status}）${httpHint(r.status) ? ` —— ${httpHint(r.status)}` : ''}`)
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line.startsWith('data:')) continue
          let msg
          try { msg = JSON.parse(line.slice(5).trim()) } catch { continue }
          if (!msg || msg.event_id !== eventId) continue
          if (msg.msg === 'process_completed') {
            if (msg.success === false || msg.output?.error) {
              throw new Error(`IndexTTS 合成失败：${String(msg.output?.error || '未知错误').slice(0, 300)}`)
            }
            const item = msg.output?.data?.[0]
            const v = item?.value ?? item
            const path = typeof v === 'string' ? v : v?.path
            if (!path) throw new Error('IndexTTS 返回结果缺少文件路径')
            return { path: String(path), url: typeof v === 'object' ? String(v?.url || '') : '' }
          }
          if (msg.msg === 'close_stream') throw new Error('IndexTTS 结果流提前关闭（任务可能被中断，查看服务端日志）')
        }
      }
      throw new Error('IndexTTS 结果流结束但未收到完成事件（超时或服务端异常）')
    } catch (e) {
      if (controller.signal.aborted) throw new Error(`IndexTTS 合成超时（${Math.round(this.timeoutMs / 1000)}s）`)
      throw e
    } finally {
      clearTimeout(timer)
      try { controller.abort() } catch { /* noop */ }
    }
  }

  /** 下载合成结果（优先用服务端返回的 url，回落按 path 拼 /gradio_api/file=） */
  async _download(out) {
    const url = out.url && /^https?:\/\//.test(out.url)
      ? out.url
      : `${this.base}/gradio_api/file=${out.path}`
    const r = await this.fetch(url, { signal: this._signal(), headers: this._authHeaders() })
    if (!r.ok) throw new Error(`IndexTTS 结果下载失败（HTTP ${r.status}）${httpHint(r.status) ? ` —— ${httpHint(r.status)}` : ''}`)
    return Buffer.from(await r.arrayBuffer())
  }
}
