/**
 * 进化引擎编排（阶段1/2：缺口 → 生成 → 静态验证 → 行为验证 → verified）。
 *
 * 安全铁律（文档 §5.2）：候选不自动晋升 stable；verified 需行为验证全过，stable 仍需主人审批。
 * 版本由注册表原子分配（审计 P1-3），修订明确关联父版本；失败/危险候选 reject，绝不污染 active。
 *
 * 验收输入（审计 P1-4）：调用方传入的 examples 是**受信验收用例**，不可被生成器改写，
 * 与候选自带 tests 一起在行为门执行；缺 oracle 的用例一律不计正确。
 *
 * synthesizer/registry 由 apps 注入。
 */
import crypto from 'node:crypto'
import { verifyStatic } from './verifier/static.js'
import { verifyBehavior, VERIFIER_VERSION } from './verifier/behavior.js'
import { makeManifest } from './manifest.js'

export class EvolutionEngine {
  constructor({ synthesizer, registry, logger = () => {}, verifySession = null, verifyTimeoutMs = 3000 }) {
    this.synthesizer = synthesizer
    this.registry = registry
    this.logger = logger
    this.verifySession = verifySession
    this.verifyTimeoutMs = Math.max(500, Number(verifyTimeoutMs) || 3000)
  }

  /**
   * 针对一个能力缺口生成并验证候选。
   * @param {object} p { goal, examples?, context?, toolId?(已有工具则建新版本), parentVersionId? }
   * @returns { ok, versionId?, status, reason?, evidence?, assumptions?, name?, version? }
   */
  async evolve({ goal, examples = [], context = '', toolId = null, parentVersionId = null }) {
    // 0. 受信验收用例（不可被生成器改写）
    let accept
    try { accept = normalizeExamples(examples) }
    catch (e) { return { ok: false, status: 'rejected', reason: e?.message || String(e) } }

    // 1. 生成（含修复循环 + 本地完整校验 + 生成闸）
    const gen = await this.synthesizer.generate({ goal, examples: accept, context })
    if (!gen.ok) return { ok: false, status: 'rejected', reason: '生成失败：' + gen.error }
    const { manifest, source, tests, assumptions } = gen.candidate

    // 2. 静态验证（AST 禁用模式 + manifest schema + 导出 run）
    const sv = verifyStatic({ manifest, source })
    if (!sv.passed) {
      this.logger('warn', '[toolEvo] 候选静态验证失败', sv.violations)
      return { ok: false, status: 'rejected', reason: '静态验证：' + sv.violations.join('; ') }
    }

    // 3. 解析目标工具身份 + 父版本（同名改进建父链；内置/受信工具同名拒绝）
    let tid = toolId
    let parent = parentVersionId
    try {
      if (tid) {
        const tool = await this.registry.getById(tid)
        if (!tool) return { ok: false, status: 'rejected', reason: `指定的工具 ${tid} 不存在` }
        if (tool.name !== manifest.name) {
          return { ok: false, status: 'rejected', reason: `manifest.name(${manifest.name}) 与指定工具名(${tool.name}) 不一致，拒绝挂靠` }
        }
        if (tool.namespace !== 'evolved') {
          return { ok: false, status: 'rejected', reason: `「${manifest.name}」是内置/受信工具，禁止用生成代码覆盖` }
        }
        if (parent) {
          const pv = await this.registry.getVersion(parent)
          if (!pv || pv.tool_id !== tid) return { ok: false, status: 'rejected', reason: '指定的父版本不存在或不属于该工具' }
        } else {
          parent = await this._parentVersionId(tid)
        }
      } else {
        const exist = await this.registry.getByName(manifest.name)
        if (exist) {
          if (exist.namespace && exist.namespace !== 'evolved') {
            return { ok: false, status: 'rejected', reason: `名字冲突：「${manifest.name}」与内置/受信工具同名，进化工具不可覆盖内置工具——请改名后重新描述能力` }
          }
          tid = exist.id
          if (parent) {
            const pv = await this.registry.getVersion(parent)
            if (!pv || pv.tool_id !== tid) return { ok: false, status: 'rejected', reason: '指定的父版本不属于该工具' }
          } else {
            parent = await this._parentVersionId(tid)
          }
        } else {
          tid = 'tool_' + crypto.randomBytes(6).toString('hex')
          await this.registry.createTool({ id: tid, name: manifest.name, namespace: 'evolved' })
        }
      }

      // 4. 注册 draft（semver 由注册表原子分配；显式传入则遵守）
      const v = await this.registry.createVersion({
        toolId: tid, manifest, source, tests,
        parentVersionId: parent, generatorModel: this.synthesizer.model,
      })
      this.logger('mark', `[toolEvo] 候选注册 ${manifest.name}@${v.semver} → draft，开始行为验证`)

      // 5. 行为验证：候选 tests + 受信验收 examples（一个候选一个会话复用）
      const allTests = [...tests.map((t) => ({ kind: t.kind || 'unit', name: t.name, input: t.input, expected: t.expected, trusted: false })),
        ...accept.map((t, i) => ({ kind: 'acceptance', name: t.name || `acceptance_${i + 1}`, input: t.input, expected: t.expected, trusted: true }))]
      const bv = await verifyBehavior({ source, tests: allTests, timeoutMs: this.verifyTimeoutMs, createSession: this.verifySession })
      if (bv.passed) {
        await this.registry.setStatus(v.id, 'verified', {
          actor: 'engine', verifier: VERIFIER_VERSION,
          reason: `行为验证 ${bv.evidence.passed}/${bv.evidence.totalTests} 通过，avgMs=${bv.evidence.avgMs}`,
        })
        this.logger('mark', `[toolEvo] ${manifest.name}@${v.semver} → verified（${bv.evidence.passed}/${bv.evidence.totalTests} tests）`)
        return { ok: true, versionId: v.id, status: 'verified', evidence: bv.evidence, assumptions, name: manifest.name, version: v.semver }
      }
      const failReasons = bv.results.filter((r) => !r.passed).map((r) => r.reason).join('; ')
      await this.registry.setStatus(v.id, 'rejected', { actor: 'engine', reason: '行为验证失败：' + failReasons })
      this.logger('warn', `[toolEvo] ${manifest.name}@${v.semver} 行为验证失败 → rejected：${failReasons}`)
      return { ok: false, status: 'rejected', reason: '行为验证失败：' + failReasons, evidence: bv.evidence, versionId: v.id }
    } catch (e) {
      return { ok: false, status: 'rejected', reason: '注册/验证失败：' + (e?.message || e) }
    }
  }

  /**
   * 修订既有工具（建议采纳 / 元数据改进统一入口，审计 P1-5）：
   * 复用父版本测试与源码，系统分配新版本并关联父链，走同一静态/行为验证后再置 verified。
   * 内置/受信工具（空 source）拒绝用生成制品替代；失败保留可审阅状态。
   * @returns { ok, versionId?, status, version?, reason?, evidence? }
   */
  async revise({ toolId, parentVersionId = null, description = null, tests = null, examples = [], actor = 'revise' }) {
    let accept
    try { accept = normalizeExamples(examples) }
    catch (e) { return { ok: false, status: 'rejected', reason: e?.message || String(e) } }
    const tool = await this.registry.getById(toolId)
    if (!tool) return { ok: false, status: 'rejected', reason: '工具不存在' }
    const parent = parentVersionId ? await this.registry.getVersion(parentVersionId) : null
    if (!parent) return { ok: false, status: 'rejected', reason: '父版本不存在（修订须有可复用的父制品）' }
    if (parent.tool_id !== toolId) return { ok: false, status: 'rejected', reason: '父版本不属于该工具' }
    if (tool.namespace === 'builtin' || parent.manifest?.provenance?.kind === 'human') {
      return { ok: false, status: 'rejected', reason: '内置/受信工具不可用生成制品替代，请在插件源码维护' }
    }
    if (!parent.source) return { ok: false, status: 'rejected', reason: '父版本无可复用源码（空 source），拒绝生成替代实现' }
    const useTests = Array.isArray(tests) && tests.length ? tests : (parent.tests || [])
    if (!useTests.length) return { ok: false, status: 'rejected', reason: '父版本无测试用例，无法验证修订（拒绝无 oracle 上线）' }
    // manifest 元数据改进：权限/运行时/来源沿用父版本（不可借描述改进扩权）
    const manifest = makeManifest({
      ...parent.manifest,
      description: description || parent.manifest.description,
      version: undefined,
      status: 'draft',
      provenance: { ...(parent.manifest.provenance || {}), kind: 'refined', parentVersionId: parent.id },
      permissions: parent.manifest.permissions,
    })
    const sv = verifyStatic({ manifest, source: parent.source })
    if (!sv.passed) {
      this.logger('warn', '[toolEvo] 修订静态验证失败', sv.violations)
      return { ok: false, status: 'rejected', reason: '静态验证：' + sv.violations.join('; ') }
    }
    let v
    try {
      v = await this.registry.createVersion({
        toolId, manifest, source: parent.source, tests: useTests,
        parentVersionId: parent.id, generatorModel: this.synthesizer?.model || null,
      })
    } catch (e) {
      return { ok: false, status: 'rejected', reason: '注册失败：' + (e?.message || e) }
    }
    const allTests = [...useTests.map((t) => ({ kind: t.kind || 'unit', name: t.name, input: t.input, expected: t.expected })),
      ...accept.map((t, i) => ({ kind: 'acceptance', name: t.name || `acceptance_${i + 1}`, input: t.input, expected: t.expected, trusted: true }))]
    const bv = await verifyBehavior({ source: parent.source, tests: allTests, timeoutMs: this.verifyTimeoutMs, createSession: this.verifySession })
    if (bv.passed) {
      await this.registry.setStatus(v.id, 'verified', { actor, verifier: VERIFIER_VERSION, reason: `修订行为验证 ${bv.evidence.passed}/${bv.evidence.totalTests} 通过` })
      return { ok: true, status: 'verified', versionId: v.id, version: v.semver, evidence: bv.evidence }
    }
    const failReasons = bv.results.filter((r) => !r.passed).map((r) => r.reason).join('; ')
    await this.registry.setStatus(v.id, 'rejected', { actor, reason: '行为验证失败：' + failReasons })
    return { ok: false, status: 'rejected', versionId: v.id, version: v.semver, reason: '行为验证失败：' + failReasons, evidence: bv.evidence }
  }

  /** 修订的父版本：优先当前 active stable，其次最新 verified/stable，最后最新版本 */
  async _parentVersionId(toolId) {
    const tool = await this.registry.getById(toolId)
    if (tool?.active_version_id) return tool.active_version_id
    const list = await this.registry.listVersions({ toolId })
    const served = list.find((v) => v.status === 'verified' || v.status === 'stable')
    return (served || list[0])?.id || null
  }
}

/** 规整受信验收用例：必须有 oracle（expected 键存在，值可为 null/false/0） */
function normalizeExamples(examples) {
  if (!Array.isArray(examples)) return []
  const out = []
  for (let i = 0; i < examples.length; i++) {
    const e = examples[i]
    if (!e || typeof e !== 'object') continue
    if (!Object.prototype.hasOwnProperty.call(e, 'expected')) {
      throw new Error(`受信验收用例 examples[${i}] 缺少 expected（oracle）`)
    }
    out.push({ name: e.name || `acceptance_${i + 1}`, input: e.input, expected: e.expected })
  }
  return out
}

export default EvolutionEngine
