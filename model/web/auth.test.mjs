/**
 * 回归测试：#agents登录 必须分别返回【公网地址】与【本地地址】两条独立消息，不合并。
 * 本地地址固定 127.0.0.1（不读配置）。运行：node model/web/auth.test.mjs
 */
import Config from '../../utils/Config.js'
import { handleAgentsLogin, localHost } from './auth.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

// 阻断外网探测（detectPublicIp）：立即失败 → 走 LAN IP 兜底，测试不触网、不等待
const origFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('no net in test') }

Config.set('agent', { ...(Config.get().agent || {}), webApi: { enable: true, port: 6098 } })

const replies = []
const e = { isGroup: false, user_id: '123', reply: async (m) => { replies.push(String(m)) } }
await handleAgentsLogin(e)

ok(localHost() === '127.0.0.1', '本地地址固定为 127.0.0.1（无配置）')
ok(replies.length === 2, `分两条消息发送（实际 ${replies.length} 条）`)
ok(/公网/.test(replies[0]) && /^http:\/\//m.test(replies[0]) && /token=/.test(replies[0]), '第一条 = 公网地址')
ok(/本地/.test(replies[1]) && /127\.0\.0\.1:6098/.test(replies[1]) && /token=/.test(replies[1]), '第二条 = 本地地址')
ok(replies[0] !== replies[1] && !replies[0].includes(replies[1]) && !replies[1].includes(replies[0]), '两地址未合并')

globalThis.fetch = origFetch
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
