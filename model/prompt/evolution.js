/**
 * Evolution 桥接 —— 把 evolution 引擎（GEPA）接入 Prompt 模板自动优化。
 *
 * 参照 prompt-engineering-guide.md §7.2（自动提示优化）：
 *   "有了 evalset 与 grader，GEPA 类工具才能运转"
 *   "手工 prompt 建立基线 → evalset 固化 → 优化器在 evalset 上搜索 → 产出 prompt 走人工评审"
 *
 * 用法：
 *   import { evolveTemplate } from '../../model/prompt/index.js'
 *   const result = await evolveTemplate({
 *     templateKey: 'agent',
 *     provider, model,
 *     evalset: [{ input: '你好', check: (out) => out.includes('你好') ? 1 : 0 }],
 *     iterations: 5,
 *   })
 *   // result.best.text = 优化后的 system prompt
 *   // result.report 可写盘供人工审查
 */

import { TEMPLATES } from './library.js'
import { PromptTemplate } from './versioning.js'
import { evolve, writeReport, createMutator } from '../evolution/index.js'

/**
 * 对一个 prompt 模板执行 GEPA 进化优化。
 *
 * @param {object} opts
 *   templateKey: TEMPLATES 的 key（如 'agent', 'researcher'）
 *   provider, model: 用于评估的 LLM
 *   evalset: 评测集 [{ input, check?(output)=>score } ]
 *   iterations?: 进化轮次（默认 5）
 *   gates?: 约束门控（默认 size+semantic+cache）
 *   reportDir?: 写报告目录（不传则不写）
 *   signal?: 中断信号
 *   mutator?: 自定义变异器（默认用 provider 驱动 LLM 变异；测试可注入 mock）
 * @returns {Promise<{ best, baseline, history, improved, templateKey, reportPaths? }>}
 */
export async function evolveTemplate({
  templateKey,
  provider,
  model,
  evalset,
  iterations = 5,
  populationSize = 6,
  gates,
  judge,
  reportDir,
  signal,
  mutator: optMutator,
  logger = () => {},
} = {}) {
  if (!templateKey) throw new Error('evolveTemplate 需要 templateKey')
  if (!provider) throw new Error('evolveTemplate 需要 provider')
  if (!evalset?.length) throw new Error('evolveTemplate 需要 evalset（至少 1 条）')

  const template = TEMPLATES[templateKey]
  if (!template) throw new Error(`未知模板：${templateKey}（可用：${Object.keys(TEMPLATES).join(', ')}）`)

  const currentText = template.system || template.toolGuidance || ''
  if (!currentText) throw new Error(`模板 ${templateKey} 没有 system 或 toolGuidance 可优化`)

  const goal = template.goal || `优化 ${templateKey} prompt 以在 evalset 上得分最高`

  // 默认门控（§3.2 Prompt 工程约束：size 防膨胀 / semantic 保语义 / cache 保前缀）
  const defaultGates = {
    size: { maxChars: currentText.length * 2 }, // 不超过原长 2 倍
    semantic: { minSimilarity: 0.2 },
    cache: { prefixKeepRatio: 0.2 },
    ...gates,
  }

  // agentFactory：用候选 prompt 装配一个单轮 Agent
  const agentFactory = (promptText) => ({
    async run(input) {
      const { Agent } = await import('../agent/Agent.js')
      const agent = new Agent({
        provider, model, systemPrompt: promptText, maxTurns: 1, logger: () => {},
      })
      return agent.run(input, { signal })
    },
  })

  // 变异通道（关键）：evolveTemplate 只有 provider/model，没有 agent。此前既没传 mutator，
  // evolve 的默认 createMutator({ agent: undefined }) 便退化为"原样返回"——seed 只给 baseline、
  // mutate 只给 parent，全部被种群去重丢弃 → 产出与当前 system 完全相同，却照样过门控并落盘。
  // 这里用 provider 自行驱动 LLM 变异（可被 opts.mutator 覆盖，便于测试注入 mock）。
  const mutator = optMutator || createMutator({
    agent: {
      async run(prompt) {
        const res = await provider.chat({
          model,
          messages: [{ role: 'user', content: String(prompt) }],
          stream: false,
          temperature: 0.8,
          max_tokens: Math.max(512, Math.min(4096, currentText.length * 2)),
          ...(signal ? { signal } : {}),
        })
        return { content: res?.content || '' }
      },
    },
  })

  logger('info', `[evolve] 开始优化模板 ${templateKey}（v${template.version}, ${currentText.length} chars, ${evalset.length} eval cases）`)

  const result = await evolve({
    target: { type: 'systemPrompt', name: templateKey, text: currentText, goal },
    dataset: evalset,
    agentFactory,
    judge,
    iterations,
    populationSize,
    seed: 42,
    gates: defaultGates,
    mutator,
    logger,
  })

  // 产出与当前文本完全相同 → 不算改进：绝不写盘（曾把"没变"当成进化通过并落盘新版本号）
  const unchanged = !!result.best && String(result.best.text) === String(currentText)
  if (unchanged) result.improved = false

  logger('info', `[evolve] 完成：baseline=${result.baseline.score.toFixed(3)} → best=${result.best.score.toFixed(3)} improved=${result.improved}${unchanged ? '（产出与当前文本相同，视为未改进）' : ''}`)

  // 写报告
  let reportPaths = null
  if (reportDir) {
    reportPaths = writeReport(result, reportDir)
  }

  return {
    ...result,
    templateKey,
    templateVersion: template.version,
    reportPaths,
    ...(unchanged ? { unchanged: true } : {}),
  }
}

/**
 * 批量优化多个模板。
 * @param {Array<{ key, evalset }>} items
 * @returns {Promise<Array>} 每个模板的优化结果
 */
export async function evolveTemplates({ items, provider, model, ...commonOpts }) {
  const results = []
  for (const item of items) {
    try {
      const r = await evolveTemplate({
        templateKey: item.key,
        provider, model,
        evalset: item.evalset,
        ...commonOpts,
      })
      results.push({ key: item.key, ...r })
    } catch (e) {
      results.push({ key: item.key, error: e?.message || String(e) })
    }
  }
  return results
}
