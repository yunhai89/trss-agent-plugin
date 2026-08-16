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

/** 生成候选安全闸：只允许 sideEffects ∈ {none, read}（固定受信适配器永不自动生成） */
export function isGenerationAllowed(m) {
  const se = m?.permissions?.sideEffects || []
  return se.length > 0 && se.every((s) => s === 'none' || s === 'read')
}

/** 构造一个 manifest（补默认值） */
export function makeManifest(partial) {
  return {
    version: '0.1.0',
    status: 'draft',
    category: 'query',
    description: '',
    useWhen: [],
    doNotUseWhen: [],
    tags: [],
    entrypoint: 'index.js',
    runtime: { kind: 'node', timeoutMs: 3000, memoryMb: 128, cpuQuota: 0.5 },
    permissions: { sideEffects: ['none'], network: { mode: 'deny', hosts: [] }, filesystem: { read: [], write: [] }, secrets: [] },
    provenance: { kind: 'generated', createdAt: new Date().toISOString() },
    ...partial,
  }
}

export { NAME_RE, SEMVER_RE }
