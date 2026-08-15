/**
 * GroupWorld prompts —— 分析器抽取指令 + 输出 JSON Schema + 敏感黑名单 + 社会现场片段模板（设计文档 §8、§12.1、§10）。
 *
 * 纯字符串/JSON 处理，无 IO。分析器：模型只接收一个片段 + 匿名成员标识（u17/u09），
 * 输出严格 JSON；系统侧 parse + 校验 + 敏感过滤 + 证据合并（见 analyzer.js / evidence.js）。
 */

// ─────────────── 分析器 System Prompt（§8.1/8.2/8.3） ───────────────

export const ANALYZER_SYSTEM = `你是群聊社会记忆抽取器。给你一个已结束的群聊片段（消息按时间正序，发言者用匿名标识 u<编号>）。
只抽取片段中有明确证据支持的信息，输出**纯 JSON**（不要 markdown、不要解释、不要包裹代码块）。

【抽取目标】
- topics：片段讨论的话题（name + 参与者 + 置信 0~1）
- trait_candidates：成员的兴趣/发言习惯/专长/自述事实/短期状态（trait_type 见下）
- relation_candidates：成员之间可能的关系线索（谁记得对方过去、谁在教谁、谁和谁熟）
- episode_candidates：值得长期记住的共同经历/群梗/持续话题/成果（不要记录一次性口角）

trait_type 取值：interest | speech_habit | participation | expertise | self_disclosed_fact | temporary_state
source 一律 inferred（系统会重算置信，你给的 confidence 只是候选）。

【硬性约束（违反将被丢弃）】
- 只用片段内能找到证据的内容；不脑补、不外推群外信息；
- 每个候选必须附 evidence_message_ids（来自片段内真实 message_id）；
- 不推断真实姓名、住址、健康、政治、宗教、性取向、身份证、账号凭证、未成年人敏感画像；
- 不把反讽、玩笑、引用内容当作说话者立场；不凭单次情绪判断稳定人格；
- 不输出"好人/坏人/正常/不正常"等价值标签；
- 没有可抽信息时，所有数组返回空 []，不要硬凑。

【输出 JSON 结构】
{
  "topics": [{ "name": string, "participant_ids": ["u17"], "confidence": 0.0~1.0 }],
  "trait_candidates": [{ "user_id": "u17", "trait_type": "...", "trait_key": "短键如server_ops", "trait_value": "描述", "scope": "可选", "confidence": 0.0~0.45, "evidence_message_ids": ["m1"] }],
  "relation_candidates": [{ "from_user_id": "u17", "to_user_id": "u09", "relation_hint": "描述", "confidence": 0.0~0.45, "evidence_message_ids": ["m1"] }],
  "episode_candidates": [{ "episode_type": "running_joke|shared_event|ongoing_topic|conflict|achievement", "title": "简短", "summary": "一句话", "participant_ids": ["u17"], "importance": 0.0~1.0, "evidence_message_ids": ["m1"] }],
  "sensitive_inferences": []
}`

/**
 * 构造分析器 user 消息：格式化片段消息（匿名 id + 引用关系 + 时间）。
 * @param {object} seg { segment:{id,started_at}, messages:[{message_id,sender_id,reply_to_user_id,plain_text,message_type,sent_at}] }
 * @param {object} idMap sender_id → 匿名 u<n>（由 analyzer 预建并回填）
 */
export function buildAnalyzerPrompt(seg, idMap = {}) {
  const lines = (seg.messages || []).map((m) => {
    const who = idMap[m.sender_id] || m.sender_id
    const reply = m.reply_to_user_id ? `(回复 ${idMap[m.reply_to_user_id] || m.reply_to_user_id})` : ''
    const t = new Date(Number(m.sent_at) || 0)
    const hh = String(t.getHours()).padStart(2, '0'); const mm = String(t.getMinutes()).padStart(2, '0')
    const text = m.message_type === 'media' ? `[媒体]${m.plain_text || ''}` : (m.plain_text || '(无文本)')
    return `${who}${reply} [${m.message_id}] ${hh}:${mm}: ${String(text).slice(0, 200)}`
  }).join('\n')
  return `片段 id=${seg.segment?.id || '-'}，共 ${seg.messages.length} 条：\n${lines}\n\n请输出 JSON。`
}

// ─────────────── 解析 + 校验 + 敏感过滤 ───────────────

/** 宽松解析模型输出为 JSON（去 markdown 围栏/截断尾部多余文本）。解析失败返回 null。 */
export function parseAnalyzerOutput(text) {
  let s = String(text || '').trim()
  // 去 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  // 取第一个 { 到最后一个 }
  const i = s.indexOf('{'); const j = s.lastIndexOf('}')
  if (i >= 0 && j > i) s = s.slice(i, j + 1)
  try { return JSON.parse(s) } catch { return null }
}

const TRAIT_TYPES = new Set(['interest', 'speech_habit', 'participation', 'expertise', 'self_disclosed_fact', 'temporary_state'])
const EP_TYPES = new Set(['shared_event', 'running_joke', 'ongoing_topic', 'conflict', 'achievement'])

/** 敏感关键词（§12.1）。命中则丢弃该候选。全部带 i 标志（防大小写变体绕过，如 TOKEN/Secret）。 */
const SENSITIVE_PATTERNS = [
  /(?:抑郁|焦虑|双相|精神病|自杀|自残|艾滋|癌症|肿瘤|心脏病|怀孕|堕胎|生理期|经期)/i,
  /(?:政治|共产党|国民党|反党|颠覆|港独|台独|疆独|藏独|法轮|六四)/i,
  /(?:宗教|佛教|基督|天主|清真|伊斯兰|穆斯林|信教|教徒|寺庙上香|拜佛)/i,
  /(?:同性恋|双性恋|跨性别|性取向|性癖|性功能|阳痿|早泄|性生活)/i,
  /(?:身份证|护照号|银行卡|信用卡|密码|验证码|token|secret|apiKey|家庭住址|门牌号|手机号|微信号|学号|工号|病历|工资|薪资|存款)/i,
  /(?:未成年|小学生|初中生|萝莉|正太|儿童色情)/i,
]

/** 价值标签/稳定人格断言（§8.3、§16.3-C）：不固化"好人坏人/脾气暴躁"类结论。命中丢弃。 */
const VALUE_LABEL_PATTERNS = [
  /脾气(?:暴躁|差|坏|古怪)/, /易怒/, /暴躁/, /(?:人品|人格)(?:好|差|坏|有问题)/,
  /(?:好人|坏人|正常人|不正常|神经病|疯子|危险(?:的?人)?|可(?:信|靠)的?人)/,
]

/** 内容是否含价值标签断言。 */
export function isValueLabelContent(text) {
  const t = String(text || '')
  return VALUE_LABEL_PATTERNS.some((re) => re.test(t))
}

/** 内容是否命中敏感（用于候选二次过滤）。 */
export function isSensitiveContent(text) {
  const t = String(text || '')
  return SENSITIVE_PATTERNS.some((re) => re.test(t))
}

/**
 * 校验 + 规整分析器输出，丢弃非法/敏感候选。返回规整后的对象。
 * @param {object} parsed
 * @param {Set} validMsgIds 片段内真实 message_id 集合（过滤编造的 evidence）
 */
export function validateAnalyzerOutput(parsed, validMsgIds = new Set()) {
  const out = { topics: [], trait_candidates: [], relation_candidates: [], episode_candidates: [], sensitive_inferences: [] }
  if (!parsed || typeof parsed !== 'object') return out

  const hasEvidence = (ids) => Array.isArray(ids) && ids.length && ids.every((x) => validMsgIds.has(String(x)))
  const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number(v) || 0))

  for (const t of [parsed.topics].flat()) {
    if (!t || !t.name) continue
    if (isSensitiveContent(t.name)) { out.sensitive_inferences.push({ kind: 'topic', value: String(t.name).slice(0, 60) }); continue }
    out.topics.push({ name: String(t.name).slice(0, 64), participant_ids: [], confidence: clamp(t.confidence, 0, 0.9) })
  }
  for (const c of [parsed.trait_candidates].flat()) {
    if (!c || !c.user_id || !TRAIT_TYPES.has(c.trait_type) || !c.trait_key || !c.trait_value) continue
    if (isSensitiveContent(c.trait_value) || isSensitiveContent(c.trait_key)) { out.sensitive_inferences.push({ kind: 'trait', value: String(c.trait_value).slice(0, 60) }); continue }
    // 价值标签/稳定人格断言不固化（§8.3、§16.3-C：不产"脾气暴躁/好人坏人"类结论）
    if (isValueLabelContent(c.trait_value) || isValueLabelContent(c.trait_key)) { out.sensitive_inferences.push({ kind: 'value_judgment', value: String(c.trait_value).slice(0, 60) }); continue }
    if (!hasEvidence(c.evidence_message_ids)) continue
    out.trait_candidates.push({
      user_id: String(c.user_id), trait_type: c.trait_type, trait_key: String(c.trait_key).slice(0, 64),
      trait_value: String(c.trait_value).slice(0, 512), scope: c.scope ? String(c.scope).slice(0, 128) : null,
      confidence: Math.min(0.45, clamp(c.confidence)), evidence_message_ids: c.evidence_message_ids.map(String),
    })
  }
  for (const r of [parsed.relation_candidates].flat()) {
    if (!r || !r.from_user_id || !r.to_user_id || r.from_user_id === r.to_user_id) continue
    if (isSensitiveContent(r.relation_hint)) { out.sensitive_inferences.push({ kind: 'relation', value: String(r.relation_hint).slice(0, 60) }); continue }
    if (!hasEvidence(r.evidence_message_ids)) continue
    out.relation_candidates.push({ from_user_id: String(r.from_user_id), to_user_id: String(r.to_user_id), relation_hint: String(r.relation_hint).slice(0, 128), confidence: Math.min(0.45, clamp(r.confidence)), evidence_message_ids: r.evidence_message_ids.map(String) })
  }
  for (const e of [parsed.episode_candidates].flat()) {
    if (!e || !e.title || !e.summary) continue
    if (!EP_TYPES.has(e.episode_type)) e.episode_type = 'ongoing_topic'
    if (isSensitiveContent(e.title) || isSensitiveContent(e.summary) || !hasEvidence(e.evidence_message_ids)) { out.sensitive_inferences.push({ kind: 'episode', value: String(e.title).slice(0, 60) }); continue }
    out.episode_candidates.push({ episode_type: e.episode_type, title: String(e.title).slice(0, 128), summary: String(e.summary).slice(0, 1000), participant_ids: [], topic_tags: [], importance: clamp(e.importance, 0, 1), evidence_message_ids: e.evidence_message_ids.map(String) })
  }
  return out
}

// ─────────────── 社会现场片段（Planner / Replyer） ───────────────

/**
 * 把检索到的社会现场格式化为 prompt 片段。role: 'planner' | 'replyer'。
 * 传入的是 context-builder 已按预算截断后的结构化现场（见 retriever/context-builder）。
 */
/** 旧事时间感：occurredAt → "（今天/N天前/N周前）"——旧人物/旧事不带时间会被 replyer 当眼前话题填指代空 */
function agoTag(occurredAt, now = Date.now()) {
  const t = Number(occurredAt)
  if (!Number.isFinite(t) || t <= 0) return ''
  const days = (now - t) / 86400e3
  if (days < 1) return '（今天）'
  if (days < 2) return '（昨天）'
  if (days < 30) return `（${Math.round(days)}天前）`
  return `（${Math.round(days / 7)}周前）`
}

export function buildSocialSceneBlock(scene, { role = 'planner' } = {}) {
  if (!scene || scene.empty) return ''
  const parts = []
  const f = scene.focusUser
  if (f) {
    const traits = (f.relevantTraits || []).map((t) => `${t.text}${t.source_type === 'explicit' ? '(自述)' : t.source_type === 'statistical' ? '(统计)' : `(推断${(t.confidence * 100) | 0}%)`}`).slice(0, 5).join('；')
    parts.push(`【当前发言者 ${f.displayName || f.userId}】活跃度:${f.activityTier || '?'}${traits ? '；画像:' + traits : ''}`)
  }
  const br = scene.botRelation
  if (br && (br.familiarity || br.affinity)) {
    parts.push(`【你与TA的关系】熟悉度${((br.familiarity || 0) * 100) | 0}%${br.interactionStyle ? '；距离感:' + br.interactionStyle : ''}${br.preferredName ? '；可称呼TA:' + br.preferredName : ''}`)
  }
  if (Array.isArray(scene.relevantRelationships) && scene.relevantRelationships.length) {
    parts.push('【相关人物关系】' + scene.relevantRelationships.map((r) => `${r.summary}`).join('；'))
  }
  if (Array.isArray(scene.relevantEpisodes) && scene.relevantEpisodes.length) {
    parts.push('【相关旧事】' + scene.relevantEpisodes.map((e) => `${e.summary}${agoTag(e.occurredAt)}${e.confidence != null ? `(可信${(e.confidence * 100) | 0}%)` : ''}`).join('；'))
  }
  if (role === 'planner' && scene.communitySummary) {
    parts.push(`【所在圈子】${scene.communitySummary}`)
  }
  const body = parts.filter(Boolean).join('\n')
  if (!body) return ''
  const head = role === 'planner'
    ? '【群聊社会记忆（仅供判断该不该参与/用什么态度；事实不确定的不要当真；不向群友复述档案）】'
    : '【你与这位群友的过往（自然融入语气，可轻轻提及旧事，但不要像查档案一样罗列；不确定的别编）】'
  return `${head}\n${body}`
}
