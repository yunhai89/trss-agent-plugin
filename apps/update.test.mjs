/**
 * 离线回归 —— 更新日志以「合并转发聊天记录」发出（每条独立消息 + 标注稳定版/beta）。
 * 仅桩 Bot/插件基类，跑真实 apps/update.js。
 * 运行：node --import ./stress/e2e/hooks.mjs apps/update.test.mjs
 */
import { AgentsUpdate } from './update.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 4).join('\n')) } }

function inst() {
  const replies = []
  const o = new AgentsUpdate()
  o.e = { isMaster: true, isGroup: false, self_id: '123', group: null, friend: null, bot: null, msg: '' }
  o.reply = async (msg) => { replies.push(msg) }
  o._replies = replies
  return o
}

await test('versionLabel：master=稳定版 / beta=beta 版 / 其他=分支名', async () => {
  const o = inst()
  eq(o.versionLabel('master'), '稳定版', 'master → 稳定版')
  eq(o.versionLabel('beta'), 'beta 版', 'beta → beta 版')
  eq(o.versionLabel('dev'), '分支 dev', '其他 → 分支名')
  eq(o.versionLabel(''), '未知版本', '空 → 未知版本')
})

await test('sendLogForward：每条日志独立节点 + 卡片/昵称标注版本', async () => {
  const o = inst()
  let captured = null
  o.e.bot = { makeForwardMsg: async (nodes, opts) => { captured = { nodes, opts }; return { type: 'forward' } } }
  await o.sendLogForward(['feat: 甲', 'fix: 乙'], { branch: 'beta', after: 'abc123' })
  ok(captured && Array.isArray(captured.nodes) && captured.nodes.length === 3, '头节点 + 2 条日志 = 3 节点')
  ok(captured.nodes[0].message.includes('beta'), '头节点标注 beta')
  ok(captured.nodes[0].message.includes('abc123'), '头节点含提交号')
  eq([captured.nodes[1].message, captured.nodes[2].message], ['feat: 甲', 'fix: 乙'], '每条日志独立一条消息')
  ok(captured.nodes.every((n) => String(n.nickname).includes('beta')), '节点昵称含版本类型')
  ok(captured.opts && captured.opts.title && captured.opts.title.includes('beta'), 'forward title 含版本类型')
  ok(o._replies.length === 1, '只发出一次转发消息')
})

await test('sendLogForward：无转发能力降级为文本且含版本标签', async () => {
  const o = inst()
  o.e.group = null; o.e.friend = null; o.e.bot = null
  await o.sendLogForward(['feat: x'], { branch: 'master' })
  ok(typeof o._replies[0] === 'string', '降级为文本')
  ok(o._replies[0].includes('稳定版'), '文本头含版本标签')
  ok(o._replies[0].includes('feat: x'), '文本含日志')
})

await test('sendLogForward：带 title 抛错时退回无 title 调用', async () => {
  const o = inst()
  const calls = []
  o.e.bot = { makeForwardMsg: async (nodes, opts) => { calls.push(!!opts); if (opts) throw new Error('no opts'); return { type: 'forward' } } }
  await o.sendLogForward(['a'], { branch: 'master' })
  eq(calls, [true, false], '先带 title，失败后无 title 重试')
  ok(o._replies.length === 1, '最终发出转发')
})

await test('getLogEntries：解析提交 / 遇 oldCommitId 停止 / 跳过 Merge', async () => {
  const o = inst()
  o.oldCommitId = 'b'
  o.exec = async () => ({ stdout: 'c||c提交\na||a提交\nb||old提交\nz||Merge branch x' })
  const entries = await o.getLogEntries()
  eq(entries, ['c提交', 'a提交'], '取 old 之前、跳过 Merge')
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
