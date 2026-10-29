/**
 * 配置管理。
 *
 * 用户配置存放在**插件自己的 config 目录**：`<plugin>/config/config.yaml`（不在 Yunzai 根）。
 * 首次加载时若插件内无配置但 Yunzai 根存在旧 `config/agents-plugin.yaml`，自动迁移并删除旧文件。
 * 默认配置位于 `config/default_config/`（默认值来源，非用户配置）。
 *
 * 热加载：fs.watch 监听配置目录，文件变更 → 防抖 → reload()；内容变化时通知订阅者
 * （apps 注册后让运行时单例失效，下次对话用新配置重建，无需重启框架）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'yaml'

import Log from './Log.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.join(__dirname, '..')
const YUNZAI_ROOT = path.join(PLUGIN_DIR, '..', '..')
const PLUGIN_NAME = 'agents-plugin'

const pkgPath = path.join(PLUGIN_DIR, 'package.json')
const defaultDir = path.join(PLUGIN_DIR, 'config', 'default_config')
const userConfigDir = path.join(PLUGIN_DIR, 'config')
const userConfigPath = path.join(userConfigDir, 'config.yaml')
const legacyUserConfigPath = path.join(YUNZAI_ROOT, 'config', `${PLUGIN_NAME}.yaml`)

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

let _data = {}
const _subscribers = new Set()
let _defaults = null // 默认值缓存（load/reload 时刷新；用于差异写入与快照压缩）

/** 默认配置（缓存；load/reload 会刷新） */
function getDefaults() {
  if (!_defaults) _defaults = readYamlDir(defaultDir)
  return _defaults
}

/** 读取一个目录下的所有 .yaml 文件并合并 */
export function readYamlDir(dir) {
  let result = {}
  if (!fs.existsSync(dir)) return result
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.yaml')) continue
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    result = { ...result, ...(yaml.parse(text) || {}) }
  }
  return result
}

function isPlainObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
}

/** 深拷贝（structuredClone 优先；null/不可克隆值回退 JSON）。 */
function cloneDeep(v) {
  try { return structuredClone(v) } catch { return JSON.parse(JSON.stringify(v)) }
}

/** 深度相等（对象/数组/标量；用于「与默认值相同」的键压缩与差异写入）。 */
function deepEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isPlainObj(a) && isPlainObj(b)) {
    const ka = Object.keys(a); const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every((k) => k in b && deepEqual(a[k], b[k]))
  }
  return false
}

/**
 * 计算「相对默认值的差异」：与默认值 deep-equal 的键不写盘。
 * 这是 2026-10-29 配置审计 F16 的核心修复——此前 save() 把「默认值 + 用户值」整份落盘，
 * 用户文件变成默认值快照，之后版本改默认值对老用户永不生效。
 */
export function diffFromDefaults(data, defaults) {
  if (!isPlainObj(data) || !isPlainObj(defaults)) return data
  const out = {}
  for (const [k, v] of Object.entries(data)) {
    if (!(k in defaults)) { out[k] = v; continue }
    const d = defaults[k]
    if (isPlainObj(v) && isPlainObj(d)) {
      const child = diffFromDefaults(v, d)
      if (Object.keys(child).length) out[k] = child
    } else if (!deepEqual(v, d)) {
      out[k] = v
    }
  }
  return out
}

/**
 * 深度合并：over 逐键覆盖 base；同为普通对象时递归合并（数组整体替换）。
 * 这样插件升级新增的默认配置项，即便用户旧配置里没有，也能自动补全。
 */
export function deepMerge(base, over) {
  if (!isPlainObj(base) || !isPlainObj(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const k of Object.keys(over)) {
    out[k] = isPlainObj(base[k]) && isPlainObj(over[k]) ? deepMerge(base[k], over[k]) : over[k]
  }
  return out
}

/** 读取用户配置（yaml 解析；文件缺失返回 {}） */
function readUser() {
  if (!fs.existsSync(userConfigPath)) return {}
  try {
    return yaml.parse(fs.readFileSync(userConfigPath, 'utf8')) || {}
  } catch (e) {
    Log.warn('用户配置解析失败，回退默认', e?.message || e)
    return {}
  }
}

/** 原样写入用户配置（原子：tmp+rename）。仅用于首次生成/迁移等需要完整内容的场景。 */
function writeUserRaw(data) {
  try { fs.mkdirSync(userConfigDir, { recursive: true }) } catch { /* noop */ }
  const tmp = `${userConfigPath}.tmp`
  fs.writeFileSync(tmp, yaml.stringify(data))
  fs.renameSync(tmp, userConfigPath)
}

/**
 * 写入用户配置：只写「相对默认值的差异」（F16）。
 * 与默认值相同的键不落盘，升级后新默认值才能对老用户生效。
 */
function writeUser(data) {
  writeUserRaw(diffFromDefaults(data, getDefaults()))
}

/** 迁移旧 Yunzai 根配置 → 插件内（幂等：插件内已有则不动） */
export function migrateLegacy() {
  if (fs.existsSync(userConfigPath) || !fs.existsSync(legacyUserConfigPath)) return false
  try {
    const old = fs.readFileSync(legacyUserConfigPath, 'utf8')
    const parsed = yaml.parse(old) || {}
    writeUserRaw(parsed)
    try { fs.unlinkSync(legacyUserConfigPath) } catch { /* noop */ }
    Log.mark('[config] 已把旧配置从 Yunzai 根迁移到插件目录并删除旧文件')
    return true
  } catch (e) {
    Log.warn('[config] 旧配置迁移失败，沿用默认', e?.message || e)
    return false
  }
}

/** 基础模型引用制：providerId/modelId → 扁平字段的镜像字段名（只读，随引用自动回填） */
const BASE_MODEL_MIRROR = ['protocol', 'preset', 'baseURL', 'apiKey', 'model']

/**
 * 解析基础模型：把「厂商配置 + 模型列表」的引用条目解析成运行时接入参数。
 * 单一真源是 agent.providerId / agent.modelId；返回 null 表示引用未完整生效（此时不要动镜像字段）。
 */
function resolveBaseModel(agent) {
  if (!isPlainObj(agent) || !agent.providerId) return null
  const prov = (Array.isArray(agent.llmProviders) ? agent.llmProviders : []).find((p) => p && p.id === agent.providerId)
  const mod = (Array.isArray(agent.llmModels) ? agent.llmModels : []).find((m) => m && m.id === agent.modelId)
  if (!prov || !mod || mod.providerId !== prov.id) return null
  return {
    protocol: String(prov.protocol || 'openai'),
    preset: String(prov.preset || ''),
    baseURL: String(prov.baseURL || ''),
    apiKey: String(prov.apiKey || ''),
    model: String(mod.model || ''),
  }
}

/** 条目 id 生成（与 web 面板同前缀语义：p/m + 时间戳随机） */
function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/**
 * 一次性迁移：旧配置只有扁平的主接入字段（protocol/preset/baseURL/apiKey/model），
 * 没有厂商/模型条目。把它们登记成「厂商配置」+「模型列表」各一条，并让引用指向它们，
 * 使老用户升级后无需重配。已有 providerId 或从未配过 Key 时不触发。
 */
function migrateBaseModel(agent) {
  if (!isPlainObj(agent) || agent.providerId || !agent.apiKey) return false
  const providers = Array.isArray(agent.llmProviders) ? agent.llmProviders : []
  const models = Array.isArray(agent.llmModels) ? agent.llmModels : []
  // 注册表已存在时不再从扁平字段自动迁移：否则用户主动清空 providerId（面板「取消选择」）
  // 会被下一次 save/load 立即重建，表现为「清空无效、只能用旧模型」（2026-10-29 配置互搏审计 F2）。
  // 旧配置（注册表为空）仍按原逻辑迁移一次，保证老用户升级无感。
  if (providers.length) return false
  const same = (a, b) => String(a || '').trim().replace(/\/+$/, '').toLowerCase() === String(b || '').trim().replace(/\/+$/, '').toLowerCase()
  let prov = providers.find((p) => p && same(p.baseURL, agent.baseURL) && String(p.protocol || 'openai') === String(agent.protocol || 'openai'))
  if (!prov) {
    prov = {
      id: genId('p'), name: agent.preset || '主接入',
      protocol: String(agent.protocol || 'openai'), preset: String(agent.preset || ''),
      baseURL: String(agent.baseURL || ''), apiKey: String(agent.apiKey || ''),
    }
    providers.push(prov)
    agent.llmProviders = providers
  }
  let mod = models.find((m) => m && m.providerId === prov.id && String(m.model) === String(agent.model || ''))
  if (!mod) {
    // 不写 temperature: null / maxTokens: null —— 运行时 Number(null) === 0 会把 null 当成显式 0，
    // 导致模型级温度被钉成 0、覆盖全局 agent.temperature（2026-10-29 配置互搏审计 P0/F1）。缺失键即「继承全局」。
    mod = { id: genId('m'), name: '', providerId: prov.id, model: String(agent.model || ''), thinking: 'inherit', note: '' }
    models.push(mod)
    agent.llmModels = models
  }
  agent.providerId = prov.id
  agent.modelId = mod.id
  Log.mark(`[config] 已把旧的主接入配置迁移为厂商「${prov.name}」+ 模型条目（agent.providerId/modelId）`)
  return true
}

/** 把引用解析结果回填到扁平镜像字段；返回是否发生了变化 */
function syncBaseModel(agent) {
  const resolved = resolveBaseModel(agent)
  if (!resolved) {
    // 引用未生效且 providerId/modelId 为空、但注册表已存在 → 视为「用户主动取消/未选择基础模型」：
    // 清空镜像字段，让运行时明确报「未选定可用模型」，而不是静默沿用上一次解析出的旧端点
    // （面板「清空=停用主模型」，旧版仅打 WARN 造成面板与运行时静默分叉；2026-10-29 配置互搏审计 F2）。
    const providers = Array.isArray(agent.llmProviders) ? agent.llmProviders : []
    const explicitlyCleared = !agent.providerId || !agent.modelId
    if (explicitlyCleared && providers.length) {
      let changed = false
      for (const k of BASE_MODEL_MIRROR) {
        const blank = k === 'protocol' ? 'openai' : ''
        if ((agent[k] ?? '') !== blank) { agent[k] = blank; changed = true }
      }
      return changed
    }
    return false
  }
  let changed = false
  for (const k of BASE_MODEL_MIRROR) {
    if (agent[k] !== resolved[k]) { agent[k] = resolved[k]; changed = true }
  }
  return changed
}

/** 旧 web 面板允许模型挂在内建的「主厂商」哨兵 providerId='main' 上；哨兵已删除，改指向真实厂商条目 */
function repointLegacyMainModels(agent) {
  if (!agent.providerId) return false
  const models = Array.isArray(agent.llmModels) ? agent.llmModels : []
  let dirty = false
  for (const m of models) {
    if (m && m.providerId === 'main') { m.providerId = agent.providerId; dirty = true }
  }
  return dirty
}

let _danglingWarned = '' // 引用失效告警去重（配置每次 reload 都会归一，按 引用组合 只报一次）

/**
 * 引用失效告警：providerId/modelId 指向的条目不在注册表里（厂商或模型被删、id 手填错）。
 * 此时故意不清空镜像字段（保留最后一次可用的接入信息，避免整插件失效），但必须留痕——
 * 否则面板显示「未选择」而运行时仍在用旧端点，属于静默分叉。
 */
function warnDanglingBaseRef(agent) {
  // providerId/modelId 为空 = 用户主动清空（syncBaseModel 已清镜像，运行时会明确报未选定），不属「引用失效」
  if (!agent.providerId || !agent.modelId) { _danglingWarned = ''; return }
  if (resolveBaseModel(agent)) { _danglingWarned = ''; return }
  const key = `${agent.providerId}/${agent.modelId || ''}`
  if (_danglingWarned === key) return
  _danglingWarned = key
  Log.warn(`[config] 基础模型引用失效（agent.providerId=${agent.providerId} / agent.modelId=${agent.modelId || '空'}）：对应的厂商或模型条目不在配置中心里，运行时仍在用上一次解析出的接入信息。请重新选择厂商与模型。`)
}

/**
 * 一次性迁移：扁平回退字段（fallbackModel/fallbackBaseURL/fallbackApiKey/fallbackProtocol）
 * → `fallbackModels[]` 单真源（F7）。迁移后删除扁平键，运行时只读数组；面板只编辑数组。
 */
function migrateFallbackModels(agent) {
  if (!isPlainObj(agent)) return false
  const FLAT = ['fallbackModel', 'fallbackBaseURL', 'fallbackApiKey', 'fallbackProtocol']
  const hasFlat = FLAT.some((k) => k in agent)
  if (!hasFlat) return false
  const model = String(agent.fallbackModel || '').trim()
  const apiKey = String(agent.fallbackApiKey || '').trim()
  const list = Array.isArray(agent.fallbackModels) ? agent.fallbackModels : []
  let changed = false
  if (model && apiKey) {
    const entry = {
      model,
      baseURL: String(agent.fallbackBaseURL || '').trim(),
      apiKey,
      protocol: String(agent.fallbackProtocol || 'openai').trim() || 'openai',
    }
    const exists = list.some((x) => x && String(x.model) === entry.model && String(x.apiKey) === entry.apiKey
      && String(x.baseURL || '') === entry.baseURL && String(x.protocol || 'openai') === entry.protocol)
    if (!exists) {
      list.push(entry)
      agent.fallbackModels = list
      changed = true
      Log.mark('[config] 已把扁平回退模型迁移到 agent.fallbackModels[]（旧扁平字段已废弃）')
    }
  } else if (model && !apiKey) {
    Log.warn('[config] fallbackModel 已填但 fallbackApiKey 为空，扁平回退字段已废弃并清除；请改用 agent.fallbackModels[]')
  }
  for (const k of FLAT) { if (k in agent) { delete agent[k]; changed = true } }
  if (!Array.isArray(agent.fallbackModels)) { agent.fallbackModels = []; changed = true }
  return changed
}

/**
 * 深合并后的统一归一步（F17）：迁移旧结构 → fallback 单真源 → 修哨兵 → 类型归一 → 回填镜像。
 * 所有写入口（load/reload/save/面板）共用，避免各面板各写一套私有归一。
 * @returns {boolean} 是否发生需要落盘的变化
 */
export function normalizeConfig(root) {
  const agent = root?.agent
  if (!isPlainObj(agent)) return false
  let dirty = migrateBaseModel(agent)
  if (migrateFallbackModels(agent)) dirty = true
  if (repointLegacyMainModels(agent)) dirty = true
  // 类型归一：cacheControl 旧布尔 → 三态字符串（off/auto/explicit）；thinking 布尔 → provider-native 形状
  if (typeof agent.cacheControl === 'boolean') { agent.cacheControl = agent.cacheControl ? 'explicit' : 'off'; dirty = true }
  if (agent.thinking === true) { agent.thinking = { type: 'enabled' }; dirty = true }
  else if (agent.thinking === false) { agent.thinking = null; dirty = true }
  if (syncBaseModel(agent)) dirty = true
  warnDanglingBaseRef(agent)
  return dirty
}

/**
 * 启动时一次性压缩用户配置：把与当前默认值 deep-equal 的键删掉（写 config.yaml.bak 备份）。
 * 用于修复历史版本留下的「默认值全量快照」——否则升级后的新默认值永远被快照旧值覆盖。
 */
function compactUserConfig(def) {
  let user
  try { user = readUser() } catch { return }
  if (!isPlainObj(user) || !Object.keys(user).length) return
  const compact = diffFromDefaults(user, def)
  if (deepEqual(compact, user)) return
  try {
    fs.copyFileSync(userConfigPath, `${userConfigPath}.bak`)
    writeUserRaw(compact)
    Log.mark('[config] 已把 config.yaml 压缩为「与默认值的差异」（旧文件备份为 config.yaml.bak）；升级后的新默认值将自动生效')
  } catch (e) {
    Log.warn('[config] 压缩 config.yaml 失败（保留原文件）', e?.message || e)
  }
}

function load() {
  const def = readYamlDir(defaultDir)
  // 关键：默认值必须与 _data 完全隔离。deepMerge 是浅拷贝（只 clone 顶层对象），若直接对 `def` 合并，
  // `_data.agent` 会与 `_defaults.agent` 共享引用——运行时/归一 mutate 配置会污染默认值，
  // 导致「差异写入」永远算出空 diff（F16 修复的隐形坑）。
  _defaults = cloneDeep(def)
  // 迁移旧配置（若插件内尚无配置且 Yunzai 根有旧文件）
  migrateLegacy()
  const createdNow = !fs.existsSync(userConfigPath) && Object.keys(def).length
  if (createdNow) {
    // 首次运行：生成一份完整默认配置，方便用户直接编辑；后续启动会自动压缩为差异（见下）。
    try { writeUserRaw(def) } catch (err) { Log.warn('写入默认配置失败', err) }
  } else {
    // 老用户：一次性删掉「与当前默认值相同」的快照键（F16）；备份 .bak，幂等
    compactUserConfig(def)
  }
  _data = deepMerge(cloneDeep(def), readUser())
  persistBaseModel()
}

/** 归一并落盘（仅当归一产生了变化）：迁移/fallback/类型/镜像有变化才写，幂等，避免 fs.watch 抖动 */
function persistBaseModel() {
  if (!normalizeConfig(_data)) return
  try { writeUser(_data) } catch (e) { Log.warn('[config] 配置归一落盘失败', e?.message || e) }
}

/** 重新读取并合并；内容变化（或 force=true）才通知订阅者（去重，避免自发保存引发无谓重建） */
function reload(force = false) {
  migrateLegacy() // 自愈：若 config.yaml 缺失但 legacy 在，先拾取
  const def = readYamlDir(defaultDir)
  _defaults = cloneDeep(def)
  const prev = JSON.stringify(_data)
  // 热加载只合并（缺失键由 deepMerge 补全，不写盘）；写盘只发生在 save/归一有变化时。
  _data = deepMerge(cloneDeep(def), readUser())
  persistBaseModel() // 统一归一（幂等；有变化才落盘差异）
  const changed = JSON.stringify(_data) !== prev
  if (changed || force) {
    Log.mark('[config] 配置已热加载')
    for (const cb of _subscribers) { try { cb() } catch (e) { Log.warn('[config] 订阅回调出错', e?.message || e) } }
  }
  return changed || force
}

/** 注册配置变更订阅；返回取消订阅函数 */
function onChange(cb) {
  if (typeof cb !== 'function') return () => {}
  _subscribers.add(cb)
  return () => _subscribers.delete(cb)
}

/** 监听配置目录：config.yaml 变更 → 400ms 防抖 → reload。失败降级（仅手动 reload） */
let _watchTimer = null
function startWatch() {
  try {
    fs.mkdirSync(userConfigDir, { recursive: true })
  } catch { /* noop */ }
  try {
    const w = fs.watch(userConfigDir, (eventType, filename) => {
      // 只关心 config.yaml（及原子写过程中的 .tmp）
      if (filename !== 'config.yaml' && filename !== 'config.yaml.tmp') return
      if (_watchTimer) clearTimeout(_watchTimer)
      _watchTimer = setTimeout(() => {
        _watchTimer = null
        try { reload() } catch (e) { Log.warn('[config] 热加载失败', e?.message || e) }
      }, 400)
    })
    w.on('error', () => { /* 监听异常时静默降级，不影响运行 */ })
  } catch (e) {
    Log.warn('[config] 配置监听未启动（降级为手动 reload）', e?.message || e)
  }
}

/** 持久化当前配置到用户配置文件：统一归一 → 只写与默认值的差异（F16） */
function save(data = _data) {
  normalizeConfig(data)
  writeUser(data)
  _data = data
}

load()
// startWatch 不在 import 时自动启动（fs.watch 会让测试进程不退出）；由应用入口显式调用
let _watchStarted = false
function startWatchOnce() {
  if (_watchStarted) return
  _watchStarted = true
  startWatch()
}

export default {
  pkg,
  name: PLUGIN_NAME,
  version: pkg.version,
  path: {
    plugin: PLUGIN_DIR,
    yunzai: YUNZAI_ROOT,
    defaultConfig: defaultDir,
    userConfig: userConfigPath,
    legacyUserConfig: legacyUserConfigPath,
    // 插件自用目录（一切文件存这里，绝不写到 TRSS 根 / TRSS data）
    data: path.join(PLUGIN_DIR, 'data'),
    temp: path.join(PLUGIN_DIR, 'data', 'temp'),
    logs: path.join(PLUGIN_DIR, 'data', 'logs'),
    humanizeLogs: path.join(PLUGIN_DIR, 'data', 'humanize-logs'), // 伪人全链路日志（独立目录，不进 web 日志时间线，定期压缩）
    memories: path.join(PLUGIN_DIR, 'data', 'memories'),
    personas: path.join(PLUGIN_DIR, 'data', 'personas'),
    evolution: path.join(PLUGIN_DIR, 'data', 'evolution'),
    tts: path.join(PLUGIN_DIR, 'data', 'tts'), // TTS 参考音频库 + 合成产物
  },
  get: () => _data,
  set: (key, value) => { _data[key] = value },
  normalize: (data) => normalizeConfig(data),
  diffFromDefaults,
  reload,
  save,
  onChange,
  startWatch: startWatchOnce,
}
