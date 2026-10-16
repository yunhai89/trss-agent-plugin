/**
 * 离线回归 —— 更新日志以「合并转发聊天记录」发出（每条独立消息 + 标注稳定版/beta）。
 * 仅桩 Bot/插件基类，跑真实 apps/update.js。
 * 运行：node --import ./stress/e2e/hooks.mjs apps/update.test.mjs
 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { AgentsUpdate, readGitHead, readPkgVersion, diskChangedSinceLoad } from './update.js'

globalThis.logger = globalThis.logger || { mark() {}, info() {}, warn() {}, error() {} }

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

await test('readGitHead：普通 ref / packed-refs / detached / 非 git 目录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-head-'))
  fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/master\n')
  fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'master'), 'abcdef1234567890\n')
  eq(readGitHead(dir), 'abcdef1', '普通 ref 读取短 sha')

  fs.rmSync(path.join(dir, '.git', 'refs', 'heads', 'master'))
  fs.writeFileSync(path.join(dir, '.git', 'packed-refs'), '# pack-refs with: peeled\n1234567abcdef refs/heads/master\n')
  eq(readGitHead(dir), '1234567', 'ref 缺失时回退 packed-refs')

  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'deadbeefcafe\n')
  eq(readGitHead(dir), 'deadbee', 'detached HEAD 直接取 sha')

  eq(readGitHead(path.join(dir, 'nope')), null, '非 git 目录 → null')
  eq(readPkgVersion(dir), null, '无 package.json → null')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('diskChangedSinceLoad：磁盘≠进程 时要求重启，信息缺失不误报', async () => {
  eq(diskChangedSinceLoad({ diskHead: 'bbb2222', loadedHead: 'aaa1111', diskVersion: '1.2.4', loadedVersion: '1.2.3' }), 'head', '提交不同 → head')
  eq(diskChangedSinceLoad({ diskHead: 'aaa1111', loadedHead: 'aaa1111', diskVersion: '1.2.4', loadedVersion: '1.2.3' }), 'version', '提交相同但版本不同 → version')
  eq(diskChangedSinceLoad({ diskHead: 'aaa1111', loadedHead: 'aaa1111', diskVersion: '1.2.3', loadedVersion: '1.2.3' }), null, '完全一致 → 不需要重启')
  eq(diskChangedSinceLoad({ diskHead: null, loadedHead: null, diskVersion: null, loadedVersion: null }), null, '信息缺失 → 不误报')
  eq(diskChangedSinceLoad({ diskHead: 'bbb', loadedHead: 'bbb', diskVersion: '1.0.0', loadedVersion: '1.0.0' }), null, '短 sha 同值 → null')
})

function upToDateInst(headStub) {
  const o = inst()
  o.exec = async (cmd) => {
    if (cmd.includes('branch --show-current')) return { stdout: 'master' }
    if (cmd.includes('config branch.master.remote')) return { stdout: 'origin' }
    if (cmd.includes('rev-parse --short HEAD')) return { stdout: headStub }
    if (cmd.includes('git log -1')) return { stdout: '2026-10-16 21:00:00' }
    if (cmd.includes('git log')) return { stdout: '' }
    return { stdout: '' } // fetch / merge --ff-only 成功
  }
  return o
}

await test('runUpdate：git 已是最新但进程跑旧代码 → 触发重启并说明原因', async () => {
  const o = upToDateInst('aaaaaaa')
  o.e.msg = '#agents更新'
  await o.runUpdate()
  eq(o.isUp, true, '置 isUp 让 update() 调 restart()')
  ok(o._replies.some((r) => String(r).includes('正在重启')), '回复说明正在重启')
  ok(o._replies.some((r) => String(r).includes('当前进程加载的是')), '回复说明进程加载的提交')
})

await test('runUpdate：磁盘与进程一致 → 维持「已是最新」且不重启', async () => {
  const realHead = readGitHead(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'))
  if (!realHead) { console.log('  （跳过：当前目录不是 git 工作树）'); return }
  const o = upToDateInst(realHead)
  o.e.msg = '#agents更新'
  await o.runUpdate()
  ok(!o.isUp, '不置 isUp（无需重启）')
  ok(o._replies.some((r) => String(r).includes('已是最新')), '回复「已是最新」')
  ok(!o._replies.some((r) => String(r).includes('正在重启')), '不提示重启')
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
