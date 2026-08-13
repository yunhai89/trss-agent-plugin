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
export function devLogFilename({ gid, uid, convId, createdAt } = {}) {
  const g = gid || 'private'
  const u = uid || 'unknown'
  const c = convId || '0'
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
export default async function devLog(event, data = {}, traceId = null, scope = null, opts = {}) {
  if (_failed) return
  if (cfg().enable === false) return
  const c = cfg()
  const dir = opts.dir ? path.resolve(opts.dir) : (c.dir ? path.resolve(c.dir) : Config.path.logs)
  const filename = opts.filename || (scope ? devLogFilename(scope) : 'dev-fallback.log')
  const filepath = path.join(dir, filename)
  const isError = data && (data.status === 'error' || data.error || data.resolveError || data.stopReason === 'blocked' || data.stopReason === 'max_turns')
  const obj = {
    level: isError ? 'warn' : 'info',
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
