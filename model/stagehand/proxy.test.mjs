/**
 * 离线回归 —— stagehand 浏览器启动选项：代理透传（与搜索/抓取一致，支持受限网络）。
 * 运行：node model/stagehand/proxy.test.mjs
 */
import { buildLaunchOptions } from './guard.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }

const profile = { locale: 'zh-CN', viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, hasTouch: false, ua: 'TestUA/1.0' }

ok(buildLaunchOptions({ stealth: false }).proxy === undefined, '无代理 → 不设 proxy')
{
  const o = buildLaunchOptions({ stealth: false, proxy: 'http://user:p%40ss@127.0.0.1:7890' })
  eq(o.proxy?.server, 'http://127.0.0.1:7890', '服务端（去凭据）')
  eq(o.proxy?.username, 'user', '用户名')
  eq(o.proxy?.password, 'p@ss', '密码（URL 解码）')
}
{
  const o = buildLaunchOptions({ proxy: 'socks5://127.0.0.1:1080' }, profile)
  eq(o.proxy?.server, 'socks5://127.0.0.1:1080', 'stealth 开时也透传代理')
  ok(Array.isArray(o.args) && o.args.length > 0, 'stealth 参数仍生成')
}
{
  const o = buildLaunchOptions({ stealth: false, proxy: 'not a url:::' })
  eq(o.proxy?.server, 'not a url:::', '非法 URL 兜底为原样 server')
}

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
