/**
 * HumanizeMemoryStore —— 伪人独立记忆库（MaiBot 式三层记忆的长时层）。
 *
 * 与主 Agent 的记忆（rt.recall / MemoryStore / KV）完全独立：独立 sqlite 文件
 * （data/humanize/memory.db），独立检索/整合/遗忘管线。主 Agent 看不到这里，反之亦然。
 *
 * 生命周期（参考 MaiBot 心意架构的"睡眠整合"）：
 *  - 感觉/短时记忆 = 现有 MessageBuffer（进程内 + 重启恢复，见 bufferTail 持久化）
 *  - 长时记忆 = 本库。每日低峰 cron 把近期对话（含 bot 自身发言）交给 LLM 以**角色第一人称视角**
 *    整合成记忆条目（对成员的印象 / 群事件 / 群梗黑话 / 我的风格被如何回应），相似条目合并、
 *    重要性加权、超量淘汰。
 *  - 检索 = 双模相似度：配置 embedding 模型（agent.recall.embedProvider）时语义余弦为主
 *    （同义换说可召回："爱玩梗" ↔ "老拿我开玩笑"）；未配/某条向量缺失自动回落中文 bigram 词面。
 *    相似度 × 重要性 × 新近度 + 目标用户印象加成取 top-k 注入。
 *  - 向量管理 = 记忆创建/合并时 embed 入库（hm_memories.embedding BLOB）；换 embedding 模型自动
 *    清空存量向量（hm_meta 记模型标识），检索时每轮懒回填 8 条逐步追平。
 *  - 遗忘 = 每日衰减（重要性随周龄递减），低价值/超龄条目删除。
 *
 * 红线：只记群聊公开可见内容（整合 prompt 内置约束）；群间隔离（group_id 主键维度）；
 * 记忆是角色主观视角（"我记得…"），注入时标注"主观印象仅供参考，不复述"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Log from '../../utils/Log.js'
import { textSim, cosine, toBlob, fromBlob } from '../groupworld/embedding.js'
import { parseLlmJson } from '../selfstate/prompts.js'
import { textSim as _textSim } from '../groupworld/embedding.js'
import { MEMORY_CONSOLIDATE_SYSTEM, buildConsolidatePrompt } from './prompts.js'

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

export class HumanizeMemoryStore {
  /**
   * @param {object} opts { dataDir, provider?, cfg:()=>object, trace?, embedder? }
   *   embedder = makeEmbedder 产物（可选）。配置后检索走语义余弦，未配回落纯词面。
   */
  constructor({ dataDir, provider = null, cfg, trace = null, embedder = null } = {}) {
    this.dataDir = dataDir
    this.provider = provider
    this.embedder = embedder
    this._cfgFn = typeof cfg === 'function' ? cfg : () => cfg || {}
    this.trace = trace
    this._db = null
    this._ready = false
    this._initPromise = null
    // 整合水位：每群已整合到的 buffer seq（防重复整合同一段对话）
    this._consolidatedSeq = new Map()
    this._qVecCache = new Map() // 检索 query → 向量 LRU（同句重复检索不重复调 API）
  }

  async init() {
    if (this._ready) return true
    if (this._initPromise) return this._initPromise
    this._initPromise = (async () => {
      try {
        const { createRequire } = await import('node:module')
        const require = createRequire(import.meta.url)
        const sqlite3 = require('sqlite3')
        fs.mkdirSync(this.dataDir, { recursive: true })
        const db = new sqlite3.Database(path.join(this.dataDir, 'memory.db'))
        const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this) }))
        const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)))
        const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r || [])))
        const txn = async (fn) => { await run('BEGIN IMMEDIATE'); try { const r = await fn(); await run('COMMIT'); return r } catch (e) { await run('ROLLBACK').catch(() => {}); throw e } }
        await run('PRAGMA journal_mode=WAL')
        await run(`CREATE TABLE IF NOT EXISTS hm_memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id TEXT NOT NULL,
          user_id TEXT,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          keywords TEXT NOT NULL DEFAULT '[]',
          importance REAL NOT NULL DEFAULT 0.5,
          hit_count INTEGER NOT NULL DEFAULT 0,
          source_span TEXT,
          last_used_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`)
        await run('CREATE INDEX IF NOT EXISTS idx_hm_group ON hm_memories(group_id, kind)')
        await run(`CREATE TABLE IF NOT EXISTS hm_meta (key TEXT PRIMARY KEY, value TEXT)`)
        // embedding 列迁移（旧库无此列）+ 模型一致性：换 embedding 模型清空存量向量（检索懒回填重建）
        try {
          const cols = await all('PRAGMA table_info(hm_memories)')
          if (cols.length && !cols.some((c) => c.name === 'embedding')) await run('ALTER TABLE hm_memories ADD COLUMN embedding BLOB')
        } catch { /* noop */ }
        if (this.embedder) {
          const tag = this.embedder.model || 'default'
          const prev = await get("SELECT value FROM hm_meta WHERE key='embedding_model'")
          if (prev && prev.value !== tag) {
            await run('UPDATE hm_memories SET embedding=NULL')
            Log.info('[humanize-memory] embedding 模型变更，已清空存量记忆向量（检索时懒回填重建）')
          }
          await run("INSERT OR REPLACE INTO hm_meta(key,value) VALUES ('embedding_model',?)", [tag])
        }
        this.dao = { run, get, all, txn }
        this._db = db
        this._ready = true
        return true
      } catch (e) {
        Log.warn('[humanize-memory] 初始化失败（记忆功能降级禁用）', e?.message || e)
        this._ready = false
        return false
      } finally { this._initPromise = null }
    })()
    return this._initPromise
  }

  cfg() { return this._cfgFn().memory || {} }

  // ─────────────── 向量辅助（embedder 未配时全 no-op） ───────────────
  /** 检索 query 向量（LRU 缓存，同句重复检索不重复调 API）。 */
  async _embedQuery(text) {
    if (!this.embedder) return null
    const key = createHash('sha1').update(String(text)).digest('hex').slice(0, 16)
    if (this._qVecCache.has(key)) { const v = this._qVecCache.get(key); this._qVecCache.delete(key); this._qVecCache.set(key, v); return v }
    const v = await this.embedder.embed(String(text).slice(0, 256))
    if (!v) return null
    if (this._qVecCache.size > 100) { const k = this._qVecCache.keys().next().value; this._qVecCache.delete(k) }
    this._qVecCache.set(key, v)
    return v
  }

  /** 记忆条目向量入库（创建/合并后调用；失败静默——该条回落词面召回）。 */
  async _embedRow(id, content) {
    if (!this.embedder || !id) return
    try {
      const v = await this.embedder.embed(String(content || ''))
      if (v) await this.dao.run('UPDATE hm_memories SET embedding=? WHERE id=?', [toBlob(v), id])
    } catch (e) { Log.warn('[humanize-memory] 记忆向量入库失败 id=' + id + ':', e?.message || e) }
  }

  // ─────────────── 整合（睡眠：近期对话 → 长时记忆） ───────────────
  /**
   * @param {object} o { groupId, messages(带 seq/isSelf/text/userId/displayName/timestamp), now }
   * @returns {Promise<{created:number,merged:number,skipped?:string}>}
   */
  async consolidate({ groupId, messages, now = Date.now() }) {
    if (!await this.init() || !this._ready) return { created: 0, merged: 0, skipped: 'db' }
    const mc = this.cfg()
    if (mc.enabled === false) return { created: 0, merged: 0, skipped: 'disabled' }
    const msgs = (Array.isArray(messages) ? messages : []).filter((m) => m && String(m.text || '').trim())
    if (msgs.length < (mc.minConsolidateMessages ?? 6)) return { created: 0, merged: 0, skipped: 'few' }
    if (!this.provider) return { created: 0, merged: 0, skipped: 'no_provider' }

    const span = `${new Date(msgs[0].timestamp).toISOString().slice(0, 16)}~${new Date(msgs[msgs.length - 1].timestamp).toISOString().slice(0, 16)}`
    let parsed = null
    try {
      const res = await this.provider.chat({
        model: mc.model || undefined,
        system: MEMORY_CONSOLIDATE_SYSTEM,
        messages: [{ role: 'user', content: buildConsolidatePrompt(msgs) }],
        tools: undefined, tool_choice: { mode: 'none' },
        temperature: 0.3, max_tokens: 800, thinking: { type: 'disabled' }, stream: false,
      })
      parsed = parseLlmJson(res?.content || '')
    } catch (e) { Log.warn('[humanize-memory] 整合 LLM 失败', e?.message || e); return { created: 0, merged: 0, skipped: 'llm' } }
    const cands = Array.isArray(parsed?.memories) ? parsed.memories : []
    const suspected = (Array.isArray(parsed?.suspected_jargon) ? parsed.suspected_jargon : []).map((s) => String(s).slice(0, 24)).filter(Boolean).slice(0, 3)
    if (!cands.length) return { created: 0, merged: 0, skipped: 'empty', suspected }

    let created = 0; let merged = 0
    const existing = await this.dao.all('SELECT * FROM hm_memories WHERE group_id=?', [String(groupId)])
    for (const c of cands) {
      const content = String(c.content || '').trim().slice(0, 300)
      if (!content) continue
      const kind = ['impression', 'event', 'jargon', 'style'].includes(c.kind) ? c.kind : 'event'
      const userId = c.about_user ? String(c.about_user) : null
      const kws = (Array.isArray(c.keywords) ? c.keywords : []).map((k) => String(k).slice(0, 12)).slice(0, 8)
      const importance = clamp01(c.importance ?? 0.5)
      // 去重合并：同群同 kind 同对象 且内容相似 ≥0.6 → 合并（保留更长内容、关键词并集、重要性取大+0.05）
      const dup = existing.find((e) => e.kind === kind && (e.user_id || null) === userId && textSim(content, String(e.content || '')) >= 0.6)
      if (dup) {
        const oldKws = (() => { try { return JSON.parse(dup.keywords || '[]') } catch { return [] } })()
        const unionKws = [...new Set([...kws, ...oldKws])].slice(0, 8)
        await this.dao.run(
          'UPDATE hm_memories SET content=?, keywords=?, importance=MIN(1, MAX(?, ?)+0.05), source_span=?, updated_at=? WHERE id=?',
          [String(dup.content || '').length >= content.length ? dup.content : content, JSON.stringify(unionKws), Number(dup.importance) || 0, importance, span, now, dup.id],
        ).catch(() => {})
        Object.assign(dup, { content, keywords: JSON.stringify(unionKws), importance: Math.min(1, Math.max(Number(dup.importance) || 0, importance) + 0.05) })
        this._embedRow(dup.id, String(dup.content || '').length >= content.length ? dup.content : content).catch(() => {}) // 内容变了重嵌
        merged++
      } else {
        const r = await this.dao.run(
          `INSERT INTO hm_memories(group_id,user_id,kind,content,keywords,importance,source_span,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
          [String(groupId), userId, kind, content, JSON.stringify(kws), importance, span, now, now],
        ).catch(() => null)
        if (r?.lastID) { existing.push({ id: r.lastID, kind, user_id: userId, content, keywords: JSON.stringify(kws), importance }); this._embedRow(r.lastID, content).catch(() => {}); created++ }
      }
    }
    // 超量淘汰：按 价值 = importance×(1+log(1+hit)) − 周龄衰减 排序删最低
    const cap = mc.maxPerGroup ?? 300
    const total = existing.length
    if (total > cap) {
      await this.dao.run(
        `DELETE FROM hm_memories WHERE id IN (
           SELECT id FROM hm_memories WHERE group_id=? ORDER BY (importance*(1+ln(1+hit_count))) - ((?-updated_at)/604800000.0)*0.08 ASC LIMIT ?)`,
        [String(groupId), now, total - cap],
      ).catch(() => {})
    }
    await this.markConsolidated(groupId, Math.max(...msgs.map((x) => Number(x.seq) || 0), 0))
    this.trace?.record?.('hm_consolidate', { groupId, created, merged, source: msgs.length, suspected: suspected.length })
    return { created, merged, suspected }
  }

  // ─────────────── 检索（注入 Planner/Replyer） ───────────────
  /**
   * @param {object} o { groupId, userId?, query?, topK?, kinds? }
   * @returns {Promise<Array>} 命中行（升序时间）；副作用：hit_count/last_used_at 推进
   */
  async recall({ groupId, userId = null, query = '', topK = 5, kinds = null, allowedUsers = null } = {}) {
    if (!await this.init() || !this._ready) return []
    const rows = await this.dao.all('SELECT * FROM hm_memories WHERE group_id=?', [String(groupId)]).catch(() => [])
    if (!rows.length) return []
    const now = Date.now()
    // 双模：embedder 可用时 query 走语义向量；缺失向量的行懒回填（每轮 8 条，按重要性优先逐步追平）
    let qEmb = null
    if (this.embedder && query) {
      qEmb = await this._embedQuery(query).catch(() => null)
      if (qEmb) {
        const missing = rows.filter((r) => !r.embedding).sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0)).slice(0, 8)
        for (const m of missing) await this._embedRow(m.id, m.content)
        if (missing.length) {
          const refetch = await this.dao.all('SELECT * FROM hm_memories WHERE group_id=?', [String(groupId)]).catch(() => rows)
          for (const m of missing) { const f = refetch.find((x) => x.id === m.id); if (f) m.embedding = f.embedding }
        }
      }
    }
    let scored = []
    for (const r of rows) {
      if (Array.isArray(kinds) && kinds.length && !kinds.includes(r.kind)) continue
      // 作用域白名单（MaiBot _is_hit_allowed 同款）：印象类记忆只允许本轮活跃人物命中，
      // 防旧对话人物（两小时前的"云海"）凭语义相似混入当前对话
      if (Array.isArray(allowedUsers) && r.kind === 'impression' && r.user_id && !allowedUsers.map(String).includes(String(r.user_id))) continue
      let kws = []; try { kws = JSON.parse(r.keywords || '[]') } catch { /* noop */ }
      // 语义余弦优先（同义换说可召回）；无向量/维度不符（换模型期）回落词面 bigram
      let sim = 0
      if (query) {
        if (qEmb) {
          const emb = fromBlob(r.embedding)
          const c = emb ? cosine(qEmb, emb) : null
          sim = c != null ? c : textSim(query, `${r.content} ${kws.join(' ')}`)
        } else {
          sim = textSim(query, `${r.content} ${kws.join(' ')}`)
        }
      }
      if (query && sim <= 0.05) continue
      const targetBoost = (userId && r.user_id && String(r.user_id) === String(userId)) ? 0.25 : 0
      const recency = Math.max(0, 1 - (now - Number(r.updated_at || r.created_at)) / (30 * 86400e3)) * 0.15
      const score = sim * 0.6 + (Number(r.importance) || 0) * 0.2 + recency + targetBoost
      if (score < 0.12) continue
      scored.push({ r, score })
    }
    scored.sort((a, b) => b.score - a.score)
    const out = scored.slice(0, Math.max(1, topK | 0 || 5))
    for (const { r } of out) {
      await this.dao.run('UPDATE hm_memories SET hit_count=hit_count+1, last_used_at=? WHERE id=?', [now, r.id]).catch(() => {})
    }
    return out.map(({ r }) => r)
  }

  /** 格式化为 prompt 注入块（角色主观视角；标注不复述）。 */
  async recallText(o) {
    const rows = await this.recall(o)
    if (!rows.length) return ''
    const KIND_ZH = { impression: '印象', event: '事件', jargon: '群梗', style: '风格反馈' }
    const lines = rows.map((r) => {
      const tag = r.user_id ? `对${String(r.user_id).slice(-4)}的${KIND_ZH[r.kind] || r.kind}` : `${KIND_ZH[r.kind] || r.kind}`
      return `- [${tag}] ${r.content}`
    })
    return `【我的群聊记忆（主观印象，仅供参与参考，不向群友复述）】\n${lines.join('\n')}`
  }

  // ─────────────── 遗忘（每日衰减 + 低价值清理） ───────────────
  async decay(groupId, now = Date.now()) {
    if (!await this.init() || !this._ready) return 0
    const forgetDays = this.cfg().forgetDays ?? 30
    try {
      // 重要性按周龄衰减（每周 ×0.9）——JS 计算逐行更新（不依赖 SQLite 数学函数编译开关）
      const rows = await this.dao.all('SELECT id, importance, updated_at FROM hm_memories WHERE group_id=? AND updated_at<?', [String(groupId), now - 7 * 86400e3])
      for (const r of rows) {
        const weeks = (now - Number(r.updated_at)) / 604800e3
        const nv = Math.max(0.05, (Number(r.importance) || 0.5) * Math.pow(0.9, weeks))
        if (Math.abs(nv - (Number(r.importance) || 0)) > 0.005) {
          await this.dao.run('UPDATE hm_memories SET importance=? WHERE id=?', [Math.round(nv * 1000) / 1000, r.id]).catch(() => {})
        }
      }
      const del = await this.dao.run(
        'DELETE FROM hm_memories WHERE group_id=? AND ((importance<0.15 AND hit_count<2 AND updated_at<?) OR updated_at<?)',
        [String(groupId), now - 14 * 86400e3, now - Math.max(forgetDays, 14) * 86400e3],
      )
      const n = del?.changes || 0
      if (n) this.trace?.record?.('hm_decay', { groupId, removed: n })
      return n
    } catch { return 0 }
  }

  /**
   * 本群梗词典（全量注入用）：jargon 类记忆不做相关性检索——梗是背景知识，
   * 群里说"咕嘎"时按相关性查"咕嘎是什么"往往查不到，必须整本词典常驻 prompt。
   * 上限 25 条（重要性降序），空库返回 ''。
   */
  async jargonDict(groupId) {
    if (!await this.init() || !this._ready) return ''
    const rows = await this.dao.all(
      "SELECT content FROM hm_memories WHERE group_id=? AND kind='jargon' ORDER BY importance DESC LIMIT 25",
      [String(groupId)],
    ).catch((e) => { Log.warn('[humanize-memory] 梗词典查询失败:', e?.message || e); return [] })
    if (!rows.length) return ''
    return '【本群梗/黑话词典（背景知识，自然理解使用，不向群友背诵）】\n' + rows.map((r) => `- ${r.content}`).join('\n')
  }

  /**
   * 网络梗学习（冷启动）：对整合时发现的词典外梗逐个上网搜索→LLM 提炼→去重入库。
   * 防污染三闸：①预查去重（词面 bigram≥0.55 或向量余弦≥0.75 视为已收录，如 咕嘎/咕咕嘎嘎 同族）；
   * ②置信门槛（提炼 confidence<0.6 不入库——错误解释比缺梗更毒，留给"问群友"路径兜底）；
   * ③重试上限（同词最多搜 2 次仍无果则放弃，防反复烧搜索）。
   * @param {object} o { groupId, terms[], webSearch(q)=>{text}, now }
   */
  async learnJargonFromWeb({ groupId, terms = [], webSearch = null, now = Date.now() }) {
    const out = { learned: 0, skipped: 0, failed: 0 }
    if (!await this.init() || !this._ready || typeof webSearch !== 'function') return out
    const existing = await this.dao.all("SELECT content, keywords, embedding FROM hm_memories WHERE group_id=? AND kind='jargon'", [String(groupId)]).catch((e) => { Log.warn('[humanize-memory] 梗去重预查失败:', e?.message || e); return [] })
    for (const term of (terms || []).slice(0, 3)) {
      const q = `${term} 梗 什么意思 网络用语`
      // 闸①：去重预查——keywords 精确命中（入库时已存词本身）> 词条前缀匹配 > 词面 bigram ≥0.55（同族变体）
      let dup = existing.some((r) => {
        let kws = []; try { kws = JSON.parse(r.keywords || '[]') } catch { /* noop */ }
        const stem = String(r.content || '').split('=')[0] || ''
        const containment = kws.some((k) => k.length >= 2 && term.length >= 2 && (k.includes(term) || term.includes(k)))
          || (stem.length >= 2 && term.length >= 2 && (stem.includes(term) || term.includes(stem)))
        return kws.includes(term) || String(r.content || '').startsWith(term + '=') || containment || _textSim(term, stem) >= 0.55
      })
      if (!dup && this.embedder) {
        const tv = await this.embedder.embed(term).catch(() => null)
        if (tv) for (const r of existing) {
          const ev = fromBlob(r.embedding)
          if (ev && cosine(tv, ev) >= 0.75) { dup = true; break }
        }
      }
      if (dup) { out.skipped++; continue }
      // 闸③：重试上限（hm_meta 计数）
      const rt = await this.dao.get("SELECT value FROM hm_meta WHERE key='jargon_retry:' || ?", [String(groupId) + ':' + term]).catch(() => null)
      if (Number(rt?.value) >= 2) { out.skipped++; continue }
      // 搜索 + 提炼
      try {
        const raw = await webSearch(q)
        if (!raw || String(raw).trim().length < 50) throw new Error('搜索无结果')
        const res = await this.provider.chat({
          model: this.cfg().model || undefined,
          system: '你是网络梗释义器。给你一个词和搜索结果，输出纯 JSON：{"explanation":"一句话解释这个梗（≤50字）","confidence":0~1}。搜索结果不足以支撑解释时 confidence 给 0.5 以下。不要编造。',
          messages: [{ role: 'user', content: `词：${term}\n搜索结果：\n${String(raw).slice(0, 2000)}` }],
          tools: undefined, tool_choice: { mode: 'none' }, temperature: 0.2, max_tokens: 150, thinking: { type: 'disabled' }, stream: false,
        })
        const parsed = parseLlmJson(res?.content || '')
        const conf = clamp01(parsed?.confidence)
        if (conf < 0.6) throw new Error('低置信 ' + conf.toFixed(2))
        const content = `${term}=${parsed.explanation}（网络解释，以本群实际用法为准）`
        await this.dao.run(
          `INSERT INTO hm_memories(group_id,user_id,kind,content,keywords,importance,source_span,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
          [String(groupId), null, 'jargon', content, JSON.stringify([term]), 0.5, 'web', now, now],
        )
        this._embedRow((await this.dao.get('SELECT id FROM hm_memories WHERE group_id=? AND content=? ORDER BY id DESC LIMIT 1', [String(groupId), content]))?.id, content).catch(() => {})
        existing.push({ content, embedding: null })
        out.learned++
        this.trace?.record?.('hm_jargon_web', { groupId, term, conf })
      } catch (e) {
        const key = String(groupId) + ':' + term
        await this.dao.run("INSERT OR REPLACE INTO hm_meta(key,value) VALUES ('jargon_retry:' || ?, ?)", [key, (Number(rt?.value) || 0) + 1]).catch(() => {})
        out.failed++
        Log.warn('[humanize-memory] 网络梗学习失败（' + term + '）:', e?.message || e)
      }
    }
    return out
  }

  /** 增量整合水位：距上次整合新增 ≥ n 条消息才值得再跑（存 hm_meta 跨重启）。 */
  async shouldConsolidate(groupId, currentSeq, minNew = 20) {
    if (!await this.init() || !this._ready) return false
    const r = await this.dao.get("SELECT value FROM hm_meta WHERE key='consolidated_seq:' || ?", [String(groupId)]).catch(() => null)
    const last = Number(r?.value) || 0
    return Number(currentSeq) - last >= minNew
  }

  /** 记录整合水位。 */
  async markConsolidated(groupId, seq) {
    await this.dao.run("INSERT OR REPLACE INTO hm_meta(key,value) VALUES ('consolidated_seq:' || ?, ?)", [String(groupId), Number(seq) || 0]).catch(() => {})
  }

  /** 管理查看：最近 N 条。 */
  async recent(groupId, limit = 20) {
    if (!await this.init() || !this._ready) return []
    return this.dao.all('SELECT id,kind,user_id,content,importance,hit_count,datetime(created_at/1000,\'unixepoch\') AS created FROM hm_memories WHERE group_id=? ORDER BY updated_at DESC LIMIT ?', [String(groupId), limit]).catch(() => [])
  }

  async stats(groupId) {
    if (!await this.init() || !this._ready) return null
    const r = await this.dao.get('SELECT COUNT(*) n, SUM(hit_count) hits FROM hm_memories WHERE group_id=?', [String(groupId)]).catch(() => null)
    return r ? { total: Number(r.n) || 0, hits: Number(r.hits) || 0 } : null
  }
}
