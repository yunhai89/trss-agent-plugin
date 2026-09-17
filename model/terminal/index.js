/**
 * 终端执行能力公共出口。
 *
 * 用法（apps buildRuntime）：
 *   import { makeTerminalTool } from '../model/terminal/index.js'
 *   if (rt.sandbox?.manager) tools.register(makeTerminalTool({ manager: rt.sandbox.manager }))
 *
 * 安全：terminal **全员可用**；命令在 E2B 沙箱内执行（无审批、无黑名单、无身份门槛；
 * 宿主 shell 执行面已删除，mode=off 或沙箱未就绪时本工具不注册）。成本由
 * 单会话命令数 / 单命令超时 / 并发沙箱上限兜底，失败一律 fail-closed。
 */
export { makeTerminalTool } from './exec.js'
