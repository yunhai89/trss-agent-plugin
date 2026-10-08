/**
 * Workflow 原语 —— 可组合的多 agent / 单 agent 工作流模式。对应文档 §2.1-2.5 的五种 Anthropic 原语。
 *
 * 每个 step 可为：Agent 实例 | SubagentSpec | 另一个 workflow({run}) | 几乎任何 async function(input, ctx)。
 * 所有模式返回统一的 { async run(input, ctx) → result } 接口，可互相嵌套。
 */
import { Agent } from '../agent/Agent.js'

/** 通用 step 执行器。取消信号随 ctx.signal 透传（P0-1 相邻路径：此前只传 ctx，step 收不到取消）。 */
export async function runStep(step, input, ctx = {}) {
  const signal = ctx?.signal || null
  const opts = signal ? { ctx, signal } : { ctx }
  if (step instanceof Agent) {
    const result = await step.run(input, opts)
    return result.content
  }
  if (step && typeof step.runTask === 'function') {
    return step.runTask(input, opts)
  }
  if (step && typeof step.run === 'function') {
    return step.run(input, ctx)
  }
  if (typeof step === 'function') {
    return step(input, ctx)
  }
  throw new Error(`runStep: 未知 step 类型 (${typeof step})`)
}

/**
 * Pipeline / Sequential（文档 §2.1）—— 固定顺序链，上一步输出喂下一步。
 * @param {Array} steps Agent | fn | SubagentSpec | workflow
 * @param {Array<fn>} gates 可选校验门（每步后执行，返回 false 则重跑该步）
 */
export function pipeline(steps = [], { gates = [] } = {}) {
  return {
    async run(input, ctx = {}) {
      let current = input
      for (let i = 0; i < steps.length; i++) {
        current = await runStep(steps[i], current, ctx)
        if (gates[i] && !(await gates[i](current, ctx))) {
          current = await runStep(steps[i], current, ctx) // 校验未过则重跑一次
        }
      }
      return current
    },
  }
}

/**
 * Parallel / Voting（文档 §2.3）—— 扇出 + Promise.all + 聚合。
 * @param {Array} tasks 每个并发执行的 step
 * @param {fn} aggregate (results[], originalInput, ctx) => merged
 */
export function parallel(tasks = [], { aggregate } = {}) {
  return {
    async run(input, ctx = {}) {
      const results = await Promise.all(tasks.map((t) => runStep(t, input, ctx)))
      if (typeof aggregate === 'function') return aggregate(results, input, ctx)
      return results
    },
  }
}

/**
 * Router（文档 §2.2）—— 分类器选路，路由到专门分支。
 * @param classify fn(input, ctx) => category | string
 * @param routes { category: step }
 * @param default 兜底 step
 */
export function router({ classify, routes = {}, default: defaultRoute } = {}) {
  return {
    async run(input, ctx = {}) {
      const category = typeof classify === 'function' ? await classify(input, ctx) : classify
      const route = routes[category] || defaultRoute
      if (!route) throw new Error(`router: 未匹配路由 "${category}" 且无 default`)
      return runStep(route, input, ctx)
    },
  }
}

/**
 * Evaluator-Optimizer（文档 §2.5）—— 生成→评估→反馈循环，硬终止（轮次 + 阈值）。
 * @param generator step（第一次收到 input；后续收到 {input, draft, feedback}）
 * @param evaluator step（收到 {input, draft}，返回 {score, feedback} 或数字）
 * @param maxIterations 最大重生成轮次
 * @param threshold 达标阈值（evaluator.score >= threshold 则退出）
 */
export function evaluatorOptimizer({
  generator,
  evaluator,
  maxIterations = 3,
  threshold = 0.8,
} = {}) {
  return {
    async run(input, ctx = {}) {
      let draft = await runStep(generator, input, ctx)
      for (let i = 0; i < maxIterations; i++) {
        const evalResult = await runStep(evaluator, { input, draft }, ctx)
        const score = typeof evalResult === 'number' ? evalResult : evalResult?.score ?? 0
        const feedback = typeof evalResult === 'object' ? evalResult?.feedback || '' : ''
        if (score >= threshold) break
        draft = await runStep(generator, { input, draft, feedback }, ctx)
      }
      return draft
    },
  }
}
