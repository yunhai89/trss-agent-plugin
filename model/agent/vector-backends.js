/**
 * 向量检索后端 —— HNSW（CPU）与 cuVS（NVIDIA GPU）。
 *
 * 设计原则：
 *  - 都是可选后端：native 模块缺失/GPU 不可用/用户未授权时，由 LocalVectorStore 自动降级。
 *  - HNSW 用 hnswlib-node（C++ 绑定，m/efConstruction/efSearch 可调）。
 *  - GPU 用 cuvs-node（CAGRA）；**必须用户显式授权**才允许初始化，避免抢占用户 GPU 上正在跑的任务。
 *  - 后端只负责找候选（row），最终分数统一由 LocalVectorStore 用 Flat 向量精确重排，保证召回质量。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

const HNSW_MAGIC = 1
const CUVS_MAGIC = 1

export class VectorBackendError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'VectorBackendError'
    this.code = code
  }
}

function atomicJson(file, value) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value))
  fs.renameSync(tmp, file)
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** 同步加载 hnswlib-node（CJS），返回 HierarchicalNSW 构造器 */
export function loadHnswSync() {
  try {
    const mod = require('hnswlib-node')
    const HNSW = mod?.HierarchicalNSW || mod?.default?.HierarchicalNSW
    if (typeof HNSW !== 'function') throw new Error('导出中没有 HierarchicalNSW')
    return HNSW
  } catch (e) {
    throw new VectorBackendError(`hnswlib-node 不可用：${e?.message || e}`, 'hnsw_unavailable')
  }
}

/** 同步加载 cuvs-node（CJS），返回 { Resources, CagraIndex } */
export function loadCuvsSync() {
  try {
    const mod = require('cuvs-node')
    const Resources = mod?.Resources || mod?.default?.Resources
    const CagraIndex = mod?.CagraIndex || mod?.default?.CagraIndex
    const BruteForceIndex = mod?.BruteForceIndex || mod?.default?.BruteForceIndex
    if (typeof Resources !== 'function' || typeof CagraIndex !== 'function' || typeof BruteForceIndex !== 'function') {
      throw new Error('导出中缺少 Resources/CagraIndex/BruteForceIndex')
    }
    return { Resources, CagraIndex, BruteForceIndex }
  } catch (e) {
    throw new VectorBackendError(`cuvs-node 不可用：${e?.message || e}`, 'cuvs_unavailable')
  }
}

/**
 * 检测 NVIDIA GPU（nvidia-smi）。不启动任何 GPU 计算，仅用于「是否向用户提示可开启 GPU 方案」。
 * @returns {Promise<{hasGpu:boolean, name?:string, memoryMB?:number, driver?:string, reason?:string}>}
 */
export async function detectGpu({ timeoutMs = 1500, env = process.env } = {}) {
  if (process.platform !== 'linux' && process.platform !== 'win32') {
    return { hasGpu: false, reason: 'unsupported_platform' }
  }
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader,nounits',
    ], { timeout: timeoutMs, windowsHide: true, env })
    const line = String(stdout || '').split('\n').map((s) => s.trim()).find(Boolean)
    if (!line) return { hasGpu: false, reason: 'no_output' }
    const [name, memoryMB, driver] = line.split(',').map((s) => s.trim())
    return {
      hasGpu: true,
      name: name || 'NVIDIA GPU',
      memoryMB: Number(memoryMB) || null,
      driver: driver || null,
      cudaVisibleDevices: env?.CUDA_VISIBLE_DEVICES || null,
    }
  } catch (e) {
    return {
      hasGpu: false,
      reason: e?.code === 'ENOENT' ? 'nvidia_smi_missing' : 'nvidia_smi_failed',
      error: e?.message || String(e),
    }
  }
}

/**
 * HNSW（CPU）后端。labels 由本类维护，row 指向 LocalVectorStore 的 Flat 向量行。
 * 更新向量时 markDelete 旧 label + 新 label，避免 hnswlib 不支持原地更新。
 */
export class HnswIndex {
  constructor({ dir, m = 16, efConstruction = 200, efSearch = 256, rerank = 4, signature = null, logger = null } = {}) {
    if (!dir) throw new VectorBackendError('HnswIndex 需要 dir', 'bad_dir')
    this.dir = dir
    this.binFile = path.join(dir, 'hnsw.bin')
    this.metaFile = path.join(dir, 'hnsw.json')
    this.m = Math.max(4, Math.floor(Number(m) || 16))
    this.efConstruction = Math.max(this.m, Math.floor(Number(efConstruction) || 200))
    this.efSearch = Math.max(1, Math.floor(Number(efSearch) || 256))
    this.rerank = Math.max(1, Math.floor(Number(rerank) || 4))
    this.signature = signature == null ? null : String(signature)
    this.logger = typeof logger === 'function' ? logger : null
    this._HNSW = loadHnswSync()
    this._index = null
    this._labels = new Map() // id -> label
    this._rows = new Map() // label -> row
    this._seq = 0
    this._dim = 0
    this._deleted = 0
  }

  get activeCount() { return this._rows.size }
  get ready() { return !!this._index }

  _log(level, ...args) {
    try { this.logger?.(level, ...args) } catch { /* noop */ }
  }

  _reset() {
    this._index = null
    this._labels.clear()
    this._rows.clear()
    this._seq = 0
    this._dim = 0
    this._deleted = 0
  }

  _newIndex(dim, maxElements) {
    const index = new this._HNSW('cosine', dim)
    index.initIndex({
      maxElements: Math.max(16, Math.ceil(maxElements)),
      m: this.m,
      efConstruction: this.efConstruction,
      randomSeed: 100,
      allowReplaceDeleted: true,
    })
    index.setEf(this.efSearch)
    return index
  }

  /** 用完整条目重建索引；entries: [{ id, row, vector }] */
  build(entries = []) {
    this._reset()
    if (!entries.length) {
      try { fs.unlinkSync(this.binFile) } catch { /* noop */ }
      try { fs.unlinkSync(this.metaFile) } catch { /* noop */ }
      return this
    }
    const dim = entries[0].vector.length
    this._dim = dim
    const index = this._newIndex(dim, entries.length * 1.2 + 16)
    for (const e of entries) {
      const label = this._seq++
      index.addPoint(Array.from(e.vector), label)
      this._labels.set(String(e.id), label)
      this._rows.set(label, e.row)
    }
    this._index = index
    return this
  }

  /** 加载已有 HNSW 文件；entries 用于校验 id 映射。失败返回 false（调用方 build）。 */
  load(entries = []) {
    if (!fs.existsSync(this.binFile) || !fs.existsSync(this.metaFile)) return false
    const meta = readJson(this.metaFile)
    if (!meta || meta.version !== HNSW_MAGIC) return false
    if (this.signature != null && meta.signature != null && String(meta.signature) !== this.signature) return false
    if (!entries.length) return false
    const dim = entries[0].vector.length
    if (Number(meta.dim) !== dim || Number(meta.count) !== entries.length) return false
    try {
      const index = new this._HNSW('cosine', dim)
      index.readIndexSync(this.binFile)
      if (Number(index.getNumDimensions?.()) !== dim) return false
      if (Number(index.getCurrentCount?.()) !== entries.length) return false
      index.setEf(this.efSearch)
      const rowById = new Map(entries.map((e) => [String(e.id), e.row]))
      const labels = new Map()
      const rows = new Map()
      for (const pair of Array.isArray(meta.labels) ? meta.labels : []) {
        const id = String(pair?.[0])
        const label = Number(pair?.[1])
        const row = rowById.get(id)
        if (row == null || !Number.isFinite(label)) continue
        labels.set(id, label)
        rows.set(label, row)
      }
      if (rows.size !== entries.length) return false
      this._index = index
      this._labels = labels
      this._rows = rows
      let maxLabel = Number(meta.seq) || 0
      for (const label of rows.keys()) maxLabel = Math.max(maxLabel, label)
      this._seq = maxLabel + 1
      this._dim = dim
      this._deleted = Math.max(0, Number(meta.deleted) || 0)
      // 上次保存后累积的 tombstone 过多：直接按当前向量重建，避免继续用退化图
      if (this._deleted > Math.max(64, entries.length * 0.3)) {
        this.build(entries)
      }
      return true
    } catch (e) {
      this._log('warn', `[vector] HNSW 索引加载失败，按 Flat 向量重建：${e?.message || e}`)
      return false
    }
  }

  _ensureCapacity() {
    if (!this._index) return
    if (this._index.getCurrentCount() < this._index.getMaxElements()) return
    try { this._index.resizeIndex(Math.max(16, this._index.getMaxElements() * 2)) } catch { /* noop */ }
  }

  upsert(id, row, vector) {
    if (!this._dim) this._dim = vector.length
    if (!this._index) this._index = this._newIndex(this._dim, 64)
    const key = String(id)
    const old = this._labels.get(key)
    if (old != null) {
      try { this._index.markDelete(old) } catch { /* noop */ }
      this._labels.delete(key)
      this._rows.delete(old)
      this._deleted++
    }
    this._ensureCapacity()
    const label = this._seq++
    this._index.addPoint(Array.from(vector), label)
    this._labels.set(key, label)
    this._rows.set(label, row)
  }

  remove(id) {
    const key = String(id)
    const label = this._labels.get(key)
    if (label == null) return
    try { this._index?.markDelete(label) } catch { /* noop */ }
    this._labels.delete(key)
    this._rows.delete(label)
    this._deleted++
  }

  search(query, topK) {
    if (!this._index || !this._rows.size) return []
    const k = Math.max(1, Math.min(Math.floor(Number(topK) || 1), this._rows.size))
    // efSearch 必须不小于本次 k，否则 topK 较大时会被搜索宽度截断
    try { this._index.setEf(Math.max(this.efSearch, k)) } catch { /* noop */ }
    const res = this._index.searchKnn(Array.from(query), k)
    const out = []
    for (const label of res?.neighbors || []) {
      const row = this._rows.get(label)
      if (row != null) out.push({ row })
    }
    return out
  }

  save(entries = []) {
    if (!this._index) return
    // 频繁更新/删除会在 HNSW 里留下大量 tombstone，超过阈值时按当前向量重建，避免图质量下降
    if (entries.length && this._deleted > Math.max(64, this._rows.size * 0.3)) {
      this.build(entries)
    }
    if (!this._index) return
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.binFile}.tmp`
    this._index.writeIndexSync(tmp)
    fs.renameSync(tmp, this.binFile)
    atomicJson(this.metaFile, {
      version: HNSW_MAGIC,
      dim: this._dim,
      count: this._rows.size,
      signature: this.signature,
      seq: this._seq,
      deleted: this._deleted,
      labels: [...this._labels.entries()],
    })
  }

  close() {
    this._reset()
  }

  stats() {
    return {
      backend: 'hnsw', m: this.m, efConstruction: this.efConstruction, efSearch: this.efSearch,
      rerank: this.rerank, count: this._rows.size, dim: this._dim,
    }
  }
}

/**
 * cuVS（NVIDIA GPU）后端。使用 CAGRA 构建/检索；索引不可增量更新，upsert/remove 后标记 dirty，
 * 下一次 search/save 时用完整 Flat 向量重建。
 */
export class CuvsIndex {
  constructor({ dir, gpuConsent = false, rerank = 4, algorithm = 'brute_force', signature = null, logger = null } = {}) {
    if (!dir) throw new VectorBackendError('CuvsIndex 需要 dir', 'bad_dir')
    if (!gpuConsent) throw new VectorBackendError('GPU 向量库需要用户显式授权（kb.vectorGpuConsent=true）', 'cuvs_consent_required')
    this.dir = dir
    this.binFile = path.join(dir, 'cuvs.bin')
    this.metaFile = path.join(dir, 'cuvs.json')
    this.rerank = Math.max(1, Math.floor(Number(rerank) || 4))
    this.algorithm = algorithm === 'cagra' ? 'cagra' : 'brute_force'
    this.signature = signature == null ? null : String(signature)
    this.logger = typeof logger === 'function' ? logger : null
    const { Resources, CagraIndex, BruteForceIndex } = loadCuvsSync()
    this._IndexClass = this.algorithm === 'cagra' ? CagraIndex : BruteForceIndex
    this._Resources = Resources
    this._resources = null
    this._index = null
    this._rows = []
    this._dim = 0
    this._dirty = true
  }

  _ensureResources() {
    if (!this._resources) this._resources = new this._Resources()
    return this._resources
  }

  get activeCount() { return this._rows.length }
  get ready() { return !!this._index && !this._dirty }
  get dirty() { return this._dirty }

  _log(level, ...args) {
    try { this.logger?.(level, ...args) } catch { /* noop */ }
  }

  _resetIndex() {
    this._index = null
    this._rows = []
    this._dirty = true
  }

  /** entries: [{ id, row, vector }]，vector 已是 L2 归一化（CAGRA 用 L2，等价 cosine 排序） */
  build(entries = []) {
    this._resetIndex()
    if (!entries.length) {
      this._dirty = false
      return this
    }
    this._dim = entries[0].vector.length
    const data = new Float32Array(entries.length * this._dim)
    this._rows = entries.map((e, i) => {
      data.set(e.vector, i * this._dim)
      return e.row
    })
    this._index = this._IndexClass.build(this._ensureResources(), data, { rows: entries.length, cols: this._dim })
    this._dirty = false
    return this
  }

  /** 加载 GPU 索引；entries 用于校验 count/dim 和恢复 row 映射 */
  load(entries = []) {
    if (!fs.existsSync(this.binFile) || !fs.existsSync(this.metaFile)) return false
    const meta = readJson(this.metaFile)
    if (!meta || meta.version !== CUVS_MAGIC) return false
    if (this.signature != null && meta.signature != null && String(meta.signature) !== this.signature) return false
    if (!entries.length) return false
    const dim = entries[0].vector.length
    if (Number(meta.dim) !== dim || Number(meta.count) !== entries.length || (meta.algorithm || 'brute_force') !== this.algorithm) return false
    try {
      this._index = this._IndexClass.deserialize(this._ensureResources(), this.binFile)
      this._rows = entries.map((e) => e.row)
      this._dim = dim
      this._dirty = false
      return true
    } catch (e) {
      this._log('warn', `[vector] cuVS 索引加载失败，按 Flat 向量重建：${e?.message || e}`)
      return false
    }
  }

  upsert() { this._dirty = true }
  remove() { this._dirty = true }

  search(query, topK, entries = []) {
    if (this._dirty) this.build(entries)
    if (!this._index || !this._rows.length) return []
    const maxK = this.algorithm === 'cagra' ? 64 : this._rows.length
    const k = Math.max(1, Math.min(Math.floor(Number(topK) || 1), this._rows.length, maxK))
    const res = this._index.search(this._ensureResources(), Float32Array.from(query), { rows: 1, cols: this._dim, k })
    const out = []
    const indices = res?.indices || []
    for (let i = 0; i < indices.length; i++) {
      const row = this._rows[indices[i]]
      if (row != null) out.push({ row })
    }
    return out
  }

  save(entries = []) {
    if (this._dirty) this.build(entries)
    fs.mkdirSync(this.dir, { recursive: true })
    if (!this._index) {
      try { fs.unlinkSync(this.binFile) } catch { /* noop */ }
      try { fs.unlinkSync(this.metaFile) } catch { /* noop */ }
      return
    }
    const tmp = `${this.binFile}.tmp`
    this._index.serialize(this._ensureResources(), tmp)
    fs.renameSync(tmp, this.binFile)
    atomicJson(this.metaFile, {
      version: CUVS_MAGIC,
      dim: this._dim,
      count: this._rows.length,
      signature: this.signature,
      algorithm: this.algorithm,
    })
  }

  close() {
    this._resetIndex()
    try { this._resources?.dispose?.() } catch { /* noop */ }
    this._resources = null
  }

  stats() {
    return { backend: 'cuvs', algorithm: this.algorithm, rerank: this.rerank, count: this._rows.length, dim: this._dim, dirty: this._dirty }
  }
}
