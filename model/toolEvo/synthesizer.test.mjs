/**
 * ToolSynthesizer 候选契约自检（审计 P1-2）：
 *   - 生成 schema 符合各协议普遍支持的严格子集（对象关闭 additionalProperties、required 覆盖全部属性）；
 *   - 任意 inputSchema/fixture 用 JSON 字符串封装并在本地解析；
 *   - permissions 深合并受信默认、拒绝越权声明；缺字段/非法 JSON/缺 oracle 失败。
 * 运行：node model/toolEvo/synthesizer.test.mjs
 */
import assert from 'node:assert/strict'
import { ToolSynthesizer, CANDIDATE_SCHEMA } from './synthesizer.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

function walkSchema(node, path, problems) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) { for (const s of (node.anyOf || node.oneOf)) walkSchema(s, path, problems) }
  if (node.type === 'object' && node.properties) {
    if (node.additionalProperties !== false) problems.push(`${path} 未关闭 additionalProperties`)
    const keys = Object.keys(node.properties).sort()
    const req = [...(node.required || [])].sort()
    if (JSON.stringify(keys) !== JSON.stringify(req)) problems.push(`${path} required 未覆盖全部属性`)
    for (const [k, v] of Object.entries(node.properties)) walkSchema(v, `${path}.${k}`, problems)
  }
  if (node.items) walkSchema(node.items, `${path}[]`, problems)
}

await test('生成 schema 是严格的受支持子集（每个 object 关闭 additionalProperties 且 required 全覆盖）', async () => {
  const problems = []
  walkSchema(CANDIDATE_SCHEMA, '$', problems)
  assert.deepEqual(problems, [], 'schema 不符合 strict 子集：' + problems.join('; '))
  ok(!/minLength|pattern|minItems/.test(JSON.stringify(CANDIDATE_SCHEMA)), '不含部分兼容端不支持的约束关键字')
})

function candidate(over = {}) {
  const base = {
    manifest: {
      name: 'double_it', description: '把输入数字加倍返回', category: 'query',
      useWhen: [], doNotUseWhen: [], tags: [],
      inputSchemaJson: JSON.stringify({ type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }),
      permissions: { sideEffects: ['none'] },
    },
    source: 'export async function run(input){ return { doubled: (input.n||0)*2 } }',
    tests: [
      { name: 'a', inputJson: JSON.stringify({ n: 2 }), expectedJson: JSON.stringify({ doubled: 4 }) },
      { name: 'b', inputJson: JSON.stringify({ n: 0 }), expectedJson: JSON.stringify({ doubled: 0 }) },
    ],
    assumptions: [],
  }
  return { ...base, ...over, manifest: { ...base.manifest, ...(over.manifest || {}) } }
}

async function genWith(payload) {
  const provider = { async chat() { return { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } } }
  return new ToolSynthesizer({ provider, model: 'mock', maxRepairAttempts: 0 }).generate({ goal: 'g' })
}

await test('合法候选：解析 input/expected，受信默认补齐 network=deny', async () => {
  const r = await genWith(candidate())
  assert.equal(r.ok, true, r.error)
  assert.equal(r.candidate.tests[0].expected.doubled, 4, 'expectedJson 已解析')
  assert.deepEqual(r.candidate.manifest.permissions.network, { mode: 'deny', hosts: [] }, 'network 默认 deny')
  assert.deepEqual(r.candidate.manifest.permissions.filesystem, { read: [], write: [] }, 'filesystem 默认空')
  assert.equal(r.candidate.manifest.version, '0.1.0', '版本由系统给默认')
  assert.equal(r.candidate.manifest.provenance.kind, 'generated')
})

await test('expected 可为 null/false/0（JSON 字符串承载，不视为缺失）', async () => {
  const r = await genWith(candidate({
    source: 'export async function run(input){ return input.n }',
    tests: [
      { name: 'null', inputJson: JSON.stringify({ n: null }), expectedJson: 'null' },
      { name: 'false', inputJson: JSON.stringify({ n: false }), expectedJson: 'false' },
      { name: 'zero', inputJson: JSON.stringify({ n: 0 }), expectedJson: '0' },
    ],
  }))
  assert.equal(r.ok, true, r.error)
  assert.equal(r.candidate.tests[0].expected, null)
  assert.equal(r.candidate.tests[1].expected, false)
  assert.equal(r.candidate.tests[2].expected, 0)
})

await test('越权声明（network allowlist / filesystem）→ 生成闸拒绝', async () => {
  const r = await genWith(candidate({ manifest: { permissions: { sideEffects: ['read'], network: { mode: 'allowlist', hosts: ['x'] } } } }))
  assert.equal(r.ok, false)
  assert.match(r.error, /生成闸/)
})

await test('非 none/read 副作用 → 生成闸拒绝', async () => {
  const r = await genWith(candidate({ manifest: { permissions: { sideEffects: ['write'] } } }))
  assert.equal(r.ok, false)
})

await test('缺 oracle / 非法 JSON / 缺字段 → 失败（不伪装成功）', async () => {
  const noOracle = await genWith(candidate({ tests: [{ name: 'a', inputJson: '{"n":2}', expectedJson: '' }] }))
  assert.equal(noOracle.ok, false, '空 expectedJson 应失败')
  const badJson = await genWith(candidate({ manifest: { inputSchemaJson: '{not json' } }))
  assert.equal(badJson.ok, false, '非法 inputSchemaJson 应失败')
  const missing = await genWith({ manifest: { name: 'x' } })
  assert.equal(missing.ok, false, '缺 tests/source 应失败')
})

await test('截断/拒答文本 → 失败', async () => {
  const truncated = await genWith('{"manifest":{"name":"x"')
  assert.equal(truncated.ok, false)
  const refusal = await genWith('抱歉，我无法生成该工具。')
  assert.equal(refusal.ok, false)
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
