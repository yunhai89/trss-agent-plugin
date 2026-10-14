/**
 * DeepResearch 状态管理 —— 研究过程中的全部可变状态。
 * 对应文档 §3.2（计划外置 Memory）+ §5.2（去重与缓存）+ §5.1（预算追踪）。
 *
 * 核心状态：
 *  - brief：研究简报（北极星契约，§3.1）
 *  - plan：当前轮次的子任务列表
 *  - findings：已收集的发现（子任务 → 压缩结论 + 引用）
 *  - visitedUrls：跨轮共享已访问 URL 集合（§5.2 去重）
 *  - budget：预算追踪（轮次/工具调用/token）
 *  - round：当前研究轮次
 */
export class ResearchState {
  constructor({ maxRounds = 10, maxToolCalls = 100 } = {}) {
    this.brief = null
    this.plan = []
    this.findings = [] // [{ task, result, citations, round }]
    this.visitedUrls = new Set()
    this.visitedQueries = new Set()
    this.round = 0
    this.toolCalls = 0
    this.maxRounds = maxRounds
    this.maxToolCalls = maxToolCalls
    this.startTime = Date.now()
    this.conflicts = [] // 发现的矛盾信息（§3.4）
    this.sourceQuality = { high: 0, medium: 0, low: 0 } // 来源质量统计（§3.4）
  }

  /** 添加一条发现 */
  addFinding({ task, result, citations = [], round }) {
    this.findings.push({ task, result, citations, round: round ?? this.round })
    // 来源质量统计（§3.4：.gov/.edu/官方 = high，已知低质域 = low）
    for (const url of citations) {
      if (isHighQualitySource(url)) this.sourceQuality.high++
      else if (isLowQualitySource(url)) this.sourceQuality.low++
      else this.sourceQuality.medium++
    }
  }

  /** URL 去重（§5.2：跨轮共享已访问集合） */
  shouldVisit(url) {
    if (!url || this.visitedUrls.has(url)) return false
    this.visitedUrls.add(url)
    return true
  }

  /** 查询去重（避免子代理发完全相同的查询） */
  shouldQuery(query) {
    const normalized = query.trim().toLowerCase()
    if (this.visitedQueries.has(normalized)) return false
    this.visitedQueries.add(normalized)
    return true
  }

  /** 记录工具调用 + 检查预算 */
  consumeToolCall() {
    this.toolCalls++
    return this.toolCalls < this.maxToolCalls
  }

  /** 预算耗尽？ */
  get budgetExhausted() {
    return this.round >= this.maxRounds || this.toolCalls >= this.maxToolCalls
  }

  /** 检查子问题覆盖情况（§3.2 终止条件：综合阈值） */
  getCoverageReport() {
    const subs = this.brief?.subquestions || []
    if (!subs.length) return { covered: true, gaps: [] }
    const findingsText = this.findings.map((f) => f.result).join(' ')
    const gaps = subs.filter((sq) => {
      // 简单覆盖判断：子问题的关键词是否在发现中出现
      const keywords = extractKeywords(sq)
      return !keywords.some((kw) => findingsText.includes(kw))
    })
    return { covered: gaps.length === 0, gaps, total: subs.length, coveredCount: subs.length - gaps.length }
  }

  /** 收集所有引用 URL */
  getAllCitations() {
    const urls = new Set()
    for (const f of this.findings) for (const u of f.citations) urls.add(u)
    return [...urls]
  }

  /** 已用时间（秒） */
  get elapsed() {
    return Math.floor((Date.now() - this.startTime) / 1000)
  }
}

// ─── 来源可信度评估（§3.4 来源质量分级）───

const HIGH_QUALITY_TLDS = ['.gov', '.edu', '.mil']
const HIGH_QUALITY_DOMAINS = ['wikipedia.org', 'arxiv.org', 'github.com', 'nature.com', 'science.org', 'sciencedirect.com', 'springer.com', 'ieee.org', 'acm.org', 'who.int', 'un.org']
const LOW_QUALITY_DOMAINS = ['pinterest.com', 'reddit.com', 'quora.com'] // 用户生成内容降级

export function isHighQualitySource(url) {
  const u = String(url || '').toLowerCase()
  return HIGH_QUALITY_TLDS.some((tld) => u.includes(tld)) || HIGH_QUALITY_DOMAINS.some((d) => u.includes(d))
}

export function isLowQualitySource(url) {
  const u = String(url || '').toLowerCase()
  return LOW_QUALITY_DOMAINS.some((d) => u.includes(d))
}

export function scoreSourceQuality(url) {
  if (isHighQualitySource(url)) return 'high'
  if (isLowQualitySource(url)) return 'low'
  return 'medium'
}

// ─── 关键词提取（用于覆盖判断）───

function extractKeywords(text) {
  // 取长度 >= 2 的词（中文按字符切，英文按空格切）
  const cjk = text.match(/[一-鿿]{2,}/g) || []
  const eng = (text.match(/[a-zA-Z]{3,}/g) || []).map((w) => w.toLowerCase())
  return [...cjk, ...eng]
}

// ─── 任务-策略路由（§3.3 决策矩阵）───

export const EFFORT_CONFIG = {
  light: { agents: 1, maxTurns: 200, maxConcurrent: 1, description: '简单事实查询：1 agent' },
  medium: { agents: 4, maxTurns: 200, maxConcurrent: 3, description: '比较/列举类：3-5 agent' },
  heavy: { agents: 8, maxTurns: 200, maxConcurrent: 5, description: '复杂开放研究：5-10 agent' },
}

/**
 * 按任务类型 + effort 决定策略（§3.3 决策矩阵 + Anthropic 分级投入表）。
 */
export function routeStrategy(brief) {
  const { type, effort } = brief
  const config = EFFORT_CONFIG[effort] || EFFORT_CONFIG.medium
  // 验证类任务用少 agent 深串行（§3.3）
  if (type === 'verify') {
    return { ...config, agents: Math.min(config.agents, 2), maxConcurrent: 1, breadth: 'depth', reason: '验证类：来源质量 > 广度，少量 agent 深挖' }
  }
  // 比较类用并行（每个比较对象一个方向）
  if (type === 'compare') {
    return { ...config, breadth: 'breadth', reason: '比较类：每个对象分别搜索' }
  }
  // 列举类用宽并行
  if (type === 'enumerate') {
    return { ...config, agents: Math.max(config.agents, 4), breadth: 'breadth', reason: '列举类：覆盖面优先' }
  }
  return { ...config, breadth: 'mixed', reason: `${type || 'open'}：混合策略` }
}
