/**
 * diagram 专用临时目录管理 + TTL 定时清理。
 *
 * - 目录固定为插件 data/diagram/（可配）；清理器只删除该目录下匹配 dg-*.png|svg 的文件，绝不递归、绝不越界；
 * - 文件名由 specHash 决定（不可预测性要求：specHash 是内容 sha256，非用户标题）；
 * - 清理定时器 unref（不阻止进程退出）；服务重启后惰性重建。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SAFE_NAME = /^dg-[0-9a-f]{16}-[0-9a-f]{2,4}\.(png|svg)(\.tmp)?$/

export class TempDir {
  constructor({ dir = null, ttlMinutes = 30, sweepIntervalMs = 10 * 60_000, logger = () => {} } = {}) {
    this.dir = dir || path.join(PLUGIN_ROOT, 'data/diagram')
    this.ttlMs = Math.max(1, ttlMinutes) * 60_000
    this.sweepIntervalMs = sweepIntervalMs
    this.logger = logger
    this._timer = null
    this._ensure()
  }

  _ensure() {
    try { fs.mkdirSync(this.dir, { recursive: true }) } catch (e) { this.logger('warn', '[diagram] 临时目录创建失败', e?.message || e) }
  }

  resolve(name) {
    if (!SAFE_NAME.test(name)) throw new Error(`非法临时文件名：${name}`)
    return path.join(this.dir, name)
  }

  exists(name) { try { return fs.statSync(this.resolve(name)).isFile() } catch { return false } }

  write(name, buf) {
    const p = this.resolve(name)
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, p) // 原子写：读者永远看到完整文件
    return p
  }

  /** 只清理本目录内 dg-* 且超 TTL 的文件；返回删除数 */
  sweep(now = Date.now()) {
    let removed = 0
    let entries = []
    try { entries = fs.readdirSync(this.dir) } catch { return 0 }
    for (const name of entries) {
      if (!SAFE_NAME.test(name)) continue
      const p = path.join(this.dir, name)
      try {
        const st = fs.statSync(p)
        if (now - st.mtimeMs > this.ttlMs) { fs.unlinkSync(p); removed++ }
      } catch (e) { this.logger('debug', '[diagram] 清理跳过', name, e?.message || '') }
    }
    return removed
  }

  startSweep() {
    if (this._timer) return
    this._timer = setInterval(() => {
      const n = this.sweep()
      if (n) this.logger('debug', `[diagram] TTL 清理删除 ${n} 个过期文件`)
    }, this.sweepIntervalMs)
    this._timer.unref?.()
  }

  stopSweep() { if (this._timer) { clearInterval(this._timer); this._timer = null } }
}
