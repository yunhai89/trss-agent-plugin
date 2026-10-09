// SelfReviewer 单元测试 —— 离线 mock，验证：tick 计数触发、分级应用、强约束过滤、落盘/读取
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SelfReviewer, listPendingSuggestions, removeSuggestion, applySuggestion } from './review.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.log('  ✗ FAIL', m) } }
const test = (name, fn) => fn().catch((e) => { failed++; console.log('  ✗ THROW', name, e?.message || e) })
const tick = () => new Promise((r) => setTimeout(r, 50)) // 等 setImmediate 内的 _review 跑完

const mockProvider = (reply) => ({ chat: async () => ({ content: reply, usage: { total_tokens: 100 } }) })
const mockMemory = () => {
  const calls = []
  return {
    add: async (t, text) => { calls.push({ op: 'add', t, text }); return { ok: true } },
    remove: async (t, text) => { calls.push({ op: 'remove', t, text }); return { ok: true } },
    replace: async (t, a, b) => { calls.push({ op: 'replace', t, a, b }); return { ok: true } },
    snapshotAll: () => 'MEMORY\n- 旧条目',
    _calls: calls,
  }
}
const mockTrace = () => {
  const arr = [{ scope: 'u1', input: '我喜欢猫', output: '好的' }, { scope: 'u1', input: '叫我小明', output: '好的' }]
  return { all: () => arr, sample: (n) => arr.slice(0, n), size: arr.length }
}
const mockSkills = () => ({ list: () => [] })

await test('memory 类高置信 → 自动应用 + 落盘留痕', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-'))
  const mem = mockMemory()
  const r = new SelfReviewer({
    provider: mockProvider(JSON.stringify([{ kind: 'memory', action: 'add', target: 'memory', payload: '用户喜欢猫', rationale: '偏好', confidence: 0.8 }])),
    model: 'm', traceStore: mockTrace(), memory: mem, skills: mockSkills(), suggestionDir: dir, every: 1, logger: () => {},
  })
  r.tick({ scopeUserId: 'u1', scopeId: 'u1' }, {})
  await tick()
  ok(mem._calls.some((c) => c.op === 'add' && c.text === '用户喜欢猫'), 'memory 高置信自动写入')
  const files = fs.readdirSync(path.join(dir, 'u1')).filter((f) => f.endsWith('.json'))
  ok(files.length === 1, '已应用 suggestion 也落盘留痕（listPending 只列待审；已应用的查文件）')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('prompt 类 → 落盘待审，不自动写 memory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-'))
  const mem = mockMemory()
  const r = new SelfReviewer({
    provider: mockProvider(JSON.stringify([{ kind: 'prompt', action: 'update', target: 'agent', payload: '你是更聪明的助手', rationale: '改进', confidence: 0.9 }])),
    model: 'm', traceStore: mockTrace(), memory: mem, skills: mockSkills(), suggestionDir: dir, every: 1, autoApplyPrompt: false, logger: () => {},
  })
  r.tick({ scopeUserId: 'u2', scopeId: 'u2' }, {})
  await tick()
  ok(mem._calls.length === 0, 'prompt 类不自动写 memory')
  const p = listPendingSuggestions(dir, 'u2')
  ok(p.length === 1 && p[0].kind === 'prompt' && p[0].status === 'pending', 'prompt 落盘待审')
  ok(removeSuggestion(dir, 'u2', p[0].id), 'removeSuggestion 删除')
  ok(listPendingSuggestions(dir, 'u2').length === 0, '删除后无待审')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('tick 计数：未到 every 不触发 LLM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-'))
  let chatCalled = 0
  const r = new SelfReviewer({
    provider: { chat: async () => { chatCalled++; return { content: '[]' } } },
    model: 'm', traceStore: mockTrace(), memory: mockMemory(), skills: mockSkills(), suggestionDir: dir, every: 3, logger: () => {},
  })
  r.tick({ scopeUserId: 'u3', scopeId: 'u3' }, {})
  r.tick({ scopeUserId: 'u3', scopeId: 'u3' }, {})
  await tick()
  ok(chatCalled === 0, '2<3 未触发')
  r.tick({ scopeUserId: 'u3', scopeId: 'u3' }, {})
  await tick()
  ok(chatCalled === 1, '到 3 触发一次')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('强约束：低置信 memory + 非白名单 kind 被过滤', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-'))
  const mem = mockMemory()
  const r = new SelfReviewer({
    provider: mockProvider(JSON.stringify([
      { kind: 'memory', action: 'add', payload: '低置信', confidence: 0.3 },
      { kind: 'eval', action: 'x', payload: '非法', confidence: 0.9 }, // eval 非白名单（tool 已是合法 kind，会走 toolEvo 建 draft，故此处用 eval 验证白名单过滤）
    ])),
    model: 'm', traceStore: mockTrace(), memory: mem, skills: mockSkills(), suggestionDir: dir, every: 1, logger: () => {},
  })
  r.tick({ scopeUserId: 'u4', scopeId: 'u4' }, {})
  await tick()
  ok(mem._calls.length === 0, '低置信 memory 不自动应用')
  ok(listPendingSuggestions(dir, 'u4').length === 0, '低置信 + 非白名单全过滤，无落盘')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('enable=false → tick 不触发', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-'))
  let chatCalled = 0
  const r = new SelfReviewer({
    provider: { chat: async () => { chatCalled++; return { content: '[]' } } },
    model: 'm', traceStore: mockTrace(), memory: mockMemory(), skills: mockSkills(), suggestionDir: dir, enable: false, every: 1, logger: () => {},
  })
  r.tick({ scopeUserId: 'u5', scopeId: 'u5' }, {})
  await tick()
  ok(chatCalled === 0, 'enable=false 完全静默')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('applySuggestion：promptDir 不存在时自动创建并落盘（修 ENOENT 首次采纳崩溃）', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-apply-'))
  const promptDir = path.join(base, 'prompts-not-exist') // 故意不预建
  const suggestionDir = path.join(base, 'sugg')
  fs.mkdirSync(suggestionDir, { recursive: true })
  const tpl = { id: 'agent', system: 'old', version: '1.0.0', toJSON() { return { id: this.id, system: this.system, version: this.version } }, addChange() {} }
  const rt = { promptRegistry: { get: (k) => (k === 'agent' ? tpl : null) }, memory: null, promptDir, suggestionDir }
  ok(!fs.existsSync(promptDir), '前置：promptDir 不存在')
  const r = await applySuggestion(rt, { id: 's1', scopeId: 'u1', kind: 'prompt', action: 'update', target: 'agent', payload: 'new system', rationale: 'x' })
  ok(r.ok, '应用成功（不再抛 ENOENT）')
  const file = path.join(promptDir, 'agent.json')
  ok(fs.existsSync(file), 'promptDir 被创建且文件已写入')
  ok(JSON.parse(fs.readFileSync(file, 'utf8')).system === 'new system', '落盘内容正确')
  fs.rmSync(base, { recursive: true, force: true })
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed) process.exit(1)
