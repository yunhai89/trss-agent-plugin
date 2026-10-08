/**
 * 工具参数 schema 校验（P0-2 统一执行门的一部分）。
 *
 * 复用仓库既有 ajv 依赖（与 toolEvo/manifest.js 同源），在工具真正执行、审批之前校验：
 *   - 必填缺失、类型错误、枚举越界、多余参数（additionalProperties:false）→ 结构化错误返回给模型；
 *   - 不静默修改模型参数（useDefaults=false，不 coerce）；
 *   - schema 无法编译的对象类型 schema 不阻断执行（结构由工具自身兜底），只记录一次；
 *   - 每个 schema 仅编译一次（按 name + schema 序列化缓存）。
 *
 * 车间刻意保守：只校验 type==='object' 的 schema；无 schema 的工具直接放行。
 */
import Ajv from 'ajv'

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true, useDefaults: false, coerceTypes: false })

const compiled = new Map() // key(name|schemaJSON) -> validator | null（null=编译失败，跳过校验）

function keyOf(tool) {
  try { return `${tool?.name}|${JSON.stringify(tool?.parameters)}` } catch { return null }
}

function validatorFor(tool) {
  const key = keyOf(tool)
  if (key && compiled.has(key)) return compiled.get(key)
  let fn = null
  try { fn = ajv.compile(tool.parameters) } catch { fn = null }
  if (key) compiled.set(key, fn)
  return fn
}

/**
 * @returns {{ ok: true } | { ok: false, fields: Array<{path:string,keyword:string,message:string}> }}
 */
export function validateToolArgs(tool, args) {
  const schema = tool?.parameters
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') return { ok: true }
  const validate = validatorFor(tool)
  if (!validate) return { ok: true } // schema 编译失败：不阻断（工具自身仍需兜底）
  const payload = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {}
  if (validate(payload)) return { ok: true }
  const fields = (validate.errors || []).slice(0, 8).map((e) => ({
    path: e.instancePath || '/',
    keyword: e.keyword,
    message: e.message || '',
  }))
  return { ok: false, fields }
}
