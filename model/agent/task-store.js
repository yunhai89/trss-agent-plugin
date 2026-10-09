/**
 * TaskStore —— 可恢复任务记录 / 检查点（DeepSeek Harness 优化方案 P0-3，阶段一）。
 *
 * 与 SessionStore 的关系（职责不同，不互相替代）：
 *   - SessionStore 保存"聊过什么"（对话历史投影）；
 *   - TaskStore 保存"正在做什么、做到哪一步、哪些副作用状态未知"（任务账本）。
 *
 * 本模块复用仓库既有 sqlite3 驱动（@karinjs/sqlite3，见 model/toolEvo/db.js 同款回调→Promise 封装），
 * 以单连接 + 写事务串行化保证"任务事件 + 快照"在同一事务原子提交；任务状态由事件 + 快照折叠得到。
 *
 * 阶段一范围：记录、状态查询、重启标记、手动恢复/取消；写操作默认不自动重放。
 * 不持久化 e/bot/AbortController/函数/连接/API Key/浏览器句柄——只存稳定标识与状态。
 */
import sqlite3 from 'sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { planRecovery } from './recovery.js'

export const TASK_SCHEMA_VERSION = 1

/** 建议 phase 集合：只有完成验收才能 completed；预算耗尽可 paused；进程中断可 interrupted。 */
export const TASK_PHASES = new Set(['queued', 'running', 'waiting_input', 'paused', 'interrupted', 'completed', 'failed', 'cancelled'])
export const TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled'])

const DDL = [
  `CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    root_task_id TEXT,
    parent_task_id TEXT,
    schema_version INTEGER NOT NULL,
    scope_key TEXT NOT NULL,
    scope_json TEXT,
    actor_json TEXT,
    phase TEXT NOT NULL,
    stop_reason TEXT,
    completion TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    runtime_generation INTEGER,
    provider_route TEXT,
    prompt_version TEXT,
    tool_schema_snapshot_ref TEXT,
    budget_json TEXT,
    effects_json TEXT,
    deliveries_json TEXT,
    artifact_refs_json TEXT,
    session_key TEXT,
    session_cursor INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_scope_phase ON tasks(scope_key, phase)`,
  `CREATE TABLE IF NOT EXISTS task_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    call_id TEXT,
    phase TEXT,
    stop_reason TEXT,
    completion TEXT,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  )`,
  // 同一任务同一 kind+call_id 只记一次（迟到/重复结算不改账本）
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe ON task_events(task_id, kind, call_id) WHERE call_id IS NOT NULL`,
]

function runP(db, sql, params = []) {
  return new Promise((resolve, reject) => { db.run(sql, params, function (err) { err ? reject(err) : resolve(this) }) })
}
function allP(db, sql, params = []) {
  return new Promise((resolve, reject) => { db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))) })
}
function getP(db, sql, params = []) {
  return new Promise((resolve, reject) => { db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))) })
}
function execP(db, sql) {
  return new Promise((resolve, reject) => { db.exec(sql, (err) => (err ? reject(err) : resolve())) })
}

/** 会话作用域键（与 Agent/session 的群:用户:会话同源；群共享记忆的 scopeUserId 与真实操作者分开由 caller 保证） */
export function scopeKeyOfCtx(ctx) {
  if (!ctx) return 'global'
  const gid = ctx.groupId ? String(ctx.groupId) : 'private'
  const uid = String(ctx.scopeUserId || ctx.userId || 'unknown')
  const conv = ctx.conversationId != null ? String(ctx.conversationId) : 'default'
  return `${gid}:${uid}:${conv}`
}

function parseJson(s) { try { return s == null ? null : JSON.parse(s) } catch { return null } }

function rowToTask(row) {
  if (!row) return null
  return {
    taskId: row.task_id,
    rootTaskId: row.root_task_id || null,
    parentTaskId: row.parent_task_id || null,
    schemaVersion: row.schema_version,
    scopeKey: row.scope_key,
    scope: parseJson(row.scope_json),
    actor: parseJson(row.actor_json),
    phase: row.phase,
    stopReason: row.stop_reason || null,
    completion: row.completion || null,
    revision: row.revision,
    runtimeGeneration: row.runtime_generation,
    providerRoute: row.provider_route || null,
    promptVersion: row.prompt_version || null,
    toolSchemaSnapshotRef: row.tool_schema_snapshot_ref || null,
    budget: parseJson(row.budget_json),
    effects: parseJson(row.effects_json),
    deliveries: parseJson(row.deliveries_json),
    artifactRefs: parseJson(row.artifact_refs_json),
    sessionKey: row.session_key || null,
    sessionCursor: row.session_cursor || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class TaskStore {
  constructor({ dir, file = 'tasks.db', logger = () => {} } = {}) {
    if (!dir) throw new Error('TaskStore 需要 dir')
    this.dir = dir
    this.file = file
    this.logger = logger
    this._db = null
    this._writeChain = Promise.resolve() // 写事务串行化，防 BEGIN/COMMIT 交错
  }

  async open() {
    if (this._db) return this
    fs.mkdirSync(this.dir, { recursive: true })
    const dbPath = path.join(this.dir, this.file)
    this._db = await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath, (err) => (err ? reject(err) : resolve(db)))
    })
    await execP(this._db, 'PRAGMA journal_mode=WAL;')
    await execP(this._db, 'PRAGMA foreign_keys=ON;')
    for (const sql of DDL) await execP(this._db, sql)
    const versionRow = await getP(this._db, `SELECT value FROM store_meta WHERE key='schema_version'`)
    if (versionRow) {
      const v = Number(versionRow.value)
      if (v > TASK_SCHEMA_VERSION) {
        // 未来版本：不按旧结构凑合解析（fail-closed）
        try { this._db.close() } catch { /* noop */ }
        this._db = null
        throw new Error(`TaskStore：数据 schema_version=${v} 高于当前支持 ${TASK_SCHEMA_VERSION}，拒绝按旧结构读取`)
      }
    } else {
      await runP(this._db, `INSERT INTO store_meta(key, value) VALUES('schema_version', ?)`, [String(TASK_SCHEMA_VERSION)])
    }
    return this
  }

  async close() {
    if (!this._db) return
    try { await this._writeChain } catch { /* noop */ }
    try { await flushClose(this._db) } catch { /* noop */ }
    this._db = null
  }

  get opened() { return !!this._db }

  _tx(fn) {
    const run = this._writeChain.then(() => this._doTx(fn))
    this._writeChain = run.then(() => {}, () => {})
    return run
  }

  async _doTx(fn) {
    await runP(this._db, 'BEGIN IMMEDIATE')
    try {
      const r = await fn()
      await runP(this._db, 'COMMIT')
      return r
    } catch (e) {
      try { await runP(this._db, 'ROLLBACK') } catch { /* noop */ }
      throw e
    }
  }

  /** 接受任务后、首次调用模型前登记（写入稳定标识与初始 phase）。 */
  async begin({ taskId, rootTaskId = null, parentTaskId = null, ctx, actor = {}, phase = 'running', runtimeGeneration = null, providerRoute = null, promptVersion = null, toolSchemaSnapshotRef = null }) {
    const now = Date.now()
    const scopeKey = scopeKeyOfCtx(ctx)
    const scope = ctx ? { groupId: ctx.groupId ?? null, userId: ctx.userId ?? null, scopeUserId: ctx.scopeUserId ?? null, conversationId: ctx.conversationId ?? null, scopeId: ctx.scopeId ?? null } : null
    return this._tx(async () => {
      await runP(this._db, `INSERT INTO tasks(
        task_id, root_task_id, parent_task_id, schema_version, scope_key, scope_json, actor_json,
        phase, revision, runtime_generation, provider_route, prompt_version, tool_schema_snapshot_ref,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        taskId, rootTaskId, parentTaskId, TASK_SCHEMA_VERSION, scopeKey,
        scope ? JSON.stringify(scope) : null, JSON.stringify(actor || {}),
        phase, 0, runtimeGeneration, providerRoute, promptVersion, toolSchemaSnapshotRef, now, now,
      ])
      await runP(this._db, `INSERT INTO task_events(task_id, kind, payload_json, created_at) VALUES (?,?,?,?)`, [
        taskId, 'accepted', JSON.stringify({ scopeKey }), now,
      ])
    })
  }

  /**
   * 追加任务事件并推进快照。call_id 非空时按 (task_id, kind, call_id) 去重（重复/迟到结算不重复计数）。
   * 事件审计记录失败视为关键写失败，调用方应停止新的副作用。
   */
  async event({ taskId, kind, callId = null, phase = null, stopReason = null, completion = null, payload = null }) {
    const now = Date.now()
    return this._tx(async () => {
      const info = await runP(this._db, `INSERT OR IGNORE INTO task_events(task_id, kind, call_id, phase, stop_reason, completion, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?)`, [
        taskId, kind, callId, phase, stopReason, completion, payload == null ? null : JSON.stringify(payload), now,
      ])
      const inserted = (info?.changes || 0) > 0
      if (inserted) {
        const sets = ['updated_at = ?', 'revision = revision + 1']
        const args = [now]
        if (phase) { sets.push('phase = ?'); args.push(phase) }
        if (stopReason !== null) { sets.push('stop_reason = ?'); args.push(stopReason) }
        if (completion !== null) { sets.push('completion = ?'); args.push(completion) }
        args.push(taskId)
        await runP(this._db, `UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`, args)
      }
      return { inserted }
    })
  }

  /** 结算任务（终态或 paused/waiting_input/interrupted）。 */
  async finish({ taskId, phase, stopReason = null, completion = null, usage = null, effects = null, deliveries = null, artifactRefs = null }) {
    const now = Date.now()
    return this._tx(async () => {
      await runP(this._db, `INSERT INTO task_events(task_id, kind, phase, stop_reason, completion, payload_json, created_at) VALUES (?,?,?,?,?,?,?)`, [
        taskId, 'finished', phase, stopReason, completion, JSON.stringify({ usage, effects, deliveries }), now,
      ])
      await runP(this._db, `UPDATE tasks SET
        phase = ?, stop_reason = ?, completion = ?, updated_at = ?, revision = revision + 1,
        budget_json = COALESCE(?, budget_json),
        effects_json = COALESCE(?, effects_json),
        deliveries_json = COALESCE(?, deliveries_json),
        artifact_refs_json = COALESCE(?, artifact_refs_json)
        WHERE task_id = ?`, [
        phase, stopReason, completion, now,
        usage == null ? null : JSON.stringify(usage),
        effects == null ? null : JSON.stringify(effects),
        deliveries == null ? null : JSON.stringify(deliveries),
        artifactRefs == null ? null : JSON.stringify(artifactRefs),
        taskId,
      ])
    })
  }

  /** 取任务；传 scopeKey 时做归属校验（跨 scope 返回 null）。 */
  async get(taskId, { scopeKey = null } = {}) {
    const row = await getP(this._db, `SELECT * FROM tasks WHERE task_id = ?`, [taskId])
    if (!row) return null
    if (scopeKey != null && row.scope_key !== scopeKey) return null
    return rowToTask(row)
  }

  async listEvents(taskId) {
    const rows = await allP(this._db, `SELECT * FROM task_events WHERE task_id = ? ORDER BY seq ASC`, [taskId])
    return rows.map((r) => ({
      seq: r.seq, kind: r.kind, callId: r.call_id || null, phase: r.phase || null,
      stopReason: r.stop_reason || null, completion: r.completion || null,
      payload: parseJson(r.payload_json), createdAt: r.created_at,
    }))
  }

  async list({ scopeKey = null, phases = null, limit = 50 } = {}) {
    const where = []
    const args = []
    if (scopeKey != null) { where.push('scope_key = ?'); args.push(scopeKey) }
    if (Array.isArray(phases) && phases.length) { where.push(`phase IN (${phases.map(() => '?').join(',')})`); args.push(...phases) }
    args.push(Math.max(1, Math.min(500, Number(limit) || 50)))
    const rows = await allP(this._db, `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`, args)
    return rows.map(rowToTask)
  }

  /** 重启/加载时：把未结算任务标为 interrupted（默认不自动重放写操作）。返回受影响数量。 */
  async markInterrupted({ runtimeGeneration = null, reason = 'process_restart' } = {}) {
    const now = Date.now()
    return this._tx(async () => {
      const rows = await allP(this._db, `SELECT task_id FROM tasks WHERE phase NOT IN ('completed','failed','cancelled')`)
      for (const r of rows) {
        await runP(this._db, `INSERT INTO task_events(task_id, kind, phase, stop_reason, payload_json, created_at) VALUES (?,?,?,?,?,?)`, [
          r.task_id, 'interrupted', 'interrupted', reason, JSON.stringify({ runtimeGeneration }), now,
        ])
        await runP(this._db, `UPDATE tasks SET phase='interrupted', stop_reason=?, updated_at=?, revision=revision+1 WHERE task_id=?`, [reason, now, r.task_id])
      }
      return rows.length
    })
  }

  /** 手动取消（跨 scope 拒绝）。 */
  async cancel(taskId, { scopeKey = null } = {}) {
    const now = Date.now()
    return this._tx(async () => {
      const row = await getP(this._db, `SELECT scope_key, phase FROM tasks WHERE task_id = ?`, [taskId])
      if (!row) return { ok: false, code: 'not_found' }
      if (scopeKey != null && row.scope_key !== scopeKey) return { ok: false, code: 'forbidden' }
      if (TERMINAL_PHASES.has(row.phase)) return { ok: false, code: 'terminal', phase: row.phase }
      await runP(this._db, `INSERT INTO task_events(task_id, kind, phase, payload_json, created_at) VALUES (?,?,?,?,?)`, [taskId, 'cancelled', 'cancelled', null, now])
      await runP(this._db, `UPDATE tasks SET phase='cancelled', updated_at=?, revision=revision+1 WHERE task_id=?`, [now, taskId])
      return { ok: true }
    })
  }

  /**
   * 手动恢复（阶段一：仅返回检查点；不自动重放副作用）。
   * @returns {null|{ok:false,code:string}|{ok:true, task:object, checkpoint:{completedSteps:number}}}
   */
  async resume(taskId, { scopeKey = null } = {}) {
    const row = await getP(this._db, `SELECT * FROM tasks WHERE task_id = ?`, [taskId])
    if (!row) return { ok: false, code: 'not_found' }
    if (scopeKey != null && row.scope_key !== scopeKey) return { ok: false, code: 'forbidden' }
    if (TERMINAL_PHASES.has(row.phase)) return { ok: false, code: 'terminal', phase: row.phase }
    const events = await allP(this._db, `SELECT kind FROM task_events WHERE task_id = ?`, [taskId])
    const completedSteps = events.filter((e) => e.kind === 'step_done' || e.kind === 'tool_result').length
    // 阶段一：标记为等待用户确认后再人工继续，不在这里自动重跑
    await this.event({ taskId, kind: 'resume_requested', payload: { completedSteps } })
    const plan = planRecovery(await this.listEvents(taskId))
    return { ok: true, task: rowToTask({ ...row }), checkpoint: { completedSteps }, plan }
  }

  /** 读取任务事件并推导恢复计划（P0-3 阶段二，纯推导不执行）。 */
  async recoveryPlan(taskId, { scopeKey = null, resolveMeta = null } = {}) {
    const row = await getP(this._db, `SELECT scope_key FROM tasks WHERE task_id = ?`, [taskId])
    if (!row) return { ok: false, code: 'not_found' }
    if (scopeKey != null && row.scope_key !== scopeKey) return { ok: false, code: 'forbidden' }
    const events = await this.listEvents(taskId)
    return { ok: true, plan: planRecovery(events, { resolveMeta }) }
  }

  /**
   * 有限只读自动恢复（P0-3 阶段二）：仅在「无任何未知写副作用」时，对可安全重放的只读步骤
   * 调用注入的 execute 重跑。存在 block/reconcile 步骤时拒绝自动恢复，要求先人工/外部核实。
   * 调用方注入的 execute 必须自行重新校验权限与外部状态。
   * @returns {{ok:boolean, code?:string, plan?:object, applied?:Array}}
   */
  async recoverReadOnly(taskId, { scopeKey = null, execute = null, resolveMeta = null } = {}) {
    const row = await getP(this._db, `SELECT scope_key, phase FROM tasks WHERE task_id = ?`, [taskId])
    if (!row) return { ok: false, code: 'not_found' }
    if (scopeKey != null && row.scope_key !== scopeKey) return { ok: false, code: 'forbidden' }
    if (TERMINAL_PHASES.has(row.phase)) return { ok: false, code: 'terminal', phase: row.phase }
    const events = await this.listEvents(taskId)
    const plan = planRecovery(events, { resolveMeta })
    if (plan.hasBlocking) return { ok: false, code: 'blocked_pending_reconciliation', plan }
    if (typeof execute !== 'function') return { ok: false, code: 'no_executor', plan }

    const applied = []
    for (const step of plan.steps) {
      if (step.action !== 'retry') { applied.push({ callId: step.callId, applied: false, reason: 'not_auto' }); continue }
      if (step.effect && step.effect !== 'read') { applied.push({ callId: step.callId, applied: false, reason: 'not_read_only' }); continue }
      try {
        const res = await execute(step)
        // F03/C06：恢复执行返回的错误对象（{error}/{ok:false}）不得记成成功
        const failed = res != null && typeof res === 'object' && (res.error != null || res.ok === false)
        const errMsg = failed ? (res.error || 'recovery_failed') : null
        await this.event({ taskId, kind: 'tool_result', callId: step.callId, payload: { name: step.name, ok: !failed, recovered: true, effectState: 'none', ...(failed ? { error: errMsg } : {}) } })
        applied.push({ callId: step.callId, applied: !failed, ...(failed ? { error: errMsg } : {}) })
      } catch (e) {
        await this.event({ taskId, kind: 'tool_result', callId: step.callId, payload: { name: step.name, ok: false, recovered: true, effectState: 'none', error: e?.message || String(e) } })
        applied.push({ callId: step.callId, applied: false, error: e?.message || String(e) })
      }
    }
    return { ok: true, plan, applied }
  }

  /**
   * 记录本任务已投影到 SessionStore 的游标（P0-3：恢复时不重复 append）。
   * 单调推进：只有更大的 cursor 才更新。
   */
  async markSessionProjected(taskId, { sessionKey = null, cursor }) {
    const now = Date.now()
    const c = Math.max(0, Number(cursor) || 0)
    return this._tx(async () => {
      await runP(this._db, `UPDATE tasks SET
        session_key = COALESCE(?, session_key),
        session_cursor = MAX(COALESCE(session_cursor, 0), ?),
        updated_at = ?
        WHERE task_id = ?`, [sessionKey || null, c, now, taskId])
    })
  }

  async getSessionProjection(taskId) {
    const row = await getP(this._db, `SELECT session_key, session_cursor FROM tasks WHERE task_id = ?`, [taskId])
    if (!row) return null
    return { sessionKey: row.session_key || null, cursor: row.session_cursor || 0 }
  }

  /**
   * 幂等投影：仅当目标 cursor 超过已提交游标时才执行 fn 并推进游标。
   * 恢复流程用它保证「同一批消息只 append 一次」。
   */
  async projectOnce(taskId, { sessionKey = null, cursor }, fn) {
    const c = Math.max(0, Number(cursor) || 0)
    const cur = await this.getSessionProjection(taskId)
    if (cur && c <= (cur.cursor || 0)) return { skipped: true, cursor: cur.cursor }
    await fn()
    await this.markSessionProjected(taskId, { sessionKey, cursor: c })
    return { skipped: false, cursor: c }
  }

  /** 清理任务及其事件（删除会话/过期策略时调用；调用方负责不与普通 TTL 混淆）。 */
  async remove(taskId, { scopeKey = null } = {}) {
    return this._tx(async () => {
      const row = await getP(this._db, `SELECT scope_key FROM tasks WHERE task_id = ?`, [taskId])
      if (!row) return { ok: false, code: 'not_found' }
      if (scopeKey != null && row.scope_key !== scopeKey) return { ok: false, code: 'forbidden' }
      await runP(this._db, `DELETE FROM task_events WHERE task_id = ?`, [taskId])
      await runP(this._db, `DELETE FROM tasks WHERE task_id = ?`, [taskId])
      return { ok: true }
    })
  }
}

function flushClose(db) {
  return new Promise((resolve) => db.close(() => resolve()))
}
