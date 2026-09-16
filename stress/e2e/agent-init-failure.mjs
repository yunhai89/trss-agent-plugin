/**
 * 回归：运行时装配失败必须「可见」——既给用户回复，也要落 run_error 终态。
 *
 * 背景（本次引用制改造后发现，属静默失败）：apps/agent.js 的 _handleAgent 在 getRuntime()
 * 抛错时只是「给首个消息回一条 ⚠️ 然后 return false」，既没有 terminal('run_error')（该 traceId
 * 永久悬挂，scripts/check-trace-consistency.mjs 看不到），又把消息下沉给其它插件——用户看到的是
 * 「命令没人认领」而不是失败原因。基础模型改引用制后这条分支更容易被命中（providerId/modelId
 * 没选或厂商 Key 没填），所以在这里钉死。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/agent-init-failure.mjs
 * （hooks 把 Yunzai 基类 / utils/Config 换成桩，apps/agent.js 保持真实源码）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-agent-init-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1' // hooks 例外：保留真实 apps/agent.js（本用例测的就是它的失败分支）
// 先装钩子再 import apps（apps/agent.js 在模块顶层就会异步跑 getRuntime）
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

const cfgMod = await import('./stubs/Config.js')
// 故意不给 providerId/modelId/apiKey：buildRuntime 第一步就会 throw
cfgMod.__setConfig({ agent: { devLog: { dir: TMP + '/devlog' } } })

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

const { Chat } = await import('../../apps/agent.js')

const replies = []
const evt = {
  user_id: '10001',
  group_id: '960179589',
  self_id: '2721779039',
  msg: '你好',
  message: [],
  reply: async (m) => { replies.push(String(m)); return { message_id: `r${replies.length}` } },
}
const bot = new Chat({})
bot.e = evt

console.log('\n[装配失败：#未选厂商/未填 Key]')
const r1 = await bot._handleAgent('你好')
ok(r1 === true, `返回 true（已受理，不再下沉给其它插件；实际 ${JSON.stringify(r1)}）`)
ok(replies.length === 1, `首次触发给了一条提示（实际 ${replies.length} 条）`)
ok(String(replies[0] || '').includes('⚠️'), '提示文案带失败标记 ⚠️')
ok(String(replies[0] || '').includes('providerId') || String(replies[0] || '').includes('modelId'), '提示指向真正要修的字段（providerId/modelId）')

// 同一用户第二条：不刷屏，但仍必须 return true（不能假装没收到）
const r2 = await bot._handleAgent('你好吗')
ok(r2 === true, `第二条仍返回 true（实际 ${JSON.stringify(r2)}）`)
ok(replies.length === 1, `同一用户不重复刷屏（实际回复 ${replies.length} 条）`)

// 终态：devLog 里必须有一条 run_error（否则 trace 一致性检查认为任务悬挂）
const logPath = path.join(TMP, 'devlog', 'dev-fallback.log')
ok(fs.existsSync(logPath), `产出 dev 日志：${path.relative(TMP, logPath)}`)
const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
const events = text.split('\n}\n').filter(Boolean).map((s) => { try { return JSON.parse(s.endsWith('}') ? s : s + '}') } catch { return null } }).filter(Boolean)
const runErrors = events.filter((e) => e.event === 'run_error')
ok(runErrors.length >= 1, `装配失败落到 run_error 终态（实际 ${runErrors.length} 条）`)
ok(runErrors.some((e) => e.at === 'getRuntime'), 'run_error 标注了失败位置 at=getRuntime')
ok(runErrors.every((e) => e.traceId), 'run_error 带 traceId（可与 trigger 对齐做一致性检查）')

// 一致性检查器必须认可这批事件（无悬挂 trace）
const { checkConsistency } = await import(pathToFileURL(path.join(import.meta.dirname, '../../scripts/check-trace-consistency.mjs')).href)
const { problems } = checkConsistency(events)
ok(problems.filter((p) => /无终态|无 trigger/.test(p)).length === 0, `无悬挂 trace（检查器问题：${JSON.stringify(problems.slice(0, 2))}）`)

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed ? 1 : 0)
