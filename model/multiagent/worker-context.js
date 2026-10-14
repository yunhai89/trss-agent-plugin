/**
 * 子代理（worker）共享契约 —— 工具可达性解析、身份上下文子集、作用域键。
 *
 * 背景（DeepSeek Harness 优化方案 F01）：spawn 异步三件套与 orchestrator 同步编排
 * 各自实现了一套「子代理能用哪些工具 / 拿哪些 ctx」的判定。两条拓扑必须复用同一判定，
 * 否则会出现「同步编排绕过白名单」「同一工具一处可用一处不可用」等漂移。
 * 本模块是唯一真源：spawn-tool.js 与 orchestrator.js 都从这里取。
 */
import { ToolRegistry } from '../agent/tools/registry.js'

/** 子代理 run 时只注入的身份字段（见 workerCtxOf）；这些是「可用 ctx 键」集合 */
export const WORKER_CTX_KEYS = new Set(['userId', 'scopeUserId', 'scopeId', 'groupId', 'conversationId'])

/**
 * 依赖运行时句柄（e/bot/sandbox/media/fetcher/miyoushe…）的 query 类工具。
 * 子代理拿不到这些句柄，调用必然失败——下发给子代理只会空转/浪费轮次，故排除。
 * 新增此类工具时请同步登记（或在工具 meta.requires 里声明所需 ctx 键）。
 */
export const WORKER_CTX_UNSUPPORTED = new Set([
  'terminal',                 // ctx.sandbox
  'read_attachment',          // ctx.media
  'list_group_folder', 'get_group_file_url', // ctx.e/bot
  'get_chat_history', 'get_forward_msg', 'analyze_chat_record', 'get_group_notice', // ctx.e/bot/quoted
  'group_info', 'group_member', 'user_info', // ctx.bot
  'get_ai_characters', 'ai_tts', // ctx.e/bot（AI 语音通道）
  'read_pdf', 'create_excel', 'send_file', 'file_to_pdf', // ctx.e / ctx.media
  'miyoushe_search', 'miyoushe_post', 'miyoushe_replies', // ctx.miyoushe/fetcher/e
  'pixiv__search', 'pixiv__illust', 'pixiv__ranking', 'pixiv__user', 'pixiv__tags', // ctx.e（外置工具包）
])

/** 子代理只能使用只读类工具（默认 category='query'） */
export const ALLOWED_TOOL_CATEGORIES = new Set(['query'])

/** 内部工具名：不得下发给子代理（防递归委派 / 自旋） */
export const SUBAGENT_INTERNAL_TOOL_NAMES = new Set([
  'spawn_subagent', 'check_subagent', 'extend_subagent', 'orchestrate',
])

/**
 * 按白名单 + 可达性构建子代理工具集。
 * @returns {{ registry: import('../agent/tools/registry.js').ToolRegistry|null, granted: string[], dropped: string[] }}
 *   granted=实际下发的工具名；dropped=请求了但不可用的工具名（供主代理据此改派/自己完成）。
 */
export function buildWorkerTools(sourceRegistry, names, defaultNames) {
  if (!sourceRegistry) return { registry: null, granted: [], dropped: [] }
  const wanted = (Array.isArray(names) && names.length ? names : defaultNames).map(String)
  const workerReg = new ToolRegistry()
  const granted = []
  const dropped = []
  for (const name of wanted) {
    if (SUBAGENT_INTERNAL_TOOL_NAMES.has(name)) { dropped.push(name); continue }
    if (WORKER_CTX_UNSUPPORTED.has(name)) { dropped.push(name); continue } // 依赖子代理没有的运行时句柄 → 剔除
    const tool = sourceRegistry.get(name)
    if (!tool) { dropped.push(name); continue }
    if (!ALLOWED_TOOL_CATEGORIES.has(tool.category || 'query')) { dropped.push(name); continue }
    // 声明式能力校验：meta.requires 里有子代理 ctx 不提供的键 → 不下发
    if (Array.isArray(tool.meta?.requires) && tool.meta.requires.some((k) => !WORKER_CTX_KEYS.has(k))) { dropped.push(name); continue }
    if (!workerReg.has(name)) { workerReg.register(tool); granted.push(name) }
  }
  return { registry: workerReg, granted, dropped }
}

/** 会话作用域键：配额与任务归属都按它隔离（与 Agent/session 的群:用户:会话同源） */
export function scopeKeyOf(ctx) {
  if (!ctx) return 'global'
  const gid = ctx.groupId ? String(ctx.groupId) : 'private'
  const uid = String(ctx.scopeUserId || ctx.userId || 'unknown')
  const conv = ctx.conversationId != null ? String(ctx.conversationId) : 'default'
  return `${gid}:${uid}:${conv}`
}

/**
 * 传给子代理的身份上下文子集：让 memory_search 等 query 工具可用，
 * 同时不带事件句柄/权限对象（e/bot/API Key/AbortController 一律不进 worker）。
 * @param {object} ctx 主代理工具上下文
 * @param {{ signal?: AbortSignal }} [extra] 需要显式透传的取消信号（与身份字段分开，语义清晰）
 */
export function workerCtxOf(ctx, extra = {}) {
  const base = ctx
    ? {
        userId: ctx.userId,
        scopeUserId: ctx.scopeUserId,
        scopeId: ctx.scopeId,
        groupId: ctx.groupId,
        conversationId: ctx.conversationId,
      }
    : {}
  if (extra.signal) base.signal = extra.signal
  if (extra.taskId) base.taskId = extra.taskId
  return Object.keys(base).length ? base : undefined
}
