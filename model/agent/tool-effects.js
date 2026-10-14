/**
 * 工具执行语义契约（P0-2/P0-3）：副作用类别与可重放性。
 *
 * 三个字段互相独立、不互相推导（见 DeepSeek Harness 优化方案 §6）：
 *   effect  = read | write | external   （读 / 本地写 / 外部副作用）
 *   replay  = safe | idempotent | never （崩溃恢复时可重放的程度）
 *   idempotencyKey(args, ctx)           （幂等写操作的稳定键；重放沿用同一键）
 *
 * 默认（不声明时）：只读白名单工具 = read/safe；其余 = write/never（保守，防重复副作用）。
 * 工具显式声明 meta.effect / meta.replay / meta.idempotencyKey 时以声明为准。
 */
import { READ_PARALLEL_TOOLS } from './tool-scheduler.js'

const EFFECTS = new Set(['read', 'write', 'external'])
const REPLAYS = new Set(['safe', 'idempotent', 'never'])

export function resolveExecutionMeta(tool, args = {}, ctx = null) {
  const meta = tool?.meta || {}
  let effect = meta.effect
  if (!EFFECTS.has(effect)) {
    effect = READ_PARALLEL_TOOLS.has(tool?.name) ? 'read' : 'write'
  }
  let replay = meta.replay
  if (!REPLAYS.has(replay)) {
    replay = effect === 'read' ? 'safe' : 'never'
  }
  let idempotencyKey = null
  if (typeof meta.idempotencyKey === 'function') {
    try { idempotencyKey = String(meta.idempotencyKey(args, ctx) ?? '') || null } catch { idempotencyKey = null }
  }
  return { effect, replay, idempotencyKey }
}
