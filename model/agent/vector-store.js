/**
 * LocalVectorStore —— 插件内嵌的纯 JS 向量库（Flat / exact search）。
 *
 * 定位：给知识库等需要语义检索的模块提供一个**零 native 依赖**的本地索引层。
 * 存储是单文件（vectors.bin）：8 字节 magic + uint32 header 长度 + JSON 元数据 + Float32 向量。
 * 单文件的好处是 save 只需一次 tmp+rename，不会出现「向量文件已换、元数据还是旧的」半写状态。
 *
 * 能力边界：
 *  - Flat 精确检索（O(n·dim)）是零依赖基线；可选 HNSW（hnswlib-node）与 cuVS/CAGRA（cuvs-node）。
 *  - ANN 后端只负责找候选，最终统一用 Flat 向量精确重排，降低近似索引的召回损失。
 *  - 相似度支持 cosine（写入时 L2 归一化）与 dot；ANN 后端目前仅用于 cosine。
 *  - KV/SQLite 仍是事实源，本索引必须可重建；load 失败时调用方可清空重建。
 *  - 删除用 tombstone，save 时压实；不自动落盘，调用方在批量写完显式 save()。
 */
import fs from 'node:fs'
import path from 'node:path'
import { HnswIndex, CuvsIndex, VectorBackendError } from './vector-backends.js'

const MAGIC = 'YVEC0001'
const FILE = 'vectors.bin'
const VERSION = 1
const DEFAULT_METRIC = 'cosine'

export class VectorStoreError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'VectorStoreError'
    this.code = code
  }
}

function isFiniteVector(vec) {
  if (!vec || typeof vec.length !== 'number' || !vec.length) return false
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) return false
  }
  return true
}

/** L2 归一化；零向量明确报错（否则 cosine 会静默变成全 0 相似度） */
function l2Normalize(vec) {
  let sum = 0
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i]
  const norm = Math.sqrt(sum)
  if (!Number.isFinite(norm) || norm <= 0) {
    throw new VectorStoreError('向量为零向量或包含非法值，无法归一化', 'zero_vector')
  }
  const out = new Float32Array(vec.length)
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm
  return out
}

/** float32 精度下的余弦相似度；输入已归一化时点积即余弦 */
function dotAt(a, b, offset) {
  let n = 0
  for (let i = 0; i < a.length; i++) n += a[i] * b[offset + i]
  return n
}

export class LocalVectorStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir 索引目录（文件固定为 vectors.bin）
   * @param {number} [opts.dimension] 期望维度（0=首条写入时确定）
   * @param {'cosine'|'dot'} [opts.metric]
   * @param {string|null} [opts.signature] embedding 模型/版本签名；不一致时 load 抛 signature_mismatch
   * @param {'auto'|'flat'|'hnsw'|'cuvs'} [opts.backend] auto=有 hnswlib-node 就用 HNSW；cuvs 必须显式指定且授权
   * @param {object} [opts.hnsw] { m, efConstruction, efSearch, rerank }
   * @param {object} [opts.cuvs] { rerank }
   * @param {boolean} [opts.gpuConsent] 是否允许使用 GPU 向量库（默认 false；auto 永不启用 GPU）
   * @param {function} [opts.logger] (level, ...args) => void
   */
  constructor({ dir, dimension = 0, metric = DEFAULT_METRIC, signature = null, logger = null, backend = 'auto', hnsw = {}, cuvs = {}, gpuConsent = false } = {}) {
    if (!dir) throw new VectorStoreError('LocalVectorStore 需要 dir', 'bad_dir')
    if (metric !== 'cosine' && metric !== 'dot') {
      throw new VectorStoreError(`不支持的向量 metric：${metric}（仅 cosine/dot）`, 'bad_metric')
    }
    this.dir = dir
    this.metric = metric
    this.signature = signature == null ? null : String(signature)
    this.logger = typeof logger === 'function' ? logger : null
    this.requestedBackend = ['auto', 'flat', 'hnsw', 'cuvs'].includes(String(backend).toLowerCase()) ? String(backend).toLowerCase() : 'auto'
    this.backend = 'flat'
    this._backendReason = null
    this._hnswOpts = { ...(hnsw || {}) }
    this._cuvsOpts = { ...(cuvs || {}) }
    this._gpuConsent = gpuConsent === true
    this._hnsw = null
    this._cuvs = null
    this._fixedDim = Math.max(0, Math.floor(Number(dimension) || 0))
    this._dim = this._fixedDim
    this._ids = []
    this._metas = []
    this._vectors = null
    this._map = new Map()
    this._count = 0
    this._loaded = false
  }

  get file() { return path.join(this.dir, FILE) }
  get size() { return this._count }
  get dimension() { return this._dim }
  get loaded() { return this._loaded }

  _log(level, ...args) {
    try { this.logger?.(level, ...args) } catch { /* noop */ }
  }

  _reset() {
    this._dim = this._fixedDim
    this._ids = []
    this._metas = []
    this._vectors = null
    this._map = new Map()
    this._count = 0
  }

  get backendName() { return this.backend }
  get backendReason() { return this._backendReason }

  _entries() {
    if (!this._dim || !this._vectors) return []
    const out = []
    for (let i = 0; i < this._ids.length; i++) {
      if (this._ids[i] == null) continue
      out.push({ id: this._ids[i], row: i, vector: this._vectors.subarray(i * this._dim, (i + 1) * this._dim) })
    }
    return out
  }

  _closeBackend() {
    try { this._hnsw?.close?.() } catch { /* noop */ }
    try { this._cuvs?.close?.() } catch { /* noop */ }
    this._hnsw = null
    this._cuvs = null
  }

  /** 初始化/重建 ANN 后端。auto 只用 HNSW；GPU 必须显式 backend=cuvs + gpuConsent。 */
  _initBackend() {
    this._closeBackend()
    this.backend = 'flat'
    const fallback = (reason) => {
      this._backendReason = reason
      if (reason) this._log('warn', `[vector] ${reason}，回退 Flat 精确检索`)
    }
    if (this.metric !== 'cosine') return fallback('ANN 后端仅支持 cosine')
    const requested = this.requestedBackend
    if (requested === 'flat') return
    const entries = this._entries()
    const tryHnsw = (reason = null) => {
      try {
        const idx = new HnswIndex({
          dir: this.dir,
          signature: this.signature,
          logger: this.logger,
          ...this._hnswOpts,
        })
        if (!idx.load(entries)) idx.build(entries)
        this._hnsw = idx
        this.backend = 'hnsw'
        this._backendReason = reason
        return
      } catch (e) {
        fallback(`HNSW 不可用（${e?.message || e}）`)
      }
    }
    if (requested === 'cuvs') {
      if (!this._gpuConsent) return tryHnsw('GPU 向量库未获用户授权')
      let idx = null
      try {
        idx = new CuvsIndex({
          dir: this.dir,
          gpuConsent: true,
          signature: this.signature,
          logger: this.logger,
          ...this._cuvsOpts,
        })
        if (!idx.load(entries)) idx.build(entries)
        this._cuvs = idx
        this.backend = 'cuvs'
        return
      } catch (e) {
        try { idx?.close?.() } catch { /* noop */ }
        if (e instanceof VectorBackendError && e.code === 'cuvs_consent_required') return tryHnsw('GPU 向量库未授权')
        tryHnsw(`GPU 向量库不可用（${e?.message || e}）`)
        return
      }
    }
    tryHnsw()
  }

  /** 后端索引与 Flat 行号/标签不一致时全量重建（压实、删除、批量替换后调用）。 */
  _rebuildBackend() {
    if (!this._hnsw && !this._cuvs) return
    const entries = this._entries()
    try {
      if (this._hnsw) {
        this._hnsw.build(entries)
        this._hnsw.save()
      }
      if (this._cuvs) {
        this._cuvs.build(entries)
        this._cuvs.save(entries)
      }
    } catch (e) {
      this._log('warn', `[vector] 后端重建失败（${e?.message || e}），回退 Flat 精确检索`)
      this._closeBackend()
      this.backend = 'flat'
      this._backendReason = '后端重建失败'
    }
  }

  /** 从磁盘加载；空目录/文件不存在 = 空索引。损坏时抛 VectorStoreError（调用方可重建）。 */
  load() {
    if (this._loaded) return this
    this._reset()
    this._loaded = true
    if (!fs.existsSync(this.file)) {
      this._initBackend()
      return this
    }
    const buf = fs.readFileSync(this.file)
    if (buf.length < 12 || buf.toString('utf8', 0, 8) !== MAGIC) {
      throw new VectorStoreError(`向量索引文件损坏（magic 不符）：${this.file}`, 'bad_file')
    }
    const headerLen = buf.readUInt32LE(8)
    if (!headerLen || 12 + headerLen > buf.length) {
      throw new VectorStoreError(`向量索引文件损坏（header 长度非法）：${this.file}`, 'bad_header')
    }
    let meta
    try {
      meta = JSON.parse(buf.toString('utf8', 12, 12 + headerLen))
    } catch (e) {
      throw new VectorStoreError(`向量索引元数据不是合法 JSON：${e?.message || e}`, 'bad_header')
    }
    if (!meta || meta.version !== VERSION) {
      throw new VectorStoreError(`向量索引版本不兼容：${meta?.version ?? '?'}`, 'bad_version')
    }
    if (meta.metric !== this.metric) {
      throw new VectorStoreError(`向量索引 metric 不匹配：${meta.metric} != ${this.metric}`, 'metric_mismatch')
    }
    const dim = Math.max(0, Math.floor(Number(meta.dim) || 0))
    const count = Math.max(0, Math.floor(Number(meta.count) || 0))
    if (this._fixedDim && dim !== this._fixedDim) {
      throw new VectorStoreError(`向量维度不匹配：文件 ${dim}，期望 ${this._fixedDim}`, 'dimension_mismatch')
    }
    if (this.signature != null && meta.signature != null && String(meta.signature) !== this.signature) {
      throw new VectorStoreError(`向量索引签名不匹配：${meta.signature} != ${this.signature}`, 'signature_mismatch')
    }
    if (!Array.isArray(meta.ids) || !Array.isArray(meta.metas) || meta.ids.length !== count || meta.metas.length !== count) {
      throw new VectorStoreError('向量索引元数据条目数与 count 不一致', 'bad_header')
    }
    const bytes = count * dim * 4
    if (buf.length - 12 - headerLen !== bytes) {
      throw new VectorStoreError(`向量索引数据长度不符：期望 ${bytes} 字节`, 'bad_file')
    }
    // 复制到独立的 ArrayBuffer，保证 Float32Array 的字节偏移按 4 对齐
    const ab = new ArrayBuffer(bytes)
    if (bytes) Buffer.from(ab).set(buf.subarray(12 + headerLen))
    this._dim = dim
    this._ids = meta.ids.map((id) => (id == null ? null : String(id)))
    this._metas = meta.metas
    this._vectors = bytes ? new Float32Array(ab) : null
    this._map = new Map()
    for (let i = 0; i < this._ids.length; i++) {
      if (this._ids[i] != null) this._map.set(this._ids[i], i)
    }
    this._count = this._map.size
    if (this._count !== count) {
      throw new VectorStoreError('向量索引 id 重复或为空', 'bad_header')
    }
    this._initBackend()
    return this
  }

  _ensureLoaded() {
    if (!this._loaded) this.load()
  }

  _normalize(vec) {
    if (!isFiniteVector(vec)) {
      throw new VectorStoreError('向量必须是长度 >0 的有限数值数组', 'bad_vector')
    }
    if (this._dim && vec.length !== this._dim) {
      throw new VectorStoreError(`向量维度不匹配：${vec.length} != ${this._dim}`, 'dimension_mismatch')
    }
    const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec)
    return this.metric === 'cosine' ? l2Normalize(arr) : arr
  }

  _append(id, vec, meta) {
    if (!this._dim) this._dim = vec.length
    if (vec.length !== this._dim) {
      throw new VectorStoreError(`向量维度不匹配：${vec.length} != ${this._dim}`, 'dimension_mismatch')
    }
    const slot = this._ids.length
    const need = (slot + 1) * this._dim
    if (!this._vectors) this._vectors = new Float32Array(Math.max(16, this._dim * 16))
    if (need > this._vectors.length) {
      const oldSlots = Math.floor(this._vectors.length / this._dim) || 0
      let cap = Math.max(16, oldSlots * 2, slot + 1)
      while (cap * this._dim < need) cap *= 2
      const next = new Float32Array(cap * this._dim)
      next.set(this._vectors)
      this._vectors = next
    }
    this._vectors.set(vec, slot * this._dim)
    this._ids.push(id)
    this._metas.push(meta)
    this._map.set(id, slot)
    this._count++
  }

  /**
   * 写入/覆盖一条向量。不自动落盘：批量 upsert 后调用 save()。
   * @returns {{id:string, added:boolean}}
   */
  upsert(id, vector, meta = {}) {
    this._ensureLoaded()
    const key = String(id)
    if (!key) throw new VectorStoreError('向量 id 不能为空', 'bad_id')
    const vec = this._normalize(vector)
    const idx = this._map.get(key)
    if (idx != null) {
      this._vectors.set(vec, idx * this._dim)
      this._metas[idx] = meta
      this._hnsw?.upsert(key, idx, vec)
      this._cuvs?.upsert()
      return { id: key, added: false }
    }
    this._append(key, vec, meta)
    const row = this._map.get(key)
    this._hnsw?.upsert(key, row, vec)
    this._cuvs?.upsert()
    return { id: key, added: true }
  }

  upsertMany(items = []) {
    this._ensureLoaded()
    let added = 0
    for (const it of items) {
      if (!it || it.id == null || !it.vector) continue
      if (this.upsert(it.id, it.vector, it.meta || {}).added) added++
    }
    return { added, total: items.length }
  }

  /** 删除一条（tombstone；save 时压实）。返回是否命中。 */
  remove(id) {
    this._ensureLoaded()
    const key = String(id)
    const idx = this._map.get(key)
    if (idx == null) return false
    this._ids[idx] = null
    this._metas[idx] = null
    if (this._vectors) this._vectors.fill(0, idx * this._dim, (idx + 1) * this._dim)
    this._map.delete(key)
    this._count--
    this._hnsw?.remove(key)
    this._cuvs?.remove()
    return true
  }

  removeMany(ids = []) {
    let n = 0
    for (const id of ids) if (this.remove(id)) n++
    return n
  }

  _compact() {
    if (this._count === this._ids.length) return false
    const ids = []
    const metas = []
    const vectors = this._dim && this._count ? new Float32Array(this._count * this._dim) : null
    let row = 0
    for (let i = 0; i < this._ids.length; i++) {
      const id = this._ids[i]
      if (id == null) continue
      ids.push(id)
      metas.push(this._metas[i])
      if (vectors) vectors.set(this._vectors.subarray(i * this._dim, (i + 1) * this._dim), row * this._dim)
      row++
    }
    this._ids = ids
    this._metas = metas
    this._vectors = vectors
    this._map = new Map(ids.map((id, i) => [id, i]))
    return true
  }

  /** 原子落盘：单文件 tmp+rename。 */
  save() {
    this._ensureLoaded()
    const compacted = this._compact()
    const header = Buffer.from(JSON.stringify({
      version: VERSION,
      metric: this.metric,
      dim: this._dim,
      count: this._count,
      signature: this.signature,
      ids: this._ids,
      metas: this._metas,
      savedAt: new Date().toISOString(),
    }), 'utf8')
    const dataLen = this._count * this._dim * 4
    const out = Buffer.allocUnsafe(12 + header.length + dataLen)
    out.write(MAGIC, 0, 'utf8')
    out.writeUInt32LE(header.length, 8)
    header.copy(out, 12)
    if (dataLen && this._vectors) {
      Buffer.from(this._vectors.buffer, this._vectors.byteOffset, dataLen).copy(out, 12 + header.length)
    }
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, out)
    fs.renameSync(tmp, this.file)
    // ANN 后端：压实会让行号/标签失效，必须按新数组重建；否则增量保存即可
    if (compacted && (this._hnsw || this._cuvs)) this._rebuildBackend()
    else {
      try { this._hnsw?.save(this._entries()) } catch (e) { this._log('warn', `[vector] HNSW 保存失败：${e?.message || e}`) }
      if (this._cuvs) {
        try { this._cuvs.save(this._entries()) } catch (e) { this._log('warn', `[vector] cuVS 保存失败：${e?.message || e}`) }
      }
    }
    return this
  }

  /**
   * 检索：ANN 后端先取候选，再用 Flat 向量精确重排；后端不可用时回退全量 Flat。
   * @param {number[]|Float32Array} query
   * @param {number} [topK]
   * @param {{filter?:function, minScore?:number}} [opts]
   * @returns {Array<{id:string, score:number, meta:object}>}
   */
  search(query, topK = 5, { filter = null, minScore = -Infinity } = {}) {
    this._ensureLoaded()
    const k = Math.max(0, Math.floor(Number(topK) || 0))
    if (!k || !this._count || !this._dim || !this._vectors) return []
    const q = this.metric === 'cosine' ? l2Normalize(Float32Array.from(query)) : Float32Array.from(query)
    if (q.length !== this._dim) {
      throw new VectorStoreError(`查询向量维度不匹配：${q.length} != ${this._dim}`, 'dimension_mismatch')
    }
    const floor = Number.isFinite(Number(minScore)) ? Number(minScore) : -Infinity

    if (this.backend === 'hnsw' && this._hnsw?.ready) {
      try {
        const candidates = this._hnsw.search(q, this._candidateK(k))
        const hits = this._scoreRows(q, candidates.map((c) => c.row), k, filter, floor)
        if (hits.length || candidates.length || !this._count) return hits
        // 近似索引返回空（常见于大量 tombstone/过滤过严）→ 用全量 Flat 兜底，避免静默丢失召回
        this._log('warn', '[vector] HNSW 候选为空，本次回退 Flat 精确检索')
      } catch (e) {
        this._log('warn', `[vector] HNSW 检索失败，本次回退 Flat：${e?.message || e}`)
      }
    } else if (this.backend === 'cuvs' && this._cuvs) {
      try {
        const candidates = this._cuvs.search(q, this._candidateK(k), this._entries())
        const hits = this._scoreRows(q, candidates.map((c) => c.row), k, filter, floor)
        if (hits.length || candidates.length || !this._count) return hits
        this._log('warn', '[vector] cuVS 候选为空，本次回退 Flat 精确检索')
      } catch (e) {
        this._log('warn', `[vector] cuVS 检索失败，本次回退 Flat：${e?.message || e}`)
      }
    }
    return this._flatSearch(q, k, filter, floor)
  }

  _candidateK(k) {
    if (this.backend === 'hnsw' && this._hnsw) {
      const s = this._hnsw.stats()
      // 至少取 efSearch 个候选：只取 topK*倍数时，高维随机数据上 HNSW 的 topK 召回会明显下降
      return Math.min(this._count, Math.max(k, k * s.rerank, s.efSearch))
    }
    if (this.backend === 'cuvs' && this._cuvs) {
      const s = this._cuvs.stats()
      return Math.min(this._count, Math.max(k, k * s.rerank, 64))
    }
    return k
  }

  _flatSearch(q, k, filter, floor) {
    const rows = []
    for (let i = 0; i < this._ids.length; i++) if (this._ids[i] != null) rows.push(i)
    return this._scoreRows(q, rows, k, filter, floor)
  }

  /** 对给定行做精确 cosine（q 已归一化）并按 Top-K 小顶堆排序 */
  _scoreRows(q, rows, k, filter, floor) {
    const heap = []
    const push = (item) => {
      if (heap.length < k) {
        heap.push(item)
        let i = heap.length - 1
        while (i > 0) {
          const p = (i - 1) >> 1
          if (heap[p].score <= heap[i].score) break
          ;[heap[p], heap[i]] = [heap[i], heap[p]]
          i = p
        }
        return
      }
      if (item.score <= heap[0].score) return
      heap[0] = item
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let smallest = i
        if (l < heap.length && heap[l].score < heap[smallest].score) smallest = l
        if (r < heap.length && heap[r].score < heap[smallest].score) smallest = r
        if (smallest === i) break
        ;[heap[i], heap[smallest]] = [heap[smallest], heap[i]]
        i = smallest
      }
    }
    for (const row of [...new Set(rows)].sort((a, b) => a - b)) {
      const id = this._ids[row]
      if (id == null) continue
      const meta = this._metas[row] || {}
      if (typeof filter === 'function') {
        let keep = false
        try { keep = filter(meta, id) } catch { keep = false }
        if (!keep) continue
      }
      const base = row * this._dim
      const score = dotAt(q, this._vectors, base)
      if (score < floor) continue
      push({ id, score, meta })
    }
    return heap.sort((a, b) => b.score - a.score)
  }

  /** 清空索引（默认同时删文件与关闭 ANN 后端）。 */
  clear({ removeFile = true } = {}) {
    this._closeBackend()
    this._reset()
    this._loaded = true
    this.backend = 'flat'
    if (removeFile) {
      for (const f of [this.file, path.join(this.dir, 'hnsw.bin'), path.join(this.dir, 'hnsw.json'), path.join(this.dir, 'cuvs.bin'), path.join(this.dir, 'cuvs.json')]) {
        try { fs.unlinkSync(f) } catch { /* 文件不存在忽略 */ }
      }
    }
    return this
  }

  /** 用完整条目重建（调用方负责提供 embedding；本方法不调用 embedding API）。 */
  rebuild(items = []) {
    this.clear()
    const r = this.upsertMany(items)
    this._initBackend()
    this.save()
    return r
  }

  /** 释放 GPU 资源（运行时关闭/热重载时调用）。 */
  close() {
    this._closeBackend()
    this.backend = 'flat'
    return this
  }

  stats() {
    return {
      dir: this.dir,
      file: this.file,
      size: this._count,
      dimension: this._dim,
      metric: this.metric,
      signature: this.signature,
      loaded: this._loaded,
      backend: this.backend,
      requestedBackend: this.requestedBackend,
      backendReason: this._backendReason,
      ...(this._hnsw ? { hnsw: this._hnsw.stats() } : {}),
      ...(this._cuvs ? { cuvs: this._cuvs.stats() } : {}),
    }
  }
}
