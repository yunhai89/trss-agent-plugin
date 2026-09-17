/**
 * spawn_subagent + check_subagent + extend_subagent —— 异步子代理委派三件套。
 *
 * 架构（对齐用户要求）：
 *   spawn_subagent(task, timeBudgetMs) → 立即返回 taskId（非阻塞，子代理后台跑）。
 *   check_subagent(taskId) → 查看状态（queued/running/done/failed/timeout）+ 进度。
 *   extend_subagent(taskId, extraMs) → 快到预算但还在跑 → 续期。
 *
 * 主 Agent 不再阻塞等待子代理——它在后续轮次用 check_subagent 轮询，
 * governor 看到结果签名变化（= progress）不计 duplicate_action（轮询工具 meta.polling 豁免）。
 *
 * 健壮性约束：
 *   ① 工具白名单 category==='query' ② 无递归 ③ Semaphore 并发限流
 *   ④ 配额「按会话」隔离（不再全局共享）⑤ taskId 绑定发起会话（跨会话不可读/不可操作）
 *   ⑥ 预算从真正开始运行起算 ⑦ 预算到点协作取消 + 硬宽限兜底强制释放并发槽
 *   ⑧ shutdown() 供热重载/退出时终止在跑子代理
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

const MIN_BUDGET_MS = 10000
const MAX_BUDGET_MS = 600000
const HARD_GRACE_MS = 30000 // 预算到点（协作取消）后，最多再等这么久；仍不结算就强制判超时并释放并发槽
const STALE_MS = 10 * 60 * 1000 // 终态任务保留时长 / 会话配额记录过期时长

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

/** 会话作用域键：配额与任务归属都按它隔离（与 Agent/session 的群:用户:会话同源） */
function scopeKeyOf(ctx) {
  if (!ctx) return 'global'
  const gid = ctx.groupId ? String(ctx.groupId) : 'private'
  const uid = String(ctx.scopeUserId || ctx.userId || 'unknown')
  const conv = ctx.conversationId != null ? String(ctx.conversationId) : 'default'
  return `${gid}:${uid}:${conv}`
}

/** 传给子代理的身份上下文子集：让 memory_search 等 query 工具可用，同时不带事件句柄/权限对象 */
function workerCtxOf(ctx) {
  if (!ctx) return undefined
  return {
    userId: ctx.userId,
    scopeUserId: ctx.scopeUserId,
    scopeId: ctx.scopeId,
    groupId: ctx.groupId,
    conversationId: ctx.conversationId,
  }
}

/**
 * 构造子代理三件套工具（spawn + check + extend）。
 * 返回的数组额外带一个不可枚举的 `shutdown()`：终止所有在跑任务并清空配额（热重载/退出用）。
 * @returns {Array<object> & { shutdown: () => number }}
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
  hardGraceMs = HARD_GRACE_MS, // 测试可调小
  minBudgetMs = MIN_BUDGET_MS,
} = {}) {
  if (!provider) throw new Error('makeSpawnSubagentTools: provider 必填')

  let _seq = 0 // 全局自增序号（taskId/specName 用；与配额无关）
  const sem = semaphore || new Semaphore(3)
  const trace = new Trace()

  // 任务注册表（闭包内，per-runtime 隔离）
  // taskId → { status, scope, createdAt, startedAt, finishedAt, budgetMs, abort, _budgetTimer, _hardTimer, _hardReject, result, error, specName }
  const _tasks = new Map()
  // 会话作用域 → { count, lastAt }：配额按会话计，不再全局共享（曾导致全体用户共用一个上限）
  const _spawnCounts = new Map()

  function _hardGrace() { return Math.max(0, Number(hardGraceMs) || 0) }

  /** 预算到点 → 协作取消；再等硬宽限仍不结算 → 强制判超时并让等待方放槽 */
  function _armTimers(taskId, t) {
    clearTimeout(t._budgetTimer); clearTimeout(t._hardTimer)
    const remaining = t.startedAt ? Math.max(1, t.budgetMs - (Date.now() - t.startedAt)) : t.budgetMs
    t._budgetTimer = setTimeout(() => {
      try { t.abort.abort(new Error('子代理时间预算耗尽')) } catch { /* noop */ }
    }, remaining)
    t._budgetTimer.unref?.()
    t._hardTimer = setTimeout(() => {
      try { t.abort.abort(new Error('子代理未响应取消（硬超时）')) } catch { /* noop */ }
      try { t._hardReject?.(new Error('子代理未响应取消（硬超时）')) } catch { /* noop */ }
    }, remaining + _hardGrace())
    t._hardTimer.unref?.()
  }

  function _cleanupOld() {
    const now = Date.now()
    for (const [id, t] of _tasks) {
      const terminal = t.status !== 'queued' && t.status !== 'running'
      const anchor = terminal ? (t.finishedAt || t.startedAt || t.createdAt) : (t.startedAt || t.createdAt)
      const ttl = terminal ? STALE_MS : (t.budgetMs + _hardGrace() + 5000)
      if (now - anchor > ttl) {
        clearTimeout(t._budgetTimer); clearTimeout(t._hardTimer)
        if (!terminal) { try { t.abort.abort(new Error('任务清理')) } catch { /* noop */ } }
        _tasks.delete(id)
      }
    }
    for (const [scope, c] of _spawnCounts) {
      if (now - c.lastAt > STALE_MS) _spawnCounts.delete(scope)
    }
  }

  /** 热重载/退出：终止在跑子代理（协作取消 + 硬释放），清空任务与配额 */
  function shutdown() {
    let n = 0
    for (const [, t] of _tasks) {
      if (t.status === 'queued' || t.status === 'running') {
        try { t.abort.abort(new Error('运行时关闭')) } catch { /* noop */ }
        try { t._hardReject?.(new Error('运行时关闭')) } catch { /* noop */ }
        clearTimeout(t._budgetTimer); clearTimeout(t._hardTimer)
        t.status = 'cancelled'
        n++
      }
    }
    _tasks.clear()
    _spawnCounts.clear()
    return n
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

      _cleanupOld()
      const scope = scopeKeyOf(ctx)
      const rec = _spawnCounts.get(scope) || { count: 0, lastAt: 0 }
      if (rec.count >= maxSpawns) return { error: `本会话子代理已达上限（${maxSpawns} 个/对话）`, spawned: rec.count }
      rec.count++
      rec.lastAt = Date.now()
      _spawnCounts.set(scope, rec)

      const budgetMs = Math.max(minBudgetMs, Math.min(MAX_BUDGET_MS, Number(params.timeBudgetMs) || defaultBudgetMs))
      const focus = params.focus && FOCUS_PROMPTS[params.focus] ? params.focus : 'default'
      _seq++
      const specName = `worker_${_seq}_${focus}`
      const taskId = `sub_${_seq}_${Date.now().toString(36)}`

      // 构造子代理（身份 ctx 子集随 run 传入，供 memory_search 等 query 工具使用）
      const workerTools = buildWorkerTools(sourceRegistry, params.tools, defaultTools)
      const workerCtx = workerCtxOf(ctx)
      const spec = new SubagentSpec({
        name: specName, description: `子代理 #${_seq}（${focus}）`,
        systemPrompt: FOCUS_PROMPTS[focus], tools: workerTools, model, provider, maxTurns,
      })

      const abort = new AbortController()
      const taskInfo = {
        status: 'queued', scope, createdAt: Date.now(), startedAt: null, finishedAt: null,
        budgetMs, abort, _budgetTimer: null, _hardTimer: null, _hardReject: null,
        result: null, error: null, specName,
      }
      _tasks.set(taskId, taskInfo)

      Log.mark('[spawn_subagent]', `异步创建子代理 ${taskId} scope=${scope} focus=${focus} budget=${Math.round(budgetMs / 1000)}s task="${task.slice(0, 60)}"`)
      trace.emit('delegate:start', { subagent: specName, task: task.slice(0, 120), budgetMs })

      // 后台执行（不阻塞 execute 返回）
      ;(async () => {
        let slotHeld = false
        try {
          await sem.acquire()
          slotHeld = true
          taskInfo.status = 'running'
          taskInfo.startedAt = Date.now() // 预算从真正开始运行起算（排队时间不计）
          _armTimers(taskId, taskInfo)
          const runPromise = spec.runTask(task, { signal: abort.signal, ...(workerCtx ? { ctx: workerCtx } : {}) })
          runPromise.catch(() => { /* 硬超时后迟到的 rejection 不外溢 */ })
          const result = await new Promise((resolve, reject) => {
            taskInfo._hardReject = reject
            runPromise.then(resolve, reject)
          })
          taskInfo._hardReject = null
          taskInfo.status = 'done'
          taskInfo.result = result
          trace.emit('delegate:end', { subagent: specName, resultLength: (result || '').length })
          Log.mark('[spawn_subagent]', `${taskId} 完成 len=${(result || '').length}`)
        } catch (e) {
          taskInfo._hardReject = null
          // 停止原因按 AbortController 状态判定，不再靠错误文本正则（避免把含 abort/budget/signal 的普通失败误判为超时）
          const timedOut = abort.signal.aborted
          taskInfo.status = timedOut ? 'timeout' : 'failed'
          taskInfo.error = e?.message || String(e)
          trace.emit('delegate:error', { subagent: specName, error: taskInfo.error, timedOut })
          Log.warn('[spawn_subagent]', `${taskId} ${taskInfo.status}:`, String(taskInfo.error || '').slice(0, 80))
        } finally {
          taskInfo.finishedAt = Date.now()
          clearTimeout(taskInfo._budgetTimer)
          clearTimeout(taskInfo._hardTimer)
          if (slotHeld) sem.release()
        }
      })()

      return {
        ok: true, taskId, status: 'queued', timeBudgetMs: budgetMs,
        message: `子代理 ${taskId} 已启动（预算 ${Math.round(budgetMs / 1000)} 秒，按本会话计数）。下一轮调用 check_subagent("${taskId}") 查看进度。`,
      }
    },
  }

  // ── check_subagent（查看子代理状态 + 结果）──
  const checkTool = {
    name: 'check_subagent',
    description: '查看子代理任务状态。返回 status（queued=排队中/running=运行中/done=完成/failed=失败/timeout=超时）。done 时包含完整结果。快到预算时会提示用 extend_subagent 续期。可反复轮询（不会被判死循环）。',
    category: 'query',
    meta: { polling: true, resultCap: 16000 }, // polling：轮询豁免 duplicate_action；resultCap 避免研究结果被 4000 全局默认截断
    parameters: {
      type: 'object',
      required: ['taskId'],
      properties: { taskId: { type: 'string', description: 'spawn_subagent 返回的 taskId' } },
      additionalProperties: false,
    },
    execute(params = {}, ctx) {
      const t = _tasks.get(String(params.taskId || ''))
      if (!t) return { error: `未找到任务 ${params.taskId}（可能已过期或不存在）` }
      if (t.scope !== scopeKeyOf(ctx)) return { error: '无权查看该任务（仅发起会话可访问）' }
      const now = Date.now()
      const waitingMs = t.startedAt ? t.startedAt - t.createdAt : now - t.createdAt
      const remaining = t.startedAt ? Math.max(0, t.budgetMs - (now - t.startedAt)) : t.budgetMs
      const res = {
        taskId: params.taskId, status: t.status,
        elapsedMs: now - t.createdAt, waitingMs, budgetMs: t.budgetMs, remainingMs: remaining,
      }
      if (t.status === 'done') {
        res.result = t.result
        res.message = '子代理已完成，结果在 result 字段。可直接用于回复用户。'
      } else if (t.status === 'failed' || t.status === 'timeout' || t.status === 'cancelled') {
        res.error = t.error
        res.message = `子代理${t.status === 'timeout' ? '超时' : t.status === 'cancelled' ? '已取消' : '失败'}：${t.error}`
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
    execute(params = {}, ctx) {
      const t = _tasks.get(String(params.taskId || ''))
      if (!t) return { error: `未找到任务 ${params.taskId}` }
      if (t.scope !== scopeKeyOf(ctx)) return { error: '无权操作该任务（仅发起会话可访问）' }
      if (t.status !== 'queued' && t.status !== 'running') return { taskId: params.taskId, status: t.status, message: '任务已结束，无需续期' }
      const extra = Math.max(10000, Math.min(300000, Number(params.extraMs) || 60000))
      t.budgetMs += extra
      if (t.status === 'running') _armTimers(String(params.taskId), t) // 运行中才需重排定时器；排队中等到 running 再按新预算起算
      const remaining = t.startedAt ? Math.max(0, t.budgetMs - (Date.now() - t.startedAt)) : t.budgetMs
      Log.mark('[spawn_subagent]', `${params.taskId} 续期 +${Math.round(extra / 1000)}s → 总预算 ${Math.round(t.budgetMs / 1000)}s 剩余 ${Math.round(remaining / 1000)}s`)
      return { ok: true, taskId: params.taskId, newBudgetMs: t.budgetMs, remainingMs: remaining }
    },
  }

  const tools = [spawnTool, checkTool, extendTool]
  Object.defineProperty(tools, 'shutdown', { value: shutdown, enumerable: false })
  return tools
}

/** 向后兼容：旧代码只取第一个工具（spawn_subagent） */
export function makeSpawnSubagentTool(opts = {}) {
  return makeSpawnSubagentTools(opts)[0]
}
