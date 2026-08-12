/**
 * MessageBuffer —— 单群有界消息环（指南 §7、§3.1）。
 *
 * 设计：
 *  - 进程内内存（in-process）；AbortController/Timer/事件对象不可序列化，只存于进程内。
 *  - 容量：默认 150 条 / 2 小时 TTL，超限按 seq 淘汰最旧。
 *  - 批次游标：snapshotAfter(seq) 返回 seq 之后的所有消息（待处理批次），供 Scheduler 消费。
 *  - 注入 Prompt 的条数（contextMessages，默认 30）由调用方在 snapshot(limit) 控制——存储全量与注入全量分开。
 *  - 去重：同 id 不重复入队。
 *  - 记录机器人自身发言（isSelf=true）用于 presence 占比统计，但不参与触发。
 */

/**
 * @typedef {import('./message-normalizer.js').AmbientMessage} AmbientMessage
 */

export class MessageBuffer {
  /**
   * @param {object} opts { capacity?:number, ttlMs?:number }
   */
  constructor({ capacity = 150, ttlMs = 2 * 60 * 60 * 1000 } = {}) {
    this.capacity = Math.max(1, capacity | 0)
    this.ttlMs = Math.max(60_000, ttlMs | 0)
    /** @type {Array<AmbientMessage & {seq:number}>} */
    this._items = []
    this._seq = 0
    this._ids = new Set()
  }

  /** 单调递增序号（当前最大） */
  get lastSeq() { return this._seq }

  /** 当前条数 */
  get size() { return this._items.length }

  /**
   * 追加消息。同 id 去重；分配 seq；按容量与 TTL 淘汰。
   * @param {AmbientMessage} msg
   * @returns {number} 该消息的 seq（已存在则返回原 seq，第二个返回值 true 表示新增）
   */
  append(msg) {
    if (!msg || !msg.id) return -1
    if (this._ids.has(msg.id)) {
      const existing = this._items.find((m) => m.id === msg.id)
      return existing ? existing.seq : -1
    }
    this._seq += 1
    const item = { ...msg, seq: this._seq }
    this._items.push(item)
    this._ids.add(msg.id)
    this._trim()
    return item.seq
  }

  /** 标记某条消息为机器人自身发言（presence 统计用）。 */
  markSelf(messageId) {
    const it = this._items.find((m) => m.id === messageId)
    if (it) it.isSelf = true
  }

  /** 富化 quotesBot（replyToId 命中某条机器人消息）。返回是否更新成功。 */
  markQuotesBot(messageId) {
    const it = this._items.find((m) => m.id === messageId)
    if (it) { it.quotesBot = true; return true }
    return false
  }

  /** 按 id 取消息（不含 seq 包装则返回带 seq 的）。 */
  get(id) {
    return this._items.find((m) => m.id === id) || null
  }

  has(id) { return this._ids.has(id) }

  /**
   * 返回 seq 之后的所有消息（正序）。用于 Scheduler 取待处理批次。
   * @param {number} sinceSeq
   * @returns {Array<AmbientMessage & {seq:number}>}
   */
  snapshotAfter(sinceSeq) {
    return this._items.filter((m) => m.seq > sinceSeq)
  }

  /**
   * 返回最近 limit 条消息（正序，最旧在前）。用于注入 Prompt。
   * @param {number} limit
   * @param {object} opts { includeSelf?:boolean }
   */
  snapshot(limit = 30, { includeSelf = true } = {}) {
    const arr = includeSelf ? this._items : this._items.filter((m) => !m.isSelf)
    return arr.slice(-Math.max(0, limit | 0))
  }

  /** presence 统计：窗口内机器人发言占比原始数据（机器人条数、外部条数）。 */
  presenceStats(windowMs) {
    const cutoff = Date.now() - (windowMs || 0)
    let bot = 0
    let other = 0
    let lastBotAt = 0
    let lastExternalAt = 0
    const intervals = []
    let prevExternalAt = 0
    for (const m of this._items) {
      if (m.timestamp < cutoff) continue
      if (m.isSelf) {
        bot++
        if (m.timestamp > lastBotAt) lastBotAt = m.timestamp
      } else {
        other++
        if (prevExternalAt) intervals.push(m.timestamp - prevExternalAt)
        prevExternalAt = m.timestamp
        if (m.timestamp > lastExternalAt) lastExternalAt = m.timestamp
      }
    }
    return { bot, other, total: bot + other, lastBotAt, lastExternalAt, recentExternalIntervals: intervals }
  }

  /** 容量 + TTL 淘汰 */
  _trim() {
    const now = Date.now()
    // TTL：从头部丢弃过期
    while (this._items.length && now - this._items[0].timestamp > this.ttlMs) {
      const removed = this._items.shift()
      this._ids.delete(removed.id)
    }
    // 容量：从头部丢弃超限
    while (this._items.length > this.capacity) {
      const removed = this._items.shift()
      this._ids.delete(removed.id)
    }
  }

  /** 清空 */
  clear() {
    this._items = []
    this._ids.clear()
    this._seq = 0
  }
}
