/**
 * PersonaStore —— 人设库（内置 + 自定义）。
 *
 * 设计要点（对齐 MemoryStore/SessionStore 的库解耦原则）：
 *  - 内置人设只读（BUILTIN_PERSONAS）；自定义人设落盘为 dir/<id>.json。
 *  - list/get 合并内置与自定义；增删改只作用于自定义。
 *  - id 为 slug（小写、中文保留、空格转 -），全局唯一（与内置冲突时拒绝）。
 *  - 不依赖插件 Config/Log，由 apps 注入 dir。
 */

import fs from 'node:fs'
import path from 'node:path'
import { BUILTIN_PERSONAS } from './defaults.js'
import { assessPersonaPrompt } from '../agent/guard.js'

// 第 7 轮 M4：人设原本无任何条数/长度上限 —— 单用户可无限刷盘，list()/resolve() 每轮全目录解析
// 也会被越拖越慢。这里在 store 层补纵深防御（命令层另有每次创建的配额检查）。
const MAX_CUSTOM_PERSONAS = 500
const MAX_NAME_LEN = 40
const MAX_PROMPT_LEN = 8000
const MAX_TEXT_LEN = 500
const LIST_TTL_MS = 5000 // list() 缓存窗口（写入即失效）

/** 人设内容安全闸：拒绝把用于解除限制 / 抑制拒答 / 绕过审批的指令写进身份层 */
export function assertSafePersonaPrompt(systemPrompt) {
  const { allowed, score, hits } = assessPersonaPrompt(systemPrompt)
  if (allowed) return
  const cats = [...new Set(hits.map((h) => h.cat))].join(',')
  const err = new Error('人设内容包含疑似越狱/提示注入指令（要求忽略安全、禁止拒答或绕过审批等），已拒绝保存；请移除相关指令后重试。')
  err.code = 'persona_injection'
  err.score = score
  err.categories = cats
  throw err
}

/**
 * 写入前的长度闸（第 7 轮 M4）。只作用于 add/update 写路径：
 * 读取路径（_readFile）保持宽容，否则历史遗留的超长文件会被判非法而"从列表里消失"。
 */
export function assertPersonaSize(p) {
  if (String(p.name || '').length > MAX_NAME_LEN) throw new Error(`人设名称过长（${String(p.name).length} > ${MAX_NAME_LEN} 字）`)
  if (String(p.systemPrompt || '').length > MAX_PROMPT_LEN) throw new Error(`人设内容过长（${String(p.systemPrompt).length} > ${MAX_PROMPT_LEN} 字），请精简后重试`)
  if (String(p.description || '').length > MAX_TEXT_LEN) throw new Error(`人设简介过长（> ${MAX_TEXT_LEN} 字）`)
  if (String(p.greeting || '').length > MAX_TEXT_LEN) throw new Error(`人设问候语过长（> ${MAX_TEXT_LEN} 字）`)
  if (String(p.avatar || '').length > MAX_TEXT_LEN) throw new Error(`人设头像地址过长（> ${MAX_TEXT_LEN} 字）`)
}

/** 名称 → slug id */
export function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .slice(0, 40) || `persona_${Date.now().toString(36)}`
}

/** 校验并归一一个人设对象 */
export function normalizePersona(input, { builtin = false, creator } = {}) {
  if (!input || typeof input !== 'object') throw new Error('人设必须是对象')
  const name = String(input.name || '').trim()
  if (!name) throw new Error('人设缺少 name')
  const systemPrompt = String(input.systemPrompt || '').trim()
  if (!systemPrompt) throw new Error('人设缺少 systemPrompt')
  // id 直接参与文件名（dir/<id>.json）：必须经 slug 归一。
  // 曾原样采用 input.id → POST /api/personas 传 "../../x" 可越出 dir 写任意 .json（路径穿越）。
  const id = input.id ? slugify(input.id) : slugify(name)
  return {
    id,
    name,
    description: String(input.description || systemPrompt.slice(0, 30)),
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 8) : [],
    avatar: String(input.avatar || ''),
    greeting: String(input.greeting || ''),
    systemPrompt,
    builtin,
    creator: input.creator || creator || null,
    createdAt: input.createdAt || Date.now(),
  }
}

export class PersonaStore {
  constructor({ dir } = {}) {
    if (!dir) throw new Error('PersonaStore 需要 dir')
    this.dir = dir
    this._listCache = null // { at, items }：短 TTL 缓存，写路径立即失效（第 7 轮 M4）
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* noop */ }
  }

  /** 缓存失效（add/update/remove 落盘后调用） */
  _invalidate() {
    this._listCache = null
  }

  /** 所有内置 id 集合 */
  builtinIds() {
    return new Set(BUILTIN_PERSONAS.map((p) => p.id))
  }

  /** 内置人设（标记 builtin:true，只读） */
  _builtins() {
    return BUILTIN_PERSONAS.map((p) => ({ ...p, builtin: true }))
  }

  /** 读取单个自定义人设文件 */
  _readFile(file) {
    try {
      const raw = fs.readFileSync(file, 'utf8')
      return normalizePersona(JSON.parse(raw), { creator: null })
    } catch { return null }
  }

  _customFiles() {
    try { return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')) } catch { return [] }
  }

  /** 全部人设（内置 + 自定义），可按 tag 过滤 */
  list({ tag } = {}) {
    // 第 7 轮 M4：此前每次调用都 readdir + 逐个 JSON.parse（每轮对话 resolve()/面板轮询都会走），
    // 人设一多就是纯浪费；改为短 TTL 缓存 + 写路径失效。缓存的是合并去重后的全量列表。
    let all = this._listCache && Date.now() - this._listCache.at < LIST_TTL_MS ? this._listCache.items : null
    if (!all) {
      const customs = this._customFiles().map((f) => this._readFile(path.join(this.dir, f))).filter(Boolean)
      const merged = [...this._builtins(), ...customs]
      const seen = new Set()
      const dedup = []
      for (const p of merged) {
        if (seen.has(p.id)) continue
        seen.add(p.id)
        dedup.push(p)
      }
      all = dedup
      this._listCache = { at: Date.now(), items: all }
    }
    // 返回副本：调用方（面板/命令）改字段不至于污染缓存
    const items = all.map((p) => ({ ...p }))
    return tag ? items.filter((p) => p.tags?.includes(tag)) : items
  }

  /** 按 id 或名称（模糊）取人设 */
  get(idOrName) {
    if (!idOrName) return null
    const key = String(idOrName).trim().toLowerCase()
    const all = this.list()
    return (
      all.find((p) => p.id === idOrName || p.id === key) ||
      all.find((p) => p.name === idOrName) ||
      all.find((p) => p.name.toLowerCase().includes(key) || key.includes(p.name.toLowerCase())) ||
      null
    )
  }

  /** id → 落盘路径（纵深防御：任何情况下都不允许越出 this.dir） */
  _fileOf(id) {
    const file = path.resolve(this.dir, `${String(id)}.json`)
    const root = path.resolve(this.dir)
    if (file !== root && !file.startsWith(root + path.sep)) throw new Error(`人设 id 非法：${id}`)
    return file
  }

  /**
   * 精确查找（id 大小写不敏感 / name 完全一致）——**写路径必须用它**。
   * get() 带子串模糊匹配，用于展示/引用很方便，但被 add/update/remove 复用时会命中"另一个人设"：
   * 新人设被误判「已存在」、更新/删除改错对象。
   */
  getExact(idOrName) {
    if (!idOrName) return null
    const key = String(idOrName).trim()
    const lower = key.toLowerCase()
    const all = this.list()
    return all.find((p) => p.id === lower) || all.find((p) => p.name === key) || null
  }

  /** 新增自定义人设；id 与内置/已有冲突则报错 */
  add(input, { creator } = {}) {
    const p = normalizePersona(input, { builtin: false, creator })
    assertSafePersonaPrompt(p.systemPrompt)
    assertPersonaSize(p)
    if (this._customFiles().length >= MAX_CUSTOM_PERSONAS) {
      throw new Error(`自定义人设数量已达上限（${MAX_CUSTOM_PERSONAS} 个），请先 #删除人设 再新建`)
    }
    if (this.builtinIds().has(p.id)) throw new Error(`人设 id「${p.id}」与内置冲突，请换个名称`)
    // 精确判重（id + 名称）：模糊匹配会把"名字包含我"的既有人设误判为重名
    if (this.getExact(p.id)) throw new Error(`人设 id「${p.id}」已存在`)
    if (this.getExact(p.name)) throw new Error(`人设「${p.name}」已存在`)
    fs.writeFileSync(this._fileOf(p.id), JSON.stringify(p, null, 2))
    this._invalidate()
    return p
  }

  /** 更新自定义人设（内置不可改） */
  update(id, patch) {
    const existing = this.getExact(id)
    if (!existing) throw new Error(`人设「${id}」不存在`)
    if (existing.builtin) throw new Error(`内置人设「${existing.name}」不可修改`)
    const merged = normalizePersona({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt }, { builtin: false })
    assertSafePersonaPrompt(merged.systemPrompt)
    assertPersonaSize(merged)
    fs.writeFileSync(this._fileOf(existing.id), JSON.stringify(merged, null, 2))
    this._invalidate()
    return merged
  }

  /** 删除自定义人设（内置不可删） */
  remove(id) {
    // 精确匹配：此前用模糊 get()，删除可能命中另一个人设
    const existing = this.getExact(id)
    if (!existing) return false
    if (existing.builtin) throw new Error(`内置人设「${existing.name}」不可删除`)
    try { fs.unlinkSync(this._fileOf(existing.id)) } catch { /* noop */ }
    this._invalidate()
    return true
  }
}
