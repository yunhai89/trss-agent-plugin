/**
 * spawn_subagent —— 主 Agent 自主创建子代理委派任务（agent-as-tool，§3.2）。
 *
 * 让 LLM 自己判断「这个任务需要拆给子代理做」，动态构造 SubagentSpec + 隔离执行。
 * 复用 model/multiagent/ 的全部基础设施（SubagentSpec / Semaphore / Trace）。
 *
 * 安全约束（硬编码）：
 *   ① 工具白名单：子代理只能用 category==='query' 的工具（web_search/memory_search 等），群管/系统/终端不可。
 *   ② 无递归：子代理工具集不含 spawn_subagent 自身。
 *   ③ 无审批：子代理是独立 Agent，不传 guard/policy/confirm（纯隔离，复用 SubagentSpec.runTask 设计）。
 *   ④ 并发上限：Semaphore 进程级限流。
 *   ⑤ 配额：单次主对话最多 spawn N 个（防失控烧 token）。
 */
import { SubagentSpec } from './subagent.js'
import { Semaphore, Trace } from './support.js'
import { ToolRegistry } from '../agent/tools/registry.js'
import Log from '../../utils/Log.js'

/** 子代理角色 systemPrompt 模板 */
const FOCUS_PROMPTS = {
  research: '你是一个信息检索子代理。你的任务是搜索和整理信息。直接给出结论和关键事实，附引用来源。不要解释搜索过程。',
  analysis: '你是一个分析子代理。你的任务是分析给定信息并给出洞察。直接给出分析结论，结构清晰，不要废话。',
  writing: '你是一个写作子代理。你的任务是根据要求生成文本。直接输出成品文本，不要解释创作思路。',
  code: '你是一个代码子代理。你的任务是编写或分析代码。直接给出代码或分析结果，不要解释过程。',
  default: '你是一个独立子代理。只做被委派的任务，直接给出结果。不要解释过程，不要做超出任务范围的事。任务自包含——你看不到主对话的上下文。',
}

const ALLOWED_TOOL_CATEGORIES = new Set(['query'])

/**
 * 构造子代理可用工具集（从主 registry 按名字取子集 + category 白名单过滤）。
 * @param {ToolRegistry} sourceRegistry 主 Agent 的 ToolRegistry
 * @param {string[]} names 模型请求的工具名列表
 * @param {string[]} defaultNames 默认工具名（模型未指定时用）
 * @returns {ToolRegistry|null} 新的独立 ToolRegistry（不含 spawn_subagent）
 */
function buildWorkerTools(sourceRegistry, names, defaultNames) {
  if (!sourceRegistry) return null
  const wanted = (Array.isArray(names) && names.length ? names : defaultNames).map(String)
  const workerReg = new ToolRegistry()
  for (const name of wanted) {
    // 硬白名单：跳过 spawn_subagent 自身（防递归）
    if (name === 'spawn_subagent') continue
    const tool = sourceRegistry.get(name)
    if (!tool) continue
    // 硬白名单：只允许 query 类（web_search/memory_search/calc 等无副作用工具）
    if (!ALLOWED_TOOL_CATEGORIES.has(tool.category || 'query')) {
      Log.debug('[spawn_subagent] 拒绝子代理使用非 query 工具:', name, 'category=' + tool.category)
      continue
    }
    workerReg.register(tool)
  }
  return workerReg
}

/**
 * 构造 spawn_subagent 工具。
 * @param {object} opts
 *   - provider: 主 Agent 的 Provider（复用）
 *   - model: 子代理模型（空=复用主模型）
 *   - sourceRegistry: 主 Agent 的 ToolRegistry（取工具子集）
 *   - semaphore?: Semaphore（并发限流，外部传入共享实例）
 *   - maxTurns?: 子代理工具循环上限（默认 10）
 *   - defaultTools?: 子代理默认工具名（默认 ['web_search','memory_search']）
 *   - maxSpawns?: 单次对话最多 spawn 数（默认 5）
 * @returns {object} 标准工具对象
 */
export function makeSpawnSubagentTool({
  provider,
  model = null,
  sourceRegistry = null,
  semaphore = null,
  maxTurns = 10,
  defaultTools = ['web_search', 'memory_search'],
  maxSpawns = 5,
} = {}) {
  if (!provider) throw new Error('makeSpawnSubagentTool: provider 必填')

  // per-conversation 配额计数器（闭包内维护）
  let _spawnCount = 0
  const trace = new Trace()

  return {
    name: 'spawn_subagent',
    description:
      '创建一个独立的子代理来执行子任务。子代理有自己的上下文，不会看到主对话历史，适合：需要多轮搜索/分析的复杂子任务、可并行处理的独立子任务、需要上下文隔离的工作。传入自包含的任务描述（目标+输出格式+边界），子代理完成后返回结果文本。',
    category: 'query',
    meta: { subagent: true, resultCap: 8000 },
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description: '给子代理的任务描述。必须自包含（子代理看不到主对话）：明确目标、期望的输出格式、任务边界。例如："搜索 DeepSeek V3 的最新发布信息，返回 3 条关键事实+来源链接"。',
          maxLength: 2000,
        },
        focus: {
          type: 'string',
          description: '子代理的专注方向（影响角色设定）：research（检索）/ analysis（分析）/ writing（写作）/ code（代码）。留空=通用。',
          enum: ['research', 'analysis', 'writing', 'code'],
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: '子代理可用的工具名列表（默认 web_search + memory_search）。只能用只读类工具（搜索/记忆/计算），群管/系统/终端类不可。',
        },
      },
      additionalProperties: false,
    },

    async execute(params = {}, ctx) {
      const task = String(params.task || '').trim()
      if (!task) return { error: 'task 不能为空' }

      // ① 配额检查
      if (_spawnCount >= maxSpawns) {
        return { error: `已达子代理上限（${maxSpawns} 个/对话）`, spawned: _spawnCount }
      }
      _spawnCount++

      // ② 构造子代理工具集（白名单过滤 + 防递归）
      const workerTools = buildWorkerTools(sourceRegistry, params.tools, defaultTools)

      // ③ 选 systemPrompt
      const focus = params.focus && FOCUS_PROMPTS[params.focus] ? params.focus : 'default'
      const systemPrompt = FOCUS_PROMPTS[focus]

      // ④ 动态构造 SubagentSpec
      const specName = `worker_${_spawnCount}_${focus}`
      const spec = new SubagentSpec({
        name: specName,
        description: `子代理 #${_spawnCount}（${focus}）`,
        systemPrompt,
        tools: workerTools,
        model,
        provider,
        maxTurns,
      })

      // ⑤ Semaphore 限流 + 执行
      const sem = semaphore || new Semaphore(3)
      Log.mark('[spawn_subagent]', `创建子代理 #${_spawnCount} focus=${focus} task="${task.slice(0, 60)}"`)
      trace.emit('delegate:start', { subagent: specName, task: task.slice(0, 120) })

      try {
        await sem.acquire()
        const result = await spec.runTask(task, { signal: ctx?.signal })
        trace.emit('delegate:end', { subagent: specName, resultLength: (result || '').length })
        Log.mark('[spawn_subagent]', `子代理 #${_spawnCount} 完成 len=${(result || '').length}`)
        return { ok: true, result, worker: specName, spawned: _spawnCount }
      } catch (e) {
        trace.emit('delegate:error', { subagent: specName, error: e?.message || String(e) })
        Log.warn('[spawn_subagent]', `子代理 #${_spawnCount} 失败:`, e?.message || e)
        return { ok: false, error: `子代理执行失败: ${e?.message || e}`, worker: specName }
      } finally {
        sem.release()
      }
    },
  }
}
