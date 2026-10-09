/**
 * PersonaAdoptionQueue —— 人设资料「采纳」审批队列（持久化）。
 *
 * 背景：人设资料（PersonaLore draft）一旦采纳会注入身份层，属于持久配置变更。
 * 本模块把「采纳」从"立即生效"改为"先进 Web 审批门，主人批准后才 draft→active"，
 * 给自动/定时补齐产出的草稿留一道人工复核闸。
 *
 * 契约：
 *  - 单文件落盘 dir/adoptions.json（原子写：临时文件 + rename），进程重启不丢待审项；
 *  - 同一人设仅保留一条 pending（重复提交刷新快照，不产生重复待审）；
 *  - 批准时**采纳磁盘上的当前草稿**（不从请求体取内容）——客户端无法借审批接口注入任意资料；
 *  - 批准/驳回均幂等：已决策项再次操作返回错误，不重复产生副作用；
 *  - 非 pending 的历史做有界截断（MAX_RECORDS），pending 永不截断。
 *
 * 安全：队列只存人设资料快照的展示用子集（summary/facts 片段/出处数）+ 发起人 id；
 *      真正生效走 personaLore.adopt（内部再过断言注入闸 assertSafeLore）。不打印资料正文。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// 人设 id 白名单（与 PersonaLore._file 同形）：防路径穿越（id 来自命令/Web 参数）
const ID_RE = /^[\p{L}\p{N}_-]{1,80}$/u
const MAX_RECORDS = 200 // 已决策历史保留上限（pending 不受限）

function hashSnap(snap) {
  return crypto.createHash('sha1').update(JSON.stringify(snap)).digest('hex').slice(0, 12)
}

export class PersonaAdoptionQueue {
  /**
   * @param {object} o
   * @param {string} o.dir            队列文件目录（adoptions.json）
   * @param {object} o.personaLore    PersonaLore 实例（读取草稿 / 采纳 / 灌长尾）
   * @param {function} [o.logger]     可选 logger（仅告警，不打正文）
   * @param {function} [o.now]        时间源（测试用）
   */
  constructor({ dir, personaLore, logger = null, now = Date.now } = {}) {
    if (!dir) throw new Error('PersonaAdoptionQueue 需要 dir')
    if (!personaLore) throw new Error('PersonaAdoptionQueue 需要 personaLore')
    this.dir = dir
    this.personaLore = personaLore
    this.logger = logger
    this._now = now
    this._file = path.join(dir, 'adoptions.json')
    this._data = null
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* noop */ }
  }

  _load() {
    if (this._data) return this._data
    try {
      const raw = JSON.parse(fs.readFileSync(this._file, 'utf8'))
      this._data = {
        seq: Number(raw?.seq) > 0 ? Math.floor(Number(raw.seq)) : 0,
        items: Array.isArray(raw?.items) ? raw.items.filter((i) => i && typeof i === 'object' && i.id) : [],
      }
    } catch { this._data = { seq: 0, items: [] } }
    return this._data
  }

  _persist() {
    const data = this._load()
    const pending = data.items.filter((i) => i.status === 'pending')
    const decided = data.items
      .filter((i) => i.status !== 'pending')
      .sort((a, b) => (b.decidedAt || b.updatedAt || 0) - (a.decidedAt || a.updatedAt || 0))
      .slice(0, MAX_RECORDS)
    data.items = [...pending, ...decided]
    const tmp = `${this._file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify({ seq: data.seq, items: data.items }, null, 2))
      fs.renameSync(tmp, this._file)
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch { /* noop */ }
      throw e
    }
  }

  /** 列表（默认全部；可按 status / personaId 过滤），按最近更新倒序 */
  list({ status = null, personaId = null } = {}) {
    return this._load().items
      .filter((i) => (!status || i.status === status) && (!personaId || i.personaId === personaId))
      .slice()
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
  }

  pending() { return this.list({ status: 'pending' }) }
  pendingCount() { return this._load().items.filter((i) => i.status === 'pending').length }
  get(id) { return this._load().items.find((i) => i.id === String(id)) || null }

  /** 取当前可采纳的草稿：优先独立草稿，其次主文件草稿（未生效）；无则 null */
  _currentDraft(sid) {
    const draft = this.personaLore.getDraft(sid)
    if (draft) return draft
    const main = this.personaLore.get(sid)
    return (main && main.status !== 'active') ? main : null
  }

  _snapshot(lore) {
    return {
      summary: String(lore?.summary || '').slice(0, 300),
      facts: String(lore?.facts || '').slice(0, 4000),
      systemPromptPatch: String(lore?.systemPromptPatch || '').slice(0, 1000),
      sourceCount: Array.isArray(lore?.sources) ? lore.sources.length : 0,
      rawNotesLen: String(lore?.rawNotes || '').length,
    }
  }

  /**
   * 提交/更新一条采纳待审（同一人设只保留一条 pending；已有则刷新快照）。
   * @returns {{ item?: object, duplicated?: boolean, error?: string }}
   */
  request({ personaId, personaName = null, by = null, via = 'unknown' } = {}) {
    const sid = String(personaId ?? '')
    if (!ID_RE.test(sid)) return { error: '非法人设 id', code: 'bad_id' }
    const src = this._currentDraft(sid)
    if (!src) return { error: `人设「${sid}」暂无待采纳草稿`, code: 'no_draft' }
    const snap = this._snapshot(src)
    const hash = hashSnap(snap)
    const data = this._load()
    const existing = data.items.find((i) => i.status === 'pending' && i.personaId === sid)
    if (existing) {
      existing.snapshot = snap
      existing.hash = hash
      existing.personaName = personaName || existing.personaName || ''
      existing.by = by != null ? String(by) : existing.by
      existing.via = String(via || existing.via || 'unknown')
      existing.updatedAt = this._now()
      this._persist()
      return { item: existing, duplicated: true }
    }
    data.seq += 1
    const item = {
      id: 'pa' + String(data.seq).padStart(4, '0'),
      personaId: sid,
      personaName: personaName ? String(personaName).slice(0, 120) : '',
      status: 'pending',
      snapshot: snap,
      hash,
      by: by != null ? String(by) : null,
      via: String(via || 'unknown'),
      createdAt: this._now(),
      updatedAt: this._now(),
      decidedAt: null,
      decidedBy: null,
      reason: null,
    }
    data.items.push(item)
    this._persist()
    return { item, duplicated: false }
  }

  /** 补齐/刷新后同步待审快照（若该人设存在 pending）：保证审批门看到的是当前草稿 */
  refreshPending(personaId, { personaName = null } = {}) {
    const sid = String(personaId ?? '')
    const item = this._load().items.find((i) => i.status === 'pending' && i.personaId === sid)
    if (!item) return null
    const src = this._currentDraft(sid)
    if (!src) return null
    item.snapshot = this._snapshot(src)
    item.hash = hashSnap(item.snapshot)
    if (personaName) item.personaName = String(personaName).slice(0, 120)
    item.updatedAt = this._now()
    this._persist()
    return item
  }

  /**
   * 批准：采纳磁盘当前草稿（draft→active）+ 灌长尾库；标记 applied。
   * 采用请求时以外的当前内容——审批接口不接受客户端内容，防注入。
   * @returns {{ item?, lore?, ingestError?, error? }}
   */
  async approve(id, { by = null } = {}) {
    const item = this.get(id)
    if (!item) return { error: '待审项不存在' }
    if (item.status !== 'pending') return { error: `该待审项已处理（${item.status}）` }
    const src = this._currentDraft(item.personaId)
    const main = this.personaLore.get(item.personaId)
    if (!src) return { error: '草稿已不存在（可能已被丢弃或已生效）' }
    const newContent = !!this.personaLore.getDraft(item.personaId) || main?.status !== 'active'
    let lore
    try { lore = this.personaLore.adopt(item.personaId) }
    catch (e) { return { error: `采纳失败：${e?.message || e}` } }
    let ingestError = null
    if (newContent && src.rawNotes) {
      const ir = await this.personaLore
        .ingest(item.personaId, src.rawNotes, { title: `人设资料·${item.personaId}` })
        .catch((e) => ({ error: e?.message || e }))
      // 近似重复=已有等价内容，不算失败（避免 refresh→采纳 时误报）
      if (ir?.error && !/近似重复/.test(ir.error)) {
        ingestError = ir.error
        try { this.logger?.warn?.('[persona-adopt] 长尾资料入库失败', item.personaId, ir.error) } catch { /* noop */ }
      }
    }
    item.status = 'applied'
    item.decidedAt = this._now()
    item.decidedBy = by != null ? String(by) : null
    item.updatedAt = item.decidedAt
    this._persist()
    return { item, lore, ingestError }
  }

  /** 驳回：只驳回请求，保留草稿（用户可改后重新提交），标记 rejected */
  reject(id, { by = null, reason = '' } = {}) {
    const item = this.get(id)
    if (!item) return { error: '待审项不存在' }
    if (item.status !== 'pending') return { error: `该待审项已处理（${item.status}）` }
    item.status = 'rejected'
    item.reason = String(reason || '').slice(0, 300)
    item.decidedAt = this._now()
    item.decidedBy = by != null ? String(by) : null
    item.updatedAt = item.decidedAt
    this._persist()
    return { item }
  }

  /** 撤销某人设的待审（如草稿被丢弃/人设被删）：标记 cancelled。返回撤销条数。 */
  cancelByPersona(personaId) {
    const sid = String(personaId ?? '')
    let n = 0
    for (const item of this._load().items) {
      if (item.status === 'pending' && item.personaId === sid) {
        item.status = 'cancelled'
        item.decidedAt = this._now()
        item.updatedAt = item.decidedAt
        item.reason = '草稿已丢弃/人设已变更'
        n++
      }
    }
    if (n) this._persist()
    return n
  }
}
