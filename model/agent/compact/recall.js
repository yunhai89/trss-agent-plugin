/**
 * context_recall 工具——无损压缩的恢复路径（跨窗口引用）。
 *
 * Agent 压缩档案消息里带有 archive ref；模型需要原文细节（数字/报错/代码片段）时：
 *  - 按 ref 精确取回整段归档原文；
 *  - 按 query 关键词跨归档检索（拿不准 ref 时）。
 * 权限域：归档按 convKey 隔离，工具只读本会话（ctx → archiveFor 绑定），不越权。
 */
import { CompactionArchive } from './archive.js'

const MAX_RETURN_CHARS = 8000

export function makeContextRecallTool({ archiveFor }) {
  return {
    name: 'context_recall',
    description: '取回被上下文压缩归档的历史原文。当压缩档案中提到某条信息的细节（数字、报错、代码、完整命令等）需要展开时使用：有 ref 就按 ref 精确取回整段；只知道关键词就按 query 检索。',
    category: 'query',
    meta: { summary: '取回压缩归档原文', resultCap: MAX_RETURN_CHARS },
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '压缩档案/归档索引里给出的 ref（如 3-a1b2c3d4e5f60718.json）' },
        query: { type: 'string', description: '关键词检索（无 ref 时用；返回命中归档的摘录与 ref）' },
      },
    },
    async execute({ ref, query } = {}, ctx = {}) {
      const convKey = ctx && (ctx.scopeUserId || ctx.userId)
        ? `${ctx.scopeUserId || ctx.userId}:${ctx.groupId || 'p'}:${ctx.conversationId || 'unknown'}`
        : null
      const archive = archiveFor ? archiveFor(ctx) : null
      if (!archive) return { ok: false, error: '当前会话无压缩归档（archive 未装配或未发生过压缩）' }
      const arch = archive instanceof CompactionArchive ? archive : null
      if (!arch) return { ok: false, error: 'archive 装配类型错误' }
      if (ref) {
        if (!convKey) return { ok: false, error: '缺少会话上下文，无法定位归档' }
        const g = await Promise.resolve(arch.get(ref, { convKey }))
        if (!g.ok) return { ok: false, error: `取回归档失败：${g.code}${g.error ? '（' + g.error + '）' : ''}` }
        let text = g.messages.map((m) => `[${m.role}]${m.tool_call_id ? '(' + m.tool_call_id + ')' : ''} ${typeof m.content === 'string' ? m.content : JSON.stringify(m.tool_calls || m.content || '')}`).join('\n')
        if (text.length > MAX_RETURN_CHARS) text = text.slice(0, MAX_RETURN_CHARS) + `\n…(已截断 ${text.length - MAX_RETURN_CHARS} 字)`
        return { ok: true, ref, count: g.count, epoch: g.epoch, text }
      }
      if (query) {
        if (!convKey) return { ok: false, error: '缺少会话上下文，无法定位归档' }
        const hits = await arch.search(convKey, query)
        if (!hits.length) return { ok: false, error: `归档中未命中关键词：${query}` }
        return {
          ok: true, hits: hits.map((h) => ({ ref: h.ref, count: h.count, epoch: h.epoch, excerpt: h.excerpt.slice(0, 300) })),
          hint: '需要完整原文时用其中的 ref 再次调用',
        }
      }
      return { ok: false, error: '需要 ref 或 query 之一' }
    },
  }
}
