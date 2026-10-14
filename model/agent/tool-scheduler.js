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
  // 检索 / 知识（web_download 会发送文件 → 不在此列）
  'web_search', 'web_crawl', 'web_extract',
  'memory_search', 'kb_search', 'context_recall', 'tool_search', 'skill',
  // 纯计算 / 环境
  'calc', 'calculate', 'get_weather',
  // 只读个人/会话数据
  'get_note', 'get_chat_history', 'get_forward_msg', 'analyze_chat_record',
  // 只读群信息
  'group_info', 'group_member', 'group_members', 'user_info',
  'list_group_files', 'get_group_file', 'get_group_file_url', 'get_group_notice',
  // 只读媒体读取（read_pdf 会发送渲染图 → 不在此列）
  'read_excel', 'read_attachment', 'transcribe_media',
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

/**
 * ToolScheduler —— 单实例内**跨 run / 跨 Agent 共享**的受控并发门（F10）。
 * active 计数与资源锁是实例级：同一运行时的多个 Agent 共享同一个实例，因此
 * 相同资源键跨 Agent 互斥、全局并发受 maxParallel 约束。生产装配注入单例。
 */
export class ToolScheduler {
  constructor({ maxParallel = 3 } = {}) {
    this.maxParallel = Math.max(1, Number(maxParallel) || 1)
    this._active = 0
    this._held = new Map() // key -> refcount
    this._queue = [] // { task, signal, settle }
    this._exclusiveActive = false
  }

  _keysFree(keys) { return keys.every((k) => !this._held.has(k)) }
  _take(keys) { for (const k of keys) this._held.set(k, (this._held.get(k) || 0) + 1) }
  _free(keys) {
    for (const k of keys) {
      const c = (this._held.get(k) || 0) - 1
      if (c <= 0) this._held.delete(k)
      else this._held.set(k, c)
    }
  }

  /**
   * 提交一批任务；结果按 tasks 原序返回。同一实例的并发 run 共享额度与资源锁。
   * @param {SchedulerTask[]} tasks
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<SchedulerResult[]>}
   */
  run(tasks, { signal = null } = {}) {
    if (!tasks.length) return Promise.resolve([])
    const results = new Array(tasks.length).fill(null)
    const n = tasks.length
    let completed = 0
    return new Promise((resolve) => {
      const settleAt = (idx, res) => { results[idx] = res; if (++completed === n) resolve(results) }
      tasks.forEach((task, idx) => this._queue.push({ task, signal, settle: (res) => settleAt(idx, res) }))
      this._pump()
    })
  }

  _pump() {
    if (this._exclusiveActive) return // 独占运行中：屏障，后续全部等待
    let i = 0
    while (i < this._queue.length) {
      const item = this._queue[i]
      const task = item.task
      if (item.signal?.aborted) { // 取消：排队项不启动，标记 cancelled（在跑项已由各自 finally 处理）
        this._queue.splice(i, 1)
        item.settle({ ok: false, cancelled: true })
        continue
      }
      if (task.concurrency === EXCLUSIVE) {
        // 独占屏障：必须全局空闲才能启动；未空闲则阻塞其后所有任务（不跳过）
        if (this._active === 0 && this._held.size === 0) {
          this._queue.splice(i, 1)
          this._start(item, true)
        }
        break
      }
      const keys = task.resourceKeys || []
      if (this._active < this.maxParallel && this._keysFree(keys)) {
        this._queue.splice(i, 1)
        this._start(item, false)
        continue
      }
      i++
    }
  }

  _start(item, exclusive) {
    const keys = item.task.resourceKeys || []
    this._active++
    this._take(keys)
    if (exclusive) this._exclusiveActive = true
    Promise.resolve()
      .then(() => item.task.run())
      .then((value) => item.settle({ ok: true, value }), (error) => item.settle({ ok: false, error }))
      .finally(() => {
        this._active--
        this._free(keys)
        if (exclusive) this._exclusiveActive = false
        this._pump()
      })
  }

  stats() { return { maxParallel: this.maxParallel, active: this._active, waiting: this._queue.length, held: [...this._held.keys()] } }
}
