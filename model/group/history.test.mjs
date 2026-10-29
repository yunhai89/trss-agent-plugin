/**
 * get_chat_history 本地兜底回归（QQ 官方机器人没有历史 API 的场景）。
 * 运行：node model/group/history.test.mjs
 */
import { chatHistoryTool } from './history.js'
import { recordGroupMessage, resetGroupHistory } from './history-store.js'

let passed = 0, failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

const now = Date.now()
const ev = (id, text, nick) => ({
  isGroup: true,
  group_id: 'G1',
  message_id: id,
  user_id: 'u1',
  sender: { nickname: nick },
  time: Math.floor(now / 1000),
  message: [{ type: 'text', text }],
})
const ctx = { official: true, groupId: 'G1', e: { isGroup: true, group_id: 'G1', message_id: 'm4', user_id: 'u1' } }

resetGroupHistory()
recordGroupMessage(ev('m1', '第一条', '甲'))
recordGroupMessage(ev('m2', '第二条', '乙'))
recordGroupMessage(ev('m3', '第三条', '丙'))

const r = await chatHistoryTool.execute({ count: 10 }, ctx)
eq(r.count, 3, '无协议历史接口时返回本地缓存 3 条')
eq(r.source, 'local', '标记来源 local')
ok(/^甲: 第一条\n乙: 第二条\n丙: 第三条$/.test(r.history), '按时间正序、昵称+文本')

// 协议端返回空 → 仍回退本地
const r2 = await chatHistoryTool.execute({ count: 2 }, {
  ...ctx,
  e: { ...ctx.e, group: { getChatHistory: async () => [] } },
})
eq(r2.source, 'local', '协议端返回空数组时回退本地')
ok(r2.history.endsWith('乙: 第二条\n丙: 第三条'), '按 count 截取最近两条')

// 空缓存：官方机器人返回 note 而不是 error（平台限制，不应让模型重试）
resetGroupHistory()
const r3 = await chatHistoryTool.execute({ count: 10 }, ctx)
eq(r3.count, 0, '空缓存 count=0')
ok(/QQ 官方机器人没有历史消息 API/.test(r3.note || ''), '官方机器人给出平台限制说明')
ok(!r3.error, '不返回 error 触发无意义重试')

// 私聊仍明确报错
const r4 = await chatHistoryTool.execute({ count: 10 }, { e: { isGroup: false, user_id: 'u1' } })
ok(!!r4.error && /非群聊/.test(r4.error), '私聊保持明确错误')

resetGroupHistory()
console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
