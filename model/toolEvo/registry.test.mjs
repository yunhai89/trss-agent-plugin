/**
 * ToolEvoRegistry 版本回滚离线自检（审计 §4.1 / P0-4）。
 * 验证：① listStable 每工具只返回 active 版本；② setActiveVersion 切换 active；③ 非 stable 不可设 active。
 * 运行：node model/toolEvo/registry.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDb, closeDb } from './db.js'
import { ToolEvoRegistry } from './registry.js'
import { makeManifest } from './manifest.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tevo-reg-'))
await initDb({ dir: tmpDir })
const reg = new ToolEvoRegistry({ artifactsDir: path.join(tmpDir, 'tools') })

const mkManifest = (name, semver) => makeManifest({
  name, version: semver, description: '回滚测试工具描述',
  inputSchema: { type: 'object' }, permissions: { sideEffects: ['none'], network: { mode: 'deny' } },
})

await test('listStable：每工具只返回 active 版本（多 stable 不全返回）', async () => {
  const toolId = 'tool_rb1'
  await reg.createTool({ id: toolId, name: 'rollback_demo1', namespace: 'test' })
  const v1 = await reg.createVersion({ toolId, semver: '1.0.0', manifest: mkManifest('rollback_demo1', '1.0.0'), source: 'export async function run(){return{v:1}}', tests: [] })
  const v2 = await reg.createVersion({ toolId, semver: '2.0.0', manifest: mkManifest('rollback_demo1', '2.0.0'), source: 'export async function run(){return{v:2}}', tests: [] })
  await reg.setStatus(v1.id, 'verified'); await reg.setStatus(v1.id, 'stable') // draft→verified→stable（转移才回填 active）
  await reg.setStatus(v2.id, 'verified'); await reg.setStatus(v2.id, 'stable') // 后采纳 → active = v2
  const list = await reg.listStable()
  ok(list.length === 1, 'listStable 只返回 1 个（active，非全部 stable）')
  ok(list[0].semver === '2.0.0', 'active = v2（后采纳覆盖）')
})

await test('setActiveVersion：切换 active（回滚）', async () => {
  const tool = await reg.getByName('rollback_demo1')
  const v1 = (await reg.listVersions({ toolId: tool.id })).find((v) => v.semver === '1.0.0')
  await reg.setActiveVersion(tool.id, v1.id, { actor: 'master:test', reason: '手动回滚' })
  const list = await reg.listStable()
  ok(list.length === 1 && list[0].semver === '1.0.0', '回滚后 active = v1')
})

await test('setActiveVersion：拒绝非 stable 版本（防回滚到未验证版本）', async () => {
  const toolId = 'tool_rb2'
  await reg.createTool({ id: toolId, name: 'rollback_demo2', namespace: 'test' })
  const v = await reg.createVersion({ toolId, semver: '0.1.0', manifest: mkManifest('rollback_demo2', '0.1.0'), source: 'export async function run(){}', tests: [] })
  let threw = null
  try { await reg.setActiveVersion(toolId, v.id) } catch (e) { threw = e }
  ok(threw && /stable/.test(threw.message), 'draft 版本不可设 active（抛错含 stable）')
})

await test('并发创建同名版本 → 系统原子分配，无重复 semver', async () => {
  const toolId = 'tool_conc'
  await reg.createTool({ id: toolId, name: 'conc_demo', namespace: 'evolved' })
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    reg.createVersion({ toolId, manifest: mkManifest('conc_demo', '0.0.0'), source: 'export async function run(){return{}}', tests: [] })))
  const semvers = results.map((r) => r.semver).sort()
  ok(new Set(semvers).size === 5, `5 次并发得到 5 个唯一版本（实际 ${semvers.join(',')}）`)
  ok(semvers[0] === '0.1.0' && semvers[4] === '0.1.4', '从 0.1.0 连续分配')
})

await test('制品篡改 → verifyArtifacts / setStatus(stable) 拒绝', async () => {
  const toolId = 'tool_tamper'
  await reg.createTool({ id: toolId, name: 'tamper_demo', namespace: 'evolved' })
  const v = await reg.createVersion({ toolId, semver: '0.1.0', manifest: mkManifest('tamper_demo', '0.1.0'), source: 'export async function run(){return{v:1}}', tests: [] })
  await reg.setStatus(v.id, 'verified')
  const file = path.join(reg.artifactsDir, 'tamper_demo', '0.1.0', 'index.js')
  fs.writeFileSync(file, 'export async function run(){return{v:999}}')
  let e1 = null
  try { await reg.verifyArtifacts(await reg.getVersion(v.id)) } catch (e) { e1 = e }
  ok(!!e1 && /哈希/.test(e1.message), 'verifyArtifacts 检出篡改')
  let e2 = null
  try { await reg.setStatus(v.id, 'stable') } catch (e) { e2 = e }
  ok(!!e2, 'setStatus stable 拒绝篡改制品')
})

await test('显式 toolId 与 manifest.name 不一致 → 拒绝挂靠', async () => {
  const toolId = 'tool_mismatch'
  await reg.createTool({ id: toolId, name: 'mm_a', namespace: 'evolved' })
  let e = null
  try { await reg.createVersion({ toolId, semver: '0.1.0', manifest: mkManifest('mm_b', '0.1.0'), source: 'export async function run(){}', tests: [] }) } catch (err) { e = err }
  ok(!!e && /不一致/.test(e.message), '拒绝写到别的工具名下')
})

await test('内置工具不可写入自动生成制品', async () => {
  const toolId = 'tool_builtin_guard'
  await reg.createTool({ id: toolId, name: 'builtin_demo', namespace: 'builtin' })
  let e = null
  try {
    await reg.createVersion({ toolId, semver: '0.1.0', manifest: makeManifest({ name: 'builtin_demo', version: '0.1.0', description: '内置工具', inputSchema: { type: 'object' }, provenance: { kind: 'generated' } }), source: 'export async function run(){}', tests: [] })
  } catch (err) { e = err }
  ok(!!e && /内置/.test(e.message), '内置 namespace 拒绝 generated 制品')
})

await closeDb()
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
