/**
 * cuVS GPU 真机验证 —— 仅在 Linux + NVIDIA GPU + cuvs-node 可用时执行，否则 SKIP_FILE。
 * 覆盖：BruteForce 精确检索/持久化/增删改、CAGRA 图索引、KnowledgeStore 集成。
 *
 * 运行：node model/agent/vector-gpu.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LocalVectorStore } from './vector-store.js'
import { detectGpu, loadCuvsSync } from './vector-backends.js'
import { KnowledgeStore } from './knowledge.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), `${m}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`) }
function rm(dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ } }

const gpu = await detectGpu()
if (!gpu.hasGpu) {
  console.log(`SKIP_FILE: 未检测到 NVIDIA GPU（${gpu.reason || 'unknown'}）`)
  process.exit(0)
}
try { loadCuvsSync() } catch (e) {
  console.log(`SKIP_FILE: cuvs-node 不可用（${e?.message || e}）`)
  process.exit(0)
}
console.log(`真机：${gpu.name}（${gpu.memoryMB || '?'}MB，驱动 ${gpu.driver || '?'}）`)

let seed = 7
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5 }
const gen = (n, dim) => Array.from({ length: n }, (_, i) => ({ id: `v${i}`, vector: Array.from({ length: dim }, rand) }))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuvs-real-'))
try {
  // 1) BruteForce 精确检索：与 Flat 结果完全一致
  console.log('\n[1] cuVS BruteForce：与 Flat 精确结果一致')
  {
    const n = 5000, dim = 64
    const items = gen(n, dim)
    const queries = Array.from({ length: 20 }, () => Array.from({ length: dim }, rand))
    const flat = new LocalVectorStore({ dir: path.join(dir, 'flat'), backend: 'flat' })
    flat.upsertMany(items)
    const gpuStore = new LocalVectorStore({ dir: path.join(dir, 'gpu'), backend: 'cuvs', gpuConsent: true, cuvs: { algorithm: 'brute_force' } })
    let t = Date.now()
    gpuStore.upsertMany(items)
    gpuStore.save()
    const buildMs = Date.now() - t
    ok(gpuStore.stats().backend === 'cuvs', '实际后端=cuvs')
    eq(gpuStore.stats().cuvs.algorithm, 'brute_force', 'algorithm=brute_force')
    let same = true
    for (const q of queries) {
      const a = flat.search(q, 5).map((h) => h.id)
      const b = gpuStore.search(q, 5).map((h) => h.id)
      if (JSON.stringify(a) !== JSON.stringify(b)) { same = false; break }
    }
    ok(same, '20 次查询 top5 与 Flat 完全一致')
    console.log(`  · 5000×64 建库+落盘 ${buildMs}ms`)

    // 2) 持久化 + 增删改
    console.log('\n[2] cuVS BruteForce：持久化 + 增删改')
    const gpu2 = new LocalVectorStore({ dir: path.join(dir, 'gpu'), backend: 'cuvs', gpuConsent: true, cuvs: { algorithm: 'brute_force' } })
    gpu2.load()
    eq(gpu2.stats().backend, 'cuvs', '重启后加载 cuvs')
    const q0 = queries[0]
    eq(gpu2.search(q0, 5).map((h) => h.id), flat.search(q0, 5).map((h) => h.id), '重启后 top5 一致')
    gpu2.upsert('v0', queries[1], { changed: true })
    gpu2.save()
    eq(gpu2.search(queries[1], 1)[0].id, 'v0', '更新向量后命中 v0')
    gpu2.remove('v1')
    gpu2.save()
    ok(!gpu2.search(queries[1], 20).some((h) => h.id === 'v1'), '删除后不再返回 v1')
  }

  // 3) CAGRA 图索引
  console.log('\n[3] cuVS CAGRA：图索引可建/可查')
  {
    const n = 3000, dim = 64
    const items = gen(n, dim)
    const s = new LocalVectorStore({ dir: path.join(dir, 'cagra'), backend: 'cuvs', gpuConsent: true, cuvs: { algorithm: 'cagra' } })
    let t = Date.now()
    s.upsertMany(items)
    s.save()
    const buildMs = Date.now() - t
    const hits = s.search(items[0].vector, 5)
    eq(s.stats().cuvs.algorithm, 'cagra', 'algorithm=cagra')
    ok(hits.length === 5, 'CAGRA 返回 5 条')
    ok(hits[0].id === 'v0', 'CAGRA 自查询命中 v0')
    console.log(`  · 3000×64 CAGRA 建库+落盘 ${buildMs}ms`)
  }

  // 4) KnowledgeStore 集成
  console.log('\n[4] KnowledgeStore：cuvs 后端入库/检索/重建')
  {
    const kv = {
      _v: null,
      async get() { return this._v },
      async set(_k, v) { this._v = JSON.parse(JSON.stringify(v)) },
    }
    const toVec = (s) => [String(s).includes('猫') ? 1 : 0.1, String(s).includes('狗') ? 1 : 0.1, String(s).includes('鱼') ? 1 : 0.1]
    const embedFn = async (input) => Array.isArray(input) ? input.map(toVec) : toVec(input)
    const kb = new KnowledgeStore({
      kv, embedFn, logger: () => {},
      vectorDir: path.join(dir, 'kb'), vectorBackend: 'cuvs', vectorGpuConsent: true,
      cuvs: { algorithm: 'brute_force' }, chunkSize: 50, chunkOverlap: 0, minScore: 0.1,
    })
    const r = await kb.ingest('猫咪喜欢晒太阳', { title: 'cat' })
    ok(!r.error, '入库成功')
    const hits = await kb.retrieve('猫', 1)
    ok(hits.length === 1 && hits[0].doc.title === 'cat', 'cuvs 后端检索命中 cat')
    const rebuilt = await kb.rebuild()
    ok(!rebuilt.error && rebuilt.indexed === 1, 'rebuild 后 cuvs 索引 1 条')
  }
} finally {
  rm(dir)
}

console.log('\n========================================')
console.log(`cuVS 真机测试：通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
