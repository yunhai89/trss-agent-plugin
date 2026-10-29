/**
 * 自实现 QQBot 适配器集成自检（真跑 apps/qqbot.js，桩 Yunzai/Config/协议客户端）。
 *
 * 覆盖：
 *  ① 模块加载时把适配器注册进 Bot.adapter（框架 Listener 阶段会调用 load()）；
 *  ② 账号配置归一化：accounts[] 与扁平 appId/appSecret、缺密钥跳过、enable=false 不启动；
 *  ③ 连接后注册 Bot[id] 并提供 pickFriend/pickGroup/pickMember（框架 prepareEvent 依赖）；
 *  ④ 网关事件 → Yunzai 事件（message.group.normal / message.private.friend）字段正确；
 *  ⑤ 被动回复：5 分钟内带 msg_id、同一 msg_id 最多 5 次，超出降级主动消息；
 *  ⑥ 按钮点击（INTERACTION）→ 当作「用户发了一句话」投递；
 *  ⑦ 断连清理 Bot[id]；状态查询。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs stress/e2e/qqbot-adapter.mjs
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
// 若未通过 --import 传入 hooks，则自行加载（保证单跑也能过）
if (!globalThis.__QQBOT_ADAPTER_HOOKED__) {
  globalThis.__QQBOT_ADAPTER_HOOKED__ = true
  await import(pathToFileURL(path.join(here, 'hooks.mjs')).href)
}

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `（实际 ${JSON.stringify(a)}）`}`)

// ── 假 Bot 宿主（框架侧最小契约） ──────────────────────────────────────
const harness = {
  adapter: [],
  bots: {},
  uin: Object.assign([], { toJSON() { return this[this.length - 1] || '' } }),
  emCalls: [],
  emits: [],
  em(name, data) { this.emCalls.push({ name, data }) },
  emit(name, data) { this.emits.push({ name, data }) },
  makeLog() {},
}
globalThis.Bot = harness

// ── 假协议客户端（替身 QQBotClient） ───────────────────────────────────
class FakeClient {
  constructor(account) {
    this.account = account
    this.handlers = new Map()
    this.sent = []
    this.started = false
    this.api = { creds: () => ({ appId: account.appId, appSecret: account.appSecret }), createDms: async () => ({ guild_id: 'DMG' }) }
  }
  on(ev, fn) { if (!this.handlers.has(ev)) this.handlers.set(ev, new Set()); this.handlers.get(ev).add(fn); return () => this.handlers.get(ev)?.delete(fn) }
  emit(ev, payload) { for (const fn of this.handlers.get(ev) || []) fn(payload) }
  async start() { this.started = true; this._state = 'ready' }
  stop() { this._state = 'stopped' }
  status() { return { state: this._state || 'idle', appId: this.account.appId } }
  async send(scene, target, segments, opts = {}) {
    this.sent.push({ scene, target, segments, opts })
    return { message_id: ['MID' + this.sent.length], data: [{}], error: [] }
  }
  async recall() { return true }
}

const { createQQBotAdapter, normalizeAccounts, adapter: registeredAdapter } = await import(pathToFileURL(path.join(here, '../../apps/qqbot.js')).href)
const cfgMod = await import('./stubs/Config.js')
const { __setConfig } = cfgMod

console.log('\n[1] 模块加载即注册适配器')
{
  ok(Array.isArray(harness.adapter) && harness.adapter.includes(registeredAdapter), 'Bot.adapter 已含自实现适配器')
  eq(registeredAdapter.id, 'QQBot', '适配器 id=QQBot（与 qqofficial 识别一致）')
  ok(registeredAdapter.path && registeredAdapter.path.indexOf('QQBotAgent') >= 0, '适配器 path 独立（避免与 Yunzai-QQBot-Plugin 去重冲突）')
}

console.log('\n[2] 账号配置归一化（AppID + AppSecret）')
{
  eq(normalizeAccounts({ agent: { qqBot: { enable: true, accounts: [{ appId: 'A1', appSecret: 'S1', name: '一号' }] } } }).length, 1, 'accounts[] 解析')
  const flat = normalizeAccounts({ agent: { qqBot: { appId: 'A2', appSecret: 'S2' } } })
  eq([flat.length, flat[0].appId, flat[0].name], [1, 'A2', 'A2'], '扁平 appId/appSecret 单账号')
  eq(normalizeAccounts({ agent: { qqBot: { enable: false, appId: 'A', appSecret: 'S' } } }).length, 0, 'enable=false 不启动')
  eq(normalizeAccounts({ agent: { qqBot: { appId: 'A' } } }).length, 0, '缺 appSecret 跳过')
  const norm = normalizeAccounts({ agent: { qqBot: { appId: 'A', appSecret: 'S' } } })[0]
  ok(norm.intents > 0 && norm.markdown === 'auto', '默认 intents 与 markdown=auto')
  // 回归：intents=0（默认配置）必须回落为「群@+C2C」，不能原样 0 传给网关（IDENTIFY intents=0 → 平台 4013）
  eq(norm.intents, 33554432, 'intents=0 → 默认 33554432（GROUP_AND_C2C）')
  eq(normalizeAccounts({ agent: { qqBot: { intents: 0, accounts: [{ appId: 'A', appSecret: 'S' }] } } })[0].intents, 33554432, 'accounts[] + qq.intents=0 也回落默认')
  eq(normalizeAccounts({ agent: { qqBot: { intents: 100663296, accounts: [{ appId: 'A', appSecret: 'S' }] } } })[0].intents, 100663296, '显式 intents 保留（群@+C2C+交互）')
  eq(normalizeAccounts({ agent: { qqBot: { intents: 100663296, accounts: [{ appId: 'A', appSecret: 'S', intents: 1073741825 }] } } })[0].intents, 1073741825, '账号级 intents 覆盖全局')
}

console.log('\n[3] 连接：注册 Bot[id] + pickFriend/pickGroup/pickMember')
{
  __setConfig({ agent: { qqBot: { enable: true, accounts: [{ appId: 'APP1', appSecret: 'SEC1', name: '测试号' }] } } })
  const clients = []
  const adapter = createQQBotAdapter({ clientFactory: (account) => { const c = new FakeClient(account); clients.push(c); return c } })
  await adapter.load()
  eq(clients.length, 1, '按配置创建 1 个协议客户端')
  eq(clients[0].started, true, '客户端已启动')
  const bot = harness.bots.APP1
  ok(!!bot, 'Bot[id] 已注册（框架 pick* / prepareEvent 依赖）')
  eq(bot.uin, 'APP1', 'bot.uin=appId')
  eq(bot.adapter.id, 'QQBot', 'bot.adapter 指回适配器')
  ok(bot.fl instanceof Map && bot.gl instanceof Map && bot.gml instanceof Map, 'fl/gl/gml 均为 Map')
  ok(typeof bot.pickFriend === 'function' && typeof bot.pickGroup === 'function' && typeof bot.pickMember === 'function', '提供 pickFriend/pickGroup/pickMember')
  ok(harness.emCalls.some((x) => x.name === 'connect.APP1') || harness.emits.some((x) => x.name === 'connect.APP1'), '发 connect.<id>（框架据此把 id 加入 Bot.uin）')
  eq(adapter.status()[0].connected, true, 'status 显示已连接')

  // reply 走被动回复
  await bot.pickGroup('APP1:G1').sendMsg('hello')
  const s = clients[0].sent.pop()
  eq([s.scene, s.target], ['group', 'G1'], '群消息发送到 group_openid')
  await bot.pickFriend('APP1:U1').sendMsg('hi')
  const s2 = clients[0].sent.pop()
  eq([s2.scene, s2.target], ['c2c', 'U1'], '私聊消息发送到 user_openid')
  adapter.stopAll()
}

console.log('\n[4] 事件归一化：群 / 私聊 / 频道 / 按钮')
{
  __setConfig({ agent: { qqBot: { enable: true, accounts: [{ appId: 'APP2', appSecret: 'SEC2', name: '二号' }] } } })
  let client
  const adapter = createQQBotAdapter({ clientFactory: (account) => { client = new FakeClient(account); return client } })
  await adapter.load()
  harness.emCalls.length = 0

  // 群 @ 消息
  client.emit('message', {
    type: 'message', scene: 'group', appId: 'APP2', eventName: 'GROUP_AT_MESSAGE_CREATE', atBot: true,
    messageId: 'm1', content: '你好', timestamp: '2026-10-29T10:00:00Z',
    userId: 'MO', groupOpenid: 'GO', username: '小明', mentions: [], attachments: [], msgElements: [], raw: {},
  })
  const g = harness.emCalls.pop()
  eq(g?.name, 'message', '群消息以 message 事件投递')
  const d = g.data
  eq([d.post_type, d.message_type, d.sub_type, d.self_id], ['message', 'group', 'normal', 'APP2'], '群消息基础字段')
  eq([d.user_id, d.group_id], ['APP2:MO', 'APP2:GO'], 'ID 拼成 <appId>:<openid>（与 qqofficial 识别一致）')
  eq(d.adapter_id, 'QQBot', '带 adapter_id（官方协议识别）')
  eq(d.message[0], { type: 'at', qq: 'APP2' }, '群消息补 at 段（框架 atBot 判定）')
  eq(d.message[1], { type: 'text', text: '你好' }, '正文段')
  ok(typeof d.reply === 'function', '提供 reply')
  eq(d.raw_message, '你好', 'raw_message')
  // 回归（线上「#设置主人/#agents更新 无反应、#状态 却能用」）：
  // 适配器不能预设 data.msg —— TRSS loader.dealEvent 会把 message 的 text 段累加到 e.msg，
  // 若这里已有初值就会变成「#设置主人#设置主人」，精确匹配（$ 结尾）的规则全失效，前缀规则却照常。
  ok(!('msg' in d), '不设置 data.msg（避免框架累加后文本翻倍）')
  const buildMsg = (data) => {
    let m = data.msg || ''
    for (const seg of data.message || []) if (seg.type === 'text') m += seg.text
    return m.trim()
  }
  eq(buildMsg(d), '你好', '模拟框架 dealEvent 后 e.msg 不重复')

  // 精确匹配命令完整链路：群 @ + #设置主人 → 框架 e.msg 恰为 #设置主人
  client.emit('message', {
    type: 'message', scene: 'group', appId: 'APP2', eventName: 'GROUP_AT_MESSAGE_CREATE', atBot: true,
    messageId: 'm1x', content: '#设置主人', timestamp: '2026-10-29T10:00:00Z',
    userId: 'MO', groupOpenid: 'GO', username: '小明', mentions: [], attachments: [], msgElements: [], raw: {},
  })
  const cmdData = harness.emCalls.pop().data
  eq(buildMsg(cmdData), '#设置主人', '@机器人的框架指令 e.msg 精确匹配（不再翻倍）')
  ok(new RegExp('^#设置主人$').test(buildMsg(cmdData)), 'TRSS ^#设置主人$ 规则可命中')

  // 被动回复：同一 msg_id 最多 5 次
  const ids = []
  for (let i = 0; i < 6; i++) {
    await d.reply(`r${i}`)
    ids.push(client.sent.pop().opts.msgId)
  }
  eq(ids.slice(0, 5), ['m1', 'm1', 'm1', 'm1', 'm1'], '前 5 次带被动回复 msg_id')
  eq(ids[5], '', '第 6 次降级主动消息（官方限制 5 次/msg_id）')

  // 私聊
  client.emit('message', {
    type: 'message', scene: 'c2c', appId: 'APP2', eventName: 'C2C_MESSAGE_CREATE', atBot: false,
    messageId: 'm2', content: 'hi', timestamp: '2026-10-29T10:00:00Z',
    userId: 'UO', groupOpenid: null, username: 'u', mentions: [], attachments: [], msgElements: [], raw: {},
  })
  const c2c = harness.emCalls.pop().data
  eq([c2c.message_type, c2c.sub_type, c2c.user_id, c2c.group_id], ['private', 'friend', 'APP2:UO', undefined], '私聊消息字段')
  eq(c2c.message, [{ type: 'text', text: 'hi' }], '私聊不加 at 段')

  // 频道
  client.emit('message', {
    type: 'message', scene: 'guild', appId: 'APP2', eventName: 'AT_MESSAGE_CREATE', atBot: true,
    messageId: 'm3', content: 'hi', timestamp: '2026-10-29T10:00:00Z',
    userId: 'GU', groupOpenid: null, guildId: 'GD', channelId: 'CH', username: 'u', mentions: [], attachments: [], msgElements: [], raw: {},
  })
  const guild = harness.emCalls.pop().data
  eq([guild.user_id, guild.group_id], ['qg_GU', 'qg_GD-CH'], '频道 ID 形态 qg_guild-channel')

  // 按钮点击 → 当作用户消息
  client.emit('interaction', {
    type: 'interaction', scene: 'group', appId: 'APP2', eventName: 'INTERACTION_CREATE', atBot: true, interactionId: 'i1', messageId: 'm0',
    content: '#确认 12', buttonId: 'b1', userId: 'MO', groupOpenid: 'GO', guildId: null, channelId: null,
    timestamp: '2026-10-29T10:00:00Z', username: '', mentions: [], attachments: [], msgElements: [], raw: {},
  })
  const inter = harness.emCalls.pop().data
  eq([inter.message_type, inter.message[1]?.text], ['group', '#确认 12'], '按钮回调文本当作一条用户消息投递')
  eq(inter.message_id, 'm0', '按钮消息沿用原消息 id（可被动回复）')

  // 回归（线上「不管发什么都回复」）：开启全量消息权限后收到的非 @ 群消息不得补 at 段，
  // 否则框架 trigger=at 会把每条群聊都当 @ 机器人而回复。
  client.emit('message', {
    type: 'message', scene: 'group', appId: 'APP2', eventName: 'GROUP_MESSAGE_CREATE', atBot: false,
    messageId: 'm4', content: '随便聊聊', timestamp: '2026-10-29T10:00:00Z',
    userId: 'MO', groupOpenid: 'GO', username: '小明', mentions: [], attachments: [], msgElements: [], raw: {},
  })
  const plain = harness.emCalls.pop().data
  ok(!plain.message.some((s) => s.type === 'at'), '非 @ 群消息不补 at 段（不会误触发 AI 回复）')
  eq(plain.message, [{ type: 'text', text: '随便聊聊' }], '非 @ 群消息只保留正文')
  eq(plain._qqbot.atBot, false, '_qqbot.atBot 标记可排障')

  client.emit('message', {
    type: 'message', scene: 'group', appId: 'APP2', eventName: 'GROUP_MESSAGE_CREATE', atBot: true,
    messageId: 'm5', content: '在吗', timestamp: '2026-10-29T10:00:00Z',
    userId: 'MO', groupOpenid: 'GO', username: '小明', mentions: [{ is_you: true, id: 'BOTOPENID' }], attachments: [], msgElements: [], raw: {},
  })
  const atMsg = harness.emCalls.pop().data
  eq(atMsg.message[0], { type: 'at', qq: 'APP2' }, '全量消息中被 @ 时补 at 段（正常触发）')

  adapter.stopAll()
}

console.log('\n[5] 断连清理与状态')
{
  __setConfig({ agent: { qqBot: { enable: true, appId: 'APP3', appSecret: 'SEC3' } } })
  let client
  const adapter = createQQBotAdapter({ clientFactory: (account) => { client = new FakeClient(account); return client } })
  await adapter.load()
  ok(!!harness.bots.APP3, '注册 Bot[APP3]')
  eq(adapter.status().length, 1, 'status 有 1 个账号')
  adapter.disconnect('APP3')
  ok(!harness.bots.APP3, '断连后移除 Bot[id]')
  eq(adapter.status().length, 0, '断连后 status 为空')
  eq(client._state, 'stopped', '协议客户端已 stop')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed ? 1 : 0)
