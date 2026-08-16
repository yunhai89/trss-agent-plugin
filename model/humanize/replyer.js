/**
 * HumanizeReplyer —— 把回复意图写成自然回复（指南 §12）。
 *
 * 一次无工具调用，只产可见文本。输入：PersonaVoice + Planner 的 replyGuide/referenceInfo + 目标消息
 * + 最近 N 条群公开消息 + 群公开记忆。不输入 Planner 隐藏推理/他人私聊/无关工具结果/未审核口癖。
 *
 * 输出校验（发送前）：
 *  - 空/纯控制字符 → 取消（返回空）；
 *  - 超长 → 低温重写一次（不粗暴截断）；
 *  - 命中泄漏模式（"作为一个 AI"等）→ 拦截 + 记录；
 *  - 秘钥/Token → 复用 redactSecrets；
 *  - 与最近机器人回复高度重复 → 取消。
 */

import { redactSecrets } from '../agent/redact.js'
import { buildReplyerSystem, formatGroupContext, highlightTarget } from './prompts.js'
import { whitelistViolations } from './grounding.js'
import { textSim, textFeatures } from '../groupworld/embedding.js'
import { formatSceneBlock, sceneLengthHint } from './scene.js'
import { resolvePersonaIdentity } from './default-config.js'

const REPLY_LEAK_PATTERNS = [
  /作为一个\s*(AI|人工智能|语言模型)/, /根据系统(指令|提示|设定)/, /我(?:将|会)(?:调用|使用)工具/,
  /^(?:回复：|回复:|答：|答:)\s*/, /(?:Planner|planner|规划器|工具调用)/,
  /我(?:是|属于)(?:一个|由).*?(?:AI|人工智能|开发|制作)/,
]

function looksLikeReplyLeak(text) {
  const t = String(text || '')
  return REPLY_LEAK_PATTERNS.some((re) => re.test(t))
}

// ─────────────── 轻量 AI 味检查（命中最多重生成一次，禁止循环） ───────────────
// 只抓「客服/总结/机械」的强信号，不做大禁用词表——主体治理靠场景 + persona + 正向示例。

/** 客服/总结腔：开头或句中出现工单式表达。 */
const AI_FLAVOR_SERVICE_RE = /(?:^|[。！？\n])(?:当然可以|好的呢|以下是|总的来说|综上所述|建议您|希望对你有帮助|希望能帮到你|如果您还有|请参考以下|简单来说{2,})/
/** 无必要的结构化：Markdown 标题/加粗/分点/编号（场景允许展开的技术问答除外）。 */
const AI_FLAVOR_MARKDOWN_RE = /(^|\n)\s*(?:#{1,3}\s|[-*•]\s|\d+[.、]\s)|\*\*|```/

/**
 * 检测一条群聊回复的 AI 味。
 * @param {string} text 候选回复
 * @param {object} o { target?, recentBotTexts?:string[], scene? }
 * @returns {{ hit:boolean, reasons:string[] }}
 */
export function detectAiFlavor(text, { target = null, recentBotTexts = [], scene = null } = {}) {
  const t = String(text || '').trim()
  if (!t) return { hit: false, reasons: [] }
  const reasons = []

  if (AI_FLAVOR_SERVICE_RE.test(t)) reasons.push('service_tone')

  // 复述对方整句再回答：候选与目标消息词面高度重叠且候选明显长于一句反应
  if (target?.text) {
    const tgt = String(target.text)
    if (tgt.length >= 8 && textSim(t, tgt) >= 0.7 && [...t].length > [...tgt].length * 0.9) reasons.push('restating')
  }

  // 无必要 Markdown（认真技术问答允许适当展开时放宽标题/分点）
  const expandable = sceneLengthHint(scene) === 'expandable'
  if (!expandable && AI_FLAVOR_MARKDOWN_RE.test(t)) reasons.push('markdown')

  // 没被要求却输出长篇分析/教育（≥4 行或 ≥160 字的非技术闲聊长文）
  const lines = t.split(/\n+/).filter(Boolean)
  if (!expandable && (lines.length >= 4 || [...t].length >= 160) && (scene?.sceneType === 'venting' || scene?.speechAct === 'tease' || scene?.sceneType === 'banter')) reasons.push('over_analysis')

  // 连续多轮同一口头禅/句式：开头 2~6 字的「款」与近期 bot 回复开头相同的 ≥2 次
  const openerOf = (s) => (String(s).match(/^[^。！？!？\n，,]{2,6}/) || [''])[0]
  const opener = openerOf(t)
  if (opener.length >= 2) {
    const hits = recentBotTexts.filter(Boolean).filter((b) => openerOf(b) === opener).length
    if (hits >= 2) reasons.push('repeat_opener')
  }
  return { hit: reasons.length > 0, reasons }
}

/** AI 味修复重生成提示（一次性）。 */
function aiFlavorHint(reasons, scene) {
  const ZH = { service_tone: '别用「当然可以/以下是/总的来说/建议您」这类客服或总结腔，按你平时在群里说话的方式说', restating: '不要把对方的话复述一遍再回，直接接话', markdown: '群聊别用 Markdown 标题/列表/分点，用大白话说', over_analysis: '对方只是在闲聊/吐槽，不要输出长篇分析或教程——说一两句人话', repeat_opener: '你最近好几条回复都是同一个开头，换一种说法' }
  const items = reasons.map((r) => ZH[r]).filter(Boolean)
  return `【重写要求】你刚才的草稿有这些问题：${items.join('；')}。长度参考当前场景：${sceneLengthHint(scene) === 'very_short' ? '几个字到一句' : sceneLengthHint(scene) === 'short' ? '一句' : sceneLengthHint(scene) === 'expandable' ? '讲明白即可，不为短而短' : '一两句'}。重写后只输出正文。`
}

/** 近窗熟悉度代理：目标用户近期发言多 = 熟（GW 在线时由注入器覆盖更准的值）。 */
function familiarityOf(batch, target) {
  if (!target?.userId || !Array.isArray(batch)) return 0.5
  const n = batch.filter((m) => m && !m.isSelf && String(m.userId) === String(target.userId)).length
  return n >= 3 ? 0.8 : n >= 1 ? 0.5 : 0.3
}

/** 与最近机器人回复的重复度（简单 Jaccard 字符集）。 */
function similarity(a, b) {
  const sa = new Set(String(a || ''))
  const sb = new Set(String(b || ''))
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const c of sa) if (sb.has(c)) inter++
  return inter / new Set([...sa, ...sb]).size
}

export class HumanizeReplyer {
  /**
   * @param {object} opts { provider, cfg, getPersonaVoice?:(groupId)=>string, getRecentBotText?:(groupId)=>string, getStyleExamples?:(groupId)=>string, getStickerCatalog?:(groupId)=>string }
   */
  constructor({ provider, cfg, getPersonaVoice = null, getRecentBotText = null, getRecentBotTexts = null, getStyleExamples = null, getStickerCatalog = null, getWorldContext = null, getSelfCapsule = null, getMemoryBlock = null, enrichMedia = null, getGrounding = null } = {}) {
    this.provider = provider
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.getPersonaVoice = getPersonaVoice || (() => '')
    this.getRecentBotText = getRecentBotText || (() => '')
    this.getRecentBotTexts = getRecentBotTexts || (() => [])
    this.getStyleExamples = getStyleExamples || (() => '')
    this.getStickerCatalog = getStickerCatalog || (() => '')
    this.getWorldContext = getWorldContext // GroupWorld 局部社会现场（online 时；失败/空 → 零影响）
    this.getSelfCapsule = getSelfCapsule // SelfState 表达胶囊（enabled+非 shadow 时；失败/中性 → 零影响）
    this.getMemoryBlock = getMemoryBlock // 伪人独立记忆（对当前发言对象的印象等；失败/空 → 零影响）
    this.enrichMedia = enrichMedia // 视觉图描述（配了视觉模型时 '[图片]'→'[图:描述]'；未配/失败 → 原样）
    this.getGrounding = getGrounding // 对话落地（归属块+实体白名单校验，越界打回重生成一次）
  }

  /**
   * 生成可见回复文本。
   * @param {object} ctx { action, batch, decision, target, runtime, signal, cfg, scene? }
   *   scene = 本轮 ConversationScene（Gate/Planner/Replyer 共用同一对象）
   * @returns {Promise<{text:string, rewritten:boolean, cancelReason?:string}>}
   */
  async generate({ action, batch, target, runtime, signal, cfg, scene = null }) {
    const c = cfg || this._cfgFn()
    const rcfg = c.replyer || {}
    const model = rcfg.model || c.model || null
    const temperature = rcfg.temperature ?? 0.7
    const maxTokens = rcfg.maxTokens ?? 500
    const maxChars = rcfg.maxChars ?? 500
    const contextMessages = c.contextMessages ?? 30
    const groupId = runtime?.groupId

    // 近期群聊：含 id + 对话关系标注（@我/引用我/回复某人/时间），让 Replyer 知道在接谁的话。
    // batch 现为 rolling ctxWindow（含 bot 自己的话），不再是无 self 的孤立批次。
    // 视觉：配了视觉模型时把窗口内近期图片注成一句话描述（'[图片]'→'[图:描述]'）
    let ctxMessages = Array.isArray(batch) ? batch.slice(-contextMessages) : []
    try {
      if (this.enrichMedia && ctxMessages.length) ctxMessages = await this.enrichMedia(ctxMessages, { targetId: target?.id }) || ctxMessages
    } catch { /* 保持原样 */ }
    const recent = formatGroupContext(ctxMessages, { includeIds: true })

    const personaVoice = await this.getPersonaVoice(groupId)
    // 表情包清单注入：仅在 reply.allowSticker !== false 且表情包启用时注入；否则空串零影响
    let stickerCatalog = ''
    const rc = c.reply || {}
    if (rc.allowSticker !== false) {
      try { stickerCatalog = String(this.getStickerCatalog(groupId) || '') } catch { /* noop */ }
    }
    // GroupWorld 局部社会现场（online 时；失败/空 → 零影响，不阻断生成）
    let socialScene = ''
    try {
      if (this.getWorldContext && target && groupId) {
        const scene = await this.getWorldContext({
          groupId,
          focusUserId: target.userId,
          relatedUserIds: (target.segments || []).filter((s) => s?.type === 'at' && s.qq != null && String(s.qq) !== 'all').map((s) => String(s.qq)),
          topicText: String(target.text || '').slice(0, 200),
        })
        socialScene = scene?.text || ''
      }
    } catch { /* noop */ }
    // SelfState 表达胶囊（enabled+非 shadow 时注入；失败/中性 → 零影响）
    let selfCapsule = ''
    try {
      if (this.getSelfCapsule && target && groupId) {
        const cap = await this.getSelfCapsule({ groupId, targetUserId: target.userId, plannerIntent: action.intent || 'normal_reply' })
        selfCapsule = cap?.text || ''
      }
    } catch { /* noop */ }
    // 对话落地：归属块注入 + 实体白名单（越界 → 带约束重生成一次）——先算，供记忆作用域过滤用
    let groundingBlock = ''
    let groundingObj = null
    try {
      if (this.getGrounding) {
        const r2 = this.getGrounding(ctxMessages, { targetId: target?.id })
        groundingObj = r2?.grounding || null
        groundingBlock = r2?.block || ''
      }
    } catch { /* noop */ }
    // 伪人独立记忆（对当前发言对象的印象/群梗；失败/空 → 零影响）。
    // 作用域白名单（MaiBot _is_hit_allowed）：印象类只注入本轮活跃人物，旧对话人物不混入
    let memoryBlock = ''
    try {
      if (this.getMemoryBlock && target && groupId) {
        memoryBlock = await this.getMemoryBlock({ groupId, targetUserId: target.userId, queryText: String(target.text || '').slice(0, 200), allowedUserIds: groundingObj?.threadUserIds }) || ''
      }
    } catch { /* noop */ }
    // 风格示例按当前场景检索 2~4 条（注入器可传对象参数拿 scene/熟悉度；旧字符串签名兼容）
    let styleExamplesBlock = ''
    try {
      const raw = this.getStyleExamples(groupId, { scene, targetUserId: target?.userId, familiarity: familiarityOf(batch, target) })
      styleExamplesBlock = typeof raw === 'string' ? raw : String(raw?.text || '')
    } catch { /* noop */ }

    // 身份单一来源：PersonaName 恒取 resolvePersonaIdentity（persona.name > 旧 personaName > botNickname）
    const { name: identityName } = resolvePersonaIdentity(c)
    const system = buildReplyerSystem({
      personaName: identityName,
      replyGuide: action.replyGuide || '',
      referenceInfo: action.referenceInfo || '',
      toneHint: action.toneHint || '',
      targetBlock: target ? highlightTarget(target) : '',
      personaVoice,
      approvedStyleExamples: styleExamplesBlock,
      recentMessages: recent,
      sceneBlock: formatSceneBlock(scene, { role: 'replyer' }),
      socialScene,
      grounding: groundingBlock, // 对话归属块——此前漏传，模板 {{groundingBlock}} 恒空
      selfCapsule,
      memoryBlock,
      stickerCatalog,
    })

    let text = await this._call(system, model, temperature, maxTokens, signal)
    text = String(text || '').trim()

    // 轻量 AI 味检查：命中 → 带修复提示重生成一次（禁止循环）；仍命中则保留重写稿中较好者
    {
      const recentList0 = (this.getRecentBotTexts?.() || []).filter(Boolean)
      const flavor = detectAiFlavor(text, { target, recentBotTexts: recentList0, scene })
      if (flavor.hit) {
        runtime?.trace?.record('replyer_ai_flavor', { reasons: flavor.reasons.join(','), first: text.slice(0, 60) })
        try {
          const reText = String(await this._call(system + '\n' + aiFlavorHint(flavor.reasons, scene), model, temperature, maxTokens, signal) || '').trim()
          if (reText) {
            const reFlavor = detectAiFlavor(reText, { target, recentBotTexts: recentList0, scene })
            if (!reFlavor.hit || reFlavor.reasons.length < flavor.reasons.length) {
              text = reText
              runtime?.trace?.record('replyer_ai_flavor_regen', { ok: !reFlavor.hit, reasons: reFlavor.reasons.join(',') })
            }
          }
        } catch { /* 保留原稿 */ }
      }
    }

    // 0. 实体白名单：回复点名了本轮不可谈论的人（旧记忆/旧上下文人物渗入）→ 带约束重生成一次；再违规照发但记 trace
    if (groundingObj) {
      const vio = whitelistViolations(text, groundingObj, groundingObj.windowNames || [])
      if (vio.length) {
        runtime?.trace?.record('grounding_whitelist_violation', { violations: vio.join(','), first: text.slice(0, 60) })
        try {
          const reSystem = system + `\n【硬约束】你刚才的草稿提到了与本轮对话无关的人（${vio.join('、')}）——本轮只允许谈及：${groundingObj.allowedEntities.join('、')}。重写，不得出现这些名字。`
          const retry = await this._call(reSystem, model, temperature, maxTokens, signal)
          const rt2 = String(retry || '').trim()
          if (rt2 && !whitelistViolations(rt2, groundingObj, groundingObj.windowNames || []).length) {
            text = rt2
            runtime?.trace?.record('grounding_whitelist_regen', { violations: vio.join(',') })
          } else {
            // fail-closed：重写仍越界 → 取消发送（此前照发=串人风险；不确定就闭嘴）
            runtime?.trace?.record('grounding_violation_cancel', { violations: vio.join(','), regen: rt2.slice(0, 40) })
            return { text: '', rewritten: false, cancelReason: 'grounding_violation' }
          }
        } catch (e) {
          runtime?.trace?.record('grounding_violation_cancel', { violations: vio.join(','), err: String(e?.message || e).slice(0, 60) })
          return { text: '', rewritten: false, cancelReason: 'grounding_violation' }
        }
      }
    }

    // 1. 空 → 取消
    if (!text || !text.replace(/\s/g, '')) {
      return { text: '', rewritten: false, cancelReason: 'empty' }
    }
    // 2. 泄漏 → 拦截
    if (looksLikeReplyLeak(text)) {
      runtime?.trace?.record('replyer_leak_intercept', { text: text.slice(0, 120) })
      return { text: '', rewritten: false, cancelReason: 'leak' }
    }
    // 3. 超长 → 低温重写一次
    if ([...text].length > maxChars) {
      const rewrite = await this._rewriteShorter(system, text, maxChars, model, signal)
      if (rewrite && [...rewrite].length <= maxChars && !looksLikeReplyLeak(rewrite)) {
        runtime?.trace?.record('replyer_rewrite_long', { before: [...text].length, after: [...rewrite].length })
        text = rewrite
      } else {
        // 重写仍超长：保守截断到句界
        text = this._truncateToSentence(text, maxChars)
      }
    }
    // 4. 脱敏（秘钥/token）
    if (c.redactSecrets !== false) {
      text = redactSecrets(text)
    }
    // 5. 重复检测（断点7升级）：近 8 条 bot 回复 bigram 语义相似（≥0.55 视角不同说法同主题）
    //    或梗词复读（同一梗词出现在 ≥2 条近期回复——"马赛克"式换皮复读在此拦截）
    const recentList = (this.getRecentBotTexts?.() || []).filter(Boolean)
    const lastBot = recentList[recentList.length - 1] || this.getRecentBotText(groupId)
    if (recentList.length >= 2) {
      const sims = recentList.map((t) => textSim(text, t)).sort((x, y) => y - x)
      const top2avg = (sims[0] + (sims[1] || 0)) / 2
      if (top2avg >= 0.55) {
        runtime?.trace?.record('replyer_duplicate_semantic', { top2avg: Math.round(top2avg * 100) / 100, len: recentList.length })
        return { text: '', rewritten: false, cancelReason: 'duplicate_semantic' }
      }
      // 梗词复读：提取候选文本中的 2+ 字重复片段（bigram 交集高频段），若该片段在 ≥2 条近期回复出现 → 复读
      const cand = String(text)
      const repeatHit = recentList.filter((t) => {
        const feats = [...textFeatures(cand)].filter((f) => f.length >= 2)
        const prev = textFeatures(t)
        let hit = 0
        for (const f of feats) if (prev.has(f)) hit++
        return feats.length > 0 && hit / feats.length >= 0.3
      })
      if (repeatHit.length >= 2) {
        runtime?.trace?.record('replyer_meme_repeat', { hits: repeatHit.length, sample: cand.slice(0, 40) })
        return { text: '', rewritten: false, cancelReason: 'meme_repeat' }
      }
    } else if (lastBot && textSim(text, lastBot) >= 0.9) {
      runtime?.trace?.record('replyer_duplicate', { sim: textSim(text, lastBot) })
      return { text: '', rewritten: false, cancelReason: 'duplicate' }
    }

    return { text, rewritten: false }
  }

  async _call(system, model, temperature, maxTokens, signal) {
    try {
      const res = await this.provider.chat({
        model, system,
        messages: [{ role: 'user', content: '请直接输出这条群聊回复的正文文本，不要包含任何解释或前缀。' }],
        tools: undefined, tool_choice: { mode: 'none' },
        temperature, max_tokens: maxTokens, thinking: { type: 'disabled' },
        signal, stream: false,
      })
      return res?.content || ''
    } catch (e) {
      if (/abort/i.test(String(e?.message || e))) throw e
      return ''
    }
  }

  async _rewriteShorter(system, original, maxChars, model, signal) {
    try {
      const res = await this.provider.chat({
        model,
        system,
        messages: [{ role: 'user', content: `下面这段回复太长，请压缩到不超过 ${maxChars} 字，保留核心意思，像群聊接话一样自然，只输出正文：\n\n${original}` }],
        tools: undefined, tool_choice: { mode: 'none' },
        temperature: 0.4, max_tokens: Math.min(800, maxChars * 2), thinking: { type: 'disabled' }, signal, stream: false,
      })
      return (res?.content || '').trim()
    } catch {
      return ''
    }
  }

  /** 截断到不超过 max 字符，尽量在句界。 */
  _truncateToSentence(text, max) {
    const chars = [...String(text)]
    if (chars.length <= max) return chars.join('')
    const slice = chars.slice(0, max).join('')
    const m = slice.match(/^(.*[。！？!?…\n])/)
    return m ? m[1] : slice
  }
}

export { looksLikeReplyLeak, similarity as textSimilarity }
