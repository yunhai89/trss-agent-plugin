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

/** ref 形如 `${epoch}-${hash}.json`——按 epoch 数值降序（新归档优先）。
 *  不能用字典序 sort().reverse()：epoch>=10 时 '9-…' 会排在 '10-…' 之前，顺序反了。 */
const byNewest = (a, b) => (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0)

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

  /** 归档一批消息 → { ref, hash, count, tokens? }。ref = 文件名（不含目录），get/search 用。
   *  原子写：先写临时文件再 rename（同目录内 rename 原子）——避免半写文件被 get 当成损坏归档，
   *  也避免 ENOSPC/进程中断留下看似成功实则残缺的原文。失败时清掉临时文件并抛出。 */
  save({ convKey, epoch = 0, messages = [] }) {
    if (!Array.isArray(messages) || !messages.length) throw new Error('archive.save: messages 为空')
    const hash = contentHash({ convKey, epoch, messages })
    const ref = `${Number(epoch) || 0}-${hash.slice(0, 16)}.json`
    const rec = { v: 1, hash, convKey, epoch: Number(epoch) || 0, createdAt: Date.now(), count: messages.length, messages }
    const finalPath = path.join(this._convDir(convKey), ref)
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(rec))
      fs.renameSync(tmpPath, finalPath)
    } catch (e) {
      try { fs.rmSync(tmpPath, { force: true }) } catch { /* best effort */ }
      throw e
    }
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
    for (const ref of fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort(byNewest)) { // 新归档优先
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
    return fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort(byNewest)
  }

  /**
   * 清空某 scope 用户在各隔离域（私聊 + 各群）的全部归档。
   * 目录名 = safeKey(`${scopeUserId}:${groupId||'p'}:${convId}`) = `${safeKey(scopeUserId)}_...`，
   * 用带尾随 `_` 的前缀匹配，避免 `1234_` 命中 `12345_...`。
   * 群共享（scopeUserId='__group__'）不在本方法范围内——调用方只传真实 uid，群共享数据因此保留。
   * @returns {number} 删除的归档目录数
   */
  purge(scopeUserId) {
    const prefix = `${safeKey(scopeUserId)}_`
    if (!fs.existsSync(this.dir)) return 0
    let removed = 0
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.startsWith(prefix)) continue
      try { fs.rmSync(path.join(this.dir, name), { recursive: true, force: true }); removed++ } catch { /* 单个目录失败不阻断其余 */ }
    }
    return removed
  }
}
