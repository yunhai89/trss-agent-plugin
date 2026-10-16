/**
 * 工作流执行内核 —— LLM 工具（tools/comfyui/index.js）与指令插件（apps/comfyui-draw.js）
 * 共用同一条执行链，避免两套逻辑分叉：
 *
 *   发现/解析（discover）→ 转换（convert）→ 分析（analyze）→ 输入图上传
 *   → 参数注入（params）→ 提交 /prompt → 轮询 → 下载产物（返回 buffer）
 *
 * 本模块不负责「发送」（工具走 ctx.e.reply，指令插件走 e.reply），也不读 ctx。
 */
import {
  listWorkflowFiles, loadWorkflow, resolveWorkflowRef, getObjectInfo, DEFAULT_WORKFLOW_DIR,
} from './discover.js'

/** 从 object_info 的 loader 节点选项里取「服务器上已安装的模型」（存在性检查用） */
export function availableModels(objectInfo) {
  const optsOf = (cls, field) => {
    const spec = objectInfo?.[cls]?.input?.required?.[field] || objectInfo?.[cls]?.input?.optional?.[field]
    if (!spec) return []
    const t = spec[0]
    if (Array.isArray(t)) return t.map(String)
    // 新版本把 COMBO 选项放在第二项 { options: [...] }（如 UpscaleModelLoader.model_name）
    if (spec[1] && Array.isArray(spec[1].options)) return spec[1].options.map(String)
    return []
  }
  return {
    checkpoints: optsOf('CheckpointLoaderSimple', 'ckpt_name'),
    unet: optsOf('UNETLoader', 'unet_name'),
    vae: optsOf('VAELoader', 'vae_name'),
    upscale: optsOf('UpscaleModelLoader', 'model_name'),
    loras: optsOf('LoraLoader', 'lora_name'),
    // Impact 检测器权重（bbox/face/hand yolo）——选项来自 UltralyticsDetectorProvider，与 upscale 不同源
    detectors: optsOf('UltralyticsDetectorProvider', 'model_name'),
    controlnet: optsOf('ControlNetLoader', 'control_net_name'),
  }
}

/** 检查工作流引用模型是否存在（返回缺失清单；检查不了的类别跳过） */
export function missingModels(analysis, avail) {
  const out = []
  const check = (cat, list) => {
    const have = avail?.[cat]
    if (!Array.isArray(have) || !have.length) return
    for (const m of list || []) if (!have.includes(m)) out.push(`${cat}:${m}`)
  }
  check('checkpoints', analysis.models.checkpoints)
  check('unet', analysis.models.unet)
  check('vae', analysis.models.vae)
  check('upscale', analysis.models.upscale)
  check('loras', analysis.models.loras)
  check('detectors', analysis.models.detectors)
  check('controlnet', analysis.models.controlnet)
  return out
}

/** 加载工作流（缺节点包时刷新一次 object_info 再试：用户可能刚装了节点包，缓存还是旧的） */
export async function loadWorkflowSmart(api, entry, { ttl, objectInfo }) {
  let r = await loadWorkflow(api, entry, { ttl, objectInfo })
  if (!r.ok && r.missing?.length) {
    try {
      const fresh = await getObjectInfo(api, { ttl, refresh: true })
      r = await loadWorkflow(api, entry, { ttl, objectInfo: fresh })
    } catch { /* 保持原错误 */ }
  }
  return r
}

/** 工作流清单摘要（控制体积；list_workflows 工具与 #画图列表 共用同一份数据） */
export function summarizeWorkflow(entry, loaded, avail) {
  const a = loaded.analysis
  const missing = missingModels(a, avail)
  const noteText = (loaded.notes || []).map((n) => n.text).join(' ').replace(/\s+/g, ' ').slice(0, 160)
  const defPrompt = a.params.prompt ? String(loaded.graph?.[a.params.prompt.node]?.inputs?.[a.params.prompt.field] || '').replace(/\s+/g, ' ').slice(0, 80) : ''
  return {
    name: entry.name,
    path: entry.path,
    ...(entry.folder ? { folder: entry.folder } : {}),
    size: entry.size,
    modified: entry.modified,
    format: loaded.format,
    kinds: a.kinds,
    params: Object.keys(a.params),
    needs_input_image: !!a.params.input_image,
    ...(missing.length ? { missing_models: missing } : {}),
    ...(noteText ? { note: noteText } : {}),
    ...(defPrompt ? { default_prompt: defPrompt } : {}),
  }
}

/**
 * 发现 + 逐个分析（列表页/清单共用）。
 * @returns {{ok:true, dir, objectInfo, items, failed}|{ok:false, error}}
 *   items = summarizeWorkflow 的产物（摘要字段；选中后用 path 走 prepareWorkflow 拿图/分析）
 */
export async function listWorkflowsSummary({ api, dir = DEFAULT_WORKFLOW_DIR, ttl = 300, refresh = false } = {}) {
  let entries
  try { entries = await listWorkflowFiles(api, { dir, ttl, refresh }) } catch (e) {
    return { ok: false, error: `发现工作流失败：${e?.message || e}` }
  }
  let objectInfo = null
  try { objectInfo = await getObjectInfo(api, { ttl, refresh }) } catch { /* 老版本服务器/不可用：只给名字 */ }
  const avail = objectInfo ? availableModels(objectInfo) : null
  const items = []
  const failed = []
  for (const entry of entries) {
    if (!objectInfo) { items.push({ name: entry.name, path: entry.path, size: entry.size, modified: entry.modified, entry }); continue }
    const loaded = await loadWorkflowSmart(api, entry, { ttl, objectInfo })
    if (!loaded.ok) failed.push({ path: entry.path, error: loaded.error })
    else items.push(summarizeWorkflow(entry, loaded, avail))
  }
  return { ok: true, dir, objectInfo, items, failed }
}

/**
 * 发现 + 解析 + 转换 + 分析（执行前的准备）。
 * @param {object} o { api, ref, dir, ttl, refresh }
 * @returns {{ok:true, entries, entry, graph, analysis, titles, warnings, format}
 *          |{ok:false, error, candidates?, missing?}}
 */
export async function prepareWorkflow({ api, ref, dir = DEFAULT_WORKFLOW_DIR, ttl = 300, refresh = false } = {}) {
  let entries
  try { entries = await listWorkflowFiles(api, { dir, ttl, refresh }) } catch (e) {
    return { ok: false, error: `发现工作流失败：${e?.message || e}` }
  }
  const hit = resolveWorkflowRef(entries, ref)
  if (hit.error) return { ok: false, error: hit.error, candidates: hit.candidates }

  let objectInfo = null
  try { objectInfo = await getObjectInfo(api, { ttl, refresh }) } catch (e) {
    return { ok: false, error: `object_info 获取失败（转换前端格式工作流需要它）：${e?.message || e}` }
  }
  const loaded = await loadWorkflowSmart(api, hit.entry, { ttl, objectInfo })
  if (!loaded.ok) return { ok: false, error: `加载工作流失败：${loaded.error}`, missing: loaded.missing }
  return {
    ok: true,
    entries,
    entry: hit.entry,
    objectInfo,
    graph: loaded.graph,
    analysis: loaded.analysis,
    titles: loaded.titles,
    notes: loaded.notes || [],
    warnings: loaded.warnings || [],
    format: loaded.format,
  }
}

/**
 * 输入图 / 蒙版上传（工作流需要时）。
 * @param {object} o { api, analysis, image, mask } image/mask = { buffer, name } | null
 * @returns {{ok:true, uploaded}|{ok:false, error}}
 */
export async function uploadWorkflowInputs({ api, analysis, image, mask } = {}) {
  const uploaded = {}
  if (analysis.params.input_image) {
    if (!image?.buffer) return { ok: false, error: '该工作流需要输入图（input_image），但未提供或取不到。先发一张图/引用一张图，或给图片 URL' }
    try { uploaded.image = await api.uploadImage(image.buffer, image.name || 'input.png', 'input') }
    catch (e) { return { ok: false, error: `上传输入图失败：${e?.message || e}` } }
  }
  if (analysis.params.mask_image) {
    if (!mask?.buffer) return { ok: false, error: '该工作流需要蒙版图（mask_image），但未提供或取不到' }
    try {
      uploaded.mask = await api.uploadMask(mask.buffer, mask.name || 'mask.png', {
        filename: uploaded.image?.name || mask.name, subfolder: uploaded.image?.subfolder || '', type: 'input',
      })
    } catch (e) { return { ok: false, error: `上传蒙版失败：${e?.message || e}` } }
  }
  return { ok: true, uploaded }
}

/**
 * 计算每个节点在依赖链上的深度（0=源头；每经过一次上游 +1）。
 * 用于挑「最终成品」输出节点：多段式工作流（底图→修脸→修手→高清）里有多个 SaveImage，
 * 默认只发依赖链最深（最后一步）的那个，中间步骤图按需再发。
 */
export function nodeDepths(graph) {
  const ids = Object.keys(graph || {})
  const incoming = new Map(ids.map((id) => [id, new Set()]))
  for (const id of ids) {
    for (const v of Object.values(graph[id]?.inputs || {})) {
      if (Array.isArray(v) && v.length >= 2 && graph[String(v[0])]) incoming.get(id).add(String(v[0]))
    }
  }
  const depth = new Map()
  const calc = (id, stack = new Set()) => {
    if (depth.has(id)) return depth.get(id)
    if (stack.has(id)) return 0 // 环（异常图）：按 0 处理，不死循环
    stack.add(id)
    let d = 0
    for (const src of incoming.get(id) || []) d = Math.max(d, calc(src, stack) + 1)
    stack.delete(id)
    depth.set(id, d)
    return d
  }
  for (const id of ids) calc(id)
  return depth
}

/**
 * 挑「最终成品」输出节点 id（依赖链最深；同深度按节点出现顺序取最后一个）。
 * @returns {string|null} null = 无法判定（调用方应保留全部产物）
 */
export function finalOutputNodeId(graph) {
  const depth = nodeDepths(graph)
  let best = null
  let bestDepth = -1
  for (const id of Object.keys(graph || {})) {
    const d = depth.get(id) ?? 0
    if (d >= bestDepth) { best = id; bestDepth = d } // >=：同深度取靠后的
  }
  return best
}

/**
 * 提交 + 轮询 + 下载产物（返回 buffer 列表，由调用方决定怎么发）。
 * @returns {{ok:true, promptId, outputs:[{filename,subfolder,kind,buffer}]}
 *          |{ok:false, status:'submit'|'error'|'cancelled'|'timeout', error, nodeErrors?, promptId?, nodeId?}}
 */
export async function executeGraph({ api, graph, timeout = 300, interval = 1.5, maxInterval = 8, isVideo = false, maxImages = 4, allSteps = false, onProgress } = {}) {
  const clientId = globalThis.crypto?.randomUUID?.() || String(Date.now())
  let promptId
  try {
    const sub = await api.submit(graph, clientId)
    promptId = sub?.prompt_id
    if (!promptId) return { ok: false, status: 'submit', error: `提交未返回 prompt_id：${JSON.stringify(sub).slice(0, 300)}` }
  } catch (e) {
    return { ok: false, status: 'submit', error: e?.message || String(e), nodeErrors: e?.node_errors }
  }

  // 夹到 [1,1800]：负数/0 会让轮询 deadline 立刻过期 → 刚提交的 prompt 马上被判超时并 /interrupt
  const wait = Math.max(1, Math.min(Number(timeout) || (isVideo ? 900 : 300), 1800))
  const result = await api.pollStatus(promptId, { timeout: wait, interval, maxInterval, onProgress })
  if (result.status === 'error') return { ok: false, status: 'error', promptId, error: result.message || 'execution_error', nodeId: result.nodeId }
  if (result.status === 'cancelled') return { ok: false, status: 'cancelled', promptId, error: '任务被取消' }
  if (result.status === 'timeout') {
    api.interrupt().catch(() => {})
    return { ok: false, status: 'timeout', promptId, error: `超时（${wait}s）` }
  }

  // 默认只发「最终成品」：多段式工作流的中间步骤图（底图/修脸/修手…）过滤掉，allSteps=true 时全发
  const finalId = allSteps ? null : finalOutputNodeId(graph)
  const picked = (result.outputs || []).filter((o) => o.kind === 'text' || !finalId || String(o.nodeId) === String(finalId))
  const skippedSteps = (result.outputs || []).filter((o) => o.kind !== 'text' && finalId && String(o.nodeId) !== String(finalId))
  const outs = picked.slice(0, Math.max(1, Number(maxImages) || 4))
  const outputs = []
  const seenText = new Set()
  for (const out of outs) {
    // 文本产物（反推标签等）：无需下载；tagger 节点 + PreviewAny 常输出同一段 → 按内容去重
    if (out.kind === 'text') {
      if (seenText.has(out.text)) continue
      seenText.add(out.text)
      outputs.push({ kind: 'text', text: out.text, filename: null, subfolder: '', buffer: null })
      continue
    }
    try {
      const buffer = await api.downloadOutput(out)
      outputs.push({ filename: out.filename, subfolder: out.subfolder || '', kind: out.kind, buffer })
    } catch (e) {
      outputs.push({ filename: out.filename, subfolder: out.subfolder || '', kind: out.kind, buffer: null, error: e?.message || String(e) })
    }
  }
  return { ok: true, promptId, outputs, skippedSteps, finalNodeId: finalId }
}

/** node_errors（{nodeId:{errors:[{message,details}]}}）→ 可读摘要（附节点类型与标题） */
export function formatNodeErrors(nodeErrors, analysis, titles) {
  if (!nodeErrors || typeof nodeErrors !== 'object') return ''
  const parts = []
  for (const [nodeId, info] of Object.entries(nodeErrors)) {
    const errs = Array.isArray(info?.errors) ? info.errors : []
    const msg = errs.map((e) => `${e?.message || ''}${e?.details ? `（${e.details}）` : ''}`).join('；') || JSON.stringify(info).slice(0, 200)
    const ct = analysis?.nodes?.find((n) => n.id === String(nodeId))?.class_type || info?.class_type || ''
    parts.push(`节点 ${nodeId}${ct ? `(${ct})` : ''}${titles?.[nodeId] ? `「${titles[nodeId]}」` : ''}: ${msg}`)
    if (parts.length >= 4) break
  }
  return parts.join('；')
}
