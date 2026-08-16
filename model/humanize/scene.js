/**
 * ConversationScene —— 当前会话场景分析（「最近几十秒正在发生什么」）。
 *
 * 与 GroupWorld 的分工：
 *   - GroupWorld：历史关系、旧事件、群体记忆（跨天/跨周）。
 *   - ConversationScene：此刻的话轮——谁在和谁说什么、言外之意、现在适不适合插话。
 *
 * 管线位置：Grounding → ConversationScene → GroupWorld/SelfState → Gate → Planner → Replyer。
 * 同一轮 Gate/Planner/Replyer 共享同一个 scene 对象（禁止各层自行推断出互相冲突的场景）；
 * SelfState 在 onAmbient（逐消息感知）用的是同一模块的规则场景（热路径不调 LLM）。
 *
 * 混合算法：
 *   1) 硬规则：回复链、@、说话人切换、时间间隔、问句、结束语、表情标点 → 基线场景；
 *   2) 小模型严格 JSON 分类语用场景 + 证据消息 id；
 *   3) hysteresis/有限状态平滑：场景翻转需要更高置信，防逐条消息在「玩笑/严肃」间跳变；
 *   4) LLM 不得修改 Grounding 确认的发言对象/回复链/参与者——participants 一律由 Grounding 事实重建；
 *   5) 失败/超时/低置信 → 降级到规则结果（degraded 标记），绝不阻塞消息链路；
 *   6) 缓存：groupId + lastMessageId；新消息到达自然换键失效。
 */

import Log from '../../utils/Log.js'

export const SCENE_TYPES = ['banter', 'venting', 'serious_qna', 'debate', 'storytelling', 'coordination', 'comfort', 'conflict', 'repair', 'idle']
export const SPEECH_ACTS = ['ask', 'tease', 'complain', 'share', 'seek_validation', 'invite', 'reject', 'close_topic', 'self_talk', 'inform']
export const TONES = ['playful', 'sarcastic', 'tired', 'serious', 'tense', 'awkward']
export const PHASES = ['opening', 'rising', 'peak', 'cooling', 'closed']
export const PARTICIPANT_ROLES = ['speaker', 'target', 'audience', 'mediator']

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

// ─────────────── 硬规则特征 ───────────────

const RE_QUESTION = /[?？]|吗{1}[。？！\s]|呢[。？！\s]|怎么|如何|为什么|啥意思|有没有|能不能|可以吗/
const RE_CLOSE = /^\s*(?:行了|算了|先这样|睡了|困了|晚安|拜|回见|先溜了|挂了|去忙了|吃饭去了|就这样吧|扯远了)|(?:先不聊|不聊了|下次再聊)/
const RE_SARCASM = /可真会|真有你的|真是个人才|好家伙|佩服佩服|可太会了|真行啊你|你可真行|真棒棒|感谢您嘞|真是谢谢您嘞|可真是|真是个小天才/
const RE_COMPLAIN = /服了|烦死|又炸了|又崩了|裂开|累死了|离谱|吐了|没眼看|搞不定|搞不出来|还让不让人|气死|无语|麻了|搞了一晚上|改不动/
const RE_TEASE = /哈哈|笑死|绷不住|哈哈哈哈|6{2,}|乐死|蚌埠住了|doge|😂|🤣| XD /i
const RE_SUPPORT = /没事|别难过|摸摸|抱抱|加油|挺住|辛苦了|心疼|别急|慢慢来/
const RE_SHARE = /今天|刚才|刚|昨天|看到|听说|给你们看|分享|推荐|入了个|买到|出了个/
const RE_TECH = /部署|服务器|报错|bug|接口|编译|模型|显卡|docker|nginx|报了|栈|内存|配置文件|环境|版本|p40|4090|api|token数|上下文/i

/** 从消息列表提取硬规则特征（纯函数；grounding 可空——热路径逐消息感知时无完整 grounding）。 */
export function extractSceneFeatures(messages = [], grounding = null, { now = Date.now() } = {}) {
  const arr = (Array.isArray(messages) ? messages : []).filter(Boolean)
  const humans = arr.filter((m) => !m.isSelf)
  const lastHuman = [...humans].reverse().find((m) => !m.isCommand && !m.handledByDirectAgent) || null

  // 时间节奏：近 90s 内人类消息数与平均间隔
  const recentHumans = humans.filter((m) => now - Number(m.timestamp || 0) < 90_000)
  const intervals = []
  for (let i = 1; i < recentHumans.length; i++) intervals.push(Number(recentHumans[i].timestamp || 0) - Number(recentHumans[i - 1].timestamp || 0))
  const avgGap = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : Infinity
  // 说话人切换率（两人以上快速交替 = 高动量对话）
  let switches = 0
  for (let i = 1; i < recentHumans.length; i++) if (String(recentHumans[i].userId) !== String(recentHumans[i - 1].userId)) switches++
  const alternation = recentHumans.length > 1 ? switches / (recentHumans.length - 1) : 0

  const lastText = String(lastHuman?.text || '')
  // 指向机器人的强度：@/引用/提及（grounding 的事实优先，缺失时用消息标志）
  let directedAtBot = 0
  if (grounding?.target) {
    if (grounding.target.atBot) directedAtBot = 1
    else if (grounding.target.quotesBot) directedAtBot = 0.9
    else if (grounding.semanticTarget === '我') directedAtBot = Math.max(directedAtBot, 0.7)
    else directedAtBot = grounding.target.mentionsBotName ? 0.4 : 0
  } else if (lastHuman) {
    if (lastHuman.atBot) directedAtBot = 1
    else if (lastHuman.quotesBot) directedAtBot = 0.9
    else if (lastHuman.mentionsBotName) directedAtBot = 0.4
  }

  return {
    lastText,
    lastHuman,
    isQuestion: RE_QUESTION.test(lastText),
    isClose: RE_CLOSE.test(lastText),
    isSarcasm: RE_SARCASM.test(lastText),
    isComplain: RE_COMPLAIN.test(lastText),
    isTease: RE_TEASE.test(lastText),
    isSupport: RE_SUPPORT.test(lastText),
    isShare: RE_SHARE.test(lastText),
    isTech: RE_TECH.test(lastText),
    recentHumanCount: recentHumans.length,
    avgGap,
    alternation,
    directedAtBot: clamp01(directedAtBot),
  }
}

/**
 * 规则场景（确定性基线；也是 LLM 失败/超时/低置信时的降级结果）。
 * @param {Array} messages 近 8~12 条规范化消息（旧→新，含 isSelf）
 * @param {object|null} grounding resolveGrounding 产物（可空）
 */
export function ruleScene(messages = [], grounding = null, { now = Date.now() } = {}) {
  const f = extractSceneFeatures(messages, grounding, { now })
  const tones = []
  let sceneType = 'idle'
  let speechAct = 'inform'
  let phase = 'cooling'

  if (f.lastHuman) {
    if (f.isSarcasm) { speechAct = 'tease'; tones.push('sarcastic') }
    else if (f.isTease) { speechAct = 'tease'; tones.push('playful') }
    else if (f.isComplain) { speechAct = 'complain'; tones.push('tired') }
    else if (f.isQuestion) speechAct = 'ask'
    else if (f.isShare) speechAct = 'share'

    // 场景类型合成（多线索叠加取最强语义）
    if (f.isSarcasm || (f.isTease && f.alternation >= 0.4)) sceneType = 'banter'
    else if (f.isComplain) sceneType = 'venting'
    else if (f.isQuestion && (f.isTech || f.directedAtBot >= 0.7)) sceneType = 'serious_qna'
    else if (f.isQuestion) sceneType = 'debate'
    else if (f.isSupport) sceneType = 'comfort'
    else if (f.isShare) sceneType = 'storytelling'
    else if (speechAct === 'inform') sceneType = f.recentHumanCount >= 3 ? 'banter' : 'idle'
    if (f.isClose) speechAct = 'close_topic'
    if (f.isSarcasm && !tones.includes('sarcastic')) tones.push('sarcastic')
    if (!tones.length) tones.push(f.isComplain ? 'tired' : 'serious')

    // 阶段：结束语收尾 → closed；快速交替 → peak/rising；冷清 → cooling/opening
    if (f.isClose && (f.recentHumanCount <= 1 || now - Number(f.lastHuman.timestamp || 0) > 20_000)) phase = 'closed'
    else if (f.recentHumanCount >= 4 && f.avgGap < 15_000) phase = 'peak'
    else if (f.recentHumanCount >= 2 && f.avgGap < 40_000) phase = 'rising'
    else if (f.recentHumanCount <= 1) phase = 'opening'
    else phase = 'cooling'
  }

  // 动量：近期人类消息密度 × 交替率（两人聊得顺 = 高）
  const density = clamp01(f.recentHumanCount / 6)
  const humanMomentum = clamp01(density * 0.6 + (f.avgGap < 30_000 ? 0.25 : 0) + f.alternation * 0.3 * density)
  // 可回插度：问句/求助/被点名高；闲聊互怼低
  const replyAffordance = clamp01(
    (f.isQuestion ? 0.45 : 0) + (f.isComplain ? 0.3 : 0) + f.directedAtBot * 0.5 + (f.isClose ? -0.5 : 0) + (speechAct === 'share' ? 0.15 : 0),
  )
  const ambiguity = clamp01((f.isSarcasm ? 0.25 : 0) + (speechAct === 'inform' && !f.isShare ? 0.2 : 0) + (f.directedAtBot > 0 && f.directedAtBot < 0.6 ? 0.2 : 0))

  return {
    sceneType,
    speechAct,
    tones: [...new Set(tones)].slice(0, 3),
    phase,
    participants: participantsFromGrounding(messages, grounding),
    directedAtBot: f.directedAtBot,
    replyAffordance,
    humanMomentum,
    ambiguity,
    confidence: 0.4, // 规则基线的保守置信
    evidenceMessageIds: f.lastHuman ? [String(f.lastHuman.id)] : [],
    source: 'rule',
    degraded: null,
  }
}

/**
 * 参与者一律由 Grounding/消息事实重建（LLM 不可改）：
 * speaker=目标消息发送者；target=被回复者/被@者（含 bot=我）；mediator 未定；其余近窗发言者=audience。
 */
export function participantsFromGrounding(messages = [], grounding = null) {
  const arr = (Array.isArray(messages) ? messages : []).filter(Boolean)
  const out = []
  const seen = new Set()
  const add = (userId, role) => {
    if (userId == null || String(userId) === '') return
    const k = `${userId}:${role}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ userId: String(userId), role })
  }
  if (grounding?.target) {
    add(grounding.target.userId, 'speaker')
    if (grounding.quoted && grounding.quoted.userId != null) add(grounding.quoted.userId, grounding.quoted.name === '我' ? 'target' : 'target')
    for (const m of grounding.mentions || []) add(m.id, 'target')
    for (const uid of grounding.threadUserIds || []) add(uid, 'audience')
  } else {
    const lastHuman = [...arr].reverse().find((m) => !m.isSelf && !m.isCommand && !m.handledByDirectAgent)
    if (lastHuman) {
      add(lastHuman.userId, 'speaker')
      const src = lastHuman.replyToId ? arr.find((m) => String(m.id) === String(lastHuman.replyToId)) : null
      if (src) add(src.userId, 'target')
      for (const s of lastHuman.segments || []) if (s?.type === 'at' && s.qq != null) add(String(s.qq), 'target')
    }
  }
  return out.slice(0, 10)
}

/** schema 校验 + 归一：非法枚举/数值钳制；participants 恒以 Grounding 事实为准（llm 的被丢弃）。 */
export function validateScene(obj, { grounding = null, messages = [] } = {}) {
  if (!obj || typeof obj !== 'object') return null
  const one = (v, list, dflt) => (list.includes(v) ? v : dflt)
  const scene = {
    sceneType: one(obj.sceneType, SCENE_TYPES, 'idle'),
    speechAct: one(obj.speechAct, SPEECH_ACTS, 'inform'),
    tones: (Array.isArray(obj.tones) ? obj.tones : []).map((t) => one(t, TONES, null)).filter(Boolean).slice(0, 3),
    phase: one(obj.phase, PHASES, 'cooling'),
    participants: participantsFromGrounding(messages, grounding),
    directedAtBot: clamp01(obj.directedAtBot),
    replyAffordance: clamp01(obj.replyAffordance),
    humanMomentum: clamp01(obj.humanMomentum),
    ambiguity: clamp01(obj.ambiguity),
    confidence: clamp01(obj.confidence),
    evidenceMessageIds: (Array.isArray(obj.evidenceMessageIds) ? obj.evidenceMessageIds : []).map(String).slice(0, 12),
    source: obj.source === 'llm' ? 'llm' : 'rule',
    degraded: obj.degraded || null,
  }
  if (!scene.tones.length) scene.tones = ['serious']
  return scene
}

// ─────────────── LLM 分类 ───────────────

const SCENE_SYSTEM = `你是群聊场景分析器。给你最近几条群聊消息（旧→新，含对话关系角注），判断「此刻正在发生什么」。
只输出纯 JSON（无 markdown、无解释）：
{
  "sceneType": "banter|venting|serious_qna|debate|storytelling|coordination|comfort|conflict|repair|idle",
  "speechAct": "ask|tease|complain|share|seek_validation|invite|reject|close_topic|self_talk|inform",
  "tones": ["playful|sarcastic|tired|serious|tense|awkward", "最多3个"],
  "phase": "opening|rising|peak|cooling|closed",
  "directedAtBot": 0.0~1.0,
  "replyAffordance": 0.0~1.0,
  "humanMomentum": 0.0~1.0,
  "ambiguity": 0.0~1.0,
  "confidence": 0.0~1.0,
  "evidenceMessageIds": ["支撑判断的消息id"]
}
判定要点：
- 吐槽/抱怨（venting）≠ 求方案：对方在发泄情绪，不等于在要解决步骤；
- 讽刺/阴阳（如「你可真会挑时候」）不是字面表扬——tones 用 sarcastic；
- 明显结束语（行了/睡了/先这样）→ phase=closed；
- 两个人聊得火热且没叫机器人 → humanMomentum 高、replyAffordance 低；
- 只输出 JSON；evidenceMessageIds 必须来自输入中的真实消息 id。`

function buildSceneUserPrompt(messages = []) {
  const lines = messages.slice(-12).map((m) => {
    const rels = []
    if (m.isSelf) rels.push('（机器人自己）')
    else {
      if (m.atBot) rels.push('@机器人')
      else if (m.quotesBot) rels.push('↩引用机器人')
      else if (m.mentionsBotName) rels.push('·提及机器人名')
      if (m.replyToId) rels.push(`↩回复[${m.replyToId}]`)
      if (m.isCommand) rels.push('（命令）')
    }
    const t = new Date(Number(m.timestamp) || 0)
    const mm = String(t.getMinutes()).padStart(2, '0')
    const ss = String(t.getSeconds()).padStart(2, '0')
    return `[${m.id}] ${m.isSelf ? '我' : (m.displayName || m.userId)}{${rels.join(' ')}} ${mm}:${ss}: ${String(m.text || '').slice(0, 100)}`
  })
  return `最近消息（旧→新）：\n${lines.join('\n')}\n\n请输出 JSON。`
}

function parseSceneJson(text) {
  let s = String(text || '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const i = s.indexOf('{'); const j = s.lastIndexOf('}')
  if (i >= 0 && j > i) s = s.slice(i, j + 1)
  try { return JSON.parse(s) } catch { return null }
}

/**
 * 会话场景分析器（规则 + LLM 混合；按 groupId+lastMessageId 缓存；hysteresis 平滑）。
 */
export class ConversationSceneAnalyzer {
  /**
   * @param {object} opts { provider, cfg:()=>object, trace?, model? }
   *   provider 缺省 → 纯规则模式（零影响降级）。
   */
  constructor({ provider = null, cfg = null, trace = null, model = null, timeoutMs = 6000 } = {}) {
    this.provider = provider
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.trace = trace
    this.model = model
    this.timeoutMs = timeoutMs
    this._cache = new Map() // `${groupId}:${lastMessageId}` → scene
    this._prev = new Map() // groupId → 上一次 scene（hysteresis）
  }

  /** 纯规则场景（热路径：SelfState 逐消息感知用，不调 LLM）。 */
  ruleOnly(messages, grounding = null, now = Date.now()) {
    return ruleScene(messages, grounding, { now })
  }

  /**
   * 混合分析（一轮 Gate/Planner/Replyer 共用一次）。
   * @param {object} o { groupId, messages, grounding?, lastMessageId?, signal?, now? }
   * @returns {Promise<object>} schema 校验后的场景对象（永不 throw；失败降级规则结果）
   */
  async analyze({ groupId, messages = [], grounding = null, lastMessageId = null, signal = null, now = Date.now() } = {}) {
    const key = `${groupId}:${lastMessageId != null ? String(lastMessageId) : (messages[messages.length - 1]?.id ?? '-')}`
    const cached = this._cache.get(key)
    if (cached) return cached

    const base = ruleScene(messages, grounding, { now })
    const validIds = new Set(messages.map((m) => String(m?.id || '')))
    let result = null
    let degraded = null

    if (this.provider) {
      try {
        const res = await this.provider.chat({
          model: this.model || this._cfgFn()?.planner?.model || undefined,
          system: SCENE_SYSTEM,
          messages: [{ role: 'user', content: buildSceneUserPrompt(messages) }],
          tools: undefined, tool_choice: { mode: 'none' },
          temperature: 0.2, max_tokens: 350, thinking: { type: 'disabled' }, stream: false,
          signal: signal || undefined,
          ...(this.timeoutMs ? { signal: AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)].filter(Boolean)) : AbortSignal.timeout(this.timeoutMs) } : {}),
        })
        const parsed = parseSceneJson(res?.content)
        if (!parsed) degraded = 'invalid_json'
        else {
          // 证据校验：伪造的 evidence id 全部剔除；全伪造 → 降级
          parsed.evidenceMessageIds = (parsed.evidenceMessageIds || []).filter((id) => validIds.has(String(id)))
          const merged = {
            ...base,
            ...parsed,
            participants: undefined, // 恒由 Grounding 重建（LLM 不可改发言对象/参与者）
            source: 'llm',
          }
          const v = validateScene(merged, { grounding, messages })
          if (!v) degraded = 'invalid_schema'
          else if (v.confidence < 0.35) degraded = 'low_confidence'
          else {
            // 指向强度受 Grounding 结构证据钳制：@/引用机器人的硬事实不可被 LLM 压低；
            // 无任何结构信号时 LLM 不得凭语义把「指向机器人」抬过 0.5（防认领别人间的对话）。
            if (base.directedAtBot >= 0.7) v.directedAtBot = Math.max(v.directedAtBot, base.directedAtBot)
            else if (base.directedAtBot <= 0.4) v.directedAtBot = Math.min(v.directedAtBot, 0.5)
            result = v
          }
        }
      } catch (e) {
        degraded = /abort|timeout/i.test(String(e?.message || e)) ? 'timeout' : 'llm_error'
      }
    } else {
      degraded = 'no_provider'
    }

    let scene = result || { ...base, degraded: degraded || base.degraded }
    if (!result && degraded && degraded !== 'no_provider') {
      Log.debug('[humanize-scene] 降级到规则场景:', degraded)
    }

    // hysteresis 平滑：与上一场景类型不同且置信优势不足 → 保留旧类型（ambiguity 上调，防逐条跳变）
    const prev = this._prev.get(String(groupId))
    if (prev && scene.sceneType !== prev.sceneType) {
      const flipMargin = 0.15
      if ((scene.confidence || 0) < (prev.confidence || 0) + flipMargin) {
        scene = {
          ...scene,
          sceneType: prev.sceneType,
          phase: PHASES[Math.max(PHASES.indexOf(prev.phase), 0)] === prev.phase ? prev.phase : scene.phase,
          ambiguity: clamp01(scene.ambiguity + 0.2),
          confidence: clamp01(Math.min(scene.confidence, prev.confidence) * 0.9),
          smoothed: true,
        }
      }
    }
    this._prev.set(String(groupId), scene)

    this.trace?.record?.('scene', {
      groupId, sceneType: scene.sceneType, speechAct: scene.speechAct, phase: scene.phase,
      tones: scene.tones, directedAtBot: scene.directedAtBot, momentum: scene.humanMomentum,
      conf: scene.confidence, source: scene.source, degraded: scene.degraded || null, smoothed: !!scene.smoothed,
      evidence: scene.evidenceMessageIds,
    })
    if (this._cache.size > 200) this._cache.clear()
    this._cache.set(key, scene)
    return scene
  }
}

/** 场景 → prompt 注入块（Gate/Planner/Replyer 共用的解读口径，含接话纪律）。 */
export function formatSceneBlock(scene, { role = 'planner' } = {}) {
  if (!scene || !scene.sceneType) return ''
  const SCENE_ZH = {
    banter: '互相逗趣/损来损去', venting: '吐槽发泄情绪', serious_qna: '认真提问求答案', debate: '讨论/争论观点',
    storytelling: '分享经历/讲故事', coordination: '约事/协作安排', comfort: '安慰/关心', conflict: '冲突/争吵',
    repair: '和好/补救', idle: '闲散/无明确话题',
  }
  const ACT_ZH = {
    ask: '提问', tease: '调侃/开玩笑', complain: '抱怨吐槽', share: '分享', seek_validation: '求认同',
    invite: '邀请', reject: '拒绝/否定', close_topic: '收尾结束话题', self_talk: '自言自语', inform: '陈述',
  }
  const lines = [
    `【当前会话场景（结构化判定；置信${(scene.confidence || 0).toFixed(2)}${scene.degraded ? `，${scene.degraded}已降级规则` : ''}${scene.smoothed ? '，经平滑' : ''}）】`,
    `- 类型：${SCENE_ZH[scene.sceneType] || scene.sceneType}；言语行为：${ACT_ZH[scene.speechAct] || scene.speechAct}；语气：${(scene.tones || []).join('/') || '-'}；阶段：${scene.phase}`,
    `- 人类对话动量 ${scene.humanMomentum?.toFixed(2)}（高=大家聊得正顺）；指向机器人 ${scene.directedAtBot?.toFixed(2)}；适合接话程度 ${scene.replyAffordance?.toFixed(2)}；歧义 ${scene.ambiguity?.toFixed(2)}`,
  ]
  if (role === 'planner') {
    lines.push(
      '- 解读纪律：吐槽(venting/complain)≠求方案——未明确求助时优先短暂接情绪，不要自动给步骤/清单；',
      '- 讽刺/阴阳/反问(tones=sarcastic)不得按字面表扬或肯定句理解；',
      '- 群友间动量高且没人叫机器人时，插话门槛应显著提高；phase=closed 表示话题已收尾，默认沉默。',
    )
  } else {
    lines.push(
      '- 接话口径：对方在吐槽时先接住情绪（一句共鸣/一句损），别急着分析或给解决方案——除非对方明确问「怎么办」；',
      '- 讽刺/阴阳话别当表扬接；话题已收尾(phase=closed)就别强行续聊。',
    )
  }
  return lines.join('\n')
}

/** 场景 → 期望回复长度档位（供 Replyer 长度随场景变化；不是硬截断）。 */
export function sceneLengthHint(scene) {
  if (!scene) return 'normal'
  if (scene.sceneType === 'banter' || scene.speechAct === 'tease') return 'very_short'
  if (scene.sceneType === 'venting') return 'short'
  if (scene.phase === 'closed') return 'short'
  if (scene.sceneType === 'serious_qna' && scene.speechAct === 'ask') return 'expandable'
  return 'normal'
}
