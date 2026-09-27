/**
 * 回归 —— 流式发送结算与跨分片标记防泄漏（审计 B5/B6），走真实 apps/agent.js 的
 * Chat._handleAgent 入口（E2E_REAL_AGENT=1，仅桩 Yunzai 基类/Config/getRuntime 之外的
 * LLM 传输层：用本地 provider 桩替换网络调用）。
 *
 * 不变量：
 *  - 分片发送失败/未决不得被计为成功；最终正文不得被跳过（应补发）；
 *  - 全部分片成功且流式全文=正文时不重复整段发送；
 *  - [sticker:x] 标记被拆进多个分片时不得字面外发。
 *
 * 运行：node stress/e2e/stream-send-accounting.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-stream-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1'
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

const cfgMod = await import('./stubs/Config.js')
cfgMod.__setConfig({
  agent: {
    apiKey: 'sk-stream-test', model: 'test-model', stream: true, progress: false,
    reply: { mode: 'text' },
    devLog: { dir: path.join(TMP, 'devlog') },
  },
})

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

const { Chat } = await import('../../apps/agent.js')
const { getRuntime } = await import('../../apps/agent.js')

// 本地 LLM 桩：分片由 CHUNKS 控制，最终正文 = 拼接结果
const LLM = { chunks: [], replyText: null, calls: 0 }
function installProvider() {
  return getRuntime().then((rt) => {
    rt.provider.chat = async (opts) => {
      LLM.calls++
      const text = LLM.replyText != null ? LLM.replyText : LLM.chunks.join('')
      if (opts.stream || opts.onDelta) {
        for (const c of LLM.chunks) { try { opts.onDelta?.(c) } catch { /* noop */ } }
      }
      return { role: 'assistant', content: text, toolCalls: [], finishReason: 'stop', usage: null }
    }
    return rt
  })
}

function makeEvent({ replyImpl }) {
  const sent = []
  const evt = {
    user_id: '10001',
    self_id: '2721779039',
    msg: 'hi',
    message: [],
    reply: async (...args) => { sent.push(args[0]); return replyImpl(args[0]) },
  }
  return { evt, sent }
}

function readTerminal() {
  const dir = path.join(TMP, 'devlog')
  if (!fs.existsSync(dir)) return []
  const events = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.log')) continue
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    for (const s of text.split('\n}\n')) {
      if (!s) continue
      try { events.push(JSON.parse(s.endsWith('}') ? s : s + '}')) } catch { /* 跳过坏帧 */ }
    }
  }
  return events
}

const rt = await installProvider()

console.log('\n[B5 全部分片发送失败：不得计成功，最终正文必须补发]')
{
  LLM.chunks = ['这是完整', '的回复正文内容']
  LLM.replyText = '这是完整的回复正文内容'
  LLM.calls = 0
  const { evt, sent } = makeEvent({ replyImpl: () => { throw new Error('adapter rejected') } })
  const bot = new Chat({})
  bot.e = evt
  await bot._handleAgent('hi')
  const terminal = readTerminal()
  ok(terminal.some((e) => e.event === 'reply_failed'), '终态为 reply_failed（不伪装成功）')
  // 全部分片失败后，必须尝试补发整段正文（不能因 sentAny 误判而跳过）
  const fullBodySent = sent.some((m) => {
    const s = typeof m === 'string' ? m : (Array.isArray(m) ? m.map((x) => x?.data?.text ?? x?.text ?? '').join('') : '')
    return s.includes('这是完整的回复正文内容')
  })
  ok(fullBodySent, '失败后补发整段正文（正文未被跳过）')
}

console.log('\n[B5 全部分片成功：流式全文=正文，不重复整段发送]')
{
  LLM.chunks = ['这是完整', '的回复正文内容']
  LLM.replyText = '这是完整的回复正文内容'
  const { evt, sent } = makeEvent({ replyImpl: () => ({ retcode: 0 }) })
  const bot = new Chat({})
  bot.e = evt
  await bot._handleAgent('hi')
  const terminal = readTerminal()
  ok(terminal.some((e) => e.event === 'reply_sent'), '终态为 reply_sent')
  const joined = sent.map((m) => (typeof m === 'string' ? m : '')).join('')
  const fullCount = sent.filter((m) => typeof m === 'string' && m === '这是完整的回复正文内容').length
  ok(joined.includes('这是完整的回复正文内容'), '内容已送达')
  ok(fullCount <= 1, `整段正文不重复发送（实际 ${fullCount} 次）`)
}

console.log('\n[B5 首片成功后失败：不得标记完整送达，剩余部分补发]')
{
  LLM.chunks = ['前半段内容', '后半段内容']
  LLM.replyText = '前半段内容后半段内容'
  let n = 0
  const { evt, sent } = makeEvent({ replyImpl: () => { n++; return n === 1 ? { retcode: 0 } : (() => { throw new Error('second chunk failed') })() } })
  const bot = new Chat({})
  bot.e = evt
  await bot._handleAgent('hi')
  const terminal = readTerminal()
  ok(terminal.some((e) => e.event === 'reply_failed'), '存在失败分片 → reply_failed')
  const joined = sent.map((m) => (typeof m === 'string' ? m : '')).join('')
  ok(joined.includes('后半段内容'), '失败分片对应的剩余正文被补发（不丢片）')
}

console.log('\n[B6 标记跨分片：不得字面外发 [sticker:x]]')
{
  LLM.chunks = ['hello [sti', 'cker:happy] world']
  LLM.replyText = 'hello [sticker:happy] world'
  const { evt, sent } = makeEvent({ replyImpl: () => ({ retcode: 0 }) })
  const bot = new Chat({})
  bot.e = evt
  await bot._handleAgent('hi')
  const joined = sent.map((m) => (typeof m === 'string' ? m : '')).join('')
  ok(!joined.includes('[sticker'), '跨分片标记未字面外发')
  ok(joined.includes('hello') && joined.includes('world'), '正文其余内容保留')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed ? 1 : 0)
