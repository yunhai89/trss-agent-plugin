/**
 * 向量召回记忆 —— 每用户长期记忆，相似度×时间衰减排序召回、regex+LLM 双抽取、去重、遗忘。
 * 区别于声明式 MemoryStore（快照注入）：这是 recall 系统。
 * 对应 yunhai lib/agent/memory.js（已裁剪：无 PG/Milvus/Neo4j，仅 KV + 可选 embedding）。
 *
 * 条目：{ id, level:L2|L3|L4, type, content, confidence, embedding?, createdAt, updatedAt, prev? }
 */

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
    this._turns = new Map()
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
    return levelW * (0.4 + conf * 0.6) * decay
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
      const sim = this._sim(query, mem.content, qEmbed, mem.embedding)
      const days = (now - (mem.updatedAt || mem.createdAt || now)) / 86400000
      const hl = this.halflife[mem.level] || 30
      const decay = Math.pow(0.5, days / hl)
      const conf = typeof mem.confidence === 'number' ? mem.confidence : 0.5
      const score = sim * decay * (0.5 + conf * 0.5)
      if (score <= minScore) continue // 零相似度/低于阈值不注入（审计 §3.1）
      scored.push({ ...mem, _score: score, _sim: sim })
    }
    return scored.sort((a, b) => b._score - a._score).slice(0, topK)
  }

  /** 去重感知写入（相似超阈值 → 高置信度覆盖，旧内容进 prev[]） */
  async writeMemory(candidate, userId) {
    // 威胁扫描：疑似指令注入 → 降置信 + 标 suspect（live 保留原文便于排查，formatForPrompt 屏蔽不喂模型）
    if (this.scanFn) {
      try {
        if (await this.scanFn(candidate.content)) {
          candidate = { ...candidate, suspect: true, confidence: Math.min((candidate.confidence || 0.5) * 0.3, 0.3) }
        }
      } catch { /* 扫描异常保守不标记，照常写入 */ }
    }
    const all = await this._all(userId)
    for (const mem of all) {
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
            prev: [...(mem.prev || []), { content: mem.content, confidence: mem.confidence, updatedAt: mem.updatedAt }],
            createdAt: mem.createdAt,
            updatedAt: Date.now(),
          }
        }
        await this._save(userId, all)
        return { action: 'updated', id: mem.id }
      }
    }
    const entry = {
      id: candidate.id || rid(),
      level: candidate.level || 'L3',
      type: candidate.type || 'fact',
      content: candidate.content,
      confidence: candidate.confidence ?? 0.6,
      ...(candidate.embedding ? { embedding: candidate.embedding } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    all.push(entry)
    await this._save(userId, all)
    return { action: 'created', id: entry.id }
  }

  async forget(userId, keyword) {
    const all = await this._all(userId)
    const next = all.filter((m) => !(m.content || '').includes(keyword))
    await this._save(userId, next)
    return all.length - next.length
  }

  /** 按 id 精确删除单条（Web 面板用；forget 只能按 keyword 模糊删） */
  async removeById(userId, entryId) {
    const all = await this._all(userId)
    const next = all.filter((m) => m.id !== entryId)
    if (next.length === all.length) return 0
    await this._save(userId, next)
    return 1
  }

  async clearAll(userId) { await this.kv.del(this._key(userId)) }
  async listByUser(userId) { return this._all(userId) }

  /** 规则抽取每轮 + LLM 抽取节流（意图词强制触发） */
  async extractAndWrite(messages, userId, { llm } = {}) {
    const ruleCands = ruleExtract(messages)
    for (const c of ruleCands) await this.writeMemory(c, userId)
    const turn = (this._turns.get(userId) || 0) + 1
    this._turns.set(userId, turn)
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const intent = lastUser && /记住|别忘了|叫我|称呼我/.test(typeof lastUser.content === 'string' ? lastUser.content : '')
    if (llm && (turn % this.extractEvery === 0 || intent)) {
      const cands = await llmExtract(messages, llm)
      for (const c of cands) if (c.content) await this.writeMemory(c, userId)
    }
  }

  formatForPrompt(memories) {
    // suspect（疑似注入）条目不注入 prompt（防投毒），仅 live 保留供 #记忆 排查
    const safe = (memories || []).filter((m) => !m.suspect)
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
