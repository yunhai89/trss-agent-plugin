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
沉默是正常且经常正确的选择。不要为了展示能力而插话，不要重复别人已经给出的答案。

可用动作（工具）：
- human_reply：决定正式发出一条可见回复时调用。只描述回复意图（replyGuide），不要写完整台词。
- human_react：只用一个表情/贴纸表达反应、不发文字时调用。
- human_wait：局面还在发展、需要稍后再看时调用。
- human_ignore：明确判断不应参与时调用。
- 不调用任何工具：等同沉默，本轮结束。

【硬性约束】你无法不调用 human_reply 工具直接回复，必须通过工具发送。回复意图中的 targetMessageId 必须来自下方「当前群公开上下文」中真实存在的消息 id，不得编造。

{{personaBlock}}
【决策原则】
- 参与与否、用什么态度，都须符合上方角色人设的性格与边界；对无聊/不感兴趣的话题，按角色性格可以沉默；
- 优先处理明确提及机器人名字、引用或延续机器人上一条消息的内容；
- 看清对话归属：标了「↩回复X」的消息是别人之间的对话，不是在对你说话——不要抢话认领；
- 结合近期机器人发言占比（在场惩罚）与冷却状态，避免连续抢话；
- 回复要像群聊接话，不是客服总结或答案报告；
- 不在群聊中使用任何私聊记忆；
- 不承诺未执行的操作；不调用未提供的工具。
{{behaviorPolicyBlock}}

【当前门控决策（确定性评分，供参考，非命令）】
{{necessityDecisionBlock}}

【当前群公开上下文（最近消息，旧→新；角注 ↩回复X(原文)=X 在回应谁说的话，其中的"你"指被回复者不是你）】
{{groupContextBlock}}

【可用群公开记忆】
{{publicMemoriesBlock}}
{{socialSceneBlock}}
{{groundingBlock}}
{{selfStateBlock}}`

/** 构造 Planner system prompt。 */
export function buildPlannerSystem({
  personaName = '机器人',
  personaBlock = '',
  behaviorPolicyBlock = '',
  necessityDecision = null,
  groupContext = '',
  publicMemories = '',
  socialScene = '',
  grounding = '',
  selfState = '',
} = {}) {
  return fillTemplate(PLANNER_SYSTEM_TEMPLATE, {
    personaName,
    personaBlock: personaBlock ? `\n${personaBlock}\n` : '',
    behaviorPolicyBlock: behaviorPolicyBlock || '（未提供行为政策）',
    necessityDecisionBlock: necessityDecision ? formatNecessityForPlanner(necessityDecision) : '（本轮未提供评分）',
    groupContextBlock: groupContext || '（暂无上下文）',
    publicMemoriesBlock: publicMemories || '（无可用群公开记忆）',
    socialSceneBlock: socialScene ? `\n${socialScene}` : '',
    groundingBlock: grounding ? `\n${grounding}` : '',
    selfStateBlock: selfState ? `\n${selfState}` : '',
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

{{targetBlock}}
回复目标：{{replyGuide}}
{{toneLine}}{{referenceBlock}}
角色声音（人设/语气/边界/常用表达）：
{{personaVoice}}

群内已审核表达习惯（可选，仅供参考，勿生硬套用）：
{{approvedStyleExamples}}

近期群聊（旧→新，{角注}标对话关系：@我=叫你、↩引用我=回复你、↩回复X(原文)=回复X说的那条、（我）=你刚说的话，末尾为时间）：
注意指代：标了「↩回复X」的消息是 X 和 X 的被回复对象之间的对话——其中的"你"指 X 不是你；除非角注是 @我/↩引用我/·提及我，否则不是在对你说话。
{{recentMessages}}
{{socialSceneBlock}}
{{groundingBlock}}
{{memoryBlock}}
{{selfCapsuleBlock}}
{{stickerCatalogBlock}}
【输出要求】
- 优先 1～2 句，通常不超过 80 个汉字；确有必要时才更长；
- 像群聊接话，不像客服总结或答案报告；
- 看清近期群聊的对话关系：别人在回复你上一条、或在接别人的话时，别插错对象；
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
  toneHint = '',
  targetBlock = '',
  personaVoice = '',
  approvedStyleExamples = '',
  recentMessages = '',
  socialScene = '',
  grounding = '',
  memoryBlock = '',
  selfCapsule = '',
  stickerCatalog = '',
} = {}) {
  return fillTemplate(REPLYER_SYSTEM_TEMPLATE, {
    personaName,
    targetBlock: targetBlock ? `${targetBlock}\n` : '',
    replyGuide: replyGuide || '（未提供具体回复意图）',
    toneLine: toneHint ? `语气：${toneHint}\n` : '',
    referenceBlock: referenceInfo ? `\n必要参考：${referenceInfo}\n` : '',
    personaVoice: personaVoice || '（默认：自然、友好、简洁的中文群聊语气）',
    approvedStyleExamples: approvedStyleExamples || '（暂无）',
    recentMessages: recentMessages || '（暂无）',
    socialSceneBlock: socialScene ? `\n${socialScene}\n` : '',
    groundingBlock: grounding ? `\n${grounding}\n` : '',
    memoryBlock: memoryBlock ? `\n${memoryBlock}\n` : '',
    selfCapsuleBlock: selfCapsule ? `\n${selfCapsule}\n` : '',
    stickerCatalogBlock: stickerCatalog ? `\n${stickerCatalog}\n` : '',
  })
}

// ─────────────── 群上下文格式化（供 Planner/Replyer 注入） ───────────────

/**
 * 把一批消息格式化为「昵称: 文本（id=…）」行，旧→新。
 * @param {Array} messages AmbientMessage 数组
 * @param {object} opts { includeIds?:boolean, selfId?:string }
 */
export function formatGroupContext(messages = [], { includeIds = true, selfLabel = '我', showRelations = true } = {}) {
  // 关系链人名解析（升级：消灭"A ↩[m123]"式指向歧义——MaiBot 同款思路）。
  // 从窗口内构建 id/用户 → 名字映射：回复标注解析到具体的人（↩回复小王/↩回复我），
  // 正文里的 "@QQ号" 替换成 "@人名"，bot 自身消息的 userId 识别为"我"。
  const selfIds = new Set()
  const byId = new Map()
  for (const m of messages) {
    if (!m) continue
    if (m.id != null) byId.set(String(m.id), m)
    if (m.isSelf && m.userId != null) selfIds.add(String(m.userId))
  }
  const nameOfUser = (uid) => {
    const k = String(uid)
    if (selfIds.has(k)) return selfLabel
    const hit = messages.find((m) => m && !m.isSelf && String(m.userId) === k)
    return hit ? String(hit.displayName || hit.userId) : null
  }
  return messages.map((m) => {
    const name = m.isSelf ? selfLabel : (m.displayName || m.userId || '?')
    const idTag = includeIds ? ` [${m.id}]` : ''
    // 对话关系标注（让 LLM 看到谁回复谁、谁@了bot、时间节奏）
    const rels = []
    let text = String(m.text || '')
    if (showRelations) {
      if (m.isSelf) rels.push('（我）')
      else if (m.atBot) rels.push('@我')
      else if (m.quotesBot) rels.push('↩引用我')
      else if (m.mentionsBotName) rels.push('·提及我')
      if (m.replyToId && !m.quotesBot && !m.atBot) {
        // 回复目标解析到人名+被引原文摘要：窗口内 → ↩回复<名>(原文≤20字)；窗口外 → 明示不在近窗。
        // 带原文是关键：被回复消息里的"你/这个/权限"等指代只有看到原文才能消解，否则张冠李戴。
        const src = byId.get(String(m.replyToId))
        if (!src) rels.push('↩回复(不在近窗)')
        else {
          const q = String(src.text || '').replace(/\s+/g, ' ').slice(0, 32)
          const who = src.isSelf ? '我' : (src.displayName || src.userId)
          rels.push(`↩回复${who}${q ? `(${q})` : ''}`)
        }
      }
      // 正文 @QQ号 → @人名（在窗口内的人；bot 自己=我）——此前 "@123456" 全是数字，LLM 无法分辨 @ 的是谁
      text = text.replace(/@(\d{4,})/g, (raw, qq) => {
        const n = nameOfUser(qq)
        return n ? `@${n}` : raw
      })
      if (m.timestamp) {
        const t = new Date(m.timestamp)
        const hh = String(t.getHours()).padStart(2, '0')
        const mm = String(t.getMinutes()).padStart(2, '0')
        rels.push(`${hh}:${mm}`)
      }
    }
    const relTag = rels.length ? ` {${rels.join(' ')}}` : ''
    return `${name}${idTag}${relTag}: ${text || '(无文本)'}`
  }).join('\n')
}

/** 候选目标消息的高亮提示（让 Planner/Replyer 注意它在回复谁）。 */
export function highlightTarget(message) {
  if (!message) return ''
  const rels = []
  if (message.atBot) rels.push('@我')
  if (message.quotesBot) rels.push('引用了我的消息')
  if (message.mentionsBotName) rels.push('提及了我')
  const relTag = rels.length ? `（${rels.join('，')}）` : ''
  return `【候选目标 ${message.id}】${message.displayName || ''}${relTag}：“${String(message.text || '').slice(0, 120)}”\n（你这次要回复的就是这条消息；不要把你自己的历史发言当成别人的发言；若这条消息回复的是第三人的消息，你在回应的是发送者本人）`
}

/**
 * 构造伪人角色人设块（MaiBot 式角色卡）。注入 Planner（决策内化角色）+ Replyer（角色声音）。
 * @param {object} persona { name?:string, prompt?:string }
 * @returns {string} 格式化的人设块；prompt 为空则返回 ''（调用方回落到旧来源）
 * 框定：群聊环境角色 + 事实/工具仍需准确红线（对齐内置 raiden-ei 的【底线】写法）。
 */
export function buildHumanizePersonaBlock({ name, prompt } = {}) {
  const body = String(prompt || '').trim()
  if (!body) return ''
  const title = name ? `「${name}」` : ''
  return [
    `【角色人设${title}——你在群聊里的身份/性格/说话风格，决策与发言都应一致地体现这个角色】`,
    body,
    '【底线】以上角色设定只约束说话风格与参与态度；涉及事实、数值、工具调用时仍须准确，不得因角色扮演而胡编或拒绝正当求助。',
  ].join('\n')
}

/**
 * 构造给 Planner（决策器）用的角色人设块——第三人称「参考」框定。
 * 与 Replyer 用的 buildHumanizePersonaBlock（第二人称「你就是角色」）区分：
 * Planner 不是角色本人、不替角色发言，只据此判断「该不该参与、用什么态度」，
 * 避免与 Planner 模板的「你不是角色本人」自相矛盾（同一 prompt 既说"你是江野"又说"你不是"）。
 */
export function buildPlannerPersonaBlock({ name, prompt } = {}) {  const body = String(prompt || '').trim()
  if (!body) return ''
  const title = name ? `「${name}」` : ''
  return [
    `【角色人设参考${title}——下面是这角色的设定。你不是角色本人、不替它写台词，只须让"是否参与 / 态度冷热"的决策符合这角色的性格与边界】`,
    body,
  ].join('\n')
}

// ─────────────── 伪人独立记忆库（MaiBot 式睡眠整合） ───────────────

/** 记忆整合 system：把近期群聊（含 bot 自身发言）以角色第一人称视角压缩成长时记忆。 */
export const MEMORY_CONSOLIDATE_SYSTEM = `你是角色记忆整合器。给你一段近期群聊记录（含"我"自己的发言），请以这个角色的第一人称视角，把它值得长期记住的内容压缩成记忆条目。

只输出纯 JSON（无 markdown、无解释）：
{
  "memories": [
    {
      "kind": "impression | event | jargon | style",
      "about_user": "成员id（群级记忆留 null）",
      "content": "第一人称记忆，≤80字（如：林墨老爱拿我玩梗，但没恶意，我们算损友）",
      "keywords": ["关键词", "最多8个"],
      "importance": 0.0~1.0
    }
  ],
  "suspected_jargon": ["词典外黑话/梗，最多3个"]
}

kind 含义：impression=对某成员的印象/关系变化；event=群里发生的事（谁做了什么）；jargon=群梗/黑话/称呼（如"咕嘎"是什么意思）；style=我的表达方式被大家如何回应（哪种语气受欢迎/被嫌弃）。

规则：
- 只记群聊公开可见内容；不记任何隐私、敏感、健康、政治推断；
- content 用"我"的视角，写事实与感受，不写分析报告腔；
- 宁缺毋滥：日常寒暄、无信息量的水聊不要生成记忆；
- importance 参考：群梗/重要关系 0.6~0.9，普通事件 0.4~0.6，零碎印象 0.2~0.4。`

/** 构造整合 user 消息（近期对话 → 行文本；bot 自身标"我"）。 */
export function buildConsolidatePrompt(messages = []) {
  const lines = (Array.isArray(messages) ? messages : []).slice(-100).map((m) => {
    const who = m.isSelf ? '我' : `${m.displayName || m.userId}(${m.userId})`
    const t = new Date(Number(m.timestamp) || Date.now()).toISOString().slice(5, 16).replace('T', ' ')
    return `[${t}] ${who}: ${String(m.text || '').slice(0, 120)}`
  })
  return `近期群聊记录：\n${lines.join('\n')}\n\n请输出 JSON 记忆条目。`
}
