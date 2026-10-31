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
 * 向量索引：可选 LocalVectorStore（data/vectors/kb/vectors.bin）作加速层；
 * KV 里的 chunks.embedding 仍是事实源，索引缺失/损坏/换模型时可重建。
 * 检索优先走向量索引，未配置 embedding 或索引不可用时回退 BM25。
 *
 * embedFn 复用 recall 那份（agent.js 构造，基于 recall.embedProvider）；
 * embedFn 透传 embed()，支持数组输入（批量入库一次调用）。
 */

import { cosine } from './recall.js'
import { BM25, tokenize, simhash, isNearDup } from '../llm/local-sim.js'
import { crawlUrl } from '../crawl/index.js' // 网页抓取（ingestUrl/refreshDoc）
import { createKeyedLock } from './store/lock.js'
import { LocalVectorStore, VectorStoreError } from './vector-store.js'

const DEFAULT_KEY = 'Yz:agent:kb:__global__'

function rid() {
  return `kb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 文档分块：按字符切片 + overlap（保上下文连贯）。短文整段返回。 */
export function chunkText(text, size = 500, overlap = 50) {
  const t = String(text || '').trim()
  if (!t) return []
  // 参数夹紧（2026-10-17 审计 M3）：`kb.chunkOverlap >= kb.chunkSize` 时 i 会停在原地
  // ⇒ while 死循环 + out 无界增长，CPU 打满直至 OOM，且崩前无任何日志（用户只是改了个配置）。
  const sz = Math.max(1, Math.floor(Number(size) || 500))
  // 除 size-1 上限外再夹到半块：overlap 接近块长时每块只前进 1 个字符，分片数线性膨胀
  //（1MB 文档 + size=500/overlap=499 ≈ 100 万块 × 500 字符 → 内存直接打爆），且这类配置没有检索价值。
  const ov = Math.max(0, Math.min(Math.floor(Number(overlap) || 0), sz - 1, Math.floor(sz / 2)))
  if (t.length <= sz) return [t]
  const out = []
  let i = 0
  while (i < t.length) {
    const end = Math.min(i + sz, t.length)
    out.push(t.slice(i, end))
    if (end >= t.length) break
    const next = end - ov
    // 兜底：任何情况下都必须前进，否则直接截断（宁可少一块，也不死循环）
    if (next <= i) break
    i = next
  }
  return out
}

/**
 * 查询词覆盖率：query 分词在文档中出现的占比（绝对尺度 0~1，不受「除以最大值」影响）。
 * 短查询靠它拦住「只共享一个常见分词」的无关片段，query 为空返回 0。
 */
function queryCoverage(qSet, docTokens) {
  if (!qSet.size) return 0
  let n = 0
  for (const t of new Set(docTokens)) if (qSet.has(t)) n++
  return n / qSet.size
}

export class KnowledgeStore {
  constructor({ kv, embedFn = null, key = DEFAULT_KEY, chunkSize = 500, chunkOverlap = 50, topK = 5, minScore = 0.3, logger = null, vectorStore = null, vectorDir = null, vectorSignature = null, vectorBackend = 'auto', vectorGpuConsent = false, hnsw = {}, cuvs = {} } = {}) {
    if (!kv) throw new Error('KnowledgeStore 需要 kv')
    this.kv = kv
    this.embedFn = embedFn
    this.key = key
    this.chunkSize = chunkSize
    this.chunkOverlap = chunkOverlap
    this.topK = topK
    this.minScore = minScore
    this.logger = logger
    // 本地向量索引（可选）：KV 仍是事实源，索引只做加速；失败时自动回退词面检索
    this.vector = vectorStore || null
    if (!this.vector && vectorDir) {
      try {
        this.vector = new LocalVectorStore({
          dir: vectorDir,
          signature: vectorSignature,
          backend: vectorBackend,
          gpuConsent: vectorGpuConsent,
          hnsw,
          cuvs,
          logger: (...args) => this.logger?.(...args),
        })
      } catch (e) {
        this.logger?.('warn', `[kb] 本地向量库初始化失败，回退词面检索：${e?.message || e}`)
      }
    }
    this._vectorMismatch = false
    // 定时刷新（URL 文档周期 re-crawl）：scheduler 延后注入（见 attachScheduler）
    this.scheduler = null
    this._refreshJobs = new Map() // docId -> job handle
    this._lock = createKeyedLock() // 单条全局 KV 的 RMW 串行化：并发 ingest/refresh 会互相丢文档
  }

  /** 注入 scheduler（供定时刷新注册 job）。knowledge 构造早于 scheduler 创建，故延后注入。 */
  attachScheduler(scheduler) { this.scheduler = scheduler }

  /**
   * 读取知识库。
   * 关键：**读失败/值损坏绝不能当成「空库」**——所有变更方法都是 `_load → 改 → _save` 整份写回，
   * 一次 Redis 抖动或坏值就会把整库抹掉（实测：读故障后 ingest 返回成功、落盘只剩新文档，无任何告警）。
   * 因此这里把「没有这个键」（null/undefined）视为空库，其余异常一律抛出中止本次写入。
   */
  async _load() {
    let v
    try {
      v = await this.kv.get(this.key)
    } catch (e) {
      throw new Error(`知识库读取失败，已中止本次写入（避免整库被覆盖）：${e?.message || e}`)
    }
    if (v == null) return { docs: [], chunks: [] }
    if (typeof v !== 'object' || !Array.isArray(v.docs) || !Array.isArray(v.chunks)) {
      throw new Error('知识库数据损坏（结构不是 {docs,chunks}），已中止本次写入；请先备份/清空该键后重试')
    }
    return v
  }

  async _save(data) { await this.kv.set(this.key, data) }

  // ── 本地向量索引 ──

  _chunkKey(c) { return `${c.docId}:${c.idx}` }

  /** 可入索引的 chunk（必须有 embedding）；meta 只放定位字段，正文仍从 KV 读。 */
  _vectorItems(chunks = []) {
    return chunks
      .filter((c) => Array.isArray(c.embedding) && c.embedding.length)
      .map((c) => ({
        id: this._chunkKey(c),
        vector: c.embedding,
        meta: { docId: c.docId, idx: c.idx },
      }))
  }

  /** 索引文件损坏/换 embedding 模型/维度不一致时，按缓存内容重建或明确降级。 */
  _ensureVectorIndex(data) {
    if (!this.vector || this._vectorMismatch) return false
    try {
      this.vector.load()
    } catch (e) {
      if (e instanceof VectorStoreError && (e.code === 'signature_mismatch' || e.code === 'dimension_mismatch' || e.code === 'metric_mismatch')) {
        this._vectorMismatch = true
        this.logger?.('warn', `[kb] 向量索引与当前 embedding 模型不匹配，已回退词面检索；请执行 #知识库重建：${e.message}`)
        try { this.vector.clear() } catch { /* noop */ }
        return false
      }
      this.logger?.('warn', `[kb] 向量索引损坏，按 KV 内容重建：${e.message}`)
      try { this.vector.clear() } catch { /* noop */ }
    }
    const items = this._vectorItems(data.chunks)
    if (this.vector.size !== items.length) this._rebuildVectorIndex(items)
    return this.vector.size > 0
  }

  _rebuildVectorIndex(items) {
    if (!this.vector) return 0
    try {
      this.vector.rebuild(items)
      return this.vector.size
    } catch (e) {
      this.logger?.('warn', `[kb] 向量索引重建失败，回退词面检索：${e?.message || e}`)
      return 0
    }
  }

  _indexChunks(chunks) {
    if (!this.vector || this._vectorMismatch) return 0
    try {
      this.vector.upsertMany(this._vectorItems(chunks))
      this.vector.save()
      return this.vector.size
    } catch (e) {
      this.logger?.('warn', `[kb] 向量索引写入失败（下次检索会按 KV 重建）：${e?.message || e}`)
      return 0
    }
  }

  _unindexChunks(chunks) {
    if (!this.vector || this._vectorMismatch) return 0
    try {
      const n = this.vector.removeMany(chunks.map((c) => this._chunkKey(c)))
      if (n) this.vector.save()
      return n
    } catch (e) {
      this.logger?.('warn', `[kb] 向量索引删除失败（下次检索会按 KV 重建）：${e?.message || e}`)
      return 0
    }
  }

  /** 入库：文本 → SimHash 去重 → chunk → 批量 embedding → 存。返回 { id, chunkCount, embedded } */
  async ingest(text, { title, source, extra } = {}) {
    const chunks = chunkText(text, this.chunkSize, this.chunkOverlap)
    if (!chunks.length) return { error: '空文本，无法入库' }

    return this._lock.withLock(this.key, async () => {
      const data = await this._load()
      this._ensureVectorIndex(data)
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
      const addedChunks = chunks.map((c, idx) => ({
        docId: id, idx, text: c,
        embedding: Array.isArray(embeddings) ? embeddings[idx] : null,
        createdAt: now,
      }))
      data.chunks.push(...addedChunks)
      await this._save(data)
      this._indexChunks(addedChunks)
      return { id, chunkCount: chunks.length, embedded: !!embeddings }
    })
  }

  /** 检索：优先本地向量索引；索引不可用 → cosine；无 embedding → BM25 × 查询词覆盖率 */
  async retrieve(query, topK, minScore) {
    const k = Math.max(1, Number(topK) || this.topK)
    const min = Number.isFinite(Number(minScore)) ? Number(minScore) : this.minScore
    const data = await this._load()
    if (!data.chunks.length) return []

    let qvec = null
    if (this.embedFn) { try { qvec = await this.embedFn(query) } catch { qvec = null } }
    const docsMap = new Map(data.docs.map((d) => [d.id, d]))

    // 1) 本地向量索引（Flat exact）：索引缺失/损坏时 _ensure 会按 KV 里的 embedding 重建
    if (this.vector && qvec && this._ensureVectorIndex(data)) {
      try {
        const hits = this.vector.search(qvec, k, { minScore: min })
        const byId = new Map(data.chunks.map((c) => [this._chunkKey(c), c]))
        return hits
          .filter((h) => h.score > min)
          .map((h) => {
            const c = byId.get(h.id)
            return c ? { text: c.text, docId: c.docId, idx: c.idx, doc: docsMap.get(c.docId), _score: h.score } : null
          })
          .filter(Boolean)
      } catch (e) {
        this.logger?.('warn', `[kb] 向量索引检索失败，回退词面检索：${e?.message || e}`)
      }
    }

    let scores
    if (qvec && !this._vectorMismatch && data.chunks.some((c) => c.embedding)) {
      // 有 embedding 但未启用本地索引：保留原 cosine 线性扫描
      scores = data.chunks.map((c) => (c.embedding ? cosine(qvec, c.embedding) : 0))
    } else {
      // 无 embedding：BM25 纯代码检索（jieba 分词）。
      // scoresNormalized 是「除以最大值」的相对分（top1 恒为 1.00），单独用来比 minScore 会让阈值失效、
      // 展示给模型的 score 也具误导性；故再乘「查询词覆盖率」这一绝对尺度（命中的 query 分词占比）。
      const qTokens = await tokenize(query)
      const qSet = new Set(qTokens)
      const bm = new BM25()
      const docTokens = []
      for (const c of data.chunks) { const t = await tokenize(c.text); docTokens.push(t); bm.add(t) }
      const rel = bm.scoresNormalized(qTokens)
      scores = rel.map((s, i) => s * queryCoverage(qSet, docTokens[i]))
    }
    const scored = data.chunks.map((c, i) => ({
      text: c.text, docId: c.docId, idx: c.idx, doc: docsMap.get(c.docId), _score: scores[i] || 0,
    }))
    return scored.filter((c) => c._score > min).sort((a, b) => b._score - a._score).slice(0, k)
  }

  async listDocs() { return (await this._load()).docs }

  async removeDoc(docId) {
    // 删前取消定时刷新 job（防野 job 到点对一个已删 doc 跑刷新）；persist=false——refreshCron 随文档一并删除，
    // 不在锁外做「load→改→save」的 RMW（会被并发 ingest/refresh 的旧快照覆盖）
    try { if (this._refreshJobs.has(docId)) await this.cancelRefresh(docId, false) } catch { /* noop */ }
    return this._lock.withLock(this.key, async () => {
      const data = await this._load()
      this._ensureVectorIndex(data)
      const before = data.docs.length
      const removedChunks = data.chunks.filter((c) => c.docId === docId)
      data.docs = data.docs.filter((d) => d.id !== docId)
      data.chunks = data.chunks.filter((c) => c.docId !== docId)
      await this._save(data)
      this._unindexChunks(removedChunks)
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
      this._vectorMismatch = false
      const indexed = this.vector ? this._rebuildVectorIndex(this._vectorItems(data.chunks)) : null
      return { rebuilt: data.chunks.length, indexed }
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
    if (!r.success || !r.markdown) return { error: `抓取失败：${r.error || '无内容'}${r.hint ? `（${r.hint}）` : ''}` }
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
      this._ensureVectorIndex(data)
      const doc = data.docs.find((d) => d.id === docId)
      if (!doc || !doc.url) return { error: `文档 ${docId} 无 URL，不可刷新` }
      const r = await crawlUrl(doc.url)
      if (!r.success || !r.markdown) return { error: `抓取失败：${r.error || '无内容'}${r.hint ? `（${r.hint}）` : ''}` }
      const oldChunks = data.chunks.filter((c) => c.docId === docId)
      data.chunks = data.chunks.filter((c) => c.docId !== docId) // 删旧 chunks
      const chunks = chunkText(r.markdown, this.chunkSize, this.chunkOverlap)
      if (!chunks.length) return { error: '抓取内容为空，无法分块' }
      let embeddings = null
      if (this.embedFn) { try { embeddings = await this.embedFn(chunks) } catch { /* embed 失败降级 BM25 */ } }
      const now = Date.now()
      const addedChunks = chunks.map((c, idx) => ({
        docId, idx, text: c, embedding: Array.isArray(embeddings) ? embeddings[idx] : null, createdAt: now,
      }))
      data.chunks.push(...addedChunks)
      doc.chunkCount = chunks.length; doc.lastCrawled = now
      try { doc.simhash = simhash(await tokenize(r.markdown)) } catch { /* noop */ }
      await this._save(data)
      this._unindexChunks(oldChunks)
      this._indexChunks(addedChunks)
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
    // load→改→save 与 ingest/removeDoc/refreshDoc 共用同一把 key 锁：无锁 RMW 会被并发写者的旧快照
    // 整体覆盖（定时刷新配置静默丢失 / 反向时序下新入库文档被抹掉）
    const r = await this._lock.withLock(this.key, async () => {
      const data = await this._load()
      const doc = data.docs.find((d) => d.id === docId)
      if (!doc) return { error: `文档 ${docId} 不存在` }
      if (!doc.url) return { error: `文档 ${docId} 无 URL，不可设定时刷新` }
      // ⚠ 顺序：先注册新 job，成功后才取消旧 job。曾先 _cancelJob 再校验新 cron —— 非法表达式会
      // 让**已在跑**的定时刷新被取消且不恢复，KV 却仍显示「已排期」，静默停摆（2026-10-17 回归审计 medium-4）。
      const prevCron = doc.refreshCron || null
      // ⚠ 必须先取旧句柄：_scheduleRefresh 成功时会用**新** job 覆盖句柄表。第 8 轮审计 high-1：
      // 原来在注册成功后调 `_cancelJob(docId)`，从同一张表读到的正是刚注册的新 job → 当场取消，
      // 定时刷新永不触发，而命令/面板/KV 都回报「已排期」；同 cron 重复保存还会让旧 job 变孤儿
      // （句柄被覆盖、取消不掉），每个 tick 重复抓同一 URL。
      const prevJob = this._refreshJobs.get(docId) || null
      if (cron && this.scheduler) {
        if (!this._scheduleRefresh(docId, cron)) {
          // 注册失败：旧 job 未被覆盖则继续跑（不重复注册）；句柄缺失时才按旧 cron 复原
          if (!prevJob && prevCron) this._scheduleRefresh(docId, prevCron)
          return { error: `非法的定时刷新表达式：${cron}（5 段 cron，例如 0 8 * * *）` }
        }
        // 换掉旧 job：句柄表此刻已指向新 job，按引用取消旧的那个（不能用按 docId 查表的 _cancelJob）
        if (prevJob && prevJob !== this._refreshJobs.get(docId)) {
          try { this.scheduler.cancelJob(prevJob) } catch { /* noop */ }
        }
      } else if (prevJob) {
        this._cancelJob(docId) // cron=null：取消定时刷新
      }
      doc.refreshCron = cron || null
      await this._save(data)
      return { id: docId, cron: cron || null }
    })
    return r
  }

  /** 取消定时刷新：cancelJob + 清句柄。persist=true 时同步把 doc.refreshCron 写回 null（与其它 RMW 同锁）。 */
  async cancelRefresh(docId, persist = true) {
    this._cancelJob(docId)
    if (!persist) return { id: docId }
    return this._lock.withLock(this.key, async () => {
      const data = await this._load()
      const doc = data.docs.find((d) => d.id === docId)
      if (doc && doc.refreshCron) { doc.refreshCron = null; await this._save(data) }
      return { id: docId }
    })
  }

  /** 取消某 doc 的调度 job 并清句柄（不碰 KV，故可在 key 锁内调用，不会自锁死） */
  _cancelJob(docId) {
    const j = this._refreshJobs.get(docId)
    if (j && this.scheduler) { try { this.scheduler.cancelJob(j) } catch { /* noop */ } }
    this._refreshJobs.delete(docId)
  }

  _scheduleRefresh(docId, cron) {
    if (!this.scheduler) return null
    let job = null
    try {
      job = this.scheduler.scheduleJob(cron, () => {
        this.refreshDoc(docId).catch(() => { /* 刷新失败保留下轮重试，此处静默 */ })
      })
    } catch (e) {
      this.logger?.('warn', `[kb] 定时刷新注册失败（cron=${cron}）：${e?.message || e}`)
      return null
    }
    // node-schedule 对无法解析的 cron 返回 null 而非抛错（2026-10-17 审计 L1）：此处原来只 catch 异常，
    // 于是把 null 存进句柄表并回报「已设置」，重启恢复也一样 —— 面板/列表都显示已排期，实际永不触发。
    if (!job) {
      this.logger?.('warn', `[kb] 定时刷新 cron 非法，未注册：${cron}`)
      return null
    }
    this._refreshJobs.set(docId, job)
    return job
  }

  /** 重启恢复：遍历带 refreshCron 的 doc 重新注册 job。在 apps 启动恢复时调一次。
   *  幂等：先取消本实例已排 job 再重排，重复调用不会叠加触发。 */
  async restoreRefreshJobs(onRefresh) {
    for (const job of this._refreshJobs.values()) { try { this.scheduler?.cancelJob(job) } catch { /* noop */ } }
    this._refreshJobs.clear()
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

  /** 取消全部定时刷新 job（热重载/关闭时调，防止旧 job 泄漏继续触发） */
  shutdown() {
    for (const job of this._refreshJobs.values()) { try { this.scheduler?.cancelJob(job) } catch { /* noop */ } }
    this._refreshJobs.clear()
    try { this.vector?.close?.() } catch { /* noop */ }
  }
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
