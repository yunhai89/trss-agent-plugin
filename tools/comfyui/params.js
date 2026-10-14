/**
 * 参数注入：把模型给的友好参数写进工作流的 API 图（落点来自 analyzeGraph 的 params 映射）。
 *
 * 约定：
 *  - 未传的参数保留工作流默认值（不覆盖）；
 *  - 工作流没有对应参数时静默跳过并记入 report.skipped（由工具回传给模型，便于改用 set）；
 *  - seed 留空/负数 → 随机（记 seedUsed 回传，方便复现）；
 *  - set: [{node, field, value}] 兜底覆盖任意节点字段（字段必须已存在于该节点输入）。
 */

/** 数值字段归一（按 API 字段名判断整数/浮点） */
const INT_FIELDS = new Set(['seed', 'noise_seed', 'steps', 'width', 'height', 'batch_size', 'length', 'frame_rate', 'tile_size'])
const FLOAT_FIELDS = new Set(['cfg', 'denoise', 'upscale_by', 'guide_size', 'max_size', 'strength'])

function coerce(field, v) {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v
  if (typeof v !== 'string') return v
  if (INT_FIELDS.has(field)) {
    const n = Number(v)
    return Number.isFinite(n) ? Math.round(n) : v
  }
  if (FLOAT_FIELDS.has(field)) {
    const n = Number(v)
    return Number.isFinite(n) ? n : v
  }
  return v
}

function randomSeed() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
}

/** 控制类参数（不是工作流字段，由 execute 处理） */
const CONTROL_KEYS = new Set(['workflow', 'timeout', 'send_images', 'input_image', 'mask_image', 'refresh', 'raw'])

/**
 * @param {object} graph API 图（原地修改）
 * @param {object} analysis analyzeGraph 结果
 * @param {object} overrides 模型给的参数
 * @param {object} opts { uploaded?: { image?:{name}, mask?:{name} } }
 * @returns {{ok:true, applied:string[], skipped:{key:string,reason:string}[], seedUsed:number|null}
 *          |{ok:false, error:string}}
 */
export function applyParams(graph, analysis, overrides = {}, opts = {}) {
  const map = analysis?.params || {}
  const applied = []
  const skipped = []
  let seedUsed = null

  const setField = (key, nodeId, field, value) => {
    const node = graph[String(nodeId)]
    if (!node || typeof node !== 'object' || !node.inputs) return { error: `节点 ${nodeId} 不存在（参数 ${key}）` }
    node.inputs[field] = coerce(field, value)
    applied.push(key)
    return true
  }

  // 1) 友好参数
  for (const [key, val] of Object.entries(overrides)) {
    if (CONTROL_KEYS.has(key) || key === 'set') continue
    if (val == null || val === '') continue
    const m = map[key]
    if (!m) { skipped.push({ key, reason: '该工作流未识别到此参数（可用 set 指定节点字段）' }); continue }

    if (key === 'seed') {
      const n = Number(val)
      seedUsed = Number.isFinite(n) && n >= 0 ? n : randomSeed()
      const r = setField('seed', m.node, m.field, seedUsed)
      if (r?.error) return { ok: false, error: r.error }
      continue
    }
    const r = setField(key, m.node, m.field, val)
    if (r?.error) return { ok: false, error: r.error }
  }

  // 2) 输入图 / 蒙版（值=上传后服务器返回的文件名）
  if (map.input_image) {
    const name = opts.uploaded?.image?.name
    if (name) {
      const r = setField('input_image', map.input_image.node, map.input_image.field, name)
      if (r?.error) return { ok: false, error: r.error }
    }
  }
  if (map.mask_image) {
    const name = opts.uploaded?.mask?.name
    if (name) {
      const r = setField('mask_image', map.mask_image.node, map.mask_image.field, name)
      if (r?.error) return { ok: false, error: r.error }
    }
  }

  // 3) seed 未传但工作流有 → 随机一个写入（保证可复现）
  if (seedUsed == null && map.seed) {
    seedUsed = randomSeed()
    const r = setField('seed', map.seed.node, map.seed.field, seedUsed)
    if (r?.error) return { ok: false, error: r.error }
  }

  // 4) 显式 set 覆盖
  for (const item of Array.isArray(overrides.set) ? overrides.set : []) {
    const nodeId = String(item?.node ?? '')
    const field = String(item?.field ?? '')
    if (!nodeId || !field) { skipped.push({ key: `set:${nodeId}.${field}`, reason: '需要 node/field/value' }); continue }
    const node = graph[nodeId]
    if (!node?.inputs) { skipped.push({ key: `set:${nodeId}.${field}`, reason: `节点 ${nodeId} 不存在` }); continue }
    if (!(field in node.inputs)) { skipped.push({ key: `set:${nodeId}.${field}`, reason: `节点 ${nodeId}(${node.class_type}) 没有输入字段 ${field}` }); continue }
    node.inputs[field] = coerce(field, item.value)
    applied.push(`set:${nodeId}.${field}`)
  }

  return { ok: true, applied, skipped, seedUsed }
}
