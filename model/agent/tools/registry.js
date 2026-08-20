/**
 * ToolRegistry —— 工具注册、发现与协议格式转换。
 *
 * Tool 契约（能力本身，"能不能做"，模型直接调用执行）：
 *   { name, description, parameters(JSONSchema),
 *     execute(params, ctx): Promise<string|object>,
 *     category?, meta? }
 *
 * AOP：register 时自动包装 execute，集中打印"调用入参 / 耗时 / 结果 / 错误"日志。
 *      无论工具作者是否写日志、无论从哪条路径调用，都经此切面，统一可观测。
 * register 为变参（支持单个 / 多个 / 数组 / 嵌套数组），修复"spread 只注册首个"的隐患。
 */

import { cosine } from '../recall.js'
import { BM25 } from '../../llm/local-sim.js'

function brief(v, n = 160) {
  let s
  if (v == null) s = String(v)
  else if (typeof v === 'string') s = v
  else { try { s = JSON.stringify(v) } catch { s = String(v) } }
  s = String(s).replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s
}

/** 软失败判定：工具以"不抛异常、返回错误对象/串"的方式报错。
 *  - 对象：含 error 字段 或 ok===false
 *  - 字符串：形如 {"error":...} 或 error: 前缀（被 stringify 过的结果）
 * 导出供 usage-stats 等统计方复用（判定语义与 AOP 日志一致，避免两处漂移） */
export function isErrorShape(r) {
  if (r == null) return false
  if (typeof r === 'string') return /^\s*\{.*"error"\s*:/i.test(r) || /^error\b/i.test(r)
  if (typeof r === 'object' && !Array.isArray(r)) return r.error != null || r.ok === false
  return false
}

export class ToolRegistry {
  constructor({ logger = () => {} } = {}) {
    this.tools = new Map()
    this.logger = logger
    this._index = null // 工具检索索引（懒构建）
    this._indexDirty = true // register/unregister/setEmbedFn 置脏 → search 时重建
    this._embedFn = null // 可选 embedding 函数（apps 注入；留空 = 纯关键词 jaccard）
    this._invSink = null // 可选调用埋点（toolEvo 注入 recordInvocation；留空 = 不持久化）
  }

  /** 注入 embedding 函数（apps 用；留空 = 纯关键词 jaccard 检索）。切换会重建索引。 */
  setEmbedFn(fn) {
    this._embedFn = typeof fn === 'function' ? fn : null
    this._indexDirty = true
    return this
  }

  /** 注入日志器（AOP 切面用它打印） */
  setLogger(logger) {
    this.logger = logger || (() => {})
    return this
  }

  /** 注入调用埋点（toolEvo recordInjection；留空 = 不持久化 tool_invocations）。核心模块不静态依赖 toolEvo。 */
  setInvocationSink(fn) {
    this._invSink = typeof fn === 'function' ? fn : null
    return this
  }

  /**
   * 注册工具（变参）：register(t1, t2, ...) / register(array) / register(...array) 均可。
   * 自动用 AOP 包装 execute，集中日志。
   */
  register(...tools) {
    for (const tool of tools.flat(Infinity).filter(Boolean)) {
      if (!tool || !tool.name) throw new Error('工具必须包含 name')
      if (typeof tool.execute !== 'function') throw new Error(`工具 ${tool.name} 必须包含 execute 函数`)
      this.tools.set(tool.name, this.#wrap(tool))
    }
    this._indexDirty = true
    return this
  }

  /** AOP 包装：调用前后统一打日志、计时。
   *  - 抛异常 → warn（可见）并抛出（由调用方归一为 {error}）
   *  - 软失败（返回 {error}/{ok:false}，不抛）→ 提升到 warn，确保控制台可见
   *    （否则只走 debug，默认 debug:false 会被吞 → 工具失败完全无痕）
   *  MCP 工具(meta.mcp)用其专用 logger、默认 info 级；其余工具成功路径仅 debug。 */
  #wrap(tool) {
    const self = this
    const orig = tool.execute
    const name = tool.name
    const meta = tool.meta || {}
    const isMcp = !!meta.mcp
    const lg = typeof meta.logger === 'function' ? meta.logger : self.logger
    return {
      ...tool,
      execute: async function (params, ctx) {
        const t0 = Date.now()
        if (isMcp) lg('info', `调用 ${name}`, '参数=', brief(params))
        else self.logger('debug', 'tool call', name, 'args=', brief(params))
        const sink = (extra) => { if (self._invSink) self._invSink({ versionId: meta.toolEvoVersionId || null, toolName: name, args: params, ...extra }) }
        try {
          const r = await orig.call(this, params, ctx)
          const ms = Date.now() - t0
          if (isErrorShape(r)) {
            ;(isMcp ? lg : self.logger)('warn', 'tool failed', name, brief(r.error != null ? r.error : r, 200), 'args=', brief(params))
            sink({ success: false, latencyMs: ms, errorClass: 'soft_fail' })
          } else if (isMcp) {
            lg('info', `完成 ${name}`, `耗时=${ms}ms`)
            sink({ success: true, latencyMs: ms })
          } else {
            self.logger('debug', 'tool done', name, `ms=${ms}`, 'preview=', brief(r, 140))
            sink({ success: true, latencyMs: ms })
          }
          return r
        } catch (e) {
          lg('warn', 'tool error', name, e?.message || e, 'args=', brief(params))
          sink({ success: false, latencyMs: Date.now() - t0, errorClass: e?.name || 'Error' })
          throw e
        }
      },
    }
  }

  unregister(name) {
    const r = this.tools.delete(name)
    this._indexDirty = true
    return r
  }

  has(name) {
    return this.tools.has(name)
  }

  get(name) {
    return this.tools.get(name)
  }

  list() {
    return [...this.tools.values()]
  }

  names() {
    return [...this.tools.keys()]
  }

  /** 按名称集合或谓词筛选子集 */
  match({ names, predicate } = {}) {
    let list = this.list()
    if (names) {
      const set = new Set(names)
      list = list.filter((t) => set.has(t.name))
    }
    if (typeof predicate === 'function') list = list.filter(predicate)
    return list
  }

  /**
   * 构建/刷新工具检索索引（懒重建：register/unregister/setEmbedFn 置脏）。
   * 索引文本 = name + category + description + summary + 派生关键词 + 必填参数名；
   * tokens 预算缓存，避免每次 search 重算。元工具 tool_search 自身不入索引。
   */
  _ensureIndex() {
    if (this._index && !this._indexDirty) return
    const idx = []
    for (const tool of this.tools.values()) {
      if (!tool || tool.name === 'tool_search') continue
      const required = tool.parameters?.required || []
      const summary = String(tool.meta?.summary || tool.description || '').replace(/\s+/g, ' ').trim()
      const text = [tool.name, tool.category, tool.description, tool.meta?.summary, ...deriveKeywords(tool), ...required].filter(Boolean).join(' ')
      idx.push({
        name: tool.name,
        category: tool.category || 'query',
        summary,
        required,
        tokens: toolTokenize(text),
        embedding: null, // lazy：首次 search 且 embedFn 可用时才填
      })
    }
    this._index = idx
    this._indexDirty = false
  }

  /**
   * 按自然语言 query 检索工具（双轨：有 embedding 走 cosine，否则 query 覆盖率打分）。
   * 覆盖率 = query tokens 命中文档的比例（|∩|/|query|），不受文档长度影响，对短查询友好。
   * @returns {Promise<Array<{name,score,category,summary,required}>>} 按 score 降序、过滤 minScore、截断 topK
   */
  async search(query, { topK = 8, category, minScore = 0.3 } = {}) {
    this._ensureIndex()
    const q = String(query || '').trim()
    if (!q || !this._index.length) return []
    const qTokens = toolTokenize(q)
    if (!qTokens.size) return []
    let qEmbed = null
    if (this._embedFn) {
      try { qEmbed = await this._embedFn(q) } catch { qEmbed = null } // embed 失败 → 降级关键词覆盖率
    }
    // 无 embedding（embedFn 未配/qEmbed 失败）→ BM25 纯代码检索（IDF 加权，比 coverage 抗长 query 稀释）
    if (!qEmbed) {
      const bm = new BM25()
      const docs = []
      for (const doc of this._index) {
        if (category && doc.category !== category) continue
        bm.add([...doc.tokens])
        docs.push(doc)
      }
      const scores = bm.scoresNormalized([...qTokens])
      return docs
        .map((doc, i) => ({ name: doc.name, score: scores[i] || 0, category: doc.category, summary: doc.summary, required: doc.required }))
        .filter((s) => s.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
    }
    // 有 embedding：cosine（doc.embedding 懒计算）
    const scored = []
    for (const doc of this._index) {
      if (category && doc.category !== category) continue
      if (!doc.embedding) {
        try { doc.embedding = await this._embedFn([doc.name, doc.summary].join(' ')) } catch { doc.embedding = null }
      }
      const sim = (qEmbed && doc.embedding) ? cosine(qEmbed, doc.embedding) : 0
      if (sim >= minScore) scored.push({ name: doc.name, score: sim, category: doc.category, summary: doc.summary, required: doc.required })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, topK)
  }
}

/**
 * 工具检索专用分词：CJK 单字 + CJK 2-gram + Latin/数字词（≥2）。
 * 比 recall.tokenize 多含单字——短查询（如"踢人"）靠单字"踢"命中"踢出群成员"，
 * 避免 2-gram 无交集导致漏召回。
 */
function toolTokenize(s) {
  const t = String(s || '').toLowerCase()
  const grams = new Set()
  for (let i = 0; i < t.length; i++) {
    const code = t.charCodeAt(i)
    if (code >= 0x4e00 && code <= 0x9fff) {
      grams.add(t[i]) // 单字（短查询召回关键）
      if (i + 1 < t.length) {
        const next = t.charCodeAt(i + 1)
        if (next >= 0x4e00 && next <= 0x9fff) grams.add(t.slice(i, i + 2)) // 2-gram（精排）
      }
    }
  }
  ;(t.match(/[a-z0-9]{2,}/g) || []).forEach((w) => grams.add(w))
  return grams
}

/** query 覆盖率：max(query 覆盖率, doc 覆盖率)。短查询靠 query 覆盖率；长查询（含多意图词）
 *  不被稀释——改用 doc 覆盖率（命中文档的比例）兜底，避免"定时任务资讯推送"这类长 query 漏召回。 */
function coverage(qTokens, docTokens) {
  if (!qTokens?.size) return 0
  let n = 0
  for (const t of qTokens) if (docTokens?.has(t)) n++
  const qCov = n / qTokens.size
  const dCov = docTokens?.size ? n / docTokens.size : 0
  return Math.max(qCov, dCov)
}

/** 从 name/description 派生发现用关键词（内联以避免与 skill 模块耦合；逻辑同 skill/index.js） */
function deriveKeywords(tool) {
  const out = new Set()
  const push = (s) => { const t = String(s || '').trim(); if (t) out.add(t) }
  for (const seg of String(tool.name || '').split(/[-_/\s]+/)) if (seg.length >= 2) push(seg)
  const desc = String(tool.description || '')
  ;(desc.match(/[一-龥]{2,}/g) || []).forEach(push)
  ;(desc.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []).forEach(push)
  return [...out].slice(0, 16)
}

export { brief }
