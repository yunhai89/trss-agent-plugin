import plugin from '../../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Config from '../utils/Config.js'
import Log from '../utils/Log.js'
import {
  Agent,
  createProvider,
  ToolRegistry,
  MemoryStore,
  createMemoryTool,
  makeRecallTool,
  SessionStore,
  RecallStore,
  ScheduleStore,
  reminderSetTool,
  parseCron,
  scheduleTaskTool,
  ConfirmStore,
  nodeScheduleAdapter,
  memoryKv,
  redisKv,
  noteTools,
  clarifyTool,
  checkInput,
  systemHardening,
  createPolicy,
  buildChatListHtml,
  buildPersonaListHtml,
} from '../model/agent/index.js'
import { presets as openaiPresets } from '../model/openai/index.js'
import { presets as anthropicPresets } from '../model/anthropic/index.js'
import { McpManager } from '../model/mcp/index.js'
import { createMediaService, makeMediaTools } from '../model/media/index.js'
import { detectCapabilities } from '../model/llm/capabilities.js'
import { embed } from '../model/llm/embed.js'
import { KnowledgeStore, makeKbSearchTool } from '../model/agent/knowledge.js'
import { webCrawlTool } from '../model/crawl/index.js' // web_crawl：抓取网页正文（常驻）
import { groupInfoTools, groupManageTools, groupHistoryTools, groupNoticeTools, groupFileTools, aiVoiceTools, forwardTools } from '../model/group/index.js'
import { miyousheTools } from '../model/miyoushe/index.js'
import { pixivTools } from '../model/pixiv/index.js'
import { loadToolPacks } from '../model/toolkit/index.js'
import { createSearchManager, makeSearchTools } from '../model/search/index.js'
import { PersonaStore, PersonaService } from '../model/persona/index.js'
import { VisionService, describeImages } from '../model/vision/index.js'
import { getStickerManager } from '../model/sticker/manager.js'
import { redactSecrets } from '../model/agent/redact.js'
import { randomUUID } from 'node:crypto'
import devLog from '../utils/DevLog.js'
import { SkillRegistry, loadSkillPack, makeSkillTool } from '../model/skill/index.js'
import { PromptRegistry, PromptTemplate, regressionGate, evolveTemplate, TEMPLATES } from '../model/prompt/index.js'
import { TraceStore } from '../model/evolution/trace.js'
import { SelfReviewer, listPendingSuggestions, removeSuggestion } from '../model/evolution/review.js'
import { buildSituationalContext } from '../model/perception.js'
import { makeTerminalTool, DEFAULT_BLOCKLIST, requestClaim, claim, getMaster as getTerminalMaster, isMaster as isTerminalMaster, resolveApproval as resolveTerminalApproval, listApprovals as listTerminalApprovals } from '../model/terminal/index.js'
import { makeStagehand } from '../model/stagehand/index.js'
import { makeDownloadTool } from '../model/download/index.js'
import { calcTool } from '../model/calc/index.js'
import { sendFileTool } from '../model/document/sendfile.js'
import { readPdfTool } from '../model/document/pdf.js'
import { createExcelTool, readExcelTool } from '../model/document/excel.js'
import { fileToPdfTool } from '../model/document/topdf.js'
import { transcribeMediaTool } from '../model/document/media_stt.js'
import { screenshot, renderReplyImage } from './render.js'
import { REPLY_CSS } from '../model/render/theme.js'
import { toFileSegment } from '../utils/SendFile.js'

/** 插件根目录（apps/ 的上两级）—— 用于定位 tools/ 自定义工具包目录 */
// agent.js 在 apps/ 子目录，dirname=agents-plugin/apps；'..'=agents-plugin（插件根），'../..' 会多上一级到 plugins
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ─── 进度反馈：工具调用时推送节流进度消息，消除"干等几十秒"的僵化感 ───
// 真正的逐字流式依赖 QQ 适配器（icqq/napcat 差异大、编辑消息不稳），故默认只做可靠的进度反馈；
// agent.stream=true 时才让 provider 流式（onDelta 可用，供未来适配器接入）。
const PROGRESS_LABELS = {
  web_search: '🔍 联网搜索',
  ddg: '🔍 联网搜索',
  tavily: '🔍 联网搜索',
  exa: '🔍 联网搜索',
  brave: '🔍 联网搜索',
  perplexity: '🔍 联网搜索',
  skill: '📖 加载技能',
  reload_skills: '🔄 重载技能',
  read_attachment: '📎 读取附件',
  get_group_file: '📎 获取文件',
  list_group_files: '📎 列出文件',
  terminal: '💻 执行命令',
  calculate: '🧮 计算中',
  file_to_pdf: '📄 转PDF',
  process: '💻 进程操作',
  group_info: '⚙️ 查群信息',
  group_members: '⚙️ 查成员',
  group_member: '⚙️ 查成员',
  group_kick: '⚙️ 群操作',
  group_mute: '⚙️ 群操作',
  group_mute_all: '⚙️ 群操作',
  group_set_card: '⚙️ 群操作',
  group_set_title: '⚙️ 群操作',
  group_set_admin: '⚙️ 群操作',
  group_set_name: '⚙️ 群操作',
  miyoushe_search: '🎮 查米游社',
  memory: '📝 更新记忆',
  memory_search: '🧠 检索记忆',
  // 群公告
  send_group_notice: '📢 发群公告',
  get_group_notice: '📢 查群公告',
  delete_group_notice: '📢 删群公告',
  // 群文件 CRUD
  upload_group_file: '📤 上传群文件',
  delete_group_file: '🗑️ 删群文件',
  create_group_folder: '📂 建文件夹',
  delete_group_folder: '🗑️ 删文件夹',
  list_group_folder: '📂 列群文件',
  get_group_file_url: '🔗 取文件直链',
  move_group_file: '📂 移动文件',
  rename_group_file: '📂 重命名',
  transfer_group_file: '📂 跨群转发',
  // AI 语音
  get_ai_characters: '🎙️ 查语音角色',
  ai_tts: '🎙️ 合成语音',
  send_group_ai_record: '🎙️ 发AI语音',
  // 合并转发
  send_forward_msg: '📦 合并转发',
  get_forward_msg: '📦 读转发消息',
  // Pixiv
  pixiv_search: '🎨 搜Pixiv',
  pixiv_illust: '🎨 取Pixiv作品',
  pixiv_ranking: '🎨 Pixiv榜单',
  pixiv_user: '🎨 查Pixiv画师',
  pixiv_tags: '🎨 查Pixiv标签',
}

/** 从工具调用参数提取关键信息，给进度消息加上下文（让用户知道在干什么，而非只看到工具名） */
function extractArgHint(args, name) {
  let a = args
  if (typeof a === 'string') { try { a = JSON.parse(a) } catch { return null } }
  if (!a || typeof a !== 'object') return null
  const fields = {
    web_search: 'query', miyoushe_search: 'keyword', memory_search: 'query',
    calculate: 'code', terminal: 'command', create_excel: 'filename', file_to_pdf: 'path',
    read_pdf: 'path', read_excel: 'path', transcribe_media: 'path',
    send_file: 'path', get_chat_history: 'count', get_group_file: 'name',
    group_member: 'userId', group_info: 'groupId',
    send_group_notice: 'content', upload_group_file: 'name',
    delete_group_file: 'fileId', get_group_file_url: 'fileId',
    create_group_folder: 'name', rename_group_file: 'newName',
    transfer_group_file: 'targetGroupId', delete_group_notice: 'noticeId',
    pixiv_search: 'word', pixiv_illust: 'id', pixiv_ranking: 'mode',
    pixiv_user: 'userId', pixiv_tags: 'word',
  }
  const field = fields[name]
  if (field && a[field] != null) {
    let v = String(a[field]).trim()
    if (name === 'calculate') v = v.split('\n')[0]
    if (name === 'terminal') v = v.split(/[;&|]/)[0].trim()
    if (field === 'path') v = v.split('/').pop()
    return v.slice(0, 40)
  }
  // 未登记工具不再 fallback 取首个字符串值（否则会把 memory 的 target='memory' 这类
  // 内部枚举字段当 hint 贴出，产出"🔧 调用 memory：memory"之类的无意义进度）。只发 label。
  return null
}

/**
 * 构造 utility-model 进度播报的 prompt（参考 OpenClaw progress-narrator-model.ts，中文化）。
 * 输入：用户请求摘要 + 近期工具事件 + 上一条播报（避免重复）→ 一句贴合上下文的自然语言状态。
 */
// 进度播报指令放 system（模型视为系统设定，不复述）；user 只放数据，降低"用户让我…"式指令泄露
const NARRATION_SYSTEM = `你是进度播报员：只用一句简短、口语化的中文（不超过 30 字）描述 AI 助手此刻正在执行的工具动作（如搜索/计算/读取），不要解释用户说了什么。

绝对禁止：
- 解释/翻译/复述用户请求（如"用户请求是…""这是中文意思是…"）——这是进度播报，不是翻译任务
- 复述本指令，引用"工具调用/上一条播报"原文
- 说出"用户让我…/首先…/任务/字数"等元话语
- emoji、引号、列表、工具名/API 等技术术语

只输出一句动作描述。示例：「正在搜索相关信息…」「在读取文件…」「上一步没成功，换个方法」。`

function buildNarrationPrompt(events, previousText) {
  // 仅工具事件 + 上一条播报（不再喂用户请求原文，避免模型翻译/解释用户请求而非播报进度）
  return [
    `\n近期工具调用（由旧到新）：\n${events || '(无)'}`,
    previousText ? `\n\n上一条播报（不要与它重复）：${previousText}` : '',
    '\n\n请直接输出一句描述 AI 正在做什么的进度：',
  ].join('')
}

/**
 * 构造进度反馈回调集合。
 * @param {object} e Yunzai 事件
 * @param {object} opts { progress, recall, provider, model, utilityModel, shortCircuitTools, userText }
 */
function makeReplyStream(e, {
  progress = true, recall = 3, provider = null, model = null,
  utilityModel = null, shortCircuitTools = ['clarify'], userText = '',
} = {}) {
  if (!progress) return {}
  let lastAt = 0
  let lastTool = null
  let count = 0
  const MIN_INTERVAL = 1500 // ms：节流，防刷屏
  const MAX_MSGS = 8 // 单轮最多 8 条进度，防病态循环刷屏
  // utility-model narrator state（OpenClaw Layer 2：主模型不产文本时，用廉价 LLM 生成一句话进度）
  const toolEvents = []
  let lastNarrationAt = 0
  let narrationCount = 0
  let lastNarration = '' // 上一条播报，喂回 prompt 避免重复
  const reqBrief = String(userText || '').slice(0, 500) // 用户请求摘要，给 narration 当上下文
  const narrModel = utilityModel || model // 留空则沿用主模型（向后兼容）

  // fire-and-forget narrator：immediate=true（失败事件）时跳过节流立即生成；否则按 ≥3 事件/15s 节流，单任务最多 3 次
  async function tryNarrate({ immediate = false } = {}) {
    if (!provider || !narrModel) return
    const now = Date.now()
    if (narrationCount >= 3) return
    if (!immediate) {
      if (toolEvents.length < 3 && now - lastNarrationAt < 15000) return
      if (now - lastNarrationAt < 5000) return
    }
    lastNarrationAt = now
    narrationCount++
    const events = toolEvents.slice(-5).map((ev, i) => `${i + 1}. ${ev}`).join('\n')
    try {
      const res = await provider.chat({
        model: narrModel,
        system: NARRATION_SYSTEM,
        messages: [{ role: 'user', content: buildNarrationPrompt(events, lastNarration) }],
        max_tokens: 80,
        stream: false,
      })
      const status = (res?.content || '').trim().replace(/^["「""']+|["「""']+$/g, '').slice(0, 40)
      // 兜底防指令泄露：模型若仍复述指令/元话语（"用户让我…/要求…/字数"等），丢弃不播报
      const leaked = /用户让我|要求我|本指令|不超过|字以内|简短|口语化|播报员|任务要求/.test(status)
      if (status && !leaked) {
        lastNarration = status
        try { e.reply(`💭 ${status}`, false, { recallMsg: recall }) } catch { /* noop */ }
      }
    } catch { /* narrator 失败不影响主流程 */ }
  }

  return {
    onToolStart(tc) {
      if (count >= MAX_MSGS) return
      const now = Date.now()
      const name = tc?.name
      if (!name) return
      // 短路工具（如 clarify）：参数本身就是最终回复，发进度=与最终回复重复，跳过
      if (shortCircuitTools.includes(name)) return
      if (name === lastTool && now - lastAt < 5000) return
      if (now - lastAt < MIN_INTERVAL) return
      lastAt = now
      lastTool = name
      count++
      const label = PROGRESS_LABELS[name] || `🔧 调用 ${name}`
      const hint = extractArgHint(tc?.arguments, name)
      const msg = hint ? `${label}：${hint}` : `${label}…`
      try { e.reply(msg, false, { recallMsg: recall }) } catch { /* noop */ }
    },
    // 工具结束（含失败）：检测到失败时，立即触发一次贴合上下文的自然语言播报（"搜索没响应，换方法重试"）
    onToolEnd(tc, content) {
      const name = tc?.name
      if (!name || shortCircuitTools.includes(name)) return
      let failed = false
      if (typeof content === 'string') {
        const s = content.slice(0, 200)
        if (/"error"\s*:/.test(s) || /rejected_by_(policy|confirm)/.test(s) || /Tool '.*' not found/.test(s)) failed = true
      }
      if (!failed) return
      // 工具失败：主模型会据 error 结果回复用户，不再用 utility model 额外 💭 播报（narrator 已移除）
    },
  }
}

/**
 * agents-plugin 对话命令。
 *   触发 AI：艾特机器人（默认）或自定义触发词（agent.trigger: at|command|both + triggerCommand）
 *   #聊天列表 / #进入聊天 <id> / #new          多对话管理
 *   #确认/#拒绝/#待确认（master）              审批
 *   #记忆 / #忘掉 <kw>                         长期记忆
 *   #我的提醒 / #取消提醒 <id>                  提醒
 *   #模型切换 <id>（master）                    切换模型
 *   #启用mcp <名> / #停止mcp <名>（master）     MCP 服务端启停
 *   #mcp（master）                             MCP 状态
 * 主人判定：大部分主人指令用 Yunzai 原生 permission:'master'（即 e.isMaster / cfg.master）。
 * 例外：terminal 工具用自包含的「terminal 主人」（验证码认领，model/terminal/master.js），
 *   #确认/#拒绝/#待确认 放宽为「框架主人 OR terminal 主人」均可。
 */

let _runtime = null
let _runtimePromise = null // in-flight buildRuntime()，并发安全：多调用方共享同一次构建
let _runtimeFailed = null  // buildRuntime 失败原因缓存；非 null 则 getRuntime 直接抛、不再重试，避免每条消息刷屏重建
let _initErrLogged = false // 初始化失败日志限首（防每条消息重复打 ERRO）
const _initFailNotified = new Set() // 已提示过"初始化失败"的用户(每用户仅提示一次，防刷屏)；runtime 重建时清
const _clearPending = new Map() // userId → 确认清空的时间戳（2 步确认）

function getKv() {
  if (typeof globalThis !== 'undefined' && globalThis.redis) return redisKv(globalThis.redis)
  return memoryKv()
}

// 一次性把旧「TRSS data 目录」下的插件数据迁到插件自己目录（Config.path.data 下）。幂等。
// memories/personas 等持久数据；首次迁移后旧目录留空壳（不删，避免误伤）。
function migratePluginData() {
  try {
    const moves = [
      ['memories', Config.path.memories],
      ['personas', Config.path.personas],
    ]
    for (const [name, dst] of moves) {
      const src = path.join(Config.path.yunzai, 'data/agents-plugin', name)
      if (!fs.existsSync(src)) continue
      // 目标已有内容则不迁（避免覆盖）
      let dstHas = false
      try { dstHas = fs.existsSync(dst) && fs.readdirSync(dst).length > 0 } catch { /* noop */ }
      if (dstHas) continue
      try { fs.mkdirSync(path.dirname(dst), { recursive: true }) } catch { /* noop */ }
      // 整目录搬移（rename 跨设备会失败 → 退化逐项复制）
      try { fs.renameSync(src, dst); Log.mark('[migrate] 迁移', name, '→', dst); continue }
      catch { /* 跨设备，走逐项复制 */ }
      try {
        fs.mkdirSync(dst, { recursive: true })
        for (const f of fs.readdirSync(src)) {
          const s = path.join(src, f), d = path.join(dst, f)
          fs.copyFileSync(s, d)
        }
        Log.mark('[migrate] 复制', name, '→', dst, '（旧目录保留）')
      } catch (e) { Log.warn('[migrate] 迁移失败', name, e?.message || e) }
    }
  } catch { /* noop */ }
}

// 构造走代理的 fetch（undici ProxyAgent）；undici 未装/地址错则返回 null（直连）。供 provider 访问海外 LLM（GPT/Gemini 等）
async function makeProxyFetch(proxy) {
  if (!proxy) return null
  try {
    const { ProxyAgent, fetch: uFetch } = await import('undici')
    const dispatcher = new ProxyAgent(proxy)
    return (url, opts = {}) => uFetch(url, { ...opts, dispatcher })
  } catch (e) {
    Log.warn('[provider] 代理不可用（undici 未装或地址错误），将直连', e?.message || e)
    return null
  }
}

async function buildRuntime() {
  const cfg = Config.get().agent || {}
  if (!cfg.apiKey) throw new Error(`未配置 agent.apiKey：请编辑「${Config.path.userConfig}」填入 agent.apiKey（OpenAI 兼容接口密钥，如 DeepSeek/OpenAI/智谱/mimo）。该文件是插件自己的配置（首次启动已自动生成），不是 default_config。`)

  const protocol = cfg.protocol || 'openai'
  const presetMap = protocol === 'anthropic' ? anthropicPresets : openaiPresets
  const preset = cfg.preset ? presetMap[cfg.preset] : {}
  const proxyFetch = cfg.proxy ? await makeProxyFetch(cfg.proxy) : null
  const provider = createProvider({
    protocol,
    ...preset,
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    apiKey: cfg.apiKey,
    model: cfg.model,
    ...(cfg.reasoningFields ? { reasoningFields: cfg.reasoningFields } : {}),
    ...(proxyFetch ? { fetch: proxyFetch } : {}),
  })

  // 可选 embedding 函数：填了 recall.embedProvider 才造（OpenAI 兼容 /embeddings 端点），供工具检索 + recall 语义召回共用。
  // 配了 embedBaseURL/embedApiKey 则用独立 embedding provider（专门 embedding 服务），否则复用主 provider
  const _rcfg = cfg.recall || {}
  const embedFn = _rcfg.embedProvider
    ? (text) => embed(text, {
        client: (_rcfg.embedBaseURL || _rcfg.embedApiKey)
          ? { baseURL: _rcfg.embedBaseURL || provider.client?.baseURL, apiKey: _rcfg.embedApiKey || provider.client?.apiKey }
          : provider,
        model: _rcfg.embedProvider,
      })
    : null

  // 回退 provider：每条独立 baseURL/apiKey/protocol（可跨厂商，如主 DeepSeek + 回退 GPT）
  const fallbackProviders = []
  const fbList = [...(Array.isArray(cfg.fallbackModels) ? cfg.fallbackModels : [])]
  if (cfg.fallbackModel && cfg.fallbackApiKey) fbList.push({ model: cfg.fallbackModel, baseURL: cfg.fallbackBaseURL, apiKey: cfg.fallbackApiKey, protocol: cfg.fallbackProtocol }) // 兼容锅巴扁平字段（单回退）
  for (const fb of fbList) {
    if (!fb || !fb.model || !fb.apiKey) continue
    try {
      const fbp = fb.protocol || 'openai'
      const fbPreset = fb.preset ? (fbp === 'anthropic' ? anthropicPresets : openaiPresets)[fb.preset] : {}
      const fp = createProvider({
        protocol: fbp, ...fbPreset,
        ...(fb.baseURL ? { baseURL: fb.baseURL } : {}),
        apiKey: fb.apiKey, model: fb.model,
        ...(proxyFetch ? { fetch: proxyFetch } : {}),
      })
      fallbackProviders.push({ provider: fp, model: fb.model })
    } catch (e) { Log.warn('[fallback] 回退模型装配失败', fb?.model, e?.message || e) }
  }

  // 一切数据存插件自己目录（Config.path.data 下）；首次运行把旧 TRSS data 目录的数据迁过来
  migratePluginData()
  const memoryDir = Config.path.memories
  const memory = new MemoryStore({
    dir: memoryDir,
    limits: cfg.memoryLimits || undefined, // 接通死配置；null 会覆盖默认 → undefined 回落 DEFAULT_LIMITS
    enabled: cfg.memory?.enable === false ? { memory: false, user: false } : undefined,
  })
  const personaDir = Config.path.personas
  const personaStore = new PersonaStore({ dir: personaDir })
  const K = getKv()
  const session = new SessionStore({ kv: K })
  // 记忆威胁扫描：写入前检测指令注入（复用入口 guard.checkInput）。threatScan 关闭则不扫
  const recallScanFn = cfg.memory?.threatScan === false ? null : (text) => {
    try {
      const g = checkInput(String(text || ''), { sensitivity: 'medium', action: 'flag' })
      return !!g.blocked || (typeof g.score === 'number' && g.score >= 0.6)
    } catch { return false }
  }
  const recall = new RecallStore({
    kv: K,
    cap: cfg.recall?.cap,
    extractEvery: cfg.recall?.extractEvery,
    scanFn: recallScanFn,
    // embedding（可选）：填了 recall.embedProvider 即走 cosine 语义召回，否则纯关键词 jaccard
    embedFn,
  })
  // 知识库（全局共享文档库）：复用 recall 的 embedFn，chunk+向量化存 KV，kb_search 检索（RAG）
  const knowledge = new KnowledgeStore({
    kv: K, embedFn,
    chunkSize: cfg.kb?.chunkSize, chunkOverlap: cfg.kb?.chunkOverlap,
    topK: cfg.kb?.topK, minScore: cfg.kb?.minScore,
  })
  // confirmTimeout 配置单位是「秒」，ConfirmStore 用「毫秒」，这里换算（默认 300 秒）
  const confirm = new ConfirmStore({ timeout: (cfg.confirmTimeout || 300) * 1000 })
  const scheduler = await nodeScheduleAdapter()
  const schedule = new ScheduleStore({ kv: K, scheduler })
  knowledge.attachScheduler(scheduler) // KB URL 定时刷新复用同一 scheduler（注册/恢复 refresh job）
  const persona = new PersonaService({ store: personaStore, kv: K })

  // Skill（说明书 / 指令包）：从 skills/ 目录加载 .md/.js，按用户输入匹配后注入 prompt
  const skills = new SkillRegistry()
  const skillsDir = path.resolve(PLUGIN_ROOT, cfg.skill?.dir || 'skills')
  const userSkills = await loadSkillPack(skillsDir, { logger: Log.tag('skill') })
  for (const s of userSkills) {
    try { skills.register(s) } catch (e) { Log.warn('[skill] 注册失败', s.name, e?.message || e) }
  }

  // 统一搜索：多源自动路由（Tavily/Exa/Perplexity/Brave → SearXNG → DDG 兜底）
  const searchManager = createSearchManager({
    ...(cfg.search || {}),
    fetcher: (typeof fetch !== 'undefined' && fetch) || undefined,
    logger: Log.tag('search'),
  })
  const enabledSearch = searchManager.availableProviders
  if (enabledSearch.length) Log.info('[search] 已启用搜索源：' + enabledSearch.join('、'))

  const tools = new ToolRegistry({ logger: Log.tag('tool') })
    .register(...makeSearchTools(searchManager)) // web_search（多源）+ web_extract
    .register(...noteTools({ kv: K }))
    .register(clarifyTool)
    .register(createMemoryTool(memory))
    .register(makeRecallTool(recall)) // memory_search：模型主动检索长期记忆
    .register(...makeMediaTools())
  // kb_search：知识库检索（默认开；cfg.kb.enable:false 关闭）
  if (cfg.kb?.enable !== false) tools.register(makeKbSearchTool(knowledge))
  // web_crawl：抓取网页正文（常驻；cfg.kb.crawlEnable:false 关闭）
  if (cfg.kb?.crawlEnable !== false) tools.register(webCrawlTool)

  // 内置基础工具包：群信息 / 群管 / 米游社
  if (cfg.tools?.builtin !== false) {
    tools
      .register(...groupInfoTools)
      .register(...groupManageTools)
      .register(...groupHistoryTools) // get_chat_history：模型按需拉群聊近期记录（被动找回）
      .register(...groupNoticeTools) // 群公告：发送/获取/删除
      .register(...groupFileTools) // 群文件 CRUD：上传/删除/文件夹/列目录/直链/移动/重命名/跨群
      .register(...aiVoiceTools) // AI 语音：角色列表/文字转语音/群内发送
      .register(...forwardTools) // 合并转发：发送/获取
      .register(...miyousheTools)
      .register(reminderSetTool) // reminder_set：对话设提醒（到时间 fireReminder 主动发消息）
      .register(scheduleTaskTool) // schedule_task：对话设 cron 重复任务链（到点跑 Agent + 发结果）
  }

  // Pixiv（需 refreshToken；未配置则不注册，避免暴露不可用工具）
  if (cfg.pixiv?.enable !== false && cfg.pixiv?.refreshToken) {
    tools.register(...pixivTools) // 搜索/作品(发图)/排行/用户/标签
    Log.info('[pixiv] 已启用 Pixiv 工具（搜索/作品/排行/用户/标签；图片代理 ' + (cfg.pixiv.imageProxy || 'https://i.yuki.sh') + '）')
  }

  // 自定义工具包：扫描插件根 tools/ 目录自动加载（TRSS-Yunzai apps 风格）
  const toolsDir = path.resolve(PLUGIN_ROOT, cfg.tools?.dir || 'tools')
  const loaded = await loadToolPacks(toolsDir, { logger: Log.tag('toolkit') })
  for (const t of loaded.tools) {
    try { tools.register(t) } catch (e) { Log.warn('[toolkit] 注册失败', t.name, e?.message || e) }
  }
  if (loaded.packs.length) Log.info('[toolkit] 已加载工具包：', loaded.packs.map((p) => `${p.name}(${p.count})`).join(', '))

  // 终端执行能力（高危，默认关；真机执行 + 仅验证码认领的 terminal 主人 + 每条命令 #确认 + 黑名单）
  if (cfg.terminal?.enable) {
    tools.register(makeTerminalTool())
    const tm = getTerminalMaster()
    Log.info(`[terminal] 已启用主机终端执行工具（仅 terminal 主人可用；当前主人：${tm || '未认领，发 #agents设置主人 认领'}）`)
  }

  // 媒体下载（yt-dlp；受约束、仅框架主人；默认开。给 LLM 专用下载入口，避免它去抓 terminal 裸 shell）
  if (cfg.download?.enable !== false) {
    try { tools.register(makeDownloadTool()) } catch (e) { Log.warn('[download] 注册失败', e?.message || e) }
  }

  // Stagehand 浏览器自动化（可选，默认关；goto/observe/extract/act；仅框架主人；act 需 #确认）
  let stagehand = null
  if (cfg.stagehand?.enable) {
    try {
      const { pack, sessionMgr } = makeStagehand({ cfg: cfg.stagehand, agent: cfg })
      for (const t of pack.resolve({})) {
        try { tools.register(t) } catch (e) { Log.warn('[stagehand] 注册失败', t.name, e?.message || e) }
      }
      stagehand = { sessionMgr }
      Log.info(`[stagehand] 已启用浏览器自动化工具（${cfg.stagehand.mode || 'local'} 模式；4 个工具 stagehand__goto/observe/extract/act）`)
    } catch (e) { Log.warn('[stagehand] 初始化失败（@browserbasehq/stagehand 未装或浏览器不可用？）', e?.message || e) }
  }

  // Python 精确计算工具（数学/统计等；沙箱内执行，默认开）
  if (cfg.calc?.enable !== false) tools.register(calcTool)
  tools.register(sendFileTool) // send_file：发送文件到聊天
  tools.register(readPdfTool) // read_pdf：读取 PDF 文本+页面图片
  tools.register(createExcelTool) // create_excel：创建带样式 Excel
  tools.register(readExcelTool) // read_excel：读取 Excel 为表格文本
  tools.register(transcribeMediaTool) // transcribe_media：音视频转文字(STT)
  tools.register(fileToPdfTool) // file_to_pdf：任意文件转 PDF 并发送

  // skill 工具：模型主动调用 skill 的通道（按 name 加载说明书正文）—— 渐进式披露的载入入口
  tools.register(makeSkillTool(skills))

  // send_sticker 工具：按情绪跨全库选图（表情包启用且未显式关闭时注册）
  if (cfg.sticker?.enable && cfg.sticker?.sendStickerTool !== false) {
    try {
      const { makeSendStickerTool } = await import('../model/sticker/send-tool.js')
      tools.register(makeSendStickerTool(getStickerManager()))
    } catch (e) { Log.warn('[sticker] send_sticker 工具注册失败', e?.message || e) }
  }

  // 技能热加载工具：安装 SkillHub 技能后免重启即可用
  tools.register({
    name: 'reload_skills',
    description: '重新扫描技能目录(skills/)并加载新技能。用 skillhub/手动安装技能后调用，免去重启。',
    category: 'system',
    meta: { alwaysConfirm: true, interactive: true },
    parameters: { type: 'object', properties: {} },
    async execute() {
      const fresh = await loadSkillPack(skillsDir, { logger: Log.tag('skill') })
      skills.skills.clear()
      skills.register(...fresh)
      return { ok: true, count: skills.list().length, skills: skills.list().map((s) => s.name) }
    },
  })

  const mcp = new McpManager({ registry: tools, logger: Log.tag('mcp'), requestTimeout: cfg.mcp?.requestTimeout })
  mcp.start(cfg.mcp?.servers || {}).catch((e) => Log.error('[mcp] 启动失败', e?.message || e))

  // 工具按需发现：检索 embedding（可选，复用上面的 embedFn）；未填则 registry 用纯关键词 jaccard
  tools.setEmbedFn(embedFn)

  // recall 抽取用的轻量 LLM 通道：复用主 provider、换廉价 model id（utilityModel 降本，留空沿用主模型）
  // llmExtract 已自拼抽取指令+对话，此处只需做「无脑 chat 通道」（recall.js 兼容 llm.run 与函数两种形态）
  const recallModel = cfg.recall?.model || cfg.utilityModel || cfg.model
  const recallLlm = {
    run: async (prompt) => {
      try {
        const res = await provider.chat({ model: recallModel, messages: [{ role: 'user', content: prompt }], stream: false })
        return { content: res?.content || '' }
      } catch (e) {
        Log.warn('[recall] llm 抽取调用失败', e?.message || e)
        return { content: '' }
      }
    },
  }

  // —— 在线自进化三件套：PromptRegistry（prompt 版本化/回滚）+ TraceStore（数据闭环）+ SelfReviewer（后台自评审）——
  const promptDir = path.resolve(PLUGIN_ROOT, cfg.evolution?.promptDir || 'data/evolution/prompts')
  const traceDir = path.resolve(PLUGIN_ROOT, cfg.evolution?.traceDir || 'data/evolution/traces')
  const suggestionDir = path.resolve(PLUGIN_ROOT, cfg.evolution?.suggestionDir || 'data/evolution/suggestions')
  const promptRegistry = new PromptRegistry()
  promptRegistry.registerAll(TEMPLATES)
  try {
    if (fs.existsSync(promptDir)) {
      for (const f of fs.readdirSync(promptDir).filter((x) => x.endsWith('.json'))) {
        try {
          const tpl = JSON.parse(fs.readFileSync(path.join(promptDir, f), 'utf8'))
          if (tpl && tpl.id) promptRegistry.register(new PromptTemplate(tpl))
        } catch (e) { Log.warn('[prompt] 加载进化产出失败', f, e?.message || e) }
      }
      if (promptRegistry.size > 0) Log.info('[evolution] PromptRegistry 已加载进化覆盖')
    }
  } catch (e) { Log.warn('[evolution] prompts 目录加载失败', e?.message || e) }
  let traceStore = null
  try { traceStore = new TraceStore({ dir: traceDir }) } catch (e) { Log.warn('[evolution] TraceStore 初始化失败', e?.message || e) }
  const srCfg = cfg.selfReview || {}
  let selfReview = null
  if (srCfg.enable !== false) {
    try {
      selfReview = new SelfReviewer({
        provider, model: srCfg.model || cfg.utilityModel || cfg.model,
        traceStore, memory, skills, suggestionDir,
        botName: (typeof Bot !== 'undefined' && (Bot.nickname || Bot.name)) || '',
        every: srCfg.every, autoApplyMemory: srCfg.autoApplyMemory, autoApplyPrompt: srCfg.autoApplyPrompt,
        dailyBudgetTokens: srCfg.dailyBudgetTokens,
        logger: Log.tag('selfReview'),
      })
    } catch (e) { Log.warn('[evolution] SelfReviewer 初始化失败', e?.message || e) }
  }

  // —— Tool Evolution：版本化工具库 + 调用埋点（动态 import；sqlite3 未装/未启用则降级，不影响主流程）——
  let toolEvo = null
  if (cfg.toolEvo?.enable !== false) {
    try {
      const te = await import('../model/toolEvo/index.js')
      await te.initDb({ dir: path.resolve(PLUGIN_ROOT, path.dirname(cfg.toolEvo?.dbPath || 'data/evolution/tevo.db')) })
      const toolEvoRegistry = new te.ToolEvoRegistry({ artifactsDir: path.resolve(PLUGIN_ROOT, cfg.toolEvo?.artifactsDir || 'data/evolution/tools') })
      tools.setInvocationSink(te.recordInvocation)
      // 隔离 runner（审计 §4.2 / P0-1，F 阻断）：stable 工具在常驻 worker 子进程执行，不主进程 import，
      // capability ctx 冻结 {now,log}，不暴露 e/bot/fetcher/process；env 不透传 apiKey 等敏感变量。
      const runner = new te.RunnerClient({ logger: Log.tag('toolEvo'), timeoutMs: cfg.toolEvo?.runnerTimeoutMs || 5000 })
      const builtins = tools.list().filter((t) => !t.meta?.mcp).map((t) => ({
        name: t.name, description: t.description, parameters: t.parameters,
        sideEffects: t.meta?.sideEffects || ['none'], tags: ['builtin'],
      }))
      const seeded = await te.seedBuiltinTools(toolEvoRegistry, builtins).catch((e) => { Log.warn('[toolEvo] seed 失败', e?.message || e); return 0 })
      const synthesizer = new te.ToolSynthesizer({ provider, model: srCfg.model || cfg.utilityModel || cfg.model, maxRepairAttempts: cfg.toolEvo?.maxRepairAttempts ?? 2, logger: Log.tag('toolEvo') })
      const engine = new te.EvolutionEngine({ synthesizer, registry: toolEvoRegistry, logger: Log.tag('toolEvo') })
      // 注入已 stable 的进化工具（经 runner 隔离执行；重启/热重载后自动恢复，供 agent tool_search 调用）
      let stableCount = 0
      try {
        for (const s of await toolEvoRegistry.listStable()) {
          // 内置工具(provenance=human)由插件代码注册,不走制品注入(其 source 为空,execute 在插件代码);
          // 只注入进化产出(generated/refined,制品含 export run)
          if (s.manifest?.provenance?.kind === 'human') continue
          try { tools.register(await toolEvoRegistry.toToolContract(s, runner)); stableCount++ } catch (e) { Log.warn('[toolEvo] 注入 stable 失败', s.name, e?.message || e) }
        }
      } catch (e) { Log.warn('[toolEvo] stable 注入失败', e?.message || e) }
      toolEvo = { registry: toolEvoRegistry, engine, runner, closeDb: te.closeDb, flushNow: te.flushNow }
      Log.info(`[toolEvo] 已初始化（内置 ${builtins.length} 个 · 本次 seed ${seeded}（已入库则跳过）· stable 进化 ${stableCount} 经隔离 runner）`)
    } catch (e) { Log.warn('[toolEvo] 初始化失败（sqlite3 未装？）', e?.message || e) }
  }

  const agentConfig = {
    provider,
    model: cfg.model,
    fallbackProviders,
    tools,
    memory,
    session,
    recall,
    recallLlm, // 接通：让 recall.js 的 llmExtract 真正触发（覆盖"帮我记/以后都/别忘了"等自然说法）
    promptRegistry, // 进化版 prompt：_assembleSystem 优先取 registry.get('agent').system
    skills, // 让 Agent 在 system prompt 注入 <available_skills> 目录
    guard: { checkInput, systemHardening },
    guardAction: cfg.guardAction || 'flag',
    guardSensitivity: cfg.guardSensitivity || 'medium',
    policy: createPolicy({ categoryMin: cfg.policy?.categoryMin }),
    confirm, // ConfirmStore 审批器：需确认的工具（terminal 写命令等）经它走主人 #确认/#拒绝
    masterSkipConfirm: cfg.masterSkipConfirm === true, // 主人任务免确认直执行（高危，仅主人；denylist 仍拦）
    // 留空时由 Agent 用富默认身份（model/prompt TEMPLATES.agent.system）；人设经 run opts.systemPrompt 覆盖
    systemPrompt: cfg.systemPrompt || undefined,
    maxTurns: cfg.maxTurns ?? 50,
    loop: cfg.loop || undefined, // LoopGovernor 循环智能终止（审计 §2.1）；cfg.loop 假值则 Agent 不启用 governor
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens || null, // 控制输出长度（消除 Anthropic 硬编码 4096 / OpenAI 不发）
    thinking: cfg.thinking || null,
    // 上下文管理：token 压力阈值（从 contextWindow 派生）、工具结果上限、是否回灌 reasoning
    contextPressureThreshold: cfg.contextPressureThreshold ?? (cfg.contextWindow ? Math.floor(cfg.contextWindow * 0.8) : null),
    maxToolResultChars: cfg.maxToolResultChars ?? 4000,
    keepReasoning: cfg.keepReasoning === true,
    // 工具按需发现：LLM 只常驻少数核心工具，其余经 tool_search 检索后动态注入（默认开；关则回退全量常驻）
    toolDiscovery: {
      enable: cfg.toolDiscovery?.enable !== false,
      alwaysOn: Array.isArray(cfg.toolDiscovery?.alwaysOn) ? cfg.toolDiscovery.alwaysOn : undefined,
      topK: cfg.toolDiscovery?.topK ?? 8,
      minScore: cfg.toolDiscovery?.minScore ?? 0.3,
    },
    reflect: cfg.reflect ?? 'auto',
    reflectMaxIterations: cfg.reflectMaxIterations ?? 1,
    stickers: getStickerManager({ logger: Log.tag('sticker') }), // 表情包清单注入（_assembleSystem 用 catalog()）
    devLog: (event, data, traceId, scope) => devLog(event, data, traceId, scope), // 详细 trace（框架无关，pino 文件）；库零依赖，由 apps 注入
    logger: Log.tag('agent'),
  }
  // 多例：每请求 new Agent（共享 provider/tools/session 等引用，但 this.messages 各自独立）
  // → 并发 run 不再互相覆盖 this.messages，根治串会话/艾特错人，且不同用户真并发（不排队）
  const makeAgent = () => new Agent(agentConfig)

  // 视觉子模型（A 方案）：主模型不支持视觉时，由它把图片转成文本描述喂给主模型
  let vision = null
  if (cfg.vision?.enable === true && (cfg.vision?.model || cfg.model)) {
    try {
      const vcfg = cfg.vision
      if (!vcfg.model && cfg.model) Log.info('[vision] vision.model 未配，复用主模型', cfg.model)
      const vProtocol = vcfg.protocol || protocol
      const vPresetMap = vProtocol === 'anthropic' ? anthropicPresets : openaiPresets
      const vPreset = vcfg.preset ? vPresetMap[vcfg.preset] : preset
      const vProvider = createProvider({
        protocol: vProtocol,
        ...vPreset,
        ...(vcfg.baseURL ? { baseURL: vcfg.baseURL } : {}),
        apiKey: vcfg.apiKey || cfg.apiKey,
        model: vcfg.model || cfg.model,
      })
      vision = new VisionService({
        provider: vProvider,
        model: vcfg.model || cfg.model,
        protocol: vProtocol,
        describePrompt: vcfg.describePrompt || undefined,
        maxTokens: vcfg.maxTokens || 1024,
        logger: Log.tag('vision'),
        ...(proxyFetch ? { fetch: proxyFetch } : {}),
      })
    } catch (e) {
      Log.warn('[vision] 视觉子模型装配失败，主模型不支持视觉时图片将降级', e?.message || e)
    }
  }

  return { agentConfig, makeAgent, tools, session, recall, knowledge, memory, confirm, schedule, scheduler, mcp, provider, persona, personaStore, vision, skills, skillsDir, sticker: getStickerManager(), kv: K, promptRegistry, traceStore, selfReview, promptDir, suggestionDir, toolEvo, stagehand }
}

const getRuntime = async () => {
  if (_runtime) return _runtime
  // 失败缓存：apiKey 等配置类错误一旦发生，直接抛缓存原因，不再每条消息重新 buildRuntime
  // （否则每条群消息都重建+抛错+回复，刷屏 + 日志爆炸）。配置热加载后 invalidateRuntime 清缓存重试。
  if (_runtimeFailed) {
    // 配置已有 apiKey（原失败原因已解决）→ 清缓存重试，而非永远抛旧错误
    if (Config.get().agent?.apiKey) { _runtimeFailed = null; _initErrLogged = false }
    else throw _runtimeFailed
  }
  // 并发安全：启动期各 apps 构造器 / 首条消息可能并发调 getRuntime，
  // 复用同一个 in-flight buildRuntime()，避免运行时被构建多次（否则 MCP 会重复连接注册、日志打两遍）。
  if (!_runtimePromise) {
    _runtimePromise = buildRuntime()
      .then((rt) => { _runtime = rt; _runtimeFailed = null; return rt })
      .catch((e) => { _runtimeFailed = e; _runtimePromise = null; throw e })
      .finally(() => { _runtimePromise = null })
  }
  return _runtimePromise
}

/** 失效运行时单例（下一次 getRuntime 用新配置重建） */
function invalidateRuntime() {
  if (_runtime?.toolEvo) {
    try { _runtime.toolEvo.runner?.stop?.() } catch { /* noop */ } // 关闭隔离 worker（审计 §4.2）
    try { _runtime.toolEvo.closeDb() } catch { /* noop */ }
  }
  if (_runtime?.stagehand?.sessionMgr) {
    try { _runtime.stagehand.sessionMgr.closeAll() } catch { /* noop */ } // 关闭所有浏览器会话
  }
  _runtime = null
  _runtimePromise = null
  _runtimeFailed = null  // 配置已变更：清失败缓存，下次 getRuntime 用新配置重试
  _initErrLogged = false // 允许再次记录初始化失败（若仍失败）
  _initFailNotified.clear() // runtime 重建：重置"已提示"标记，下次失败可再提示用户
}

// 热加载：配置文件变更 → 失效运行时单例，下次对话用新配置重建（无需重启框架）
Config.onChange(() => {
  invalidateRuntime()
  Log.info('[config] 配置已热加载，运行时将在下次对话重建')
})
Config.startWatch() // 应用入口启动配置文件监听（不在 Config import 时启动，免得测试进程不退出）

// 供 apps/research.js 等复用已装配的 provider / 工具集
export { getRuntime }

function ctxOf(e) {
  const isMaster = !!e.isMaster
  let role = 'member'
  if (e.member?.is_owner) role = 'owner'
  else if (e.member?.is_admin) role = 'admin'
  const userId = String(e.user_id)
  const groupId = e.group_id ? String(e.group_id) : null
  const isGroup = !!e.isGroup
  // —— 数据隔离 scope 身份 ——
  // isolation=true（默认）: 每(群,用户)独立；false: 同群共享（群体型 bot）；跨群始终隔离；私聊始终按用户。
  // userId=真实用户(个人功能/get_chat_history 自过滤/回复@)；scopeUserId=session/recall 键；scopeId=MemoryStore 文件目录。
  const isolation = Config.get().agent?.isolation?.enable !== false
  const sharedGroup = !!(isGroup && groupId && !isolation)
  const scopeUserId = sharedGroup ? '__group__' : userId
  const scopeId = !isGroup
    ? `u_${userId}`
    : (isolation ? `g${groupId}_u${userId}` : `g${groupId}`)
  return {
    role,
    isMaster,
    userId,
    groupId,
    isGroup,
    isGroupAdmin: !!(e.member?.is_admin || e.member?.is_owner),
    isolation,
    scopeUserId,
    scopeId,
    notify: (id, info) => notifyMaster(e, id, info),
    conversationId: null,
    // 媒体被动工具（list_group_files/get_group_file/read_attachment）需读取实时事件与 Bot 句柄
    e,
    bot: (typeof Bot !== 'undefined' && Bot) || null,
    fetcher: (typeof fetch !== 'undefined' && fetch) || null,
  }
}

function notifyMaster(e, id, info) {
  const masters = Config.get().agent?.masters || []
  let detail = JSON.stringify(info.args || {}).slice(0, 120)
  let risk = ''
  if (info.tool === 'terminal' && info.args?.command) {
    detail = `\n$ ${info.args.command}`.slice(0, 500)
    // 风险特征提示（写入/网络/提权/删除/安装）
    const c = info.args.command
    if (/\b(rm|mv|chmod|chown|mkfs|dd|shutdown|reboot|halt)\b|>\s*/i.test(c)) risk = ' ⚠️写入/破坏'
    else if (/\b(curl|wget|ssh|scp|rsync|git\s+push|git\s+clone)\b|https?:\/\//i.test(c)) risk = ' 🌐网络'
    else if (/\bsudo\b|\bsu\b/i.test(c)) risk = ' 🔐提权'
    else if (/\b(install|pip|npm|apt|yum|brew)\b/i.test(c)) risk = ' 📦安装'
  }
  const text = `待审批 #${id}：${info.tool}${risk} ${detail}\n回复「#确认 ${id}」或「#拒绝 ${id}」`
  try {
    for (const mid of masters) {
      const bot = (typeof Bot !== 'undefined' && Bot) || null
      bot?.pickFriend?.(mid)?.sendMsg?.(text)
    }
    if (!masters.length && e.isGroup) e.reply('⚠️ 有动作待审批，但未配置 master 接收通知（agent.masters）')
  } catch (err) {
    Log.warn('notifyMaster 失败', err?.message || err)
  }
}

export const fireReminder = async (info) => {
  try {
    const bot = (typeof Bot !== 'undefined' && (Bot[info.selfId] || Bot)) || null
    const text = `⏰ 提醒：${info.message}`
    if (info.groupId && bot?.pickGroup) await bot.pickGroup(info.groupId).sendMsg(text)
    else if (bot?.pickFriend) await bot.pickFriend(info.userId).sendMsg(text)
  } catch (err) {
    Log.warn('fireReminder 失败', err?.message || err)
  }
}

// 按目标（群/私聊）发消息（fire 路径，无 e；复用 fireReminder 的 pickGroup/pickFriend 逻辑）
async function sendByInfo(info, text) {
  const bot = (typeof Bot !== 'undefined' && (Bot[info.selfId] || Bot)) || null
  if (!bot) return
  if (info.groupId && bot.pickGroup) await bot.pickGroup(info.groupId).sendMsg(text)
  else if (bot.pickFriend) await bot.pickFriend(info.userId).sendMsg(text)
}

// 合成 ctx（fire 时无用户事件 e）：复用 ctxOf 的 scope 逻辑，去 e 相关
function ctxFromInfo(info) {
  const userId = String(info.userId || '')
  const groupId = info.groupId ? String(info.groupId) : null
  const isGroup = !!groupId
  const cfg = Config.get().agent || {}
  const isolation = cfg.isolation?.enable !== false
  const sharedGroup = !!(isGroup && groupId && !isolation)
  const scopeUserId = sharedGroup ? '__group__' : userId
  const scopeId = !isGroup ? `u_${userId}` : (isolation ? `g${groupId}_u${userId}` : `g${groupId}`)
  return {
    userId, groupId, isGroup, isMaster: false, isolation, scopeUserId, scopeId,
    bot: (typeof Bot !== 'undefined' && Bot) || null, selfId: info.selfId || '',
    notify: () => {}, fetcher: (typeof fetch !== 'undefined' && fetch) || null,
    conversationId: null,
  }
}

// 统一 fire 分发：type='task' → 跑 Agent 任务链（makeAgent().run(prompt)）+ 发结果；否则 fireReminder 静态
export const makeFireDispatch = (rt) => {
  return async (info) => {
    if (info.type === 'task' && info.prompt) {
      try {
        const cfg = Config.get().agent?.schedule || {}
        const ctx = ctxFromInfo(info)
        const r = await rt.makeAgent().run(info.prompt, { ctx, maxTurns: cfg.taskMaxTurns || 15 })
        const text = `🤖 定时任务：${(r?.content || '').trim() || '(无输出)'}`
        await sendByInfo(info, text)
        Log.info('[schedule] 任务链完成', info.id, 'turns=', r?.turns)
      } catch (e) {
        Log.warn('[schedule] 任务链失败', info.id, e?.message || e)
        try { await sendByInfo(info, `⚠️ 定时任务「${String(info.prompt).slice(0, 30)}」执行失败：${e?.message || e}`) } catch { /* noop */ }
      }
    } else {
      await fireReminder(info)
    }
  }
}

// #添加mcp 交互式监听：私聊下记录"待接收 mcpServers JSON"的用户（带 TTL 防卡死；进程重启清空）
const MCP_ADD_PENDING_TTL = 120000 // 2 分钟
const mcpAddPending = new Map() // userId(String) -> { at }

// #agents设置主人 交互式监听：发命令后控制台打印验证码，该用户接下来直接发验证码认领（无需另发命令）。
// 群聊/私聊均可；per-user 监听，其他人消息不受影响。验证码错误不消费、可重发，直到正确或超时。
const TERMINAL_CLAIM_TTL_MS = 5 * 60 * 1000 // 5 分钟（与 master.js 验证码 TTL 一致）
const terminalClaimPending = new Map() // userId(String) -> { at, expires }

export class Chat extends plugin {
  constructor() {
    super({
      name: 'agents对话',
      dsc: 'AI Agent 对话（多轮/工具/记忆/安全/审批/MCP）',
      event: 'message',
      priority: 9999,
      rule: [
        // —— 主人指令 ——
        { reg: '^#启用mcp\\s+(.+)', fnc: 'enableMcp', permission: 'master' },
        { reg: '^#停止mcp\\s+(.+)', fnc: 'disableMcp', permission: 'master' },
        { reg: '^#模型切换\\s+(.+)', fnc: 'switchModel', permission: 'master' },
        { reg: '^#确认\\s*(\\d+)', fnc: 'approve' }, // 审批：框架主人 OR terminal 主人均可用（内部 guard）
        { reg: '^#拒绝\\s*(\\d+)', fnc: 'reject' },
        { reg: '^#待确认$', fnc: 'pending' },
        { reg: '^#mcp$', fnc: 'mcpStatus', permission: 'master' },
        { reg: '^#添加[Mm][Cc][Pp]', fnc: 'addMcp', permission: 'master' },
        { reg: '^#agents重载$', fnc: 'agentsReload', permission: 'master' },
        { reg: '^#进化工具\\s+([\\s\\S]+)', fnc: 'toolEvoEvolve', permission: 'master' },
        { reg: '^#工具进化列表$', fnc: 'toolEvoList', permission: 'master' },
        { reg: '^#采纳工具\\s+(\\S+)', fnc: 'toolEvoAdopt', permission: 'master' },
        { reg: '^#淘汰工具\\s+(\\S+)', fnc: 'toolEvoDecommission', permission: 'master' },
        { reg: '^#回滚工具\\s+(\\S+)\\s+(\\S+)', fnc: 'toolEvoRollback', permission: 'master' },
        { reg: '^#工具健康$', fnc: 'toolEvoHealth', permission: 'master' },
        { reg: '^#openrouter余额$', fnc: 'openrouterBalance', permission: 'master' },
        { reg: '^#知识库添加[\\s\\S]*', fnc: 'addKnowledge', permission: 'master' },
        { reg: '^#知识库列表$', fnc: 'listKnowledge' },
        { reg: '^#知识库删除\\s+(\\S+)', fnc: 'delKnowledge', permission: 'master' },
        { reg: '^#知识库重建$', fnc: 'rebuildKnowledge', permission: 'master' },
        { reg: '^#知识库刷新全部$', fnc: 'refreshAllKnowledge', permission: 'master' },
        { reg: '^#知识库刷新\\s+(\\S+)', fnc: 'refreshKnowledge', permission: 'master' },
        { reg: '^#知识库定时\\s+(\\S+)\\s+([\\s\\S]+)', fnc: 'setKbRefresh', permission: 'master' },
        { reg: '^#知识库取消定时\\s+(\\S+)', fnc: 'cancelKbRefresh', permission: 'master' },
        { reg: '^#定时任务\\s+[\\s\\S]+', fnc: 'addCronTask', permission: 'master' },
        { reg: '^#定时任务列表$', fnc: 'listCronTask' },
        { reg: '^#取消定时任务\\s+(\\S+)', fnc: 'cancelCronTask', permission: 'master' },
        { reg: '^#LLM进化$', fnc: 'llmEvolve', permission: 'master' },
        // —— 所有用户 ——
        // terminal 主人认领（自包含，不读框架配置；安全靠控制台验证码）
        // #agents设置主人 → 控制台打印验证码 → 直接发验证码认领（监听下一条消息，类似 Yunzai #设置主人）
        { reg: '^#agents设置主人$', fnc: 'terminalRequestClaim' },
        { reg: '^#聊天列表$', fnc: 'chatList' },
        { reg: '^#进入聊天\\s*(\\d+)', fnc: 'enterChat' },
        { reg: '^#new$', fnc: 'newChat' },
        { reg: '^#记忆$', fnc: 'showMemory' },
        { reg: '^#忘掉\\s+(.+)', fnc: 'forget' },
        { reg: '^#我的提醒$', fnc: 'myReminders' },
        { reg: '^#取消提醒\\s*(\\d+)', fnc: 'cancelReminder' },
        { reg: '^#清空所有记录$', fnc: 'clearMyData' },
        // —— 人设 ——（更具体的规则在前，避免被 #人设+id 吞掉）
        { reg: '^#人设列表$', fnc: 'personaList' },
        { reg: '^#人设详情\\s+(.+)', fnc: 'personaDetail' },
        { reg: '^#新建人设\\s+(.+)', fnc: 'personaCreate' },
        { reg: '^#删除人设\\s+(.+)', fnc: 'personaDelete' },
        { reg: '^#重置人设$', fnc: 'personaReset' },
        { reg: '^#人设$', fnc: 'personaList' },
        { reg: '^#人设\\s+(.+)', fnc: 'personaSwitch' },
        // —— 在线自进化：审阅 / 采纳 / 拒绝 / 回滚（主人）——
        { reg: '^#审阅进化$', fnc: 'reviewList', permission: 'master' },
        { reg: '^#采纳\\s+(.+)', fnc: 'reviewAdopt', permission: 'master' },
        { reg: '^#拒绝进化\\s+(.+)', fnc: 'reviewReject', permission: 'master' },
        { reg: '^#回滚\\s+(.+)', fnc: 'promptRollback', permission: 'master' },
        { reg: '^#进化\\s+prompt\\s+(.+)', fnc: 'evolvePrompt', permission: 'master' },
        // —— 错误上报 ——
        { reg: '^#上报错误(?:\\s+([\\s\\S]+))?$', fnc: 'reportBug' },
        // —— AI 触发（catch-all，最后匹配；@或自定义触发词）——
        { reg: '^[\\s\\S]+$', fnc: 'onTrigger', log: false },
      ],
    })
    getRuntime()
      .then((rt) => {
        rt.schedule.restore(makeFireDispatch(rt)).catch(() => {})
        // KB URL 定时刷新 job 恢复（重启后 cron 继续生效）
        rt.knowledge.restoreRefreshJobs((id) => rt.knowledge.refreshDoc(id).catch((e) => Log.warn('[kb] 定时刷新失败', id, e?.message || e))).catch(() => {})
      })
      .catch((e) => { if (!_initErrLogged) { _initErrLogged = true; Log.error('agent 初始化失败（修复 config 后重启，或保存 config 触发热加载自动恢复）', e?.message || e) } })
  }

  // —— AI 触发 ——
  async onTrigger() {
    // 过滤 bot 自己发的消息：NapCat 开了 report-self-message 时，bot 的发言（如"思考中…"进度、
    // 工具播报）会被投递回 message 事件。私聊下 onTrigger 无脑触发，若不过滤 self 会死循环——
    // bot 发"思考中…" → 被当用户输入 → 回复 → 又发进度消息 → 再触发……（曾烧出单轮 27k token 循环）
    const __selfId = this.e.self_id || this.e.bot?.self_id
    if (__selfId && (String(this.e.user_id) === String(__selfId) || String(this.e.sender?.user_id || '') === String(__selfId))) {
      return false
    }
    // #添加mcp 交互式监听：私聊下，待接收 JSON 的用户，本条消息当作 mcpServers 配置处理
    const __uid = String(this.e.user_id)
    if (!this.e.isGroup && mcpAddPending.has(__uid)) {
      const p = mcpAddPending.get(__uid)
      if (Date.now() - p.at > MCP_ADD_PENDING_TTL) mcpAddPending.delete(__uid) // 超时自清
      else return this._consumeMcpAddJson(this.e.msg)
    }
    // #agents设置主人 交互式认领：该用户处于监听态时，下一条消息作为验证码消费（群聊/私聊均生效）
    if (terminalClaimPending.has(__uid)) {
      const p = terminalClaimPending.get(__uid)
      if (Date.now() > p.expires) {
        terminalClaimPending.delete(__uid) // 超时自清
      } else {
        const code = (this.e.msg || '').trim()
        const r = claim(code, __uid)
        if (r.ok) {
          terminalClaimPending.delete(__uid) // 认领成功，退出监听
          await this.e.reply(`✅ 认领成功！你（${r.userId}）已成为 terminal 主人。\n现在可让 AI 使用 terminal 工具在主机执行命令（每条命令仍需你 #确认，灾难命令黑名单硬拦）。`)
        } else {
          // 验证码错误：保持监听，用户可在超时前继续重发（code 不变，无需重新 #agents设置主人）
          await this.e.reply(`❌ ${r.reason}，请直接重新发送验证码（控制台查看 ${Math.round((p.expires - Date.now()) / 1000)} 秒内有效）。`)
        }
        return true
      }
    }
    const cfg = Config.get().agent || {}
    const mode = cfg.trigger || 'at' // at | command | both
    const cmd = cfg.triggerCommand || '#ai'
    const text = (this.e.msg || '').trim()
    const atMode = mode !== 'command'
    const cmdMode = mode !== 'at'
    const isAt = !!this.e.atBot
    const cmdRe = new RegExp(`^${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`)
    const isCmd = cmdMode && cmdRe.test(text)
    const hasMedia = this._hasMedia(this.e)
    // 触发条件：命令匹配 ｜（@机器人 且（有文字 或 有媒体））。
    // 关键：纯引用图片/文件无文字也算触发（问题4）—— 媒体由 _handleAgent 注入默认指令处理。
    // 私聊直接触发（私聊无 @，at 模式下原本不触发；私聊任何消息都该能对话）
    const isPrivate = !this.e.isGroup
    if (!(isPrivate || isCmd || (atMode && isAt && (text || hasMedia)))) return false
    const input = isCmd ? text.replace(cmdRe, '').trim() : text
    if (!input && !hasMedia) return false // 既无文字又无媒体（如裸 `#ai`）：不触发
    Log.mark('[trigger]', `user=${this.e.user_id} gid=${this.e.group_id || '-'} mode=${isCmd ? 'cmd' : 'at'} inputLen=${input.length} media=${hasMedia}`)
    return this._handleAgent(input)
  }

  /** 轻量探测：消息是否含图片/文件/音视频段，或引用了某条消息（引用的媒体由 collectActive 兜底拉取）。不发网络请求。 */
  _hasMedia(e) {
    const segs = e?.message
    const hasSeg = Array.isArray(segs) && segs.some((s) => s && ['image', 'file', 'record', 'video', 'flash'].includes(s.type))
    return !!(hasSeg || e?.reply_id != null)
  }

  async _handleAgent(text) {
    let rt
    try {
      rt = await getRuntime()
    } catch (e) {
      // 运行时初始化失败（如 apiKey 未配置）：每个用户仅提示一次（避免群里刷屏），修复 config（热加载）后自动恢复
      const _uid = String(this.e.user_id || '')
      if (_uid && !_initFailNotified.has(_uid)) {
        _initFailNotified.add(_uid)
        try { await this.e.reply(`⚠️ ${e?.message || '插件初始化失败'}。修复后保存 config 即自动恢复。`) } catch { /* noop */ }
      }
      return false
    }
    const cfg = Config.get().agent || {}
    const ctx = ctxOf(this.e)
    ctx.conversationId = await rt.session.getActiveConversation(ctx.scopeUserId, ctx.groupId)
    // per-会话日志文件名所需信息；uid 用 scopeUserId 保证"同会话同文件"（群共享时为 __group__）
    let __convMeta = null
    try { __convMeta = await rt.session.getConversationMeta(ctx.scopeUserId, ctx.groupId, ctx.conversationId) } catch { /* noop */ }
    ctx.devScope = { gid: ctx.groupId || 'private', uid: ctx.scopeUserId, convId: ctx.conversationId, createdAt: __convMeta?.createdAt || Date.now() }
    const traceId = randomUUID() // 串联整条链路的 dev trace id（与 Agent taskId 一致）
    devLog('trigger', {
      user: ctx.userId, gid: ctx.groupId, isGroup: ctx.isGroup, scopeUserId: ctx.scopeUserId, scopeId: ctx.scopeId, conv: ctx.conversationId,
      text: text || '',              // 用户提问原文（意图来源；trace 不截断，全文记录）
      inputLen: (text || '').length,
      hasReply: !!(this.e?.reply_id || (Array.isArray(this.e?.message) && this.e.message.some((s) => s && s.type === 'reply'))), // 是否引用了消息提问
    }, traceId, ctx.devScope)

    // —— 多模态：主动收集消息中的图片/文件，按模型能力转为协议原生内容 ——
    const protocol = cfg.protocol || 'openai'
    const caps = detectCapabilities({ protocol, model: cfg.model, caps: cfg.media?.caps })
    const mediaCfg = cfg.media || {}
    ctx.miyoushe = { cookie: cfg.miyoushe?.cookie || '', defaultGid: cfg.miyoushe?.defaultGid || 2, maxImages: cfg.miyoushe?.maxImages ?? 9 }
    ctx.replyMode = cfg.reply?.mode || 'image' // 供工具按回复模式分流发图（image 渲染进回复图 / text 合并转发）
    // 提醒服务：reminder_set 工具经此调 rt.schedule.add（绑定 fireReminder + selfId），到时间 fireReminder 主动发消息
    ctx.selfId = String(this.e.self_id || this.e.selfId || '')
    ctx.reminder = {
      // 有 prompt → 一次性任务链（type=task 跑 Agent + 发结果，走 fireDispatch）；否则静态提醒（fireReminder）
      add: (info) => {
        const isTask = !!info.prompt
        return rt.schedule.add(
          { selfId: ctx.selfId, type: isTask ? 'task' : 'reminder', ...info },
          isTask ? makeFireDispatch(rt) : fireReminder,
        )
      },
      list: (userId) => rt.schedule.listByUser(userId),
      cancel: (id) => rt.schedule.cancel(id),
    }
    // 定时任务链：schedule_task 工具经此调 rt.schedule.add（type=task + cron + makeFireDispatch，到点跑 Agent + 发结果）
    ctx.cronTask = {
      add: (info) => {
        const cron = info.cron || parseCron(info.when)
        if (!cron) return { error: `无法识别时间「${info.when || ''}」，支持：每天8点/每2小时/工作日9点/每周一8点30/每30分钟` }
        return rt.schedule.add({ type: 'task', cron, prompt: info.prompt, userId: ctx.scopeUserId, groupId: ctx.groupId || null, selfId: ctx.selfId }, makeFireDispatch(rt))
      },
    }
    // terminal 工具运行时配置（主机执行；黑名单/超时/工作目录 + 审批超时）
    ctx.terminal = {
      cwd: Config.path.yunzai,
      maxTimeout: cfg.terminal?.maxTimeout || 600,
      blocklist: cfg.terminal?.blocklist || DEFAULT_BLOCKLIST,
      confirmTimeout: cfg.confirmTimeout || 300, // 主人 #确认 超时（秒），复用 agent.confirmTimeout
      skipConfirm: cfg.terminal?.skipConfirm === true, // terminal 主人免 #确认 直跑（黑名单仍硬拦；高危）
    }
    // web_download 工具运行时配置（yt-dlp 下载；目录/大小/超时上限，单位 MB→字节）
    ctx.download = {
      dir: cfg.download?.dir || undefined,
      maxBytes: cfg.download?.maxMB ? cfg.download.maxMB * 1024 * 1024 : undefined,
      sendLimitBytes: cfg.download?.sendLimitMB ? cfg.download.sendLimitMB * 1024 * 1024 : undefined,
      maxTimeoutSec: cfg.download?.maxTimeoutSec || undefined,
      ytDlpBin: cfg.download?.bin || undefined,
    }
    const media = createMediaService({
      bot: ctx.bot, e: this.e, caps, protocol, config: mediaCfg, fetcher: ctx.fetcher,
      log: (m) => (/失败|未能|异常/.test(m) ? Log.warn('[media]', m) : Log.debug('[media]', m)),
    })
    let input = text
    let blindImage = false // 收集到图片但模型无法识别（主模型无视觉 + 未被 vision 子模型转成文本）—— 防臆测
    try {
      let files = await media.collectActive()
      const nImg = files.filter((f) => f.kind === 'image' || (f.mime || '').startsWith('image/')).length
      // A 方案：主模型不支持视觉时，由视觉子模型把图片转成文本描述，再喂给主模型
      if (!caps.vision && rt.vision && nImg > 0) {
        Log.mark('[chat]', `vision 子模型识别 ${nImg} 张图（主模型 ${cfg.model} 无视觉）`)
        try {
          files = await describeImages(rt.vision, files, text)
          media.replaceActive(files)
        } catch (e) {
          Log.warn('[vision] 图片识别失败，按原能力降级', e?.message || e)
        }
      }
      ctx.media = files // 供 read_attachment 等被动工具读取
      devLog('media', { files: (files || []).map((f) => ({
        // source: message=消息附带 reply=引用 forward=合并转发 group_file=群文件
        source: f.source, kind: f.kind, name: f.name, ext: f.ext || null, mime: f.mime || null,
        size: f.size ?? null,            // 协议/消息段报告大小（与 bytes 对比判断下载是否完整）
        bytes: f.bytes ?? null,          // 实际下载字节（null/0=未拿到字节=下载未成功）
        hasUrl: !!f.url,                 // 是否拿到直链
        status: f.resolveError || 'ok',  // ok / no_url / download_failed / limit_images / limit_size
        skipReason: f.__skipReason || null,
        visionDescribed: !!f.__visionDescribed, // 图片是否已被 vision 子模型转成文本描述
      })) }, traceId, ctx.devScope)
      // 盲图判定（问题1）：有图片，主模型无视觉，且这些图片没被 vision 子模型转成文本（__visionDescribed）
      if (nImg > 0 && !caps.vision) {
        const rawImageLeft = files.some((f) => (f.kind === 'image' || (f.mime || '').startsWith('image/')) && f.buffer && !f.__visionDescribed)
        blindImage = rawImageLeft
        if (blindImage) Log.warn('[vision] 用户发送了图片但当前无法识别（主模型无视觉，未配 agent.vision.model）；将提示用户而非臆测')
      }
      // 纯媒体无文字：注入默认指令（问题4）；既无文字又无媒体：提示而非空跑
      const effText = text || (files.length ? '（我发了一张图片/文件给你，请查看并告诉我内容，或按需处理）' : '')
      if (!effText) {
        await this.e.reply('未识别到文字或图片/文件内容（引用的图片可能获取失败），请重新发送或补充说明。')
        return true
      }
      const content = media.buildContent(effText)
      if (Array.isArray(content)) input = { role: 'user', content, _media: true }
      else input = effText
      if (files.length) Log.debug('[chat]', `media files=${files.length} images=${nImg} vision=${!!caps.vision} blind=${blindImage} multimodal=${Array.isArray(content)}`)
    } catch (e) {
      Log.warn('[media] 主动收集失败，回退纯文本', e?.message || e)
    }

    // —— 人设：解析当前用户激活的人设，覆盖身份层 systemPrompt ——
    let systemPrompt
    let personaId = null
    try {
      const { persona } = await rt.persona.resolve(ctx.userId)
      systemPrompt = persona?.systemPrompt || undefined
      personaId = persona?.id || null
    } catch (e) {
      Log.warn('[persona] 解析失败，用默认', e?.message || e)
    }

    // —— 情境感知：perception（数据：时间/角色/自我状态/近期对话）+ skill（说明书，按输入匹配）——
    let context
    try {
      // 会话历史条数：供 perception 判断"上下文稀薄 → 主动补全近期群聊"（复用 session 缓存，零额外读盘）
      let sessionLen
      try { sessionLen = await rt.session.historyLength(ctx) } catch { sessionLen = undefined }
      const perception = await buildSituationalContext({
        ctx, runtime: rt, e: this.e, kv: rt.kv, cfg, bot: ctx.bot,
        historyCount: cfg.skill?.historyCount ?? 15,
        sessionLen,
      })
      const matched = rt.skills.match({ input: text, ctx })
      const skillText = rt.skills.assemble(matched)
      if (matched.length) Log.mark('[skill]', '命中说明书：', matched.map((s) => s.name).join(','))
      devLog('skill', { matched: matched.map((s) => s.name), input: (text || '').slice(0, 100) }, traceId, ctx.devScope)
      context = [perception, skillText].filter(Boolean).join('\n\n') || undefined
      // B方案：附件清单注入 context——让 AI 明确知道本轮有哪些附件、可用
      // read_attachment/file_to_pdf(name:"<文件名>") 直接处理。根治"附件正文进了上下文
      // 却丢了文件名、AI 不知该对哪个文件动手"（如"把这个转pdf"→AI 去列群文件找不到）
      const __atts = Array.isArray(ctx.media) ? ctx.media : []
      if (__atts.length) {
        const __srcCn = { message: '消息附带', reply: '引用消息', forward: '合并转发', group_file: '群文件' }
        const __lines = __atts.map((f, i) => {
          const sz = f.bytes ? `${(f.bytes / 1024).toFixed(1)}KB` : '大小未知'
          const st = f.resolveError ? `（获取失败:${f.resolveError}）` : ''
          return `${i + 1}. ${f.name} (${sz}, ${__srcCn[f.source] || f.source}${f.mime ? ', ' + f.mime : ''})${st}`
        })
        const __attHint = `【本次附件】用户本轮有以下附件（已自动收集；你可用 read_attachment(name:"<文件名>") 读内容、file_to_pdf(name:"<文件名>") 转PDF，无需知道路径）：\n${__lines.join('\n')}\n若用户指令针对某附件（如"转成pdf"/"总结这个文件"），请直接用其文件名作 name 参数调用对应工具。`
        context = context ? `${context}\n\n${__attHint}` : __attHint
      }
    } catch (e) {
      Log.warn('[perception/skill] 注入失败', e?.message || e)
    }
    // 盲图防臆测（问题1）：模型看不到图时，明确告知"无法识别"，杜绝从历史/上下文臆测图片内容
    if (blindImage) {
      const warn = '【系统提示】用户发送了图片，但当前未配置视觉模型（agent.vision.model 为空）且主模型不支持视觉，无法识别图片内容。请如实告知用户暂时无法识别图片、建议配置视觉模型；切勿根据历史对话或上下文臆测图片内容。'
      context = context ? `${context}\n\n${warn}` : warn
    }

    Log.mark('[chat]', `user=${ctx.userId} gid=${ctx.groupId || '-'} conv=${ctx.conversationId} model=${cfg.model} persona=${personaId || 'default'} vision=${caps.vision ? 'on' : 'off'} thinking=${cfg.thinking ? 'on' : 'off'}${context ? ` ctx=${String(context).length}字` : ''}`)
    const wantProgress = cfg.progress !== false
    const wantStream = cfg.stream === true // 逐字流式默认关（适配器差异大）；进度反馈默认开
    await this.e.reply('思考中…') // 触发确认：进入 agents 即回复，不受 progress 配置影响（让用户知道触发成功）
    const rs = makeReplyStream(this.e, { progress: wantProgress, recall: cfg.progressRecall ?? 3, provider: rt.provider, model: cfg.model, utilityModel: cfg.utilityModel || null, shortCircuitTools: ['clarify'], userText: text })
    try {
      // 喂给模型的首条 user 输入（追"AI 实际看到什么"：附件正文/文件名有没有进上下文、走纯文本还是多模态块、模型能力如何）
      const __inputText = typeof input === 'string' ? input
        : Array.isArray(input?.content) ? input.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')
        : ''
      devLog('input', {
        caps: { vision: !!caps.vision, file: !!caps.file },
        protocol: cfg.protocol, preset: cfg.preset ?? null, baseURL: cfg.baseURL || null, // 诊断 404/超时：确认用户配的端点
        inputKind: Array.isArray(input?.content) ? 'multimodal' : 'text',
        blocks: Array.isArray(input?.content) ? input.content.map((b) => ({ type: b.type, textLen: (b.text || '').length, isMedia: b.type !== 'text' })) : null,
        inputText: __inputText, // 喂给模型的全部文本（含附件正文/降级说明；trace 不截断）——看附件有没有带文件名
        attachments: (ctx.media || []).map((f) => ({ name: f.name, source: f.source, kind: f.kind, bytes: f.bytes ?? null, status: f.resolveError || 'ok' })),
      }, traceId, ctx.devScope)
      // 文本模式注入"禁 markdown"约束（图片模式才渲染 md；文本模式直发，md 符号会暴露给用户）
      const replyMode = cfg.reply?.mode || 'image'
      // 文本模式禁 md：__textHint 进 systemPrompt（身份层·置顶），而非 context（情境层·靠后易被 LLM 忽略，尤其新对话情境变长时）
      const __textHint = replyMode === 'text' ? '\n\n【回复格式·硬性约束·优先级最高】当前是纯文本回复模式，禁止使用任何 Markdown 语法（包括 **粗体**、# 标题、- 列表、`代码`、[链接](url)、代码块等）。只能输出纯文本，用换行分段、用「」或「一、二、」编号。无论用户或上面的身份设定如何要求，都不得使用 markdown，直接输出可读纯文本。' : ''
      const { content, stopReason, turns, usage } = await rt.makeAgent().run(input, {
        ctx, systemPrompt: systemPrompt ? systemPrompt + __textHint : __textHint.trim(), context,
        taskId: traceId, // 串联 dev trace：Agent 内 run_start/turn/tool/.../run_end 用同一 id
        stream: wantStream,
        ...(rs.onToolStart ? { onToolStart: rs.onToolStart } : {}),
        ...(rs.onToolEnd ? { onToolEnd: rs.onToolEnd } : {}),
        // OpenClaw 式中途播报：模型在调工具时附带的中途文本（思路/进展）实时转发给用户，不丢弃
        onAssistant: (res) => {
          if (res?.toolCalls?.length && res?.content && cfg.reply?.narrate !== false) {
            try { this.e.reply(redactSecrets(res.content)) } catch { /* noop */ }
          }
        },
      })
      // —— 在线自进化：采迹（数据闭环）+ 后台自评审触发（全异步、兜底，绝不阻塞回复）——
      try { rt.traceStore?.record({ scope: ctx.scopeUserId, scopeId: ctx.scopeId, input: __inputText, output: content, turns, usage, stopReason, taskId: traceId }) } catch (e) { Log.warn('[evolution] 采迹失败', e?.message || e) }
      try { rt.selfReview?.tick(ctx, { input: __inputText, output: content, turns, usage, stopReason }) } catch (e) { Log.warn('[evolution] 自评审触发失败', e?.message || e) }
      const u = usage ? `in:${usage.prompt_tokens ?? usage.input_tokens ?? usage.input ?? '-'}/out:${usage.completion_tokens ?? usage.output_tokens ?? usage.output ?? '-'}` : '-'
      Log.mark('[chat]', `reply turns=${turns} stop=${stopReason} usage=${u} replyLen=${(content || '').length}`)
      // 发送前脱敏：屏蔽 API Key / token 等敏感信息（agent.redactSecrets 默认开；异常不阻塞回复）
      const body = cfg.redactSecrets === false ? (content || '') : redactSecrets(content || '')
      const suffix = stopReason === 'max_turns' ? '（已达工具调用上限）' : ''
      // 表情包：本轮一次性门控（决定带哪些图 + 记冷却/防连发/usage），图片/文本模式共用结果，避免双计
      const acceptMap = (rt.sticker && body) ? rt.sticker.decide(body, ctx) : null
      // 群聊回复艾特发言人（agent.reply.atSender，默认开；私聊不艾特）
      const atSender = (ctx.isGroup && cfg.reply?.atSender !== false && ctx.userId && typeof segment !== 'undefined') ? segment.at(ctx.userId) : null
      // 回复渲染：默认图片（markdown→图片，失败退文本）；replyMode 已在上方 run 前计算
      let delivered = false
      if (replyMode === 'image' && body) {
        try {
          // 拆 sticker：正文剥标记（无图，applyImage 空 map）+ 图独立成气泡（stickerImgs）
          let stickerImgs = []
          let cleanBody = body
          if (acceptMap && acceptMap.size) {
            try {
              cleanBody = rt.sticker.applyImage(body, new Map())
              stickerImgs = [...acceptMap.values()].map((e) => rt.sticker._imgDataUri(e.abs || e.path)).filter(Boolean)
            } catch { cleanBody = body }
          }
          const img = await renderReplyImage(cleanBody, {
          scale: cfg.reply?.renderScale ?? 3,
          footer: `会话 #${ctx.conversationId} · 对话 ${traceId.slice(0, 8)}`,
          extraCss: REPLY_CSS,
          chat: {
            userText: text,
            userName: this.e.sender?.card || this.e.sender?.nickname || ctx.userId,
            userAvatar: `https://q1.qlogo.cn/g?b=qq&nk=${ctx.userId}&s=100`,
            aiName: (typeof Bot !== 'undefined' && (Bot.nickname || Bot.name)) || 'AI',
            aiAvatar: `https://q1.qlogo.cn/g?b=qq&nk=${(typeof Bot !== 'undefined' && (Bot.uin || Bot.uins?.[0])) || this.e.self_id || ''}&s=100`,
            groupName: ctx.isGroup ? (this.e.group_name || this.e.groupInfo?.group_name || '') : '',
            groupId: ctx.groupId || '',
            model: cfg.model || '',
            inputTokens: usage?.input ?? usage?.raw?.prompt_tokens ?? usage?.prompt_tokens ?? 0,
            outputTokens: usage?.output ?? usage?.raw?.completion_tokens ?? usage?.completion_tokens ?? 0,
            tokens: usage?.total_tokens ?? usage?.total ?? (usage ? ((usage.prompt_tokens ?? usage.input_tokens ?? usage.input ?? 0) + (usage.completion_tokens ?? usage.output_tokens ?? usage.output ?? 0)) : null),
            reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens ?? usage?.raw?.completion_tokens_details?.reasoning_tokens ?? usage?.raw?.reasoning_tokens ?? 0,
            stickerImgs,
          },
        })
          if (img) {
            await this.e.reply(atSender ? [atSender, img] : img); delivered = true
            // 图片模式下链接单独发（图内无法复制）：单链接文本直发；多链接打包一条合并转发防刷屏
            const __links = [...new Set((body.match(/https?:\/\/[^\s<>"')]+/g) || []).map((s) => s.replace(/[.,;:!?)]+$/, '')))]
            if (__links.length === 1) {
              try { await this.e.reply(__links[0]) } catch { /* noop */ }
            } else if (__links.length > 1) {
              // 多链接 → 合并转发卡片（Yunzai makeForwardMsg：e.group/friend/Bot.makeForwardMsg([{message},...]) → forward segment → reply）
              try {
                const fwdMsg = __links.map((u) => ({ message: u }))
                let fwd = null
                if (this.e.isGroup && this.e.group?.makeForwardMsg) fwd = await this.e.group.makeForwardMsg(fwdMsg)
                else if (this.e.friend?.makeForwardMsg) fwd = await this.e.friend.makeForwardMsg(fwdMsg)
                else if (typeof Bot !== 'undefined' && Bot.makeForwardMsg) fwd = await Bot.makeForwardMsg(fwdMsg)
                if (fwd) await this.e.reply(fwd)
                else throw new Error('forward unavailable')
              } catch {
                // 适配器不支持合并转发 → 降级一条文本
                try { await this.e.reply(__links.join('\n')) } catch { /* noop */ }
              }
            }
          }
        } catch (e) { Log.warn('[render] 回复图片渲染失败，回退文本', e?.message || e) }
      }
      if (!delivered) {
        // 文本模式（或图片渲染失败）：正文先发（剥除所有表情包标记，不在正文内联）；
        // 表情包作为主内容之后的【独立消息】依次发送（不与文字混排在同一条）。
        const cleanBody = acceptMap ? rt.sticker.applyText(body, new Map()) : (body || '(无回复)')
        try {
          const txt = `${cleanBody}${suffix ? `\n${suffix}` : ''}`
          await this.e.reply(atSender ? [atSender, txt] : txt)
          delivered = true
          // 表情包：主内容发完后，作为独立消息依次发送
          if (acceptMap && acceptMap.size && typeof segment !== 'undefined') {
            for (const abs of acceptMap.values()) {
              try { await this.e.reply(segment.image(abs)) } catch (e) { Log.warn('[render] 表情包单独发送失败', e?.message || e) }
            }
          }
        } catch (e) { Log.warn('[render] 文本回复发送失败', e?.message || e) }
      } else if (suffix) {
        await this.e.reply(suffix) // 图片已发，max_turns 提示作附注
      }
      // 记录群内最近活跃时间，供 perception 判断"久未发言补课"
      if (ctx.isGroup && ctx.groupId && rt.kv) {
        rt.kv.set(`perception:last_active:${ctx.groupId}`, { at: Date.now() }).catch(() => {})
      }
      devLog('reply', { mode: replyMode, delivered, replyLen: (body || '').length, body: body || '', turns, stopReason }, traceId, ctx.devScope)
    } catch (e) {
      Log.error('[chat] agent 失败', e?.message || e)
      devLog('error', { error: e?.message || String(e), stack: e?.stack || null, input: (text || '').slice(0, 200), model: cfg.model, turns: 'unknown' }, traceId, ctx?.devScope)
      await this.e.reply([
        redactSecrets(`⚠️ 处理时出错：${e?.message || e}`),
        '如反复出错，请发送 #上报错误 <问题描述> 上报（自动打包会话日志给开发者）；',
        '或加入官方 QQ 群 960179589 @群主 并附上日志反馈。',
      ].join('\n'))
    }
    return true
  }

  // —— 多对话 ——
  async chatList() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const list = await rt.session.listConversations(ctx.scopeUserId, ctx.groupId)
    const activeId = await rt.session.getActiveConversation(ctx.scopeUserId, ctx.groupId)
    const html = buildChatListHtml({ user: ctx.userId, conversations: list, activeId })
    const img = await screenshot('agents-plugin/chat-list', html)
    if (img) return this.e.reply(img), true
    const lines = list.map((c) => `#${c.id} ${c.title}（${c.count}条）${c.id === activeId ? ' [当前]' : ''}`)
    await this.e.reply(['聊天列表', ...lines].join('\n'))
    return true
  }

  async enterChat() {
    const id = this.e.msg.match(/\d+/)?.[0]
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const ok = await rt.session.setActiveConversation(ctx.scopeUserId, ctx.groupId, id)
    await this.e.reply(ok ? `已切换到对话 #${id}` : `未找到对话 #${id}，发送 #聊天列表 查看`)
    return true
  }

  async newChat() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const conv = await rt.session.createConversation(ctx.scopeUserId, ctx.groupId)
    await this.e.reply(`已新建对话 #${conv.id}（${conv.title}），后续消息在此对话中继续`)
    return true
  }

  // —— 错误上报：把该用户最近 10 个会话的 dev 日志打包发给主人私信 ——
  // ============ 在线自进化：审阅 / 采纳 / 拒绝 / 回滚（主人）============
  // 后台 SelfReviewer 每 N 轮对话自动产出 suggestion：memory 类（低风险）已自动应用；
  // skill/prompt 类（高风险）落盘待审，在此人工把关。#进化 prompt 走离线 GEPA（见 evolvePrompt）。

  // ============ Tool Evolution：#进化工具 生成候选工具（主人）============
  async toolEvoEvolve() {
    const goal = this.e.msg.replace(/^#进化工具\s+/, '').trim()
    if (!goal) { await this.e.reply('用法：#进化工具 <能力描述>，如\n#进化工具 提取文本中所有邮箱地址'); return true }
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    if (!rt?.toolEvo?.engine) { await this.e.reply('工具进化未启用（config: agent.toolEvo.enable，或 sqlite3 未装）'); return true }
    await this.e.reply(`🧬 正在为「${goal}」生成候选工具…（LLM 生成 + typescript AST 验证，约数秒）`)
    try {
      const r = await rt.toolEvo.engine.evolve({ goal })
      if (r.ok) {
        await this.e.reply([
          `✅ 候选已生成：${r.name}@${r.version} → draft`,
          '待阶段2 沙箱行为验证 + #采纳 后上线（当前仅注册，不自动晋升）。',
          r.assumptions?.length ? '假设：' + r.assumptions.join('；') : '',
        ].filter(Boolean).join('\n'))
      } else {
        await this.e.reply(`❌ 候选被拒（${r.status}）：\n${r.reason}`)
      }
    } catch (err) { await this.e.reply('❌ 进化失败：' + (err?.message || err)) }
    return true
  }

  async toolEvoList() {
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    if (!rt?.toolEvo?.registry) { await this.e.reply('工具进化未启用（config: agent.toolEvo.enable）'); return true }
    const versions = await rt.toolEvo.registry.listVersions()
    if (!versions.length) { await this.e.reply('暂无进化工具版本。用 #进化工具 <能力描述> 生成候选。'); return true }
    const icon = (s) => s === 'stable' ? '🟢' : s === 'verified' ? '🟡' : s === 'draft' ? '⚪' : '⚫'
    const lines = versions.slice(0, 20).map((v) => `${icon(v.status)} ${v.semver} · id=${v.id} [${v.status}]`)
    await this.e.reply(`工具进化版本（共 ${versions.length}，显示前 20）：\n${lines.join('\n')}\n\n🟡verified 可 #采纳工具 <id> 晋升 stable`)
    return true
  }

  async toolEvoAdopt() {
    const versionId = this.e.msg.replace(/^#采纳工具\s+/, '').trim()
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    if (!rt?.toolEvo?.registry) { await this.e.reply('工具进化未启用'); return true }
    const reg = rt.toolEvo.registry
    const v = await reg.getVersion(versionId)
    if (!v) { await this.e.reply(`版本 ${versionId} 不存在`); return true }
    if (v.status !== 'verified') { await this.e.reply(`仅 verified 候选可采纳（当前状态：${v.status}）`); return true }
    try {
      await reg.setStatus(versionId, 'stable', { actor: 'master:' + this.e.user_id, reason: '手动采纳' })
      const stable = (await reg.listStable()).find((s) => s.versionId === versionId)
      if (stable) rt.tools.register(await reg.toToolContract(stable, rt.toolEvo.runner))
      await this.e.reply(`✅ ${v.manifest.name}@${v.semver} 已晋升 stable 并注入\nagent 可经 tool_search 调用（工具名：${v.manifest.name}）`)
    } catch (e) { await this.e.reply('❌ 采纳失败：' + (e?.message || e)) }
    return true
  }

  async toolEvoDecommission() {
    const versionId = this.e.msg.replace(/^#淘汰工具\s+/, '').trim()
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    if (!rt?.toolEvo?.registry) { await this.e.reply('工具进化未启用'); return true }
    const reg = rt.toolEvo.registry
    const v = await reg.getVersion(versionId)
    if (!v) { await this.e.reply(`版本 ${versionId} 不存在`); return true }
    try {
      // 淘汰只影响目标版本（审计 §4.1）：目标=active → 自动回滚到另一 stable 或下线；目标≠active → 仅 DB deprecated，不影响注入
      const tool = await reg.getById(v.tool_id)
      const wasActive = tool?.active_version_id === versionId
      await reg.setStatus(versionId, 'deprecated', { actor: 'master:' + this.e.user_id, reason: '手动淘汰' })
      if (wasActive) {
        const others = await reg.listVersions({ toolId: v.tool_id, status: 'stable' })
        if (others.length) {
          const target = others[0]
          await reg.setActiveVersion(v.tool_id, target.id, { actor: 'master:' + this.e.user_id, reason: `淘汰 ${v.semver} 后回滚` })
          const stable = (await reg.listStable()).find((s) => s.versionId === target.id)
          if (stable) rt.tools.register(await reg.toToolContract(stable, rt.toolEvo.runner))
          await this.e.reply(`🗑️ ${v.manifest.name}@${v.semver} 已淘汰（原 active）。已自动回滚到 ${target.semver} 并重新注入。`)
        } else {
          rt.tools.unregister(v.manifest.name)
          await this.e.reply(`🗑️ ${v.manifest.name}@${v.semver} 已淘汰并下线（无其它 stable 可回滚；制品保留作审计）`)
        }
      } else {
        await this.e.reply(`🗑️ ${v.manifest.name}@${v.semver} 已淘汰（非 active，注入的 active 版本不受影响；制品保留作审计）`)
      }
    } catch (e) { await this.e.reply('❌ 淘汰失败：' + (e?.message || e)) }
    return true
  }

  // #回滚工具 <工具名> <semver>：切 active 到指定 stable 版本 + 重新注入（审计 §4.1 版本回滚）
  async toolEvoRollback() {
    const m = this.e.msg.match(/^#回滚工具\s+(\S+)\s+(\S+)/)
    if (!m) { await this.e.reply('用法：#回滚工具 <工具名> <semver>，如\n#回滚工具 extract_email 1.0.0'); return true }
    const [, name, semver] = m
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    if (!rt?.toolEvo?.registry) { await this.e.reply('工具进化未启用'); return true }
    const reg = rt.toolEvo.registry
    try {
      const tool = await reg.getByName(name)
      if (!tool) { await this.e.reply(`工具「${name}」不存在`); return true }
      const target = (await reg.listVersions({ toolId: tool.id, status: 'stable' })).find((vv) => vv.semver === semver)
      if (!target) { await this.e.reply(`「${name}」无 stable 版本 ${semver}（回滚目标须是已上线版本）`); return true }
      await reg.setActiveVersion(tool.id, target.id, { actor: 'master:' + this.e.user_id, reason: `手动回滚到 ${semver}` })
      rt.tools.unregister(name)
      const stable = (await reg.listStable()).find((s) => s.versionId === target.id)
      if (stable) rt.tools.register(await reg.toToolContract(stable, rt.toolEvo.runner))
      await this.e.reply(`↩️ ${name} 已回滚到 ${semver} 并重新注入（active 版本切换）`)
    } catch (e) { await this.e.reply('❌ 回滚失败：' + (e?.message || e)) }
    return true
  }

  async toolEvoHealth() {
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    if (!rt?.toolEvo?.registry) { await this.e.reply('工具进化未启用（config: agent.toolEvo.enable）'); return true }
    const { failureClusters, convergenceMetrics } = await import('../model/toolEvo/evaluator.js')
    const [clusters, metrics] = await Promise.all([failureClusters(), convergenceMetrics()])
    const head = `📊 工具库：${metrics.stable} stable / ${metrics.totalVersions} 总版本 · 调用 ${metrics.invocations} 次（失败率 ${(metrics.invocationFailRate * 100).toFixed(0)}%）`
    if (!clusters.length) { await this.e.reply(`${head}\n\n✅ 所有 stable 工具健康（无高失败率工具）`); return true }
    const lines = clusters.map((c) => `⚠️ ${c.toolName}：失败率 ${(c.failRate * 100).toFixed(0)}%（${c.failed}/${c.total}）· ${c.topErrors.join(', ')}`)
    await this.e.reply(`${head}\n\n${lines.join('\n')}\n\n用 #进化工具 <修复描述> 生成修复候选`)
    return true
  }

  // #openrouter余额：查 OpenRouter key 额度/用量（master；需 agent.apiKey 为 OpenRouter key）
  async openrouterBalance() {
    const cfg = Config.get().agent || {}
    if (!cfg.apiKey) { await this.e.reply('未配置 agent.apiKey'); return true }
    await this.e.reply('🔄 查询 OpenRouter key 余额…')
    try {
      const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(15000) })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        await this.e.reply(`❌ 查询失败（HTTP ${r.status}）${t ? '：' + t.slice(0, 100) : ''}\n（确认 agent.preset=openrouter 且 apiKey 为 OpenRouter key）`)
        return true
      }
      const d = (await r.json())?.data || {}
      const money = (v) => (v == null ? '∞（无限制）' : `$${Number(v).toFixed(4)}`)
      await this.e.reply([
        '🔑 OpenRouter Key 余额',
        `额度上限：${money(d.limit)}`,
        `剩余额度：${money(d.limit_remaining)}`,
        `已用（总计）：${money(d.usage)}`,
        `已用（今日）：${money(d.usage_daily)}`,
        `已用（本月）：${money(d.usage_monthly)}`,
        `免费层：${d.is_free_tier ? '是' : '否（付费层）'}`,
      ].join('\n'))
    } catch (e) { await this.e.reply('❌ 查询失败：' + (e?.message || e)) }
    return true
  }

  async reviewList() {
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    const ctx = ctxOf(this.e)
    const list = listPendingSuggestions(rt.suggestionDir, ctx.scopeId)
    if (!list.length) {
      const every = Config.get().agent?.selfReview?.every || 20
      await this.e.reply(`当前无待审的自评审 suggestion。\n（后台每 ${every} 轮对话自动产出；memory 类已自动应用，此处仅列 skill/prompt 及低置信 memory）`)
      return true
    }
    const lines = list.map((s, i) => `${i + 1}. [${s.kind}] conf=${(s.confidence || 0).toFixed(2)} id=${s.id}\n   内容：${String(s.payload || '').slice(0, 100)}\n   理由：${String(s.rationale || '').slice(0, 60)}`)
    await this.e.reply(`待审 suggestion（共 ${list.length} 条）—— #采纳 <id> 应用 / #拒绝进化 <id> 丢弃：\n\n${lines.join('\n\n')}`)
    return true
  }

  async reviewAdopt() {
    const id = this.e.msg.replace(/^#采纳\s+/, '').trim()
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    const ctx = ctxOf(this.e)
    const list = listPendingSuggestions(rt.suggestionDir, ctx.scopeId)
    const s = list.find((x) => x.id === id)
    if (!s) { await this.e.reply(`未找到待审 suggestion：${id}`); return true }
    if (s.kind === 'prompt') {
      const key = s.target || 'agent'
      const tpl = rt.promptRegistry.get(key)
      if (!tpl) { await this.e.reply(`未找到 prompt 模板：${key}`); return true }
      const oldSystem = tpl.system
      tpl.system = String(s.payload || '')
      tpl.addChange(`${tpl.version || '1.0.0'}-evolved`, `自评审采纳：${String(s.rationale || '').slice(0, 50)}`)
      try { fs.writeFileSync(path.join(rt.promptDir, `${key}.json`), JSON.stringify(tpl.toJSON(), null, 2)) }
      catch (e) { Log.warn('[evolution] prompt 落盘失败', e?.message || e); await this.e.reply(`⚠️ 已应用但落盘失败：${e?.message || e}`) }
      removeSuggestion(rt.suggestionDir, ctx.scopeId, s.id)
      await this.e.reply(`✅ 已采纳 prompt suggestion（${key}），下轮对话生效。可用 #回滚 ${key} 恢复。\n旧版首句：${oldSystem.slice(0, 50)}…`)
      return true
    }
    await this.e.reply(`[${s.kind}] suggestion 需手工处理（skill 请编辑 skills/ 对应文件）：\n${String(s.payload || '').slice(0, 200)}\n\n已记录采纳并移出待审列表。`)
    removeSuggestion(rt.suggestionDir, ctx.scopeId, s.id)
    return true
  }

  async reviewReject() {
    const id = this.e.msg.replace(/^#拒绝进化\s+/, '').trim()
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    const ctx = ctxOf(this.e)
    const ok = removeSuggestion(rt.suggestionDir, ctx.scopeId, id)
    await this.e.reply(ok ? `已拒绝并删除 suggestion：${id}` : `未找到 suggestion：${id}`)
    return true
  }

  async promptRollback() {
    const key = this.e.msg.replace(/^#回滚\s+/, '').trim()
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    const file = path.join(rt.promptDir, `${key}.json`)
    let removed = false
    try { fs.unlinkSync(file); removed = true } catch { /* 进化产出文件不存在 */ }
    const builtin = TEMPLATES[key]
    if (builtin) rt.promptRegistry.register(PromptTemplate.fromTemplateEntry(key, builtin)) // 引用共享：Agent 下轮自动用回默认
    await this.e.reply(removed ? `✅ 已回滚 ${key} 到内置默认（删除进化产出，下轮生效）` : `${key} 未找到进化产出文件（可能本就是默认版）`)
    return true
  }

  async evolvePrompt() {
    const key = this.e.msg.replace(/^#进化\s+prompt\s+/, '').trim()
    let rt; try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    const cfg = Config.get().agent || {}
    if (!rt.traceStore?.size) { await this.e.reply('TraceStore 暂无对话轨迹，先正常聊几轮再进化（每轮对话自动采迹）。'); return true }
    if (!TEMPLATES[key] && !rt.promptRegistry.get(key)) { await this.e.reply(`未知 prompt 模板：${key}（可用：${Object.keys(TEMPLATES).join(', ')}）`); return true }
    await this.e.reply(`⏳ 开始离线进化 prompt「${key}」：采样轨迹 → GEPA 迭代 → LLM-as-judge 评分（约 1-3 分钟、消耗较多 token，期间勿重复触发）…`)
    try {
      const samples = rt.traceStore.sample(8)
      const evalset = samples.map((t, i) => ({ id: String(i), input: String(t.input || '') })).filter((s) => s.input)
      // LLM-as-judge：无 check 的 case 用主模型评「回复是否正面回应、有无臆测/跑题」(0~1)
      const judge = {
        score: async (item, output) => {
          const p = `用户问题：${String(item.input).slice(0, 200)}\n助手回复：${String(output).slice(0, 300)}\n\n请给回复打分(0~1)：是否正面回应问题、有无明显错误/臆测/跑题。只输出一个小数。`
          try {
            const res = await rt.provider.chat({ model: cfg.model, messages: [{ role: 'user', content: p }], stream: false, temperature: 0 })
            const m = String(res?.content || '').match(/(1(?:\.0+)?|0?\.\d+)/)
            return { score: m ? Math.max(0, Math.min(1, parseFloat(m[1]))) : 0.5 }
          } catch { return { score: 0.5 } }
        },
      }
      const result = await evolveTemplate({ templateKey: key, provider: rt.provider, model: cfg.model, evalset, judge, iterations: 2, populationSize: 3, logger: Log.tag('evolve') })
      if (!result?.best) { await this.e.reply('进化未产出有效版本。'); return true }
      const tpl = rt.promptRegistry.get(key)
      const base = tpl ? tpl.toJSON() : { id: key, system: TEMPLATES[key]?.system || '' }
      const evolved = { ...base, system: result.best.text, version: `${base.version || '1.0.0'}-evolved-${Date.now().toString(36)}` }
      try { fs.writeFileSync(path.join(rt.promptDir, `${key}.json`), JSON.stringify(evolved, null, 2)) } catch (e) { Log.warn('[evolution] 落盘失败', e?.message || e) }
      await this.e.reply(`✅ 进化完成：best=${(result.best.score || 0).toFixed(3)}（baseline=${(result.baseline?.score || 0).toFixed(3)}，${result.improved ? '✨已提升' : '未提升'}）\n已写入 data/evolution/prompts/${key}.json（待审）。\n#审阅进化 → #采纳 <id> 应用，#回滚 ${key} 恢复。`)
    } catch (e) { await this.e.reply(`进化失败：${e?.message || e}`) }
    return true
  }

  async reportBug() {
    const desc = this.e.msg?.match(/^#上报错误(?:\s+)?([\s\S]+)?$/)?.[1]?.trim() || ''
    let rt
    try { rt = await getRuntime() } catch (e) { await this.e.reply(String(e?.message || e)); return true }
    const ctx = ctxOf(this.e)
    const masters = Config.get().agent?.masters || []
    if (!masters.length) { await this.e.reply('⚠️ 未配置 agent.masters，无人接收上报。'); return true }
    // 最近 10 个会话（listConversations 默认按 id 升序，这里按 updatedAt 降序取最近）
    const list = (await rt.session.listConversations(ctx.scopeUserId, ctx.groupId))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 10)
    const c = Config.get().agent?.devLog
    const devDir = c?.dir ? path.resolve(c.dir) : Config.path.logs
    const gid = ctx.groupId || 'private', uid = ctx.scopeUserId
    const collected = []
    for (const conv of list) {
      const prefix = `${gid}-${uid}-${conv.id}-`
      let files = []
      try { files = fs.readdirSync(devDir).filter((f) => f.startsWith(prefix) && f.endsWith('.log')) } catch { /* noop */ }
      for (const f of files) collected.push({ conv, file: f })
    }
    if (!collected.length) { await this.e.reply('未找到你的会话日志（可能尚未触发过 AI 或日志已关闭）。'); return true }
    // 合并成单个 .log 文本（零新依赖，必成功）；每段前加分隔头便于主人定位
    const ts = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    const stamp = `${ts.getFullYear()}${p2(ts.getMonth() + 1)}${p2(ts.getDate())}-${p2(ts.getHours())}${p2(ts.getMinutes())}`
    const bundlePath = path.join(Config.path.temp, `agents-bug-${uid}-${stamp}.log`)
    let header = `# agents-plugin 错误上报\n# 用户：${ctx.userId}（群：${ctx.groupId || '私聊'}）\n# 描述：${desc || '(无)'}\n# 时间：${ts.toLocaleString('zh-CN')}\n# 会话数：${collected.length}\n`
    let body = ''
    for (const { conv, file } of collected) {
      body += `\n===== 会话 #${conv.id} ${conv.title || ''} | createdAt ${conv.createdAt} | updatedAt ${conv.updatedAt} | file ${file} =====\n`
      try { body += fs.readFileSync(path.join(devDir, file), 'utf8') } catch (e) { body += `(读取失败: ${e?.message})\n` }
    }
    try { fs.mkdirSync(Config.path.temp, { recursive: true }); fs.writeFileSync(bundlePath, header + body) }
    catch (e) { await this.e.reply(`打包失败：${e?.message || e}`); return true }
    // 发主人私信
    const bot = (typeof Bot !== 'undefined' && Bot) || null
    let okCnt = 0
    for (const mid of masters) {
      try {
        await bot?.pickFriend?.(mid)?.sendMsg(`🐛 用户上报错误\n用户：${ctx.userId}（群：${ctx.groupId || '私聊'}）\n描述：${desc || '(无)'}\n会话数：${collected.length}\n时间：${ts.toLocaleString('zh-CN')}`)
        await bot?.pickFriend?.(mid)?.sendMsg(toFileSegment(bundlePath, `上报日志-${uid}-${stamp}.log`))
        okCnt++
      } catch (e) { Log.warn('[reportBug] 发送 master 失败', mid, e?.message || e) }
    }
    await this.e.reply([
      `✅ 已上报给 ${okCnt}/${masters.length} 位 master（含最近 ${collected.length} 个会话日志）`,
      '如需进一步帮助：加入官方 QQ 群 960179589 @群主，并附上本次上报的问题描述/日志。',
    ].join('\n'))
    return true
  }

  // —— 模型切换 ——
  async switchModel() {
    const id = this.e.msg.replace(/^#模型切换\s+/, '').trim()
    const rt = await getRuntime()
    rt.agentConfig.model = id
    try {
      const c = Config.get()
      if (!c.agent) c.agent = {}
      c.agent.model = id
      Config.save()
    } catch (e) {
      Log.warn('模型切换持久化失败', e?.message || e)
    }
    await this.e.reply(`已切换模型：${id}`)
    return true
  }

  // —— MCP 启停 ——
  async enableMcp() {
    const name = this.e.msg.replace(/^#启用mcp\s+/, '').trim()
    const rt = await getRuntime()
    const cfg = Config.get().agent?.mcp?.servers?.[name]
    if (!cfg) return this.e.reply(`未在配置中找到 MCP 服务端：${name}`), true
    await rt.mcp.add(name, cfg)
    const s = rt.mcp.status()[name]
    await this.e.reply(s?.status === 'connected' ? `已启用 ${name}（${s.tools} 个工具）` : `启用 ${name} 失败：${s?.error || ''}`)
    return true
  }

  async disableMcp() {
    const name = this.e.msg.replace(/^#停止mcp\s+/, '').trim()
    const rt = await getRuntime()
    await rt.mcp.remove(name)
    await this.e.reply(`已停止 ${name}`)
    return true
  }

  // —— 添加 MCP（标准 mcpServers JSON）→ 连接验证 → 成功则持久化 ——
  // 两种用法：① #添加mcp <JSON> 一行带配置（任意会话）；
  //          ② 私聊发 #添加mcp（不带 JSON）进入监听，下一条消息当作 JSON 处理（onTrigger 拦截），处理一次即结束。
  //          群聊不带 JSON 只显示用法（群聊不开监听，避免群消息被吞）。
  async addMcp() {
    const body = this.e.msg.replace(/^#添加mcp\b\s*/i, '').trim()
    if (!body) {
      if (!this.e.isGroup) {
        // 私聊：进入交互式监听，等下一条消息作为 mcpServers JSON
        mcpAddPending.set(String(this.e.user_id), { at: Date.now() })
        await this.e.reply([
          '📝 已进入添加 MCP 模式，请直接发送 mcpServers JSON 配置。',
          '支持 Claude Desktop / Z.AI 标准格式，例如：',
          '```json',
          '{ "mcpServers": { "zai": { "type": "stdio", "command": "npx", "args": ["-y","@z_ai/mcp-server"], "env": { "Z_AI_API_KEY": "xxx" } } } }',
          '```',
          '收到后会立即连接验证；成功则写入配置（持久化、热加载），失败会报错。',
          `（${MCP_ADD_PENDING_TTL / 1000} 秒内有效；处理一次即结束）`,
        ].join('\n'))
        return true
      }
      // 群聊：不开启监听（避免群消息被吞），提示用一行带 JSON 的方式或去私聊
      await this.e.reply([
        '用法：#添加mcp <mcpServers JSON>',
        '或私聊发送 #添加mcp 进入交互式添加（直接粘贴 JSON 即可）。',
        '示例：',
        '```json',
        '{ "mcpServers": { "zai": { "type": "stdio", "command": "npx", "args": ["-y","@z_ai/mcp-server"], "env": { "Z_AI_API_KEY": "xxx" } } } }',
        '```',
      ].join('\n'))
      return true
    }
    const parsed = this._parseMcpBody(body)
    if (!parsed.ok) { await this.e.reply(parsed.msg); return true }
    await this.e.reply('⏳ 正在连接验证…')
    await this.e.reply((await this._applyMcpServers(parsed.servers)).join('\n'))
    return true
  }

  /** 解析 mcpServers JSON：成功 {ok:true, servers}；失败 {ok:false, msg}（不回复，由调用方决定） */
  _parseMcpBody(body) {
    let parsed
    try { parsed = JSON.parse(body) }
    catch (e) { return { ok: false, msg: `❌ JSON 解析失败：${e?.message || e}\n请粘贴完整的 mcpServers JSON。` } }
    const servers = parsed?.mcpServers || parsed
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      return { ok: false, msg: '❌ 未找到服务端配置（需 { "mcpServers": {...} } 或 { "name": {...} }）' }
    }
    return { ok: true, servers }
  }

  /** 逐个连接验证 + 注册工具；成功的写入配置持久化（触发热加载）。返回结果行数组。 */
  async _applyMcpServers(servers) {
    const rt = await getRuntime()
    const cfg = Config.get()
    cfg.agent = cfg.agent || {}
    cfg.agent.mcp = cfg.agent.mcp || {}
    cfg.agent.mcp.servers = cfg.agent.mcp.servers || {}
    const results = []
    let anyOk = false
    for (const [name, scfg] of Object.entries(servers)) {
      try {
        // add() 会连接 + 注册工具 + 验证可用（失败 entry.status='error'）
        const entry = await rt.mcp.add(name, { ...scfg, enabled: true })
        if (entry.status === 'connected') {
          cfg.agent.mcp.servers[name] = scfg
          anyOk = true
          results.push(`✅ ${name}：已连接，注册 ${entry.tools} 个工具（已写入配置）`)
        } else {
          results.push(`❌ ${name}：${entry.error || entry.status}（未写入配置）`)
        }
      } catch (e) {
        results.push(`❌ ${name}：${e?.message || e}（未写入配置）`)
      }
    }
    if (anyOk) Config.save(cfg) // 持久化成功的 + 触发热加载
    return results
  }

  /** 交互式添加：把监听期间收到的那条消息当作 mcpServers JSON 处理（处理一次即结束监听）。 */
  async _consumeMcpAddJson(raw) {
    const uid = String(this.e.user_id)
    mcpAddPending.delete(uid) // 无论成败都结束监听
    const body = (raw || '').trim()
    if (!body) { await this.e.reply('⚠️ 内容为空，已退出添加流程。重新发送 #添加mcp 可再试。'); return true }
    const parsed = this._parseMcpBody(body)
    if (!parsed.ok) { await this.e.reply(`${parsed.msg}\n（已退出添加流程，重新发送 #添加mcp 可再试）`); return true }
    await this.e.reply('⏳ 收到配置，正在连接验证…')
    await this.e.reply((await this._applyMcpServers(parsed.servers)).join('\n'))
    return true
  }


  async mcpStatus() {
    const rt = await getRuntime()
    const status = rt.mcp.status()
    const names = Object.keys(status)
    if (!names.length) return this.e.reply('未配置 MCP 服务端'), true
    const lines = names.map((n) => {
      const s = status[n]
      return `${s.status === 'connected' ? '✅' : s.status === 'error' ? '❌' : '⏳'} ${n}：${s.tools} 工具${s.error ? `（${s.error}）` : ''}`
    })
    await this.e.reply(lines.join('\n'))
    return true
  }

  // —— 配置热重载（立即重建运行时：provider/model/tools/skills/mcp）——
  async agentsReload() {
    try {
      Config.reload()
      invalidateRuntime()
      await getRuntime()
      await this.e.reply('✅ 已重载配置并重建运行时（model / tools / skills / mcp）')
    } catch (e) {
      Log.error('[reload] 重载失败', e?.message || e)
      await this.e.reply(`重载失败：${e?.message || e}`)
    }
    return true
  }

  // —— 审批 ——（框架主人 OR terminal 主人均可；双路由：框架 ConfirmStore + terminal 自包含）
  async approve() {
    const id = this.e.msg.match(/\d+/)?.[0]
    if (!this.e.isMaster && !isTerminalMaster(this.e.user_id)) return this.e.reply('无权限：仅主人可审批'), true
    const rt = await getRuntime()
    if (rt.confirm.resolve(id, true)) return this.e.reply(`已批准 #${id}`), true
    if (resolveTerminalApproval(id, true)) return this.e.reply(`已批准 terminal #${id}`), true
    await this.e.reply(`未找到待审 #${id}`)
    return true
  }

  async reject() {
    const id = this.e.msg.match(/\d+/)?.[0]
    if (!this.e.isMaster && !isTerminalMaster(this.e.user_id)) return this.e.reply('无权限：仅主人可审批'), true
    const rt = await getRuntime()
    if (rt.confirm.resolve(id, false)) return this.e.reply(`已拒绝 #${id}`), true
    if (resolveTerminalApproval(id, false)) return this.e.reply(`已拒绝 terminal #${id}`), true
    await this.e.reply(`未找到待审 #${id}`)
    return true
  }

  async pending() {
    if (!this.e.isMaster && !isTerminalMaster(this.e.user_id)) return this.e.reply('无权限：仅主人可查看'), true
    const rt = await getRuntime()
    const list = rt.confirm.list()
    const termList = listTerminalApprovals()
    if (!list.length && !termList.length) return this.e.reply('当前无待审批'), true
    const lines = []
    for (const p of list) lines.push(`#${p.id} ${p.tool} ${JSON.stringify(p.args || {}).slice(0, 80)}`)
    for (const t of termList) lines.push(`#${t.id} 🖥️terminal $ ${String(t.info?.command || '').slice(0, 80)}`)
    await this.e.reply(lines.join('\n'))
    return true
  }

  // —— terminal 主人认领（自包含、验证码；不读框架配置）——
  // #agents设置主人 → 控制台打印验证码 + 进入监听态，用户接下来直接发验证码认领（类似 Yunzai #设置主人）
  async terminalRequestClaim() {
    const { ttlMs } = requestClaim()
    const uid = String(this.e.user_id)
    terminalClaimPending.set(uid, { at: Date.now(), expires: Date.now() + ttlMs })
    await this.e.reply(`✅ terminal 主人认领验证码已打印到控制台（${Math.round(ttlMs / 1000)} 秒有效）。\n请在控制台查看验证码，然后直接把它发到这里完成认领（无需加任何命令前缀，${Math.round(ttlMs / 1000)} 秒内可重发）。认领成功即成为 terminal 主人（替换旧主人）。`)
    return true
  }

  // —— 记忆 / 提醒 ——
  async showMemory() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const list = await rt.recall.listByUser(ctx.scopeUserId)
    const text = list.length ? rt.recall.formatForPrompt(list.slice(0, 20)) : rt.memory.snapshotAll(ctx.scopeId)
    await this.e.reply((text || '(记忆为空)').slice(0, 4000))
    return true
  }

  async forget() {
    const kw = this.e.msg.replace(/^#忘掉\s+/, '').trim()
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const n = await rt.recall.forget(ctx.scopeUserId, kw)
    await this.e.reply(n ? `已遗忘 ${n} 条含「${kw}」的记忆` : `未找到含「${kw}」的记忆`)
    return true
  }

  // —— 知识库（全局共享文档库，embedding RAG）——
  async addKnowledge() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    if (!ctx.isMaster) return this.e.reply('仅主人可添加知识库'), true
    let text = this.e.msg.replace(/^#知识库添加\s*/, '').trim()
    // 回复一条消息入库：命令无文本但有 reply_id → 取被回复消息正文
    if (!text && this.e.reply_id != null) {
      try {
        const replied = await (this.e.getReply?.() || this.e.bot?.getMsg?.(this.e.reply_id))
        const msg = replied?.message
        if (Array.isArray(msg)) text = msg.filter((s) => s?.type === 'text').map((s) => s.text || '').join('')
        else if (typeof replied?.content === 'string') text = replied.content
      } catch { /* noop */ }
    }
    if (!text) return this.e.reply('用法：\n#知识库添加 <文本或网址>\n例：\n#知识库添加 https://example.com\n#知识库添加 一段资料…\n或回复一条消息后发：#知识库添加'), true
    // URL 入库：抓取网页正文（crawl4ai 优先，降级 fetch）→ ingest
    if (/^https?:\/\//i.test(text)) {
      await this.e.reply(`🌐 抓取入库中（${text}）…`)
      const r = await rt.knowledge.ingestUrl(text)
      if (r.error) return this.e.reply(r.error), true
      await this.e.reply(`✓ 已抓取入库 ${r.id}：${r.title}\n${r.chunkCount} 块（via ${r.via}）${r.embedded ? '·已向量化' : '·关键词检索'}\n定时刷新最新：#知识库定时 ${r.id} 每天8点`)
      return true
    }
    const r = await rt.knowledge.ingest(text, { source: `command:${ctx.userId}` })
    if (r.error) return this.e.reply(r.error), true
    await this.e.reply(`✓ 已入库 ${r.id}：${r.chunkCount} 块${r.embedded ? '（已向量化）' : '（未配 embedding，关键词检索）'}`)
    return true
  }

  async listKnowledge() {
    const rt = await getRuntime()
    const docs = await rt.knowledge.listDocs()
    if (!docs.length) return this.e.reply('知识库为空（web 知识库页 或 #知识库添加 入库）'), true
    const lines = docs.map((d) => {
      const tag = d.url ? '🌐' : '📄'
      const cron = d.refreshCron ? ` ·定时(${d.refreshCron})` : ''
      const refreshed = d.lastCrawled ? ` ·刷新${new Date(d.lastCrawled).toLocaleDateString('zh-CN')}` : ''
      return `${tag} ${d.id} | ${d.title} | ${d.chunkCount}块${cron}${refreshed} | ${new Date(d.createdAt).toLocaleDateString('zh-CN')}`
    })
    await this.e.reply(`知识库（${docs.length} 篇；🌐=网页URL 可 #知识库刷新/#知识库定时）：\n${lines.join('\n')}`)
    return true
  }

  async delKnowledge() {
    const rt = await getRuntime()
    const id = (this.e.msg.match(/^#知识库删除\s+(\S+)/) || [])[1] || ''
    if (!id) return this.e.reply('用法：#知识库删除 <id>（id 见 #知识库列表）'), true
    const n = await rt.knowledge.removeDoc(id)
    await this.e.reply(n ? `已删除 ${id}` : `未找到 ${id}`)
    return true
  }

  async rebuildKnowledge() {
    const rt = await getRuntime()
    await this.e.reply('开始重建知识库索引…')
    const r = await rt.knowledge.rebuild()
    await this.e.reply(r.error ? r.error : `✓ 重建完成：${r.rebuilt} 块`)
    return true
  }

  async refreshKnowledge() {
    const rt = await getRuntime()
    if (!ctxOf(this.e).isMaster) return this.e.reply('仅主人可操作'), true
    const id = (this.e.msg.match(/^#知识库刷新\s+(\S+)/) || [])[1] || ''
    if (!id) return this.e.reply('用法：#知识库刷新 <id>（id 见 #知识库列表，仅 🌐 网页文档可刷新）'), true
    await this.e.reply(`🔄 刷新中（${id}）…`)
    const r = await rt.knowledge.refreshDoc(id)
    if (r.error) return this.e.reply(r.error), true
    await this.e.reply(`✓ 已刷新 ${id}：${r.chunkCount} 块（via ${r.via}）`)
    return true
  }

  async refreshAllKnowledge() {
    const rt = await getRuntime()
    if (!ctxOf(this.e).isMaster) return this.e.reply('仅主人可操作'), true
    const urlDocs = await rt.knowledge.listUrlDocs()
    if (!urlDocs.length) return this.e.reply('知识库暂无网页 URL 文档（#知识库添加 <网址> 入库）'), true
    await this.e.reply(`🔄 开始刷新 ${urlDocs.length} 个网页文档（串行）…`)
    const r = await rt.knowledge.refreshAll()
    await this.e.reply(`✓ 刷新完成：${r.refreshed}/${r.total} 成功`)
    return true
  }

  async setKbRefresh() {
    const rt = await getRuntime()
    if (!ctxOf(this.e).isMaster) return this.e.reply('仅主人可操作'), true
    const m = this.e.msg.match(/^#知识库定时\s+(\S+)\s+([\s\S]+)/) || []
    const id = m[1] || ''
    const when = (m[2] || '').trim()
    if (!id || !when) return this.e.reply('用法：#知识库定时 <id> <时间>\n如：#知识库定时 kbXXX 每天8点\n时间支持：每天8点 / 每2小时 / 工作日9点 / 每周一8点30'), true
    const cron = parseCron(when)
    if (!cron) return this.e.reply(`无法识别时间「${when}」。支持：每天8点 / 每2小时 / 工作日9点 / 每周一8点30`), true
    const r = await rt.knowledge.setRefresh(id, cron)
    if (r.error) return this.e.reply(r.error), true
    await this.e.reply(`✓ 已设定时刷新 ${id}\n周期：${when}（${cron}）\n取消：#知识库取消定时 ${id}`)
    return true
  }

  async cancelKbRefresh() {
    const rt = await getRuntime()
    if (!ctxOf(this.e).isMaster) return this.e.reply('仅主人可操作'), true
    const id = (this.e.msg.match(/^#知识库取消定时\s+(\S+)/) || [])[1] || ''
    if (!id) return this.e.reply('用法：#知识库取消定时 <id>'), true
    await rt.knowledge.cancelRefresh(id)
    await this.e.reply(`✓ 已取消 ${id} 的定时刷新`)
    return true
  }

  // —— 定时任务（cron 重复 + 任务链：到点跑 Agent 任务 + 发结果）——
  async addCronTask() {
    const rt = await getRuntime()
    if (Config.get().agent?.schedule?.taskEnabled === false) return this.e.reply('定时任务功能已关闭'), true
    const raw = this.e.msg.replace(/^#定时任务\s+/, '').trim()
    const sp = raw.indexOf(' ')
    if (sp < 0) return this.e.reply('用法：#定时任务 <时间> <任务描述>\n如：#定时任务 每天8点 搜索今日AI资讯\n时间支持：每天8点 / 每2小时 / 工作日9点 / 每周一8点30 / 每30分钟'), true
    const when = raw.slice(0, sp).trim()
    const prompt = raw.slice(sp + 1).trim()
    const cron = parseCron(when)
    if (!cron) return this.e.reply(`无法识别时间「${when}」。支持：每天8点 / 每2小时 / 工作日9点 / 每周一8点30 / 每30分钟`), true
    const rec = await rt.schedule.add({
      type: 'task', cron, prompt,
      userId: String(this.e.user_id || ''), groupId: this.e.group_id ? String(this.e.group_id) : null,
      selfId: String(this.e.self_id || this.e.selfId || ''),
    }, makeFireDispatch(rt))
    await this.e.reply(`✓ 定时任务 #${rec.id}\n周期：${when}（${cron}）\n任务：${prompt}`)
    return true
  }

  async listCronTask() {
    const rt = await getRuntime()
    const tasks = (await rt.schedule.listAll()).filter((r) => r.type === 'task')
    if (!tasks.length) return this.e.reply('暂无定时任务（#定时任务 <时间> <任务> 创建）'), true
    const lines = tasks.map((r) => `#${r.id} | ${r.cron} | ${String(r.prompt).slice(0, 40)}`)
    await this.e.reply(`定时任务（${tasks.length}）：\n${lines.join('\n')}`)
    return true
  }

  async cancelCronTask() {
    const rt = await getRuntime()
    const id = (this.e.msg.match(/^#取消定时任务\s+(\S+)/) || [])[1] || ''
    if (!id) return this.e.reply('用法：#取消定时任务 <id>（id 见 #定时任务列表）'), true
    await rt.schedule.cancel(id)
    await this.e.reply(`已取消定时任务 #${id}`)
    return true
  }

  // —— LLM 自进化（手动触发；平时每 N 轮自动跑）——
  async llmEvolve() {
    const rt = await getRuntime()
    if (!rt?.selfReview) return this.e.reply('⚠️ 自进化未启用（config agent.selfReview.enable）'), true
    const ctx = ctxOf(this.e)
    await this.e.reply('🧬 开始 LLM 自进化评审（近期对话轨迹 + 记忆快照 → 产出改进 suggestion）…')
    try {
      const r = await rt.selfReview.force(ctx)
      if (r?.error) return this.e.reply(`⚠️ ${r.error}`), true
      await this.e.reply(r.suggestionCount > 0
        ? `✓ 自进化完成，产出 ${r.suggestionCount} 条 suggestion\n（memory 类已自动应用；prompt/技能类待审：#审阅进化）`
        : '✓ 自进化完成，本轮无新 suggestion（近期对话暂无改进点）')
    } catch (e) {
      await this.e.reply(`⚠️ 评审失败：${e?.message || e}`)
    }
    return true
  }

  async myReminders() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const list = await rt.schedule.listByUser(ctx.userId)
    if (!list.length) return this.e.reply('暂无提醒'), true
    const lines = list.map((r) => `#${r.id} ${new Date(r.at).toLocaleString()}：${r.message}`)
    await this.e.reply(lines.join('\n'))
    return true
  }

  async cancelReminder() {
    const id = this.e.msg.match(/\d+/)?.[0]
    const rt = await getRuntime()
    await rt.schedule.cancel(id)
    await this.e.reply(`已取消提醒 #${id}`)
    return true
  }

  // —— 清空自己的所有记录（不含配置文件；2 步确认）——
  async clearMyData() {
    const rt = await getRuntime()
    const uid = String(this.e.user_id)
    const ctx = ctxOf(this.e)
    const sharedGroup = ctx.scopeUserId === '__group__' // 关闭隔离的群聊：会话/记忆为群共享，不清（避免一人清空全群）
    const now = Date.now()
    const last = _clearPending.get(uid)
    if (!last || now - last > 60000) {
      _clearPending.set(uid, now)
      await this.e.reply([
        '⚠️ 确认清空你的所有记录？将删除：',
        '· 全部对话历史',
        '· 长期记忆（recall）',
        '· 个人笔记',
        '· 提醒',
        '· 人设绑定（恢复默认）',
        ...(sharedGroup ? ['（当前为「群共享」模式，群共享的对话/记忆不在此次清理范围）'] : []),
        '',
        '**不删除配置文件**。60 秒内再发一次「#清空所有记录」执行。',
      ].join('\n'))
      return true
    }
    _clearPending.delete(uid)
    try {
      const cleared = []
      // 会话：扫描归属当前用户的 session 键（keyUid=该 key 的归属用户；ON=本人各群会话；群共享 '__group__' 跳过）
      const sessPrefix = 'Yz:agent:sess:'
      let nSess = 0
      for (const k of await rt.kv.scan(sessPrefix)) {
        const tail = String(k).slice(sessPrefix.length)
        const parts = tail.split(':')
        let keyUid = null
        if (parts[0] === 'conv') keyUid = (parts[1] === 'active' || parts[1] === 'seq') ? parts[3] : parts[2]
        else keyUid = parts[1] // 旧 group:user 会话 <gid>:<uid>
        if (keyUid === uid && keyUid !== '__group__') { await rt.kv.del(k); nSess++ }
      }
      if (nSess) cleared.push(`对话历史(${nSess})`)
      // 召回记忆（按真实 uid：ON=本人 recall；群共享 recall 在 '__group__' 下，不会被误清）
      await rt.recall.clearAll(uid); cleared.push('长期记忆')
      // 声明式记忆（按 scopeId 隔离的 MEMORY.md/USER.md；群共享模式跳过）
      if (!sharedGroup) { rt.memory.clear(ctx.scopeId); cleared.push('声明式记忆') }
      // 个人笔记
      await rt.kv.del(`Yz:agent:note:${uid}`); cleared.push('笔记')
      // 提醒
      const rems = await rt.schedule.listByUser(uid)
      for (const r of rems) await rt.schedule.cancel(r.id)
      if (rems.length) cleared.push(`提醒(${rems.length})`)
      // 人设绑定
      await rt.persona.resetActive(uid); cleared.push('人设绑定')
      await this.e.reply('✅ 已清空你的所有记录：' + cleared.join('、') + '\n（配置文件未动）')
    } catch (e) {
      Log.error('[clear] 清空失败', e?.message || e)
      await this.e.reply(`清空失败：${e?.message || e}`)
    }
    return true
  }


  // —— 人设 ——
  async personaList() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const personas = rt.personaStore.list()
    const activeId = await rt.persona.getActiveId(ctx.userId)
    const html = buildPersonaListHtml({ user: ctx.userId, personas, activeId })
    const img = await screenshot('agents-plugin/persona-list', html)
    if (img) return this.e.reply(img), true
    const lines = personas.map((p, i) => `${p.id === activeId ? '★' : '·'} ${i + 1}. ${p.name}${p.builtin ? '（内置）' : ''} — ${p.description}`)
    await this.e.reply(['人设列表（#人设 + 序号切换，如 #人设 1）', ...lines].join('\n'))
    return true
  }

  async personaSwitch() {
    const input = this.e.msg.replace(/^#人设\s+/, '').trim()
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    // 数字 → 列表序号（1-based）；否则按 id/名称
    let target = input
    if (/^\d+$/.test(input)) {
      const list = rt.personaStore.list()
      const idx = Number(input) - 1
      if (idx < 0 || idx >= list.length) return this.e.reply(`序号超出范围（1-${list.length}），发送 #人设 查看列表`), true
      target = list[idx].id
    }
    try {
      const p = await rt.persona.setActive(ctx.userId, target)
      await this.e.reply(`已切换人设：${p.name}${p.greeting ? `\n${p.greeting}` : ''}`)
    } catch (e) {
      await this.e.reply(e?.message || '切换失败，发送 #人设 查看列表')
    }
    return true
  }

  async personaDetail() {
    const input = this.e.msg.replace(/^#人设详情\s+/, '').trim()
    const rt = await getRuntime()
    // 数字 → 序号
    let target = input
    if (/^\d+$/.test(input)) {
      const list = rt.personaStore.list()
      const idx = Number(input) - 1
      if (idx < 0 || idx >= list.length) return this.e.reply(`序号超出范围（1-${list.length}）`), true
      target = list[idx].id
    }
    const p = rt.personaStore.get(target)
    if (!p) return this.e.reply(`未找到人设「${input}」`), true
    const tags = p.tags?.length ? ` | 标签：${p.tags.join('、')}` : ''
    await this.e.reply([
      `#${p.id} ${p.name}${p.builtin ? '（内置）' : '（自定义）'}${tags}`,
      p.description,
      '—— 人设内容 ——',
      p.systemPrompt,
    ].join('\n'))
    return true
  }

  async personaCreate() {
    const rest = this.e.msg.replace(/^#新建人设\s+/, '').trim()
    const sp = rest.indexOf(' ')
    if (sp < 0) return this.e.reply('格式：#新建人设 <名称> <人设内容>（名称与内容用空格分隔）'), true
    const name = rest.slice(0, sp).trim()
    const systemPrompt = rest.slice(sp + 1).trim()
    if (!name || systemPrompt.length < 2) return this.e.reply('名称或人设内容过短'), true
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    try {
      const p = rt.personaStore.add({ name, systemPrompt }, { creator: ctx.userId })
      await rt.persona.setActive(ctx.userId, p.id)
      await this.e.reply(`已创建并切换到人设：${p.name}（#${p.id}）`)
    } catch (e) {
      await this.e.reply(e?.message || '创建失败')
    }
    return true
  }

  async personaDelete() {
    const idOrName = this.e.msg.replace(/^#删除人设\s+/, '').trim()
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    const p = rt.personaStore.get(idOrName)
    if (!p) return this.e.reply(`未找到人设「${idOrName}」`), true
    if (p.builtin) return this.e.reply(`内置人设「${p.name}」不可删除`), true
    // 仅创建者或 master 可删
    if (p.creator && p.creator !== ctx.userId && !ctx.isMaster) {
      return this.e.reply('仅人设创建者或主人可删除'), true
    }
    rt.personaStore.remove(p.id)
    await rt.persona.resetActive(ctx.userId)
    await this.e.reply(`已删除人设：${p.name}（#${p.id}）`)
    return true
  }

  async personaReset() {
    const rt = await getRuntime()
    const ctx = ctxOf(this.e)
    await rt.persona.resetActive(ctx.userId)
    await this.e.reply('已恢复默认人设')
    return true
  }
}
