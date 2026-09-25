/**
 * 工具开发 SDK（模板）—— 供第三方开发者编写自定义 Agent 工具。
 *
 * 一个工具 = { name, description, parameters, execute(params, ctx), category?, meta? }
 * 一个工具包 = { name, description, tools | factory, author?, version? }
 *
 * 用 defineTool / defineToolPack 包装可得到：
 *  - 字段校验（缺 name/execute 抛错，而非运行时才暴雷）
 *  - category 默认值（'query'）
 *  - 命名空间前缀（pack.name 自动给子工具加前缀，避免冲突）
 *
 * 	ctx 访问辅助：getBot/getGroup/getFriend/getMember —— 优雅降级，缺失返回 null。
 * 	参数构造辅助：str/num/bool/int/enum/object —— 拼装 JSONSchema 少写样板。
 * 	响应辅助：ok/fail/markdown —— 统一返回结构。
 */

const VALID = ['query', 'personal', 'message', 'group_manage', 'system']

/** 单个工具定义 */
export function defineTool(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('defineTool: spec 必须是对象')
  if (!spec.name || typeof spec.name !== 'string') throw new Error('defineTool: 缺少 name')
  if (typeof spec.execute !== 'function') throw new Error(`defineTool[${spec.name}]: 缺少 execute 函数`)
  if (!spec.parameters || typeof spec.parameters !== 'object') {
    spec.parameters = { type: 'object', properties: {} }
  }
  return {
    name: spec.name,
    description: spec.description || `工具 ${spec.name}`,
    category: spec.category || 'query',
    parameters: spec.parameters,
    meta: spec.meta || undefined,
    execute: spec.execute,
  }
}

/**
 * 工具包定义。pack.name 作为命名空间，自动给每个子工具加 `${name}__` 前缀（除非已带前缀）。
 * @param {object} pack { name, description?, author?, version?, tools?: Tool[]|((ctx)=>Tool[]), prefix?: boolean }
 * @returns {{ name, description, author, version, prefix, resolve(ctx): Tool[] }}
 */
export function defineToolPack(pack) {
  if (!pack || typeof pack !== 'object') throw new Error('defineToolPack: 缺少配置')
  if (!pack.name) throw new Error('defineToolPack: 缺少 name')
  if (!pack.tools && typeof pack.factory !== 'function') {
    throw new Error(`defineToolPack[${pack.name}]: 需提供 tools 数组或 factory`)
  }
  const usePrefix = pack.prefix !== false
  return {
    name: pack.name,
    description: pack.description || '',
    author: pack.author || '',
    version: pack.version || '1.0.0',
    prefix: usePrefix,
    resolve(ctx) {
      const raw = typeof pack.tools === 'function' ? pack.tools(ctx) : pack.tools || pack.factory?.(ctx) || []
      return (Array.isArray(raw) ? raw : [raw])
        .filter(Boolean)
        .map((t) => {
          const tool = typeof t.execute === 'function' ? t : defineTool(t)
          if (usePrefix && !tool.name.startsWith(`${pack.name}__`)) {
            return { ...tool, name: `${pack.name}__${tool.name}` }
          }
          return tool
        })
    },
  }
}

// ─── ctx 访问辅助（优雅降级）───
export function getBot(ctx) {
  return ctx?.bot || (typeof Bot !== 'undefined' ? Bot : null) || null
}

export function getEvent(ctx) {
  return ctx?.e || null
}

/** pickGroup：优先 ctx.e.group，否则 bot.pickGroup */
export function getGroup(ctx, groupId) {
  const gid = groupId || ctx?.e?.group_id || ctx?.groupId
  const e = ctx?.e
  if (e?.group && !groupId) return e.group
  const bot = getBot(ctx)
  if (gid && bot?.pickGroup) {
    try { return bot.pickGroup(gid) } catch { return null }
  }
  return null
}

export function getFriend(ctx, userId) {
  const uid = userId || ctx?.e?.user_id || ctx?.userId
  const e = ctx?.e
  if (e?.friend && !userId) return e.friend
  const bot = getBot(ctx)
  if (uid && bot?.pickFriend) {
    try { return bot.pickFriend(String(uid)) } catch { return null }
  }
  return null
}

export function getMember(ctx, groupId, userId) {
  const g = getGroup(ctx, groupId)
  const uid = String(userId || ctx?.e?.user_id || ctx?.userId)
  if (g?.pickMember) {
    try { return g.pickMember(uid) } catch { return null }
  }
  return null
}

/**
 * 调用 NapCat / OneBot 原生动作（e.bot.sendApi(action, params)）。
 * 供群公告 / 群文件 CRUD / AI 语音 / 合并转发等无框架封装的协议动作使用。
 * @returns {Promise<{ok:true,data}|{ok:false,error}>}
 */
export async function sendApi(ctx, action, params = {}) {
  const bot = ctx?.bot || ctx?.e?.bot || (typeof Bot !== 'undefined' ? Bot : null)
  if (!bot || typeof bot.sendApi !== 'function') {
    return { ok: false, error: '协议端不支持原生 API 调用（需 sendApi，NapCat/OneBot 适配器才有）' }
  }
  try {
    const res = await bot.sendApi(action, params)
    if (res && (res.status === 'ok' || res.retcode === 0)) return { ok: true, data: res.data }
    return { ok: false, error: res?.message || res?.wording || `动作 ${action} 失败（retcode=${res?.retcode}）`, retcode: res?.retcode, raw: res }
  } catch (e) {
    return { ok: false, error: `动作 ${action} 异常：${e?.message || e}` }
  }
}

/** 取当前/指定群号字符串；非群聊且未指定 → null */
export function groupIdOf(ctx, groupId) {
  const gid = groupId || ctx?.e?.group_id || ctx?.groupId
  return gid ? String(gid) : null
}

/**
 * 查询**机器人自身**在某群的角色（admin/owner/member）。best-effort：失败返回 null。
 * 群公告/群管类工具据此预检"机器人是否有权限"，给出可读原因（而不是把协议端原始报错抛给用户）。
 */
export async function botGroupRole(ctx, groupId) {
  const gid = groupIdOf(ctx, groupId)
  if (!gid) return null
  const selfId = String(ctx?.bot?.uin || ctx?.e?.self_id || ctx?.selfId || '')
  // 1) NapCat/OneBot 原生：no_cache 取实时角色
  if (selfId) {
    try {
      const r = await sendApi(ctx, 'get_group_member_info', { group_id: gid, user_id: selfId, no_cache: true })
      if (r.ok && r.data?.role) return String(r.data.role)
    } catch { /* fallthrough */ }
  }
  // 2) 退回框架 group.pickMember
  try {
    const g = getGroup(ctx, gid)
    if (g?.pickMember && selfId) { const m = await g.pickMember(selfId); if (m?.role) return String(m.role) }
  } catch { /* noop */ }
  return null
}

// ─── 参数构造辅助（JSONSchema 样板）───
export const param = {
  str: (desc, opts = {}) => ({ type: 'string', description: desc, ...(opts.enum ? { enum: opts.enum } : {}) }),
  num: (desc) => ({ type: 'number', description: desc }),
  int: (desc, opts = {}) => ({ type: 'integer', description: desc, ...(opts.min != null ? { minimum: opts.min } : {}) }),
  bool: (desc) => ({ type: 'boolean', description: desc }),
  enum: (desc, values) => ({ type: 'string', description: desc, enum: values }),
  object: (properties, required = []) => ({ type: 'object', properties, required }),
}

// ─── 响应辅助 ───
export function ok(data, extra = {}) {
  return { ok: true, ...(typeof data === 'string' ? { content: data } : data), ...extra }
}
export function fail(error, extra = {}) {
  return { ok: false, error: typeof error === 'string' ? error : error?.message || String(error), ...extra }
}
export function markdown(text) {
  return { content: String(text || ''), format: 'markdown' }
}

/** 把 role 字符串归一为 RBAC 阶梯值 */
export function roleRank(role) {
  return { member: 0, admin: 1, owner: 2, master: 3 }[role] ?? 0
}

export { VALID as VALID_CATEGORIES }
