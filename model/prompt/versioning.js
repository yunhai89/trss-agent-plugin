/**
 * Prompt 版本管理 + Fixtures + Eval 框架。
 * 参照 prompt-engineering-guide.md §3.2-3.3 工程规范。
 *
 *  PromptTemplate —— 带 id/version/owner/modelPin/changelog/variables 的 prompt 工件
 *  PromptRegistry —— 模板注册表（按 id+version 索引）
 *  runFixtures —— 快速单元测试（§3.5.1 fixtures 层）
 *  runEval —— 回归评测（§3.5.1 evalset 层 + §3.5.3 LLM-as-Judge）
 */

// ─── PromptTemplate（§3.2 模板文件规范）───

export class PromptTemplate {
  constructor({
    id,
    version = '1.0.0',
    owner = '',
    modelPin = '',
    system = '',
    userTemplate = '',
    variables = {},
    changelog = [],
    fixtures = [],
    evalset = [],
    goal = '',
  } = {}) {
    if (!id) throw new Error('PromptTemplate 需要 id')
    this.id = id
    this.version = version
    this.owner = owner
    this.modelPin = modelPin
    this.system = system
    this.userTemplate = userTemplate
    this.variables = variables
    this.changelog = Array.isArray(changelog) ? changelog : []
    this.fixtures = Array.isArray(fixtures) ? fixtures : []
    this.evalset = Array.isArray(evalset) ? evalset : []
    this.goal = goal
  }

  /** 添加 changelog 条目 */
  addChange(version, change, { evalRun = '', date = new Date().toISOString().slice(0, 10) } = {}) {
    this.changelog.unshift({ version, date, change, evalRun })
    this.version = version
  }

  /** 从 TEMPLATES 条目构造（便于给预优化模板补充元数据） */
  static fromTemplateEntry(key, entry, extra = {}) {
    return new PromptTemplate({
      id: key,
      version: entry.version || '1.0.0',
      system: entry.system || '',
      userTemplate: entry.userTemplate || '',
      goal: entry.goal || entry.description || '',
      ...extra,
    })
  }

  toJSON() {
    return {
      id: this.id, version: this.version, owner: this.owner, modelPin: this.modelPin,
      system: this.system, userTemplate: this.userTemplate, variables: this.variables,
      changelog: this.changelog, fixtures: this.fixtures, evalset: this.evalset, goal: this.goal,
    }
  }
}

// ─── PromptRegistry（注册表 + 版本索引）───

export class PromptRegistry {
  constructor() {
    this._templates = new Map() // key → PromptTemplate
  }

  register(template) {
    if (!(template instanceof PromptTemplate)) throw new Error('需要 PromptTemplate 实例')
    this._templates.set(template.id, template)
    return template
  }

  get(id) { return this._templates.get(id) || null }
  has(id) { return this._templates.has(id) }
  list() { return [...this._templates.values()] }
  ids() { return [...this._templates.keys()] }
  get size() { return this._templates.size }

  /** 批量注册（从对象） */
  registerAll(obj = {}) {
    for (const [key, entry] of Object.entries(obj)) {
      if (entry instanceof PromptTemplate) this.register(entry)
      else this.register(PromptTemplate.fromTemplateEntry(key, entry))
    }
    return this
  }
}

// ─── Fixtures 运行器（§3.5.1 fixtures 层：快速单元测试）───

/**
 * 运行 fixtures（每个 fixture = { input, check(output)=>bool|string }）。
 * @param {object} opts { template(system prompt), provider, model, fixtures }
 * @returns {Promise<{ passed, failed, results: [{fixture, pass, detail}] }>}
 */
export async function runFixtures({ system, provider, model, fixtures = [], signal } = {}) {
  const results = []
  let passed = 0
  let failed = 0

  for (const fx of fixtures) {
    const agent = new (await import('../agent/Agent.js')).Agent({
      provider, model, systemPrompt: system, maxTurns: 1, logger: () => {},
    })
    let output = ''
    try {
      const res = await agent.run(fx.input, { signal })
      output = res.content || ''
    } catch (e) {
      output = `ERROR: ${e?.message || e}`
    }

    let pass = false
    let detail = ''
    try {
      if (typeof fx.check === 'function') {
        const r = await fx.check(output)
        pass = r === true || r === 'pass'
        detail = typeof r === 'string' ? r : ''
      } else if (fx.expected) {
        pass = output.includes(fx.expected)
        detail = pass ? '' : `期望包含 "${fx.expected}"，实际: "${output.slice(0, 100)}"`
      } else {
        pass = true
      }
    } catch (e) {
      detail = `check threw: ${e?.message}`
    }

    results.push({ fixture: fx.input?.slice(0, 50), pass, detail })
    if (pass) passed++; else failed++
  }

  return { passed, failed, total: fixtures.length, results }
}

// ─── Eval 运行器（§3.5.1 evalset 层 + §3.5.3 LLM-as-Judge）───

/**
 * 运行 evalset 回归评测。
 * @param {object} opts { system, provider, model, evalset, judge?: {score}, signal }
 *   evalset 条目: { input, expected?, check?(output)=>{score,feedback} }
 *   judge: 可选 LLM judge（无 check 的条目用 judge 打分）
 * @returns {Promise<{ meanScore, passRate, results: [{input, score, pass}] }>}
 */
export async function runEval({ system, provider, model, evalset = [], judge, signal } = {}) {
  const results = []
  let sumScore = 0

  for (const item of evalset) {
    const agent = new (await import('../agent/Agent.js')).Agent({
      provider, model, systemPrompt: system, maxTurns: 1, logger: () => {},
    })
    let output = ''
    try {
      const res = await agent.run(item.input, { signal })
      output = res.content || ''
    } catch (e) {
      output = `ERROR: ${e?.message || e}`
    }

    let score = 0
    if (typeof item.check === 'function') {
      const r = await item.check(output)
      score = typeof r === 'number' ? r : (r?.score ?? 0)
    } else if (judge?.score) {
      const r = await judge.score(item, output)
      score = typeof r === 'number' ? r : (r?.score ?? 0)
    } else if (item.expected) {
      score = output.includes(item.expected) ? 1 : 0
    }
    score = Math.max(0, Math.min(1, score))
    sumScore += score
    results.push({ input: item.input?.slice(0, 50), score, pass: score >= 0.5 })
  }

  const meanScore = evalset.length ? sumScore / evalset.length : 0
  const passRate = results.filter((r) => r.pass).length / (results.length || 1)
  return { meanScore, passRate, count: results.length, results }
}

// ─── 回归门禁（§3.7 CI 门禁）───

/**
 * 检查新 prompt 版本是否通过回归门禁。
 * 已接入：apps/agent.js evolvePrompt 在落盘进化版本前调用（best 低于 baseline-0.01 或未达
 * minScore 则拒绝写入）。fixtures/eval 由 GEPA 进化过程产出（evalset + judge）。
 * @param {object} current { meanScore, passRate }
 * @param {object} baseline 上一版基线 { meanScore }
 * @param {object} gates { maxRegression(默认 0.01), minScore(默认 0.6) }
 * @returns {{ passed, reasons: [] }}
 */
export function regressionGate(current, baseline = {}, gates = {}) {
  const maxRegression = gates.maxRegression ?? 0.01
  const minScore = gates.minScore ?? 0.6
  const reasons = []

  if (baseline.meanScore != null && current.meanScore < baseline.meanScore - maxRegression) {
    reasons.push(`均分退化 ${((baseline.meanScore - current.meanScore) * 100).toFixed(1)}pp > ${maxRegression * 100}pp 阈值`)
  }
  if (current.meanScore < minScore) {
    reasons.push(`均分 ${current.meanScore.toFixed(3)} < 绝对门槛 ${minScore}`)
  }

  return { passed: reasons.length === 0, reasons }
}
