/**
 * ReplySender —— 受控串行发送队列（框架无关）。
 *
 * 背景（长任务稳定性审计）：apps 层曾用 `try { e.reply(...) } catch {}` 发进度/旁白/最终回复——
 * 同步 catch 捕获不了适配器返回的 Promise rejection，会变成 unhandledRejection 静默消失；
 * 最终回复失败也无从得知（delivered 只看"执行过 await"）。
 *
 * 契约：
 *  - 所有发送进同一会话级队列串行执行（进度 → 最终回复顺序稳定，不会最终回复先于进度发出）；
 *  - enqueue() 返回的 Promise **永不 reject**，rejection 被归一为 { ok:false, error } 记录在 outcomes；
 *  - fire-and-forget（进度/旁白）不 await 也不产生 unhandledRejection；
 *  - 最终回复 await enqueue(...).ok 判定 delivered；适配器返回 { retcode } 时 retcode!==0 视为失败。
 *
 * 库零依赖；send 函数由 apps 注入（(payload) => e.reply(payload)）。
 */

/** 判定适配器返回值是否算发送成功：null/undefined=假定成功；{retcode} 非 0=失败；其余（消息 id 等）=成功 */
export function isSendOk(ret) {
  if (ret == null) return true
  if (typeof ret === 'object') {
    if (typeof ret.retcode === 'number') return ret.retcode === 0
    if (typeof ret.status === 'number' && typeof ret.retcode !== 'number') return ret.status === 0 || ret.status === 200
  }
  return true
}

export class ReplySender {
  /**
   * @param {object} opts
   * @param {function} opts.send 实际发送函数（返回 Promise；适配器返回值/抛错都由本类归一）
   * @param {function} [opts.onSendError] (error, payload, tag) 发送失败回调（记日志/devLog 用）
   */
  constructor({ send, onSendError } = {}) {
    if (typeof send !== 'function') throw new Error('ReplySender 需要 send 函数')
    this._send = send
    this._onSendError = onSendError || null
    this._tail = Promise.resolve()
    this._depth = 0
    this.outcomes = [] // { tag, ok, ret?, error? }
  }

  /** 队列中排队+发送中的条数（含正在发送的 1 条；0=空闲） */
  get pending() {
    return this._depth
  }

  /**
   * 入队一条发送。返回 Promise<outcome>（永不 reject）。
   * @param {*} payload 透传给 send 的内容
   * @param {object} [meta] { tag } —— 'progress' | 'final' | ...（仅记录用）
   */
  enqueue(payload, { tag = 'progress' } = {}) {
    this._depth++
    const run = () => this._one(payload, tag).finally(() => { this._depth-- })
    const p = this._tail.then(run, run) // 无论前一条成败都继续（前一条已归一不会 reject，双保险）
    this._tail = p.catch(() => {}) // 链尾永不 reject，防级联 unhandledRejection
    return p
  }

  async _one(payload, tag) {
    let ret
    try {
      ret = await this._send(payload)
    } catch (e) {
      const outcome = { tag, ok: false, error: e?.message || String(e) }
      this.outcomes.push(outcome)
      try { this._onSendError?.(e, payload, tag) } catch { /* 回调异常不影响队列 */ }
      return outcome
    }
    const ok = isSendOk(ret)
    const outcome = { tag, ok, ...(ok ? { ret } : { ret, error: `适配器返回失败状态：${JSON.stringify(ret)?.slice(0, 120)}` }) }
    this.outcomes.push(outcome)
    if (!ok) {
      try { this._onSendError?.(new Error(outcome.error), payload, tag) } catch { /* noop */ }
    }
    return outcome
  }

  /** 等待队列排空（fire-and-forget 的进度消息在最终回复前可显式刷干） */
  async flush() {
    await this._tail
    return this.outcomes
  }
}

/**
 * createRunQueues —— 每会话 single-flight 运行队列（框架无关）。
 *
 * 背景：每请求 new Agent() + appendConversation() 读改写，同会话并发触发两个任务会互覆历史、
 * 旧任务在新任务结束后发送过期结果。本队列按 key（会话）串行执行、不同 key 并发；
 * fn 抛错也释放队列（下一个排队任务继续），错误向调用方原样传播。
 */
export function createRunQueues() {
  const queues = new Map() // key -> { tail(永不 reject), depth }
  return {
    /** key 当前排队+执行中的任务数（0=空闲，1=正在执行，>1=还有排队） */
    depth(key) {
      return queues.get(key)?.depth || 0
    },
    /**
     * 串行执行 fn。同 key 排队；不同 key 并发。
     * @returns fn 的返回值/抛错原样传播。
     */
    run(key, fn) {
      const q = queues.get(key) || { tail: Promise.resolve(), depth: 0 }
      queues.set(key, q)
      q.depth++
      const p = q.tail.then(() => fn())
      // 链尾吞错（错误由 p 的调用方处理），depth 在结算后递减
      q.tail = p.then(() => {}, () => {})
      const dec = () => { q.depth--; if (q.depth <= 0 && queues.get(key) === q) queues.delete(key) }
      p.then(dec, dec)
      return p
    },
  }
}
