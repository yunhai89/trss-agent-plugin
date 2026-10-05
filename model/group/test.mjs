/**
 * 群工具离线自检 —— mock pickGroup/pickFriend，覆盖信息读取 + 管理 + 安全。
 * 运行：node model/group/test.mjs
 */
import {
  groupInfoTool, groupMemberTool, groupMembersTool, userInfoTool,
  groupKickTool, groupMuteTool, groupSetCardTool, groupSetNameTool,
} from './index.js'
import { sendForwardMsgTool, normalizeForwardNodes } from './forward.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

function mockCtx(group, e = {}) {
  return { e: { group_id: 123, self_id: '9999', user_id: '10000', ...e, group }, bot: null, fetcher: null }
}

// ---------- 1. group_info ----------
await test('group_info：读取群信息', async () => {
  const group = { getInfo: async () => ({ group_id: 123, group_name: '测试群', member_count: 50, max_member_count: 200, owner_id: '1' }) }
  const r = await groupInfoTool.execute({}, mockCtx(group))
  eq(r.name, '测试群', '群名')
  eq(r.memberCount, 50, '人数')
  eq(r.ownerId, '1', '群主')
})

await test('group_info：非群聊报错', async () => {
  const r = await groupInfoTool.execute({}, mockCtx(null))
  ok(r.error, '无 group → 报错')
})

// ---------- 2. group_member ----------
await test('group_member：读取成员信息', async () => {
  const group = { pickMember: (uid) => ({ getInfo: async () => ({ user_id: uid, nickname: '小红', card: '红', role: 'admin', level: 7, title: '大佬', join_time: 1700000000 }) }) }
  const r = await groupMemberTool.execute({ userId: '200' }, mockCtx(group))
  eq(r.nickname, '小红', '昵称')
  eq(r.role, 'admin', '角色')
  eq(r.title, '大佬', '头衔')
  ok(r.joinTime, '入群时间')
})

// ---------- 3. group_members 分页 ----------
await test('group_members：分页 + 总数', async () => {
  const members = Array.from({ length: 55 }, (_, i) => ({ user_id: 1000 + i, nickname: `N${i}`, card: '', role: 'member' }))
  const group = { getMemberMap: async () => new Map(members.map((m) => [m.user_id, m])) }
  const r = await groupMembersTool.execute({ offset: 0, size: 10 }, mockCtx(group))
  eq(r.total, 55, '总数 55')
  eq(r.size, 10, '本页 10')
  eq(r.members[0].userId, 1000, '首项')

  const r2 = await groupMembersTool.execute({ offset: 50, size: 20 }, mockCtx(group))
  eq(r2.members.length, 5, '末页 5 项')
})

// ---------- 4. user_info ----------
await test('user_info：好友资料', async () => {
  const ctx = { e: { user_id: '10000' }, bot: { pickFriend: (uid) => ({ getInfo: async () => ({ user_id: uid, nickname: '小明' }) }) } }
  const r = await userInfoTool.execute({ userId: '300' }, ctx)
  eq(r.nickname, '小明', '昵称')
})

// ---------- 5. 安全：禁止对自身/操作者 ----------
await test('group_kick：安全检查（自身/操作者）', async () => {
  const group = { kickMember: async (uid) => (calls.push(uid), null) }
  const calls = []
  const ctx = mockCtx(group)
  const r1 = await groupKickTool.execute({ userId: '9999' }, ctx) // self
  ok(r1.error && r1.error.includes('自身'), '禁踢 bot 自身')
  const r2 = await groupKickTool.execute({ userId: '10000' }, ctx) // operator
  ok(r2.error && r2.error.includes('自己'), '禁踢操作者')
  eq(calls.length, 0, '未实际调用 kickMember')

  const r3 = await groupKickTool.execute({ userId: '555', rejectAddRequest: true }, ctx)
  eq(r3.kicked, '555', '正常踢出')
})

// ---------- 6. group_mute 时长上限 ----------
await test('group_mute：禁言秒数封顶 30 天', async () => {
  let got = null
  const group = { muteMember: async (uid, dur) => (got = dur, null) }
  const ctx = mockCtx(group)
  const r = await groupMuteTool.execute({ userId: '555', duration: 999999999 }, ctx)
  eq(r.duration, 2592000, '封顶 2592000')
  eq(got, 2592000, '实际调用 2592000')

  const r2 = await groupMuteTool.execute({ userId: '555', duration: 0 }, ctx)
  eq(r2.duration, 0, '0 = 解除')
})

// ---------- 7. group_set_card ----------
await test('group_set_card：设置群名片', async () => {
  let got = null
  const group = { setCard: async (uid, card) => (got = { uid, card }, null) }
  const r = await groupSetCardTool.execute({ userId: '555', card: '新名片' }, mockCtx(group))
  eq(r.card, '新名片', '返回名片')
  eq(got.uid, '555', '调 setCard uid')
  eq(got.card, '新名片', '调 setCard card')
})

// ---------- 8. group_set_name ----------
await test('group_set_name：改群名', async () => {
  let got = null
  const group = { setName: async (name) => (got = name, null) }
  const r = await groupSetNameTool.execute({ name: '新群名' }, mockCtx(group))
  eq(r.name, '新群名', '返回群名')
  eq(got, '新群名', '调 setName')
})

// ---------- 9. send_forward_msg：节点归一为 {type:'node',data} ----------
await test('normalizeForwardNodes：裸节点包成 node，原生 node 保留', async () => {
  const out = normalizeForwardNodes([
    { uin: '1', name: 'A', content: 'hi' },
    { id: '123' },
    { type: 'node', data: { content: 'x', user_id: '2' } },
    { uin: '3', name: 'C', content: [{ type: 'image', data: { file: 'http://x/a.jpg' } }] },
  ])
  eq(out[0], { type: 'node', data: { content: 'hi', user_id: '1', nickname: 'A' } }, '裸节点包 node')
  eq(out[1], { type: 'node', data: { id: '123' } }, 'id 引用节点')
  eq(out[2], { type: 'node', data: { content: 'x', user_id: '2' } }, '原生 node 保留')
  eq(out[3].data.content[0], { type: 'image', data: { file: 'http://x/a.jpg' } }, '段已规范')
})

await test('send_forward_msg：发出的是 type=node（否则 NapCat 报未知的消息类型）', async () => {
  let captured = null
  const ctx = {
    e: { group_id: 123 },
    bot: { async sendApi(action, params) { captured = { action, params }; return { status: 'ok', data: { message_id: 7 } } } },
  }
  const r = await sendForwardMsgTool.execute({ messages: [{ uin: '1', name: 'A', content: 'hi' }] }, ctx)
  eq(r.ok, true, '返回 ok')
  eq(captured.action, 'send_group_forward_msg', '群转发动作')
  eq(captured.params.messages[0].type, 'node', '节点 type=node')
  eq(captured.params.messages[0].data.content, 'hi', '内容在 data.content')
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
