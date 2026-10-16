/**
 * 约束门控（对应 hermes §4.6.3 constraint gates）。
 * 纯函数、零依赖；用于在候选进入种群前过滤掉不合规的变体。
 *
 * 四道门：
 *  - size     文本不超过字符上限（toolDescription ≤500；systemPrompt 可配）
 *  - test     调用方测试套件（对文本的谓词）全过
 *  - semantic 与基线文本的相似度 ≥ 阈值（默认 trigram Jaccard；零 LLM）
 *  - cache    与基线的公共前缀保留率 ≥ 阈值（保护 prompt 前缀缓存）
 */

function trigrams(s) {
  const t = (s || '').toLowerCase()
  const g = new Set()
  for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3))
  return g
}

/** trigram Jaccard 相似度 ∈ [0,1] */
export function similarity(a, b) {
  const A = trigrams(a)
  const B = trigrams(b)
  if (!A.size && !B.size) return 1
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  const union = A.size + B.size - inter
  return union ? inter / union : 0
}

/** 最长公共前缀占比 ∈ [0,1]（相对较长串） */
export function lcpRatio(a, b) {
  a = a || ''
  b = b || ''
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  const m = Math.max(a.length, b.length)
  return m ? i / m : 1
}

export function sizeGate(text, { maxChars } = {}) {
  if (maxChars == null) return { passed: true, failures: [], length: (text || '').length }
  const len = (text || '').length
  const passed = len <= maxChars
  return { passed, failures: passed ? [] : [`size ${len} > maxChars ${maxChars}`], length: len }
}

export function testGate(text, { tests } = {}) {
  if (!tests || !tests.length) return { passed: true, failures: [] }
  const failures = []
  for (const t of tests) {
    let ok
    try {
      ok = t(text)
    } catch (e) {
      failures.push(`${t?.name || 'test'}: ${e?.message || e}`)
      continue
    }
    if (!ok) failures.push(t?.name || 'test')
  }
  return { passed: !failures.length, failures }
}

export function semanticGate(text, baseline, { minSimilarity = 0.2 } = {}) {
  if (baseline == null) return { passed: true, failures: [], similarity: 1 }
  const sim = similarity(text, baseline)
  const passed = sim >= minSimilarity
  return { passed, failures: passed ? [] : [`similarity ${sim.toFixed(3)} < minSimilarity ${minSimilarity}`], similarity: sim }
}

export function cacheGate(text, baseline, { prefixKeepRatio = 0.3 } = {}) {
  if (baseline == null) return { passed: true, failures: [], prefixKeepRatio: 1 }
  const r = lcpRatio(text, baseline)
  const passed = r >= prefixKeepRatio
  return { passed, failures: passed ? [] : [`prefix keep ${r.toFixed(3)} < prefixKeepRatio ${prefixKeepRatio}`], prefixKeepRatio: r }
}

/** 语法/格式门控（纯启发式，零 LLM）：检查括号平衡、最小字符数、无乱码 */
export function grammarGate(text, { minChars = 5 } = {}) {
  const t = String(text || '')
  const failures = []
  // 括号平衡检查（只认 () [] {}）：`<`/`>` 在 prompt 里多为比较符（「置信度 < 0.5」「得分 > 0.8」），
  // 当括号会误判成「括号不匹配/未闭合」→ 合法候选静默 0 分淘汰（见 #进化 prompt）。
  const openMap = { '(': ')', '[': ']', '{': '}' }
  const closeSet = new Set([')', ']', '}'])
  const openSet = new Set(Object.keys(openMap))
  const stack = []
  for (const ch of t) {
    if (openSet.has(ch)) stack.push(openMap[ch])
    else if (closeSet.has(ch)) {
      if (stack.pop() !== ch) { failures.push('括号不匹配'); break }
    }
  }
  if (stack.length) failures.push('括号未闭合')
  // 最小字符数（防止碎片化输出；用字符而非词以兼容 CJK）
  const trimmed = t.trim()
  if (trimmed.length < minChars) failures.push(`字符数 ${trimmed.length} < ${minChars}`)
  // 控制字符
  if (/[\x00-\x08\x0e-\x1f]/.test(t)) failures.push('含控制字符')
  return { passed: !failures.length, failures }
}

/**
 * 运行全部门控（含 grammar）。
 * @param {string} text 候选文本
 * @param {string} baseline 基线文本（语义/缓存门用）
 * @param {object} config { size, test, semantic, cache, grammar }
 * @returns {{ passed, failures: string[], details }}
 */
export function runGates(text, baseline, config = {}) {
  const entries = [
    ['size', sizeGate(text, config.size)],
    ['test', testGate(text, config.test)],
    ['semantic', semanticGate(text, baseline, config.semantic)],
    ['cache', cacheGate(text, baseline, config.cache)],
    ...(config.grammar === false ? [] : [['grammar', grammarGate(text, typeof config.grammar === 'object' ? config.grammar : {})]]),
  ]
  const failures = []
  for (const [k, r] of entries) {
    if (!r.passed) for (const f of r.failures) failures.push(`${k}: ${f}`)
  }
  return {
    passed: !failures.length,
    failures,
    details: Object.fromEntries(entries),
  }
}

/** 默认门控配置（按 target 类型） */
export function defaultGateConfig(targetType) {
  if (targetType === 'toolDescription') {
    return { size: { maxChars: 500 }, semantic: { minSimilarity: 0.15 }, cache: { prefixKeepRatio: 0.2 } }
  }
  return { semantic: { minSimilarity: 0.1 }, cache: { prefixKeepRatio: 0.2 } }
}
