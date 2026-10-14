/**
 * 工作流分析：API 图 → 友好参数映射（prompt/seed/尺寸/输入图/模型…）+ 类型提示。
 *
 * 自动发现的工作流来自用户，节点布局千差万别；本模块按「语义连接」而不是固定节点 ID
 * 定位参数（例如正向提示词 = 采样器 positive 输入一路回溯到的第一个带 text 的节点），
 * 让 LLM 无需了解每个工作流的内部结构即可填参。找不到的参数不报错，只是不提供。
 *
 * 输出：
 *  - params: 友好名 → { node, field }（写值位置）
 *  - kinds:  类型提示（txt2img/img2img/upscale/detailer/video），供 LLM 选工作流
 *  - models: 引用的模型文件（按类别），供检查是否已安装
 *  - nodes:  紧凑节点清单（inspect 工具用）
 *  - notes:  工作流内 Note/MarkdownNote 的说明文本（由调用方从 UI 格式收集传入）
 */

const SAMPLER_RE = /^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced|KSamplerSelect|CFGGuider|BasicScheduler|RandomNoise|SamplerCustomAdvanced)$/
/** 带 width/height 的潜空间/缩放节点（尺寸目标候选） */
const LATENT_CLASSES = /^(EmptyLatentImage|EmptySD3LatentImage|EmptyHunyuanLatentVideo|EmptyLatentVideo|EmptyMochiLatentVideo|EmptyLTXVLatentVideo|ImageScale|ImageScaleBy|ResizeImageMaskNode|ImageResize)$/
const VIDEO_OUT_RE = /^(VHS_VideoCombine|SaveVideo|SaveWEBM|SaveAnimatedWEBP|SaveAnimatedPNG)$/
const DETAILER_RE = /(FaceDetailer|MaskDetailer|SegmDetailer|DetailerPipe|HandRepair|HandPose)/
/** 提示词反推/打标类节点（WD14 Tagger、CLIP Interrogator、Florence、BLIP 等） */
const INTERROGATE_RE = /(WD14Tagger|Tagger|Interrogator|Florence|BLIP|JoyTag|ImageCaption|Captioner)/i
const MAX_TRACE_DEPTH = 12

const isLink = (v) => Array.isArray(v) && v.length >= 2 && typeof v[0] === 'string'
/** 取输入字段的连线来源节点 ID（非连线返回 null） */
const srcOf = (inputs, field) => (isLink(inputs?.[field]) ? String(inputs[field][0]) : null)

/**
 * 分析 API 图。
 * @param {object} graph API 格式图（{id:{class_type,inputs}}）
 * @param {object} opts { notes?: [{title,text}], titles?: {id:title} }
 */
export function analyzeGraph(graph, opts = {}) {
  const nodes = Object.entries(graph || {}).map(([id, n]) => ({ id: String(id), class_type: n.class_type, inputs: n.inputs || {}, title: opts.titles?.[String(id)] || '' }))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const params = {}
  const warnings = []
  const kinds = new Set()
  const models = { checkpoints: [], unet: [], vae: [], upscale: [], loras: [], detectors: [], controlnet: [] }

  const setIf = (key, node, field) => { if (!params[key] && node && field in node.inputs) params[key] = { node: node.id, field } }

  // ── 回溯：沿 link 找到第一个带 text 输入的节点（提示词落点） ──
  const textNodeOf = (nodeId, depth = 0, seen = new Set()) => {
    if (!nodeId || depth > MAX_TRACE_DEPTH || seen.has(nodeId)) return null
    seen.add(nodeId)
    const n = byId.get(String(nodeId))
    if (!n) return null
    if ('text' in n.inputs) return n
    // 条件链（ConditioningCombine/Set/Concat/…）继续往上找
    for (const [field, v] of Object.entries(n.inputs)) {
      if (!isLink(v)) continue
      if (!/cond|positive|negative|text|prompt|clip/i.test(field)) continue
      const t = textNodeOf(String(v[0]), depth + 1, seen)
      if (t) return t
    }
    return null
  }

  // ── 采样器（参数主落点）──
  const samplers = nodes.filter((n) => SAMPLER_RE.test(n.class_type))
  const primary = samplers.find((n) => 'seed' in n.inputs) || samplers.find((n) => /KSampler/.test(n.class_type)) || samplers[0] || null
  if (primary) {
    setIf('seed', primary, 'seed')
    setIf('steps', primary, 'steps')
    setIf('cfg', primary, 'cfg')
    setIf('sampler_name', primary, 'sampler_name')
    setIf('scheduler', primary, 'scheduler')
    setIf('denoise', primary, 'denoise')
    const pos = textNodeOf(srcOf(primary.inputs, 'positive'))
    const neg = textNodeOf(srcOf(primary.inputs, 'negative'))
    if (pos) params.prompt = { node: pos.id, field: 'text' }
    if (neg) params.negative_prompt = { node: neg.id, field: 'text' }
  }
  // 全局兜底（SamplerCustom 链：RandomNoise/BasicScheduler/KSamplerSelect/CFGGuider 分散在多节点；
  // 放大/重绘类工作流（UltimateSDUpscale 等）不在 SAMPLER_RE 里，也靠这里）
  for (const n of nodes) {
    setIf('seed', n, 'seed')
    setIf('seed', n, 'noise_seed')
    setIf('steps', n, 'steps')
    setIf('cfg', n, 'cfg')
    setIf('sampler_name', n, 'sampler_name')
    setIf('scheduler', n, 'scheduler')
    setIf('denoise', n, 'denoise')
  }
  // 提示词兜底：没连采样器也认（工作流可能只接了 detailer）
  if (!params.prompt || !params.negative_prompt) {
    const texts = nodes.filter((n) => 'text' in n.inputs && typeof n.inputs.text === 'string')
    const negLike = (s) => /worst quality|low quality|lowres|bad anatomy|bad hands|watermark|text, error|nsfw|blurry|low score/i.test(s)
    if (!params.prompt) {
      const p = texts.find((n) => !negLike(n.inputs.text))
      if (p) params.prompt = { node: p.id, field: 'text' }
    }
    if (!params.negative_prompt) {
      const q = texts.find((n) => negLike(n.inputs.text))
      if (q) params.negative_prompt = { node: q.id, field: 'text' }
    }
  }
  if (!params.prompt) warnings.push('未识别到正向提示词节点（text 输入），prompt 参数将不可用')

  // ── 尺寸/批量（潜空间或缩放节点）──
  const dimNodes = nodes.filter((n) => LATENT_CLASSES.test(n.class_type) && 'width' in n.inputs && 'height' in n.inputs)
  // 优先：喂给采样器 latent_image 的那个；img2img 工作流则退到缩放输入图的节点
  const latentSrc = primary ? srcOf(primary.inputs, 'latent_image') : null
  const dimPreferred = (latentSrc && dimNodes.find((n) => n.id === latentSrc))
    || dimNodes.find((n) => /^(ImageScale|ImageScaleBy|ResizeImageMaskNode|ImageResize)$/.test(n.class_type) && srcOf(n.inputs, 'image'))
    || dimNodes[0] || null
  if (dimPreferred) {
    setIf('width', dimPreferred, 'width')
    setIf('height', dimPreferred, 'height')
    setIf('batch_size', dimPreferred, 'batch_size')
  }
  const upscaleByNode = nodes.find((n) => 'upscale_by' in n.inputs)
  if (upscaleByNode) params.upscale_by = { node: upscaleByNode.id, field: 'upscale_by' }

  // ── 模型文件 ──
  for (const n of nodes) {
    const push = (arr, v) => { if (typeof v === 'string' && v && !arr.includes(v)) arr.push(v) }
    if ('ckpt_name' in n.inputs) { push(models.checkpoints, n.inputs.ckpt_name); setIf('model', n, 'ckpt_name') }
    if ('unet_name' in n.inputs) { push(models.unet, n.inputs.unet_name); setIf('model', n, 'unet_name') }
    if ('vae_name' in n.inputs) push(models.vae, n.inputs.vae_name)
    if ('model_name' in n.inputs) {
      if (/Upscale/i.test(n.class_type)) { push(models.upscale, n.inputs.model_name); setIf('upscale_model', n, 'model_name') }
      // 检测器权重（Impact 的 bbox/hand/face yolo 等）：独立类别，别混进 upscale（检查源不同，会误报缺失）
      else if (/Detector/i.test(n.class_type)) push(models.detectors, n.inputs.model_name)
    }
    if ('lora_name' in n.inputs) push(models.loras, n.inputs.lora_name)
    if ('control_net_name' in n.inputs) push(models.controlnet, n.inputs.control_net_name)
  }

  // ── 输入图 / 蒙版 ──
  const loadImages = nodes.filter((n) => 'image' in n.inputs && /LoadImage/.test(n.class_type))
  // LoadImage 的输出槽：0=IMAGE、1=MASK；「蒙版专用图」= 类名带 Mask 或 IMAGE 输出只被 mask 类字段消费
  const consumers = (id) => {
    const out = []
    for (const t of nodes) {
      for (const [field, v] of Object.entries(t.inputs)) {
        if (isLink(v) && String(v[0]) === id) out.push({ field, slot: Number(v[1]) || 0 })
      }
    }
    return out
  }
  const maskOnly = (n) => {
    if (/Mask/i.test(n.class_type)) return true
    const cs = consumers(n.id).filter((c) => c.slot === 0)
    return cs.length > 0 && cs.every((c) => /mask/i.test(c.field))
  }
  const plainImages = loadImages.filter((n) => !maskOnly(n))
  const maskImages = loadImages.filter(maskOnly)
  if (plainImages[0]) params.input_image = { node: plainImages[0].id, field: 'image' }
  if (maskImages[0]) params.mask_image = { node: maskImages[0].id, field: 'image' }
  if (plainImages.length > 1) warnings.push(`工作流含 ${plainImages.length} 个输入图节点，仅第一个映射为 input_image（其余可用 set 覆盖）`)

  // ── 类型提示 ──
  // img2img 判定要求「真有输入图」：局部重绘/手部修复链内部也含 VAEEncode（但那是把原图编码进重绘流程），
  // 只看 encode 节点会把「底图+修手」这类 txt2img 工作流误标成 img2img（如 02 新版）。
  const hasEncode = nodes.some((n) => /VAEEncode|EncodeTiled|VAEEncodeForInpaint/.test(n.class_type)) || (loadImages.length && primary && srcOf(primary.inputs, 'latent_image'))
  if (primary) {
    if (params.input_image && hasEncode) kinds.add('img2img')
    else kinds.add('txt2img')
  }
  if (nodes.some((n) => DETAILER_RE.test(n.class_type))) kinds.add('detailer')
  if (nodes.some((n) => /UltimateSDUpscale|UpscaleModelLoader|ImageUpscaleWithModel/.test(n.class_type))) kinds.add('upscale')
  if (nodes.some((n) => VIDEO_OUT_RE.test(n.class_type))) kinds.add('video')
  // 反推提示词/打标：输出文本而非图片（工具/指令会把文本原样返回）
  if (nodes.some((n) => INTERROGATE_RE.test(n.class_type))) kinds.add('interrogate')
  if (!kinds.size) kinds.add(primary ? 'img2img' : 'other')

  // ── 紧凑节点清单（inspect 用） ──
  const compact = nodes.map((n) => {
    const widgets = {}
    for (const [k, v] of Object.entries(n.inputs)) {
      if (isLink(v)) continue
      if (typeof v === 'string' && v.length > 120) widgets[k] = v.slice(0, 120) + '…'
      else widgets[k] = v
    }
    return { id: n.id, class_type: n.class_type, ...(n.title ? { title: n.title } : {}), widgets }
  })

  return {
    params,
    kinds: [...kinds],
    models,
    nodes: compact,
    notes: (opts.notes || []).slice(0, 6),
    warnings,
  }
}
