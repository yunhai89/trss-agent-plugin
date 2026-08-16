/**
 * Agent —— ReAct 主循环（参考 Hermes AIAgent 九步 Turn Lifecycle 与 yunhai lib/agent/loop.js）。
 *
 * 职责：接收输入 → 组装 system → 调 Provider → 工具调用则执行回插 → 循环到文本回复。
 * 基础：迭代预算、AbortSignal、回调、流式、token 压力钩子（既有）。
 * opt-in 运营层（传实例 + ctx 才启用，否则保持现行为）：
 *   - guard：入口注入防御（block/flag/sanitize）+ system 硬化
 *   - session：跨会话历史（group:user 键、KV 持久化）
 *   - recall：向量召回记忆（注入 system + 轮后异步抽取）
 *   - policy + confirm：工具分发前的 RBAC + 审批门
 *   - clarify 短路：指定工具的结果作为最终回复直接退出
 * 库零依赖插件；ctx / kv / logger / key 由上层注入。
 */

import { randomUUID } from 'node:crypto'
import { ExecutionContext } from './tools/context.js'
import { makeToolSearchTool } from './tools/tool_search.js'
import { stringifyArgs, estimateMessages, mergeUsage } from './messages.js'
import { tokenBreakdown, toolResultFields } from './trace/events.js'
import { LoopGovernor } from './loop-governor.js'
import { TEMPLATES, SERVICE_DIRECTIVE, REFLECTION_DIRECTIVE, buildToolCatalogSection, buildToolDiscoverySection, buildSkillsPromptSection, buildStickerPromptSection, buildAgentSystemPrompt } from '../prompt/index.js'

const DEFAULT_IDENTITY = TEMPLATES.agent.system

/** 按需发现默认常驻工具（不经过搜索；config.toolDiscovery.alwaysOn 留空时兜底）。tool_search 始终由元工具注入。 */
const DEFAULT_ALWAYS_ON = ['tool_search', 'clarify', 'memory_search', 'web_search', 'kb_search', 'skill', 'get_chat_history', 'reminder_set']

/** 紧凑用量日志：兼容 per-turn(prompt/completion_tokens) 与 mergeUsage(input/output/total) 两种形态 */
function fmtUsage(u) {
  if (!u) return null
  const p = u.prompt_tokens ?? u.input_tokens ?? u.input
  const c = u.completion_tokens ?? u.output_tokens ?? u.output
  const t = u.total_tokens ?? u.total
  const parts = []
  if (p != null) parts.push(`in:${p}`)
  if (c != null) parts.push(`out:${c}`)
  if (!parts.length && t != null) parts.push(`tok:${t}`)
  return parts.length ? `{${parts.join(',')}}` : null
}

/** 日志截断：字符串/对象单行化 + 长度截断 */
function brief(v, n = 160) {
  let s
  if (v == null) s = String(v)
  else if (typeof v === 'string') s = v
  else { try { s = JSON.stringify(v) } catch { s = String(v) } }
  s = String(s).replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s
}

/** 判定工具结果是否为失败形态：{"error":...}（stringifyArgs 后的 JSON 键） */
function isToolError(content) {
  return typeof content === 'string' && /"error"\s*:/.test(content)
}

/** 工具结果签名（LoopGovernor 判"新事实"用）：长度 + 首尾片段 + 简单散列，
 *  区分"同参同结果空转"与"轮询状态变化"。结果已被 resultCap 截断，O(n) 开销可忽略。 */
function resultSignature(content) {
  if (content == null) return ''
  const s = typeof content === 'string' ? content : (() => { try { return JSON.stringify(content) } catch { return String(content) } })()
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return `${s.length}:${h}`
}

/**
 * 结构化截断 JSON 值，保证截断后仍可 JSON.parse（审计 §3.4）。
 * - 数组：留前 N 项 + { _truncated, omitted, total }，模型知道缺了多少；
 * - 对象：保留前若干字段 + _truncated，超长字符串字段单独裁剪；
 * - 基本类型过长：包装成 { _truncated, value }。
 * 避免按字符 slice 把 JSON 切成非法片段——那会让模型无法解析、不知道缺哪些字段、反复重调。
 */
function truncateJson(value, max) {
  if (JSON.stringify(value).length <= max) return value
  if (Array.isArray(value)) {
    const total = value.length
    const items = []
    for (const it of value) {
      const probe = JSON.stringify({ items: [...items, it], _truncated: true, omitted: total - items.length - 1, total })
      if (probe.length > max) break
      items.push(it)
    }
    return { items, _truncated: true, omitted: total - items.length, total }
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) {
      const next = { ...out, [k]: value[k], _truncated: true }
      if (JSON.stringify(next).length > max && Object.keys(out).length) break
      out[k] = value[k]
    }
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'string' && out[k].length > max * 0.6) {
        out[k] = out[k].slice(0, Math.max(80, Math.floor(max / 4))) + `…(字段截断 ${out[k].length} 字符)`
      }
    }
    return { ...out, _truncated: true }
  }
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return { _truncated: true, value: s.slice(0, Math.max(80, max - 80)) + `…(截断 ${s.length} 字符)` }
}

/** 失败回灌提示：注入错误 tool 结果的 _hint 字段，引导模型据实回复、勿臆测编造。
 *  注：以 JSON 字段注入（而非追加文本），保证 tool 结果仍可被 JSON.parse。 */
const TOOL_FAIL_HINT = '这是工具返回的真实失败原因——请据此如实回复用户（勿臆测/编造其它原因）；若给出可重试方向（缺参数/权限不足/网络不可达/需先查 id）则换方式重试或指导用户；若反复失败无法解决，引导用户发送 #上报错误 <问题描述> 上报（命令会自动打包本次会话日志给开发者）。'

/** LoopGovernor 触发的停止原因集合（这些 + max_turns 耗尽时，若无最终回复则强制收尾） */
const GOVERNOR_STOP = new Set(['max_turns', 'duplicate_action', 'consecutive_failures', 'no_progress', 'time_budget', 'token_budget'])
/** 强制收尾指令：让模型据已完成工具结果交付进展，不再调工具（审计 §2.1：预算耗尽不返回空串） */
const GOVERNOR_WRAP_DIRECTIVE = '任务尚未完成。请根据上方已完成的工具调用与结果，向用户简要交付：①已完成的进展；②遇到的问题或失败原因；③建议的下一步。直接给出文字回复，不要再调用工具。'

export class Agent {
  constructor(config = {}) {
    if (!config.provider) throw new Error('Agent 需要 provider')
    this.provider = config.provider
    this.model = config.model || null
    this.tools = config.tools || null
    this.memory = config.memory || null
    this.skills = config.skills || null
    this.stickers = config.stickers || null // 表情包清单注入（catalog()，无资源时返回空串零影响）

    this.systemPrompt = config.systemPrompt || DEFAULT_IDENTITY
    this.maxTurns = config.maxTurns ?? 90
    this.temperature = config.temperature
    this.maxTokens = config.max_tokens ?? config.maxTokens ?? null
    this.thinking = config.thinking || null
    this.toolChoice = config.tool_choice ?? config.toolChoice ?? null

    this.estimateTokens = config.estimateTokens || null
    this.contextPressureThreshold = config.contextPressureThreshold ?? null
    // 上下文管理（解决长对话膨胀 / token 溢出）
    this.maxToolResultChars = config.maxToolResultChars ?? 4000 // 单条工具结果字符上限，超长截断
    this.keepReasoning = config.keepReasoning === true // 默认 false：不把 reasoning 回灌历史，省 context
    this.contextKeepRecent = config.contextKeepRecent ?? 8 // 压缩时至少保留的尾部消息数
    this.logger = config.logger || (() => {})
    this.devLog = config.devLog || null // 详细 trace 日志（apps 注入，库零依赖）；null 时为 no-op

    // opt-in 运营层
    this.guard = config.guard || null
    this.guardSensitivity = config.guardSensitivity || 'medium'
    this.guardAction = config.guardAction || 'flag'
    this.blockedMessage = config.blockedMessage || '检测到潜在的指令注入，已拒绝处理。'
    this.policy = config.policy || null
    this.confirm = config.confirm || null
    // 主人发起的任务免确认直执行（高危）：开启后 ctx.isMaster 的确认类工具跳过 #确认，
    // 但经 onMasterAutoApprove 回调发"特别高危提示"。denylist 仍是硬底线（execute 里拦）。
    this.masterSkipConfirm = config.masterSkipConfirm === true
    this.session = config.session || null
    this.recall = config.recall || null
    this.recallTopK = config.recallTopK ?? 5
    this.recallLlm = config.recallLlm || null
    this.promptRegistry = config.promptRegistry || null // 进化版 prompt 注册表：_assembleSystem 优先取 registry.get('agent').system
    this.shortCircuitTools = config.shortCircuitTools || ['clarify']
    // 自我反思/自纠：最终回复交付前自检，发现实质问题则回环修正。off=关 | auto=仅多轮/用工具时(默认) | always=每次都反思
    this.reflect = config.reflect ?? 'auto'
    this.cacheControl = config.cacheControl === true // Anthropic 显式 prompt 缓存断点（openai 兼容端为自动前缀缓存，无需开启）
    this.reflectMaxIterations = config.reflectMaxIterations ?? 1

    // 回退 provider 列表（每条 {provider, model}，独立 baseURL/apiKey/protocol，可跨厂商）；主模型失败时依次尝试
    this.fallbackProviders = Array.isArray(config.fallbackProviders) ? config.fallbackProviders : []

    // LoopGovernor：循环智能终止器（审计 §2.1）。config.loop 为假值则不启用（保持原 maxTurns 行为）
    this.governor = config.loop ? new LoopGovernor(config.loop) : null

    // 工具按需发现（Tool Discovery）：null=全量模式；Set=按需模式（常驻核心工具 + 命中后扩充）
    this.toolDiscovery = config.toolDiscovery || null
    this.activeTools = null
    this._metaTools = {} // per-instance 元工具（tool_search 闭包绑 this，并发安全）
    this._curTaskId = null // run() 内暂存，供元工具 devLog
    this._curDevScope = null
    this.messages = []
    this._pendingReflect = null // 反思反馈暂存：下轮拼入 system（非 messages），防被模型当用户话（审计 §3.7）
  }

  setHistory(messages) { this.messages = messages ? messages.map((m) => ({ ...m })) : [] }
  getHistory() { return this.messages }
  reset() { this.messages = [] }

  /**
   * @param {string|object} input 用户文本或消息对象
   * @param {object} opts signal/ctx/onDelta/onReasoning/onToolStart/onToolEnd/onAssistant/onContextPressure/onApprove/onBeforeTool/taskId/stream/...
   *   ctx = { role, isMaster, userId, groupId, isGroup, isGroupAdmin, notify, fetcher, ... }
   */
  async run(input, opts = {}) {
    const cb = {
      onDelta: opts.onDelta,
      onReasoning: opts.onReasoning,
      onToolStart: opts.onToolStart,
      onToolEnd: opts.onToolEnd,
      onAssistant: opts.onAssistant,
      onContextPressure: opts.onContextPressure,
      onApprove: opts.onApprove,
      onBeforeTool: opts.onBeforeTool,
      onMasterAutoApprove: opts.onMasterAutoApprove,
    }
    const signal = opts.signal || null
    const taskId = opts.taskId || randomUUID()
    const ctx = opts.ctx || null
    const wantStream = opts.stream ?? !!cb.onDelta
    // 人设覆盖：传入则替换身份层 systemPrompt，工具/记忆/防护仍照常追加
    const systemPromptOverride = opts.systemPrompt || null
    // 情境感知（skill 注入）：如"首次入群"获取的群信息/聊天记录
    const context = opts.context || null

    const rawText = this._inputText(input)

    // guard：入口注入防御
    let userText = rawText
    if (this.guard) {
      const g = this.guard.checkInput(rawText, { sensitivity: this.guardSensitivity, action: this.guardAction })
      if (g.blocked) {
        this.logger('warn', `输入被 guard 拦截：score=${g.score}`)
        return { content: this.blockedMessage, messages: this.messages, usage: null, turns: 0, taskId, stopReason: 'blocked' }
      }
      userText = g.text // 可能被 isolate/sanitize
    }

    // session：加载历史（conversation 模式 or group:user 模式）
    // scopeUserId = 数据归属身份（isolation 开=真实用户，关群聊=群共享占位），实现多用户隔离
    const scopeUserId = ctx?.scopeUserId || ctx?.userId
    const scopeId = ctx?.scopeId
    const useConv = !!(this.session && ctx && ctx.conversationId != null && typeof this.session.getConversation === 'function')
    let sessKey = null
    if (useConv) {
      try { this.messages = await this.session.getConversation(scopeUserId, ctx.groupId, ctx.conversationId) } catch { this.messages = [] }
    } else if (this.session && ctx) {
      sessKey = this.session.key(ctx.groupId, scopeUserId)
      try { this.messages = await this.session.get(sessKey) } catch { this.messages = [] }
    }
    const sessStart = this.messages.length

    // 清理历史中的空 assistant 消息（之前 bug 可能产生），给占位避免 API 报 "content or tool_calls must be set"
    this.messages = this.messages.map((m) => {
      if (m && m.role === 'assistant' && !m.content && !m.tool_calls?.length) {
        return { ...m, content: '(模型历史空回复，已自动修复)' }
      }
      return m
    })

    // 追加 user 消息（保留多模态对象形态，仅替换文本内容）
    this.messages.push(this._buildUserMessage(input, userText))

    // recall：检索注入（按 scopeUserId 隔离：群共享模式下读群共享记忆）
    let memories = null
    if (this.recall && ctx) {
      try { memories = await this.recall.retrieve(rawText, scopeUserId, this.recallTopK) } catch { memories = null }
    }

    this._pendingReflect = null // 每 run 重置反思反馈（防跨 run 串）
    this.governor?.reset()
    let usage = null
    let turns = 0
    let stopReason = null
    let lastContent = ''
    let usedTools = false      // 本轮是否调用过工具（auto 门控：仅非平凡任务触发反思，纯闲聊零延迟）
    let reflectIter = 0        // 已触发的反思回环次数（reflectMaxIterations 封顶，防无限循环）
    // 工具按需发现：按 enable 初始化激活集 + per-instance 元工具（同 run 内激活持续）
    const td = this.toolDiscovery
    const discoveryOn = !!(td?.enable && this.tools)
    if (discoveryOn) {
      this.activeTools = new Set(td.alwaysOn?.length ? td.alwaysOn : DEFAULT_ALWAYS_ON)
      this._metaTools = { tool_search: makeToolSearchTool(this.tools, this, td) }
      // 跨轮恢复上一对话扩充过的工具集（会话级持久）：tools 数组参与请求前缀缓存——
      // 若每轮重置回 alwaysOn，上一轮 tool_search 扩充过的对话本轮 tools 缩水 → 前缀在
      // tools 处断裂，system+messages 全部 cache miss；且历史中的 tool_use 工具不在列表
      // 可能被严格端点拒收。恢复顺序=上轮最终顺序（Set 保插入序），前缀逐字节一致。
      if (useConv && typeof this.session.getConversationState === 'function') {
        try {
          const st = await this.session.getConversationState(scopeUserId, ctx.groupId, ctx.conversationId)
          if (Array.isArray(st?.activeTools)) {
            for (const n of st.activeTools) if (this.tools.has?.(n) && !this.activeTools.has(n)) this.activeTools.add(n)
          }
        } catch { /* 状态缺失按新对话处理 */ }
      }
    } else {
      this.activeTools = null
      this._metaTools = {}
    }
    this._curTaskId = taskId
    this._curDevScope = ctx?.devScope || null
    const __runStart = Date.now()
    const __tools0 = this._buildToolList()
    const __toolsTokensEst = estimateMessages(__tools0.map((t) => ({ content: JSON.stringify({ n: t.name, d: t.description, p: t.parameters }) })))
    this.logger('mark', 'run start user=', ctx?.userId, 'gid=', ctx?.groupId, 'conv=', ctx?.conversationId, 'inputLen=', rawText.length, 'msgs=', this.messages.length, 'tools=', __tools0.length + (discoveryOn ? `/${this.tools.list().length} discovery=on` : ''), 'maxTurns=', this.maxTurns)
    this.devLog?.('run_start', { user: ctx?.userId, gid: ctx?.groupId, conv: ctx?.conversationId, scopeUserId, scopeId, model: this.model, msgs: this.messages.length, tools: this.tools?.list?.().length || 0, discoveryOn, activeTools: this.activeTools ? [...this.activeTools] : null, toolsSent: __tools0.length, toolsTokensEst: __toolsTokensEst, maxTurns: this.maxTurns, inputLen: rawText.length }, taskId, ctx?.devScope)

    while (turns < this.maxTurns) {
      if (signal?.aborted) throw new Error('aborted')

      const { system, breakdown } = this._assembleSystem(memories, systemPromptOverride, context, scopeId)

      if (this.contextPressureThreshold) {
        const est = this._estimateHistory(system)
        if (est > this.contextPressureThreshold) {
          // 实际压缩历史：保留首条 user 意图 + 近期若干条，安全丢弃中段整轮
          const dropped = this._compactMessages(Math.floor(this.contextPressureThreshold * 0.6))
          if (dropped) this.logger('mark', `上下文压力(est=${est}>${this.contextPressureThreshold})：压缩历史，丢弃 ${dropped} 条中段消息`)
          cb.onContextPressure?.({ estimate: est, threshold: this.contextPressureThreshold, dropped, messages: this.messages })
        }
      }

      const toolList = this._buildToolList() // 每轮重算：tool_search 命中后 activeTools 扩充，下轮须重新合成
      const __toolListTokens = estimateMessages(toolList.map((t) => ({ content: JSON.stringify({ n: t.name, d: t.description, p: t.parameters }) })))
      breakdown.tools += __toolListTokens; breakdown.total = (breakdown.total || 0) + __toolListTokens
      const __t0 = Date.now()
      // 流式增量守卫：本轮已有增量内容送达用户（onDelta 播报/逐字输出）后，
      // 若 provider 中途失败，换 fallback 重跑会把同样的半截内容再发一遍——直接抛出，宁断不重。
      let __emitted = false
      const __delta = cb.onDelta ? (...a) => { __emitted = true; return cb.onDelta(...a) } : undefined
      // 主模型失败时依次尝试回退 provider（各自独立 baseURL/apiKey/protocol，可跨厂商）
      const __chatWith = (prov, m) => prov.chat({
        model: m, messages: this.messages, system,
        tools: toolList.length ? toolList : undefined, tool_choice: this.toolChoice,
        temperature: this.temperature, max_tokens: this.maxTokens, thinking: this.thinking,
        signal, stream: wantStream, onDelta: __delta, onReasoning: cb.onReasoning,
        ...(this.cacheControl ? { cacheControl: true } : {}),
        ...this._extraRunOpts(opts),
      })
      const __tries = [{ provider: this.provider, model: this.model }, ...this.fallbackProviders]
      let result, lastErr
      for (const t of __tries) {
        try { result = await __chatWith(t.provider, t.model); break }
        catch (e) {
          lastErr = e
          if (__emitted) {
            this.logger('warn', `[fallback] 模型 ${t.model} 流式中途失败且已输出部分内容，不切换 provider（防重复输出）`, e?.message || e)
            throw e
          }
          if (__tries.length > 1) this.logger('warn', `[fallback] 模型 ${t.model} 失败，尝试下一个`, e?.message || e)
        }
      }
      if (!result) throw lastErr
      const __ms = Date.now() - __t0
      if (result.usage) {
        usage = mergeUsage(usage, result.usage)
        this.governor?.noteUsage(result.usage) // token 预算接线（此前 noteUsage 从未被调用，tokenBudget 恒不触发）
      }
      turns++
      this.logger('debug', `turn ${turns}`, 'model=', this.model, 'finish=', result.finishReason, 'contentLen=', (result.content || '').length, 'toolCalls=', result.toolCalls?.length || 0, 'reasoning=', !!result.reasoning, 'usage=', fmtUsage(result.usage), `ms=${__ms}`)
      this.devLog?.('turn', {
        turn: turns, finish: result.finishReason, contentLen: (result.content || '').length,
        content: result.content || '', reasoning: !!result.reasoning,
        toolCalls: (result.toolCalls || []).map((tc) => ({ name: tc.name, arguments: tc.arguments })),
        usage: result.usage || null, ms: __ms, toolsSent: toolList.length, breakdown, ...(discoveryOn ? { activeTotal: this.activeTools.size } : {}),
      }, taskId, ctx?.devScope)

      // 诊断（文档 §9.2/§12）：finishReason 表明要调工具，却没解析到 tool_calls
      // → 工具调用结构丢失，循环将误判为"纯文本最终回复"而中断（工具不执行、无后续）。
      // 记下原始结构，便于定位是否通道用了非标准 tool_call 格式。
      if (!result.toolCalls?.length && result.finishReason && /tool|function/i.test(result.finishReason)) {
        this.logger('warn', `[adapter] finish_reason=${result.finishReason} 但未解析到 tool_calls（工具循环将中断，疑似通道非标准格式）rawKeys=[${Object.keys(result.rawMessage || {}).join(',')}]`)
        this.devLog?.('adapter_warn', { kind: 'finish_reason_without_tool_calls', finishReason: result.finishReason, contentLen: (result.content || '').length, rawKeys: Object.keys(result.rawMessage || {}) }, taskId, ctx?.devScope)
      }

      // 防 API 报错："assistant message content or tool_calls must be set"
      // deepseek 等模型偶尔返回空 content + 无 tool_calls（如纯 thinking 无正文），
      // 空消息被追加到历史后，下次 run 读历史时 API 拒绝。给占位避免。
      const __emptyAssistant = !result.content && !result.toolCalls?.length
      const assistantMsg = {
        role: 'assistant',
        content: result.content || (__emptyAssistant ? '(模型本轮未输出正文)' : null),
        // 默认不回灌 reasoning（keepReasoning=false），避免隐藏 token 持续吃 context
        ...((this.keepReasoning && result.reasoning) ? { reasoning: result.reasoning } : {}),
      }
      if (result.toolCalls?.length) {
        assistantMsg.tool_calls = result.toolCalls.map((tc) => ({
          id: tc.id, type: 'function', function: { name: tc.name, arguments: stringifyArgs(tc.arguments) },
        }))
      }
      this.messages.push(assistantMsg)
      cb.onAssistant?.(result, assistantMsg)
      lastContent = result.content || lastContent

      if (!result.toolCalls?.length) {
        // 反思门：交付前自检，发现实质问题则回环修正（自我纠正）
        if (reflectIter < this.reflectMaxIterations && this._shouldReflect(usedTools, turns)) {
          const verdict = await this._reflect({ system, signal }).catch((e) => {
            this.logger('warn', '[reflect] 自检异常，跳过（直接交付）', e?.message || e)
            return null
          })
          reflectIter++
          if (verdict?.usage) usage = mergeUsage(usage, verdict.usage)
          this.devLog?.('reflect', { revise: !!verdict?.revise, feedback: verdict?.feedback || null, iter: reflectIter }, taskId, ctx?.devScope)
          if (verdict?.revise) {
            this.logger('mark', `[reflect] 自检发现需修正：${verdict.feedback || ''}——回环重做`)
            // 反馈走 system 而非 messages（审计 §3.7 根治）：role:'user' 的反馈会被模型当成用户说的话，
            // 导致最终回复"你说的对…"。改为：弹起草稿 assistant（重新生成而非续写）+ 反馈存 _pendingReflect，
            // 下一轮 _assembleSystem 拼进 system（系统指令，模型不当用户话），用后即清。
            this.messages.pop() // 移除刚 push 的草稿 assistant
            this._pendingReflect = verdict.feedback || '草拟回复存在未达标之处'
            continue
          }
          this.logger('debug', '[reflect] 自检通过，照常交付')
        }
        stopReason = result.finishReason || 'end_turn'
        break
      }

      // 执行工具
      const execCtx = new ExecutionContext({ agent: this, taskId, messages: this.messages, signal, logger: this.logger, props: { ctx } })
      const toolResults = await this._executeToolCalls(result.toolCalls, execCtx, cb, ctx)
      usedTools = true
      for (const trm of toolResults) this.messages.push(trm)

      // clarify 短路：指定工具的结果作为最终回复
      const sc = toolResults.find((tr) => this.shortCircuitTools.includes(tr.name))
      if (sc) {
        let q = sc.content
        try { const o = JSON.parse(q); if (o && o.clarify) q = o.clarify } catch { /* keep raw */ }
        lastContent = String(q)
        this.messages.push({ role: 'assistant', content: lastContent })
        stopReason = 'clarify'
        break
      }

      // LoopGovernor：上报本轮工具调用 + 检测循环停滞（审计 §2.1）。命中则终止，留给下方收尾交付
      if (this.governor) {
        for (let i = 0; i < result.toolCalls.length; i++) {
          const tc = result.toolCalls[i]
          const trm = toolResults[i]
          const ok = !!trm && !isToolError(trm.content)
          this.governor.noteToolCall(tc.name, tc.arguments, ok, undefined, resultSignature(trm?.content))
        }
        const g = this.governor.shouldStop()
        if (g.stop) {
          stopReason = g.reason
          this.logger('mark', `[governor] 循环终止：${g.reason}`, JSON.stringify(this.governor.snapshot()))
          this.devLog?.('governor_stop', { reason: g.reason, ...this.governor.snapshot() }, taskId, ctx?.devScope)
          break
        }
      }
    }

    if (!stopReason) {
      stopReason = 'max_turns'
      this.logger('warn', `Agent 达到 maxTurns(${this.maxTurns})，提前结束`)
    }

    // 强制收尾：governor 终止 / max_turns 耗尽 且未产出最终回复时，做一次"不带工具"的收尾调用，
    // 让模型据已完成工具结果向用户交付进展（而非返回空串）。审计 §2.1。
    if (this.governor && !lastContent && GOVERNOR_STOP.has(stopReason)) {
      try {
        const wrapSys = this._assembleSystem(memories, systemPromptOverride, context, scopeId).system
        const wrap = await this.provider.chat({
          model: this.model,
          messages: [...this.messages, { role: 'user', content: GOVERNOR_WRAP_DIRECTIVE }],
          system: wrapSys,
          tools: undefined,
          tool_choice: 'none',
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          thinking: this.thinking,
          signal,
          stream: false,
        })
        if (wrap?.content) {
          lastContent = wrap.content
          if (wrap.usage) usage = mergeUsage(usage, wrap.usage)
          this.logger('mark', `[governor] 强制收尾（${stopReason}）：让模型总结已完成进展`)
          this.devLog?.('governor_wrap', { reason: stopReason, contentLen: lastContent.length, usage: wrap.usage || null }, taskId, ctx?.devScope)
        }
      } catch (e) {
        this.logger('warn', '[governor] 收尾调用失败（交付空回复）', e?.message || e)
      }
    }

    // 持久化 session + 异步抽取记忆（按 scopeUserId 归属）
    // 反思草稿已 pop、反馈走 system 不进 messages，历史天然干净（无需额外过滤）
    const persistMsgs = this.messages.slice(sessStart)
    if (useConv) {
      // 连同本轮最终工具激活集一起持久（下轮恢复，保 tools 前缀稳定 → 缓存不 bust）
      const extra = discoveryOn && this.activeTools ? { activeTools: [...this.activeTools] } : {}
      try { await this.session.appendConversation(scopeUserId, ctx.groupId, ctx.conversationId, persistMsgs, extra) } catch (e) { this.logger('warn', 'conversation 持久化失败', e) }
    } else if (sessKey) {
      try { await this.session.append(sessKey, persistMsgs) } catch (e) { this.logger('warn', 'session 持久化失败', e) }
    }
    if (this.recall && ctx) {
      const snapshot = this.messages.slice()
      const llm = this.recallLlm || null
      // 异步抽取记忆：可观测（原空 catch 吞错，现记 logger + devLog，便于排查抽取失败/验证触发）
      setImmediate(async () => {
        const __t = Date.now()
        try {
          await this.recall.extractAndWrite(snapshot, scopeUserId, { llm })
          this.logger('debug', `[recall] 异步抽取完成 scope=${scopeUserId} msgs=${snapshot.length} ms=${Date.now() - __t}`)
          this.devLog?.('recall_extract', { scopeUserId, ok: true, msgs: snapshot.length, hasLlm: !!llm, ms: Date.now() - __t }, taskId, ctx?.devScope)
        } catch (e) {
          this.logger('warn', '[recall] 抽取失败', e?.message || e)
          this.devLog?.('recall_extract', { scopeUserId, ok: false, hasLlm: !!llm, error: e?.message || String(e) }, taskId, ctx?.devScope)
        }
      })
    }

    this.logger('mark', 'run end turns=', turns, 'stop=', stopReason, 'usage=', fmtUsage(usage), 'replyLen=', (lastContent || '').length, `totalMs=${Date.now() - __runStart}`)
    this.devLog?.('run_end', { turns, stopReason, usage, replyLen: (lastContent || '').length, totalMs: Date.now() - __runStart, usedTools }, taskId, ctx?.devScope)
    return { content: lastContent, messages: this.messages, usage, turns, taskId, stopReason }
  }

  _inputText(input) {
    if (input == null) return ''
    if (typeof input === 'string') return input
    if (typeof input.content === 'string') return input.content
    // 多模态：content 为协议原生块数组时，拼接所有 text 块作为可 Guard/记忆的纯文本
    if (Array.isArray(input.content)) {
      return input.content
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text || '')
        .join('\n')
        .trim()
    }
    try { return JSON.stringify(input) } catch { return '' }
  }

  _buildUserMessage(input, text) {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      // 多模态：apps 经 createMediaService.buildContent 构造的协议原生 content 数组
      // 用 Guard 后的文本置顶/替换 text 块，保留其余媒体块；剥离 _media 标记不入历史
      if (input._media && Array.isArray(input.content)) {
        const nonText = input.content.filter((b) => !b || b.type !== 'text')
        const content = (text ? [{ type: 'text', text }] : []).concat(nonText)
        return { role: input.role || 'user', content }
      }
      return { role: input.role || 'user', ...input, content: text }
    }
    return { role: 'user', content: text }
  }

  _assembleSystem(memories, systemPromptOverride, context, scopeId) {
    // 结构化分层（稳定前缀 → 动态后缀）：身份 → 服务准则 → 执行取向 → 工具目录 → 技能 → 记忆 → 情境 → 安全
    // identity 优先级：人设 override > 进化产出(registry) > config.systemPrompt > 默认 TEMPLATES.agent.system
    const regIdentity = this.promptRegistry?.get('agent')?.system
    const identity = systemPromptOverride || regIdentity || this.systemPrompt
    // 工具目录：按需发现模式→常驻工具速查 + 分类总览（不列全量工具名，防抵消 token 收益）；全量模式→原速查
    let toolCatalog = ''
    if (this.toolDiscovery?.enable && this.tools) {
      const alwaysOnTools = this.activeTools ? [...Object.values(this._metaTools), ...[...this.activeTools].map((n) => this.tools.get(n)).filter(Boolean)] : []
      toolCatalog = buildToolDiscoverySection({ alwaysOnTools, categories: ['query', 'personal', 'message', 'group_manage', 'system'] })
    } else if (this.tools && this.tools.list().length) {
      toolCatalog = buildToolCatalogSection(this.tools.list())
    }
    const skillsSection = this.skills ? buildSkillsPromptSection(this.skills.catalog()) : ''
    const stickerSection = this.stickers ? buildStickerPromptSection(this.stickers.catalog()) : ''
    let recalledMemory = ''
    if (this.recall && memories && memories.length) recalledMemory = this.recall.formatForPrompt(memories) || ''
    // 声明式记忆按 scopeId 隔离（每群每用户各自一份 MEMORY.md/USER.md）
    const memorySnapshot = this.memory ? (this.memory.snapshotAll(scopeId) || '') : ''
    const guardHardening = this.guard ? (this.guard.systemHardening() || '') : ''
    const system = buildAgentSystemPrompt({
      identity,
      serviceDirective: SERVICE_DIRECTIVE,
      toolCatalog,
      skillsSection,
      stickerSection,
      recalledMemory,
      memorySnapshot,
      context,
      guardHardening,
    })
    // token 分段估算（供 token_breakdown；toolListTokens 在 run 处每轮补，因 _assembleSystem 早于 toolList 合成）
    const breakdown = tokenBreakdown({
      identity, service: SERVICE_DIRECTIVE, context: context || '', guard: guardHardening,
      toolCatalog, toolListTokens: 0,
      recalledMemory, memorySnapshot, skills: skillsSection, sticker: stickerSection,
      conversationTokens: this._estimateMessagesTokens(),
    }, this.estimateTokens)
    // 反思反馈拼入 system（非 messages）：让模型视为系统自检指令而非用户输入（审计 §3.7 根治）
    let reflectHint = ''
    if (this._pendingReflect) {
      reflectHint = `

【交付前自检反馈（系统自检，非用户输入，不要把本段当作用户说的话）】你上一版草拟回复存在以下不足，请据此重新给出修正后的最终回复：
` + this._pendingReflect
      this._pendingReflect = null // 用一次即清（仅指导紧接的下一次生成）
    }
    return { system: reflectHint ? system + reflectHint : system, breakdown }
  }

  /**
   * 合成本轮下发的工具列表：全量模式→全部；按需模式→ per-instance 元工具 ∪ registry.match(activeTools)。
   * 每轮调用（tool_search 可能在上一轮扩充 activeTools）。
   */
  _buildToolList() {
    if (!this.tools) return []
    if (!this.activeTools) return this.tools.list()
    const matched = this.tools.match({ names: [...this.activeTools] })
    return [...Object.values(this._metaTools), ...matched]
  }

  _estimateHistory(system) {
    const fn = this.estimateTokens || ((t) => Math.ceil((t || '').length / 4))
    let n = fn(system)
    for (const m of this.messages) {
      n += 4
      if (typeof m.content === 'string') n += fn(m.content)
      if (m.reasoning) n += fn(m.reasoning)
      if (m.tool_calls) n += fn(JSON.stringify(m.tool_calls))
    }
    return n
  }

  /** 仅估算 messages（不含 system）的 token 数 */
  _estimateMessagesTokens() {
    const fn = this.estimateTokens || ((t) => Math.ceil((t || '').length / 4))
    let n = 0
    for (const m of this.messages) {
      n += 4
      if (typeof m.content === 'string') n += fn(m.content)
      if (this.keepReasoning && m.reasoning) n += fn(m.reasoning)
      if (m.tool_calls) n += fn(JSON.stringify(m.tool_calls))
    }
    return n
  }

  /**
   * 压缩历史到 maxTokens 以下：保留首条 user 意图 + 尾部 contextKeepRecent 条，
   * 在"安全边界"丢弃中段整轮对话。
   * 安全边界：从 cutStart 起丢一块——若该块是带 tool_calls 的 assistant，连带其后所有
   * tool 结果一起丢，保证不会留下孤立的 tool_result（其触发 assistant 已被移除）。
   * @param {number} maxTokens 目标 messages token 上限
   * @returns {number} 实际丢弃的消息数
   */
  _compactMessages(maxTokens) {
    const minKeep = Math.max(this.contextKeepRecent, 2)
    if (this.messages.length <= minKeep + 1) return 0
    let dropped = 0
    let guard = 0
    // cutStart=1：始终保留 messages[0]（首条 user 意图）
    while (this._estimateMessagesTokens() > maxTokens && this.messages.length > minKeep + 1 && guard++ < 1000) {
      let cutStart = 1
      // 尾部保留 minKeep 条
      const maxCutEnd = this.messages.length - minKeep
      if (cutStart >= maxCutEnd) break
      // 从 cutStart 丢一块：assistant(tool_calls)+其 tool 结果 / 单条 user 或 assistant
      const block = [this.messages[cutStart]]
      if (this.messages[cutStart].tool_calls) {
        let j = cutStart + 1
        while (j < this.messages.length && this.messages[j].role === 'tool') { block.push(this.messages[j]); j++ }
      }
      // 块不能侵入尾部保留区
      if (cutStart + block.length > maxCutEnd) break
      this.messages.splice(cutStart, block.length)
      dropped += block.length
    }
    return dropped
  }

  _extraRunOpts(opts) {
    const reserved = new Set(['signal', 'onDelta', 'onReasoning', 'onToolStart', 'onToolEnd', 'onAssistant', 'onContextPressure', 'onApprove', 'onBeforeTool', 'onMasterAutoApprove', 'taskId', 'stream', 'ctx'])
    const out = {}
    for (const k of Object.keys(opts)) if (!reserved.has(k)) out[k] = opts[k]
    return out
  }

  async _executeToolCalls(toolCalls, execCtx, cb, ctx) {
    const hasInteractive = toolCalls.some((tc) => this.tools?.get?.(tc.name)?.meta?.interactive)
    const runOne = async (tc) => this._executeOne(tc, execCtx, cb, ctx)
    if (hasInteractive) {
      const results = []
      for (const tc of toolCalls) results.push(await runOne(tc))
      return results
    }
    return Promise.all(toolCalls.map((tc) => runOne(tc)))
  }

  async _executeOne(tc, execCtx, cb, ctx) {
    const __t = Date.now()
    cb.onToolStart?.(tc)
    const tool = this.tools?.get?.(tc.name) ?? this._metaTools?.[tc.name]
    // 注：工具调用入参/耗时/结果/错误的日志由 ToolRegistry 的 AOP 切面统一打印，
    // 这里只记录调度层关心的 outcome（未注册 / 被策略拦截 / 审批拒绝）。
    let content

    if (!tool) {
      content = stringifyArgs({ error: `Tool '${tc.name}' not found` })
      this.logger('warn', 'tool not_found', tc.name)
    } else {
      // policy + confirm 门（代码层强制，agent 无法绕过）
      const alwaysConfirm = tool?.meta?.alwaysConfirm === true
      if (this.policy && ctx) {
        const dec = this.policy.decide(ctx, tool)
        if (dec.decision === 'deny') {
          content = stringifyArgs({ error: 'rejected_by_policy', reason: dec.reason })
          this.logger('mark', 'tool denied', tc.name, 'reason=', dec.reason)
          cb.onToolEnd?.(tc, content)
          return { role: 'tool', tool_call_id: tc.id, name: tc.name, content }
        }
        // meta.alwaysConfirm（如 terminal）：即便主人/policy 放行，也强制走确认
        let needConfirm = dec.decision === 'confirm' || alwaysConfirm
        // meta.shouldConfirm（按入参否决审批）：如 terminal 的 allowlist 命中 → 免审批直跑
        if (needConfirm && typeof tool?.meta?.shouldConfirm === 'function') {
          try {
            if (await tool.meta.shouldConfirm(tc.arguments, ctx) === false) {
              needConfirm = false
              this.logger('mark', 'tool auto-allow', tc.name, 'meta.shouldConfirm 否决审批（如 allowlist 命中）')
            }
          } catch { /* shouldConfirm 出错保守起见仍走确认 */ }
        }
        if (needConfirm) {
          // 主人免确认（高危）：masterSkipConfirm 开启且当前是主人 → 跳过 #确认、发高危提示。
          // denylist 仍是硬底线（execute 里拦），不会因免确认而放行灾难命令。
          if (this.masterSkipConfirm && ctx?.isMaster) {
            this.logger('warn', '⚠️ 主人任务免确认自动执行（高危）', tc.name, brief(tc.arguments))
            cb.onMasterAutoApprove?.(tc)
            needConfirm = false
          }
        }
        if (needConfirm) {
          if (!this.confirm) {
            // 需确认但无确认器 → 拒绝（绝不放行危险动作）
            content = stringifyArgs({ error: 'rejected_by_confirm', reason: '该操作需确认但未装配确认器' })
            this.logger('warn', 'tool blocked', tc.name, '需确认但无 ConfirmStore')
            cb.onToolEnd?.(tc, content)
            return { role: 'tool', tool_call_id: tc.id, name: tc.name, content }
          }
          const approved = await this.confirm.request({ tool: tc.name, args: tc.arguments, ctx, notify: ctx?.notify })
          if (!approved) {
            content = stringifyArgs({ error: 'rejected_by_confirm', reason: '未获批准或超时' })
            this.logger('mark', 'tool rejected', tc.name, '未获批准/超时')
            cb.onToolEnd?.(tc, content)
            return { role: 'tool', tool_call_id: tc.id, name: tc.name, content }
          }
        }
      }
      // onBeforeTool 拦截（扩展点）
      let intercepted
      if (cb.onBeforeTool) intercepted = await cb.onBeforeTool(tc, execCtx)
      if (intercepted != null) {
        content = typeof intercepted === 'string' ? intercepted : stringifyArgs(intercepted)
      } else {
        try {
          const raw = await tool.execute(tc.arguments ?? {}, ctx || execCtx)
          content = typeof raw === 'string' ? raw : stringifyArgs(raw)
        } catch (e) {
          // 错误日志已由 AOP 切面打印；这里归一为 {error} 结果供模型下一轮重试
          content = stringifyArgs({ error: e?.message || String(e) })
        }
      }
    }
    // 失败回灌：工具返回/抛出错误时，把"据实回复"提示注入 tool 结果（JSON 字段，保持可 parse）——
    // 让模型据实转告用户真实错误，而非忽略错误去臆测/编造失败原因（杜绝"schema bug"式瞎编）
    if (isToolError(content)) {
      try { const o = JSON.parse(content); o._hint = TOOL_FAIL_HINT; content = JSON.stringify(o) }
      catch { content = content + '\n' + TOOL_FAIL_HINT } // 非 JSON 结果才回退追加
    }
    const __toolOk = !isToolError(content)
    const __toolMs = Date.now() - __t
    this.devLog?.('tool', {
      name: tc.name, args: tc.arguments, ok: __toolOk, result: content, ms: __toolMs,
      ...toolResultFields({ name: tc.name, ok: __toolOk, ms: __toolMs, result: content }),
    }, execCtx.taskId, ctx?.devScope)
    cb.onToolEnd?.(tc, content)
    return { role: 'tool', tool_call_id: tc.id, name: tc.name, content: this._capToolResult(content, tool) }
  }

  /** 反思门控：off→不反思；always→每次最终回复都反思；auto→仅在本轮用过工具或多步时反思（纯闲聊零延迟） */
  _shouldReflect(usedTools, turns) {
    const mode = this.reflect
    if (!mode || mode === 'off') return false
    if (mode === 'always') return true
    return !!(usedTools || turns > 1) // 'auto'
  }

  /**
   * 交付前自检：在消息快照上做一次评判调用（不污染主 messages），返回 {revise, feedback, usage}。
   * revise=true 表示发现实质问题、需回环修正。任何异常/解析失败一律返回 revise=false，绝不阻塞主流程。
   * 草拟回复已是 this.messages 末尾的 assistant 消息，评判者据此核查完整性/准确性/一致性。
   */
  async _reflect({ system, signal } = {}) {
    const reflectSystem = system ? `${system}\n\n${REFLECTION_DIRECTIVE}` : REFLECTION_DIRECTIVE
    const messages = [...this.messages, { role: 'user', content: '请对上面你草拟的最终回复做交付前自检，并按指定 JSON 格式给出结论。' }]
    const res = await this.provider.chat({
      model: this.model,
      messages,
      system: reflectSystem,
      tools: undefined, // 纯评判，不带工具
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      thinking: this.thinking,
      signal,
      stream: false,
    })
    const text = (res?.content || '').trim()
    const m = text.match(/\{\s*"revise"\s*:\s*(true|false)\s*\}/i)
    if (!m || !/true/i.test(m[1])) return { revise: false, usage: res?.usage || null }
    const feedback = text.slice(text.indexOf('}') + 1).trim() || '草拟回复存在未达标之处'
    return { revise: true, feedback, usage: res?.usage || null }
  }

  /** 工具结果封顶：优先 meta.resultCap，否则全局 maxToolResultChars。
   *  结构化截断（审计 §3.4）：JSON 结果按类型裁剪并保证仍可 JSON.parse；非 JSON 文本才字符 slice。 */
  _capToolResult(content, tool) {
    const max = tool?.meta?.resultCap ?? this.maxToolResultChars
    if (!max || typeof content !== 'string' || content.length <= max) return content
    let parsed
    try { parsed = JSON.parse(content) } catch { parsed = undefined }
    if (parsed === undefined) {
      return content.slice(0, max) + `\n…(已截断，原文 ${content.length} 字符；如需完整结果请缩小查询范围)`
    }
    return JSON.stringify(truncateJson(parsed, max))
  }
}

export { ExecutionContext } from './tools/context.js'
export { estimateMessages } from './messages.js'
