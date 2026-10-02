/**
 * Tool Manifest 结构 + ajv 校验（开发文档 §10，JS 版）。
 *
 * schema 允许全部副作用类型（兼容 provenance=human 的内置工具，如 web/network、terminal/write 入库）；
 * 但「自动生成」的候选由 isGenerationAllowed() 把关——第一版只允许 sideEffects ∈ {none, read}（§4.3 两层：
 * qq.send/kick/删库等固定受信适配器永不自动生成）。
 */
import Ajv from 'ajv'

const SEMVER_RE = /^\d+\.\d+\.\d+$/
const NAME_RE = /^[a-z][a-z0-9_-]*$/
const STATUS = ['draft', 'rejected', 'verified', 'stable', 'quarantined', 'deprecated']
const SIDE_EFFECTS = ['none', 'read', 'write', 'network', 'message', 'delete']

const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['name', 'version', 'status', 'description', 'inputSchema', 'permissions'],
  properties: {
    name: { type: 'string', pattern: NAME_RE.source },
    version: { type: 'string', pattern: SEMVER_RE.source },
    status: { enum: STATUS },
    category: { enum: ['query', 'personal', 'message', 'group_manage', 'system'] },
    description: { type: 'string', minLength: 6 },
    useWhen: { type: 'array', items: { type: 'string' } },
    doNotUseWhen: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    entrypoint: { type: 'string', default: 'index.js' },
    runtime: {
      type: 'object',
      properties: {
        kind: { enum: ['node'] },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 30000 },
        memoryMb: { type: 'integer', minimum: 16, maximum: 512 },
        cpuQuota: { type: 'number' },
      },
    },
    permissions: {
      type: 'object',
      required: ['sideEffects', 'network'],
      properties: {
        sideEffects: { type: 'array', items: { enum: SIDE_EFFECTS }, minItems: 1 },
        network: {
          type: 'object',
          properties: {
            mode: { enum: ['deny', 'allowlist'] },
            hosts: { type: 'array', items: { type: 'string' } },
          },
        },
        filesystem: {
          type: 'object',
          properties: {
            read: { type: 'array', items: { type: 'string' } },
            write: { type: 'array', items: { type: 'string' } },
          },
        },
        secrets: { type: 'array', items: { type: 'string' } },
      },
    },
    provenance: {
      type: 'object',
      properties: {
        kind: { enum: ['human', 'generated', 'refined', 'imported'] },
        parentVersionId: { type: 'string' },
        sourceTaskHash: { type: 'string' },
        generatorModel: { type: 'string' },
        createdAt: { type: 'string' },
      },
    },
  },
}

let _validate = null
function validate() {
  if (!_validate) {
    const ajv = new Ajv({ allErrors: true, useDefaults: true })
    _validate = ajv.compile(MANIFEST_SCHEMA)
  }
  return _validate
}

/** 校验 manifest 结构，返回 { ok, errors[] } */
export function validateManifest(m) {
  const fn = validate()
  const ok = !!fn(m)
  return { ok, errors: ok ? [] : (fn.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`) }
}

/**
 * 生成候选安全闸（审计 P1-2）：sideEffects 仅 none/read，且不得声明任何额外能力
 * （network 必须 deny、filesystem 必须为空、secrets 必须为空）。固定受信适配器永不自动生成。
 * @returns {string[]} 违规项（空数组 = 通过）
 */
export function generationPermissionViolations(m) {
  const v = []
  const perm = m?.permissions || {}
  const se = perm.sideEffects
  if (!Array.isArray(se) || se.length === 0 || !se.every((s) => s === 'none' || s === 'read')) {
    v.push('sideEffects 仅允许 none/read')
  }
  const net = perm.network || {}
  if (net.mode && net.mode !== 'deny') v.push('network.mode 仅允许 deny')
  if (Array.isArray(net.hosts) && net.hosts.length) v.push('不允许声明 network.hosts')
  const fsperm = perm.filesystem || {}
  if ((fsperm.read || []).length || (fsperm.write || []).length) v.push('不允许声明 filesystem 访问')
  if ((perm.secrets || []).length) v.push('不允许声明 secrets')
  return v
}

/** 生成候选安全闸：只允许 sideEffects ∈ {none, read} 且无额外能力声明 */
export function isGenerationAllowed(m) {
  return generationPermissionViolations(m).length === 0
}

/**
 * 构造 manifest（补默认值）。permissions/runtime/provenance 做**深合并**：
 * 候选只声明 sideEffects 时，network/filesystem/secrets 仍取受信默认（deny/空），
 * 绝不会因浅层展开被不完整的 LLM 输出覆盖（审计 P1-2）。
 */
export function makeManifest(partial = {}) {
  const p = partial || {}
  const perm = p.permissions || {}
  const runtime = p.runtime || {}
  const prov = p.provenance || {}
  const out = { ...p }
  out.version = typeof p.version === 'string' ? p.version : '0.1.0'
  out.status = p.status || 'draft'
  out.category = p.category || 'query'
  out.description = typeof p.description === 'string' ? p.description : ''
  out.useWhen = Array.isArray(p.useWhen) ? p.useWhen : []
  out.doNotUseWhen = Array.isArray(p.doNotUseWhen) ? p.doNotUseWhen : []
  out.tags = Array.isArray(p.tags) ? p.tags : []
  out.inputSchema = (p.inputSchema && typeof p.inputSchema === 'object') ? p.inputSchema : { type: 'object', properties: {} }
  out.entrypoint = p.entrypoint || 'index.js'
  out.runtime = { kind: 'node', timeoutMs: 3000, memoryMb: 128, cpuQuota: 0.5, ...runtime }
  out.permissions = {
    sideEffects: Array.isArray(perm.sideEffects) && perm.sideEffects.length ? perm.sideEffects : ['none'],
    network: { mode: 'deny', hosts: [], ...(perm.network || {}) },
    filesystem: { read: [], write: [], ...(perm.filesystem || {}) },
    secrets: Array.isArray(perm.secrets) ? perm.secrets : [],
  }
  out.provenance = { kind: 'generated', createdAt: new Date().toISOString(), ...prov }
  return out
}

export { NAME_RE, SEMVER_RE }
