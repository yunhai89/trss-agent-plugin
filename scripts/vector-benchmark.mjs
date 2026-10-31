#!/usr/bin/env node
/**
 * 向量库性能自检 —— 检测 GPU/后端可用性，并用合成向量测 Flat/HNSW/cuVS 的建库与查询延迟。
 *
 * 用法：
 *   node scripts/vector-benchmark.mjs
 *   node scripts/vector-benchmark.mjs --n=50000 --dim=256 --queries=100 --topk=10
 *   node scripts/vector-benchmark.mjs --cuvs        # 显式授权测 GPU（需已装 cuvs-node + NVIDIA GPU）
 *
 * 注意：这是开发/运维自检，不参与 npm test；合成向量不代表真实 embedding 分布，仅用于容量/延迟参考。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LocalVectorStore } from '../model/agent/vector-store.js'
import { detectGpu, loadHnswSync, loadCuvsSync } from '../model/agent/vector-backends.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  return m ? [m[1], m[2] == null ? true : m[2]] : [a, true]
}))
const n = Math.max(100, Number(args.n) || 10000)
const dim = Math.max(8, Number(args.dim) || 128)
const queries = Math.max(1, Number(args.queries) || 50)
const topK = Math.max(1, Number(args.topk) || 5)
const wantCuvs = args.cuvs === true || args.cuvs === 'true'

let seed = 42
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5 }
const items = Array.from({ length: n }, (_, i) => ({ id: `v${i}`, vector: Array.from({ length: dim }, rand) }))
const queryVecs = Array.from({ length: queries }, () => Array.from({ length: dim }, rand))

function now() { return Number(process.hrtime.bigint()) / 1e6 }
function fmt(ms) { return `${ms.toFixed(ms < 10 ? 2 : 1)}ms` }

function bench(label, backend, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vecbench-${backend}-`))
  try {
    const s = new LocalVectorStore({ dir, backend, ...opts })
    const t0 = now()
    s.upsertMany(items)
    const build = now() - t0
    const t1 = now()
    const results = queryVecs.map((q) => s.search(q, topK).map((h) => h.id))
    const search = now() - t1
    return {
      label, backend: s.stats().backend, buildMs: build, searchMs: search / queries,
      avgMs: search / queries, results, size: s.size,
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

console.log('🧪 向量库性能自检')
console.log(`数据：${n} 条 × ${dim} 维，查询 ${queries} 次，topK=${topK}`)
const gpu = await detectGpu()
console.log(`GPU：${gpu.hasGpu ? `${gpu.name}（${gpu.memoryMB || '?'}MB，驱动 ${gpu.driver || '?'}）` : `未检测到（${gpu.reason || 'unknown'}）`}`)
try { loadHnswSync(); console.log('HNSW：hnswlib-node 已安装') } catch (e) { console.log(`HNSW：不可用（${e?.message || e}），将只测 Flat`) }
try { loadCuvsSync(); console.log('cuVS：cuvs-node 已安装') } catch (e) { console.log(`cuVS：不可用（${e?.message || e}）`) }

const flat = bench('Flat（精确）', 'flat')
console.log(`\nFlat：建库/插入 ${fmt(flat.buildMs)} · 平均查询 ${fmt(flat.avgMs)} · ${flat.size} 条`)

let hnsw = null
try {
  hnsw = bench('HNSW（CPU）', 'hnsw', { hnsw: { m: Number(args.m) || 16, efConstruction: Number(args.efConstruction) || 200, efSearch: Number(args.efSearch) || 256, rerank: Number(args.rerank) || 4 } })
  let hit = 0
  let total = 0
  for (let i = 0; i < hnsw.results.length; i++) {
    const exact = new Set(flat.results[i] || [])
    const list = hnsw.results[i] || []
    total += list.length
    for (const id of list) if (exact.has(id)) hit++
  }
  const recall = total ? hit / total : 0
  console.log(`HNSW：建库/插入 ${fmt(hnsw.buildMs)} · 平均查询 ${fmt(hnsw.avgMs)} · 相对 Flat 的 topK 重合率 ${(recall * 100).toFixed(1)}%`)
} catch (e) {
  console.log(`HNSW：跳过（${e?.message || e}）`)
}

if (wantCuvs) {
  if (!gpu.hasGpu) {
    console.log('cuVS：跳过（未检测到 GPU）')
  } else {
    try {
      const cuvs = bench('cuVS（GPU）', 'cuvs', { gpuConsent: true, cuvs: { rerank: Number(args.rerank) || 4 } })
      console.log(`cuVS：建库/插入 ${fmt(cuvs.buildMs)} · 平均查询 ${fmt(cuvs.avgMs)} · 实际后端 ${cuvs.backend}`)
    } catch (e) {
      console.log(`cuVS：跳过（${e?.message || e}）`)
    }
  }
} else if (gpu.hasGpu) {
  console.log('cuVS：已检测到 GPU；如需测试请显式加 --cuvs（确认显卡空闲）')
}
