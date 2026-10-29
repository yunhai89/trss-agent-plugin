/**
 * 群消息本地缓存离线回归。
 * 运行：node model/group/history-store.test.mjs
 */
import { recordGroupMessage, recentGroupMessages, resetGroupHistory, groupHistorySize } from './history-store.js'

let passed = 0, failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

const now = Date.now()
const ev = (id, text, extra = {}) => ({
  isGroup: true,
  group_id: 'G1',
  message_id: id,
  user_id: '1001',
  sender: { nickname: '甲' },
  time: Math.floor(now / 1000),
  message: [{ type: 'text', text }],
  ...extra,
})

resetGroupHistory()
ok(recordGroupMessage(ev('m1', '第一条')), '群消息入库')
ok(recordGroupMessage(ev('m2', '第二条')) === true, '第二条入库')
eq(groupHistorySize('G1'), 2, '缓存条数=2')

ok(recordGroupMessage(ev('m2', '重复')) === false, '同 message_id 去重')
eq(groupHistorySize('G1'), 2, '重复不入库')
ok(recordGroupMessage(ev('m3', '第二条', { group_id: 'G2' })), '不同群独立')
eq(groupHistorySize('G2'), 1, 'G2 独立计数')

ok(recordGroupMessage({ isGroup: false, group_id: 'G1', message_id: 'p1', message: [{ type: 'text', text: '私聊' }] }) === false, '私聊不入库')
ok(recordGroupMessage(ev('m4', '')) === false, '空文本不入库')

const rows = recentGroupMessages('G1', 10, { now })
eq(rows.map((m) => m.message[0].text), ['第一条', '第二条'], '按时间正序返回')
eq(rows[0].sender.nickname, '甲', '保留昵称')
eq(rows[0].user_id, '1001', '保留用户 ID')

// TTL：25 小时前的消息不返回
const oldNow = now
recordGroupMessage(ev('old', '旧消息', { time: Math.floor((oldNow - 25 * 3600 * 1000) / 1000) }), { now: oldNow })
eq(recentGroupMessages('G1', 10, { now: oldNow }).some((m) => m.message_id === 'old'), false, '超过 24h TTL 不返回')

// 容量：max=2 时只保留最近两条
resetGroupHistory('G3')
for (const [i, id] of ['a', 'b', 'c'].entries()) recordGroupMessage(ev(id, `第${i}条`, { group_id: 'G3' }), { max: 2, now })
eq(recentGroupMessages('G3', 10, { now }).map((m) => m.message_id), ['b', 'c'], '超过容量淘汰最旧')

resetGroupHistory()
eq(groupHistorySize('G1'), 0, 'reset 清空')

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
