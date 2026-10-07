/**
 * 媒体发送 API —— 供自定义工具开发者在 execute(params, ctx) 中主动发送媒体。
 *
 * 基于 Yunzai segment + e.reply。segment 是运行时全局对象（oicq 注入）。
 * 输入 source 支持：Buffer / 本地路径 / http(s) URL / base64:// / file://。
 *
 * 用法（在工具里）：
 *   import { sendImage } from '../model/toolkit/index.js'
 *   async execute(p, ctx) {
 *     await sendImage(ctx, '/path/to/chart.png')
 *     return { ok: true }
 *   }
 */

import { toFileSegment } from '../../utils/SendFile.js'

/** 归一化输入 → segment 可接受的 file 字符串 */
function normalize(source) {
  if (Buffer.isBuffer(source)) return `base64://${source.toString('base64')}`
  return String(source)
}

/** 获取 segment 全局（Yunzai 运行时注入，非运行时为 null） */
function getSegment() {
  return (typeof segment !== 'undefined' && segment) || null
}

/**
 * 发送图片。source: Buffer / 路径 / URL / base64://。
 * @returns {Promise<boolean>} 成功 true，失败 false
 */
export async function sendImage(ctx, source) {
  const seg = getSegment()
  if (!seg) return false
  try { await ctx?.e?.reply(seg.image(normalize(source))); return true }
  catch { return false }
}

/**
 * 发送语音。source: Buffer / 路径 / URL / base64://。
 * 建议 mp3 格式（NapCat / Lagrange 等主流 OneBot 实现内部自动转 silk）。
 */
export async function sendVoice(ctx, source) {
  const seg = getSegment()
  if (!seg) return false
  try { await ctx?.e?.reply(seg.record(normalize(source))); return true }
  catch { return false }
}

/** 发送视频。source: Buffer / 路径 / URL / base64://。 */
export async function sendVideo(ctx, source) {
  const seg = getSegment()
  if (!seg) return false
  try { await ctx?.e?.reply(seg.video(normalize(source))); return true }
  catch { return false }
}

/** 发送文件（走群文件/好友文件上传 API，非消息段）。source: 路径 / URL。 */
export async function sendFile(ctx, source) {
  const seg = getSegment()
  if (!seg) return false
  try { await ctx?.e?.reply(toFileSegment(normalize(source))); return true }
  catch { return false }
}

/** 发送文本消息（中途播报/通知用户）。 */
export async function sendText(ctx, text) {
  try { await ctx?.e?.reply(String(text || '')); return true }
  catch { return false }
}

/**
 * 构造 OneBot 11 `music` 音乐分享消息段（NapCat 支持）。
 *  - 原生音源：{ type:'qq'|'163'|'kugou'|'kuwo'|'migu', id }（QQ 音乐的 id 用 songmid）
 *  - 自定义卡片：{ type:'custom', url, audio?, title?, image, content? }（url、image 必填）
 * 返回对象直接交给 e.reply 即可（OneBotv11 适配器会原样透传给协议端）。
 */
export function musicSegment(o = {}) {
  const type = String(o.type || 'qq')
  if (type === 'custom') {
    const data = { type: 'custom', url: String(o.url || ''), image: String(o.image || '') }
    if (o.audio) data.audio = String(o.audio)
    if (o.title) data.title = String(o.title)
    if (o.content) data.content = String(o.content)
    return { type: 'music', data }
  }
  return { type: 'music', data: { type, id: String(o.id || '') } }
}

/** 发送音乐分享卡片；失败返回 false（由调用方决定降级到语音/文本）。 */
export async function sendMusic(ctx, o) {
  try { await ctx?.e?.reply(musicSegment(o)); return true }
  catch { return false }
}
