/**
 * 后台自评审器（在线自进化核心）—— 参考 Hermes agent/background_review.py + turn_finalizer.py。
 *
 * 设计要点：
 *  - 每跑满 N 轮对话（per-scope 计数），后台异步让 agent 自我评审：
 *    review 近期 trace + 记忆快照 + 技能清单 → 产出改进 suggestion（memory/skill/prompt 三类）。
 *  - 强负面约束（照搬 Hermes）：不得捕获环境相关失败/一次性任务叙事/临时偏好 —— 这些会固化为持久化自我设限。
 *  - 工具白名单：suggestion 仅允许 memory/skill/prompt 三类，其它一律拒。
 *  - 分级应用：memory 类（低风险）自动写入（有 prev[] 回滚 + 威胁扫描兜底 + 置信度闸）；
 *    skill/prompt 类（高风险）落盘待审，由 #审阅进化 / #采纳 命令人工批准。
 *  - 全异步（setImmediate）、异常绝不 crash 主流程、日 token 预算耗尽即降级（只采集不评审）。
 *
 * 与 Agent._reflect 的区别：_reflect 是单轮内交付前自检（短反馈环）；本模块是跨对话的后台元改进（长改进环），互不替代。
 *
 * 库零依赖插件：provider/model/traceStore/memory/skills/suggestionDir/cfg 全由 apps 注入。
 */
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_EVERY = 20
const DEFAULT_BUDGET = 200000

/** 自批判评审 prompt（强负面约束是核心，防自我设限） */
function buildReviewPrompt({ recent, memSnap, skillList, botName }) {
  return [
    `你是 ${botName || 'AI 助手'} 的自我评审模块。审视近期对话与当前记忆/技能，提出【少量、高价值】的持久化改进建议。`,
    '',
    '## 近期对话摘要（最近若干轮，已脱敏）',
    recent || '（暂无）',
    '',
    '## 当前长期记忆快照',
    memSnap || '（空）',
    '',
    '## 当前技能清单',
    skillList.length ? skillList.join('、') : '（无）',
    '',
    '## 输出规则',
    '只输出 JSON 数组（不要 markdown 代码块、不要解释），每项一个 suggestion：',
    '{ "kind": "memory"|"skill"|"prompt"|"tool", "action": "add"|"replace"|"remove"|"update"|"create", "target": "<memory目标:memory|user / 技能名 / prompt key如agent / 工具名>", "payload": "<新内容文本；tool 类须为 {description:<改进后的工具描述>}>", "rationale": "<为何有价值>", "confidence": 0~1 }',
    '无改进则输出 []。',
    '',
    '## 强负面约束——以下情况绝不产出 suggestion',
    '1. 环境相关失败（"某工具坏了""网络超时""API 报错""模型不支持"）—— 环境会变，固化成记忆=自我设限，环境恢复后反咬。',
    '2. 一次性任务叙事（"用户让查了天气""帮写了邮件"）—— 已完成的事，记了无用还占容量。',
    '3. 用户临时/情绪状态（"用户现在有点累""心情不好"）—— 非持久事实。',
    '4. 仅凭单次对话的强结论 —— 需多次稳定出现才值得固化。',
    '5. 不得改动与本轮任务无关的既有稳定记忆/技能。',
    '6. 不得产出 memory/skill/prompt/tool 以外的 suggestion。',
    '',
    '## 优先级',
    '更新已有 > 新增；宁缺毋滥，最多 3 条；只提真正值得长期记住的用户事实/偏好/身份，或确实能提升回复质量的技能/prompt 改进。',
  ].join('\n')
}

/** 从 LLM 回复解析 suggestion 数组（容错：剥离 markdown/截取首个 JSON 数组） */
function parseSuggestions(text) {
  if (!text) return []
  const s = String(text).replace(/^```(?:json)?/i, '').replace(/```$/, '')
  const start = s.indexOf('[')
  if (start === -1) return []
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false }
    else if (ch === '"') inStr = true
    else if (ch === '[') depth++
    else if (ch === ']') { depth--; if (depth === 0) { try { const a = JSON.parse(s.slice(start, i + 1)); return Array.isArray(a) ? a : [] } catch { return [] } } }
  }
  return []
}

const ALLOWED_KIND = new Set(['memory', 'skill', 'prompt', 'tool'])

export class SelfReviewer {
  constructor({
    provider, model = null, traceStore = null, memory = null, skills = null,
    suggestionDir, botName = '',
    enable = true, every = DEFAULT_EVERY, autoApplyMemory = true, autoApplyPrompt = false,
    dailyBudgetTokens = DEFAULT_BUDGET, logger = () => {},
  } = {}) {
    if (!provider) throw new Error('SelfReviewer 需要 provider')
    if (!suggestionDir) throw new Error('SelfReviewer 需要 suggestionDir')
    this.provider = provider
    this.model = model
    this.traceStore = traceStore
    this.memory = memory
    this.skills = skills
    this.suggestionDir = suggestionDir
    this.botName = botName
    this.enable = enable !== false
    this.every = Math.max(1, Number(every) || DEFAULT_EVERY)
    this.autoApplyMemory = autoApplyMemory !== false
    this.autoApplyPrompt = autoApplyPrompt === true
    this.dailyBudgetTokens = Math.max(0, Number(dailyBudgetTokens) || 0)
    this.logger = logger
    this._counts = new Map() // scopeId → 已累计对话轮数
    this._budgetDay = ''
    this._usedTokens = 0
    try { fs.mkdirSync(this.suggestionDir, { recursive: true }) } catch { /* noop */ }
  }

  /** 预算闸：日 token 预算耗尽则降级（不评审） */
  _budgetExhausted() {
    const today = new Date().toISOString().slice(0, 10)
    if (this._budgetDay !== today) { this._budgetDay = today; this._usedTokens = 0 }
    return this.dailyBudgetTokens > 0 && this._usedTokens >= this.dailyBudgetTokens
  }

  /** 每轮对话后调用：per-scope 计数 → 到阈值 setImmediate 触发后台评审 */
  tick(ctx, runResult = {}) {
    if (!this.enable) return
    const scope = ctx?.scopeId || ctx?.scopeUserId || '__global__'
    const n = (this._counts.get(scope) || 0) + 1
    if (n < this.every) { this._counts.set(scope, n); return }
    this._counts.set(scope, 0) // 重置，开始下一轮计数周期
    setImmediate(async () => {
      try { await this._review(ctx, runResult) }
      catch (e) { this.logger('warn', '[selfReview] 评审异常（已吞，不影响主流程）', e?.message || e) }
    })
  }

  async _review(ctx, runResult) {
    if (this._budgetExhausted()) { this.logger('debug', '[selfReview] 日预算耗尽，本轮跳过评审'); return }
    const scopeUserId = ctx?.scopeUserId
    const scopeId = ctx?.scopeId
    // 收集评审上下文：近期 trace（本 scope）+ 记忆快照 + 技能清单
    let recent = ''
    try {
      const all = (this.traceStore && typeof this.traceStore.all === 'function') ? this.traceStore.all() : []
      const own = all.filter((t) => t && t.scope === scopeUserId).slice(-8)
      recent = own.map((t, i) => `${i + 1}. 用户: ${(t.input || '').slice(0, 80)} → 助手: ${(t.output || '').slice(0, 80)}${t.stopReason === 'max_turns' ? ' [超限]' : ''}`).join('\n')
    } catch { /* noop */ }
    let memSnap = ''
    try { memSnap = (this.memory && typeof this.memory.snapshotAll === 'function') ? this.memory.snapshotAll(scopeId) : '' } catch { /* noop */ }
    let skillList = []
    try { skillList = (this.skills && typeof this.skills.list === 'function') ? this.skills.list().map((s) => s.name || s) : [] } catch { /* noop */ }

    const prompt = buildReviewPrompt({ recent, memSnap, skillList, botName: this.botName })
    let res
    try {
      res = await this.provider.chat({ model: this.model, messages: [{ role: 'user', content: prompt }], stream: false, temperature: 0.2 })
    } catch (e) { this.logger('warn', '[selfReview] 评审 LLM 调用失败', e?.message || e); return }
    if (res?.usage) this._usedTokens += (res.usage.total_tokens ?? res.usage.total ?? 0)

    const raw = parseSuggestions(res?.content || '')
    // 强约束过滤：白名单 + 置信度 + 条数上限
    const filtered = raw
      .filter((s) => s && ALLOWED_KIND.has(s.kind))
      .filter((s) => !this.autoApplyMemory || (s.confidence || 0) >= 0.5) // 低置信直接丢，不值得记
      .slice(0, 3)
    if (!filtered.length) { this.logger('debug', '[selfReview] 本轮无有效 suggestion'); return 0 }

    for (const s of filtered) {
      try { await this._apply(ctx, s) }
      catch (e) { this.logger('warn', '[selfReview] suggestion 应用异常', s?.kind, e?.message || e) }
    }
    this.logger('mark', `[selfReview] scope=${scopeId} 产出 ${filtered.length} 条 suggestion（memory 自动=${this.autoApplyMemory}）`)
    return filtered.length
  }

  /** 手动触发评审（#LLM进化 命令用；跳过节流立即跑一次，返回产出数） */
  async force(ctx, runResult = {}) {
    if (!this.enable) return { error: '自进化未启用（config agent.selfReview.enable）' }
    try {
      const n = await this._review(ctx, runResult)
      return { suggestionCount: Number.isFinite(n) ? n : 0 }
    } catch (e) {
      this.logger('warn', '[selfReview] 手动评审异常', e?.message || e)
      return { error: `评审失败：${e?.message || e}` }
    }
  }

  /** 分级应用：memory 类自动写（置信度闸）；skill/prompt 类落盘待审 */
  async _apply(ctx, s) {
    s.scope = ctx?.scopeUserId
    s.scopeId = ctx?.scopeId
    s.ts = Date.now()
    s.id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const conf = Number(s.confidence) || 0
    if (s.kind === 'memory' && this.autoApplyMemory && conf >= 0.6) {
      try {
        const r = await this._applyMemory(ctx, s)
        s.status = 'applied'
        s.applyResult = r
        this.logger('mark', `[selfReview] 自动应用 memory：${String(s.payload || '').slice(0, 50)}`)
      } catch (e) { s.status = 'apply_failed'; s.error = e?.message || String(e) }
    } else {
      s.status = 'pending' // skill/prompt 或低置信 memory → 待审
    }
    await this._persist(ctx, s) // 已应用也落盘留痕（回溯/审计）
  }

  /** 写声明式记忆（payload 当 bullet 文本；target 指 memory/user） */
  async _applyMemory(ctx, s) {
    if (!this.memory) throw new Error('memory 未注入')
    const target = s.target === 'user' ? 'user' : 'memory'
    const scopeId = ctx?.scopeId
    if (s.action === 'remove') return this.memory.remove(target, String(s.payload || ''), scopeId)
    if (s.action === 'replace') return this.memory.replace(target, String(s.payload || ''), String(s.newPayload || s.payload || ''), scopeId)
    return this.memory.add(target, String(s.payload || ''), scopeId)
  }

  /** 落盘 suggestion（按 scope 隔离目录；待审的供 #审阅进化，已应用的供回溯） */
  async _persist(ctx, s) {
    const dir = path.join(this.suggestionDir, String(ctx?.scopeId || '__global__'))
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* noop */ }
    try { fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s, null, 2)) }
    catch (e) { this.logger('warn', '[selfReview] suggestion 落盘失败', e?.message || e) }
  }
}

/** 读取某 scope 的待审 suggestion 列表（供 #审阅进化 命令） */
export function listPendingSuggestions(suggestionDir, scopeId) {
  const dir = path.join(suggestionDir, String(scopeId || '__global__'))
  try {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }
        catch { return null }
      })
      .filter(Boolean)
      .filter((s) => s.status === 'pending')
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
  } catch { return [] }
}

/** 删除已处理（采纳/拒绝）的 suggestion 文件 */
export function removeSuggestion(suggestionDir, scopeId, id) {
  const file = path.join(suggestionDir, String(scopeId || '__global__'), `${id}.json`)
  try { fs.unlinkSync(file); return true } catch { return false }
}

/** 把 suggestion 状态写回磁盘（应用结果 / 失败保留待审，供审阅追溯） */
export function persistSuggestion(suggestionDir, s) {
  const dir = path.join(suggestionDir, String(s?.scopeId || '__global__'))
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* noop */ }
  try { fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s, null, 2)); return true } catch { return false }
}

/**
 * 应用一条 suggestion（Web 面板 #apply 与命令行 #采纳 共用，避免逻辑漂移）。
 * prompt → 改 promptRegistry + 落盘；memory → memory.add/replace/remove；skill → 无自动（提示手工）。
 * 应用后从待审列表移除。失败抛错（路由层置 apply_failed）。
 * @param {object} rt getRuntime() 返回值（需 promptRegistry/memory/promptDir/suggestionDir）
 * @param {object} s suggestion（须含 scopeId/id/kind/action/target/payload[/newPayload]）
 */
export async function applySuggestion(rt, s) {
  if (!s || !s.scopeId) throw new Error('suggestion 缺少 scopeId')
  if (s.kind === 'prompt') {
    const key = s.target || 'agent'
    const tpl = rt.promptRegistry && rt.promptRegistry.get(key)
    if (!tpl) throw new Error(`未找到 prompt 模板：${key}`)
    const oldSystem = tpl.system
    const payload = String(s.payload || '')
    const nextVersion = `${tpl.version || '1.0.0'}-evolved`
    const changeText = `采纳：${String(s.rationale || '').slice(0, 50)}`
    // 先落盘、成功后再改内存 registry 并移出待审：写失败不污染内存、也不丢 suggestion（调用方置 apply_failed）
    const next = {
      ...tpl.toJSON(),
      system: payload,
      version: nextVersion,
      changelog: [{ version: nextVersion, date: new Date().toISOString().slice(0, 10), change: changeText, evalRun: '' }, ...(tpl.changelog || [])],
    }
    try { fs.mkdirSync(rt.promptDir, { recursive: true }); fs.writeFileSync(path.join(rt.promptDir, `${key}.json`), JSON.stringify(next, null, 2)) }
    catch (e) { throw new Error(`prompt 落盘失败：${e?.message || e}`) }
    tpl.system = payload
    if (typeof tpl.addChange === 'function') tpl.addChange(nextVersion, changeText)
    removeSuggestion(rt.suggestionDir, s.scopeId, s.id)
    return { ok: true, note: `prompt「${key}」已应用（旧：${String(oldSystem).slice(0, 40)}…）` }
  }
  if (s.kind === 'memory') {
    if (!rt.memory) throw new Error('memory 未就绪')
    const target = s.target === 'user' ? 'user' : 'memory'
    if (s.action === 'remove') rt.memory.remove(target, String(s.payload || ''), s.scopeId)
    else if (s.action === 'replace') rt.memory.replace(target, String(s.payload || ''), String(s.newPayload || s.payload || ''), s.scopeId)
    else rt.memory.add(target, String(s.payload || ''), s.scopeId)
    removeSuggestion(rt.suggestionDir, s.scopeId, s.id)
    return { ok: true, note: `memory ${s.action} 已应用` }
  }
  if (s.kind === 'tool') {
    const reg = rt.toolEvo?.registry
    const engine = rt.toolEvo?.engine
    if (!reg || !engine) throw new Error('toolEvo 未启用，无法应用 tool suggestion')
    const tool = await reg.getByName(s.target)
    if (!tool?.active_version_id) throw new Error(`工具 ${s.target} 不存在或无 active 版本`)
    const active = await reg.getVersion(tool.active_version_id)
    const tests = await reg.getTests(active.id)
    try {
      // 统一走引擎修订：复用父 source/tests、系统分配版本、静态+行为验证通过后才 verified（审计 P1-5）
      const r = await engine.revise({
        toolId: tool.id, parentVersionId: active.id,
        description: (s.payload && s.payload.description) || active.manifest.description,
        tests, actor: 'suggestion',
      })
      if (!r.ok) throw new Error(r.reason || '修订验证失败')
      s.status = 'applied'
      s.applyResult = { versionId: r.versionId, version: r.version, status: r.status }
      persistSuggestion(rt.suggestionDir, s)
      return { ok: true, note: `工具「${s.target}」描述修订已通过验证 → ${r.version} verified（versionId=${r.versionId}），待 #采纳工具 ${r.versionId} 上线` }
    } catch (e) {
      // 失败保留待审证据与原因，不删除唯一待办记录
      s.status = 'pending'
      s.lastError = e?.message || String(e)
      s.attempts = (s.attempts || 0) + 1
      persistSuggestion(rt.suggestionDir, s)
      throw new Error(`工具建议应用失败（已保留待审）：${e?.message || e}`)
    }
  }
  // skill 类：无自动应用机制，仅移出待审
  removeSuggestion(rt.suggestionDir, s.scopeId, s.id)
  return { ok: true, note: 'skill suggestion 需手工编辑 skills/（已移出待审）' }
}

/**
 * 读取全部 suggestion（跨 scope 子目录，按 status 过滤；供 Web 面板）。
 * 与 listPendingSuggestions 区别：本函数跨 scope、含全部 status（pending/applied/apply_failed）。
 */
export function listAllSuggestions(suggestionDir, { scopeId, status } = {}) {
  const out = []
  try {
    if (!fs.existsSync(suggestionDir)) return []
    const scopes = scopeId
      ? [String(scopeId)]
      : fs.readdirSync(suggestionDir).filter((d) => { try { return fs.statSync(path.join(suggestionDir, d)).isDirectory() } catch { return false } })
    for (const sc of scopes) {
      const dir = path.join(suggestionDir, sc)
      if (!fs.existsSync(dir)) continue
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue
        try {
          const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
          if (status && s.status !== status) continue
          out.push(s)
        } catch { /* 跳过损坏文件 */ }
      }
    }
  } catch { /* noop */ }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0))
}
