/**
 * 回归：群聊最终回复默认引用触发消息（agent.reply.quote），避免人多时找不到回复对象；
 * 私聊不引用。走真实 apps/agent.js 的 _handleAgent 入口，只桩 Yunzai 基类/Config/LLM 传输层。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/agent-reply-quote.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-quote-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1'
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

const cfgMod = await import('./stubs/Config.js')
cfgMod.__setConfig({
  agent: {
    apiKey: 'sk-quote-test', model: 'test-model', stream: false, progress: false,
    reply: { mode: 'text', quote: true },
    devLog: { dir: path.join(TMP, 'devlog') },
  },
})

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

const { Chat, getRuntime } = await import('../../apps/agent.js')
const rt = await getRuntime()
rt.provider.chat = async () => ({ role: 'assistant', content: '引用测试', toolCalls: [], finishReason: 'stop', usage: null })

async function run(extra = {}) {
  const calls = []
  const evt = {
    user_id: '10001', self_id: '2721779039', msg: 'hi', message: [],
    sender: { card: '测试', nickname: '测试' },
    reply: async (...args) => { calls.push(args); return { retcode: 0 } },
    ...extra,
  }
  const bot = new Chat({})
  bot.e = evt
  await bot._handleAgent('hi')
  return calls
}

console.log('\n[群聊最终回复：引用触发消息]')
{
  const calls = await run({ isGroup: true, group_id: 'g1', message_id: 'm1' })
  ok(calls.some((a) => a[1] === true), '群聊最终回复 quote=true')
}

console.log('\n[私聊最终回复：不引用]')
{
  const calls = await run({ isGroup: false, message_id: 'm2' })
  ok(calls.every((a) => a[1] !== true), '私聊最终回复不引用')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed ? 1 : 0)
