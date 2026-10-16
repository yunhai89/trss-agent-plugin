#!/usr/bin/env node
/**
 * 多轮对话前缀缓存命中率报告（针对「面板 Token 缓存 · 命中率」口径）
 *
 * 口径：tokenHitRate = ΣcacheRead / ΣobservedInput（只统计报告了缓存字段的请求）。
 * 与面板一致——冷启动（每个会话首个 run_end）必然未热，也计入分母，不剔除。
 *
 * 用法：
 *   node scripts/cache-hit-report.mjs [--dir <日志目录>] [--since "2026-10-16 21:00"] [--top 8] [--target 0.95] [--json]
 *
 * 归属分类（turn 级，用于回答「miss 花在哪」）：
 *   break:<原因>          带 cacheBreakReason 的轮（前缀被打断，如工具目录变化）
 *   COMPACTED(epoch++)    压缩改写历史前缀后的轮
 *   after cache_compact   压缩事件之后、首个未标 break 的轮
 *   cold(first in file)   会话首个观测轮
 *   turn:纯新增内容       正常增长（用户消息 + 工具结果 + 回复，属不可消除部分）
 *   turn:prompt 未增长    prompt 未变却未命中（异常，值得排查）
 */
import fs from 'node:fs'
import path from 'node:path'
import { listLogFiles, readLogFile, aggregateStats } from '../model/web/logs.js'
import { normalizeUsage } from '../model/agent/messages.js'

function parseArgs(argv) {
  const out = { dir: null, since: 0, top: 8, target: 0.95, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') out.dir = argv[++i]
    else if (a === '--since') out.since = Date.parse(String(argv[++i]).replace(' ', 'T'))
    else if (a === '--top') out.top = Number(argv[++i]) || 8
    else if (a === '--target') out.target = Number(argv[++i]) || 0.95
    else if (a === '--json') out.json = true
  }
  if (out.since && !Number.isFinite(out.since)) out.since = 0
  return out
}

async function defaultDir() {
  try {
    const { default: Config } = await import('../utils/Config.js')
    return path.join(Config.path?.data || path.resolve('data'), 'logs')
  } catch {
    return path.resolve('data/logs')
  }
}

const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(2)}%`)
const num = (v) => Number(v || 0).toLocaleString('en-US')

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dir = args.dir || (await defaultDir())
  const agg = aggregateStats(dir, { since: args.since, topK: 5 })

  // turn 级归属（与 aggregateStats 同一窗口）
  const groups = new Map() // 原因 → {n, input, cached}
  const convs = new Map() // 会话文件 → {runs, input, cached}
  const bump = (m, k, input, cached) => {
    const g = m.get(k) || { n: 0, input: 0, cached: 0 }
    g.n++
    g.input += input
    g.cached += cached
    m.set(k, g)
  }
  for (const f of listLogFiles(dir)) {
    if (args.since > 0) {
      let mtime = 0
      try { mtime = fs.statSync(path.resolve(dir, f.file)).mtimeMs } catch { mtime = f.ts }
      if (mtime && mtime < args.since) continue
    }
    const evs = readLogFile(dir, f.file)
    const conv = convs.get(f.file) || { runs: 0, input: 0, cached: 0 }
    let prev = null
    let compactionSince = false
    for (const e of evs) {
      if (!e || !e.time) continue
      const et = Date.parse(e.time)
      if (args.since > 0 && Number.isFinite(et) && et < args.since) continue
      if (e.event === 'cache_compact') { compactionSince = true; continue }
      if (e.event === 'run_end' && e.usage) {
        const n = normalizeUsage(e.usage)
        if (n.cacheObserved) {
          conv.runs++
          conv.input += n.observedInput || 0
          conv.cached += n.cacheRead || 0
        }
      }
      if (e.event !== 'turn' || !e.usage) continue
      const n = normalizeUsage(e.usage)
      if (!n.cacheObserved) { prev = { input: n.observedInput || n.input || 0, epoch: e.cacheEpoch }; continue }
      const cur = { input: n.observedInput || n.input || 0, cached: n.cacheRead || 0 }
      const epochChanged = prev && e.cacheEpoch != null && prev.epoch != null && e.cacheEpoch !== prev.epoch
      let k
      if (e.cacheBreakReason) k = `break:${e.cacheBreakReason}`
      else if (!prev) k = 'cold(first in file)'
      else if (epochChanged) k = 'COMPACTED(epoch++)'
      else if (compactionSince) k = 'after cache_compact'
      else if (cur.input <= prev.input) k = 'turn:prompt 未增长'
      else k = 'turn:纯新增内容'
      bump(groups, k, cur.input, cur.cached)
      prev = { input: cur.input, epoch: e.cacheEpoch }
      compactionSince = false
    }
    convs.set(f.file, conv)
  }

  let tn = 0, ti = 0, tc = 0
  for (const g of groups.values()) { tn += g.n; ti += g.input; tc += g.cached }

  const rate = agg.tokenHitRate
  const ok = rate != null && rate >= args.target
  if (args.json) {
    console.log(JSON.stringify({
      dir, since: args.since || null,
      runs: agg.observedRequests, input: agg.observedInput, cached: agg.totalCacheRead,
      tokenHitRate: rate, requestHitRate: agg.requestHitRate, warmRequestHitRate: agg.warmRequestHitRate,
      cold: agg.coldObserved, warm: agg.warmObserved, target: args.target, meetTarget: ok,
      turns: tn, turnInput: ti, turnCached: tc,
      attribution: [...groups.entries()].map(([cause, g]) => ({ cause, ...g, miss: g.input - g.cached })),
      conversations: [...convs.entries()].map(([file, c]) => ({ file, ...c })).sort((a, b) => b.input - a.input),
    }, null, 2))
    return
  }

  console.log(`多轮对话缓存命中率报告`)
  console.log(`日志目录：${dir}${args.since ? `（窗口起点 ${new Date(args.since).toLocaleString('zh-CN')}）` : ''}`)
  console.log('')
  console.log(`【面板口径 · run_end 级】`)
  console.log(`  观测请求 ${num(agg.observedRequests)}（cold ${agg.coldObserved} / warm ${agg.warmObserved}）· 未观测 ${num(agg.unobservedRequests)}`)
  console.log(`  输入 ${num(agg.observedInput)} tok · 缓存读取 ${num(agg.totalCacheRead)} tok · 缓存写入 ${num(agg.totalCacheWrite)} tok`)
  console.log(`  Token 命中率 = ${pct(rate)}   请求命中率 = ${pct(agg.requestHitRate)}   warm 请求命中率 = ${pct(agg.warmRequestHitRate)}`)
  console.log(`  目标 ≥${pct(args.target)}：${ok ? '✅ 达标' : '❌ 未达标'}${rate == null ? '（窗口内无观测数据）' : `（差 ${((args.target - rate) * 100).toFixed(2)} 个百分点）`}`)
  console.log('')
  console.log(`【turn 级 miss 归属】n=${tn} input=${num(ti)} 命中=${pct(ti ? tc / ti : null)}（不含收尾/评判等非 turn 调用）`)
  const rows = [...groups.entries()].sort((a, b) => (b[1].input - b[1].cached) - (a[1].input - a[1].cached))
  const totalMiss = ti - tc
  for (const [cause, g] of rows) {
    const miss = g.input - g.cached
    console.log(`  ${cause.padEnd(24)} n=${String(g.n).padStart(4)} input=${num(g.input).padStart(11)} 命中=${pct(g.input ? g.cached / g.input : null).padStart(7)} miss=${num(miss).padStart(10)} 占总 miss ${totalMiss ? ((miss / totalMiss) * 100).toFixed(1).padStart(5) : '  0.0'}%`)
  }
  console.log('')
  console.log(`【按会话（Top ${args.top}）】`)
  const top = [...convs.entries()].map(([file, c]) => ({ file, ...c })).sort((a, b) => b.input - a.input).slice(0, args.top)
  for (const c of top) {
    console.log(`  ${c.file.slice(0, 46).padEnd(48)} runs=${String(c.runs).padStart(3)} input=${num(c.input).padStart(10)} 命中=${pct(c.input ? c.cached / c.input : null)}`)
  }
  console.log('')
  console.log('提示：miss 中「纯新增内容」是每轮真正新增的 token（用户消息 + 工具结果 + 回复），无法靠缓存消除；')
  console.log('      break:*/COMPACTED 属于前缀被打断，可通过「工具目录静态化」「收尾/评判调用与主请求同形」「放大 contextWindow」消除。')
}

await main()
