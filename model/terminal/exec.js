/**
 * 终端执行能力 —— 命令在 E2B（Firecracker microVM）沙箱内执行。
 *
 * 执行面**只有沙箱一个**：宿主 `spawn`/黑名单/审批已全部删除，`agent.sandbox.mode=off` 时
 * 本工具根本不注册（apps/agent.js），所以不存在"配置写错就落到真机"的降级面。
 *
 * 安全模型：
 *   1. 主人限定：仅「terminal 主人」（验证码认领，自包含、不读框架配置）可用，其他人直接拒。
 *   2. 无审批、无命令黑名单：破坏性命令被限制在 microVM 内（独立 VM/独立 FS/独立网络命名空间），
 *      出口按 agent.sandbox.network.allowOut 白名单收紧（allow 优先于 deny）。
 *   3. 成本闸：单会话命令数上限 + 单命令超时上限 + 全局并发上限（见 agent.sandbox.*）。
 *   4. 失败一律 fail-closed：连不上 E2B / 未配置 → 返回结构化错误，**绝不回退到本机执行**。
 */
import { isMaster as isTerminalMaster } from './master.js'
import { runSandboxShell, sessionKeyOf } from '../sandbox/index.js'
import Log from '../../utils/Log.js'

/**
 * terminal 工具（沙箱执行；仅 terminal 主人 + 无审批无黑名单 + 成本闸）。
 * ctx.sandbox = { manager, defaultCwd?, maxTimeout?, maxOutput?, maxCommandsPerSession?, audit?, commands?, sessionKey? }
 *
 * @param {object} [opt] { isMasterFn?, manager? } —— 均可注入用于离线测试；缺省用 master.js / ctx.sandbox.manager
 */
export function makeTerminalTool({ isMasterFn, manager = null } = {}) {
  const checkMaster = typeof isMasterFn === 'function' ? isMasterFn : isTerminalMaster
  return {
    name: 'terminal',
    description: '在隔离的 Linux 沙箱（E2B 微虚机）里执行 shell 命令并返回 exitCode/stdout/stderr。'
      + '沙箱与宿主完全隔离：宿主文件、宿主进程都不可见，默认工作目录 /home/user，网络仅放行包管理器与 api.openai.com。'
      + '每个会话独占一个沙箱，文件与进程状态在会话内连续（多步任务可先安装/写文件再用）。'
      + '仅 terminal 主人可用；无审批流程，命令直接执行。'
      + '⚠️下载视频/媒体请用 web_download 工具（基于 yt-dlp，受约束），不要用 terminal 跑 curl/wget/yt-dlp。',
    category: 'query', // 放行 policy（access 控制在 execute 内，仅 terminal 主人通过）
    meta: {
      interactive: true, // 沙箱命令不与其他工具并行（顺序执行，避免同一会话内互相干扰）
      dangerous: true,
    },
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令（支持管道 | 与重定向 >）' },
        cwd: { type: 'string', description: '沙箱内工作目录（可选，默认 /home/user）' },
        timeout: { type: 'integer', description: '超时秒数（默认 60，上限由 maxTimeout 控制）' },
      },
      required: ['command'],
    },
    async execute(params = {}, ctx) {
      const cfg = ctx?.sandbox || {}
      const cmd = String(params.command || '').trim()
      if (!cmd) return { error: '空命令' }
      if (!checkMaster(ctx?.userId)) {
        return { error: '仅 terminal 主人可用。请由服务器持有者发 #agents设置主人（控制台会打印验证码），再把验证码直接发到会话认领。' }
      }
      // 沙箱不可用（mode=off / 装配失败 / 未填 key）→ 直接拒绝，绝不落到宿主
      const box = cfg.manager || manager
      if (!box) {
        return { error: '沙箱不可用，已拒绝执行：请在配置中心把 agent.sandbox.mode 设为 e2b 并填 apiKey（本机不再执行 shell 命令）。' }
      }
      const key = cfg.sessionKey || sessionKeyOf(ctx)
      // 成本闸：单会话命令数上限（防长任务空转把配额/账单打爆）
      if (cfg.commands?.hit?.(key)) {
        return { error: `本会话命令数已达上限（${cfg.commands.limit} 条，agent.sandbox.maxCommandsPerSession）。可用 #新会话 开新会话，或调高该上限。` }
      }
      if (cfg.audit !== false) Log.mark('[terminal]', `key=${key} $ ${cmd.slice(0, 200)}`)

      const res = await runSandboxShell(box, key, cmd, {
        cwd: params.cwd || cfg.defaultCwd,
        timeout: Math.min(Number(params.timeout) || 60, cfg.maxTimeout || 600),
        maxTimeout: cfg.maxTimeout || 600,
        maxOutput: cfg.maxOutput,
        signal: ctx?.signal || null,
      })
      if (cfg.audit !== false && (res.timedOut || res.aborted || res.sandboxError || res.ok === false)) {
        Log.mark('[terminal]', `key=${key} exit=${res.exitCode ?? 'null'}${res.timedOut ? ' timedOut' : ''}${res.aborted ? ' aborted' : ''}${res.sandboxError ? ` ${res.sandboxError.kind}` : ''}`)
      }
      return { command: cmd, ...res }
    },
  }
}
