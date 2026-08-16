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
  // §5.4 证据（可回溯；evidence_text 短摘要；subject_user_id = 证据主体用户，隐私清理直接定位）
  gw_evidence: `CREATE TABLE IF NOT EXISTS gw_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER,
    subject_user_id TEXT,
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
  // ══════════ SelfState 自我认知与情绪（设计文档 v1.1 §6；sqlite 适配 ms/REAL/TEXT-JSON）══════════
  // §6.1 稳定自我核心（SelfCoreCompiler 编译产物，persona_version 缓存）
  ss_self_core: `CREATE TABLE IF NOT EXISTS ss_self_core (
    bot_id TEXT PRIMARY KEY,
    persona_version TEXT NOT NULL,
    identity_summary TEXT NOT NULL,
    values_json TEXT NOT NULL,
    boundaries_json TEXT NOT NULL,
    sensitivities_json TEXT NOT NULL,
    coping_style_json TEXT NOT NULL,
    emotional_baseline_json TEXT NOT NULL,
    temperament_json TEXT NOT NULL,
    compiled_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // §6.2 群级自我状态（CoreAffect；state_version 乐观锁 §21.4）
  ss_group_state: `CREATE TABLE IF NOT EXISTS ss_group_state (
    bot_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    valence REAL NOT NULL DEFAULT 0,
    arousal REAL NOT NULL DEFAULT 0.2,
    energy REAL NOT NULL DEFAULT 0.7,
    social_security REAL NOT NULL DEFAULT 0.6,
    agency REAL NOT NULL DEFAULT 0.6,
    belonging_satisfaction REAL NOT NULL DEFAULT 0.6,
    respect_satisfaction REAL NOT NULL DEFAULT 0.6,
    attention_satisfaction REAL NOT NULL DEFAULT 0.5,
    expression_frozen INTEGER NOT NULL DEFAULT 0,
    last_transition_at INTEGER,
    updated_at INTEGER NOT NULL,
    state_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (bot_id, group_id)
  )`,
  // §6.3 情绪实例（懒衰减锚点 last_evaluated_at；cause 关联 ss_events）
  ss_emotions: `CREATE TABLE IF NOT EXISTS ss_emotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    emotion_type TEXT NOT NULL,
    intensity REAL NOT NULL,
    target_user_id TEXT,
    cause_event_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    half_life_seconds INTEGER NOT NULL,
    last_evaluated_at INTEGER NOT NULL,
    resolved_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // §6.4 自我事件（连接 GW 与 SS 的桥梁；17 种 event_type）
  ss_events: `CREATE TABLE IF NOT EXISTS ss_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_user_id TEXT,
    target_user_id TEXT,
    source_message_ids TEXT NOT NULL,
    group_episode_id INTEGER,
    appraisal_json TEXT NOT NULL,
    emotion_impulse_json TEXT NOT NULL,
    confidence REAL NOT NULL,
    significance REAL NOT NULL,
    occurred_at INTEGER NOT NULL,
    processed_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
  )`,
  // §6.5 回应期待（七态生命周期 §16.3）
  ss_expectations: `CREATE TABLE IF NOT EXISTS ss_expectations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    target_user_id TEXT,
    expectation_type TEXT NOT NULL,
    expectation_strength REAL NOT NULL,
    group_activity_at_send REAL,
    normal_response_ms INTEGER,
    not_before_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    fulfilled_by_message_id TEXT,
    outcome TEXT,
    outcome_confidence REAL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    status TEXT NOT NULL DEFAULT 'pending'
  )`,
  // §6.7 未解决心事
  ss_concerns: `CREATE TABLE IF NOT EXISTS ss_concerns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    concern_type TEXT NOT NULL,
    target_user_id TEXT,
    source_event_ids TEXT NOT NULL,
    summary TEXT NOT NULL,
    intensity REAL NOT NULL,
    priority REAL NOT NULL,
    desired_resolution TEXT,
    expires_at INTEGER,
    resolved_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // §13.3 反思叙事（主观总结，不入群公共事实）
  ss_reflections: `CREATE TABLE IF NOT EXISTS ss_reflections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    scope TEXT NOT NULL,
    target_user_id TEXT,
    confidence REAL NOT NULL,
    source_event_ids TEXT NOT NULL,
    recommended_concern TEXT,
    expires_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
  )`,
  // §6.8 状态迁移审计（before/delta/after，一切变化可追溯）
  ss_transitions: `CREATE TABLE IF NOT EXISTS ss_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    source_event_id INTEGER,
    before_state_json TEXT NOT NULL,
    delta_json TEXT NOT NULL,
    after_state_json TEXT NOT NULL,
    transition_reason TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    created_at INTEGER NOT NULL
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
  // SelfState
  'CREATE INDEX IF NOT EXISTS idx_ss_emotions_group ON ss_emotions(bot_id, group_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_ss_events_group ON ss_events(bot_id, group_id, occurred_at)',
  'CREATE INDEX IF NOT EXISTS idx_ss_events_actor ON ss_events(group_id, actor_user_id, event_type)',
  'CREATE INDEX IF NOT EXISTS idx_ss_expectations_pending ON ss_expectations(bot_id, group_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_ss_concerns_group ON ss_concerns(bot_id, group_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_ss_transitions_group ON ss_transitions(bot_id, group_id, created_at)',
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
  // 证据主体列（隐私清理修复）：evidence 原本只能经 target_id→gw_traits 间接定位用户，
  // traits 先删后子查询即成孤儿。subject_user_id 让证据行自带归属，purgeUser 可直接定位。
  ['gw_evidence', 'subject_user_id', 'ALTER TABLE gw_evidence ADD COLUMN subject_user_id TEXT'],
  // SelfState §6.6：gw_bot_rel 关系情感扩展列（关系性情绪衰减慢于即时情绪，由 maintenance 处理）
  ['gw_bot_rel', 'gratitude', 'ALTER TABLE gw_bot_rel ADD COLUMN gratitude REAL NOT NULL DEFAULT 0'],
  ['gw_bot_rel', 'hurt', 'ALTER TABLE gw_bot_rel ADD COLUMN hurt REAL NOT NULL DEFAULT 0'],
  ['gw_bot_rel', 'resentment', 'ALTER TABLE gw_bot_rel ADD COLUMN resentment REAL NOT NULL DEFAULT 0'],
  ['gw_bot_rel', 'disappointment', 'ALTER TABLE gw_bot_rel ADD COLUMN disappointment REAL NOT NULL DEFAULT 0'],
  ['gw_bot_rel', 'guardedness', 'ALTER TABLE gw_bot_rel ADD COLUMN guardedness REAL NOT NULL DEFAULT 0'],
  ['gw_bot_rel', 'unresolved_event_count', 'ALTER TABLE gw_bot_rel ADD COLUMN unresolved_event_count INTEGER NOT NULL DEFAULT 0'],
  ['gw_bot_rel', 'last_affective_event_at', 'ALTER TABLE gw_bot_rel ADD COLUMN last_affective_event_at INTEGER'],
]

/**
 * 存量数据回填（幂等，WHERE ... IS NULL 保证重复执行零副作用）：
 *  - trait 证据：subject = 所属 trait 的 user_id；
 *  - edge 证据：subject = from 用户（evidence_text 约定 "from>to:hint" 前缀，解析失败留空由 purge 兜底路径处理）。
 * 迁移后新写入由 _writeEvidence 直接携带 subject_user_id。
 */
const DATA_MIGRATIONS = [
  `UPDATE gw_evidence SET subject_user_id = (SELECT t.user_id FROM gw_traits t WHERE t.id = gw_evidence.target_id)
   WHERE target_type='trait' AND subject_user_id IS NULL`,
  `UPDATE gw_evidence SET subject_user_id = substr(evidence_text, 1, instr(evidence_text, '>') - 1)
   WHERE target_type='edge' AND subject_user_id IS NULL AND evidence_text LIKE '_%>_%'`,
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
      if (cols.length && !cols.some((c) => c.name === col)) {
        try { await runP(db, ddl) } catch (e2) { if (!/duplicate column/i.test(String(e2?.message || e2))) throw e2 }
      }
    } catch (e) { Log.warn(`[groupworld] 列迁移失败 ${table}.${col}:`, e?.message || e) }
  }
  for (const sql of DATA_MIGRATIONS) {
    try { await runP(db, sql) } catch (e) { Log.warn('[groupworld] 存量回填失败:', e?.message || e) }
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
