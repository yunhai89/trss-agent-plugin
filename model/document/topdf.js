/**
 * file_to_pdf 工具 —— 任意文件转 PDF 并发送到聊天。
 *
 * 引擎（按可用性与类型择优）：
 *  1. LibreOffice（soffice --headless --convert-to pdf）：万能且保真，docx/xlsx/pptx/odt
 *     /图片/文本 等全吃。需系统安装（容器内 apt-get install -y libreoffice）。
 *  2. renderPdf（puppeteer，已就绪，优先系统 Chromium）：图片/文本/markdown/html/xlsx
 *     → 渲染 HTML → 打印 PDF。无需系统依赖。
 *  3. docx/pptx 等无 LibreOffice 时：明确报错引导安装（纯 JS 无法保真转换）。
 *
 * 执行面（2025-10 变更）：显式选择 E2B（agent.sandbox.mode=e2b）后，LibreOffice 转换**在会话沙箱内执行**
 * （输入上传 → soffice → 产物拉回）；沙箱模板缺 soffice 时：可走纯 JS 的类型照旧在宿主渲染（非 shell），
 * docx/pptx 等则明确报错提示装模板，绝不在宿主跑 soffice。mode=off 时保持旧的宿主路径。
 *
 * 输入：path（本地路径）或 已发送的附件（name/index，从 ctx.media 取并落临时文件）。
 * 不造轮子：复用 renderPdf、excelBufferToText、buildHtml/mdToHtml。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import Config from '../../utils/Config.js'
import Log from '../../utils/Log.js'
import { renderPdf } from '../../apps/render.js'
import { buildHtml, mdToHtml } from '../render/index.js'
import { excelBufferToText } from './excel.js'
import { toFileSegment } from '../../utils/SendFile.js'
import { toolSandbox, sandboxSelected, openToolSession, runToolCommand, missingCommand, sandboxTmp, shellQuote } from '../sandbox/bridge.js'

const TEMP_DIR = () => Config.path.temp
const sofficeBin = () => Config.get().agent?.document?.soffice || 'soffice'

const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'])
const TEXT_EXTS = new Set(['txt', 'log', 'ini', 'conf', 'env', 'ts', 'js', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'sh', 'yaml', 'yml', 'json'])
let _sofficeMissing = false // 缓存：soffice 不存在则后续跳过，避免每次 ENOENT

function extOf(p) { return path.extname(p).slice(1).toLowerCase() }
function safeName(s) { return String(s || 'output').replace(path.extname(s || ''), '').replace(/[^\w一-龥-]/g, '_').slice(0, 60) }
function tmpPdf(base) { fs.mkdirSync(TEMP_DIR(), { recursive: true }); return path.join(TEMP_DIR(), `${safeName(base)}_${Date.now().toString(36)}.pdf`) }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

/** 解析输入：path 或已发送附件（落临时文件） */
function resolveInput(ctx, p) {
  if (p.path && fs.existsSync(p.path)) return { path: p.path, name: path.basename(p.path) }
  const active = Array.isArray(ctx?.media) ? ctx.media : ctx?.media?.active || []
  if (!active.length) return { error: '未找到文件：请提供 path，或先发送文件后引用' }
  let mf
  if (p.name) mf = active.find((m) => m.name === p.name) || active.find((m) => m.name?.includes(p.name))
  else if (p.index != null) mf = active[(Number(p.index) || 1) - 1]
  else mf = active[0]
  if (!mf) return { error: '未找到匹配的附件', available: active.map((m) => m.name) }
  if (!mf.buffer) return { error: `附件未就绪：${mf.resolveError || '未下载'}` }
  const ext = mf.ext ? (mf.ext.startsWith('.') ? mf.ext : `.${mf.ext}`) : path.extname(mf.name || '')
  const tp = path.join(TEMP_DIR(), `in_${Date.now().toString(36)}${ext || '.bin'}`)
  fs.mkdirSync(TEMP_DIR(), { recursive: true })
  fs.writeFileSync(tp, mf.buffer)
  return { path: tp, name: mf.name }
}

/** 调 soffice 转 pdf（宿主档）；返回 {path} 或 {error, missing} */
function runSoffice(input, outDir) {
  return new Promise((resolve) => {
    execFile(sofficeBin(), ['--headless', '--convert-to', 'pdf', '--outdir', outDir, input], { timeout: 120000 }, (e) => {
      if (e) {
        const missing = /ENOENT|not found/i.test(e.message)
        if (missing) _sofficeMissing = true
        return resolve({ error: e.message, missing })
      }
      const out = path.join(outDir, path.basename(input, path.extname(input)) + '.pdf')
      resolve(fs.existsSync(out) ? { path: out } : { error: 'soffice 未产出 PDF' })
    })
  })
}

/**
 * 沙箱档：上传输入 → 沙箱内 soffice 转 PDF → 流式拉回宿主临时目录。
 * 沙箱内输入名固定为 in<ext>，产物即 in.pdf（可预测，无需依赖 soffice 的命名细节）。
 * @param {{signal?:AbortSignal, outPath?:string}} [opt] outPath 缺省按 tmpPdf 规则落到插件临时目录（测试可注入）
 * @returns {Promise<{path:string}|{error:string, missing?:string, sandbox?:boolean}>}
 */
export async function runSofficeInSandbox(box, hostPath, { signal = null, outPath = null } = {}) {
  const dir = sandboxTmp('topdf')
  const ext = path.extname(hostPath) || '.bin'
  const remoteIn = `${dir}/in${ext}`
  const remoteOut = `${dir}/in.pdf`
  const sess = await openToolSession(box, { purpose: 'tool:file_to_pdf' })
  // 先探测（1 条廉价命令）：缺 soffice 时不必上传大文件
  const probe = await runToolCommand(box, sess, 'command -v soffice >/dev/null 2>&1', { timeoutMs: 20000, maxOutput: 500, label: 'file_to_pdf:probe' })
  if (probe.limited) return { error: probe.error }
  if (!probe.ok) {
    return {
      error: '沙箱内没有 `soffice`（LibreOffice）。请把它装进 agent.sandbox.template 指向的 E2B 模板后重试'
        + '（沙箱执行面已显式选择 e2b，不会回落宿主执行）。',
      missing: 'soffice', sandbox: true,
    }
  }
  await sess.upload(hostPath, remoteIn)
  const cmd = `soffice --headless --convert-to pdf --outdir ${shellQuote(dir)} ${shellQuote(remoteIn)}`
  const r = await runToolCommand(box, sess, cmd, { timeoutMs: 120000, maxOutput: 4000, signal, label: 'file_to_pdf' })
  if (r.limited) return { error: r.error }
  const miss = missingCommand('soffice', r, 'file_to_pdf')
  if (miss) return { ...miss, sandbox: true }
  if (r.timedOut) return { error: '转换超时（沙箱内 soffice >120s）', sandbox: true }
  if (r.sandboxError || r.error || !r.ok) {
    return { error: `转换失败（沙箱内 soffice）：${String(r.stderr || '').trim().slice(-200) || '未知原因'}`, sandbox: true }
  }
  const out = outPath || tmpPdf(path.basename(hostPath))
  try {
    await sess.downloadTo(remoteOut, out, { signal })
  } catch (e) {
    return { error: `拉回 PDF 失败：${e?.message || e}`, sandbox: true }
  }
  return { path: out, sandbox: true }
}

/** csv 文本 → markdown 表格（首行作表头） */
function csvToMd(text) {
  const rows = String(text || '').split(/\r?\n/).filter((l) => l.trim())
  if (!rows.length) return ''
  const split = (r) => r.split(',').map((c) => c.trim())
  const head = split(rows[0])
  const body = rows.slice(1).map(split)
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

/** 按 ext 把文件内容转成 inner HTML（供 buildHtml 包裹后 renderPdf） */
async function toInnerHtml(inputPath, ext) {
  if (IMG_EXTS.has(ext)) {
    const buf = fs.readFileSync(inputPath)
    const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`
    return `<img style="max-width:100%;height:auto;display:block;margin:0 auto" src="data:${mime};base64,${buf.toString('base64')}">`
  }
  if (ext === 'md') return await mdToHtml(fs.readFileSync(inputPath, 'utf8'))
  if (ext === 'html' || ext === 'htm') return fs.readFileSync(inputPath, 'utf8')
  if (ext === 'xlsx' || ext === 'xls') {
    const out = await excelBufferToText(fs.readFileSync(inputPath), { maxRows: 200 })
    if (out.error) throw new Error(out.error)
    return await mdToHtml(out.text || '')
  }
  if (ext === 'csv') return await mdToHtml(csvToMd(fs.readFileSync(inputPath, 'utf8')))
  // 纯文本类
  const txt = fs.readFileSync(inputPath, 'utf8')
  return `<pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.6">${esc(txt)}</pre>`
}

/** 主转换：inputPath → 产出 PDF 路径（ctx 用于解析沙箱执行面） */
async function convert(inputPath, baseName, ctx = {}) {
  const ext = extOf(inputPath)
  // PDF 直接透传
  if (ext === 'pdf') { const out = tmpPdf(baseName); fs.copyFileSync(inputPath, out); return { path: out, engine: 'passthrough' } }

  // 1) LibreOffice：沙箱档（显式选择 e2b）优先；否则宿主档
  const box = toolSandbox(ctx)
  let sandboxErr = null
  if (box) {
    const out = tmpPdf(baseName)
    const r = await runSofficeInSandbox(box, inputPath, { outPath: out, signal: ctx?.signal || null }).catch((e) => ({ error: `沙箱执行失败：${e?.message || e}`, sandbox: true }))
    if (r.path) return { path: out, engine: 'libreoffice-sandbox' }
    sandboxErr = r
    if (!r.missing) Log.warn('[topdf] 沙箱内 soffice 转换失败，回退纯 JS', r.error)
    // 缺 soffice：可走纯 JS 的类型继续；docx/pptx 等下面会给模板提示
  } else if (!sandboxSelected(ctx) && !_sofficeMissing) {
    // 宿主档（mode=off）：行为与旧版一致（宿主 soffice，失败回退纯 JS）
    const r = await runSoffice(inputPath, TEMP_DIR())
    if (r.path) { const out = tmpPdf(baseName); fs.copyFileSync(r.path, out); return { path: out, engine: 'libreoffice' } }
    if (!r.missing) Log.warn('[topdf] soffice 转换失败，回退纯 JS', r.error)
  }

  // 2) 纯 JS（renderPdf / puppeteer）：图片/文本/markdown/html/xlsx/csv——宿主渲染，非 shell，任何模式下可用
  if (IMG_EXTS.has(ext) || ['md', 'html', 'htm', 'xlsx', 'xls', 'csv', ...TEXT_EXTS].includes(ext)) {
    const inner = await toInnerHtml(inputPath, ext)
    const html = buildHtml({ title: safeName(baseName), bodyHtml: inner })
    const out = tmpPdf(baseName)
    const pdfPath = await renderPdf(html, { path: out })
    if (pdfPath) return { path: pdfPath, engine: 'puppeteer' }
    return { error: _sofficeMissing ? '渲染 PDF 失败（puppeteer/Chromium 不可用）；docx/pptx 等需装 LibreOffice' : '渲染 PDF 失败' }
  }

  // 3) 不支持（docx/pptx/odt 等需 LibreOffice）
  if (box) {
    if (sandboxErr && !sandboxErr.missing) return { error: sandboxErr.error }
    return {
      error: `此类型(${ext || '未知'})转 PDF 需沙箱模板安装 LibreOffice（soffice）：请把它装进 agent.sandbox.template `
        + '指向的 E2B 模板后重试（显式选择 e2b 时不在宿主执行 soffice）。',
    }
  }
  if (sandboxSelected(ctx)) {
    return {
      error: `沙箱未就绪，已拒绝在宿主执行 soffice：此类型(${ext || '未知'})转 PDF 需要 LibreOffice。`
        + '请修复 E2B 沙箱配置（agent.sandbox）后重试，或改用图片/markdown/文本等纯 JS 可转换的类型。',
    }
  }
  return {
    error: _sofficeMissing
      ? `此类型(${ext || '未知'})转 PDF 需安装 LibreOffice：在容器内 apt-get install -y libreoffice，并在配置 agent.document.soffice 指定 soffice 路径`
      : `转换失败：${ext || '未知'} 不支持`,
  }
}

export const fileToPdfTool = {
  name: 'file_to_pdf',
  description: '把任意文件转成 PDF 并发送到聊天。支持图片(png/jpg/webp/gif)、文本/markdown/html、Excel(xlsx/csv)；docx/pptx 等需装 LibreOffice(更保真；启用 E2B 沙箱时转换在沙箱内执行，需沙箱模板含 soffice)。输入可用 path 或已发送的附件(name/index)。',
  category: 'query',
  meta: { summary: '文件转 PDF', interactive: true },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '本地文件路径（与 name/index 二选一）' },
      name: { type: 'string', description: '已发送的附件名（模糊匹配，自动落盘后转换）' },
      index: { type: 'integer', description: '附件序号(从1开始，与 name 二选一)' },
    },
  },
  async execute(p, ctx) {
    const input = resolveInput(ctx, p)
    if (input.error) return { error: input.error }
    const base = p.name || path.basename(input.path)
    let res
    try { res = await convert(input.path, base, ctx) }
    catch (e) { return { error: `转换失败：${e?.message || e}` } }
    if (res.error) return res
    // 发送 PDF（创建即发送，无需再调 send_file）
    let sent = false
    if (ctx?.e?.reply) {
      try { await ctx.e.reply(toFileSegment(res.path, `${safeName(base)}.pdf`)); sent = true } catch (e) { Log.warn('[topdf] 发送 PDF 失败', e?.message || e) }
    }
    return {
      ok: true, engine: res.engine, path: res.path, sent,
      note: sent ? 'PDF 已发送到聊天' : 'PDF 已生成但发送失败（可用 send_file 重发）',
      ...(p.path && input.path !== p.path ? { tempInput: input.path } : {}),
    }
  },
}
