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
import { buildReplyerSystem, formatGroupContext } from './prompts.js'

const REPLY_LEAK_PATTERNS = [
  /作为一个\s*(AI|人工智能|语言模型)/, /根据系统(指令|提示|设定)/, /我(?:将|会)(?:调用|使用)工具/,
  /^(?:回复：|回复:|答：|答:)\s*/, /(?:Planner|planner|规划器|工具调用)/,
  /我(?:是|属于)(?:一个|由).*?(?:AI|人工智能|开发|制作)/,
]

function looksLikeReplyLeak(text) {
  const t = String(text || '')
  return REPLY_LEAK_PATTERNS.some((re) => re.test(t))
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
   * @param {object} opts { provider, cfg, getPersonaVoice?:(groupId)=>string, getRecentBotText?:(groupId)=>string, getStyleExamples?:(groupId)=>string }
   */
  constructor({ provider, cfg, getPersonaVoice = null, getRecentBotText = null, getStyleExamples = null } = {}) {
    this.provider = provider
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.getPersonaVoice = getPersonaVoice || (() => '')
    this.getRecentBotText = getRecentBotText || (() => '')
    this.getStyleExamples = getStyleExamples || (() => '')
  }

  /**
   * 生成可见回复文本。
   * @param {object} ctx { action, batch, decision, target, runtime, signal, cfg }
   * @returns {Promise<{text:string, rewritten:boolean, cancelReason?:string}>}
   */
  async generate({ action, batch, runtime, signal, cfg }) {
    const c = cfg || this._cfgFn()
    const rcfg = c.replyer || {}
    const model = rcfg.model || c.model || null
    const temperature = rcfg.temperature ?? 0.7
    const maxTokens = rcfg.maxTokens ?? 500
    const maxChars = rcfg.maxChars ?? 500
    const contextMessages = c.contextMessages ?? 30
    const groupId = runtime?.groupId

    const recent = formatGroupContext(
      (Array.isArray(batch) ? batch : []).slice(-contextMessages),
      { includeIds: false },
    )

    const personaVoice = await this.getPersonaVoice(groupId)
    const system = buildReplyerSystem({
      personaName: c.personaName || '机器人',
      replyGuide: action.replyGuide || '',
      referenceInfo: action.referenceInfo || '',
      personaVoice,
      approvedStyleExamples: this.getStyleExamples(groupId),
      recentMessages: recent,
    })

    let text = await this._call(system, model, temperature, maxTokens, signal)
    text = String(text || '').trim()

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
    // 5. 与最近机器人回复高度重复 → 取消
    const lastBot = this.getRecentBotText(groupId)
    if (lastBot && similarity(text, lastBot) >= 0.9) {
      runtime?.trace?.record('replyer_duplicate', { sim: similarity(text, lastBot) })
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
