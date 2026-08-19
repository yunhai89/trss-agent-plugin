/**
 * devLog 解析与聚合（供 /api/logs、/api/overview 用）。
 *
 * devLog 文件（utils/DevLog.js）每事件写 JSON.stringify(obj, null, 2) + '\n'（缩进多行 JSON）。
 * 文件名：<gid>-<uid>-<convId>-<YYYYMMDDHHmmss>.log；私聊为 private-<uid>-<conv>-<ts>.log。
 * 事件体 { level, time(ISO), event, traceId, ...payload }；12 种 event。
 */
import fs from 'node:fs'
import path from 'node:path'
import { normalizeUsage } from '../agent/messages.js'

/**
 * 解析 devLog 文本（含多个缩进 JSON 对象）→ LogEvent[]。
 * 按顶层 {} 深度 + 字符串转义切分（借鉴 recall.js extractJsonArray 的扫描思路）。
 */
export function parseDevLog(text) {
  const events = []
  const s = String(text || '')
  let i = 0
  while (i < s.length) {
    const start = s.indexOf('{', i)
    if (start < 0) break
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    for (let j = start; j < s.length; j++) {
      const ch = s[j]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
      } else if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) { end = j; break } }
    }
    if (end < 0) break
    try { events.push(JSON.parse(s.slice(start, end + 1))) } catch { /* 跳过损坏对象 */ }
    i = end + 1
  }
  return events
}

// 文件名 = <groupId>-<userId>-<序号>-<YYYYMMDDHHmmss>.log。userId 不保证纯数字
// （生产实测存在 `private-unknown-0-...`：私聊监听态/无用户上下文的会话）——曾用 (\d+) 匹配
// 导致这类文件 ts=0：排序沉底 + 日期筛选恒 miss（筛「今天」提示无结果的根因）。
const FILE_RE = /^(.+?)-([^-]+)-(\d+)-(\d{14})\.log$/

function tsFromName(tsStr) {
  // YYYYMMDDHHmmss → ms
  const iso = `${tsStr.slice(0, 4)}-${tsStr.slice(4, 6)}-${tsStr.slice(6, 8)}T${tsStr.slice(8, 10)}:${tsStr.slice(10, 12)}:${tsStr.slice(12, 14)}`
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/** 列日志文件 → [{ file, label, ts }]，按 ts 倒序（不含 events，懒加载） */
export function listLogFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.log')) continue
    const m = name.match(FILE_RE)
    let label = name.replace(/\.log$/, '')
    let ts = 0
    if (m) {
      const [, gid, uid, , tsStr] = m
      ts = tsFromName(tsStr)
      const gidLabel = gid === 'private' ? '私聊' : `群${gid}`
      const dd = `${tsStr.slice(4, 6)}-${tsStr.slice(6, 8)} ${tsStr.slice(8, 10)}:${tsStr.slice(10, 12)}`
      label = `${gidLabel} · ${uid} · ${dd}`
    }
    out.push({ file: name, label, ts })
  }
  return out.sort((a, b) => b.ts - a.ts)
}

/** 读单文件 → LogEvent[]（防路径穿越：解析后路径必须在 dir 内） */
export function readLogFile(dir, file) {
  const fp = path.resolve(dir, file)
  if (!fp.startsWith(path.resolve(dir) + path.sep) && fp !== path.resolve(dir)) return []
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return []
  return parseDevLog(fs.readFileSync(fp, 'utf8'))
}

/** YYYY-MM-DD → ms（当天 00:00:00 本地）；endOfDay=true 则 23:59:59.999。非法返 null。 */
function parseDateDay(s, endOfDay = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${endOfDay ? '23:59:59.999' : '00:00:00'}`)
  return Number.isFinite(t) ? t : null
}

/**
 * 按条件查询会话日志文件（默认最新 limit 个；日期/时间/事件任意组合，留空即不过滤）。
 * - from/to：YYYY-MM-DD 日期范围（按文件名时间戳=会话开始时间）；
 * - event：只保留「含该事件类型」的文件（扫文件内容，如 error/tool/run_end）；
 * - q：关键词，模糊匹配文件内事件 JSON（可输入「3点」「报错」「工具名」等时间/内容片段）；
 * - limit：默认 10（仅截断 items，不影响 total）。
 * 返回 { items:[{file,label}], total }，total = 筛选后命中总数。
 */
export function queryLogFiles(dir, { from, to, event, q, limit = 10 } = {}) {
  let files = listLogFiles(dir) // 已按 ts 倒序（最新在前）
  const fromTs = parseDateDay(from, false)
  const toTs = parseDateDay(to, true)
  const ev = String(event || '').trim()
  const kw = String(q || '').trim().toLowerCase()
  // 日期筛选语义：文件名日期（会话创建日）**或任一事件时间**落入范围即命中。
  // 会话文件名日期=创建日，长对话持续数日（生产实测：13 号创建的会话活跃到 17 号）——
  // 只按文件名筛会把「今天聊过的会话」全部漏掉（曾筛当天恒提示无结果的根因之二）。
  if (fromTs != null || toTs != null || ev || kw) {
    files = files.filter((f) => {
      const nameHit = (fromTs == null || f.ts >= fromTs) && (toTs == null || f.ts <= toTs)
      if (nameHit && !ev && !kw) return true
      // 文件名不命中日期（或还有 event/q 条件）→ 扫事件内容
      const events = readLogFile(dir, f.file)
      if (!nameHit) {
        const tsOf = (t) => Date.parse(String(t || ''))
        const timeHit = events.some((e) => {
          const t = tsOf(e.time)
          return Number.isFinite(t) && (fromTs == null || t >= fromTs) && (toTs == null || t <= toTs)
        })
        if (!timeHit) return false
      }
      if (ev && !events.some((e) => e.event === ev)) return false
      if (kw && !JSON.stringify(events).toLowerCase().includes(kw)) return false
      return true
    })
  }
  const total = files.length
  const lim = Number.isFinite(+limit) && +limit > 0 ? Math.floor(+limit) : 10
  const items = files.slice(0, lim).map((f) => ({ file: f.file, label: f.label }))
  return { items, total }
}

/**
 * 聚合近 N 日 stats（供 /api/overview）：tokenTrend（按天 input/output）+ requestTrend（按天请求/对话轮次）
 * + toolTop（工具计数 TopK）+ 汇总（totalRequests/totalToolCalls/totalTokens）。
 * 仅扫文件名日期 >= since 的文件，避免全扫。
 */
export function aggregateStats(dir, { since = 0, topK = 5 } = {}) {
  const dayMap = {} // day → { input, output, cacheRead, cacheWrite, uncached, observedInput, requests, observedRequests }
  const toolMap = {}
  let totalRequests = 0
  let totalToolCalls = 0
  let totalTokens = 0
  // 缓存口径：**未观测 ≠ 0 命中**。旧链路日志无缓存字段，不能进命中率分母（曾把
  // 2400/3000 的真实命中率稀释成 2400/5000）。分层聚合：
  //   observedInput/observedRequests 只统计报告了缓存字段的请求；hitRequests = 其中 read>0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let observedInput = 0
  let observedOutput = 0 // 观测口径输出（缓存卡「输出 tokens」数据源：只统计报告了缓存字段的请求，
  // 与 observedInput 同分母——曾只有 trend 的全量 output，缓存卡前端拿不到观测口径输出而恒显 0）
  let observedRequests = 0
  let hitRequests = 0
  let unobservedRequests = 0
  let firstObservedAt = null
  // cold/warm 分层：同会话（=同日志文件）首个 run_end 是 cold start（缓存必然未热），
  // 与后续 warm 请求分开统计——warm 命中率才是缓存改造的真实效果
  let coldObserved = 0
  let warmObserved = 0
  let warmHit = 0
  const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))
  for (const f of listLogFiles(dir)) {
    if (f.ts < since) continue
    let firstRunEndInFile = true
    for (const e of readLogFile(dir, f.file)) {
      if (!e || !e.time) continue
      const day = String(e.time).slice(5, 10) // ISO → MM-DD
      if (e.event === 'run_end') {
        totalRequests++
        const isCold = firstRunEndInFile
        firstRunEndInFile = false
        ;(dayMap[day] ||= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, uncached: 0, observedInput: 0, cached: 0, requests: 0, observedRequests: 0 }).requests++
        if (e.usage) {
          // 统一走 normalizeUsage 跨协议归一（顶层已是 Agent 多轮累加值；旧日志从 raw 兜底）
          const n = normalizeUsage(e.usage)
          const din = n.input
          const dout = n.output
          if (din || dout) {
            dayMap[day].input += din
            dayMap[day].output += dout
            totalTokens += din + dout
          }
          if (n.cacheObserved) {
            observedRequests++
            if (isCold) coldObserved++
            else { warmObserved++; if (n.cacheRead > 0) warmHit++ }
            if (n.cacheRead > 0) hitRequests++
            if (din) { observedInput += din; dayMap[day].observedInput += din }
            if (dout) observedOutput += dout
            totalCacheRead += n.cacheRead
            totalCacheWrite += n.cacheWrite
            dayMap[day].cacheRead += n.cacheRead
            dayMap[day].cacheWrite += n.cacheWrite
            dayMap[day].uncached += n.uncached
            dayMap[day].cached += n.cacheRead
            const t = Date.parse(e.time)
            if (Number.isFinite(t) && (firstObservedAt == null || t < firstObservedAt)) firstObservedAt = t
          } else {
            unobservedRequests++
          }
        } else {
          unobservedRequests++
        }
      }
      if (e.event === 'tool' && e.name) {
        toolMap[e.name] = (toolMap[e.name] || 0) + 1
        totalToolCalls++
      }
    }
  }
  const days = Object.keys(dayMap).sort((a, b) => (a < b ? -1 : 1))
  const tokenTrend = days.map((day) => ({ day, input: dayMap[day].input, output: dayMap[day].output, cached: dayMap[day].cacheRead, cacheRead: dayMap[day].cacheRead, cacheWrite: dayMap[day].cacheWrite, uncached: dayMap[day].uncached, observedInput: dayMap[day].observedInput }))
  const requestTrend = days.map((day) => ({ day, count: dayMap[day].requests }))
  const toolTop = Object.entries(toolMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([name, count]) => ({ name, count }))
  return {
    tokenTrend, requestTrend, toolTop,
    totalRequests, totalToolCalls, totalTokens,
    totalCached: totalCacheRead, // 兼容别名
    totalCacheRead, totalCacheWrite, observedInput, observedOutput, observedRequests, hitRequests, unobservedRequests,
    tokenHitRate: observedInput > 0 ? clamp01(totalCacheRead / observedInput) : null,
    requestHitRate: observedRequests > 0 ? clamp01(hitRequests / observedRequests) : null,
    warmObserved, warmHit, coldObserved,
    warmRequestHitRate: warmObserved > 0 ? clamp01(warmHit / warmObserved) : null,
    firstObservedAt,
  }
}

/**
 * /api/overview 的 cache 载荷组装（纯函数，供 api.js 调用；测试可直接断言）。
 * 字段白名单在此单一维护——曾因 api.js 手写解构白名单漏掉 observedOutput，
 * 聚合层的输出 token 到达不了前端（缓存卡「输出 tokens」恒 0 的第二处接线断点）。
 * 新增字段必须同时对照 web/assets/js/views/dashboard.js 的 cacheStats computed。
 */
export function buildCachePayload(stats) {
  return {
    totalCacheRead: stats.totalCacheRead || 0,
    totalCacheWrite: stats.totalCacheWrite || 0,
    observedInput: stats.observedInput || 0,
    observedOutput: stats.observedOutput || 0,
    observedRequests: stats.observedRequests || 0,
    hitRequests: stats.hitRequests || 0,
    unobservedRequests: stats.unobservedRequests || 0,
    tokenHitRate: stats.tokenHitRate ?? null,
    requestHitRate: stats.requestHitRate ?? null,
    warmObserved: stats.warmObserved || 0,
    warmHit: stats.warmHit || 0,
    coldObserved: stats.coldObserved || 0,
    warmRequestHitRate: stats.warmRequestHitRate ?? null,
    firstObservedAt: stats.firstObservedAt ?? null,
  }
}
