/**
 * 终端执行能力公共出口。
 *
 * 用法（apps buildRuntime）：
 *   import { makeTerminalTool, getMaster } from '../model/terminal/index.js'
 *   if (rt.sandbox?.manager) tools.register(makeTerminalTool({ manager: rt.sandbox.manager }))
 *
 * 主人认证（验证码认领，自包含，不读框架配置）：
 *   import { requestClaim, claim, isMaster, getMaster } from '../model/terminal/index.js'
 *
 * 安全：terminal 仅 terminal 主人可用；命令在 E2B 沙箱内执行（无审批、无黑名单；
 * 宿主 shell 执行面已删除，mode=off 时本工具不注册）。
 */
export { makeTerminalTool } from './exec.js'
export { requestClaim, claim, isMaster, getMaster } from './master.js'
