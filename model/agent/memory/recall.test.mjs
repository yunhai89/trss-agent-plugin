/**
 * 离线自检 —— RecallStore 质量增强：MMR 去冗余 / 每类上限 / 纠错闭环 / 使用反馈。
 * 运行：node model/agent/memory/recall.test.mjs（memoryKv，无需 redis）
 *
 * 被测不变量：
 *  - 召回不得被同义/近重复条目挤满（MMR + perTypeCap）；
 *  - 用户纠错后旧记忆不再召回/注入，但保留 prev 审计链；
 *  - 反复注入却从未被引用的记忆轻微降权，被引用过的不被误伤；
 *  - 各用户完全隔离。
 */
import { RecallStore, detectCorrection, containment, setJaccard, tokenize } from '../recall.js'
import { memoryKv } from '../store/kv.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }

// ---------- 1. detectCorrection 规则 ----------
await test('detectCorrection：明确纠错句式', async () => {
  eq(detectCorrection('不是湖南，是湖北'), { negated: '湖南', replacement: '湖北', explicit: false }, '不是X是Y')
  eq(detectCorrection('我不是学生,而是老师'), { negated: '学生', replacement: '老师', explicit: false }, '不是X而是Y（英文逗号）')
  eq(detectCorrection('更正：我不喜欢辣'), { negated: null, replacement: '我不喜欢辣', explicit: true }, '更正：Y')
  eq(detectCorrection('我今天很累'), null, '普通陈述不误判')
  eq(detectCorrection('今天应该是晴天'), null, '推测语气不误判为纠错')
  eq(detectCorrection('他不是坏人'), null, '单否定无更正值不误判为纠错')
})

// ---------- 2. tokenize / containment ----------
await test('containment：短记忆被回复覆盖判定', async () => {
  ok(containment('你上次说喜欢简洁的回复，我记住了', '用户喜欢简洁回复') >= 0.5, '回复覆盖记忆词元')
  ok(containment('今天天气不错', '用户喜欢简洁回复') < 0.2, '无关回复不判为引用')
  eq(setJaccard(tokenize('abc'), tokenize('abc')), 1, '相同词元 jaccard=1')
})

// ---------- 3. MMR 去冗余 ----------
await test('retrieve：MMR 抑制近重复条目', async () => {
  const kv = memoryKv()
  const r = new RecallStore({ kv, diversity: { enable: true, lambda: 0.3, perTypeCap: 5 } })
  const now = Date.now()
  // 直接落库绕过写去重，构造两条近乎相同的候选 + 一条多样候选
  await r._save('u1', [
    { id: 'a', level: 'L3', type: 'preference', content: '用户喜欢简洁回复', confidence: 0.9, status: 'active', createdAt: now, updatedAt: now },
    { id: 'b', level: 'L3', type: 'preference', content: '用户喜欢简洁的回复', confidence: 0.9, status: 'active', createdAt: now - 1000, updatedAt: now - 1000 },
    { id: 'c', level: 'L4', type: 'identity', content: '用户是工程师', confidence: 0.9, status: 'active', createdAt: now, updatedAt: now },
  ])
  const got = await r.retrieve('用户喜欢简洁回复', 'u1', 2)
  eq(got.length, 2, '返回 2 条')
  const ids = got.map((m) => m.id)
  ok(ids.includes('a'), '相关最高者入选')
  ok(ids.includes('c'), '近重复被抑制，多样候选入选')
  ok(!ids.includes('b'), '重复项被 MMR 排除')
})

// ---------- 4. perTypeCap 限制同类型占比 ----------
await test('retrieve：perTypeCap 限制同类型占比', async () => {
  const kv = memoryKv()
  const r = new RecallStore({ kv, diversity: { enable: true, lambda: 0.7, perTypeCap: 3 } })
  const now = Date.now()
  const arr = []
  for (let i = 0; i < 6; i++) {
    arr.push({ id: 'f' + i, level: 'L3', type: 'fact', content: `事实条目${i}关于项目进度`, confidence: 0.8, status: 'active', createdAt: now, updatedAt: now })
  }
  arr.push({ id: 'id1', level: 'L4', type: 'identity', content: '用户是工程师', confidence: 0.8, status: 'active', createdAt: now, updatedAt: now })
  await r._save('u1', arr)
  const got = await r.retrieve('用户 项目进度 事实条目', 'u1', 4)
  const facts = got.filter((m) => m.type === 'fact').length
  eq(got.length, 4, '返回 4 条')
  eq(facts, 3, '同类型最多 3 条')
  ok(got.some((m) => m.type === 'identity'), '不同类型补足')
})

// ---------- 5. 纠错闭环 ----------
await test('correct：旧记忆不再召回/注入但保留审计链', async () => {
  const kv = memoryKv()
  const r = new RecallStore({ kv })
  await r.writeMemory({ content: '用户住在湖南', level: 'L4', confidence: 0.9 }, 'u1')
  const res = await r.correct('u1', { matchText: '湖南', newContent: '用户住在湖北', level: 'L4', confidence: 0.9 })
  eq(res.corrected, 1, '纠正 1 条旧记忆')
  ok(res.added, '写入更正记忆')
  const got = await r.retrieve('用户住在哪里', 'u1', 5)
  ok(!got.some((m) => m.content.includes('湖南')), '旧记忆不再召回')
  ok(got.some((m) => m.content.includes('湖北')), '更正记忆可召回')
  const all = await r.listByUser('u1')
  const old = all.find((m) => m.content.includes('湖南'))
  eq(old.status, 'corrected', '旧记忆标记 corrected')
  ok(Array.isArray(old.prev) && old.prev.length >= 1, '保留 prev 审计链')
  ok(!r.formatForPrompt(all).includes('湖南'), '纠正内容不注入 prompt')
})

await test('applyCorrections：从自然语言纠错落库', async () => {
  const kv = memoryKv()
  const r = new RecallStore({ kv })
  await r.writeMemory({ content: '用户住在湖南', level: 'L4', confidence: 0.9 }, 'u1')
  const ap = await r.applyCorrections([{ role: 'user', content: '不是湖南，是湖北' }], 'u1')
  eq(ap.corrected, 1, '识别并纠正 1 条')
  const got = await r.retrieve('用户住在哪里', 'u1', 5)
  ok(!got.some((m) => m.content.includes('湖南')), '旧说法失效')
  ok(got.some((m) => m.content.includes('湖北')), '新说法生效')
})

await test('applyCorrections：无匹配旧记忆时不写入碎片', async () => {
  const kv = memoryKv()
  const r = new RecallStore({ kv })
  const ap = await r.applyCorrections([{ role: 'user', content: '这个不是重点，是小事' }], 'u1')
  eq(ap.corrected, 0, '无匹配旧记忆')
  eq(ap.added, 0, '不写入碎片')
  eq((await r.listByUser('u1')).length, 0, '记忆仍为空')
})

// ---------- 6. 使用反馈降权 ----------
await test('recordUsage：注入计数 + 引用检测 + 从不引用降权', async () => {
  const kv = memoryKv()
  const r = new RecallStore({ kv })
  const now = Date.now()
  await r._save('u1', [
    { id: 'x', level: 'L3', type: 'preference', content: '用户喜欢简洁回复', confidence: 0.8, status: 'active', injected: 5, used: 0, createdAt: now, updatedAt: now },
    { id: 'y', level: 'L3', type: 'preference', content: '用户喜欢简洁答复', confidence: 0.8, status: 'active', injected: 0, used: 0, createdAt: now, updatedAt: now },
  ])
  // 等相似度下，从不被引用的 x 应降权到 y 之后
  const got = await r.retrieve('喜欢简洁', 'u1', 5)
  eq(got[0].id, 'y', '反复注入未引用者降权')
  // 引用检测：回复覆盖记忆词元 → used+1
  const before = (await r.listByUser('u1')).find((m) => m.id === 'y')
  await r.recordUsage('u1', { injectedIds: ['y'], replyText: '好的，你喜欢简洁答复，我尽量短说' })
  const after = (await r.listByUser('u1')).find((m) => m.id === 'y')
  eq(after.injected, (before.injected || 0) + 1, 'injected+1')
  ok(after.used >= 1, '被引用 → used 增加')
})

// ---------- 7. 用户隔离 + 向后兼容 ----------
await test('recall：用户隔离 + 基础召回不回归', async () => {
  const kv = memoryKv()
  const r = new RecallStore({ kv })
  await r.writeMemory({ content: '用户喜欢简洁的回复', level: 'L3', confidence: 0.8 }, 'u1')
  await r.writeMemory({ content: '用户是工程师', level: 'L4', confidence: 0.9 }, 'u1')
  const got = await r.retrieve('回复风格偏好', 'u1', 5)
  ok(got[0].content.includes('简洁'), '最相关在前（不回归）')
  const other = await r.retrieve('回复风格偏好', 'u2', 5)
  eq(other.length, 0, '他人无记忆')
})

console.log(`\n========================================`)
console.log(`recall 质量测试：通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
process.exit(failed > 0 ? 1 : 0)
