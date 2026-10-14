/**
 * DeepResearch —— 深度搜索与研究引擎。
 *
 * 参照 deep-research-best-practices.md 完整实现五阶段管线 + 双层循环（§3.1-3.5 / §5 / §6.3）：
 *
 *   Scope（§3.1：澄清 + Brief）
 *   → Plan（§3.1：委派模板四要素 + §3.3 任务-策略路由）
 *   → Iterate（§3.2：外层 Supervisor 覆盖判断/重规划 + 内层子代理 tool-calling loop）
 *       ↳ 内层：SubagentSpec 隔离上下文 → 搜索→评估→精炼发现（§3.5 第一层压缩）
 *       ↳ 外层：覆盖检查 → 缺口→重规划→新轮（§3.2 终止三件套：预算+阈值+分级）
 *   → Synthesize（§3.5 第二层+第三层：跨源融合 + one-shot 成稿 + 置信度标注）
 *   → Cite（§3.5 独立 CitationAgent：引用校验 + 来源质量标记）
 *   → Evaluate（§6.3：五维 rubric 评估 + 快速规则检查）
 *
 * 复用底座：
 *   model/multiagent/SubagentSpec（隔离子代理）
 *   model/search/SearchManager（多源路由 + 回退链）
 *   model/prompt/TEMPLATES（预优化 prompt）
 *   model/agent/Agent（LLM 调用）
 *
 * 本文件聚焦"引擎编排"；状态管理在 state.js、评估在 evaluation.js。
 */
import { Agent } from '../agent/Agent.js'
import { SubagentSpec } from '../multiagent/subagent.js'
import { ToolRegistry } from '../agent/tools/registry.js'
import { Semaphore, Trace } from '../multiagent/support.js'
import { formatResults } from '../search/base.js'
import { TEMPLATES, inject } from '../prompt/index.js'
import {
  ResearchState,
  routeStrategy,
  EFFORT_CONFIG,
} from './state.js'
import { evaluateReport, quickCheck } from './evaluation.js'

export class DeepResearch {
  constructor({
    provider,
    model,
    searchManager,
    workerModel,
    workerProvider,
    maxRounds = 3, // 外层 Supervisor 最大轮次（§3.2 每轮可派多子代理）
    maxToolCallsPerWorker = 200,
    maxConcurrent = 3,
    logger = () => {},
    enableEvaluation = true,
  } = {}) {
    if (!provider) throw new Error('DeepResearch 需要 provider')
    if (!searchManager) throw new Error('DeepResearch 需要 searchManager')
    this.provider = provider
    this.model = model
    this.searchManager = searchManager
    this.workerModel = workerModel || model
    this.workerProvider = workerProvider || provider
    this.maxRounds = maxRounds
    this.maxToolCallsPerWorker = maxToolCallsPerWorker
    this.maxConcurrent = maxConcurrent
    this.logger = logger
    this.enableEvaluation = enableEvaluation
  }

  /**
   * 运行深度研究。
   * @param {string} query 用户研究请求
   * @param {object} opts { signal, callbacks: { onPhase, onRound, onDelegate, onFinding } }
   * @returns {Promise<{ brief, rounds, findings, report, citations, evaluation, trace, state }>}
   */
  async run(query, opts = {}) {
    const signal = opts.signal || null
    const cb = opts.callbacks || {}
    const trace = new Trace()
    const state = new ResearchState({ maxRounds: this.maxRounds, maxToolCalls: this.maxRounds * this.maxToolCallsPerWorker * 5 })
    const semaphore = new Semaphore(this.maxConcurrent)
    const __start = Date.now()
    this.logger('mark', `[DR] start query="${query}" model=${this.model} worker=${this.workerModel} maxRounds=${this.maxRounds} concurrent=${this.maxConcurrent}`)

    // ═══ 阶段 1：Scope（§3.1 澄清 + 研究简报）═══
    trace.emit('scope:start', { query })
    cb.onPhase?.('scope', { query })
    state.brief = await this._scope(query, signal)
    trace.emit('scope:end', { brief: state.brief })
    this.logger('info', `[DR] Scope: type=${state.brief.type}, effort=${state.brief.effort}, ${state.brief.subquestions?.length || 0} 子问题`)

    // 任务-策略路由（§3.3 决策矩阵）
    const strategy = routeStrategy(state.brief)
    trace.emit('strategy', { strategy })
    this.logger('info', `[DR] Strategy: ${strategy.reason}`)

    // ═══ 阶段 2+3：Plan + Iterate（双层循环）═══
    // 外层 Supervisor Loop（§3.2）：覆盖判断 → 重规划 → 新轮
    while (!state.budgetExhausted) {
      if (signal?.aborted) break
      state.round++
      trace.emit('round:start', { round: state.round })
      cb.onRound?.({ round: state.round, state: this._stateSummary(state) })

      // Plan：生成本轮子任务（§3.1 委派模板四要素）
      const plan = this._makePlan(state, strategy)
      if (!plan.length) {
        this.logger('info', `[DR] 轮 ${state.round}: 无新任务——进入综合`)
        break
      }
      trace.emit('plan', { round: state.round, taskCount: plan.length })
      this.logger('info', `[DR] 轮 ${state.round}: ${plan.length} 个子任务`)

      // 内层：并行执行子代理（§3.2 内层 tool-calling loop）
      const promises = plan.map((task) => this._runWorker(task, state, semaphore, trace, cb, signal))
      await Promise.allSettled(promises)

      trace.emit('round:end', { round: state.round, findingsCount: state.findings.length })
      this.logger('info', `[DR] 轮 ${state.round} 完成: ${state.findings.length} findings, ${state.visitedUrls.size} URLs, ${state.toolCalls} tool calls`)

      // 覆盖判断（§3.2 终止条件：综合阈值）
      const coverage = state.getCoverageReport()
      trace.emit('coverage', { round: state.round, ...coverage })
      if (coverage.covered) {
        this.logger('info', `[DR] 覆盖完成: ${coverage.coveredCount}/${coverage.total} 子问题已覆盖`)
        break
      }
      if (coverage.gaps.length) {
        // 有缺口 → 更新 brief 的子问题为未覆盖项，下一轮重新规划（§3.2 重规划）
        this.logger('info', `[DR] 发现缺口: ${coverage.gaps.join('; ')}——进入新一轮`)
        state.brief._gaps = coverage.gaps // 供 _makePlan 使用
      }
    }

    // ═══ 阶段 4：Synthesize（§3.5 one-shot 成稿）═══
    trace.emit('synthesize:start')
    cb.onPhase?.('synthesize', { findingsCount: state.findings.length })
    const report = await this._synthesize(state, signal)
    trace.emit('synthesize:end', { reportLength: report.length })
    this.logger('info', `[DR] Synthesize: ${report.length} chars`)

    // ═══ 阶段 5：Cite（§3.5 独立 CitationAgent）═══
    trace.emit('cite:start')
    cb.onPhase?.('cite', { report })
    const cited = await this._cite(report, state, signal)
    trace.emit('cite:end', { citedLength: cited.length })
    this.logger('info', `[DR] Cite: cited=${cited.length} chars, citations=${state.getAllCitations().length}`)

    // ═══ 阶段 6：Evaluate（§6.3 五维 rubric）═══
    let evaluation = null
    if (this.enableEvaluation) {
      trace.emit('evaluate:start')
      cb.onPhase?.('evaluate', { report: cited })
      evaluation = await this._evaluate(query, cited, state, signal)
      trace.emit('evaluate:end', { pass: evaluation?.pass })
      this.logger('info', `[DR] Evaluate: pass=${evaluation?.pass} score=${evaluation?.score ?? '-'}`)
    }

    this.logger('mark', `[DR] done query="${query}" rounds=${state.round} findings=${state.findings.length} urls=${state.visitedUrls.size} toolCalls=${state.toolCalls} reportLen=${cited.length} pass=${evaluation?.pass ?? '-'} totalMs=${Date.now() - __start}`)
    return {
      brief: state.brief,
      rounds: state.round,
      findings: state.findings,
      report: cited,
      rawReport: report,
      citations: state.getAllCitations(),
      evaluation,
      trace,
      state: this._stateSummary(state),
    }
  }

  // ═══ 阶段实现 ═══

  /** Scope：生成研究简报（§3.1） */
  async _scope(query, signal) {
    const agent = new Agent({
      provider: this.provider, model: this.model,
      systemPrompt: TEMPLATES.scope.system, maxTurns: 1, logger: () => {},
    })
    const { content } = await agent.run(query, { signal })
    return this._parseBrief(content) || {
      intent: query, subquestions: [query], type: 'open', effort: 'medium',
    }
  }

  /** Plan：生成本轮子任务（§3.1 委派模板 + §3.3 按策略路由） */
  _makePlan(state, strategy) {
    // 如果有缺口（上轮未覆盖），优先研究缺口
    const subs = state.brief._gaps?.length ? state.brief._gaps : state.brief.subquestions || []
    // 过滤掉已有充分发现的子问题（简单判断：findings 中已有 result 含子问题关键词）
    const coveredText = state.findings.map((f) => f.task + ' ' + f.result).join(' ')
    const remaining = subs.filter((sq) => {
      const kw = (sq.match(/[一-鿿]{2,}|[a-zA-Z]{3,}/g) || []).slice(0, 3)
      return kw.length === 0 || !kw.every((k) => coveredText.includes(k))
    })
    if (!remaining.length) return []
    const count = Math.min(remaining.length, strategy.agents)
    return remaining.slice(0, count).map((sq, i) => ({
      objective: sq,
      prompt: this._buildDelegationPrompt(sq, state, i, count),
    }))
  }

  /** 构造委派 prompt（§3.1 Anthropic 委派四要素：目标 + 输出格式 + 工具指引 + 边界） */
  _buildDelegationPrompt(subquestion, state, idx, total) {
    const priorFindings = state.findings.length
      ? `\n已有发现概要（供参考，不要重复已找到的信息）：\n${state.findings.map((f) => `- ${f.task}: ${f.result.slice(0, 100)}...`).join('\n')}`
      : ''
    return [
      `研究任务：${subquestion}`,
      `\n这是关于「${state.brief.intent}」的研究的第 ${idx + 1}/${total} 部分。`,
      priorFindings,
      `\n输出格式：精炼结论（200-500 字），附引用 URL。只输出清洗后的结论，不要输出原始搜索结果。`,
      `\n任务边界：只研究上述子问题，不要覆盖其他子问题。`,
      `\n搜索建议：先做 2-3 次宽查询探明信息版图，再逐步收窄深入。优先权威一手来源。`,
    ].join('')
  }

  /** 内层：执行单个子代理（§3.2 tool-calling loop + §3.5 第一层压缩） */
  async _runWorker(task, state, semaphore, trace, cb, signal) {
    await semaphore.acquire()
    const __t0 = Date.now()
    try {
      trace.emit('delegate:start', { task: task.objective, round: state.round })
      cb.onDelegate?.({ task, round: state.round })
      this.logger('info', `delegate start round=${state.round} task="${task.objective}"`)

      // 构造隔离子代理（§3.5 独立上下文）
      const researcher = new SubagentSpec({
        name: `r${state.round}_${task.objective.slice(0, 10)}`,
        description: task.objective,
        systemPrompt: TEMPLATES.researcher.system,
        tools: this._buildWorkerTools(state),
        model: this.workerModel,
        provider: this.workerProvider,
        maxTurns: this.maxToolCallsPerWorker,
      })

      const result = await researcher.runTask(task.prompt, { signal })
      const citations = this._extractUrls(result)

      state.addFinding({ task: task.objective, result, citations, round: state.round })
      trace.emit('delegate:end', { task: task.objective, resultLength: result.length, citations: citations.length })
      cb.onFinding?.({ task: task.objective, result, round: state.round })
      this.logger('info', `delegate done round=${state.round} task="${task.objective}" resultLen=${result.length} citations=${citations.length} ms=${Date.now() - __t0}`)
    } catch (e) {
      state.addFinding({ task: task.objective, result: `（研究失败：${e?.message || e}）`, citations: [], round: state.round })
      trace.emit('delegate:error', { task: task.objective, error: e?.message })
      this.logger('warn', `delegate error round=${state.round} task="${task.objective}"`, e?.message || e)
    } finally {
      semaphore.release()
    }
  }

  /** 构造子代理工具集（搜索 + 去重） */
  _buildWorkerTools(state) {
    const self = this
    const reg = new ToolRegistry()
    reg.register({
      name: 'web_search',
      description: '联网搜索。输入查询词，返回相关结果。',
      category: 'query',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async execute(params = {}) {
        if (!state.consumeToolCall()) return '已达到工具调用上限'
        self.logger('debug', `search round=${state.round} query="${params.query}"`)
        const result = await self.searchManager.search(params.query)
        // §5.2 跨轮去重
        const deduped = (result.results || []).filter((r) => state.shouldVisit(r.url))
        self.logger('debug', `search done query="${params.query}" hits=${deduped.length} visited=${state.visitedUrls.size}`)
        return formatResults({ ...result, results: deduped })
      },
    })
    return reg
  }

  /** Synthesize：跨源融合 + one-shot 成稿（§3.5 第二+三层） */
  async _synthesize(state, signal) {
    const findingsText = state.findings.map((f, i) =>
      `## 发现 ${i + 1}（轮次 ${f.round}）：${f.task}\n${f.result}\n${f.citations?.length ? '引用：' + f.citations.join(', ') : ''}`,
    ).join('\n\n')
    const sourceStats = `来源质量分布：权威 ${state.sourceQuality.high} / 普通 ${state.sourceQuality.medium} / 低质 ${state.sourceQuality.low}`
    const prompt = [
      `# 研究简报`,
      `意图：${state.brief.intent}`,
      `子问题：${(state.brief.subquestions || []).join('；')}`,
      `\n# 各子代理研究发现（共 ${state.findings.length} 条）`,
      findingsText,
      `\n# 来源统计`,
      sourceStats,
      `\n# 要求`,
      '基于以上发现撰写结构化研究报告。',
      '每条事实性声明标注 [n] 引用编号，末尾列出来源列表。',
      '不确定的结论标注置信度（高/中/低）。',
      '如有矛盾信息，单列"争议点"小节。',
    ].join('\n')
    const agent = new Agent({
      provider: this.provider, model: this.model,
      systemPrompt: TEMPLATES.synthesis.system, maxTurns: 1, logger: () => {},
    })
    const { content } = await agent.run(prompt, { signal })
    return content || '(综合失败)'
  }

  /** Cite：引用后处理（§3.5 CitationAgent + §8.7 引用虚设防护） */
  async _cite(report, state, signal) {
    const allCitations = state.getAllCitations()
    if (!allCitations.length) return report
    const prompt = [
      `# 待校验报告`,
      report,
      `\n# 来源列表`,
      allCitations.map((u, i) => `[${i + 1}] ${u} (${getSourceLabel(u)})`).join('\n'),
    ].join('\n')
    const agent = new Agent({
      provider: this.provider, model: this.model,
      systemPrompt: TEMPLATES.citation.system, maxTurns: 1, logger: () => {},
    })
    const { content } = await agent.run(prompt, { signal })
    return content || report
  }

  /** Evaluate：五维 rubric + 快速规则检查（§6.3） */
  async _evaluate(query, report, state, signal) {
    const quick = quickCheck({ report, findings: state.findings, brief: state.brief })
    const llm = await evaluateReport({
      provider: this.provider, model: this.model,
      query, report, citations: state.getAllCitations(), signal,
    }).catch(() => null)
    return { quick, llm }
  }

  // ═══ 工具方法 ═══

  _parseBrief(text) {
    if (!text) return null
    try {
      const match = text.match(/\{[\s\S]*\}/)
      if (match) {
        const p = JSON.parse(match[0])
        return {
          intent: p.intent || '',
          subquestions: Array.isArray(p.subquestions) ? p.subquestions : [],
          type: p.type || 'open',
          effort: EFFORT_CONFIG[p.effort] ? p.effort : 'medium',
        }
      }
    } catch { /* fall through */ }
    return null
  }

  _extractUrls(text) {
    const urls = new Set()
    const re = /https?:\/\/[^\s\])\]]+/g
    let m
    while ((m = re.exec(text || ''))) urls.add(m[0])
    return [...urls]
  }

  _stateSummary(state) {
    return {
      round: state.round,
      findings: state.findings.length,
      visitedUrls: state.visitedUrls.size,
      toolCalls: state.toolCalls,
      elapsed: state.elapsed,
      sourceQuality: { ...state.sourceQuality },
    }
  }
}

function getSourceLabel(url) {
  if (/(\.gov|\.edu|wikipedia\.org|arxiv\.org|github\.com|nature\.com|science\.org)/i.test(url)) return '权威'
  if (/(pinterest\.com|reddit\.com|quora\.com)/i.test(url)) return '低质'
  return '普通'
}
