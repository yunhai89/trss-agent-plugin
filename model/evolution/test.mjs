/**
 * 离线自检 —— mock agentFactory/变异器 + 真实评估器/优化器/门控，无需联网 / API Key。
 * 运行：node model/evolution/test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  evolve,
  writeReport,
  optimize,
  mulberry32,
  paretoFront,
  pickBest,
  dominates,
  runGates,
  sizeGate,
  testGate,
  semanticGate,
  cacheGate,
  similarity,
  lcpRatio,
  TraceStore,
  fromTraces,
} from './index.js'
import { SelfReviewer } from './review.js'

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
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)})`}`)
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
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evo-'))
}

// ---------- 1. 门控单元 ----------
await test('门控：size / test / semantic / cache', async () => {
  ok(sizeGate('hello', { maxChars: 10 }).passed, 'size 通过')
  ok(!sizeGate('hello', { maxChars: 3 }).passed, 'size 超限拒绝')
  ok(testGate('abc', { tests: [(t) => t.includes('a')] }).passed, 'test 通过')
  ok(!testGate('abc', { tests: [(t) => t.includes('z')] }).passed, 'test 失败拒绝')
  ok(semanticGate('sort numbers ascending', 'sort numbers', { minSimilarity: 0.3 }).passed, 'semantic 相似通过')
  ok(!semanticGate('xyz 完全不同的内容', 'sort numbers', { minSimilarity: 0.3 }).passed, 'semantic 过弱拒绝')
  ok(cacheGate('sort numbers ascending', 'sort numbers', { prefixKeepRatio: 0.5 }).passed, 'cache 前缀保留通过')
  ok(!cacheGate('xyz sort', 'sort numbers', { prefixKeepRatio: 0.5 }).passed, 'cache 前缀破坏拒绝')

  const g = runGates('sort numbers ascending', 'sort numbers', {
    size: { maxChars: 1000 },
    semantic: { minSimilarity: 0.3 },
    cache: { prefixKeepRatio: 0.5 },
  })
  ok(g.passed, 'runGates 全过')
  const g2 = runGates('completely different long text here padding padding', 'sort numbers', {
    semantic: { minSimilarity: 0.3 },
    cache: { prefixKeepRatio: 0.5 },
  })
  ok(!g2.passed && g2.failures.length > 0, 'runGates 汇总失败原因')
})

// ---------- 2. 相似度 / LCP ----------
await test('similarity 与 lcpRatio 边界', async () => {
  eq(similarity('abc', 'abc'), 1, '完全相同 = 1')
  eq(similarity('', ''), 1, '空串 = 1')
  ok(similarity('abcdef', 'abcfed') > 0 && similarity('abcdef', 'abcfed') < 1, '部分相似 ∈ (0,1)')
  eq(lcpRatio('sort', 'sort ascending'), 4 / 14, 'LCP 比例')
  eq(lcpRatio('a', 'b'), 0, '无公共前缀 = 0')
})

// ---------- 3. Pareto / pickBest / dominates ----------
await test('Pareto 前沿与 pickBest', async () => {
  const items = [
    { score: 0.8, length: 100 },
    { score: 0.8, length: 80 },
    { score: 0.6, length: 50 },
    { score: 0.9, length: 200 },
  ]
  const front = paretoFront(items)
  eq(front.length, 3, '前沿 = 非支配集（100 被 80 支配）')
  eq(pickBest(items).score, 0.9, 'pickBest 取最高分')
  eq(pickBest([{ score: 0.8, length: 100 }, { score: 0.8, length: 80 }]).length, 80, '等分取更短')
  ok(dominates({ score: 0.8, length: 80 }, { score: 0.8, length: 100 }), '80 支配 100')
  ok(!dominates({ score: 0.9, length: 200 }, { score: 0.6, length: 50 }), '高分长文本不支配低分短文本')
})

// ---------- 4. mulberry32 确定性 ----------
await test('mulberry32 可复现', async () => {
  const r1 = mulberry32(123)
  const a = [r1(), r1(), r1()]
  const r2 = mulberry32(123)
  eq([r2(), r2(), r2()], a, '同种子序列一致')
})

// ---------- 5. TraceStore ----------
await test('TraceStore：record/all/sample/clear + 持久化', async () => {
  const dir = tmpDir()
  const store = new TraceStore({ dir })
  store.record({ input: 'a', output: 'b' })
  store.record({ input: 'c', output: 'd' })
  eq(store.size, 2, 'size=2')
  eq(store.all().length, 2, 'all=2')
  eq(store.sample(2).length, 2, 'sample 2')
  const store2 = new TraceStore({ dir })
  eq(store2.size, 2, '重开持久化')
  store.clear()
  eq(store.size, 0, 'clear')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------- 6. fromTraces ----------
await test('dataset.fromTraces：轨迹 → Case', async () => {
  const cases = fromTraces([
    { input: 'hi', output: 'yo', taskId: 't1' },
    { input: 'hey', output: 'hey' },
  ])
  eq(cases.length, 2, '2 条 case')
  eq(cases[0].input, 'hi', 'input 透传')
  ok(cases[0].context.trace, 'context.trace 保留')
})

// ---------- 7. 真实端到端：进化循环离线收敛（无 LLM） ----------
await test('进化收敛：反思变异让 score 0→1（真实 evaluate/optimize/gates，mock agentFactory）', async () => {
  // mock agentFactory：把候选 systemPrompt 原样作为回复（便于用 check 判定）
  const echoAgentFactory = (prompt) => ({
    async run() {
      return { content: prompt, messages: [], turns: 1, usage: null, taskId: 't', stopReason: 'stop' }
    },
  })
  // 程序化 case：回复含 SORT 关键字才得分
  const dataset = [
    {
      id: 'c1',
      input: 'sort numbers',
      check: (out) => (/SORT/i.test(out) ? { score: 1, feedback: 'has SORT' } : { score: 0, feedback: 'missing SORT keyword' }),
    },
  ]
  // 反思变异器：评估反馈指出 missing SORT 时，给文本追加 SORT
  const reflectiveMutator = {
    async seed({ baseline }) {
      return [baseline]
    },
    async mutate({ parent, evalResult }) {
      const failing = (evalResult?.perCase || []).some((p) => /missing SORT/i.test(p.feedback || ''))
      if (failing && !/SORT/i.test(parent)) return [`${parent} SORT`]
      return [parent]
    },
    crossover(a) {
      return [a]
    },
  }

  const result = await evolve({
    target: { type: 'systemPrompt', name: 'sorter', text: 'You are a helpful assistant.', goal: '让助手输出排序结果' },
    dataset,
    agentFactory: echoAgentFactory,
    mutator: reflectiveMutator,
    iterations: 3,
    populationSize: 5,
    seed: 42,
  })

  eq(result.baseline.score, 0, '基线 score=0（无 SORT）')
  eq(result.best.score, 1, '最优 score=1（含 SORT）')
  ok(/SORT/i.test(result.best.text), '最优文本含 SORT')
  eq(result.improved, true, 'improved=true')
  ok(result.history.length === 3, '3 轮历史')
})

// ---------- 8. 确定性：同 seed 同结果 ----------
await test('确定性：相同 seed 产出相同 best', async () => {
  const factory = (p) => ({ async run() { return { content: p, messages: [], turns: 1 } } })
  const dataset = [{ id: 'c1', input: 'x', check: (o) => (/GOOD/.test(o) ? 1 : 0) }]
  const mut = {
    async seed({ baseline }) {
      return [baseline, `${baseline} GOOD`]
    },
    async mutate({ parent }) {
      return [/GOOD/.test(parent) ? parent : `${parent} GOOD`]
    },
    crossover(a) {
      return [a]
    },
  }
  const cfg = {
    target: { type: 'systemPrompt', name: 'd', text: 'base' },
    dataset,
    agentFactory: factory,
    mutator: mut,
    iterations: 2,
    seed: 7,
  }
  const r1 = await evolve(cfg)
  const r2 = await evolve(cfg)
  eq(r1.best.text, r2.best.text, '两次 best 一致')
})

// ---------- 9. 门控集成：超长后代被拒绝 ----------
await test('门控集成：超长变体 gateFailed、不入最优', async () => {
  const oversizeMutator = {
    async seed({ baseline }) {
      return [baseline, 'X'.repeat(10000)]
    },
    async mutate({ parent }) {
      return [parent]
    },
    crossover(a) {
      return [a]
    },
  }
  const result = await evolve({
    target: { type: 'systemPrompt', name: 't', text: 'short baseline text' },
    dataset: [{ id: 'c1', input: 'x', check: () => ({ score: 0.5 }) }],
    agentFactory: (p) => ({ async run() { return { content: p, messages: [], turns: 1 } } }),
    mutator: oversizeMutator,
    gates: { size: { maxChars: 100 } },
    iterations: 2,
    populationSize: 5,
    seed: 1,
  })
  const oversize = result.population.find((p) => p.text.length >= 10000)
  ok(oversize, '超长变体在种群中')
  ok(oversize.gateFailed, '超长变体被门控标记')
  eq(oversize.score, 0, '超长变体 score=0')
  ok(result.best.text.length <= 10000, 'best 不是超长变体')
})

// ---------- 10. 报告写出 ----------
await test('writeReport：evolved.md / report.md / state.json', async () => {
  const result = await evolve({
    target: { type: 'systemPrompt', name: 'rep', text: 'base text' },
    dataset: [{ id: 'c1', input: 'x', check: () => ({ score: 0.7 }) }],
    agentFactory: (p) => ({ async run() { return { content: p, messages: [], turns: 1 } } }),
    mutator: { async seed({ b }) { return [] }, async mutate({ parent }) { return [parent] }, crossover(a) { return [a] } },
    iterations: 1,
    seed: 1,
  })
  const dir = path.join(tmpDir(), 'rep')
  const paths = writeReport(result, dir)
  ok(fs.existsSync(paths.evolvedMd), 'evolved.md 生成')
  ok(fs.existsSync(paths.reportMd), 'report.md 生成')
  ok(fs.existsSync(paths.stateJson), 'state.json 生成')
  const report = fs.readFileSync(paths.reportMd, 'utf8')
  ok(report.includes('Evolution Report'), 'report 含标题')
  ok(report.includes('Score history'), 'report 含历史表')
  const state = JSON.parse(fs.readFileSync(paths.stateJson, 'utf8'))
  ok(state.baseline && state.best, 'state 含 baseline/best')
  fs.rmSync(path.dirname(dir), { recursive: true, force: true })
})

// ---------- 11. ✨ Grammar 门控（增强） ----------
await test('grammarGate：括号平衡 + 词数 + 控制字符', async () => {
  const { grammarGate } = await import('./gates.js')
  ok(grammarGate('hello world test').passed, '正常文本通过')
  ok(grammarGate('hello (world) [test] {ok}').passed, '平衡括号通过')
  ok(!grammarGate('hello (world').passed, '未闭合括号拒绝')
  // 比较符不是括号：曾把 < > 当括号 → 含「置信度 < 0.5」「得分 > 0.8」的合法变体被判 0 分淘汰
  ok(grammarGate('当置信度 < 0.5 时重试').passed, '比较符 < 不误判为括号未闭合')
  ok(grammarGate('若得分 > 0.8 才采纳').passed, '比较符 > 不误判为括号不匹配')
  ok(!grammarGate('hi').passed, '词数不足拒绝')
  ok(grammarGate('hello world test', { minWords: 1 }).passed, 'minWords=1 通过')
  // runGates 含 grammar
  const { runGates } = await import('./gates.js')
  const g = runGates('正常文本测试', '正常文本', {})
  ok(g.passed, 'runGates 含 grammar 默认通过')
  ok(g.details.grammar, 'runGates 返回 grammar 详情')
  // grammar: false 关闭
  const g2 = runGates('hi', 'baseline', { grammar: false })
  ok(!g2.details.grammar, 'grammar: false 时不含 grammar 详情')
})

// ---------- 12. ✨ 早停（patience） ----------
await test('早停：patience 触发提前终止', async () => {
  const factory = (p) => ({ async run() { return { content: p, messages: [], turns: 1 } } })
  const dataset = [{ id: 'c1', input: 'x', check: (o) => (/GOOD/.test(o) ? 1 : 0) }]
  // mutator 永远不变（返回 parent 本身）→ score 永远不涨 → patience=2 应在第 3 轮早停
  const mut = {
    async seed({ baseline }) { return [baseline] },
    async mutate({ parent }) { return [parent] },
    crossover(a) { return [a] },
    crossoverParagraph(a) { return [a] },
  }
  const result = await evolve({
    target: { type: 'systemPrompt', name: 'es', text: 'base' },
    dataset, agentFactory: factory, mutator: mut,
    iterations: 10, patience: 2, seed: 1,
  })
  ok(result.stoppedEarly === true, 'patience=2 → 早停')
  ok(result.actualIterations <= 3, `实际迭代 ${result.actualIterations} <= 3`)
})

// ---------- 13. ✨ 自适应变异温度 + 段落交叉 ----------
await test('自适应温度 + 段落交叉：低多样性→高温度', async () => {
  let receivedTemp = null
  const factory = (p) => ({ async run() { return { content: p, messages: [], turns: 1 } } })
  const dataset = [{ id: 'c1', input: 'x', check: (o) => (/GOOD/.test(o) ? 1 : 0) }]
  const mut = {
    async seed({ baseline }) { return [baseline, `${baseline} GOOD`] },
    async mutate({ parent, temperature }) { receivedTemp = temperature; return [`${parent} GOOD`] },
    crossover(a) { return [a] },
    crossoverParagraph(a, b) { return [a.split('\n\n')[0] + '\n\n' + b.split('\n\n').pop()] },
  }
  const result = await evolve({
    target: { type: 'systemPrompt', name: 'at', text: 'base' },
    dataset, agentFactory: factory, mutator: mut,
    iterations: 2, seed: 1,
  })
  ok(receivedTemp != null && receivedTemp >= 0 && receivedTemp <= 1, `收到 temperature=${receivedTemp}`)
  // 段落交叉被调用（crossoverParagraph 存在且 useParagraphCrossover 默认 true）
  ok(typeof mut.crossoverParagraph === 'function', 'crossoverParagraph 可用')
})

// ---------- 第 7 轮 L1/L2：自评审日界与 per-scope 计数上限 ----------
await test('审计回归：日预算按本地日界重置、_counts 有容量上限', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-review-'))
  try {
    const r = new SelfReviewer({ provider: { name: 'mock' }, suggestionDir: dir, dailyBudgetTokens: 100, logger: () => {} })
    // L1：日界取本地日期（此前 toISOString 取 UTC，东八区要到北京时间 08:00 才重置当日预算）
    const d = new Date()
    const localKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    r._usedTokens = 999
    ok(r._budgetExhausted() === false, '跨日即重置已用预算（本地日界）')
    ok(r._budgetDay === localKey, `预算日界用本地日期（${r._budgetDay}）`)
    ok(r._usedTokens === 0, '重置后已用归零')
    r._usedTokens = 999
    ok(r._budgetExhausted() === true, '同日超预算即闸住评审')
    // L2：per-scope 计数 Map 不再无上限增长（此前只增不删）
    for (let i = 0; i < 2000; i++) r._counts.set(`s${i}`, 1)
    r.tick({ scopeId: 'brand-new-scope' })
    ok(r._counts.size <= 2000 && r._counts.get('brand-new-scope') === 1, `_counts 触顶后清零重计（size=${r._counts.size}）`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
