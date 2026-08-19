/**
 * DiagramService —— diagram_render 工具的渲染编排。
 *
 * 管线：validate/canonicalize → 缓存(singleflight) → 确定性编译(D2|Mermaid) → 渲染(自托管 Kroki | 本地 beautiful-mermaid)
 *       → SVG 安全检查 → resvg 高清 PNG → 插件临时目录落盘 → 结构化引用返回。
 *
 * 失败/回退链：Kroki 失败 →（fallbackRenderer: beautiful-mermaid 时）本地渲染一次 → 结构化失败。
 *   渲染失败不重画、不删节点伪装成功；超时/取消终态明确；取消后不写缓存不落盘不发送。
 *
 * 超时：service 总预算 timeoutMs（覆盖编译+HTTP+栅格化）与 Agent AbortSignal 组合后逐阶段下发。
 * 事件：diagram_validate / diagram_render_start / diagram_compile / diagram_fallback / diagram_svg_validate /
 *       diagram_svg_rejected / diagram_render_end / diagram_render_error / diagram_cancelled（+ Kroki 内部事件）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { validateSpec } from './spec.js'
import { compileD2 } from './compile-d2.js'
import { compileMermaid } from './compile-mermaid.js'
import { THEMES, THEME_NAMES, resolveTheme, THEME_MAP_VERSION, DEFAULT_THEME } from './themes.js'
import { checkSvg } from './svg-check.js'
import { expandSvgCss } from './svg-css.js'
import { KrokiClient } from './kroki.js'
import { rasterizeSvg, resolveFontFiles, DEFAULT_FONT_FAMILY } from './raster.js'
import { TempDir } from './tempdir.js'
import { DiagramCache } from './cache.js'

/** 各组件版本因子（任何改动必须 bump 使缓存失效） */
export const VERSIONS = {
  compilerD2: 'd2c-1',
  compilerMermaid: 'mmc-1',
  themeMap: `t${THEME_MAP_VERSION}`,
  svgPost: 'spc-1',
}

/** D2 layout 类型覆盖表（代码内固定；sequence 用轻量 dagre，复杂分组/ER 用 elk） */
const LAYOUT_BY_TYPE = { sequence: 'dagre', er: 'elk', class: 'elk', architecture: 'elk', mindmap: 'elk', flowchart: null, state: null }

const fail = (errorClass, message, extra = {}) => ({ ok: false, errorClass, message, retryable: false, ...extra })

export class DiagramService {
  /** @type {null|{resvg:string,bm:string,fonts:string,fontFamily:string}} */
  #versions = null
  /**
   * @param {object} cfg agent.diagram 配置块
   * @param {object} deps { logger(info 级), devLog(会话级事件), pluginRoot }
   */
  constructor(cfg = {}, { logger = () => {}, devLog = null } = {}) {
    // kroki 子块先深合并（外层 ...cfg 整体覆盖会抹掉子块默认值——allowedDiagramTypes 曾因此变 undefined）
    const krokiCfg = {
      enabled: true,
      endpoint: 'http://127.0.0.1:8000',
      deploymentMode: 'self-hosted-only',
      allowPublicEndpoint: false,
      allowedDiagramTypes: ['d2'],
      connectTimeoutMs: 2000,
      requestTimeoutMs: 12000,
      maxSourceBytes: 131072,
      maxResponseBytes: 4194304,
      maxConcurrency: 2,
      circuitBreaker: { enabled: true, failureThreshold: 3, cooldownMs: 30000 },
      d2: { layout: 'elk' },
      imageTag: '', // 管理员声明部署的 Kroki 镜像版本（进缓存 key；升级镜像必须更新）
      ...(cfg.kroki || {}),
    }
    this.cfg = {
      enabled: true,
      renderer: 'kroki',
      fallbackRenderer: 'none',
      defaultTheme: DEFAULT_THEME,
      defaultFormat: 'png',
      timeoutMs: 15000,
      targetWidth: 1600,
      maxNodes: 50, maxEdges: 100, maxWidth: 2000, maxHeight: 5000,
      maxPixels: 10_000_000, maxOutputBytes: 8_388_608,
      tempTtlMinutes: 30,
      ...cfg,
      kroki: krokiCfg,
    }
    this.logger = logger
    this.devLog = devLog
    const emit = (e) => this.#emit(e)
    this.kroki = this.cfg.renderer === 'kroki' && this.cfg.kroki.enabled !== false
      ? new KrokiClient({ ...this.cfg.kroki, onEvent: emit })
      : null
    this.temp = new TempDir({ ttlMinutes: this.cfg.tempTtlMinutes, logger })
    this.temp.startSweep()
    this.cache = new DiagramCache({})
  }

  /** 渲染器版本因子（懒加载依赖包版本） */
  #versionFactors() {
    if (this.#versions) return this.#versions
    let resvg = 'unknown'; let bm = 'none'
    try { resvg = JSON.parse(fs.readFileSync(new URL('../../node_modules/@resvg/resvg-js/package.json', import.meta.url), 'utf8')).version } catch { }
    try { bm = JSON.parse(fs.readFileSync(new URL('../../node_modules/beautiful-mermaid/package.json', import.meta.url), 'utf8')).version } catch { }
    const fontFiles = resolveFontFiles()
    const fontFingerprint = fontFiles.map((p) => {
      try { const st = fs.statSync(p); return `${path.basename(p)}:${st.size}` } catch { return path.basename(p) }
    }).join(',') || 'missing'
    this.#versions = { resvg, bm, fonts: fontFingerprint, fontFamily: DEFAULT_FONT_FAMILY }
    return this.#versions
  }

  #emit(e) {
    try {
      const lvl = ['diagram_render_error', 'diagram_cancelled', 'diagram_svg_rejected'].includes(e.event) ? 'warn' : 'info'
      this.logger(lvl, `[diagram] ${e.event}`, ...Object.entries(e).filter(([k]) => k !== 'event').map(([k, v]) => `${k}=${v}`))
      this.devLog?.('diagram', e)
    } catch { /* 事件失败不影响渲染 */ }
  }

  /**
   * 主入口：raw spec（LLM 提交）→ 结构化结果。
   * @param {object} raw
   * @param {object} opts { signal(AbortSignal), toolCallId, traceId }
   */
  async render(raw, { signal = null, toolCallId = '', traceId = '' } = {}) {
    const t0 = Date.now()
    const base = { toolCallId, traceId }

    // 1) 校验 + 规范化
    const v = validateSpec(raw, { maxNodes: this.cfg.maxNodes, maxEdges: this.cfg.maxEdges })
    this.#emit({ event: 'diagram_validate', ...base, ok: v.ok, errorClass: v.ok ? undefined : v.errorClass, field: v.field })
    if (!v.ok) return v
    const spec = v.spec
    if (this.cfg.enabled === false) return fail('renderer_unavailable', '示意图工具已被配置禁用')

    // 2) 组合取消信号：Agent signal ∨ service 总预算
    let combined = signal
    if (this.cfg.timeoutMs > 0) {
      combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.cfg.timeoutMs)]) : AbortSignal.timeout(this.cfg.timeoutMs)
    }

    // 3) 引擎与主题解析
    const wantsSvgFile = spec.output === 'svg'
    const format = wantsSvgFile ? 'svg' : this.cfg.defaultFormat
    const engineOrder = this.#engineOrder()
    const themeRes = resolveTheme(spec.theme, { engine: engineOrder[0] === 'kroki' ? 'd2' : 'local' })

    const limits = {
      targetWidth: this.cfg.targetWidth, maxWidth: this.cfg.maxWidth, maxHeight: this.cfg.maxHeight,
      maxPixels: this.cfg.maxPixels, maxOutputBytes: this.cfg.maxOutputBytes,
    }
    const factors = {
      ...VERSIONS, ...this.#versionFactors(),
      renderer: engineOrder.join('|'),
      krokiEndpoint: this.kroki?.endpointId || 'none', krokiImage: this.cfg.kroki.imageTag || 'unspecified',
      d2Layout: this.cfg.kroki.d2?.layout || 'elk',
      themeKey: themeRes.key, themeMap: VERSIONS.themeMap, format, targetWidth: limits.targetWidth,
    }
    const key = DiagramCache.keyOf({ canonicalSpec: spec, factors })
    const baseEvt = {
      ...base, type: spec.type, theme: themeRes.key,
      nodeCount: spec.type === 'sequence' ? spec.participants.length : spec.nodes.length,
      edgeCount: spec.type === 'sequence' ? spec.messages.length : (spec.edges || []).length,
      specHash: v.specHash, cacheKey: key,
    }

    // 4) 缓存（文件仍在盘上才命中）
    const hit = this.cache.get(key, (r) => this.temp.exists(path.basename(r.path)))
    if (hit) {
      this.#emit({ event: 'diagram_render_end', ...baseEvt, engine: hit.engine, cacheHit: true, durationMs: Date.now() - t0, width: hit.width, height: hit.height, bytes: hit.bytes })
      return { ...hit, cacheHit: true, durationMs: Date.now() - t0 }
    }

    // 5) singleflight 渲染
    this.#emit({ event: 'diagram_render_start', ...baseEvt })
    const result = await this.cache.run(key, () => this.#renderWithEngines({ spec, themeRes, format, limits, combined, baseEvt }))
    if (!result.ok) {
      this.#emit({
        event: result.errorClass === 'cancelled' ? 'diagram_cancelled' : 'diagram_render_error',
        ...baseEvt, engine: result.engine, errorClass: result.errorClass, fallbackReason: result.fallbackReason, durationMs: Date.now() - t0,
      })
      return result
    }
    this.#emit({
      event: 'diagram_render_end', ...baseEvt, engine: result.engine, cacheHit: false,
      durationMs: Date.now() - t0, width: result.width, height: result.height, bytes: result.bytes,
    })
    this.cache.set(key, result)
    return result
  }

  /** 引擎顺序：renderer → fallbackRenderer（none = 无回退） */
  #engineOrder() {
    const order = []
    if (this.cfg.renderer === 'kroki' && this.kroki) order.push('kroki')
    if (this.cfg.fallbackRenderer === 'beautiful-mermaid') order.push('beautiful-mermaid')
    return order.length ? order : ['none']
  }

  /** 逐引擎尝试（每个引擎至多一次；失败换下一个；全失败返回最后一个错误） */
  async #renderWithEngines({ spec, format, limits, combined, baseEvt }) {
    const engines = this.#engineOrder()
    let lastErr = fail('renderer_unavailable', '无可用渲染引擎（renderer/kroki.enabled/fallbackRenderer 配置组合为空）')
    for (let i = 0; i < engines.length; i++) {
      if (combined?.aborted) return { ...fail('cancelled', '渲染被取消'), engine: engines[i] }
      const engine = engines[i]
      const r = engine === 'kroki'
        ? await this.#renderKroki({ spec, format, limits, signal: combined, baseEvt })
        : await this.#renderLocalMermaid({ spec, format, limits, signal: combined, baseEvt })
      if (r.ok) return r
      lastErr = r
      if (r.errorClass === 'cancelled') return r // 取消不回退
      if (i < engines.length - 1) {
        this.#emit({ event: 'diagram_fallback', ...baseEvt, engine, fallbackReason: r.errorClass, next: engines[i + 1] })
      }
    }
    return lastErr
  }

  /** 引擎 A：确定性 D2 编译 → 自托管 Kroki POST → SVG 检查 → 栅格化 */
  async #renderKroki({ spec, format, limits, signal, baseEvt }) {
    const themeRes = resolveTheme(spec.theme, { engine: 'd2' })
    const theme = themeRes.theme
    const layout = LAYOUT_BY_TYPE[spec.type] || this.cfg.kroki.d2?.layout || 'elk'
    const { dsl } = compileD2(spec, theme)
    this.#emit({ event: 'diagram_compile', ...baseEvt, engine: 'kroki-d2', dslBytes: Buffer.byteLength(dsl) })
    const allowed = this.cfg.kroki.allowedDiagramTypes
    const diagramType = allowed.includes('d2') ? 'd2' : null
    if (!diagramType) return fail('renderer_unavailable', 'Kroki allowedDiagramTypes 未启用 d2')

    const options = { layout, theme: theme.d2.theme }
    if (theme.d2.sketch) options['sketch-mode'] = true

    const r = await this.kroki.render({
      dsl, diagramType, options, specHash: baseEvt.specHash,
      agentSignal: signal, toolCallId: baseEvt.toolCallId,
    })
    if (!r.ok) return r

    const meta = await this.#acceptSvg(r.svg, { maxBytes: this.cfg.kroki.maxResponseBytes, engine: 'kroki-d2', baseEvt })
    if (!meta.ok) return meta
    return await this.#finalize({ svg: r.svg, svgW: meta.width, svgH: meta.height, spec, theme, format, limits, signal, engine: 'kroki-d2', baseEvt })
  }

  /** 引擎 B：确定性 Mermaid 编译 → 本地 beautiful-mermaid（零 DOM）→ 主题变量展开 → SVG 检查 → 栅格化 */
  async #renderLocalMermaid({ spec, format, limits, signal, baseEvt }) {
    const themeRes = resolveTheme(spec.theme, { engine: 'local' })
    const theme = themeRes.theme
    const compiled = compileMermaid(spec)
    if (compiled.unsupported) return fail('unsupported_type', compiled.unsupported)
    this.#emit({ event: 'diagram_compile', ...baseEvt, engine: 'beautiful-mermaid', dslBytes: Buffer.byteLength(compiled.dsl) })

    let bm
    try { bm = await import('beautiful-mermaid') } catch (e) {
      return fail('renderer_unavailable', `本地渲染依赖未安装（beautiful-mermaid）：${e?.message || e}`)
    }
    if (signal?.aborted) return fail('cancelled', '渲染被取消')
    let svg
    try { svg = bm.renderMermaidSVG(compiled.dsl) } catch (e) {
      return fail('render_failed', `本地 Mermaid 渲染失败：${String(e?.message || e).slice(0, 160)}`)
    }
    // 主题变量注入 + var()/color-mix 展开 + 外链字体剥除（resvg 不解析 CSS 变量）
    const { svg: expanded } = expandSvgCss(svg, {
      bg: theme.bg, fg: theme.fg, accent: theme.accent, line: theme.line, surface: theme.surface, border: theme.border,
    }, DEFAULT_FONT_FAMILY)

    const meta = await this.#acceptSvg(expanded, { maxBytes: this.cfg.kroki.maxResponseBytes, engine: 'beautiful-mermaid', baseEvt })
    if (!meta.ok) return meta
    return await this.#finalize({ svg: expanded, svgW: meta.width, svgH: meta.height, spec, theme, format, limits, signal, engine: 'beautiful-mermaid', baseEvt })
  }

  /** SVG 安全检查（两引擎共用；不可信输出） */
  async #acceptSvg(svg, { maxBytes, engine, baseEvt }) {
    this.#emit({ event: 'diagram_svg_validate', ...baseEvt, engine, bytes: Buffer.byteLength(svg || '') })
    const c = checkSvg(svg, { maxBytes })
    if (!c.ok) {
      this.#emit({ event: 'diagram_svg_rejected', ...baseEvt, engine, reason: c.reason, errorClass: c.errorClass })
      return fail(c.errorClass, `SVG 安全检查未通过：${c.reason}`)
    }
    return { ok: true, width: c.width, height: c.height }
  }

  /** 栅格化/落盘/摘要（取消检查在 rasterize 内部逐档进行） */
  async #finalize({ svg, svgW, svgH, spec, theme, format, limits, signal, engine, baseEvt }) {
    const specHash = baseEvt.specHash
    if (format === 'svg') {
      const buf = Buffer.from(svg, 'utf8')
      const name = `dg-${specHash}-${Buffer.from('sv').toString('hex')}.svg`
      if (signal?.aborted) return fail('cancelled', '渲染被取消（不落盘）')
      const p = this.temp.write(name, buf)
      return { ok: true, type: 'diagram', engine, format: 'svg', path: p, bytes: buf.length, title: spec.title, summary: summaryOf(spec), specHash }
    }
    const r = await rasterizeSvg(svg, { theme, svgW, svgH, signal, limits })
    if (!r.ok) return r
    if (signal?.aborted) return fail('cancelled', '渲染被取消（不落盘）')
    const name = `dg-${specHash}-${Buffer.from('pn').toString('hex')}.png`
    const p = this.temp.write(name, r.png)
    return {
      ok: true, type: 'diagram', engine, format: 'png', path: p,
      width: r.width, height: r.height, bytes: r.png.length,
      title: spec.title, summary: summaryOf(spec), specHash,
    }
  }

  stop() { this.temp.stopSweep() }
}

/** 结果摘要（给模型/日志的简短描述；不含路径） */
export function summaryOf(spec) {
  if (spec.type === 'sequence') return `已生成包含 ${spec.participants.length} 个参与者和 ${spec.messages.length} 条消息的时序图`
  const kind = { flowchart: '流程图', architecture: '架构图', state: '状态图', class: '类图', er: '关系图', mindmap: '思维导图' }[spec.type] || '示意图'
  const g = (spec.groups || []).length ? `、${spec.groups.length} 个分组` : ''
  return `已生成包含 ${spec.nodes.length} 个节点、${(spec.edges || []).length} 条连接${g}的${kind}`
}

export { validateSpec, compileD2, compileMermaid, checkSvg, expandSvgCss, THEMES, THEME_NAMES, resolveTheme }
