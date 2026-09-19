/**
 * 向量召回记忆 —— 每用户长期记忆，相似度×时间衰减排序召回、regex+LLM 双抽取、去重、遗忘。
 * 区别于声明式 MemoryStore（快照注入）：这是 recall 系统。
 * 对应 yunhai lib/agent/memory.js（已裁剪：无 PG/Milvus/Neo4j，仅 KV + 可选 embedding）。
 *
 * 条目：{ id, level:L2|L3|L4, type, content, confidence, embedding?, createdAt, updatedAt, prev? }
 */

import { createKeyedLock } from './store/lock.js'

function rid() {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 分词：CJK 2-gram + Latin 词（≥2 字符） */
export function tokenize(s) {
  const t = String(s || '').toLowerCase()
  const grams = new Set()
  let word = ''
  const flush = () => { if (word.length >= 2) grams.add(word); word = '' }
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    const code = t.charCodeAt(i)
    if (code >= 0x4e00 && code <= 0x9fff) {
      flush()
      if (i + 1 < t.length && t.charCodeAt(i + 1) >= 0x4e00) grams.add(t.slice(i, i + 2))
    } else if (/[a-z0-9]/.test(ch)) {
      word += ch
    } else {
      flush()
    }
  }
  flush()
  return grams
}

export function jaccard(a, b) {
  const A = tokenize(a)
  const B = tokenize(b)
  if (!A.size && !B.size) return 0
  let n = 0
  for (const g of A) if (B.has(g)) n++
  const u = A.size + B.size - n
  return u ? n / u : 0
}

/** 已分词集合间的 Jaccard（MMR 热路径复用，避免重复 tokenize） */
export function setJaccard(A, B) {
  if (!A.size && !B.size) return 0
  let n = 0
  for (const g of A) if (B.has(g)) n++
  const u = A.size + B.size - n
  return u ? n / u : 0
}

/** 记忆词元被文本覆盖的比例（containment）：短记忆命中更敏感，适合判定"本轮回答用到了这条记忆" */
export function containment(text, memoryContent) {
  const B = tokenize(memoryContent)
  if (!B.size) return 0
  const A = tokenize(text)
  if (!A.size) return 0
  let n = 0
  for (const g of B) if (A.has(g)) n++
  return n / B.size
}

/**
 * 纠错意图识别（规则，零成本）。只支持语义明确的句式，避免误伤普通否定/推测。
 * 返回 { negated, replacement, explicit }：negated=被否定的旧说法子串（可能为 null），
 * replacement=更正后的说法；explicit=true 表示是明确的"更正/我说的是"指令（允许单独写入更正）。
 * 例：「不是湖南，是湖北」→ { negated:'湖南', replacement:'湖北', explicit:false }
 *     「更正：我不喜欢辣」→ { negated:null, replacement:'我不喜欢辣', explicit:true }
 * 无法识别返回 null。注意：不匹配「应该是」这类推测语气（"今天应该是晴天"不是纠错）。
 */
export function detectCorrection(text) {
  const s = String(text || '').trim()
  if (!s) return null
  // 不是X（，）而是/是 Y ｜ 不是X，是Y
  let m = s.match(/不是\s*([^，,。；;！!？?\n]{1,30})\s*[，,、]?\s*(?:而是|是|应该是)\s*([^，,。；;！!？?\n]{1,60})/)
  if (m) return { negated: m[1].trim(), replacement: m[2].trim(), explicit: /更正|我说的是|我指的是/.test(s) }
  // 明确更正指令（允许没有旧说法，直接写入更正内容）
  m = s.match(/(?:我只是?说|我指的是|我是想?说|更正为|更正是|更正[:：])\s*([^，,。；;！!？?\n]{1,60})/)
  if (m) return { negated: null, replacement: m[1].trim(), explicit: true }
  return null
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

async function safe(p) { try { return await p } catch { return null } }

function extractJsonArray(text) {
  if (!text) return []
  const s = String(text).replace(/^```(?:json)?/i, '').replace(/```$/, '')
  const start = s.indexOf('[')
  if (start === -1) return []
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false }
    else if (ch === '"') inStr = true
    else if (ch === '[') depth++
    else if (ch === ']') { depth--; if (depth === 0) { try { const a = JSON.parse(s.slice(start, i + 1)); return Array.isArray(a) ? a : [] } catch { return [] } } }
  }
  return []
}

/** 规则抽取：偏好/称呼/身份（零成本，每轮跑） */
function ruleExtract(messages) {
  const text = [...messages].reverse().filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
  const out = []
  let m
  const rePref = /(?:我喜欢|我偏好|我爱|我习惯)([一-龥A-Za-z0-9 ，、]{1,20})/g
  while ((m = rePref.exec(text))) out.push({ content: `喜欢${m[1].trim()}`, type: 'preference', level: 'L3', confidence: 0.7 })
  const reName = /(?:叫我|称呼我|以后叫我)([一-龥A-Za-z]{1,10})/g
  while ((m = reName.exec(text))) out.push({ content: `用户希望被叫"${m[1].trim()}"`, type: 'name', level: 'L4', confidence: 0.8 })
  // 身份抽取：只匹配「我是/我负责/我的工作是」。「我在…」太易匹配临时动作（我在吃饭/我在忙/我在外面），
  // 会把瞬时状态误提炼成长期身份（审计 §3.1）。地点类信息留给 LLM 抽取（extractEvery 节流）更准。
  const reId = /(?:我是|我负责|我的工作是)([一-龥A-Za-z0-9 ，]{2,20})/g
  while ((m = reId.exec(text))) out.push({ content: `用户：${m[0]}`, type: 'identity', level: 'L4', confidence: 0.6 })
  return out
}

async function llmExtract(messages, llm) {
  const recent = messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-12)
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n')
  const prompt = [
    '从下面对话中抽取值得长期记住的用户信息（偏好/身份/事实）。',
    '只输出 JSON 数组，每项 {type,content,level:L2|L3|L4,confidence:0~1}。无则输出 []。',
    '',
    recent,
  ].join('\n')
  const res = llm.run ? await safe(llm.run(prompt)) : await safe(llm(prompt))
  const content = res?.content ?? res
  return extractJsonArray(content).filter(Boolean).map((c) => ({
    type: c.type || 'fact',
    content: String(c.content || ''),
    level: c.level || 'L3',
    confidence: Number(c.confidence) || 0.5,
  }))
}

export class RecallStore {
  constructor({
    kv,
    embedFn = null,
    scanFn = null,
    prefix = 'Yz:agent:mem:',
    cap = 200,
    halflife = { L2: 7, L3: 30, L4: 365 },
    dedup = { embed: 0.85, keyword: 0.5 },
    extractEvery = 10,
    minScore = 0,
    // 去冗余：候选数 > topK 时用 MMR 兼顾相关性与多样性，并用每类上限限制同一 type 占比。
    // lambda 越大越偏相关性（1=退化为纯分数排序）。默认开启但只影响"候选多于要取"的场景。
    diversity = { enable: true, lambda: 0.7, perTypeCap: 3 },
    // 使用反馈：记录"注入次数/被判为被引用次数"，对反复注入却从不被引用的记忆轻微降权。
    // 被引用检测 = 回复文本对记忆词元的包含率（containment），仅为启发式，故权重轻。
    usage = { enable: true, containment: 0.5, minTokens: 2, penalizeAfter: 5, penalty: 0.5 },
  } = {}) {
    if (!kv) throw new Error('RecallStore 需要 kv')
    this.kv = kv
    this.embedFn = embedFn
    this.scanFn = scanFn
    this.prefix = prefix
    this.cap = cap
    this.halflife = halflife
    this.dedup = dedup
    this.extractEvery = extractEvery
    // 召回最低综合分阈值：_score <= minScore 的条目不返回（默认 0 = 至少过滤零相似度）。
    // 审计 §3.1：零相关记忆被自动注入会污染上下文、让模型莫名提及旧话题。空结果优于注入无关记忆。
    // 关键词召回（jaccard）与向量召回（cosine）分值量纲不同，可由上层按需调大（如向量 0.3）。
    this.minScore = minScore
    this.diversity = { enable: true, lambda: 0.7, perTypeCap: 3, ...(diversity || {}) }
    this.usage = { enable: true, containment: 0.5, minTokens: 2, penalizeAfter: 5, penalty: 0.5, ...(usage || {}) }
    this._turns = new Map()
    this._turnsMax = 5000 // 轮次计数键空间上限（防长进程无界增长）
    this._lock = createKeyedLock() // 每用户 RMW 串行：抽取在 run 之后异步触发，并发写会丢记忆
  }

  _key(userId) { return `${this.prefix}${userId}` }
  async _all(userId) { const v = await this.kv.get(this._key(userId)); return Array.isArray(v) ? v : [] }
  async _save(userId, arr) {
    if (arr.length > this.cap) {
      // 容量智能淘汰：按综合价值排序后保留前 cap 条（保护高 confidence/高 level/近期 事实，替代 FIFO 丢最旧）
      arr = arr.map((m) => ({ m, r: this._rank(m) })).sort((a, b) => b.r - a.r).slice(0, this.cap).map((x) => x.m)
    }
    await this.kv.set(this._key(userId), arr)
  }

  /** 综合价值评分（容量淘汰用）：level 权重 × 置信度 × 时间衰减，与 retrieve 排序思路一致 */
  _rank(mem) {
    const now = Date.now()
    const days = (now - (mem.updatedAt || mem.createdAt || now)) / 86400000
    const hl = this.halflife[mem.level] || 30
    const decay = Math.pow(0.5, days / hl)
    const levelW = mem.level === 'L4' ? 1.0 : mem.level === 'L3' ? 0.7 : 0.4
    const conf = typeof mem.confidence === 'number' ? mem.confidence : 0.5
    return levelW * (0.4 + conf * 0.6) * decay * this._usefulness(mem)
  }

  /**
   * 使用反馈权重：反复注入却从未被判定引用的记忆轻微降权（默认 0.5 倍）；
   * 被引用过的记忆给极轻加成（上限 +10%）。纠正/取代的条目不参与召回，权重置 0。
   */
  _usefulness(mem) {
    if (mem.status === 'corrected' || mem.status === 'superseded') return 0
    if (!this.usage.enable) return 1
    const injected = Number(mem.injected) || 0
    const used = Number(mem.used) || 0
    let w = 1
    if (injected >= (this.usage.penalizeAfter ?? 5) && used === 0) w *= (this.usage.penalty ?? 0.5)
    else if (used > 0) w *= 1 + Math.min(0.1, used * 0.03)
    return w
  }

  _sim(a, b, ea, eb) {
    if (ea && eb && ea.length && eb.length) return cosine(ea, eb)
    return jaccard(a, b)
  }

  /** 召回 topK：相似度 × 时间衰减 × 置信度加权；_score <= minScore 的不返回（防零相关记忆污染上下文） */
  async retrieve(query, userId, topK = 5) {
    const all = await this._all(userId)
    if (!all.length) return []
    const qEmbed = this.embedFn ? await safe(this.embedFn(query)) : null
    const now = Date.now()
    const minScore = this.minScore ?? 0
    const scored = []
    for (const mem of all) {
      // 已纠正/被取代的记忆不再召回（用户纠错闭环；仍保留在 live 供 #记忆 查看）
      if (mem.status === 'corrected' || mem.status === 'superseded') continue
      const sim = this._sim(query, mem.content, qEmbed, mem.embedding)
      const days = (now - (mem.updatedAt || mem.createdAt || now)) / 86400000
      const hl = this.halflife[mem.level] || 30
      const decay = Math.pow(0.5, days / hl)
      const conf = typeof mem.confidence === 'number' ? mem.confidence : 0.5
      const score = sim * decay * (0.5 + conf * 0.5) * this._usefulness(mem)
      if (score <= minScore) continue // 零相似度/低于阈值不注入（审计 §3.1）
      scored.push({ ...mem, _score: score, _sim: sim })
    }
    const sorted = scored.sort((a, b) => b._score - a._score)
    return this._selectDiverse(sorted, topK)
  }

  /**
   * 去冗余选择（MMR + 每类上限）。候选 ≤ topK 时原样返回（不影响小集合行为）。
   * MMR：mmr = λ·归一化分数 − (1−λ)·与已选条目的最大词面相似度，兼顾相关与多样。
   * perTypeCap 限制同一 type 占比；若因此选不满 topK，放宽上限补齐（宁多勿漏）。
   */
  _selectDiverse(sorted, topK) {
    const k = Math.max(0, Number(topK) || 0)
    if (k === 0) return []
    if (sorted.length <= k) return sorted.slice(0, k)
    const dv = this.diversity || {}
    if (dv.enable === false) return sorted.slice(0, k)
    const lambda = typeof dv.lambda === 'number' ? dv.lambda : 0.7
    const perTypeCap = Number.isFinite(dv.perTypeCap) ? dv.perTypeCap : Infinity
    // 预分词一次，避免 MMR 每轮重复 tokenize（热路径）
    const tok = sorted.map((m) => tokenize(m.content))
    const maxScore = sorted[0]._score || 1
    const picked = []
    const typeCount = new Map()
    const used = new Set()
    const next = (respectCap) => {
      let best = -Infinity
      let bestIdx = -1
      for (let i = 0; i < sorted.length; i++) {
        if (used.has(i)) continue
        if (respectCap) {
          const t = sorted[i].type || 'fact'
          if ((typeCount.get(t) || 0) >= perTypeCap) continue
        }
        let maxSim = 0
        for (const j of picked) maxSim = Math.max(maxSim, setJaccard(tok[i], tok[j]))
        const rel = (sorted[i]._score || 0) / maxScore
        const mmr = lambda * rel - (1 - lambda) * maxSim
        if (mmr > best) { best = mmr; bestIdx = i }
      }
      return bestIdx
    }
    while (picked.length < k) {
      let idx = next(true)
      if (idx === -1) idx = next(false) // 上限导致选不满 → 放宽补齐
      if (idx === -1) break
      used.add(idx)
      picked.push(idx)
      const t = sorted[idx].type || 'fact'
      typeCount.set(t, (typeCount.get(t) || 0) + 1)
    }
    return picked.map((i) => sorted[i])
  }

  /** 去重感知写入（相似超阈值 → 高置信度覆盖，旧内容进 prev[]）。每用户加锁，防并发丢更新。 */
  async writeMemory(candidate, userId) {
    return this._lock.withLock(this._key(userId), async () => {
      const all = await this._all(userId)
      const r = await this._writeLocked(candidate, all)
      await this._save(userId, all)
      return r
    })
  }

  /** 在给定数组上执行一次写入（扫描→去重→追加/覆盖）。调用方负责加锁与 _save。 */
  async _writeLocked(candidate, all) {
    // 威胁扫描：疑似指令注入 → 降置信 + 标 suspect（live 保留原文便于排查，formatForPrompt 屏蔽不喂模型）
    if (this.scanFn) {
      try {
        if (await this.scanFn(candidate.content)) {
          candidate = { ...candidate, suspect: true, confidence: Math.min((candidate.confidence || 0.5) * 0.3, 0.3) }
        }
      } catch { /* 扫描异常保守不标记，照常写入 */ }
    }
    for (const mem of all) {
      // 已纠正/被取代的条目不再参与去重合并（否则新说法会把纠错条目复活）
      if (mem.status === 'corrected' || mem.status === 'superseded') continue
      const haveEmbed = !!(candidate.embedding && mem.embedding)
      const thresh = haveEmbed ? this.dedup.embed : this.dedup.keyword
      const sim = this._sim(candidate.content, mem.content, candidate.embedding, mem.embedding)
      if (sim >= thresh) {
        if ((candidate.confidence || 0) >= (mem.confidence || 0)) {
          const idx = all.indexOf(mem)
          all[idx] = {
            ...mem,
            ...candidate,
            id: mem.id,
            status: 'active',
            prev: [...(mem.prev || []), { content: mem.content, confidence: mem.confidence, updatedAt: mem.updatedAt }],
            createdAt: mem.createdAt,
            updatedAt: Date.now(),
          }
        }
        return { action: 'updated', id: mem.id }
      }
    }
    const entry = {
      id: candidate.id || rid(),
      level: candidate.level || 'L3',
      type: candidate.type || 'fact',
      content: candidate.content,
      confidence: candidate.confidence ?? 0.6,
      status: 'active',
      ...(candidate.source ? { source: candidate.source } : {}),
      ...(candidate.embedding ? { embedding: candidate.embedding } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    all.push(entry)
    return { action: 'created', id: entry.id }
  }

  /**
   * 纠错闭环：把与 matchText 匹配的旧记忆标记为 corrected（不再召回/注入，保留 prev 审计链），
   * 并可选写入更正后的新说法（高置信、source=correction）。返回 { corrected, ids, added }。
   */
  async correct(userId, { matchText, newContent, matchThreshold = 0.5, type, level, confidence = 0.9 } = {}) {
    return this._lock.withLock(this._key(userId), async () => {
      const all = await this._all(userId)
      const now = Date.now()
      let corrected = 0
      const ids = []
      let resolvedContent = newContent
      if (matchText) {
        for (let i = 0; i < all.length; i++) {
          const mem = all[i]
          if (mem.status === 'corrected' || mem.status === 'superseded') continue
          const hit = String(mem.content || '').includes(matchText) || jaccard(mem.content, matchText) >= matchThreshold
          if (!hit) continue
          // 用旧说法所在的整句做替换，得到自然、可检索的更正句（避免只存 "湖北" 这类碎片）
          if (newContent && String(mem.content || '').includes(matchText)) {
            resolvedContent = String(mem.content).split(matchText).join(newContent)
          }
          all[i] = {
            ...mem,
            status: 'corrected',
            confidence: Math.min(Number(mem.confidence) || 0.5, 0.1),
            prev: [...(mem.prev || []), { content: mem.content, confidence: mem.confidence, updatedAt: mem.updatedAt }],
            updatedAt: now,
          }
          corrected++
          ids.push(mem.id)
        }
      }
      let added = null
      // 有 matchText 但没命中任何旧记忆时不写入（否则「不是重点，是小事」这类会把碎片当记忆写入）
      if (resolvedContent && (corrected > 0 || !matchText)) {
        const r = await this._writeLocked({ content: resolvedContent, type: type || 'fact', level: level || 'L4', confidence, source: 'correction' }, all)
        added = r.id
      }
      await this._save(userId, all)
      return { corrected, ids, added, content: added ? resolvedContent : null }
    })
  }

  /**
   * 使用反馈（启发式）：本轮注入过的记忆计一次 injected；若最终回复对某条记忆词元的
   * 包含率 ≥ containment 阈值，判为"被引用"计一次 used。仅用于轻微降权/淘汰，不作为事实依据。
   */
  async recordUsage(userId, { injectedIds = [], replyText = '' } = {}) {
    if (!this.usage.enable) return { updated: 0 }
    const ids = new Set((injectedIds || []).filter(Boolean))
    if (!ids.size) return { updated: 0 }
    return this._lock.withLock(this._key(userId), async () => {
      const all = await this._all(userId)
      const text = String(replyText || '')
      const now = Date.now()
      let updated = 0
      for (let i = 0; i < all.length; i++) {
        const mem = all[i]
        if (!ids.has(mem.id)) continue
        const injected = Math.min(10000, (Number(mem.injected) || 0) + 1)
        let used = Number(mem.used) || 0
        let lastUsedAt = mem.lastUsedAt || null
        if (text && tokenize(mem.content).size >= (this.usage.minTokens ?? 2)
          && containment(text, mem.content) >= (this.usage.containment ?? 0.6)) {
          used = Math.min(10000, used + 1)
          lastUsedAt = now
        }
        all[i] = { ...mem, injected, used, lastUsedAt, lastInjectedAt: now }
        updated++
      }
      if (updated) await this._save(userId, all)
      return { updated }
    })
  }

  /** 从最近用户消息识别纠错并落库（只处理最近一条明确纠错，避免历史纠错反复触发）。 */
  async applyCorrections(messages, userId) {
    const recent = [...(messages || [])].reverse().filter((m) => m.role === 'user').slice(0, 3)
    const applied = { corrected: 0, added: 0 }
    const PRONOUN = /^(?:这个|那个|这些|那些|它|他|她|这里|那里|刚才|上面|下面)$/
    for (const m of recent) {
      const text = typeof m.content === 'string' ? m.content : ''
      const c = detectCorrection(text)
      if (!c) continue
      if (c.negated) {
        const r = await this.correct(userId, { matchText: c.negated, newContent: c.replacement, type: 'correction', level: 'L4', confidence: 0.9 })
        applied.corrected += r.corrected
        if (r.added) applied.added++
      } else if (c.explicit && c.replacement && c.replacement.length >= 2 && !PRONOUN.test(c.replacement)) {
        const r = await this.writeMemory({ content: c.replacement, type: 'correction', level: 'L4', confidence: 0.85, source: 'correction' }, userId)
        if (r.action === 'created') applied.added++
      }
      break
    }
    return applied
  }

  async forget(userId, keyword) {
    return this._lock.withLock(this._key(userId), async () => {
      const all = await this._all(userId)
      const next = all.filter((m) => !(m.content || '').includes(keyword))
      await this._save(userId, next)
      return all.length - next.length
    })
  }

  /** 按 id 精确删除单条（Web 面板用；forget 只能按 keyword 模糊删） */
  async removeById(userId, entryId) {
    return this._lock.withLock(this._key(userId), async () => {
      const all = await this._all(userId)
      const next = all.filter((m) => m.id !== entryId)
      if (next.length === all.length) return 0
      await this._save(userId, next)
      return 1
    })
  }

  async clearAll(userId) { await this.kv.del(this._key(userId)) }
  async listByUser(userId) { return this._all(userId) }

  /** 规则抽取每轮 + LLM 抽取节流（意图词强制触发） */
  async extractAndWrite(messages, userId, { llm } = {}) {
    // 纠错优先：先按明确纠错句式纠正/作废旧记忆，再正常抽取（避免旧说法被重新写入）
    try { await this.applyCorrections(messages, userId) } catch { /* 纠错失败不阻断抽取 */ }
    const ruleCands = ruleExtract(messages)
    for (const c of ruleCands) await this.writeMemory(c, userId)
    const turn = (this._turns.get(userId) || 0) + 1
    this._turns.set(userId, turn)
    if (this._turns.size > this._turnsMax) {
      for (const k of this._turns.keys()) { if (this._turns.size <= this._turnsMax) break; this._turns.delete(k) }
    }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const intent = lastUser && /记住|别忘了|叫我|称呼我/.test(typeof lastUser.content === 'string' ? lastUser.content : '')
    if (llm && (turn % this.extractEvery === 0 || intent)) {
      const cands = await llmExtract(messages, llm)
      for (const c of cands) if (c.content) await this.writeMemory(c, userId)
    }
  }

  formatForPrompt(memories) {
    // suspect（疑似注入）与 corrected/superseded（已纠错/被取代）条目不注入 prompt，仅 live 保留供 #记忆 排查
    const safe = (memories || []).filter((m) => !m.suspect && m.status !== 'corrected' && m.status !== 'superseded')
    if (!safe.length) return ''
    const byLevel = { L2: [], L3: [], L4: [] }
    // 非法/缺失 level 回退到 L3 分组（LLM 抽取的 level 未校验，可能是任意值）。
    // 注意不能用 `|| (byLevel.L3 = [])`：那会在遇到非法 level 时把已累积的 L3 条目整体丢掉。
    for (const m of safe) (byLevel[m.level] || byLevel.L3).push(m)
    const lines = ['## 关于这位用户的长期记忆（历史信息，非当前输入；如需更多可调用 memory_search 主动检索）']
    const fmt = (m) => {
      const type = m.type ? `[${m.type}]` : ''
      const date = m.updatedAt ? `（${new Date(m.updatedAt).toISOString().slice(0, 10)}）` : ''
      return `${m.content}${type ? ' ' + type : ''}${date}`
    }
    if (byLevel.L3.length) lines.push('偏好：' + byLevel.L3.map(fmt).join('；'))
    if (byLevel.L4.length) lines.push('事实：' + byLevel.L4.map(fmt).join('；'))
    if (byLevel.L2.length) lines.push('近期：' + byLevel.L2.map(fmt).join('；'))
    return lines.join('\n')
  }
}
