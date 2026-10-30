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

await test('命令前缀：只认 #agent*，#agents* 已移除', async () => {
  const o = inst()
  const regs = o.rule.map((r) => new RegExp(r.reg))
  const hit = (msg) => regs.some((re) => re.test(msg))
  ok(hit('#agent更新') && hit('#agent强制更新') && hit('#agent版本') && hit('#agent更新日志'), '#agent* 四个更新/版本命令可匹配')
  ok(!hit('#agents更新') && !hit('#agents版本') && !hit('#agents更新日志'), '旧 #agents* 不再匹配')
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

await test('overwriteFiles：从 git 报错里提取会被覆盖的本地改动文件', async () => {
  const o = inst()
  const err = "error: Your local changes to the following files would be overwritten by merge:\n\tapps/comfyui-draw.js\n\ttools/comfyui/index.js\nPlease commit your changes or stash them before you merge.\nAborting"
  eq(o.overwriteFiles('Updating a..b', err), ['apps/comfyui-draw.js', 'tools/comfyui/index.js'], '解析出文件列表')
  eq(o.overwriteFiles('', 'fatal: 别的错误'), [], '无关错误返回空数组')
})

await test('gitErr：本地改动会被覆盖时，给出文件清单 + 暂存指引 + 强更丢数据警告', async () => {
  const o = inst()
  const err = "error: Your local changes to the following files would be overwritten by merge:\n\tapps/comfyui-draw.js\nPlease commit your changes or stash them before you merge.\nAborting"
  await o.gitErr('Updating b41f4a6..0fd7c9a', err)
  const msg = o._replies.join('\n')
  ok(msg.includes('apps/comfyui-draw.js'), '列出会被覆盖的文件')
  ok(msg.includes('git stash push'), '给出保留改动的暂存指引')
  ok(msg.includes('永久丢失'), '警告强制更新会丢改动')
  ok(!/否则发送 #agent强制更新$/.test(msg.trim()), '不再无警告地引导强更')
})

await test('untrackedCollisions：只挑出「未跟踪 ∩ 目标新增」文件（2026-10-17 审计 high）', async () => {
  const o = inst()
  const calls = []
  o.exec = async (cmd) => {
    calls.push(cmd)
    if (cmd.includes('ls-files --others')) return { stdout: 'package-lock.json\ntools/qqmusic/index.js\ntools/qqmusic/util.js\n', error: null }
    if (cmd.includes('--diff-filter=A')) return { stdout: 'tools/qqmusic/index.js\ntools/qqmusic/util.js\napps/render.test.mjs\n', error: null }
    return { stdout: '', error: null }
  }
  const cols = await o.untrackedCollisions('origin/master')
  eq(cols, ['tools/qqmusic/index.js', 'tools/qqmusic/util.js'], '只报「未跟踪 ∩ 新增」交集（package-lock 不报）')
  ok(calls.length === 2 && calls[1].includes('--diff-filter=A HEAD origin/master'), '第二条命令带 HEAD 与 target')
})

await test('overwriteFiles：同时解析未跟踪文件冲突（stash 不带 -u 救不了）', async () => {
  const o = inst()
  const err = 'error: Untracked working tree files would be overwritten by merge:\n\ttools/qqmusic/util.js\nPlease move or remove them before you merge.\nAborting'
  eq(o.overwriteFiles('Updating a..b', err), ['tools/qqmusic/util.js'], '解析出未跟踪冲突文件')
})

await test('gitErr：未跟踪文件冲突时提示 -u 暂存 / clean（不再只教普通 stash）', async () => {
  const o = inst()
  const err = 'error: Untracked working tree files would be overwritten by merge:\n\ttools/qqmusic/util.js\nAborting'
  await o.gitErr('Updating a..b', err)
  const msg = o._replies.join('\n')
  ok(msg.includes('tools/qqmusic/util.js'), '列出冲突文件')
  ok(msg.includes('git stash push -u'), '提示带 -u 的暂存（未跟踪文件也能保住）')
  ok(msg.includes('git clean -n'), '给出 git clean 预览指引')
})

await test('backupUntracked：不存在的文件不产生备份目录（no-op）', async () => {
  const o = inst()
  const r = await o.backupUntracked(['data/temp/__not-exist-xyz.js'])
  eq(r, { dir: null, count: 0 }, '没有可备份文件时 dir=null / count=0')
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
