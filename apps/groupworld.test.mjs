/**
 * apps/groupworld.js 离线自检 —— analysis.schedule 热加载（D19）：
 *  ① 自实现 5 字段 cron 匹配：`*` / 步长 / `a-b` 区间 / 逗号列表 / dom+dow 同时受限 OR；
 *  ② 默认仍等效 '7 * * * *'，非法配置回退默认；
 *  ③ 每分钟 cron 入口：命中且同一分钟未跑过才执行 hourlyTask（同分钟重复 tick 只跑一次）；
 *  ④ 改 analysis.schedule 后无需重启，下一次 tick 即按新 cron 判定。
 *
 * 运行：node apps/groupworld.test.mjs
 * 说明：apps 层依赖 Yunzai 插件基类与桩 Config（源码仓内不存在 ../../../lib），
 *       故子进程用 stress/e2e/hooks.mjs 装载桩后再 import 真实 apps/groupworld.js。
 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

console.log('\n[groupworld analysis.schedule 热加载（D19）]')

const root = path.join(import.meta.dirname, '..')
const appUrl = pathToFileURL(path.join(import.meta.dirname, 'groupworld.js')).href
const hooksUrl = pathToFileURL(path.join(root, 'stress', 'e2e', 'hooks.mjs')).href
const stubConfigUrl = pathToFileURL(path.join(root, 'stress', 'e2e', 'stubs', 'Config.js')).href

const child = `
import { GroupWorld, cronMatches, isValidCron, DEFAULT_ANALYSIS_SCHEDULE } from ${JSON.stringify(appUrl)}
import { __setConfig } from ${JSON.stringify(stubConfigUrl)}

const out = { matches: [], taskCron: null, defaultSchedule: DEFAULT_ANALYSIS_SCHEDULE, invalidFallsBack: null, ticks: {} }
const D = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi)
const cases = [
  ['7 * * * *', [2026, 10, 29, 10, 7], true, 'minute=7 命中'],
  ['7 * * * *', [2026, 10, 29, 10, 8], false, 'minute=8 不命中'],
  ['* * * * *', [2026, 10, 29, 0, 0], true, '全通配'],
  ['*/15 * * * *', [2026, 10, 29, 10, 45], true, '步长 15 → 45 命中'],
  ['*/15 * * * *', [2026, 10, 29, 10, 7], false, '步长 15 → 7 不命中'],
  ['5-10 * * * *', [2026, 10, 29, 10, 5], true, '区间端点 5'],
  ['5-10 * * * *', [2026, 10, 29, 10, 11], false, '区间外 11'],
  ['1,3,5-7,*/20 * * * *', [2026, 10, 29, 10, 6], true, '逗号列表命中区间 6'],
  ['1,3,5-7,*/20 * * * *', [2026, 10, 29, 10, 2], false, '逗号列表外 2'],
  ['1,3,5-7,*/20 * * * *', [2026, 10, 29, 10, 40], true, '逗号列表命中步长 40'],
  ['0 3 * * 1', [2026, 10, 26, 3, 0], true, '周一 3 点命中'],
  ['0 3 * * 1', [2026, 10, 27, 3, 0], false, '周二不命中'],
  ['0 0 * * 7', [2026, 10, 18, 0, 0], true, '周字段 7 视作周日'],
  ['0 0 1 * *', [2026, 10, 1, 0, 0], true, 'dom=1 命中'],
  ['0 0 1 * *', [2026, 10, 2, 0, 0], false, 'dom=2 不命中'],
  ['0 0 13 * 1', [2026, 10, 13, 0, 0], true, 'dom/dow 同时受限：dom 命中（OR）'],
  ['0 0 13 * 1', [2026, 10, 19, 0, 0], true, 'dom/dow 同时受限：dow 命中（OR）'],
  ['0 0 13 * 1', [2026, 10, 14, 0, 0], false, 'dom/dow 都未命中'],
  ['99 * * * *', [2026, 10, 29, 10, 7], false, '越界字段 → false'],
  ['abc * * * *', [2026, 10, 29, 10, 7], false, '非法字段 → false'],
  ['* * * *', [2026, 10, 29, 10, 7], false, '4 字段 → false'],
]
out.matches = cases.map(([expr, [y, mo, d, h, mi], expect, label]) => ({
  label, expect, got: cronMatches(expr, D(y, mo, d, h, mi)),
}))
out.valid = {
  ok7: isValidCron('7 * * * *'),
  okList: isValidCron('1,3,5-7,*/20 * * * *'),
  badOut: isValidCron('99 * * * *'),
  badFields: isValidCron('* * * *'),
}

// 构造插件（enabled=false 避免异步预热装配）；task 列表应固定每分钟触发
__setConfig({ agent: { groupWorld: { enabled: false, analysis: { schedule: '7 * * * *' } } } })
const g = new GroupWorld()
out.taskCron = g.task.find((t) => t.name === '群世界-小时分析')?.cron
// 非法配置 → _analysisSchedule 回退默认
__setConfig({ agent: { groupWorld: { enabled: false, analysis: { schedule: 'not-a-cron' } } } })
out.invalidFallsBack = g._analysisSchedule()

let runs = 0
g.hourlyTask = async () => { runs++ }
__setConfig({ agent: { groupWorld: { enabled: true, analysis: { schedule: '7 * * * *' } } } })
out.ticks.hit = await g._runHourlyIfDue(D(2026, 10, 29, 10, 7))
out.ticks.sameMinute = await g._runHourlyIfDue(D(2026, 10, 29, 10, 7))
out.ticks.runsAfterSameMinute = runs
out.ticks.miss = await g._runHourlyIfDue(D(2026, 10, 29, 10, 8))
out.ticks.runsAfterMiss = runs
// 热加载：改成 :08 后无需重启，同一判定分钟立即生效
__setConfig({ agent: { groupWorld: { enabled: true, analysis: { schedule: '8 * * * *' } } } })
out.ticks.hotReload = await g._runHourlyIfDue(D(2026, 10, 29, 10, 8))
out.ticks.runsAfterHotReload = runs
// enabled=false → 不执行
__setConfig({ agent: { groupWorld: { enabled: false, analysis: { schedule: '* * * * *' } } } })
out.ticks.disabled = await g._runHourlyIfDue(D(2026, 10, 29, 10, 9))
out.ticks.runsAfterDisabled = runs
process.stdout.write('__RESULT__' + JSON.stringify(out) + '\\n')
`

const r = spawnSync(process.execPath, ['--import', hooksUrl, '--input-type=module', '-e', child], {
  cwd: root, encoding: 'utf8', timeout: 60000,
  env: { ...process.env, E2E_TMP: path.join(root, 'temp', `gw-d19-${process.pid}`) },
})
const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'))

if (!line) {
  failed++
  console.error('  ✗ FAIL 子进程未回传结果', `status=${r.status}`, String(r.stderr || '').slice(-1200), String(r.stdout || '').slice(-600))
} else if (r.status !== 0) {
  failed++
  console.error('  ✗ FAIL 子进程非零退出', r.status, String(r.stderr || '').slice(-1200))
} else {
  const out = JSON.parse(line.slice('__RESULT__'.length))
  // ① cron 匹配
  for (const c of out.matches) ok(c.got === c.expect, `cronMatches：${c.label}`)
  ok(out.valid.ok7 && out.valid.okList, 'isValidCron：合法表达式通过')
  ok(!out.valid.badOut && !out.valid.badFields, 'isValidCron：越界/字段数不符拒绝')
  // ② 默认与回退
  ok(out.defaultSchedule === '7 * * * *', `默认 cron 等效每小时 :07（实际 ${out.defaultSchedule}）`)
  ok(out.taskCron === '* * * * *', `小时分析 task 固定每分钟触发以支持热加载（实际 ${out.taskCron}）`)
  ok(out.invalidFallsBack === '7 * * * *', `非法 analysis.schedule 回退默认（实际 ${out.invalidFallsBack}）`)
  // ③ 同分钟去重 / 非命中不跑
  ok(out.ticks.hit === true && out.ticks.runsAfterSameMinute === 1, '命中分钟执行一次')
  ok(out.ticks.sameMinute === false && out.ticks.runsAfterSameMinute === 1, '同一分钟重复 tick 不重复执行')
  ok(out.ticks.miss === false && out.ticks.runsAfterMiss === 1, '非命中分钟不执行')
  // ④ 热加载
  ok(out.ticks.hotReload === true && out.ticks.runsAfterHotReload === 2, '改 cron 后无需重启，下一次 tick 即生效')
  ok(out.ticks.disabled === false && out.ticks.runsAfterDisabled === 2, 'enabled=false 时不执行')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
