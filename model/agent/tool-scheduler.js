/**
 * ToolScheduler —— 单批工具调用的受控并发调度（DeepSeek Harness 优化方案 P0-2，修 F03）。
 *
 * 现状缺口：Agent._executeToolCalls 只要本批没有 meta.interactive，就用 Promise.all 并发执行全部工具，
 * 不分辨读写、资源键、实际并发安全或全局资源上限。浏览器同页面、同文件写入、同群顺序操作可能竞态。
 *
 * 本模块提供：
 *   - 显式并发声明：meta.concurrency = 'parallel' | 'exclusive' | 'resource'
 *   - 未声明工具默认 exclusive（保守）；内置纯只读工具经审计列入白名单显式 parallel
 *   - resource 按 meta.resourceKeys(args, ctx) 返回的资源键串行（不同键可并发）
 *   - exclusive 形成屏障：等待先前任务真正退出后才执行
 *   - 全局并发上限 maxParallel（滚动池）
 *   - 取消：abort 后不再启动排队的工具；已在跑的等待结算
 *   - 结果按原始调用顺序返回（与模型 tool_calls 顺序对齐）
 *
 * 字段之间不互相推导：query 不等于无副作用，read 不等于可安全并发。
 */

const EXCLUSIVE = 'exclusive'
const PARALLEL = 'parallel'
const RESOURCE = 'resource'

/**
 * 经审计的纯只读、可安全并发的内置工具白名单。
 * 未列入且未显式声明 meta.concurrency 的工具一律 exclusive（尤其第三方/MCP/toolEvo/写操作）。
 * 依赖运行时句柄或会写外部状态（浏览器页面、群管理、文件、笔记）的工具不在其中。
 */
export const READ_PARALLEL_TOOLS = new Set([
  // 检索 / 知识
  'web_search', 'web_crawl', 'web_extract', 'web_download',
  'memory_search', 'kb_search', 'context_recall', 'tool_search', 'skill',
  // 纯计算 / 环境
  'calc', 'calculate', 'get_weather',
  // 只读个人/会话数据
  'get_note', 'get_chat_history', 'get_forward_msg', 'analyze_chat_record',
  // 只读群信息
  'group_info', 'group_member', 'group_members', 'user_info',
  'list_group_files', 'get_group_file', 'get_group_file_url', 'get_group_notice',
  // 只读媒体读取
  'read_excel', 'read_pdf', 'read_attachment', 'transcribe_media',
  // 只读第三方内容检索
  'miyoushe_search', 'miyoushe_post', 'miyoushe_replies',
  // 定时任务只读
  'reminder_list',
])

function normalizeMode(meta) {
  const m = meta?.concurrency
  return (m === PARALLEL || m === EXCLUSIVE || m === RESOURCE) ? m : null
}

/**
 * 解析单个工具的实际并发语义。
 * @returns {{ mode: 'parallel'|'exclusive'|'resource', resourceKeys: string[] }}
 */
export function resolveToolConcurrency(tool, args, ctx) {
  const meta = tool?.meta || {}
  // interactive（审批/顺序确认）永远独占，屏障串行
  if (meta.interactive === true) return { mode: EXCLUSIVE, resourceKeys: [] }

  const declaresKeys = typeof meta.resourceKeys === 'function'
  let mode = normalizeMode(meta)
  if (!mode) {
    mode = READ_PARALLEL_TOOLS.has(tool?.name) ? PARALLEL : (declaresKeys ? RESOURCE : EXCLUSIVE)
  }

  let resourceKeys = []
  if (mode !== EXCLUSIVE && declaresKeys) {
    try {
      const ks = meta.resourceKeys(args, ctx)
      if (Array.isArray(ks)) resourceKeys = ks.map(String).filter(Boolean)
    } catch { resourceKeys = [] }
  }
  // 声明了资源键但按并行处理：升级为 resource（按资源串行），避免误并发
  if (mode === PARALLEL && resourceKeys.length) mode = RESOURCE
  // resource 但拿不到任何资源键 → 无法保证安全，降级独占
  if (mode === RESOURCE && !resourceKeys.length) mode = EXCLUSIVE
  return { mode, resourceKeys }
}

/**
 * @typedef {{ concurrency: string, resourceKeys?: string[], run: () => any }} SchedulerTask
 * @typedef {{ ok: boolean, value?: any, cancelled?: boolean, error?: any }} SchedulerResult
 */
export class ToolScheduler {
  constructor({ maxParallel = 3 } = {}) {
    this.maxParallel = Math.max(1, Number(maxParallel) || 1)
  }

  /**
   * 按原始顺序调度一批任务。
   * @param {SchedulerTask[]} tasks
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<SchedulerResult[]>} 与 tasks 同序
   */
  async run(tasks, { signal = null } = {}) {
    const results = new Array(tasks.length).fill(null)
    let i = 0
    while (i < tasks.length) {
      const t = tasks[i]
      if (t.concurrency === EXCLUSIVE) {
        results[i] = await this._runExclusive(t, signal)
        i++
        continue
      }
      // 收集连续的非 exclusive 任务为一个并发组（exclusive 作为屏障分隔）
      const group = []
      while (i < tasks.length && tasks[i].concurrency !== EXCLUSIVE) {
        group.push({ task: tasks[i], idx: i })
        i++
      }
      await this._runGroup(group, results, signal)
    }
    return results
  }

  async _runExclusive(task, signal) {
    if (signal?.aborted) return { ok: false, cancelled: true }
    try { return { ok: true, value: await task.run() } } catch (error) { return { ok: false, error } }
  }

  async _runGroup(group, results, signal) {
    const pending = [...group]
    const active = new Map() // promise -> { idx, keys }
    const held = new Map() // key -> refcount

    const keysFree = (keys) => keys.every((k) => !held.has(k))
    const takeKeys = (keys) => { for (const k of keys) held.set(k, (held.get(k) || 0) + 1) }
    const freeKeys = (keys) => {
      for (const k of keys) {
        const c = (held.get(k) || 0) - 1
        if (c <= 0) held.delete(k)
        else held.set(k, c)
      }
    }

    while (pending.length || active.size) {
      if (signal?.aborted) {
        // 取消：排队项不再启动，标记为 cancelled（已在跑的等待结算）
        while (pending.length) {
          const e = pending.shift()
          results[e.idx] = { ok: false, cancelled: true }
        }
      }
      // 在并发上限内，挑选资源键可用的最早任务启动
      let started = false
      while (!signal?.aborted && active.size < this.maxParallel && pending.length) {
        let pick = -1
        for (let p = 0; p < pending.length; p++) {
          if (keysFree(pending[p].task.resourceKeys || [])) { pick = p; break }
        }
        if (pick < 0) break
        const entry = pending.splice(pick, 1)[0]
        const keys = entry.task.resourceKeys || []
        takeKeys(keys)
        const p = Promise.resolve()
          .then(() => entry.task.run())
          .then(
            (value) => { results[entry.idx] = { ok: true, value } },
            (error) => { results[entry.idx] = { ok: false, error } },
          )
          .finally(() => { freeKeys(keys); active.delete(p) })
        active.set(p, entry)
        started = true
      }
      if (!active.size) {
        if (pending.length && !signal?.aborted) {
          // 理论不可达（无 active 时资源键必空闲）。防御：按序强制启动，避免死锁。
          const entry = pending.shift()
          try { results[entry.idx] = { ok: true, value: await entry.task.run() } }
          catch (error) { results[entry.idx] = { ok: false, error } }
          continue
        }
        break
      }
      if (!started && active.size) { /* 等待现有任务让出资源/槽位 */ }
      await Promise.race([...active.keys()])
    }
  }
}
