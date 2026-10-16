/**
 * 群操作「目标群归属」离线回归（防跨群越权）。
 *
 * 背景：group_kick / group_mute / 群文件 / 群公告 / 合并转发 / AI 语音等工具都接受可选
 * `groupId` 参数，而 groupIdOf() 直接采用该参数、policy 只看「当前群」的群管身份 →
 * 本群管理员可以借参数对别的群踢人/禁言/改名/删文件，普通成员也能把消息投到别的群。
 * 修法：groupScopeError() 强制「在群里调用时目标群必须等于当前会话群」，私聊放行
 * （那些类别本就只对主人开放）。本文件锁住这个不变量。
 *
 * 运行：node model/group/scope.test.mjs
 */
import { groupScopeError } from '../toolkit/define.js'
import { groupKickTool, groupMuteTool } from './manage.js'
import { listGroupFolderTool, transferGroupFileTool } from './files.js'
import { sendGroupAiRecordTool } from './ai.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }

// ── groupScopeError 单元 ──
const inGroup111 = { e: { group_id: 111, user_id: 9001, self_id: 1000 }, isGroup: true, role: 'admin' }
ok(groupScopeError(inGroup111, 111) === null, '同群（数字/数字）通过')
ok(groupScopeError(inGroup111, '111') === null, '同群（数字/字符串）通过')
ok(groupScopeError(inGroup111, undefined) === null, '未指定群号 → 用当前群，通过')
ok(typeof groupScopeError(inGroup111, 999) === 'string', '跨群（999）被拒')
ok(groupScopeError(inGroup111, 999).includes('999') && groupScopeError(inGroup111, 999).includes('111'), '错误信息含目标群与当前群')
ok(groupScopeError({ e: { user_id: 9001 } }, 999) === null, '私聊（无群上下文）放行——交给 RBAC 判定')
ok(groupScopeError({}, 999) === null, '无 e 上下文不误报')

// ── 工具层：跨群调用必须无副作用 ──
function mkCtx(gid) {
  const calls = []
  const group = {
    kickMember: async (uid, reject) => { calls.push(['kickMember', gid, uid, !!reject]) },
    muteMember: async (uid, dur) => { calls.push(['muteMember', gid, uid, dur]) },
    getFileList: async () => { calls.push(['getFileList', gid]); return { files: [], folders: [] } },
  }
  // sendApi 桩：记录协议端调用（group_file 类工具走 sendApi 而非 group 对象方法）
  const bot = { sendApi: async (action, params) => { calls.push(['sendApi', action, params?.group_id]); return { status: 'ok', retcode: 0, data: { files: [], folders: [] } } } }
  return { ctx: { bot, e: { group_id: gid, user_id: 9001, self_id: 1000, group }, isGroup: true, role: 'admin', isGroupAdmin: true, isMaster: false }, calls }
}

const a = mkCtx(111)
const kickCross = await groupKickTool.execute({ userId: '30003', groupId: '999' }, a.ctx)
ok(kickCross?.error && String(kickCross.error).includes('999'), 'group_kick 跨群 → 返回错误')
eq(a.calls.length, 0, 'group_kick 跨群 → 协议端零调用（无副作用）')

const kickSame = await groupKickTool.execute({ userId: '30003' }, a.ctx)
eq(kickSame, { kicked: '30003' }, 'group_kick 本群（不传 groupId）正常执行')
eq(a.calls, [['kickMember', 111, '30003', false]], '本群踢人确实打到协议端')

const b = mkCtx(111)
const muteCross = await groupMuteTool.execute({ userId: '30003', duration: 60, groupId: 999 }, b.ctx)
ok(muteCross?.error, 'group_mute 跨群 → 返回错误')
eq(b.calls.length, 0, 'group_mute 跨群 → 零调用')

const c = mkCtx(111)
const listCross = await listGroupFolderTool.execute({ groupId: '999' }, c.ctx)
ok(listCross?.error, '群文件列举跨群 → 返回错误')
eq(c.calls.length, 0, '群文件列举跨群 → 零调用')

const c2 = mkCtx(111)
const listSame = await listGroupFolderTool.execute({}, c2.ctx)
eq(listSame?.groupId, '111', '群文件列举本群正常，回传当前群号')
eq(c2.calls, [['sendApi', 'get_group_root_files', '111']], '本群列举打到协议端且带当前群号')

// ── 私聊：允许显式群号（这些工具类别只对主人开放） ──
const d = mkCtx(undefined)
d.ctx.e = { user_id: 9001, self_id: 1000 }
const dm = await groupMuteTool.execute({ userId: '30003', duration: 60, groupId: 999 }, d.ctx)
ok(!dm?.error || !String(dm.error).includes('不是当前会话群'), '私聊指定群号不被归属校验拦截')

// ── 修 2026-10-17 审计：send_group_ai_record 漏判 needGid 的 {error} 返回值 ──
// 原实现写 `if (!gid)`，而错误对象 `{error:'…'}` 为真值 → 被当 group_id 透传，跨群守卫静默失效。
const e1 = mkCtx(111)
const aiCross = await sendGroupAiRecordTool.execute({ groupId: '999', text: '你好', character: 'c1' }, e1.ctx)
ok(aiCross?.error && String(aiCross.error).includes('999'), 'send_group_ai_record 跨群 → 返回错误（非假成功）')
eq(e1.calls.length, 0, 'send_group_ai_record 跨群 → 协议端零调用（错误对象不再被当群号）')

// ── 修 2026-10-17 审计：transfer_group_file 的 targetGroupId 原先完全不校验 ──
// group_manage 对群管自动放行 → 任意群管可把本群文件写进任意其它群。现：目标须纯数字；跨群仅主人。
function mkTransferCtx(gid, { isMaster = false } = {}) {
  const calls = []
  const bot = {
    sendApi: async (action, params) => {
      calls.push([action, params])
      return { status: 'ok', retcode: 0, data: { files: [{ file_id: 'f1', file_name: '内部资料.zip' }], folders: [] } }
    },
  }
  return { ctx: { bot, e: { group_id: gid, user_id: 9001, self_id: 1000 }, isGroup: true, role: 'admin', isGroupAdmin: true, isMaster }, calls }
}
const transfers = (r) => r.calls.filter((x) => x[0] === 'trans_group_file')

const t1 = mkTransferCtx(111)
const tCross = await transferGroupFileTool.execute({ fileId: 'f1', targetGroupId: '999' }, t1.ctx)
ok(tCross?.error && String(tCross.error).includes('主人'), '非主人跨群转移 → 拒绝')
eq(transfers(t1).length, 0, '非主人跨群转移 → 零 trans_group_file 调用')

const t2 = mkTransferCtx(111, { isMaster: true })
const tOk = await transferGroupFileTool.execute({ fileId: 'f1', targetGroupId: '999' }, t2.ctx)
eq(tOk?.toGroup, '999', '主人跨群转移 → 目标群原样回传')
eq(transfers(t2).map((x) => x[1]?.target_group_id), ['999'], '主人跨群转移 → 参数带目标群 999')

const t3 = mkTransferCtx(111, { isMaster: true })
const tBad = await transferGroupFileTool.execute({ fileId: 'f1', targetGroupId: 'not-a-gid' }, t3.ctx)
ok(tBad?.error && String(tBad.error).includes('非法'), '目标群号非数字 → 拒绝')
eq(transfers(t3).length, 0, '目标群号非法 → 零调用')

const t4 = mkTransferCtx(111)
const tSame = await transferGroupFileTool.execute({ fileId: 'f1', targetGroupId: '111' }, t4.ctx)
eq(tSame?.transferred, true, '非主人同群转移（target=当前群）→ 允许')
eq(transfers(t4).map((x) => x[1]?.target_group_id), ['111'], '同群转移参数正确')

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
process.exit(failed ? 1 : 0)
