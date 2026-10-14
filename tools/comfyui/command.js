/**
 * 指令画图的纯逻辑（离线可测）：解析「#画图N 关键字」、格式化工作流清单、按需自动选工作流。
 * Yunzai 交互（回复/发图/冷却/权限）留在 apps/comfyui-draw.js。
 */

/** 工作流用途（kinds）→ 中文标签 */
export const KIND_ZH = {
  txt2img: '文生图',
  img2img: '图生图',
  upscale: '放大高清',
  detailer: '修脸/修手',
  video: '视频',
  interrogate: '反推提示词',
  other: '其它',
}

/** kinds → 中文用途串（如「文生图+修脸/修手」） */
export function kindText(kinds = []) {
  const names = (Array.isArray(kinds) ? kinds : []).map((k) => KIND_ZH[k] || k)
  return names.join('+') || '未知'
}

/**
 * 解析指令文本：
 *   #画图1 关键字   → { n:1, prompt:'关键字' }
 *   #画图 关键字    → { n:null, prompt:'关键字' }（自动选工作流）
 *   #画图1          → { n:1, prompt:'' }（用工作流自带默认提示词）
 * 注意：「#画图 5月的天空」里的 5 不是编号（数字后必须跟空白/结尾才算编号）。
 */
export function parseDraw(text) {
  const s = String(text ?? '').trim()
  if (!/^#画图/.test(s)) return { error: '格式：#画图<编号> <关键字>（如「#画图1 银发少女 樱花」）；先 #画图列表 看编号' }
  const rest = s.slice('#画图'.length)
  let n = null
  let body = rest
  const m = rest.match(/^\s*(\d+)(?:\s+|$)/)
  if (m) {
    n = Number(m[1])
    body = rest.slice(m[0].length)
  }
  if (n != null && n < 1) return { error: '工作流编号从 1 开始（见 #画图列表）' }
  return { n, prompt: body.trim() }
}

/**
 * 解析反推指令：#反推（图随消息/引用附带）。多出的文字作为提示（如"只要角色标签"），当前仅透传。
 */
export function parseReverse(text) {
  const s = String(text ?? '').trim()
  if (!/^#反推/.test(s)) return { error: '格式：#反推（把图随消息一起发，或引用一张图再发）' }
  return { hint: s.slice('#反推'.length).trim() }
}

/** 工作流清单文案（供聊天展示；带编号、用途、是否需配图、缺模型与说明） */
export function formatWorkflowList(items, { max = 12 } = {}) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return '未发现工作流：请先在 ComfyUI 里保存工作流（或用 agent.comfyui.workflowDir 指定目录）'
  const lines = [`🎨 可用工作流（共 ${list.length} 个）`]
  list.slice(0, max).forEach((it, i) => {
    const tags = [kindText(it.kinds)]
    if (it.needs_input_image) tags.push('需配图')
    if (it.missing_models?.length) tags.push('⚠️缺模型')
    lines.push(`${i + 1}. ${it.name} ［${tags.join(' · ')}］`)
    const desc = String(it.note || it.default_prompt || '').replace(/\s+/g, ' ').trim()
    if (desc) lines.push(`   ${desc.slice(0, 56)}${desc.length > 56 ? '…' : ''}`)
  })
  if (list.length > max) lines.push(`…另有 ${list.length - max} 个（用工作流全名指定）`)
  lines.push('')
  lines.push('用法：#画图<编号> <关键字>｜例：#画图1 银发少女 樱花')
  lines.push('不带编号=自动选（配图→图生图；纯文字→文生图）；「需配图」的工作流请随消息附图或引用一张图')
  lines.push('提示词反推：#反推（附图或引用一张图）→ 返回 Danbooru 风格标签，可直接拿去画图')
  lines.push('改图类工作流默认只做轻度变化（沿用工作流自带 denoise）；想大改可让 AI 画（可调 denoise 0.6~0.8）')
  return lines.join('\n')
}

/**
 * 选工作流：指定编号优先；否则按需求自动选。
 * @param {Array} items listWorkflowsSummary 的 items
 * @param {{n?:number|null, hasImage?:boolean, only?:string|null}} opts
 *   only：只在含该 kind 的工作流里选（如 'interrogate' 反推）；未指定时自动选会排除反推类
 * @returns {{item, index:number, auto?:boolean}|{error:string}}
 */
export function pickWorkflow(items, { n = null, hasImage = false, only = null } = {}) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return { error: '未发现任何工作流（先在 ComfyUI 里保存工作流）' }
  const has = (it, k) => (it.kinds || []).includes(k)
  if (n != null) {
    if (!Number.isInteger(n) || n < 1 || n > list.length) return { error: `编号 ${n} 不存在（共 ${list.length} 个，见 #画图列表）` }
    return { item: list[n - 1], index: n }
  }
  if (only) {
    const item = list.find((it) => has(it, only))
    if (!item) return { error: `没有「${KIND_ZH[only] || only}」类工作流（需在 ComfyUI 里装对应节点并保存工作流）` }
    return { item, index: list.indexOf(item) + 1, auto: true }
  }
  // 自动选（画图）时排除反推类（它不产图）
  const pool = list.filter((it) => !has(it, 'interrogate'))
  const from = pool.length ? pool : list
  const pick = hasImage
    // 有配图：优先图生图 → 修脸/修手 → 放大
    ? (from.find((it) => has(it, 'img2img')) || from.find((it) => has(it, 'detailer')) || from.find((it) => has(it, 'upscale')) || from[0])
    // 纯文字：优先「纯文生图」（不含 detailer/upscale 的轻量档）
    : (from.find((it) => has(it, 'txt2img') && !has(it, 'detailer')) || from.find((it) => has(it, 'txt2img')) || from[0])
  return { item: pick, index: list.indexOf(pick) + 1, auto: true }
}
