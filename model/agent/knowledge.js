/**
 * 知识库（Knowledge Base）—— 全局共享文档库，chunk + embedding 向量化存储 + 语义检索（RAG）。
 *
 * 区别于 RecallStore（per-user 自动抽取的个人记忆，带 level/置信度/衰减/威胁扫描）：
 * KB 是「文档 chunk」语义，schema 简单（docId/text/embedding），全局共享，无时间衰减。
 * 故独立实现，但复用 recall.js 的 cosine/jaccard/tokenize + llm/embed.js + KV。
 *
 * 存储：单条 KV `Yz:agent:kb:__global__` = { docs:[], chunks:[] }
 *   docs:   { id, title, source, createdAt, chunkCount }
 *   chunks: { docId, idx, text, embedding?, createdAt }
 *
 * embedFn 复用 recall 那份（agent.js 构造，基于 recall.embedProvider）；
 * embedFn 透传 embed()，支持数组输入（批量入库一次调用）。
 */

import { cosine } from './recall.js'
import { BM25, tokenize, simhash, isNearDup } from '../llm/local-sim.js'
import { crawlUrl } from '../crawl/index.js' // 网页抓取（ingestUrl/refreshDoc）
import { createKeyedLock } from './store/lock.js'

const DEFAULT_KEY = 'Yz:agent:kb:__global__'

function rid() {
  return `kb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 文档分块：按字符切片 + overlap（保上下文连贯）。短文整段返回。 */
export function chunkText(text, size = 500, overlap = 50) {
  const t = String(text || '').trim()
  if (!t) return []
  if (t.length <= size) return [t]
  const out = []
  let i = 0
  while (i < t.length) {
    const end = Math.min(i + size, t.length)
    out.push(t.slice(i, end))
    if (end >= t.length) break
    i = end - overlap
    if (i < 0) i = 0
  }
  return out
}

export class KnowledgeStore {
  constructor({ kv, embedFn = null, key = DEFAULT_KEY, chunkSize = 500, chunkOverlap = 50, topK = 5, minScore = 0.3 } = {}) {
    if (!kv) throw new Error('KnowledgeStore 需要 kv')
    this.kv = kv
    this.embedFn = embedFn
    this.key = key
    this.chunkSize = chunkSize
    this.chunkOverlap = chunkOverlap
    this.topK = topK
    this.minScore = minScore
    // 定时刷新（URL 文档周期 re-crawl）：scheduler 延后注入（见 attachScheduler）
    this.scheduler = null
    this._refreshJobs = new Map() // docId -> job handle
    this._lock = createKeyedLock() // 单条全局 KV 的 RMW 串行化：并发 ingest/refresh 会互相丢文档
  }

  /** 注入 scheduler（供定时刷新注册 job）。knowledge 构造早于 scheduler 创建，故延后注入。 */
  attachScheduler(scheduler) { this.scheduler = scheduler }

  async _load() {
    const v = await this.kv.get(this.key).catch(() => null)
    return (v && Array.isArray(v.docs) && Array.isArray(v.chunks)) ? v : { docs: [], chunks: [] }
  }

  async _save(data) { await this.kv.set(this.key, data) }

  /** 入库：文本 → SimHash 去重 → chunk → 批量 embedding → 存。返回 { id, chunkCount, embedded } */
  async ingest(text, { title, source, extra } = {}) {
    const chunks = chunkText(text, this.chunkSize, this.chunkOverlap)
    if (!chunks.length) return { error: '空文本，无法入库' }

    return this._lock.withLock(this.key, async () => {
      const data = await this._load()
      // SimHash 近似去重（纯代码，hamming≤3 视为近似重复 → 拒绝入库，防重复）
      const docSim = simhash(await tokenize(text))
      const nearDup = data.docs.find((d) => d.simhash != null && isNearDup(d.simhash, docSim))
      if (nearDup) return { error: `与已有文档「${nearDup.title}」(${nearDup.id}) 近似重复，未入库。如确为不同内容，请删除旧文档或调整后重试` }

      let embeddings = null
      if (this.embedFn) {
        try { embeddings = await this.embedFn(chunks) } // 批量一次（embed 支持数组）
        catch { /* embed 失败 → chunks 照存但无 embedding，检索降级 BM25 */ }
      }
      const id = rid()
      const now = Date.now()
      data.docs.push({
        id, title: title || `文档 ${data.docs.length + 1}`, source: source || 'manual',
        createdAt: now, chunkCount: chunks.length, simhash: docSim,
        ...(extra || {}), // URL 入库时透传 url/refreshCron/lastCrawled
      })
      data.chunks.push(...chunks.map((c, idx) => ({
        docId: id, idx, text: c,
        embedding: Array.isArray(embeddings) ? embeddings[idx] : null,
        createdAt: now,
      })))
      await this._save(data)
      return { id, chunkCount: chunks.length, embedded: !!embeddings }
    })
  }

  /** 检索：有 embedding → cosine；无 embedding → BM25 纯代码检索（jieba 分词，归一化到 [0,1]） */
  async retrieve(query, topK, minScore) {
    const k = Math.max(1, Number(topK) || this.topK)
    const min = Number.isFinite(Number(minScore)) ? Number(minScore) : this.minScore
    const data = await this._load()
    if (!data.chunks.length) return []

    let qvec = null
    if (this.embedFn) { try { qvec = await this.embedFn(query) } catch { qvec = null } }
    const docsMap = new Map(data.docs.map((d) => [d.id, d]))

    let scores
    if (qvec && data.chunks.some((c) => c.embedding)) {
      // 有 embedding：cosine 语义检索
      scores = data.chunks.map((c) => (c.embedding ? cosine(qvec, c.embedding) : 0))
    } else {
      // 无 embedding：BM25 纯代码检索（jieba 分词），归一化到 [0,1] 适配 minScore
      const bm = new BM25()
      for (const c of data.chunks) bm.add(await tokenize(c.text))
      scores = bm.scoresNormalized(await tokenize(query))
    }
    const scored = data.chunks.map((c, i) => ({
      text: c.text, docId: c.docId, idx: c.idx, doc: docsMap.get(c.docId), _score: scores[i] || 0,
    }))
    return scored.filter((c) => c._score > min).sort((a, b) => b._score - a._score).slice(0, k)
  }

  async listDocs() { return (await this._load()).docs }

  async removeDoc(docId) {
    // 删前取消定时刷新 job（防野 job 到点对一个已删 doc 跑刷新）
    try { if (this._refreshJobs.has(docId)) await this.cancelRefresh(docId) } catch { /* noop */ }
    return this._lock.withLock(this.key, async () => {
      const data = await this._load()
      const before = data.docs.length
      data.docs = data.docs.filter((d) => d.id !== docId)
      data.chunks = data.chunks.filter((c) => c.docId !== docId)
      await this._save(data)
      return before - data.docs.length
    })
  }

  /** 重建索引：对所有 chunk 重新批量 embedding（换 embedding 模型后用） */
  async rebuild() {
    return this._lock.withLock(this.key, async () => {
      const data = await this._load()
      if (!data.chunks.length) return { rebuilt: 0 }
      if (!this.embedFn) return { error: '未配置 embedding（recall.embedProvider），无法重建' }
      const texts = data.chunks.map((c) => c.text)
      let embeddings
      try { embeddings = await this.embedFn(texts) }
      catch (e) { return { error: `重建失败：${e?.message || e}` } }
      data.chunks.forEach((c, i) => { c.embedding = Array.isArray(embeddings) ? embeddings[i] : null })
      await this._save(data)
      return { rebuilt: data.chunks.length }
    })
  }

  // ── 网页 URL 入库 + 定时拉取最新内容 ──

  /** 入库网页 URL：抓取正文 → ingest（带 url/refreshCron/lastCrawled 元数据）。同 URL 精确查重（不走 SimHash）。 */
  async ingestUrl(url, { title, refreshCron } = {}) {
    const u = String(url || '').trim()
    if (!/^https?:\/\//i.test(u)) return { error: '需 http(s) 网址' }
    const data = await this._load()
    const exist = data.docs.find((d) => d.url === u)
    if (exist) return { error: `该 URL 已入库为「${exist.title}」(${exist.id})。如需更新请用 #知识库刷新 ${exist.id}` }
    const r = await crawlUrl(u)
    if (!r.success || !r.markdown) return { error: `抓取失败：${r.error || '无内容'}` }
    const r2 = await this.ingest(r.markdown, {
      title: title || r.title || u, source: u,
      extra: { url: u, refreshCron: refreshCron || null, lastCrawled: Date.now() },
    })
    if (r2.error) return r2
    if (refreshCron && this.scheduler) this._scheduleRefresh(r2.id, refreshCron)
    return { ...r2, via: r.via, title: r.title || u }
  }

  /**
   * 刷新某 URL 文档：绕过 ingest/SimHash（同 URL 新内容与旧 doc 同源必撞 SimHash 近似去重），
   * 直接操作 chunks —— 删旧 → 重新 chunk + embed → 插回。串行化（防多个 doc 同时到点拉起多个 chromium OOM）。
   */
  async refreshDoc(docId) {
    // 与 ingest/removeDoc 共用同一把 key 锁：既串行化多个 refresh（防并发 chromium OOM），
    // 也避免刷新与入库互相覆盖整份 KB。
    return this._lock.withLock(this.key, async () => {
      const data = await this._load()
      const doc = data.docs.find((d) => d.id === docId)
      if (!doc || !doc.url) return { error: `文档 ${docId} 无 URL，不可刷新` }
      const r = await crawlUrl(doc.url)
      if (!r.success || !r.markdown) return { error: `抓取失败：${r.error || '无内容'}` }
      data.chunks = data.chunks.filter((c) => c.docId !== docId) // 删旧 chunks
      const chunks = chunkText(r.markdown, this.chunkSize, this.chunkOverlap)
      if (!chunks.length) return { error: '抓取内容为空，无法分块' }
      let embeddings = null
      if (this.embedFn) { try { embeddings = await this.embedFn(chunks) } catch { /* embed 失败降级 BM25 */ } }
      const now = Date.now()
      data.chunks.push(...chunks.map((c, idx) => ({
        docId, idx, text: c, embedding: Array.isArray(embeddings) ? embeddings[idx] : null, createdAt: now,
      })))
      doc.chunkCount = chunks.length; doc.lastCrawled = now
      try { doc.simhash = simhash(await tokenize(r.markdown)) } catch { /* noop */ }
      await this._save(data)
      return { id: docId, chunkCount: chunks.length, via: r.via }
    })
  }

  /** 刷新所有 URL 文档（串行）。返回 { refreshed, total, details } */
  async refreshAll() {
    const docs = (await this._load()).docs.filter((d) => d.url)
    const out = []
    for (const d of docs) out.push({ id: d.id, ...(await this.refreshDoc(d.id)) })
    return { refreshed: out.filter((x) => !x.error).length, total: docs.length, details: out }
  }

  /** 设定时刷新：更新 doc.refreshCron + 注册 job（先取消旧 job 防重复）。cron=null 即取消。 */
  async setRefresh(docId, cron) {
    const data = await this._load()
    const doc = data.docs.find((d) => d.id === docId)
    if (!doc) return { error: `文档 ${docId} 不存在` }
    if (!doc.url) return { error: `文档 ${docId} 无 URL，不可设定时刷新` }
    await this.cancelRefresh(docId, false) // 取消旧 job（不写 KV，下面统一 save）
    doc.refreshCron = cron || null
    await this._save(data)
    if (cron && this.scheduler) this._scheduleRefresh(docId, cron)
    return { id: docId, cron: cron || null }
  }

  /** 取消定时刷新：cancelJob + 清句柄。persist=true 时同步把 doc.refreshCron 写回 null。 */
  async cancelRefresh(docId, persist = true) {
    const j = this._refreshJobs.get(docId)
    if (j && this.scheduler) { try { this.scheduler.cancelJob(j) } catch { /* noop */ } }
    this._refreshJobs.delete(docId)
    if (persist) {
      const data = await this._load()
      const doc = data.docs.find((d) => d.id === docId)
      if (doc && doc.refreshCron) { doc.refreshCron = null; await this._save(data) }
    }
    return { id: docId }
  }

  _scheduleRefresh(docId, cron) {
    if (!this.scheduler) return
    try {
      const job = this.scheduler.scheduleJob(cron, () => {
        this.refreshDoc(docId).catch(() => { /* 刷新失败保留下轮重试，此处静默 */ })
      })
      this._refreshJobs.set(docId, job)
    } catch { /* 非法 cron 静默 */ }
  }

  /** 重启恢复：遍历带 refreshCron 的 doc 重新注册 job。在 apps 启动恢复时调一次。 */
  async restoreRefreshJobs(onRefresh) {
    const docs = (await this._load()).docs.filter((d) => d.refreshCron)
    for (const d of docs) {
      if (!this.scheduler) continue
      try {
        const job = this.scheduler.scheduleJob(d.refreshCron, () => onRefresh(d.id).catch(() => {}))
        if (job) this._refreshJobs.set(d.id, job)
      } catch { /* noop */ }
    }
    return { restored: docs.length }
  }

  async listUrlDocs() { return (await this._load()).docs.filter((d) => d.url) }
}

/**
 * 构造 kb_search 工具（模型主动检索知识库，照 makeRecallTool 范式）。
 * category=query（人人可用，只读）；返回片段文本（带来源 title + 相似度）给 LLM。
 */
export function makeKbSearchTool(kb) {
  return {
    name: 'kb_search',
    description: '检索知识库（全局共享文档库；FAQ / 资料 / 规则设定 / 产品信息等）。**当问题可能涉及已入库文档时，优先用本工具（而非 web_search 联网）——本地知识库更准确、不耗流量**。返回若干相关片段（带来源和相似度）；无命中再考虑联网搜索。',
    category: 'query',
    meta: { summary: '检索知识库' },
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索问题或关键词（语义/关键词匹配）' },
        topK: { type: 'integer', description: '返回片段数（默认 5）' },
      },
      required: ['query'],
    },
    async execute({ query, topK } = {}) {
      const q = String(query || '').trim()
      if (!q) return { error: '缺少 query' }
      const hits = await kb.retrieve(q, topK, kb.minScore).catch(() => [])
      if (!hits.length) return { found: 0, text: '未在知识库检索到相关内容。' }
      const lines = [`知识库命中 ${hits.length} 段：`]
      hits.forEach((h, i) => {
        const title = h.doc?.title || h.docId
        const score = h._score != null ? ` score=${h._score.toFixed(2)}` : ''
        lines.push(`${i + 1}. 【${title}】${score}\n   ${String(h.text).trim()}`)
      })
      return { found: hits.length, text: lines.join('\n') }
    },
  }
}
