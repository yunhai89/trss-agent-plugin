/**
 * GET /api/web/console-url 离线自检（真实 express router + 真实 auth 中间件）。
 *
 * 校验「启动默认访问地址」在面板侧的出口：
 *  ① 返回本地/内网（/公网）带 token 地址，token 能被 authMiddleware 接受（登录可用）；
 *  ② 无 Authorization → 401（地址含 token，不能匿名拿）；
 *  ③ publicUrl 配置时公网地址用它；未配置时 public 为空（不做启动期网络探测）；
 *  ④ 返回 expiresAt / ttlHours / printTokenOnStart，与 webApi 配置一致；
 *  ⑤ 同一个令牌文件与启动横幅共用（ensureConsoleToken 幂等）。
 *
 * 运行：node --import ./stress/e2e/hooks.mjs model/web/api.web-console.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import Config from '../../utils/Config.js'
import { buildApiRouter } from './api.js'
import { errorMiddleware, CODE } from './response.js'
import { authMiddleware, ensureConsoleToken, consoleTokenDir } from './auth.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const A = JSON.stringify(a), B = JSON.stringify(b); ok(A === B, `${m}${A === B ? '' : `（实际 ${A}，期望 ${B}）`}`) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-web-console-'))
const oldData = Config.path.data
Config.path.data = tmp
const setWeb = (webApi) => {
  const cfg = Config.get()
  cfg.agent = cfg.agent || {}
  cfg.agent.webApi = { enable: true, port: 6098, publicUrl: '', printTokenOnStart: true, consoleTokenTtlHours: 720, ...webApi }
}

const app = express()
app.use(express.json())
// 与 server.js 同构：/api 先过鉴权
app.use('/api', authMiddleware, buildApiRouter({ runtimeProvider: async () => ({}) }))
app.use(errorMiddleware)
const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const req = async (p, { token } = {}) => {
  const r = await fetch(base + p, token ? { headers: { Authorization: `Bearer ${token}` } } : {})
  return { status: r.status, body: await r.json() }
}

try {
  console.log('\n[1] 未认证不能拿地址（地址里含 token）')
  {
    setWeb({})
    const r = await req('/api/web/console-url')
    eq([r.status, r.body.code], [401, 4010], '无 Authorization → 401/4010')
  }

  console.log('\n[2] 认证后返回带 token 的默认地址')
  {
    setWeb({ publicUrl: 'http://203.0.113.9:6098' })
    const rec = ensureConsoleToken({})
    const r = await req('/api/web/console-url', { token: rec.token })
    eq(r.status, 200, 'HTTP 200')
    const d = r.body.data
    ok(d.local.startsWith('http://127.0.0.1:6098/?token='), '本地地址固定 127.0.0.1:6098 且带 token')
    ok(d.local.endsWith(rec.token), 'token 与启动横幅共用同一令牌')
    ok(d.lan === '' || d.lan.startsWith('http://'), '内网地址格式（探测不到则为空）')
    eq(d.public, `http://203.0.113.9:6098/?token=${rec.token}`, '配置 publicUrl 时公网地址用它')
    eq(d.port, 6098, '返回端口')
    eq(d.ttlHours, 720, '返回 TTL（小时）')
    eq(d.printTokenOnStart, true, '返回启动打印开关')
    ok(d.expiresAt > Date.now(), '令牌未过期')
    ok(d.tokenFile.endsWith(path.join('web', 'console-token.json')), '返回令牌文件路径')
    // 地址本身可直接登录（?token= 直跳）；测试服务器监听随机端口，替换端口后再请求
    const localUrl = new URL(d.local)
    localUrl.port = String(server.address().port)
    const r2 = await fetch(localUrl)
    ok(r2.status === 200 || r2.status === 404, '?token= 直跳路径可访问（静态首页/SPA 兜底）')
  }

  console.log('\n[3] 未配置 publicUrl：公网地址为空（不阻塞/不联网探测）')
  {
    setWeb({ publicUrl: '' })
    const rec = ensureConsoleToken({})
    const r = await req('/api/web/console-url', { token: rec.token })
    eq(r.body.data.public, '', 'public 为空（启动横幅里才异步探测公网 IP）')
  }

  console.log('\n[4] printTokenOnStart=false 时仍可获取（面板内主动取不受开关限制）')
  {
    setWeb({ publicUrl: '', printTokenOnStart: false })
    const rec = ensureConsoleToken({})
    const r = await req('/api/web/console-url', { token: rec.token })
    eq([r.status, r.body.data.printTokenOnStart], [200, false], '返回真实开关状态')
  }

  console.log('\n[5] 地址与令牌落盘位置一致')
  {
    setWeb({})
    const rec = ensureConsoleToken({})
    const r = await req('/api/web/console-url', { token: rec.token })
    eq(r.body.data.tokenFile, path.join(consoleTokenDir(), 'console-token.json'), 'tokenFile 指向 data/web/console-token.json')
    ok(fs.existsSync(path.join(consoleTokenDir(), 'console-token.json')), '令牌文件存在')
  }
} finally {
  Config.path.data = oldData
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
