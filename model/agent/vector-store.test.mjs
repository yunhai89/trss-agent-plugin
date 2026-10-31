/**
 * LocalVectorStore 离线自检 —— Flat 检索 / 二进制持久化 / 过滤 / 维度与签名校验。
 * 运行：node model/agent/vector-store.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LocalVectorStore } from './vector-store.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), `${m}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 4).join('\n')) } }

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yv-'))
}
function rm(dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ } }
function codeOf(fn) {
  try { fn(); return '' } catch (e) { return e?.code || e?.name || String(e) }
}

await test('Flat cosine：写入/检索/覆盖', async () => {
  const dir = mkTmp()
  try {
    const s = new LocalVectorStore({ dir })
    s.upsert('a', [1, 0], { text: 'A' })
    s.upsert('b', [0, 1], { text: 'B' })
    s.upsert('c', [1, 1], { text: 'C' })
    eq(s.size, 3, 'size=3')
    eq(s.dimension, 2, '维度自动确定')
    const hits = s.search([1, 0.1], 2)
    eq(hits[0].id, 'a', '最相似的是 a')
    eq(hits.length, 2, 'topK=2')
    ok(hits[0].score > hits[1].score, '分数降序')
    // 覆盖同一 id 不应增加条数
    s.upsert('a', [0, 1], { text: 'A2' })
    eq(s.size, 3, '覆盖不新增')
    const hits2 = s.search([0, 1], 1)
    eq(hits2[0].id, 'a', '覆盖后向量生效')
    eq(hits2[0].meta.text, 'A2', '覆盖后 meta 生效')
  } finally { rm(dir) }
})

await test('持久化：save → 新实例 load 后结果一致', async () => {
  const dir = mkTmp()
  try {
    const s = new LocalVectorStore({ dir, signature: 'embed-v1' })
    s.upsert('x', [0.2, 0.4, 0.6], { docId: 'd1', idx: 0 })
    s.upsert('y', [0.6, 0.4, 0.2], { docId: 'd2', idx: 0 })
    s.save()
    ok(fs.existsSync(path.join(dir, 'vectors.bin')), '索引文件已生成')
    const s2 = new LocalVectorStore({ dir, signature: 'embed-v1' })
    s2.load()
    eq(s2.size, 2, '加载后 size=2')
    eq(s2.dimension, 3, '加载后维度=3')
    const hits = s2.search([0.2, 0.4, 0.6], 1)
    eq(hits[0].id, 'x', '加载后检索正确')
    eq(hits[0].meta, { docId: 'd1', idx: 0 }, 'meta 往返一致')
  } finally { rm(dir) }
})

await test('删除 / 压实 / 重新加载', async () => {
  const dir = mkTmp()
  try {
    const s = new LocalVectorStore({ dir })
    s.upsert('a', [1, 0])
    s.upsert('b', [0, 1])
    s.upsert('c', [1, 1])
    ok(s.remove('b'), '删除命中')
    eq(s.remove('b'), false, '重复删除返回 false')
    eq(s.size, 2, '删除后 size=2')
    eq(s.search([0, 1], 3).map((h) => h.id), ['c', 'a'], 'tombstone 不参与检索')
    s.save()
    const s2 = new LocalVectorStore({ dir })
    s2.load()
    eq(s2.size, 2, '压实后重新加载 size=2')
    eq(s2.search([0, 1], 3).map((h) => h.id), ['c', 'a'], '压实后检索一致')
  } finally { rm(dir) }
})

await test('filter / minScore / topK=0', async () => {
  const dir = mkTmp()
  try {
    const s = new LocalVectorStore({ dir })
    s.upsert('a', [1, 0], { scope: 'u1' })
    s.upsert('b', [0.9, 0.1], { scope: 'u2' })
    s.upsert('c', [0, 1], { scope: 'u1' })
    eq(s.search([1, 0], 10, { filter: (m) => m.scope === 'u1' }).map((h) => h.id), ['a', 'c'], '按 meta 过滤')
    ok(s.search([1, 0], 10, { minScore: 0.5 }).every((h) => h.score >= 0.5), 'minScore 过滤')
    eq(s.search([1, 0], 0), [], 'topK=0 返回空')
    eq(s.search([1, 0], 1).length, 1, 'topK=1')
  } finally { rm(dir) }
})

await test('维度 / 零向量 / 非法值明确报错', async () => {
  const dir = mkTmp()
  try {
    const s = new LocalVectorStore({ dir })
    s.upsert('a', [1, 0])
    eq(codeOf(() => s.upsert('b', [1, 0, 0])), 'dimension_mismatch', '写入维度不一致')
    eq(codeOf(() => s.search([1, 0, 0], 1)), 'dimension_mismatch', '查询维度不一致')
    eq(codeOf(() => s.upsert('z', [0, 0])), 'zero_vector', '零向量拒绝')
    eq(codeOf(() => s.upsert('n', [1, Number.NaN])), 'bad_vector', 'NaN 拒绝')
  } finally { rm(dir) }
})

await test('签名不匹配 / 损坏文件可被调用方识别', async () => {
  const dir = mkTmp()
  try {
    const s = new LocalVectorStore({ dir, signature: 'old' })
    s.upsert('a', [1, 0])
    s.save()
    const s2 = new LocalVectorStore({ dir, signature: 'new' })
    eq(codeOf(() => s2.load()), 'signature_mismatch', '签名不一致')
    fs.writeFileSync(path.join(dir, 'vectors.bin'), 'not-a-vector-file')
    const s3 = new LocalVectorStore({ dir })
    eq(codeOf(() => s3.load()), 'bad_file', '损坏文件')
  } finally { rm(dir) }
})

await test('dot metric 不做归一化；rebuild 全量替换', async () => {
  const dir = mkTmp()
  try {
    const s = new LocalVectorStore({ dir, metric: 'dot' })
    s.upsert('a', [1, 0])
    s.upsert('b', [2, 0])
    eq(s.search([1, 0], 1)[0].id, 'b', 'dot 分数按模长排序')
    s.rebuild([{ id: 'c', vector: [1, 1], meta: { k: 1 } }])
    eq(s.size, 1, 'rebuild 后只剩新条目')
    eq(s.search([1, 0], 1)[0].id, 'c', 'rebuild 检索正确')
    eq(s.stats().metric, 'dot', 'stats metric')
  } finally { rm(dir) }
})

await test('HNSW：增量更新 / 持久化 / 删除 / 参数生效', async () => {
  const dir = mkTmp()
  try {
    const s = new LocalVectorStore({
      dir, backend: 'hnsw',
      hnsw: { m: 12, efConstruction: 100, efSearch: 48, rerank: 4 },
    })
    s.upsert('a', [1, 0], { text: 'A' })
    s.upsert('b', [0, 1], { text: 'B' })
    s.upsert('c', [1, 1], { text: 'C' })
    s.upsert('a', [0, 1], { text: 'A2' })
    eq(s.stats().backend, 'hnsw', 'backend=hnsw')
    eq(s.stats().hnsw.efSearch, 48, 'efSearch 参数生效')
    eq(s.search([0, 1], 1)[0].id, 'a', 'HNSW 更新后精确重排命中 a')
    s.save()
    ok(fs.existsSync(path.join(dir, 'hnsw.bin')), 'HNSW 索引已落盘')
    ok(fs.existsSync(path.join(dir, 'hnsw.json')), 'HNSW 元数据已落盘')

    const s2 = new LocalVectorStore({
      dir, backend: 'hnsw',
      hnsw: { m: 12, efConstruction: 100, efSearch: 48, rerank: 4 },
    })
    s2.load()
    eq(s2.stats().backend, 'hnsw', '重启后加载 HNSW')
    eq(s2.search([0, 1], 1)[0].id, 'a', '重启后检索正确')
    s2.remove('a')
    s2.save()
    eq(s2.size, 2, '删除后 size=2')
    eq(s2.search([0, 1], 2).map((h) => h.id), ['b', 'c'], '删除后 tombstone 不返回')
  } finally { rm(dir) }
})

await test('HNSW：近似候选 + Flat 重排的召回质量', async () => {
  const dir = mkTmp()
  try {
    // 固定伪随机，避免测试抖动
    let seed = 42
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
    const dim = 24
    const n = 500
    const items = []
    for (let i = 0; i < n; i++) {
      const v = Array.from({ length: dim }, () => rand() - 0.5)
      items.push({ id: `v${i}`, vector: v, meta: { i } })
    }
    const flat = new LocalVectorStore({ dir: `${dir}/flat`, backend: 'flat' })
    flat.upsertMany(items)
    const hnsw = new LocalVectorStore({ dir: `${dir}/hnsw`, backend: 'hnsw', hnsw: { m: 16, efConstruction: 200, efSearch: 64, rerank: 4 } })
    hnsw.upsertMany(items)
    let hits = 0
    const queries = 20
    for (let q = 0; q < queries; q++) {
      const query = Array.from({ length: dim }, () => rand() - 0.5)
      const exact = flat.search(query, 5).map((h) => h.id)
      const approx = hnsw.search(query, 5).map((h) => h.id)
      hits += approx.filter((id) => exact.includes(id)).length
    }
    const recall = hits / (queries * 5)
    ok(recall >= 0.9, `top5 召回率 ${(recall * 100).toFixed(1)}% ≥ 90%`)
  } finally { rm(dir) }
})

await test('GPU 未授权：请求 cuvs 也不得启用', async () => {
  const dir = mkTmp()
  try {
    const s = new LocalVectorStore({ dir, backend: 'cuvs', gpuConsent: false })
    s.upsert('a', [1, 0])
    ok(s.stats().backend !== 'cuvs', '未授权时回退 CPU（HNSW/Flat）')
    ok(String(s.stats().backendReason || '').includes('授权'), '降级原因可读')
  } finally { rm(dir) }
})

console.log(`\n========================================`)
console.log(`LocalVectorStore 测试：通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
