/**
 * Semaphore —— 并发限流，防 multi-agent 扇出失控（文档 §6.3 成本控制）。
 *
 * DeepSeek Harness 优化方案 P0-1：原实现排队后无法取消——父任务取消/热重载时，
 * 排队中的委派仍会被唤醒并调用 Provider。这里补：
 *   - 可取消等待：acquire({ signal }) 排队期间 abort 立即从队列移除并 reject；
 *   - 队列上限：queueLimit（默认不限），满了 acquire 返回 false，避免无限堆积；
 *   - 明确入场状态：resolve(true)=拿到槽位；false=队列满拒绝；throw=被取消；
 *   - 释放幂等：多余 release 不会把 active 变成负数。
 * release() 仍复用「槽位直接传递」语义（不改 active），保持 O(1) 不惊群。
 */
export class Semaphore {
  constructor(max = 3, { queueLimit = Infinity } = {}) {
    this.max = Math.max(1, Number(max) || 1)
    this.queueLimit = Number.isFinite(queueLimit) ? Math.max(0, Number(queueLimit)) : Infinity
    this._active = 0
    this._queue = [] // { resolve, reject, signal, onAbort, settled }
  }

  async acquire({ signal = null } = {}) {
    if (signal?.aborted) throw abortError()
    if (this._active < this.max) {
      this._active++
      return true
    }
    if (this._queue.length >= this.queueLimit) return false
    return await new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: null, settled: false }
      const detach = () => { if (entry.onAbort && signal) signal.removeEventListener('abort', entry.onAbort) }
      entry.onAbort = () => {
        if (entry.settled) return
        entry.settled = true
        const i = this._queue.indexOf(entry)
        if (i >= 0) this._queue.splice(i, 1)
        detach()
        reject(abortError())
      }
      if (signal) {
        if (signal.aborted) { entry.onAbort(); return }
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this._queue.push(entry)
    })
  }

  release() {
    // 找到最早的、尚未被取消（settled）的排队项，把槽位直接转交给它（active 不变）
    while (this._queue.length > 0) {
      const entry = this._queue.shift()
      if (entry.settled) continue // 已取消但尚未摘除（理论上已被 onAbort 摘除）→ 跳过
      entry.settled = true
      if (entry.onAbort && entry.signal) entry.signal.removeEventListener('abort', entry.onAbort)
      entry.resolve(true)
      return
    }
    if (this._active > 0) this._active--
  }

  get active() { return this._active }
  get waiting() { return this._queue.length }
  stats() { return { max: this.max, active: this._active, waiting: this._queue.length, queueLimit: this.queueLimit } }
}

/** AbortError 语义的错误（区别于普通业务失败，供调用方按取消处理） */
function abortError(message = 'acquire 被取消') {
  const e = new Error(message)
  e.name = 'AbortError'
  return e
}

/**
 * Trace —— 观测事件流（文档 §6.5：没有 tracing 的 multi-agent 等于裸奔）。
 */
export class Trace {
  constructor() { this._events = [] }
  emit(type, data = {}) { this._events.push({ type, data, ts: Date.now() }) }
  get events() { return [...this._events] }
  filter(type) { return this._events.filter((e) => e.type === type) }
  clear() { this._events = [] }
}

/**
 * SharedState —— 黑板/状态传递（文档 §3.1：跨 step 共享数据，非可变全局）。
 */
export class SharedState {
  constructor(initial = {}) { this._data = { ...initial } }
  get(key) { return this._data[key] }
  set(key, value) { this._data[key] = value; return value }
  update(patch) { Object.assign(this._data, patch) }
  delete(key) { delete this._data[key] }
  toJSON() { return { ...this._data } }
  get keys() { return Object.keys(this._data) }
}
