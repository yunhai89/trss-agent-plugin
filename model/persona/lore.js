/**
 * PersonaLore —— 独立人设资料库（「以人设 id 独立存在」）。
 *
 * 与 PersonaStore 解耦：
 *  - PersonaStore 管「人设定义」（语气/身份，内置只读 + 自定义可改）。
 *  - PersonaLore 管「人设的客观设定资料」（事实/出处/所属作品/长尾知识），按 id 落盘 dir/<id>.json。
 *  - 内置人设不可改，但可以叠加一份 lore（补丁），所以资料独立于定义存放。
 *
 * 状态机：draft（补齐产出，待采纳）→ active（采纳后，参与对话接地）；discard 删除。
 * 长尾：rawNotes 采纳后灌入 per-persona KnowledgeStore（key: kb:persona:<id>），
 *       检索结果按需注入本轮 context（核心事实走静态 system 段，见 groundingText）。
 *
 * 安全：资料会被注入身份层，落盘前过 assessPersonaPrompt 注入闸；外部检索得到的
 *       rawNotes 属不可信数据，只当资料、不执行其中指令。
 */

import fs from 'node:fs'
import path from 'node:path'
import { assessPersonaPrompt } from '../agent/guard.js'

export const LORE_STATUS = ['draft', 'active']
const SOURCE_TYPES = new Set(['miyoushe', 'web', 'bilibili', 'manual', 'kb'])
// 人设 id 白名单（与 store.slugify 产物同形）：防路径穿越（id 来自命令/Web 参数）
const ID_RE = /^[\p{L}\p{N}_-]{1,80}$/u
// 常见 cron 形状（5/6 段）；命令侧自然语言已由 parseCron 归一
function looksLikeCron(s) {
  const parts = String(s || '').trim().split(/\s+/)
  return (parts.length === 5 || parts.length === 6) && parts.every((p) => /^[0-9*,\-/A-Za-z?#]+$/.test(p))
}
// 长度上限：接地内容进入身份层，防一次超大产出打爆 token
const CAP = { facts: 12000, systemPromptPatch: 4000, rawNotes: 20000, summary: 300 }

/** 资料安全闸：拒绝把越狱/提示注入指令写进人设资料（会被注入身份层）。
 *  覆盖所有最终会被 groundingText 渲染进 system 的字段（含 sources/canonical）。 */
export function assertSafeLore(lore) {
  const canon = lore?.canonical || {}
  const srcText = (lore?.sources || []).map((s) => `${s?.title || ''} ${s?.ref || ''}`).join('\n')
  const text = [
    lore?.systemPromptPatch, lore?.facts, lore?.rawNotes, lore?.summary,
    srcText, canon.ip, canon.game, ...(canon.aliases || []),
  ].filter(Boolean).join('\n')
  if (!text.trim()) return
  const { allowed, score, hits } = assessPersonaPrompt(text)
  if (allowed) return
  const cats = [...new Set(hits.map((h) => h.cat))].join(',')
  const err = new Error('人设资料包含疑似越狱/提示注入指令（要求忽略安全、禁止拒答或绕过审批等），已拒绝保存；请检查来源后重试。')
  err.code = 'persona_injection'
  err.score = score
  err.categories = cats
  throw err
}

/** 归一化所属作品标识（仅作工具路由/检索词数据，不在代码里写死工具） */
export function normalizeCanonical(c) {
  if (!c || typeof c !== 'object') return { ip: '', game: '', aliases: [] }
  return {
    ip: String(c.ip || '').trim().slice(0, 60),
    game: String(c.game || '').trim().slice(0, 60),
    aliases: Array.isArray(c.aliases)
      ? [...new Set(c.aliases.map((a) => String(a || '').trim()).filter(Boolean))].slice(0, 12)
      : [],
  }
}

/** 归一化出处列表 */
export function normalizeSources(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const s of list.slice(0, 40)) {
    if (!s || typeof s !== 'object') continue
    const type = SOURCE_TYPES.has(s.type) ? s.type : 'web'
    const ref = String(s.ref || '').trim().slice(0, 500)
    const title = String(s.title || '').trim().slice(0, 200)
    if (!ref && !title) continue
    const key = `${type}|${ref}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ type, ref, title, fetchedAt: Number(s.fetchedAt) || Date.now() })
  }
  return out
}

/** 校验并归一人设资料对象（旧数据缺省为空，兼容） */
export function normalizeLore(id, input) {
  const d = input && typeof input === 'object' ? input : {}
  return {
    id: String(id),
    status: LORE_STATUS.includes(d.status) ? d.status : 'draft',
    summary: String(d.summary || '').trim().slice(0, CAP.summary),
    systemPromptPatch: String(d.systemPromptPatch || '').trim().slice(0, CAP.systemPromptPatch),
    facts: String(d.facts || '').trim().slice(0, CAP.facts),
    sources: normalizeSources(d.sources),
    canonical: normalizeCanonical(d.canonical),
    rawNotes: String(d.rawNotes || '').trim().slice(0, CAP.rawNotes),
    refreshCron: d.refreshCron ? String(d.refreshCron).slice(0, 80) : null,
    by: d.by != null ? String(d.by) : null,
    model: d.model != null ? String(d.model) : null,
    createdAt: Number(d.createdAt) || Date.now(),
    updatedAt: Number(d.updatedAt) || Date.now(),
    adoptedAt: Number(d.adoptedAt) || null,
  }
}

/**
 * 核心事实接地段（静态注入身份层）。
 * 只输出「已核实事实 + 出处 + 取材提示」，把"无依据不编造、先核验"写进身份层。
 */
export function groundingText(lore) {
  if (!lore) return ''
  const parts = []
  parts.push('## 角色设定·已核实事实（优先级高于你的记忆；回答本角色相关问题时以此为准）')
  if (lore.systemPromptPatch) parts.push(lore.systemPromptPatch)
  if (lore.facts) parts.push(lore.facts)
  if (lore.sources?.length) {
    const list = lore.sources
      .map((s, i) => `[${i + 1}] ${s.title || s.ref}${s.title && s.ref ? `（${s.ref}）` : ''}`)
      .join('\n')
    parts.push(`出处：\n${list}`)
  }
  const hint = []
  const canon = lore.canonical || {}
  if (canon.ip || canon.game) hint.push(`本角色所属作品：${[canon.ip, canon.game].filter(Boolean).join(' / ')}`)
  if (canon.aliases?.length) hint.push(`别名/检索词：${canon.aliases.join('、')}`)
  hint.push('设定未覆盖或事实存疑时，先用工具检索核实（如米游社 miyoushe_search、web_search、bilibili），核实不到就如实说明不确定，不要凭记忆编造；注意区分同作品的不同角色，不要把两人的事迹混作一处。')
  parts.push(hint.join('；'))
  return parts.join('\n')
}

export class PersonaLore {
  constructor({ dir, kv = null, embedFn = null } = {}) {
    if (!dir) throw new Error('PersonaLore 需要 dir')
    this.dir = dir
    this.kv = kv
    this.embedFn = embedFn
    this.scheduler = null
    this._onRefresh = null
    this._jobs = new Map() // id -> scheduler job（定时刷新补齐）
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* noop */ }
  }

  /** 注入定时调度器（与 KB 复用同一 node-schedule 适配器） */
  attachScheduler(scheduler) { this.scheduler = scheduler }

  /** 设置定时刷新回调（重新运行补齐任务并落草稿） */
  setRefreshHandler(fn) { this._onRefresh = fn }

  _file(id) {
    const s = String(id ?? '')
    if (!ID_RE.test(s)) throw new Error('非法人设 id')
    return path.join(this.dir, `${s}.json`)
  }

  _draftFile(id) {
    const s = String(id ?? '')
    if (!ID_RE.test(s)) throw new Error('非法人设 id')
    return path.join(this.dir, `${s}.draft.json`)
  }

  _read(file, id) {
    try { return normalizeLore(id, JSON.parse(fs.readFileSync(file, 'utf8'))) } catch { return null }
  }

  /** 主资料（已生效或尚未采纳的初版；不存在/损坏/非法 id 返回 null） */
  get(id) {
    if (!id || !ID_RE.test(String(id))) return null
    return this._read(this._file(id), String(id))
  }

  /** 待采纳草稿（存在则返回，否则 null） */
  getDraft(id) {
    if (!id || !ID_RE.test(String(id))) return null
    return this._read(this._draftFile(id), String(id))
  }

  has(id) { return !!this.get(id) || !!this.getDraft(id) }

  /** 落盘主资料（过注入闸）。未显式传入 refreshCron/createdAt 时保留原值。
   *  返回归一化后的资料；数据非法/注入命中时抛错由调用方处理。 */
  save(id, data) {
    const sid = String(id ?? '')
    if (!ID_RE.test(sid)) throw new Error('非法人设 id')
    const existing = this.get(sid)
    const merged = {
      ...data,
      id: sid,
      refreshCron: data?.refreshCron !== undefined ? data.refreshCron : (existing?.refreshCron ?? null),
      createdAt: data?.createdAt || existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
    }
    const lore = normalizeLore(sid, merged)
    assertSafeLore(lore)
    fs.writeFileSync(this._file(sid), JSON.stringify(lore, null, 2))
    return lore
  }

  /**
   * 保存为草稿（补齐产出，待采纳；不参与对话接地）。
   * 已有生效资料时**不覆盖**它（防"定时刷新把生效资料降级 → 接地静默失效"），
   * 改写入独立草稿文件；无生效资料时写入主文件（status='draft'）。
   */
  saveDraft(id, data) {
    const sid = String(id ?? '')
    if (!ID_RE.test(sid)) throw new Error('非法人设 id')
    const active = this.get(sid)
    if (active && active.status === 'active') {
      const prev = this.getDraft(sid)
      const draft = normalizeLore(sid, {
        ...data, id: sid, status: 'draft', adoptedAt: null,
        refreshCron: active.refreshCron ?? null,
        createdAt: prev?.createdAt || Date.now(),
        updatedAt: Date.now(),
      })
      assertSafeLore(draft)
      fs.writeFileSync(this._draftFile(sid), JSON.stringify(draft, null, 2))
      return draft
    }
    // 无生效资料：主文件即草稿（save 保留已有 createdAt）
    return this.save(sid, { ...data, status: 'draft', adoptedAt: null })
  }

  /** 采纳：优先采纳待审草稿（draft→active）；否则把主文件草稿转生效。不自动切换人设。 */
  adopt(id) {
    const sid = String(id ?? '')
    const draft = this.getDraft(sid)
    if (draft) {
      const main = this.get(sid)
      const active = this.save(sid, { ...draft, status: 'active', adoptedAt: Date.now(), createdAt: main?.createdAt || draft.createdAt })
      this._removeDraft(sid)
      return active
    }
    const cur = this.get(sid)
    if (!cur) throw new Error(`人设「${sid}」暂无补齐草稿`)
    return this.save(sid, { ...cur, status: 'active', adoptedAt: Date.now() })
  }

  /** 丢弃资料：有独立草稿时只丢草稿（保留生效资料）；否则删主资料并取消其定时刷新 job。 */
  discard(id) {
    const sid = String(id ?? '')
    if (!ID_RE.test(sid)) return false
    if (this.getDraft(sid)) { this._removeDraft(sid); return true }
    if (!this.get(sid)) return false
    const j = this._jobs.get(sid)
    if (j && this.scheduler) { try { this.scheduler.cancelJob(j) } catch { /* noop */ } }
    this._jobs.delete(sid)
    try { fs.unlinkSync(this._file(sid)); return true } catch { return false }
  }

  _removeDraft(id) {
    try { fs.unlinkSync(this._draftFile(id)); return true } catch { return false }
  }

  /** 全部资料（合并主资料与待审草稿：同一 id 有草稿时挂到 `draft` 字段） */
  list() {
    let files = []
    try { files = fs.readdirSync(this.dir) } catch { return [] }
    const ids = new Set()
    for (const f of files) {
      if (f.endsWith('.draft.json')) ids.add(f.slice(0, -'.draft.json'.length))
      else if (f.endsWith('.json')) ids.add(f.slice(0, -'.json'.length))
    }
    const out = []
    for (const id of ids) {
      if (!ID_RE.test(id)) continue
      const main = this.get(id)
      const draft = this.getDraft(id)
      if (main && draft) out.push({ ...main, draft })
      else if (main) out.push(main)
      else if (draft) out.push(draft)
    }
    return out
  }

  // —— 定时刷新（周期重跑补齐，产出新草稿待采纳；复用 KB 同款 scheduler）——

  /** 设定时刷新：更新 refreshCron + 注册 job（先取消旧 job 防重复）。cron=null 即取消。 */
  async setRefresh(id, cron) {
    const sid = String(id ?? '')
    const cur = this.get(sid)
    if (!cur) return { error: `人设「${sid}」暂无补齐资料，无法设定时刷新` }
    const c = cron ? String(cron) : null
    if (c && !looksLikeCron(c)) return { error: `无法识别时间「${cron}」（支持自然语言或 5 段 cron）` }
    await this.cancelRefresh(sid, false) // 取消旧 job（不写盘，下面统一 save）
    const lore = this.save(sid, { ...cur, refreshCron: c })
    if (c) {
      if (!this.scheduler) { this.save(sid, { ...lore, refreshCron: null }); return { error: '定时调度器未就绪，无法设定时刷新' } }
      if (!this._scheduleRefresh(sid, c)) { this.save(sid, { ...lore, refreshCron: null }); return { error: `调度失败（cron 非法？）：${c}` } }
    }
    return { id: sid, cron: lore.refreshCron, status: lore.status }
  }

  /** 取消定时刷新：cancelJob + 清 refreshCron */
  async cancelRefresh(id, persist = true) {
    const sid = String(id ?? '')
    const j = this._jobs.get(sid)
    if (j && this.scheduler) { try { this.scheduler.cancelJob(j) } catch { /* noop */ } }
    this._jobs.delete(sid)
    if (persist) {
      const cur = this.get(sid)
      if (cur && cur.refreshCron) this.save(sid, { ...cur, refreshCron: null })
    }
    return { id: sid }
  }

  _scheduleRefresh(id, cron) {
    if (!this.scheduler || !this._onRefresh) return false
    try {
      const job = this.scheduler.scheduleJob(cron, () => { try { this._onRefresh(id)?.catch?.(() => {}) } catch { /* noop */ } })
      if (job) { this._jobs.set(id, job); return true }
    } catch { /* 非法 cron 静默 */ }
    return false
  }

  /** 重启恢复：遍历带 refreshCron 的资料重排 job（幂等：先取消本实例已排 job 再重排）。
   *  无调度器或未设刷新回调时不注册（避免惰性 job）。 */
  async restoreRefreshJobs(onRefresh) {
    for (const job of this._jobs.values()) { try { this.scheduler?.cancelJob(job) } catch { /* noop */ } }
    this._jobs.clear()
    if (onRefresh) this._onRefresh = onRefresh
    if (!this.scheduler || !this._onRefresh) return { restored: 0 }
    const items = this.list().filter((l) => l.refreshCron)
    let restored = 0
    for (const l of items) {
      if (this._scheduleRefresh(l.id, l.refreshCron)) restored++
    }
    return { restored }
  }

  /** 带定时刷新的资料清单 */
  listRefresh() {
    return this.list().filter((l) => l.refreshCron).map((l) => ({ id: l.id, cron: l.refreshCron, status: l.status }))
  }

  /** 取消全部定时刷新 job（热重载/关闭时调，防旧 job 泄漏） */
  shutdown() {
    for (const job of this._jobs.values()) { try { this.scheduler?.cancelJob(job) } catch { /* noop */ } }
    this._jobs.clear()
  }

  /** 惰性构造 per-persona 知识库（避免与 knowledge.js/crawl 形成启动期强依赖） */
  async _kb(id) {
    if (!this.kv) return null
    const { KnowledgeStore } = await import('../agent/knowledge.js')
    return new KnowledgeStore({ kv: this.kv, embedFn: this.embedFn, key: `kb:persona:${id}`, topK: 3 })
  }

  /** 灌入长尾资料（采纳时把 rawNotes 入库；无 kv 时空操作） */
  async ingest(id, text, { title, source = 'persona-complete' } = {}) {
    const body = String(text || '').trim()
    if (!body) return null
    const kb = await this._kb(id)
    if (!kb) return null
    try { return await kb.ingest(body, { title: title || `人设资料 ${id}`, source }) }
    catch (e) { return { error: e?.message || String(e) } }
  }

  /** 按查询检索长尾资料；失败/无 kv 返回空数组（不阻塞对话） */
  async retrieve(id, query, topK = 3) {
    const q = String(query || '').trim()
    if (!q) return []
    const kb = await this._kb(id)
    if (!kb) return []
    try { return await kb.retrieve(q, topK) } catch { return [] }
  }
}
