/**
 * embedFn 装配（apps 层共享）—— GroupWorld 与 SelfState 共用同一份 embedding 配置。
 *
 * 注意：这类"同步具名函数导出"**不能**放在 apps/*.js——Yunzai loader 会把 apps 目录模块的所有
 * 导出当插件类实例化（async/箭头函数无 .prototype 被跳过，同步函数有 → new 后无 task →
 * collectTask 读 undefined.cron 崩、整个 agents-plugin 加载被拒）。所以放在 model 层。
 */
import Config from '../../utils/Config.js'
import { embed } from './embed.js'

/**
 * 语义层 embedFn：复用 recall 的 embedding 配置（agent.recall.embedProvider 等；未配 → null 词面兜底）。
 * @param {object} rt runtime（取 provider 的 baseURL/apiKey 兜底）
 * @returns {{ embedFn:((text:string)=>Promise<number[]>)|null, embedModel:string|null }}
 *   注：与 provider 同为装配期决定——改 embedding 配置需重启进程生效。
 */
export function buildEmbed(rt) {
  const rcfg = Config.get().agent?.recall || {}
  if (!rcfg.embedProvider) return { embedFn: null, embedModel: null }
  const client = (rcfg.embedBaseURL || rcfg.embedApiKey)
    ? { baseURL: rcfg.embedBaseURL || rt.provider?.client?.baseURL, apiKey: rcfg.embedApiKey || rt.provider?.client?.apiKey }
    : rt.provider
  return { embedModel: rcfg.embedProvider, embedFn: (text) => embed(text, { client, model: rcfg.embedProvider }) }
}
