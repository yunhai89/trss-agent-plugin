/**
 * 终端执行能力 —— 命令在 E2B（Firecracker microVM）沙箱内执行，**对所有用户开放**。
 *
 * 执行面**只有沙箱一个**：宿主 `spawn`/黑名单/审批已全部删除，`agent.sandbox.mode=off` 时
 * 本工具根本不注册（apps/agent.js），所以不存在"配置写错就落到真机"的降级面。
 *
 * 安全模型（沙箱化 + 全员开放的产品决策）：
 *   1. 无身份门槛、无审批、无命令黑名单：破坏性命令被限制在会话 microVM 内
 *      （独立 VM/独立 FS/独立网络命名空间），出口按 agent.sandbox.network.allowOut 白名单收紧
 *      （allow 优先于 deny）。
 *   2. 成本闸：单会话命令数上限 + 单命令超时上限 + 全局并发沙箱上限（agent.sandbox.*），
 *      防任何用户（含被注入诱导的会话）把配额/账单打爆。
 *   3. 失败一律 fail-closed：连不上 E2B / 未配置 → 返回结构化错误，**绝不回退到本机执行**。
 *   4. 每会话独立沙箱（会话键含群/用户/会话 id）：用户之间文件系统互不可见。
 */
import { runSandboxShell, sessionKeyOf } from '../sandbox/index.js'
import Log from '../../utils/Log.js'

/**
 * terminal 工具（沙箱执行；全员可用 + 成本闸）。
 * ctx.sandbox = { manager, defaultCwd?, maxTimeout?, maxOutput?, maxCommandsPerSession?, audit?, commands?, sessionKey? }
 *
 * @param {object} [opt] { manager? } —— manager 可注入用于离线测试；缺省用 ctx.sandbox.manager
 */
export function makeTerminalTool({ manager = null } = {}) {
  return {
    name: 'terminal',
    description: '在隔离的 Linux 沙箱（E2B 微虚机）里执行 shell 命令并返回 exitCode/stdout/stderr。'
      + '沙箱与宿主完全隔离：宿主文件、宿主进程都不可见，默认工作目录 /home/user，网络仅放行包管理器与 api.openai.com。'
      + '每个会话独占一个沙箱，文件与进程状态在会话内连续（多步任务可先安装/写文件再用）。'
      + '无需审批，命令直接执行。'
      + '⚠️下载视频/媒体请用 web_download 工具（基于 yt-dlp，受约束），不要用 terminal 跑 curl/wget/yt-dlp。',
    category: 'query', // rank 0：所有用户 allow（工具内部不再有身份门槛）
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
      // 沙箱不可用（mode=off / 装配失败 / 未填 key）→ 直接拒绝，绝不落到宿主
      const box = cfg.manager || manager
      if (!box) {
        return { error: '沙箱不可用，已拒绝执行：请在配置中心把 agent.sandbox.mode 设为 e2b 并填 apiKey（本机不再执行 shell 命令）。' }
      }
      const key = cfg.sessionKey || sessionKeyOf(ctx)
      // 成本闸：单会话命令数上限（防任何用户的长任务空转把配额/账单打爆）
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
