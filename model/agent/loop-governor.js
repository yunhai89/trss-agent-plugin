/**
 * LoopGovernor —— ReAct 循环智能终止器（审计 §2.1 / P0-3）。
 *
 * 主循环原有 maxTurns 硬上限不足以防"有上限的无效循环"：同一个工具 + 相同参数可一直重复到耗尽，
 * 然后把空内容交付给用户。本组件独立于模型，跟踪：
 *   - 动作指纹（toolName + 规范化 args）连续重复 → duplicate_action
 *   - 连续失败（工具返回 error）→ consecutive_failures
 *   - 无进展（最近 N 步无新事实）→ no_progress
 *   - 时间预算 / token 预算耗尽 → time_budget / token_budget
 * 命中任一即建议停止；Agent 主循环据此 break，并强制一次"不带工具的收尾调用"交付进展。
 *
 * 库零依赖（与 Agent 一致）；now 注入便于测试。
 */

/** 稳定 JSON：对象键排序，保证相同 args 产出相同指纹 */
function stableJson(v) {
  if (v == null) return String(v)
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']'
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}

/** 动作指纹：toolName + 规范化 args（同工具同参数 = 同指纹） */
export function fingerprint(name, args) {
  return String(name || '') + '|' + stableJson(args)
}

export class LoopGovernor {
  constructor({
    maxSameAction = 2,
    maxConsecutiveFailures = 3,
    noProgressWindow = 4,
    timeBudgetMs = 90_000,
    tokenBudget = 80_000,
    now = Date.now,
  } = {}) {
    this.maxSameAction = Math.max(1, Number(maxSameAction) || 2)
    this.maxConsecutiveFailures = Math.max(1, Number(maxConsecutiveFailures) || 3)
    this.noProgressWindow = Math.max(1, Number(noProgressWindow) || 4)
    this.timeBudgetMs = Math.max(0, Number(timeBudgetMs) || 0)
    this.tokenBudget = Math.max(0, Number(tokenBudget) || 0)
    this._now = now
    this.reset()
  }

  /** 每 run 重置（防跨 run 串） */
  reset() {
    this._start = this._now()
    this._lastFingerprint = null
    this._sameCount = 0
    this._consecutiveFailures = 0
    this._progressFlags = [] // 滚动窗口：最近 N 步是否产出新事实
    this._tokens = 0
    this._seenFacts = new Set() // 本 run 已见过的事实键（指纹+结果签名）：重复出现不再算新事实
  }

  /**
   * 工具调用后上报。
   * @param {string} name 工具名
   * @param {*} args 工具入参（指纹用）
   * @param {boolean} ok 是否成功（非 error）
   * @param {boolean} [hasNewFact] 是否产出新事实；缺省由本组件判定：
   *   成功 且 （工具+入参+结果签名）首次出现 才算新事实。
   *   结果签名参与判定使轮询型工具（如 check_subagent）状态变化仍算进展，
   *   而"同参同结果"的空转（A,B,A,B 交替或状态卡死）会触发 no_progress。
   * @param {string} [resultSig] 工具结果签名（内容摘要；缺省只按指纹判重）
   */
  noteToolCall(name, args, ok, hasNewFact, resultSig) {
    const fp = fingerprint(name, args)
    if (fp === this._lastFingerprint) this._sameCount++
    else { this._lastFingerprint = fp; this._sameCount = 1 }
    if (ok === false) this._consecutiveFailures++
    else this._consecutiveFailures = 0
    let isNew = ok !== false
    if (hasNewFact !== undefined) isNew = !!hasNewFact
    else {
      const factKey = resultSig === undefined ? fp : `${fp}|${resultSig}`
      if (this._seenFacts.has(factKey)) isNew = false
      else this._seenFacts.add(factKey)
    }
    this._progressFlags.push(isNew)
    if (this._progressFlags.length > this.noProgressWindow) this._progressFlags.shift()
  }

  /** 累加 token 用量（兼容 input/output 与 prompt_tokens/completion_tokens 两种形态） */
  noteUsage(usage) {
    if (!usage) return
    const inc = (usage.input ?? usage.prompt_tokens ?? 0) + (usage.output ?? usage.completion_tokens ?? 0)
    if (inc > 0) this._tokens += inc
  }

  /** 快照（供 devLog/调试） */
  snapshot() {
    return {
      sameCount: this._sameCount,
      consecutiveFailures: this._consecutiveFailures,
      progressWindow: this._progressFlags.slice(),
      tokens: this._tokens,
      elapsedMs: this._now() - this._start,
    }
  }

  /**
   * 是否建议停止。
   * @returns {{ stop: boolean, reason: string|null }}
   *   reason ∈ duplicate_action | consecutive_failures | no_progress | time_budget | token_budget
   */
  shouldStop() {
    // 允许 maxSameAction 次相同动作（给一次合理重试机会），超出判死循环
    if (this._sameCount > this.maxSameAction) return { stop: true, reason: 'duplicate_action' }
    if (this._consecutiveFailures >= this.maxConsecutiveFailures) return { stop: true, reason: 'consecutive_failures' }
    // 窗口满且全程无新事实 → 停滞
    if (this._progressFlags.length >= this.noProgressWindow && !this._progressFlags.some(Boolean)) {
      return { stop: true, reason: 'no_progress' }
    }
    if (this.timeBudgetMs && this._now() - this._start > this.timeBudgetMs) return { stop: true, reason: 'time_budget' }
    if (this.tokenBudget && this._tokens > this.tokenBudget) return { stop: true, reason: 'token_budget' }
    return { stop: false, reason: null }
  }
}

export default LoopGovernor
