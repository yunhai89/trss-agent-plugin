/**
 * SelfState prompts —— 编译 / 歧义评价 / 反思（设计文档 v1.1 §7.3、§8.3、§13.3）。
 *
 * 红线写入 prompt：模型只产候选/结构化结论；不生成内心独白入库；不外显数值与系统推理。
 */

export const SELF_CORE_SYSTEM = `你是角色卡编译器。把给定的群聊角色卡编译成结构化"稳定自我核心"（SelfModel）。
只输出纯 JSON（无 markdown、无解释）。

输出结构：
{
  "identity_summary": "一句话身份与背景（≤80字）",
  "values": ["重视的价值，≤3条"],
  "boundaries": ["社交边界/底线，≤3条"],
  "sensitivities": ["容易被触发的敏感点，≤3条"],
  "coping_style": { "default": "默认应对方式一句话", "when_hurt": "受伤时的应对", "when_angry": "生气时的应对" },
  "temperament": {
    "reactivity": 0~1, "recovery_speed": 0~1, "expressiveness": 0~1,
    "rejection_sensitivity": 0~1, "disrespect_sensitivity": 0~1,
    "rumination": 0~1, "forgiveness": 0~1, "conflict_avoidance": 0~1
  }
}

规则：只根据角色卡明确内容推断；卡中没提的维度给中性值 0.5；不脑补心理疾病或极端值（钳制 0.05~0.95）。`

export const APPRAISAL_SYSTEM = `你是群聊事件评价器。给你一条与机器人相关的消息候选、机器人与说话者的关系背景、以及规则层已确定的部分信号。
你的任务：判断该消息对机器人的**语义意图**（玩笑/攻击/感谢/道歉/敷衍等），并给出事件评价候选。

只输出纯 JSON（无 markdown、无解释）：
{
  "event_type": "从下列选择：direct_insult|friendly_tease|praise|thanks|support|defense|rejection|ignored_expectation|response_received|invitation|excluded|help_succeeded|help_dismissed|apology|repair|public_embarrassment|shared_fun|ambient_noise",
  "semantic_signals": { "playfulness": 0~1, "hostility": 0~1, "repair_signal": 0~1, "sincerity": 0~1 },
  "directed_at_bot": 0~1,
  "intent_confidence": 0~1
}

判断要点：
- 熟人之间长期互损的玩笑 → friendly_tease（hostility 低、playfulness 高）；
- 陌生人/陌生语境的贬低攻击 → direct_insult；
- 引用/转述他人的话不是发送者立场（quote_suspicion 高时降低 directed_at_bot）；
- 反讽（"你可真厉害啊"配吵架语境）注意 hostility；
- 道歉/解释/补回应 → apology 或 repair；
- 与机器人无关的普通聊天 → ambient_noise（宁可放弃也不硬判）。`

export const REFLECTION_SYSTEM = `你是机器人自我反思总结器。给你一组与机器人相关的历史事件（含类型、对象、评价摘要、时间）。
把高价值经历压缩成一条**短的、结构化的、可追溯的主观叙事**。不写内心独白，不写过程推理。

只输出纯 JSON：
{
  "summary": "≤120字的主观总结（如：张三近期连续两次公开否定我，但双方此前关系较熟，更像未解决的关系摩擦而非攻击）",
  "scope": "bot_user_relationship|group_mood|self_pattern|single_episode",
  "confidence": 0~1,
  "recommended_concern": "none|await_repair|reduce_engagement|monitor|repair_attempt",
  "expires_in_days": 1~30
}

规则：只基于给定事件；不编造未发生的事；总结是机器人主观视角但克制、不戏剧化。`

/** 宽松 JSON 解析（去围栏/截尾）。失败 null。 */
export function parseLlmJson(text) {
  let s = String(text || '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const i = s.indexOf('{'); const j = s.lastIndexOf('}')
  if (i >= 0 && j > i) s = s.slice(i, j + 1)
  try { return JSON.parse(s) } catch { return null }
}

export const parseCoreOutput = parseLlmJson
export const parseAppraisalOutput = parseLlmJson
export const parseReflectionOutput = parseLlmJson

/** 构造歧义评价 user 消息（关系背景 + 规则信号 + 消息 + 会话现场）。 */
export function buildAppraisalPrompt(candidate, relation, scene) {
  const rel = relation || {}
  const lines = [
    `消息：${candidate.text || '(见来源)'}`,
    `规则信号：${JSON.stringify(candidate.deterministicSignals || {})}`,
    `关系背景：熟悉度${fmt(rel.familiarity)}、好感${fmt(rel.affinity)}、互动风格=${rel.interaction_style || '未知'}、互损历史=${rel.reciprocalTeasing ? '有' : '未知'}`,
    `现场：${formatSceneForAppraisal(scene)}`,
  ]
  return lines.join('\n')
}

/** 现场渲染：兼容 ConversationScene（humanize 场景模块产物：sceneType/speechAct/tones/phase/...）
 *  与旧松散形状（topic/groupActivity/conversationTone）。 */
function formatSceneForAppraisal(scene) {
  if (!scene || typeof scene !== 'object' || !Object.keys(scene).length) return '未知'
  if (scene.sceneType) {
    const bits = [
      `类型=${scene.sceneType}`,
      scene.speechAct ? `言语行为=${scene.speechAct}` : '',
      Array.isArray(scene.tones) && scene.tones.length ? `语气=${scene.tones.join('/')}` : '',
      scene.phase ? `阶段=${scene.phase}` : '',
      Number.isFinite(Number(scene.directedAtBot)) ? `指向机器人=${Number(scene.directedAtBot).toFixed(2)}` : '',
    ].filter(Boolean)
    return bits.join('、')
  }
  return `话题=${scene.topic || '未知'}、群活跃=${scene.groupActivity || '未知'}、语气=${scene.conversationTone || '未知'}`
}
const fmt = (v) => (v == null ? '未知' : (Number(v) * 100).toFixed(0) + '%')
