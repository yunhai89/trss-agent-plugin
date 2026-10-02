/**
 * Tool Evolution 数据库层。
 *
 * sqlite3 = @karinjs/sqlite3（N-API prebuild，Node 24 免编译），复用 Yunzai 已装；回调风格 → Promise 封装。
 * 幂等 getDb() 防热重载泄漏：句柄挂模块级单例，热重载前须 closeDb()（由 runtime 生命周期调用）。
 * 调用埋点走批量队列（tool_invocations），不阻塞 agent 主循环；args 仅存哈希摘要，不落原始敏感入参（§11）。
 *
 * 表结构对齐 tool-evolution 开发文档 §11；约束：版本不可变、(tool_id,semver) 唯一、stable 不可原地覆盖（由 registry 保证）。
 */
import sqlite3 from 'sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Log from '../../utils/Log.js'

let _db = null
let _dbPath = null

/** 全部建表 DDL（IF NOT EXISTS，幂等） */
const SCHEMA = {
  tools: `CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    namespace TEXT NOT NULL DEFAULT 'default',
    active_version_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  tool_versions: `CREATE TABLE IF NOT EXISTS tool_versions (
    id TEXT PRIMARY KEY,
    tool_id TEXT NOT NULL,
    semver TEXT NOT NULL,
    status TEXT NOT NULL,
    source_hash TEXT,
    source_text TEXT,
    tests_json TEXT,
    content_hash TEXT,
    verified_content_hash TEXT,
    verified_verifier TEXT,
    manifest_json TEXT NOT NULL,
    parent_version_id TEXT,
    generator_model TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(tool_id, semver),
    FOREIGN KEY(tool_id) REFERENCES tools(id)
  )`,
  tool_tests: `CREATE TABLE IF NOT EXISTS tool_tests (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT,
    fixture_json TEXT,
    oracle_json TEXT,
    FOREIGN KEY(version_id) REFERENCES tool_versions(id)
  )`,
  tool_embeddings: `CREATE TABLE IF NOT EXISTS tool_embeddings (
    version_id TEXT NOT NULL,
    model TEXT NOT NULL,
    vector BLOB,
    PRIMARY KEY(version_id, model),
    FOREIGN KEY(version_id) REFERENCES tool_versions(id)
  )`,
  tool_edges: `CREATE TABLE IF NOT EXISTS tool_edges (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    PRIMARY KEY(from_id, to_id, relation)
  )`,
  tool_invocations: `CREATE TABLE IF NOT EXISTS tool_invocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id TEXT,
    tool_name TEXT NOT NULL,
    args_hash TEXT,
    success INTEGER NOT NULL,
    latency_ms INTEGER,
    error_class TEXT,
    created_at INTEGER NOT NULL
  )`,
  evolution_runs: `CREATE TABLE IF NOT EXISTS evolution_runs (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    candidate_version_id TEXT,
    decision TEXT,
    detail_json TEXT,
    created_at INTEGER NOT NULL
  )`,
  approval_records: `CREATE TABLE IF NOT EXISTS approval_records (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL,
    actor TEXT,
    scope TEXT,
    decision TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(version_id) REFERENCES tool_versions(id)
  )`,
  audit_events: `CREATE TABLE IF NOT EXISTS audit_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload_hash TEXT,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  )`,
}

/* —— Promise 封装（sqlite3 回调风格 → async）—— */
function runP(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this) })
  })
}
function allP(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  })
}
function getP(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  })
}
function execP(db, sql) {
  return new Promise((resolve, reject) => { db.exec(sql, (err) => (err ? reject(err) : resolve())) })
}

/** 幂等获取 DB 句柄（首次需传 dir）。热重载由 closeDb 处理。 */
export function getDb({ dir } = {}) {
  if (_db) return _db
  if (!dir) throw new Error('[toolEvo] getDb 首次调用须传 { dir }')
  fs.mkdirSync(dir, { recursive: true })
  _dbPath = path.join(dir, 'tevo.db')
  _db = new sqlite3.Database(_dbPath)
  Log.info(`[toolEvo] db opened: ${_dbPath}`)
  return _db
}

/**
 * 增量迁移：给已存在的库补列（SQLite 不支持 ADD COLUMN IF NOT EXISTS）。
 * 旧库（审计前创建）缺 source_text/tests_json/content_hash 等；缺列按 NULL 补齐，
 * 这些旧版本因无 content_hash 无法通过稳定性校验（需重新验证），属预期 fail-closed。
 */
async function ensureColumn(db, table, column, ddl) {
  try {
    const cols = await allP(db, `PRAGMA table_info(${table})`)
    if (cols.some((c) => c.name === column)) return
    await runP(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    Log.info(`[toolEvo] 迁移：${table}.${column} 已添加`)
  } catch (e) { Log.warn(`[toolEvo] 迁移 ${table}.${column} 失败:`, e?.message || e) }
}

async function migrate(db) {
  await ensureColumn(db, 'tool_versions', 'source_text', 'TEXT')
  await ensureColumn(db, 'tool_versions', 'tests_json', 'TEXT')
  await ensureColumn(db, 'tool_versions', 'content_hash', 'TEXT')
  await ensureColumn(db, 'tool_versions', 'verified_content_hash', 'TEXT')
  await ensureColumn(db, 'tool_versions', 'verified_verifier', 'TEXT')
}

/** 初始化：建全部表 + PRAGMA（WAL 并发读、外键约束）+ 增量迁移。幂等。 */
export async function initDb({ dir }) {
  const db = getDb({ dir })
  await execP(db, 'PRAGMA journal_mode=WAL;')
  await execP(db, 'PRAGMA foreign_keys=ON;')
  for (const [name, sql] of Object.entries(SCHEMA)) {
    try { await execP(db, sql) } catch (e) { Log.warn(`[toolEvo] 建表失败 ${name}:`, e?.message || e) }
  }
  await migrate(db)
  return db
}

/**
 * 关闭句柄（热重载/卸载时调，防泄漏）。
 * 先停掉落盘定时器并冲刷队列，再关闭——否则队列里未落盘的调用埋点会被直接丢弃（审计 P1-8）。
 * 异步：调用方应 `await closeDb()`；旧同步调用方不 await 也不会同步关闭，保证 flush 完整。
 */
export async function closeDb() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null }
  try { await flushInvocations() } catch { /* noop */ }
  if (_db) { try { _db.close() } catch { /* noop */ }; _db = null; _dbPath = null }
}

/* —— DAO：async 查询入口 —— */
export const dao = {
  db: () => _db,
  run: (sql, params) => runP(_db, sql, params),
  all: (sql, params) => allP(_db, sql, params),
  get: (sql, params) => getP(_db, sql, params),
}

/* —— 调用埋点批量队列（tool_invocations）—— */
const _invQueue = []
let _flushTimer = null
const FLUSH_MS = 2000
const FLUSH_MAX = 200

/** 记录一次工具调用（异步批量落盘，不阻塞主流程）。args 仅存哈希。 */
export function recordInvocation({ versionId = null, toolName, args, success, latencyMs = null, errorClass = null }) {
  if (!_db) return
  const argsHash = args == null ? null : crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16)
  _invQueue.push({ versionId, toolName, argsHash, success: success ? 1 : 0, latencyMs, errorClass, createdAt: Date.now() })
  if (_invQueue.length >= FLUSH_MAX) { flushInvocations() }
  else if (!_flushTimer) _flushTimer = setTimeout(flushInvocations, FLUSH_MS)
}

async function flushInvocations() {
  _flushTimer = null
  if (!_db || !_invQueue.length) return
  const batch = _invQueue.splice(0, _invQueue.length)
  const sql = `INSERT INTO tool_invocations(version_id, tool_name, args_hash, success, latency_ms, error_class, created_at) VALUES (?,?,?,?,?,?,?)`
  try {
    for (const r of batch) {
      await runP(_db, sql, [r.versionId, r.toolName, r.argsHash, r.success, r.latencyMs, r.errorClass, r.createdAt])
    }
  } catch (e) { Log.warn('[toolEvo] invocation 落盘失败:', e?.message || e) }
}

/** 进程退出前冲刷（尽力而为） */
export async function flushNow() { if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null }; await flushInvocations() }

export default { getDb, initDb, closeDb, dao, recordInvocation, flushNow }
