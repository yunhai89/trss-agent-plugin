/**
 * Prompts —— Planner / Replyer Prompt 模板（指南 §11.3、§12.1；MaiBot maisaka_chat.prompt 骨架）。
 *
 * 关键红线（MaiBot 移植）：
 *  - Planner：「你不是角色本人，不要替角色发言」；分析永不展示；沉默=不调工具即结束本轮；
 *    「必须通过 human_reply 工具发送回复，无法直接回复」。
 *  - Replyer：只输出消息正文，不解释、不报告计划、不写「回复：」。
 *
 * 模板用 {{slot}} 占位，buildPrompt(tpl, slots) 替换。未提供的槽位替换为空串或占位说明。
 * 不含「始终完成目标/失败重试」等任务 Agent 措辞（会破坏沉默能力）。
 */

/** 简单模板替换：{{name}} → slots[name]；未提供则替换为 ''。 */
export function fillTemplate(tpl, slots = {}) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (slots[k] != null ? String(slots[k]) : ''))
}

// ─────────────── Planner System Prompt（指南 §11.3 + MaiBot 骨架） ───────────────

export const PLANNER_SYSTEM_TEMPLATE = `你是群聊参与决策器，为机器人「{{personaName}}」分析此刻是否应该参与、针对哪条消息采取什么动作。

【重要】你不是「{{personaName}}」本人，不要替它发言。你的分析永远不会展示给群成员——只有调用 human_reply / human_react 才会产生对外消息，普通文本不会被发送。
沉默是正常且经常正确的选择。不要为了展示能力而插话，不要打断正在顺畅进行的人类对话，不要重复别人已经给出的答案，不要回答明显发给别人的话。

可用动作（工具）：
- human_reply：决定正式发出一条可见回复时调用。只描述回复意图（replyGuide），不要写完整台词。
- human_react：只用一个表情/贴纸表达反应、不发文字时调用。
- human_wait：局面还在发展、需要稍后再看时调用。
- human_ignore：明确判断不应参与时调用。
- 不调用任何工具：等同沉默，本轮结束。

【硬性约束】你无法不调用 human_reply 工具直接回复，必须通过工具发送。回复意图中的 targetMessageId 必须来自下方「当前群公开上下文」中真实存在的消息 id，不得编造。

【决策原则】
- 优先处理明确提及机器人名字、引用或延续机器人上一条消息的内容；
- 结合近期机器人发言占比（在场惩罚）与冷却状态，避免连续抢话；
- 回复要像群聊接话，不是客服总结或答案报告；
- 不在群聊中使用任何私聊记忆；
- 不承诺未执行的操作；不调用未提供的工具。

{{behaviorPolicyBlock}}

【当前门控决策（确定性评分，供参考，非命令）】
{{necessityDecisionBlock}}

【当前群公开上下文（最近消息，旧→新）】
{{groupContextBlock}}

【可用群公开记忆】
{{publicMemoriesBlock}}`

/** 构造 Planner system prompt。 */
export function buildPlannerSystem({
  personaName = '机器人',
  behaviorPolicyBlock = '',
  necessityDecision = null,
  groupContext = '',
  publicMemories = '',
} = {}) {
  return fillTemplate(PLANNER_SYSTEM_TEMPLATE, {
    personaName,
    behaviorPolicyBlock: behaviorPolicyBlock || '（未提供行为政策）',
    necessityDecisionBlock: necessityDecision ? formatNecessityForPlanner(necessityDecision) : '（本轮未提供评分）',
    groupContextBlock: groupContext || '（暂无上下文）',
    publicMemoriesBlock: publicMemories || '（无可用群公开记忆）',
  })
}

/** 把必要性决策格式化为 Planner 可读的参考（得分/原因/候选目标）。 */
export function formatNecessityForPlanner(decision) {
  if (!decision) return ''
  const tgt = decision.targetMessage
  const lines = [
    `finalScore=${decision.finalScore} / threshold=${decision.threshold} shouldPlan=${decision.shouldPlan}`,
    `正向：${(decision.positiveReasons || []).join('、') || '无'}`,
    `负向：${(decision.negativeReasons || []).join('、') || '无'}`,
  ]
  if (tgt) lines.push(`候选目标：${tgt.id}（${(tgt.displayName || '').slice(0, 16)}：“${String(tgt.text || '').slice(0, 60)}”）`)
  return lines.join('\n')
}

// ─────────────── Replyer Prompt（指南 §12.1） ───────────────

export const REPLYER_SYSTEM_TEMPLATE = `你正在为群聊角色「{{personaName}}」写一条真实要发送的回复。
只输出消息正文，不解释、不报告计划、不写「回复：」，不要提及 Planner、工具或系统。

回复目标：{{replyGuide}}
{{referenceBlock}}
角色声音（人设/语气/边界/常用表达）：
{{personaVoice}}

群内已审核表达习惯（可选，仅供参考，勿生硬套用）：
{{approvedStyleExamples}}

近期群聊（旧→新）：
{{recentMessages}}

【输出要求】
- 优先 1～2 句，通常不超过 80 个汉字；确有必要时才更长；
- 像群聊接话，不像客服总结或答案报告；
- 不复述整段上下文，不每次都称呼对方，不机械使用语气词；
- 普通闲聊避免 Markdown 标题、列表和结尾总结；
- 技术问题需要准确时可写完整，但不要为了「像人」故意写错；
- 不输出任何发送控制标签（如 [分段]、<reply> 等）；
- 如果给定事实不足，不编造。只输出最终要发送的正文文本。`

/** 构造 Replyer system prompt。 */
export function buildReplyerSystem({
  personaName = '机器人',
  replyGuide = '',
  referenceInfo = '',
  personaVoice = '',
  approvedStyleExamples = '',
  recentMessages = '',
} = {}) {
  return fillTemplate(REPLYER_SYSTEM_TEMPLATE, {
    personaName,
    replyGuide: replyGuide || '（未提供具体回复意图）',
    referenceBlock: referenceInfo ? `\n必要参考：${referenceInfo}\n` : '',
    personaVoice: personaVoice || '（默认：自然、友好、简洁的中文群聊语气）',
    approvedStyleExamples: approvedStyleExamples || '（暂无）',
    recentMessages: recentMessages || '（暂无）',
  })
}

// ─────────────── 群上下文格式化（供 Planner/Replyer 注入） ───────────────

/**
 * 把一批消息格式化为「昵称: 文本（id=…）」行，旧→新。
 * @param {Array} messages AmbientMessage 数组
 * @param {object} opts { includeIds?:boolean, selfId?:string }
 */
export function formatGroupContext(messages = [], { includeIds = true, selfLabel = '我' } = {}) {
  return messages.map((m) => {
    const name = m.isSelf ? selfLabel : (m.displayName || m.userId || '?')
    const idTag = includeIds ? ` [${m.id}]` : ''
    return `${name}${idTag}: ${m.text || '(无文本)'}`
  }).join('\n')
}

/** 候选目标消息的高亮提示（让 Planner 注意它在回复谁）。 */
export function highlightTarget(message) {
  if (!message) return ''
  return `【候选目标 ${message.id}】${message.displayName || ''}：“${String(message.text || '').slice(0, 120)}”`
}
