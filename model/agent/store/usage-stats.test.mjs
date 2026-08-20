/**
 * 离线自检 —— KV 用量统计（采集/缓冲/flush 合并/趋势合并/成功率）。
 * 运行：node model/agent/store/usage-stats.test.mjs（memoryKv，无需 redis）
 *
 * 被测不变量：
 *  - 事件按本地时区日聚合成 JSON 写 KV（Redis 优先，Web 端不再读日志聚合趋势）；
 *  - flush 为 get→merge→set：多次 flush 累加不覆盖；flush 失败保留缓冲可重试；
 *  - 趋势合并按日切换（KV 首个有数据日前用日志、其后用 KV），同一天不双算；
 *  - 工具成功/失败与 AOP isErrorShape 同判定；rateOf 无样本返回 null（≠0%）。
 */
import { memoryKv } from './kv.js'
import {
  createUsageStats, localDayKey, mergeDay, rateOf, mergeTrend, summarizeKvDays, DAY_KEY_PREFIX,
} from './usage-stats.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { ok(a === b, `${m}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await test('localDayKey：本地时区 YYYY-MM-DD', async () => {
  eq(localDayKey(new Date(2026, 7, 20, 0, 30)), '2026-08-20', '本地凌晨 0:30 归当天（UTC 视角还是 19 号——正是日志路径的缺天根因）')
  eq(localDayKey(new Date(2026, 0, 2)), '2026-01-02', '补零')
})

await test('recordRun + recordToolResult → flush → KV JSON 结构', async () => {
  const kv = memoryKv()
  const st = createUsageStats({ kv, flushIntervalMs: 0 })
  st.recordRun({ inputTokens: 1000, outputTokens: 200, cacheRead: 800, cacheWrite: 100, cacheObserved: true, turns: 3, model: 'mimo-v2.5-pro' })
  st.recordRun({ inputTokens: 500, outputTokens: 50, turns: 1, model: 'mimo-v2.5-pro' })
  st.recordToolResult('web_search', { ok: true, results: [] })
  st.recordToolResult('web_search', '{"error":"超时"}')
  st.recordToolResult('terminal', { ok: false })
  await st.flushNow()
  const d = await kv.get(DAY_KEY_PREFIX + localDayKey())
  ok(!!d, '当日键存在')
  eq(d.chats, 2, 'chats=2')
  eq(d.turns, 4, 'turns 累加')
  eq(d.inputTokens, 1500, 'inputTokens 累加')
  eq(d.outputTokens, 250, 'outputTokens 累加')
  eq(d.cacheRead, 800, 'cacheRead')
  eq(d.observedRequests, 1, 'observedRequests 只计 cacheObserved 请求')
  eq(d.toolCalls, 3, 'toolCalls=3')
  eq(d.toolOk, 1, '成功 1（error 串与 ok:false 均为失败）')
  eq(d.toolFail, 2, '失败 2')
  eq(d.byTool.web_search.ok, 1, 'byTool.web_search.ok')
  eq(d.byTool.web_search.fail, 1, 'byTool.web_search.fail')
  eq(d.byModel['mimo-v2.5-pro'].input, 1500, 'byModel input')
  eq(d.byModel['mimo-v2.5-pro'].chats, 2, 'byModel chats')
  ok(typeof d.updatedAt === 'number' && d.updatedAt > 0, 'updatedAt')
  st.stop()
})

await test('错误终态：errors 计数且不计 chats', async () => {
  const kv = memoryKv()
  const st = createUsageStats({ kv, flushIntervalMs: 0 })
  st.recordRun({ error: true })
  await st.flushNow()
  const d = await kv.get(DAY_KEY_PREFIX + localDayKey())
  eq(d.errors, 1, 'errors=1')
  eq(d.chats, 0, '错误终态不计 chats')
  st.stop()
})

await test('多次 flush 累加（get→merge→set 不覆盖存量）', async () => {
  const kv = memoryKv()
  const st = createUsageStats({ kv, flushIntervalMs: 0 })
  st.recordRun({ inputTokens: 100, outputTokens: 10, turns: 1 })
  await st.flushNow()
  st.recordRun({ inputTokens: 50, outputTokens: 5, turns: 2 })
  st.recordToolResult('calc', { ok: true })
  await st.flushNow()
  const d = await kv.get(DAY_KEY_PREFIX + localDayKey())
  eq(d.chats, 2, '两次 flush 累计 chats=2')
  eq(d.inputTokens, 150, 'inputTokens=150（不覆盖）')
  eq(d.byTool.calc.ok, 1, '工具增量并入')
  st.stop()
})

await test('flush 失败保留缓冲，重试成功', async () => {
  const kv = memoryKv()
  let failOnce = true
  const flaky = {
    ...kv,
    async set(k, v, ttl) { if (failOnce && k.startsWith(DAY_KEY_PREFIX)) { failOnce = false; throw new Error('redis 闪断') } return kv.set(k, v, ttl) },
    get: (k) => kv.get(k),
  }
  const st = createUsageStats({ kv: flaky, flushIntervalMs: 0, logger: () => {} })
  st.recordRun({ inputTokens: 10, outputTokens: 1, turns: 1 })
  await st.flushNow()
  eq(await kv.get(DAY_KEY_PREFIX + localDayKey()), null, '失败轮未落 KV')
  await st.flushNow() // 缓冲保留，重试
  const d = await kv.get(DAY_KEY_PREFIX + localDayKey())
  eq(d?.chats, 1, '重试后落库（缓冲未丢）')
  st.stop()
})

await test('readDays：最近 N 天 + 缺失天补零骨架', async () => {
  const kv = memoryKv()
  const st = createUsageStats({ kv, flushIntervalMs: 0 })
  st.recordRun({ inputTokens: 7, outputTokens: 1, turns: 1 })
  await st.flushNow()
  const days = await st.readDays(3)
  eq(days.length, 3, '3 天')
  eq(days[2].inputTokens, 7, '今天是 recordRun 的值')
  eq(days[0].inputTokens, 0, '前天补零骨架')
  ok(days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)), '日期键格式连续')
  st.stop()
})

await test('自动去抖 flush（flushIntervalMs 生效）', async () => {
  const kv = memoryKv()
  const st = createUsageStats({ kv, flushIntervalMs: 30 })
  st.recordRun({ inputTokens: 3, outputTokens: 1, turns: 1 })
  eq(await kv.get(DAY_KEY_PREFIX + localDayKey()), null, '缓冲期内未落')
  await sleep(80)
  eq((await kv.get(DAY_KEY_PREFIX + localDayKey()))?.inputTokens, 3, '去抖到期自动落')
  st.stop()
})

await test('mergeTrend：KV 无数据 → 日志透传；有数据 → 按日切换无双算', async () => {
  const logTok = [{ day: '08-17', input: 100, output: 10 }, { day: '08-18', input: 200, output: 20 }, { day: '08-19', input: 50, output: 5 }]
  const logReq = [{ day: '08-17', count: 2 }, { day: '08-18', count: 3 }, { day: '08-19', count: 1 }]
  // KV 无数据（全空骨架）→ 全用日志
  const a = mergeTrend(logTok, logReq, [{ date: '2026-08-19', chats: 0, toolCalls: 0 }, { date: '2026-08-20', chats: 0, toolCalls: 0 }])
  eq(a.firstKvDay, null, '无 KV 数据 firstKvDay=null')
  eq(a.tokenTrend.length, 3, '日志趋势透传')
  // KV 从 19 号有数据 → 17/18 用日志、19 用 KV（日志的 19 号丢弃，不双算）
  const kvDays = [
    { date: '2026-08-19', chats: 2, toolCalls: 5, inputTokens: 60, outputTokens: 6, cacheRead: 40 },
    { date: '2026-08-20', chats: 1, toolCalls: 0, inputTokens: 30, outputTokens: 3, cacheRead: 0 },
  ]
  const b = mergeTrend(logTok, logReq, kvDays)
  eq(b.firstKvDay, '08-19', 'KV 首日=08-19')
  eq(b.tokenTrend.map((t) => t.day).join(','), '08-17,08-18,08-19,08-20', '四天连续')
  eq(b.tokenTrend.find((t) => t.day === '08-19').input, 60, '08-19 用 KV 值（非日志 50+KV 60 双算）')
  eq(b.tokenTrend.find((t) => t.day === '08-17').input, 100, '08-17 保留日志值')
  eq(b.requestTrend.find((t) => t.day === '08-19').count, 2, '请求趋势同切换')
  // 趋势含今天（本地日）——症状回归：不再因 UTC 缺「今天」
  eq(b.tokenTrend[b.tokenTrend.length - 1].day, localDayKey().slice(5), '最后一天=本地今天')
})

await test('summarizeKvDays：总量 + 工具成功率', async () => {
  const days = [
    { date: '2026-08-19', chats: 3, inputTokens: 100, outputTokens: 10, toolCalls: 4, toolOk: 3, toolFail: 1, byTool: { web_search: { ok: 2, fail: 1 }, calc: { ok: 1, fail: 0 } } },
    { date: '2026-08-20', chats: 2, inputTokens: 50, outputTokens: 5, toolCalls: 2, toolOk: 1, toolFail: 1, byTool: { web_search: { ok: 0, fail: 1 } } },
  ]
  const s = summarizeKvDays(days)
  eq(s.totalRequests, 5, 'totalRequests=5')
  eq(s.totalTokens, 165, 'totalTokens=155+10？(100+10+50+5=165)')
  eq(s.totalToolCalls, 6, 'totalToolCalls=6')
  eq(s.toolOk, 4, 'toolOk=4')
  eq(s.toolFail, 2, 'toolFail=2')
  eq(s.toolSuccessRate, 4 / 6, '成功率 4/6')
  eq(s.toolFailRate, 2 / 6, '失败率 2/6')
  eq(s.toolTop[0].name, 'web_search', '按次数排序')
  eq(s.toolTop[0].count, 4, 'web_search 总次')
  eq(s.toolTop[0].rate, 2 / 4, 'web_search 成功率 2/4')
})

await test('rateOf：无样本 null（不是 0%）', async () => {
  eq(rateOf(0, 0), null, '0 样本 → null')
  eq(rateOf(0, 10), 0, '全失败 → 0')
  eq(rateOf(10, 10), 1, '全成功 → 1')
  eq(rateOf(3, 4), 0.75, '3/4')
})

await test('mergeDay：入参不被修改（纯函数）', async () => {
  const a = { chats: 1, byTool: { x: { ok: 1, fail: 0 } }, byModel: {} }
  const b = { chats: 1, byTool: { x: { ok: 0, fail: 1 } }, byModel: {} }
  const m = mergeDay(a, b)
  eq(m.chats, 2, '合并正确')
  eq(a.chats, 1, '入参 a 未被修改')
  eq(a.byTool.x.fail, 0, '入参嵌套对象未被修改')
  eq(m.byTool.x.fail, 1, '合并嵌套值')
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed ? 1 : 0)
