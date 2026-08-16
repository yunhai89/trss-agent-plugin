/**
 * Terminal 主人认证 —— 自包含、验证码认领（绝不读 Yunzai 框架的 master 配置）。
 *
 * 设计动机：terminal 在主机执行任意 shell（高危），只有「主人」可用。
 * 但「主人」不沿用框架的 e.isMaster / Bot.master / agent.masters —— 那需要改框架配置，
 * 易出错。这里自建一套：服务器持有者在控制台看到验证码，用自己的 QQ 把验证码发到群里认领。
 *
 * 认领流程（单主人 + 验证码重置，类似 Yunzai #设置主人）：
 *   ① 任意人发 `#agents设置主人` → requestClaim() 生成验证码、打印到控制台（只有控制台可见），
 *      apps 层进入监听态（terminalClaimPending）。
 *   ② 服务器持有者直接把验证码发到当前会话（无需命令前缀）→ claim() 校验通过 → 成为 terminal 主人（替换旧主人）。
 *      验证码错误不消费、可重发，直到正确或超时。
 *
 * 持久化：插件 data/terminal-master.json（绝不写框架配置）。重启不丢主人。
 *
 * 审批门（自包含，不走框架 ConfirmStore）：terminal 每条命令需主人 #确认 才在主机执行。
 * requestTerminalApproval() 在 terminal.execute 内调用：通知主人 → 等待 #确认/超时。
 * #确认/#拒绝 命令经 apps/agent.js 放宽后，调 resolveApproval 解锁。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import Log from '../../utils/Log.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..') // model/terminal -> 插件根
const MASTER_FILE = path.join(PLUGIN_ROOT, 'data', 'terminal-master.json')
const CLAIM_TTL_MS = 5 * 60 * 1000 // 验证码 5 分钟有效
const CODE_BYTES = 4 // → 8 位 hex
const DEFAULT_APPROVAL_TIMEOUT_SEC = 300

let _master = null // { userId }
let _pending = null // { code, expires }
let _approvals = new Map() // id(4位字符串) -> { resolve, timer, info }
let _seq = 0
load()

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'))
    if (j && j.userId != null) _master = { userId: String(j.userId) }
  } catch { /* 不存在/损坏=未认领 */ }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(MASTER_FILE), { recursive: true })
    fs.writeFileSync(MASTER_FILE, JSON.stringify(_master || {}, null, 2))
  } catch (e) { Log.warn('[terminal] 主人文件保存失败', e?.message || e) }
}

/** 生成验证码并打印到控制台；返回 { code, ttlMs }（码不回聊天——只有控制台可见）。 */
export function requestClaim() {
  const code = randomBytes(CODE_BYTES).toString('hex') // 8 位
  _pending = { code, expires: Date.now() + CLAIM_TTL_MS }
  Log.mark(
    `[terminal] 主人认领验证码：${code}\n` +
    `把它直接发到当前会话（无需任何命令前缀）即可认领（类似 Yunzai #设置主人）\n` +
    `（${CLAIM_TTL_MS / 1000} 秒内有效；认领后即成为 terminal 主人，替换旧主人）`,
  )
  return { code, ttlMs: CLAIM_TTL_MS }
}

/** 认领：码匹配且未过期 → 设为主人（替换旧主人）。返回 { ok, userId?, reason? }。 */
export function claim(code, userId) {
  if (!code || userId == null) return { ok: false, reason: '参数缺失' }
  if (!_pending || _pending.code !== String(code).trim()) return { ok: false, reason: '验证码错误' }
  if (Date.now() > _pending.expires) { _pending = null; return { ok: false, reason: '验证码已过期，请重新 #agents设置主人' } }
  _master = { userId: String(userId) }
  _pending = null
  save()
  Log.mark(`[terminal] 已认领主人：${_master.userId}`)
  return { ok: true, userId: _master.userId }
}

export function isMaster(userId) {
  return !!_master && userId != null && String(_master.userId) === String(userId)
}

export function getMaster() { return _master ? _master.userId : null }

/** 审批超时（秒）：优先 ctx.terminal.confirmTimeout（apps 注入 agent.confirmTimeout），默认 300。 */
function approvalTimeoutSec(ctx) {
  const t = Number(ctx?.terminal?.confirmTimeout)
  return (t > 0 ? t : DEFAULT_APPROVAL_TIMEOUT_SEC)
}

/**
 * 请求主人审批一条命令：通知主人（私聊 + 群内提示），返回 Promise<bool>。
 * 主人发 `#确认 <id>` → resolveApproval(id,true) → resolve(true)。
 * 超时 / `#拒绝` → resolve(false)。仅 terminal 用，与框架 ConfirmStore 互不干扰。
 */
export function requestTerminalApproval(info, ctx) {
  return new Promise((resolve) => {
    const id = String(++_seq % 10000).padStart(4, '0')
    const timeoutMs = approvalTimeoutSec(ctx) * 1000
    const timer = setTimeout(() => { _approvals.delete(id); resolve(false) }, timeoutMs)
    _approvals.set(id, { resolve, timer, info })
    const master = getMaster()
    const bot = ctx?.bot || (typeof Bot !== 'undefined' && Bot) || null
    const cmd = String(info?.command || '').slice(0, 500)
    const text = `🖥️ 主机终端待审批 #${id}（${Math.round(timeoutMs / 1000)}s 超时自拒）：\n$ ${cmd}\n回复「#确认 ${id}」执行 /「#拒绝 ${id}」取消`
    // 私聊通知 master：sendMsg 是异步的，异常要留痕（曾静默吞掉——通知失败时主人只能干等超时自拒，排障无线索）
    try {
      if (master) {
        const p = bot?.pickFriend?.(master)
        const r = p?.sendMsg?.(text)
        if (r?.catch) r.catch((e) => Log.warn('[terminal] 审批私聊通知失败（主人可能收不到，只能等超时自拒）', e?.message || e))
      }
    } catch (e) { Log.warn('[terminal] 审批私聊通知构建失败', e?.message || e) }
    // 群里也提示一句（主人在群里操作时可见审批进度）
    try { if (ctx?.isGroup) ctx.e?.reply?.(`⏳ 主机命令待主人审批 #${id}…`) } catch { /* noop */ }
  })
}

/** 主人端解析审批：#确认 → approved=true / #拒绝 → false。返回是否命中。 */
export function resolveApproval(id, approved) {
  const p = _approvals.get(String(id))
  if (!p) return false
  clearTimeout(p.timer)
  _approvals.delete(String(id))
  p.resolve(!!approved)
  return true
}

export function listApprovals() {
  return [..._approvals.entries()].map(([id, v]) => ({ id, info: v.info }))
}
