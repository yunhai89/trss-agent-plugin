/**
 * ActionTools —— Planner 的四个动作工具定义与校验（指南 §11.2）。
 *
 * 只有 human_reply / human_react 产生对外消息；human_wait / human_ignore 终结本轮但不发送。
 * 同一 Planner 轮最多接受一个终止动作；多个发送动作 → 取最高优先级一个，其余记 schema violation，绝不多发。
 * targetMessageId 必须存在于当前 buffer 快照，否则拒绝（防止模型编造目标）。
 */

/** 工具优先级（多发时取最高；reply > react > wait > ignore） */
export const ACTION_PRIORITY = { human_reply: 4, human_react: 3, human_wait: 2, human_ignore: 1 }
export const TERMINAL_ACTIONS = new Set(Object.keys(ACTION_PRIORITY))
export const SEND_ACTIONS = new Set(['human_reply', 'human_react'])

/** Provider 用的工具定义数组（{name,description,parameters}）。 */
export const ACTION_TOOLS = [
  {
    name: 'human_reply',
    description: '决定参与对话、要发出可见回复时调用。只描述回复意图和要点，不要直接写完整台词（台词由系统另行生成）。replyGuide 描述要回复什么/针对哪句话/情感态度。',
    parameters: {
      type: 'object',
      required: ['targetMessageId', 'replyGuide'],
      properties: {
        targetMessageId: { type: 'string', description: '要回复的目标消息 id（必须来自上下文中真实存在的消息）' },
        replyGuide: { type: 'string', description: '回复意图：针对什么、要表达什么、语气', maxLength: 500 },
        referenceInfo: { type: 'string', description: '可选：回复可参考的事实/记忆要点', maxLength: 1200 },
        quote: { type: 'boolean', description: '是否引用目标消息（默认 false，忙碌时可 true）', default: false },
        toneHint: { type: 'string', description: '可选：语气提示（如「轻松」「认真」）', maxLength: 80 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'human_react',
    description: '只用一个已有表情/贴纸表达反应、不发送文字时调用。第一版可能等同记录意图。',
    parameters: {
      type: 'object',
      required: ['targetMessageId', 'intent'],
      properties: {
        targetMessageId: { type: 'string', description: '反应针对的目标消息 id' },
        intent: { type: 'string', description: '反应意图（如「赞同」「好笑」「惊讶」）', maxLength: 80 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'human_wait',
    description: '局面还在发展、稍后再看时调用。等待期间收到新消息会重新评估。',
    parameters: {
      type: 'object',
      required: ['seconds', 'reason'],
      properties: {
        seconds: { type: 'integer', minimum: 3, maximum: 120, description: '建议等待秒数（3-120）' },
        reason: { type: 'string', description: '等待理由', maxLength: 160 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'human_ignore',
    description: '明确判断此刻不应参与时调用（或直接不调用任何工具也等同忽略）。',
    parameters: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', description: '忽略理由', maxLength: 160 },
      },
      additionalProperties: false,
    },
  },
]

/** 动作名称 → 中文标签（trace 用） */
export const ACTION_LABEL = { human_reply: '回复', human_react: '表情反应', human_wait: '等待', human_ignore: '沉默' }

/** 不发送的终局动作 */
export function isSilentAction(type) { return type === 'human_wait' || type === 'human_ignore' }

/**
 * 校验单个工具调用 → 归一化为动作对象。
 * @param {{name:string, arguments:object, id?:string}} tc
 * @param {object} ctx { hasTarget:(id)=>boolean }
 * @returns {{ok:boolean, action?:object, error?:string, violation?:string}}
 */
export function validateActionCall(tc, { hasTarget } = {}) {
  const name = tc?.name
  if (!TERMINAL_ACTIONS.has(name)) {
    return { ok: false, violation: `unknown_action:${name}` }
  }
  let args = tc?.arguments
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return { ok: false, violation: `bad_json:${name}` } } }
  if (!args || typeof args !== 'object') return { ok: false, violation: `no_args:${name}` }

  // 通用：targetMessageId 必须存在（reply/react 需要）
  if (name === 'human_reply' || name === 'human_react') {
    const tid = String(args.targetMessageId || '')
    if (!tid) return { ok: false, violation: `${name}:missing_target`, action: { type: name } }
    if (typeof hasTarget === 'function' && !hasTarget(tid)) {
      return { ok: false, violation: `${name}:target_not_found:${tid.slice(0, 24)}`, action: { type: name } }
    }
  }

  // wait：seconds 范围
  if (name === 'human_wait') {
    let sec = Number(args.seconds)
    if (!Number.isFinite(sec)) return { ok: false, violation: 'human_wait:bad_seconds' }
    sec = Math.max(3, Math.min(120, Math.round(sec)))
    args.seconds = sec
  }

  // 长度上限裁剪（防超长 prompt 注入）
  const LIMITS = { replyGuide: 500, referenceInfo: 1200, toneHint: 80, intent: 80, reason: 160 }
  for (const [k, max] of Object.entries(LIMITS)) {
    if (typeof args[k] === 'string' && args[k].length > max) args[k] = args[k].slice(0, max)
  }

  const action = { type: name, toolCallId: tc?.id || null }
  if (name === 'human_reply') {
    action.targetMessageId = String(args.targetMessageId)
    action.replyGuide = String(args.replyGuide || '')
    if (args.referenceInfo) action.referenceInfo = String(args.referenceInfo)
    action.quote = args.quote === true
    if (args.toneHint) action.toneHint = String(args.toneHint)
  } else if (name === 'human_react') {
    action.targetMessageId = String(args.targetMessageId)
    action.intent = String(args.intent || '')
  } else if (name === 'human_wait') {
    action.seconds = args.seconds
    action.reason = String(args.reason || '')
  } else { // human_ignore
    action.reason = String(args.reason || '')
  }
  return { ok: true, action }
}

/**
 * 从一轮的多个工具调用中选出唯一终止动作。
 * - 忽略非终止/未知工具。
 * - 多个发送动作：取优先级最高者；其余记 violations（绝不多发）。
 * - 全部非法或无工具：返回 {type:'ignore'}（等同沉默）。
 * @returns {{action:object, violations:string[]}}
 */
export function pickSingleAction(toolCalls = [], ctx = {}) {
  const violations = []
  const valid = []
  for (const tc of toolCalls) {
    const r = validateActionCall(tc, ctx)
    if (r.ok) valid.push(r.action)
    else if (r.violation) violations.push(r.violation)
  }
  if (!valid.length) return { action: { type: 'human_ignore', reason: violations.length ? 'all_invalid' : 'no_tool', toolCallId: null }, violations }
  valid.sort((a, b) => (ACTION_PRIORITY[b.type] || 0) - (ACTION_PRIORITY[a.type] || 0))
  const chosen = valid[0]
  // 其余同为发送动作的多余 → violation
  for (let i = 1; i < valid.length; i++) {
    if (SEND_ACTIONS.has(valid[i].type) && SEND_ACTIONS.has(chosen.type)) {
      violations.push(`multi_send_drop:${valid[i].type}`)
    }
  }
  return { action: chosen, violations }
}
