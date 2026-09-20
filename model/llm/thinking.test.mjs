/**
 * 离线自检 —— 思考自动决策：复杂度分档 / 厂商原生字段编码 / 预算硬顶。
 * 运行：node model/llm/thinking.test.mjs
 */
import { classifyComplexity, encodeThinking, resolveThinkingStyle, decideThinking, decideThinkingSmart, classifyWithModel, parseClassifierOutput, shouldAskModel, clearThinkingCache, thinkingLogFields, DEFAULT_BUDGETS, DEFAULT_MAX_BUDGET } from './thinking.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }

await test('classifyComplexity：闲聊/简单 → off', async () => {
  eq(classifyComplexity('你好').depth, 'off', '寒暄 → off')
  eq(classifyComplexity('谢谢').depth, 'off', '道谢 → off')
  eq(classifyComplexity('哈哈哈哈哈').depth, 'off', '纯笑 → off')
  eq(classifyComplexity('北京在哪').depth, 'off', '短事实、无信号 → off')
  eq(classifyComplexity('').depth, 'off', '空 → off')
})

await test('classifyComplexity：简单问题 → low', async () => {
  eq(classifyComplexity('今天天气怎么样').depth, 'low', '单个疑问词 → low')
  eq(classifyComplexity('把这句话翻译成英文').depth, 'low', '轻任务 → low')
})

await test('classifyComplexity：代码/多步 → medium', async () => {
  const d = classifyComplexity('这段代码为什么报错？\n```js\nconst a = 1\n```')
  eq(d.depth, 'medium', `代码+分析 → medium（实际 ${d.depth}, score ${d.score}）`)
  const d2 = classifyComplexity('先用 find 找到文件，然后批量重命名并导出清单')
  ok(['medium', 'low'].includes(d2.depth), `多步任务 ≥ low（实际 ${d2.depth}）`)
})

await test('classifyComplexity：复杂设计 → high', async () => {
  const d = classifyComplexity('请帮我设计一个分布式系统的架构，分析一致性、容错与性能优化，并给出完整实现方案和几种技术选型的对比')
  eq(d.depth, 'high', `架构/分析/设计 → high（实际 ${d.depth}, score ${d.score}）`)
  ok(d.reasons.length > 0, '带判定理由')
})

await test('classifyComplexity：显式"讲深/讲浅"/约束 会升降档', async () => {
  const deep = classifyComplexity('详细讲讲这段代码为什么报错，并给出几种方案对比')
  eq(deep.depth, 'high', `"详细" + 代码/分析 → high（实际 ${deep.depth}, score ${deep.score}）`)
  ok(deep.reasons.includes('depth-ask'), '命中 depth-ask')
  const brief = classifyComplexity('简单说下今天天气')
  eq(brief.depth, 'off', `"简单说…" 降档（实际 ${brief.depth}, score ${brief.score}）`)
  ok(brief.reasons.includes('brevity-ask'), '命中 brevity-ask')
  const cons = classifyComplexity('约束：输出不超过 10 行，必须包含异常处理')
  ok(['low', 'medium'].includes(cons.depth) && cons.reasons.includes('constraint'), `约束条件升档（实际 ${cons.depth}, reasons ${cons.reasons}）`)
})

await test('classifyComplexity：预算 = 档位预算，且受 maxBudget 硬顶', async () => {
  ok(classifyComplexity('请帮我设计一个分布式系统的架构并给出实现方案', {}).budget >= DEFAULT_BUDGETS.high, 'high 预算')
  const capped = classifyComplexity('请帮我设计一个分布式系统的架构，分析一致性与容错，并给出实现方案', { budgets: { high: 99999 }, maxBudget: 10000 })
  eq(capped.depth, 'high', '仍判 high')
  eq(capped.budget, 10000, '预算被 maxBudget 截断')
  eq(classifyComplexity('你好', { maxBudget: 10000 }).budget, 0, 'off 预算 0')
})

await test('resolveThinkingStyle：预设表优先，网关按模型回退', async () => {
  eq(resolveThinkingStyle({ protocol: 'openai', preset: 'mimo' }), 'thinking_toggle', 'MiMo → thinking_toggle')
  eq(resolveThinkingStyle({ protocol: 'openai', preset: 'deepseek' }), 'deepseek', 'DeepSeek → deepseek')
  eq(resolveThinkingStyle({ protocol: 'openai', preset: 'dashscope' }), 'enable_thinking', 'DashScope → enable_thinking')
  eq(resolveThinkingStyle({ protocol: 'openai', preset: 'minimax' }), 'minimax', 'MiniMax → minimax')
  eq(resolveThinkingStyle({ protocol: 'anthropic', preset: 'anthropic' }), 'anthropic_budget', 'Anthropic → budget')
  eq(resolveThinkingStyle({ protocol: 'openai', preset: 'opencode-go', model: 'gpt-5.5' }), 'reasoning_effort', '网关 GPT → reasoning_effort')
  eq(resolveThinkingStyle({ protocol: 'openai', preset: 'unknown', model: 'gemini-3' }), 'reasoning_effort', '未知预设 Gemini → reasoning_effort')
  eq(resolveThinkingStyle({ protocol: 'openai', preset: 'mimo', presetStyle: 'reasoning_effort' }), 'reasoning_effort', '显式覆盖优先')
})

await test('encodeThinking：各厂商原生字段', async () => {
  // MiMo / Kimi / GLM / 豆包 等：thinking:{type}
  eq(encodeThinking({ depth: 'high', protocol: 'openai', preset: 'mimo' }), { thinking: { type: 'enabled' } }, 'mimo on')
  eq(encodeThinking({ depth: 'off', protocol: 'openai', preset: 'mimo' }), { thinking: { type: 'disabled' } }, 'mimo off')
  // DeepSeek：thinking + reasoning_effort
  eq(encodeThinking({ depth: 'high', budget: 16384, protocol: 'openai', preset: 'deepseek' }), { thinking: { type: 'enabled' }, reasoning_effort: 'high' }, 'deepseek on')
  eq(encodeThinking({ depth: 'low', protocol: 'openai', preset: 'deepseek' }).reasoning_effort, 'low', 'deepseek low')
  eq(encodeThinking({ depth: 'off', protocol: 'openai', preset: 'deepseek' }), { thinking: { type: 'disabled' } }, 'deepseek off')
  // DashScope/Qwen：enable_thinking + thinking_budget
  eq(encodeThinking({ depth: 'medium', budget: 8192, protocol: 'openai', preset: 'dashscope' }), { enable_thinking: true, thinking_budget: 8192 }, 'qwen on+budget')
  eq(encodeThinking({ depth: 'off', protocol: 'openai', preset: 'dashscope' }), { enable_thinking: false }, 'qwen off')
  // MiniMax M3：adaptive/disabled
  eq(encodeThinking({ depth: 'medium', protocol: 'openai', preset: 'minimax' }), { thinking: { type: 'adaptive' } }, 'minimax adaptive')
  eq(encodeThinking({ depth: 'off', protocol: 'openai', preset: 'minimax' }), { thinking: { type: 'disabled' } }, 'minimax disabled')
  // Anthropic：budget_tokens
  eq(encodeThinking({ depth: 'high', budget: 16384, protocol: 'anthropic', preset: 'anthropic' }), { thinking: { type: 'enabled', budget_tokens: 16384 } }, 'anthropic budget')
  eq(encodeThinking({ depth: 'off', protocol: 'anthropic', preset: 'anthropic' }), { thinking: { type: 'disabled' } }, 'anthropic off')
  // OpenAI o 系 / GPT：reasoning_effort（off 不传，模型默认）
  eq(encodeThinking({ depth: 'high', protocol: 'openai', preset: 'openai', model: 'o3' }), { reasoning_effort: 'high' }, 'o3 effort')
  eq(encodeThinking({ depth: 'off', protocol: 'openai', preset: 'openai', model: 'o3' }), {}, 'o3 off 不传')
  // Gemini 原生：thinking_level
  eq(encodeThinking({ depth: 'high', protocol: 'gemini', preset: 'gemini' }), { thinking: { thinking_level: 'high' } }, 'gemini level')
})

await test('decideThinking：一步到位（复杂度 + 编码 + 风格）', async () => {
  const r = decideThinking('请设计一个分布式系统的架构并分析容错', { protocol: 'openai', preset: 'mimo' })
  eq(r.depth, 'high', '判 high')
  eq(r.style, 'thinking_toggle', '风格')
  eq(r.thinking, { type: 'enabled' }, '编码思考')
  const c = decideThinking('在吗', { protocol: 'openai', preset: 'mimo' })
  eq(c.depth, 'off', '闲聊 off')
  eq(c.thinking, { type: 'disabled' }, '关闭编码')
  eq(DEFAULT_MAX_BUDGET, 32768, '默认硬顶')
})

await test('parseClassifierOutput：容错解析小模型输出', async () => {
  eq(parseClassifierOutput('{"depth":"high","reason":"架构设计"}'), 'high', '标准 JSON')
  eq(parseClassifierOutput('```json\n{"depth":"low"}\n```'), 'low', 'code fence')
  eq(parseClassifierOutput('结论是 {"depth":"Medium"} 请执行'), 'medium', '前后缀 + 大小写')
  eq(parseClassifierOutput('depth: high'), 'high', 'depth: 前缀宽松解析')
  eq(parseClassifierOutput('我觉得需要思考'), null, '非结构化 → null')
  eq(parseClassifierOutput('{"depth":"extreme"}'), null, '非法档位 → null')
  eq(parseClassifierOutput(''), null, '空')
})

await test('classifyWithModel：调用/超时/解析失败', async () => {
  const llm = { run: async () => ({ content: '{"depth":"high"}' }) }
  const r = await classifyWithModel('随便', { llm, timeoutMs: 1000 })
  eq(r.depth, 'high', '取模型判定')
  eq(r.source, 'model', '来源 model')
  // 超时 → null（不抛）
  const slow = { run: () => new Promise(() => {}) }
  eq(await classifyWithModel('x', { llm: slow, timeoutMs: 50 }), null, '超时 → null')
  // 解析失败 → null
  eq(await classifyWithModel('x', { llm: { run: async () => '嗯' }, timeoutMs: 500 }), null, '解析失败 → null')
  eq(await classifyWithModel('x', { llm: null }), null, '无 llm → null')
})

await test('shouldAskModel：auto 仅在规则不确定时问模型', async () => {
  eq(shouldAskModel('你好', classifyComplexity('你好'), 'auto'), false, '寒暄 → 不问')
  eq(shouldAskModel('北京在哪', classifyComplexity('北京在哪'), 'auto'), true, '灰区 → 问')
  eq(shouldAskModel('请设计一个分布式系统架构并分析一致性与容错，给出完整实现方案', classifyComplexity('请设计一个分布式系统架构并分析一致性与容错，给出完整实现方案'), 'auto'), false, '规则确定 high → 不问')
  eq(shouldAskModel('北京在哪', classifyComplexity('北京在哪'), 'off'), false, 'off 模式不问')
  eq(shouldAskModel('你好', classifyComplexity('你好'), 'always'), true, 'always 总问')
})

await test('decideThinkingSmart：小模型优先 + 规则兜底 + 缓存', async () => {
  clearThinkingCache()
  let calls = 0
  const llm = { run: async () => { calls++; return { content: '{"depth":"high"}' } } }
  // 灰区问题 → 用模型（短事实规则判 off，模型判 high）
  const a = await decideThinkingSmart('北京在哪', { llm, classifier: 'always', protocol: 'openai', preset: 'mimo' })
  eq(a.depth, 'high', '模型覆盖规则')
  eq(a.source, 'model', '来源 model')
  eq(a.thinking, { type: 'enabled' }, '编码开启')
  eq(calls, 1, '调用一次')
  // 同样文本再问 → 命中缓存，不再调用
  await decideThinkingSmart('北京在哪', { llm, classifier: 'always', protocol: 'openai', preset: 'mimo' })
  eq(calls, 1, '缓存命中不重复调用')
  // 模型失败 → 回退规则
  const bad = { run: async () => '' }
  const b = await decideThinkingSmart('这段代码为什么报错 ```js\nconst a=1\n```', { llm: bad, classifier: 'always', protocol: 'openai', preset: 'mimo' })
  eq(b.depth, 'medium', '回退规则判 medium')
  eq(b.source, 'rule-fallback', '来源 rule-fallback')
  // classifier=off → 纯规则
  const c = await decideThinkingSmart('请设计一个分布式系统的架构并分析容错给出实现方案', { llm, classifier: 'off', protocol: 'openai', preset: 'mimo' })
  eq(c.depth, 'high', '纯规则 high')
  eq(c.source, 'rule', '来源 rule')
})

await test('thinkingLogFields：[chat] 行字段（auto on 显示档位/预算/来源；off 显示静态）', async () => {
  eq(thinkingLogFields({ thinkInfo: { auto: true, depth: 'high', budget: 16384, source: 'model' } }),
    'thinkingAuto=on depth=high budget=16384 by=model', 'auto on + 小模型判')
  eq(thinkingLogFields({ thinkInfo: { auto: true, depth: 'off', budget: 0, source: 'rule-fallback' } }),
    'thinkingAuto=on depth=off budget=0 by=rule', 'auto on + 规则兜底 → by=rule')
  eq(thinkingLogFields({ thinkInfo: null, thinking: { type: 'enabled', budget_tokens: 26000 } }),
    'thinkingAuto=off thinking=on budget=26000', 'auto off + 静态开启')
  eq(thinkingLogFields({ thinkInfo: null, thinking: null }),
    'thinkingAuto=off thinking=off', 'auto off + 静态关闭')
})

console.log(`\n========================================`)
console.log(`thinking 测试：通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
process.exit(failed > 0 ? 1 : 0)