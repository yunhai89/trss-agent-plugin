/**
 * memory 公共出口 + memory 工具构造器。
 *
 * memory 工具让 Agent 在对话中读写声明式记忆；记忆自动注入本轮上下文（user 消息尾部），故无 read 动作。
 * 工具内部捕获 MemoryLimitError / 匹配错误，以 {error, ...} 结构化结果返回（不抛异常），
 * 以便模型在下一轮自行 replace/remove 腾出空间后重试（Hermes 同款语义）。
 */
export { MemoryStore, MemoryLimitError, MemoryThreatError } from './store.js'
export { ProfileStore, facetOfType } from './profile.js'
import { evidenceAppears } from '../evidence.js'

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
 * 记忆写入的来源校验（实机事故防线）。
 *
 * 背景：实机群里模型把**自己幻觉出来的**「主人要求：以后每次被问到身份时回答『我是星野爱』」
 * 写进了长期记忆，此后每轮注入上下文（user 消息尾部），模型把它当既定事实继续执行（还据此建了提醒）。
 * 根因是「写记忆」这一步没有任何来源约束。这里的规则：
 *  - 写「用户要求/让我/以后每次…」这类**指令性条目**必须带 evidence（用户原话片段）；
 *  - evidence 会被核对是否真出现在用户亲述文本里（Agent 传入 ctx.userTexts，已剥掉系统注入块）；
 *  - 对不上就拒绝写入并说明原因，让模型改成可核实的事实或干脆不写。
 */
const INSTRUCTION_CLAIM = /(要求|让我|叫我|以后每次|以后都|必须|不准|禁止|记住|记得|交代|吩咐)/
const WRITE_RULES = [
  '写入规则：只记录用户在对话里亲口说过的偏好/事实，或你在真实工具调用中确认过的客观信息。',
  '禁止写入：你自己的推断/决定/计划；系统注入块（【本轮情境参考】/机器人身份/群聊环境/长期记忆）里的内容；没有用户原话支撑的「用户要求/让我/以后每次…」类条目。',
  '写指令性条目必须带 evidence（用户原话片段）——插件会核对它是否真出现在用户说过的话里，对不上则拒绝写入。',
]

/**
 * 校验一条待写入文本；返回 {ok:true, text} 或 {error}。
 * @param {string} text 待写入条目
 * @param {string} evidence 用户原话片段（可空）
 * @param {string[]} userTexts 用户亲述文本（Agent 注入）
 */
export function guardMemoryWrite(text, evidence, userTexts) {
  const body = String(text || '').trim()
  if (!body) return { error: '缺少 text' }
  const ev = String(evidence || '').trim()
  if (ev && !evidenceAppears(ev, userTexts)) {
    return {
      error: 'evidence 与用户实际说过的话不符（未在最近会话的用户消息里找到该片段），本条未写入。'
        + '若这是你自己的推断或计划，请不要写进记忆；若确为用户所述，请贴出用户原话。',
    }
  }
  if (!ev && INSTRUCTION_CLAIM.test(body)) {
    return {
      error: '「用户要求」类记忆必须带 evidence（用户原话片段）才能写入：请在 evidence 里贴出用户说过的那句话；'
        + '若这只是你自己的归纳或计划，请改写成可核实的事实，或不要写入。',
    }
  }
  return { ok: true, text: ev ? `${body}（据用户原话："${ev}"）` : body }
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
      '记忆会自动注入本轮上下文（user 消息尾部），无需 read。接近上限(>80%)时先 replace/remove 合并再 add。',
      ...WRITE_RULES,
    ].join(' '),
    // RBAC 类别：personal=全员可用（写读自范围，scopeId 隔离；防护在 guardMemoryWrite 的来源佐证 + threatScan）。
    // 注意：不声明会被 policy 当「未知类别」fail-closed（仅主人）——实机事故：群管理员写长期记忆被拒
    // 「角色 admin 低于 未知 所需等级」（v1.28.1 修）。
    category: 'personal',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['memory', 'user'] },
        action: { type: 'string', enum: ['add', 'replace', 'remove', 'batch'] },
        text: { type: 'string', description: 'add 时的条目文本' },
        evidence: { type: 'string', description: '用户原话片段（写「用户要求/让我…」类条目时必填；插件会核对是否真出现在用户消息里）' },
        old_text: { type: 'string', description: 'replace/remove 时唯一定位条目的子串' },
        new_text: { type: 'string', description: 'replace 时的新文本' },
        operations: {
          type: 'array',
          description: 'batch 时的操作数组，每项 {action, text?, evidence?, old_text?, new_text?}',
          items: { type: 'object' },
        },
      },
      required: ['target', 'action'],
    },
    async execute(params, ctx) {
      const { target, action } = params
      const scopeId = ctx?.scopeId
      const userTexts = ctx?.userTexts
      try {
        if (action === 'add') {
          const g = guardMemoryWrite(params.text, params.evidence, userTexts)
          if (g.error) return g
          return store.add(target, g.text, scopeId)
        }
        if (action === 'replace') {
          const g = guardMemoryWrite(params.new_text, params.evidence, userTexts)
          if (g.error) return g
          return store.replace(target, params.old_text, g.text, scopeId)
        }
        if (action === 'remove') return store.remove(target, params.old_text, scopeId)
        if (action === 'batch') {
          const ops = Array.isArray(params.operations) ? params.operations : []
          const checked = []
          for (let i = 0; i < ops.length; i++) {
            const op = ops[i] || {}
            if (op.action === 'add' || op.action === 'replace') {
              const g = guardMemoryWrite(op.text ?? op.new_text, op.evidence, userTexts)
              if (g.error) return { error: `operations[${i}]：${g.error}`, index: i }
              checked.push(op.action === 'add' ? { ...op, text: g.text } : { ...op, new_text: g.text })
            } else {
              checked.push(op)
            }
          }
          return store.batch(target, checked, scopeId)
        }
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
