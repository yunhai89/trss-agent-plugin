/**
 * ToolEvoRegistry：版本化工具注册表（DB + 文件制品双写）。
 *
 * - createTool / createVersion（不可变版本，parent 链，(tool_id,semver) 唯一）
 * - getVersion / listVersions / getByName
 * - setStatus（走 lifecycle 状态机校验；→stable 时回填 tools.active_version_id + 审批记录）
 * - listStable + toToolContract：stable 版本导出为 ToolRegistry 契约 {name,description,parameters,execute}
 *   （execute 由 sandbox runner 执行候选 source，阶段2 接入；阶段0 此处占位）
 *
 * 文件制品：data/evolution/tools/<name>/<semver>/{TOOL.md, index.js, manifest.json, tests.json}
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { dao } from './db.js'
import { canTransition, isValidState } from './lifecycle.js'
import { validateManifest } from './manifest.js'

export class ToolEvoRegistry {
  constructor({ artifactsDir }) {
    this.artifactsDir = artifactsDir
    fs.mkdirSync(artifactsDir, { recursive: true })
  }

  /** 创建工具逻辑身份（id 唯一，name 唯一） */
  async createTool({ id, name, namespace = 'default' }) {
    await dao.run(`INSERT INTO tools(id,name,namespace,created_at) VALUES(?,?,?,?)`, [id, name, namespace, Date.now()])
    return id
  }

  async getByName(name) { return dao.get(`SELECT * FROM tools WHERE name=?`, [name]) }
  async getById(id) { return dao.get(`SELECT * FROM tools WHERE id=?`, [id]) }

  /** 创建不可变版本（DB + 文件制品双写）。manifest 必须先过 validateManifest。 */
  async createVersion({ toolId, semver, manifest, source, tests = [], parentVersionId = null, generatorModel = null }) {
    const v = validateManifest(manifest)
    if (!v.ok) throw new Error('manifest 校验失败: ' + v.errors.join('; '))
    const exist = await dao.get(`SELECT 1 FROM tool_versions WHERE tool_id=? AND semver=?`, [toolId, semver])
    if (exist) throw new Error(`版本已存在 ${toolId}@${semver}（版本不可变，修订请新 semver）`)
    const id = 'tv_' + crypto.randomBytes(8).toString('hex')
    const sourceHash = crypto.createHash('sha256').update(source || '').digest('hex')
    await dao.run(
      `INSERT INTO tool_versions(id,tool_id,semver,status,source_hash,manifest_json,parent_version_id,generator_model,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      [id, toolId, semver, manifest.status || 'draft', sourceHash, JSON.stringify(manifest), parentVersionId, generatorModel, Date.now()],
    )
    for (const t of tests) {
      const tid = 'tt_' + crypto.randomBytes(6).toString('hex')
      await dao.run(`INSERT INTO tool_tests(id,version_id,kind,name,fixture_json,oracle_json) VALUES(?,?,?,?,?,?)`,
        [tid, id, t.kind || 'unit', t.name || null, JSON.stringify(t.input ?? null), JSON.stringify(t.expected ?? null)])
    }
    this._writeArtifacts(manifest.name, semver, { manifest, source, tests })
    return { id, toolId, semver, status: manifest.status || 'draft', sourceHash }
  }

  _writeArtifacts(name, semver, { manifest, source, tests }) {
    const dir = path.join(this.artifactsDir, name, semver)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    fs.writeFileSync(path.join(dir, 'index.js'), source || '')
    fs.writeFileSync(path.join(dir, 'tests.json'), JSON.stringify(tests, null, 2))
    const md = `# ${manifest.name} v${semver}\n\n${manifest.description}\n\n**useWhen**\n- ${(manifest.useWhen || []).join('\n- ')}\n\n**doNotUseWhen**\n- ${(manifest.doNotUseWhen || []).join('\n- ')}\n\n**sideEffects**: ${(manifest.permissions?.sideEffects || []).join(',')}\n`
    fs.writeFileSync(path.join(dir, 'TOOL.md'), md)
  }

  async getVersion(versionId) {
    const row = await dao.get(`SELECT * FROM tool_versions WHERE id=?`, [versionId])
    return row ? { ...row, manifest: JSON.parse(row.manifest_json) } : null
  }

  async listVersions({ toolId, status } = {}) {
    const where = [], params = []
    if (toolId) { where.push('tool_id=?'); params.push(toolId) }
    if (status) { where.push('status=?'); params.push(status) }
    const sql = `SELECT id,tool_id,semver,status,source_hash,generator_model,created_at FROM tool_versions${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`
    return dao.all(sql, params)
  }

  /** 改状态（状态机校验） */
  async setStatus(versionId, to, { actor, reason } = {}) {
    const v = await this.getVersion(versionId)
    if (!v) throw new Error('版本不存在')
    if (!isValidState(to)) throw new Error('非法状态: ' + to)
    if (v.status === to) return v
    if (!canTransition(v.status, to)) throw new Error(`非法转移 ${v.status} → ${to}`)
    await dao.run(`UPDATE tool_versions SET status=? WHERE id=?`, [to, versionId])
    if (to === 'stable') await dao.run(`UPDATE tools SET active_version_id=? WHERE id=?`, [versionId, v.tool_id])
    if (actor) await this._recordApproval(versionId, actor, to, reason)
    return { ...v, status: to }
  }

  /**
   * 显式切换工具的 active 版本（回滚 / 切换上线版本，审计 §4.1）。
   * 仅 stable 版本可设为 active（须是已验证+审批上线版本）；记审计。
   * 切换后下次热重载/重启，listStable 只返回新 active → ToolRegistry 注入新版本。
   */
  async setActiveVersion(toolId, versionId, { actor, reason } = {}) {
    const v = await this.getVersion(versionId)
    if (!v) throw new Error('版本不存在')
    if (v.tool_id !== toolId) throw new Error('版本不属于该工具')
    if (v.status !== 'stable') throw new Error('仅 stable 版本可设为 active（回滚目标须是已上线版本）')
    await dao.run(`UPDATE tools SET active_version_id=? WHERE id=?`, [versionId, toolId])
    if (actor) await this._recordApproval(versionId, actor, 'rollback', reason)
    return { toolId, activeVersionId: versionId }
  }

  async _recordApproval(versionId, actor, decision, reason) {
    const id = 'ap_' + crypto.randomBytes(6).toString('hex')
    await dao.run(`INSERT INTO approval_records(id,version_id,actor,scope,decision,reason,created_at) VALUES(?,?,?,?,?,?,?)`,
      [id, versionId, actor, 'toolEvo', decision, reason || null, Date.now()])
  }

  /** 每工具的 active stable 版本（供注入 ToolRegistry）。
   *  审计 §4.4：原查询返回所有 stable 按时间 DESC，apps 顺序 register 时后注册覆盖前注册，
   *  最终留下的反而是最旧 stable。改为 JOIN tools.active_version_id——每工具只取其 active 版本。 */
  async listStable() {
    const rows = await dao.all(
      `SELECT tv.id AS version_id, tv.tool_id, tv.semver, tv.manifest_json, t.name
       FROM tools t JOIN tool_versions tv ON tv.id = t.active_version_id
       WHERE tv.status='stable'`,
    )
    return rows.map((r) => ({ versionId: r.version_id, toolId: r.tool_id, name: r.name, semver: r.semver, manifest: JSON.parse(r.manifest_json) }))
  }

  /**
   * 导出为 ToolRegistry 契约。execute 经隔离 runner 调用（审计 §4.2 / P0-1，F 阻断）：
   * stable 不再主进程 import，而在隔离执行面（本地 fork worker / E2B 沙箱）执行。
   * runner 由 apps 注入 —— **未注入一律拒绝执行**：主进程 import 回退已删除，
   * 因为「没有隔离面时退回主进程」正是审计里最危险的 fail-open 开口。
   */
  async toToolContract(stable, runner) {
    const dir = path.join(this.artifactsDir, stable.manifest.name, stable.semver)
    const artifactPath = pathToFileURL(path.join(dir, 'index.js')).href
    const artifactRel = path.join(stable.manifest.name, stable.semver, 'index.js') // 沙箱档据此上传制品
    const versionId = stable.versionId
    const meta = { toolEvoVersionId: versionId, provenance: 'evolved', sideEffects: stable.manifest.permissions?.sideEffects || ['none'] }
    const base = {
      name: stable.manifest.name,
      description: stable.manifest.description,
      parameters: stable.manifest.inputSchema,
      category: stable.manifest.category || 'query', // 真实类别（审计 §3.3），不用 'evolved'
      meta,
    }
    if (runner) {
      return {
        ...base,
        async execute(params) {
          const r = await runner.invoke(versionId, { artifactPath, artifactRel, params })
          if (!r.ok) throw new Error(r.error || '进化工具执行失败')
          return r.output
        },
      }
    }
    // fail-closed：没有隔离执行面就拒绝执行（绝不在 Bot 主进程跑进化工具）
    return {
      ...base,
      async execute() {
        throw new Error(`进化工具「${stable.manifest.name}@${stable.semver}」当前不可用：隔离执行面未就绪（toolEvo runner 未注入）。已拒绝在主进程执行。`)
      },
    }
  }
}

export default ToolEvoRegistry
