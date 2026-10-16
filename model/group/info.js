/**
 * 群聊信息获取工具（内置）—— 读类，category 低（query/group_manage）。
 * 全部经 toolkit.getGroup/getFriend 访问 pickGroup/pickFriend，特征检测方法存在性。
 */

import { defineTool, param, getGroup, getFriend, groupScopeError } from '../toolkit/index.js'

function needGroup(ctx, gid) {
  const scopeErr = groupScopeError(ctx, gid)
  if (scopeErr) return { error: scopeErr }
  const g = getGroup(ctx, gid)
  if (!g) return { error: '当前会话非群聊或协议端不支持群信息查询' }
  return g
}

/** 群信息：名称/人数/上限/群主/简介 */
export const groupInfoTool = defineTool({
  name: 'group_info',
  description: '获取当前（或指定）群的基本信息：群名、成员数、上限、群主。',
  category: 'query',
  parameters: param.object({
    groupId: param.str('群号（可选，默认当前群）'),
  }),
  async execute(p, ctx) {
    const g = needGroup(ctx, p.groupId)
    if (g.error) return g
    if (typeof g.getInfo !== 'function') return { error: '协议端未提供 getInfo' }
    const info = await g.getInfo()
    return {
      groupId: info.group_id,
      name: info.group_name || info.name,
      memberCount: info.member_count,
      maxMembers: info.max_member_count,
      ownerId: info.owner_id,
    }
  },
})

/** 单个群成员信息：昵称/群名片/角色/等级/头衔/入群时间/禁言剩余 */
export const groupMemberTool = defineTool({
  name: 'group_member',
  description: '获取群内某成员信息：昵称、群名片、角色(成员/管理员/群主)、等级、头衔、入群时间。',
  category: 'query',
  parameters: param.object({
    userId: param.str('目标 QQ 号'),
    groupId: param.str('群号（可选，默认当前群）'),
  }, ['userId']),
  async execute(p, ctx) {
    const g = needGroup(ctx, p.groupId)
    if (g.error) return g
    if (typeof g.pickMember !== 'function') return { error: '协议端未提供 pickMember' }
    const m = g.pickMember(String(p.userId))
    const info = typeof m.getInfo === 'function' ? await m.getInfo() : m
    return {
      userId: info.user_id || p.userId,
      nickname: info.nickname || info.name,
      card: info.card || '',
      role: info.role || 'member',
      level: info.level ?? null,
      title: info.title || '',
      joinTime: info.join_time ? new Date(info.join_time * 1000).toLocaleString('zh-CN') : null,
      muteUntil: info.shut_up_time ? new Date(info.shut_up_time * 1000).toLocaleString('zh-CN') : null,
    }
  },
})

/** 群成员列表（分页，仅统计 + 样本；隐私敏感 → group_manage） */
export const groupMembersTool = defineTool({
  name: 'group_members',
  description: '获取群成员总数与分页列表（昵称/群名片/角色）。隐私敏感，需群管以上权限。',
  category: 'group_manage',
  parameters: param.object({
    groupId: param.str('群号（可选）'),
    offset: param.int('偏移量', { min: 0 }),
    size: param.int('每页数量（≤30，默认 20）', { min: 1 }),
  }),
  async execute(p, ctx) {
    const g = needGroup(ctx, p.groupId)
    if (g.error) return g
    let map
    if (typeof g.getMemberMap === 'function') map = await g.getMemberMap()
    else if (typeof g.getMemberArray === 'function') {
      const arr = await g.getMemberArray()
      map = new Map(arr.map((m) => [m.user_id, m]))
    } else return { error: '协议端未提供成员列表接口' }
    const all = [...(map.values?.() || [])]
    const offset = p.offset || 0
    const size = Math.min(30, p.size || 20)
    const page = all.slice(offset, offset + size).map((m) => ({
      userId: m.user_id, nickname: m.nickname, card: m.card || '', role: m.role || 'member',
    }))
    return { total: all.length, offset, size: page.length, members: page }
  },
})

/** 用户资料（好友/陌生人资料） */
export const userInfoTool = defineTool({
  name: 'user_info',
  description: '获取某 QQ 用户的公开资料（昵称等，依赖协议端支持）。',
  category: 'query',
  parameters: param.object({ userId: param.str('QQ 号') }, ['userId']),
  async execute(p, ctx) {
    const f = getFriend(ctx, p.userId)
    if (f && typeof f.getInfo === 'function') {
      const info = await f.getInfo()
      return { userId: info.user_id || p.userId, nickname: info.nickname || info.name }
    }
    const bot = ctx?.bot || null
    if (bot?.pickUser) {
      try { const info = await bot.pickUser(p.userId).getInfo?.(); if (info) return { userId: p.userId, nickname: info.nickname } } catch { /* noop */ }
    }
    return { userId: p.userId, nickname: null, note: '协议端不支持陌生人资料查询' }
  },
})

export const groupInfoTools = [groupInfoTool, groupMemberTool, groupMembersTool, userInfoTool]
