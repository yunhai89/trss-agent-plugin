/**
 * HumanizeStore —— 伪人模式持久化/去重键封装（指南 §8.2、§16）。
 *
 * 复用 getRuntime().kv（redisKv 或 memoryKv 回退），接口：get/set/del/scan + ttlSec。
 * 不创建第二套连接。运行中的 AbortController/Timer/事件对象不可序列化，只存于进程内；
 * Redis 只保存重启后仍有意义的游标、冷却截止、去重标记和消息摘要。
 *
 * 键：
 *  - humanize:direct-handled:<gid>:<messageId>   直接模式接管标记，TTL 60s
 *  - humanize:reply-lock:<gid>:<batchId>          分布式规划锁，TTL 60s（含 holder）
 *  - humanize:sent:<gid>:<messageId|fingerprint>  防重复发送，TTL 10m
 *  - humanize:config:group:<gid>                  群级配置覆盖（长存）
 *  - humanize:state:group:<gid>                   可恢复轻状态（长存）
 *
 * 注意：kv 接口不暴露原子 SET NX，acquireReplyLock 用 check-then-set + TTL，
 * 单进程安全；多进程/热重载为 best-effort 互斥（TTL 兜底防死锁）。
 */

const PREFIX = 'humanize'

function k(...parts) { return [PREFIX, ...parts].join(':') }

export class HumanizeStore {
  /**
   * @param {object} opts { kv }  kv 需实现 async get/set(key,val,ttlSec?)/del/scan
   */
  constructor({ kv } = {}) {
    if (!kv) throw new Error('HumanizeStore 需要 kv 实例')
    this.kv = kv
  }

  // ─────────────── 直接模式接管去重 ───────────────

  /** Direct Agent 接管某消息时调用，阻止环境模式以它为目标发言。 */
  async markDirectHandled(groupId, messageId, ttlSec = 60) {
    if (!groupId || !messageId) return
    await this.kv.set(k('direct-handled', groupId, messageId), 1, ttlSec)
  }

  async isDirectHandled(groupId, messageId) {
    if (!groupId || !messageId) return false
    const v = await this.kv.get(k('direct-handled', groupId, messageId))
    return !!v
  }

  // ─────────────── 规划锁（reply-lock） ───────────────

  /**
   * 获取本批次的规划锁（进入 Planner 前）。holderId 用于安全释放（只释放自己的）。
   * @returns {Promise<boolean>} 是否拿到
   */
  async acquireReplyLock(groupId, batchId, holderId, ttlSec = 60) {
    if (!groupId || batchId == null) return false
    const key = k('reply-lock', groupId, batchId)
    const existing = await this.kv.get(key)
    const now = Date.now()
    if (existing && existing.holder && existing.expiresAt && existing.expiresAt > now) {
      return false // 被他人持有且未过期
    }
    await this.kv.set(key, { holder: holderId, at: now, expiresAt: now + ttlSec * 1000 }, ttlSec)
    return true
  }

  /** 释放锁（仅当 holder 匹配）。 */
  async releaseReplyLock(groupId, batchId, holderId) {
    if (!groupId || batchId == null) return
    const key = k('reply-lock', groupId, batchId)
    const existing = await this.kv.get(key)
    if (!existing || !existing.holder || existing.holder === holderId) {
      await this.kv.del(key)
    }
  }

  /** 锁是否被他人持有（用于取消竞争）。 */
  async isReplyLockHeldByOther(groupId, batchId, holderId) {
    if (!groupId || batchId == null) return false
    const existing = await this.kv.get(k('reply-lock', groupId, batchId))
    return !!(existing && existing.holder && existing.holder !== holderId && existing.expiresAt && existing.expiresAt > Date.now())
  }

  // ─────────────── 防重复发送（at-most-once） ───────────────

  /** 发送成功后标记，10 分钟内同 messageId/指纹不再发。 */
  async markSent(groupId, messageKey, ttlSec = 600) {
    if (!groupId || !messageKey) return
    await this.kv.set(k('sent', groupId, messageKey), 1, ttlSec)
  }

  async isSent(groupId, messageKey) {
    if (!groupId || !messageKey) return false
    return !!(await this.kv.get(k('sent', groupId, messageKey)))
  }

  // ─────────────── 群级配置覆盖（长存） ───────────────

  async setGroupConfig(groupId, cfg) {
    if (!groupId) return
    await this.kv.set(k('config', 'group', groupId), cfg || {})
  }

  async getGroupConfig(groupId) {
    if (!groupId) return null
    try { return await this.kv.get(k('config', 'group', groupId)) } catch { return null }
  }

  // ─────────────── 可恢复轻状态（长存） ───────────────
  // 仅保存重启后仍有意义的：游标、冷却截止、连续 no_action 计数。
  // 不保存 AbortController/Timer/事件对象（不可序列化）。

  async setState(groupId, state) {
    if (!groupId) return
    await this.kv.set(k('state', 'group', groupId), state || {})
  }

  async getState(groupId) {
    if (!groupId) return null
    try { return await this.kv.get(k('state', 'group', groupId)) } catch { return null }
  }

  // ─────────────── 扫描（清理/管理命令用） ───────────────

  async scanKeys(prefix) {
    try { return await this.kv.scan(k(prefix)) } catch { return [] }
  }
}

/** 构造一个进程内唯一 holderId（热重载/多实例区分）。 */
export function newHolderId() {
  return `p_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
