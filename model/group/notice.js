/**
 * 群公告工具（内置）—— NapCat 原生动作 _send/_get/_del_group_notice。
 *
 * RBAC：发送/删除为群管写操作（group_manage，群管自动放行、否则需审批）；
 *      读取为 query（全员可读）。发送/删除标 interactive，确保顺序确认。
 * 经 toolkit.sendApi 走 e.bot.sendApi(action, params)。
 */

import { defineTool, param, groupIdOf, sendApi, botGroupRole } from '../toolkit/index.js'

function needGid(ctx, groupId) {
  const gid = groupIdOf(ctx, groupId)
  return gid || null
}

/** 机器人自身群管权限预检：返回可读错误或 null（查询失败不阻断，交给协议端最终判定） */
async function botRoleGuard(ctx, gid) {
  const role = await botGroupRole(ctx, gid)
  if (role && role !== 'admin' && role !== 'owner') {
    return `机器人账号在本群的角色是「${role}」，发送/删除群公告需要群管或群主权限——请先把机器人设为群管理员`
  }
  return null
}

/** send_group_notice：发送群公告（可选图片/置顶/需确认） */
export const sendGroupNoticeTool = defineTool({
  name: 'send_group_notice',
  description: '发送群公告（需机器人有群管权限）。可附图片、置顶、要求成员确认。慎用，会审批。',
  category: 'group_manage',
  meta: { summary: '发送群公告', interactive: true },
  parameters: param.object({
    content: param.str('公告正文'),
    image: param.str('公告配图（可选，图片路径/URL/base64）'),
    pinned: param.bool('是否置顶（可选，默认 false）'),
    confirmRequired: param.bool('是否要求成员确认阅读（可选，默认 false）'),
    groupId: param.str('群号（可选，默认当前群）'),
  }, ['content']),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    if (!gid) return { error: '当前非群聊且未指定 groupId' }
    const noPerm = await botRoleGuard(ctx, gid)
    if (noPerm) return { error: noPerm }
    const r = await sendApi(ctx, '_send_group_notice', {
      group_id: gid,
      content: String(p.content || ''),
      ...(p.image ? { image: String(p.image) } : {}),
      ...(p.pinned != null ? { pinned: p.pinned ? 1 : 0 } : {}),
      ...(p.confirmRequired != null ? { confirmRequired: p.confirmRequired ? 1 : 0 } : {}),
    })
    if (!r.ok) return { error: r.error }
    return { ok: true, groupId: gid, sent: true }
  },
})

/** get_group_notice：获取群公告列表 */
export const getGroupNoticeTool = defineTool({
  name: 'get_group_notice',
  description: '获取当前群的公告列表（标题/内容/发布者/图片）。只读。',
  category: 'query',
  meta: { summary: '查群公告', resultCap: 8000 },
  parameters: param.object({
    groupId: param.str('群号（可选，默认当前群）'),
  }),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    if (!gid) return { error: '当前非群聊且未指定 groupId' }
    const r = await sendApi(ctx, '_get_group_notice', { group_id: gid })
    if (!r.ok) return { error: r.error }
    const list = Array.isArray(r.data) ? r.data : []
    const notices = list.map((n) => ({
      noticeId: n.fid || n.notice_id || undefined,
      sender: n.sender_id || n.sender?.user_id || null,
      time: n.publish_time || n.time || null,
      text: typeof n.message === 'string' ? n.message : (Array.isArray(n.message) ? n.message.map((s) => s?.data?.text || '').join('') : n.text || ''),
    }))
    return { count: notices.length, notices }
  },
})

/** delete_group_notice：删除指定群公告 */
export const deleteGroupNoticeTool = defineTool({
  name: 'delete_group_notice',
  description: '删除指定群公告（需群管权限，会审批）。先用 get_group_notice 拿到 noticeId。',
  category: 'system',
  meta: { summary: '删除群公告', interactive: true },
  parameters: param.object({
    noticeId: param.str('公告 ID（从 get_group_notice 获取）'),
    groupId: param.str('群号（可选，默认当前群）'),
  }, ['noticeId']),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    if (!gid) return { error: '当前非群聊且未指定 groupId' }
    const noPerm = await botRoleGuard(ctx, gid)
    if (noPerm) return { error: noPerm }
    const r = await sendApi(ctx, '_del_group_notice', { group_id: gid, notice_id: String(p.noticeId) })
    if (!r.ok) return { error: r.error }
    return { ok: true, groupId: gid, noticeId: p.noticeId, deleted: true }
  },
})

export const groupNoticeTools = [sendGroupNoticeTool, getGroupNoticeTool, deleteGroupNoticeTool]
