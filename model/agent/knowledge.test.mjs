/**
 * KnowledgeStore 定时刷新（setRefresh / cancelRefresh）回归用例。
 *
 * 背景（第 8 轮回归审计 high-1）：`setRefresh` 先注册新 job、成功后调 `_cancelJob(docId)`，
 * 而 `_scheduleRefresh` 成功时已把**新** job 写进 `_refreshJobs` —— 按 docId 查表取消到的正是
 * 刚注册的新 job，于是定时刷新当场被取消、永不触发，命令/面板/KV 却都回报「已排期」；
 * 同 cron 重复保存还会让旧 job 变孤儿（句柄被覆盖、取消不掉），每个 tick 重复抓同一 URL。
 * 修复要点：注册前先取旧句柄，换 cron 时按**引用**取消旧 job，非法 cron 时保留旧 job。
 */
import { KnowledgeStore } from './knowledge.js'

let pass = 0; let fail = 0
const ok = (c, m) => { c ? pass++ : (fail++, console.log(`  ✗ ${m}`)) }

/** 可控 scheduler 桩：记录 scheduleJob/cancelJob，可注入「非法 cron 返回 null」（node-schedule 真实行为） */
function mkScheduler({ invalid = new Set() } = {}) {
  const jobs = []
  const cancelled = []
  return {
    jobs, cancelled,
    scheduleJob(cron, fn) {
      if (invalid.has(cron)) return null
      const job = { cron, fn, id: jobs.length + 1 }
      jobs.push(job)
      return job
    },
    cancelJob(job) { cancelled.push(job) },
  }
}

function mkStore(doc = { id: 'd1', url: 'https://example.com/a', refreshCron: null }) {
  const kv = {
    _v: null,
    async get() { return this._v },
    async set(k, v) { this._v = JSON.parse(JSON.stringify(v)) },
  }
  const store = new KnowledgeStore({ kv, logger: () => {} })
  return { store, kv, seed: async () => { await kv.set('Yz:agent:kb:__global__', { docs: [doc], chunks: [] }) } }
}

// 1) 换 cron：注册新 job 并**按引用**取消旧 job（不是刚注册的那个）
{
  const { store, seed } = mkStore()
  const sched = mkScheduler()
  store.attachScheduler(sched)
  await seed()
  const r1 = await store.setRefresh('d1', '*/5 * * * *')
  ok(!r1.error && sched.jobs.length === 1, '首次设置：注册 1 个 job')
  const first = sched.jobs[0]
  const r2 = await store.setRefresh('d1', '*/10 * * * *')
  ok(!r2.error && sched.jobs.length === 2, '换 cron：再注册 1 个 job')
  const second = sched.jobs[1]
  ok(sched.cancelled.length === 1 && sched.cancelled[0] === first, '被取消的是旧 job（按引用）')
  ok(store._refreshJobs.get('d1') === second, '句柄表指向新 job')
  ok(!sched.cancelled.includes(second), '新注册的 job 没有被误取消（正是审计 high-1 的缺陷）')
}

// 2) 非法 cron：返回错误且旧 job 继续跑（不清句柄、不取消）
{
  const { store, seed } = mkStore()
  const sched = mkScheduler({ invalid: new Set(['bad cron']) })
  store.attachScheduler(sched)
  await seed()
  await store.setRefresh('d1', '*/5 * * * *')
  const alive = sched.jobs[0]
  const r = await store.setRefresh('d1', 'bad cron')
  ok(!!r.error, '非法 cron 返回错误')
  ok(store._refreshJobs.get('d1') === alive, '非法 cron 后旧 job 句柄仍在（未静默停摆）')
  ok(sched.cancelled.length === 0, '非法 cron 不会取消任何 job')
  // （原在此处有一行 `ok(kv === undefined || true, …)` 恒真占位断言，属假绿，已删——
  //   KV 里的 refreshCron 由下方用例真实校验。第 8 轮回归审计 low-4）
}

// 3) 非法 cron 不改 KV 里的 refreshCron（仍是旧值）
{
  const kv = {
    _v: null,
    async get() { return this._v },
    async set(k, v) { this._v = JSON.parse(JSON.stringify(v)) },
  }
  const store = new KnowledgeStore({ kv, logger: () => {} })
  const sched = mkScheduler({ invalid: new Set(['bad cron']) })
  store.attachScheduler(sched)
  await kv.set('Yz:agent:kb:__global__', { docs: [{ id: 'd1', url: 'https://example.com/a', refreshCron: '0 8 * * *' }], chunks: [] })
  const r = await store.setRefresh('d1', 'bad cron')
  ok(!!r.error, '非法 cron 返回错误（带旧值场景）')
  ok(kv._v.docs[0].refreshCron === '0 8 * * *', '非法 cron 不覆盖 KV 中的 refreshCron')
}

// 4) cron=null：取消定时刷新（job 取消 + KV 置 null）
{
  const kv = {
    _v: null,
    async get() { return this._v },
    async set(k, v) { this._v = JSON.parse(JSON.stringify(v)) },
  }
  const store = new KnowledgeStore({ kv, logger: () => {} })
  const sched = mkScheduler()
  store.attachScheduler(sched)
  await kv.set('Yz:agent:kb:__global__', { docs: [{ id: 'd1', url: 'https://example.com/a', refreshCron: null }], chunks: [] })
  await store.setRefresh('d1', '*/5 * * * *')
  const job = sched.jobs[0]
  const r = await store.setRefresh('d1', null)
  ok(!r.error && sched.cancelled.includes(job), 'cron=null：取消已注册 job')
  ok(!store._refreshJobs.has('d1'), 'cron=null：句柄已清除')
  ok(kv._v.docs[0].refreshCron === null, 'cron=null：KV 中 refreshCron 置 null')
}

// 5) 文档不存在 / 无 URL → 明确报错（不注册 job）
{
  const { store, seed } = mkStore({ id: 'd1', refreshCron: null })
  const sched = mkScheduler()
  store.attachScheduler(sched)
  await seed()
  const r1 = await store.setRefresh('nope', '*/5 * * * *')
  ok(!!r1.error && sched.jobs.length === 0, '文档不存在：报错且不注册 job')
  const r2 = await store.setRefresh('d1', '*/5 * * * *')
  ok(!!r2.error, '无 URL 的文档不可设定时刷新')
}

// 6) chunkText 死循环防护（第 6 轮审计 C5：overlap ≥ size 时 i 不前进 → CPU 打满 + OOM）
{
  const { chunkText } = await import('./knowledge.js')
  const text = 'a'.repeat(3000)
  const chunks = chunkText(text, 100, 500) // overlap > size
  ok(chunks.length > 0 && chunks.length < 200, `overlap>size 不再死循环（chunks=${chunks.length}）`)
  const chunks2 = chunkText(text, 0, 0) // size=0
  ok(chunks2.length > 0 && chunks2.length < 200, `size=0 不再死循环（chunks=${chunks2.length}）`)
}

console.log(`\nknowledge 定时刷新测试：通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
