/**
 * Jev 决策函数 —— 四个决策点的高层封装：构造 state/questions → 调用 → 置信度门控。
 *
 * 统一契约：任何失败（未配置/超时/网络/协议/低置信/结构非法）都返回 null（shell 风险返回
 * 可回退结论），调用方据此**无感回退现有方案**，绝不抛错阻塞对话。Jev 输出只用于"选择/门控"，
 * 不作为可信指令执行（安全评估缓解项）。
 */

import { DEPTHS, buildThinkingDecision } from '../../llm/thinking.js'
import { THINKING_QUESTION, SHELL_RISK_QUESTION, toolActiveQuestion, resolveThresholds } from './spec.js'

/** Jev 判定结果只取结构合法的字段（类型正确 ≠ 语义正确，仍需门控） */
const SHELL_RISKS = ['readonly', 'reversible', 'destructive']

/**
 * 用 Jev 判定思考深度。低置信/失败 → null（调用方回退规则+小模型）。
 * @returns {Promise<null|object>} 与 decideThinkingSmart 同构（depth/budget/thinking/... + jevModel/jevUsage/confidence）
 */
export async function decideThinkingWithJev({
  client, text, context = '', protocol, preset, model, style, budgets, maxBudget,
  thresholds = {}, signal = null,
} = {}) {
  if (!client?.configured || !text) return null
  const th = resolveThresholds(thresholds)
  try {
    const state = context ? { message: text, recent_dialogue: context } : { message: text }
    const { answers, model: jevModel, usage } = await client.systemOne({
      state, questions: { depth: THINKING_QUESTION }, signal,
    })
    const ans = answers?.depth
    const depth = String(ans?.choice || '').toLowerCase()
    const confidence = Number(ans?.confidence)
    if (!DEPTHS.includes(depth)) return null
    // 思考非破坏性：低置信保守回退规则（不猜测档位）
    if (!Number.isFinite(confidence) || confidence < th.thinkingMinConfidence) return null
    const decision = buildThinkingDecision(depth, {
      source: 'jev', reasons: ['jev'], confidence, protocol, preset, model, style, budgets, maxBudget,
    })
    return { ...decision, jevModel, jevUsage: usage }
  } catch { return null }
}

/**
 * 用 Jev 选择本轮应激活的工具（每工具一个 noul，代码按阈值聚合；文档 §9.2）。
 * state 只发工具名/摘要（不发完整 schema），并受 maxTools 限制（64k 上下文保护）。
 * @param {object} o { client, catalog:[{name,summary}], request, maxTools, thresholds }
 * @returns {Promise<null|{selected:string[], probabilities:Array, model, usage, candidateCount}>} 失败 → null（走 tool_search）
 */
export async function selectToolsWithJev({
  client, catalog = [], request = '', maxTools = 80, thresholds = {}, signal = null,
} = {}) {
  if (!client?.configured || !catalog.length || !request) return null
  const th = resolveThresholds(thresholds)
  const tools = catalog.slice(0, Math.max(1, Number(maxTools) || 80))
  try {
    const questions = {}
    tools.forEach((t, i) => { questions[`tool_${i}`] = toolActiveQuestion(i, t.name) })
    const { answers, model, usage } = await client.systemOne({
      // state 只发工具名/摘要/必填参数（不发完整 schema，控制 token 与泄露面）
      state: { request, tools: tools.map((t) => ({ name: t.name, summary: String(t.summary || '').slice(0, 200), required: t.required || [] })) },
      questions, signal,
    })
    const selected = []
    const probabilities = []
    tools.forEach((t, i) => {
      const p = Number(answers?.[`tool_${i}`]?.noul)
      if (!Number.isFinite(p)) return
      probabilities.push({ name: t.name, p })
      if (p >= th.toolNoulFloor) selected.push(t.name)
    })
    return { selected, probabilities, model, usage, candidateCount: tools.length }
  } catch { return null }
}

/**
 * 用 Jev 判定 shell 命令风险。失败 → null（调用方按现有行为放行）。
 * @returns {Promise<null|{risk:'readonly'|'reversible'|'destructive', confidence:number, model, usage}>}
 */
export async function assessShellRiskWithJev({ client, command, cwd = '', signal = null } = {}) {
  if (!client?.configured || !command) return null
  try {
    const { answers, model, usage } = await client.systemOne({
      state: { command, cwd: cwd || '' }, questions: { risk: SHELL_RISK_QUESTION }, signal,
    })
    const ans = answers?.risk
    const risk = String(ans?.choice || '').toLowerCase()
    const confidence = Number(ans?.confidence)
    if (!SHELL_RISKS.includes(risk) || !Number.isFinite(confidence)) return null
    return { risk, confidence, model, usage }
  } catch { return null }
}

/**
 * shell 风险门控（fail-closed）：
 *  - 不可用/失败（result=null）→ 放行并标记 fallback（回退现有行为，不静默阻断只读命令）
 *  - destructive → **默认一律拒绝**（terminal 无审批，Jev 是唯一闸门）；仅当显式开启
 *    allowDestructive 时才允许"高置信（≥ terminalRiskFloor）"放行（文档三段式）
 *  - readonly/reversible → 放行
 * @param {object} result assessShellRiskWithJev 结果或 null
 * @param {object} thresholds 阈值覆盖
 * @param {object} opt { allowDestructive?:boolean }
 */
export function evaluateShellRisk(result, thresholds = {}, { allowDestructive = false } = {}) {
  const th = resolveThresholds(thresholds)
  if (!result) return { allow: true, fallback: true, risk: null, confidence: null }
  if (result.risk === 'destructive') {
    if (!allowDestructive) {
      return {
        allow: false, fallback: false, risk: result.risk, confidence: result.confidence,
        reason: `Jev 判定为破坏性命令（置信度 ${result.confidence}），默认拒绝执行。如确需执行，请先让用户明确确认；或在配置中开启 agent.jev.allowDestructive。`,
      }
    }
    if (!(result.confidence >= th.terminalRiskFloor)) {
      return {
        allow: false, fallback: false, risk: result.risk, confidence: result.confidence,
        reason: `Jev 判定为破坏性命令，但置信度不足（${result.confidence} < ${th.terminalRiskFloor}），已拒绝执行`,
      }
    }
  }
  return { allow: true, fallback: false, risk: result.risk, confidence: result.confidence }
}
