/**
 * 本地 Mermaid SVG 后处理 —— 把 beautiful-mermaid 输出的"主题化 CSS 变量 SVG"转成 resvg 可渲染的纯色 SVG。
 *
 * 背景：beautiful-mermaid（零 DOM 引擎）的 SVG 用 CSS 自定义属性（--bg/--fg/…、var()、color-mix()）做主题；
 * resvg 不解析 var()/color-mix，未处理直接栅格化会得到整图单色剪影（实测 distinctColors=1）。
 * 本模块确定性展开：
 *   1. 剥 @import 外链字体行；font-family 全部替换为加载的中文固定字体；
 *   2. 注入主题变量（--bg/--fg/--accent/--line/--surface/--border）到根元素 style；
 *   3. 递归展开 var(--x[,fallback]) 与 color-mix(in srgb, A N%, B)（迭代至不动点，防循环上限 8 轮）；
 *   4. 展开 background:var(--bg) → 具体色。
 */

const VAR_DEF = /--([A-Za-z0-9_-]+)\s*:\s*([^;}"']+)/g

/** hex（#RGB/#RRGGBB）→ [r,g,b]；不识别的返回 null */
function hexToRgb(c) {
  const s = String(c || '').trim()
  if (/^#[0-9a-f]{3}$/i.test(s)) return [parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16), parseInt(s[3] + s[3], 16)]
  if (/^#[0-9a-f]{6}$/i.test(s)) return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]
  return null
}
const rgbToHex = (r, g, b) => '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')

/** color-mix(in srgb, A N%, B) → hex（A/B 已是具体色值；不识别返回 null 保持原文） */
function applyColorMix(s) {
  const re = /color-mix\(\s*in\s+srgb\s*,\s*([^,]+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)/i
  let out = s, changed = false
  for (let guard = 0; guard < 16; guard++) {
    const m = re.exec(out)
    if (!m) break
    const a = hexToRgb(m[1]); const b = hexToRgb(m[3]); const pct = parseFloat(m[2]) / 100
    if (!a || !b || !Number.isFinite(pct)) break
    out = out.slice(0, m.index) + rgbToHex(a[0] * pct + b[0] * (1 - pct), a[1] * pct + b[1] * (1 - pct), a[2] * pct + b[2] * (1 - pct)) + out.slice(m.index + m[0].length)
    changed = true
  }
  return { out, changed }
}

/**
 * 展开 SVG 中的 var()/color-mix() 为具体值。
 * @param {string} svg 原始 SVG
 * @param {object} themeVars 主题变量覆盖（{bg:'#..',fg:'#..',accent,line,surface,border} → --bg 等）
 * @param {string} fontFamily 替换后的字体名
 */
export function expandSvgCss(svg, themeVars = {}, fontFamily = 'Noto Sans CJK SC') {
  let s = String(svg ?? '')

  // 1) 剥 @import（外链字体——SVG 安全检查会拒，必须先移除）
  s = s.replace(/@import\s+url\([^)]*\)\s*;?/g, '')
  // 2) font-family 统一替换（style 块与内联 attribute 两处）
  s = s.replace(/font-family\s*:\s*[^;}"']+;?/gi, `font-family: '${fontFamily}';`)
  s = s.replace(/font-family="[^"]*"/gi, `font-family="${fontFamily}"`)

  // 3) 收集变量定义：先 <style> 块（按出现顺序，后者覆盖前者），再根元素内联 style（优先级最高）
  const vars = new Map()
  const styleBlock = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(s)?.[1] || ''
  for (const m of styleBlock.matchAll(VAR_DEF)) vars.set(m[1], m[2].trim())
  const rootTag = /<svg[^>]*>/i.exec(s)?.[0] || ''
  const rootStyleAttr = /style="([^"]*)"/i.exec(rootTag)?.[1] || ''
  // 4) 注入主题变量到根内联 style（在收集默认值之后写入，保证覆盖）
  const inject = Object.entries(themeVars)
    .filter(([, v]) => v)
    .map(([k, v]) => `--${k}:${v}`)
    .join(';')
  for (const m of rootStyleAttr.matchAll(VAR_DEF)) vars.set(m[1], m[2].trim())
  if (inject) {
    const newRoot = rootStyleAttr
      ? rootTag.replace(/style="[^"]*"/i, `style="${rootStyleAttr};${inject}"`)
      : rootTag.replace(/>$/, ` style="${inject}">`)
    if (newRoot !== rootTag) s = s.replace(rootTag, newRoot)
    // 注入后重新收集（内联变量优先）
    const updatedRoot = /<svg[^>]*>/i.exec(s)?.[0] || ''
    const updatedAttr = /style="([^"]*)"/i.exec(updatedRoot)?.[1] || ''
    for (const m of updatedAttr.matchAll(VAR_DEF)) vars.set(m[1], m[2].trim())
  }

  // 5) 迭代展开：var() → color-mix → 具体色；8 轮不动点上限（防循环引用）
  let unresolved = false
  for (let round = 0; round < 8; round++) {
    let changed = false
    // var(--x) 与 var(--x, fallback)：fallback 存在时，若 --x 未定义用 fallback
    s = s.replace(/var\(\s*--([A-Za-z0-9_-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*)\s*)?\)/g, (whole, name, fallback) => {
      if (vars.has(name)) { changed = true; return vars.get(name) }
      if (fallback != null && fallback.trim()) { changed = true; return fallback.trim() }
      unresolved = true
      return whole
    })
    const mix = applyColorMix(s)
    if (mix.changed) { s = mix.out; changed = true }
    // 定义行里的 var() 也可能互相引用：重算一次变量表
    const sb = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(s)?.[1] || ''
    if (sb) {
      const nv = new Map()
      for (const m of sb.matchAll(VAR_DEF)) nv.set(m[1], m[2].trim())
      const rt = /<svg[^>]*>/i.exec(s)?.[0] || ''
      const ra = /style="([^"]*)"/i.exec(rt)?.[1] || ''
      for (const m of ra.matchAll(VAR_DEF)) nv.set(m[1], m[2].trim())
      for (const [k, v] of nv) vars.set(k, v)
    }
    if (!changed) break
  }
  return { svg: s, unresolved }
}
