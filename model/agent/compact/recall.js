/**
 * context_recall 工具——无损压缩的恢复路径（跨窗口引用）。
 *
 * Agent 压缩档案消息里带有 archive ref；模型需要原文细节（数字/报错/代码片段）时：
 *  - 按 ref 取回归档原文（**有界分页**：offset/limit 或 from/to 消息区间）；
 *  - 按 ref + query 在指定归档内定位命中片段（offset 直接落在命中附近）；
 *  - 按 query 关键词跨归档检索（拿不准 ref 时，返回摘录与 ref）。
 * 恢复视图保留 message id / role / 工具名 / call_id / 工具调用参数，避免空正文 assistant
 * 的 tool_calls 被丢弃（F03）；单条大归档可逐页读到末尾（next_offset）。
 * 权限域：归档按 convKey 隔离，工具只读本会话（ctx → archiveFor 绑定），不越权。
 */
import { CompactionArchive } from './archive.js'

const DEFAULT_PAGE = 4000
const MIN_PAGE = 256
const MAX_PAGE = 8000
// 返回值整体（含 JSON 转义开销）必须低于 meta.resultCap，保证每页尾部的续读锚点不被外层封顶切掉
const RESULT_CHAR_BUDGET = 14000
const HIT_CONTEXT = 200

/** 把任意 content（字符串 / 协议原生块数组）还原为可读文本；媒体块给占位标注 */
const contentText = (c) => {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (b == null) return ''
      if (typeof b === 'string') return b
      if (typeof b.text === 'string') return b.text
      if (typeof b.type === 'string' && /image|file|document|audio|video/.test(b.type)) return `[${b.type}]`
      try { return JSON.stringify(b) } catch { return '' }
    }).filter(Boolean).join('\n')
  }
  try { return JSON.stringify(c) } catch { return '' }
}

const argText = (v) => {
  if (v == null) return '{}'
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

/** 逐条渲染，保留 role / 工具名 / call_id / tool_calls 参数等恢复所需结构 */
export const renderArchiveMessages = (messages = []) => {
  const out = []
  messages.forEach((m, i) => {
    const role = m?.role || 'unknown'
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const text = contentText(m.content)
      out.push(`[#${i} assistant]${text ? ' ' + text : ''}`)
      for (const tc of m.tool_calls) {
        const f = tc.function || tc
        const nm = tc.name || f?.name || 'unknown'
        const args = tc.arguments !== undefined ? tc.arguments : f?.arguments
        out.push(`[#${i} tool_call] name=${nm} id=${tc.id || ''} args=${argText(args)}`)
      }
    } else if (role === 'tool') {
      out.push(`[#${i} tool] id=${m.tool_call_id || ''}${m.name ? ' name=' + m.name : ''} ${contentText(m.content)}`)
    } else {
      out.push(`[#${i} ${role}] ${contentText(m.content)}`)
    }
  })
  return out.join('\n')
}

const clampInt = (v, min, max, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, Math.floor(n)))
}

export function makeContextRecallTool({ archiveFor }) {
  return {
    name: 'context_recall',
    description: '取回被上下文压缩归档的历史原文。当压缩档案中提到某条信息的细节（数字、报错、代码、完整命令、工具参数等）需要展开时使用：有 ref 就按 ref 取回；结果过大时用 offset/limit 分页续读，或用 from/to 取指定消息区间；只知道关键词就按 query 检索，或 ref+query 直接取命中附近片段。返回的 next_offset 非空表示还有后续页。',
    category: 'query',
    meta: { summary: '取回压缩归档原文（可分页）', resultCap: RESULT_CHAR_BUDGET + 2000 },
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '压缩档案/归档索引里给出的 ref（如 3-a1b2c3d4e5f60718.json）' },
        query: { type: 'string', description: '关键词检索（无 ref 时跨归档检索；有 ref 时在该归档内定位命中片段）' },
        offset: { type: 'integer', description: '按 ref 读取时的字符偏移（从 0 开始）；续读时用返回值里的 next_offset' },
        limit: { type: 'integer', description: `按 ref 读取时本页最大字符数（默认 ${DEFAULT_PAGE}，上限 ${MAX_PAGE}）` },
        from: { type: 'integer', description: '按 ref 读取时的起始消息序号（0 开始，含）' },
        to: { type: 'integer', description: '按 ref 读取时的结束消息序号（含）' },
      },
    },
    async execute({ ref, query, offset, limit, from, to } = {}, ctx = {}) {
      const convKey = ctx && (ctx.scopeUserId || ctx.userId)
        ? `${ctx.scopeUserId || ctx.userId}:${ctx.groupId || 'p'}:${ctx.conversationId || 'unknown'}`
        : null
      const archive = archiveFor ? archiveFor(ctx) : null
      if (!archive) return { ok: false, error: '当前会话无压缩归档（archive 未装配或未发生过压缩）' }
      const arch = archive instanceof CompactionArchive ? archive : null
      if (!arch) return { ok: false, error: 'archive 装配类型错误' }
      if (!ref && !query) return { ok: false, error: '需要 ref 或 query 之一' }
      if (!convKey) return { ok: false, error: '缺少会话上下文，无法定位归档' }

      if (ref) {
        const g = await Promise.resolve(arch.get(ref, { convKey }))
        if (!g.ok) return { ok: false, error: `取回归档失败：${g.code}${g.error ? '（' + g.error + '）' : ''}` }
        const total = g.messages.length
        const hasRange = Number.isFinite(Number(from)) || Number.isFinite(Number(to))
        let rangeFrom = null
        let rangeTo = null
        let subset = g.messages
        if (hasRange) {
          rangeFrom = clampInt(from, 0, Math.max(0, total - 1), 0)
          rangeTo = clampInt(to, 0, Math.max(0, total - 1), total - 1)
          if (rangeTo < rangeFrom) return { ok: false, error: '消息区间非法：to < from' }
          subset = g.messages.slice(rangeFrom, rangeTo + 1)
        }
        const text = renderArchiveMessages(subset)
        let start = clampInt(offset, 0, text.length, 0)
        let hitOffset
        if (query) {
          const idx = text.toLowerCase().indexOf(String(query).toLowerCase())
          if (idx < 0) return { ok: false, error: `该归档中未命中关键词：${query}` }
          hitOffset = idx
          if (!Number.isFinite(Number(offset))) start = Math.max(0, idx - HIT_CONTEXT) // 未显式给 offset 时直接落到命中附近
        }
        const pageSize = clampInt(limit, MIN_PAGE, MAX_PAGE, DEFAULT_PAGE)
        let page = text.slice(start, start + pageSize)
        const result = {
          ok: true, ref, count: g.count, epoch: g.epoch,
          message_count: total,
          ...(hasRange ? { from: rangeFrom, to: rangeTo } : {}),
          ...(hitOffset != null ? { hit_offset: hitOffset } : {}),
          total_chars: text.length,
          offset: start,
          returned: page.length,
          next_offset: start + page.length < text.length ? start + page.length : null,
          truncated: start > 0 || start + page.length < text.length,
          text: page,
        }
        // 全局工具结果封顶会把整个 JSON 截断：这里主动把页缩到预算内，保住 next_offset 等续读锚点
        let size = JSON.stringify(result).length
        while (size > RESULT_CHAR_BUDGET && result.text.length > MIN_PAGE) {
          const cut = result.text.length - Math.max(64, size - RESULT_CHAR_BUDGET + 64)
          result.text = result.text.slice(0, cut)
          result.returned = result.text.length
          result.next_offset = start + result.text.length < text.length ? start + result.text.length : null
          result.truncated = start > 0 || start + result.text.length < text.length
          size = JSON.stringify(result).length
        }
        return result
      }

      const hits = await arch.search(convKey, query)
      if (!hits.length) return { ok: false, error: `归档中未命中关键词：${query}` }
      return {
        ok: true,
        hits: hits.map((h) => ({ ref: h.ref, count: h.count, epoch: h.epoch, excerpt: h.excerpt.slice(0, 300) })),
        hint: '需要完整原文时用其中的 ref 再次调用；结果过大时用 offset/limit 续读或用 ref+query 直接取命中片段',
      }
    },
  }
}
