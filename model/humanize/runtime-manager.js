/**
 * RuntimeManager —— 按 groupId 创建/回收 GroupRuntime + TurnScheduler（指南 §6、§17 maxConcurrentGroups）。
 *
 * - Map<groupId, {runtime, scheduler}>：每群独立运行时，按群隔离缓冲/状态。
 * - 全局 semaphore(maxConcurrentGroups)：限制同时进入 Planning 的群数（默认 1；指南 §17 MVP）。
 *   通过包装 planner.decide 获取/释放全局槽实现，scheduler 无需感知。
 * - 热重载/关闭：cancelAll() 取消所有 Planner 与未发送分段。
 */

import { GroupRuntime } from './group-runtime.js'
import { MessageBuffer } from './message-buffer.js'
import { IdleBackoff } from './idle-backoff.js'
import { TurnScheduler } from './turn-scheduler.js'
import { newHolderId } from './store.js'

/** 简单异步信号量（maxConcurrentGroups 全局槽）。 */
class Semaphore {
  constructor(max = 1) {
    this.max = Math.max(1, max | 0)
    this._free = this.max
    this._waiters = []
  }
  setMax(max) { this.max = Math.max(1, max | 0) }
  async acquire() {
    if (this._free > 0) { this._free--; return () => this.release() }
    await new Promise((res) => this._waiters.push(res))
    return () => this.release()
  }
  release() {
    if (this._waiters.length) { this._waiters.shift()(); return }
    if (this._free < this.max) this._free++
  }
}

export class RuntimeManager {
  /**
   * @param {object} opts { store, trace, cfg:()=>object, makePlanner, makeReplyer, makeComposer, makeSend, onDelivered? }
   *   cfg() 返回全局 humanize 配置；make*(groupId) 各返回对应服务实例。
   *   onDelivered?: 成功发送后回调（apps 注入 → GroupWorld.recordInteraction）
   */
  constructor({ store, trace, cfg, makePlanner, makeReplyer, makeComposer, makeSend, onDelivered = null } = {}) {
    this.store = store
    this.trace = trace
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.makePlanner = makePlanner
    this.makeReplyer = makeReplyer
    this.makeComposer = makeComposer
    this.makeSend = makeSend
    this.onDelivered = onDelivered
    /** @type {Map<string, {runtime:GroupRuntime, scheduler:TurnScheduler}>} */
    this._groups = new Map()
    this._sem = new Semaphore(this._cfgFn()?.safety?.maxConcurrentGroups ?? 1)
  }

  /** 配置热重载后重建信号量上限。 */
  reload() {
    this._sem.setMax(this._cfgFn()?.safety?.maxConcurrentGroups ?? 1)
    // 各 scheduler 的 cfg() 是函数引用，自动读到新配置；无需重建 runtime
  }

  _groupCfg(groupId) {
    const base = this._cfgFn() || {}
    return { ...base, ...(base.groupsOverride?.[groupId] || {}) }
  }

  /** 取/建本群运行时。 */
  getOrCreate(groupId) {
    groupId = String(groupId)
    let entry = this._groups.get(groupId)
    if (entry) return entry

    const gcfg = this._groupCfg(groupId)
    const buffer = new MessageBuffer({ capacity: gcfg.bufferCapacity ?? 150, ttlMs: (gcfg.bufferTtlHours ?? 2) * 3600 * 1000 })
    const backoff = new IdleBackoff({
      baseSeconds: gcfg.idleBackoffBaseSeconds ?? 15,
      capSeconds: gcfg.idleBackoffCapSeconds ?? 300,
      startCount: gcfg.idleBackoffStartCount ?? 2,
      bypassPendingCount: gcfg.bypassPendingCount ?? 6,
    })
    const runtime = new GroupRuntime({
      groupId, buffer, store: this.store, backoff,
      trace: this.trace, holderId: newHolderId(),
      presenceWindowMs: (gcfg.presenceWindowSeconds ?? 300) * 1000,
      cooldownSeconds: gcfg.cooldownSeconds ?? 45,
      maxRepliesPer10Minutes: gcfg.behaviorPolicy?.maxRepliesPer10Minutes ?? gcfg.maxRepliesPer10Minutes ?? 4,
    })
    // 恢复轻状态（游标/冷却/backoff）
    runtime.restore().catch(() => {})

    // 包装 planner：在全局信号量内执行 decide（限制并发 Planning 群数）
    const innerPlanner = this.makePlanner(groupId)
    const planner = {
      decide: async (ctx) => {
        const release = await this._sem.acquire()
        try {
          return await innerPlanner.decide(ctx)
        } finally { release() }
      },
    }
    const replyer = this.makeReplyer(groupId)
    const composer = this.makeComposer(groupId)
    const send = this.makeSend(groupId)

    const scheduler = new TurnScheduler({
      runtime, cfg: () => this._groupCfg(groupId),
      planner, replyer, composer, send, onDelivered: this.onDelivered,
    })
    entry = { runtime, scheduler }
    this._groups.set(groupId, entry)
    return entry
  }

  /** 路由一条消息到对应群的 scheduler。 */
  async route(groupId, msg) {
    if (!groupId) return false
    const { scheduler } = this.getOrCreate(String(groupId))
    return scheduler.onMessage(msg)
  }

  /** 取消某群所有进行中操作（失锁/配置变更）。 */
  cancelGroup(groupId) {
    const entry = this._groups.get(String(groupId))
    if (entry) entry.runtime.cancelAll('manager_cancel_group')
  }

  /** 取消所有群（热重载/关闭）。 */
  cancelAll() {
    for (const [, entry] of this._groups) entry.runtime.cancelAll('manager_cancel_all')
  }

  /** 回收空闲群运行时（可选；MVP 不主动回收，长期运行内存可控因 buffer 有界）。 */
  disposeGroup(groupId) {
    const gid = String(groupId)
    const entry = this._groups.get(gid)
    if (entry) { entry.runtime.cancelAll('dispose'); this._groups.delete(gid) }
  }

  /** 列出活跃群（管理命令用）。 */
  activeGroups() {
    return [...this._groups.entries()].map(([gid, { runtime }]) => ({
      groupId: gid, phase: runtime.phase, size: runtime.buffer.size, cooldown: runtime.isCoolingDown(),
      backoff: runtime.backoff.count, lastSeq: runtime.lastProcessedSeq,
    }))
  }
}
