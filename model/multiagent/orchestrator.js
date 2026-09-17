/**
 * Orchestrator —— 动态分解 + 委派 + 综合。文档 §2.4 唯一被生产验证的多 agent 拓扑。
 *
 * 内部是一个 Agent（旗舰模型）+ 每个 SubagentSpec 注册为委派工具 + 综合 prompt。
 * 模型一次返回多个 delegate__* 工具调用 → Agent._executeToolCalls 的 Promise.all 并发执行（Semaphore 限流）。
 * 结果（压缩摘要）回到 Orchestrator → 综合 → 最终回复。
 *
 * 已接入（config 开关）：agent.multiagent.topology=orchestrator 时，apps 注册同步 `orchestrate`
 * 工具使用本类（通用 worker 子代理）；默认 topology=spawn 走 multiagent/spawn-tool.js 异步三件套。
 * patterns.js 仍为库导出（pipeline/parallel/router/evaluatorOptimizer），生产未直接使用。
 */
import { Agent } from '../agent/Agent.js'
import { ToolRegistry } from '../agent/tools/registry.js'
import { makeDelegationTool } from './subagent.js'
import { Semaphore, Trace } from './support.js'
import { TEMPLATES } from '../prompt/index.js'

export const DEFAULT_ORCHESTRATOR_PROMPT = TEMPLATES.orchestrator.system

export class Orchestrator {
  constructor({
    provider,
    model,
    systemPrompt,
    subagents = [],
    tools,
    maxTurns = 20,
    maxConcurrent = 3,
    trace,
    logger = () => {},
    ...agentConfig
  } = {}) {
    if (!provider) throw new Error('Orchestrator 需要 provider')
    if (!subagents.length && !tools) throw new Error('Orchestrator 需要 subagents 或 tools')
    this.provider = provider
    this.model = model
    this.systemPrompt = systemPrompt || DEFAULT_ORCHESTRATOR_PROMPT
    this.subagents = subagents
    this.tools = tools || null
    this.maxTurns = maxTurns
    this.maxConcurrent = maxConcurrent
    this.trace = trace || new Trace()
    this.logger = logger
    this.agentConfig = agentConfig
    this._semaphore = new Semaphore(maxConcurrent)
  }

  async run(task, opts = {}) {
    const registry = new ToolRegistry()
    for (const spec of this.subagents) {
      registry.register(makeDelegationTool(spec, { semaphore: this._semaphore, trace: this.trace }))
    }
    if (this.tools) {
      for (const t of this.tools.list()) {
        if (!registry.has(t.name)) registry.register(t)
      }
    }

    this.trace.emit('orchestrator:start', {
      task,
      subagents: this.subagents.map((s) => s.name),
      maxConcurrent: this.maxConcurrent,
    })

    const agent = new Agent({
      provider: this.provider,
      model: this.model,
      tools: registry,
      systemPrompt: this.systemPrompt,
      maxTurns: this.maxTurns,
      logger: this.logger,
      ...this.agentConfig,
    })

    const result = await agent.run(task, opts)
    this.trace.emit('orchestrator:end', { turns: result.turns, stopReason: result.stopReason })
    return { ...result, trace: this.trace }
  }
}
