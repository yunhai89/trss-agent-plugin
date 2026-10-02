/**
 * ToolEvoRegistry：版本化工具注册表（DB + 文件制品双写）。
 *
 * - createTool / createVersion（不可变版本；semver 由系统原子分配；parent 链；(tool_id,semver) 唯一）
 * - getVersion / getTests / listVersions / getByName
 * - setStatus（走 lifecycle 状态机校验；verified 绑定内容哈希；stable 校验哈希+制品完整性）
 * - setActiveVersion（回滚/切换；仅 stable 且制品完整）
 * - listStable + toToolContract：stable 导出为 ToolRegistry 契约，execute 经隔离 runner 执行
 *
 * 制品完整性（审计 P1-7）：createVersion 计算 content_hash = H(source, manifest, tests)，
 * 同时把 source/tests 存入 DB。审批/加载/调用以同一份不可变内容为准：stable 前校验哈希，
 * 调用时 runner 再校验宿主制品文件哈希，杜绝“验证后重新读取”的竞态与篡改执行。
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

/** 规范化 JSON（对象键排序）→ 稳定哈希输入 */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = canonical(v[k])
    return o
  }
  return v
}

/** 制品内容哈希：绑定实际运行的 source/manifest/tests */
export function contentHashOf({ source, manifest, tests }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    source: String(source || ''),
    manifest: canonical(manifest || {}),
    tests: canonical(tests || []),
  })).digest('hex')
}

/** semver 数值比较（a>b → 正） */
function compareSemver(a, b) {
  const pa = String(a || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0) }
  return 0
}
function bumpPatch(semver) {
  const p = String(semver || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0)
  while (p.length < 3) p.push(0)
  p[2] += 1
  return p.join('.')
}

export class ToolEvoRegistry {
  constructor({ artifactsDir }) {
    this.artifactsDir = artifactsDir
    fs.mkdirSync(artifactsDir, { recursive: true })
    this._versionLock = Promise.resolve() // 版本分配/创建的进程内串行锁（审计 P1-3）
  }

  /** 进程内串行：分配 semver + 插入必须在同一临界区，防同名并发撞版本 */
  async _withVersionLock(fn) {
    const prev = this._versionLock
    let release
    this._versionLock = new Promise((r) => { release = r })
    await prev
    try { return await fn() } finally { release() }
  }

  /**
   * 兼容迁移：为审计前入库、缺 source_text/content_hash 的旧版本，从磁盘制品回填哈希与源码，
   * 使既有 stable 工具在升级后仍能通过完整性校验并被注入。旧制品缺失则保持 NULL（fail-closed）。
   * @returns 回填的版本数
   */
  async backfillFromArtifacts() {
    const rows = await dao.all(`SELECT * FROM tool_versions WHERE content_hash IS NULL OR source_text IS NULL`)
    let n = 0
    for (const row of rows) {
      try {
        const manifest = JSON.parse(row.manifest_json)
        const dir = path.join(this.artifactsDir, manifest.name, row.semver)
        const diskManifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
        const source = fs.readFileSync(path.join(dir, 'index.js'), 'utf8')
        const tests = JSON.parse(fs.readFileSync(path.join(dir, 'tests.json'), 'utf8'))
        const contentHash = contentHashOf({ source, manifest: diskManifest, tests })
        const sourceHash = crypto.createHash('sha256').update(source || '').digest('hex')
        await dao.run(
          `UPDATE tool_versions SET source_text=?, source_hash=?, tests_json=?, content_hash=? WHERE id=?`,
          [source, sourceHash, JSON.stringify(tests), contentHash, row.id],
        )
        n++
      } catch { /* 旧制品缺失/损坏：保持 NULL，由完整性校验 fail-closed */ }
    }
    return n
  }

  /** 创建工具逻辑身份（id 唯一，name 唯一） */
  async createTool({ id, name, namespace = 'default' }) {
    await dao.run(`INSERT INTO tools(id,name,namespace,created_at) VALUES(?,?,?,?)`, [id, name, namespace, Date.now()])
    return id
  }

  async getByName(name) { return dao.get(`SELECT * FROM tools WHERE name=?`, [name]) }
  async getById(id) { return dao.get(`SELECT * FROM tools WHERE id=?`, [id]) }

  /** 系统分配下一个 semver：无版本 → 0.1.0；有版本 → 最高版本 patch+1（同名连续修订不撞版本） */
  async _nextSemver(toolId) {
    const rows = await dao.all(`SELECT semver FROM tool_versions WHERE tool_id=?`, [toolId])
    if (!rows.length) return '0.1.0'
    const max = rows.map((r) => r.semver).sort(compareSemver).pop()
    return bumpPatch(max)
  }

  /**
   * 创建不可变版本（DB + 文件制品双写）。manifest 必须先过 validateManifest。
   * semver 缺省时由系统在该工具下原子分配；显式 toolId/parentVersionId 会核对身份、namespace、manifest.name、父子归属。
   */
  async createVersion({ toolId, semver = null, manifest, source, tests = [], parentVersionId = null, generatorModel = null, status = null }) {
    return this._withVersionLock(async () => {
      const tool = await this.getById(toolId)
      if (!tool) throw new Error('工具不存在')
      // 身份核对：manifest.name 必须与工具逻辑身份一致（防显式 toolId 把制品写到别的工具名下）
      if (!manifest || manifest.name !== tool.name) throw new Error(`manifest.name(${manifest?.name}）与工具名(${tool.name}）不一致`)
      // 内置/受信工具（seed namespace=builtin，或已登记 human 版本）不可被自动生成（generated/refined）制品覆盖
      const kind = manifest.provenance?.kind
      const isTrusted = tool.namespace === 'builtin'
      if (isTrusted && (kind === 'generated' || kind === 'refined')) {
        throw new Error(`内置/受信工具「${tool.name}」不可写入自动生成制品`)
      }
      if (parentVersionId) {
        const parent = await this.getVersion(parentVersionId)
        if (!parent) throw new Error('父版本不存在')
        if (parent.tool_id !== toolId) throw new Error('父版本不属于该工具')
      }
      const sv = semver || await this._nextSemver(toolId)
      const m = { ...manifest, version: sv, status: status || manifest.status || 'draft' }
      const v = validateManifest(m)
      if (!v.ok) throw new Error('manifest 校验失败: ' + v.errors.join('; '))
      const exist = await dao.get(`SELECT 1 FROM tool_versions WHERE tool_id=? AND semver=?`, [toolId, sv])
      if (exist) throw new Error(`版本已存在 ${toolId}@${sv}（版本不可变，修订请新 semver）`)

      const id = 'tv_' + crypto.randomBytes(8).toString('hex')
      const sourceHash = crypto.createHash('sha256').update(source || '').digest('hex')
      const contentHash = contentHashOf({ source, manifest: m, tests })
      await dao.run(
        `INSERT INTO tool_versions(id,tool_id,semver,status,source_hash,source_text,tests_json,content_hash,manifest_json,parent_version_id,generator_model,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, toolId, sv, m.status, sourceHash, String(source || ''), JSON.stringify(tests || []), contentHash,
          JSON.stringify(m), parentVersionId, generatorModel, Date.now()],
      )
      try {
        for (const t of tests) {
          const tid = 'tt_' + crypto.randomBytes(6).toString('hex')
          await dao.run(`INSERT INTO tool_tests(id,version_id,kind,name,fixture_json,oracle_json) VALUES(?,?,?,?,?,?)`,
            [tid, id, t.kind || 'unit', t.name || null, JSON.stringify(t.input ?? null), JSON.stringify(t.expected ?? null)])
        }
        this._writeArtifacts(m.name, sv, { manifest: m, source, tests })
      } catch (e) {
        // 补偿：制品/测试写入失败时删除版本记录，避免“库有版本、制品缺失”导致状态与实际不一致
        try { await dao.run(`DELETE FROM tool_tests WHERE version_id=?`, [id]) } catch { /* noop */ }
        try { await dao.run(`DELETE FROM tool_versions WHERE id=?`, [id]) } catch { /* noop */ }
        try { fs.rmSync(path.join(this.artifactsDir, m.name, sv), { recursive: true, force: true }) } catch { /* noop */ }
        throw new Error(`写入版本制品失败，已回滚版本记录：${e?.message || e}`)
      }
      return { id, toolId, semver: sv, status: m.status, sourceHash, contentHash }
    })
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
    if (!row) return null
    let tests = []
    try { tests = JSON.parse(row.tests_json || '[]') } catch { tests = [] }
    return {
      ...row,
      manifest: JSON.parse(row.manifest_json),
      source: row.source_text || '',
      tests,
      contentHash: row.content_hash || null,
      verifiedContentHash: row.verified_content_hash || null,
      verifiedVerifier: row.verified_verifier || null,
    }
  }

  /** 版本的测试用例（从 tool_tests 读取，保留 input/expected 值） */
  async getTests(versionId) {
    const rows = await dao.all(`SELECT kind,name,fixture_json,oracle_json FROM tool_tests WHERE version_id=?`, [versionId])
    return rows.map((r) => {
      let input, expected
      try { input = JSON.parse(r.fixture_json) } catch { input = null }
      try { expected = JSON.parse(r.oracle_json) } catch { expected = null }
      return { kind: r.kind, name: r.name, input, expected }
    })
  }

  async listVersions({ toolId, status } = {}) {
    const where = [], params = []
    if (toolId) { where.push('tv.tool_id=?'); params.push(toolId) }
    if (status) { where.push('tv.status=?'); params.push(status) }
    const sql = `SELECT tv.id,tv.tool_id,tv.semver,tv.status,tv.source_hash,tv.content_hash,tv.parent_version_id,tv.generator_model,tv.created_at,t.name,tv.manifest_json,
        (SELECT COUNT(*) FROM tool_tests tt WHERE tt.version_id=tv.id) AS tests_count
      FROM tool_versions tv LEFT JOIN tools t ON t.id=tv.tool_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY tv.created_at DESC`
    const rows = await dao.all(sql, params)
    // active 标记（供命令/Web 展示 + 主人审阅）
    const actives = await dao.all(`SELECT id,active_version_id FROM tools WHERE active_version_id IS NOT NULL`)
    const activeSet = new Set(actives.map((a) => a.active_version_id))
    return rows.map((r) => {
      let manifest = {}
      try { manifest = JSON.parse(r.manifest_json || '{}') } catch { /* noop */ }
      const { manifest_json: _mj, ...rest } = r
      return {
        ...rest,
        active: activeSet.has(r.id),
        description: manifest.description || '',
        category: manifest.category || 'query',
        sideEffects: manifest.permissions?.sideEffects || [],
        provenanceKind: manifest.provenance?.kind || null,
      }
    })
  }

  /** 改状态（状态机校验）；verified 绑定内容哈希；stable 校验哈希与制品完整性 */
  async setStatus(versionId, to, { actor, reason, verifier } = {}) {
    const v = await this.getVersion(versionId)
    if (!v) throw new Error('版本不存在')
    if (!isValidState(to)) throw new Error('非法状态: ' + to)
    if (v.status === to) return v
    if (!canTransition(v.status, to)) throw new Error(`非法转移 ${v.status} → ${to}`)
    if (to === 'stable') {
      if (!v.contentHash) throw new Error('版本缺少内容哈希，拒绝上线（旧数据需重新验证）')
      if (!v.verifiedContentHash || v.verifiedContentHash !== v.contentHash) {
        throw new Error('验证证据与当前制品不一致（内容已变更或未验证），拒绝上线')
      }
      await this._verifyArtifacts(v)
    }
    await dao.run(`UPDATE tool_versions SET status=? WHERE id=?`, [to, versionId])
    if (to === 'verified') {
      await dao.run(`UPDATE tool_versions SET verified_content_hash=?, verified_verifier=? WHERE id=?`,
        [v.contentHash, verifier || 'unknown', versionId])
    }
    if (to === 'stable') {
      // active 切换失败必须回滚状态，避免“版本已 stable 但未真正上线”的不一致
      try { await dao.run(`UPDATE tools SET active_version_id=? WHERE id=?`, [versionId, v.tool_id]) }
      catch (e) {
        try { await dao.run(`UPDATE tool_versions SET status=? WHERE id=?`, [v.status, versionId]) } catch { /* noop */ }
        throw new Error(`切换 active 失败，已回滚版本状态：${e?.message || e}`)
      }
    }
    if (actor) await this._recordApproval(versionId, actor, to, reason)
    return { ...v, status: to }
  }

  /** 公开入口：校验某版本（{manifest,semver,contentHash}）磁盘制品完整性 */
  async verifyArtifacts(v) { return this._verifyArtifacts(v) }

  /** 校验磁盘制品与 DB 记录的内容哈希一致（篡改/半写入 → 抛错，拒激活/调用） */
  async _verifyArtifacts(v) {
    if (!v.contentHash) throw new Error('版本缺少内容哈希')
    let manifest, source, tests
    try {
      const dir = path.join(this.artifactsDir, v.manifest.name, v.semver)
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
      source = fs.readFileSync(path.join(dir, 'index.js'), 'utf8')
      tests = JSON.parse(fs.readFileSync(path.join(dir, 'tests.json'), 'utf8'))
    } catch (e) {
      throw new Error(`工具制品缺失或损坏（${v.manifest.name}@${v.semver}）：${e?.message || e}`)
    }
    const h = contentHashOf({ source, manifest, tests })
    if (h !== v.contentHash) throw new Error(`工具制品内容哈希不匹配（${v.manifest.name}@${v.semver} 已被篡改或半写入），拒绝使用`)
    return true
  }

  /**
   * 显式切换工具的 active 版本（回滚 / 切换上线版本，审计 §4.1）。
   * 仅 stable 版本可设为 active，且必须内容哈希一致 + 制品完整；记审计。
   */
  async setActiveVersion(toolId, versionId, { actor, reason } = {}) {
    const v = await this.getVersion(versionId)
    if (!v) throw new Error('版本不存在')
    if (v.tool_id !== toolId) throw new Error('版本不属于该工具')
    if (v.status !== 'stable') throw new Error('仅 stable 版本可设为 active（回滚目标须是已上线版本）')
    await this._verifyArtifacts(v)
    await dao.run(`UPDATE tools SET active_version_id=? WHERE id=?`, [versionId, toolId])
    if (actor) await this._recordApproval(versionId, actor, 'rollback', reason)
    return { toolId, activeVersionId: versionId }
  }

  async _recordApproval(versionId, actor, decision, reason) {
    const id = 'ap_' + crypto.randomBytes(6).toString('hex')
    await dao.run(`INSERT INTO approval_records(id,version_id,actor,scope,decision,reason,created_at) VALUES(?,?,?,?,?,?,?)`,
      [id, versionId, actor, 'toolEvo', decision, reason || null, Date.now()])
  }

  /** 每工具的 active stable 版本（供注入 ToolRegistry），带 source/contentHash 供隔离执行 */
  async listStable() {
    const rows = await dao.all(
      `SELECT tv.id AS version_id, tv.tool_id, tv.semver, tv.manifest_json, tv.source_text, tv.source_hash, tv.content_hash, t.name
       FROM tools t JOIN tool_versions tv ON tv.id = t.active_version_id
       WHERE tv.status='stable'`,
    )
    return rows.map((r) => ({
      versionId: r.version_id, toolId: r.tool_id, name: r.name, semver: r.semver,
      manifest: JSON.parse(r.manifest_json), source: r.source_text || '',
      sourceHash: r.source_hash || null, contentHash: r.content_hash || null,
    }))
  }

  /**
   * 导出为 ToolRegistry 契约。execute 经隔离 runner 调用（审计 §4.2 / P0-1）：
   * stable 不在主进程 import；runner 由 apps 注入，未注入一律拒绝执行（fail-closed）。
   * 调用时把不可变 source 与内容哈希交给 runner；runner 先校验宿主制品文件哈希再执行 DB 字节，
   * 避免“校验后重新读取”的竞态（审计 P1-7）。
   */
  async toToolContract(stable, runner) {
    const dir = path.join(this.artifactsDir, stable.manifest.name, stable.semver)
    const artifactPath = pathToFileURL(path.join(dir, 'index.js')).href
    const artifactRel = path.join(stable.manifest.name, stable.semver, 'index.js')
    const versionId = stable.versionId
    const meta = {
      toolEvoVersionId: versionId,
      provenance: 'evolved',
      sideEffects: stable.manifest.permissions?.sideEffects || ['none'],
    }
    const base = {
      name: stable.manifest.name,
      description: stable.manifest.description,
      parameters: stable.manifest.inputSchema,
      category: stable.manifest.category || 'query',
      meta,
    }
    if (runner) {
      return {
        ...base,
        async execute(params, ctx) {
          const r = await runner.invoke(versionId, {
            source: stable.source,
            artifactPath,
            artifactRel,
            expectedHash: stable.sourceHash || null, // 制品文件内容=source，按 source_hash 校验
            params,
          }, { signal: ctx?.signal, taskId: ctx?.taskId })
          if (!r.ok) {
            const err = new Error(r.error || '进化工具执行失败')
            if (r.errorClass) err.errorClass = r.errorClass
            throw err
          }
          return r.output
        },
      }
    }
    return {
      ...base,
      async execute() {
        throw new Error(`进化工具「${stable.manifest.name}@${stable.semver}」当前不可用：隔离执行面未就绪（toolEvo runner 未注入）。已拒绝在主进程执行。`)
      },
    }
  }
}

export default ToolEvoRegistry
