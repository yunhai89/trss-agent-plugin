/**
 * 工具参数 schema 校验（P0-2 统一执行门的一部分）。
 *
 * 复用仓库既有 ajv 依赖（与 toolEvo/manifest.js 同源），在工具真正执行、审批之前校验：
 *   - 必填缺失、类型错误、枚举越界、多余参数（additionalProperties:false）→ 结构化错误返回给模型；
 *   - 不静默修改模型参数（useDefaults=false，不 coerce）；
 *   - schema 存在却无法编译 → **fail-closed**（code=schema_invalid，不静默放行）；
 *   - 每个 schema 仅编译一次（按 name + schema 序列化缓存）。
 *
 * 方言（关键）：Ajv 默认实例只认 draft-07。MCP 2025-06-18 起默认方言为 JSON Schema 2020-12，
 * Zod4/FastMCP 系服务端常原样带 `$schema`，用默认实例编译会直接抛错 → 合法工具被判「无法编译」
 * 而永久不可调用。这里按 `$schema` 分派 draft-07 / 2019-09 / 2020-12 实例；
 * 仍编译失败时退一步做「宽松化」（剥离 $schema、把远程 $ref 换成 {}）再试一次。
 */
import Ajv from 'ajv'
import Ajv2019 from 'ajv/dist/2019.js'
import Ajv2020 from 'ajv/dist/2020.js'

const AJV_OPTS = { allErrors: true, strict: false, allowUnionTypes: true, useDefaults: false, coerceTypes: false }
const ajvDraft7 = new Ajv(AJV_OPTS)
const ajv2019 = new Ajv2019(AJV_OPTS)
const ajv2020 = new Ajv2020(AJV_OPTS)

/** 按 $schema 选实例（未知/缺省 → draft-07，保持旧行为） */
function ajvFor(schema) {
  const d = String(schema?.$schema || '')
  if (/2020-12/.test(d)) return ajv2020
  if (/2019-09/.test(d)) return ajv2019
  return ajvDraft7
}

/**
 * 宽松化：剥离 $schema（方言已由实例决定）并把**远程** $ref 换成 {}（接受任意值）。
 * 本地引用（#/...）保留。返回 null 表示无需宽松化。
 */
function relaxSchema(schema) {
  let changed = false
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 12) return v
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1))
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      if (k === '$schema') { changed = true; continue }
      if (k === '$ref' && typeof val === 'string' && !val.startsWith('#')) { changed = true; out[k] = undefined; delete out[k]; continue }
      out[k] = walk(val, depth + 1)
    }
    if (out.$ref === undefined && v.$ref !== undefined && !String(v.$ref).startsWith('#')) { changed = true; delete out.$ref }
    return out
  }
  const relaxed = walk(schema, 0)
  return changed ? relaxed : null
}

const compiled = new Map() // key(name|schemaJSON) -> validator | null（null=编译失败）
const warned = new Set() // 编译失败只告警一次（每个工具）

function keyOf(tool) {
  try { return `${tool?.name}|${JSON.stringify(tool?.parameters)}` } catch { return null }
}

function validatorFor(tool) {
  const key = keyOf(tool)
  if (key && compiled.has(key)) return compiled.get(key)
  const schema = tool?.parameters
  let fn = null
  try {
    fn = ajvFor(schema).compile(schema)
  } catch {
    const relaxed = relaxSchema(schema)
    if (relaxed) {
      try { fn = ajvFor(relaxed).compile(relaxed) } catch { fn = null }
    }
  }
  if (!fn && key && !warned.has(key)) {
    warned.add(key)
    // 不引入 Log 依赖（库保持零依赖）：交由调用方在结构化错误里呈现
    try { tool?.meta?.logger?.('warn', `[tool-schema] ${tool?.name} 的参数 schema 无法编译，该工具在开启校验时不可调用`) } catch { /* noop */ }
  }
  if (key) compiled.set(key, fn)
  return fn
}

/**
 * @returns {{ ok: true } | { ok: false, code?: string, fields: Array<{path:string,keyword:string,message:string}> }}
 */
export function validateToolArgs(tool, args) {
  const schema = tool?.parameters
  if (!schema || typeof schema !== 'object') return { ok: true } // 无 schema：显式放行（旧工具兼容模式）
  // 顶层合约要求 JSON 对象；校验「实际执行的同一个值」，不再把数组/原始类型偷偷换成 {}
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      ok: false,
      code: 'invalid_arguments',
      fields: [{ path: '/', keyword: 'type', message: `参数必须是 JSON 对象（收到 ${Array.isArray(args) ? 'array' : typeof args}）` }],
    }
  }
  const validate = validatorFor(tool)
  if (!validate) {
    // schema 存在但无法编译 → 工具契约错误，fail-closed（不静默放行）
    return {
      ok: false,
      code: 'schema_invalid',
      fields: [{ path: '/', keyword: 'schema', message: '工具参数 schema 无法编译（工具契约错误）——该工具在当前环境下不可调用，请更换工具或修正其 schema' }],
    }
  }
  if (validate(args)) return { ok: true }
  const fields = (validate.errors || []).slice(0, 8).map((e) => ({
    path: e.instancePath || '/',
    keyword: e.keyword,
    message: e.message || '',
  }))
  return { ok: false, code: 'invalid_arguments', fields }
}
