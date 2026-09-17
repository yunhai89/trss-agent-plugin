/**
 * 回归：agent.chatPermission 必须真正约束群内 `#ai` 命令触发；
 * @机器人 与私聊不受限（保持向后兼容）。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/agent-trigger-permission.mjs
 * （或直接 node，文件自身会先 import hooks；apps/agent.js 保持真实源码）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-trigger-perm-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1'
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

const cfgMod = await import('./stubs/Config.js')
const baseCfg = () => ({
  agent: {
    trigger: 'both', triggerCommand: '#ai', chatPermission: 'master',
    providerId: '', modelId: '', // 故意不配 → _handleAgent 到 getRuntime 快速失败（回复 ⚠️），便于区分"已放行"
    devLog: { dir: TMP + '/devlog' },
  },
})

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

const { Chat } = await import('../../apps/agent.js')

function makeBot(overrides = {}) {
  const replies = []
  const evt = {
    user_id: '10001', group_id: '960179589', self_id: '2721779039',
    msg: '#ai 你好', message: [], isGroup: true,
    isMaster: false, sender: { role: 'member' }, member: {},
    reply: async (m) => { replies.push(String(m)); return { message_id: `r${replies.length}` } },
    ...overrides,
  }
  const bot = new Chat({})
  bot.e = evt
  return { bot, evt, replies }
}
const denied = (replies) => replies.some((r) => /权限/.test(r))
const allowed = (replies) => replies.some((r) => /⚠️/.test(r))
const isCmdDeniedReplied = (r) => r === true

console.log('\n[chatPermission=master：群内 #ai]')
cfgMod.__setConfig(baseCfg())
{
  const { bot, replies } = makeBot({ user_id: 'u11' })
  const r = await bot.onTrigger()
  ok(isCmdDeniedReplied(r) && denied(replies) && !allowed(replies), '普通成员 #ai → 拒绝并提示（不放行到 Agent）')
}
{
  const { bot, replies } = makeBot({ user_id: 'u12', sender: { role: 'admin' } })
  await bot.onTrigger()
  ok(denied(replies), '群管理员 #ai → 仍拒绝（需 master）')
}
{
  const { bot, replies } = makeBot({ user_id: 'u13', isMaster: true })
  await bot.onTrigger()
  ok(allowed(replies), '主人 #ai → 放行（进入 Agent，运行时报错 ⚠️）')
}

console.log('\n[chatPermission=master：@机器人 / 私聊不受限]')
{
  const { bot, replies } = makeBot({ user_id: 'u14', msg: '你好', atBot: true })
  await bot.onTrigger()
  ok(allowed(replies), '普通成员 @机器人 → 放行')
}
{
  const { bot, replies } = makeBot({ user_id: 'u15', msg: '#ai 你好', isGroup: false, group_id: null })
  await bot.onTrigger()
  ok(allowed(replies), '私聊 #ai → 放行（私聊始终可对话）')
}

console.log('\n[chatPermission=all：命令对所有人开放]')
cfgMod.__setConfig({ agent: { ...baseCfg().agent, chatPermission: 'all' } })
{
  const { bot, replies } = makeBot({ user_id: 'u16' })
  await bot.onTrigger()
  ok(allowed(replies), 'all 时普通成员 #ai → 放行')
}

console.log('\n[chatPermission=admin：管理员/群主可命令]')
cfgMod.__setConfig({ agent: { ...baseCfg().agent, chatPermission: 'admin' } })
{
  const { bot, replies } = makeBot({ user_id: 'u17', sender: { role: 'admin' } })
  await bot.onTrigger()
  ok(allowed(replies), 'admin 时群管理员 #ai → 放行')
}
{
  const { bot, replies } = makeBot({ user_id: 'u18' })
  await bot.onTrigger()
  ok(denied(replies), 'admin 时普通成员 #ai → 拒绝')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed ? 1 : 0)
