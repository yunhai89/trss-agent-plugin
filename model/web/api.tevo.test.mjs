/**
 * Web router 真实入口自检（审计 P1-9 / P1-7）：
 * 经真实 express router 请求 metrics / health / approve / rollback / decommission，
 * 覆盖启用 / 关闭 / DB 失败 / 制品篡改拒绝。只桩运行时提供者与 tools，不复制路由逻辑。
 * 运行：node --import ./stress/e2e/hooks.mjs model/web/api.tevo.test.mjs
 */
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildApiRouter } from './api.js'
import { errorMiddleware } from './response.js'
import { initDb, closeDb, dao } from '../toolEvo/db.js'
import { ToolEvoRegistry } from '../toolEvo/registry.js'
import { makeManifest } from '../toolEvo/manifest.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wevtevo-'))
const artifactsDir = path.join(dir, 'tools')
await initDb({ dir })
const registry = new ToolEvoRegistry({ artifactsDir })
// 造一个高失败率 stable 版本 + 3 次失败调用（health 应命中）
await registry.createTool({ id: 'tool_h', name: 'health_demo', namespace: 'evolved' })
const hv = await registry.createVersion({ toolId: 'tool_h', semver: '0.1.0', manifest: makeManifest({ name: 'health_demo', version: '0.1.0', description: '健康检测示例工具', inputSchema: { type: 'object' } }), source: 'export async function run(){return{}}', tests: [] })
await registry.setStatus(hv.id, 'verified')
await registry.setStatus(hv.id, 'stable')
for (let i = 0; i < 3; i++) {
  await dao.run(`INSERT INTO tool_invocations(version_id,tool_name,success,latency_ms,error_class,created_at) VALUES(?,?,?,?,?,?)`,
    [hv.id, 'health_demo', 0, 10, 'timeout', Date.now()])
}

// 审批/回滚/淘汰用：一个 verified 版本 + 一个旧 stable 版本
await registry.createTool({ id: 'tool_ap', name: 'approve_demo', namespace: 'evolved' })
const ap1 = await registry.createVersion({ toolId: 'tool_ap', semver: '0.1.0', manifest: makeManifest({ name: 'approve_demo', version: '0.1.0', description: '审批示例工具一', inputSchema: { type: 'object' } }), source: 'export async function run(){return{v:1}}', tests: [] })
await registry.setStatus(ap1.id, 'verified'); await registry.setStatus(ap1.id, 'stable')
const ap2 = await registry.createVersion({ toolId: 'tool_ap', semver: '0.1.1', manifest: makeManifest({ name: 'approve_demo', version: '0.1.1', description: '审批示例工具二', inputSchema: { type: 'object' } }), source: 'export async function run(){return{v:2}}', tests: [], parentVersionId: ap1.id })
await registry.setStatus(ap2.id, 'verified')

const fakeTools = { register() {}, unregister() {} }
let toolEvoEnabled = true
const runtimeProvider = async () => ({ toolEvo: toolEvoEnabled ? { registry, runner: null } : null, tools: fakeTools })

const app = express()
app.use(express.json())
app.use('/api', buildApiRouter({ runtimeProvider }))
app.use(errorMiddleware)
const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() } }
const post = async (p) => { const r = await fetch(base + p, { method: 'POST' }); return { status: r.status, body: await r.json() } }

await test('启用：GET /api/tevo/metrics 走真实 router 返回收敛指标', async () => {
  const r = await get('/api/tevo/metrics')
  ok(r.status === 200 && r.body.code === 0, 'HTTP 200 / code 0')
  ok(r.body.data && typeof r.body.data.totalVersions === 'number', 'data 含 totalVersions')
  ok(r.body.data.totalVersions === 3, `统计到 3 个版本（实际 ${r.body.data?.totalVersions}）`)
})

await test('启用：GET /api/tevo/health 命中高失败率工具', async () => {
  const r = await get('/api/tevo/health')
  ok(r.status === 200 && r.body.code === 0, 'HTTP 200 / code 0')
  ok(Array.isArray(r.body.data) && r.body.data.some((c) => c.toolName === 'health_demo'), '聚类含 health_demo')
})

await test('POST approve：verified → stable 并切换 active', async () => {
  const r = await post(`/api/tevo/tools/${ap2.id}/approve`)
  ok(r.status === 200 && r.body.code === 0, `approve 成功（${r.status}/${r.body.code} ${r.body.msg || ''}）`)
  const tool = await registry.getById('tool_ap')
  ok(tool.active_version_id === ap2.id, 'active 切到新采纳版本')
})

await test('POST rollback：切回旧 stable 版本', async () => {
  const r = await post(`/api/tevo/tools/${ap1.id}/rollback`)
  ok(r.status === 200 && r.body.code === 0, 'rollback 成功')
  const tool = await registry.getById('tool_ap')
  ok(tool.active_version_id === ap1.id, 'active 回滚到旧版本')
})

await test('POST decommission：淘汰非 active 版本仅改状态', async () => {
  const r = await post(`/api/tevo/tools/${ap2.id}/decommission`)
  ok(r.status === 200 && r.body.code === 0, 'decommission 成功')
  const v = await registry.getVersion(ap2.id)
  ok(v.status === 'deprecated', '目标版本 deprecated')
})

await test('POST approve：制品被篡改 → 拒绝上线（保留 fail-closed）', async () => {
  await registry.createTool({ id: 'tool_tamper', name: 'tamper_demo', namespace: 'evolved' })
  const tv = await registry.createVersion({ toolId: 'tool_tamper', semver: '0.1.0', manifest: makeManifest({ name: 'tamper_demo', version: '0.1.0', description: '篡改示例工具', inputSchema: { type: 'object' } }), source: 'export async function run(){return{v:1}}', tests: [] })
  await registry.setStatus(tv.id, 'verified')
  fs.writeFileSync(path.join(artifactsDir, 'tamper_demo', '0.1.0', 'index.js'), 'export async function run(){return{v:999}}')
  const r = await post(`/api/tevo/tools/${tv.id}/approve`)
  ok(r.status === 500 && r.body.code === 5000, `篡改制品拒绝上线（${r.status}/${r.body.code}）`)
  const v = await registry.getVersion(tv.id)
  ok(v.status === 'verified', '状态未变为 stable（保留原 active）')
})

await test('关闭：registry 为空 → metrics 返回 null、health 返回 []', async () => {
  toolEvoEnabled = false
  const m = await get('/api/tevo/metrics')
  const h = await get('/api/tevo/health')
  ok(m.body.code === 0 && m.body.data === null, 'metrics 提前返回 null')
  ok(h.body.code === 0 && Array.isArray(h.body.data) && h.body.data.length === 0, 'health 提前返回 []')
})

await test('DB 失败：关闭数据库后请求 → 5000（不再 MODULE_NOT_FOUND）', async () => {
  toolEvoEnabled = true
  await closeDb()
  const r = await get('/api/tevo/metrics')
  ok(r.status === 500 && r.body.code === 5000, `DB 失败结构化 5000（实际 ${r.status}/${r.body.code}）`)
})

await new Promise((resolve) => server.close(resolve))
fs.rmSync(dir, { recursive: true, force: true })

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
