/**
 * LoopGovernor —— ReAct 循环智能终止器（审计 §2.1 / P0-3；长任务稳定性审计重设计）。
 *
 * 主循环原有 maxTurns 硬上限不足以防"有上限的无效循环"：同一个工具 + 相同参数可一直重复到耗尽，
 * 然后把空内容/中间旁白交付给用户。本组件独立于模型，跟踪：
 *   - 动作指纹（toolName + 规范化 args）连续重复 → duplicate_action
 *   - 连续失败（工具返回 error）→ consecutive_failures
 *   - 无进展（最近 N 步无新事实）→ no_progress
 *   - 时间预算 / token 预算耗尽 → time_budget / token_budget
 * 命中任一即建议停止；Agent 主循环据此 break，并强制一次"不带工具的收尾调用"交付进展。
 *
 * ── 预算口径（长任务稳定性审计：曾有 governor 88k / run_end 102k 的口径分裂）──
 * 所有用量经 noteUsage(usage, {scope}) 入账，scope 分三类：
 *   - 'work'     工作循环（主模型轮次 + 反思评判）→ 计入工作预算门控
 *   - 'finalize' 收尾总结（独立预留，不占工作预算，但计入总量对账）
 * 命名口径（snapshot 暴露）：
 *   - contextTokens  单次上下文占用（最近一次工作调用的完整输入，含缓存命中）
 *   - workTokens     累计工作 token（每轮完整 input+output 累加，含缓存读——本插件 tokenBudget 的语义）
 *   - finalizeTokens 收尾调用累计
 *   - bill          实际计费口径估算累计 { uncached, cacheWrite, cacheRead, output }（观察用，不作门控）
 *
 * 门控时机：
 *   - precheck()   调模型前 / 执行长工具前：时间已超，或「已用 + 预计下一轮上下文」超预算 → 停，
 *                  不再启动一轮注定超支的调用（为收尾保留空间）。
 *   - shouldStop() 工具执行后：循环停滞检测 + 预算硬上限。
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
    finalizeGraceMs = 45_000, // 收尾宽限：预算/时间耗尽后，finalizer 在此窗内完成最终交付
    now = Date.now,
  } = {}) {
    this.maxSameAction = Math.max(1, Number(maxSameAction) || 2)
    this.maxConsecutiveFailures = Math.max(1, Number(maxConsecutiveFailures) || 3)
    this.noProgressWindow = Math.max(1, Number(noProgressWindow) || 4)
    this.timeBudgetMs = Math.max(0, Number(timeBudgetMs) || 0)
    this.tokenBudget = Math.max(0, Number(tokenBudget) || 0)
    this.finalizeGraceMs = Math.max(1_000, Number(finalizeGraceMs) || 45_000)
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
    this._workTokens = 0 // 累计工作 token（input+output，含缓存读）
    this._finalizeTokens = 0 // 收尾调用累计（独立预留）
    this._contextTokens = 0 // 单次上下文占用（最近一次工作调用的完整输入）
    this._bill = { uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0 } // 计费口径估算累计
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

  /**
   * 累加 token 用量（兼容 input/output、prompt_tokens/completion_tokens 及缓存明细字段）。
   * @param {object} usage provider 返回的 usage（raw 或归一形态均可）
   * @param {object} [opts] { scope: 'work' | 'finalize' } —— finalize 独立预留，不占工作预算
   */
  noteUsage(usage, { scope = 'work' } = {}) {
    if (!usage) return
    const input = usage.input ?? usage.prompt_tokens ?? 0
    const output = usage.output ?? usage.completion_tokens ?? 0
    const cacheRead = usage.cacheRead
      ?? usage.cache_read_input_tokens
      ?? usage.prompt_cache_hit_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? 0
    const cacheWrite = usage.cacheWrite
      ?? usage.cache_creation_input_tokens
      ?? usage.input_tokens_details?.cache_write_tokens
      ?? 0
    // uncached：显式字段优先；否则从 input 扣除缓存读（OpenAI 口径 input 含缓存；Anthropic input_tokens 本就不含）
    const uncached = usage.uncached
      ?? usage.prompt_cache_miss_tokens
      ?? Math.max(0, Number(input) - Number(cacheRead))
    const inc = (Number(input) || 0) + (Number(output) || 0)
    if (scope === 'finalize') {
      if (inc > 0) this._finalizeTokens += inc
    } else {
      if (inc > 0) this._workTokens += inc
      if (Number(input) > 0) this._contextTokens = Number(input) // 单次上下文占用（单调可观）
    }
    this._bill.uncached += Number(uncached) || 0
    this._bill.cacheWrite += Number(cacheWrite) || 0
    this._bill.cacheRead += Number(cacheRead) || 0
    this._bill.output += Number(output) || 0
  }

  /** 快照（供 devLog/调试；tokens 兼容旧字段名=workTokens） */
  snapshot() {
    return {
      sameCount: this._sameCount,
      consecutiveFailures: this._consecutiveFailures,
      progressWindow: this._progressFlags.slice(),
      tokens: this._workTokens,
      workTokens: this._workTokens,
      finalizeTokens: this._finalizeTokens,
      contextTokens: this._contextTokens,
      bill: { ...this._bill },
      elapsedMs: this._now() - this._start,
    }
  }

  /**
   * 预检（调模型前 / 执行长工具前）。与 shouldStop 的区别：这是"还要不要开始下一轮"的判断，
   * token 维度按「已用 + 最近一次上下文占用」预估——不再启动一轮注定超支的调用，为收尾留出空间。
   * @returns {{ stop: boolean, reason: string|null }}
   */
  precheck() {
    if (this.timeBudgetMs && this._now() - this._start > this.timeBudgetMs) return { stop: true, reason: 'time_budget' }
    if (this.tokenBudget && this._workTokens + this._contextTokens > this.tokenBudget) return { stop: true, reason: 'token_budget' }
    return { stop: false, reason: null }
  }

  /**
   * 是否建议停止（工具执行后）。
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
    if (this.tokenBudget && this._workTokens > this.tokenBudget) return { stop: true, reason: 'token_budget' }
    return { stop: false, reason: null }
  }
}

export default LoopGovernor
