/**
 * Excel 工具 —— 创建（带样式）+ 读取（转表格文本）。
 * 用 exceljs 库（纯 JS，支持字体/颜色/边框/合并/条件格式/图片插入）。
 */

import fs from 'node:fs'
import path from 'node:path'
import Config from '../../utils/Config.js'
import { toFileSegment } from '../../utils/SendFile.js'
import { hostPathError } from './path-guard.js'

async function getExcelJS() {
  const m = await import('exceljs')
  return m.default || m
}

const TEMP_DIR = () => Config.path.temp

function thinBorder() {
  const s = { style: 'thin', color: { argb: 'FFCCCCCC' } }
  return { top: s, bottom: s, left: s, right: s }
}

/** create_excel：创建 xlsx（多工作表、表头样式、合并、列宽自适应）→ 发送文件 */
export const createExcelTool = {
  name: 'create_excel',
  description: '创建 Excel(.xlsx) 文件并【自动发送】到聊天（创建即发送，无需再调 send_file）。支持多工作表、合并单元格、列宽自适应、表头样式（加粗/蓝底白字/边框）。何时用：用户让你做表格、数据汇总、报表时。',
  category: 'query',
  meta: { summary: '创建 Excel 文件' },
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: '文件名（不含扩展名，如"销售报表"）' },
      sheets: {
        type: 'array',
        description: '工作表数组',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '工作表名' },
            headers: { type: 'array', items: { type: 'string' }, description: '列标题' },
            rows: { type: 'array', items: { type: 'array' }, description: '数据行（每行为数组，对应 headers 各列）' },
            merges: { type: 'array', description: '合并单元格（可选）', items: { type: 'object', properties: {
              row: { type: 'integer', description: '起始行(1-based)' },
              col: { type: 'integer', description: '起始列(1-based)' },
              rowspan: { type: 'integer', description: '跨行数(默认1)' },
              colspan: { type: 'integer', description: '跨列数(默认1)' },
              value: { type: 'string', description: '合并后单元格的值（可选）' },
            } } },
          },
          required: ['headers', 'rows'],
        },
      },
    },
    required: ['filename', 'sheets'],
  },
  async execute(params, ctx) {
    const ExcelJS = await getExcelJS()
    const wb = new ExcelJS.Workbook()
    // filename 来自 LLM 工具参数：消毒（去扩展名、非法字符→_、限长），防 `../../x` 穿越临时目录写出宿主文件（对照 topdf.js safeName）
    const rawName = String(params?.filename || 'export')
    const filename = rawName.replace(path.extname(rawName), '').replace(/[^\w一-龥-]/g, '_').slice(0, 60) || 'export'

    for (const sheet of params?.sheets || []) {
      const ws = wb.addWorksheet(sheet.name || `Sheet${wb.worksheets.length + 1}`)
      const headers = sheet.headers || []
      const rows = sheet.rows || []

      // 表头行（加粗 + 蓝底白字 + 居中 + 边框）
      if (headers.length) {
        const hr = ws.addRow(headers)
        hr.height = 22
        hr.eachCell((cell) => {
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } }
          cell.alignment = { horizontal: 'center', vertical: 'middle' }
          cell.border = thinBorder()
        })
      }

      // 数据行（边框）
      for (const row of rows) ws.addRow(row).eachCell({ includeEmpty: true }, (c) => { c.border = thinBorder() })

      // 列宽自适应
      ws.columns.forEach((col) => {
        let max = 0
        col.eachCell({ includeEmpty: true }, (cell) => { max = Math.max(max, String(cell.value ?? '').length) })
        col.width = Math.min(50, Math.max(10, max + 2))
      })

      // 合并单元格
      for (const m of sheet.merges || []) {
        const r1 = m.row, c1 = m.col
        const r2 = r1 + (m.rowspan || 1) - 1
        const c2 = c1 + (m.colspan || 1) - 1
        if (m.value != null) ws.getCell(r1, c1).value = m.value
        ws.mergeCells(r1, c1, r2, c2)
      }
    }

    // 写文件 + 发送
    const dir = TEMP_DIR()
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${filename}.xlsx`)
    await wb.xlsx.writeFile(filePath)

    // 创建后自动发送到聊天；返回 sent 标记，明确告知模型已发送、避免它再调 send_file 重复发
    let sent = false
    try {
      await ctx?.e?.reply(toFileSegment(filePath, `${filename}.xlsx`)); sent = true
    } catch { /* noop */ }
    return {
      ok: true,
      sent,
      path: filePath,
      sheets: wb.worksheets.length,
      note: sent ? '文件已发送到聊天，无需再用 send_file 重复发送' : '文件已生成但未发送成功；如需发送请用 send_file',
    }
  },
}

/**
 * 把 xlsx 字节解析为 markdown 表格文本（read_excel 与 read_attachment 共用，DRY）。
 * @param {Buffer} buffer xlsx 文件字节
 * @param {object} opts { sheet, maxRows }
 * @returns {Promise<object>} { sheets, currentSheet, totalRows, totalCols, text } 或 { error }
 */
export async function excelBufferToText(buffer, { sheet, maxRows = 50 } = {}) {
  const ExcelJS = await getExcelJS()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const sheetNames = wb.worksheets.map((ws) => ws.name)
  let ws = wb.worksheets[0]
  if (sheet != null) ws = wb.worksheets[Number(sheet) - 1] || wb.getWorksheet(String(sheet)) || ws
  if (!ws) return { sheets: sheetNames, error: '无工作表' }
  const mr = Math.min(500, Math.max(1, Number(maxRows) || 50))
  const lines = []
  let n = 0
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (n >= mr) return
    const cells = []
    row.eachCell({ includeEmpty: true }, (cell) => cells.push(fmtCell(cell.value)))
    lines.push(`| ${cells.join(' | ')} |`)
    if (rowNum === 1) lines.push(`| ${cells.map(() => '---').join(' | ')} |`)
    n++
  })
  return { sheets: sheetNames, currentSheet: ws.name, totalRows: ws.rowCount, totalCols: ws.columnCount, text: lines.join('\n') }
}

/** read_excel：读取 xlsx → markdown 表格文本（供模型分析） */
export const readExcelTool = {
  name: 'read_excel',
  description: '读取 Excel(.xlsx) 文件内容，返回为文本表格供分析。何时用：用户发了 Excel 让你查看数据、分析、统计时。',
  category: 'query',
  meta: { summary: '读取 Excel 内容', resultCap: 8000 },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Excel 文件路径' },
      sheet: { type: 'string', description: '工作表名或序号（默认第一个）' },
      maxRows: { type: 'integer', description: '最大返回行数（默认 50）' },
    },
    required: ['path'],
  },
  async execute(params) {
    const p = String(params?.path || '').trim()
    if (!p) return { error: '请提供 Excel 文件路径' }
    // 越界路径（config.yaml/.env/data/logs 等）必须先拒：category=query 对任意群成员免审批
    const guard = hostPathError(p, { label: 'Excel 文件' })
    if (guard) return { error: guard }
    if (!fs.existsSync(p)) return { error: `文件不存在：${p}` }
    let buf
    try { buf = fs.readFileSync(p) } catch (e) { return { error: `读取失败：${e?.message || e}` } }
    const out = await excelBufferToText(buf, { sheet: params?.sheet, maxRows: params?.maxRows })
    return out.error ? out : { ...out, path: p }
  },
}

function fmtCell(v) {
  if (v == null) return ''
  if (v instanceof Date) return v.toLocaleDateString('zh-CN')
  if (typeof v === 'object') {
    if (v.result != null) return String(v.result)
    if (v.richText) return v.richText.map((t) => t.text).join('')
    if (v.text) return v.text
    return JSON.stringify(v)
  }
  return String(v)
}
