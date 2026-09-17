/**
 * 媒体被动模式工具 —— LLM 根据用户提问**主动**取文件。
 *
 * 与主动模式（collect.js 自动随消息收集）互补：用户没附带文件、但问题指向某个文件时，
 * 模型可调用这些工具去群里 / 聊天记录 / 本次会话已收集的附件里取。
 *
 * 工具通过 ctx 读取运行时（ctx.e = Yunzai 事件，ctx.bot = Bot 句柄，ctx.media = 本次主动收集的附件），
 * 因此工具可在 buildRuntime 一次性注册，跨会话复用，无需每条消息重建。
 *
 * 三个工具：
 *  - list_group_files（group_manage）列出群文件
 *  - get_group_file  （group_manage）按名称/fid 下载群文件 → 文本类返回内容、二进制返回元信息
 *  - read_attachment （query）      读取本次会话已主动收集的附件
 */

import fs from 'node:fs'
import path from 'node:path'
import Config from '../../utils/Config.js'
import { resolveMedia, isTextLike } from './resolve.js'
import { excelBufferToText } from '../document/excel.js'

const TEMP_DIR = () => Config.path.temp

/** 把二进制办公文档落到临时文件，返回路径（供 read_excel/read_pdf 等工具消费） */
function writeTempFile(mf) {
  fs.mkdirSync(TEMP_DIR(), { recursive: true })
  let ext = mf.ext || path.extname(mf.name || '') || '.bin'
  if (!ext.startsWith('.')) ext = `.${ext}`
  const fname = `att_${Date.now().toString(36)}${ext}`
  const p = path.join(TEMP_DIR(), fname)
  fs.writeFileSync(p, mf.buffer)
  return p
}

/**
 * 解析办公文档类附件（xlsx/csv/pdf/docx）→ 落盘 + 直接返回可读内容/路径。
 * 问题3：用户发 Excel 时让模型一步拿到表格文本，无需再链式调 read_excel（也不再有"读不了"）。
 * @returns {Promise<object|null>} 解析结果；非办公文档返回 null（交由上层走默认二进制分支）
 */
async function parseOfficeDoc(mf) {
  const ext = (mf.ext || path.extname(mf.name || '') || '').toLowerCase()
  const mime = (mf.mime || '').toLowerCase()
  const isXlsx = ext === '.xlsx' || ext === '.xls' || mime.includes('spreadsheet')
  const isPdf = ext === '.pdf' || mime === 'application/pdf'
  const isDocx = ext === '.docx' || ext === '.doc' || mime.includes('wordprocessing') || mime.includes('msword') || mime.includes('officedocument.wordprocessing')
  if (!isXlsx && !isPdf && !isDocx) return null
  let p
  try { p = writeTempFile(mf) } catch (e) { return { name: mf.name, mime: mf.mime, error: `落盘失败：${e?.message || e}` } }
  const base = { name: mf.name, mime: mf.mime, size: mf.bytes, path: p }
  if (isXlsx) {
    try {
      const out = await excelBufferToText(mf.buffer, { maxRows: 50 })
      return out.error ? { ...base, ...out } : { ...base, ...out }
    } catch (e) {
      return { ...base, error: `Excel 解析失败：${e?.message || e}（文件路径 ${p}，可改用 read_excel 重试）` }
    }
  }
  if (isPdf) {
    return { ...base, note: 'PDF 已落盘到上述 path，可调用 read_pdf 工具按路径读取文本与页面图片。' }
  }
  return { ...base, note: 'Word 文档已落盘到上述 path；暂无内置 docx 文本解析器（表格类可转 xlsx 后再用 read_excel）。' }
}

function noFs(ctx) {
  return { error: '当前会话不支持群文件操作（需在群内且协议端提供 fs.ls/download）' }
}

/** 单页文本窗口上限（字符）：默认每次返回 6000，模型可用 limit 放大到 12000。
 *  resultCap 必须大于单页最坏 JSON 体量（转义后约 2×limit + 信封），否则会被二次截断。 */
const TEXT_CHUNK_DEFAULT = 6000
const TEXT_CHUNK_MAX = 12000
const TEXT_RESULT_CAP = 26000

/**
 * 文本类附件分页读取：大文件不再静默截断，而是返回一段窗口 + nextOffset，
 * 模型据此继续按 offset 拉取直到读完整份，每页长度受 limit 约束以免撑爆上下文。
 * 小文件（一页读完）行为与旧版一致：直接给全文，不带分页字段。
 */
function readTextChunk(mf, params = {}) {
  const text = Buffer.isBuffer(mf.buffer) ? mf.buffer.toString('utf8') : String(mf.buffer || '')
  const total = text.length
  const offset = Math.max(0, Math.min(Number(params.offset) || 0, total))
  const limit = Math.min(Math.max(1, Number(params.limit) || TEXT_CHUNK_DEFAULT), TEXT_CHUNK_MAX)
  const content = text.slice(offset, offset + limit)
  const nextOffset = offset + content.length
  const out = { name: mf.name, size: mf.bytes, mime: mf.mime, content }
  if (nextOffset < total) {
    out.total = total
    out.offset = offset
    out.nextOffset = nextOffset
    out.note = `文件较大（共 ${total} 字符），已分页返回 offset ${offset}~${nextOffset}。继续读取请再调用本工具并传 offset=${nextOffset}（可用 limit 调整每页长度，最大 ${TEXT_CHUNK_MAX}）。`
  }
  return out
}

function pickGroup(ctx) {
  return ctx?.e?.group || ctx?.bot?.pickGroup?.(ctx?.e?.group_id) || null
}

/** 归一化群文件列表项（OneBot 各端字段不一） */
function normFsItem(it) {
  return {
    name: it.file_name || it.name || it.fileName || null,
    fid: it.file_id || it.id || it.fid || null,
    busid: it.busid ?? null,
    size: it.file_size || it.size ? Number(it.file_size || it.size) : null,
    isDir: !!(it.folder || it.is_dir || it.type === 'folder'),
  }
}

export const listGroupFilesTool = {
  name: 'list_group_files',
  description: '列出当前 QQ 群的群文件。用户问"群里那个文件"/"群文件有哪些"时调用。返回文件名/大小/fid。',
  category: 'group_manage',
  parameters: {
    type: 'object',
    properties: {
      folder: { type: 'string', description: '可选：子文件夹 id（默认根目录）' },
    },
  },
  async execute(params, ctx) {
    const g = pickGroup(ctx)
    const fs = g?.fs
    if (!fs?.ls) return noFs(ctx)
    let raw
    try { raw = await fs.ls(params.folder || undefined) } catch (e) { return { error: `列群文件失败：${e?.message || e}` } }
    const data = (raw?.files || raw?.fileList || [].concat(raw || [])).map(normFsItem).filter((x) => x.name || x.fid)
    const withUrl = raw?.url || raw ? data : data
    return { count: withUrl.length, files: withUrl.slice(0, 50) }
  },
}

export const getGroupFileTool = {
  name: 'get_group_file',
  description: '下载并读取群文件内容。按 name（文件名，模糊匹配）或 fid（群文件 id）定位。文本类（txt/md/csv/json/代码/文档等）返回内容——大文件自动分页，结果带 nextOffset，续读时再调用本工具并传 offset；图片/二进制返回元信息（当前工具结果不支持内联图片）。',
  category: 'group_manage',
  meta: { resultCap: TEXT_RESULT_CAP },
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '群文件名（与 fid 二选一）' },
      fid: { type: 'string', description: '群文件 id（与 name 二选一）' },
      offset: { type: 'integer', description: '可选：文本类起始字符偏移（默认 0；读大文件时用上一页返回的 nextOffset）' },
      limit: { type: 'integer', description: '可选：本次返回的最大字符数（默认 6000，最大 12000）' },
    },
  },
  async execute(params, ctx) {
    const g = pickGroup(ctx)
    const fs = g?.fs
    if (!fs?.ls || !fs.download) return noFs(ctx)
    let fid = params.fid || null
    let busid = null
    let name = params.name || null
    if (!fid) {
      if (!name) return { error: '需提供 name 或 fid' }
      let list
      try { list = await fs.ls() } catch (e) { return { error: `列群文件失败：${e?.message || e}` } }
      const items = (list?.files || [].concat(list || [])).map(normFsItem)
      const hit = items.find((it) => it.name === name) || items.find((it) => it.name?.includes(name))
      if (!hit) return { error: `群文件未找到：${name}` }
      fid = hit.fid
      busid = hit.busid
      name = hit.name
    }
    // 取下载链接
    let url
    try { url = (await fs.download(fid, busid))?.url } catch (e) { return { error: `取群文件链接失败：${e?.message || e}` } }
    if (!url) return { error: '未能获取群文件下载链接' }
    const mf = { name: name || fid, url, fid, busid, kind: 'file' }
    await resolveMedia(mf, { bot: ctx?.bot, fetcher: ctx?.fetcher })
    if (mf.resolveError || !mf.buffer) return { name: mf.name, url, error: `下载失败：${mf.resolveError || '未知'}` }
    if (isTextLike(mf.mime)) return readTextChunk(mf, params)
    return { name: mf.name, size: mf.bytes, mime: mf.mime, note: '非文本文件，工具结果不支持内联展示；如需识别请让用户直接发送该文件。' }
  },
}

export const readAttachmentTool = {
  name: 'read_attachment',
  description: '读取本次对话用户已发送（被自动收集）的附件内容。文本类（txt/csv/json/代码等）返回内容——大文件自动分页，结果带 nextOffset，续读时再调用本工具并传 offset；Excel(.xlsx/.xls) 直接解析为表格文本；PDF/Word 落盘后返回路径（可再调 read_pdf）。何时用：用户发送了文件让你查看/分析/统计时，优先用本工具（无需知道文件路径）。图片已在对话上下文中随消息发送，通常无需再读。',
  category: 'query',
  meta: { summary: '读取附件内容', resultCap: TEXT_RESULT_CAP },
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '附件名（模糊匹配，与 index 二选一）' },
      index: { type: 'integer', description: '附件序号（从 1 开始，与 name 二选一）' },
      offset: { type: 'integer', description: '可选：文本类起始字符偏移（默认 0；读大文件时用上一页返回的 nextOffset）' },
      limit: { type: 'integer', description: '可选：本次返回的最大字符数（默认 6000，最大 12000）' },
    },
  },
  async execute(params, ctx) {
    const active = Array.isArray(ctx?.media) ? ctx.media : ctx?.media?.active || []
    if (!active.length) return { error: '本次对话没有已收集的附件' }
    let mf
    if (params.name) mf = active.find((m) => m.name === params.name) || active.find((m) => m.name?.includes(params.name))
    else if (params.index != null) mf = active[(Number(params.index) || 1) - 1]
    else mf = active[0]
    if (!mf) return { error: '未找到匹配的附件', available: active.map((m) => m.name) }
    if (mf.resolveError || !mf.buffer) return { name: mf.name, error: `附件未就绪：${mf.resolveError || '未下载'}` }
    if (isTextLike(mf.mime)) return readTextChunk(mf, params)
    // 办公文档（xlsx/pdf/docx）：落盘 + 解析（问题3）
    const parsed = await parseOfficeDoc(mf)
    if (parsed) return parsed
    return { name: mf.name, size: mf.bytes, mime: mf.mime, source: mf.source, note: '图片/二进制附件已随消息进入上下文，无需重复读取。' }
  },
}

/** 一次性注册用：返回三个被动工具数组（供 ToolRegistry.register(...tools)） */
export function makeMediaTools() {
  return [listGroupFilesTool, getGroupFileTool, readAttachmentTool]
}
