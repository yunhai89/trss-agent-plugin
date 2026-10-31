/**
 * read_pdf 工具 —— 读取 PDF：提取文本 + 渲染前 N 页为图片发送。
 *
 * 全部用 pdfjs-dist（文本用 getTextContent，图片用 canvas 渲染）。
 * @napi-rs/canvas 提供 Node 端 canvas（预编译，免系统依赖）。
 */

import fs from 'node:fs'
import { hostPathError } from './path-guard.js'

/** 单文件大小上限：pdfjs 会把整份文件读进内存，先挡超大文件（审计 A2） */
const MAX_PDF_BYTES = 64 * 1024 * 1024
/** 全文提取页数上限（正文只回传前 10000 字） */
const MAX_TEXT_PAGES = 200

export const readPdfTool = {
  name: 'read_pdf',
  description: '读取 PDF 文件：提取全文文本 + 渲染前几页为图片发送给用户。何时用：用户发了 PDF 让你查看内容、提取信息、总结时。',
  category: 'query',
  meta: { summary: '读取 PDF 文本+页面图', resultCap: 12000, effect: 'external', replay: 'never' },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'PDF 文件本地路径' },
      maxPages: { type: 'integer', description: '渲染为图片的最大页数（默认 5，上限 20）' },
    },
    required: ['path'],
  },
  async execute(params, ctx) {
    const p = String(params?.path || '').trim()
    if (!p) return { error: '请提供 PDF 文件路径' }
    // 越界路径（config.yaml/.env/data/logs 等）必须先拒：category=query 对任意群成员免审批
    const guard = hostPathError(p, { label: 'PDF 文件' })
    if (guard) return { error: guard }
    if (!fs.existsSync(p)) return { error: `文件不存在：${p}` }
    try {
      const st = fs.statSync(p)
      if (st.size > MAX_PDF_BYTES) return { error: `PDF 过大：${(st.size / 1048576).toFixed(1)}MB（上限 ${MAX_PDF_BYTES / 1048576}MB）` }
    } catch { /* stat 失败交给 readPdf 报错 */ }
    const maxPages = Math.min(20, Math.max(1, Number(params?.maxPages) || 5))
    try {
      return await readPdf(p, maxPages, ctx)
    } catch (e) {
      return { error: `PDF 读取失败：${e?.message || e}` }
    }
  },
}

/**
 * 仅提取 PDF 文本（不渲染、不发图）——供 web_crawl/knowledge 等抓取链路复用。
 * @param {Buffer|Uint8Array} input PDF 字节
 * @param {{maxPages?:number}} [opts] 最多提取页数（默认 200）
 * @returns {Promise<{pages:number, text:string}>}
 */
export async function extractPdfText(input, { maxPages = MAX_TEXT_PAGES } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || [])
  if (!bytes.length) throw new Error('PDF 内容为空')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 })
  const doc = await loadingTask.promise
  try {
    const numPages = doc.numPages
    const end = Math.min(numPages, Math.max(1, Number(maxPages) || MAX_TEXT_PAGES))
    const parts = []
    for (let i = 1; i <= end; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      const pageText = tc.items.map((item) => item.str || '').join(' ').trim()
      if (pageText) parts.push(pageText)
      await page.cleanup()
    }
    return { pages: numPages, text: parts.join('\n\n').trim() }
  } finally {
    await loadingTask.destroy()
  }
}

/** pdfjs-dist canvas factory（Node 端 @napi-rs/canvas） */
function makeFactory() {  // 延迟导入（首次使用时加载）
  return {
    async create() {
      const { createCanvas } = await import('@napi-rs/canvas')
      return {
        create(w, h) { const c = createCanvas(w, h); return { canvas: c, context: c.getContext('2d') } },
        reset(o, w, h) { o.canvas.width = w; o.canvas.height = h },
        destroy(o) { o.canvas.width = 0; o.canvas.height = 0 },
      }
    },
  }
}

async function readPdf(filePath, maxPages, ctx) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const factoryMaker = makeFactory()
  const factory = await factoryMaker.create()

  const data = new Uint8Array(fs.readFileSync(filePath))
  // 销毁必须走 loadingTask：pdfjs-dist v6 的 PDFDocumentProxy 只有 cleanup()/numPages，
  // 已移除 destroy()（v6 API：PDFDocumentLoadingTask.destroy(): Promise<void>）。
  // 曾调用 doc.destroy() → 每次读取都在末尾抛 TypeError，已提取的全文被整份丢弃。
  const loadingTask = pdfjs.getDocument({ data, canvasFactory: factory, isEvalSupported: false, verbosity: 0 })
  const doc = await loadingTask.promise
  const numPages = doc.numPages
  const renderCount = Math.min(maxPages, numPages)
  const seg = (typeof segment !== 'undefined' && segment) || null
  let fullText = ''
  let rendered = 0

  // 前 renderCount 页：提取文本 + 渲染为图片
  for (let i = 1; i <= renderCount; i++) {
    const page = await doc.getPage(i)
    // 文本
    const tc = await page.getTextContent()
    const pageText = tc.items.map((item) => item.str || '').join(' ')
    fullText += (fullText ? '\n\n' : '') + pageText
    // 渲染为图片
    const viewport = page.getViewport({ scale: 1.5 })
    const { canvas, context } = factory.create(viewport.width, viewport.height)
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, viewport.width, viewport.height)
    try {
      await page.render({ canvasContext: context, viewport, canvasFactory: factory }).promise
      if (seg) {
        const png = canvas.toBuffer('image/png')
        await ctx?.e?.reply(seg.image(`base64://${png.toString('base64')}`))
        rendered++
      }
    } catch { /* 单页渲染失败不影响整体 */ }
    await page.cleanup()
  }

  // 剩余页：仅提取文本（不渲染，省资源）；页数设上限——正文只回传前 10000 字（见下方 slice），
  // 扫完整本几百页 PDF 纯属浪费 CPU/内存（审计 A2 放大器）
  const textPageEnd = Math.min(numPages, renderCount + MAX_TEXT_PAGES)
  for (let i = renderCount + 1; i <= textPageEnd; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    fullText += '\n\n' + tc.items.map((item) => item.str || '').join(' ')
    await page.cleanup()
  }

  await loadingTask.destroy()
  return { pages: numPages, rendered, text: fullText.slice(0, 10000).trim() }
}
