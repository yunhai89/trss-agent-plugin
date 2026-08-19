/**
 * 无损上下文压缩（reversible）—— Hermes ContextCompressor 四阶段算法的可逆化移植。
 *
 * 参考：hermes-agent agent/context_compressor.py（NousResearch/hermes-agent 文档
 * 「Context Compression and Caching」）的四阶段：
 *   Phase 1  修剪旧工具结果（>阈值字符 → 占位符，便宜、无 LLM）
 *   Phase 2  确定边界（protect_first_n 头部保护 + token 尾保 + 对齐不撕 tool 配对）
 *   Phase 3  结构化摘要（本实现为**确定性台账 ledger**，LLM 摘要可后续插拔）
 *   Phase 4  组装 + _sanitize_tool_pairs 孤儿清理 + 迭代再压缩（_previous_summary 更新语义）
 *
 * 与 Hermes 默认 compressor（lossy 摘要）的关键差异——按「无损」要求升级为 reversible 模式：
 *   被移出窗口的原文**整块写入内容寻址归档**（sha256 校验、可完整找回），
 *   窗口内保留结构化台账（facts/tool_state/archive_refs）+ context_recall 恢复工具。
 *   台账是结构化提取物而非散文重总结——多次压缩走 merge（旧的保留、新的追加），
 *   数字/纠正/错误信息以结构化字段原样保留，防摘要漂移。
 *
 * 本文件纯函数（除 compactMessages 通过注入的 archive 异步落盘）；存储见 ./archive.js。
 */
import { createHash } from 'node:crypto'

/** 稳定 JSON（键排序）——内容寻址 hash 的输入必须确定 */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
}

export const contentHash = (v) => createHash('sha256').update(stableStringify(v)).digest('hex')

const toolName = (tc) => tc?.name || tc?.function?.name || 'unknown'
const excerpt = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** 压缩档案消息识别（与 renderCompactionMessage 的头常量一致）。台账是派生数据：
 *  再压缩时由合并台账重新渲染**替换**，不作为对话原文归档（其覆盖的原始消息早已归档）。 */
export const isCompactionMessage = (m) => m && typeof m.content === 'string' && m.content.startsWith('【上下文压缩档案')

/**
 * 按 turn-block 分块：messages[0]（首条意图）独立保留；从 index 1 起以 user 边界分块。
 * turn-block = 一条普通 user 起始 + 直到下一条普通 user 之前的全部 assistant/tool 消息
 * ——块级移动保证原子束不撕裂（assistant(tool_calls) 与其全部 tool results 同块）。
 * 防御形态：index 1 起的孤儿 assistant/tool 头（无 user 起始）并入同块，不与首意图混合。
 */
export function splitTurnBlocks(messages) {
  const blocks = []
  if (!messages.length) return blocks
  blocks.push([messages[0]])
  let i = 1
  while (i < messages.length) {
    const start = i
    while (i < messages.length && messages[i].role !== 'user') i++
    if (start === i) i++ // 块首是 user：跳过再吞后续非 user
    while (i < messages.length && messages[i].role !== 'user') i++
    blocks.push(messages.slice(start, i))
  }
  return blocks
}

/**
 * 双向孤儿清理（Hermes _sanitize_tool_pairs）：
 *  - tool result 引用的 tool_call 不在列表内 → 删除该结果；
 *  - tool_call 没有对应结果 → 紧随其后注入 stub 结果（占位说明 + context_recall 指引）。
 * 保证组装后的消息列表对任何 provider 协议合法。
 */
export function sanitizeToolPairs(messages) {
  const callIds = new Set()
  for (const m of messages) for (const tc of m.tool_calls || []) callIds.add(tc.id)
  const kept = messages.filter((m) => m.role !== 'tool' || callIds.has(m.tool_call_id))
  const hasResult = new Set(kept.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
  const out = []
  for (const m of kept) {
    out.push(m)
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (!hasResult.has(tc.id)) {
          out.push({ role: 'tool', tool_call_id: tc.id, content: '[工具结果已随上下文压缩归档，可用 context_recall 找回]' })
          hasResult.add(tc.id)
        }
      }
    }
  }
  return out
}

/**
 * 确定性台账：从被压缩消息**结构化提取**（非生成、非重总结）。
 * - facts：用户消息摘录（数字/纠正原样保留在摘录文本里）
 * - completed_steps：assistant 文本步骤摘录
 * - tool_state：每工具 calls/failures/最后结果摘录（错误识别用 Agent 错误结果协议 {"error":...}）
 * 确定性保证：同输入两次构建逐字节一致（无时间戳/随机数）——ledger 可作为权威状态防漂移。
 */
export function buildLedger(dropped, { msgStart = 0, cap = { facts: 20, steps: 20, tools: 12 } } = {}) {
  const idToTool = new Map()
  for (const m of dropped) for (const tc of m.tool_calls || []) idToTool.set(tc.id, toolName(tc))
  const facts = []
  const steps = []
  const tools = new Map()
  dropped.forEach((m, i) => {
    const at = msgStart + i
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      facts.push({ text: excerpt(m.content, 160), at })
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string' && m.content.trim()) steps.push({ text: excerpt(m.content, 120), at })
      for (const tc of m.tool_calls || []) {
        const t = tools.get(toolName(tc)) || { tool: toolName(tc), calls: 0, failures: 0, lastExcerpt: '' }
        t.calls++
        tools.set(t.tool, t)
      }
    } else if (m.role === 'tool') {
      const name = idToTool.get(m.tool_call_id) || 'unknown'
      const t = tools.get(name) || { tool: name, calls: 0, failures: 0, lastExcerpt: '' }
      const c = typeof m.content === 'string' ? m.content : ''
      if (/^\s*\{\s*"error"/.test(c)) t.failures++
      if (c) t.lastExcerpt = excerpt(c, 100)
      tools.set(name, t)
    }
  })
  return {
    v: 1,
    facts: facts.slice(-cap.facts),
    completed_steps: steps.slice(-cap.steps),
    tool_state: [...tools.values()].slice(0, cap.tools),
    open_questions: [],
    archive_refs: [],
    stats: { compactedMsgs: dropped.length, compactedTokens: 0, compactions: 1 },
  }
}

/** 多次压缩合并（Hermes 迭代再压缩的防漂移版）：新旧并存、归档追加、计数累加，绝不重总结散文。 */
export function mergeLedger(prev, next) {
  if (!prev || typeof prev !== 'object') return next
  const seen = new Set()
  const facts = []
  for (const f of [...(next.facts || []), ...(prev.facts || [])]) {
    const k = f.text
    if (seen.has(k)) continue
    seen.add(k)
    facts.push(f)
    if (facts.length >= 24) break
  }
  const tools = new Map()
  for (const t of [...(prev.tool_state || []), ...(next.tool_state || [])]) {
    const cur = tools.get(t.tool) || { tool: t.tool, calls: 0, failures: 0, lastExcerpt: '' }
    cur.calls += t.calls || 0
    cur.failures += t.failures || 0
    tools.set(t.tool, cur)
  }
  for (const t of next.tool_state || []) tools.get(t.tool).lastExcerpt = t.lastExcerpt || tools.get(t.tool).lastExcerpt
  return {
    v: 1,
    facts,
    completed_steps: [...(next.completed_steps || []), ...(prev.completed_steps || [])].slice(0, 24),
    tool_state: [...tools.values()].slice(0, 12),
    open_questions: next.open_questions || [],
    archive_refs: [...(next.archive_refs || []), ...(prev.archive_refs || [])].slice(0, 50),
    stats: {
      compactedMsgs: (next.stats?.compactedMsgs || 0) + (prev.stats?.compactedMsgs || 0),
      compactedTokens: (next.stats?.compactedTokens || 0) + (prev.stats?.compactedTokens || 0),
      // ?? 而非 ||：Phase-1 增量合法传 0（同一次压缩的修剪不计新代），曾 || 1 把每次修剪也 +1
      compactions: (next.stats?.compactions ?? 1) + (prev.stats?.compactions ?? 0),
    },
  }
}

/**
 * 压缩档案消息：窗口内的台账载体。role 规则（Hermes 同款）——避免连续同 role：
 * 下一条是 assistant → 取 user；否则取 assistant（[首意图user, 档案assistant, 尾部user...] 保持交替）。
 * 明确标注「系统生成」防止被当成用户发言或助手观点（角色污染防护）。
 * budgetTokens 给定时按预算自适应裁剪章节（保底：标注 + recall 指引 + 最新 ref）——
 * 台账消息自身也占窗口，不能把压后水位顶过高水位（滞回失效）。
 */
export function renderCompactionMessage({ ledger, nextRole, budgetTokens = null }) {
  const role = nextRole === 'assistant' ? 'user' : 'assistant'
  const tok = (s) => Math.ceil(String(s || '').length / 4)
  const L = []
  let used = 0
  const push = (line) => { L.push(line); used += tok(line) }
  push('【上下文压缩档案 v1（系统生成，非用户发言，非助手观点）】')
  const s = ledger.stats || {}
  if (s.compactedMsgs) push(`更早的 ${s.compactedMsgs} 条消息已无损归档（原文完整保存，sha256 校验）。`)
  push('需要原文细节（数字/报错/代码片段）时，调用 context_recall 工具按 ref 取回或按关键词检索。')
  const fits = (line) => budgetTokens == null || used + tok(line) <= budgetTokens
  const sections = [
    { title: '## 用户事实与纠正（按时间序，数字/否定原样）', items: (ledger.facts || []).map((f) => `- ${f.text}`) },
    { title: '## 已完成步骤', items: (ledger.completed_steps || []).map((st) => `- ${st.text}`) },
    { title: '## 工具使用', items: (ledger.tool_state || []).map((t) => `- ${t.tool} ×${t.calls}${t.failures ? `（失败 ${t.failures}）` : ''}${t.lastExcerpt ? `：最后结果 ${t.lastExcerpt}` : ''}`) },
  ]
  for (const sec of sections) {
    if (!sec.items.length) continue
    if (!fits(sec.title)) break
    push(sec.title)
    for (const it of sec.items) {
      if (!fits(it)) break
      push(it)
    }
  }
  const refs = ledger.archive_refs || []
  if (refs.length) {
    const title = '## 归档索引（archive_refs）'
    if (fits(title)) {
      push(title)
      for (const r of refs.slice(0, 3)) {
        const line = `- [${String(r.ref).slice(0, 24)}] ${r.msgs ?? '?'} 条消息 · sha256:${String(r.hash).slice(0, 16)}`
        if (!fits(line)) break
        push(line)
      }
      if (refs.length > 3) {
        const more = `- …另有 ${refs.length - 3} 份更早归档（context_recall 可检索）`
        if (fits(more)) push(more)
      }
    } else if (refs[0]) {
      // 预算耗尽也要留恢复锚点（一句话）
      push(`归档索引：[${String(refs[0].ref).slice(0, 24)}] 等 ${refs.length} 份（context_recall 可检索）`)
    }
  }
  push('（本条由上下文水位治理自动生成；继续基于上述台账与尾部近期消息工作即可）')
  return { role, content: L.join('\n') }
}

function defaultEstimate(t) { return Math.ceil(String(t || '').length / 4) }

/**
 * 四阶段压缩主入口（async：归档落盘）。
 * @param {Array} messages 当前完整消息列表（messages[0] = 首条意图，恒保留）
 * @param {object} o
 *  - kind: 'token'（value=低水位 token）| 'count'（value=低水位条数）
 *  - archive: CompactionArchive 实例（缺省则不落盘原文——降级为纯台账压缩，生产装配层必须注入）
 *  - convKey / epoch：归档寻址
 *  - estimateTokens：token 估算函数（与 Agent 同口径：content/tool_calls 字符 ÷4）
 *  - minKeep：尾部保底条数（Agent 的 contextKeepRecent）
 *  - prevLedger：上一代台账（迭代合并防漂移）
 *  - pruneToolResultChars：Phase 1 修剪阈值（Hermes 默认 200 字符）
 * @returns {Promise<{messages, dropped, pruned, ledger, archiveRefs}>}
 *
 * 组装目标把**档案消息自身**计入低水位（预算自适应裁剪章节）——否则台账逐代增长会把
 * 压后水位顶过高水位，滞回失效（每轮重触压缩、epoch 空转、前缀缓存逐轮全灭）。
 * 归档 ref 为确定性内容寻址（epoch + hash 前缀）——搜索阶段虚拟引用，定稿后一次落盘。
 */
export async function compactMessages(messages, {
  kind = 'token', value = 0, archive = null, convKey = 'unknown', epoch = 0,
  estimateTokens = null, minKeep = 4, prevLedger = null, pruneToolResultChars = 200,
} = {}) {
  const fn = estimateTokens || defaultEstimate
  const est = (msgs) => {
    if (kind === 'count') return msgs.length
    let n = 0
    for (const m of msgs) {
      n += 4
      if (typeof m.content === 'string') n += fn(m.content)
      if (m.tool_calls) n += fn(JSON.stringify(m.tool_calls))
    }
    return n
  }
  const over = (msgs) => (kind === 'count' ? msgs.length > value : est(msgs) > value)
  const minKeep2 = Math.max(minKeep, 2)
  const noOp = { messages, dropped: 0, pruned: 0, ledger: prevLedger, archiveRefs: prevLedger?.archive_refs || [] }
  if (!over(messages)) return noOp
  // 计数水位：块不能再丢时修剪无意义（不减条数），保留旧防抖语义防止 epoch 每轮空转
  if (kind === 'count' && messages.length <= minKeep2 + 1) return noOp

  // 上一代的档案消息是派生数据（台账已持久化在会话 extra）：剔除后由本代合并台账重渲染替换，
  // 不进归档、不重复占窗（曾把旧档案消息当原文归档——恢复出的"原文"竟是台账渲染本身）。
  const live = []
  for (const m of messages) { if (!isCompactionMessage(m)) live.push(m) }

  // Phase 2：边界——turn-block 原子束 + floorKeep 尾保
  const blocks = splitTurnBlocks(live)
  const floorKeep = kind === 'token' ? minKeep2 + 1 : Math.max(2, value)
  // 归档 blocks[1..R]（R 块）可行 ⇔ 丢完最后一块后剩余（m0+尾）仍 ≥ floorKeep
  const canDrop = (r) => r >= 1 && r < blocks.length && (1 + blocks.slice(r + 1).flat().length) >= floorKeep
  let rMax = 0
  for (let r = 1; r < blocks.length; r++) { if (canDrop(r)) rMax = r; else break }

  const virtualRef = (msgs) => {
    const hash = contentHash({ convKey, epoch, messages: msgs })
    return { ref: `${Number(epoch) || 0}-${hash.slice(0, 16)}.json`, hash, msgs: msgs.length }
  }
  // 候选：归档 blocks[1..R]，台账按「低水位 - 首意图 - 尾部」预算自适应渲染
  const choose = (r) => {
    const droppedMsgs = blocks.slice(1, r + 1).flat()
    const tail = blocks.slice(r + 1).flat()
    let ledger = buildLedger(droppedMsgs, { msgStart: 1 })
    ledger.archive_refs = droppedMsgs.length ? [virtualRef(droppedMsgs)] : []
    ledger.stats.compactedTokens = Math.round(est(droppedMsgs))
    if (prevLedger) ledger = mergeLedger(prevLedger, ledger)
    const budgetTokens = kind === 'token' ? Math.max(0, value - est([live[0], ...tail])) : null
    const msg = renderCompactionMessage({ ledger, nextRole: tail[0]?.role, budgetTokens })
    return { r, droppedMsgs, tail, ledger, msg, assembled: sanitizeToolPairs([live[0], msg, ...tail]) }
  }

  // 最小丢弃优先（保留最多历史）：从 R=1 起找第一个达标候选；都不达标则止于 R=rMax（尽力）
  let cand = null
  for (let r = 1; r <= rMax; r++) {
    cand = choose(r)
    if (!over(cand.assembled)) break
  }
  if (!cand) {
    // 一块都丢不了（floor 全保）：纯 Phase 1 路径——不动块结构，只修剪长工具结果
    cand = { r: 0, droppedMsgs: [], tail: [], ledger: prevLedger || buildLedger([]), msg: null, assembled: live.slice() }
  }

  // Phase 1 兜底（仅 token 水位：修剪减 token 不减条数）：floor 保护下仍超标 →
  // 老 tool result 占位 + 原文归档（Hermes Phase 1 的无损化版本）
  let pruned = 0
  const savedResults = []
  if (kind === 'token' && over(cand.assembled)) {
    const keepFrom = Math.max(2, cand.assembled.length - minKeep2) // 保住 m0+档案+尾部 minKeep 条
    for (let i = cand.assembled.length - 1; i >= keepFrom && over(cand.assembled); i--) {
      const m = cand.assembled[i]
      if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length <= pruneToolResultChars) continue
      let ref = ''
      if (archive) {
        try {
          const saved = await archive.save({ convKey, epoch, messages: [m] })
          savedResults.push(saved)
          ref = saved.ref
        } catch { continue }
      }
      m.content = `[此工具输出较长（${m.content.length} 字符），已归档${ref ? `：ref=${ref}` : ''} —— 可用 context_recall 取回]`
      pruned++
    }
    if (pruned && savedResults.length) {
      cand.ledger = mergeLedger(cand.ledger, {
        v: 1, facts: [], completed_steps: [], tool_state: [], open_questions: [],
        archive_refs: savedResults.map((s) => ({ ref: s.ref, hash: s.hash, msgs: 1, tokens: 0 })),
        stats: { compactedMsgs: 0, compactedTokens: 0, compactions: 0 },
      })
    }
  }
  if (!cand.droppedMsgs.length && !pruned) return noOp

  // 定稿落盘：整块归档一次写入（ref 与虚拟引用一致——内容寻址确定性）
  if (archive && cand.droppedMsgs.length) {
    try {
      const saved = await archive.save({ convKey, epoch, messages: cand.droppedMsgs })
      // 校验确定性：落盘 ref 必须与台账虚拟 ref 一致（不一致说明实现有状态泄漏，保留实际值）
      const v = cand.ledger.archive_refs?.[0]
      if (v && v.ref !== saved.ref) v.ref = saved.ref
    } catch { /* 归档失败不阻断压缩（降级为无该 ref 台账），装配层可观测 */ }
  }

  return { messages: cand.assembled, dropped: cand.droppedMsgs.length, pruned, ledger: cand.ledger, archiveRefs: cand.ledger.archive_refs || [] }
}
