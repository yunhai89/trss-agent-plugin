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
      fields: [{ path: '/', keyword: 'schema', message: '工具参数 schema 无法编译（工具契约错误）' }],
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
