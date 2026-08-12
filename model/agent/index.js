/**
 * 核心 Agent 框架 —— 公共出口。
 *
 * 协议无关的 ReAct Agent：可接任意 OpenAI/Anthropic 兼容模型（经 model/openai、model/anthropic），
 * 多轮自主调用工具直到完成，维护有界声明式记忆，支持流式/中断/预算/回调。零新增运行时依赖。
 *
 * 用法：
 *   import { Agent, createProvider, ToolRegistry, MemoryStore, createMemoryTool, msg } from '../../model/agent/index.js'
 *   import { presets as openaiPresets } from '../../model/openai/index.js'
 *
 *   const provider = createProvider({ protocol:'openai', ...openaiPresets.deepseek, apiKey, model:'deepseek-v4-pro' })
 *   const tools = new ToolRegistry().register(createMemoryTool(memory))
 *   const agent = new Agent({ provider, model:'deepseek-v4-pro', tools, memory, systemPrompt, maxTurns:50 })
 *   const { content } = await agent.run('北京天气？', { onDelta: s => reply(s) })
 */

import { Agent } from './Agent.js'
export { Agent } from './Agent.js'

export { createProvider, Provider, mapToolChoice, toolsToList } from './provider/index.js'
export { OpenAIProvider } from './provider/openai.js'
export { AnthropicProvider, toAnthropicMessages } from './provider/anthropic.js'
export { GeminiProvider, toGeminiSteps } from './provider/gemini.js'

export { ToolRegistry, ExecutionContext, ddgSearch, parseDDG, stripHtml, noteTools, clarifyTool, makeFailingTool, CLARIFY_TOOL_NAME } from './tools/index.js'

export { MemoryStore, MemoryLimitError, createMemoryTool, makeRecallTool } from './memory/index.js'

// 运营层（yunhai 补齐）
export { memoryKv, redisKv } from './store/kv.js'
export { SessionStore } from './session.js'
export { RecallStore, tokenize, jaccard, cosine } from './recall.js'
export { ScheduleStore, nodeScheduleAdapter, reminderSetTool, reminderListTool, reminderCancelTool, parseCron, scheduleTaskTool } from './schedule.js'
export { checkInput, analyze, isolate, systemHardening, PATTERNS, SENSITIVITY } from './guard.js'
export { decide, roleRank, categoryMinRole, visibleCategories, roleLabel, createPolicy, RANK, CATEGORY_MIN } from './policy.js'
export { ConfirmStore } from './confirm.js'
export { buildHelpHtml, buildChatListHtml, buildPersonaListHtml } from './render.js'

export {
  msg,
  parseArgs,
  stringifyArgs,
  cloneMessage,
  tokenEstimate,
  estimateMessages,
  normalizeUsage,
  mergeUsage,
} from './messages.js'
