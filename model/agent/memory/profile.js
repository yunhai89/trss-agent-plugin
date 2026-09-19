/**
 * ProfileStore —— 统一用户模型（跨会话结构化用户画像）。
 *
 * 定位：在 RecallStore（原始长期记忆，逐条事实）与 MemoryStore（模型自由笔记 MEMORY.md/USER.md）之间，
 * 维护一份**结构化、带证据、可纠错、会演进**的用户画像，供 system 侧的动态情境注入。
 *  - 分面（facet）：identity（身份/称呼）/ preference（偏好）/ communication（沟通风格）/
 *    expertise（专长）/ sensitivity（雷点忌讳）/ fact（事实）。
 *  - 每条 { id, claim, source: observed|inferred|corrected, confidence, evidence[], observedAt, updatedAt,
 *    status: active|superseded, prev[] }；来源可追溯，纠错保留审计链。
 *  - 隐式偏好：从用户消息统计（长度/表情/提问率/活跃时段）推断表达风格，标 source=inferred。
 *  - 显式记忆：由 RecallStore 的 active 条目 consolidate 而来（类型→分面），标 source=observed/corrected。
 *  - 写入前过威胁扫描（suspect 不注入）；库解耦，不依赖插件 Config，由 apps 注入 dir/kv/扫描器。
 *
 * 红线：画像只作偏置参考，不覆盖当前消息/权限；跨用户隔离；推断项标 inferred 且低置信；可被用户纠正/删除。
 */
import { createKeyedLock } from '../store/lock.js'
import { jaccard } from '../recall.js'

const FACETS = ['identity', 'preference', 'communication', 'expertise', 'sensitivity', 'fact']
const FACET_LABEL = {
  identity: '身份',
  preference: '偏好',
  communication: '沟通风格',
  expertise: '专长',
  sensitivity: '忌讳/雷点',
  fact: '其他事实',
}
// 注入顺序：身份/沟通风格优先（对"像不像懂你"影响最大）
const FACET_ORDER = ['identity', 'communication', 'preference', 'expertise', 'sensitivity', 'fact']

const DEFAULTS = {
  prefix: 'Yz:agent:profile:',
  maxChars: 600,
  inferAfter: 8,
  maxPerFacet: 8,
  dedup: 0.5,
}

function pid() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\uFE0F]/u
const QUESTION_RE = /[?？]|吗[？?]?\s*$|呢[？?]?\s*$|怎么|为什么|如何|是不是|有没有/

/** 记忆类型 → 分面 */
export function facetOfType(type, content = '') {
  const t = String(type || '')
  if (t === 'preference') return 'preference'
  if (t === 'name' || t === 'identity') return 'identity'
  if (t === 'correctionGone') return 'fact'
  const s = String(content || '')
  if (/喜欢|偏好|习惯|爱用|常用|讨厌|不喜欢|不爱/.test(s)) return 'preference'
  if (/叫我|称呼|名字|我是|我负责|我的工作|职业|居住|住在/.test(s)) return 'identity'
  if (/忌讳|别(?:再)?提|不要提|雷点|不喜欢被|反感/.test(s)) return 'sensitivity'
  return 'fact'
}

function emptyModel() {
  const facets = {}
  for (const f of FACETS) facets[f] = []
  return { v: 1, facets, stats: { msgs: 0, chars: 0, emojis: 0, questions: 0, hours: {}, firstSeen: 0, lastSeen: 0 }, updatedAt: 0 }
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v) }

export class ProfileStore {
  constructor({ kv, scanFn = null, prefix = DEFAULTS.prefix, maxChars = DEFAULTS.maxChars, inferAfter = DEFAULTS.inferAfter, maxPerFacet = DEFAULTS.maxPerFacet, dedup = DEFAULTS.dedup } = {}) {
    if (!kv) throw new Error('ProfileStore 需要 kv')
    this.kv = kv
    this.scanFn = typeof scanFn === 'function' ? scanFn : null
    this.prefix = prefix
    this.maxChars = maxChars
    this.inferAfter = inferAfter
    this.maxPerFacet = maxPerFacet
    this.dedup = dedup
    this._lock = createKeyedLock()
  }

  _key(userId) { return `${this.prefix}${userId}` }

  _normalize(raw) {
    const m = emptyModel()
    if (isObj(raw)) {
      if (isObj(raw.facets)) {
        for (const f of FACETS) if (Array.isArray(raw.facets[f])) m.facets[f] = raw.facets[f].filter((e) => e && typeof e.claim === 'string')
      }
      if (isObj(raw.stats)) m.stats = { ...m.stats, ...raw.stats, hours: isObj(raw.stats.hours) ? raw.stats.hours : {} }
      m.updatedAt = Number(raw.updatedAt) || 0
    }
    return m
  }

  async load(userId) {
    let raw = null
    try { raw = await this.kv.get(this._key(userId)) } catch { raw = null }
    return this._normalize(raw)
  }

  async _save(userId, model) {
    for (const f of FACETS) model.facets[f] = this._pruneFacet(model.facets[f])
    model.updatedAt = Date.now()
    try { await this.kv.set(this._key(userId), model) } catch { /* KV 失败不阻断对话 */ }
    return model
  }

  _pruneFacet(entries) {
    if (entries.length <= this.maxPerFacet) return entries
    const rank = (e) => {
      if (e.status === 'superseded') return -1
      const c = Number(e.confidence) || 0.5
      const age = Date.now() - (e.updatedAt || e.observedAt || 0)
      return c - age / (365 * 86400000)
    }
    return [...entries].sort((a, b) => rank(b) - rank(a)).slice(0, this.maxPerFacet)
  }

  /** 在分面内插入/合并一条（去重：相似 claim 合并证据；更高置信/纠正来源覆盖旧 claim）。调用方持锁。 */
  async _upsertLocked(model, { facet, claim, source = 'observed', confidence = 0.6, evidence = null, at = Date.now() }) {
    if (!FACETS.includes(facet)) facet = 'fact'
    const c = String(claim || '').trim()
    if (!c) return null
    let suspect = false
    if (this.scanFn) { try { suspect = !!this.scanFn(c) } catch { suspect = false } }
    const list = model.facets[facet]
    let matched = null
    for (const e of list) {
      if (e.status === 'superseded' || e.suspect) continue
      const hit = String(e.claim).includes(c) || c.includes(String(e.claim)) || jaccard(e.claim, c) >= this.dedup
      if (hit) { matched = e; break }
    }
    const ev = evidence == null ? [] : [String(evidence)]
    if (matched) {
      const takeover = source === 'corrected' || (Number(confidence) || 0) > (Number(matched.confidence) || 0)
      if (takeover) {
        matched.prev = [...(matched.prev || []), { claim: matched.claim, confidence: matched.confidence, source: matched.source, updatedAt: matched.updatedAt }]
        matched.claim = c
        matched.source = source
        matched.confidence = Math.max(Number(confidence) || 0, Number(matched.confidence) || 0)
      }
      matched.evidence = [...new Set([...(matched.evidence || []), ...ev])].slice(-10)
      if (suspect) matched.suspect = true
      matched.updatedAt = at
      return { action: takeover ? 'superseded' : 'merged', id: matched.id }
    }
    const entry = {
      id: pid(), claim: c, source, confidence: Number(confidence) || 0.6,
      evidence: ev, observedAt: at, updatedAt: at, status: 'active',
      ...(suspect ? { suspect: true } : {}),
    }
    list.push(entry)
    return { action: 'created', id: entry.id }
  }

  _bumpStats(model, text, at) {
    const s = model.stats
    const t = String(text || '')
    if (!t) return
    const capped = t.length > 2000 ? 2000 : t.length
    s.msgs += 1
    s.chars += capped
    if (EMOJI_RE.test(t)) s.emojis += 1
    if (QUESTION_RE.test(t)) s.questions += 1
    const h = new Date(at).getHours()
    s.hours[h] = (s.hours[h] || 0) + 1
    if (!s.firstSeen) s.firstSeen = at
    s.lastSeen = at
  }

  /** 隐式偏好推断：样本足够后按统计生成风格条目（幂等，合并进 communication/fact）。 */
  _inferStyle(model) {
    const s = model.stats
    if (s.msgs < this.inferAfter) return
    const avg = s.chars / s.msgs
    const emojiRate = s.emojis / s.msgs
    const askRate = s.questions / s.msgs
    const style = model.facets.communication
    const has = (kw) => style.some((e) => String(e.claim).includes(kw))
    if (avg <= 12 && !has('简短')) model._infer = (model._infer || []).concat([{ facet: 'communication', claim: '消息通常简短，偏好简洁直接的沟通', confidence: 0.5 }])
    else if (avg >= 80 && !has('详细')) model._infer = (model._infer || []).concat([{ facet: 'communication', claim: '习惯详细表达，可给足背景信息', confidence: 0.5 }])
    if (emojiRate >= 0.3 && !has('表情')) model._infer = (model._infer || []).concat([{ facet: 'communication', claim: '常用表情/颜文字，语气可放松活泼', confidence: 0.5 }])
    if (askRate >= 0.5 && !has('提问')) model._infer = (model._infer || []).concat([{ facet: 'communication', claim: '多以提问/求知为主，重视直接答案', confidence: 0.5 }])
    const hour = Object.entries(s.hours).sort((a, b) => b[1] - a[1])[0]
    if (hour && Number(hour[1]) >= Math.max(3, s.msgs * 0.3) && !has('活跃')) {
      const h = Number(hour[0])
      model._infer = (model._infer || []).concat([{ facet: 'fact', claim: `常在 ${String(h).padStart(2, '0')}:00-${String((h + 2) % 24).padStart(2, '0')}:00 活跃`, confidence: 0.4 }])
    }
  }

  /**
   * 单次摄入：更新统计 + 隐式推断 + 合并显式记忆，一次锁/一次落盘。
   * @param {string} o.userText 本轮用户原文（空/null 则只合并记忆，不计统计）
   * @param {Array}  o.memories RecallStore active 条目
   */
  async ingest(userId, { userText = '', memories = [], at = Date.now() } = {}) {
    if (!userId) return null
    return this._lock.withLock(this._key(userId), async () => {
      const model = await this.load(userId)
      if (typeof userText === 'string' && userText.trim()) this._bumpStats(model, userText, at)
      this._inferStyle(model)
      const inferred = model._infer || []
      for (const it of inferred) await this._upsertLocked(model, { ...it, source: 'inferred', evidence: 'stats', at })
      delete model._infer
      for (const mem of (memories || [])) {
        if (!mem || mem.suspect || mem.status === 'corrected' || mem.status === 'superseded') continue
        const claim = String(mem.content || '').trim()
        if (!claim) continue
        const facet = facetOfType(mem.type, claim)
        const source = mem.source === 'correction' ? 'corrected' : 'observed'
        await this._upsertLocked(model, { facet, claim, source, confidence: mem.confidence ?? 0.6, evidence: mem.id, at })
      }
      return this._save(userId, model)
    })
  }

  /** 仅统计 + 隐式推断 */
  observe(userId, { text, at = Date.now() } = {}) {
    return this.ingest(userId, { userText: text, memories: [], at })
  }

  /** 仅合并显式记忆 */
  consolidate(userId, memories, { at = Date.now() } = {}) {
    return this.ingest(userId, { userText: '', memories, at })
  }

  /** 主动纠正画像：命中 matchText 的条目置 superseded，并写入更正条目。 */
  async correct(userId, { matchText, newClaim, facet, confidence = 0.9 } = {}) {
    if (!userId) return { superseded: 0 }
    return this._lock.withLock(this._key(userId), async () => {
      const model = await this.load(userId)
      const now = Date.now()
      let superseded = 0
      const mt = String(matchText || '')
      if (mt) {
        for (const f of FACETS) {
          for (const e of model.facets[f]) {
            if (e.status === 'superseded') continue
            if (String(e.claim).includes(mt) || jaccard(e.claim, mt) >= this.dedup) {
              e.status = 'superseded'
              e.prev = [...(e.prev || []), { claim: e.claim, confidence: e.confidence, source: e.source, updatedAt: e.updatedAt }]
              e.updatedAt = now
              superseded++
            }
          }
        }
      }
      let added = null
      if (newClaim) {
        const f = FACETS.includes(facet) ? facet : facetOfType('fact', newClaim)
        const r = await this._upsertLocked(model, { facet: f, claim: newClaim, source: 'corrected', confidence, evidence: 'correction', at: now })
        added = r?.id || null
      }
      await this._save(userId, model)
      return { superseded, added }
    })
  }

  /** 取渲染块（Agent 注入入口） */
  async build(userId) {
    const model = await this.load(userId)
    return this._formatModel(model)
  }

  _formatModel(model) {
    if (!model) return ''
    const lines = []
    for (const f of FACET_ORDER) {
      const entries = (model.facets[f] || [])
        .filter((e) => e.status !== 'superseded' && !e.suspect)
        .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0))
      if (!entries.length) continue
      const seg = entries.map((e) => {
        const tag = e.source === 'inferred' ? '（推断）' : e.source === 'corrected' ? '（已更正）' : ''
        return `${e.claim}${tag}`
      }).join('；')
      lines.push(`${FACET_LABEL[f]}：${seg}`)
    }
    if (!lines.length) return ''
    const head = '## 关于这位用户的画像（长期归纳，非当前输入；仅作参考，以用户当前消息为准）'
    let body = lines.join('\n')
    const budget = Math.max(80, this.maxChars - head.length)
    if (body.length > budget) body = body.slice(0, budget) + '…'
    return `${head}\n${body}`
  }

  /** 扁平列出全部有效条目（Web/命令用） */
  async list(userId) {
    const model = await this.load(userId)
    const out = []
    for (const f of FACET_ORDER) {
      for (const e of model.facets[f] || []) out.push({ facet: f, ...e })
    }
    return out
  }

  /** 扁平列出全部条目 + 统计（Web 面板用） */
  async overview(userId) {
    const model = await this.load(userId)
    const entries = []
    for (const f of FACET_ORDER) for (const e of model.facets[f] || []) entries.push({ facet: f, ...e })
    return { entries, stats: model.stats, facetOrder: FACET_ORDER, facetLabel: FACET_LABEL }
  }

  /** 管理端手动写入/覆盖（source 默认 corrected=人工权威），走与内部一致的扫描+去重。 */
  async upsert(userId, { facet, claim, source = 'corrected', confidence = 0.9 } = {}) {
    if (!userId) return null
    const c = String(claim || '').trim()
    if (!c) return null
    return this._lock.withLock(this._key(userId), async () => {
      const model = await this.load(userId)
      const r = await this._upsertLocked(model, { facet: facet || facetOfType('fact', c), claim: c, source, confidence, evidence: 'manual', at: Date.now() })
      await this._save(userId, model)
      return r
    })
  }

  /** 按 id 移除单条（标记 superseded 保留审计链）。返回移除条数。 */
  async removeById(userId, entryId) {
    if (!userId || !entryId) return 0
    return this._lock.withLock(this._key(userId), async () => {
      const model = await this.load(userId)
      const now = Date.now()
      let n = 0
      for (const f of FACETS) {
        for (const e of model.facets[f]) {
          if (e.id === entryId && e.status !== 'superseded') {
            e.status = 'superseded'
            e.prev = [...(e.prev || []), { claim: e.claim, confidence: e.confidence, source: e.source, updatedAt: e.updatedAt }]
            e.updatedAt = now
            n++
          }
        }
      }
      if (n) await this._save(userId, model)
      return n
    })
  }

  async clear(userId) {
    try { await this.kv.del(this._key(userId)) } catch { /* noop */ }
    return { ok: true }
  }
}
