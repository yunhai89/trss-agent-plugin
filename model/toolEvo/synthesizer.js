/**
 * 候选工具生成器（文档 §13）。
 *
 * 用 LLM + 结构化输出产出 { manifest, source, tests, assumptions }。
 * 约束：① sideEffects ∈ {none, read} 且不得声明额外能力（generationPermissionViolations）
 *      ② 纯函数 JS：export async function run(input, ctx)，零 import（verifyStatic 兜底）
 * 修复循环：输出不合规则带错误重新生成，≤ maxRepairAttempts（防无限自我修复把安全限制"修掉"）。
 *
 * 结构化输出契约（审计 P1-2）：request 用与协议无关的 OpenAI json_schema 形态，
 * 由各 provider 适配器映射为原生参数（OpenAI response_format / Anthropic output_config.format /
 * Gemini response_format）。schema 仅使用各协议普遍支持的子集（type/properties/required/
 * additionalProperties/items/enum/description），任意 inputSchema 与 fixture 一律用 JSON 字符串
 * 封装后本地解析校验，避免发送不合法的严格 schema。
 *
 * provider/model 由 apps 注入（如 SelfReviewer）；库零依赖。
 */
import { validateManifest, generationPermissionViolations, makeManifest } from './manifest.js'

/**
 * 候选输出 JSON Schema（严格子集，供各协议结构化输出）。
 * OpenAI strict 要求每个 object 关闭 additionalProperties 且 required 覆盖全部声明属性；
 * 这里刻意不使用 minLength/pattern/minItems 等部分兼容端不支持的约束，改由本地校验兜底。
 */
const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['manifest', 'source', 'tests', 'assumptions'],
  properties: {
    manifest: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'description', 'category', 'useWhen', 'doNotUseWhen', 'tags', 'inputSchemaJson', 'permissions'],
      properties: {
        name: { type: 'string', description: '小写字母开头，仅小写字母/数字/连字符/下划线' },
        description: { type: 'string', description: '至少 6 字符，说清用途与适用条件' },
        category: { type: 'string', enum: ['query', 'personal', 'message', 'group_manage', 'system'] },
        useWhen: { type: 'array', items: { type: 'string' } },
        doNotUseWhen: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
        inputSchemaJson: { type: 'string', description: '入参 JSON Schema 的 JSON 字符串，例如 {"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}' },
        permissions: {
          type: 'object',
          additionalProperties: false,
          required: ['sideEffects'],
          properties: { sideEffects: { type: 'array', items: { enum: ['none', 'read'] } } },
        },
      },
    },
    source: { type: 'string', description: '纯函数 JS：export async function run(input, ctx) { ... }，零 import' },
    tests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'inputJson', 'expectedJson'],
        properties: {
          name: { type: 'string' },
          inputJson: { type: 'string', description: '用例输入的 JSON 字符串' },
          expectedJson: { type: 'string', description: '期望输出的 JSON 字符串；不得省略（缺 oracle 的用例一律拒绝）' },
        },
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
}

const NAME_RE = /^[a-z][a-z0-9_-]*$/

/** 构造生成 prompt（单一原子职责/完整 schema/禁 API/资源/副作用/测试/输出 JSON） */
function buildPrompt({ goal, examples, context }) {
  return [
    '你在为一个 Node.js Agent 生成一个【可复用工具】。输出必须是严格 JSON，schema 见结构化输出配置。',
    '',
    '## 任务目标（能力缺口）',
    goal,
    context ? `\n## 情境\n${context}` : '',
    '',
    '## 硬性约束（违反即拒绝）',
    '1. 单一原子职责；纯函数，零副作用优先（sideEffects: ["none"]），只读 ["read"] 次之；',
    '   禁止 write/network/message/delete（这些走固定受信适配器，永不自动生成）。',
    '2. source 必须是 `export async function run(input, ctx) { ... return result }`，零 import（不引任何模块）。',
    '   禁 require/child_process/process.env/eval/动态 import/new Function。不得访问 process/globalThis/fs/net。',
    '3. inputSchemaJson 是入参 JSON Schema 的 JSON 字符串；tests 至少 2 个（含 1 个边界/错误用例），',
    '   每个用例都要给出 expectedJson（JSON 字符串，可以是 null/false/0），不允许缺省。',
    '4. name 小写字母+数字+连字符/下划线；description ≥6 字符说清用途与适用条件。',
    '5. manifest.category 填权限类别：纯计算/只读 "query"（人人可用，多数工具为此）；用户私有数据 "personal"；'
      + '发消息 "message"；群管写操作 "group_manage"；系统级 "system"。',
    examples?.length ? `\n## 参考用例（必须由实现满足，属强制验收）\n${examples.map((e) => `- 输入:${JSON.stringify(e.input)} → 期望:${JSON.stringify(e.expected)}`).join('\n')}` : '',
    '',
    '## 输出',
    '严格按结构化输出 schema 输出，不要任何额外文字。',
  ].filter(Boolean).join('\n')
}

/** 解析 JSON 字符串；失败抛错 */
function parseJsonField(raw, field) {
  if (typeof raw !== 'string') throw new Error(`${field} 必须是 JSON 字符串`)
  let v
  try { v = JSON.parse(raw) } catch (e) { throw new Error(`${field} 不是合法 JSON：${e?.message || e}`) }
  return v
}

export class ToolSynthesizer {
  constructor({ provider, model, maxRepairAttempts = 2, logger = () => {} }) {
    this.provider = provider
    this.model = model
    this.maxRepairAttempts = Math.max(0, Number(maxRepairAttempts) || 0)
    this.logger = logger
  }

  /**
   * 生成一个候选工具。
   * @returns { ok, candidate?:{manifest,source,tests,assumptions}, error? }
   */
  async generate({ goal, examples = [], context = '' }) {
    const prompt = buildPrompt({ goal, examples, context })
    let lastError = null
    for (let attempt = 0; attempt <= this.maxRepairAttempts; attempt++) {
      let raw
      try {
        raw = await this._call(prompt, lastError)
      } catch (e) {
        lastError = `LLM 调用失败：${e?.message || e}`
        this.logger('warn', '[toolEvo:synth] LLM 调用失败', lastError)
        continue
      }
      const parsed = this._parse(raw)
      if (!parsed.ok) { lastError = `输出非合法 JSON：${parsed.error}`; continue }
      const chk = this._normalizeCandidate(parsed.value)
      if (!chk.ok) { lastError = chk.error; this.logger('debug', '[toolEvo:synth] 候选不合规，修复重试', chk.error); continue }
      return { ok: true, candidate: chk.candidate }
    }
    return { ok: false, error: lastError || `生成失败（超过 ${this.maxRepairAttempts} 次修复）` }
  }

  /**
   * 本地完整校验并把候选规范化为内部契约：
   *   - version/status/runtime/provenance 由受信系统决定，不采信 LLM；
   *   - permissions 深合并受信默认（network deny / 无 fs / 无 secrets），并拒绝任何越权声明；
   *   - inputSchemaJson / inputJson / expectedJson 解析为对象/值；
   *   - 每条测试都必须有 oracle（expectedJson）。
   * @returns { ok, candidate?, error? }
   */
  _normalizeCandidate(cand) {
    if (!cand || typeof cand !== 'object') return { ok: false, error: '输出非对象' }
    if (!cand.manifest || typeof cand.manifest !== 'object') return { ok: false, error: '缺 manifest' }
    const rawM = cand.manifest
    if (!NAME_RE.test(String(rawM.name || ''))) return { ok: false, error: 'name 非法（须小写字母开头，仅小写字母/数字/连字符/下划线）' }
    if (String(rawM.description || '').length < 6) return { ok: false, error: 'description 至少 6 字符' }
    if (!Array.isArray(cand.tests) || cand.tests.length < 2) return { ok: false, error: 'tests 至少 2 个（含边界/错误用例）' }
    if (!cand.source || !/export\s+async\s+function\s+run\s*\(/.test(cand.source)) return { ok: false, error: 'source 须为 export async function run(...)' }

    let inputSchema
    try { inputSchema = parseJsonField(rawM.inputSchemaJson, 'inputSchemaJson') }
    catch (e) { return { ok: false, error: e.message } }
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return { ok: false, error: 'inputSchemaJson 须为 JSON 对象' }

    // 受信系统决定版本/状态/运行时/来源；permissions 深合并默认
    const manifest = makeManifest({
      name: rawM.name,
      description: rawM.description,
      category: rawM.category,
      useWhen: rawM.useWhen,
      doNotUseWhen: rawM.doNotUseWhen,
      tags: rawM.tags,
      inputSchema,
      permissions: rawM.permissions,
      version: '0.1.0',
      status: 'draft',
      runtime: undefined,
      provenance: { kind: 'generated' },
    })
    const mv = validateManifest(manifest)
    if (!mv.ok) return { ok: false, error: 'manifest：' + mv.errors.join('; ') }
    const pv = generationPermissionViolations(manifest)
    if (pv.length) return { ok: false, error: '生成闸：' + pv.join('；') }

    const tests = []
    for (let i = 0; i < cand.tests.length; i++) {
      const t = cand.tests[i]
      if (!t || typeof t !== 'object') return { ok: false, error: `tests[${i}] 非对象` }
      let input, expected
      try {
        input = parseJsonField(t.inputJson, `tests[${i}].inputJson`)
        expected = parseJsonField(t.expectedJson, `tests[${i}].expectedJson`)
      } catch (e) { return { ok: false, error: e.message } }
      tests.push({ name: t.name || `case_${i + 1}`, input, expected })
    }

    return {
      ok: true,
      candidate: {
        manifest,
        source: cand.source,
        tests,
        assumptions: Array.isArray(cand.assumptions) ? cand.assumptions.filter((a) => typeof a === 'string') : [],
      },
    }
  }

  async _call(prompt, repairHint) {
    const content = repairHint ? `${prompt}\n\n—— 上次输出被拒：${repairHint}\n请修正后严格按 schema 重新输出。` : prompt
    const r = await this.provider.chat({
      model: this.model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_schema', json_schema: { name: 'tool_candidate', strict: true, schema: CANDIDATE_SCHEMA } },
    })
    return r?.content || ''
  }

  _parse(text) {
    try { return { ok: true, value: JSON.parse(String(text || '').trim()) } }
    catch (e) { return { ok: false, error: e?.message || String(e) } }
  }
}

export { CANDIDATE_SCHEMA }
export default ToolSynthesizer
