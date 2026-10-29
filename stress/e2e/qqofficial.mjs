/**
 * E2E：QQ 官方机器人适配（markdown 直发 / keyboard 卡片 / /uid / /groupid / 主人兜底 / scope 目录安全）。
 *
 * 真跑 apps/agent.js 的 _handleAgent 与命令方法，只桩 Yunzai 基类 / Config / LLM 传输层。
 * 覆盖：
 *  ① 官方适配器（adapter_id=QQBot）下最终回复走 segment.markdown（不再渲染图片），
 *     且官方模式下默认不发「思考中…」；
 *  ② markdown 被平台拒绝（适配器返回 {error:[...]}）时自动降级纯文本；
 *  ③ send_keyboard 工具排队的卡片在最终回复后以 markdown+button 段发出；
 *  ④ /uid、/groupid 输出可直接粘贴的完整/去前缀 ID；
 *  ⑤ 官方 openid 主人：agent.masters 命中后主人指令可用（masterGate）；
 *  ⑥ scopeId 目录安全（含 : 的官方 ID 不会产生非法目录名）。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/qqofficial.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-qqofficial-${process.pid}-`))
process.env.E2E_TMP = TMP
process.env.E2E_REAL_AGENT = '1'
await import(pathToFileURL(path.join(import.meta.dirname, 'hooks.mjs')).href)

// —— 复刻 TRSS-Yunzai 的 segment（含 markdown/button/at） ——
const segCalls = []
globalThis.segment = {
  at: (qq) => ({ type: 'at', qq }),
  image: (file) => ({ type: 'image', file }),
  markdown: (data) => { segCalls.push(['markdown', data]); return { type: 'markdown', data } },
  button: (...data) => { segCalls.push(['button', data]); return { type: 'button', data } },
  reply: (id) => ({ type: 'reply', id }),
}

const SELF = '1024'
const cfgMod = await import('./stubs/Config.js')
cfgMod.__setConfig({
  agent: {
    apiKey: 'sk-qqofficial-test', model: 'test-model', stream: false, progress: true,
    reply: { mode: 'image', quote: true, atSender: true, narrator: false },
    qqOfficial: { markdown: { enable: true, maxChars: 3500 }, keyboard: { enable: true }, progress: false, narrate: false },
    masters: [`${SELF}:U_MASTER`],
    devLog: { dir: path.join(TMP, 'devlog') },
  },
})

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

const { Chat, getRuntime } = await import('../../apps/agent.js')
const rt = await getRuntime()

/** 一轮 LLM 回复（不进工具循环） */
function stubLLM(content, { toolCalls = null } = {}) {
  let n = 0
  rt.provider.chat = async () => {
    n++
    if (toolCalls && n === 1) return { role: 'assistant', content: '', toolCalls, finishReason: 'tool_calls', usage: null }
    return { role: 'assistant', content, toolCalls: [], finishReason: 'stop', usage: null }
  }
}

const officialGroupEvent = (extra = {}) => {
  const calls = []
  const evt = {
    self_id: SELF,
    adapter_id: 'QQBot',
    adapter_name: 'QQBot',
    isGroup: true,
    group_id: `${SELF}:G_OPENID`,
    user_id: `${SELF}:U_OPENID`,
    msg: 'hi',
    message: [],
    sender: { nickname: '测试' },
    message_id: 'm-qq-1',
    reply: async (...args) => { calls.push(args); return { message_id: ['x'], data: [{}], error: [] } },
    ...extra,
  }
  return { evt, calls }
}

const textsOf = (calls) => calls.map((a) => a[0])

console.log('\n[1] 官方适配器：markdown 直发 + 不发进度')
{
  stubLLM('# 标题\n**答案**：这是 markdown 回复。')
  const { evt, calls } = officialGroupEvent()
  const bot = new Chat({})
  bot.e = evt
  await bot._handleAgent('hi')
  const flat = calls.flatMap((a) => (Array.isArray(a[0]) ? a[0] : [a[0]]))
  ok(flat.some((s) => s && s.type === 'markdown'), '最终回复含 markdown 段（不渲染图片）')
  const md = flat.find((s) => s && s.type === 'markdown')
  ok(String(md?.data || '').includes('# 标题'), 'markdown 段内容=模型原文')
  ok(!flat.some((s) => s && s.type === 'image'), '没有渲染成图片')
  ok(!textsOf(calls).some((t) => typeof t === 'string' && t.includes('思考中')), '官方模式默认不发「思考中…」进度')
}

console.log('\n[2] markdown 被拒 → 自动降级纯文本')
{
  stubLLM('# 会被拒绝\n**正文** 保留可读')
  const { evt, calls } = officialGroupEvent()
  // 前两次（markdown 尝试）返回 error，第三次（纯文本降级）成功
  let call = 0
  evt.reply = async (...args) => {
    calls.push(args)
    call++
    if (call <= 1) return { message_id: [], data: [], error: [new Error('markdown not allowed')] }
    return { message_id: ['ok'], data: [{}], error: [] }
  }
  const bot = new Chat({})
  bot.e = evt
  await bot._handleAgent('hi')
  const flats = calls.flatMap((a) => (Array.isArray(a[0]) ? a[0] : [a[0]]))
  const last = flats.filter((s) => s != null).pop()
  ok(typeof last === 'string' && !last.includes('#'), '降级为纯文本（已剥 md 标记）')
  ok(String(last).includes('正文'), '降级文本保留正文')
}

console.log('\n[3] send_keyboard：卡片在最终回复后发送')
{
  stubLLM('已为你准备好选项。', {
    toolCalls: [{
      id: 'call_1',
      name: 'send_keyboard',
      // Agent 期望 arguments 已是对象（provider 层解析后的形态），不要再 JSON.stringify
      arguments: {
        text: '请选择下一步',
        keyboard: [[{ text: '继续', callback: '#ai 继续' }, { text: '文档', link: 'https://example.com' }]],
      },
    }],
  })
  const { evt, calls } = officialGroupEvent()
  const bot = new Chat({})
  bot.e = evt
  await bot._handleAgent('hi')
  const flats = calls.flatMap((a) => (Array.isArray(a[0]) ? a[0] : [a[0]]))
  const idxMd = flats.findIndex((s) => s && s.type === 'markdown')
  const idxBtn = flats.findIndex((s) => s && s.type === 'button')
  ok(idxMd >= 0, '正文 markdown 已发送')
  ok(idxBtn >= 0, 'keyboard 按钮段已发送')
  ok(idxBtn > idxMd, '卡片在最终回复之后（顺序稳定）')
  const btnRow = flats[idxBtn].data[0]
  ok(Array.isArray(btnRow) && btnRow.length === 2, '按钮行含 2 个按钮')
  // 回归（v1.45.7）：卡片权限必须用平台原始 openid（剥 self_id 前缀），否则本人点自己的按钮也会无权限
  ok(Array.isArray(btnRow[0].permission) && btnRow[0].permission[0] === 'U_OPENID', '回调按钮默认仅触发者可点（原始 openid，无前缀）')
  ok(!btnRow[1].permission, '链接按钮不限人')
}

console.log('\n[4] /uid 与 /groupid')
{
  const { evt, calls } = officialGroupEvent({ msg: '/uid' })
  const bot = new Chat({})
  bot.e = evt
  await bot.showUid()
  const out = String(textsOf(calls).pop() || '')
  ok(out.includes(`${SELF}:U_OPENID`), '/uid 打印完整 user_id（可直接配 masters）')
  ok(out.includes('U_OPENID') && out.includes('QQ 官方机器人'), '/uid 标注去前缀 ID 与协议类型')
  ok(out.includes('scopeId'), '/uid 给出 scopeId')

  const g = officialGroupEvent({ msg: '/groupid' })
  const bot2 = new Chat({})
  bot2.e = g.evt
  await bot2.showGroupId()
  const gout = String(textsOf(g.calls).pop() || '')
  ok(gout.includes(`${SELF}:G_OPENID`), '/groupid 打印完整 group_id')
  ok(gout.includes('G_OPENID'), '/groupid 打印去前缀 group_id')
  ok(gout.includes('官方机器人的群号不是 QQ 群号'), '/groupid 提醒不能按 QQ 群号配白名单')

  // 私聊：说明没有群聊 ID
  const p = officialGroupEvent({ isGroup: false, group_id: undefined, msg: '/groupid' })
  const bot3 = new Chat({})
  bot3.e = p.evt
  await bot3.showGroupId()
  ok(String(textsOf(p.calls).pop() || '').includes('没有群聊 ID'), '私聊 /groupid 说明没有群聊 ID')
}

console.log('\n[5] 官方 openid 主人：agent.masters 命中后主人指令可用')
{
  const rules = new Chat({}).rule || []
  const heavy = rules.find((r) => r.fnc === 'agentsReload')
  ok(heavy?.__masterGate === true && heavy?.permission === 'all', 'master 规则已下沉为插件内判定（masterGate）')
  // 非主人：拒绝并提示 /uid
  {
    const { evt, calls } = officialGroupEvent({ user_id: `${SELF}:U_OTHER`, msg: '#agents重载' })
    const bot = new Chat({})
    bot.e = evt
    const res = await Object.getPrototypeOf(bot).agentsReload.call({ e: evt, reply: evt.reply })
    const out = textsOf(calls).map(String).join('\n')
    ok(/仅主人可用/.test(out) && /\/uid/.test(out), '非主人被拒且给出 /uid 指引')
  }
  // 主人：命中完整 openid → 放行（不出现拒绝文案）
  {
    const { evt, calls } = officialGroupEvent({ user_id: `${SELF}:U_MASTER`, msg: '#agents重载' })
    const bot = new Chat({})
    bot.e = evt
    try { await Object.getPrototypeOf(bot).agentsReload.call({ e: evt, reply: evt.reply }) } catch { /* 运行时重建在桩环境可能抛错，这里只看是否被权限门拦下 */ }
    ok(!textsOf(calls).map(String).join('\n').includes('仅主人可用'), '主人（openid 命中 masters）未被权限门拦截')
  }
}

console.log('\n[6] 官方 ID 不产生非法落盘路径（scopeId / 日志文件名）')
{
  // 上一节的 #agents重载 会重建运行时 → 重新取引用并桩掉 LLM
  const rtNow = await getRuntime()
  rtNow.provider.chat = async () => ({ role: 'assistant', content: 'ok', toolCalls: [], finishReason: 'stop', usage: null })
  const { evt } = officialGroupEvent()
  const bot = new Chat({})
  bot.e = evt
  const seen = []
  const origWrite = fs.writeFileSync
  fs.writeFileSync = (p, ...rest) => { try { seen.push(String(p)) } catch { /* noop */ } return origWrite(p, ...rest) }
  try { await bot._handleAgent('hi') } finally { fs.writeFileSync = origWrite }
  const logs = seen.filter((p) => String(p).endsWith('.log'))
  ok(logs.length > 0, '确实写了会话日志（链路跑通）')
  ok(logs.every((p) => !String(p).includes(':')), `日志路径不含冒号（${logs.length} 个文件）`)
  ok(logs.some((p) => /1024-U_OPENID/.test(String(p))), '日志文件名含净化后的官方 ID（可追溯）')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* noop */ }
process.exit(failed ? 1 : 0)
