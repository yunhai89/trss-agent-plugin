/**
 * 终端执行能力 —— 在主机上直接执行 shell 命令（即焚式调用，无容器隔离）。
 *
 * ⚠️ 高危：这是真机任意命令执行。安全模型（纵深防御，全部在代码层）：
 *   1. 主人限定：仅「terminal 主人」（验证码认领，自包含、不读框架配置）可用，其他人 execute 直接拒。
 *   2. 审批门：每条命令需主人在聊天里 #确认 才执行（无 allowlist 免审——真机执行没有「安全的只读命令」）。
 *   3. 黑名单：灾难命令（rm -rf / / mkfs / dd of=/dev/ / 关机重启 等）即使已确认也硬拦。
 *
 * runShell 为纯执行函数（带超时、输出截断、退出码），terminal 工具在其上加安全门。
 */
import { spawn } from 'node:child_process'
import { isMaster as isTerminalMaster, requestTerminalApproval } from './master.js'

function trunc(s, max) {
  const t = String(s == null ? '' : s)
  if (t.length <= max) return t
  return t.slice(0, max) + `\n…[已截断，共 ${t.length} 字符]`
}

/**
 * 在主机上执行 shell 命令（无容器隔离）。
 * @param {string} command
 * @param {object} opts { cwd?(默认 Yunzai 根), timeout?(秒,默认60,上限600), maxOutput?(默认8000) }
 * @returns {Promise<{ok, exitCode, stdout, stderr, duration, signal?, timedOut?}>}
 */
export async function runShell(command, { cwd, timeout = 60, maxOutput = 8000 } = {}) {
  const cmd = String(command || '')
  const seconds = Math.min(Math.max(1, Number(timeout) || 60), 600)
  const ms = seconds * 1000
  const t0 = Date.now()
  return new Promise((resolve) => {
    let stdout = '', stderr = ''
    let timer = null
    let proc
    const finish = (r) => { if (timer) clearTimeout(timer); resolve(r) }
    try {
      proc = spawn(process.env.SHELL || '/bin/sh', ['-c', cmd], {
        cwd: cwd || undefined,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      return finish({ ok: false, stderr: trunc(String(e), maxOutput), duration: Date.now() - t0 })
    }
    proc.stdout?.on('data', (d) => { stdout += d.toString() })
    proc.stderr?.on('data', (d) => { stderr += d.toString() })
    timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* noop */ }
      finish({ ok: false, exitCode: null, signal: 'SIGKILL', stdout: trunc(stdout, maxOutput), stderr: trunc(stderr, maxOutput), duration: Date.now() - t0, timedOut: true })
    }, ms)
    proc.on('error', (e) => {
      finish({ ok: false, stderr: trunc(String(e?.message || e), maxOutput), duration: Date.now() - t0 })
    })
    proc.on('close', (code) => finish({ ok: code === 0, exitCode: code, stdout: trunc(stdout, maxOutput), stderr: trunc(stderr, maxOutput), duration: Date.now() - t0 }))
  })
}

/** 默认安全黑名单（即使主人确认也拦截）；可在 config.terminal.blocklist 覆盖/追加 */
export const DEFAULT_BLOCKLIST = [
  'rm\\s+(-[a-z]*r[a-z]*f|[a-z]*-r[a-z]*f)', // rm -rf / rm -fr / rm -rfv 等（拦任何 rm 带 r+f flags，不管目标路径/通配符）
  'rm\\s+.*-rf', // 兜底：rm xxx -rf（flags 在后面）
  'mkfs\\.?[a-z0-9]*\\s+/dev/', // 格式化设备
  'dd\\s+.*of=/dev/', // dd 写设备
  ':\\(\\)\\s*\\{.*\\}\\s*;\\s*:', // fork bomb
  'shutdown|reboot|halt|poweroff', // 关机重启
  'chmod\\s+-R?\\s*000\\s+/', // 去除根权限
  '>/dev/sda', // 直接写设备
  'mv\\s+/.+\\s+/dev/null', // mv 到 /dev/null
]

/** 任一正则命中 → true */
export function matchesAny(cmd, patterns) {
  const list = Array.isArray(patterns) ? patterns : []
  for (const re of list) {
    try {
      if (new RegExp(re).test(cmd)) return true
    } catch { /* 无效正则跳过 */ }
  }
  return false
}

/**
 * terminal 工具（主机执行；仅 terminal 主人 + 每条命令 #确认 + 黑名单硬拦）。
 * ctx.terminal = { cwd?, maxTimeout?, blocklist?: string[], approve?(测试覆写) }
 *
 * 安全闸顺序：① 非主人拒（不触发审批，免打扰）→ ② 黑名单硬拦 → ③ 主人 #确认审批 → ④ 主机执行。
 * @param {object} [opt] { isMasterFn? } —— isMasterFn 测试注入；缺省用 master.js 的 isTerminalMaster
 */
export function makeTerminalTool({ isMasterFn } = {}) {
  const checkMaster = typeof isMasterFn === 'function' ? isMasterFn : isTerminalMaster
  return {
    name: 'terminal',
    description: '在主机执行终端(shell)命令。仅 terminal 主人可用（#agents设置主人 认领）；每条命令默认需主人 #确认（config terminal.skipConfirm=true 时 terminal 主人免确认直跑，黑名单仍硬拦）；灾难性命令（rm -rf / 等）黑名单硬拦。用于系统管理：安装软件、文件操作、运行脚本、进程管理等。⚠️下载视频/媒体请用 web_download 工具（基于 yt-dlp，受约束），不要用 terminal 跑 curl/wget/yt-dlp。返回 exitCode/stdout/stderr。',
    category: 'query', // 放行 policy（access 控制在 execute 内，仅 terminal 主人通过）
    meta: {
      interactive: true, // 主机命令不与其他工具并行（顺序执行）
      dangerous: true,
    },
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令（支持管道 | 与重定向 >）' },
        cwd: { type: 'string', description: '工作目录（可选，默认 Yunzai 根目录）' },
        timeout: { type: 'integer', description: '超时秒数（默认 60，上限由 maxTimeout 控制）' },
      },
      required: ['command'],
    },
    async execute(params = {}, ctx) {
      const cfg = ctx?.terminal || {}
      const cmd = String(params.command || '').trim()
      if (!cmd) return { error: '空命令' }
      // ① 仅 terminal 主人（自包含，不读框架 e.isMaster）
      if (!checkMaster(ctx?.userId)) {
        return { error: '仅 terminal 主人可用。请由服务器持有者发 #agents设置主人（控制台会打印验证码），再把验证码直接发到会话认领。' }
      }
      // ② 黑名单（代码层，已确认也拦）
      const blocklist = Array.isArray(cfg.blocklist) ? cfg.blocklist : DEFAULT_BLOCKLIST
      if (matchesAny(cmd, blocklist)) return { error: '命令被安全策略拦截（黑名单）' }
      // ③ 审批门：每条命令需主人 #确认；cfg.skipConfirm=true 时 terminal 主人免确认直跑（黑名单仍硬拦，高危）
      if (cfg.skipConfirm !== true) {
        const approve = typeof cfg.approve === 'function' ? cfg.approve : requestTerminalApproval
        const approved = await approve({ command: cmd }, ctx)
        if (!approved) return { error: '未获主人批准或审批超时' }
      }
      // ④ 主机执行
      const res = await runShell(cmd, {
        cwd: params.cwd || cfg.cwd || undefined,
        timeout: Math.min(Number(params.timeout) || cfg.maxTimeout || 60, cfg.maxTimeout || 600),
      })
      return { command: cmd, ...res }
    },
  }
}
