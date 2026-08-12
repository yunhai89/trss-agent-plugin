/**
 * HumanizePlanner —— Tool-only 决策器（指南 §11）。
 *
 * 与现有任务型 Agent 的根本区别（指南 §11.1）：
 *  - 普通 assistant content 视为内部分析，**永不发送**。
 *  - 无工具调用 = 本轮终结（沉默），不重试（MaiBot planner_no_tool_end）。
 *  - 只有 human_reply/human_react 产生对外消息，且由 scheduler/Replyer 另行处理。
 *  - 最多 maxPlannerRounds（4）轮、plannerTimeoutMs（30s）；temperature 低（0.2）求稳定。
 *
 * 只挂载 4 个动作工具 + 白名单只读工具（allowedReadTools）；写/删/管理/终端工具一律不可发现。
 * 内部消息循环：调模型 → assistant 写内部历史 → 有终止动作则返回 → 否则执行只读工具回灌 → 继续。
 */

import { stringifyArgs } from '../agent/messages.js'
import { ACTION_TOOLS, pickSingleAction, TERMINAL_ACTIONS } from './action-tools.js'
import { buildPlannerSystem, formatGroupContext, highlightTarget } from './prompts.js'

const LEAK_PATTERNS = [
  /作为一个\s*(AI|人工智能)/, /根据系统(指令|提示)/, /我将(调用|使用)工具/,
  /(?:reply|human_reply)\s*工具.*?(写|生成|输出)/, /(?:回复：|回复:)\s*['"「]/,
]

/** 检测 assistant 文本是否含发送控制/泄漏措辞（仅用于 trace 告警，不发送本身就被禁止）。 */
function looksLikeLeak(text) {
  const t = String(text || '')
  return LEAK_PATTERNS.some((re) => re.test(t))
}

export class HumanizePlanner {
  /**
   * @param {object} opts { provider, cfg, readTools?:Array, getMemories?:(query)=>Promise<string>, getBehaviorPolicyBlock?:()=>string, getPersonaName?:()=>string }
   *   readTools: 已过滤的白名单只读工具，每项 {name, description, parameters, execute(args)=>Promise<string|object>}
   */
  constructor({ provider, cfg, readTools = [], getMemories = null, getBehaviorPolicyBlock = null, getPersonaName = null } = {}) {
    this.provider = provider
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.readTools = Array.isArray(readTools) ? readTools : []
    this.getMemories = getMemories
    this.getBehaviorPolicyBlock = getBehaviorPolicyBlock || (() => '')
    this.getPersonaName = getPersonaName || (() => '机器人')
  }

  /** 下发给模型的工具列表 = 4 动作 + 白名单只读。 */
  _toolList() {
    return [...ACTION_TOOLS, ...this.readTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))]
  }

  /** 执行白名单只读工具 → 字符串结果（回灌内部历史）。 */
  async _execReadTool(name, args) {
    const t = this.readTools.find((x) => x.name === name)
    if (!t || typeof t.execute !== 'function') return { error: `Tool '${name}' not found` }
    try {
      const raw = await t.execute(args || {})
      return typeof raw === 'string' ? raw : raw
    } catch (e) {
      return { error: e?.message || String(e) }
    }
  }

  /**
   * 决策一轮。
   * @param {object} ctx { snapshot, decision, signal, runtime, cfg }
   * @returns {Promise<object>} 动作 {type, ...} （human_reply/human_react/human_wait/human_ignore）
   */
  async decide({ snapshot, decision, signal, runtime, cfg }) {
    const c = cfg || this._cfgFn()
    const pcfg = c.planner || {}
    const maxRounds = Math.max(1, Math.min(6, pcfg.maxRounds ?? c.maxPlannerRounds ?? 4))
    const timeoutMs = pcfg.timeoutMs ?? c.plannerTimeoutMs ?? 30000
    const model = pcfg.model || c.model || null
    const temperature = pcfg.temperature ?? 0.2
    const maxTokens = pcfg.maxTokens ?? 800

    // 系统 Prompt
    const groupContext = formatGroupContext(snapshot, { includeIds: true })
    const target = decision?.targetMessage || null
    let publicMemories = ''
    try {
      if (this.getMemories && target) publicMemories = await this.getMemories(target.text || '', c.contextMessages ?? 30)
    } catch { /* noop */ }

    const system = buildPlannerSystem({
      personaName: this.getPersonaName(),
      behaviorPolicyBlock: this.getBehaviorPolicyBlock(),
      necessityDecision: decision,
      groupContext: (target ? highlightTarget(target) + '\n\n' : '') + groupContext,
      publicMemories,
    })

    // 内部消息（永不对外发送）
    const internalMessages = [{
      role: 'user',
      content: '请根据上方群聊上下文与门控评分，判断机器人此刻是否应该参与。需要回复时调用 human_reply（targetMessageId 必须来自上文真实 id）；不应参与时调用 human_ignore 或不调用任何工具。',
    }]

    const tools = this._toolList()
    const timeoutAc = timeoutMs ? AbortSignal.timeout(timeoutMs) : null
    // 合并外部 signal 与 timeout：任一触发即中止
    const combinedSignal = this._combineSignals(signal, timeoutAc)

    for (let round = 0; round < maxRounds; round++) {
      if (combinedSignal?.aborted) throw new Error('aborted')

      let result
      try {
        result = await this.provider.chat({
          model, system, messages: internalMessages, tools,
          tool_choice: { mode: 'auto' }, temperature, max_tokens: maxTokens,
          signal: combinedSignal, stream: false,
        })
      } catch (e) {
        if (/abort/i.test(String(e?.message || e))) throw e
        // 非中断错误：记录并当作 ignore（不发送）
        runtime?.trace?.record('planner_call_error', { round, msg: String(e?.message || e) })
        return { type: 'human_ignore', reason: 'planner_call_failed', toolCallId: null }
      }

      // 永远不发送 result.content；只入内部历史
      const assistantMsg = { role: 'assistant', content: result.content || '(无分析)' }
      const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : []
      if (toolCalls.length) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id, type: 'function', function: { name: tc.name, arguments: stringifyArgs(tc.arguments) },
        }))
      }
      internalMessages.push(assistantMsg)
      if (looksLikeLeak(result.content)) {
        runtime?.trace?.record('planner_leak_warning', { round, content: String(result.content || '').slice(0, 160) })
      }
      runtime?.trace?.record('planner_round', { round, contentLen: (result.content || '').length, toolCalls: toolCalls.map((tc) => tc.name), usage: result.usage || null })

      if (!toolCalls.length) {
        // 无工具 = 本轮终结（沉默）—— MaiBot planner_no_tool_end，不重试
        return { type: 'human_ignore', reason: 'no_tool', toolCallId: null }
      }

      // 分离终止动作 vs 只读工具
      const actionCalls = toolCalls.filter((tc) => TERMINAL_ACTIONS.has(tc.name))
      const readCalls = toolCalls.filter((tc) => !TERMINAL_ACTIONS.has(tc.name))

      // 终止动作：校验并返回（同轮多发送动作只取一个）
      if (actionCalls.length) {
        const hasTarget = (id) => !!snapshot.find((m) => m.id === String(id))
        const { action, violations } = pickSingleAction(actionCalls, { hasTarget })
        if (violations.length) runtime?.trace?.record('planner_schema_violation', { round, violations })
        return action
      }

      // 只读工具：执行并回灌结果，继续循环
      for (const tc of readCalls) {
        const res = await this._execReadTool(tc.name, tc.arguments)
        internalMessages.push({
          role: 'tool', tool_call_id: tc.id, name: tc.name,
          content: typeof res === 'string' ? res : stringifyArgs(res),
        })
      }
      // 继续下一轮（最多 maxRounds）
    }

    // 轮数耗尽：默认沉默
    runtime?.trace?.record('planner_round_limit', { maxRounds })
    return { type: 'human_ignore', reason: 'round_limit', toolCallId: null }
  }

  /** 合并外部 abort signal 与超时 signal。 */
  _combineSignals(external, timeout) {
    if (!external && !timeout) return null
    if (!external) return timeout
    if (!timeout) return external
    const ac = new AbortController()
    const onAbort = () => ac.abort()
    external.addEventListener?.('abort', onAbort)
    timeout.addEventListener?.('abort', onAbort)
    return ac.signal
  }
}
