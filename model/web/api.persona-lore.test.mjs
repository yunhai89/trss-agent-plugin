/**
 * Web router 真实入口自检：人设资料库（PersonaLore）端点。
 * 经真实 express router 请求 /api/persona-lore 的 list / complete / adopt / refresh / discard，
 * 以及新的人设采纳审批队列 /api/persona-adoptions（提交→批准/驳回）。
 * 只桩运行时提供者（真实 PersonaLore + 真实 PersonaAdoptionQueue + 桩 completePersona），不复制路由逻辑。
 * 运行：node model/web/api.persona-lore.test.mjs
 */
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildApiRouter } from './api.js'
import { errorMiddleware } from './response.js'
import { PersonaLore } from '../persona/lore.js'
import { PersonaAdoptionQueue } from '../persona/adoptions.js'
import { memoryKv } from '../agent/store/kv.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wepersona-'))
const adoptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weadopt-'))
const personaLore = new PersonaLore({ dir, kv: memoryKv() })
const personaAdoptionQueue = new PersonaAdoptionQueue({ dir: adoptDir, personaLore })
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

const runtimeProvider = async () => ({ personaLore, personaStore, completePersona, personaAdoptionQueue })
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

await test('GET /api/persona-adoptions —— 初始为空数组', async () => {
  const r = await get('/api/persona-adoptions')
  ok(r.status === 200 && r.body.code === 0 && Array.isArray(r.body.data), 'HTTP 200 / code 0 / 数组')
  ok(r.body.data.length === 0, '初始无待审采纳')
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

await test('POST /api/persona-lore/:id/adopt —— 改为提交审批（不再直接生效）', async () => {
  const r = await post('/api/persona-lore/raiden-ei/adopt')
  ok(r.status === 200 && r.body.code === 0, '提交成功')
  ok(r.body.data?.item?.status === 'pending', '返回 pending 待审项')
  const lore = personaLore.get('raiden-ei')
  ok(lore?.status === 'draft', '未直接生效（仍为 draft）')
  const list = await get('/api/persona-adoptions')
  ok(list.body.data.length === 1 && list.body.data[0].personaId === 'raiden-ei', '待审列表含该人设')
})

await test('POST /api/persona-adoptions/:id/approve —— 批准后生效 + 长尾入库', async () => {
  const pending = (await get('/api/persona-adoptions')).body.data[0]
  const r = await post(`/api/persona-adoptions/${pending.id}/approve`)
  ok(r.status === 200 && r.body.code === 0, '批准成功')
  ok(r.body.data?.lore?.status === 'active', '状态 active')
  ok(!r.body.data?.ingestError, '长尾入库无错误')
  ok((await get('/api/persona-adoptions')).body.data.length === 0, '待审清空')
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
  // 提交待审草稿采纳 → 批准（不重复灌库，近似重复不误报）
  const sub = await post('/api/persona-lore/raiden-ei/adopt')
  ok(sub.status === 200 && sub.body.data?.item?.status === 'pending', '提交待审草稿')
  const a = await post(`/api/persona-adoptions/${sub.body.data.item.id}/approve`)
  ok(a.status === 200 && a.body.data?.lore?.status === 'active', '批准草稿成功')
  ok(!a.body.data?.ingestError, '重复 rawNotes 不误报入库错误')
  const final = (await get('/api/persona-lore')).body.data.find((l) => l.id === 'raiden-ei')
  ok(final && final.status === 'active' && !final.draft, '草稿已清、生效保留')
})

await test('POST /api/persona-adoptions/:id/reject —— 驳回保留草稿；可再次提交', async () => {
  const sub = await post('/api/persona-lore/raiden-ei/adopt') // 主文件已 active，无新草稿 → 报错
  ok(sub.body.code === 4004 || sub.body.code === 4001, `无新草稿提交报错（${sub.body.code}）`)
  // 造一份新草稿再走 提交→驳回→再提交→批准 全链路
  await post('/api/persona-lore/raiden-ei/complete')
  const s1 = await post('/api/persona-lore/raiden-ei/adopt')
  const rej = await post(`/api/persona-adoptions/${s1.body.data.item.id}/reject`, { reason: '不准确' })
  ok(rej.status === 200 && rej.body.data?.status === 'rejected', '驳回成功')
  ok(!!personaLore.getDraft('raiden-ei'), '驳回保留草稿')
  const s2 = await post('/api/persona-lore/raiden-ei/adopt')
  ok(s2.body.data?.item?.status === 'pending', '可再次提交待审')
  const ap = await post(`/api/persona-adoptions/${s2.body.data.item.id}/approve`)
  ok(ap.status === 200 && ap.body.data?.lore?.status === 'active', '再次批准生效')
})

await test('DELETE /api/persona-lore/:id —— 丢弃资料并撤销其待审采纳', async () => {
  await post('/api/persona-lore/raiden-ei/complete')
  await post('/api/persona-lore/raiden-ei/adopt')
  ok((await get('/api/persona-adoptions')).body.data.length === 1, '存在待审项')
  const r = await del('/api/persona-lore/raiden-ei')
  ok(r.status === 200 && r.body.code === 0 && r.body.data?.removed === true, '丢弃成功')
  ok((await get('/api/persona-adoptions')).body.data.length === 0, '待审项随丢弃撤销')
  const g = await get('/api/persona-lore')
  const item = g.body.data.find((l) => l.id === 'raiden-ei')
  ok(item && item.status === 'active' && !item.draft, '丢弃草稿后生效资料保留、草稿已清')
  ok((await del('/api/persona-lore/raiden-ei')).body.data?.removed === true, '再丢弃生效主资料')
  ok((await get('/api/persona-lore')).body.data.length === 0, '资料列表清空')
})

await new Promise((resolve) => server.close(resolve))
fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(adoptDir, { recursive: true, force: true })

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
