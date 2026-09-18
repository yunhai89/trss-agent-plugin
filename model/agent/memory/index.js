/**
 * memory 公共出口 + memory 工具构造器。
 *
 * memory 工具让 Agent 在对话中读写声明式记忆；记忆自动注入 system prompt，故无 read 动作。
 * 工具内部捕获 MemoryLimitError / 匹配错误，以 {error, ...} 结构化结果返回（不抛异常），
 * 以便模型在下一轮自行 replace/remove 腾出空间后重试（Hermes 同款语义）。
 */
export { MemoryStore, MemoryLimitError, MemoryThreatError } from './store.js'

/**
 * 构造 memory_search 工具（模型主动召回长期记忆，参考 OpenClaw memory_search）。
 * 复用 RecallStore.retrieve（相似度×时间衰减×置信度加权召回），按 ctx.userId 隔离。
 * 与声明式 memory 工具（写）互补：这是只读的主动检索通道。
 * @param {import('../../recall.js').RecallStore} recall
 */
export function makeRecallTool(recall) {
  return {
    name: 'memory_search',
    description: '检索关于当前用户的长期记忆（跨会话持久；偏好/身份/事实/近期事项）。何时用：回答涉及用户先前说过的偏好、身份、历史决策、待办或"你记得吗"类问题时，先调用本工具核实，不要凭印象作答。返回若干条带类型与时间的记忆。',
    category: 'query',
    meta: { summary: '检索用户长期记忆' },
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或问题（用于语义/关键词匹配）' },
        topK: { type: 'integer', description: '返回条数（默认 5）' },
      },
      required: ['query'],
    },
    async execute({ query, topK } = {}, ctx) {
      const q = String(query || '').trim()
      if (!q) return { error: '缺少 query' }
      const userId = ctx?.scopeUserId || ctx?.userId
      if (!userId) return { error: '无用户上下文，无法检索记忆' }
      const hits = await recall.retrieve(q, userId, Math.max(1, Number(topK) || 5))
      if (!hits.length) return { found: 0, text: '未检索到相关长期记忆。' }
      const lines = [`找到 ${hits.length} 条相关记忆：`]
      hits.forEach((m, i) => {
        const type = m.type || 'fact'
        const date = m.updatedAt ? new Date(m.updatedAt).toISOString().slice(0, 10) : '?'
        const score = m._score != null ? ` score=${m._score.toFixed(2)}` : ''
        lines.push(`${i + 1}. [${type}]（更新于 ${date}${score}）\n   ${String(m.content || '').trim()}`)
      })
      return { found: hits.length, text: lines.join('\n') }
    },
  }
}

/**
 * 构造 memory 工具定义（注册到 ToolRegistry）。
 * @param {MemoryStore} store
 */
export function createMemoryTool(store) {
  return {
    name: 'memory',
    description: [
      '管理长期记忆（跨会话持久）。',
      'target: memory(你的个人笔记/环境事实/经验) | user(用户画像/偏好)。',
      'action: add(新增) | replace(用 old_text 子串唯一定位条目并替换) | remove(子串定位删除) | batch(原子批量 operations)。',
      '记忆会自动注入 system prompt，无需 read。接近上限(>80%)时先 replace/remove 合并再 add。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['memory', 'user'] },
        action: { type: 'string', enum: ['add', 'replace', 'remove', 'batch'] },
        text: { type: 'string', description: 'add 时的条目文本' },
        old_text: { type: 'string', description: 'replace/remove 时唯一定位条目的子串' },
        new_text: { type: 'string', description: 'replace 时的新文本' },
        operations: {
          type: 'array',
          description: 'batch 时的操作数组，每项 {action, text?, old_text?, new_text?}',
          items: { type: 'object' },
        },
      },
      required: ['target', 'action'],
    },
    async execute(params, ctx) {
      const { target, action } = params
      const scopeId = ctx?.scopeId
      try {
        if (action === 'add') return store.add(target, params.text, scopeId)
        if (action === 'replace') return store.replace(target, params.old_text, params.new_text, scopeId)
        if (action === 'remove') return store.remove(target, params.old_text, scopeId)
        if (action === 'batch') return store.batch(target, params.operations, scopeId)
        return { error: `未知 action：${action}` }
      } catch (e) {
        // 超限/匹配失败：结构化返回，便于模型在同一轮调整后重试
        const out = { error: e.message || String(e) }
        if (e.target) out.target = e.target
        if (e.used != null) out.used = e.used
        if (e.limit != null) out.limit = e.limit
        if (e.entries) out.entries = e.entries
        return out
      }
    },
  }
}
