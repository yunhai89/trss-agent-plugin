/**
 * GEPA 主循环（Genetic-Pareto Prompt Evolution，JS 原生移植）—— 增强版。
 *
 * 增强点：
 *  1. 早停（patience）：连续 N 轮无改善则提前终止，省 token
 *  2. 自适应变异温度：根据 Pareto 前沿多样性动态调整——低多样性→高温度（探索）；高多样性→低温度（精化）
 *  3. 段落级交叉：optimizer 在选择父代后可调用 crossoverParagraph
 *
 * 算法：种群进化 + Pareto 多目标（score↑ / length↓）+ 反思式变异 + 约束门控 + 语法门控。
 */

import { evaluate as defaultEvaluate } from './evaluator.js'
import { runGates } from './gates.js'

/** 种子化 PRNG（mulberry32）→ () => number∈[0,1) */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function dominates(a, b) {
  if (a.score >= b.score && a.length <= b.length) {
    return a.score > b.score || a.length < b.length
  }
  return false
}

export function paretoFront(items) {
  return items.filter((a) => !items.some((b) => b !== a && dominates(b, a)))
}

export function pickBest(items) {
  if (!items.length) return null
  return items.slice().sort((a, b) => b.score - a.score || a.length - b.length)[0]
}

function tournamentSelect(pool, rng, k = 3) {
  if (!pool.length) return null
  if (pool.length === 1) return pool[0]
  const contestants = []
  for (let i = 0; i < Math.min(k, pool.length); i++) {
    contestants.push(pool[Math.floor(rng() * pool.length)])
  }
  return contestants.sort((a, b) => b.score - a.score || a.length - b.length)[0]
}

/**
 * 种群收敛（容量上限）。
 *
 * 曾是「同分排序后整体截断」：新后代 eval=null → 分数记 -1 → 永远排在最后被当轮丢弃，
 * 于是后代从未被评估过（GEPA 实际退化为"只评估初始种群"）；基线个体被淘汰后
 * 末尾的 `find(i => i.text === baseline)` 取不到 → baselineScore 归零、improved 失真。
 * 现在：① 未评估个体优先保留（否则永远轮不到评估）；② 基线个体优先保留（评分基准不能丢）。
 */
function capPopulation(population, maxSize, protectedText = null) {
  if (population.length <= maxSize) return
  const isProtected = (i) => protectedText != null && i.text === protectedText
  const keep = population.filter(isProtected)
  const rest = population.filter((i) => !isProtected(i))
  const unevaluated = rest.filter((i) => !i.eval)
  const evaluated = rest.filter((i) => i.eval)
  evaluated.sort((a, b) => (b.eval?.score ?? -1) - (a.eval?.score ?? -1) || (a.eval?.length ?? 0) - (b.eval?.length ?? 0))
  const room = Math.max(0, maxSize - keep.length)
  keep.push(...unevaluated.slice(0, room), ...evaluated.slice(0, Math.max(0, room - Math.min(room, unevaluated.length))))
  population.length = 0
  population.push(...keep.slice(0, maxSize))
}

function targetGoal(target) {
  return target?.goal || `${target?.type || 'text'} 优化目标${target?.name ? `（${target.name}）` : ''}`
}

/**
 * 计算 Pareto 前沿的多样性（length 的变异系数 CV）。
 * CV 低 → 候选趋同 → 需要高温度探索。
 * CV 高 → 候选分散 → 低温度精化即可。
 */
function paretoDiversity(front) {
  if (front.length < 2) return 0
  const lengths = front.map((f) => f.length)
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length
  if (mean === 0) return 0
  const variance = lengths.reduce((s, l) => s + (l - mean) ** 2, 0) / lengths.length
  return Math.sqrt(variance) / mean // 变异系数 CV
}

/**
 * @param {object} opts — 见下方字段（增强字段标注 ✨）
 */
export async function optimize(opts) {
  const {
    target, dataset, agentFactory, judge, mutator,
    gates = {},
    iterations = 5,
    populationSize = 6,
    offspringPerIter = 2,
    seed = 42,
    logger = () => {},
    evaluate = defaultEvaluate,
    patience = Infinity,           // ✨ 早停：连续 patience 轮无改善则终止
    useParagraphCrossover = true,  // ✨ 段落级交叉
  } = opts

  if (!target || target.text == null) throw new Error('optimize 需要 target.text（基线文本）')
  const baseline = target.text
  const goal = targetGoal(target)
  const rng = mulberry32(seed)

  // 初始种群
  const population = []
  const seedTexts = (await safe(mutator.seed({ goal, baseline, n: populationSize }))) || []
  const initialSet = []
  for (const t of [baseline, ...seedTexts]) {
    if (typeof t === 'string' && t.trim() && !initialSet.includes(t)) initialSet.push(t)
  }
  for (const t of initialSet) population.push({ text: t, eval: null })

  const history = []
  let bestScoreEver = -1
  let noImprovementCount = 0  // ✨ 早停计数器
  let stoppedEarly = false
  // 基线评分独立跟踪：种群收敛可能淘汰基线个体，末尾从种群反查会得到 0（improved 失真）
  let baselineEval = null

  for (let it = 0; it < iterations; it++) {
    // 0. 先按容量收敛（保留全部未评估后代，避免"刚生成就被淘汰、永远轮不到评估"）
    capPopulation(population, populationSize, baseline)

    // 1. 评估未评估候选（先过门控）
    for (const indiv of population) {
      if (indiv.eval) continue
      const g = runGates(indiv.text, baseline, gates)
      if (!g.passed) {
        indiv.eval = { candidate: indiv.text, score: 0, length: indiv.text.length, perCase: [], gateFailed: g.failures }
        continue
      }
      indiv.eval = await evaluate(indiv.text, dataset, { agentFactory, judge })
      indiv.eval.gatePassed = g.details
    }
    // 基线评估结果一旦出现就记住（此后即使个体被淘汰也有真实基准分）
    if (!baselineEval) {
      const bi = population.find((i) => i.text === baseline)
      if (bi?.eval) baselineEval = bi.eval
    }

    // 2. Pareto 前沿 + 本代最优
    const evaluated = population.filter((i) => i.eval)
    const flat = evaluated.map((i) => ({ ...i.eval, ref: i }))
    const front = paretoFront(flat)
    const best = pickBest(flat)

    // ✨ 早停判定
    if (best && best.score > bestScoreEver) {
      bestScoreEver = best.score
      noImprovementCount = 0
    } else {
      noImprovementCount++
    }

    history.push({
      iteration: it,
      bestScore: best?.score ?? 0,
      bestLength: best?.length ?? 0,
      paretoSize: front.length,
      population: evaluated.length,
      noImprovement: noImprovementCount, // ✨
    })
    logger('info', `iter ${it}: best ${(best?.score ?? 0).toFixed(3)} (len ${best?.length ?? 0}), pareto ${front.length}, noImprove ${noImprovementCount}`)

    // ✨ 早停触发
    if (noImprovementCount >= patience) {
      stoppedEarly = true
      logger('info', `早停：连续 ${patience} 轮无改善`)
      break
    }

    if (it === iterations - 1) break

    // 3. ✨ 自适应变异温度：Pareto 多样性低 → 高温探索；多样性高 → 低温精化
    const diversity = paretoDiversity(front)
    const temperature = Math.max(0.1, Math.min(1.0, 1.0 - diversity * 2)) // diversity 0→temp 1, diversity 0.5→temp 0

    // 4. 选择父代 + 反思变异 → 后代
    const pool = front.length ? front : flat
    const newOffspring = []

    for (let k = 0; k < offspringPerIter; k++) {
      const parent = tournamentSelect(pool, rng)
      if (!parent) continue

      // 变异（带温度）
      const mutatorOpts = { parent: parent.ref.text, evalResult: parent.ref.eval, goal, temperature }
      const variants = (await safe(mutator.mutate?.(mutatorOpts) || mutator(mutatorOpts))) || []

      for (const v of variants) {
        if (typeof v === 'string' && v.trim() && !population.some((i) => i.text === v)) {
          newOffspring.push({ text: v, eval: null })
        }
      }

      // ✨ 段落级交叉：偶数轮对两个 Pareto 前沿候选做交叉
      if (useParagraphCrossover && k === 0 && pool.length >= 2) {
        const p1 = pool[Math.floor(rng() * pool.length)]
        const p2 = pool[Math.floor(rng() * pool.length)]
        if (p1 !== p2 && mutator.crossoverParagraph) {
          const crossed = mutator.crossoverParagraph(p1.ref.text, p2.ref.text)
          for (const v of crossed) {
            if (typeof v === 'string' && v.trim() && !population.some((i) => i.text === v)) {
              newOffspring.push({ text: v, eval: null })
            }
          }
        }
      }
    }

    for (const o of newOffspring) population.push(o)
    // 不在此处 cap：新后代需要留到下一轮的评估步骤（见循环开头的 capPopulation）
  }

  // 收尾补评：评估发生在每轮开头，故最后一轮生成的后代从未被评估——补评一轮，
  // 否则最后一代永远进不了 best/pareto（等于白生成，GEPA 每轮 offspringPerIter 全浪费）
  for (const indiv of population) {
    if (indiv.eval) continue
    const g = runGates(indiv.text, baseline, gates)
    if (!g.passed) {
      indiv.eval = { candidate: indiv.text, score: 0, length: indiv.text.length, perCase: [], gateFailed: g.failures }
      continue
    }
    indiv.eval = (await safe(evaluate(indiv.text, dataset, { agentFactory, judge })))
      || { candidate: indiv.text, score: 0, length: indiv.text.length, perCase: [] }
    indiv.eval.gatePassed = g.details
  }
  capPopulation(population, populationSize, baseline)

  const evaluated = population.filter((i) => i.eval)
  const flat = evaluated.map((i) => ({ ...i.eval, ref: i }))
  const bestFlat = pickBest(flat)
  const best = bestFlat ? { text: bestFlat.ref.text, score: bestFlat.score, length: bestFlat.length, eval: bestFlat } : null
  const front = paretoFront(flat).map((f) => ({ text: f.ref.text, score: f.score, length: f.length }))
  // 基线分：优先用循环中记录的真实评估值；种群已不含基线时补评一次（绝不默认 0）
  let baselineEvalFinal = baselineEval || evaluated.find((i) => i.text === baseline)?.eval || null
  if (!baselineEvalFinal) {
    const g = runGates(baseline, baseline, gates)
    baselineEvalFinal = g.passed
      ? await safe(evaluate(baseline, dataset, { agentFactory, judge }))
      : { candidate: baseline, score: 0, length: baseline.length, perCase: [], gateFailed: g.failures }
  }
  const baselineScore = baselineEvalFinal?.score ?? 0

  return {
    best,
    baseline: { text: baseline, score: baselineScore, length: baseline.length },
    pareto: front,
    history,
    population: evaluated.map((i) => ({ text: i.text, score: i.eval.score, length: i.eval.length, gateFailed: i.eval.gateFailed || null })),
    improved: best ? best.score > baselineScore : false,
    iterations: history.length,
    actualIterations: history.length, // ✨ 实际迭代数（可能 < iterations 因早停）
    stoppedEarly,                     // ✨ 是否早停
    seed,
  }
}

async function safe(promise) {
  try {
    return await promise
  } catch {
    return null
  }
}
