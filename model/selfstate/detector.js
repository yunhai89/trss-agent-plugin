/**
 * SelfEventDetector —— 规则优先的事件发现（设计文档 v1.1 §7）。
 *
 * 不让每条群消息都影响机器人。只有"明确指向机器人 / 命中期待窗口 / 明显褒贬候选"才产 candidate。
 * 规则优先：目标性/公开性/重复/身份全由程序确定；只有"语气意图、反讽、玩笑、善恶意、修复含义"
 * 不确定部分交给 AppraisalEngine（LLM 仅歧义时介入）。
 * 引用红线（§10.1-2）：引用他人的辱骂内容不判为引用者立场（replyToId 指向非机器人消息且文本疑似引用转发 → 降 directedness）。
 *
 * 输入 AmbientMessage（humanize normalizer）。输出 candidate 或 null：
 *   { candidateType, actorUserId, sourceMessageIds, deterministicSignals, needsLlm, confidence, occurredAt }
 *
 * 算法升级（第一梯队 #1）：语义近邻层——seed-examples 每类原型句 embedding，候选消息余弦 top-k
 * 分类，与关键词命中融合；灰区/词义冲突升级 LLM。无 embedder / embedding 失败 → 全部回落纯关键词。
 */
import Log from '../../utils/Log.js'
import { cosine } from '../groupworld/embedding.js'
import { SEED_EXAMPLES, SEM_CATEGORY_TO_EVENT } from './seed-examples.js'

// 关键词候选表（正则；命中只产候选，最终类型由 appraisal 重判）
const KW = {
  praise: /(?:厉害了|牛逼|nb|NB|太牛|真牛|好强|真好用|干得漂亮|可以啊|好评|点赞|太棒|优秀|靠谱|yyds)/,
  thanks: /(?:谢谢|感谢|多谢|辛苦了|thx|谢啦|ありがとう)/,
  insult: /(?:垃圾|废物|真菜|好菜|蠢|傻逼|sb|SB|滚|闭嘴|脑子有病|智障|低能|狗东西|滚蛋|尼玛|妈的|tm|TM|操你|傻X|煞笔)/,
  rejection: /(?:真不行|太失望|好失望|真失望|差劲|不及格|白搭|没用|搞不了|就这水平|还不如|过誉|太拉胯|拉胯)/,
  apology: /(?:对不起|抱歉|不好意思|我错了|道(?:个)?歉|赔不是|赔罪|刚才.*(过分|冲动|说重了)|开玩笑的|不是故意|别往心里去|说(的|得)太重)/,
  defense: /(?:别骂了|别这样说|人家也|它也挺好|不许|住手|够了|别欺负|维护)/,
  invite: /(?:一起|来玩|加入|要不要|来吧|带上.*(bot|机器人)|@?(?:你|它).*(?:来|一起|玩))/,
}

// 低价值/无语义文本直接跳过
const SKIP = /^\s*(?:\[.+\]|\d+|[哈哈哈啊嘿哟~！!？?。.,，])+\s*$/

export class SelfEventDetector {
  /**
   * @param {object} opts { botIds:Set<string>, botNames:string[], cfg:()=>object, embedder? }
   *   embedder = makeEmbedder 产物（可选）。配了 → 语义近邻分类层（seed-examples 原型，替代纯正则脆性）；
   *   未配/失败 → 自动回落纯关键词路径，零影响。
   */
  constructor({ botIds = new Set(), botNames = [], cfg, embedder = null } = {}) {
    this.botIds = botIds
    this.botNames = botNames.filter((n) => n && n.length >= 2)
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.embedder = embedder
    this._seedVecs = null   // Map<category, Float32Array[]>
    this._semDisabled = false
    // 语义层阈值：≥HIGH 直接采信语义类别；GRAY~HIGH 灰区交 LLM；<GRAY 忽略语义信号
    this._semHigh = 0.62
    this._semGray = 0.45
    this._vecCache = new Map() // 文本→向量 LRU（消息短文本重复概率低，纯内存即可）
  }

  /** 批量 embed 例句集（首次使用时一次；失败禁用语义层）。 */
  async _ensureSeeds() {
    if (this._seedVecs || !this.embedder || this._semDisabled) return this._seedVecs
    try {
      const vecs = new Map()
      const entries = Object.entries(SEED_EXAMPLES)
      for (const [cat, list] of entries) {
        const out = []
        for (let i = 0; i < list.length; i += 32) { // 分批，避免单请求过大
          const batch = list.slice(i, i + 32)
          const res = await this.embedder.embedBatch?.(batch)
          if (res) { for (const v of res) out.push(v); continue }
          for (const t of batch) out.push(await this.embedder.embed(t))
        }
        if (out.some(Boolean)) vecs.set(cat, out.filter(Boolean))
      }
      if (!vecs.size) { this._semDisabled = true; return null }
      this._seedVecs = vecs
    } catch (e) {
      Log.warn('[selfstate] 语义检测层例句向量初始化失败，语义层禁用（回落关键词）:', e?.message || e)
      this._semDisabled = true
      return null
    }
    return this._seedVecs
  }

  /** 单文本向量（LRU 缓存；失败返回 null）。 */
  async _embedText(text) {
    const key = text.slice(0, 256)
    if (this._vecCache.has(key)) return this._vecCache.get(key)
    let v = null
    try { v = await this.embedder.embed(text) } catch { v = null }
    if (this._vecCache.size > 2000) this._vecCache.clear()
    if (v) this._vecCache.set(key, v)
    return v
  }

  /**
   * 语义近邻分类：对每类取"与例句的最大余弦"，返回 { category, score, scores }。
   * neutral 负类同时参与：事件类要胜过 neutral 才算命中（压制"什么都像辱骂"误报）。
   */
  async _semanticClassify(text) {
    const seeds = await this._ensureSeeds()
    if (!seeds) return null
    const vec = await this._embedText(text)
    if (!vec) return null
    const scores = {}
    for (const [cat, list] of seeds) {
      let best = 0
      for (const s of list) {
        const c = cosine(vec, s)
        if (c != null && c > best) best = c
      }
      scores[cat] = Math.round(best * 1000) / 1000
    }
    let category = null; let score = 0
    for (const [cat, s] of Object.entries(scores)) {
      if (cat === 'neutral') continue
      if (s > score) { score = s; category = cat }
    }
    // 事件类必须明显胜过负类（≥ +0.02）才可信
    const neutralScore = scores.neutral || 0
    if (!category || score < this._semGray || score < neutralScore + 0.02) return { category: null, score, scores }
    return { category, score, scores }
  }

  /**
   * 检测一条消息是否产生自我事件候选（语义层启用时为 async——service 层 await）。
   * @param {object} norm AmbientMessage
   * @param {object} ctx { hasPendingExpectation:boolean, quoteIsBot:boolean }
   *   quoteIsBot：norm.replyToId 命中的是被引用消息属于机器人（由 service 层查 ss_expectations/缓冲判断）
   * @returns {Promise<object|null>} candidate
   */
  async detect(norm, ctx = {}) {
    if (!norm || norm.isSelf || norm.isCommand) return null
    const cfg = this._cfgFn()
    const ed = cfg.eventDetection || {}
    const text = String(norm.text || '').trim()
    if (!text || SKIP.test(text)) return null

    const isBot = (id) => this.botIds.has(String(id))
    // ── 确定性目标性信号（§7.2）──
    const directReplyToBot = !!(norm.replyToId && ctx.quoteIsBot)
    const directMention = !!norm.atBot || (norm.segments || []).some((s) => s?.type === 'at' && isBot(s.qq))
    const nicknameRef = this.botNames.length > 0 && this._mentionsNickname(text)
    const inExpectationWindow = !!ctx.hasPendingExpectation

    const directed = directReplyToBot || directMention || nicknameRef
    // ── 关键词候选（无指向也可触发——"有明显赞扬/感谢/维护/攻击候选"§7.1）──
    const kwHit = []
    if (KW.praise.test(text)) kwHit.push('praise')
    if (KW.thanks.test(text)) kwHit.push('thanks')
    if (KW.insult.test(text)) kwHit.push('insult')
    if (KW.rejection.test(text)) kwHit.push('rejection')
    if (KW.apology.test(text)) kwHit.push('apology')
    if (KW.defense.test(text)) kwHit.push('defense')
    if (KW.invite.test(text)) kwHit.push('invitation')

    if (!directed && !kwHit.length && !inExpectationWindow) return null

    // ── 语义近邻层（embedding 可用且开启；纯关键词语义盲区由它补：'你真的太帮了'无词面命中也能识别）──
    let semHit = null
    let semGray = null
    if (this.embedder && ed.semantic !== false && [...text].length >= 4) {
      const sem = await this._semanticClassify(text).catch(() => null)
      if (sem) {
        const evtName = SEM_CATEGORY_TO_EVENT[sem.category] || null
        if (evtName && sem.score >= this._semHigh) semHit = { event: evtName, score: sem.score, scores: sem.scores }
        else if (evtName) semGray = { event: evtName, score: sem.score } // 灰区：升级 LLM 裁决
      }
    }
    const semEvent = semHit?.event || null

    // ── 引用红线：回复的是"别人的消息"且文本疑似纯引用 → 不算指向机器人 ──
    let quoteSuspicion = 0
    if (norm.replyToId && !directReplyToBot) quoteSuspicion = 0.5 // 回复他人：文本立场可能是被引用者的
    if (directReplyToBot) quoteSuspicion = 0.15                    // 回复机器人但内容也可能是引述第三方

    // ── 组装确定性信号 ──
    const deterministicSignals = {
      direct_reply_to_bot: directReplyToBot,
      direct_mention: directMention,
      nickname_reference: nicknameRef,
      in_expectation_window: inExpectationWindow,
      kw_hits: kwHit,
      semantic_hit: semEvent ? { event: semEvent, score: semHit.score } : null,
      text_length: [...text].length,
      has_question: /[?？]|怎么|如何|什么|为什么|吗\b/.test(text),
      quote_suspicion: quoteSuspicion,
      sender_is_bot: false,
    }

    // ── 候选类型初判（最终由 appraisal 重判）；语义命中并入关键词体系 ──
    const hits = [...new Set([...kwHit, ...(semEvent ? [semEvent] : [])])]
    // 关键词与语义正面冲突（如词面辱骂但语义强判夸奖=反讽/引用）→ 升级 LLM
    const conflict = !!(semEvent && kwHit.length && !kwHit.includes(semEvent))
    let candidateType = 'unclassified'
    let needsLlm = false
    let confidence = 0.4
    if (hits.includes('apology')) { candidateType = 'apology'; confidence = 0.5 + (directed ? 0.2 : 0) + (semEvent === 'apology' ? 0.1 : 0) }
    else if (hits.includes('defense')) { candidateType = 'defense'; confidence = 0.5 + (semEvent === 'defense' ? 0.1 : 0) }
    else if (hits.includes('insult')) {
      candidateType = directed ? 'direct_insult' : 'ambient_hostility'
      // 熟人玩笑 vs 真辱骂歧义 → 交 appraisal（可能调 LLM）
      needsLlm = true
      confidence = directed ? 0.55 : 0.35
    }
    else if (hits.includes('rejection')) { candidateType = 'rejection'; confidence = directed ? 0.5 : 0.35; needsLlm = true }
    else if (hits.includes('thanks')) { candidateType = 'thanks'; confidence = directed ? 0.65 : 0.45 }
    else if (hits.includes('praise')) { candidateType = 'praise'; confidence = directed ? 0.6 : 0.4 }
    else if (hits.includes('invitation')) { candidateType = 'invitation'; confidence = 0.45 }
    else if (directed) {
      // 明确指向但无关键词：可能是普通对话/玩笑/提问，语义判断交 appraisal
      candidateType = 'directed_message'
      needsLlm = kwHit.length === 0
      confidence = directMention || directReplyToBot ? 0.5 : 0.4
    } else if (inExpectationWindow) {
      candidateType = 'possible_response'
      confidence = 0.4
    } else return null
    // 语义命中提置信度；灰区/冲突升级 LLM
    if (semEvent && semEvent === this._candidateEventName(candidateType)) confidence = Math.max(confidence, 0.5 + (semHit.score - this._semHigh))
    if (semGray || conflict) needsLlm = true

    if ((ed.minEventConfidence || 0.55) > 0.5 && confidence < (ed.minEventConfidence || 0.55) * 0.6) return null

    return {
      candidateType,
      actorUserId: String(norm.userId || '') || null,
      sourceMessageIds: [String(norm.id)],
      deterministicSignals,
      semanticSignals: null,
      needsLlm,
      confidence,
      occurredAt: norm.timestamp || Date.now(),
    }
  }

  /** candidateType → 事件名（语义命中与初判类型一致时提置信度用）。 */
  _candidateEventName(t) {
    if (t === 'direct_insult' || t === 'ambient_hostility') return 'insult'
    if (['apology', 'defense', 'rejection', 'thanks', 'praise', 'invitation'].includes(t)) return t
    return null
  }

  _mentionsNickname(text) {
    const t = String(text || '')
    for (const n of this.botNames) {
      if (/[A-Za-z0-9]/.test(n)) {
        const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`).test(t)) return true
      } else if (t.includes(n)) return true
    }
    return false
  }
}

export { KW as DETECT_KEYWORDS }
