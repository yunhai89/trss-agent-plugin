/**
 * Stagehand 可靠性回归 —— 身份隔离 / 容量 / 生命周期 / 串行 / 取消 / SDK schema / 审批链。
 * 运行：node model/stagehand/regression.test.mjs
 *
 * 全部离线：浏览器用注入 launcher 的 fake context/stagehand；LLM 用 mock fetch。
 * schema 段走真实 SDK 序列化路径（Zod 4 的 toJSONSchema，与 Stagehand.extract 内部一致）。
 */
import { SessionManager } from './session.js'
import { makeGenerate } from './llm.js'
import { makeStagehand, jsonSchemaToZod } from './index.js'
import { compileDomainPolicy, assertUrlAllowed, parseLooseIPv4, isPrivateIp } from './guard.js'
import { ok } from '../toolkit/index.js'
import { Agent, ToolRegistry, ConfirmStore } from '../agent/index.js'
import { createPolicy } from '../agent/policy.js'

let passed = 0
let failed = 0
function ok_(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { ok_(JSON.stringify(a) === JSON.stringify(b), `${m}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 4).join('\n')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 构造 fake 浏览器环境（可注入行为与观测点） */
function makeEnv(over = {}) {
  const state = { launched: 0, browserClosed: 0, shClosed: 0, policyCalls: [], initScriptCalls: [], gotos: [] }
  const launcher = async () => {
    state.launched++
    const page = {
      goto: async (url) => { state.gotos.push(url); return { status: () => 200, url: () => url } },
      title: async () => 'Fake Title',
      url: async () => 'about:blank',
      evaluate: async () => '',
    }
    const context = {
      pages: async () => [page],
      activePage: async () => page,
      newPage: async () => page,
      addInitScript: async (s) => { state.initScriptCalls.push(s) },
      setDomainPolicy: async (pol) => { state.policyCalls.push(pol); if (over.onPolicy) over.onPolicy(pol) },
    }
    const stagehand = {
      browser: { context },
      observe: over.observe || (async () => ({ data: [{ selector: '#a', description: 'x' }], metadata: { usage: {} } })),
      extract: over.extract || (async () => ({ data: { a: 1 }, metadata: {} })),
      act: over.act || (async () => ({ data: { success: true, message: 'ok', actionDescription: 'd', actions: [] }, metadata: {} })),
      close: async () => { state.shClosed++ },
    }
    return { browser: {}, close: async () => { state.browserClosed++ }, stagehand, context }
  }
  return { launcher, state }
}

// ───────────────────────── 身份隔离 ─────────────────────────
await test('身份隔离：不同 机器人/群/用户/对话 → 不同会话；同身份复用', async () => {
  const { launcher, state } = makeEnv()
  const { pack, sessionMgr } = makeStagehand({ cfg: { permission: 'all', idleTimeoutMs: 60000, maxSessions: 10 }, agent: {}, launcher })
  const goto = pack.resolve({}).find((t) => t.name === 'stagehand__goto')
  const base = { selfId: 'bot1', userId: 'u1', conversationId: 'c1' }
  await goto.execute({ url: 'http://93.184.216.34/' }, base)
  await goto.execute({ url: 'http://93.184.216.34/' }, base)
  eq(sessionMgr.size(), 1, '同身份复用 1 个会话')
  await goto.execute({ url: 'http://93.184.216.34/' }, { ...base, conversationId: 'c2' })
  await goto.execute({ url: 'http://93.184.216.34/' }, { ...base, userId: 'u2' })
  await goto.execute({ url: 'http://93.184.216.34/' }, { ...base, selfId: 'bot2' })
  await goto.execute({ url: 'http://93.184.216.34/' }, { ...base, isGroup: true, groupId: 'g1' })
  eq(sessionMgr.size(), 5, '切换对话/用户/机器人/群各得独立会话')
  eq(state.launched, 5, '启动 5 次')
  await sessionMgr.closeAll()
})

await test('身份隔离：缺少机器人/用户标识 → 拒绝且不启动浏览器', async () => {
  const { launcher, state } = makeEnv()
  const { pack, sessionMgr } = makeStagehand({ cfg: { permission: 'all' }, agent: {}, launcher })
  const goto = pack.resolve({}).find((t) => t.name === 'stagehand__goto')
  const r1 = await goto.execute({ url: 'http://93.184.216.34/' }, { userId: 'u1' }) // 缺 bot
  eq(r1.ok, false, '缺机器人标识被拒')
  eq(r1.errorClass, 'identity_missing', '错误类别 identity_missing')
  const r2 = await goto.execute({ url: 'http://93.184.216.34/' }, { selfId: 'bot1' }) // 缺 user
  eq(r2.ok, false, '缺用户标识被拒')
  eq(state.launched, 0, '未启动任何浏览器')
  await sessionMgr.closeAll()
})

await test('限流绑定机器人+操作者：切换对话不能重置配额', async () => {
  const { launcher } = makeEnv()
  const { pack, sessionMgr } = makeStagehand({ cfg: { permission: 'all', maxCallsPerMinute: 1 }, agent: {}, launcher })
  const goto = pack.resolve({}).find((t) => t.name === 'stagehand__goto')
  const ctx = { selfId: 'bot1', userId: 'u1', conversationId: 'c1' }
  const r1 = await goto.execute({ url: 'http://93.184.216.34/' }, ctx)
  eq(r1.ok, true, '第一次成功')
  const r2 = await goto.execute({ url: 'http://93.184.216.34/' }, { ...ctx, conversationId: 'c2' })
  eq(r2.ok, false, '切换对话仍受限流')
  eq(r2.errorClass, 'rate_limited', 'rate_limited')
  await sessionMgr.closeAll()
})

// ───────────────────────── 容量 / 并发 ─────────────────────────
await test('容量：启动中即占位（含启动/关闭中），并发超卖被拒', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const { launcher } = makeEnv()
  const slow = async () => { await gate; return launcher() }
  const sm = new SessionManager({ cfg: { maxSessions: 1, idleTimeoutMs: 60000 }, launcher: slow })
  const p1 = sm.acquire('k1')
  await sleep(10)
  eq(sm.capacityUsed, 1, '启动中已占容量')
  let rejected = false
  try { await sm.acquire('k2') } catch (e) { rejected = e.code === 'max_sessions' }
  ok_(rejected, '并发第二个 key 因容量被拒')
  release()
  await p1
  eq(sm.capacityUsed, 1, '启动完成后容量=1')
  await sm.closeAll()
  eq(sm.capacityUsed, 0, 'closeAll 后容量=0')
})

await test('同 key 并发 acquire 去重（单次启动）', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const { launcher, state } = makeEnv()
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 60000 }, launcher: async () => { await gate; return launcher() } })
  const p1 = sm.acquire('same')
  const p2 = sm.acquire('same')
  release()
  const [e1, e2] = await Promise.all([p1, p2])
  ok_(e1 === e2, '同 key 返回同一 entry')
  eq(state.launched, 1, '只启动一次')
  await sm.closeAll()
})

// ───────────────────────── 生命周期 ─────────────────────────
await test('初始化失败：回收已获得的 stagehand 与浏览器', async () => {
  const { launcher, state } = makeEnv()
  const broken = async () => {
    const env = await launcher()
    env.context.pages = async () => []
    env.context.activePage = async () => null
    env.context.newPage = async () => null
    return env
  }
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 60000 }, launcher: broken })
  let threw = false
  try { await sm.acquire('k') } catch { threw = true }
  ok_(threw, '无可用页面时启动失败')
  eq(sm.size(), 0, '未注册会话')
  eq(state.shClosed, 1, 'stagehand 已关闭')
  eq(state.browserClosed, 1, '底层浏览器已关闭')
  eq(sm.capacityUsed, 0, '容量已释放')
})

await test('访问策略安装失败：中止初始化并清理资源', async () => {
  const { launcher, state } = makeEnv({ onPolicy: () => { throw new Error('policy boom') } })
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 60000 }, launcher })
  let msg = ''
  try { await sm.acquire('k') } catch (e) { msg = e.message }
  ok_(/policy boom/.test(msg), '策略失败向上传播')
  eq(sm.size(), 0, '未注册会话')
  eq(state.shClosed, 1, 'stagehand 已清理')
  eq(state.browserClosed, 1, '浏览器已清理')
})

await test('关闭期间迟到启动：不注册会话、资源被清理、acquire 被拒', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const { launcher, state } = makeEnv()
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 60000 }, launcher: async () => { await gate; return launcher() } })
  const p = sm.acquire('late')
  await sleep(5)
  const closing = sm.closeAll()
  release()
  let rejected = false
  try { await p } catch { rejected = true }
  await closing
  ok_(rejected, '迟到 acquire 被拒')
  eq(sm.size(), 0, '迟到初始化未注册会话')
  ok_(sm.closed === true, 'closeAll 后管理器永久关闭')
  let again = false
  try { await sm.acquire('x') } catch (e) { again = e.code === 'manager_closed' }
  ok_(again, '关闭后 acquire 一律拒绝')
  eq(state.browserClosed, 1, '迟到资源已关闭')
})

await test('closeAll 幂等且等待在途', async () => {
  const { launcher } = makeEnv()
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 60000 }, launcher })
  await sm.acquire('a')
  await Promise.all([sm.closeAll(), sm.closeAll()])
  eq(sm.size(), 0, 'closeAll 幂等')
})

// ───────────────────────── 串行 / 并行 / idle ─────────────────────────
await test('同会话串行、不同会话并行', async () => {
  const { launcher } = makeEnv()
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 60000 }, launcher })
  await sm.acquire('s1')
  await sm.acquire('s2')
  const order = []
  let releaseA
  const gateA = new Promise((r) => { releaseA = r })
  const opA = sm.run('s1', async () => { order.push('a-start'); await gateA; order.push('a-end'); return 'a' })
  const opB = sm.run('s1', async () => { order.push('b'); return 'b' })
  const opC = sm.run('s2', async () => { order.push('c'); return 'c' })
  await sleep(10)
  ok_(order.includes('a-start'), 'a 已开始')
  ok_(!order.includes('b'), '同会话 b 未插队（等待 a）')
  ok_(order.includes('c'), '不同会话 c 并行执行')
  releaseA()
  await Promise.all([opA, opB, opC])
  eq(order, ['a-start', 'c', 'a-end', 'b'], '同会话严格串行、跨会话并行')
  await sm.closeAll()
})

await test('执行中的任务不被 idle 回收；idle 从操作结束后起算', async () => {
  const { launcher } = makeEnv()
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 80 }, launcher })
  await sm.acquire('k')
  const p = sm.run('k', async () => { await sleep(200); return 'done' })
  await sleep(140) // 超过 idleTimeout，但操作仍在执行
  eq(sm.size(), 1, '执行中不被 idle 回收')
  await p
  eq(sm.size(), 1, '操作刚结束仍在')
  await sleep(160)
  eq(sm.size(), 0, '操作结束后 idle 到期关闭')
})

await test('排队取消：不关前序浏览器、不使后序插队', async () => {
  const { launcher, state } = makeEnv()
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 60000 }, launcher })
  await sm.acquire('k')
  const order = []
  let releaseA
  const gateA = new Promise((r) => { releaseA = r })
  const ctl = new AbortController()
  const opA = sm.run('k', async () => { order.push('a-start'); await gateA; order.push('a-end'); return 'a' })
  const opB = sm.run('k', async () => { order.push('b'); return 'b' }, { signal: ctl.signal })
  const opC = sm.run('k', async () => { order.push('c'); return 'c' })
  await sleep(10)
  ctl.abort() // 取消排队中的 b
  let bCancelled = false
  opB.catch((e) => { bCancelled = e.name === 'AbortError' || /取消/.test(e.message) })
  releaseA()
  await Promise.all([opA, opC])
  await sleep(10)
  ok_(bCancelled, 'b 被取消')
  eq(order, ['a-start', 'a-end', 'c'], 'b 未执行且未插队，c 在前序之后')
  eq(state.browserClosed, 0, '排队取消不关闭前序正在使用的浏览器')
  eq(sm.size(), 1, '会话仍在')
  await sm.closeAll()
})

await test('运行超时：拒绝迟到结果并清理会话', async () => {
  const { launcher, state } = makeEnv()
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 60000 }, launcher, opTimeoutMs: 60 })
  await sm.acquire('k')
  let timedOut = false
  const p = sm.run('k', async () => { await sleep(400); return 'late' })
  p.catch((e) => { timedOut = /超时/.test(e.message) })
  const t0 = Date.now()
  await p.catch(() => {})
  const dt = Date.now() - t0
  ok_(timedOut, '超时被拒绝')
  ok_(dt < 300, `及时拒绝（${dt}ms）而非等待迟到结果`)
  await sleep(30)
  eq(sm.size(), 0, '超时后会话进入清理')
  eq(state.browserClosed, 1, '底层浏览器被关闭')
})

await test('运行取消（ctx.signal）：拒绝并清理', async () => {
  const { launcher } = makeEnv()
  const sm = new SessionManager({ cfg: { idleTimeoutMs: 60000 }, launcher, opTimeoutMs: 5000 })
  await sm.acquire('k')
  const ctl = new AbortController()
  const p = sm.run('k', async () => { await sleep(400); return 'late' }, { signal: ctl.signal })
  setTimeout(() => ctl.abort(), 20)
  let aborted = false
  await p.catch((e) => { aborted = e.name === 'AbortError' })
  ok_(aborted, '取消被拒绝')
  await sm.closeAll()
})

// ───────────────────────── 返回契约 ─────────────────────────
await test('ok()：数组/原始值不展开为数字键', async () => {
  eq(ok([1, 2, 3]), { ok: true, data: [1, 2, 3] }, '数组收进 data')
  eq(ok(5), { ok: true, data: 5 }, '数字收进 data')
  eq(ok('hi'), { ok: true, content: 'hi' }, '字符串走 content')
  eq(ok({ url: 'u', title: 't' }), { ok: true, url: 'u', title: 't' }, '对象展开')
  ok_(!('0' in ok([1, 2])), '无数字键')
})

await test('工具返回契约：goto/observe/extract/act', async () => {
  const { launcher } = makeEnv()
  const { pack, sessionMgr } = makeStagehand({ cfg: { permission: 'all', idleTimeoutMs: 60000 }, agent: {}, launcher })
  const tools = Object.fromEntries(pack.resolve({}).map((t) => [t.name, t]))
  const ctx = { selfId: 'bot1', userId: 'u1', conversationId: 'c1' }
  const g = await tools['stagehand__goto'].execute({ url: 'http://93.184.216.34/' }, ctx)
  eq(g.ok, true, 'goto 成功')
  eq(g.data.url, 'http://93.184.216.34/', 'goto 结果在 data.url')
  eq(g.data.title, 'Fake Title', 'goto 结果在 data.title')
  eq(g.data.status, 200, 'goto 结果含 status')
  const o = await tools['stagehand__observe'].execute({}, ctx)
  ok_(Array.isArray(o.data), 'observe data 是数组（未丢进数字键）')
  eq(o.data[0].selector, '#a', 'observe 元素正确')
  const e = await tools['stagehand__extract'].execute({ instruction: 'x', schema: '{"type":"object","properties":{"a":{"type":"integer"}},"required":["a"]}' }, ctx)
  eq(e.data.a, 1, 'extract 结果在 data')
  const a = await tools['stagehand__act'].execute({ instruction: 'click' }, ctx)
  eq(a.ok, true, 'act success===true 才算成功')
  eq(a.data.success, true, 'act data 含 success')
  await sessionMgr.closeAll()
})

await test('act 失败：success:false → ok:false 且不谎报成功', async () => {
  const { launcher } = makeEnv({ act: async () => ({ data: { success: false, message: 'element not found', actionDescription: 'd', actions: [] }, metadata: {} }) })
  const { pack, sessionMgr } = makeStagehand({ cfg: { permission: 'all', idleTimeoutMs: 60000 }, agent: {}, launcher })
  const tools = Object.fromEntries(pack.resolve({}).map((t) => [t.name, t]))
  const ctx = { selfId: 'bot1', userId: 'u1', conversationId: 'c1' }
  await tools['stagehand__goto'].execute({ url: 'http://93.184.216.34/' }, ctx)
  const a = await tools['stagehand__act'].execute({ instruction: 'click' }, ctx)
  eq(a.ok, false, 'act 失败返回 ok:false')
  eq(a.errorClass, 'act_failed', 'errorClass=act_failed')
  ok_(/element not found/.test(a.error), '保留 SDK 失败原因')
  await sessionMgr.closeAll()
})

// ───────────────────────── SDK schema 序列化 ─────────────────────────
await test('真实 SDK schema 路径：Zod 4 toJSONSchema 不报 def；Zod 3 会报（根因）', async () => {
  const z4 = await import('zod-stagehand')
  const schema = { type: 'object', properties: { title: { type: 'string' }, n: { type: 'integer', minimum: 1, maximum: 9 }, k: { type: 'string', enum: ['a', 'b'] }, opt: { type: ['string', 'null'] } }, required: ['title', 'n'] }
  const zs = jsonSchemaToZod(schema)
  let out
  try { out = z4.toJSONSchema(zs) } catch (e) { failed++; console.error('  ✗ FAIL Zod4 序列化失败', e.message); return }
  ok_(out.properties.n.type === 'integer', 'integer 语义保留')
  eq(out.properties.k.enum, ['a', 'b'], 'enum 语义保留')
  eq([...out.required].sort(), ['n', 'title'], 'required 语义保留')
  ok_(JSON.stringify(out.properties.opt).includes('null'), 'nullable 语义保留')
  ok_(out.properties.n.minimum === 1 && out.properties.n.maximum === 9, '数值边界保留')
  // 根因：Zod 3 schema 走同一路径会崩（Cannot read properties of undefined (reading 'def')）
  const z3 = await import('zod')
  let z3err = ''
  try { z4.toJSONSchema(z3.z.object({ a: z3.z.string() })) } catch (e) { z3err = e.message }
  ok_(/def/.test(z3err), 'Zod3 传入 SDK 序列化路径确会失败（证明必须用 Zod4）')
})

await test('schema 限制与不支持结构：明确报错，不静默丢约束', async () => {
  let msg = ''
  try { jsonSchemaToZod({ type: 'weird' }) } catch (e) { msg = e.message }
  ok_(/不支持/.test(msg), '未知 type 明确报错')
  msg = ''
  try { jsonSchemaToZod({ $ref: '#/x' }) } catch (e) { msg = e.message }
  ok_(/不支持/.test(msg), '$ref 明确报错')
  msg = ''
  try { jsonSchemaToZod({ type: 'object', properties: { a: { type: 'string' } } }, { maxDepth: 0 }) } catch (e) { msg = e.message }
  ok_(/深/.test(msg), '深度限制报错')
  msg = ''
  try { jsonSchemaToZod({ type: 'object', properties: { a: { type: 'string' } } }, { maxKeys: 0 }) } catch (e) { msg = e.message }
  ok_(/属性过多/.test(msg), '属性数量限制报错')
  msg = ''
  try { jsonSchemaToZod({ type: 'object', properties: { a: { type: 'string' } } }, { maxBytes: 5 }) } catch (e) { msg = e.message }
  ok_(/过大/.test(msg), '体积限制报错')
})

// ───────────────────────── 访问策略 ─────────────────────────
await test('域名策略编译：精确域名+子域通配；IPv4 字面量；不可表达项单列', async () => {
  const { blockedDomains, unrepresentable } = compileDomainPolicy(['example.com', '127.0.0.1', 'localhost', '::1', '10.0.0.0/8', '169.254.169.254'])
  ok_(blockedDomains.includes('example.com') && blockedDomains.includes('*.example.com'), '精确域名+子域通配')
  ok_(blockedDomains.includes('127.0.0.1') && blockedDomains.includes('169.254.169.254'), 'IPv4 字面量可表达')
  ok_(unrepresentable.includes('localhost') && unrepresentable.includes('::1') && unrepresentable.includes('10.0.0.0/8'), '单标签/IPv6/CIDR 归入不可表达')
})

await test('SSRF 增强：混淆 IPv4 / 尾点 / 空 DNS / 取消', async () => {
  eq(parseLooseIPv4('2130706433'), '127.0.0.1', '整数 IPv4 归一')
  eq(parseLooseIPv4('0x7f000001'), '127.0.0.1', '十六进制 IPv4 归一')
  eq(parseLooseIPv4('127.1'), '127.0.0.1', '少段 IPv4 归一')
  ok_(isPrivateIp('::ffff:127.0.0.1'), '映射 IPv4 判私有')
  ok_(isPrivateIp('64:ff9b::7f00:1'), 'NAT64 映射判私有')
  ok_(!isPrivateIp('2606:4700:4700::1111'), '公网 IPv6 放行')
  const pub = async () => [{ address: '93.184.216.34', family: 4 }]
  eq((await assertUrlAllowed('http://2130706433/', { lookup: pub })).ok, false, '整数混淆环回拒绝')
  eq((await assertUrlAllowed('http://example.com./', { lookup: async () => { throw new Error('ENOTFOUND') } })).ok, false, '尾点域名解析失败拒绝')
  eq((await assertUrlAllowed('http://empty.test/', { lookup: async () => [] })).ok, false, '空 DNS 结果拒绝')
  const ctl = new AbortController(); ctl.abort()
  eq((await assertUrlAllowed('http://slow.test/', { lookup: async () => { await sleep(50); return pub() }, signal: ctl.signal })).ok, false, '已取消拒绝')
  eq((await assertUrlAllowed('http://user:pass@127.0.0.1/', { lookup: pub })).ok, false, '内嵌凭据仍按 host 拒绝')
})

// ───────────────────────── LLM ─────────────────────────
await test('LLM：复用代理 fetch + 保留 usage + 响应体读取超时 + 不泄露 key', async () => {
  let usedFetch = null
  const proxyFetch = async (url, opt) => {
    usedFetch = { url, opt }
    return {
      ok: true, status: 200,
      async json() { return { choices: [{ message: { content: '{"x":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } },
      async text() { return '' },
    }
  }
  const gen = makeGenerate({ apiKey: 'sk-secret', baseURL: 'https://api.test/v1', model: 'm', fetch: proxyFetch })
  const out = await gen({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], responseFormat: { type: 'json_schema', name: 'r', schema: { type: 'object' } } })
  ok_(usedFetch && usedFetch.url === 'https://api.test/v1/chat/completions', '使用注入的代理 fetch')
  eq(out.usage.inputTokens, 10, 'usage 保留（input）')
  eq(out.usage.outputTokens, 5, 'usage 保留（output）')
  eq(out.structuredContent.x, 1, '结构化内容解析')
  // 错误脱敏
  const badFetch = async () => ({ ok: false, status: 500, async text() { return 'boom sk-secret' } })
  let emsg = ''
  try { await makeGenerate({ apiKey: 'sk-secret', baseURL: 'https://api.test/v1', model: 'm', fetch: badFetch })({ messages: [], responseFormat: { type: 'json_schema', name: 'r', schema: {} } }) } catch (e) { emsg = e.message }
  ok_(!emsg.includes('sk-secret') && emsg.includes('***'), '错误信息脱敏 apiKey')
  // 响应体读取超时（headers 立即返回，body 永不结束）
  const hangFetch = async (url, opt) => ({
    ok: true, status: 200,
    json: () => new Promise((_res, rej) => { opt.signal?.addEventListener('abort', () => rej(new Error('aborted'))) }),
    text: async () => '',
  })
  let tmsg = ''
  const t0 = Date.now()
  try { await makeGenerate({ apiKey: 'sk', baseURL: 'https://api.test/v1', model: 'm', fetch: hangFetch, timeoutMs: 60 })({ messages: [], responseFormat: { type: 'json_schema', name: 'r', schema: {} } }) } catch (e) { tmsg = e.message }
  ok_(/超时|取消/.test(tmsg), '响应体读取超时被拒绝')
  ok_(Date.now() - t0 < 400, '截止时间覆盖响应体读取')
})

// ───────────────────────── 真实审批链 ─────────────────────────
const reply = (content = 'done') => ({ role: 'assistant', content, toolCalls: [], finishReason: 'stop' })
const call = (name, id, args = {}) => ({ id, name, arguments: args })

await test('真实审批链：act 经 ConfirmStore 批准后执行，tool-call/result 配对', async () => {
  const { launcher, state } = makeEnv()
  const { pack, sessionMgr } = makeStagehand({ cfg: { permission: 'all', idleTimeoutMs: 60000 }, agent: {}, launcher })
  const registry = new ToolRegistry()
  for (const t of pack.resolve({})) registry.register(t)
  const confirm = new ConfirmStore({ timeout: 1000 })
  let turn = 0
  const provider = { async chat() {
    if (turn++) return reply()
    return { ...reply(''), toolCalls: [call('stagehand__goto', 'g1', { url: 'http://93.184.216.34/' }), call('stagehand__act', 'a1', { instruction: 'click login' })], finishReason: 'tool_calls' }
  } }
  const agent = new Agent({ provider, tools: registry, confirm, policy: createPolicy(), reflect: 'off', governor: false })
  const ctx = { selfId: 'bot1', userId: 'u1', conversationId: 'c1', role: 'master', isMaster: true, notify: (id) => confirm.resolve(id, true) }
  await agent.run('打开并点击登录', { ctx, maxTurns: 3 })
  // goto 与 act 都执行；act 需要审批但被 notify 批准
  eq(state.gotos.length, 1, 'goto 执行一次')
  const actMsgs = agent.messages.filter((m) => m.role === 'tool' && m.name === 'stagehand__act')
  ok_(actMsgs.length >= 1, 'act 产生 tool 结果（配对）')
  const actContent = JSON.parse(actMsgs[0].content)
  eq(actContent.ok, true, '审批通过后 act 成功')
  const toolCallIds = agent.messages.flatMap((m) => (m.tool_calls || []).map((tc) => tc.id))
  const toolResultIds = agent.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
  ok_(toolCallIds.every((id) => toolResultIds.includes(id)), '每个 tool_call 都有配对 tool 结果')
  await sessionMgr.closeAll()
})

await test('真实审批链：无权限用户在启动浏览器之前被拒绝', async () => {
  const { launcher, state } = makeEnv()
  const { pack, sessionMgr } = makeStagehand({ cfg: { permission: 'master' }, agent: {}, launcher }) // category=system
  const registry = new ToolRegistry()
  for (const t of pack.resolve({})) registry.register(t)
  let turn = 0
  const provider = { async chat() {
    if (turn++) return reply()
    return { ...reply(''), toolCalls: [call('stagehand__goto', 'g1', { url: 'http://93.184.216.34/' })], finishReason: 'tool_calls' }
  } }
  const agent = new Agent({ provider, tools: registry, policy: createPolicy(), reflect: 'off', governor: false })
  const ctx = { selfId: 'bot1', userId: 'u1', role: 'member', isMaster: false }
  await agent.run('打开网页', { ctx, maxTurns: 3 })
  eq(state.launched, 0, 'member 被 policy 拒绝，未启动浏览器')
  const toolMsg = agent.messages.find((m) => m.role === 'tool')
  ok_(/rejected_by_policy/.test(toolMsg?.content || ''), '返回 rejected_by_policy')
  await sessionMgr.closeAll()
})

// ───────────────────────── 总结 ─────────────────────────
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
