/**
 * Web「QQ 官方机器人账号」API 离线自检（真实 express router + 真实 Config + 桩适配器）。
 *
 * 覆盖：
 *  ① GET /api/qqbot：空配置、扁平单账号、accounts[] 多账号，均不返回 AppSecret 明文；
 *  ② POST /api/qqbot/accounts：参数校验、新增成功并调用适配器 connect、自动 enable；
 *  ③ PUT /api/qqbot/accounts/:appId：改名、AppSecret 留空保持原值、已连接账号触发重连；
 *  ④ DELETE：删除并调用适配器 disconnect；不存在的账号 404；
 *  ⑤ POST connect / disconnect / reload：调用适配器对应方法；
 *  ⑥ GET /api/qqbot/status：透出适配器原始状态；
 *  ⑦ 扁平配置 → 首次写操作后迁移为 accounts[]（单一真源）。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs model/web/api.qqbot.test.mjs
 * （hooks 把 Yunzai plugin 基类 / Config 替换为桩；不加 --import 由 scripts/run-tests.mjs 自动加）
 */
import express from 'express'
import Config from '../../utils/Config.js'
import { buildApiRouter } from './api.js'
import { errorMiddleware } from './response.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const A = JSON.stringify(a), B = JSON.stringify(b); ok(A === B, `${m}${A === B ? '' : `（实际 ${A}，期望 ${B}）`}`) }

// ── 桩适配器：记录调用，status() 返回配置里的账号状态 ─────────────────
const calls = []
const fakeAdapter = {
  status() {
    return (Config.get().agent?.qqBot?.accounts || []).map((a) => ({
      appId: String(a.appId),
      name: a.name || String(a.appId),
      connected: false,
      state: a.appId === '1002' ? 'ready' : 'idle',
      sessionId: a.appId === '1002' ? 'SESSION_ABCDEF' : null,
      markdownUsable: true,
      lastClose: null,
      reconnectAttempts: 0,
    }))
  },
  async connect(account) { calls.push(['connect', account.appId]) },
  disconnect(appId) { calls.push(['disconnect', appId]) },
  stopAll() { calls.push(['stopAll']) },
  async load() { calls.push(['load']) },
}

// 本测试要跑「会写配置」的 API：桩 Config.save 默认抛错（别的用例依赖这一点），
// 这里仅对本测试进程把 save 换成内存写回，测完还原。
const cfgMod = await import('../../stress/e2e/stubs/Config.js')
const origSave = Config.save
Config.save = (data) => { if (data && typeof data === 'object') cfgMod.__state.config = data }
// 保存/恢复配置快照（内存实现：save 只回写内存，不落盘）
const snapshot = JSON.parse(JSON.stringify(Config.get()))

const app = express()
app.use(express.json())
app.use('/api', buildApiRouter({ runtimeProvider: async () => ({}), qqbotAdapterProvider: () => fakeAdapter }))
app.use(errorMiddleware)
const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const req = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json() }
}
const get = (p) => req('GET', p)
const post = (p, b) => req('POST', p, b)
const put = (p, b) => req('PUT', p, b)
const del = (p) => req('DELETE', p)

/** 重置 qqBot 配置（直接改内存后落盘，模拟已有配置） */
function setQQBot(qq) {
  const cfg = Config.get()
  cfg.agent = cfg.agent || {}
  cfg.agent.qqBot = qq
  Config.save(cfg)
}

try {
  console.log('\n[1] GET /api/qqbot：空配置')
  {
    setQQBot({ enable: false, accounts: [] })
    const r = await get('/api/qqbot')
    eq(r.status, 200, 'HTTP 200')
    eq([r.body.code, r.body.data.total, r.body.data.accounts.length], [0, 0, 0], '空账号列表')
    eq(r.body.data.adapterReady, true, '适配器就绪标记（注入 provider）')
  }

  console.log('\n[2] POST 新增账号：校验 + 连接 + 不返回明文密钥')
  {
    calls.length = 0
    let r = await post('/api/qqbot/accounts', { appId: 'abc', appSecret: 's' })
    eq(r.status, 400, '非数字 appId → 400')
    r = await post('/api/qqbot/accounts', { appId: '1001' })
    eq(r.status, 400, '缺 appSecret → 400')
    eq(calls.length, 0, '校验失败不触发连接')

    r = await post('/api/qqbot/accounts', { appId: '1001', appSecret: 'SECRET_A', name: '主号' })
    eq(r.status, 200, '新增成功')
    const a = r.body.data.accounts[0]
    eq([a.appId, a.name, a.hasSecret], ['1001', '主号', true], '返回账号信息')
    ok(!('appSecret' in a), '响应不含明文 appSecret')
    eq(a.secretMasked, '••••••••ET_A', '只回尾部 4 位掩码')
    eq(Config.get().agent.qqBot.enable, true, '自动 enable=true')
    eq(calls, [['connect', '1001']], '已调用适配器 connect')
  }

  console.log('\n[3] PUT 编辑：密钥留空保持、改名、触发重连')
  {
    calls.length = 0
    let r = await put('/api/qqbot/accounts/1001', { name: '改名' })
    eq(r.status, 200, '编辑成功')
    eq(Config.get().agent.qqBot.accounts[0].appSecret, 'SECRET_A', 'AppSecret 留空保持原值')
    eq(Config.get().agent.qqBot.accounts[0].name, '改名', '名称已更新')
    eq(calls, [['disconnect', '1001'], ['connect', '1001']], '已连接账号编辑后重连')

    r = await put('/api/qqbot/accounts/1001', { appSecret: 'SECRET_B' })
    eq(Config.get().agent.qqBot.accounts[0].appSecret, 'SECRET_B', '显式传密钥可更新')
    r = await put('/api/qqbot/accounts/9999', { name: '新号' })
    eq(r.status, 400, 'PUT 不存在的账号且未给密钥 → 400（防误建空账号）')
    r = await put('/api/qqbot/accounts/9999', { name: '新号', appSecret: 'S9999' })
    eq(r.status, 200, 'PUT 带密钥按 upsert 新增')
    eq(Config.get().agent.qqBot.accounts.length, 2, '现有 2 个账号')
  }

  console.log('\n[4] 连接 / 断开 / 重连全部')
  {
    calls.length = 0
    let r = await post('/api/qqbot/accounts/1001/connect')
    eq([r.status, calls], [200, [['connect', '1001']]], 'connect 调适配器')
    calls.length = 0
    r = await post('/api/qqbot/accounts/1001/disconnect')
    eq([r.status, calls], [200, [['disconnect', '1001']]], 'disconnect 调适配器')
    calls.length = 0
    r = await post('/api/qqbot/reload')
    eq([r.status, calls], [200, [['stopAll'], ['load']]], 'reload：stopAll + load')
    r = await post('/api/qqbot/accounts/8888/connect')
    eq(r.status, 404, '连接不存在的账号 → 404')
  }

  console.log('\n[5] GET 状态：合并连接状态与会话')
  {
    // 让 1002 处于 ready
    setQQBot({ enable: true, accounts: [{ appId: '1002', appSecret: 'S', name: '二号' }, { appId: '1001', appSecret: 'S', name: '一号' }] })
    const r = await get('/api/qqbot')
    const a2 = r.body.data.accounts.find((a) => a.appId === '1002')
    const a1 = r.body.data.accounts.find((a) => a.appId === '1001')
    eq([a2.status.state, a2.status.sessionId], ['ready', 'SESSION_ABCDEF'], '账号状态含网关 state/session')
    eq(a1.status.state, 'idle', '未连接账号状态 idle')
    eq(r.body.data.connected, 1, 'connected 计数')
    const st = await get('/api/qqbot/status')
    eq([st.body.data.ready, st.body.data.accounts.length], [true, 2], '原始状态接口')
  }

  console.log('\n[6] 扁平配置 → 写操作迁移为 accounts[]')
  {
    setQQBot({ enable: true, appId: '3001', appSecret: 'FLAT_SECRET', name: '扁平号' })
    let r = await get('/api/qqbot')
    eq([r.body.data.accounts[0].appId, r.body.data.accounts[0].source], ['3001', 'flat'], '扁平写法可读')
    r = await post('/api/qqbot/accounts', { appId: '3002', appSecret: 'S2' })
    const qq = Config.get().agent.qqBot
    ok(!('appId' in qq) && !('appSecret' in qq), '扁平字段已清理（单一真源）')
    eq((qq.accounts || []).map((a) => a.appId).sort(), ['3001', '3002'], '两个账号都在 accounts[]')
    eq(Config.get().agent.qqBot.accounts.find((a) => a.appId === '3001').appSecret, 'FLAT_SECRET', '迁移保留原密钥')
  }

  console.log('\n[7] DELETE 删除账号')
  {
    calls.length = 0
    let r = await del('/api/qqbot/accounts/3002')
    eq([r.status, calls], [200, [['disconnect', '3002']]], '删除并断开')
    ok(!Config.get().agent.qqBot.accounts.some((a) => a.appId === '3002'), '账号已从配置移除')
    r = await del('/api/qqbot/accounts/3002')
    eq(r.status, 404, '重复删除 → 404')
  }
} finally {
  try { Config.save(snapshot) } catch { /* noop */ } // 还原配置快照
  Config.save = origSave
  server.close()
}

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
