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
import { QQBotGateway, INTENTS, DEFAULT_INTENTS, OP, resolveWebSocket, CLOSE_CODE_HINT, nextIntents } from './gateway.js'
import { normalizeEvent, normalizeAttachments, GATEWAY_EVENTS, mentionsBot } from './events.js'
import { buildKeyboard, buildMessageJobs, splitText, markdownPayload, resolveMediaSource, markdownMentionTags } from './payload.js'
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

console.log('\n[3b] intents：默认最小集 / 4013 自动降级 / 关闭去重 / INVALID_SESSION 不重复重连')
{
  // 默认只订群@+C2C（1<<25）；交互/频道位按需显式开启
  eq(DEFAULT_INTENTS, INTENTS.GROUP_AND_C2C, '默认 intents 只含 GROUP_AND_C2C')
  eq(DEFAULT_INTENTS, 33554432, '默认 intents = 33554432')
  ok((DEFAULT_INTENTS & INTENTS.INTERACTION) === 0, '默认不含交互位（未开通会被 4013）')

  // 只降不升
  eq(nextIntents(INTENTS.GROUP_AND_C2C | INTENTS.INTERACTION, [INTENTS.GROUP_AND_C2C | INTENTS.INTERACTION]), INTENTS.GROUP_AND_C2C, '先剥交互位')
  eq(nextIntents(INTENTS.GUILDS | INTENTS.PUBLIC_GUILD_MESSAGES, [INTENTS.GUILDS | INTENTS.PUBLIC_GUILD_MESSAGES]), INTENTS.GROUP_AND_C2C, '频道位被拒 → 退到群最小集')
  eq(nextIntents(INTENTS.GROUP_AND_C2C, [INTENTS.GROUP_AND_C2C]), INTENTS.PUBLIC_GUILD_MESSAGES, '群位被拒 → 试频道单聊/频道消息')
  eq(nextIntents(INTENTS.GROUP_AND_C2C, [INTENTS.GROUP_AND_C2C, INTENTS.PUBLIC_GUILD_MESSAGES, INTENTS.GUILDS | INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE]), null, '候选耗尽返回 null')
  ok(nextIntents(INTENTS.GROUP_AND_C2C | INTENTS.INTERACTION, [INTENTS.GROUP_AND_C2C | INTENTS.INTERACTION]) !== (INTENTS.GROUP_AND_C2C | INTENTS.INTERACTION), '降级不会返回相同值（不循环）')

  const makeFake = () => {
    class FWS {
      constructor(url) { this.url = url; this.sent = []; this.listeners = {}; FWS.all.push(this); FWS.instance = this; setTimeout(() => this.emit('open', {}), 0) }
      addEventListener(n, fn) { (this.listeners[n] ||= []).push(fn) }
      emit(n, ev) { for (const fn of this.listeners[n] || []) fn(ev) }
      send(text) { this.sent.push(JSON.parse(text)) }
      close() { this.closed = true }
    }
    FWS.all = []
    return FWS
  }
  const hello = (ws) => ws.emit('message', { data: JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 100000 } }) })
  const identifyOf = (ws) => ws.sent.find((p) => p.op === OP.IDENTIFY)

  // 4013 降级：交互位被拒 → 自动改群最小集重连成功
  {
    const FWS = makeFake()
    const gw = new QQBotGateway({
      appId: 'A', appSecret: 'S', getToken: async () => 'T', getGatewayUrl: async () => 'wss://gw',
      WebSocketImpl: FWS, intents: INTENTS.GROUP_AND_C2C | INTENTS.INTERACTION, reconnectDelays: [5], intentsRetryDelayMs: 5,
    })
    await gw.start()
    await sleep(5)
    hello(FWS.instance)
    await sleep(3)
    eq(identifyOf(FWS.instance)?.d.intents, 100663296, '首次 IDENTIFY 用配置的 intents')
    FWS.instance.emit('close', { code: 4013, reason: 'invalid intents' })
    await sleep(3)
    eq([gw.status().intents, gw.status().state], [INTENTS.GROUP_AND_C2C, 'connecting'], '4013 → 自动降级为群最小集并计划重连')
    eq(gw.reconnectAttempts, 1, '降级只计一次重连')
    await sleep(20) // 等 reconnectDelays=5 后重连
    ok(FWS.all.length >= 2, '降级后重新建立连接')
    hello(FWS.all[FWS.all.length - 1])
    await sleep(3)
    eq(identifyOf(FWS.all[FWS.all.length - 1])?.d.intents, INTENTS.GROUP_AND_C2C, '重连后的 IDENTIFY 用降级 intents')
    FWS.all[FWS.all.length - 1].emit('message', { data: JSON.stringify({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 'S' } }) })
    await sleep(3)
    eq(gw.status().state, 'ready', '降级后 READY 成功')
    gw.stop()
  }

  // 候选耗尽：停止重连并给出 invalid_intents 原因（不再无限循环）
  {
    const FWS = makeFake()
    const gw = new QQBotGateway({ appId: 'A', appSecret: 'S', getToken: async () => 'T', getGatewayUrl: async () => 'wss://gw', WebSocketImpl: FWS, reconnectDelays: [5] })
    await gw.start(); await sleep(5); hello(FWS.instance); await sleep(3)
    gw._triedIntents = [INTENTS.GROUP_AND_C2C | INTENTS.INTERACTION, INTENTS.GROUP_AND_C2C, INTENTS.PUBLIC_GUILD_MESSAGES, INTENTS.GUILDS | INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE]
    gw.intents = INTENTS.PUBLIC_GUILD_MESSAGES
    FWS.instance.emit('close', { code: 4013 })
    await sleep(5)
    eq(gw.status().state, 'closed', '候选耗尽后状态 closed（不再重连）')
    ok(String(gw.status().hint || '').includes('intents'), '状态里带可执行提示')
    eq(gw.reconnectAttempts, 0, '耗尽时不排重连')
    gw.stop()
  }

  // 同一 socket 连续两个 close 只算一次（历史 bug：attempts 1s/2s 连跳导致重连风暴）
  {
    const FWS = makeFake()
    const gw = new QQBotGateway({ appId: 'A', appSecret: 'S', getToken: async () => 'T', getGatewayUrl: async () => 'wss://gw', WebSocketImpl: FWS, reconnectDelays: [50] })
    await gw.start(); await sleep(5); hello(FWS.instance); await sleep(3)
    FWS.instance.emit('close', { code: 4006 })
    FWS.instance.emit('close', { code: 4006 })
    await sleep(5)
    eq(gw.reconnectAttempts, 1, '重复 close 只计一次重连')
    gw.stop()
  }

  // INVALID_SESSION：先不重连（等真实 close 码），3s 兜底才主动断开
  {
    const FWS = makeFake()
    const gw = new QQBotGateway({ appId: 'A', appSecret: 'S', getToken: async () => 'T', getGatewayUrl: async () => 'wss://gw', WebSocketImpl: FWS, reconnectDelays: [50] })
    await gw.start(); await sleep(5); hello(FWS.instance); await sleep(3)
    FWS.instance.emit('message', { data: JSON.stringify({ op: OP.INVALID_SESSION, d: false }) })
    await sleep(5)
    eq(gw.reconnectAttempts, 0, 'INVALID_SESSION 后不立即重连（等 close 码以决定是否降级）')
    eq(gw.sessionId, null, 'INVALID_SESSION 清 session')
    FWS.instance.emit('close', { code: 4013 })
    await sleep(3)
    eq(gw.reconnectAttempts, 1, '随后真实 close 4013 触发一次降级重连')
    gw.stop()
  }

  // 取 token 失败：网络类可重试（退避重连），鉴权类停止
  {
    const FWS = makeFake()
    let tokenCalls = 0
    const gw = new QQBotGateway({
      appId: 'A', appSecret: 'S',
      // 第一次 connect 取 token 成功（建 WS），HELLO 后 IDENTIFY 再取 token 时失败
      getToken: async () => { tokenCalls++; if (tokenCalls === 1) return 'T'; throw new Error('网络错误：ECONNRESET') },
      getGatewayUrl: async () => 'wss://gw', WebSocketImpl: FWS, reconnectDelays: [5],
    })
    await gw.start(); await sleep(5); hello(FWS.instance); await sleep(10)
    ok(gw.reconnectAttempts >= 1, '取 token 网络失败 → 继续退避重连（不再一次性判死）')
    ok(gw.status().state !== 'closed', '网络失败不进入 closed/auth_failed')
    gw.stop()
  }
  {
    const FWS = makeFake()
    let authCalls = 0
    const gw = new QQBotGateway({
      appId: 'A', appSecret: 'S',
      getToken: async () => { authCalls++; if (authCalls === 1) return 'T'; throw new Error('获取 access_token 失败（HTTP 401）：AppID/AppSecret 不匹配') },
      getGatewayUrl: async () => 'wss://gw', WebSocketImpl: FWS, reconnectDelays: [5],
    })
    await gw.start(); await sleep(5); hello(FWS.instance); await sleep(10)
    eq(gw.status().state, 'closed', '鉴权类 token 失败 → 停止重连')
    eq(gw.status().reason, 'auth_failed', '状态 reason=auth_failed')
    eq(gw.reconnectAttempts, 0, '鉴权失败不排重连')
    gw.stop()
  }

  // 关闭码提示表覆盖 4013/4914
  ok(CLOSE_CODE_HINT[4013].includes('intents'), '4013 有中文说明')
  ok(CLOSE_CODE_HINT[4914].includes('intents'), '4914 有中文说明')
}

console.log('\n[4] events：事件归一化')
{
  const g = normalizeEvent(GATEWAY_EVENTS.GROUP_AT_MESSAGE_CREATE, {
    id: 'm1', content: '你好', timestamp: '2026-10-29T10:00:00+08:00', group_openid: 'GO', author: { member_openid: 'MO', username: '小明' },
    mentions: [{ id: 'A' }], attachments: [{ content_type: 'image/png', url: 'https://x/1.png', filename: 'a.png', size: 12 }],
  }, { appId: 'A' })
  eq([g.type, g.scene, g.userId, g.groupOpenid, g.username], ['message', 'group', 'MO', 'GO', '小明'], '群 @ 消息归一化')
  eq(g.attachments[0].url, 'https://x/1.png', '附件保留 url')

  eq(g.atBot, true, 'GROUP_AT_MESSAGE_CREATE → atBot=true（必然被 @）')
  eq(g.eventName, 'GROUP_AT_MESSAGE_CREATE', '保留事件名（排障用）')

  // 全量消息权限下的普通群消息：不能当 @（否则 trigger=at 会回复所有群聊）
  const plain = normalizeEvent(GATEWAY_EVENTS.GROUP_MESSAGE_CREATE, {
    id: 'm1b', content: '随便聊聊', group_openid: 'GO', author: { member_openid: 'MO' }, mentions: [],
  }, { appId: 'A' })
  eq(plain.atBot, false, 'GROUP_MESSAGE_CREATE 无 mention → atBot=false')

  const mentioned = normalizeEvent(GATEWAY_EVENTS.GROUP_MESSAGE_CREATE, {
    id: 'm1c', content: '艾特你', group_openid: 'GO', author: { member_openid: 'MO' },
    mentions: [{ is_you: true, id: 'BOT' }],
  }, { appId: 'A' })
  eq(mentioned.atBot, true, 'GROUP_MESSAGE_CREATE mentions.is_you → atBot=true')

  // mentionsBot 单元
  ok(mentionsBot([{ is_you: true }], 'A'), 'is_you=true 判定为提及机器人')
  ok(mentionsBot([{ id: 'A' }], 'A'), 'mention.id 等于 appId 也判 true')
  ok(!mentionsBot([{ id: 'someone' }], 'A'), '提及他人不算')
  ok(!mentionsBot([], 'A') && !mentionsBot(null, 'A'), '空/缺失 mentions 安全返回 false')

  const c2c = normalizeEvent(GATEWAY_EVENTS.C2C_MESSAGE_CREATE, { id: 'm2', content: 'hi', author: { user_openid: 'UO' } }, { appId: 'A' })
  eq([c2c.scene, c2c.userId, c2c.groupOpenid, c2c.atBot], ['c2c', 'UO', null, false], 'C2C 归一化（私聊无需 at）')

  const guild = normalizeEvent(GATEWAY_EVENTS.AT_MESSAGE_CREATE, { id: 'm3', content: 'hi', guild_id: 'G', channel_id: 'C', author: { id: 'U', username: 'u' } }, { appId: 'A' })
  eq([guild.scene, guild.guildId, guild.channelId, guild.userId], ['guild', 'G', 'C', 'U'], '频道消息归一化')

  const dm = normalizeEvent(GATEWAY_EVENTS.DIRECT_MESSAGE_CREATE, { id: 'm4', content: 'hi', guild_id: 'G', author: { id: 'U' } }, { appId: 'A' })
  eq([dm.scene, dm.guildId, dm.atBot], ['guild_dm', 'G', false], '频道私信归一化（私聊无需 at）')
  eq(guild.atBot, true, '频道 AT_MESSAGE_CREATE → atBot=true')

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
  eq(jobs2[0].payload.markdown.content, '# 标题\n<qqbot-at-user id="A" />', 'markdown 内容 + at 段转 mention 标签（@回复人不再丢失）')
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
  // at → Markdown mention 标签（QQ 群默认走 Markdown 直发，不转就丢 @）
  eq(markdownMentionTags(['A'], 'APP'), ['<qqbot-at-user id="A" />'], '普通 at → qqbot-at-user 标签')
  eq(markdownMentionTags(['APP:UO'], 'APP'), ['<qqbot-at-user id="UO" />'], '剥掉 <appId>: 前缀还原 openid')
  eq(markdownMentionTags(['all'], 'APP'), ['<qqbot-at-everyone />'], '@全体 → qqbot-at-everyone')
  eq(markdownMentionTags(['A', 'A', '', 'all', 'all'], ''), ['<qqbot-at-user id="A" />', '<qqbot-at-everyone />'], '去重且跳过空值')
  eq(markdownMentionTags([], 'APP'), [], '无 at → 空数组')
  // 脏/恶意 at 值不能破坏 Markdown 结构
  eq(markdownMentionTags(['APP:UO"><script>'], 'APP'), ['<qqbot-at-user id="UOscript" />'], '非法字符被清洗（防标签注入）')
  eq(markdownMentionTags(['"\'><>', '  '], 'APP'), [], '只剩非法字符的 at 被丢弃')
  const jobsAt = buildMessageJobs([{ type: 'at', qq: 'APP:UO' }, { type: 'markdown', data: '**结果**' }], { appId: 'APP' })
  ok(jobsAt[0].payload.markdown.content.includes('<qqbot-at-user id="UO" />'), 'buildMessageJobs 把 at 拼进 markdown')
  const jobsAtDup = buildMessageJobs([{ type: 'at', qq: 'UO' }, { type: 'markdown', data: 'hi <qqbot-at-user id="UO" />' }], { appId: 'APP' })
  eq(jobsAtDup[0].payload.markdown.content, 'hi <qqbot-at-user id="UO" />', '内容已手动含标签时不重复追加')
  const jobsTpl = buildMessageJobs([{ type: 'at', qq: 'UO' }, { type: 'markdown', data: 'x' }], { appId: 'APP', templateId: 'tpl' })
  ok(!JSON.stringify(jobsTpl[0].payload).includes('qqbot-at-user'), '模板消息不塞自定义 mention（平台不支持）')
  // 纯文本消息不支持 at 段：内容保持原文，不拼标签
  const jobsTextAt = buildMessageJobs([{ type: 'at', qq: 'UO' }, { type: 'text', text: 'hi' }], { appId: 'APP' })
  eq(jobsTextAt[0].payload, { content: 'hi' }, '文本模式不拼 at（官方文本消息不支持 at 段）')

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


  // start 阶段 token 网络抖动：短退避重试，避免一次抖动账号永远起不来
  {
    class FWS2 { constructor() { this.listeners = {}; setTimeout(() => this.emit('open', {}), 0) } addEventListener(n, fn) { (this.listeners[n] ||= []).push(fn) } emit(n, ev) { for (const fn of this.listeners[n] || []) fn(ev) } send() {} close() {} }
    let tokenAttempts = 0
    const flaky = makeFetchStub(({ url }) => {
      if (String(url).includes('getAppAccessToken')) {
        tokenAttempts++
        if (tokenAttempts < 3) return { status: 503, body: 'upstream busy' }
        return { body: { access_token: 'T', expires_in: 7200 } }
      }
      if (String(url).includes('/gateway')) return { body: { url: 'wss://gw' } }
      return { body: {} }
    })
    const cRetry = new QQBotClient({ appId: 'A', appSecret: 'S', fetchImpl: flaky, WebSocketImpl: FWS2, logger: () => {} })
    await cRetry.start()
    eq(tokenAttempts, 3, 'start 阶段 token 5xx 自动重试（第 3 次成功）')
    cRetry.stop()
  }
  {
    class FWS3 { constructor() { this.listeners = {}; setTimeout(() => this.emit('open', {}), 0) } addEventListener(n, fn) { (this.listeners[n] ||= []).push(fn) } emit(n, ev) { for (const fn of this.listeners[n] || []) fn(ev) } send() {} close() {} }
    let authAttempts = 0
    const authBad = makeFetchStub(({ url }) => {
      if (String(url).includes('getAppAccessToken')) { authAttempts++; return { status: 401, body: { code: 100016, message: 'invalid appid or secret' } } }
      if (String(url).includes('/gateway')) return { body: { url: 'wss://gw' } }
      return { body: {} }
    })
    const cAuth = new QQBotClient({ appId: 'A', appSecret: 'S', fetchImpl: authBad, WebSocketImpl: FWS3, logger: () => {} })
    let err = null
    try { await cAuth.start() } catch (e) { err = e }
    // 鉴权错误只在「token 端点回退」里各试一次（最多 2 个端点），不进入 3 次退避重试
    ok(err && authAttempts <= 2, `鉴权错误快速失败（不进入退避重试，实际请求 ${authAttempts} 次）`)
  }

  // 401：token 被提前失效 → 清缓存重取并重试一次
  {
    let tokenCalls = 0
    let msgCalls = 0
    const fetch401 = makeFetchStub(({ url }) => {
      if (url.includes('getAppAccessToken')) { tokenCalls++; return { body: { access_token: 'T' + tokenCalls, expires_in: 7200 } } }
      if (url.includes('/files')) return { body: { file_info: 'FI' } }
      if (url.includes('/gateway')) return { body: { url: 'wss://gw' } }
      msgCalls++
      if (msgCalls === 1) return { status: 401, body: { code: 11244, message: 'invalid token' } }
      return { body: { id: 'MID_OK' } }
    })
    const c401 = new QQBotClient({ appId: 'A', appSecret: 'S', fetchImpl: fetch401, logger: () => {} })
    const r = await c401.send('group', 'GO', 'hi')
    eq(r.message_id, ['MID_OK'], '401 时自动刷新 token 后重试成功')
    eq(tokenCalls, 2, 'token 被清缓存并重新获取')
    c401.stop()
  }

  // Markdown mention：@ 段转 <qqbot-at-user/>
  {
    const requests2 = []
    const fetchMd = makeFetchStub(({ url, body }) => {
      requests2.push({ url: String(url), body })
      if (String(url).includes('getAppAccessToken')) return { body: { access_token: 'T', expires_in: 7200 } }
      if (String(url).includes('/gateway')) return { body: { url: 'wss://gw' } }
      return { body: { id: 'M1' } }
    })
    const cMd = new QQBotClient({ appId: 'APP', appSecret: 'S', fetchImpl: fetchMd, logger: () => {} })
    await cMd.send('group', 'GO', [{ type: 'at', qq: 'APP:UO' }, { type: 'markdown', data: '# 结果' }])
    const sent = requests2.filter((r) => r.url.includes('/v2/groups/GO/messages')).pop()
    ok(sent.body.markdown.content.includes('<qqbot-at-user id="UO" />'), 'Markdown 消息里 @ 回复人（剥 appId 前缀）')
    ok(sent.body.msg_type === 2, '仍以 msg_type=2 发送')
    cMd.stop()
  }

  // 富媒体体积守卫：超过 10MB 的 base64 直接跳过（不发上传请求）
  {
    const requests3 = []
    const fetchBig = makeFetchStub(({ url }) => {
      requests3.push(String(url))
      if (String(url).includes('getAppAccessToken')) return { body: { access_token: 'T', expires_in: 7200 } }
      if (String(url).includes('/files')) return { body: { file_info: 'FI' } }
      if (String(url).includes('/gateway')) return { body: { url: 'wss://gw' } }
      return { body: { id: 'M' } }
    })
    const cBig = new QQBotClient({ appId: 'A', appSecret: 'S', fetchImpl: fetchBig, logger: () => {} })
    const huge = 'base64://' + 'A'.repeat(14 * 1024 * 1024) // ≈10.5MB 原始字节
    const r = await cBig.send('group', 'GO', [{ type: 'image', file: huge }])
    eq(r.message_id, [], '超大媒体跳过（不返回消息 id）')
    ok(!requests3.some((u) => u.includes('/files')), '超大媒体不发起上传请求')
    cBig.stop()
  }

  ok(/标题/.test(markdownToPlain('# 标题\n**加粗**')), 'markdownToPlain 去标记')
  eq(QQBotClient.splitMarkdown('x'.repeat(100), 50).length, 2, '静态分片方法可用')

  client.stop()
}

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
