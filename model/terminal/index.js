/**
 * 终端执行能力公共出口。
 *
 * 用法（apps buildRuntime）：
 *   import { makeTerminalTool, DEFAULT_BLOCKLIST } from '../model/terminal/index.js'
 *   if (cfg.terminal?.enable) tools.register(makeTerminalTool())
 *
 * 主人认证（验证码认领，自包含，不读框架配置）：
 *   import { requestClaim, claim, isMaster, resolveApproval, listApprovals } from '../model/terminal/index.js'
 *
 * 安全：terminal 仅 terminal 主人可用 + 每条命令主人 #确认 + DEFAULT_BLOCKLIST 拦截灾难命令。
 */
export { runShell, makeTerminalTool, DEFAULT_BLOCKLIST, matchesAny } from './exec.js'
export {
  requestClaim,
  claim,
  isMaster,
  getMaster,
  requestTerminalApproval,
  resolveApproval,
  listApprovals,
} from './master.js'
