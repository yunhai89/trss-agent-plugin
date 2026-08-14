/**
 * spawn_subagent + check_subagent + extend_subagent —— 异步子代理委派三件套。
 *
 * 架构（对齐用户要求）：
 *   spawn_subagent(task, timeBudgetMs) → 立即返回 taskId（非阻塞，子代理后台跑）。
 *   check_subagent(taskId) → 查看状态（running/done/failed/timeout）+ 进度。
 *   extend_subagent(taskId, extraMs) → 快到预算但还在跑 → 续期。
 *
 * 主 Agent 不再阻塞等待子代理——它在后续轮次用 check_subagent 轮询，
 * governor 看到每轮都有新工具调用（= progress），不会因 time_budget 杀掉。
 *
 * 安全约束（同前）：① 工具白名单 category==='query' ② 无递归 ③ Semaphore 并发限流 ④ 配额。
 */
import { SubagentSpec } from './subagent.js'
import { Semaphore, Trace } from './support.js'
import { ToolRegistry } from '../agent/tools/registry.js'
import Log from '../../utils/Log.js'

const FOCUS_PROMPTS = {
  research: '你是一个信息检索子代理。你的任务是搜索和整理信息。直接给出结论和关键事实，附引用来源。不要解释搜索过程。',
  analysis: '你是一个分析子代理。你的任务是分析给定信息并给出洞察。直接给出分析结论，结构清晰，不要废话。',
  writing: '你是一个写作子代理。你的任务是根据要求生成文本。直接输出成品文本，不要解释创作思路。',
  code: '你是一个代码子代理。你的任务是编写或分析代码。直接给出代码或分析结果，不要解释过程。',
  default: '你是一个独立子代理。只做被委派的任务，直接给出结果。不要解释过程，不要做超出任务范围的事。任务自包含——你看不到主对话的上下文。',
}

const ALLOWED_TOOL_CATEGORIES = new Set(['query'])

function buildWorkerTools(sourceRegistry, names, defaultNames) {
  if (!sourceRegistry) return null
  const wanted = (Array.isArray(names) && names.length ? names : defaultNames).map(String)
  const workerReg = new ToolRegistry()
  for (const name of wanted) {
    if (name === 'spawn_subagent' || name === 'check_subagent' || name === 'extend_subagent') continue
    const tool = sourceRegistry.get(name)
    if (!tool) continue
    if (!ALLOWED_TOOL_CATEGORIES.has(tool.category || 'query')) continue
    workerReg.register(tool)
  }
  return workerReg
}

/**
 * 构造子代理三件套工具（spawn + check + extend）。
 * @returns {Array<object>} 3 个标准工具对象
 */
export function makeSpawnSubagentTools({
  provider,
  model = null,
  sourceRegistry = null,
  semaphore = null,
  maxTurns = 10,
  defaultTools = ['web_search', 'memory_search'],
  maxSpawns = 5,
  defaultBudgetMs = 120000, // 默认 2 分钟
} = {}) {
  if (!provider) throw new Error('makeSpawnSubagentTools: provider 必填')

  let _spawnCount = 0
  const sem = semaphore || new Semaphore(3)
  const trace = new Trace()

  // 任务注册表（闭包内，per-runtime 隔离）
  // taskId → { status, startedAt, budgetMs, abort, _timeout, result, error, specName, _read }
  const _tasks = new Map()

  function _cleanupOld() {
    const now = Date.now()
    for (const [id, t] of _tasks) {
      if (now - t.startedAt > 10 * 60 * 1000) {
        if (t._timeout) clearTimeout(t._timeout)
        if (t.abort) try { t.abort.abort() } catch { /* noop */ }
        _tasks.delete(id)
      }
    }
  }

  // ── spawn_subagent（异步启动，立即返回 taskId）──
  const spawnTool = {
    name: 'spawn_subagent',
    description:
      '异步启动一个独立子代理执行子任务，立即返回 taskId（不阻塞）。子代理在后台独立运行，有自己的上下文和时间预算。' +
      '启动后用 check_subagent(taskId) 查看进度（running/done/failed/timeout），done 时返回完整结果。' +
      '快到时间预算但子代理还在跑，用 extend_subagent(taskId, extraMs) 续期。建议每 1-2 轮 check 一次。',
    category: 'query',
    meta: { subagent: true, resultCap: 8000 },
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'string', description: '自包含的任务描述（子代理看不到主对话）：目标+输出格式+边界。', maxLength: 2000 },
        focus: { type: 'string', description: '专注方向', enum: ['research', 'analysis', 'writing', 'code'] },
        tools: { type: 'array', items: { type: 'string' }, description: '子代理可用工具（默认 web_search+memory_search，仅只读类）' },
        timeBudgetMs: { type: 'integer', description: '子代理时间预算（毫秒，默认 120000=2 分钟）。超时则 timeout 终止。', default: 120000, minimum: 10000, maximum: 600000 },
      },
      additionalProperties: false,
    },

    async execute(params = {}, ctx) {
      const task = String(params.task || '').trim()
      if (!task) return { error: 'task 不能为空' }
      if (_spawnCount >= maxSpawns) return { error: `已达子代理上限（${maxSpawns} 个/对话）`, spawned: _spawnCount }

      _cleanupOld()
      _spawnCount++

      const budgetMs = Math.max(10000, Math.min(600000, Number(params.timeBudgetMs) || defaultBudgetMs))
      const focus = params.focus && FOCUS_PROMPTS[params.focus] ? params.focus : 'default'
      const specName = `worker_${_spawnCount}_${focus}`
      const taskId = `sub_${_spawnCount}_${Date.now().toString(36)}`

      // 构造子代理
      const workerTools = buildWorkerTools(sourceRegistry, params.tools, defaultTools)
      const spec = new SubagentSpec({
        name: specName, description: `子代理 #${_spawnCount}（${focus}）`,
        systemPrompt: FOCUS_PROMPTS[focus], tools: workerTools, model, provider, maxTurns,
      })

      // 预算超时控制
      const abort = new AbortController()
      const timeout = setTimeout(() => {
        try { abort.abort(new Error('子代理时间预算耗尽')) } catch { /* noop */ }
      }, budgetMs)

      // 注册任务
      const taskInfo = { status: 'queued', startedAt: Date.now(), budgetMs, abort, _timeout: timeout, result: null, error: null, specName, _read: false }
      _tasks.set(taskId, taskInfo)

      Log.mark('[spawn_subagent]', `异步创建子代理 ${taskId} focus=${focus} budget=${Math.round(budgetMs / 1000)}s task="${task.slice(0, 60)}"`)
      trace.emit('delegate:start', { subagent: specName, task: task.slice(0, 120), budgetMs })

      // 后台执行（不阻塞 execute 返回）
      ;(async () => {
        try {
          await sem.acquire()
          taskInfo.status = 'running'
          const result = await spec.runTask(task, { signal: abort.signal })
          taskInfo.status = 'done'
          taskInfo.result = result
          trace.emit('delegate:end', { subagent: specName, resultLength: (result || '').length })
          Log.mark('[spawn_subagent]', `${taskId} 完成 len=${(result || '').length}`)
        } catch (e) {
          const aborted = /abort|budget|signal/i.test(String(e?.message || e))
          taskInfo.status = aborted ? 'timeout' : 'failed'
          taskInfo.error = e?.message || String(e)
          trace.emit('delegate:error', { subagent: specName, error: taskInfo.error })
          Log.warn('[spawn_subagent]', `${taskId} ${taskInfo.status}:`, taskInfo.error?.slice(0, 80))
        } finally {
          sem.release()
          clearTimeout(timeout)
        }
      })()

      return {
        ok: true, taskId, status: 'queued', timeBudgetMs: budgetMs,
        message: `子代理 ${taskId} 已启动（预算 ${Math.round(budgetMs / 1000)} 秒）。下一轮调用 check_subagent("${taskId}") 查看进度。`,
      }
    },
  }

  // ── check_subagent（查看子代理状态 + 结果）──
  const checkTool = {
    name: 'check_subagent',
    description: '查看子代理任务状态。返回 status（queued=排队中/running=运行中/done=完成/failed=失败/timeout=超时）。done 时包含完整结果。快到预算时会提示用 extend_subagent 续期。',
    category: 'query',
    parameters: {
      type: 'object',
      required: ['taskId'],
      properties: { taskId: { type: 'string', description: 'spawn_subagent 返回的 taskId' } },
      additionalProperties: false,
    },
    execute(params = {}) {
      const t = _tasks.get(String(params.taskId || ''))
      if (!t) return { error: `未找到任务 ${params.taskId}（可能已过期或不存在）` }
      const elapsed = Date.now() - t.startedAt
      const remaining = Math.max(0, t.budgetMs - elapsed)
      const res = {
        taskId: params.taskId, status: t.status,
        elapsedMs: elapsed, budgetMs: t.budgetMs, remainingMs: remaining,
      }
      if (t.status === 'done') {
        res.result = t.result
        res.message = '子代理已完成，结果在 result 字段。可直接用于回复用户。'
      } else if (t.status === 'failed' || t.status === 'timeout') {
        res.error = t.error
        res.message = `子代理${t.status === 'timeout' ? '超时' : '失败'}：${t.error}`
      } else if (remaining < 30000) {
        res.hint = `⚠️ 仅剩 ${Math.round(remaining / 1000)} 秒，如需更多时间请调用 extend_subagent("${params.taskId}", 60000)`
      }
      return res
    },
  }

  // ── extend_subagent（续期）──
  const extendTool = {
    name: 'extend_subagent',
    description: '给还在运行的子代理追加时间预算。子代理快到时间但还没跑完时用。',
    category: 'query',
    parameters: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string', description: 'spawn_subagent 返回的 taskId' },
        extraMs: { type: 'integer', description: '追加的毫秒数（默认 60000=1 分钟）', default: 60000, minimum: 10000, maximum: 300000 },
      },
      additionalProperties: false,
    },
    execute(params = {}) {
      const t = _tasks.get(String(params.taskId || ''))
      if (!t) return { error: `未找到任务 ${params.taskId}` }
      if (t.status !== 'queued' && t.status !== 'running') return { taskId: params.taskId, status: t.status, message: '任务已结束，无需续期' }
      const extra = Math.max(10000, Math.min(300000, Number(params.extraMs) || 60000))
      t.budgetMs += extra
      // 重置超时定时器
      clearTimeout(t._timeout)
      const remaining = t.budgetMs - (Date.now() - t.startedAt)
      t._timeout = setTimeout(() => {
        try { t.abort.abort(new Error('子代理时间预算耗尽（续期后）')) } catch { /* noop */ }
      }, Math.max(1000, remaining))
      Log.mark('[spawn_subagent]', `${params.taskId} 续期 +${Math.round(extra / 1000)}s → 总预算 ${Math.round(t.budgetMs / 1000)}s 剩余 ${Math.round(remaining / 1000)}s`)
      return { ok: true, taskId: params.taskId, newBudgetMs: t.budgetMs, remainingMs: Math.max(0, remaining) }
    },
  }

  return [spawnTool, checkTool, extendTool]
}

/** 向后兼容：旧代码只取第一个工具（spawn_subagent） */
export function makeSpawnSubagentTool(opts = {}) {
  return makeSpawnSubagentTools(opts)[0]
}
