/**
 * apps/sticker-watch.js —— 表情包自动发现被动监听（MaiBot 式）。
 *
 * 旁听群消息里的 image 段（自定义表情/梗图）→ 下载字节 → sha256 去重 →
 * 视觉判定+打标（拒绝照片/文档）→ 入 StickerManager 库。永远 return false 不阻断。
 *
 * 触发条件：sticker.enable && sticker.autoDiscover && 群在白名单（discoverGroups 空=所有群）。
 * 需配置 agent.vision.model（视觉打标/判定）；未配则只按 hash 入库、不打标（VLM 判定降级为放行）。
 *
 * 成本控制：视觉调用串行化（一条一条判，防 burst 烧 token）；图片按 sha256 去重，重复不重判。
 */

import plugin from '../../../lib/plugins/plugin.js'
import Config from '../utils/Config.js'
import Log from '../utils/Log.js'
import { getRuntime } from './agent.js'

// 串行化视觉判定链（同一时刻只判一张，防 burst 成本）
let _chain = Promise.resolve()
const _seenUrl = new Map() // url → 最近处理时间（短窗去重，10 分钟）
const URL_DEDUP_MS = 10 * 60 * 1000

/** 下载图片 → {buffer, mime}；非 http(s) url 或失败返回 null。 */
async function fetchImageBuffer(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    const ab = await r.arrayBuffer()
    if (!ab || ab.byteLength < 512) return null // 太小：头像/占位图跳过
    const mime = (r.headers.get('content-type') || '').split(';')[0].trim() || 'image/jpeg'
    if (!/image\//i.test(mime)) return null
    return { buffer: Buffer.from(ab), mime }
  } catch { return null }
}

function selfIdsOf(e) {
  const ids = []
  try {
    if (typeof Bot !== 'undefined' && Bot) { if (Bot.uin) ids.push(String(Bot.uin)); if (Bot.uins) for (const u of Bot.uins) ids.push(String(u)) }
  } catch { /* noop */ }
  if (e?.self_id) ids.push(String(e.self_id))
  return ids
}

export class StickerWatch extends plugin {
  constructor() {
    super({
      name: '表情包自动发现',
      dsc: '被动采集群内表情图 → 视觉判定+打标 → 入库',
      event: 'message',
      priority: 2, // 早于 agent.js(9999) 跑，旁听后 return false
      rule: [{ reg: '^[\\s\\S]+$', fnc: 'onWatch', log: false }],
    })
  }

  async onWatch() {
    const e = this.e
    if (!e.isGroup) return false
    const cfg = Config.get().agent?.sticker || {}
    if (cfg.enable !== true || cfg.autoDiscover !== true) return false
    // 白名单：discoverGroups 空=所有群
    const gid = String(e.group_id)
    if (Array.isArray(cfg.discoverGroups) && cfg.discoverGroups.length && !cfg.discoverGroups.includes(gid)) return false

    // 跳过 self（机器人自己发的图，防环）
    const selfIds = selfIdsOf(e)
    if (selfIds.length && selfIds.includes(String(e.user_id))) return false

    // 提取 image 段
    const segs = Array.isArray(e.message) ? e.message.filter((s) => s && s.type === 'image') : []
    if (!segs.length) return false

    // 取运行时（vision + sticker manager）；未就绪静默跳过
    let rt
    try { rt = await getRuntime() } catch { return false }
    const manager = rt.sticker
    const vision = rt.vision
    if (!manager?.enabled?.()) return false

    // 串行化处理每张图（append 到链）
    for (const seg of segs) {
      const url = seg.url || seg.file
      if (!url) continue
      // 短窗 url 去重（同一链接 10 分钟内不重复处理）
      const now = Date.now()
      const last = _seenUrl.get(url) || 0
      if (now - last < URL_DEDUP_MS) continue
      _seenUrl.set(url, now)
      _chain = _chain.then(() => this._discoverOne(manager, vision, url, gid, cfg)).catch((err) => {
        Log.warn('[sticker-watch] discover 异常', err?.message || err)
      })
    }
    return false // 永不阻断
  }

  async _discoverOne(manager, vision, url, groupId, cfg) {
    const fetched = await fetchImageBuffer(url)
    if (!fetched) return
    try {
      const res = await manager.discover(fetched.buffer, fetched.mime, { vision, maxDiscovered: cfg.maxDiscovered })
      if (res.status === 'added') {
        Log.mark(`[sticker-watch] 新表情入库 群=${groupId} name=${res.name} tags=[${(res.tags || []).join(',')}]`)
      } else if (res.status === 'rejected' && res.reason === 'not_sticker') {
        Log.debug(`[sticker-watch] 判定非表情，丢弃 群=${groupId}`)
      }
      // dup / too_large / no_buffer / save_failed：静默
    } catch (e) {
      Log.warn('[sticker-watch] discover 失败', e?.message || e)
    }
  }
}
