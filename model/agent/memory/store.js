/**
 * 声明式记忆 MemoryStore —— 对应 Hermes MEMORY.md / USER.md，参考 OpenClaw「文件即真相」。
 *
 * 设计要点：
 *  - 双 store：memory（Agent 笔记，默认 2200 字符）/ user（用户画像，默认 1375 字符）。
 *  - **按 scopeId 隔离**：每个数据归属(scope)一个独立目录 `memories/<scopeId>/MEMORY.md`+`USER.md`。
 *    apps/agent.js 按「群+用户」(isolation 开)或「群」(关) 计算 scopeId 传入，实现多用户完全隔离。
 *  - **持久化为 Markdown**：人可读、可编辑、可 diff。每条 = 一行 `- ` bullet。
 *  - 旧 memory.json/user.json 自动迁移为 .md（一次性、幂等，按 scope）。
 *  - snapshot 渲染为「LABEL [用量] + bullets」注入 system prompt。
 *  - 不自动合并：写超限 → 抛 MemoryLimitError，由 Agent 自行 replace/remove 后重试。
 *  - 重复预防：完全重复条目 → no-op。
 *  - 库解耦：只接收 dir，不依赖插件 Config；由 apps/ 注入路径与 scopeId。
 */

import fs from 'node:fs'
import path from 'node:path'

const SEP = '\n§\n' // 仅用于字符上限估算（joinedLen），不参与 .md 渲染

const DEFAULT_LIMITS = { memory: 2200, user: 1375 }
const LABELS = {
  memory: 'MEMORY (your personal notes)',
  user: 'USER (what you know about the user)',
}
// 文件名：人可读的规范名
const FILES = { memory: 'MEMORY.md', user: 'USER.md' }
// 无 scopeId 时的兜底（保持向后兼容；正常路径都由 apps 传入 scopeId）
const DEFAULT_SCOPE = '__global__'

export class MemoryLimitError extends Error {
  constructor({ target, used, limit, entries }) {
    super(`记忆 ${target} 超限：used ${used}/${limit} chars`)
    this.name = 'MemoryLimitError'
    this.target = target
    this.used = used
    this.limit = limit
    this.entries = entries
  }
}

/** 记忆写入威胁拦截：内容命中提示词注入特征（声明式记忆会注入 system，必须先拦）。 */
export class MemoryThreatError extends Error {
  constructor({ target, text, score, hits }) {
    const cats = (hits || []).map((h) => h.cat).filter(Boolean).join(',')
    super(`记忆写入被拦截：内容疑似提示词注入${cats ? `（${cats}）` : ''}，score=${score ?? '?'}`)
    this.name = 'MemoryThreatError'
    this.target = target
    this.threat = true
    this.score = score
    this.hits = hits || []
    this.snippet = String(text || '').slice(0, 120)
  }
}

function joinedLen(entries) {
  return entries.join(SEP).length
}

/** 在条目数组上应用单个操作（返回新数组；匹配失败抛错）。重复 add 视为 no-op。 */
function applyOp(arr, op) {
  switch (op.action || op.op) {
    case 'add': {
      const text = op.text
      if (!text) throw new Error('add 需要 text')
      if (arr.includes(text)) return arr // 重复预防
      return [...arr, text]
    }
    case 'replace': {
      const { old_text: oldText, new_text: newText } = op
      if (!oldText) throw new Error('replace 需要 old_text')
      const matches = arr.filter((e) => e.includes(oldText))
      if (matches.length === 0) throw new Error(`未找到包含 "${oldText}" 的条目`)
      if (matches.length > 1) throw new Error(`"${oldText}" 匹配多条，请用更具体的子串`)
      return arr.map((e) => (e.includes(oldText) ? e.replace(oldText, newText ?? '') : e))
    }
    case 'remove': {
      const { old_text: oldText } = op
      if (!oldText) throw new Error('remove 需要 old_text')
      const matches = arr.filter((e) => e.includes(oldText))
      if (matches.length === 0) throw new Error(`未找到包含 "${oldText}" 的条目`)
      if (matches.length > 1) throw new Error(`"${oldText}" 匹配多条，请用更具体的子串`)
      return arr.filter((e) => !e.includes(oldText))
    }
    default:
      throw new Error(`未知 memory action：${op.action || op.op}`)
  }
}

export class MemoryStore {
  constructor({ dir, limits, enabled = { memory: true, user: true }, scan = null } = {}) {
    if (!dir) throw new Error('MemoryStore 需要 dir')
    this.dir = dir
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.enabled = { memory: true, user: true, ...enabled }
    // 写入威胁扫描（可选）：scan(text) → { flagged, score, hits }。声明式记忆注入 system，
    // 命中即拒写，防止把指令注入持久化进每轮 system。库解耦：由 apps 注入 guard.checkInput。
    this.scan = typeof scan === 'function' ? scan : null
    /** @type {Map<string, {state:{memory:string[],user:string[]}}>} 按 scopeId 懒加载缓存 */
    this._scopes = new Map()
  }

  /** scopeId → 目录（scopeId 由 apps 保证 fs-safe：u_xxx / g{gid}_u{uid} / g{gid}） */
  _scopeDir(scopeId) {
    return path.join(this.dir, String(scopeId || DEFAULT_SCOPE))
  }

  /** .md 文件路径（规范名） */
  _file(target, scopeId) {
    return path.join(this._scopeDir(scopeId), FILES[target] || `${target}.md`)
  }

  /** 旧 .json 文件路径（迁移用） */
  _legacyFile(target, scopeId) {
    return path.join(this._scopeDir(scopeId), `${target}.json`)
  }

  /**
   * 解析 .md 文本 → 条目数组。
   * 规则：`- ` / `* ` 开头的行是条目（去掉前缀）；缩进续行（非空、非 bullet、非注释）追加到上一条；
   * `#`/`<!--`/`-->`/LABEL 用量头/空行 忽略。
   */
  _parseMd(text) {
    const entries = []
    let cur = null
    for (const raw of String(text || '').split('\n')) {
      const line = raw.replace(/\s+$/, '') // 去行尾空白
      if (!line.trim()) continue
      // bullet 行（- 或 * 开头）
      const bm = line.match(/^\s*[-*]\s+(.*)$/)
      if (bm) {
        cur = bm[1]
        entries.push(cur)
        continue
      }
      // 注释 / 标题 / LABEL 用量头 → 忽略
      if (/^\s*(#|<!--|-->)/.test(line)) continue
      if (/^\s*MEMORY\b|^\s*USER\b/.test(line) && /\[\d+%/.test(line)) continue
      // 缩进续行 → 追加到上一条（多行条目）
      if (cur !== null && /^\s+\S/.test(line)) {
        entries[entries.length - 1] = cur + '\n' + line.trim()
        cur = entries[entries.length - 1]
        continue
      }
      // 其余独立行忽略（人手写的非 bullet 内容）
    }
    return entries.filter((e) => typeof e === 'string')
  }

  /** 条目数组 → .md 文本（含 LABEL 用量头 + bullets，人可读） */
  _renderMd(target, entries) {
    const label = LABELS[target] || target
    const limit = this.limits[target]
    const used = joinedLen(entries)
    const pct = limit > 0 ? Math.round((used / limit) * 100) : 0
    const head = `${label} [${pct}% — ${used}/${limit} chars]`
    if (!entries.length) return `${head}\n<!-- 空记忆；新增条目请写成一行 "- 你的记忆内容"（每行一条）。字符上限 ${limit}。 -->`
    const bullets = entries.map((e) => `- ${String(e).replace(/\n/g, '\n  ')}`).join('\n') // 多行条目续行缩进 2 空格
    return `${head}\n${bullets}\n`
  }

  /**
   * 取（必要时加载）某 scope 的内存状态。每个 scope 独立目录，互不串档。
   * 首次访问该 scope 时从磁盘读取（缺失则迁移旧 .json → .md，再缺失则空）。
   */
  _getScope(scopeId) {
    const id = String(scopeId || DEFAULT_SCOPE)
    let sc = this._scopes.get(id)
    if (sc) return sc
    const state = { memory: [], user: [] }
    try { fs.mkdirSync(this._scopeDir(id), { recursive: true }) } catch { /* noop */ }
    for (const target of ['memory', 'user']) {
      if (!this.enabled[target]) continue
      const mdFile = this._file(target, id)
      try {
        if (fs.existsSync(mdFile)) {
          state[target] = this._parseMd(fs.readFileSync(mdFile, 'utf8'))
          continue
        }
      } catch { /* 解析失败保持空 */ }
      // 迁移旧 .json（本 scope 目录内）
      const jsonFile = this._legacyFile(target, id)
      try {
        if (fs.existsSync(jsonFile)) {
          const arr = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
          if (Array.isArray(arr)) {
            state[target] = arr.filter((e) => typeof e === 'string')
            this._save(target, id, state[target])
            try { fs.unlinkSync(jsonFile) } catch { /* noop */ }
          }
        }
      } catch { /* noop */ }
    }
    sc = { state }
    this._scopes.set(id, sc)
    return sc
  }

  /** 原子写盘：tmp + rename */
  _save(target, scopeId, entries) {
    try {
      fs.mkdirSync(this._scopeDir(scopeId), { recursive: true })
    } catch {
      /* noop */
    }
    const file = this._file(target, scopeId)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, this._renderMd(target, entries))
    fs.renameSync(tmp, file)
  }

  /** 刷盘所有已加载 scope */
  flush() {
    for (const [id, sc] of this._scopes) {
      for (const target of ['memory', 'user']) if (this.enabled[target]) this._save(target, id, sc.state[target])
    }
  }

  /** 清缓存重新读盘（下次访问各 scope 时按需重载） */
  reload() {
    this._scopes.clear()
    return this
  }

  getEntries(target, scopeId) {
    return [...(this._getScope(scopeId).state[target] || [])]
  }

  used(target, scopeId) {
    return joinedLen(this._getScope(scopeId).state[target] || [])
  }

  ratio(target, scopeId) {
    return this.used(target, scopeId) / this.limits[target]
  }

  _ensure(target) {
    if (!(target === 'memory' || target === 'user')) throw new Error(`未知 memory target：${target}（应为 memory 或 user）`)
    if (!this.enabled[target]) throw new Error(`记忆 ${target} 已禁用`)
  }

  /** 提交前做威胁扫描 + 超限检查；命中注入抛 MemoryThreatError，超限抛 MemoryLimitError（均不改状态） */
  _commit(target, scopeId, newArr) {
    const sc = this._getScope(scopeId)
    // 威胁扫描：只扫本轮新增/变更的条目。已存在的条目不再重复扫，避免历史脏数据把后续写入全部锁死
    // （历史文件被直接编辑/迁移带进来的注入由注入侧 _screenUntrusted 兜底标注）。
    if (this.scan) {
      const oldSet = new Set(sc.state[target] || [])
      for (const entry of newArr) {
        if (oldSet.has(entry)) continue
        let r = null
        try { r = this.scan(String(entry)) } catch { r = null }
        if (r?.flagged) throw new MemoryThreatError({ target, text: entry, score: r.score, hits: r.hits })
      }
    }
    const used = joinedLen(newArr)
    const limit = this.limits[target]
    if (used > limit) {
      throw new MemoryLimitError({ target, used, limit, entries: newArr })
    }
    sc.state[target] = newArr
    this._save(target, scopeId, newArr)
    return { ok: true, target, used, limit, count: newArr.length }
  }

  add(target, text, scopeId) {
    this._ensure(target)
    const arr = this._getScope(scopeId).state[target]
    if (arr.includes(text)) return { ok: true, duplicate: true, message: 'no duplicate added', target }
    return this._commit(target, scopeId, applyOp(arr, { action: 'add', text }))
  }

  replace(target, oldText, newText, scopeId) {
    this._ensure(target)
    return this._commit(target, scopeId, applyOp(this._getScope(scopeId).state[target], { action: 'replace', old_text: oldText, new_text: newText }))
  }

  remove(target, oldText, scopeId) {
    this._ensure(target)
    return this._commit(target, scopeId, applyOp(this._getScope(scopeId).state[target], { action: 'remove', old_text: oldText }))
  }

  /** 全量替换条目（Web 面板用）：超限抛 MemoryLimitError（_commit 内检查） */
  setAll(target, entries, scopeId) {
    this._ensure(target)
    if (!Array.isArray(entries)) throw new Error('entries 必须是字符串数组')
    const arr = entries.map((e) => String(e))
    return this._commit(target, scopeId, arr)
  }

  /** 原子批量：在一份数组上顺序应用全部 op，全部成功且不超限才提交（否则不改动） */
  batch(target, operations, scopeId) {
    this._ensure(target)
    if (!Array.isArray(operations)) throw new Error('batch 需要 operations 数组')
    let arr = [...this._getScope(scopeId).state[target]]
    const summary = []
    for (const op of operations) {
      const before = arr.length
      arr = applyOp(arr, op)
      summary.push({ op: op.action || op.op, delta: arr.length - before })
    }
    return { ...this._commit(target, scopeId, arr), operations: summary }
  }

  /** 渲染注入 system prompt 的快照（LABEL 用量头 + bullets，模型可读） */
  snapshot(target, scopeId) {
    if (!this.enabled[target]) return ''
    return this._renderMd(target, this._getScope(scopeId).state[target] || []).trim()
  }

  snapshotAll(scopeId) {
    return ['memory', 'user'].map((t) => this.snapshot(t, scopeId)).filter(Boolean).join('\n\n')
  }

  /** 清空某 scope 的全部声明式记忆（#清空所有记录 用；同步内存缓存与磁盘文件） */
  clear(scopeId) {
    const id = String(scopeId || DEFAULT_SCOPE)
    const sc = this._scopes.get(id)
    if (sc) sc.state = { memory: [], user: [] }
    for (const target of ['memory', 'user']) {
      if (!this.enabled[target]) continue
      try { fs.unlinkSync(this._file(target, id)) } catch { /* 文件不存在忽略 */ }
    }
    return { ok: true, scope: id }
  }
}
