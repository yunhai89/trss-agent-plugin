/**
 * ComfyUI 前端工作流（UI 格式）→ API 格式 转换。
 *
 * ComfyUI 里用户保存/下载的「真实工作流」是前端格式（nodes/links/widgets_values），
 * 而 POST /prompt 只吃 API 格式（节点ID → {class_type, inputs}）。本模块用服务器
 * /object_info 的节点定义做转换（widget 顺序、类型、可选输入都在里面）：
 *
 *  1. link 输入：node.inputs[].link → links 表 → [origin_id, origin_slot]；
 *  2. widget 值：按 object_info required→optional 的声明顺序依次消费 widgets_values；
 *     seed 类 widget 后可能跟一个 control 下拉值（fixed/randomize/...），按「下一个值
 *     是否为控制词」跳过（自定义节点常缺 control_after_generate 声明，但前端照样插值）；
 *  3. 虚拟/旁路节点：Reroute 与 mode=4(bypass) 穿透（同类型输入接替输出）、
 *     PrimitiveNode 命中 widget 输入时写字面量、mode=2(mute) 剔除、Note/MarkdownNote 剔除；
 *  4. 缺节点包（object_info 里没有的类型）→ 明确报错并列出，避免提交后才被 server 打回。
 *
 * 已用 RTX2080 动漫包 5 份工作流与同源 API 格式逐字段比对通过（见 test.mjs）。
 */

/** 视为 widget 的输入类型（其余字符串类型按 link 输入处理；数组类型=COMBO） */
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])
/** seed 类 widget 后的控制下拉取值 */
const SEED_CONTROLS = new Set(['fixed', 'increment', 'decrement', 'randomize'])
/** 前端虚拟节点（不执行） */
const NOTE_TYPES = new Set(['Note', 'MarkdownNote'])
const VIRTUAL_TYPES = new Set(['Reroute', 'PrimitiveNode'])
/** 展开深度上限（防病态图死循环） */
const MAX_DEPTH = 64

/** 取某类节点的输入规格（有序）：[{name, widget, type, opts}]；未知类型返回 null */
export function inputSpecs(objectInfo, classType) {
  const def = objectInfo?.[classType]
  if (!def) return null
  const out = []
  for (const bucket of ['required', 'optional']) {
    for (const [name, spec] of Object.entries(def.input?.[bucket] || {})) {
      const type = Array.isArray(spec) ? spec[0] : undefined
      const opts = (Array.isArray(spec) ? spec[1] : null) || {}
      const widget = !opts.forceInput && (Array.isArray(type) || WIDGET_TYPES.has(type))
      out.push({ name, widget, type, opts })
    }
  }
  return out
}

/** 是否为前端格式（UI 工作流） */
export function isUiFormat(raw) {
  return !!(raw && typeof raw === 'object' && Array.isArray(raw.nodes) && raw.nodes.length)
}

/** 兼容 {prompt:{...}} 包装与裸 {...} 两种 API 形态（Hermes unwrap_workflow） */
export function unwrapApi(raw) {
  if (raw && typeof raw === 'object' && raw.prompt && typeof raw.prompt === 'object' && !raw.class_type) return raw.prompt
  return raw
}

/**
 * 是否为 API 格式（含节点条目即可；`_comment` 等说明键由 sanitizeApiGraph 剔除）。
 * 注意：只要「有一个带 class_type 的条目」就算 API 图 —— 老工具模板是「裸图 + 顶层 _comment」形态，
 * 若要求所有值都是节点，这类文件会被误判成「无法识别」。
 */
export function isApiFormat(raw) {
  const g = unwrapApi(raw)
  if (!g || typeof g !== 'object' || Array.isArray(g)) return false
  return Object.values(g).some((v) => v && typeof v === 'object' && typeof v.class_type === 'string')
}

/**
 * 只保留节点条目（值必须是 {class_type, inputs} 对象）。
 * 工作流文件常带 `_comment` 之类的说明键；若原样提交，ComfyUI validate_prompt 会对字符串调 .get()
 * 直接崩（实测 0.39.0：AttributeError → aiohttp 500「Server got itself in trouble」）。
 * @returns {{graph:object, dropped:string[]}}
 */
export function sanitizeApiGraph(raw) {
  const g = unwrapApi(raw)
  const graph = {}
  const dropped = []
  for (const [k, v] of Object.entries(g && typeof g === 'object' && !Array.isArray(g) ? g : {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.class_type === 'string') graph[k] = v
    else dropped.push(k)
  }
  return { graph, dropped }
}

/**
 * UI 格式 → API 格式。
 * @param {object} ui 前端格式工作流
 * @param {object} objectInfo 服务器 /object_info
 * @returns {{ok:true, prompt:object, warnings:string[], notes:{title:string,text:string}[], dropped:number}
 *          |{ok:false, error:string, missing?:string[]}}
 */
export function uiToApi(ui, objectInfo) {
  const nodes = isUiFormat(ui) ? ui.nodes : null
  if (!nodes) return { ok: false, error: '不是前端格式工作流（缺少 nodes 数组）' }
  if (ui.definitions?.subgraphs?.length) {
    return { ok: false, error: '该工作流包含子图（Subgraph），暂不支持自动转换；请在 ComfyUI 里展开子图（或导出 API 格式）后再保存' }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const links = new Map()
  for (const l of ui.links || []) {
    // [link_id, origin_id, origin_slot, target_id, target_slot, type]
    if (Array.isArray(l)) links.set(l[0], { origin: l[1], originSlot: l[2], target: l[3], targetSlot: l[4] })
  }

  // 缺节点包预检（mute/Note/虚拟节点不参与执行，不要求定义）
  const missing = new Set()
  for (const n of nodes) {
    if (n.mode === 2 || NOTE_TYPES.has(n.type) || VIRTUAL_TYPES.has(n.type)) continue
    if (!objectInfo?.[n.type]) missing.add(n.type)
  }
  if (missing.size) {
    return { ok: false, error: `工作流使用了服务器上没有的节点类型（未安装对应节点包）：${[...missing].join('、')}`, missing: [...missing] }
  }

  // 出边索引（origin id → [{linkId, slot}]）——仅用于 bypass/reroute 的穿透解析
  const outLinks = new Map()
  for (const [linkId, l] of links) {
    if (!outLinks.has(l.origin)) outLinks.set(l.origin, [])
    outLinks.get(l.origin).push({ linkId, slot: l.originSlot })
  }

  /** 解析输入来源：普通节点 → [id, slot]；bypass/reroute 逐层穿透；Primitive 返回字面量；mute → 断开 */
  const resolveSource = (nodeId, slot, depth = 0) => {
    if (depth > MAX_DEPTH) return null
    const n = byId.get(nodeId)
    if (!n) return null
    // mute（mode=2）节点不参与执行：来源视为断开（与前端一致——下游输入缺失，由 server 明确报错）
    if (n.mode === 2) return null
    const isBypass = n.mode === 4
    const isReroute = n.type === 'Reroute'
    if (!isBypass && !isReroute && n.type !== 'PrimitiveNode') return { link: [String(nodeId), slot] }
    if (n.type === 'PrimitiveNode') return { literal: n.widgets_values?.[0] }

    const outType = n.outputs?.[slot]?.type || '*'
    const cands = (n.inputs || []).filter((i) => i.link != null && (isReroute || i.type === outType || i.type === '*' || outType === '*'))
    const inp = cands[0]
    if (!inp) return null
    const src = links.get(inp.link)
    if (!src) return null
    return resolveSource(src.origin, src.originSlot, depth + 1)
  }

  const warnings = []
  const notes = []
  const prompt = {}
  let dropped = 0

  for (const n of nodes) {
    if (n.mode === 2) { dropped++; continue }
    if (NOTE_TYPES.has(n.type)) {
      const text = typeof n.widgets_values?.[0] === 'string' ? n.widgets_values[0] : ''
      if (text.trim()) notes.push({ title: n.title || '', text: text.trim().slice(0, 2000) })
      continue
    }
    if (n.mode === 4 || VIRTUAL_TYPES.has(n.type)) { dropped++; continue }

    const specs = inputSpecs(objectInfo, n.type)
    const inputs = {}
    const linked = new Set()
    // 1) link 输入（含被转成输入口的 widget：node.inputs[].widget.name 才是 API 字段名）
    for (const inp of n.inputs || []) {
      if (inp.link == null) continue
      const name = inp.widget?.name || inp.name
      const l = links.get(inp.link)
      if (!l) continue
      const src = resolveSource(l.origin, l.originSlot)
      if (src?.link) { inputs[name] = src.link; linked.add(name) }
      else if (src && 'literal' in src) { inputs[name] = src.literal; linked.add(name) }
      else warnings.push(`节点 ${n.id}(${n.type}) 的输入 ${name} 来源无法解析（经过 bypass/mute 节点？）`)
    }
    // 2) widget 值：按声明顺序消费 widgets_values
    const wv = Array.isArray(n.widgets_values) ? n.widgets_values : []
    let wi = 0
    for (const s of specs) {
      if (!s.widget) continue
      if (!linked.has(s.name) && wi < wv.length) inputs[s.name] = wv[wi]
      wi++
      const isSeed = s.name === 'seed' || s.name === 'noise_seed'
      if ((s.opts?.control_after_generate || isSeed) && wi < wv.length && typeof wv[wi] === 'string' && SEED_CONTROLS.has(wv[wi])) wi++
    }
    prompt[String(n.id)] = { class_type: n.type, inputs }
  }

  if (!Object.keys(prompt).length) return { ok: false, error: '工作流里没有可执行节点（全是 Note/mute？）' }
  return { ok: true, prompt, warnings, notes, dropped }
}

/**
 * 归一为 API 图：API 格式直接用，UI 格式转换。两者都会剔除非节点键（如 _comment）。
 * @returns {{ok:true, prompt, format:'api'|'ui', warnings, notes} | {ok:false, error, missing?}}
 */
export function toApiGraph(raw, objectInfo) {
  if (isApiFormat(raw)) {
    const { graph, dropped } = sanitizeApiGraph(raw)
    if (!Object.keys(graph).length) return { ok: false, error: '工作流里没有可执行节点（只有说明/注释键？）' }
    const warnings = dropped.length ? [`已剔除非节点键：${dropped.join('、')}（ComfyUI 只接受节点条目，直接提交会 500）`] : []
    return { ok: true, prompt: graph, format: 'api', warnings, notes: [] }
  }
  if (isUiFormat(raw)) {
    const r = uiToApi(raw, objectInfo)
    if (!r.ok) return r
    return { ok: true, prompt: r.prompt, format: 'ui', warnings: r.warnings, notes: r.notes }
  }
  return { ok: false, error: '无法识别的工作流格式（既不是 API 格式 {节点ID:{class_type,inputs}}，也不是前端格式 {nodes:[...]}）' }
}
