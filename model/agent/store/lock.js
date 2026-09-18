/**
 * 进程内按键互斥锁 —— 用于「读→改→写」(RMW) 存储的并发串行化，防丢失更新。
 *
 * 设计：
 *  - 同 key 串行（promise 链尾跟随）；不同 key 完全并发。
 *  - 有界：超过 maxKeys 时淘汰「链尾已 settled（无等待者）」的最旧 key，
 *    防长进程里 session/recall/schedule 等键空间无界增长（旧实现每键永久留一个 Promise）。
 *  - 单线程 JS：链尾替换与淘汰判定都在同步段完成，不会与他人交错，无需原子指令。
 *  - 非重入：同一 key 的 fn 内不得再对同一 key 调 withLock（会自锁死）；需要组合操作时
 *    拆成「公开方法加锁 + 内部 locked 变体」互相调用（见 SessionStore.getActiveConversation）。
 */

export function createKeyedLock({ maxKeys = 2000 } = {}) {
  const tails = new Map() // key -> 队尾 Promise（带 __settled 标记）
  const order = new Map() // key -> 最近使用序号（淘汰用）
  let seq = 0

  /** 队尾 settled 且无后续等待者时才可安全淘汰（否则会打断串行链） */
  function evictIfNeeded() {
    if (tails.size <= maxKeys) return
    const need = tails.size - maxKeys
    const entries = [...order.entries()].sort((a, b) => a[1] - b[1]) // 最旧在前
    let removed = 0
    for (const [k] of entries) {
      if (removed >= need) break
      if (tails.get(k)?.__settled) {
        tails.delete(k)
        order.delete(k)
        removed++
      }
    }
  }

  function withLock(key, fn) {
    const prev = tails.get(key) || Promise.resolve()
    const run = prev.then(fn, fn) // 前序无论成败都继续（错误由本次调用方处理）
    const tail = run.then(() => {}, () => {})
    tail.__settled = false
    tail.then(() => { tail.__settled = true })
    tails.set(key, tail)
    order.set(key, ++seq)
    evictIfNeeded()
    return run
  }

  return {
    withLock,
    get size() { return tails.size },
  }
}

export default createKeyedLock
