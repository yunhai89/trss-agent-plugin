/**
 * TTS 参考音频库 —— 上传的参考音频统一「命名」管理（音色参考 / 情绪参考）。
 *
 * 存储（全部在插件自己的 data 目录，不入库）：
 *   <dir>/refs.json          索引：[{ id, name, kind, ext, size, createdAt }]
 *   <dir>/refs/<id><ext>     音频文件本体
 *
 * 约定：
 *  - name 必填且唯一（模型按名字引用音色/情绪，重名会导致歧义）；
 *  - kind: voice=音色参考 | emotion=情绪参考（情绪参考可来自其他说话人）；
 *  - 写操作走进程内互斥锁 + 原子写（tmp+rename），防 Web 面板并发上传丢索引。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createKeyedLock } from '../agent/store/lock.js'

export const REF_KINDS = ['voice', 'emotion']
export const AUDIO_EXTS = ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.aac', '.opus', '.wma', '.amr']
const NAME_MAX = 40

/** 名称校验与归一：去首尾空白/控制字符，限长；返回 null 表示非法（调用方回可读错误） */
export function normalizeRefName(name) {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!s) return null
  if (s.length > NAME_MAX) return null
  if (/[/\\]/.test(s)) return null
  return s
}

/** 从上传文件名猜扩展名（白名单外返回 null） */
export function extOf(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase()
  return AUDIO_EXTS.includes(ext) ? ext : null
}

const lock = createKeyedLock({ maxKeys: 8 })

export class RefLibrary {
  /** @param {{ dir: string, logger?: Function }} opts dir = data/tts 目录 */
  constructor({ dir, logger } = {}) {
    this.dir = dir
    this.filesDir = path.join(dir, 'refs')
    this.indexPath = path.join(dir, 'refs.json')
    this.logger = logger || (() => {})
  }

  /**
   * 读取索引。区分「文件不存在」（真空表）与「读/解析失败」（索引损坏）：
   * 后者**必须抛错**——旧实现一律返回空数组，于是下一次 add() 会把损坏当空表、
   * 把整个索引覆盖成只剩新条目（refs/ 里的音频文件还在但全部失联，只能重建）。
   * 抛错前先把损坏文件另存 .bad-<ts>，便于人工找回。
   */
  _read() {
    let raw
    try { raw = fs.readFileSync(this.indexPath, 'utf8') } catch { return [] } // 不存在＝真空表
    try {
      const arr = JSON.parse(raw)
      return Array.isArray(arr) ? arr : []
    } catch (e) {
      // 备份按**内容哈希**命名：读路径（list/get/getByName → _readSafe）也会走到这里，若按时间戳命名，
      // 索引修好之前每次面板刷新/每次合成都新增一份副本，data/tts 无限增长（2026-10-17 回归审计 low）。
      // 同内容只留一份，人工仍可找回。
      let bak = ''
      try {
        const sum = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8)
        bak = `${this.indexPath}.bad-${sum}`
        if (!fs.existsSync(bak)) fs.copyFileSync(this.indexPath, bak)
      } catch { /* 备份失败不阻断报错 */ }
      throw new Error(`参考音频索引损坏${bak ? `（已备份到 ${path.basename(bak)}）` : ''}：${e?.message || e}`)
    }
  }

  /** 读路径专用：损坏时告警并降级为空表（不抛，保证面板/合成不整体失败；写路径仍走 _read 抛错防覆盖） */
  _readSafe() {
    try { return this._read() } catch (e) {
      this.logger('warn', `[tts] ${e?.message || e}`)
      return []
    }
  }

  /** 原子写索引 */
  _write(list) {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = this.indexPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
    fs.renameSync(tmp, this.indexPath)
  }

  /** 列表（可按 kind 过滤），新→旧 */
  list(kind) {
    const arr = this._readSafe()
    const out = kind ? arr.filter((r) => r.kind === kind) : arr
    return out.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  get(id) { return this._readSafe().find((r) => r.id === id) || null }

  getByName(name, kind) {
    const n = String(name || '').trim()
    return this._readSafe().find((r) => r.name === n && (!kind || r.kind === kind)) || null
  }

  /** 参考音频绝对路径（条目不存在返回 null） */
  filePath(entry) {
    if (!entry) return null
    return path.join(this.filesDir, `${entry.id}${entry.ext || ''}`)
  }

  /** 新增：{ name, kind, filename, buffer } → 条目；校验失败抛 Error（消息可直接回给用户） */
  async add({ name, kind, filename, buffer }) {
    const n = normalizeRefName(name)
    if (!n) throw new Error(`参考音频名称非法（1~${NAME_MAX} 字，不含 / \\ 与控制字符）`)
    const k = REF_KINDS.includes(kind) ? kind : 'voice'
    const ext = extOf(filename)
    if (!ext) throw new Error(`不支持的音频格式（支持 ${AUDIO_EXTS.join(' / ')}）`)
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('音频内容为空')
    return lock.withLock('refs', async () => {
      const list = this._read()
      if (list.some((r) => r.name === n)) throw new Error(`名称「${n}」已存在（重名会让模型引用歧义，请换一个）`)
      const id = crypto.randomBytes(8).toString('hex')
      const entry = { id, name: n, kind: k, ext, size: buffer.length, createdAt: Date.now() }
      fs.mkdirSync(this.filesDir, { recursive: true })
      fs.writeFileSync(path.join(this.filesDir, `${id}${ext}`), buffer)
      list.push(entry)
      this._write(list)
      this.logger('debug', `[tts] 参考音频已入库：${n}（${k}，${(buffer.length / 1024).toFixed(0)} KB）`)
      return entry
    })
  }

  /** 删除条目 + 文件（不存在返回 false） */
  async remove(id) {
    return lock.withLock('refs', async () => {
      const list = this._read()
      const i = list.findIndex((r) => r.id === id)
      if (i < 0) return false
      const [entry] = list.splice(i, 1)
      try { fs.unlinkSync(path.join(this.filesDir, `${entry.id}${entry.ext || ''}`)) } catch { /* 文件可能已丢，索引照删 */ }
      this._write(list)
      return true
    })
  }
}
