/**
 * Perception —— 情境感知（数据层）。
 *
 * 与 Skill（说明书/指令）相对：perception 注入的是**事实数据**——
 * 当前时间、发言者身份、机器人自身的工具/能力/运行时状态、近期聊天记录。
 * 让 AI 对"自己、对方、环境"有准确认知，避免凭空臆测（如谎称"没有 MCP 功能"）。
 *
 * 这是框架内部数据，开发者扩展的是 skill（说明书），不是这里。
 *
 * 用法（apps 每轮）：
 *   const perception = await buildSituationalContext({ ctx, runtime, e, kv, cfg })
 *   agent.run(input, { ctx, context: perception })
 */

const MET_PREFIX = 'perception:met:' // 已感知过的群
const ACTIVE_PREFIX = 'perception:last_active:' // 群内最近活跃
const ABSENCE_MS = 6 * 60 * 60 * 1000 // 6 小时未发言视为"久离"

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

function nowStr() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 周${WEEK[d.getDay()]}`
}

function roleLabel(ctx) {
  if (ctx?.isMaster) return '主人'
  if (ctx?.role === 'owner') return '群主'
  if (ctx?.role === 'admin') return '管理员'
  return '普通成员'
}

/** 把消息段数组拼成可读文本（媒体标注类型） */
export function messageToText(msg) {
  const segs = msg?.message || msg?.content || []
  const arr = Array.isArray(segs) ? segs : [segs]
  const parts = []
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue
    if (s.type === 'text') parts.push(s.text || '')
    else if (s.type === 'at') parts.push(`@${s.qq}`)
    else if (s.type === 'image') parts.push('[图片]')
    else if (s.type === 'face' || s.type === 'bface' || s.type === 'mface') parts.push('[表情]')
    else if (s.type === 'record') parts.push('[语音]')
    else if (s.type === 'video') parts.push('[视频]')
    else if (s.type === 'file') parts.push(`[文件:${s.name || ''}]`)
  }
  return parts.join('').trim()
}

/** 格式化聊天记录为 "昵称: 文本"，剔除当前消息/空文本，时间正序、限量 */
export function formatHistory(msgs, currentE, cap = 20) {
  const curId = currentE?.message_id != null ? String(currentE.message_id) : null
  const lines = []
  for (const m of [].concat(msgs || [])) {
    if (!m) continue
    if (curId && m.message_id != null && String(m.message_id) === curId) continue
    const nick = m?.sender?.card || m?.sender?.nickname || m?.user_id || '?'
    const txt = messageToText(m)
    if (txt) lines.push(`${nick}: ${txt}`)
  }
  return lines.slice(0, cap).reverse() // 适配器通常逆序返回，翻转为正序
}

/** 工具类别中文标签（与 RBAC CATEGORY_MIN 对齐） */
const TOOL_CAT_LABEL = { query: '查询', personal: '个人', message: '消息', group_manage: '群管', system: '系统' }

/**
 * 运行能力盘点：工具清单 + MCP 协议/运行时 + 框架能力。核心让 AI"知道自己有什么"。
 * （曾名【自我状态】——与 SelfState 自我认知/情绪层（projector 的 planner 投影）纯命名撞车，已改名区分。）
 */
function runtimeStatus(runtime, cfg) {
  const lines = ['【运行能力盘点】']
  // 工具清单：只列能力类别 + 计数（审计 §3.2）。列全量工具名会①抵消 Tool Discovery 省 token 的收益；
  // ②模型见名无 schema 直接调用得 not_found；③形成模糊选择面降低路由准确率。需要具体工具调 tool_search。
  const tools = (runtime?.tools?.list?.() || runtime?.agent?.tools?.list?.() || []).filter((t) => t?.name && !t.name.startsWith('delegate__'))
  const names = tools.map((t) => t.name)
  if (names.length) {
    const counts = {}
    for (const t of tools) {
      const c = TOOL_CAT_LABEL[t.category] ? t.category : '其它'
      counts[c] = (counts[c] || 0) + 1
    }
    const parts = Object.entries(counts).map(([c, n]) => `${TOOL_CAT_LABEL[c] || c}类 ${n}`)
    lines.push(`- 可用工具：共 ${names.length} 个（${parts.join('、')}）。需要具体能力时调 \`tool_search\` 按自然语言搜索或按类别浏览——不要凭印象直接调用未下发 schema 的工具名（会得到 not_found）。`)
  }

  // 终端执行能力：以 terminal 工具是否注册为准（显式告知，避免模型误判"没有能力"）
  if (names.includes('terminal')) {
    lines.push('- 终端执行：✅已启用（工具名 `terminal`；可在主机执行 shell 命令，每条命令需主人 #确认，只读安全命令免审）')
  } else {
    lines.push('- 终端执行：❌未启用（配置 agent.terminal.enable: true 后 #agents重载 开启；未启用则无法在主机执行命令/装软件）')
  }

  // 技能清单：列出可用 skill 名（与 system prompt 的 <available_skills> 目录双通道呼应）
  const skillNames = (runtime?.skills?.list?.() || []).map((s) => s.name).filter(Boolean)
  if (skillNames.length) lines.push(`- 可用技能：${skillNames.join('、')}（任务匹配时调用 skill 工具加载详情）`)

  // MCP：协议层支持 + 运行时接入数
  let mcpConnected = 0
  try {
    const st = runtime?.mcp?.status?.() || {}
    mcpConnected = Object.values(st).filter((s) => s?.status === 'connected').length
  } catch { /* noop */ }
  lines.push(`- MCP：框架已支持该协议；当前接入 ${mcpConnected} 个 MCP 服务端（0 = 协议可用但暂未接入，可让主人按 README 配置）`)

  // 框架能力
  const feats = []
  if (cfg?.media?.enable !== false) feats.push('多模态(图片/文件)')
  if (cfg?.vision?.model) feats.push('视觉识别(子模型)')
  feats.push('深度研究(#研究)')
  feats.push('人设切换(#人设)')
  if (feats.length) lines.push(`- 框架能力：${feats.join('、')}`)

  // 技能目录（供 skillhub 安装时 --dir 指向）
  if (runtime?.skillsDir) lines.push(`- 技能目录：${runtime.skillsDir}（安装 SkillHub 技能时 --dir 指向它）`)
  return lines.join('\n')
}

/** 拉取群内近期聊天记录 → "昵称: 文本" 正序行（适配器通常逆序返回，已翻转；失败返回空数组，不抛错） */
async function fetchGroupHistoryLines({ e, bot, groupId, count, ctx }) {
  const g = e?.group || bot?.pickGroup?.(groupId) || null
  if (!g?.getChatHistory) return []
  try {
    const seq = e?.seq ?? e?.message_id ?? e?.source?.seq ?? undefined
    let msgs = await g.getChatHistory(seq, count)
    // 数据隔离（默认开）：仅当前用户自己的群发言，避免读到他人记录（多用户串档）
    if (ctx?.isolation) {
      const me = e?.user_id != null ? String(e.user_id) : null
      if (me) msgs = [].concat(msgs).filter((m) => m && String(m.user_id) === me)
    }
    return formatHistory(msgs, e, count)
  } catch { return [] }
}

/** 近期聊天记录：首次入群（群信息+历史）或久离补课 */
async function recentHistory({ ctx, e, kv, bot, historyCount }) {
  if (!ctx?.isGroup || !ctx?.groupId || !kv) return null
  const gid = ctx.groupId
  const g = e?.group || bot?.pickGroup?.(gid) || null
  const now = Date.now()

  let met
  try { met = await kv.get(`${MET_PREFIX}${gid}`) } catch { met = null }
  let last
  try { last = await kv.get(`${ACTIVE_PREFIX}${gid}`) } catch { last = null }

  const isFirst = !met
  const isAbsence = !isFirst && last?.at && now - last.at > ABSENCE_MS
  if (!isFirst && !isAbsence) return null

  const parts = []
  // 群信息（仅首次）
  if (isFirst && g?.getInfo) {
    try {
      const info = await g.getInfo()
      parts.push(`群「${info?.group_name || gid}」｜成员 ${info?.member_count ?? '?'}/上限 ${info?.max_member_count ?? '?'}｜群主 ${info?.owner_id ?? '?'}`)
    } catch { /* noop */ }
  }
  // 历史
  const lines = await fetchGroupHistoryLines({ e, bot, groupId: gid, count: historyCount, ctx })
  if (lines.length) parts.push(`${isFirst ? '入群近期对话' : '久未发言后的近期对话'}：\n${lines.join('\n')}`)
  // 标记已感知
  try { await kv.set(`${MET_PREFIX}${gid}`, { at: now }) } catch { /* noop */ }
  if (!parts.length) return null
  return (isFirst ? `【入群感知】你刚进入群 ${gid}。` : '【久未发言补课】') + parts.join('\n')
}

/**
 * 构建情境感知文本（每轮注入 system prompt）。
 * @returns {Promise<string|null>}
 */
export async function buildSituationalContext({ ctx, runtime, e, kv, cfg, bot, historyCount = 15, sessionLen } = {}) {
  const parts = []
  parts.push(`【当前时间】${nowStr()}`)
  // Bot 自身信息（用 Yunzai e.bot/e.self_id 获取，AI 需要知道自己是谁）
  const b = bot || ctx?.bot || e?.bot
  const selfId = e?.self_id || ctx?.bot?.uin || b?.uin || ''
  const botNick = b?.nickname || (typeof Bot !== 'undefined' && Bot.nickname) || ''
  if (selfId || botNick) parts.push(`【机器人身份】${botNick || 'Bot'}（QQ: ${selfId}）——这是你自己的身份，用户问"你的QQ号/你是谁"时据此回答`)
  if (ctx?.isGroup) parts.push(`【发言者】${roleLabel(ctx)}（${ctx.userId}）。权限：${ctx.isMaster ? '可执行敏感指令' : '普通对话与查询类工具'}`)
  parts.push(runtimeStatus(runtime, cfg))
  // 群聊环境提示：引导 AI 主动参考群聊上下文
  if (ctx?.isGroup && ctx?.groupId) {
    parts.push(`【群聊环境】你在群 ${ctx.groupId} 中。回答前请参考上方已注入的近期群聊记录；若上下文不足，主动调用 get_chat_history 工具拉取更多——不要等用户要求。`)
  }
  const hist = await recentHistory({ ctx, e, kv, bot: bot || ctx?.bot, historyCount }).catch(() => null)
  if (hist) {
    parts.push(hist)
  } else {
    // 会话上下文稀薄（新会话 / 历史很少）时主动补一小段近期群聊，避免模型对群内近况一无所知。
    // 与 recentHistory 互斥：刚做过入群/久离补课就不再重复注入。
    // 可用 cfg.perception.sparseInject=false 关闭，cfg.perception.sparseThreshold 调阈值（默认 6 条）。
    const sparseThreshold = cfg?.perception?.sparseThreshold ?? 6
    const sparseEnabled = cfg?.perception?.sparseInject !== false
    if (sparseEnabled && ctx?.isGroup && ctx?.groupId && Number.isFinite(sessionLen) && sessionLen < sparseThreshold) {
      const lines = await fetchGroupHistoryLines({ e, bot: bot || ctx?.bot, groupId: ctx.groupId, count: historyCount, ctx }).catch(() => [])
      if (lines.length) {
        parts.push(`【近期群聊补全】当前会话上下文较少，以下是群内最近对话（如仍不够，可调用 get_chat_history 工具拉取更多）：\n${lines.join('\n')}`)
      }
    }
  }
  return parts.join('\n')
}

export { MET_PREFIX, ACTIVE_PREFIX }
