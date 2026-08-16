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

import Log from '../../utils/Log.js'
import { resolvePersonaIdentity } from './default-config.js'

// URL 边界：排除空白/尖括号/引号/括号 + 全部 CJK 标点 + 全角空格，
// 否则 "看 https://x.com，超好笑" 会被贪婪匹配成 "https://x.com，超好笑"
const URL_RE = /https?:\/\/[^\s<>"'），。！？；：、“”‘’（）【】《》〈〉「」『』…　]+/g
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
export function splitSegments(text, { maxBubbles = 3, rand = Math.random } = {}) {
  const max = Math.max(1, Math.min(5, maxBubbles | 0))
  if (!text) return []
  const { masked, tokens } = protect(text)
  const textLen = [...masked].length
  if (textLen < 3) return [restore(masked, tokens)]
  // 1. 按句末标点 + 换行切
  let parts = masked.split(/(?<=[。！？!?…\n])\s*/).map((s) => s.trim()).filter(Boolean)
  // 2. 不足 2 段且较长 → 按逗号/分号/空格切
  if (parts.length < 2 && textLen > 40) {
    parts = masked.split(/(?<=[，,；;])\s*/).map((s) => s.trim()).filter(Boolean)
    if (parts.length < 2) parts = masked.split(/\s+/).filter(Boolean)
  }
  // 3. 概率合并（MaiBot split_strength by length：短文高合并率，长文低合并率）
  if (parts.length > 1) {
    const splitStrength = textLen < 12 ? 0.2 : textLen < 32 ? 0.6 : 0.7
    const mergeProb = 1.0 - splitStrength
    const merged = [parts[0]]
    for (let i = 1; i < parts.length; i++) {
      if (rand() < mergeProb) merged[merged.length - 1] += parts[i]
      else merged.push(parts[i])
    }
    parts = merged
  }
  // 4. 超过 max → 均衡合并
  if (parts.length <= max) return parts.map((p) => restore(p, tokens))
  const groupSize = Math.ceil(parts.length / max)
  const out = []
  for (let i = 0; i < parts.length; i += groupSize) out.push(parts.slice(i, i + groupSize).join(''))
  while (out.length > max) { out[out.length - 2] += out[out.length - 1]; out.pop() }
  return out.map((p) => restore(p, tokens))
}

/** 输入延迟（指南 §13 公式）。 */
export function typingDelayMs(text, cfg = {}) {
  const zh = (String(text || '').match(/[\u3400-\u9fff]/g) || []).length
  const other = Math.max(0, [...String(text || '')].length - zh)
  const speed = Math.max(0.1, Number(cfg.typingSpeed) || 1.0)
  const raw = (zh * 300 + other * 150) / speed // MaiBot: zh=0.3s/字 en=0.15s/字
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
    // 先剥除文本中的 [sticker:...] 标记（防泄漏到正文）
    const cleanText = this.stickerManager ? this.stickerManager.applyText(text, new Map()) : text
    const segments = splitSegments(cleanText, { maxBubbles })
    if (!segments.length) return { sentIds: [], sentTexts: [], cancelled: true, cancelReason: 'no_segments' }

    const gen = runtime.plannerGeneration
    const sentIds = []
    const sentTexts = [] // 与 sentIds 一一对应：实际发送成功的各段文本（部分发送中断时只含已发段）
    const botId = c.botId || 'bot'

    for (let i = 0; i < segments.length; i++) {
      // 取消：代变化（新消息重规划）/ 信号中止 / 目标失效
      if (!runtime.isCurrent(gen) || signal?.aborted) {
        return { sentIds, sentTexts, cancelled: true, cancelReason: 'superseded' }
      }
      // 后续段：模拟输入延迟（指南 §13：第一段尽快发，后续段按长度延迟）
      if (i > 0) {
        await sleep(typingDelayMs(segments[i], rcfg))
        if (!runtime.isCurrent(gen) || signal?.aborted) {
          return { sentIds, sentTexts, cancelled: true, cancelReason: 'superseded_mid' }
        }
      }
      // 首段可引用目标（action.quote）；后续段不重复引用
      const quoteTargetId = i === 0 && action.quote && target ? target.id : null
      let sentId = null
      try {
        sentId = await send(segments[i], { quoteTargetId })
      } catch (e) {
        runtime.trace?.record('send_error', { segment: i, msg: String(e?.message || e) })
        return { sentIds, sentTexts, cancelled: true, cancelReason: 'send_error' }
      }
      if (sentId) {
        sentIds.push(sentId)
        sentTexts.push(segments[i]) // deliveredText 语义：只有真实发出的段才算「已交付」
        // 把机器人自身发言写入 buffer（presence 占比统计 + 后续 quotesBot 判定）；displayName 与
        // Planner/Replyer 人设名同源（resolvePersonaIdentity 单一来源，不再一处角色名一处"我"）
        runtime.buffer.append({
          id: sentId, groupId: runtime.groupId, userId: botId, displayName: resolvePersonaIdentity(c).name,
          timestamp: Date.now(), text: segments[i], segments: [],
          replyToId: null, atBot: false, mentionsBotName: false, quotesBot: false,
          isCommand: false, isSelf: true, handledByDirectAgent: false, media: [],
        })
      } else {
        // send 返回 null = 静默失败 → 中止后续段（防"失败后继续发"）
        return { sentIds, sentTexts, cancelled: true, cancelReason: 'send_failed' }
      }
    }

    // 可选 Sticker 尾泡（复用现有 cooldown/sendRate/antiConsecutive；指南 §13）
    if (rcfg.allowSticker !== false && this.stickerManager?.enabled?.() && runtime.isCurrent(gen) && !signal?.aborted) {
      try {
        const acceptMap = this.stickerManager.decide(text, { isGroup: true, groupId: runtime.groupId })
        const sn = acceptMap ? [...acceptMap.keys()] : []
        // 日志分级（修复误导：此前"回复本来就没带标记"也打成"未附加（门控未过/无匹配）"，看起来像想发发不出）
        if (sn.length) Log.mark('[humanize] 表情包', `群${runtime.groupId} 附加 ${sn.join(',')}`)
        else if (/\[sticker:/i.test(text)) Log.warn('[humanize] 表情包', `群${runtime.groupId} 未附加：Replyer 带了标记但门控未过/无匹配（${text.match(/\[sticker:[^\]]*\]/gi)?.join(' ')}）`)
        // 取证（入全链路日志）：Replyer 原始标记 vs 实际命中——出现"虚构名→模糊兜底到语义不符的图"时可直接定位
        if (/\[sticker:/i.test(text)) runtime.trace?.record('sticker', { markers: (text.match(/\[sticker:[^\]]*\]/gi) || []).join(' '), attached: sn.join(','), sentCount: sentIds.length })
        // 无标记 → 模型本轮不想用表情包，不打日志（之前每条回复刷一行造成误读）
        if (acceptMap && acceptMap.size) {
          // 取一个 sticker 作为独立气泡。修复：applyText 是按"文本中的标记位置"插图片段的，
          // 空文本没有标记 → 返回 []（此前 sendMsg([]) 发出空气泡：适配器返回 id 但群里无内容，
          // "附加 X"日志刷了但表情从来没真正发出去过）。用首个命中名构造单标记文本产出真图片段。
          const firstName = [...acceptMap.keys()][0]
          const seg = this.stickerManager.applyText(`[sticker:${firstName}]`, acceptMap)
          if (Array.isArray(seg) && seg.length) {
            try {
              const sid = await send(seg[0], { quoteTargetId: null })
              if (sid) { sentIds.push(sid); this.stickerManager?.noteSent?.(sn) }
            } catch (e) { Log.warn('[humanize] 表情包发送失败', e?.message || e) }
          }
        }
      } catch (e) { Log.warn('[humanize] 表情包附加异常', e?.message || e) }
    }

    return { sentIds, sentTexts, cancelled: false }
  }

  /** 纯表情反应（第一版：发送一个 sticker）。 */
  async react({ action, target, runtime, send, signal }) {
    if (!this.stickerManager?.enabled?.()) return null
    if (signal?.aborted) return null
    try {
      // 用 intent 作为「内容」让 sticker 概率门控；无匹配则不发
      const acceptMap = this.stickerManager.decide(action.intent || '反应', { isGroup: true, groupId: runtime.groupId })
      if (!acceptMap || !acceptMap.size) return null
      // P1 修复（human_react 空段）：applyText('') 对空文本恒返回 []（无标记位可替换）——
      // 此前 send([]) 适配器或发空气泡或静默失败，表情反应从未真正发出。与正文路径同修：构造单标记文本
      const firstName = [...acceptMap.keys()][0]
      const seg = this.stickerManager.applyText(`[sticker:${firstName}]`, acceptMap)
      if (Array.isArray(seg) && seg.length) {
        const sid = await send(seg[0], { quoteTargetId: target?.id || null })
        if (sid) this.stickerManager?.noteSent?.([firstName])
        return sid
      }
    } catch (e) { Log.warn('[humanize] react 表情发送失败:', e?.message || e) }
    return null
  }
}

export { protect, restore }
