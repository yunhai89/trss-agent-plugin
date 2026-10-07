/**
 * 模型能力「官方数据」来源 —— 从厂商 /models 端点拉取模态元数据，缓存供 detectCapabilities 同步读取。
 *
 * 背景：多数 OpenAI 兼容厂商（含小米 MiMo）的 /models 只返回 id，无模态字段；而 OpenRouter 等
 * 会在 `architecture.input_modalities` / `supported_parameters` 中声明模态与工具能力。本模块：
 *  - primeModelCaps() 拉取并缓存（best-effort，永不抛错）；
 *  - getApiCaps(model) 供 detectCapabilities 同步叠加（仅正向能力，不因缺字段关闭内置判定）；
 *  - capsFromModelItem() 为纯解析函数（可离线测试）。
 *
 * 无官方数据时回退内置 REGISTRY 与 agent.media.caps 覆盖（config 优先级最高）。
 */

const TTL_MS = 6 * 3600 * 1000
const _cache = new Map() // modelId -> { caps, at }

/** 同步读取已缓存的官方能力；无/过期返回 null */
export function getApiCaps(model) {
  const hit = _cache.get(String(model || ''))
  if (hit && Date.now() - hit.at < TTL_MS) return hit.caps
  return null
}

/** 清空缓存（测试/诊断用） */
export function clearApiCaps() { _cache.clear() }

/**
 * 解析 /models 单项 → 正向能力位（无信息返回 null）。
 * 支持 OpenRouter：architecture.input_modalities / supported_parameters；
 * 兼容通用：modalities / input_modalities / capabilities。
 */
export function capsFromModelItem(item) {
  if (!item || typeof item !== 'object') return null
  const caps = {}
  const arch = (item.architecture && typeof item.architecture === 'object') ? item.architecture : {}
  const inputsRaw = arch.input_modalities || item.input_modalities || item.modalities
  const inputs = Array.isArray(inputsRaw) ? inputsRaw.map((x) => String(x).toLowerCase()) : []
  if (inputs.includes('image')) caps.vision = true
  if (inputs.includes('file') || inputs.includes('pdf')) caps.file = true
  if (inputs.includes('audio')) caps.audio = true
  if (inputs.includes('video')) caps.video = true

  const c = item.capabilities
  if (c && typeof c === 'object') {
    if (c.vision || c.image || c.image_input) caps.vision = true
    if (c.video || c.video_input) caps.video = true
    if (c.audio || c.audio_input) caps.audio = true
    if (c.tools || c.function_calling) caps.tools = true
    if (c.reasoning || c.thinking) caps.thinking = true
  }

  const spRaw = arch.supported_parameters || item.supported_parameters
  const sp = Array.isArray(spRaw) ? spRaw.map((x) => String(x).toLowerCase()) : []
  if (sp.includes('tools')) caps.tools = true
  if (sp.some((x) => /reason|thinking/.test(x))) caps.thinking = true

  return Object.keys(caps).length ? caps : null
}

/**
 * 拉取并缓存指定模型的官方能力。best-effort：任何失败静默忽略（回退注册表）。
 * @param {object} o { protocol, baseURL, apiKey, preset, models:[...], fetchImpl, timeoutMs }
 */
export async function primeModelCaps({ protocol = 'openai', baseURL, apiKey, models = [], fetchImpl, timeoutMs = 8000 } = {}) {
  const want = (Array.isArray(models) ? models : [models]).map((m) => String(m || '').trim()).filter(Boolean)
  if (!baseURL || !apiKey || !want.length) return
  const f = fetchImpl || globalThis.fetch
  if (typeof f !== 'function') return

  const base = String(baseURL).replace(/\/+$/, '')
  let url, headers
  if (protocol === 'anthropic') {
    url = `${base.replace(/\/v1\/?$/, '')}/v1/models`
    headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  } else {
    url = `${base}/models`
    headers = { Authorization: `Bearer ${apiKey}` }
  }

  try {
    const res = await f(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res?.ok) return
    const data = await res.json().catch(() => null)
    const arr = Array.isArray(data?.data) ? data.data
      : Array.isArray(data?.models) ? data.models
        : Array.isArray(data) ? data : []
    const wantSet = new Set(want)
    for (const item of arr) {
      const id = String(item?.id || item?.name || '').replace(/^models\//, '')
      if (!id || !wantSet.has(id)) continue
      const caps = capsFromModelItem(item)
      if (caps) _cache.set(id, { caps, at: Date.now() })
    }
  } catch { /* 忽略：回退内置注册表 / 配置覆盖 */ }
}
