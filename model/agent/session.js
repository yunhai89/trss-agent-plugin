/**
 * 会话存储 —— 多轮对话历史。
 *
 * 两套模型：
 *  1. group:user 会话（原有）：按 group:user 隔离，滑动窗口 + TTL。
 *  2. 用户多对话（conversation，新增）：每用户可有多个并行对话（类似 ChatGPT 对话列表），
 *     各有 id、标题、历史；一个活跃指针。用于 #聊天列表 / #进入聊天 / #new。
 *
 * 系统提示每轮重建（不存储）。
 */

export class SessionStore {
  constructor({ kv, prefix = 'Yz:agent:sess:', window = 20, ttl = 86400 } = {}) {
    if (!kv) throw new Error('SessionStore 需要 kv')
    this.kv = kv
    this.prefix = prefix
    this.window = window
    this.ttl = ttl
    this._cache = new Map()
  }

  // —— group:user 会话（原有）——
  key(groupId, userId) {
    return `${this.prefix}${groupId || 'private'}:${userId}`
  }

  async get(k) {
    if (!this._cache.has(k)) {
      const val = await this.kv.get(k)
      this._cache.set(k, unpack(val))
    }
    return this._cache.get(k).map((m) => ({ ...m }))
  }

  async getMessages(k) {
    return this.get(k)
  }

  /**
   * 取当前会话历史条数（只读，复用缓存）。供 perception 判断"会话上下文是否稀薄"
   * —— 内部封装 conversation / group:user 两种模式的取数逻辑，调用方无需关心键构造。
   */
  async historyLength({ userId, groupId, conversationId } = {}) {
    try {
      if (conversationId != null && typeof this.getConversation === 'function') {
        return (await this.getConversation(userId, groupId, conversationId)).length
      }
      return (await this.get(this.key(groupId, userId))).length
    } catch { return 0 }
  }

  async append(k, msgs) {
    if (!msgs || !msgs.length) return this.get(k)
    const cur = await this.get(k)
    const next = [...cur, ...msgs]
    const trimmed = trimKeepFirst(next, this.window)
    this._cache.set(k, trimmed)
    await this.kv.set(k, { messages: trimmed, updatedAt: Date.now() }, this.ttl)
    return trimmed
  }

  async clear(k) {
    this._cache.delete(k)
    await this.kv.del(k)
  }

  async listAll() {
    const keys = await this.kv.scan(this.prefix)
    const out = []
    for (const k of keys) {
      if (k.includes(':conv:')) continue // 跳过 conversation 键
      const val = await this.kv.get(k)
      const msgs = unpack(val)
      const rest = k.slice(this.prefix.length)
      const [group, user] = rest.split(':')
      out.push({ key: k, group, user, count: msgs.length, updatedAt: val?.updatedAt || null, preview: preview(msgs) })
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  // —— 用户多对话（conversation，按 群+用户 隔离：同一用户在不同群有各自独立的对话列表）——
  convKey(userId, groupId, convId) {
    return `${this.prefix}conv:${groupId || 'private'}:${userId}:${convId}`
  }
  activeKey(userId, groupId) {
    return `${this.prefix}conv:active:${groupId || 'private'}:${userId}`
  }
  seqKey(userId, groupId) {
    return `${this.prefix}conv:seq:${groupId || 'private'}:${userId}`
  }

  async _nextConvId(userId, groupId) {
    const seq = (await this.kv.get(this.seqKey(userId, groupId))) || 0
    const id = String(seq + 1)
    await this.kv.set(this.seqKey(userId, groupId), seq + 1)
    return id
  }

  /** 新建对话并设为活跃 */
  async createConversation(userId, groupId, title) {
    const id = await this._nextConvId(userId, groupId)
    const conv = {
      id,
      title: title || `对话 ${id}`,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await this.kv.set(this.convKey(userId, groupId, id), conv)
    await this.setActiveConversation(userId, groupId, id)
    return conv
  }

  /** 列出用户在指定群的全部对话（id/title/条数/更新时间/预览） */
  async listConversations(userId, groupId) {
    const gid = groupId || 'private'
    const scanPrefix = `${this.prefix}conv:${gid}:${userId}:`
    const keys = (await this.kv.scan(scanPrefix)).filter((k) => !k.endsWith(':active') && !k.includes(':seq:'))
    const out = []
    for (const k of keys) {
      const c = await this.kv.get(k)
      if (!c) continue
      out.push({
        id: c.id,
        title: c.title || `对话 ${c.id}`,
        count: (c.messages || []).length,
        updatedAt: c.updatedAt || c.createdAt || 0,
        createdAt: c.createdAt || 0,
        preview: preview(c.messages || []),
      })
    }
    return out.sort((a, b) => Number(a.id) - Number(b.id))
  }

  /** 列出全局所有 scope 的全部对话（每条带 scopeUserId/scopeGroupId，供 web 会话回放全局视图；与概览"活跃对话"同源，避免依赖 memories 目录选 scope 导致两边数据不一致） */
  async listAllConversations() {
    const keys = (await this.kv.scan(`${this.prefix}conv:`))
      .filter((k) => !k.includes(':active:') && !k.includes(':seq:'))
    const out = []
    for (const k of keys) {
      const c = await this.kv.get(k).catch(() => null)
      if (!c) continue
      // 键形态：...conv:<gid>:<uid>:<convId>（gid='private' 或数字；末两段为 uid/convId）
      const parts = k.slice(`${this.prefix}conv:`.length).split(':')
      const convId = parts[parts.length - 1]
      const userId = parts[parts.length - 2] || ''
      const groupId = parts.slice(0, -2).join(':') || 'private'
      out.push({
        id: c.id,
        title: c.title || `对话 ${c.id}`,
        count: (c.messages || []).length,
        updatedAt: c.updatedAt || c.createdAt || 0,
        createdAt: c.createdAt || 0,
        preview: preview(c.messages || []),
        scopeUserId: userId,
        scopeGroupId: groupId === 'private' ? '' : groupId,
      })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 取活跃对话 id；若无则自动创建首个 */
  async getActiveConversation(userId, groupId) {
    const v = await this.kv.get(this.activeKey(userId, groupId))
    if (v) return v
    const list = await this.listConversations(userId, groupId)
    if (list.length) {
      await this.setActiveConversation(userId, groupId, list[0].id)
      return list[0].id
    }
    const c = await this.createConversation(userId, groupId)
    return c.id
  }

  async setActiveConversation(userId, groupId, convId) {
    const exists = await this.kv.get(this.convKey(userId, groupId, String(convId)))
    if (!exists) return false
    await this.kv.set(this.activeKey(userId, groupId), String(convId))
    return true
  }

  async getConversation(userId, groupId, convId) {
    const c = await this.kv.get(this.convKey(userId, groupId, String(convId)))
    return (c?.messages || []).map((m) => ({ ...m }))
  }

  /** 读对话 meta（id/title/createdAt/updatedAt，不含 messages），供 devLog 拼 per-会话日志文件名 */
  async getConversationMeta(userId, groupId, convId) {
    const c = await this.kv.get(this.convKey(userId, groupId, String(convId)))
    if (!c) return null
    return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt }
  }

  async appendConversation(userId, groupId, convId, msgs, extra = {}) {
    const k = this.convKey(userId, groupId, String(convId))
    const c = (await this.kv.get(k)) || { id: String(convId), title: `对话 ${convId}`, messages: [], createdAt: Date.now() }
    const next = [...(c.messages || []), ...msgs]
    const trimmed = trimKeepFirst(next, this.window)
    c.messages = trimmed
    c.updatedAt = Date.now()
    // extra：会话级非消息状态（如 toolDiscovery 的 activeTools——跨轮恢复保 tools 前缀稳定，缓存不 bust）
    for (const [ek, ev] of Object.entries(extra || {})) if (ev !== undefined) c[ek] = ev
    await this.kv.set(k, c)
    return trimmed
  }

  /** 读会话级状态（不含 messages）。Agent.run 恢复 activeTools 用；旧对话无该字段返回空。 */
  async getConversationState(userId, groupId, convId) {
    const c = await this.kv.get(this.convKey(userId, groupId, String(convId)))
    return { activeTools: c && Array.isArray(c.activeTools) ? c.activeTools : null }
  }

  async deleteConversation(userId, groupId, convId) {
    await this.kv.del(this.convKey(userId, groupId, String(convId)))
    const active = await this.kv.get(this.activeKey(userId, groupId))
    if (active === String(convId)) {
      const list = await this.listConversations(userId, groupId)
      if (list.length) await this.setActiveConversation(userId, groupId, list[0].id)
      else await this.createConversation(userId, groupId)
    }
  }
}

function unpack(val) {
  if (!val) return []
  if (Array.isArray(val)) return val
  if (Array.isArray(val.messages)) return val.messages
  return []
}

/**
 * 滑动窗口裁剪，但始终保留首条消息（用户原始意图），避免长对话丢失最初目标。
 *
 * 按 **turn-block** 淘汰而非按消息切片（审计 §2.2）：assistant(tool_calls) 与其后的连续 tool 结果
 * 视为一个原子块，裁剪只在块边界丢弃——绝不留下孤立的 tool 结果（其触发 assistant 已被移除会
 * 触发 OpenAI 400 / Anthropic 语义异常）。借鉴 Agent._compactMessages 的 block 边界判定。
 *
 * 结果条数可能略多于 window（最后保留的块整体纳入），多几条远好过破坏 tool_call/tool_result 配对。
 */
function trimKeepFirst(arr, window) {
  if (!Array.isArray(arr) || arr.length <= window) return arr
  // 把消息分段成 turn-blocks：单条 user/assistant(text) 各成一块；
  // assistant(tool_calls) + 其后连续 tool* 是一个原子块（不可拆）。
  const blocks = []
  for (let i = 0; i < arr.length;) {
    const m = arr[i]
    if (m && m.role === 'assistant' && m.tool_calls?.length) {
      const block = [m]
      let j = i + 1
      while (j < arr.length && arr[j].role === 'tool') { block.push(arr[j]); j++ }
      blocks.push(block)
      i = j
    } else {
      blocks.push([m])
      i++
    }
  }
  // 始终保留首块（首条意图）+ 从尾部往回纳入完整块，直到累计条数 >= window
  const head = blocks[0]
  let keepCount = head.length
  const tail = []
  for (let b = blocks.length - 1; b >= 1; b--) {
    if (keepCount >= window) break
    tail.unshift(blocks[b])
    keepCount += blocks[b].length
  }
  return [...head, ...tail.flat()]
}

function preview(msgs) {
  const last = [...msgs].reverse().find((m) => m.role === 'user' || m.role === 'assistant')
  const c = last?.content
  return typeof c === 'string' ? c.slice(0, 80) : ''
}
