/**
 * DevLog —— 插件自带的详细 trace 日志（框架无关），自写 fs.appendFileSync。
 *
 * 目的：开发期把"从触发 AI 到最终回复"的整条链路写进插件自己的文件，
 *   不依赖机器人框架的日志体系（框架默认 debug:false 会吞掉大量信息）。
 *   含：trigger / media / input / 每 turn 的请求响应 / 每次工具调用的
 *   参数+状态+返回 / context 压缩 / 反思 / run_end / reply。
 *
 * 输出：**美化缩进 JSON**（人工可读，非 pino 单行 JSONL）。按【会话】分文件，位于
 *   <插件>/data/logs/<群号>-<用户>-<会话id>-<会话创建时间>.log
 *   （可用 agent.devLog.dir 改目录）。同一会话(conversation)的多轮 AI 请求（各带 uuidv4 traceId）
 *   追加到同一文件；scope 缺失（旧调用/异常）回退 dev-fallback.log。
 *   不截断——工具返回内容按用户要求完整记录（方便排错）。
 *
 * 实现：fs.appendFileSync 同步追加 JSON.stringify(obj, null, 2)（缩进多行）。
 *   无 pino / 无 transport worker（杜绝 worker 错误被吞）。
 *   容错：写入失败 → _failed 关 dev 日志，绝不拖垮 bot。
 *   库零依赖：agent 库不直接 import 本模块；由 apps 注入 devLog 回调。
 */

import fs from 'node:fs'
import path from 'node:path'
import Config from './Config.js'

let _failed = false

function cfg() {
  return Config.get().agent?.devLog || {}
}

/**
 * 会话日志目录（读写同源）：agent.devLog.dir 优先，相对路径以**插件根**为基准（与 apps 同约定），
 * 留空 → Config.path.logs。写入侧（devLog）与读取侧（web 面板 logDir / #上报错误）必须共用本函数，
 * 否则用户设了 devLog.dir 后两边指向不同目录，面板看不到日志。
 */
export function resolveDevLogDir() {
  const fromPlugin = (d) => path.resolve(Config.path?.plugin || process.cwd(), String(d))
  try {
    const dir = cfg().dir
    if (dir) return fromPlugin(dir)
  } catch { /* 配置未就绪：回退默认路径 */ }
  return Config.path.logs
}

/**
 * 清空会话日志目录下的全部 *.log（「清空 Token 缓存统计」连带清理用；只删 .log，
 * 目录本身与其它文件保留）。返回删除文件数；目录不存在视为 0。
 */
export function clearDevLogs() {
  const dir = resolveDevLogDir()
  let removed = 0
  let names = []
  try { names = fs.readdirSync(dir) } catch { return { removed: 0, dir } }
  for (const name of names) {
    if (!name.endsWith('.log')) continue
    try { fs.unlinkSync(path.join(dir, name)); removed++ } catch { /* 单个失败不阻断其余 */ }
  }
  return { removed, dir }
}

/** 把毫秒时间戳格式化为文件名用的紧凑形式 YYYYMMDDHHmmss */
function fmtTime(ms) {
  const d = new Date(ms || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * scope → 日志文件名。<群号>-<用户>-<会话id>-<创建时间>.log
 * 与 #上报错误 的 glob 前缀（<群号>-<用户>-<会话id>-*.log）保持一致。
 */
/** 文件名安全片段：QQ 官方机器人的 ID 含 ':'（`<self_id>:<openid>`），Windows 下是非法文件名字符 */
function fileSafe(v) {
  const s = String(v ?? '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
  return s.slice(0, 80)
}

export function devLogFilename({ gid, uid, convId, createdAt } = {}) {
  // 数字 QQ 号/群号原样输出（历史文件名兼容）；官方机器人 openid 净化后拼入，避免 Windows 非法字符
  const g = fileSafe(gid || 'private') || 'private'
  const u = fileSafe(uid || 'unknown') || 'unknown'
  const c = fileSafe(convId || '0') || '0'
  return `${g}-${u}-${c}-${fmtTime(createdAt)}.log`
}

/**
 * 写一条 trace（美化缩进 JSON，人工可读）。
 * @param {string} event 事件名（trigger/media/input/run_start/turn/tool/context_pressure/reflect/run_end/reply/...）
 * @param {object} data 任意结构数据（完整记录，不截断）
 * @param {string|null} traceId 本次 AI 调用的 traceId（串联整条链路）
 * @param {object|null} scope {gid,uid,convId,createdAt} —— 决定写哪个会话文件；缺则 dev-fallback.log
 * @param {object} [opts] { dir?:string, filename?:string } —— 覆盖目录/文件名（如伪人日志写独立目录、按日文件）
 */
/** 应至少 warn 的异常停止原因（预算耗尽/循环停滞等——曾显示 info，控制台"看起来没报错"） */
const WARN_STOP_REASONS = new Set(['token_budget', 'time_budget', 'duplicate_action', 'no_progress', 'consecutive_failures', 'max_turns', 'blocked'])
/** 硬失败事件（error 级） */
const ERROR_EVENTS = new Set(['run_error', 'reply_failed'])

/**
 * 日志级别推导（长任务稳定性审计 P1：失败不再伪装 info）。
 * 优先级：显式 data.level > ERROR_EVENTS > 失败形态（ok/success=false、errorClass、error、error 事件、
 * 异常 stopReason、provider retry 耗尽）> info。调用方可传 data.level 覆盖。
 */
function inferLevel(event, data) {
  const d = data || {}
  if (d.level && typeof d.level === 'string') return d.level
  if (ERROR_EVENTS.has(event)) return 'error'
  if (d.ok === false || d.success === false || d.errorClass) return 'warn'
  if (event === 'error') return 'error'
  if (d.error || d.resolveError) return 'warn'
  if (d.stopReason && WARN_STOP_REASONS.has(d.stopReason)) return 'warn'
  if (event === 'provider_retry' && d.exhausted) return 'error'
  return 'info'
}

export default async function devLog(event, data = {}, traceId = null, scope = null, opts = {}) {
  if (_failed) return
  // debug 是历史公开开关（yaml/锅巴/README 都承诺「开=打印工具入参/每轮 token/搜索词」），
  // 但真正写全链路日志的是 devLog.enable；此前 debug 零读取、承诺不兑现（配置互搏审计 F10）。
  // 现在 debug=true 等价于强制开启 devLog；devLog.enable=false 仍是显式关闭（仅 debug 未开时生效）。
  if (cfg().enable === false && Config.get().debug !== true) return
  // 防御：scope 契约是 {gid,uid,convId,createdAt} 对象。传字符串（历史误用，如 'groupworld'）
  // 会被解构成全 undefined → 产出 private-unknown-0-*.log 落进主 agents 目录污染 web 时间线。
  // 现在显式拒绝并留痕，调用方应改传 opts {dir, filename}。
  if (typeof scope === 'string') {
    if (!devLog._warnedStrScope) { devLog._warnedStrScope = true; console.warn('[agents-dev] devLog 收到字符串 scope（应为对象或 null，请改用 opts {dir,filename}）——按无 scope 处理') }
    scope = null
  }
  // 相对目录一律以**插件根**为基准（与 apps 的 path.resolve(PLUGIN_ROOT, cfg.xxx) 同约定）：
  // path.resolve(dir) 会按 process.cwd()（生产上是 Yunzai 根）解析，把日志写到插件之外，
  // 而 Web 日志面板只读 Config.path.logs → 面板看不到内容、排障误判「日志没写」。
  // 默认目录解析已抽到 resolveDevLogDir（读取侧共用同一口径，勿在本文件另写一份）；
  // opts.dir 是调用方显式覆盖（伪人日志等独立目录），优先于配置。
  const dir = opts.dir
    ? path.resolve(Config.path?.plugin || process.cwd(), String(opts.dir))
    : resolveDevLogDir()
  const filename = opts.filename || (scope ? devLogFilename(scope) : 'dev-fallback.log')
  const filepath = path.join(dir, filename)
  const obj = {
    level: inferLevel(event, data),
    time: new Date().toISOString(),
    event,
    traceId,
    ...(data || {}),
  }
  // 美化缩进 JSON（人工可读）+ 分隔空行
  const line = JSON.stringify(obj, null, 2) + '\n'
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(filepath, line)
  } catch (e) {
    if (!_failed) {
      console.warn('[agents-dev] 日志写入失败，关闭 dev 日志：', e?.message || e)
      _failed = true
    }
  }
}

export { devLog }
