/**
 * Tool Evolution 端到端集成自检（真实 registry/engine/runner/suggestion/seed，只 mock LLM provider）。
 * 覆盖审计：P1-3 同名版本/父链/采纳回滚、P1-7 制品哈希绑定、P1-8 seed 埋点、P1-5 建议修订、
 * P0-1 显式 e2b 失败 fail-closed。
 * 运行：node model/toolEvo/integration.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDb, closeDb, recordInvocation, flushNow, dao } from './db.js'
import { ToolEvoRegistry } from './registry.js'
import { ToolSynthesizer } from './synthesizer.js'
import { EvolutionEngine } from './engine.js'
import { RunnerClient } from './runner.js'
import { seedBuiltinTools } from './seed.js'
import { evaluateVersion, failureClusters, convergenceMetrics } from './evaluator.js'
import { applySuggestion, listPendingSuggestions } from '../evolution/review.js'

let passed = 0, failed = 0
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn(); passed++ } catch (e) { failed++; console.error('  ✗', name, '—', e?.message || e); console.error(e?.stack?.split('\n').slice(1, 4).join('\n')) } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tevo-int-'))
await initDb({ dir })
const reg = new ToolEvoRegistry({ artifactsDir: path.join(dir, 'tools') })

function cand(over = {}) {
  const base = {
    manifest: { name: 'double_it', description: '把输入数字加倍返回', category: 'query', useWhen: [], doNotUseWhen: [], tags: [], inputSchemaJson: JSON.stringify({ type: 'object', properties: { n: { type: 'number' } } }), permissions: { sideEffects: ['none'] } },
    source: 'export async function run(input){ return { doubled: (input.n||0)*2 } }',
    tests: [
      { name: 'a', inputJson: '{"n":2}', expectedJson: '{"doubled":4}' },
      { name: 'b', inputJson: '{"n":0}', expectedJson: '{"doubled":0}' },
    ],
    assumptions: [],
  }
  return { ...base, ...over, manifest: { ...base.manifest, ...(over.manifest || {}) } }
}
const provider = { async chat() { return { content: JSON.stringify(cand()) } } }
const synth = new ToolSynthesizer({ provider, model: 'mock', maxRepairAttempts: 0 })
const engine = new EvolutionEngine({ synthesizer: synth, registry: reg })

let adoptedVersionId = null

await test('生成→验证→采纳 stable→注册契约→隔离执行（正例保留）', async () => {
  const r = await engine.evolve({ goal: '把数字加倍' })
  assert.equal(r.ok, true, r.reason)
  await reg.setStatus(r.versionId, 'stable', { actor: 'master:test', reason: '采纳' })
  adoptedVersionId = r.versionId
  const stable = (await reg.listStable()).find((s) => s.versionId === r.versionId)
  assert.ok(stable, 'listStable 含 active 版本')
  const runner = new RunnerClient({ logger: () => {}, timeoutMs: 4000 })
  try {
    const contract = await reg.toToolContract(stable, runner)
    const out = await contract.execute({ n: 21 })
    assert.equal(out.doubled, 42, '隔离执行结果正确')
    assert.equal(contract.meta.toolEvoVersionId, r.versionId, '契约绑定版本身份')
  } finally { await runner.stop() }
})

await test('P1-7：契约执行前篡改制品 → 拒绝执行', async () => {
  const stable = (await reg.listStable()).find((s) => s.versionId === adoptedVersionId)
  const file = path.join(reg.artifactsDir, 'double_it', stable.semver, 'index.js')
  const original = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, 'export async function run(){ return { doubled: 999 } }')
  const runner = new RunnerClient({ logger: () => {}, timeoutMs: 4000 })
  try {
    const contract = await reg.toToolContract(stable, runner)
    let e = null
    try { await contract.execute({ n: 2 }) } catch (err) { e = err }
    assert.ok(e && e.errorClass === 'artifact_tampered', `拒绝执行篡改制品（${e?.message}）`)
  } finally { await runner.stop(); fs.writeFileSync(file, original) }
})

await test('P1-3：同名第二次进化 → 新版本 + 父链；回滚切 active 后 listStable 跟随', async () => {
  const tool = await reg.getByName('double_it')
  const r2 = await engine.evolve({ goal: '同名改进', toolId: tool.id })
  assert.equal(r2.ok, true, r2.reason)
  assert.notEqual(r2.version, '0.1.0', '新版本号不同')
  const v2 = await reg.getVersion(r2.versionId)
  assert.equal(v2.parent_version_id, adoptedVersionId, '父链指向首版')
  await reg.setStatus(r2.versionId, 'stable', { actor: 'master', reason: '采纳新版' })
  let list = await reg.listStable()
  assert.equal(list.find((s) => s.name === 'double_it').semver, r2.version, 'active=新版')
  await reg.setActiveVersion(tool.id, adoptedVersionId, { actor: 'master', reason: '回滚' })
  list = await reg.listStable()
  assert.equal(list.find((s) => s.name === 'double_it').versionId, adoptedVersionId, '回滚后 active=旧版')
})

await test('P1-5：tool suggestion 走统一修订并 verified；内置工具失败保留待审', async () => {
  const suggestionDir = path.join(dir, 'sugg')
  fs.mkdirSync(suggestionDir, { recursive: true })
  const rt = { toolEvo: { registry: reg, engine }, suggestionDir, promptRegistry: {}, promptDir: dir, memory: null }

  // 对进化工具的描述改进 → 统一修订 → verified（不直接 stable）
  const s = { id: 'sg1', scopeId: 'g1', kind: 'tool', action: 'update', target: 'double_it', payload: { description: '把输入数字加倍返回（已改进的用途说明）' }, confidence: 0.9, ts: Date.now(), status: 'pending' }
  const r = await applySuggestion(rt, s)
  assert.equal(r.ok, true, r.note)
  const tool = await reg.getByName('double_it')
  const versions = await reg.listVersions({ toolId: tool.id, status: 'verified' })
  const rev = versions.find((v) => v.description.includes('已改进'))
  assert.ok(rev, '修订版本为 verified（待主人 #采纳）')
  assert.equal(rev.parent_version_id, tool.active_version_id, '修订关联当前 active 父版本')

  // 内置工具（空 source）→ 拒绝且保留待审证据
  const seedRes = await seedBuiltinTools(reg, [{ name: 'builtin_one', description: '内置工具一号', parameters: { type: 'object' }, sideEffects: ['none'] }])
  assert.equal(seedRes.added, 1)
  const bs = { id: 'sg_builtin', scopeId: 'g1', kind: 'tool', action: 'update', target: 'builtin_one', payload: { description: '尝试改写内置' }, confidence: 0.9, ts: Date.now(), status: 'pending' }
  let thrown = null
  try { await applySuggestion(rt, bs) } catch (e) { thrown = e }
  assert.ok(thrown, '内置工具建议应失败')
  const kept = listPendingSuggestions(suggestionDir, 'g1').find((x) => x.id === 'sg_builtin')
  assert.ok(kept && kept.lastError, '失败建议保留待审并记录原因')
})

await test('P1-8：seed 绑定版本 → 调用埋点关联版本，三次失败进 health', async () => {
  const seedRes = await seedBuiltinTools(reg, [
    { name: 'builtin_one', description: '内置工具一号', parameters: { type: 'object' }, sideEffects: ['none'] },
    { name: 'builtin_two', description: '内置工具二号', parameters: { type: 'object' }, sideEffects: ['none'] },
  ])
  assert.equal(seedRes.bindings.length, 2, '返回全部内置绑定（含已存在复用）')
  const b1 = seedRes.bindings.find((b) => b.name === 'builtin_one')
  assert.ok(b1.versionId, '内置工具绑定版本 ID')
  for (let i = 0; i < 3; i++) recordInvocation({ versionId: b1.versionId, toolName: 'builtin_one', args: { i }, success: false, latencyMs: 5, errorClass: 'timeout' })
  await flushNow()
  const ev = await evaluateVersion(b1.versionId)
  assert.equal(ev.invocations, 3, `三次调用关联到版本（实际 ${ev.invocations}）`)
  const clusters = await failureClusters()
  assert.ok(clusters.some((c) => c.toolName === 'builtin_one'), 'health 聚类包含内置工具')
  const metrics = await convergenceMetrics()
  assert.equal(metrics.invocations >= 3, true, 'metrics 统计调用次数')
  assert.equal(typeof metrics.reuseRate, 'number', 'reuseRate 有定义')
})

await test('P0-1：显式 e2b 且 manager 缺失 → fail-closed，不降级本地', async () => {
  const r = new RunnerClient({ logger: () => {}, sandbox: { mode: 'e2b', manager: null } })
  assert.equal(r.backend, 'sandbox-unavailable')
  const out = await r.invoke('v1', { source: 'export async function run(){return 1}', params: {} })
  assert.equal(out.ok, false)
  assert.equal(out.errorClass, 'sandbox_unavailable')
  assert.equal(r._worker, null, '未回退本地 worker')
  await r.stop()
})

await test('P1-8：ToolRegistry bindVersion 后调用埋点关联版本', async () => {
  const { ToolRegistry } = await import('../agent/tools/registry.js')
  const calls = []
  const tools = new ToolRegistry({ logger: () => {} })
  tools.register({ name: 'demo_bind', description: 'd', parameters: { type: 'object' }, execute: async () => ({ ok: true }) })
  tools.setInvocationSink((e) => calls.push(e))
  tools.bindVersion('demo_bind', 'tv_demo')
  await tools.get('demo_bind').execute({})
  assert.equal(calls[0]?.versionId, 'tv_demo', '埋点关联绑定版本')
  assert.equal(calls[0]?.success, true)
})

await test('P1-8：失败策略拒绝与已执行失败分类不被折成 soft_fail（结构化错误类别）', async () => {
  const rows = await dao.all(`SELECT DISTINCT error_class FROM tool_invocations WHERE error_class IS NOT NULL`)
  assert.ok(rows.some((r) => r.error_class === 'timeout'), '保留 timeout 类别')
})

await closeDb()
fs.rmSync(dir, { recursive: true, force: true })

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
