/**
 * GroupWorld embedding 层 —— 语义相似度基础设施（P0 语义升级）。
 *
 * 提供三件事：
 *  1. makeEmbedder(embedFn)：把 apps 注入的 embedFn（(text)=>Promise<number[]>，同 recall.embedFn 契约）
 *     包成带 model 标识的嵌入器；任何失败返回 null（调用方回落 textSim，零影响）。
 *  2. BLOB 序列化：Float32Array ↔ sqlite BLOB（与 toolEvo/tool_embeddings 同思路）。
 *  3. textSim：**中文友好**的词面相似度（无 embedding 时的兜底，也用于切片漂移检测）——
 *     CJK 用字符二元组（bigram）、alnum 用词 token，再 jaccard。
 *     纯 jaccard 分词对中文几乎无效（标点间的整段连成一坨），bigram 是标准解法。
 *
 * 设计约束：embedding 是可选增强——没配 recall.embedProvider 时一切照旧（textSim/词面）。
 */

import Log from '../../utils/Log.js'

/** 余弦相似度；任一为空/长度不匹配（不同模型维度）→ null（调用方自行兜底）。 */
export function cosine(a, b) {
  if (!a || !b || !a.length || !b.length) return null
  if (a.length !== b.length) return null
  let dot = 0; let na = 0; let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return null
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Float32Array → sqlite BLOB。 */
export function toBlob(vec) {
  if (!vec || !vec.length) return null
  try { return Buffer.from(Float32Array.from(vec).buffer) } catch { return null }
}

/** sqlite BLOB → Float32Array；空/损坏 → null。 */
export function fromBlob(blob) {
  if (!blob || !blob.length) return null
  try {
    if (blob.length % 4 !== 0) return null
    return new Float32Array(blob.buffer, blob.byteOffset, blob.length / 4)
  } catch { return null }
}

/**
 * 包装 embedFn 为嵌入器。embedFn 缺失/非函数 → 返回 null（整层禁用，回落词面）。
 * @param {object} o { embedFn?: (text)=>Promise<number[]>, model?: string }
 * @returns {{model:string, embed(text:string):Promise<Float32Array|null>}|null}
 */
export function makeEmbedder({ embedFn, model = 'default' } = {}) {
  if (typeof embedFn !== 'function') return null
  return {
    model: String(model || 'default'),
    async embed(text) {
      const t = String(text || '').trim()
      if (!t) return null
      try {
        const v = await embedFn(t)
        if (!Array.isArray(v) || !v.length) { Log.warn('[embedding] embedFn 返回空向量（model=' + this.model + '）'); return null }
        return Float32Array.from(v)
      } catch (e) { Log.warn('[embedding] embed 失败（model=' + this.model + '）:', e?.message || e); return null }
    },
    /** 批量嵌入（并发钳 8；任一失败该条为 null，调用方自滤）。 */
    async embedBatch(texts) {
      const list = (Array.isArray(texts) ? texts : []).map((t) => String(t || '').trim()).filter(Boolean)
      const out = new Array(list.length).fill(null)
      for (let i = 0; i < list.length; i += 8) {
        const chunk = list.slice(i, i + 8)
        const res = await Promise.all(chunk.map((t) => this.embed(t).catch(() => null)))
        for (let j = 0; j < chunk.length; j++) out[i + j] = res[j]
      }
      return out
    },
  }
}

// ─────────────── 中文友好词面相似度（embedding 兜底 + 切片漂移检测） ───────────────

/** 抽特征集：CJK 连续段 → 字符二元组；alnum 连续段 → 小写词。 */
export function textFeatures(text) {
  const t = String(text || '').toLowerCase()
  const feats = new Set()
  // CJK 二元组（含跨 CJK 字符）
  const cjkRuns = t.match(/[㐀-鿿]+/g) || []
  for (const run of cjkRuns) {
    if (run.length === 1) feats.add(run)
    else for (let i = 0; i < run.length - 1; i++) feats.add(run.slice(i, i + 2))
  }
  // alnum 词（≥2 字符）
  for (const w of t.match(/[a-z0-9][a-z0-9_-]{1,}/g) || []) feats.add(w)
  return feats
}

/** 词面 jaccard（基于 textFeatures）。两空串 → 0。 */
export function textSim(a, b) {
  const sa = textFeatures(a); const sb = textFeatures(b)
  if (!sa.size || !sb.size) return 0
  let inter = 0
  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa]
  for (const x of small) if (big.has(x)) inter++
  return inter / (sa.size + sb.size - inter)
}

/**
 * 混合语义相似度：双方 embedding 可用 → 余弦；否则 → textSim。
 * （与 RecallStore._sim 同型的 per-item 双模降级。）
 */
export function hybridSim(topicEmb, storedEmb, textA, textB) {
  if (topicEmb && storedEmb) {
    const c = cosine(topicEmb, storedEmb)
    if (c != null) return c
  }
  return textSim(textA, textB)
}
