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

/** 递归检测 base 有而 over 缺失的键（用于 config.yaml 自愈补全） */
function hasMissingKeys(base, over) {
  if (!isPlainObj(base)) return false
  if (!isPlainObj(over)) return true
  for (const k of Object.keys(base)) {
    if (!(k in over)) return true
    if (isPlainObj(base[k]) && hasMissingKeys(base[k], over[k])) return true
  }
  return false
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

/** 写入用户配置（原子：tmp+rename） */
function writeUser(data) {
  try { fs.mkdirSync(userConfigDir, { recursive: true }) } catch { /* noop */ }
  const tmp = `${userConfigPath}.tmp`
  fs.writeFileSync(tmp, yaml.stringify(data))
  fs.renameSync(tmp, userConfigPath)
}

/** 迁移旧 Yunzai 根配置 → 插件内（幂等：插件内已有则不动） */
export function migrateLegacy() {
  if (fs.existsSync(userConfigPath) || !fs.existsSync(legacyUserConfigPath)) return false
  try {
    const old = fs.readFileSync(legacyUserConfigPath, 'utf8')
    const parsed = yaml.parse(old) || {}
    writeUser(parsed)
    try { fs.unlinkSync(legacyUserConfigPath) } catch { /* noop */ }
    Log.mark('[config] 已把旧配置从 Yunzai 根迁移到插件目录并删除旧文件')
    return true
  } catch (e) {
    Log.warn('[config] 旧配置迁移失败，沿用默认', e?.message || e)
    return false
  }
}

function load() {
  const def = readYamlDir(defaultDir)
  // 迁移旧配置（若插件内尚无配置且 Yunzai 根有旧文件）
  migrateLegacy()
  // 首次运行（无旧文件也无新文件）：把默认配置落到插件内，方便用户直接编辑
  if (!fs.existsSync(userConfigPath) && Object.keys(def).length) {
    try { writeUser(def) } catch (err) { Log.warn('写入默认配置失败', err) }
    _data = deepMerge(def, readUser())
    return
  }
  const user = readUser()
  const merged = deepMerge(def, user)
  // 自愈：default 有而 user 缺失的键，补全回 user config.yaml（user config 是程序生成的、
  // 无注释，重写无损）。否则用户编辑 config.yaml 时看不到新增字段（如 agent.pixiv / agent.document），
  // 只能靠运行时 deepMerge 兜底——既不可见也不可编辑。
  if (hasMissingKeys(def, user)) {
    try { writeUser(merged); Log.mark('[config] 已补全 config.yaml 中缺失的字段') } catch (e) { Log.warn('[config] 补全缺失字段失败', e?.message || e) }
  }
  _data = merged
}

/** 重新读取并合并；内容变化（或 force=true）才通知订阅者（去重，避免自发保存引发无谓重建） */
function reload(force = false) {
  migrateLegacy() // 自愈：若 config.yaml 缺失但 legacy 在，先拾取
  const def = readYamlDir(defaultDir)
  const next = deepMerge(def, readUser())
  const changed = JSON.stringify(next) !== JSON.stringify(_data)
  _data = next
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

/** 持久化当前配置到用户配置文件 */
function save(data = _data) {
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
  },
  get: () => _data,
  set: (key, value) => { _data[key] = value },
  reload,
  save,
  onChange,
  startWatch: startWatchOnce,
}
