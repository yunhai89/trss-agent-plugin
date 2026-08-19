/**
 * SVG 安全检查 —— 所有来源（Kroki 返回 / 本地渲染）的 SVG 一律视为不可信输出。
 *
 * 拒绝形态（任一命中即 invalid_renderer_output，不进入栅格化/发送）：
 *   DOCTYPE/外部实体、script/foreignObject/image 元素、事件处理属性（on*=）、
 *   任何 http(s) URL（外链/追踪）、非字体类 data: URI（图片/文本嵌入）、非 svg 根元素（HTML 错误页伪装）。
 *   唯一放行：字体类 data: URI（D2 输出内嵌 @font-face；不执行不外联，栅格化用本地字体）。
 * 通过时顺带解析 viewBox/width/height 供栅格化尺寸计算。
 */

const RE_FORBIDDEN = [
  { re: /<!DOCTYPE/i, why: 'DOCTYPE 声明' },
  { re: /<!ENTITY/i, why: '外部实体' },
  { re: /<\s*script/i, why: 'script 元素' },
  { re: /<\s*foreignObject/i, why: 'foreignObject 元素' },
  { re: /<\s*image/i, why: 'image 元素（图片嵌入）' },
  { re: /\son[a-z]+\s*=/i, why: '事件处理属性（on*=）' },
  // 外部资源引用：href/src（含协议相对 //）与 CSS url() —— xmlns 命名空间声明不属于资源引用，不在此列。
  // 字体类 data: URI 放行（D2 输出内嵌 @font-face 字体；resvg 用本地字体渲染，内嵌字体不执行不外联），
  // data:image / data:text 仍然拒绝。
  { re: /(?:xlink:href|href|src)\s*=\s*["']?\s*(?:https?:)?\/\//i, why: 'href/src 外部 URL' },
  { re: /(?:xlink:href|href|src)\s*=\s*["']?\s*data\s*:\s*(?!font\/|application\/font)/i, why: 'href/src data: URL' },
  { re: /url\(\s*['"]?\s*(?:https?:)?\/\//i, why: 'CSS url() 外部引用' },
  { re: /url\(\s*['"]?\s*data\s*:\s*(?!font\/|application\/font)/i, why: 'CSS url() data: URL' },
  { re: /javascript\s*:/i, why: 'javascript: 协议' },
  { re: /@import/i, why: '@import 外链样式' },
]

/**
 * @param {string} svgText
 * @param {{maxBytes?:number}} opts
 * @returns {{ok:true,width?:number,height?:number}|{ok:false,errorClass:'invalid_renderer_output'|'output_too_large',reason:string}}
 */
export function checkSvg(svgText, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const s = String(svgText ?? '')
  if (!s) return { ok: false, errorClass: 'invalid_renderer_output', reason: 'SVG 为空' }
  const bytes = Buffer.byteLength(s, 'utf8')
  if (bytes > maxBytes) return { ok: false, errorClass: 'output_too_large', reason: `SVG ${bytes}B 超过上限 ${maxBytes}B` }
  for (const { re, why } of RE_FORBIDDEN) {
    if (re.test(s)) return { ok: false, errorClass: 'invalid_renderer_output', reason: `SVG 含被禁止内容：${why}` }
  }
  // 根元素必须是 <svg>（剥 BOM/前导空白/合法 xml 声明）
  const head = s.replace(/^[﻿\s]+/, '').replace(/^<\?xml[^>]*\?>\s*/i, '')
  if (!/^<svg[\s>]/i.test(head)) return { ok: false, errorClass: 'invalid_renderer_output', reason: '根元素不是 <svg>（可能为 HTML 错误页）' }
  const dims = parseSvgSize(s)
  return { ok: true, ...dims }
}

/** 解析 width/height（px 优先）与 viewBox，输出 {width,height}（px 数值；缺失时 null） */
export function parseSvgSize(svgText) {
  const s = String(svgText ?? '')
  const root = /<svg[^>]*>/i.exec(s)?.[0] || ''
  const num = (v) => {
    if (v == null) return null
    const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(v)
    return m ? parseFloat(m[1]) : null
  }
  let w = num(/(^|["\s])width\s*=\s*"([^"]*)"/i.exec(root)?.[2])
  let h = num(/(^|["\s])height\s*=\s*"([^"]*)"/i.exec(root)?.[2])
  const vb = /viewBox\s*=\s*"([^"]*)"/i.exec(root)?.[1]
  if (vb) {
    const m = vb.trim().split(/[\s,]+/).map(Number)
    if (m.length === 4 && m.every((x) => Number.isFinite(x)) && m[2] > 0 && m[3] > 0) {
      if (w == null || h == null) { w = w ?? m[2]; h = h ?? m[3] }
    }
  }
  return { width: w, height: h }
}
