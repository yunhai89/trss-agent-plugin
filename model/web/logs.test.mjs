/**
 * model/web/logs.js 离线自检：文件名解析（含非数字 userId）+ 日期/事件/关键词筛选。
 * 运行：node model/web/logs.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listLogFiles, readLogFile, queryLogFiles } from './logs.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'weblogs-'))
const mk = (name, lines = []) => fs.writeFileSync(path.join(TMP, name), lines.join('\n'))
mk('960179589-3891977697-1-20260813004545.log')
mk('private-unknown-0-20260817073958.log') // ← 生产实测形态：userId 非数字（私聊监听态/无用户上下文）
mk('960179589-2154607285-1-20260815193839.log')

await test('listLogFiles：非数字 userId 的文件名正确解析出 ts/label（不再 ts=0 沉底）', async () => {
  const all = listLogFiles(TMP)
  eq(all.length, 3, '三个文件都列出')
  const unknown = all.find((f) => f.file.startsWith('private-unknown'))
  ok(unknown != null, 'private-unknown 文件在列表中')
  ok(unknown.ts > 0, `ts 解析非 0（实际 ${unknown.ts}；曾 (\d+) 不匹配 → ts=0）`)
  ok(unknown.label.includes('私聊') && unknown.label.includes('08-17'), `label 渲染（实际 ${unknown.label}）`)
  eq(all[0].file, 'private-unknown-0-20260817073958.log', '最新文件排第一（曾因 ts=0 沉底）')
})

await test('queryLogFiles：按日期筛选能命中含非数字 userId 的文件', async () => {
  const today = queryLogFiles(TMP, { from: '2026-08-17', to: '2026-08-17' })
  eq(today.total, 1, '筛 08-17 → 1 条')
  eq(today.items[0].file, 'private-unknown-0-20260817073958.log', '命中的正是 unknown 文件')
  eq(queryLogFiles(TMP, { from: '2026-08-15', to: '2026-08-15' }).total, 1, '筛 08-15 → 1 条')
  eq(queryLogFiles(TMP, { from: '2026-08-13', to: '2026-08-15' }).total, 2, '范围 13~15 → 2 条')
  eq(queryLogFiles(TMP, {}).total, 3, '不筛 → 全部')
})

await test('queryLogFiles：日期按事件时间命中（长会话跨天——今天聊过的会话可查）', async () => {
  // 13 号创建的会话、事件持续到 17 号：筛 17 号必须命中
  const day13 = new Date(Date.now() - 4 * 86400e3)
  fs.writeFileSync(path.join(TMP, '960179589-3891977697-1-' + fmt(day13) + '090000.log'),
    JSON.stringify({ level: 'info', time: day13.toISOString(), event: 'run_end', usage: { input: 100, output: 10 } }) + '\n'
    + JSON.stringify({ level: 'info', time: new Date().toISOString(), event: 'run_end', usage: { input: 200, output: 20 } }) + '\n')
  const todayStr = new Date().toISOString().slice(0, 10)
  const hit = queryLogFiles(TMP, { from: todayStr, to: todayStr })
  ok(hit.items.some((x) => x.file.startsWith('960179589-3891977697-1-')), `筛今天 → 命中跨天长会话（实际 ${hit.total}）`)
  const old = queryLogFiles(TMP, { from: '2020-01-01', to: '2020-01-02' })
  ok(old.total === 0, '范围外（文件名与事件都不在）→ 0')
})

await test('aggregateStats：缓存命中 token 按日聚合（DeepSeek/OpenAI/Anthropic 三种字段）', async () => {
  const { aggregateStats } = await import('./logs.js')
  const day = new Date(); day.setDate(day.getDate() - 1)
  const iso = day.toISOString()
  const mkRun = (usage) => JSON.stringify({ level: 'info', time: iso, event: 'run_end', usage }) + '\n'
  // 新链路：Agent 多轮累加的 usage.cached（normalizeUsage 归一后）
  fs.writeFileSync(path.join(TMP, '960179589-3891977697-1-' + fmt(day) + '090000.log'), mkRun({ input: 5000, output: 300, cached: 3200, raw: { prompt_tokens: 2000, completion_tokens: 300 } }))
  // 旧日志兜底：DeepSeek prompt_cache_hit_tokens / OpenAI cached_tokens / Anthropic cache_read
  fs.writeFileSync(path.join(TMP, '960179589-2721779039-1-' + fmt(day) + '100000.log'),
    mkRun({ input: 1000, output: 100, raw: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 } })
    + mkRun({ input: 600, output: 60, raw: { prompt_tokens: 600, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 400 } } })
    + mkRun({ input: 900, output: 90, raw: { input_tokens: 900, output_tokens: 90, cache_read_input_tokens: 700 } }))
  const r = aggregateStats(TMP, {})
  const t = r.tokenTrend.find((x) => x.day === iso.slice(5, 10))
  ok(t != null && t.cached === 3200 + 800 + 400 + 700, `cached 按日聚合且三种协议字段都归一（实际 ${t && t.cached}）`)
  ok(r.totalCached === 5100, `totalCached（实际 ${r.totalCached}）`)
  ok(t.input === 5000 + 1000 + 600 + 900 && t.output === 300 + 100 + 60 + 90, 'input/output 取多轮累加值（顶层级，不再低估多轮 run）')
})

await test('readLogFile：路径穿越防护', async () => {
  eq(readLogFile(TMP, '../' + path.basename(TMP) + '/x.log'), [], '拒绝目录穿越')
  eq(readLogFile(TMP, 'not-exist.log'), [], '不存在返回空')
})


function fmt(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}）`}`) }

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
fs.rmSync(TMP, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
