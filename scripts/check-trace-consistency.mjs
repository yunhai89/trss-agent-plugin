/**
 * 离线 trace 一致性检查（长任务稳定性审计 P1）。
 *
 * 规则：每个 trigger 事件（traceId 的起点）必须最终、且只能落到一个终态事件：
 *   reply_sent | reply_failed | cancelled | run_error
 * 找出：无终态的 trace（任务悬挂/回复静默消失）、多终态的 trace、无 trigger 的孤儿终态。
 *
 * 用法：
 *   node scripts/check-trace-consistency.mjs [文件或目录]   # 缺省扫 data/logs
 * 退出码：有问题=1（可挂 CI），全部一致=0。
 *
 * 日志格式：DevLog 产出的美化缩进 JSON（多行对象背靠背追加，字符串内可含花括号）——
 * 解析器需跳过字符串字面量内的 {}（见 parseDevLog）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const TERMINAL_EVENTS = new Set(['reply_sent', 'reply_failed', 'cancelled', 'run_error'])
export const TRIGGER_EVENT = 'trigger'

/** 解析 DevLog 美化 JSON 文本为事件数组（字符串感知的括号深度切分；坏段跳过并计数） */
export function parseDevLog(text) {
  const events = []
  let malformed = 0
  let depth = 0, start = -1, inStr = false, esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') { if (depth === 0) start = i; depth++ }
    else if (c === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        try { events.push(JSON.parse(text.slice(start, i + 1))) } catch { malformed++ }
        start = -1
      } else if (depth < 0) { depth = 0; start = -1 } // 防御：孤立 '}' 后重同步
    }
  }
  return { events, malformed }
}

/**
 * 一致性检查。
 * @param {object[]} events
 * @returns {{ problems: string[], traces: object[], malformed: number }}
 */
export function checkConsistency(events) {
  const byTrace = new Map() // traceId -> { trigger: bool, terminals: [] }
  for (const e of events) {
    if (!e || typeof e.event !== 'string') continue
    const id = e.traceId || null
    if (e.event === TRIGGER_EVENT || TERMINAL_EVENTS.has(e.event)) {
      const key = id || '(no-traceId)'
      if (!byTrace.has(key)) byTrace.set(key, { trigger: false, terminals: [] })
      const rec = byTrace.get(key)
      if (e.event === TRIGGER_EVENT) rec.trigger = true
      else rec.terminals.push(e.event)
    }
  }
  const problems = []
  const traces = []
  for (const [id, rec] of byTrace) {
    const n = rec.terminals.length
    let ok = true
    if (!rec.trigger) { problems.push(`${id}: 终态 ${rec.terminals.join(',')} 无 trigger 起点（孤儿终态）`); ok = false }
    else if (n === 0) { problems.push(`${id}: trigger 后没有任何终态（reply_sent/reply_failed/cancelled/run_error 缺失——回复可能静默消失）`); ok = false }
    else if (n > 1) { problems.push(`${id}: 出现 ${n} 个终态（${rec.terminals.join('→')}），必须唯一`); ok = false }
    traces.push({ traceId: id, ok, terminals: rec.terminals })
  }
  return { problems, traces, malformed: 0 }
}

/** 检查单个日志文件文本 */
export function checkLogText(text, label = 'log') {
  const { events, malformed } = parseDevLog(text)
  const { problems, traces } = checkConsistency(events)
  if (malformed) problems.push(`${label}: ${malformed} 个段无法解析（可能日志被截断）`)
  return { problems, traces, malformed, events }
}

function collectFiles(target) {
  const st = fs.statSync(target)
  if (st.isFile()) return [target]
  const out = []
  for (const f of fs.readdirSync(target)) {
    if (!f.endsWith('.log')) continue
    out.push(path.join(target, f))
  }
  return out.sort()
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const target = process.argv[2] || path.join(root, 'data', 'logs')
  let files = []
  try { files = collectFiles(target) } catch (e) { console.error(`无法读取 ${target}：${e.message}`); process.exit(2) }
  if (!files.length) { console.log(`（${target} 下没有 .log 文件，跳过）`); process.exit(0) }
  let totalProblems = 0
  let totalTraces = 0
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    const { problems, traces } = checkLogText(text, path.basename(f))
    totalTraces += traces.length
    if (problems.length) {
      totalProblems += problems.length
      console.log(`✗ ${f}`)
      for (const p of problems) console.log(`    - ${p}`)
    } else {
      console.log(`✓ ${f}（${traces.length} 条 trace 均有唯一终态）`)
    }
  }
  console.log(`\n检查 ${files.length} 个文件 / ${totalTraces} 条 trace：${totalProblems ? `${totalProblems} 个问题` : '全部一致'}`)
  process.exit(totalProblems ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
