/**
 * GroupWorld 数据库层。
 *
 * sqlite3 = @karinjs/sqlite3（N-API prebuild，Node 24 免编译，复用 Yunzai 已装）；回调风格 → Promise 封装。
 * 与 model/toolEvo/db.js 同构：模块级单例句柄 + WAL + IF NOT EXISTS 幂等建表 + closeDb 热重载。
 *
 * 表结构对齐 trss-agent-plugin-groupworld-design-v1.0.md §5（8 张主表）+ 3 张运营表（segments/cursor/optout）。
 * sqlite 适配：TIMESTAMP→INTEGER(ms)，DECIMAL→REAL，JSON→TEXT（应用层 JSON.stringify/parse）。
 *
 * 幂等：消息 UNIQUE(group_id,message_id)、片段 UNIQUE(group_id,idem_key)；
 * 事务：分析在 BEGIN/COMMIT 内「标记 analyzed + 推进 cursor」，失败 ROLLBACK 不提交（§6.3、§15.2）。
 */
import sqlite3 from 'sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import Log from '../../utils/Log.js'

let _db = null
let _dbPath = null

/** 全部建表 DDL（IF NOT EXISTS，幂等）。索引一并建。 */
const SCHEMA = {
  // §5.1 原始消息
  gw_messages: `CREATE TABLE IF NOT EXISTS gw_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    reply_to_user_id TEXT,
    reply_to_msg_id TEXT,
    mentioned_users TEXT,
    plain_text TEXT,
    message_type TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    ingest_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE (group_id, message_id)
  )`,
  // 运营：会话片段（§6.2 切片产物 + §6.3 分析状态）
  gw_segments: `CREATE TABLE IF NOT EXISTS gw_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    idem_key TEXT NOT NULL,
    start_msg_id TEXT,
    end_msg_id TEXT,
    msg_count INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    closed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'open',
    analyzed_at INTEGER,
    attempt INTEGER NOT NULL DEFAULT 0,
    low_value_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (group_id, idem_key)
  )`,
  // §5.2 成员状态
  gw_member_profiles: `CREATE TABLE IF NOT EXISTS gw_member_profiles (
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    current_nickname TEXT,
    activity_tier TEXT NOT NULL DEFAULT 'cold',
    message_count_7d INTEGER NOT NULL DEFAULT 0,
    message_count_30d INTEGER NOT NULL DEFAULT 0,
    active_days_30d INTEGER NOT NULL DEFAULT 0,
    avg_message_length REAL,
    reply_ratio REAL,
    mention_ratio REAL,
    active_hour_histogram TEXT,
    last_spoke_at INTEGER,
    profile_summary TEXT,
    summary_confidence REAL,
    summary_updated_at INTEGER,
    opt_out INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  )`,
  // §5.3 画像声明（每条结论独立行）
  gw_traits: `CREATE TABLE IF NOT EXISTS gw_traits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    trait_type TEXT NOT NULL,
    trait_key TEXT NOT NULL,
    trait_value TEXT NOT NULL,
    scope TEXT,
    source_type TEXT NOT NULL,
    confidence REAL NOT NULL,
    evidence_count INTEGER NOT NULL DEFAULT 1,
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL,
    expires_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    embedding BLOB,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // §5.4 证据（可回溯；evidence_text 短摘要）
  gw_evidence: `CREATE TABLE IF NOT EXISTS gw_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER,
    message_id TEXT,
    segment_id TEXT,
    evidence_kind TEXT NOT NULL,
    evidence_text TEXT,
    weight REAL NOT NULL,
    observed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // §5.5 有向关系边（Phase 2）
  gw_edges: `CREATE TABLE IF NOT EXISTS gw_edges (
    group_id TEXT NOT NULL,
    from_user_id TEXT NOT NULL,
    to_user_id TEXT NOT NULL,
    reply_count_30d INTEGER NOT NULL DEFAULT 0,
    mention_count_30d INTEGER NOT NULL DEFAULT 0,
    co_dialogue_count_30d INTEGER NOT NULL DEFAULT 0,
    reciprocity REAL NOT NULL DEFAULT 0,
    interaction_strength REAL NOT NULL DEFAULT 0,
    inferred_relation TEXT,
    relation_confidence REAL,
    first_interacted_at INTEGER,
    last_interacted_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, from_user_id, to_user_id)
  )`,
  // §5.6 机器人主观关系
  gw_bot_rel: `CREATE TABLE IF NOT EXISTS gw_bot_rel (
    bot_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    familiarity REAL NOT NULL DEFAULT 0,
    affinity REAL NOT NULL DEFAULT 0,
    trust REAL NOT NULL DEFAULT 0,
    interaction_count INTEGER NOT NULL DEFAULT 0,
    preferred_name TEXT,
    interaction_style TEXT,
    shared_topics TEXT,
    last_interacted_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, group_id, user_id)
  )`,
  // §5.7 群事件与群梗
  gw_episodes: `CREATE TABLE IF NOT EXISTS gw_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    episode_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    participant_ids TEXT,
    topic_tags TEXT,
    importance REAL NOT NULL,
    confidence REAL NOT NULL,
    occurred_at INTEGER NOT NULL,
    last_referenced_at INTEGER,
    expires_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    embedding BLOB,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // §5.8 小圈子（Phase 2，阶段统计非永久身份）
  gw_communities: `CREATE TABLE IF NOT EXISTS gw_communities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    algorithm_ver TEXT NOT NULL,
    member_ids TEXT NOT NULL,
    core_member_ids TEXT,
    topic_tags TEXT,
    summary TEXT,
    confidence REAL,
    valid_from INTEGER NOT NULL,
    valid_until INTEGER,
    created_at INTEGER NOT NULL
  )`,
  // 运营：游标 + 预算（幂等/熔断）
  gw_cursor: `CREATE TABLE IF NOT EXISTS gw_cursor (
    group_id TEXT NOT NULL PRIMARY KEY,
    last_segmented_msg_id INTEGER NOT NULL DEFAULT 0,
    last_analyzed_segment_id INTEGER,
    last_daily_at INTEGER,
    last_weekly_at INTEGER,
    daily_calls_today INTEGER NOT NULL DEFAULT 0,
    daily_calls_date TEXT
  )`,
  // 运营：用户退出（硬过滤）
  gw_optout: `CREATE TABLE IF NOT EXISTS gw_optout (
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    opted_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  )`,
  // 运营：元信息（embedding model 等；换模型可据此清缓存）
  gw_meta: `CREATE TABLE IF NOT EXISTS gw_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
}

/** 索引（与建表分离，便于统一加）。 */
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_messages_group_time ON gw_messages(group_id, sent_at)',
  'CREATE INDEX IF NOT EXISTS idx_messages_sender ON gw_messages(group_id, sender_id, sent_at)',
  'CREATE INDEX IF NOT EXISTS idx_segments_group_status ON gw_segments(group_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_traits_user ON gw_traits(group_id, user_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_traits_key ON gw_traits(group_id, trait_type, trait_key)',
  'CREATE INDEX IF NOT EXISTS idx_evidence_target ON gw_evidence(target_type, target_id)',
  'CREATE INDEX IF NOT EXISTS idx_evidence_group_msg ON gw_evidence(group_id, message_id)',
  'CREATE INDEX IF NOT EXISTS idx_edges_group_from ON gw_edges(group_id, from_user_id)',
  'CREATE INDEX IF NOT EXISTS idx_edges_group_to ON gw_edges(group_id, to_user_id)',
  'CREATE INDEX IF NOT EXISTS idx_episodes_group ON gw_episodes(group_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_communities_group ON gw_communities(group_id)',
  'CREATE INDEX IF NOT EXISTS idx_bot_rel ON gw_bot_rel(group_id, user_id)',
]

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
  if (!dir) throw new Error('[groupworld] getDb 首次调用须传 { dir }')
  fs.mkdirSync(dir, { recursive: true })
  _dbPath = path.join(dir, 'gw.db')
  _db = new sqlite3.Database(_dbPath)
  Log.info(`[groupworld] db opened: ${_dbPath}`)
  return _db
}

/** 旧库列迁移：CREATE IF NOT EXISTS 不会给已存在的表加列，这里显式 ALTER 补齐（幂等）。 */
const COLUMN_MIGRATIONS = [
  ['gw_traits', 'embedding', 'ALTER TABLE gw_traits ADD COLUMN embedding BLOB'],
  ['gw_episodes', 'embedding', 'ALTER TABLE gw_episodes ADD COLUMN embedding BLOB'],
]

/** 初始化：建全部表 + 索引 + 迁移 + PRAGMA（WAL 并发读、外键约束）。幂等。 */
export async function initDb({ dir }) {
  const db = getDb({ dir })
  await execP(db, 'PRAGMA journal_mode=WAL;')
  await execP(db, 'PRAGMA foreign_keys=ON;')
  for (const [name, sql] of Object.entries(SCHEMA)) {
    try { await execP(db, sql) } catch (e) { Log.warn(`[groupworld] 建表失败 ${name}:`, e?.message || e) }
  }
  for (const sql of INDEXES) {
    try { await execP(db, sql) } catch (e) { Log.warn('[groupworld] 建索引失败:', e?.message || e) }
  }
  for (const [table, col, ddl] of COLUMN_MIGRATIONS) {
    try {
      const cols = await allP(db, `PRAGMA table_info(${table})`)
      if (cols.length && !cols.some((c) => c.name === col)) await runP(db, ddl)
    } catch (e) { Log.warn(`[groupworld] 列迁移失败 ${table}.${col}:`, e?.message || e) }
  }
  return db
}

/** 关闭句柄（热重载/卸载时调，防泄漏）。 */
export function closeDb() {
  if (_db) { try { _db.close() } catch { /* noop */ }; _db = null; _dbPath = null }
}

/* —— DAO：async 查询入口 —— */
export const dao = {
  db: () => _db,
  run: (sql, params) => runP(_db, sql, params),
  all: (sql, params) => allP(_db, sql, params),
  get: (sql, params) => getP(_db, sql, params),
  /**
   * 事务：fn 内的 dao.run 串行执行，任一失败 ROLLBACK 并抛出。
   * @param {() => Promise} fn
   */
  async txn(fn) {
    if (!_db) throw new Error('[groupworld] txn: db 未初始化')
    await runP(_db, 'BEGIN')
    try {
      const r = await fn()
      await runP(_db, 'COMMIT')
      return r
    } catch (e) {
      try { await runP(_db, 'ROLLBACK') } catch { /* noop */ }
      throw e
    }
  },
}

/** DB 是否已就绪（供 service 降级判定）。 */
export function isReady() { return !!_db }

export default { getDb, initDb, closeDb, dao, isReady }
