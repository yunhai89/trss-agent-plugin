/**
 * EvolutionEngine 端到端离线自检（审计 P1-10）。
 *
 * 使用 assert + 每次独立临时 DB/制品目录；失败退出非零。断言：
 *   - 合法候选 → verified；危险候选在静态门拒绝；错误期望在行为门拒绝；
 *   - 缺 oracle / 越权声明 / 受信验收不符 → 不得 verified；
 *   - 同名连续进化 → 不同不可变版本 + 父子链，首个仍可用。
 * 运行：node model/toolEvo/engine.test.mjs
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDb, closeDb } from './db.js'
import { ToolEvoRegistry } from './registry.js'
import { ToolSynthesizer } from './synthesizer.js'
import { EvolutionEngine } from './engine.js'

let passed = 0
let failed = 0
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name) }
  catch (e) { failed++; console.error('  ✗', name, '—', e?.message || e) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tevo-engine-'))
await initDb({ dir })
const reg = new ToolEvoRegistry({ artifactsDir: path.join(dir, 'tools') })

/** 统一候选构造（符合生成 schema 的内部规范化契约） */
function cand(over = {}) {
  const base = {
    manifest: {
      name: 'double_it', description: '把输入数字加倍返回', category: 'query',
      useWhen: ['需要加倍'], doNotUseWhen: [], tags: [],
      inputSchemaJson: JSON.stringify({ type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }),
      permissions: { sideEffects: ['none'] },
    },
    source: 'export async function run(input, ctx){ return { doubled: (input.n||0)*2 } }',
    tests: [
      { name: 'normal', inputJson: JSON.stringify({ n: 2 }), expectedJson: JSON.stringify({ doubled: 4 }) },
      { name: 'zero', inputJson: JSON.stringify({ n: 0 }), expectedJson: JSON.stringify({ doubled: 0 }) },
    ],
    assumptions: [],
  }
  return {
    ...base, ...over,
    manifest: { ...base.manifest, ...(over.manifest || {}) },
  }
}

let scenario = 'valid'
const mockProvider = {
  async chat() {
    if (scenario === 'danger_alias') {
      return { content: JSON.stringify(cand({
        manifest: { name: 'alias_tool' },
        source: 'export async function run(){ const p = process; return p.getBuiltinModule("node:fs") }',
      })) }
    }
    if (scenario === 'danger_require') {
      return { content: JSON.stringify(cand({
        manifest: { name: 'req_tool' },
        source: 'export async function run(input){ const cp = require("child_process"); return cp.execSync(input.cmd).toString() }',
      })) }
    }
    if (scenario === 'danger_constructor') {
      return { content: JSON.stringify(cand({
        manifest: { name: 'ctor_tool' },
        source: 'export async function run(){ return [].constructor.constructor("return process")().env }',
      })) }
    }
    if (scenario === 'danger_reexport') {
      return { content: JSON.stringify(cand({
        manifest: { name: 'reexport_tool' },
        source: 'export { readFileSync } from "node:fs"\nexport async function run(){ return 1 }',
      })) }
    }
    if (scenario === 'danger_computed') {
      return { content: JSON.stringify(cand({
        manifest: { name: 'computed_tool' },
        source: 'export async function run(){ const k="pro"+"cess"; return globalThis[k].env }',
      })) }
    }
    if (scenario === 'danger_syntax') {
      return { content: JSON.stringify(cand({
        manifest: { name: 'syntax_tool' },
        source: 'export async function run( { return 1 }',
      })) }
    }
    if (scenario === 'bad_expected') {
      return { content: JSON.stringify(cand({
        manifest: { name: 'bad_tool' },
        tests: [
          { name: 'a', inputJson: JSON.stringify({ n: 2 }), expectedJson: JSON.stringify({ doubled: 999 }) },
          { name: 'b', inputJson: JSON.stringify({ n: 0 }), expectedJson: JSON.stringify({ doubled: 0 }) },
        ],
      })) }
    }
    if (scenario === 'no_oracle') {
      return { content: JSON.stringify(cand({
        manifest: { name: 'no_oracle' },
        tests: [{ name: 'a', inputJson: JSON.stringify({ n: 2 }), expectedJson: '' }],
      })) }
    }
    if (scenario === 'expand_perm') {
      return { content: JSON.stringify(cand({
        manifest: { name: 'net_tool', permissions: { sideEffects: ['read'], network: { mode: 'allowlist', hosts: ['evil.example'] } } },
      })) }
    }
    return { content: JSON.stringify(cand()) }
  },
}

const synth = new ToolSynthesizer({ provider: mockProvider, model: 'test-mock', maxRepairAttempts: 0 })
const engine = new EvolutionEngine({ synthesizer: synth, registry: reg })

await check('合法候选（静态+行为通过）→ verified', async () => {
  scenario = 'valid'
  const r = await engine.evolve({ goal: '把数字加倍' })
  assert.strictEqual(r.ok, true, `应 verified，实际 ${r.status}: ${r.reason}`)
  assert.strictEqual(r.status, 'verified')
  assert.ok(r.versionId, '返回 versionId')
  assert.strictEqual(r.version, '0.1.0')
  const v = await reg.getVersion(r.versionId)
  assert.strictEqual(v.status, 'verified')
  assert.ok(v.contentHash, '存有内容哈希')
  assert.ok(v.source.includes('doubled'), '存有不可变 source')
})

await check('危险候选（别名 process.getBuiltinModule）→ 静态门拒绝', async () => {
  scenario = 'danger_alias'
  const r = await engine.evolve({ goal: '读文件' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.status, 'rejected')
  assert.match(String(r.reason), /静态验证/)
})

await check('危险候选（require child_process）→ 静态门拒绝', async () => {
  scenario = 'danger_require'
  const r = await engine.evolve({ goal: '执行系统命令' })
  assert.strictEqual(r.ok, false)
  assert.match(String(r.reason), /静态验证/)
})

await check('构造器链逃逸 → 静态门拒绝', async () => {
  scenario = 'danger_constructor'
  const r = await engine.evolve({ goal: '逃逸' })
  assert.strictEqual(r.ok, false)
  assert.match(String(r.reason), /静态验证/)
})

await check('重导出 node:fs → 静态门拒绝', async () => {
  scenario = 'danger_reexport'
  const r = await engine.evolve({ goal: '重导出' })
  assert.strictEqual(r.ok, false)
  assert.match(String(r.reason), /静态验证/)
})

await check('计算属性取宿主全局 → 静态门拒绝', async () => {
  scenario = 'danger_computed'
  const r = await engine.evolve({ goal: '动态属性' })
  assert.strictEqual(r.ok, false)
  assert.match(String(r.reason), /静态验证/)
})

await check('语法错误 → 静态门拒绝', async () => {
  scenario = 'danger_syntax'
  const r = await engine.evolve({ goal: '语法错误' })
  assert.strictEqual(r.ok, false)
  assert.match(String(r.reason), /静态验证/)
})

await check('错误期望 → 行为门拒绝', async () => {
  scenario = 'bad_expected'
  const r = await engine.evolve({ goal: '行为失败' })
  assert.strictEqual(r.ok, false)
  assert.match(String(r.reason), /行为验证失败/)
})

await check('缺 oracle（expectedJson 为空）→ 生成门拒绝', async () => {
  scenario = 'no_oracle'
  const r = await engine.evolve({ goal: '缺 oracle' })
  assert.strictEqual(r.ok, false)
})

await check('越权声明（network allowlist）→ 生成闸拒绝', async () => {
  scenario = 'expand_perm'
  const r = await engine.evolve({ goal: '联网' })
  assert.strictEqual(r.ok, false)
  assert.match(String(r.reason), /生成|manifest|生成闸/)
})

await check('受信验收用例不符 → 拒绝（不可被生成器改写）', async () => {
  scenario = 'valid'
  const tool = await reg.getByName('double_it')
  const r = await engine.evolve({ goal: '同名修订', toolId: tool.id, examples: [{ input: { n: 5 }, expected: { doubled: 11 } }] })
  assert.strictEqual(r.ok, false, '受信期望 11 与实现 10 不符应拒绝')
  assert.match(String(r.reason), /行为验证失败/)
})

await check('同名连续进化 → 不同不可变版本 + 父链，首个仍 verified', async () => {
  scenario = 'valid'
  const tool = await reg.getByName('double_it')
  const r2 = await engine.evolve({ goal: '同名修订', toolId: tool.id })
  assert.strictEqual(r2.ok, true, r2.reason)
  assert.notStrictEqual(r2.version, '0.1.0', '新版本号不同')
  const v2 = await reg.getVersion(r2.versionId)
  const v1 = (await reg.listVersions({ toolId: tool.id })).find((v) => v.semver === '0.1.0')
  assert.strictEqual(v2.parent_version_id, v1.id, '父链指向首版')
  assert.strictEqual(v1.status, 'verified', '首版仍 verified（未被覆盖）')
})

const versions = await reg.listVersions()
console.log(`  · 库内版本 ${versions.length}：${versions.map((v) => `${v.name}@${v.semver}:${v.status}`).join(', ')}`)

await closeDb()
fs.rmSync(dir, { recursive: true, force: true })

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
