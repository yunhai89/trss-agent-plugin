/**
 * 通用临时目录清理器（2026-10-17 审计 A6）。
 *
 * 背景：`Config.path.temp` 会持续积累 PDF/Excel 转档、STT 音频、下载中转、渲染图、日志包……
 * diagram 有专属 TTL 清理（model/diagram/tempdir.js），其余族**没有任何清理**——长跑实例的
 * temp 只增不减，磁盘占满后媒体/文档整族失败（且失败点分散、不易归因）。
 *
 * 安全边界：只删普通文件；不跟随符号链接；递归深度受限；删除前用 realpath 确认仍在根目录内；
 * 目录本身永不删除。
 */
import fs from 'node:fs'
import path from 'node:path'

export const TEMP_DEFAULTS = { ttlHours: 24, maxFiles: 500, intervalMinutes: 30, maxDepth: 2 }

/**
 * 扫一遍临时目录：删「超过 TTL」的文件；再按总量上限从最旧的开始删。
 * @returns {{removed:number, kept:number, bytes:number}}
 */
export function sweepTempDir({
  dir,
  ttlMs = TEMP_DEFAULTS.ttlHours * 3600_000,
  maxFiles = TEMP_DEFAULTS.maxFiles,
  maxDepth = TEMP_DEFAULTS.maxDepth,
  now = Date.now(),
  logger = () => {},
} = {}) {
  const empty = { removed: 0, kept: 0, bytes: 0 }
  const root = path.resolve(String(dir || ''))
  if (!root) return empty
  let rootReal = ''
  try { rootReal = fs.realpathSync(root) } catch { return empty } // 目录还不存在：无需清理

  const files = []
  const walk = (d, depth) => {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isSymbolicLink()) continue // 不跟随链接（防越界删除）
      if (e.isDirectory()) { if (depth < maxDepth) walk(p, depth + 1); continue }
      if (!e.isFile()) continue
      try { const st = fs.statSync(p); files.push({ p, mtimeMs: st.mtimeMs, size: st.size }) } catch { /* 跳过读不到的文件 */ }
    }
  }
  walk(rootReal, 0)

  const expired = []
  const fresh = []
  for (const f of files) {
    let rp = f.p
    try { rp = fs.realpathSync(f.p) } catch { continue }
    if (!(rp === rootReal || rp.startsWith(rootReal + path.sep))) continue // 越界（软链/挂载）防御
    if (now - f.mtimeMs > ttlMs) expired.push(f)
    else fresh.push(f)
  }
  fresh.sort((a, b) => a.mtimeMs - b.mtimeMs) // 旧 → 新
  const cap = Math.max(1, Math.floor(Number(maxFiles) || TEMP_DEFAULTS.maxFiles))
  const overflow = fresh.length > cap ? fresh.slice(0, fresh.length - cap) : []

  let removed = 0
  let bytes = 0
  for (const f of [...expired, ...overflow]) {
    try { fs.unlinkSync(f.p); removed++; bytes += f.size } catch (e) { logger('debug', '[temp] 清理跳过', f.p, e?.message || '') }
  }
  return { removed, kept: files.length - removed, bytes }
}

let _timer = null

/**
 * 启动后台清理（进程内单例：重复调用只启一次）。启动即扫一次，之后按间隔扫。
 * @returns {{started:boolean, sweep:()=>object|null, stop:()=>void}}
 */
export function startTempSweep({ dir, ttlHours, maxFiles, intervalMinutes, logger } = {}) {
  const ttlMs = Math.max(1, Number(ttlHours) || TEMP_DEFAULTS.ttlHours) * 3600_000
  const cap = Math.max(1, Math.floor(Number(maxFiles) || TEMP_DEFAULTS.maxFiles))
  const every = Math.max(1, Number(intervalMinutes) || TEMP_DEFAULTS.intervalMinutes) * 60_000
  const run = () => {
    try {
      const r = sweepTempDir({ dir, ttlMs, maxFiles: cap, logger })
      if (r.removed) logger?.('info', `[temp] 清理 ${r.removed} 个临时文件（${(r.bytes / 1048576).toFixed(1)} MB），保留 ${r.kept} 个`)
      else logger?.('debug', `[temp] 临时目录无需清理（保留 ${r.kept} 个）`)
      return r
    } catch (e) {
      logger?.('warn', '[temp] 清理失败', e?.message || e)
      return null
    }
  }
  if (_timer) return { started: false, sweep: run, stop: () => {} }
  run()
  _timer = setInterval(run, every)
  _timer.unref?.() // 不阻止进程退出
  return { started: true, sweep: run, stop: () => { if (_timer) { clearInterval(_timer); _timer = null } } }
}
