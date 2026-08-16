/**
 * 文本嵌入 —— OpenAI 兼容 /embeddings 端点。对应 yunhai lib/llm/embed.js。
 * 复用底层传输客户端的 baseURL/apiKey/fetcher；按 index 排序、形状保持返回。
 * 仅适用于 OpenAI 兼容端点（DeepSeek/Kimi/Qwen/GLM 等均支持）；Anthropic 原生无 embeddings。
 */

import Log from '../../utils/Log.js'

function resolveClient(providerOrClient) {
  if (!providerOrClient) throw new Error('embed 需要 provider 或 client')
  return providerOrClient.client || providerOrClient
}

let _warnedDefaultModel = false

function buildHeaders(client) {
  const h = { 'Content-Type': 'application/json' }
  if (typeof client.authHeadersHook === 'function') Object.assign(h, client.authHeadersHook(client))
  else if (client.authHeader && client.apiKey) h[client.authHeader] = client.apiKey
  else if (client.apiKey) h['Authorization'] = `Bearer ${client.apiKey}`
  return h
}

/**
 * @param {string|string[]} texts
 * @param {object} opts { client|provider, model?, fetcher?, timeoutMs?, dimensions? }
 * @returns {number[]|number[][]}  形状随输入（单串→向量，数组→向量数组）
 */
export async function embed(texts, opts = {}) {
  const client = resolveClient(opts.client || opts.provider)
  const fetcher = opts.fetcher || client.fetcher || globalThis.fetch
  const baseURL = (client.baseURL || '').replace(/\/+$/, '')
  if (!baseURL) throw new Error('embed 需要 client.baseURL')

  const isArray = Array.isArray(texts)
  const input = isArray ? texts : [texts]
  const model = opts.model || client.embeddingModel || 'text-embedding-3-small'
  // 未显式指定模型时兜底到 OpenAI 默认名——非 OpenAI 端点大概率不认这个模型名（400），
  // 留痕一次（防刷屏）免得像 doubao 那次一样被静默吞掉、表现为"embedding 从未被使用"。
  if (!opts.model && !client.embeddingModel && !_warnedDefaultModel) {
    _warnedDefaultModel = true
    Log.warn('[embed] 未配置 embedding 模型，默认使用 text-embedding-3-small（非 OpenAI 端点请配 recall.embedProvider）baseURL=' + baseURL)
  }

  // 豆包多模态 embedding（doubao-embedding-vision-*）：不支持 OpenAI /embeddings，
  // 走 /embeddings/multimodal，input=[{type:'text',text}]，返回 data.embedding（单对象）——
  // 无批量，逐条并发 8 调用。此前按标准端点调被 400 且静默吞掉，表现为"embedding 从未被使用"。
  if (/embedding-vision/i.test(model)) {
    const rows = []
    for (let i = 0; i < input.length; i += 8) {
      const chunk = input.slice(i, i + 8)
      const outs = await Promise.all(chunk.map(async (t) => {
        const res = await fetcher(`${baseURL}/embeddings/multimodal`, {
          method: 'POST',
          headers: buildHeaders(client),
          body: JSON.stringify({ model, input: [{ type: 'text', text: String(t) }] }),
          signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || 30000),
        })
        if (!res.ok) {
          const err = `embed(multimodal) HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`
          Log.warn('[embed]', err)
          throw new Error(err)
        }
        const json = await res.json()
        const emb = json?.data?.embedding || json?.data?.[0]?.embedding
        if (!Array.isArray(emb) || !emb.length) throw new Error('embed(multimodal) 返回无向量')
        return emb
      }))
      rows.push(...outs)
    }
    return isArray ? rows : rows[0] || []
  }

  const body = { model, input }
  if (opts.dimensions != null) body.dimensions = opts.dimensions

  const signal = opts.signal || (opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : AbortSignal.timeout(30000))
  const res = await fetcher(`${baseURL}/embeddings`, {
    method: 'POST',
    headers: buildHeaders(client),
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    Log.warn('[embed]', `HTTP ${res.status}: ${t.slice(0, 200)}（model=${model}）`)
    throw new Error(`embed HTTP ${res.status}: ${t}`)
  }
  const json = await res.json()
  const rows = (json.data || [])
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((r) => r.embedding)
  return isArray ? rows : rows[0] || []
}
