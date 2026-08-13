/**
 * 日志压缩归档 —— 把超过 maxAge 未修改的 .log 压缩成 .log.gz 并删除原文件。
 *
 * 用途：伪人全链路日志（data/humanize-logs/）按日累积，定期压缩旧文件省空间。
 *   被压缩的 .log.gz 不再被 web 日志时间线读取（listLogFiles 只列 .log），等于归档。
 *
 * 实现：Node 内置 zlib（零新增依赖），读全文 → gzipSync → 写 .gz → 删原文件。
 *   单文件失败不影响其他文件。maxAgeMs 默认 24 小时（太新的不动，便于近期排错）。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * 压缩目录下过期的 .log 文件。
 * @param {string} dir 日志目录
 * @param {object} [opts] { maxAgeMs?:number, logger?:{warn?:Function} }
 * @returns {{compressed:number, skipped:number, failed:number}}
 */
export function compressOldLogs(dir, { maxAgeMs = 24 * 3600 * 1000, logger = console } = {}) {
  const out = { compressed: 0, skipped: 0, failed: 0 }
  if (!dir) return out
  let names = []
  try { names = fs.readdirSync(dir) } catch { return out } // 目录不存在 = 无可压缩
  const now = Date.now()
  for (const name of names) {
    if (!name.endsWith('.log')) continue
    const file = path.join(dir, name)
    try {
      const st = fs.statSync(file)
      if (now - st.mtimeMs < maxAgeMs) { out.skipped++; continue } // 太新，保留可读原文件
      const buf = fs.readFileSync(file)
      fs.writeFileSync(file + '.gz', zlib.gzipSync(buf))
      fs.unlinkSync(file)
      out.compressed++
    } catch (e) {
      out.failed++
      try { logger?.warn?.('[compressLogs]', name, e?.message || e) } catch { /* noop */ }
    }
  }
  return out
}

export default compressOldLogs
