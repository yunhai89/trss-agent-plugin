/**
 * RBAC 策略 —— 角色 × 工具类别 → allow/deny/confirm。对应 yunhai lib/agent/policy.js。
 *
 * 角色阶梯：member(0) < admin(1) < owner(2) < master(3)；ctx.isMaster 视为 99。
 * 类别最低角色：query(0) / personal(0) / message(1) / group_manage(2) / system(3)。
 * 群管自动放行：群 admin/owner 在本群操作 group_manage 免审批（权限来自群本身）。
 */

export const RANK = { member: 0, admin: 1, owner: 2, master: 3 }
export const CATEGORY_MIN = { query: 0, personal: 0, message: 1, group_manage: 2, system: 3 }

export function roleRank(role, isMaster) {
  if (isMaster) return 99
  return RANK[role] ?? 0
}

export function categoryMinRole(cat) {
  return CATEGORY_MIN[cat] ?? 99 // 未知类别按最高（需 master）
}

/** 群管工具判定：group_manage 类别 或 显式 meta.groupAdminSkip 标记（群管动作里 category=system
 *  的高危工具如 kick/mute——群管理/群主在群内本就持有这些 QQ 权限，调用免主人审批直接执行） */
const isGroupAdminTool = (tool) => tool?.category === 'group_manage' || tool?.meta?.groupAdminSkip === true

/**
 * @returns {{ decision:'allow'|'deny'|'confirm', reason:string }}
 */
export function decide(ctx, tool) {
  const rank = roleRank(ctx?.role, ctx?.isMaster)
  const cat = tool?.category
  const minRank = categoryMinRole(cat)

  if (isGroupAdminTool(tool) && ctx?.isGroup && ctx?.isGroupAdmin && ctx?.groupAdminSkip !== false) {
    return { decision: 'allow', reason: 'group_manager_auto' }
  }
  if (rank < minRank) {
    return { decision: 'deny', reason: `角色 ${ctx?.role || 'member'} 低于 ${cat || '未知'} 所需等级` }
  }
  if (cat === 'query' || cat === 'personal') return { decision: 'allow', reason: 'read_only_or_self_scope' }
  if (ctx?.isMaster && ctx?.masterSelfSkip !== false) return { decision: 'allow', reason: 'master_self' }
  return { decision: 'confirm', reason: 'state_changing_requires_confirm' }
}

/** 可见类别（渐进式披露：只向用户暴露其角色能用的类别） */
export function visibleCategories(ctx) {
  const rank = roleRank(ctx?.role, ctx?.isMaster)
  const out = []
  for (const [cat, min] of Object.entries(CATEGORY_MIN)) {
    if (cat === 'group_manage' && ctx?.isGroup && ctx?.isGroupAdmin) out.push(cat)
    else if (rank >= min) out.push(cat)
  }
  return out
}

export function roleLabel(ctx) {
  if (ctx?.isMaster) return '主人'
  const r = ctx?.role
  return r === 'admin' ? '管理员' : r === 'owner' ? '群主' : '成员'
}

/**
 * 构造一个绑定了自定义类别最低角色的策略（支持 MCP 等场景自定义类别）。
 * @param {object} opts { categoryMin?: {cat:rank}, groupAdminSkip?: bool, masterSelfSkip?: bool }
 *   categoryMin 与内置 CATEGORY_MIN 合并（覆盖同名、可新增类别，如 { mcp_write: 1 }）。
 * @returns {{ decide, visibleCategories, roleLabel, categoryMin }}
 */
export function createPolicy({ categoryMin, groupAdminSkip = true, masterSelfSkip = true } = {}) {
  const min = { ...CATEGORY_MIN, ...(categoryMin || {}) }

  const decide = (ctx, tool) => {
    const rank = roleRank(ctx?.role, ctx?.isMaster)
    const cat = tool?.category
    const minRank = cat in min ? min[cat] : 99 // 未知类别按最高（需 master）

    if (isGroupAdminTool(tool) && ctx?.isGroup && ctx?.isGroupAdmin && groupAdminSkip) {
      return { decision: 'allow', reason: 'group_manager_auto' }
    }
    if (rank < minRank) {
      return { decision: 'deny', reason: `角色 ${ctx?.role || 'member'} 低于 ${cat || '未知'} 所需等级` }
    }
    if (cat === 'query' || cat === 'personal') return { decision: 'allow', reason: 'read_only_or_self_scope' }
    if (ctx?.isMaster && masterSelfSkip) return { decision: 'allow', reason: 'master_self' }
    return { decision: 'confirm', reason: 'state_changing_requires_confirm' }
  }

  const visibleCategories = (ctx) => {
    const rank = roleRank(ctx?.role, ctx?.isMaster)
    const out = []
    for (const [cat, m] of Object.entries(min)) {
      if (cat === 'group_manage' && ctx?.isGroup && ctx?.isGroupAdmin) out.push(cat)
      else if (rank >= m) out.push(cat)
    }
    return out
  }

  return { decide, visibleCategories, roleLabel, categoryMin: min }
}
