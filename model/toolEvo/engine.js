/**
 * 进化引擎编排（阶段1：缺口 → 生成 → 静态验证 → 注册 draft）。
 *
 * 安全铁律（文档 §5.2）：候选仅进 draft/rejected，**禁自动晋升**（verified 需阶段2 行为验证 + 主人审批）。
 * 失败/危险候选 reject，不入库（绝不污染 stable）。
 *
 * synthesizer/registry 由 apps 注入。
 */
import crypto from 'node:crypto'
import { verifyStatic } from './verifier/static.js'
import { verifyBehavior } from './verifier/behavior.js'

export class EvolutionEngine {
  constructor({ synthesizer, registry, logger = () => {} }) {
    this.synthesizer = synthesizer
    this.registry = registry
    this.logger = logger
  }

  /**
   * 针对一个能力缺口生成并验证候选。
   * @param {object} p { goal, examples?, context?, toolId?(已有工具则建新版本), parentVersionId? }
   * @returns { ok, versionId?, status:'draft'|'rejected', reason?, assumptions? }
   */
  async evolve({ goal, examples = [], context = '', toolId = null, parentVersionId = null }) {
    // 1. 生成（含修复循环 + 本地校验 + 生成闸）
    const gen = await this.synthesizer.generate({ goal, examples, context })
    if (!gen.ok) return { ok: false, status: 'rejected', reason: '生成失败：' + gen.error }
    const { manifest, source, tests, assumptions } = gen.candidate

    // 2. 静态验证（typescript AST 禁用模式 + manifest schema + 导出 run）
    const sv = verifyStatic({ manifest, source })
    if (!sv.passed) {
      this.logger('warn', '[toolEvo] 候选静态验证失败', sv.violations)
      return { ok: false, status: 'rejected', reason: '静态验证：' + sv.violations.join('; ') }
    }

    // 3. 注册 draft（不入 active；禁自动晋升）
    try {
      let tid = toolId
      if (!tid) {
        const exist = await this.registry.getByName(manifest.name)
        if (exist) {
          // 名字碰撞防线：只允许复用「已进化的」同名工具（修订流程）。
          // 内置/受信工具（namespace !== 'evolved'）绝不可被进化候选挂靠——否则采纳后会顶掉
          // builtin 的 active_version_id，等于用生成代码覆盖受信实现（可信基不可被工具进化）。
          if (exist.namespace && exist.namespace !== 'evolved') {
            return { ok: false, status: 'rejected', reason: `名字冲突：「${manifest.name}」与内置/受信工具同名，进化工具不可覆盖内置工具——请改名后重新描述能力` }
          }
          tid = exist.id
        } else {
          tid = 'tool_' + crypto.randomBytes(6).toString('hex')
          await this.registry.createTool({ id: tid, name: manifest.name, namespace: 'evolved' })
        }
      }
      const v = await this.registry.createVersion({
        toolId: tid, semver: manifest.version, manifest, source, tests,
        parentVersionId, generatorModel: this.synthesizer.model,
      })
      this.logger('mark', `[toolEvo] 候选注册 ${manifest.name}@${manifest.version} → draft，开始行为验证（沙箱跑 tests）`)
      // 行为验证：跑候选 tests + 断言 + 性能/超时门（AST 已过，沙箱兜底运行时行为）
      const bv = await verifyBehavior({ source, tests, timeoutMs: 3000 })
      if (bv.passed) {
        await this.registry.setStatus(v.id, 'verified', { actor: 'engine', reason: `行为验证 ${bv.evidence.passed}/${bv.evidence.totalTests} 通过，avgMs=${bv.evidence.avgMs}` })
        this.logger('mark', `[toolEvo] ${manifest.name}@${manifest.version} → verified（${bv.evidence.passed}/${bv.evidence.totalTests} tests，avg ${bv.evidence.avgMs}ms）`)
        return { ok: true, versionId: v.id, status: 'verified', evidence: bv.evidence, assumptions, name: manifest.name, version: manifest.version }
      }
      const failReasons = bv.results.filter((r) => !r.passed).map((r) => r.reason).join('; ')
      await this.registry.setStatus(v.id, 'rejected', { actor: 'engine', reason: '行为验证失败：' + failReasons })
      this.logger('warn', `[toolEvo] ${manifest.name}@${manifest.version} 行为验证失败 → rejected：${failReasons}`)
      return { ok: false, status: 'rejected', reason: '行为验证失败：' + failReasons, evidence: bv.evidence }
    } catch (e) {
      return { ok: false, status: 'rejected', reason: '注册失败：' + (e?.message || e) }
    }
  }
}

export default EvolutionEngine
