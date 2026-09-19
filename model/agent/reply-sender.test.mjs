/**
 * ReplySender 离线测试：串行队列归一化 + 发送超时保护 + 进度节流闸。
 * 运行：node model/agent/reply-sender.test.mjs  （无需联网 / API Key）
 */
import { ReplySender, isSendOk, makeProgressGate, SendTimeoutError } from './reply-sender.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) {
    passed++
    console.log('  ✓', m)
  } else {
    failed++
    console.error('  ✗ FAIL', m)
  }
}
async function test(name, fn) {
  console.log(`\n[${name}]`)
  try {
    await fn()
  } catch (e) {
    failed++
    console.error('  ✗ THROW', e?.message || e)
    console.error(e?.stack)
  }
}

await test('isSendOk：适配器返回值判定', async () => {
  ok(isSendOk(null) === true, 'null 视为成功')
  ok(isSendOk({ retcode: 0 }) === true, 'retcode=0 成功')
  ok(isSendOk({ retcode: 1 }) === false, 'retcode≠0 失败')
  ok(isSendOk({ status: 200 }) === true, 'status=200 成功')
  ok(isSendOk({ message_id: 123 }) === true, '消息 id 视为成功')
})

await test('ReplySender：正常发送归一为 outcome', async () => {
  const q = new ReplySender({ send: async () => ({ retcode: 0 }) })
  const out = await q.enqueue('hi', { tag: 'final' })
  ok(out.ok === true && out.tag === 'final', '成功 outcome')
})

await test('ReplySender：适配器 rejection 不 reject，归一为失败', async () => {
  const q = new ReplySender({ send: async () => { throw new Error('请求超时') } })
  const out = await q.enqueue('hi', { tag: 'progress' })
  ok(out.ok === false && out.error.includes('请求超时'), 'rejection 归一为 ok:false')
})

await test('ReplySender：进度发送超时快速失败且不堵队列', async () => {
  let n = 0
  const q = new ReplySender({
    send: async () => { n++; if (n === 1) return new Promise(() => {}); return { retcode: 0 } },
    timeoutMs: 20,
  })
  const p1 = q.enqueue('a', { tag: 'progress' })
  const p2 = q.enqueue('b', { tag: 'progress' })
  const t0 = Date.now()
  const [o1, o2] = await Promise.all([p1, p2])
  ok(o1.ok === false && /发送超时/.test(o1.error), '卡住的进度发送超时失败')
  ok(o2.ok === true, '超时后队列继续，下一条正常成功')
  ok(Date.now() - t0 < 1000, '不等适配器 60s，快速失败')
})

await test('ReplySender：final 不受 timeoutMs 约束（宁可多等）', async () => {
  const q = new ReplySender({
    send: () => new Promise((r) => setTimeout(() => r({ retcode: 0 }), 60)),
    timeoutMs: 10, // 只作用于非 final
  })
  const out = await q.enqueue('f', { tag: 'final' })
  ok(out.ok === true, 'final 慢返回仍判定成功')
})

await test('ReplySender：finalTimeoutMs 生效', async () => {
  const q = new ReplySender({
    send: () => new Promise(() => {}),
    finalTimeoutMs: 20,
  })
  const out = await q.enqueue('f', { tag: 'final' })
  ok(out.ok === false && out.error.includes('发送超时'), 'final 显式超时生效')
})

await test('SendTimeoutError：可识别超时类型', async () => {
  const e = new SendTimeoutError(15000, 'progress')
  ok(e.timeout === true && e.ms === 15000 && e.tag === 'progress', '超时错误字段')
})

await test('makeProgressGate：间隔 + 总量节流', async () => {
  const g = makeProgressGate({ minIntervalMs: 1000, maxMsgs: 2 })
  ok(g.allow(1000) === true, '首条放行')
  ok(g.allow(1100) === false, '间隔内拦截')
  ok(g.allow(2500) === true, '超过间隔放行（第 2 条）')
  ok(g.allow(9000) === false, '达到 maxMsgs 后拦截')
  ok(g.count === 2, '计数封顶')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
process.exit(failed > 0 ? 1 : 0)
