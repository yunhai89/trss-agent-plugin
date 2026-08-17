/**
 * devLog 解析与聚合（供 /api/logs、/api/overview 用）。
 *
 * devLog 文件（utils/DevLog.js）每事件写 JSON.stringify(obj, null, 2) + '\n'（缩进多行 JSON）。
 * 文件名：<gid>-<uid>-<convId>-<YYYYMMDDHHmmss>.log；私聊为 private-<uid>-<conv>-<ts>.log。
 * 事件体 { level, time(ISO), event, traceId, ...payload }；12 种 event。
 */
import fs from 'node:fs'
import path from 'node:path'

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
  const dayMap = {} // day → { input, output, requests }
  const toolMap = {}
  let totalRequests = 0
  let totalToolCalls = 0
  let totalTokens = 0
  let totalCached = 0
  for (const f of listLogFiles(dir)) {
    if (f.ts < since) continue
    for (const e of readLogFile(dir, f.file)) {
      if (!e || !e.time) continue
      const day = String(e.time).slice(5, 10) // ISO → MM-DD
      if (e.event === 'run_end') {
        totalRequests++
        ;(dayMap[day] ||= { input: 0, output: 0, cached: 0, requests: 0 }).requests++
        if (e.usage) {
          // 顶层 input/output 是 Agent 多轮累加值（normalizeUsage 产物，比 raw 的末轮值准）；
          // raw 兜底兼容极旧日志（无顶层字段的 provider 直通 usage）
          const u = e.usage.raw || e.usage
          const din = e.usage.input ?? u.input ?? u.input_tokens ?? u.prompt_tokens ?? 0
          const dout = e.usage.output ?? u.output ?? u.output_tokens ?? u.completion_tokens ?? 0
          // 缓存命中：优先用 Agent 多轮累加的 usage.cached（normalizeUsage 已按
          // DeepSeek/OpenAI/Anthropic 三种字段归一）；旧日志无该字段时从 raw 提取末轮值兜底
          const dcache = e.usage.cached ?? u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0
          if (din || dout) {
            dayMap[day].input += din
            dayMap[day].output += dout
            dayMap[day].cached += dcache
            totalTokens += din + dout
            totalCached += dcache
          }
        }
      }
      if (e.event === 'tool' && e.name) {
        toolMap[e.name] = (toolMap[e.name] || 0) + 1
        totalToolCalls++
      }
    }
  }
  const days = Object.keys(dayMap).sort((a, b) => (a < b ? -1 : 1))
  const tokenTrend = days.map((day) => ({ day, input: dayMap[day].input, output: dayMap[day].output, cached: dayMap[day].cached }))
  const requestTrend = days.map((day) => ({ day, count: dayMap[day].requests }))
  const toolTop = Object.entries(toolMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([name, count]) => ({ name, count }))
  return { tokenTrend, requestTrend, toolTop, totalRequests, totalToolCalls, totalTokens, totalCached }
}
