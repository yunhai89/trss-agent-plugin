/**
 * SubagentSpec —— 隔离子代理的配置。runTask 构造全新 Agent（无 session/memory/recall/guard → 纯隔离上下文），
 * 跑到完成，返回 content（压缩摘要回传 orchestrator）。对应文档 §3.5 上下文隔离 + §2.4 worker 角色。
 *
 * makeDelegationTool —— 把 SubagentSpec 注册为 Orchestrator 可调用的工具（agent-as-tool，文档 §3.2）。
 *
 * DeepSeek Harness 优化方案 P0-1：
 *   - runTaskResult：结构化结果（status/completion/stopReason/usage/turns），不再只返回字符串；
 *     旧的 runTask 文本返回保留为兼容包装。
 *   - makeDelegationTool.execute(params, ctx)：接收父任务 ctx，透传筛选后的身份上下文与取消信号，
 *     排队可取消、并发满可拒绝；主代理能区分完成/部分完成/等待输入/失败/取消。
 */
import { Agent, GOVERNOR_STOP } from '../agent/Agent.js'
import { workerCtxOf } from './worker-context.js'

const ABNORMAL_STOP = GOVERNOR_STOP

/**
 * 把 Agent.run 的返回值归一为子任务结构化结果。
 * 完成语义与 Promise 是否 resolve 分开：max_turns/time_budget 等异常停止即使正常返回，
 * 也只能标记 partial，绝不能标记 completed。
 */
export function normalizeSubagentResult(result = {}, { parentTaskId = null, childTaskId = null } = {}) {
  const stopReason = result.stopReason || null
  const content = result.content || ''
  let status
  if (stopReason === 'clarify') status = 'waiting_input'
  else if (stopReason === 'blocked') status = 'blocked'
  else if (stopReason && ABNORMAL_STOP.has(stopReason)) status = content ? 'partial' : 'failed'
  else status = 'completed'
  const completion = status === 'completed' ? 'complete'
    : status === 'partial' ? 'partial'
      : status === 'waiting_input' ? 'waiting_input'
        : 'none'
  return {
    taskId: childTaskId || result.taskId || null,
    parentTaskId: parentTaskId || null,
    status, completion, content,
    stopReason, usage: result.usage || null, turns: result.turns || 0,
    error: null,
  }
}

export class SubagentSpec {
  constructor({
    name,
    description,
    systemPrompt,
    tools,
    model,
    maxTurns = 200,
    provider,
    ...agentConfig
  } = {}) {
    if (!name) throw new Error('SubagentSpec 需要 name')
    if (!provider) throw new Error('SubagentSpec 需要 provider')
    this.name = name
    this.description = description || `子代理 ${name}`
    this.systemPrompt = systemPrompt || `你是${name}，专注于完成分配给你的任务，给出简洁结果。`
    this.tools = tools || null
    this.model = model
    this.maxTurns = maxTurns
    this.provider = provider
    this.agentConfig = agentConfig
  }

  /** 在全新隔离上下文中执行任务，返回结构化结果（status/completion/stopReason/usage/turns/error） */
  async runTaskResult(task, opts = {}) {
    const taskId = opts.taskId || null
    const agent = new Agent({
      provider: this.provider,
      model: this.model,
      tools: this.tools,
      systemPrompt: this.systemPrompt,
      maxTurns: this.maxTurns,
      ...this.agentConfig,
      // 不传 session/recall/memory/guard/policy → 纯隔离
    })
    try {
      const result = await agent.run(task, opts)
      return normalizeSubagentResult(result, { parentTaskId: opts.parentTaskId, childTaskId: taskId })
    } catch (e) {
      // 取消/失败不伪装成功：区分「父任务取消」与「执行失败」
      const aborted = !!(opts.signal?.aborted) || e?.name === 'AbortError' || /aborted/i.test(e?.message || '')
      return {
        taskId,
        parentTaskId: opts.parentTaskId || null,
        status: aborted ? 'cancelled' : 'failed',
        completion: 'none',
        content: '',
        stopReason: aborted ? 'cancelled' : 'error',
        usage: null,
        turns: 0,
        error: e?.message || String(e),
      }
    }
  }

  /** 兼容包装：返回 content（原语义）。失败/取消仍上抛，保持调用方（如 spawn）既定错误处理。 */
  async runTask(task, opts = {}) {
    const r = await this.runTaskResult(task, opts)
    if (r.status === 'completed' || r.status === 'partial' || r.status === 'waiting_input') return r.content
    const err = new Error(r.error || `子代理 ${this.name} 未完成（status=${r.status}）`)
    err.subagentResult = r
    throw err
  }
}

function errorResult(kind, message, extra = {}) {
  return { error: kind, reason: message, _subagent: true, ...extra }
}

/**
 * 构造委派工具（agent-as-tool）。Orchestrator 调用时 → Semaphore 限流 → SubagentSpec.runTaskResult → 压缩结果。
 * @param {object} opts
 * @param {object} [opts.semaphore] 并发限流（支持可取消 acquire）
 * @param {object} [opts.trace] 观测
 * @param {function} [opts.onUsage] (result, spec) 用量归集回调（rootTask 预算用）
 */
export function makeDelegationTool(spec, { semaphore, trace, onUsage } = {}) {
  return {
    name: `delegate__${spec.name}`,
    description: `委派任务给「${spec.name}」：${spec.description}。传入 { task: 具体的任务描述（自包含：目标+输出格式+边界）}。`,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '给子代理的具体任务描述' },
      },
      required: ['task'],
    },
    category: 'query',
    meta: { subagent: true, spec },
    async execute(params = {}, ctx = null) {
      const task = typeof params === 'string' ? params : params.task || ''
      if (!String(task).trim()) return errorResult('bad_args', 'task 不能为空')

      const signal = ctx?.signal || null
      let admitted = true
      if (semaphore) {
        try {
          admitted = await semaphore.acquire({ signal })
        } catch (e) {
          // 排队期间父任务取消 → 不启动子代理（P-B 探针：零 Provider 调用，槽位不泄漏）
          if (trace) trace.emit('delegate:error', { subagent: spec.name, cancelled: true })
          return errorResult('cancelled', '父任务已取消，委派未启动')
        }
        if (admitted === false) {
          if (trace) trace.emit('delegate:busy', { subagent: spec.name })
          return errorResult('busy', '子代理并发已满，请稍后重试或由主代理直接完成')
        }
      }
      try {
        // 拿到槽位后再检查一次取消（入场与执行之间可能被取消）
        if (signal?.aborted) return errorResult('cancelled', '父任务已取消，委派未启动')
        if (trace) trace.emit('delegate:start', { subagent: spec.name, task: String(task).slice(0, 120) })
        const r = await spec.runTaskResult(String(task), {
          signal,
          ctx: workerCtxOf(ctx),
          parentTaskId: ctx?.taskId || null,
        })
        if (typeof onUsage === 'function') { try { onUsage(r, spec) } catch { /* 归集失败不影响结果 */ } }
        if (trace) {
          trace.emit('delegate:end', {
            subagent: spec.name, status: r.status, completion: r.completion,
            stopReason: r.stopReason, resultLength: (r.content || '').length,
          })
        }
        if (r.status === 'cancelled') return errorResult('cancelled', r.error || '子代理被取消')
        if (r.status === 'failed') return errorResult('subagent_failed', r.error || `子代理 ${spec.name} 执行失败`)
        if (r.status === 'partial' || r.status === 'blocked') {
          // 部分完成可交付内容，但必须显式标注，防主代理把「部分」当「完整」
          const note = `[子代理未完整完成 status=${r.status} reason=${r.stopReason || '-'}]`
          return r.content ? `${note}\n${r.content}` : errorResult(r.status, r.error || note)
        }
        return r.content
      } catch (e) {
        if (trace) trace.emit('delegate:error', { subagent: spec.name, error: e?.message || String(e) })
        return errorResult('subagent_error', `子代理 ${spec.name} 出错：${e?.message || e}`)
      } finally {
        if (semaphore && admitted) semaphore.release()
      }
    },
  }
}
