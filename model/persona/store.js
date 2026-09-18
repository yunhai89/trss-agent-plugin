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
  const id = input.id ? String(input.id) : slugify(name)
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
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* noop */ }
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
    const customs = this._customFiles().map((f) => this._readFile(path.join(this.dir, f))).filter(Boolean)
    const all = [...this._builtins(), ...customs]
    const seen = new Set()
    const dedup = []
    for (const p of all) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      dedup.push(p)
    }
    return tag ? dedup.filter((p) => p.tags?.includes(tag)) : dedup
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

  /** 新增自定义人设；id 与内置/已有冲突则报错 */
  add(input, { creator } = {}) {
    const p = normalizePersona(input, { builtin: false, creator })
    assertSafePersonaPrompt(p.systemPrompt)
    if (this.builtinIds().has(p.id)) throw new Error(`人设 id「${p.id}」与内置冲突，请换个名称`)
    if (this.get(p.id)) throw new Error(`人设「${p.name}」已存在`)
    const file = path.join(this.dir, `${p.id}.json`)
    fs.writeFileSync(file, JSON.stringify(p, null, 2))
    return p
  }

  /** 更新自定义人设（内置不可改） */
  update(id, patch) {
    const existing = this.get(id)
    if (!existing) throw new Error(`人设「${id}」不存在`)
    if (existing.builtin) throw new Error(`内置人设「${existing.name}」不可修改`)
    const merged = normalizePersona({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt }, { builtin: false })
    assertSafePersonaPrompt(merged.systemPrompt)
    fs.writeFileSync(path.join(this.dir, `${existing.id}.json`), JSON.stringify(merged, null, 2))
    return merged
  }

  /** 删除自定义人设（内置不可删） */
  remove(id) {
    const existing = this.get(id)
    if (!existing) return false
    if (existing.builtin) throw new Error(`内置人设「${existing.name}」不可删除`)
    try { fs.unlinkSync(path.join(this.dir, `${existing.id}.json`)) } catch { /* noop */ }
    return true
  }
}
