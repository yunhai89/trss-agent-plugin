/**
 * Multi-Agent 底座 —— 公共出口。
 *
 * 参照 multi-agent-patterns.md：
 *   - Orchestrator-Worker（§2.4，唯一被生产验证的多 agent 拓扑）
 *   - Agent-as-Tool 委派（§3.2，子代理=工具，独立上下文，压缩摘要回传）
 *   - Workflow 原语：pipeline(§2.1) / parallel(§2.3) / router(§2.2) / evaluatorOptimizer(§2.5)
 *   - 成本控制（Semaphore 并发上限 + maxTurns）、观测（Trace）、状态（SharedState）
 *
 * 用法：
 *   import { Orchestrator, SubagentSpec, pipeline, parallel } from '../../model/multiagent/index.js'
 *   const researcher = new SubagentSpec({ name:'researcher', provider, model:'cheap', tools, maxTurns:10 })
 *   const orch = new Orchestrator({ provider, model:'flagship', subagents:[researcher], maxTurns:20 })
 *   const { content, trace } = await orch.run('深度研究 AI Agent 行业')
 */

export { SubagentSpec, makeDelegationTool } from './subagent.js'
export { makeSpawnSubagentTool } from './spawn-tool.js'
export { Orchestrator, DEFAULT_ORCHESTRATOR_PROMPT } from './orchestrator.js'
export { pipeline, parallel, router, evaluatorOptimizer, runStep } from './patterns.js'
export { Semaphore, Trace, SharedState } from './support.js'
