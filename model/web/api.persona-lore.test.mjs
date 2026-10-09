/**
 * Web router 真实入口自检：人设资料库（PersonaLore）端点。
 * 经真实 express router 请求 /api/persona-lore 的 list / complete / adopt / refresh / discard，
 * 只桩运行时提供者（真实 PersonaLore + 桩 completePersona），不复制路由逻辑。
 * 运行：node model/web/api.persona-lore.test.mjs
 */
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildApiRouter } from './api.js'
import { errorMiddleware } from './response.js'
import { PersonaLore } from '../persona/lore.js'
import { memoryKv } from '../agent/store/kv.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wepersona-'))
const personaLore = new PersonaLore({ dir, kv: memoryKv() })
const fakeScheduler = () => {
  const jobs = new Map(); let seq = 0
  return { scheduleJob(cron, fn) { const id = `j${++seq}`; jobs.set(id, { cron, fn }); return id }, cancelJob(id) { jobs.delete(id) }, jobs }
}
const sched = fakeScheduler()
personaLore.attachScheduler(sched)
personaLore.setRefreshHandler(() => Promise.resolve())

const personas = { 'raiden-ei': { id: 'raiden-ei', name: '雷电将军' } }
const personaStore = { get: (id) => personas[id] || null }
// 桩 completePersona：模拟真实补齐产出草稿；记录收到的 ctx 以断言端点透传主任务 ctx
let lastCompleteCtx = null
const completePersona = async (id, { by, ctx } = {}) => {
  const p = personaStore.get(id)
  if (!p) return { error: `未找到人设「${id}」` }
  lastCompleteCtx = ctx
  const lore = personaLore.saveDraft(id, { summary: '稻妻雷神', facts: '- 挡下无想一刀的是枫原万叶', rawNotes: '枫原万叶用亡友的神之眼挡下无想的一刀。', sources: [{ type: 'miyoushe', ref: '123', title: '考据' }], canonical: { ip: '原神', game: '原神' }, by })
  return { persona: p, lore, taskId: 'task-test-1' }
}

const runtimeProvider = async () => ({ personaLore, personaStore, completePersona })
const app = express()
app.use(express.json())
app.use('/api', buildApiRouter({ runtimeProvider }))
app.use(errorMiddleware)
const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() } }
const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json() } }
const del = async (p) => { const r = await fetch(base + p, { method: 'DELETE' }); return { status: r.status, body: await r.json() } }

await test('GET /api/persona-lore —— 初始为空数组', async () => {
  const r = await get('/api/persona-lore')
  ok(r.status === 200 && r.body.code === 0 && Array.isArray(r.body.data), 'HTTP 200 / code 0 / 数组')
  ok(r.body.data.length === 0, '初始无资料')
})

await test('POST /api/persona-lore/:id/complete —— 补齐产出草稿', async () => {
  const r = await post('/api/persona-lore/raiden-ei/complete')
  ok(r.status === 200 && r.body.code === 0, `补齐成功（${r.status}/${r.body.code} ${r.body.msg || ''}）`)
  ok(r.body.data?.status === 'draft', '返回草稿')
  ok(r.body.data?.taskId === 'task-test-1', '返回 taskId（可并入主任务账本管理）')
  ok(lastCompleteCtx && lastCompleteCtx.conversationId === 'persona-complete', '端点透传主任务 ctx')
  const g = await get('/api/persona-lore')
  ok(g.body.data.some((l) => l.id === 'raiden-ei' && l.status === 'draft'), '列表含草稿')
})

await test('POST /api/persona-lore/:id/complete —— 未知人设 4001', async () => {
  const r = await post('/api/persona-lore/nope/complete')
  ok(r.status === 400 && r.body.code === 4001, `未知人设 4001（实际 ${r.status}/${r.body.code}）`)
})

await test('POST /api/persona-lore/:id/adopt —— 草稿转生效 + 长尾入库', async () => {
  const r = await post('/api/persona-lore/raiden-ei/adopt')
  ok(r.status === 200 && r.body.code === 0, '采纳成功')
  ok(r.body.data?.lore?.status === 'active', '状态 active')
  ok(!r.body.data?.ingestError, '长尾入库无错误')
  const hits = await personaLore.retrieve('raiden-ei', '谁挡下了无想的一刀', 3)
  ok(hits.some((h) => h.text.includes('枫原万叶')), '长尾库可检索到事实')
})

await test('POST /api/persona-lore/:id/adopt —— 无资料 4004', async () => {
  const r = await post('/api/persona-lore/ghost/adopt')
  ok(r.status === 404 && r.body.code === 4004, `无资料 4004（实际 ${r.status}/${r.body.code}）`)
})

await test('POST/DELETE /api/persona-lore/:id/refresh —— 定时刷新注册与取消', async () => {
  const r = await post('/api/persona-lore/raiden-ei/refresh', { cron: '0 8 * * *' })
  ok(r.status === 200 && r.body.code === 0 && r.body.data?.cron === '0 8 * * *', '设定时刷新')
  ok(sched.jobs.size === 1, '注册了 job')
  const d = await del('/api/persona-lore/raiden-ei/refresh')
  ok(d.status === 200 && d.body.code === 0, '取消定时刷新')
  ok(sched.jobs.size === 0, 'job 已清除')
})

await test('POST /complete（已有生效资料）→ 生效保留 + 待审草稿合并', async () => {
  const before = (await get('/api/persona-lore')).body.data.find((l) => l.id === 'raiden-ei')
  ok(before && before.status === 'active', '前置：已生效')
  const r = await post('/api/persona-lore/raiden-ei/complete')
  ok(r.status === 200 && r.body.code === 0 && r.body.data?.status === 'draft', '补齐产出草稿')
  const after = (await get('/api/persona-lore')).body.data.find((l) => l.id === 'raiden-ei')
  ok(after && after.status === 'active', '生效资料未被 re-补齐降级')
  ok(after && after.draft && after.draft.status === 'draft', 'list 合并出待审草稿 .draft')
  // 采纳待审草稿：不重复灌库（近似重复不报错）
  const a = await post('/api/persona-lore/raiden-ei/adopt')
  ok(a.status === 200 && a.body.data?.lore?.status === 'active', '采纳草稿成功')
  ok(!a.body.data?.ingestError, '重复 rawNotes 不误报入库错误')
  const final = (await get('/api/persona-lore')).body.data.find((l) => l.id === 'raiden-ei')
  ok(final && final.status === 'active' && !final.draft, '草稿已清、生效保留')
})

await test('DELETE /api/persona-lore/:id —— 丢弃资料', async () => {
  const r = await del('/api/persona-lore/raiden-ei')
  ok(r.status === 200 && r.body.code === 0 && r.body.data?.removed === true, '丢弃成功')
  const g = await get('/api/persona-lore')
  ok(g.body.data.length === 0, '列表清空')
})

await new Promise((resolve) => server.close(resolve))
fs.rmSync(dir, { recursive: true, force: true })

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
