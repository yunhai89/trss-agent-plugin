/**
 * ConversationGrounding —— 对话落地层（谁在对谁说什么，先于情绪与决策）。
 *
 * 三种对象拆开：speaker（发送者）/ quoted_author（被回复者）/ semantic_target（语义所指）；
 * 实体白名单：本轮可谈论对象 = 发送者 + 被回复者 + @的人 + 正文点名的人——长期记忆/旧上下文的
 * 人（如两小时前的"云海"）不得凭语义相似混入；Replyer 生成后校验白名单，越界打回重生成。
 * 纠错检测："我说的是X"（回复 bot）= reference_correction，不是挑衅——触发 Planner 约束 +
 * SelfState 冲销（repair 路径），情绪不能建立在错误指代上。
 * bot↔bot 闭环：与已知 bot 账号交替 ≥3 轮且无真人夹入 → 建议熔断（真人不受影响，只限已知 bot）。
 */
import { textMentionsName } from './message-normalizer.js'

/** 对最新一条外部消息做落地解析。 */
export function resolveGrounding(messages = [], { knownBots = new Set(), targetMessageId = null } = {}) {
  const arr = (Array.isArray(messages) ? messages : []).filter(Boolean)
  // 目标解析修复：优先 Planner 实际选中的 targetMessageId（此前恒取最新一条——一批消息里
  // Planner 想回前一条时，grounding 描述的是另一条，归属块与决策目标错位）
  let target = null
  if (targetMessageId != null) target = arr.find((m) => String(m.id) === String(targetMessageId)) || null
  if (!target) target = [...arr].reverse().find((m) => !m.isSelf)
  if (!target) return null
  const byId = new Map(arr.map((m) => [String(m.id), m]))
  const selfIds = new Set(arr.filter((m) => m.isSelf).map((m) => String(m.userId)))
  const nameOf = (uid) => {
    const k = String(uid)
    if (selfIds.has(k)) return '我'
    const hit = arr.find((m) => !m.isSelf && String(m.userId) === k)
    return hit ? String(hit.displayName || hit.userId) : null
  }
  // 窗口成员名表（≥2 字、排除发言人自己与 bot 名）
  const memberNames = []
  for (const m of arr) {
    if (!m || m.isSelf) continue
    const n = String(m.displayName || '').trim()
    if (n.length >= 2 && n !== '我' && String(m.userId) !== String(target.userId) && !memberNames.includes(n)) memberNames.push(n)
  }
  // 被回复者
  const replySrc = target.replyToId
    ? byId.get(String(target.replyToId)) || target.replySource || null
    : null
  const quoted = replySrc ? { id: replySrc.id, userId: replySrc.userId, name: replySrc.isSelf ? '我' : String(replySrc.displayName || replySrc.userId), text: String(replySrc.text || '').replace(/\s+/g, ' ').slice(0, 32) } : null
  // 显式 @
  const mentions = (target.segments || []).filter((s) => s?.type === 'at' && s.qq != null).map((s) => ({ id: String(s.qq), name: nameOf(s.qq) || String(s.qq) }))
  // 正文点名（边界匹配窗口成员名）
  const named = memberNames.filter((n) => textMentionsName(String(target.text || ''), [n]))
  // semantic_target：被回复者优先，其次正文点名
  let semanticTarget = null; let confidence = 0
  if (quoted && quoted.name !== '我') { semanticTarget = quoted.name; confidence = 0.9 }
  else if (named.length) { semanticTarget = named[0]; confidence = 0.7 }
  else if (quoted && quoted.name === '我') { semanticTarget = '我'; confidence = 0.95 }
  // 白名单（本轮可谈论对象；含 bot 自己）
  const allowed = new Set(['我'])
  allowed.add(String(target.displayName || target.userId))
  if (quoted && quoted.name !== '我') allowed.add(quoted.name)
  for (const mt of mentions) if (mt.name !== '我') allowed.add(mt.name)
  for (const n of named) allowed.add(n)
  // 纠错检测：回复 bot + "我说的是X / 指的是X / 不是说你" + 点名另一人
  const t = String(target.text || '')
  const isCorrection = !!(target.quotesBot && /(我说的是|指的是|说的可不是你|不是说你|跟你说的是)/.test(t) && named.length > 0)
  // bot↔bot 闭环：尾部 bot 与已知 bot 账号交替、无真人夹入
  const botChain = botChainDepth(arr, knownBots)
  const threadUserIds = new Set([String(target.userId)])
  if (quoted && quoted.userId && quoted.name !== '我') threadUserIds.add(String(quoted.userId))
  for (const mt of mentions) if (mt.name !== '我') threadUserIds.add(mt.id)
  for (const n of named) { const hit = arr.find((m) => !m.isSelf && String(m.displayName) === n); if (hit) threadUserIds.add(String(hit.userId)) }
  return {
    target, quoted, mentions, named, semanticTarget, confidence,
    threadUserIds: [...threadUserIds],
    allowedEntities: [...allowed],
    correction: isCorrection ? { correctTarget: named[0], userId: (arr.find((m) => !m.isSelf && String(m.displayName) === named[0]) || {}).userId } : null,
    botChain,
  }
}

/** 尾部 bot↔已知bot 交替深度（有真人夹入即断）。 */
function botChainDepth(messages, knownBots) {
  // 尾部扫描（与 turn-scheduler 熔断同口径）：从最后一条往前数连续的 bot/已知bot 消息，
  // 遇到真人即停——窗口头部有真人、尾部纯 bot↔bot 交替时同样构成闭环
  let depth = 0
  const arr = (Array.isArray(messages) ? messages : []).filter(Boolean)
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i]
    if (m.isSelf || knownBots.has(String(m.userId))) depth++
    else break
  }
  return depth
}

/** 结构化对话归属块（注入 Planner/Replyer）。 */
export function formatGroundingBlock(g) {
  if (!g || !g.target) return ''
  const lines = [
    '【对话归属（结构化，先读懂再发言）】',
    `- 发言者：${g.target.displayName || g.target.userId}`,
    g.quoted ? `- 被回复的是：${g.quoted.name}${g.quoted.name === '我' ? '（你）' : ''}${g.quoted.text ? `，原话「${g.quoted.text}」` : ''}` : '- 被回复的是：（无，不是在回复某条具体消息）',
    g.mentions.length ? `- 明确@了：${g.mentions.map((m) => m.name).join('、')}` : '',
    g.named.length ? `- 正文点名了：${g.named.join('、')}` : '',
    `- 语义所指：${g.semanticTarget || '未明'}（置信${g.confidence.toFixed(2)}）`,
    `- 本轮可谈论的人（白名单）：${g.allowedEntities.join('、')}——其他人（包括记忆/旧对话里的人）不得在回复中指名提及`,
  ]
  if (g.correction) lines.push(`- ⚠️ 对象纠错：对方明确说"我说的是${g.correction.correctTarget}"——你之前理解错了对象。只能：承认看串了/简短修正/不回；禁止反击、阴阳或关系降级。`)
  return lines.filter(Boolean).join('\n')
}

/** 白名单校验：回复文本点名了窗口内其他成员但不在白名单 → 返回越界名单。 */
export function whitelistViolations(text, g, windowNames = []) {
  if (!g || !text) return []
  const t = String(text)
  const allowed = new Set(g.allowedEntities)
  return windowNames.filter((n) => !allowed.has(n) && textMentionsName(t, [n]))
}

/** 窗口成员名（供白名单校验）。 */
export function windowNames(messages = []) {
  const out = []
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (!m || m.isSelf) continue
    const n = String(m.displayName || '').trim()
    if (n.length >= 2 && !out.includes(n)) out.push(n)
  }
  return out
}
