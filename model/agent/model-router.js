/**
 * 功能模型路由（Model Router）—— 把「功能用的模型引用」解析为 { provider, model }。
 *
 * 背景：记忆抽取 / 自进化评审 / 子代理 / 伪人 / 群世界等「功能模型」过去只复用主 provider
 * 端点、仅换 model 字符串，因此只能选与主模型同端点厂商的模型。本模块让功能模型可以落在
 * 任意已注册厂商（llmProviders）上：
 *
 *  - 引用优先按 `llmModels[].id` 命中（推荐、无歧义）；
 *  - 其次按 `llmModels[].model` 字符串命中（向后兼容旧的裸模型名配置）；
 *  - 都不命中则回退主 provider（旧行为，裸模型名仍可用）。
 *
 * 每个厂商只构造一次 provider 并缓存（避免每个功能各建一套连接）。
 */

import { createProvider } from './provider/index.js'
import { presets as openaiPresets } from '../openai/index.js'
import { presets as anthropicPresets } from '../anthropic/index.js'

/**
 * @param {object} opts
 *   cfg: agent 配置对象（读 llmProviders / llmModels）
 *   mainProvider: 主 provider（回退用）
 *   mainModel: 主模型名
 *   proxyFetch: 走代理的 fetch（可选）
 *   providerLog: provider 日志钩子（可选）
 * @returns {{ resolve:(ref:string)=> {provider,model,matched,entry?,prov?}, size:number }}
 */
export function createModelRouter({ cfg = {}, mainProvider = null, mainModel = '', proxyFetch = null, providerLog } = {}) {
  const providers = Array.isArray(cfg.llmProviders) ? cfg.llmProviders : []
  const models = Array.isArray(cfg.llmModels) ? cfg.llmModels : []
  const cache = new Map() // providerId -> provider
  // 主厂商复用主 provider 实例（同一端点不重复建客户端）
  if (cfg.providerId && mainProvider) cache.set(cfg.providerId, mainProvider)

  function providerFor(prov) {
    if (!prov) return mainProvider
    const key = prov.id || `${prov.protocol || ''}|${prov.baseURL || ''}|${prov.preset || ''}`
    if (cache.has(key)) return cache.get(key)
    const protocol = prov.protocol || 'openai'
    const presetMap = protocol === 'anthropic' ? anthropicPresets : openaiPresets
    const preset = prov.preset && presetMap[prov.preset] ? presetMap[prov.preset] : {}
    const p = createProvider({
      protocol,
      ...preset,
      ...(prov.baseURL ? { baseURL: prov.baseURL } : {}),
      apiKey: prov.apiKey,
      ...(providerLog ? { log: providerLog } : {}),
      ...(proxyFetch ? { fetch: proxyFetch } : {}),
    })
    cache.set(key, p)
    return p
  }

  /** 解析功能模型引用 → { provider, model }。ref 空 → 主 provider + null（调用方自行决定回退）。 */
  function resolve(ref) {
    const v = String(ref ?? '').trim()
    if (!v) return { provider: mainProvider, model: null, matched: false }
    // 1) 条目 id（推荐）
    let entry = models.find((m) => m && m.id === v)
    // 2) 模型名字符串（兼容旧配置；同名取首个注册条目）
    if (!entry) entry = models.find((m) => m && String(m.model) === v)
    if (entry) {
      const prov = providers.find((p) => p && p.id === entry.providerId)
      if (prov) return { provider: providerFor(prov), model: entry.model || mainModel || v, matched: true, entry, prov }
    }
    // 3) 回退主 provider（裸模型名，旧行为）
    return { provider: mainProvider, model: v, matched: false }
  }

  return { resolve, get size() { return cache.size } }
}

export default createModelRouter
