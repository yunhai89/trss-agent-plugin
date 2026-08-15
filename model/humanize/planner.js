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
import Log, { ANSI } from '../../utils/Log.js'
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

/* 控制台彩色决策日志：按动作类型上色 + 带 reason。
   ignore/reply 等都把理由/replyGuide 带出来，避免"只看到 human_ignore，不知道是主动沉默还是出错"。 */
const DEC_COLOR = { human_reply: ANSI.g, human_react: ANSI.m, human_wait: ANSI.b, human_ignore: ANSI.y }
function logDecision(runtime, action, violations = []) {
  const col = DEC_COLOR[action.type] || ANSI.c
  const tail = action.targetMessageId ? ' 目标#' + String(action.targetMessageId).slice(-6) : ''
  const viol = violations.length ? ` ${ANSI.r}违规${violations.length}${ANSI.R}` : ''
  const why = String(action.reason || action.replyGuide || action.intent || '').trim()
  const whyStr = why ? ` ${ANSI.gry}· ${why.slice(0, 100)}${ANSI.R}` : ''
  Log.mark('[humanize] 决策', `${col}群${runtime?.groupId} → ${action.type}${tail}${viol}${ANSI.R}${whyStr}`)
}

export class HumanizePlanner {
  /**
   * @param {object} opts { provider, cfg, readTools?:Array, getMemories?:(query)=>Promise<string>, getBehaviorPolicyBlock?:()=>string, getPersonaName?:()=>string }
   *   readTools: 已过滤的白名单只读工具，每项 {name, description, parameters, execute(args)=>Promise<string|object>}
   */
  constructor({ provider, cfg, readTools = [], getMemories = null, getBehaviorPolicyBlock = null, getPersonaName = null, getPersonaBlock = null, getWorldContext = null, getSelfProjection = null, enrichMedia = null, getGrounding = null } = {}) {
    this.provider = provider
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.readTools = Array.isArray(readTools) ? readTools : []
    this.getMemories = getMemories
    this.getBehaviorPolicyBlock = getBehaviorPolicyBlock || (() => '')
    this.getPersonaName = getPersonaName || (() => '机器人')
    this.getPersonaBlock = getPersonaBlock || (() => '')
    this.getWorldContext = getWorldContext // GroupWorld 局部社会现场（online 时由 apps 注入；失败/空 → 零影响）
    this.getSelfProjection = getSelfProjection // SelfState 状态投影（enabled+非shadow 时；失败/中性 → 零影响）
    this.enrichMedia = enrichMedia // 视觉图描述（配了视觉模型时 '[图片]'→'[图:描述]'；未配/失败 → 原样）
    this.getGrounding = getGrounding // 对话落地（谁在对谁说+白名单+纠错约束；失败/空 → 零影响）
  }

  /** 从目标消息段提取 @ 的用户 id（供 GroupWorld 检索相关人）。 */
  _relatedIds(target) {
    const out = []
    for (const s of (target?.segments || [])) {
      if (s?.type === 'at' && s.qq != null && String(s.qq) !== 'all') out.push(String(s.qq))
    }
    return out
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

    // 系统 Prompt（视觉：配了视觉模型时把窗口内近期图片注成一句话描述）
    let ctxMessages = snapshot
    try {
      if (this.enrichMedia && Array.isArray(snapshot)) ctxMessages = await this.enrichMedia(snapshot, { targetId: decision?.targetMessage?.id }) || snapshot
    } catch { ctxMessages = snapshot }
    const groupContext = formatGroupContext(ctxMessages, { includeIds: true })
    const target = decision?.targetMessage || null
    let publicMemories = ''
    try {
      // 记忆检索门控：只对有实质文本的目标查（对齐 MaiBot——寒暄/短反应/纯媒体不查，免得注入无关记忆+白调一次）
      const q = String(target?.text || '').trim()
      const worthRecall = q.length >= 4 && !/^\[.+\]$/.test(q) && !/^(?:6|666|哈哈|好的?|嗯|哦|确实|赞成|支持)$/.test(q)
      if (this.getMemories && target && worthRecall) publicMemories = await this.getMemories(q, c.contextMessages ?? 30)
    } catch { /* noop */ }

    // GroupWorld 局部社会现场（online 时；失败/空 → 零影响，不阻断决策）
    let socialScene = ''
    try {
      if (this.getWorldContext && target && runtime?.groupId) {
        const scene = await this.getWorldContext({
          groupId: runtime.groupId,
          focusUserId: target.userId,
          relatedUserIds: this._relatedIds(target),
          topicText: String(target.text || '').slice(0, 200),
        })
        socialScene = scene?.text || ''
      }
    } catch { /* noop */ }

    // 对话落地块（结构化归属+白名单+纠错约束）
    let groundingBlock = ''
    try {
      if (this.getGrounding) groundingBlock = this.getGrounding(ctxMessages) || ''
    } catch { /* noop */ }
    // SelfState 状态投影（enabled+非 shadow 时注入；失败/中性 → 零影响）
    let selfState = ''
    try {
      if (this.getSelfProjection && runtime?.groupId) {
        const p = await this.getSelfProjection({ groupId: runtime.groupId, targetUserId: target?.userId })
        selfState = p?.text || ''
      }
    } catch { /* noop */ }

    const system = buildPlannerSystem({
      personaName: this.getPersonaName(),
      personaBlock: this.getPersonaBlock(),
      behaviorPolicyBlock: this.getBehaviorPolicyBlock(),
      necessityDecision: decision,
      groupContext: (target ? highlightTarget(target) + '\n\n' : '') + groupContext,
      publicMemories,
      socialScene,
      grounding: groundingBlock,
      selfState,
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
          thinking: { type: 'disabled' },
          signal: combinedSignal, stream: false,
        })
      } catch (e) {
        if (/abort/i.test(String(e?.message || e))) throw e
        // 非中断错误：记录并当作 ignore（不发送）
        runtime?.trace?.record('planner_call_error', { round, msg: String(e?.message || e) })
        Log.mark('[humanize] 决策', `${ANSI.r}群${runtime?.groupId} → 沉默(规划失败: ${String(e?.message || e).slice(0, 60)})${ANSI.R}`)
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
        Log.mark('[humanize] 决策', `${ANSI.gry}群${runtime?.groupId} → 沉默(无工具)${ANSI.R}`)
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
        logDecision(runtime, action, violations)
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
    Log.mark('[humanize] 决策', `${ANSI.y}群${runtime?.groupId} → 沉默(轮数耗尽 ${maxRounds})${ANSI.R}`)
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
