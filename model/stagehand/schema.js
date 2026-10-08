/**
 * JSON Schema → Zod 4 schema（Stagehand.extract 专用）。
 *
 * 为什么需要独立模块：
 *  - Stagehand 4 内部用自带 Zod 4 调 `z.toJSONSchema(zodSchema)` 序列化抽取 schema；
 *    传根依赖的 Zod 3 实例会在 `_zod.def` 处抛
 *    "Cannot read properties of undefined (reading 'def')"。
 *  - 因此必须产出 **Zod 4** schema。依赖别名 zod-stagehand 固定 4.4.3，
 *    与 @browserbasehq/stagehand 4.0.0 内置版本一致，避免全仓升级 Zod 3。
 *
 * 转换策略：
 *  - 优先用 Zod 4 官方 `z.fromJSONSchema`（官方 JSON Schema 转换器），保留
 *    integer / enum / const / nullable / required / 数组 / 数值与字符串边界等语义；
 *  - 转换前做体积 / 深度 / 节点数限制，防超大或深递归 schema 拖垮进程；
 *  - 未知 type、`$ref`、`not` 等官方不支持的结构由 fromJSONSchema 抛错，
 *    这里统一包成可读错误；不静默退化成 z.unknown() 丢掉约束；
 *  - 转换后做一次关键约束保留性校验，官方转换器若静默丢弃已声明约束则明确报错。
 *
 * 依赖解析（防"未装可选依赖导致插件整体加载失败"）：
 *  - 首选声明的别名依赖 `zod-stagehand`（npm:zod@4.4.3，随 pnpm install 装入）；
 *  - 回退复用 `@browserbasehq/stagehand` 自带的同版本 Zod 4（其本身必装）；
 *  - 两者都不可用时才在 extract 调用时报可读错误，不影响插件启动。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

let _z4 = null
let _z4Tried = false
/** 懒加载 Zod 4 命名空间（同步）：zod-stagehand → stagehand 自带 zod。 */
function zod4() {
  if (_z4Tried) return _z4
  _z4Tried = true
  try {
    const m = require('zod-stagehand')
    _z4 = m?.fromJSONSchema ? m : (m?.default || m)
    if (typeof _z4?.fromJSONSchema === 'function') return _z4
  } catch { /* 回退 */ }
  try {
    const resolved = import.meta.resolve('@browserbasehq/stagehand')
    const pkgDir = path.dirname(path.dirname(fileURLToPath(resolved)))
    const req2 = createRequire(path.join(pkgDir, 'noop.js'))
    const m = req2('zod')
    const z = m?.fromJSONSchema ? m : (m?.default || m)
    if (typeof z?.fromJSONSchema === 'function') { _z4 = z; return _z4 }
  } catch { /* 都失败 */ }
  _z4 = null
  return null
}

/** 输入 schema 序列化后的字节上限（约 64KB，远超正常抽取需求） */
export const MAX_SCHEMA_BYTES = 64 * 1024
/** 最大嵌套深度 */
export const MAX_SCHEMA_DEPTH = 12
/** 最大节点总数（object/array/标量 schema 计 1） */
export const MAX_SCHEMA_NODES = 2000
/** 单个 object 的 properties 数量上限 */
export const MAX_SCHEMA_KEYS = 200

const UNSUPPORTED_KEYS = new Set(['$ref', '$dynamicRef', '$defs', 'definitions', 'not', 'if', 'then', 'else', 'dependencies', 'dependentSchemas', 'patternProperties', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems'])

/**
 * JSON Schema → Zod 4 schema。
 * @param {object} schema JSON Schema（模型生成的抽取结构）
 * @param {object} [opts] 限制覆盖（测试用）
 * @returns {import('zod-stagehand').ZodType} Zod 4 schema（带 safeParse / parse）
 * @throws {Error} schema 非法、超限或含不支持结构时明确抛错
 */
export function jsonSchemaToZod(schema, opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_SCHEMA_BYTES
  const maxDepth = opts.maxDepth ?? MAX_SCHEMA_DEPTH
  const maxNodes = opts.maxNodes ?? MAX_SCHEMA_NODES
  const maxKeys = opts.maxKeys ?? MAX_SCHEMA_KEYS

  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('schema 必须是 JSON 对象')
  }
  let raw
  try { raw = JSON.stringify(schema) } catch { throw new Error('schema 无法序列化（含循环引用或非法值）') }
  if (raw.length > maxBytes) throw new Error(`schema 过大（${raw.length} 字节，上限 ${maxBytes}）`)

  const budget = { nodes: 0 }
  validate(schema, 0, { maxDepth, maxNodes, maxKeys, budget })

  const z = zod4()
  if (!z) throw new Error('缺少 Zod 4（stagehand extract 需要）：请在云崽根目录执行 pnpm install（或 pnpm add zod-stagehand）')
  let zodSchema
  try {
    zodSchema = z.fromJSONSchema(schema)
  } catch (e) {
    throw new Error(`不支持的 schema：${e?.message || e}`)
  }
  if (!zodSchema || typeof zodSchema.safeParse !== 'function') {
    throw new Error('schema 转换失败（未产出可校验的 Zod schema）')
  }
  // 官方转换器对已声明关键约束应保留；若被静默丢弃则明确报错，避免"看起来成功但约束没了"
  assertPreserved(schema, zodSchema)
  return zodSchema
}

function validate(node, depth, { maxDepth, maxNodes, maxKeys, budget }) {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const it of node) validate(it, depth, { maxDepth, maxNodes, maxKeys, budget }); return }
  budget.nodes++
  if (budget.nodes > maxNodes) throw new Error(`schema 节点过多（上限 ${maxNodes}）`)
  if (depth > maxDepth) throw new Error(`schema 嵌套过深（上限 ${maxDepth} 层）`)
  for (const key of Object.keys(node)) {
    if (UNSUPPORTED_KEYS.has(key)) throw new Error(`schema 含不支持的关键字：${key}`)
  }
  const props = node.properties
  if (props && typeof props === 'object') {
    const keys = Object.keys(props)
    if (keys.length > maxKeys) throw new Error(`schema 单个对象属性过多（上限 ${maxKeys}）`)
    for (const k of keys) validate(props[k], depth + 1, { maxDepth, maxNodes, maxKeys, budget })
  }
  if (node.items) validate(node.items, depth + 1, { maxDepth, maxNodes, maxKeys, budget })
  if (node.prefixItems) validate(node.prefixItems, depth + 1, { maxDepth, maxNodes, maxKeys, budget })
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(node[key])) for (const it of node[key]) validate(it, depth + 1, { maxDepth, maxNodes, maxKeys, budget })
  }
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    validate(node.additionalProperties, depth + 1, { maxDepth, maxNodes, maxKeys, budget })
  }
}

/** 归一化 type：字符串或字符串数组（含 null 表示 nullable）；并展开 anyOf/oneOf 分支的 type */
function typeOf(node) {
  if (!node) return []
  const out = []
  const t = node.type
  if (typeof t === 'string') out.push(t)
  else if (Array.isArray(t)) out.push(...t.map(String))
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(node[key])) {
      for (const branch of node[key]) out.push(...typeOf(branch))
    }
  }
  return [...new Set(out)]
}

/**
 * 关键约束保留性校验：遍历输入 schema，逐项确认官方转换器产出的 JSON Schema
 * 仍带有所声明的 type/enum/const/required/nullable/数组项/数值与字符串边界。
 * 校验基于 `z4.toJSONSchema` 的往返结果，不要求逐字节相等，只盯"约束是否还在"。
 */
function assertPreserved(input, zodSchema) {
  let out
  try { out = zod4()?.toJSONSchema(zodSchema) } catch { return } // 无法往返则不做该断言（fromJSONSchema 已通过）
  walk(input, out, (inNode, outNode, where) => {
    const want = typeOf(inNode)
    if (want.length) {
      const got = typeOf(outNode)
      for (const t of want) {
        if (t === 'null') continue // nullable 在输出可能以 anyOf 表达，下面单独看
        if (!got.includes(t)) throw new Error(`不支持的 schema（约束丢失：${where} type=${t}）`)
      }
    }
    if (Array.isArray(inNode.enum) && JSON.stringify(inNode.enum) !== JSON.stringify(outNode?.enum)) {
      throw new Error(`不支持的 schema（约束丢失：${where} enum）`)
    }
    if (inNode.const !== undefined && JSON.stringify(inNode.const) !== JSON.stringify(outNode?.const)) {
      throw new Error(`不支持的 schema（约束丢失：${where} const）`)
    }
    if (Array.isArray(inNode.required)) {
      const got = Array.isArray(outNode?.required) ? [...outNode.required].sort() : null
      const want = [...inNode.required].map(String).sort()
      if (!got || JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`不支持的 schema（约束丢失：${where} required）`)
    }
    if (typeOf(inNode).includes('null') || hasNullAnyOf(inNode)) {
      if (!nullableInOutput(outNode)) throw new Error(`不支持的 schema（约束丢失：${where} nullable）`)
    }
    for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (inNode[k] !== undefined && outNode?.[k] !== inNode[k]) throw new Error(`不支持的 schema（约束丢失：${where} ${k}）`)
    }
  })
}

function hasNullAnyOf(node) {
  return Array.isArray(node?.anyOf) && node.anyOf.some((x) => typeOf(x).includes('null'))
}

function nullableInOutput(out) {
  if (!out) return false
  if (typeOf(out).includes('null')) return true
  if (Array.isArray(out.anyOf) && out.anyOf.some((x) => typeOf(x).includes('null'))) return true
  return false
}

/** 同步遍历输入/输出 schema 树，对每个对应节点执行断言 */
function walk(inNode, outNode, assert) {
  if (!inNode || typeof inNode !== 'object' || Array.isArray(inNode)) return
  assert(inNode, outNode, describe(inNode))
  const inProps = inNode.properties
  if (inProps && typeof inProps === 'object') {
    for (const [k, v] of Object.entries(inProps)) walk(v, outNode?.properties?.[k], assert)
  }
  if (inNode.items) walk(inNode.items, outNode?.items, assert)
  if (Array.isArray(inNode.prefixItems)) {
    inNode.prefixItems.forEach((v, i) => walk(v, outNode?.prefixItems?.[i], assert))
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(inNode[key]) && Array.isArray(outNode?.[key])) {
      inNode[key].forEach((v, i) => walk(v, outNode[key][i], assert))
    }
  }
}

function describe(node) {
  if (node.title) return `title=${node.title}`
  const t = typeOf(node).join('|') || 'unknown'
  return `type=${t}`
}
