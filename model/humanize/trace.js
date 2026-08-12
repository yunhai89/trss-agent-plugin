/**
 * Trace —— 伪人模式可回放决策日志（指南 §18）。
 *
 * 设计：
 *  - 每次门控/规划生成一个 humanizeTurnId，结构化记录 gate/planner/delivery。
 *  - groupId 存哈希（隐私），messageId 可留短尾用于回放定位。
 *  - 不把完整私聊记忆、密钥、Planner 隐藏推理长期写入普通日志：redact 拦截。
 *  - 进程内保留最近 N 条（管理命令查看），同时经 sink 写到持久日志（apps 注入 devLog/文件）。
 */

import { createHash, randomUUID } from 'node:crypto'

/** 简单 groupId 哈希（不带盐，仅用于日志去标识；不可逆但非密码学安全） */
export function hashGroupId(groupId) {
  if (!groupId) return ''
  return 'g_' + createHash('sha256').update(String(groupId)).digest('hex').slice(0, 10)
}

/** 脱敏：移除/裁剪疑似密钥与超长字符串（Planner 隐藏推理不长期留日志）。 */
export function redactForLog(value, maxStrLen = 200) {
  if (value == null) return value
  if (typeof value === 'string') {
    let s = value.replace(/(?:sk-|sk_)[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    if (s.length > maxStrLen) s = s.slice(0, maxStrLen) + `…(${s.length}字)`
    return s
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactForLog(v, maxStrLen))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      // 跳过明显的隐私/敏感字段
      if (/memory|secret|token|apiKey|reasoning|hidden/i.test(k)) continue
      out[k] = redactForLog(v, maxStrLen)
    }
    return out
  }
  return value
}

export class Trace {
  /**
   * @param {object} opts { limit?:number, sink?:(record)=>void }
   */
  constructor({ limit = 500, sink } = {}) {
    this.limit = Math.max(10, limit | 0)
    this.sink = typeof sink === 'function' ? sink : null
    /** @type {Array<object>} */
    this._ring = []
  }

  /** 生成 turnId */
  newTurnId() {
    return 'ht_' + randomUUID().slice(0, 16)
  }

  /**
   * 记录一条决策事件。自动补 turnId/groupIdHash/时间，脱敏后入环 + sink。
   * @param {string} event  事件名：gate_decision / planner_turn / delivery / humanize_turn ...
   * @param {object} record { turnId?, groupId?, ... }
   */
  record(event, record = {}) {
    const rec = redactForLog({
      event,
      turnId: record.turnId || this.newTurnId(),
      ts: Date.now(),
      ...record,
    })
    if (record.groupId != null && rec.groupId === record.groupId) {
      rec.groupIdHash = hashGroupId(record.groupId)
      delete rec.groupId
    } else if (record.groupIdHash) {
      rec.groupIdHash = record.groupIdHash
    }
    this._ring.push(rec)
    if (this._ring.length > this.limit) this._ring.splice(0, this._ring.length - this.limit)
    try { this.sink?.(rec) } catch { /* sink 失败不影响主流程 */ }
    return rec
  }

  /** 记录一次完整 turn 的聚合（gate + planner + delivery）。 */
  recordTurn({ turnId, groupId, batchSize, targetMessageId, gate, planner, delivery } = {}) {
    return this.record('humanize_turn', {
      turnId, groupId, batchSize, targetMessageId,
      gate: gate || null, planner: planner || null, delivery: delivery || null,
    })
  }

  /** 最近 N 条（可按 groupIdHash 过滤）。 */
  recent({ groupId, limit = 20 } = {}) {
    const hash = groupId ? hashGroupId(groupId) : null
    const arr = hash ? this._ring.filter((r) => r.groupIdHash === hash) : this._ring
    return arr.slice(-Math.max(1, limit | 0)).reverse()
  }
}
