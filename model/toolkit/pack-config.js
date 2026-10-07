/**
 * 外置工具包配置约定（固定模板）。
 *
 * 工具作者在工具目录内放一个 `tool.config.js`（固定模板，default export）：
 *
 *   export default {
 *     info: { title, description, author, version, homepage },
 *     config: [
 *       { key, type, label, description, default, secret?, placeholder?,
 *         options? (enum), min/max/step? (number) },
 *     ],
 *   }
 *
 * type ∈ string | text | number | boolean | enum | json
 *
 * 运行时：
 *  - 用户值统一存集中配置 `agent.tools.<包名>`（复用 Config 热加载 / /api/config 读写）；
 *  - 默认值来自 schema，用户值覆盖默认值 → getToolConfig(name) 返回合并结果；
 *  - loader 加载工具包时登记 schema，工具代码可 `getToolConfig(包名)` 同步读取。
 *
 * 保留键：`agent.tools.builtin` / `agent.tools.dir` 为内置字段，工具包名不得与之冲突。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Config, { deepMerge } from '../../utils/Config.js'

const SCHEMA_FILE = 'tool.config.js'
const FIELD_TYPES = new Set(['string', 'text', 'number', 'boolean', 'enum', 'json'])
const KEY_RE = /^[A-Za-z0-9_]+$/

/** 与内置字段同命名空间保留，工具包名不得占用 */
export const RESERVED_TOOL_KEYS = new Set(['builtin', 'dir'])

/** 运行期 schema 登记表：包名 → { name, dir, info, config } */
const _registry = new Map()

/** 归一化单个字段；非法返回 null */
function normalizeField(raw, fallbackKey) {
  if (!raw || typeof raw !== 'object') return null
  const key = String(raw.key || fallbackKey || '').trim()
  if (!KEY_RE.test(key)) return null
  const type = FIELD_TYPES.has(raw.type) ? raw.type : 'string'
  const field = {
    key,
    type,
    label: String(raw.label || key),
    description: String(raw.description || ''),
  }
  if (raw.default !== undefined) field.default = raw.default
  if (raw.secret) field.secret = true
  if (raw.placeholder) field.placeholder = String(raw.placeholder)
  if (type === 'enum') {
    const opts = Array.isArray(raw.options) ? raw.options : []
    field.options = opts
      .map((o) => (o && typeof o === 'object'
        ? { value: String(o.value), label: String(o.label ?? o.value) }
        : { value: String(o), label: String(o) }))
      .filter((o) => o.value !== '')
    if (!field.options.length) return null
  }
  if (type === 'number') {
    for (const k of ['min', 'max', 'step']) {
      if (Number.isFinite(Number(raw[k]))) field[k] = Number(raw[k])
    }
  }
  return field
}

/** 归一化 config 字段表（支持数组或 {key: def} 映射） */
export function normalizeSchema(rawConfig) {
  const fields = []
  if (Array.isArray(rawConfig)) {
    for (const item of rawConfig) {
      const f = normalizeField(item)
      if (f) fields.push(f)
    }
  } else if (rawConfig && typeof rawConfig === 'object') {
    for (const [k, v] of Object.entries(rawConfig)) {
      const f = normalizeField({ ...(v && typeof v === 'object' ? v : {}), key: k }, k)
      if (f) fields.push(f)
    }
  }
  return fields
}

/** 归一化 info */
export function normalizeInfo(raw, fallbackName) {
  const i = raw && typeof raw === 'object' ? raw : {}
  return {
    title: String(i.title || fallbackName || ''),
    description: String(i.description || ''),
    author: String(i.author || ''),
    version: String(i.version || '1.0.0'),
    homepage: String(i.homepage || ''),
    icon: String(i.icon || ''),
  }
}

/** 从工具目录读取 tool.config.js；无文件返回 null，解析失败抛错 */
export async function loadPackConfigDir(dir, name) {
  const file = path.join(dir, SCHEMA_FILE)
  if (!fs.existsSync(file)) return null
  const mod = await import(pathToFileURL(file).href)
  const exp = mod?.default ?? mod
  return {
    name,
    dir,
    info: normalizeInfo(exp?.info, name),
    config: normalizeSchema(exp?.config),
  }
}

/** 登记 schema（loader 加载工具包时调用） */
export function registerPackConfig(schema) {
  if (schema?.name) _registry.set(schema.name, schema)
}

/** 取用户值（agent.tools.<包名>），非对象视为空 */
export function getUserValues(name) {
  const tools = Config.get()?.agent?.tools
  const v = tools && typeof tools === 'object' && !RESERVED_TOOL_KEYS.has(name) ? tools[name] : undefined
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {}
}

/** schema 默认值 */
export function getSchemaDefaults(schema) {
  const out = {}
  for (const f of schema?.config || []) if (f.default !== undefined) out[f.key] = f.default
  return out
}

/**
 * 运行时读取工具配置 = 默认值 ⊕ 用户值。
 * 需先经 loader 登记 schema；未登记时退化为仅用户值。
 */
export function getToolConfig(name) {
  const schema = _registry.get(name)
  return deepMerge(getSchemaDefaults(schema), getUserValues(name))
}

/** 写入用户值到集中配置（合并已有键） */
export function saveToolConfig(name, values) {
  if (!name || RESERVED_TOOL_KEYS.has(name)) throw new Error(`非法工具包名：${name}`)
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('values 必须是对象')
  const cfg = Config.get()
  if (!cfg.agent) cfg.agent = {}
  if (!cfg.agent.tools || typeof cfg.agent.tools !== 'object') cfg.agent.tools = {}
  cfg.agent.tools[name] = deepMerge(getUserValues(name), values)
  Config.save(cfg)
  Config.reload(true)
  return cfg.agent.tools[name]
}

/**
 * 扫描 tools 目录，返回所有声明了 tool.config.js 的工具包：
 * [{ name, info, config, values }]（不含内部 dir 字段）。
 */
export async function discoverToolPacks(toolsDir) {
  const dir = toolsDir || path.join(Config.path.plugin, 'tools')
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir).sort()) {
    if (RESERVED_TOOL_KEYS.has(name) || name.startsWith('.')) continue
    const full = path.join(dir, name)
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (!st.isDirectory()) continue
    try {
      const schema = await loadPackConfigDir(full, name)
      if (!schema) continue
      registerPackConfig(schema)
      out.push({ name: schema.name, info: schema.info, config: schema.config, values: getUserValues(schema.name) })
    } catch { /* 单个工具包 schema 解析失败不影响其余 */ }
  }
  return out
}

/** 已登记 schema 快照（测试/诊断用） */
export function listRegisteredPacks() {
  return [..._registry.values()].map((s) => ({ name: s.name, info: s.info, config: s.config }))
}

export { SCHEMA_FILE }
