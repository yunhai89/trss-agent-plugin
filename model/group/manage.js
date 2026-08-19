/**
 * 群聊管理工具（内置）—— 写类，category 高（system/group_manage）。
 * RBAC：system 默认仅 master，group_manage 默认群管以上；群管工具（meta.groupAdminSkip）对
 * 群管理/群主免审批直接执行——权限来自群本身；其余场景按类别走 deny/confirm。
 * 安全：禁止对 bot 自身与操作者本人执行踢出/禁言。
 */

import { defineTool, param, getGroup } from '../toolkit/index.js'

const MAX_MUTE = 30 * 24 * 3600 // 禁言上限 30 天

function needGroup(ctx, gid) {
  const g = getGroup(ctx, gid)
  if (!g) return { error: '当前会话非群聊或协议端不支持群管理操作' }
  return g
}

/** 安全检查：不能对 bot 自己或操作者本人动手 */
function safeTarget(ctx, userId) {
  const selfId = String(ctx?.e?.self_id || ctx?.bot?.selfId || '')
  const operator = String(ctx?.e?.user_id || ctx?.userId || '')
  const target = String(userId)
  if (selfId && target === selfId) return `不能对机器人自身（${selfId}）执行此操作`
  if (operator && target === operator) return '不能对你自己执行此操作'
  return null
}

export const groupKickTool = defineTool({
  name: 'group_kick',
  description: '将成员踢出群（需群主/管理员且机器人有权限；群管理/群主调用直接执行，普通成员不可用）。慎用。',
  category: 'system',
  meta: { interactive: true, groupAdminSkip: true },
  parameters: param.object({
    userId: param.str('目标 QQ 号'),
    rejectAddRequest: param.bool('是否拒绝此人再次加群（默认 false）'),
    groupId: param.str('群号（可选）'),
  }, ['userId']),
  async execute(p, ctx) {
    const bad = safeTarget(ctx, p.userId)
    if (bad) return { error: bad }
    const g = needGroup(ctx, p.groupId)
    if (g.error) return g
    if (typeof g.kickMember !== 'function') return { error: '协议端未提供 kickMember' }
    await g.kickMember(String(p.userId), !!p.rejectAddRequest)
    return { kicked: p.userId }
  },
})

export const groupMuteTool = defineTool({
  name: 'group_mute',
  description: '禁言成员指定秒数（0=解除禁言）。上限 30 天。慎用。',
  category: 'system',
  meta: { interactive: true, groupAdminSkip: true },
  parameters: param.object({
    userId: param.str('目标 QQ 号'),
    duration: param.int('禁言秒数（0=解除，上限 2592000）', { min: 0 }),
    groupId: param.str('群号（可选）'),
  }, ['userId', 'duration']),
  async execute(p, ctx) {
    const bad = safeTarget(ctx, p.userId)
    if (bad) return { error: bad }
    const g = needGroup(ctx, p.groupId)
    if (g.error) return g
    if (typeof g.muteMember !== 'function') return { error: '协议端未提供 muteMember' }
    const dur = Math.min(MAX_MUTE, Math.max(0, Number(p.duration) || 0))
    await g.muteMember(String(p.userId), dur)
    return { muted: p.userId, duration: dur }
  },
})

export const groupMuteAllTool = defineTool({
  name: 'group_mute_all',
  description: '全体禁言开关（true=开启全体禁言，false=关闭）。慎用。',
  category: 'system',
  meta: { interactive: true, groupAdminSkip: true },
  parameters: param.object({
    enable: param.bool('true=全体禁言，false=解除'),
    groupId: param.str('群号（可选）'),
  }, ['enable']),
  async execute(p, ctx) {
    const g = needGroup(ctx, p.groupId)
    if (g.error) return g
    if (typeof g.muteAll !== 'function') return { error: '协议端未提供 muteAll' }
    await g.muteAll(!!p.enable)
    return { muteAll: !!p.enable }
  },
})

export const groupSetCardTool = defineTool({
  name: 'group_set_card',
  description: '设置群成员的群名片（昵称）。空字符串清除。',
  category: 'group_manage',
  meta: { groupAdminSkip: true },
  parameters: param.object({
    userId: param.str('目标 QQ 号'),
    card: param.str('群名片内容'),
    groupId: param.str('群号（可选）'),
  }, ['userId', 'card']),
  async execute(p, ctx) {
    const g = needGroup(ctx, p.groupId)
    if (g.error) return g
    if (typeof g.setCard !== 'function') return { error: '协议端未提供 setCard' }
    await g.setCard(String(p.userId), String(p.card || ''))
    return { userId: p.userId, card: p.card }
  },
})

export const groupSetTitleTool = defineTool({
  name: 'group_set_title',
  description: '设置群成员的头衔。空字符串清除。',
  category: 'group_manage',
  meta: { groupAdminSkip: true },
  parameters: param.object({
    userId: param.str('目标 QQ 号'),
    title: param.str('头衔内容'),
    groupId: param.str('群号（可选）'),
  }, ['userId', 'title']),
  async execute(p, ctx) {
    const g = needGroup(ctx, p.groupId)
    if (g.error) return g
    if (typeof g.setTitle !== 'function') return { error: '协议端未提供 setTitle' }
    await g.setTitle(String(p.userId), String(p.title || ''))
    return { userId: p.userId, title: p.title }
  },
})

export const groupSetAdminTool = defineTool({
  name: 'group_set_admin',
  description: '设置/取消群管理员。慎用。',
  category: 'system',
  meta: { interactive: true, groupAdminSkip: true },
  parameters: param.object({
    userId: param.str('目标 QQ 号'),
    enable: param.bool('true=设为管理员，false=取消'),
    groupId: param.str('群号（可选）'),
  }, ['userId', 'enable']),
  async execute(p, ctx) {
    const bad = safeTarget(ctx, p.userId)
    if (bad) return { error: bad }
    const g = needGroup(ctx, p.groupId)
    if (g.error) return g
    if (typeof g.setAdmin !== 'function') return { error: '协议端未提供 setAdmin' }
    await g.setAdmin(String(p.userId), !!p.enable)
    return { userId: p.userId, admin: !!p.enable }
  },
})

export const groupSetNameTool = defineTool({
  name: 'group_set_name',
  description: '修改群名。慎用。',
  category: 'system',
  meta: { interactive: true, groupAdminSkip: true },
  parameters: param.object({
    name: param.str('新群名'),
    groupId: param.str('群号（可选）'),
  }, ['name']),
  async execute(p, ctx) {
    const g = needGroup(ctx, p.groupId)
    if (g.error) return g
    if (typeof g.setName !== 'function') return { error: '协议端未提供 setName' }
    await g.setName(String(p.name || ''))
    return { name: p.name }
  },
})

export const groupManageTools = [
  groupKickTool, groupMuteTool, groupMuteAllTool,
  groupSetCardTool, groupSetTitleTool, groupSetAdminTool, groupSetNameTool,
]
