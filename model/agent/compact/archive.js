/**
 * 压缩原文归档（内容寻址存储）——无损压缩的 reversible 支撑。
 *
 * 每次压缩把被移出窗口的原始消息整块写入：
 *   <dir>/<convKey 安全化>/<epoch>-<hash 前 16 位>.json
 * 记录 { v, hash(sha256 全量), convKey, epoch, createdAt, count, tokens, messages }。
 * hash 覆盖 convKey+epoch+messages（stableStringify 键排序）——读取时重算校验，
 * 篡改/损坏 → hash_mismatch 结构化错误（不静默返回被改内容）。
 *
 * 存储选文件系统而非 KV：不受 KV 单值大小限制、生命周期独立于会话数据
 * （会话删除不误伤归档，可另行清理）；按 convKey 分目录天然隔离权限域。
 */
import fs from 'node:fs'
import path from 'node:path'
import { contentHash } from './index.js'

const safeKey = (k) => String(k || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')

export class CompactionArchive {
  constructor({ dir } = {}) {
    if (!dir) throw new Error('CompactionArchive 需要 dir')
    this.dir = dir
  }

  _convDir(convKey) {
    const d = path.join(this.dir, safeKey(convKey))
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  /** 归档一批消息 → { ref, hash, count, tokens? }。ref = 文件名（不含目录），get/search 用。 */
  save({ convKey, epoch = 0, messages = [] }) {
    if (!Array.isArray(messages) || !messages.length) throw new Error('archive.save: messages 为空')
    const hash = contentHash({ convKey, epoch, messages })
    const ref = `${Number(epoch) || 0}-${hash.slice(0, 16)}.json`
    const rec = { v: 1, hash, convKey, epoch: Number(epoch) || 0, createdAt: Date.now(), count: messages.length, messages }
    fs.writeFileSync(path.join(this._convDir(convKey), ref), JSON.stringify(rec))
    return { ref, hash, count: messages.length }
  }

  /**
   * 读回归档原文；hash 不符/文件不存在 → { ok:false, code }。
   * convKey 给定时限定该会话目录并校验归属（权限域隔离——工具路径必须传）；
   * 省略时全目录扫描（仅限测试/管理场景），命中后同样校验 hash。
   */
  get(ref, { convKey } = {}) {
    try {
      // ref 只允许文件名形态（拒绝路径穿越：不含分隔符与 ..）
      if (typeof ref !== 'string' || /[/\\]/.test(ref) || ref.includes('..')) return { ok: false, code: 'bad_ref' }
      const convDirs = convKey ? [safeKey(convKey)] : (fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : [])
      for (const cd of convDirs) {
        const fp = path.join(this.dir, cd, ref)
        if (!fs.existsSync(fp)) continue
        const rec = JSON.parse(fs.readFileSync(fp, 'utf8'))
        if (convKey && rec.convKey !== convKey) return { ok: false, code: 'forbidden', error: '该归档不属于当前会话' }
        if (rec.hash !== contentHash({ convKey: rec.convKey, epoch: rec.epoch, messages: rec.messages })) {
          return { ok: false, code: 'hash_mismatch', error: '归档校验失败（内容与 hash 不符）' }
        }
        return { ok: true, ref, convKey: rec.convKey, epoch: rec.epoch, createdAt: rec.createdAt, count: rec.count, messages: rec.messages }
      }
      return { ok: false, code: 'not_found' }
    } catch (e) {
      return { ok: false, code: 'read_error', error: e?.message || String(e) }
    }
  }

  /** 关键词检索（简单包含匹配，命中返回摘录 + ref）——context_recall 的 query 路径 */
  async search(convKey, query, { limit = 3 } = {}) {
    const kw = String(query || '').trim().toLowerCase()
    if (!kw) return []
    const d = path.join(this.dir, safeKey(convKey))
    if (!fs.existsSync(d)) return []
    const hits = []
    for (const ref of fs.readdirSync(d).sort().reverse()) { // 新归档优先
      if (hits.length >= limit) break
      let rec
      try { rec = JSON.parse(fs.readFileSync(path.join(d, ref), 'utf8')) } catch { continue }
      const hay = JSON.stringify(rec.messages || []).toLowerCase()
      const idx = hay.indexOf(kw)
      if (idx < 0) continue
      const around = hay.slice(Math.max(0, idx - 80), idx + 160).replace(/\\n/g, ' ')
      hits.push({ ref, hash: rec.hash, count: rec.count, epoch: rec.epoch, excerpt: around })
    }
    return hits
  }

  /** 列出某会话的全部归档 ref（ newest 优先）——观测/清理用 */
  list(convKey) {
    const d = path.join(this.dir, safeKey(convKey))
    if (!fs.existsSync(d)) return []
    return fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort().reverse()
  }
}
