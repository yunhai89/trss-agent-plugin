/**
 * UsageStats —— 对话/工具用量统计采集器（Redis 优先，替代 Web 端读日志聚合的不稳定路径）。
 *
 * 写路径：recordRun（对话完成，含 usage/turns/终态）与 recordToolResult（工具调用完成，成功/失败）
 *   先入进程内缓冲，2s 去抖批量 flush 到 KV（redisKv 走 Yunzai globalThis.redis；无 redis 降级 memoryKv，
 *   重启丢当日——统计可容忍）。沿用 toolEvo 埋点"2s 批量落盘"先例，避免逐调用写 Redis 的读改写竞态与写放大。
 *   flush 为 get→merge→set：单进程事件循环内串行（_flushing 防重入），跨日不会错位——dayKey 在事件时刻确定。
 *   TTL：每键 keepDays 天滚动续期，过期自动清理（默认 90 天窗口）。
 *
 * 日期键：本地时区 YYYY-MM-DD（devLog 趋势用 UTC ISO slice(5,10) 导致"今天"在本地 0~8 点被归到
 * UTC 昨天——Web 端 17/18/19 号时有时无的根因；本模块统一本地日期，与看板语境一致）。
 *
 * 读路径：readDays(n) 合并最近 n 天；api.js 的 overview 用 mergeTrend 与日志聚合（历史过渡）按日切换——
 *   日志侧只贡献 KV 首日之前的天（KV 首日起完整），同一天不会双算。
 */
import { isErrorShape } from '../tools/registry.js'

export const DAY_KEY_PREFIX = 'agents:stats:day:'
export const SINCE_KEY = 'agents:stats:since'

/** 本地时区日期键 YYYY-MM-DD */
export function localDayKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function emptyDay(date) {
  return {
    date, updatedAt: 0,
    chats: 0, turns: 0, errors: 0,
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheRead: 0, cacheWrite: 0, observedRequests: 0,
    toolCalls: 0, toolOk: 0, toolFail: 0,
    byTool: {},   // name -> { ok, fail }
    byModel: {},  // model -> { input, output, chats }
  }
}

/** 增量并入目标日（纯函数：不修改入参） */
export function mergeDay(dst, inc) {
  const out = { ...dst, byTool: { ...(dst.byTool || {}) }, byModel: { ...(dst.byModel || {}) } }
  for (const k of ['chats', 'turns', 'errors', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheRead', 'cacheWrite', 'observedRequests', 'toolCalls', 'toolOk', 'toolFail']) {
    out[k] = (out[k] || 0) + (Number(inc?.[k]) || 0)
  }
  for (const [name, t] of Object.entries(inc?.byTool || {})) {
    const cur = out.byTool[name] || { ok: 0, fail: 0 }
    out.byTool[name] = { ok: cur.ok + (Number(t.ok) || 0), fail: cur.fail + (Number(t.fail) || 0) }
  }
  for (const [model, m] of Object.entries(inc?.byModel || {})) {
    const cur = out.byModel[model] || { input: 0, output: 0, chats: 0 }
    out.byModel[model] = {
      input: cur.input + (Number(m.input) || 0),
      output: cur.output + (Number(m.output) || 0),
      chats: cur.chats + (Number(m.chats) || 0),
    }
  }
  out.updatedAt = Math.max(out.updatedAt || 0, inc?.updatedAt || 0)
  return out
}

/** 成功率：null = 无样本（前端显示「暂无」而非 0%） */
export function rateOf(ok, total) {
  const t = Number(total) || 0
  return t > 0 ? Math.max(0, Math.min(1, (Number(ok) || 0) / t)) : null
}

/**
 * @param {object} deps { kv, logger?, flushIntervalMs?=2000, keepDays?=90, now?() }
 */
export function createUsageStats({ kv, logger = () => {}, flushIntervalMs = 2000, keepDays = 90, now = () => new Date() } = {}) {
  if (!kv) throw new Error('createUsageStats 需要 kv 实例')
  const buffer = new Map() // dayKey -> day（未 flush 增量）
  let timer = null
  let flushing = false
  let stopped = false
  const stats = { recorded: 0, flushed: 0, lastFlushAt: 0 }

  const dayOf = (d) => localDayKey(d)

  const bump = (fn) => {
    if (stopped) return
    try { fn() } catch (e) { logger('warn', '[usage-stats] 采集异常', e?.message || e) }
    stats.recorded++
    if (!timer && flushIntervalMs > 0) {
      timer = setTimeout(() => { timer = null; flushNow().catch(() => {}) }, flushIntervalMs)
      timer.unref?.()
    }
  }

  /** 对话 run 完成（成功/失败/取消共用；字段尽力而为） */
  function recordRun({ inputTokens = 0, outputTokens = 0, reasoningTokens = 0, cacheRead = 0, cacheWrite = 0, cacheObserved = false, turns = 0, model = '', error = false, chats = 1 } = {}) {
    bump(() => {
      const key = dayOf(now())
      const d = buffer.get(key) || emptyDay(key)
      const inc = {
        chats: chats && !error ? 1 : 0, turns: Number(turns) || 0, errors: error ? 1 : 0,
        inputTokens: Number(inputTokens) || 0, outputTokens: Number(outputTokens) || 0, reasoningTokens: Number(reasoningTokens) || 0,
        cacheRead: Number(cacheRead) || 0, cacheWrite: Number(cacheWrite) || 0, observedRequests: cacheObserved ? 1 : 0,
        byModel: model ? { [model]: { input: Number(inputTokens) || 0, output: Number(outputTokens) || 0, chats: error ? 0 : 1 } } : {},
      }
      buffer.set(key, mergeDay(d, inc))
    })
  }

  /** 工具调用完成（content 为 Agent onToolEnd 收到的结果串/对象；与 AOP isErrorShape 同判定语义） */
  function recordToolResult(name, content) {
    const n = String(name || '').trim()
    if (!n) return
    bump(() => {
      const ok = !isErrorShape(content)
      const key = dayOf(now())
      const d = buffer.get(key) || emptyDay(key)
      const inc = { toolCalls: 1, toolOk: ok ? 1 : 0, toolFail: ok ? 0 : 1, byTool: { [n]: { ok: ok ? 1 : 0, fail: ok ? 0 : 1 } } }
      buffer.set(key, mergeDay(d, inc))
    })
  }

  /** 批量落 KV：get→merge→set（带 TTL 滚动续期）；失败保留缓冲下轮重试 */
  async function flushNow() {
    if (flushing || stopped || !buffer.size) return
    flushing = true
    const snapshot = [...buffer.entries()]
    try {
      for (const [key, inc] of snapshot) {
        const fullKey = DAY_KEY_PREFIX + key
        let existing = null
        try { existing = await kv.get(fullKey) } catch { existing = null }
        const merged = mergeDay(existing && typeof existing === 'object' ? existing : emptyDay(key), { ...inc, updatedAt: now().getTime() })
        await kv.set(fullKey, merged, keepDays * 86400)
        buffer.delete(key) // set 成功才出缓冲（失败保留重试）
        stats.flushed++
      }
      await kv.set(SINCE_KEY, { at: now().getTime() }, keepDays * 86400).catch(() => {})
      stats.lastFlushAt = now().getTime()
    } catch (e) {
      logger('warn', '[usage-stats] flush 失败（缓冲保留待重试）', e?.message || e)
    } finally {
      flushing = false
    }
  }

  /** 读最近 n 天（含今天；缺失天补零骨架，供前端连续趋势） */
  async function readDays(n = 7) {
    const out = []
    const today = now()
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
      const key = dayOf(d)
      let v = null
      try { v = await kv.get(DAY_KEY_PREFIX + key) } catch { v = null }
      out.push(v && typeof v === 'object' ? v : emptyDay(key))
    }
    return out
  }

  function stop() {
    stopped = true
    if (timer) { clearTimeout(timer); timer = null }
  }

  return { recordRun, recordToolResult, flushNow, readDays, stop, stats }
}

/**
 * 日志趋势与 KV 日统计按日合并（overview 用纯函数）：
 *   KV 首个有数据日（chats/toolCalls 任一 >0）起完全以 KV 为准（该日起 KV 全量记录），
 *   日志侧只保留更早的天——同一天不会双算；KV 尚无任何数据时全用日志（部署首回退）。
 *   日志 day 形如 'MM-DD'（ISO slice），KV 为 'YYYY-MM-DD'——统一输出 MM-DD。
 * 返回 { tokenTrend, requestTrend, firstKvDay }（firstKvDay='MM-DD' 或 null，供工具总量口径切换）。
 */
export function mergeTrend(logTokenTrend = [], logReqTrend = [], kvDays = []) {
  const kvWith = kvDays.filter((d) => d && ((d.chats || 0) > 0 || (d.toolCalls || 0) > 0))
  if (!kvWith.length) {
    return { tokenTrend: logTokenTrend.map((t) => ({ ...t })), requestTrend: logReqTrend.map((t) => ({ ...t })), firstKvDay: null }
  }
  const firstKvDay = kvWith[0].date.slice(5) // MM-DD
  const logTok = logTokenTrend.filter((t) => t.day < firstKvDay) // MM-DD 字典序即日期序
  const logReq = logReqTrend.filter((t) => t.day < firstKvDay)
  const kvTrend = kvWith.map((d) => ({
    day: d.date.slice(5),
    input: d.inputTokens || 0, output: d.outputTokens || 0,
    cached: d.cacheRead || 0, cacheRead: d.cacheRead || 0, cacheWrite: d.cacheWrite || 0,
    uncached: 0, observedInput: 0, // 观测口径细分仅日志链路有；KV 趋势不拆（缓存卡仍走日志专项）
  }))
  const kvReq = kvWith.map((d) => ({ day: d.date.slice(5), count: d.chats || 0 }))
  return { tokenTrend: [...logTok, ...kvTrend], requestTrend: [...logReq, ...kvReq], firstKvDay }
}

/** KV 多日聚合成 overview 总量/工具位（纯函数） */
export function summarizeKvDays(kvDays = []) {
  const total = emptyDay('')
  for (const d of kvDays) { Object.assign(total, mergeDay(total, d)) }
  const toolMap = new Map()
  for (const d of kvDays) {
    for (const [name, t] of Object.entries(d?.byTool || {})) {
      const cur = toolMap.get(name) || { name, count: 0, ok: 0, fail: 0 }
      cur.count += (Number(t.ok) || 0) + (Number(t.fail) || 0)
      cur.ok += Number(t.ok) || 0
      cur.fail += Number(t.fail) || 0
      toolMap.set(name, cur)
    }
  }
  const toolTop = [...toolMap.values()]
    .sort((a, b) => b.count - a.count)
    .map((t) => ({ ...t, rate: rateOf(t.ok, t.count) }))
  return {
    totalRequests: total.chats, totalToolCalls: total.toolCalls,
    totalTokens: total.inputTokens + total.outputTokens,
    totalInputTokens: total.inputTokens, totalOutputTokens: total.outputTokens,
    toolOk: total.toolOk, toolFail: total.toolFail,
    toolSuccessRate: rateOf(total.toolOk, total.toolCalls),
    toolFailRate: rateOf(total.toolFail, total.toolCalls),
    toolTop,
  }
}
