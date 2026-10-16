/**
 * DeepResearch 评估框架 —— LLM-as-Judge 五维 rubric（文档 §6.3）。
 *
 * 五维（Anthropic 官方 rubric [4]）：
 *   1. 事实准确性（accuracy）
 *   2. 引用准确性（citations）
 *   3. 完整性（completeness）
 *   4. 来源质量（sourceQuality）
 *   5. 工具效率（efficiency）
 *
 * 判定：二值/三值优于细粒度打分（§3.5.3 / §8.3 E6）。
 */
import { Agent } from '../agent/Agent.js'
import { TEMPLATES } from '../prompt/index.js'

/**
 * 用 LLM-as-Judge 评估研究报告。
 * @param {object} opts { provider, model, query, report, citations }
 * @returns {Promise<{ scores, pass, rationale }>}
 */
export async function evaluateReport({ provider, model, query, report, citations = [], signal } = {}) {
  const judge = new Agent({
    provider,
    model,
    systemPrompt: TEMPLATES.judge.system,
    maxTurns: 1,
    logger: () => {},
  })
  const prompt = [
    `# 用户原始查询\n${query}`,
    `\n# 研究报告\n${report}`,
    `\n# 引用来源列表\n${citations.length ? citations.map((u, i) => `[${i + 1}] ${u}`).join('\n') : '（无引用）'}`,
  ].join('\n')
  const { content } = await judge.run(prompt, { signal })
  return parseJudgeResult(content)
}

/**
 * 解析 judge 输出（容错 JSON）。
 */
export function parseJudgeResult(text) {
  if (!text) return defaultResult()
  try {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0])
      return {
        scores: {
          accuracy: clamp(parsed.scores?.accuracy),
          citations: clamp(parsed.scores?.citations),
          completeness: clamp(parsed.scores?.completeness),
          sourceQuality: clamp(parsed.scores?.sourceQuality),
          efficiency: clamp(parsed.scores?.efficiency),
        },
        pass: !!parsed.pass,
        rationale: parsed.rationale || '',
      }
    }
  } catch { /* fall through */ }
  return defaultResult()
}

function clamp(v) {
  const n = Number(v)
  return Number.isNaN(n) ? 0 : Math.max(0, Math.min(1, n))
}

function defaultResult() {
  return {
    scores: { accuracy: 0, citations: 0, completeness: 0, sourceQuality: 0, efficiency: 0 },
    pass: false,
    rationale: 'judge output unparseable',
  }
}

/**
 * 研究报告质量快速检查（无 LLM，纯规则）。
 */
export function quickCheck({ report, findings, brief }) {
  const issues = []
  // 引用密度：报告长度 vs 引用数量
  const citationCount = (report.match(/\[\d+\]/g) || []).length
  const reportLength = report.length
  if (reportLength > 500 && citationCount < 2) {
    issues.push({ severity: 'warn', message: '报告较长但引用稀少——可能缺少来源支撑' })
  }
  // 子问题覆盖（元素类型不保证是字符串：模型可能给 [{question}]，直接 .match 会抛 TypeError）
  if (brief?.subquestions?.length) {
    const findingsText = (findings || []).map((f) => f.result).join(' ')
    const uncovered = brief.subquestions.filter((sq) => {
      const s = typeof sq === 'string' ? sq : String(sq?.question ?? sq?.task ?? sq?.text ?? '')
      if (!s.trim()) return false
      const kw = s.match(/[一-鿿]{2,}|[a-zA-Z]{3,}/g) || []
      return kw.length > 0 && !kw.some((k) => findingsText.includes(k))
    })
    if (uncovered.length > 0) {
      issues.push({ severity: 'warn', message: `${uncovered.length} 个子问题可能未被覆盖: ${uncovered.join('; ')}` })
    }
  }
  // 来源质量分布
  if (findings?.length) {
    const allUrls = findings.flatMap((f) => f.citations || [])
    const highCount = allUrls.filter((u) => /(\.gov|\.edu|wikipedia\.org|arxiv\.org|github\.com|nature\.com|science\.org)/i.test(u)).length
    if (allUrls.length > 0 && highCount / allUrls.length < 0.2) {
      issues.push({ severity: 'info', message: '权威来源占比较低——考虑优先 .gov/.edu/学术来源' })
    }
  }
  return { issues, passed: issues.filter((i) => i.severity === 'error').length === 0 }
}
