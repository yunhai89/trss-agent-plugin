/**
 * 离线自检 —— StickerManager 发送门控 + 标记剥除 + 显式请求 force。
 * 运行：node model/sticker/manager.test.mjs
 *
 * 被测不变量：
 *  - 未通过门控的 [sticker:x] 标记一律剥除（文本/图片模式都不漏字面量）；
 *  - 频率闸（冷却/防连发/概率）默认生效；
 *  - 用户明确要表情（force）时绕过上述闸门，且标记无匹配时兜底任选一张；
 *  - maxPerReply 限流。
 */
import { StickerManager } from './manager.js'
import { isStickerOnly } from './parser.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }

const STICKERS = {
  开心: { file: 'happy.png', tags: ['开心'] },
  无奈: { file: 'helpless.png', tags: ['无奈'] },
  摸鱼: { file: 'fish.png', tags: ['摸鱼'] },
}
function makeMgr(cfgOver = {}) {
  const m = new StickerManager({ logger: () => {} })
  Object.defineProperty(m, 'cfg', { value: { enable: true, maxPerReply: 2, cooldown: 0, sendRate: 1, antiConsecutive: true, groupOnly: false, ...cfgOver } })
  m.enabled = () => true
  m.getIndex = () => ({ stickers: STICKERS })
  m._absOf = (e) => '/fake/' + e.file
  m._exists = () => true
  return m
}
const CTX = { isGroup: true, groupId: 'g1' }

await test('标记剥除：未通过门控的 [sticker:x] 不留字面量', async () => {
  const m = makeMgr()
  eq(m.applyImage('[sticker:开心]', new Map()), '', '纯标记 → 空串（图片模式此前漏字面量的根因）')
  eq(m.applyImage('你好 [sticker:不存在] 呀', new Map()), '你好  呀', '未通过标记被剥除、正文保留')
  eq(m.applyImage('你好 [sticker:开心] 呀', new Map()), '你好  呀', 'applyImage 空 map 一律剥除')
})

await test('isStickerOnly：识别"只有表情"的回复（用于强制发出，避免空白）', async () => {
  eq(isStickerOnly('[sticker:叼花少女]'), true, '纯标记 → true')
  eq(isStickerOnly('  [sticker:开心] [sticker:无奈]  '), true, '多标记纯空 → true')
  eq(isStickerOnly('[sticker:开心] 你好'), false, '带正文 → false')
  eq(isStickerOnly('你好'), false, '无标记 → false')
  eq(isStickerOnly(''), false, '空串 → false')
})

await test('频率闸：冷却 / 防连发 / 概率 默认生效', async () => {
  const anti = makeMgr({ cooldown: 0, antiConsecutive: true, sendRate: 1 })
  eq(anti.decide('[sticker:开心]', CTX).size, 1, '首次带图')
  eq(anti.decide('[sticker:无奈]', CTX).size, 0, '防连发：上一条带图 → 本条不带')

  const cool = makeMgr({ cooldown: 300, antiConsecutive: false, sendRate: 1 })
  eq(cool.decide('[sticker:开心]', CTX).size, 1, '首次带图')
  eq(cool.decide('[sticker:无奈]', CTX).size, 0, '冷却期内不发')

  const rate = makeMgr({ cooldown: 0, antiConsecutive: false, sendRate: 0 })
  eq(rate.decide('[sticker:开心]', CTX).size, 0, 'sendRate=0 → 不发')
})

await test('maxPerReply 限流', async () => {
  const m = makeMgr({ maxPerReply: 2, antiConsecutive: false })
  const got = m.decide('[sticker:开心][sticker:无奈][sticker:摸鱼]', CTX)
  eq(got.size, 2, '最多 2 张')
  ok(got.has('开心') && got.has('无奈'), '按出现顺序取前 2')
})

await test('recent-3 去重（非 force）', async () => {
  const m = makeMgr({ cooldown: 0, antiConsecutive: false, maxPerReply: 1 })
  m.noteSent(['开心'])
  eq(m.decide('[sticker:开心]', CTX).size, 0, '最近发过 → 本轮不发')
})

await test('force：显式请求绕过冷却/防连发并兜底选图', async () => {
  const anti = makeMgr({ cooldown: 0, antiConsecutive: true, sendRate: 0 })
  eq(anti.decide('[sticker:开心]', CTX).size, 0, '普通路径被概率闸挡下')
  eq(anti.decide('[sticker:开心]', CTX, { force: true }).size, 1, 'force 绕过概率闸')

  const cool = makeMgr({ cooldown: 300, antiConsecutive: false, sendRate: 0 })
  cool.decide('[sticker:开心]', CTX, { force: true })
  eq(cool.decide('[sticker:无奈]', CTX, { force: true }).size, 1, 'force 绕过冷却')

  // LLM 编了个库中不存在的名字 → 兜底任选一张，保证"要了就发"
  const m = makeMgr({ antiConsecutive: false, sendRate: 0 })
  const fb = m.decide('[sticker:zzzz_不存在]', CTX, { force: true })
  ok(fb.size >= 1, `无匹配仍兜底发一张（实际 ${fb.size}）`)
  ok([...fb.keys()].every((n) => n in STICKERS), '兜底取库内真实条目')
})

await test('force 兜底：近期全占也仍能发（放开近期限制）', async () => {
  const m = makeMgr({ cooldown: 0, antiConsecutive: false, sendRate: 1, maxPerReply: 1 })
  m.noteSent(['开心'])
  m.noteSent(['无奈'])
  m.noteSent(['摸鱼']) // 近 3 张全占
  const got = m.decide('[sticker:开心]', CTX, { force: true })
  eq(got.size, 1, 'force 下近期全占仍发一张')
})

await test('关闭开关：enabled=false → 恒空', async () => {
  const m = makeMgr()
  m.enabled = () => false
  eq(m.decide('[sticker:开心]', CTX, { force: true }).size, 0, '未启用 → 不发')
})

console.log(`\n========================================`)
console.log(`sticker manager 测试：通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
process.exit(failed > 0 ? 1 : 0)
