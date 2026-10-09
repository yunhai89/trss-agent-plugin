/**
 * ToolScheduler 离线自检 —— P0-2 受控并发调度。
 * 运行：node model/agent/tool-scheduler.test.mjs
 */
import { ToolScheduler, resolveToolConcurrency, READ_PARALLEL_TOOLS } from './tool-scheduler.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 1. resolveToolConcurrency ----------
await test('resolveToolConcurrency：默认独占 / 白名单并发 / 资源键', async () => {
  eq(resolveToolConcurrency({ name: 'unknown_x', meta: {} }, {}, {}).mode, 'exclusive', '未声明 → exclusive')
  eq(resolveToolConcurrency({ name: 'web_search', meta: {} }, {}, {}).mode, 'parallel', '只读白名单 → parallel')
  eq(resolveToolConcurrency({ name: 'web_search', meta: { interactive: true } }, {}, {}).mode, 'exclusive', 'interactive 覆盖 → exclusive')
  eq(resolveToolConcurrency({ name: 'x', meta: { concurrency: 'parallel' } }, {}, {}).mode, 'parallel', '显式 parallel')
  const r = resolveToolConcurrency({ name: 'x', meta: { concurrency: 'resource', resourceKeys: (a) => ['k:' + a.id] } }, { id: 7 }, {})
  eq(r.mode, 'resource', '显式 resource')
  eq(r.resourceKeys, ['k:7'], 'resourceKeys 计算')
  eq(resolveToolConcurrency({ name: 'x', meta: { concurrency: 'resource', resourceKeys: () => [] } }, {}, {}).mode, 'exclusive', 'resource 无键 → 降级 exclusive')
  eq(resolveToolConcurrency({ name: 'x', meta: { resourceKeys: () => ['a'] } }, {}, {}).mode, 'resource', '仅声明 resourceKeys → 升级 resource')
  eq(resolveToolConcurrency({ name: 'x', meta: { concurrency: 'parallel', resourceKeys: () => ['a'] } }, {}, {}).mode, 'resource', 'parallel+keys → resource')
  ok(READ_PARALLEL_TOOLS.has('web_search') && !READ_PARALLEL_TOOLS.has('terminal'), '白名单只含只读工具')
})

// ---------- 2. 并发池上限 + 原序结果 ----------
await test('ToolScheduler：并发池上限 + 结果按原序', async () => {
  const s = new ToolScheduler({ maxParallel: 2 })
  let active = 0, maxActive = 0
  const mk = (id, ms) => ({ concurrency: 'parallel', resourceKeys: [], run: async () => { active++; maxActive = Math.max(maxActive, active); await delay(ms); active--; return id } })
  const out = await s.run([mk('a', 20), mk('b', 5), mk('c', 5), mk('d', 5)])
  eq(maxActive, 2, '并发不超过上限 2')
  eq(out.map((r) => r.value), ['a', 'b', 'c', 'd'], '结果按原序')
})

// ---------- 3. exclusive 屏障 ----------
await test('ToolScheduler：exclusive 形成屏障（等待先前任务退出）', async () => {
  const s = new ToolScheduler({ maxParallel: 5 })
  const events = []
  const mk = (name, ms) => ({ concurrency: 'parallel', resourceKeys: [], run: async () => { events.push(name + ':start'); await delay(ms); events.push(name + ':end') } })
  const ex = (name, ms) => ({ concurrency: 'exclusive', resourceKeys: [], run: async () => { events.push(name + ':start'); await delay(ms); events.push(name + ':end') } })
  await s.run([mk('A', 20), mk('B', 20), ex('X', 5), mk('C', 5)])
  eq(events, ['A:start', 'B:start', 'A:end', 'B:end', 'X:start', 'X:end', 'C:start', 'C:end'], 'exclusive 前后不重叠')
})

// ---------- 4. resource 键串行 / 不同键并发 ----------
await test('ToolScheduler：同资源键串行，不同键并发', async () => {
  const s = new ToolScheduler({ maxParallel: 3 })
  const perKey = new Map()
  let maxActive = 0, active = 0, overlap = false
  const mk = (key, ms) => ({
    concurrency: 'resource', resourceKeys: [key],
    async run() {
      const c = (perKey.get(key) || 0) + 1
      perKey.set(key, c)
      if (c > 1) overlap = true
      active++; maxActive = Math.max(maxActive, active)
      await delay(ms)
      active--; perKey.set(key, perKey.get(key) - 1)
      return key
    },
  })
  const out = await s.run([mk('p', 20), mk('p', 3), mk('q', 20)])
  ok(!overlap, '同一资源键无重叠')
  eq(maxActive, 2, '不同资源键可并发（p 与 q）')
  eq(out.map((r) => r.value), ['p', 'p', 'q'], '结果按原序')
})

// ---------- 5. 取消：排队项不启动，在跑项等待结算 ----------
await test('ToolScheduler：取消后排队项不启动，在跑项等待结算', async () => {
  const s = new ToolScheduler({ maxParallel: 1 })
  const ac = new AbortController()
  let started = 0, finished = 0
  let release
  const first = { concurrency: 'parallel', resourceKeys: [], run: async () => { started++; await new Promise((r) => { release = r }); finished++; return 'first' } }
  const second = { concurrency: 'parallel', resourceKeys: [], run: async () => { started++; return 'second' } }
  const p = s.run([first, second], { signal: ac.signal })
  await delay(10)
  eq(started, 1, '只启动了 1 个')
  ac.abort()
  await delay(10)
  eq(started, 1, '取消后不再启动排队项')
  release()
  const out = await p
  eq(finished, 1, '在跑项结算')
  eq(out[0].value, 'first', '在跑项返回结果')
  eq(out[1].cancelled, true, '排队项标记 cancelled')
})

// ---------- 6. 开始前已取消 ----------
await test('ToolScheduler：已取消的 exclusive 不执行', async () => {
  const s = new ToolScheduler()
  const ac = new AbortController()
  ac.abort()
  let ran = false
  const out = await s.run([{ concurrency: 'exclusive', resourceKeys: [], run: async () => { ran = true } }], { signal: ac.signal })
  ok(!ran, '未执行')
  eq(out[0].cancelled, true, 'cancelled')
})

await test('ToolScheduler：同一实例跨 run 共享资源锁与额度（F10）', async () => {
  const s = new ToolScheduler({ maxParallel: 1 })
  let active = 0, peak = 0
  const mk = () => ({ concurrency: 'resource', resourceKeys: ['browser:same'], run: async () => { active++; peak = Math.max(peak, active); await delay(20); active--; return 'ok' } })
  await Promise.all([s.run([mk()]), s.run([mk()])])
  eq(peak, 1, '跨 run 同资源峰值 1（全局互斥）')
  let active2 = 0, peak2 = 0
  const mk2 = () => ({ concurrency: 'parallel', resourceKeys: [], run: async () => { active2++; peak2 = Math.max(peak2, active2); await delay(20); active2--; return 'ok' } })
  await Promise.all([s.run([mk2(), mk2()]), s.run([mk2(), mk2()])])
  eq(peak2, 1, '跨 run 共享全局并发上限 1')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
