/**
 * POST /api/cache/clear 离线自检（经真实 express router + 真实 UsageStats + 真实 DevLog 目录解析）：
 *   1) KV 日统计与 since 锚点全部删除，未落盘缓冲不得回写污染（clearAll 先丢缓冲再删键）；
 *   2) devLog 目录只删 *.log，其它文件与目录本身保留；
 *   3) 清空后 overview 不返回旧聚合（_overviewCache 必须失效，否则 60s 内「清了没变」）；
 *   4) 新对话（recordRun + flushNow）从零重新累计。
 * 运行：node model/web/api.clearcache.test.mjs
 */
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Config from '../../utils/Config.js'
import { buildApiRouter } from './api.js'
import { errorMiddleware } from './response.js'
import { createUsageStats, DAY_KEY_PREFIX, SINCE_KEY } from '../agent/store/usage-stats.js'
import { memoryKv } from '../agent/store/kv.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-clear-'))
const logDir = path.join(tmp, 'logs')
fs.mkdirSync(logDir, { recursive: true })
const writeLog = (name, body = '{}') => fs.writeFileSync(path.join(logDir, name), body + '\n')
writeLog('960179589-3891977697-1-20261017090000.log')
writeLog('private-unknown-0-20261017090100.log')
writeLog('dev-fallback.log')
fs.writeFileSync(path.join(logDir, 'compress.tar.gz'), 'not-a-log') // 非 .log 文件必须保留

// 日志目录 = agent.devLog.dir（绝对路径，与生产同一条 resolveDevLogDir 口径）
const cfg = Config.get()
if (!cfg.agent) cfg.agent = {}
cfg.agent.devLog = { enable: true, dir: logDir }

// 真实 UsageStats（memoryKv）+ 预置两天日统计与 since 锚点
const kv = memoryKv()
const usageStats = createUsageStats({ kv, flushIntervalMs: 0 })
const day = (offset) => {
  const d = new Date(); d.setDate(d.getDate() - offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
await kv.set(DAY_KEY_PREFIX + day(0), { date: day(0), chats: 3, inputTokens: 100, outputTokens: 20, cacheRead: 80, observedRequests: 3, observedInput: 100 })
await kv.set(DAY_KEY_PREFIX + day(1), { date: day(1), chats: 5, inputTokens: 200, outputTokens: 40, cacheRead: 150, observedRequests: 5, observedInput: 200 })
await kv.set(SINCE_KEY, { at: Date.now() - 86400e3 })

// overview 依赖的 runtime 最小形状（confirm/suggestionDir/kv；其余字段 overview 不读）
const runtimeProvider = async () => ({ usageStats, kv, confirm: { list: () => [] }, suggestionDir: tmp })
const app = express()
app.use(express.json())
app.use('/api', buildApiRouter({ runtimeProvider }))
app.use(errorMiddleware)
const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() } }
const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json() } }

await test('清空：KV 日统计 + since 锚点删除，devLog 只删 .log', async () => {
  // 先摸一次 overview（制造 _overviewCache，验证清空后必须失效）
  const before = await get('/api/overview')
  ok(before.body.code === 0, `overview 可用（${before.status}/${before.body.code}）`)

  const r = await post('/api/cache/clear')
  ok(r.status === 200 && r.body.code === 0, `清空成功（${r.status}/${r.body.code} ${r.body.msg || ''}）`)
  ok(r.body.data.kvRemoved === 2, `删掉 2 天日统计（实际 ${r.body.data.kvRemoved}）`)
  ok(r.body.data.logsRemoved === 3, `删掉 3 个 .log（实际 ${r.body.data.logsRemoved}）`)

  const keysAfter = await kv.scan(DAY_KEY_PREFIX)
  ok(keysAfter.length === 0, `日统计键清零（实际 ${keysAfter.length}）`)
  ok((await kv.get(SINCE_KEY)) == null, 'since 锚点删除（否则「部署后」窗口被旧锚点错切）')
  const left = fs.readdirSync(logDir)
  ok(left.length === 1 && left[0] === 'compress.tar.gz', `非 .log 文件保留（实际 ${JSON.stringify(left)}）`)
})

await test('清空：未落盘缓冲不得回写（先丢缓冲再删键）', async () => {
  // 造一笔未 flush 的采集 → 立刻清空：旧实现（先删键后丢缓冲）会在下一次 flush 把当日键写回
  usageStats.recordRun({ inputTokens: 9999, outputTokens: 999, cacheRead: 8888, cacheObserved: true, observedInput: 9999, turns: 1, model: 'test-model' })
  const r = await post('/api/cache/clear')
  ok(r.body.code === 0, `清空成功（${r.body.code}）`)
  const r2 = await post('/api/cache/clear')
  ok(r2.body.data.kvRemoved === 0, `再次清空为 0 天（缓冲已丢，无残留键；实际 ${r2.body.data.kvRemoved}）`)
})

await test('清空：overview 的 60s 聚合缓存失效（不返回旧命中率）', async () => {
  const after = await get('/api/overview')
  ok(after.body.code === 0, 'overview 可用')
  ok((after.body.data.totalTokens || 0) === 0, `totalTokens 归零（实际 ${after.body.data.totalTokens}）`)
  const c = after.body.data.cache || {}
  ok((c.totalCacheRead || 0) === 0 && (c.observedRequests || 0) === 0, '缓存载荷归零')
})

await test('清空后：新对话从零重新累计（flush → KV 当日键）', async () => {
  usageStats.recordRun({ inputTokens: 1000, outputTokens: 100, cacheRead: 600, cacheObserved: true, observedInput: 1000, turns: 2, model: 'test-model', chats: 1 })
  await usageStats.flushNow()
  const keys = await kv.scan(DAY_KEY_PREFIX)
  ok(keys.length === 1 && keys[0] === DAY_KEY_PREFIX + day(0), `清空后只建当日键（实际 ${JSON.stringify(keys)}）`)
  const cur = await kv.get(keys[0])
  ok(cur.inputTokens === 1000 && cur.cacheRead === 600 && cur.chats === 1, `当日累计 = 新采集值（输入 ${cur.inputTokens}/缓存读 ${cur.cacheRead}/会话 ${cur.chats}）`)
})

server.close()
console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
