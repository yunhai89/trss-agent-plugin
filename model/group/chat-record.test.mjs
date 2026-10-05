/**
 * 合并聊天记录解析/分析离线回归（NapCat 节点形状 + 嵌套 + 统计 + 截断 + 自动定位）。
 * 运行：node model/group/chat-record.test.mjs
 */
import { segToText, nodeParts, flattenForwardNodes, analyzeMessages, formatTranscript, resolveForwardId } from './chat-record.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }

// ── NapCat 真实节点形状：{type:'node',data:{user_id,nickname,message:[段]}} ──
const napcatNodes = [
  { type: 'node', data: { user_id: '1001', nickname: '小明', time: 1700000000, message: [{ type: 'text', data: { text: '你好' } }, { type: 'image', data: {} }] } },
  { type: 'node', data: { user_id: '1002', nickname: '小红', time: 1700000060, message: [{ type: 'text', data: { text: '在吗 https://a.com' } }] } },
]
const msgs = flattenForwardNodes(napcatNodes)
eq(msgs.length, 2, 'NapCat 节点形状 → 2 条')
eq(msgs[0].nick, '小明', '昵称取 data.nickname')
eq(msgs[0].text, '你好[图片]', '文本+图片占位')
eq(msgs[1].uid, '1002', 'uid 取 data.user_id')

// ── 扁平兼容形状 {user_id,nickname,content} ──
const flat = flattenForwardNodes([{ user_id: '7', nickname: 'A', content: 'hi' }])
eq(flat[0].text, 'hi', '扁平形状兼容')

// ── 嵌套转发 ──
const nested = [
  { type: 'node', data: { user_id: '1', nickname: 'X', message: [{ type: 'text', data: { text: '外层' } }, { type: 'node', data: { user_id: '2', nickname: 'Y', message: [{ type: 'text', data: { text: '内层' } }] } }] } },
]
const nm = flattenForwardNodes(nested)
ok(nm.some((m) => m.text === '外层'), '嵌套：外层保留')
ok(nm.some((m) => m.text === '内层'), '嵌套：内层展开')

// ── 统计 ──
const stats = analyzeMessages(msgs)
eq(stats.total, 2, '总条数')
eq(stats.senders[0].name, '小明', '发言排行')
eq(stats.links, 1, '链接计数')
ok(stats.spanText && stats.spanText.includes('~'), '时间跨度')

// ── 转录截断 ──
const big = Array.from({ length: 500 }, (_, i) => ({ nick: 'U', time: 1700000000 + i, text: `消息${i} ${'x'.repeat(50)}` }))
const t = formatTranscript(big, { maxChars: 2000 })
ok(t.truncated && t.text.includes('省略'), '超长截断（保留头尾）')
eq(t.total, 500, '总数保留')

// ── 自动定位转发卡片 id ──
eq(resolveForwardId({ e: { message: [{ type: 'forward', id: 'RESID123' }] } }), 'RESID123', 'forward 段取 id')
eq(resolveForwardId({ e: { message: [{ type: 'json', data: '{"meta":{"detail":{"resid":"R9"}}}' }] } }), 'R9', 'json 卡片取 m_resid')
eq(resolveForwardId({ e: {}, quoted: { forwardResid: 'Q7' } }), 'Q7', '引用消息里的卡片')
eq(resolveForwardId({ e: {} }), null, '无卡片 → null')
eq(resolveForwardId({ e: {} }, { messageId: 'M1' }), 'M1', '显式 messageId 优先')

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
