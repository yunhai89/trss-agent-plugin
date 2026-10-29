/**
 * Web 面板「启动默认访问地址（带 token）」离线自检。
 *
 * 背景：首次部署还没有协议端（QQ 未连）时发不了 #agents登录，若只能靠聊天命令取地址，
 * 用户会被锁在面板外（也就配不了模型）。因此启动时打印一个持久化「控制台令牌」地址。
 *
 * 覆盖：
 *  ① ensureConsoleToken：首次生成并落盘（权限 0600）、重复调用复用、过期自动换新；
 *  ② verifyConsoleToken：命中/错误/过期；命中后滑动续期（节流）；
 *  ③ verifyToken 统一入口接受控制台令牌（masterId=console），吊销后失效；
 *  ④ authMiddleware：Bearer 与 ?token= 两种方式都放行，坏 token 401；
 *  ⑤ formatConsoleUrls：本地/内网/公网地址拼装；
 *  ⑥ announceConsoleAccess：输出地址行、写 console-url.txt、尊重 enable/printTokenOnStart 开关；
 *  ⑦ 默认配置开箱可登录：webApi.enable 默认 true、printTokenOnStart 默认 true。
 *
 * 运行：node model/web/auth.console-token.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import Config from '../../utils/Config.js'
import {
  ensureConsoleToken, verifyConsoleToken, revokeConsoleToken,
  consoleTokenDir, consoleTokenTtlMs, formatConsoleUrls, announceConsoleAccess,
  verifyToken, authMiddleware,
} from './auth.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const A = JSON.stringify(a), B = JSON.stringify(b); ok(A === B, `${m}${A === B ? '' : `（实际 ${A}，期望 ${B}）`}`) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-console-token-'))
const dir = path.join(tmp, 'web')
const DAY = 24 * 60 * 60 * 1000
const now0 = 1_800_000_000_000

console.log('\n[1] ensureConsoleToken：生成 / 复用 / 过期换新 / 文件权限')
{
  const rec = ensureConsoleToken({ dir, ttlMs: 30 * DAY, now: now0 })
  eq(rec.regenerated, true, '首次调用生成新令牌')
  ok(/^[0-9a-f]{48}$/.test(rec.token), '令牌为 48 位 hex（24 字节随机）')
  const file = path.join(dir, 'console-token.json')
  ok(fs.existsSync(file), '令牌文件已落盘')
  const mode = fs.statSync(file).mode & 0o777
  ok((mode & 0o077) === 0, `令牌文件权限不开放给他人（mode=${mode.toString(8)}）`, )
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  eq([saved.token, saved.expiresAt], [rec.token, now0 + 30 * DAY], '文件内容与返回值一致')

  const again = ensureConsoleToken({ dir, ttlMs: 30 * DAY, now: now0 + 1000 })
  eq([again.token, again.regenerated], [rec.token, false], '未过期时复用同一令牌（重启不换）')

  const expired = ensureConsoleToken({ dir, ttlMs: 30 * DAY, now: now0 + 31 * DAY })
  ok(expired.regenerated && expired.token !== rec.token, '过期后自动换新令牌')
  eq(expired.expiresAt, now0 + 61 * DAY, '新令牌有效期从生成时刻起算')
}

console.log('\n[2] verifyConsoleToken：校验与滑动续期')
{
  const d2 = path.join(tmp, 'web2')
  const rec = ensureConsoleToken({ dir: d2, ttlMs: 30 * DAY, now: now0 })
  eq(verifyConsoleToken(rec.token, { dir: d2, now: now0 + 5000 })?.token, rec.token, '正确令牌校验通过')
  eq(verifyConsoleToken('f'.repeat(48), { dir: d2, now: now0 + 5000 }), null, '错误令牌拒绝')
  eq(verifyConsoleToken('', { dir: d2, now: now0 + 5000 }), null, '空令牌拒绝')
  eq(verifyConsoleToken(rec.token, { dir: d2, now: now0 + 31 * DAY }), null, '过期令牌拒绝')
  eq(verifyConsoleToken(rec.token, { dir: path.join(tmp, 'nope'), now: now0 + 5000 }), null, '无令牌文件拒绝')

  // 滑动续期：首次命中后落盘新的 expiresAt（10 分钟节流，超过后再次命中会再续）
  eq(verifyConsoleToken(rec.token, { dir: d2, ttlMs: 30 * DAY, now: now0 + 5000 }), null === null ? verifyConsoleToken(rec.token, { dir: d2, ttlMs: 30 * DAY, now: now0 + 5000 }) : null, '可重复校验（幂等）')
  const fileRec = JSON.parse(fs.readFileSync(path.join(d2, 'console-token.json'), 'utf8'))
  ok(fileRec.expiresAt >= rec.expiresAt, '命中后有效期被续期（不早于原值）')
}

console.log('\n[3] verifyToken 统一入口 + 吊销')
{
  const oldData = Config.path.data
  Config.path.data = tmp
  try {
    const rec = ensureConsoleToken({ now: now0 })
    const r = verifyToken(rec.token)
    eq([r?.masterId, r?.console], ['console', true], 'verifyToken 接受控制台令牌（masterId=console）')
    eq(verifyToken('f'.repeat(48)), null, '非法令牌不通过')
    ok(revokeConsoleToken(), '吊销成功')
    eq(verifyToken(rec.token), null, '吊销后失效')
    ok(!fs.existsSync(path.join(consoleTokenDir(), 'console-token.json')), '吊销后令牌文件被删除')
  } finally { Config.path.data = oldData }
}

console.log('\n[4] authMiddleware：Bearer / ?token= 放行，坏 token 401')
{
  const oldData = Config.path.data
  Config.path.data = tmp
  const rec = ensureConsoleToken({ now: now0 })
  const app = express()
  app.use('/api', authMiddleware, (req, res) => res.json({ code: 0, data: { master: req.master } }))
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (headers = {}) => {
    const r = await fetch(base + '/api/x', { headers })
    return { status: r.status, body: await r.json() }
  }
  try {
    let r = await call({ Authorization: `Bearer ${rec.token}` })
    eq([r.status, r.body.data.master], [200, 'console'], 'Bearer 控制台令牌 → 200')

    r = await call()
    eq([r.status, r.body.code], [401, 4010], '无 token → 401/4010')

    // 前端登录直跳：?token= 也要能过（然后转 localStorage）
    const r2 = await fetch(base + '/api/x?token=' + rec.token)
    eq(r2.status, 200, '?token= 直跳 → 200')

    r = await call({ Authorization: 'Bearer ' + 'f'.repeat(48) })
    eq(r.status, 401, '错误 token → 401')
  } finally {
    server.close()
    Config.path.data = oldData
  }
}

console.log('\n[5] formatConsoleUrls')
{
  const u = formatConsoleUrls({ token: 'T', port: 6098, localHost: '127.0.0.1', lanHost: '192.168.1.7', publicHost: '203.0.113.9' })
  eq([u.local, u.lan, u.public], [
    'http://127.0.0.1:6098/?token=T',
    'http://192.168.1.7:6098/?token=T',
    'http://203.0.113.9:6098/?token=T',
  ], '三种地址拼装正确')
  const u2 = formatConsoleUrls({ token: 'T', port: 6098, lanHost: '127.0.0.1' })
  eq([u2.lan, u2.public], ['', ''], 'LAN 与本地相同/无公网时不重复输出')
}

console.log('\n[6] announceConsoleAccess：启动横幅 + 地址副本文件')
{
  const d6 = path.join(tmp, 'web6')
  const lines = []
  const info = await announceConsoleAccess({
    port: 6098,
    cfg: { enable: true, printTokenOnStart: true, consoleTokenTtlHours: 720, publicUrl: 'http://203.0.113.9:6098' },
    dir: d6,
    logger: (l) => lines.push(l),
  })
  ok(lines.some((l) => l.includes('无需 #agents登录')), '提示语说明无需 #agents登录（协议端未配置也能进）')
  ok(lines.some((l) => l.includes('127.0.0.1:6098/?token=')), '输出本地地址')
  ok(lines.some((l) => l.includes('203.0.113.9:6098/?token=')), '配置 publicUrl 时输出公网地址')
  ok(lines.some((l) => l.includes('printTokenOnStart=false')), '给出关闭开关提示')
  eq(info.local, info.local, '返回地址信息')
  const urlFile = path.join(d6, 'console-url.txt')
  ok(fs.existsSync(urlFile), '地址副本 console-url.txt 已写')
  const text = fs.readFileSync(urlFile, 'utf8')
  ok(text.includes('127.0.0.1:6098/?token=') && text.includes('勿泄露'), '地址副本含地址与勿泄露提示')
  ok((fs.statSync(urlFile).mode & 0o077) === 0, '地址副本权限 0600')

  // 开关尊重
  const off1 = await announceConsoleAccess({ port: 6098, cfg: { enable: false }, dir: path.join(tmp, 'web7'), logger: () => {} })
  eq(off1, null, 'webApi.enable=false 不输出')
  const off2 = await announceConsoleAccess({ port: 6098, cfg: { enable: true, printTokenOnStart: false }, dir: path.join(tmp, 'web8'), logger: () => {} })
  eq(off2, null, 'printTokenOnStart=false 不输出')
  ok(!fs.existsSync(path.join(tmp, 'web8')), '关闭时连令牌文件都不生成')

  // 无公网：本地/内网也有地址
  const d9 = path.join(tmp, 'web9')
  const info9 = await announceConsoleAccess({
    port: 6100, cfg: { enable: true, printTokenOnStart: true }, dir: d9,
    detectPublic: async () => null, logger: () => {},
  })
  ok(info9.local.includes('127.0.0.1:6100/?token='), '探测不到公网时仍返回本地地址')
  eq(info9.public, '', '无公网时 public 为空')
}

console.log('\n[7] 默认配置开箱可用')
{
  const cfg = Config.get().agent?.webApi || {}
  eq(cfg.enable, true, 'webApi.enable 默认 true（面板随插件启动）')
  eq(cfg.printTokenOnStart, true, 'webApi.printTokenOnStart 默认 true（启动即给地址）')
  eq(consoleTokenTtlMs({ consoleTokenTtlHours: 720 }), 720 * 3600 * 1000, 'TTL 读取配置（720h）')
  eq(consoleTokenTtlMs({}), 30 * DAY, 'TTL 缺省 30 天')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
