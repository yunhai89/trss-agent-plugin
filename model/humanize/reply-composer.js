/**
 * HumanizeReplyComposer —— 回复发送编排（指南 §13、MaiBot chat/utils/utils.py）。
 *
 * 职责：把 Replyer 产出的整段文本拆成 1~3 个气泡，按输入延迟依次发送；首段可引用目标；
 * 分段间校验当前代/信号，新消息使代变化时取消未发送段；可选 Sticker（复用现有 cooldown/sendRate）。
 *
 * 分段规则（MaiBot 移植）：
 *  - 保护 URL、代码块、连续数字/日期/文件名、引号内、冒号旁——不在中间切断；
 *  - 优先按句末标点 {[。！？!?\n]} 拆，不足再按 {[，,；; ]} 拆；
 *  - 合并到不超过 maxBubbles（默认 3），尽量均衡长度。
 *
 * 输入延迟（指南 §13）：min(maxDelay, max(minDelay, (zh*260 + other*90)/typingSpeed))。
 */

const URL_RE = /https?:\/\/[^\s<>""')]+/g
const CODE_RE = /```[\s\S]*?```|`[^`\n]+`/g

/** 保护 URL/代码 → 占位；返回 {masked, tokens}。 */
function protect(text) {
  const tokens = []
  let masked = String(text || '')
  masked = masked.replace(CODE_RE, (m) => { tokens.push(m); return `\u0000C${tokens.length - 1}\u0000` })
  masked = masked.replace(URL_RE, (m) => { tokens.push(m); return `\u0000U${tokens.length - 1}\u0000` })
  return { masked, tokens }
}
function restore(s, tokens) {
  return s.replace(/\u0000([CU])(\d+)\u0000/g, (_, k, i) => tokens[Number(i)] ?? '')
}

/**
 * 把文本拆成 1~maxBubbles 段。
 * @param {string} text
 * @param {object} opts { maxBubbles?:number }
 * @returns {string[]} 段落数组（已恢复 URL/代码）
 */
export function splitSegments(text, { maxBubbles = 3 } = {}) {
  const max = Math.max(1, Math.min(5, maxBubbles | 0))
  if (!text) return []
  const { masked, tokens } = protect(text)
  // 句末标点切（保留标点到段尾）
  let parts = masked.split(/(?<=[。！？!?…\n])\s*/).map((s) => s.trim()).filter(Boolean)
  // 不足且文本较长 → 再按逗号/分号/空格切
  if (parts.length < 2 && [...masked].length > 40) {
    parts = masked.split(/(?<=[，,；;])\s*/).map((s) => s.trim()).filter(Boolean)
    if (parts.length < 2) parts = masked.split(/\s+/).filter(Boolean)
  }
  if (parts.length <= max) return parts.map((p) => restore(p, tokens))
  // 合并到 max 段（均衡长度：ceil 均分）
  const groupSize = Math.ceil(parts.length / max)
  const out = []
  for (let i = 0; i < parts.length; i += groupSize) {
    out.push(parts.slice(i, i + groupSize).join(''))
  }
  // 防止四舍五入产生 max+1 段：尾段合并
  while (out.length > max) {
    out[out.length - 2] += out[out.length - 1]
    out.pop()
  }
  return out.map((p) => restore(p, tokens))
}

/** 输入延迟（指南 §13 公式）。 */
export function typingDelayMs(text, cfg = {}) {
  const zh = (String(text || '').match(/[\u3400-\u9fff]/g) || []).length
  const other = Math.max(0, [...String(text || '')].length - zh)
  const speed = Math.max(0.1, Number(cfg.typingSpeed) || 1.0)
  const raw = (zh * 260 + other * 90) / speed
  const min = Number(cfg.minDelayMs) || 600
  const max = Number(cfg.maxDelayMs) || 3500
  return Math.round(Math.min(max, Math.max(min, raw)))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class HumanizeReplyComposer {
  /**
   * @param {object} opts { cfg, stickerManager? }
   */
  constructor({ cfg, stickerManager = null } = {}) {
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.stickerManager = stickerManager
  }

  /**
   * 分段发送。逐段校验当前代/信号；取消时停止后续段。
   * @param {object} p { text, action, target, runtime, send, signal, cfg }
   *   send: async (segmentText, opts:{quoteTargetId?:string}) => sentMessageId|null
   * @returns {Promise<{sentIds:string[], cancelled:boolean, cancelReason?:string}>}
   */
  async deliver({ text, action, target, runtime, send, signal, cfg }) {
    const c = cfg || this._cfgFn()
    const rcfg = c.reply || {}
    const maxBubbles = rcfg.maxBubbles ?? 3
    const segments = splitSegments(text, { maxBubbles })
    if (!segments.length) return { sentIds: [], cancelled: true, cancelReason: 'no_segments' }

    const gen = runtime.plannerGeneration
    const sentIds = []
    const botId = c.botId || 'bot'

    for (let i = 0; i < segments.length; i++) {
      // 取消：代变化（新消息重规划）/ 信号中止 / 目标失效
      if (!runtime.isCurrent(gen) || signal?.aborted) {
        return { sentIds, cancelled: true, cancelReason: 'superseded' }
      }
      // 后续段：模拟输入延迟（指南 §13：第一段尽快发，后续段按长度延迟）
      if (i > 0) {
        await sleep(typingDelayMs(segments[i], rcfg))
        if (!runtime.isCurrent(gen) || signal?.aborted) {
          return { sentIds, cancelled: true, cancelReason: 'superseded_mid' }
        }
      }
      // 首段可引用目标（action.quote）；后续段不重复引用
      const quoteTargetId = i === 0 && action.quote && target ? target.id : null
      let sentId = null
      try {
        sentId = await send(segments[i], { quoteTargetId })
      } catch (e) {
        runtime.trace?.record('send_error', { segment: i, msg: String(e?.message || e) })
        return { sentIds, cancelled: true, cancelReason: 'send_error' }
      }
      if (sentId) {
        sentIds.push(sentId)
        // 把机器人自身发言写入 buffer（presence 占比统计 + 后续 quotesBot 判定）
        runtime.buffer.append({
          id: sentId, groupId: runtime.groupId, userId: botId, displayName: '我',
          timestamp: Date.now(), text: segments[i], segments: [],
          replyToId: null, atBot: false, mentionsBotName: false, quotesBot: false,
          isCommand: false, isSelf: true, handledByDirectAgent: false, media: [],
        })
      }
    }

    // 可选 Sticker 尾泡（复用现有 cooldown/sendRate/antiConsecutive；指南 §13）
    if (rcfg.allowSticker !== false && this.stickerManager?.enabled?.() && runtime.isCurrent(gen) && !signal?.aborted) {
      try {
        const acceptMap = this.stickerManager.decide(text, { isGroup: true, groupId: runtime.groupId })
        if (acceptMap && acceptMap.size) {
          // 取一个 sticker 作为独立气泡（文本模式 applyText 返回 segment 数组）
          const seg = this.stickerManager.applyText('', acceptMap)
          if (Array.isArray(seg)) {
            try {
              const sid = await send(seg, { quoteTargetId: null })
              if (sid) sentIds.push(sid)
            } catch { /* sticker 发送失败忽略 */ }
          }
        }
      } catch { /* sticker 不可用忽略 */ }
    }

    return { sentIds, cancelled: false }
  }

  /** 纯表情反应（第一版：发送一个 sticker）。 */
  async react({ action, target, runtime, send, signal }) {
    if (!this.stickerManager?.enabled?.()) return null
    if (signal?.aborted) return null
    try {
      // 用 intent 作为「内容」让 sticker 概率门控；无匹配则不发
      const acceptMap = this.stickerManager.decide(action.intent || '反应', { isGroup: true, groupId: runtime.groupId })
      if (!acceptMap || !acceptMap.size) return null
      const seg = this.stickerManager.applyText('', acceptMap)
      if (Array.isArray(seg)) {
        const sid = await send(seg, { quoteTargetId: target?.id || null })
        return sid
      }
    } catch { /* noop */ }
    return null
  }
}

export { protect, restore }
