/**
 * Recovery planner —— 依据任务账本事件推导崩溃/重启后的恢复动作（P0-3 阶段二）。
 *
 * 崩溃/重复执行语义（DeepSeek Harness 优化方案 §7）：
 *   - 工具尚未开始（仅有 tool_planned，无 tool_started）→ 重新校验后可执行（retry）
 *   - 只读调用已开始但结果未保存（read/safe）→ 可重试（retry）
 *   - 幂等写操作已开始但结果未知（replay=idempotent）→ 复用原幂等键、先核实（reconcile）
 *   - 无幂等能力的写操作结果未知（write/never）→ 标记 unknown，暂停并核实、禁止盲目重复（block）
 *   - 工具已成功提交（tool_result ok）→ 使用既存结果，不重复执行（reuse）
 *
 * 纯函数：不执行任何副作用，只产出计划，便于确定性测试与人工审阅。
 */

/** @typedef {'reuse'|'retry'|'reconcile'|'block'} RecoveryAction */

const DEFAULT_META = { effect: 'write', replay: 'never', idempotencyKey: null }

function metaFromPayload(payload) {
  if (!payload) return null
  if (payload.effect || payload.replay) return { effect: payload.effect || 'write', replay: payload.replay || 'never', idempotencyKey: payload.idempotencyKey || null }
  return null
}

/**
 * @param {Array} events TaskStore.listEvents 输出（按 seq 升序）
 * @param {{ resolveMeta?: (name:string, seqIndex:number) => ({effect,replay,idempotencyKey}) }} [opts]
 * @returns {{ steps:Array, hasBlocking:boolean, autoResumable:boolean, counts:object }}
 */
export function planRecovery(events = [], { resolveMeta = null } = {}) {
  const order = []
  const planned = new Map() // callId -> payload
  const started = new Map() // callId -> payload
  const results = new Map() // callId -> payload
  const nameOf = new Map()

  for (const e of events) {
    if (e.kind === 'tool_planned' && e.callId) {
      order.push(e.callId)
      planned.set(e.callId, e.payload || {})
      if (e.payload?.name) nameOf.set(e.callId, e.payload.name)
    } else if (e.kind === 'tool_started' && e.callId) {
      started.set(e.callId, e.payload || {})
      if (e.payload?.name) nameOf.set(e.callId, e.payload.name)
    } else if (e.kind === 'tool_result' && e.callId) {
      results.set(e.callId, e.payload || {})
      if (e.payload?.name) nameOf.set(e.callId, e.payload.name)
    }
  }

  const metaFor = (callId) => {
    const fromStarted = metaFromPayload(started.get(callId))
    if (fromStarted) return fromStarted
    const fromPlanned = metaFromPayload(planned.get(callId))
    if (fromPlanned) return fromPlanned
    const name = nameOf.get(callId)
    if (resolveMeta && name) {
      try { return { ...DEFAULT_META, ...(resolveMeta(name) || {}) } } catch { return { ...DEFAULT_META } }
    }
    return { ...DEFAULT_META }
  }

  const steps = []
  for (const callId of order) {
    const name = nameOf.get(callId) || null
    const args = started.get(callId)?.args ?? planned.get(callId)?.args
    const withArgs = args !== undefined ? { args } : {}
    const r = results.get(callId)
    if (r) {
      if (r.ok) {
        steps.push({ callId, name, action: 'reuse', reason: 'already_completed', effectState: r.effectState || null })
      } else {
        const meta = metaFor(callId)
        steps.push(meta.effect === 'read'
          ? { callId, name, action: 'retry', reason: 'previous_failed_read', ...meta, ...withArgs }
          : { callId, name, action: 'reconcile', reason: 'previous_write_unknown', ...meta, ...withArgs })
      }
      continue
    }
    const s = started.get(callId)
    if (!s) {
      // 仅有 planned：尚未开始，无副作用 → 重新校验后可执行
      steps.push({ callId, name, action: 'retry', reason: 'not_started', ...metaFor(callId), ...withArgs })
      continue
    }
    const meta = metaFor(callId)
    if (meta.effect === 'read' && meta.replay === 'safe') {
      steps.push({ callId, name, action: 'retry', reason: 'safe_read_interrupted', ...meta, ...withArgs })
    } else if (meta.replay === 'idempotent') {
      steps.push({ callId, name, action: 'reconcile', reason: 'idempotent_write_unknown', ...meta, ...withArgs })
    } else {
      steps.push({ callId, name, action: 'block', reason: 'write_interrupted_unknown', ...meta, ...withArgs })
    }
  }

  const counts = { reuse: 0, retry: 0, reconcile: 0, block: 0 }
  for (const s of steps) counts[s.action]++
  const hasBlocking = counts.block > 0 || counts.reconcile > 0
  const autoResumable = !hasBlocking && steps.length > 0 && steps.every((s) => s.action === 'reuse' || s.action === 'retry')
  return { steps, hasBlocking, autoResumable, counts }
}
