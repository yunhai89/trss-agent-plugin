/**
 * MediaDescriber —— 伪人看图（配置了视觉模型时）。
 *
 * 群友消息里的图片以 URL 形态存在于 AmbientMessage.media；Planner/Replyer 的上下文里只有
 * '[图片]' 占位。本模块把窗口内近期图片交视觉模型（rt.vision，VisionService.analyze）转成
 * 一句话描述，注回消息文本（'[图片]' → '[图:一张猫咪表情包，配字哈哈]'），让伪人"看得见"图。
 *
 * 约束：
 *  - 未配视觉模型（rt.vision 为 null）→ 全部 no-op，占位照旧；
 *  - 每轮最多描述 maxPerTurn（默认 3）张，优先目标消息的图，其次最近消息的图——控制成本；
 *  - 按 URL 哈希缓存（LRU，默认 120），同图重复出现不重复调 API；失败静默跳过（保持占位）；
 *  - 只处理 http(s) URL（QQ 多媒体域），本地 file/id 无法拉取。
 */
import { createHash } from 'node:crypto'

const DESC_PROMPT = '这是群聊里的一张图片。用一句话简述内容（≤30字）：是什么图（表情包/截图/照片/聊天记录/商品图…）、画面要点、有字就念出关键文字。直接输出描述本身。'

export class MediaDescriber {
  /**
   * @param {object} opts { vision?(VisionService), maxPerTurn?:number, cacheSize?:number, fetcher?, trace? }
   */
  constructor({ vision = null, maxPerTurn = 3, cacheSize = 120, fetcher = null, trace = null } = {}) {
    this.vision = vision
    this.maxPerTurn = Math.max(0, maxPerTurn | 0)
    this._cache = new Map() // urlHash → desc
    this._cacheSize = cacheSize
    this._fetcher = fetcher || globalThis.fetch
    this.trace = trace
  }

  /** 可用性（未配视觉模型=false，调用方据此跳过）。 */
  get available() { return !!(this.vision && typeof this.vision.analyze === 'function') }

  _hash(url) { return createHash('sha1').update(String(url)).digest('hex').slice(0, 16) }

  /** 拉取并描述一张图（带缓存）。失败/不可拉取返回 ''。 */
  async describeUrl(url) {
    const u = String(url || '')
    if (!/^https?:\/\//i.test(u)) return ''
    const h = this._hash(u)
    if (this._cache.has(h)) {
      const v = this._cache.get(h)
      this._cache.delete(h); this._cache.set(h, v) // LRU touch
      return v
    }
    try {
      const res = await this._fetcher(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const mime = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0]
      if (!mime.startsWith('image/')) throw new Error(`not image: ${mime}`)
      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.length > 12 * 1024 * 1024) throw new Error('too large')
      const desc = String(await this.vision.analyze({ buffer, mime, name: h }, DESC_PROMPT, { maxTokens: 120 }) || '').trim().slice(0, 60)
      if (this._cache.size >= this._cacheSize) { const k = this._cache.keys().next().value; this._cache.delete(k) }
      this._cache.set(h, desc)
      return desc
    } catch (e) {
      if (this._cache.size >= this._cacheSize) { const k = this._cache.keys().next().value; this._cache.delete(k) }
      this._cache.set(h, '') // 负缓存：本轮失败的图不再重试（占位保留）
      this.trace?.record?.('vision_desc_fail', { urlHash: h, msg: String(e?.message || e).slice(0, 60) })
      return ''
    }
  }

  /**
   * 给一批消息注图描述（返回新数组，不改原消息）。优先 target 的图，其次最近的图；
   * 每轮最多 maxPerTurn 张新描述（缓存命中的不限量）。
   * @param {Array<AmbientMessage>} messages 上下文窗口（旧→新）
   * @param {object} opts { targetId?:string }
   * @returns {Promise<Array<AmbientMessage>>} 文本中 '[图片]' 被替换为 '[图:描述]' 的浅拷贝数组
   */
  async annotate(messages = [], { targetId = null } = {}) {
    if (!this.available || !Array.isArray(messages) || !messages.length) return messages
    // 候选：带 http 图片 URL 的消息（旧→新）
    const imgMsgs = messages.filter((m) => (m.media || []).some((x) => x?.kind === 'image' && /^https?:\/\//i.test(String(x.url || ''))))
    if (!imgMsgs.length) return messages
    const order = [
      ...imgMsgs.filter((m) => String(m.id) === String(targetId)),
      ...imgMsgs.filter((m) => String(m.id) !== String(targetId)).reverse(), // 最近优先
    ]
    let budget = this.maxPerTurn
    const descById = new Map()
    for (const m of order) {
      const imgs = (m.media || []).filter((x) => x?.kind === 'image' && /^https?:\/\//i.test(String(x.url || ''))).slice(0, 2)
      for (const img of imgs) {
        const cached = this._cache.has(this._hash(img.url))
        if (!cached && budget <= 0) continue
        const d = await this.describeUrl(img.url)
        if (d) {
          if (!descById.has(m.id)) descById.set(m.id, [])
          descById.get(m.id).push(d)
          if (!cached) budget--
        }
      }
      if (budget <= 0 && descById.size >= this.maxPerTurn + 1) break
    }
    if (!descById.size) return messages
    this.trace?.record?.('vision_desc', { annotated: descById.size })
    // 注回：每条消息按其图片数依次替换文本中的 '[图片]' 占位
    return messages.map((m) => {
      const ds = descById.get(m.id)
      if (!ds || !ds.length) return m
      let i = 0
      const text = String(m.text || '').replace(/\[图片\]/g, () => (i < ds.length ? `[图:${ds[i++]}]` : '[图片]'))
      return { ...m, text }
    })
  }
}
