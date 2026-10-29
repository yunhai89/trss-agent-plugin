/**
 * QQ 官方机器人自实现适配器 —— 协议层离线自检。
 *
 * 覆盖：
 *  ① token：AppID+AppSecret 换取 access_token、缓存、并发单飞、错误人话化；
 *  ② api：路径/消息体（msg_type 推断、msg_seq 分配、被动回复）、错误映射、富媒体上传、DM 创建；
 *  ③ gateway：HELLO→IDENTIFY/RESUME、心跳、READY 记 session、DISPATCH 回调、
 *     关闭码语义（4004 不重连 / 4006 清 session 重连 / 4008 60s）；
 *  ④ events：群/私聊/频道/频道私信/按钮点击 归一化；
 *  ⑤ payload：文本/markdown/键盘/媒体/引用 拆分，键盘默认权限、官方 5×5 上限；
 *  ⑥ client：发送（文本、markdown 无权限自动降级文本、富媒体上传→msg_type7）、事件分发。
 *
 * 运行：node model/qqbot/test.mjs
 */
import { TokenManager, TOKEN_URL, TOKEN_URLS } from './token.js'
import { QQBotApi, MSG_TYPE, FILE_TYPE, messagePath, mediaPath, explainError, MsgSeqAllocator, API_BASE, API_BASES } from './api.js'
import { QQBotGateway, INTENTS, DEFAULT_INTENTS, OP, resolveWebSocket } from './gateway.js'
import { normalizeEvent, normalizeAttachments, GATEWAY_EVENTS } from './events.js'
import { buildKeyboard, buildMessageJobs, splitText, markdownPayload, resolveMediaSource } from './payload.js'
import { QQBotClient, markdownToPlain } from './client.js'

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `（实际 ${JSON.stringify(a)}）`}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 通用 fetch 桩 ────────────────────────────────────────────────────────
function makeFetchStub(handler) {
  const calls = []
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url: String(url), method: init.method || 'GET', body, headers: init.headers || {} })
    const r = await handler({ url: String(url), method: init.method || 'GET', body, headers: init.headers || {} })
    return {
      ok: r.status ? r.status >= 200 && r.status < 300 : true,
      status: r.status || 200,
      headers: { get: (k) => (r.headers && r.headers[k]) || null },
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
      json: async () => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body),
    }
  }
  fn.calls = calls
  return fn
}

console.log('\n[1] token：AppID + AppSecret 换 access_token')
{
  const fetchImpl = makeFetchStub(() => ({ body: { access_token: 'tok-1', expires_in: 7200 } }))
  const tm = new TokenManager({ fetchImpl })
  const t1 = await tm.getAccessToken('1024', 'secret')
  eq(t1, 'tok-1', '取到 access_token')
  eq(fetchImpl.calls[0].url, TOKEN_URL, '请求官方 token 端点')
  eq(fetchImpl.calls[0].body, { appId: '1024', clientSecret: 'secret' }, '请求体只有 appId + clientSecret（无需 QQ 号/Token）')
  const t2 = await tm.getAccessToken('1024', 'secret')
  eq(t2, 'tok-1', '缓存命中')
  eq(fetchImpl.calls.length, 1, '缓存命中不重复请求')

  // 并发单飞
  const fetch2 = makeFetchStub(() => ({ body: { access_token: 'tok-2', expires_in: 7200 } }))
  const tm2 = new TokenManager({ fetchImpl: fetch2 })
  const [a, b, c] = await Promise.all([tm2.getAccessToken('A', 's'), tm2.getAccessToken('A', 's'), tm2.getAccessToken('A', 's')])
  eq([a, b, c], ['tok-2', 'tok-2', 'tok-2'], '并发调用同一 appId 结果一致')
  eq(fetch2.calls.length, 1, '并发只发一次请求（单飞）')

  // 错误
  const bad = new TokenManager({ fetchImpl: makeFetchStub(() => ({ status: 401, body: { code: 100016, message: 'invalid appid or secret' } })) })
  let err = null
  try { await bad.getAccessToken('x', 'y') } catch (e) { err = e }
  ok(err && /AppID\/AppSecret/.test(err.message), '401 时提示核对 AppID/AppSecret')
  const missing = new TokenManager({ fetchImpl: makeFetchStub(() => ({ body: { code: 1, message: 'no token' } })) })
  err = null
  try { await missing.getAccessToken('x', 'y') } catch (e) { err = e }
  ok(err && /access_token/.test(err.message), '缺少 access_token 时报错')
  err = null
  try { await new TokenManager({ fetchImpl: async () => { throw new Error('ECONNRESET') } }).getAccessToken('x', 'y') } catch (e) { err = e }
  ok(err && /网络/.test(err.message), '网络错误归一人话')
  eq(new TokenManager().status('none').state, 'none', 'status：无缓存')

  // 新域名失败 → 自动回退旧域名
  const fallbackCalls = []
  const fbFetch = async (url) => {
    fallbackCalls.push(String(url))
    if (String(url).includes('api.bot.qq.com')) return { ok: false, status: 502, headers: { get: () => null }, text: async () => 'bad gateway' }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ access_token: 'tok-fb', expires_in: 7200 }) }
  }
  const tmFb = new TokenManager({ fetchImpl: fbFetch })
  eq(await tmFb.getAccessToken('A', 'S'), 'tok-fb', 'token 端点：新域名失败回退旧域名')
  ok(fallbackCalls.some((u) => String(u).includes('bots.qq.com')), '确实请求了旧 token 端点')
}

console.log('\n[2] api：路径 / 消息体 / 错误映射')
{
  eq(messagePath('group', 'G1'), '/v2/groups/G1/messages', '群消息路径')
  eq(messagePath('c2c', 'U1'), '/v2/users/U1/messages', 'C2C 消息路径')
  eq(messagePath('guild', 'C1'), '/channels/C1/messages', '频道消息路径')
  eq(messagePath('guild_dm', 'D1'), '/dms/D1/messages', '频道私信路径')
  eq(mediaPath('group', 'G1'), '/v2/groups/G1/files', '群富媒体上传路径')
  eq(mediaPath('guild', 'C1'), null, '频道不走富媒体上传路径（本适配器不支持）')
  ok(/Markdown/.test(explainError('304036')), '304036 解释为 Markdown 权限')
  ok(/5 行/.test(explainError('40034029')), '键盘超限解释')
  ok(explainError('99999', 'boom').includes('boom'), '未知错误码保留原文')
  eq(API_BASE, 'https://api.bot.qq.com', '默认 API 基址（2026 官方文档统一地址）')
  ok(API_BASES.includes('https://api.sgroup.qq.com'), '保留旧基址作为回退')
  eq(TOKEN_URL, 'https://api.bot.qq.com/app/getAppAccessToken', '默认 token 端点（新域名）')
  ok(TOKEN_URLS.includes('https://bots.qq.com/app/getAppAccessToken'), '保留旧 token 端点作为回退')

  const seq = new MsgSeqAllocator()
  eq([seq.next('m1'), seq.next('m1'), seq.next('m1')], [1, 2, 3], '同一 msg_id 的 msg_seq 递增')
  eq(seq.next(''), 1, '无 msg_id（主动消息）返回 1')

  const fetchImpl = makeFetchStub(({ url }) => {
    if (url.includes('getAppAccessToken')) return { body: { access_token: 'tok-x', expires_in: 7200 } }
    if (url.includes('/gateway')) return { body: { url: 'wss://gw.example' } }
    if (url.includes('/files')) return { body: { file_info: 'FI1', ttl: 3600 } }
    if (url.includes('/users/@me/dms')) return { body: { guild_id: 'DG1' } }
    if (url.includes('/interactions/')) return { body: { code: 0 } }
    return { body: { id: 'MSG1', timestamp: '2026-01-01T00:00:00Z' } }
  })
  const tm = new TokenManager({ fetchImpl })
  const api = new QQBotApi({ tokenManager: tm, fetchImpl })
  eq(await api.getGatewayUrl({ appId: 'A', appSecret: 'S' }), 'wss://gw.example', '取网关地址')
  ok(fetchImpl.calls.some((c) => c.headers.Authorization === 'QQBot tok-x' || /QQBot/.test(c.headers.Authorization || '')), 'REST 带 QQBot access_token 鉴权头')
  ok(fetchImpl.calls.some((c) => c.headers['X-Union-Appid'] === 'A'), '带 X-Union-Appid')

  const r1 = await api.sendMessage({ appId: 'A', appSecret: 'S' }, 'group', 'G1', { content: 'hi' })
  const c1 = fetchImpl.calls.filter((c) => c.method === 'POST' && c.url.includes('/v2/groups/G1/messages')).pop()
  eq(c1.body, { content: 'hi', msg_type: MSG_TYPE.TEXT }, '文本消息自动补 msg_type=0')
  eq(r1.id, 'MSG1', '返回消息 id')

  await api.sendMessage({ appId: 'A', appSecret: 'S' }, 'c2c', 'U1', { markdown: { content: '# hi' } }, { msgId: 'evt1' })
  const c2 = fetchImpl.calls.filter((c) => c.url.includes('/v2/users/U1/messages')).pop()
  eq(c2.body.msg_type, MSG_TYPE.MARKDOWN, 'markdown 消息自动补 msg_type=2')
  eq(c2.body.msg_id, 'evt1', '被动回复带 msg_id')
  eq(c2.body.msg_seq, 1, '被动回复自动分配 msg_seq')

  await api.sendMessage({ appId: 'A', appSecret: 'S' }, 'group', 'G1', { media: { file_info: 'FI' }, foo: undefined })
  const c3 = fetchImpl.calls.filter((c) => c.url.includes('/v2/groups/G1/messages')).pop()
  eq(c3.body.msg_type, MSG_TYPE.MEDIA, '富媒体消息自动补 msg_type=7')
  ok(!('foo' in c3.body), 'undefined 字段被清理')

  const up = await api.uploadMedia({ appId: 'A', appSecret: 'S' }, 'group', 'G1', { fileType: FILE_TYPE.IMAGE, base64: 'AAAA' })
  eq(up.file_info, 'FI1', '富媒体上传返回 file_info')
  const upc = fetchImpl.calls.filter((c) => c.url.includes('/files')).pop()
  eq(upc.body, { file_type: 1, srv_send_msg: false, file_data: 'AAAA' }, '上传体：file_type + file_data')

  const dms = await api.createDms({ appId: 'A', appSecret: 'S' }, { recipientId: 'U', sourceGuildId: 'G' })
  eq(dms.guild_id, 'DG1', '创建频道私信会话')
  await api.acknowledgeInteraction({ appId: 'A', appSecret: 'S' }, 'INT1')
  ok(fetchImpl.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/interactions/INT1')), '交互应答 PUT')

  // 业务错误码
  const errApi = new QQBotApi({ tokenManager: new TokenManager({ fetchImpl: makeFetchStub(() => ({ body: { access_token: 't' } })) }), fetchImpl: makeFetchStub(() => ({ status: 400, body: { code: 304036, message: 'no markdown' } })) })
  let e2 = null
  try { await errApi.sendMessage({ appId: 'A', appSecret: 'S' }, 'group', 'G1', { markdown: { content: 'x' } }) } catch (e) { e2 = e }
  ok(e2 && e2.code === 304036 && /Markdown/.test(e2.message), '错误对象带业务码与人话')

  // API 基址回退：新域名网络错误 → 旧域名成功
  const baseCalls = []
  const tmOk = new TokenManager({ fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ access_token: 't', expires_in: 7200 }) }) })
  const apiFb = new QQBotApi({
    tokenManager: tmOk,
    fetchImpl: async (url) => {
      baseCalls.push(String(url))
      if (String(url).includes('api.bot.qq.com')) throw new Error('fetch failed: ECONNRESET')
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ url: 'wss://legacy' }) }
    },
  })
  eq(await apiFb.getGatewayUrl({ appId: 'A', appSecret: 'S' }), 'wss://legacy', 'API 基址：新域名失败回退旧域名')
  ok(baseCalls.some((u) => String(u).includes('api.sgroup.qq.com')), '确实回退到旧 API 基址')
}

console.log('\n[3] gateway：HELLO/IDENTIFY/心跳/READY/关闭码')
{
  class FakeWS {
    constructor(url) {
      this.url = url
      this.sent = []
      this.listeners = {}
      FakeWS.instance = this
      setTimeout(() => this.emit('open', {}), 0)
    }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn) }
    emit(name, ev) { for (const fn of this.listeners[name] || []) fn(ev) }
    send(text) { this.sent.push(JSON.parse(text)) }
    close() { this.closed = true }
  }
  const dispatched = []
  const states = []
  const gw = new QQBotGateway({
    appId: 'A',
    appSecret: 'S',
    getToken: async () => 'TOK',
    getGatewayUrl: async () => 'wss://gw.example',
    WebSocketImpl: FakeWS,
    reconnectDelays: [10],
    onDispatch: (ev) => dispatched.push(ev),
    onState: (s) => states.push(s.state),
  })
  await gw.start()
  await sleep(5)
  const ws = FakeWS.instance
  eq(ws.url, 'wss://gw.example', '连到网关地址')

  ws.emit('message', { data: JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 50 } }) })
  await sleep(5)
  const identify = ws.sent.find((p) => p.op === OP.IDENTIFY)
  ok(!!identify, 'HELLO 后发送 IDENTIFY')
  eq(identify.d.token, 'QQBot TOK', 'IDENTIFY token 形如 QQBot <access_token>')
  eq(identify.d.shard, [0, 1], 'IDENTIFY 带 shard')
  ok((identify.d.intents & INTENTS.GROUP_AND_C2C) !== 0, '默认订阅包含群/C2C 事件')

  // 心跳
  await sleep(70)
  const beats = ws.sent.filter((p) => p.op === OP.HEARTBEAT)
  ok(beats.length >= 1, '按 heartbeat_interval 发送心跳', `beats=${beats.length}`)

  // READY
  ws.emit('message', { data: JSON.stringify({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 'SESS1', user: { id: 'A' } } }) })
  await sleep(5)
  eq(gw.status().sessionId, 'SESS1', 'READY 记录 session_id')
  eq(gw.status().state, 'ready', '状态 ready')
  ok(states.includes('ready'), 'onState 通知 ready')

  // 业务事件
  ws.emit('message', { data: JSON.stringify({ op: OP.DISPATCH, t: 'GROUP_AT_MESSAGE_CREATE', s: 2, d: { id: 'm1' } }) })
  await sleep(5)
  eq(dispatched.pop()?.t, 'GROUP_AT_MESSAGE_C2C'.replace('_C2C', '_CREATE'), 'DISPATCH 事件回调（事件名原样）')

  // 断线重连：清 session 后重新 IDENTIFY
  const gw2 = new QQBotGateway({ appId: 'A', appSecret: 'S', getToken: async () => 'T', getGatewayUrl: async () => 'wss://gw2', WebSocketImpl: FakeWS, reconnectDelays: [5] })
  await gw2.start()
  await sleep(5)
  FakeWS.instance.emit('message', { data: JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 100000 } }) })
  FakeWS.instance.emit('message', { data: JSON.stringify({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 'S2' } }) })
  await sleep(5)
  FakeWS.instance.emit('close', { code: 4006, reason: 'invalid session' })
  await sleep(30)
  ok(gw2.reconnectAttempts >= 1, '4006 触发重连', `attempts=${gw2.reconnectAttempts}`)
  eq(gw2.status().sessionId, null, '4006 清空 session（重连走 IDENTIFY 而非 RESUME）')
  gw2.stop()

  // 4004 鉴权失败不重连
  const gw3 = new QQBotGateway({ appId: 'A', appSecret: 'S', getToken: async () => 'T', getGatewayUrl: async () => 'wss://gw3', WebSocketImpl: FakeWS, reconnectDelays: [5] })
  await gw3.start()
  await sleep(5)
  FakeWS.instance.emit('close', { code: 4004 })
  await sleep(30)
  eq(gw3.reconnectAttempts, 0, '4004 不重连')
  eq(gw3.status().state, 'closed', '4004 状态 closed(auth_failed)')
  gw3.stop()

  const resolved = await resolveWebSocket().catch(() => null)
  ok(resolved && typeof resolved.Ctor === 'function', `WebSocket 实现可解析（${resolved?.kind}）`)
}

console.log('\n[4] events：事件归一化')
{
  const g = normalizeEvent(GATEWAY_EVENTS.GROUP_AT_MESSAGE_CREATE, {
    id: 'm1', content: '你好', timestamp: '2026-10-29T10:00:00+08:00', group_openid: 'GO', author: { member_openid: 'MO', username: '小明' },
    mentions: [{ id: 'A' }], attachments: [{ content_type: 'image/png', url: 'https://x/1.png', filename: 'a.png', size: 12 }],
  }, { appId: 'A' })
  eq([g.type, g.scene, g.userId, g.groupOpenid, g.username], ['message', 'group', 'MO', 'GO', '小明'], '群 @ 消息归一化')
  eq(g.attachments[0].url, 'https://x/1.png', '附件保留 url')

  const c2c = normalizeEvent(GATEWAY_EVENTS.C2C_MESSAGE_CREATE, { id: 'm2', content: 'hi', author: { user_openid: 'UO' } }, { appId: 'A' })
  eq([c2c.scene, c2c.userId, c2c.groupOpenid], ['c2c', 'UO', null], 'C2C 归一化')

  const guild = normalizeEvent(GATEWAY_EVENTS.AT_MESSAGE_CREATE, { id: 'm3', content: 'hi', guild_id: 'G', channel_id: 'C', author: { id: 'U', username: 'u' } }, { appId: 'A' })
  eq([guild.scene, guild.guildId, guild.channelId, guild.userId], ['guild', 'G', 'C', 'U'], '频道消息归一化')

  const dm = normalizeEvent(GATEWAY_EVENTS.DIRECT_MESSAGE_CREATE, { id: 'm4', content: 'hi', guild_id: 'G', author: { id: 'U' } }, { appId: 'A' })
  eq([dm.scene, dm.guildId], ['guild_dm', 'G'], '频道私信归一化')

  const inter = normalizeEvent(GATEWAY_EVENTS.INTERACTION_CREATE, {
    id: 'i1', chat_type: 1, group_openid: 'GO', group_member_openid: 'MO', timestamp: '2026-10-29T10:00:00Z',
    data: { resolved: { button_data: '#确认 12', button_id: 'b1', message_id: 'm0' } },
  }, { appId: 'A' })
  eq([inter.type, inter.scene, inter.content, inter.userId, inter.messageId], ['interaction', 'group', '#确认 12', 'MO', 'm0'], '按钮点击归一化（回调文本当用户发言）')
  eq(normalizeEvent('SOMETHING_ELSE', {}), null, '无关事件返回 null')

  const atts = normalizeAttachments([{ content_type: 'image/jpeg', url: 'u' }, { content_type: 'voice', url: 'v' }, { content_type: 'application/pdf', url: 'f' }])
  eq(atts.map((a) => a.type), ['image', 'voice', 'file'], '附件类型归一化')
}

console.log('\n[5] payload：段 → 官方消息体')
{
  // 键盘：默认权限、上限
  const kb = buildKeyboard([[{ text: '确认', callback: '#确认 1' }, { text: '打开', link: 'https://x' }]], { ownerId: 'UO' })
  eq(kb.content.rows.length, 1, '键盘行数')
  const b0 = kb.content.rows[0].buttons[0]
  eq(b0.action.type, 1, '回调按钮 action.type=1')
  eq(b0.action.permission, { type: 0, specify_user_ids: ['UO'] }, '回调按钮默认仅触发者')
  eq(kb.content.rows[0].buttons[1].action.type, 0, '链接按钮 action.type=0')
  eq(kb.content.rows[0].buttons[1].action.permission, { type: 2 }, '链接按钮所有人可点')
  const kbPublic = buildKeyboard([[{ text: '公开', callback: 'x', public: true }]], { ownerId: 'U' })
  eq(kbPublic.content.rows[0].buttons[0].action.permission, { type: 2 }, 'public:true 放开所有人')
  const kbAdmin = buildKeyboard([[{ text: '管理', callback: 'x', permission: 'admin' }]])
  eq(kbAdmin.content.rows[0].buttons[0].action.permission, { type: 1 }, 'permission=admin → 管理员权限')
  const kbBig = buildKeyboard(Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => ({ text: `b${i}${j}`, callback: `c${i}${j}` }))))
  eq([kbBig.content.rows.length, kbBig.content.rows[0].buttons.length], [5, 5], '键盘裁剪到 5×5')
  ok(!buildKeyboard([]), '空键盘返回 null')
  ok(!buildKeyboard([[{ text: '无动作' }]]), '无动作按钮被丢弃')

  // 文本任务
  const jobs1 = buildMessageJobs('hello')
  eq(jobs1.length, 1, '字符串 → 一个文本任务')
  eq(jobs1[0].payload, { content: 'hello' }, '文本 payload')

  // markdown + 键盘 + 引用
  const jobs2 = buildMessageJobs([
    { type: 'reply', id: 'evt9' },
    { type: 'markdown', data: '# 标题' },
    { type: 'button', data: [{ text: 'A', callback: 'a' }] },
    { type: 'at', qq: 'A' },
    { type: 'text', text: '补充' },
  ], { ownerId: 'UO' })
  eq(jobs2[0].kind, 'markdown', '含 markdown 段 → markdown 任务')
  eq(jobs2[0].payload.markdown, { content: '# 标题' }, 'markdown 内容')
  ok(jobs2[0].payload.keyboard, '键盘挂在同一条消息上')
  eq(jobs2[0].msgId, 'evt9', '引用段作为被动回复 msg_id')

  // 模板 markdown
  const jobs3 = buildMessageJobs([{ type: 'markdown', data: { templateId: 'tpl-1', params: [{ key: 'k', values: ['v'] }] } }], { templateId: 'tpl-1' })
  eq(jobs3[0].payload.markdown.custom_template_id, 'tpl-1', '模板 ID 模式')

  // 媒体
  const jobs4 = buildMessageJobs([{ type: 'text', text: '看图' }, { type: 'image', file: 'https://x/1.png' }, { type: 'image', file: '/tmp/a.png' }])
  eq(jobs4.map((j) => j.kind), ['text', 'media', 'media'], '文本 + 两张图 → 三个任务')
  eq(jobs4[1].source, { url: 'https://x/1.png' }, 'URL 图片')
  eq(jobs4[2].source, { path: '/tmp/a.png' }, '本地图片（稍后读文件 base64 上传）')
  eq(jobs4[2].fileType, FILE_TYPE.IMAGE, '图片 file_type=1')

  eq(resolveMediaSource('base64://QUJD'), { base64: 'QUJD', bytes: 3 }, 'base64:// 解析')
  eq(resolveMediaSource('data:image/png;base64,QUJD').base64, 'QUJD', 'data URI 解析')
  eq(resolveMediaSource({ buffer: Buffer.from('x') }).base64, Buffer.from('x').toString('base64'), 'Buffer 解析')

  const chunks = splitText('a'.repeat(9000), 3800)
  eq(chunks.map((c) => c.length), [3800, 3800, 1400], '超长文本按上限切分')
  eq(splitText('', 100), [], '空文本返回空数组')
  eq(markdownPayload('plain'), { content: 'plain' }, 'markdown 段字符串')
  ok(buildMessageJobs([]).length === 0, '空段数组 → 无任务')
  ok(!buildMessageJobs([{ type: 'face', id: 1 }]).length, '不支持的段被忽略（不报错）')
}

console.log('\n[6] client：发送（含 markdown 降级 / 富媒体上传）与事件分发')
{
  const requests = []
  const fetchImpl = makeFetchStub(({ url, method, body }) => {
    requests.push({ url, method, body })
    if (url.includes('getAppAccessToken')) return { body: { access_token: 'TOK', expires_in: 7200 } }
    if (url.includes('/files')) return { body: { file_info: 'FI9' } }
    if (url.endsWith('/gateway')) return { body: { url: 'wss://gw' } }
    if (body?.markdown) return { status: 400, body: { code: 304036, message: 'no markdown permission' } }
    return { body: { id: 'MID' } }
  })
  const client = new QQBotClient({ appId: 'A', appSecret: 'S', fetchImpl, WebSocketImpl: null, logger: () => {} })
  eq(client.markdownMode, 'auto', '默认 markdown=auto')

  // 文本
  const r1 = await client.send('group', 'GO', 'hi')
  eq(r1.message_id, ['MID'], '文本发送成功')
  const sent1 = requests.filter((r) => r.url.includes('/v2/groups/GO/messages')).pop()
  eq(sent1.body, { content: 'hi', msg_type: 0 }, '文本消息体')

  // markdown 被拒 → 自动降级纯文本
  const r2 = await client.send('c2c', 'UO', [{ type: 'markdown', data: '# 标题\n**正文**' }])
  const mdSent = requests.filter((r) => r.url.includes('/v2/users/UO/messages'))
  eq(mdSent[0].body.msg_type, 2, '先尝试 markdown')
  const txtSent = mdSent[1]
  ok(txtSent && txtSent.body.msg_type === 0 && /标题/.test(txtSent.body.content) && !txtSent.body.content.includes('#'), '被拒后降级纯文本（剥 md 标记）')
  eq(client.markdownUsable, false, '记住该账号 markdown 不可用')

  // 富媒体：上传 → msg_type=7
  const r3 = await client.send('group', 'GO', [{ type: 'image', file: 'https://x/2.png' }], { msgId: 'evt5' })
  const upc = requests.filter((r) => r.url.includes('/files')).pop()
  eq(upc.body, { file_type: 1, srv_send_msg: false, url: 'https://x/2.png' }, '先上传图片')
  const mediaMsg = requests.filter((r) => r.url.includes('/v2/groups/GO/messages')).pop()
  eq(mediaMsg.body.msg_type, 7, '再以 msg_type=7 发富媒体')
  eq(mediaMsg.body.media, { file_info: 'FI9' }, '带 file_info')
  ok(r3.message_id.length >= 1, '富媒体返回消息 id')

  // 本地文件读不到 → 不抛错
  const r4 = await client.send('group', 'GO', [{ type: 'image', file: '/nonexistent/x.png' }])
  eq(r4.message_id, [], '本地文件缺失时跳过（不报错）')

  // 事件分发
  const messages = []
  client.on('message', (ev) => messages.push(ev))
  client._dispatch('GROUP_AT_MESSAGE_CREATE', { id: 'm1', content: 'hi', group_openid: 'GO', author: { member_openid: 'MO' } }, 1)
  eq(messages.length, 1, 'client 分发 message 事件')
  eq(messages[0].groupId || messages[0].groupOpenid, 'GO', '事件带群 openid')

  ok(/标题/.test(markdownToPlain('# 标题\n**加粗**')), 'markdownToPlain 去标记')
  eq(QQBotClient.splitMarkdown('x'.repeat(100), 50).length, 2, '静态分片方法可用')

  client.stop()
}

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
