/**
 * SVG → PNG 栅格化（@resvg/resvg-js）。
 *
 * - 字体：显式加载固定字体文件（仓库 resources/fonts 优先、系统 Noto CJK 回退），loadSystemFonts:false
 *   —— 渲染结果不随进程环境字体漂移；两者皆缺报 font_missing（不静默出方框）。
 * - 尺寸策略：目标宽 1600（2x 清晰度），按 SVG 原始宽高比计算；受 maxWidth/maxHeight/maxPixels 三重钳制。
 * - PNG 落盘前校验：文件头魔数、尺寸、字节数；超 maxOutputBytes 自动降宽重栅格化（最多 3 档），仍超报 output_too_large。
 * - 取消检查在入口：signal 已取消直接返回 cancelled，不产生任何文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** 候选字体文件（存在即用；全部缺失 → font_missing）。新增字体文件须带 OFL 许可文本（见 resources/fonts/LICENSE-NotoSansCJK.txt）。 */
export function resolveFontFiles(extraDirs = []) {
  const candidates = [
    path.join(PLUGIN_ROOT, 'resources/fonts/NotoSansCJK-Regular.ttc'), // 随仓库分发（OFL 1.1）
    path.join(PLUGIN_ROOT, 'resources/fonts/NotoSansSC-Regular.otf'),   // 管理员可自行放置单语版
    ...extraDirs,
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',           // 系统回退
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  ]
  return candidates.filter((p) => { try { return fs.statSync(p).isFile() } catch { return false } })
}

export const DEFAULT_FONT_FAMILY = 'Noto Sans CJK SC'

/** 目标尺寸计算（纯函数，供测试） */
export function computeTargetSize(svgW, svgH, { targetWidth = 1600, maxWidth = 2000, maxHeight = 5000, maxPixels = 10_000_000 } = {}) {
  if (!svgW || !svgH || svgW <= 0 || svgH <= 0) return { width: targetWidth, height: null }
  let scale = targetWidth / svgW
  if (svgW * scale > maxWidth) scale = maxWidth / svgW
  if (svgH * scale > maxHeight) scale = maxHeight / svgH
  if (svgW * scale * svgH * scale > maxPixels) scale = Math.sqrt(maxPixels / (svgW * svgH))
  const width = Math.max(1, Math.round(svgW * scale))
  const height = Math.max(1, Math.round(svgH * scale))
  return { width, height }
}

/**
 * SVG → PNG Buffer。
 * @returns {Promise<{ok:true,png:Buffer,width,height}|{ok:false,errorClass,message}>}
 */
export async function rasterizeSvg(svg, { theme, svgW, svgH, signal = null, limits = {} } = {}) {
  if (signal?.aborted) return { ok: false, errorClass: 'cancelled', message: '渲染被取消' }
  const { Resvg } = await import('@resvg/resvg-js')
  const fontFiles = resolveFontFiles(limits.fontDirs || [])
  if (!fontFiles.length) return { ok: false, errorClass: 'font_missing', message: '未找到可用的中文字体文件（resources/fonts/ 或系统 Noto CJK）' }

  const lim = {
    targetWidth: limits.targetWidth ?? 1600, maxWidth: limits.maxWidth ?? 2000,
    maxHeight: limits.maxHeight ?? 5000, maxPixels: limits.maxPixels ?? 10_000_000,
    maxOutputBytes: limits.maxOutputBytes ?? 8_388_608,
  }
  const target = computeTargetSize(svgW, svgH, lim)

  let width = target.width
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) return { ok: false, errorClass: 'cancelled', message: '渲染被取消' }
    let r
    try {
      r = new Resvg(svg, {
        fitTo: { mode: 'width', value: width },
        background: theme?.bg || '#FFFFFF',
        font: { fontFiles, loadSystemFonts: false, defaultFontFamily: DEFAULT_FONT_FAMILY },
      })
    } catch (e) {
      return { ok: false, errorClass: 'render_failed', message: `SVG 解析失败：${String(e?.message || e).slice(0, 160)}` }
    }
    let rendered
    try { rendered = r.render() } catch (e) {
      return { ok: false, errorClass: 'render_failed', message: `PNG 栅格化失败：${String(e?.message || e).slice(0, 160)}` }
    }
    const png = Buffer.from(rendered.asPng())
    // PNG 校验：魔数 + 尺寸（注意 resvg.width 是 SVG 原始尺寸，输出尺寸以 RenderedImage 为准）
    if (!(png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47)) {
      return { ok: false, errorClass: 'render_failed', message: 'PNG 文件头校验失败' }
    }
    const w = png.readUInt32BE(16); const h = png.readUInt32BE(20)
    if (w !== rendered.width || h !== rendered.height) return { ok: false, errorClass: 'render_failed', message: `PNG 尺寸异常（头 ${w}x${h}，渲染器 ${rendered.width}x${rendered.height}）` }
    if (png.length > lim.maxOutputBytes) {
      if (attempt === 3) return { ok: false, errorClass: 'output_too_large', message: `PNG ${png.length}B 超过上限 ${lim.maxOutputBytes}B（降采样 3 次后仍超）` }
      width = Math.max(400, Math.floor(width * 0.75))
      continue
    }
    return { ok: true, png, width: rendered.width, height: rendered.height }
  }
  return { ok: false, errorClass: 'render_failed', message: '栅格化循环异常退出' }
}

/** 目标输出路径（内容哈希命名；绝不使用用户标题） */
export function outputFileName(specHash, ext) {
  return `dg-${specHash}-${Buffer.from(String(ext)).toString('hex').slice(0, 2)}.${ext}`
}
