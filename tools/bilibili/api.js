/**
 * 哔哩哔哩请求层（纯传输 + 解析，不依赖 ctx）。
 *
 * 接口来源：哔哩哔哩野生 API 文档（realysy/bili-apis ≈ SocialSisterYi/bilibili-API-collect）。
 * 匿名可用：搜索/详情/播放地址/评论/弹幕/榜单/热门。
 * 需登录 Cookie（SESSDATA）：AI 总结、字幕、用户空间、高清晰度。
 */
import { encWbi, keyFromWbiUrl } from './sign.js'
import {
  HOSTS, defaultHeaders, buildCookie, normalizeVideo, normalizeSearchItem,
  parseVideoId, parseMid, httpsUrl,
} from './util.js'
import zlib from 'node:zlib'

const DEFAULT_TIMEOUT_MS = 15000
const WBI_TTL_MS = 6 * 3600 * 1000

/** 结构化错误：kind ∈ need_login | risk | not_found | http | parse */
export class BiliError extends Error {
  constructor(message, { kind = 'http', code = null } = {}) {
    super(message)
    this.name = 'BiliError'
    this.kind = kind
    this.code = code
  }
}

const _wbi = { img: '', sub: '', at: 0 }
const _buvid = { b3: '', b4: '', at: 0 }

function fetcherOf(opts) {
  const f = opts?.fetcher || globalThis.fetch
  if (typeof f !== 'function') throw new Error('运行环境缺少 fetch')
  return f
}

async function ensureBuvid(opts) {
  if (_buvid.b3 && Date.now() - _buvid.at < 24 * 3600 * 1000) return _buvid
  try {
    const j = await rawJson(`${HOSTS.api}/x/frontend/finger/spi`, opts)
    _buvid.b3 = j?.data?.b_3 || ''
    _buvid.b4 = j?.data?.b_4 || ''
    _buvid.at = Date.now()
  } catch { /* 失败则不带 buvid，多数匿名接口仍可用 */ }
  return _buvid
}

/** 合并 Cookie：配置 Cookie（SESSDATA 等）+ 自动 buvid3/4 */
async function cookieHeader(opts) {
  const base = String(opts?.cookie || '').trim()
  const b = await ensureBuvid(opts)
  const extra = buildCookie({ buvid3: b.b3, buvid4: b.b4 })
  return [base, extra].filter(Boolean).join('; ')
}

async function rawJson(url, opts) {
  const f = fetcherOf(opts)
  const controller = new AbortController()
  const timeoutMs = Number(opts?.timeoutMs) || DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await f(url, { headers: defaultHeaders(opts?.cookie), signal: controller.signal })
    const text = await res.text()
    if (!text || text.trim().startsWith('<')) throw new BiliError('上游返回非 JSON（可能触发风控或接口变动）', { kind: 'parse' })
    try { return JSON.parse(text) } catch { throw new BiliError('上游 JSON 解析失败', { kind: 'parse' }) }
  } catch (e) {
    if (e?.name === 'AbortError') throw new BiliError(`请求超时（${timeoutMs}ms）`, { kind: 'http' })
    throw e
  } finally { clearTimeout(timer) }
}

/** 带 Cookie/buvid 的 JSON 请求 */
async function getJson(url, opts) {
  const f = fetcherOf(opts)
  const controller = new AbortController()
  const timeoutMs = Number(opts?.timeoutMs) || DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await f(url, { headers: defaultHeaders(await cookieHeader(opts)), signal: controller.signal })
    const text = await res.text()
    if (!text || text.trim().startsWith('<')) throw new BiliError('上游返回非 JSON（可能触发风控或接口变形）', { kind: 'parse' })
    let json
    try { json = JSON.parse(text) } catch { throw new BiliError('上游 JSON 解析失败', { kind: 'parse' }) }
    return json
  } catch (e) {
    if (e?.name === 'AbortError') throw new BiliError(`请求超时（${timeoutMs}ms）`, { kind: 'http' })
    throw e
  } finally { clearTimeout(timer) }
}

/** 按 B站 code 归一错误；code=0 返回 data */
function unwrap(json, { needLogin = false } = {}) {
  const code = Number(json?.code)
  if (code === 0) return json.data
  const msg = json?.message || `code=${code}`
  if (code === -101) throw new BiliError(`需要登录 Cookie（SESSDATA）：${msg}`, { kind: 'need_login', code })
  if (code === -352 || code === -412) throw new BiliError(`触发风控（${code}）：${msg}`, { kind: 'risk', code })
  if (code === -404 || code === 62002) throw new BiliError(`内容不存在或已删除：${msg}`, { kind: 'not_found', code })
  if (needLogin) throw new BiliError(msg, { kind: 'http', code })
  throw new BiliError(msg, { kind: 'http', code })
}

/** 取 Wbi 密钥（缓存 6h） */
export async function getWbiKeys(opts = {}) {
  if (_wbi.img && _wbi.sub && Date.now() - _wbi.at < WBI_TTL_MS) return _wbi
  const json = await rawJson(`${HOSTS.api}/x/web-interface/nav`, opts)
  const img = keyFromWbiUrl(json?.data?.wbi_img?.img_url)
  const sub = keyFromWbiUrl(json?.data?.wbi_img?.sub_url)
  if (!img || !sub) throw new BiliError('未取到 Wbi 密钥（nav 接口异常）', { kind: 'parse' })
  _wbi.img = img; _wbi.sub = sub; _wbi.at = Date.now()
  return _wbi
}

/** Wbi 签名参数 */
async function wbiParams(params, opts) {
  const k = await getWbiKeys(opts)
  return encWbi(params, k.img, k.sub)
}

/** 解析短链（b23.tv）→ 视频标识 */
export async function resolveShortUrl(short, opts = {}) {
  const f = fetcherOf(opts)
  const res = await f(short, { headers: defaultHeaders(await cookieHeader(opts)), redirect: 'follow' })
  const finalUrl = res.url || short
  const id = parseVideoId(finalUrl)
  if (!id) throw new BiliError(`短链未解析出视频：${finalUrl}`, { kind: 'parse' })
  return id
}

/** 归一化视频标识（bvid/aid/短链/URL）→ { bvid?, aid? } */
export async function resolveVideoId(input, opts = {}) {
  const id = parseVideoId(input)
  if (!id) throw new BiliError(`无法识别的视频标识：${input}`, { kind: 'parse' })
  if (id.short) return resolveShortUrl(id.short, opts)
  return id
}

/** 搜索视频 */
export async function search(keyword, { page = 1, order = 'totalrank', type = 'video' } = {}, opts = {}) {
  const kw = String(keyword || '').trim().slice(0, 100)
  if (!kw) throw new BiliError('搜索关键词不能为空', { kind: 'parse' })
  const params = await wbiParams({ search_type: type, keyword: kw, page, order }, opts)
  const json = await getJson(`${HOSTS.api}/x/web-interface/wbi/search/type?${new URLSearchParams(params)}`, opts)
  const d = unwrap(json)
  const list = Array.isArray(d?.result) ? d.result : []
  return { keyword: kw, page, items: list.map(normalizeSearchItem).filter(Boolean), total: d?.numResults || d?.total || list.length }
}

/** 视频详情 */
export async function getVideo(input, opts = {}) {
  const id = await resolveVideoId(input, opts)
  const q = id.bvid ? `bvid=${id.bvid}` : `aid=${id.aid}`
  const json = await getJson(`${HOSTS.api}/x/web-interface/view?${q}`, opts)
  const data = unwrap(json)
  const v = normalizeVideo(data)
  if (!v) throw new BiliError('视频数据为空', { kind: 'parse' })
  return v
}

/** AI 视频总结（需登录 Cookie） */
export async function getConclusion({ bvid, cid, upMid }, opts = {}) {
  const params = await wbiParams({ bvid, cid, up_mid: upMid }, opts)
  const json = await getJson(`${HOSTS.api}/x/web-interface/view/conclusion/get?${new URLSearchParams(params)}`, opts)
  const d = unwrap(json)
  const mr = d?.model_result || {}
  const outline = Array.isArray(mr.outline)
    ? mr.outline.map((o) => ({
      title: o.title || '',
      points: Array.isArray(o.part_outline) ? o.part_outline.map((p) => ({ time: p.timestamp, content: p.content })) : [],
    }))
    : []
  return { resultType: d?.code ?? 0, summary: mr.summary || '', outline }
}

/** 字幕（需登录 Cookie）：返回可用字幕列表与首选字幕正文 */
export async function getSubtitles({ bvid, cid }, opts = {}) {
  const json = await getJson(`${HOSTS.api}/x/player/v2?bvid=${bvid}&cid=${cid}`, opts)
  const d = unwrap(json)
  const subs = Array.isArray(d?.subtitle?.subtitles) ? d.subtitle.subtitles : []
  const available = subs.map((s) => ({ lan: s.lan, lanDoc: s.lan_doc, ai: s.ai_type === 1, url: httpsUrl(s.subtitle_url) }))
  if (!available.length) return { available: [], lan: '', text: '' }
  const pick = available.find((s) => /zh/i.test(s.lan)) || available[0]
  let text = ''
  try {
    const j = await getJson(pick.url, opts)
    const body = Array.isArray(j?.body) ? j.body : []
    text = body.map((b) => b.content).filter(Boolean).join('\n')
  } catch { /* 字幕正文取不到则只回列表 */ }
  return { available, lan: pick.lan, text }
}

/** 热门评论 */
export async function getComments({ aid, ps = 10, pn = 1 }, opts = {}) {
  const json = await getJson(`${HOSTS.api}/x/v2/reply?type=1&oid=${aid}&sort=2&ps=${ps}&pn=${pn}`, opts)
  const d = unwrap(json)
  const replies = Array.isArray(d?.replies) ? d.replies : []
  return {
    count: d?.page?.count || d?.all_count || replies.length,
    items: replies.map((r) => ({
      user: r.member?.uname || '',
      like: r.like || 0,
      message: String(r.content?.message || '').slice(0, 300),
      replies: r.rcount || 0,
    })),
  }
}

/** 弹幕（取样） */
export async function getDanmaku(cid, { limit = 100 } = {}, opts = {}) {
  const f = fetcherOf(opts)
  const res = await f(`${HOSTS.api}/x/v1/dm/list.so?oid=${cid}`, { headers: defaultHeaders(await cookieHeader(opts)) })
  const buf = Buffer.from(await res.arrayBuffer())
  let xml = ''
  try {
    if (buf[0] === 0x78) xml = zlib.inflateSync(buf).toString('utf8')
    else if (buf[0] === 0x1f && buf[1] === 0x8b) xml = zlib.gunzipSync(buf).toString('utf8')
    else xml = buf.toString('utf8')
  } catch (e) {
    throw new BiliError(`弹幕解压失败：${e?.message || e}`, { kind: 'parse' })
  }
  const items = []
  const re = /<d p="([^"]+)">([\s\S]*?)<\/d>/g
  let m
  while ((m = re.exec(xml)) && items.length < limit) {
    const p = m[1].split(',')
    items.push({ time: Number(p[0]) || 0, mode: Number(p[1]) || 1, text: stripXml(m[2]).slice(0, 80) })
  }
  return { count: (xml.match(/<d p=/g) || []).length, items }
}

function stripXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

/** 排行榜 */
export async function getRanking({ rid = 0, type = 'all' } = {}, opts = {}) {
  const json = await getJson(`${HOSTS.api}/x/web-interface/ranking/v2?rid=${rid}&type=${type}`, opts)
  const d = unwrap(json)
  const list = Array.isArray(d?.list) ? d.list : []
  return { rid, list: list.map((v) => ({
    bvid: v.bvid, title: stripXml(v.title || ''), owner: v.owner?.name || '', mid: v.owner?.mid || 0,
    play: v.stat?.view || 0, danmaku: v.stat?.danmaku || 0, cover: httpsUrl(v.pic || ''),
  })) }
}

/** 热门视频 */
export async function getPopular({ ps = 10, pn = 1 } = {}, opts = {}) {
  const json = await getJson(`${HOSTS.api}/x/web-interface/popular?ps=${ps}&pn=${pn}`, opts)
  const d = unwrap(json)
  const list = Array.isArray(d?.list) ? d.list : []
  return { list: list.map((v) => ({
    bvid: v.bvid, title: stripXml(v.title || ''), owner: v.owner?.name || '', mid: v.owner?.mid || 0,
    play: v.stat?.view || 0, danmaku: v.stat?.danmaku || 0, cover: httpsUrl(v.pic || ''),
  })) }
}

/** UP 主信息（需登录 Cookie） */
export async function getUserInfo(mid, opts = {}) {
  const params = await wbiParams({ mid: String(mid) }, opts)
  const json = await getJson(`${HOSTS.api}/x/space/wbi/acc/info?${new URLSearchParams(params)}`, opts)
  const d = unwrap(json)
  return {
    mid: d.mid, name: d.name || '', face: httpsUrl(d.face || ''), sign: d.sign || '',
    level: d.level || 0, follower: d.follower ?? null, following: d.following ?? null,
    official: d.official?.title || '',
  }
}

/** UP 主投稿视频（需登录 Cookie） */
export async function getUserVideos(mid, { ps = 10, pn = 1, order = 'pubdate' } = {}, opts = {}) {
  const params = await wbiParams({ mid: String(mid), ps, pn, order }, opts)
  const json = await getJson(`${HOSTS.api}/x/space/wbi/arc/search?${new URLSearchParams(params)}`, opts)
  const d = unwrap(json)
  const vlist = Array.isArray(d?.list?.vlist) ? d.list.vlist : []
  return { total: d?.page?.count || vlist.length, list: vlist.map((v) => ({
    bvid: v.bvid, aid: v.aid, title: stripXml(v.title || ''), play: v.play || 0,
    danmaku: v.video_review || 0, duration: v.length || '', created: v.created, cover: httpsUrl(v.pic || ''),
  })) }
}

/**
 * 播放信息：同时取 durl（合并 MP4，无需 ffmpeg）与 dash（分轨，需 ffmpeg 合并）。
 * @param {object} o { bvid, cid, qn? } qn=请求清晰度（0=服务器默认）；服务端会自动降级到账号可用档
 * @returns {{ acceptQuality:number[], durl:Array, dash:{audio:Array,video:Array}, quality:number, supportFormat:Array }}
 */
export async function getPlayInfo({ bvid, cid, qn = 0 }, opts = {}) {
  const q = qn ? `&qn=${Number(qn)}` : ''
  // durl（非 wbi，fnval=1 → 合并 MP4）
  let durl = [], acceptQuality = [], quality = 0, supportFormat = []
  try {
    const j = await getJson(`${HOSTS.api}/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=1&fnver=0&fourk=1${q}`, opts)
    const d = unwrap(j)
    durl = Array.isArray(d?.durl) ? d.durl : []
    acceptQuality = d?.accept_quality || []
    quality = d?.quality || 0
    supportFormat = d?.support_formats || []
  } catch { /* 忽略，继续取 dash */ }
  // dash（wbi，fnval=16）
  let dash = { audio: [], video: [] }
  try {
    const params = await wbiParams({ bvid, cid, fnval: 16, fnver: 0, fourk: 1, ...(qn ? { qn: Number(qn) } : {}) }, opts)
    const j = await getJson(`${HOSTS.api}/x/player/wbi/playurl?${new URLSearchParams(params)}`, opts)
    const d = unwrap(j)
    if (d?.dash) {
      dash = { audio: d.dash.audio || [], video: d.dash.video || [] }
      if (!acceptQuality.length) acceptQuality = d.accept_quality || []
      if (!quality) quality = d.quality || 0
      if (!supportFormat.length) supportFormat = d.support_formats || []
    }
  } catch { /* 忽略 */ }
  return { acceptQuality, durl, dash, quality, supportFormat }
}

/** 选最优 dash 音频（id 越大越好） */
export function pickBestAudio(dash) {
  const arr = Array.isArray(dash?.audio) ? [...dash.audio] : []
  arr.sort((a, b) => (b.id || 0) - (a.id || 0))
  return arr[0] || null
}

/** 选最优 durl（合并 MP4；durl 通常单条） */
export function pickBestDurl(durl) {
  const arr = Array.isArray(durl) ? [...durl] : []
  arr.sort((a, b) => (b.size || 0) - (a.size || 0))
  return arr[0] || null
}

/** 调用 Whisper 兼容 STT 转录音频文件 */
export async function transcribeAudio(audioPath, sttCfg = {}, { fetchImpl } = {}) {
  if (!sttCfg?.apiKey) throw new BiliError('未配置 STT（agent.stt.apiKey 为空）', { kind: 'http' })
  const fs = await import('node:fs')
  const path = await import('node:path')
  const buf = fs.readFileSync(audioPath)
  const ext = path.extname(audioPath).toLowerCase()
  const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : 'audio/mp4'
  const form = new FormData()
  form.append('file', new Blob([buf], { type: mime }), path.basename(audioPath))
  form.append('model', sttCfg.model || 'whisper-1')
  if (sttCfg.language) form.append('language', sttCfg.language)
  const f = fetchImpl || globalThis.fetch
  const res = await f(sttCfg.apiBase || 'https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sttCfg.apiKey}` },
    body: form,
  })
  if (!res.ok) throw new BiliError(`STT HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`, { kind: 'http' })
  const data = await res.json()
  return String(data.text || '')
}

export { parseMid }
