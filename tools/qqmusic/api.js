/**
 * QQ 音乐请求层（纯传输 + 解析，不依赖 Config / ctx）。
 *
 * 接口来源（当前仍在维护的逆向项目，均已对照真实响应校准）：
 *  - sansenjian/qq-music-api（Node/TS，活跃 fork of Rain120/qq-music-api）：
 *      搜索 client_search_cp、播放链接 vkey.GetVkeyServer/CgiGetVkey、歌词 fcg_query_lyric_new、
 *      榜单 fcg_v8_toplist_cp、歌单 fcg_ucc_getcdinfo_byids_cp —— 均走旧网关，无需 sign。
 *  - L-1124/QQMusicApi（Python，持续更新）：
 *      现代签名网关 u6.y.qq.com/cgi-bin/musics.fcg 的 module/method 与 comm 约定，
 *      歌曲详情 music.pf_song_detail_svr/get_song_detail_yqq、
 *      榜单目录 music.musicToplist.Toplist/GetAll —— 走 sign.js 的 zzc 签名。
 *
 * 说明：播放地址（purl）当前需要登录 Cookie，匿名请求 result=104003、purl 为空。
 */
import { zzcSign } from './sign.js'
import {
  HOSTS, defaultHeaders, buildFilename, normalizeQuality, QUALITY_MAP, qualityFromFilename,
  pickPlayDomain, joinPlayUrl, normalizeSong, clampInt,
} from './util.js'

const DEFAULT_TIMEOUT_MS = 15000

function resolveFetcher(fetcher) {
  return fetcher || globalThis.fetch
}

/** 带超时 / JSONP 兜底的 GET */
async function getJson(url, { fetcher, cookie, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const f = resolveFetcher(fetcher)
  if (typeof f !== 'function') throw new Error('运行环境缺少 fetch')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await f(url, { headers: defaultHeaders(cookie), signal: controller.signal })
    const text = await res.text()
    if (!res.ok) throw new Error(`上游 HTTP ${res.status}`)
    return parseMaybeJsonp(text)
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`请求超时（${timeoutMs}ms）`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 解析 JSON，兼容 JSONP 包裹 */
export function parseMaybeJsonp(text) {
  const raw = String(text || '').trim()
  if (!raw) throw new Error('上游返回空响应')
  try {
    return JSON.parse(raw)
  } catch {
    const m = raw.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/)
    if (m) return JSON.parse(m[1])
    throw new Error(`上游返回无法解析：${raw.slice(0, 120)}`)
  }
}

function authOf({ cookie, uin, authst } = {}) {
  return {
    cookie: cookie || '',
    uin: uin || '',
    authst: authst || '',
  }
}

/**
 * 现代签名网关调用（u6.y.qq.com/cgi-bin/musics.fcg）。
 * @param {object|Array} requests 单个/多个 { module, method, param }，展开为 req_0..req_n
 * @param {object} opts { fetcher, cookie, uin, authst, ct, comm, timeoutMs }
 *   - 带 authst（登录票据）时 comm.ct 默认切到 19（登录态），否则 24
 *   - comm 可覆盖任意公共参数（如 tmeAppID / tmeLoginType）
 */
export async function signedCgi(requests, { fetcher, cookie, uin = '0', authst, ct, comm, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const list = Array.isArray(requests) ? requests : [requests]
  const payload = {
    comm: {
      ct: ct ?? (authst ? 19 : 24),
      cv: 0,
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 1,
      uin: String(uin || '0'),
      ...(authst ? { authst } : {}),
      ...(comm || {}),
    },
  }
  list.forEach((req, i) => { payload[`req_${i}`] = req })
  const body = JSON.stringify(payload)
  const url = `${HOSTS.u6}/cgi-bin/musics.fcg?_=${Date.now()}&sign=${zzcSign(body)}`

  const f = resolveFetcher(fetcher)
  if (typeof f !== 'function') throw new Error('运行环境缺少 fetch')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { ...defaultHeaders(cookie), 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`上游 HTTP ${res.status}`)
    return parseMaybeJsonp(text)
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`请求超时（${timeoutMs}ms）`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 旧网关 musicu.fcg（无需 sign） */
async function musicu(data, { fetcher, cookie, timeoutMs } = {}) {
  const url = `${HOSTS.u}/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify(data))}`
  return getJson(url, { fetcher, cookie, timeoutMs })
}

const SEARCH_TYPE = { song: 0, album: 8, mv: 12 }

/**
 * 关键字搜索（旧网关 client_search_cp）。
 * @param {string} keyword
 * @param {object} params { page, limit, type: 'song'|'album'|'mv' }
 * @param {object} opts { fetcher, cookie, timeoutMs }
 */
export async function search(keyword, { page = 1, limit = 10, type = 'song' } = {}, opts = {}) {
  const kw = String(keyword || '').trim().slice(0, 64)
  if (!kw) throw new Error('搜索关键词不能为空')
  const p = clampInt(page, 1, 100, 1)
  const n = clampInt(limit, 1, 30, 10)
  const t = SEARCH_TYPE[type] ?? 0
  const query = new URLSearchParams({
    format: 'json',
    outCharset: 'utf-8',
    ct: '24',
    qqmusic_ver: '1298',
    remoteplace: `txt.yqq.${type}`,
    t: String(t),
    aggr: '1',
    cr: '1',
    lossless: '0',
    flag_qc: '0',
    platform: 'yqq.json',
    p: String(p),
    n: String(n),
    w: kw,
  })
  const json = await getJson(`${HOSTS.c}/soso/fcgi-bin/client_search_cp?${query}`, opts)
  const data = json?.data || {}
  const category = type === 'album' ? 'album' : type === 'mv' ? 'mv' : 'song'
  const list = data?.[category]?.list || []
  const items = list
    .map((item) => (category === 'song' ? normalizeSong(item) : normalizeItem(item, category)))
    .filter(Boolean)
  return {
    keyword: kw,
    type,
    page: p,
    limit: n,
    total: Number(data?.[category]?.totalnum || data?.song?.totalnum || items.length) || items.length,
    items,
  }
}

function normalizeItem(item, category) {
  if (!item) return null
  if (category === 'album') {
    return {
      albummid: item.albumMid || item.albummid || '',
      name: String(item.albumName || item.albumname || ''),
      singers: (item.singer || []).map((s) => s?.name).filter(Boolean),
      songCount: Number(item.song_count || item.songnum || 0) || 0,
      publicTime: item.publicTime || item.pubtime || '',
    }
  }
  if (category === 'mv') {
    return {
      vid: item.vid || '',
      name: String(item.mvName || item.mvname || ''),
      singers: (item.singer || []).map((s) => s?.name).filter(Boolean),
      duration: Number(item.duration || 0) || 0,
    }
  }
  return item
}

/** 详情 track 是否可用（上游对无效 mid 可能返回空对象而非报错，须拒绝，避免发出空卡片） */
function isUsableTrack(t) {
  return !!(t && (t.mid || t.songmid || t.name || t.songname || t.id))
}

/**
 * 歌曲详情（现代签名网关，失败回退旧网关）。
 * @param {object} params { songmid } 或 { songid }
 * @param {object} opts
 */
export async function getSongDetail({ songmid, songid } = {}, opts = {}) {
  const isNumericId = songid != null && String(songid).match(/^\d+$/)
  const param = songmid
    ? { song_mid: songmid, song_id: 0, song_type: 0 }
    : isNumericId
      ? { song_id: Number(songid), song_mid: '', song_type: 0 }
      : null
  if (!param) throw new Error('需要提供 songmid 或 songid')

  try {
    const json = await signedCgi(
      { module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq', param },
      opts,
    )
    const track = json?.req_0?.data?.track_info
    if (isUsableTrack(track)) return normalizeDetail(track)
  } catch {
    /* 回退旧网关 */
  }

  const json = await musicu(
    { songinfo: { module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq', param } },
    opts,
  )
  const track = json?.songinfo?.data?.track_info || json?.req_0?.data?.track_info
  if (!isUsableTrack(track)) throw new Error(`未获取到歌曲详情（songmid 可能无效或上游异常：${songmid || songid}）`)
  return normalizeDetail(track)
}

function normalizeDetail(track) {
  const song = normalizeSong(track)
  return {
    ...song,
    mediaMid: track?.file?.media_mid || '',
    albummid: song.albummid || track?.album?.mid || '',
  }
}

/**
 * 获取播放链接。
 *
 * 现状（2026 实测）：QQ 音乐播放接口已收紧——
 *  - 仅「现代签名网关 + 登录票据（comm.ct=19 + comm.authst=qqmusic_key）」能拿到 purl；
 *    旧网关（musicu.fcg, ct=24）对所有曲目一律返回 result=104003（无播放票据）。
 *  - 非会员账号通常只能取 128k/m4a；320k/flac/ape 需绿钻/会员（返回 result=22 / pneedbuy=1）。
 *  - filename 必须是 `{前缀}{strMediaMid 或 songmid}{扩展名}`。
 * 因此这里按请求音质生成候选链（高档→低档回退），并在签名网关无果时回退旧网关。
 *
 * @param {string} songmid
 * @param {object} params { quality, mediaMid }
 * @param {object} opts
 */
export async function getSongUrl(songmid, { quality = '320', mediaMid } = {}, opts = {}) {
  const auth = authOf(opts)
  const requested = normalizeQuality(quality)
  const candidates = QUALITY_FALLBACK[requested] || ['128', 'm4a']
  const filenames = candidates.map((q) => buildFilename(q, songmid, mediaMid))
  const guid = String(10000000 + Math.floor(Math.random() * 90000000))
  const uin = auth.uin || '0'
  const param = {
    filename: filenames,
    guid,
    songmid: filenames.map(() => songmid),
    songtype: filenames.map(() => 0),
    uin,
    loginflag: 1,
    platform: '20',
    ctx: 0,
  }
  const comm = { uin, format: 'json', ct: auth.authst ? 19 : 24, cv: 0, ...(auth.authst ? { authst: auth.authst } : {}) }

  // 1) 现代签名网关（登录态唯一可行通道）
  let json = null
  let signedErr = null
  try {
    json = await signedCgi(
      { module: 'music.vkey.GetEVkey', method: 'CgiGetEVkey', param },
      { ...opts, uin, authst: auth.authst },
    )
  } catch (e) {
    signedErr = e
  }
  let picked = pickPlayable(json, filenames)

  // 2) 回退旧网关（匿名/兼容）
  if (!picked.info?.purl) {
    try {
      const legacy = await musicu({ req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param }, loginUin: uin, comm }, opts)
      const legacyPicked = pickPlayable(legacy, filenames)
      if (legacyPicked.info?.purl) picked = legacyPicked
      else if (!picked.info) picked = legacyPicked
    } catch { /* 忽略回退失败，用签名网关结果 */ }
  }

  const info = picked.info
  const domain = pickPlayDomain(picked.sip)
  const purl = info?.purl || ''
  const url = purl ? joinPlayUrl(domain, purl) : ''
  const result = info?.result ?? null
  const matchedQuality = picked.quality || requested
  return {
    songmid,
    quality: matchedQuality,
    qualityLabel: QUALITY_MAP[matchedQuality]?.label || matchedQuality,
    requestedQuality: requested,
    url,
    filename: info?.filename || filenames[0],
    needLogin: !url && !auth.cookie,
    restriction: url ? null : classifyPlaybackRestriction(info, !!auth.cookie),
    result,
    ...(signedErr && !info ? { error: signedErr.message } : {}),
  }
}

/** 播放音质候选链：请求音质优先，逐级回退到非会员可听的 128/m4a */
const QUALITY_FALLBACK = {
  ape: ['ape', 'flac', '320', '128', 'm4a'],
  flac: ['flac', '320', '128', 'm4a'],
  320: ['320', '128', 'm4a'],
  128: ['128', 'm4a'],
  m4a: ['m4a', '128'],
}

/** 从 vkey 响应里按候选顺序挑出第一个有 purl 的项 */
function pickPlayable(json, filenames) {
  const d = json?.req_0?.data || {}
  const infos = Array.isArray(d.midurlinfo) ? d.midurlinfo : []
  for (const fn of filenames) {
    const hit = infos.find((i) => i.filename === fn && i.purl)
    if (hit) return { info: hit, sip: d.sip, quality: qualityFromFilename(hit.filename) }
  }
  const anyPurl = infos.find((i) => i.purl)
  if (anyPurl) return { info: anyPurl, sip: d.sip, quality: qualityFromFilename(anyPurl.filename) }
  return { info: infos[0] || null, sip: d.sip, quality: '' }
}

/** 播放失败归类（供工具层给出准确原因，而非笼统“没配 Cookie”） */
function classifyPlaybackRestriction(info, hasCookie) {
  const result = info?.result
  if (!hasCookie) return 'login_required'
  if (result === 104003) return 'playback_denied' // 登录票据存在但缺播放票据
  if (result === 22 || info?.pneedbuy === 1 || info?.pneed === 1) return 'vip_required'
  if (info?.isonly === 1) return 'trial_only'
  return 'url_unavailable'
}

/**
 * 歌词（旧网关 fcg_query_lyric_new，nobase64=1 返回明文）。
 * @param {object} params { songmid }
 * @param {object} opts
 */
export async function getLyric({ songmid } = {}, opts = {}) {
  if (!songmid) throw new Error('需要提供 songmid')
  const query = new URLSearchParams({
    songmid,
    format: 'json',
    nobase64: '1',
    outCharset: 'utf-8',
    pcachetime: String(Date.now()),
  })
  const json = await getJson(`${HOSTS.c}/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${query}`, opts)
  const retcode = Number(json?.retcode ?? 0)
  const lyric = decodeMaybeBase64(json?.lyric)
  const trans = decodeMaybeBase64(json?.trans)
  if (retcode < 0 && !lyric) throw new Error(`歌词接口返回错误（retcode=${retcode}）`)
  return { songmid, lyric: lyric || '', trans: trans || '' }
}

function decodeMaybeBase64(value) {
  const s = String(value ?? '')
  if (!s) return ''
  // nobase64=1 已返回带时间轴的明文；无换行且无 [ 才尝试 base64 解码
  if (s.includes('\n') || s.includes('[')) return s
  if (!/^[A-Za-z0-9+/=]+$/.test(s)) return s
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf8')
    return decoded || s
  } catch {
    return s
  }
}

/**
 * 榜单目录（现代签名网关 Toplist/GetAll，失败回退旧网关 toplist）。
 * @param {object} opts
 */
export async function getTopCategories(opts = {}) {
  try {
    const json = await signedCgi({ module: 'music.musicToplist.Toplist', method: 'GetAll', param: {} }, opts)
    const groups = json?.req_0?.data?.group || []
    const items = []
    for (const g of groups) {
      for (const t of g?.toplist || []) {
        items.push({
          topId: t.topId,
          title: t.title,
          group: g.groupName || '',
          period: t.period || t.updateTime || '',
          listenNum: Number(t.listenNum || 0) || 0,
          totalNum: Number(t.totalNum || 0) || 0,
          intro: truncate(t.intro, 120),
        })
      }
    }
    if (items.length) return items
  } catch {
    /* 回退旧网关 */
  }

  const json = await getJson(
    `${HOSTS.c}/v8/fcg-bin/fcg_myqq_toplist.fcg?format=json&outCharset=utf-8&platform=h5&needNewCode=1`,
    opts,
  )
  const list = json?.data?.topList || []
  return list.map((t) => ({
    topId: t.id,
    title: t.topTitle || '',
    group: '',
    period: '',
    listenNum: Number(t.listenCount || 0) || 0,
    totalNum: 0,
    intro: '',
    preview: (t.songList || []).map((s) => `${s.songname} - ${s.singername}`),
  }))
}

/**
 * 榜单歌曲（旧网关 fcg_v8_toplist_cp，含 songmid，可继续取播放链接）。
 * @param {number|string} topId
 * @param {object} params { limit, page }
 * @param {object} opts
 */
export async function getTopSongs(topId, { limit = 20, page = 1 } = {}, opts = {}) {
  const id = clampInt(topId, 1, 9999, 0)
  if (!id) throw new Error('无效的榜单 id')
  const n = clampInt(limit, 1, 100, 20)
  const p = clampInt(page, 1, 100, 1)
  const begin = (p - 1) * n
  const query = new URLSearchParams({
    topid: String(id),
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    notice: '0',
    platform: 'h5',
    needNewCode: '1',
    tpl: '3',
    page: 'detail',
    type: 'top',
    song_begin: String(begin),
    song_num: String(n),
  })
  const json = await getJson(`${HOSTS.c}/v8/fcg-bin/fcg_v8_toplist_cp.fcg?${query}`, opts)
  const list = json?.songlist || []
  const songs = list.map((item) => normalizeSong(item?.data || item)).filter(Boolean)
  const total = Number(json?.total_song_num || json?.cur_song_num || songs.length) || songs.length
  return { topId: id, page: p, limit: n, total, topinfo: { name: json?.topinfo?.ListName || json?.topinfo?.name || '' }, songs }
}

/**
 * 歌单详情（旧网关 fcg_ucc_getcdinfo_byids_cp）。
 * @param {number|string} id 歌单 id（disstid）
 * @param {object} params { limit, page }
 * @param {object} opts
 */
export async function getPlaylist(id, { limit = 30, page = 1 } = {}, opts = {}) {
  const disstid = String(id || '').replace(/\D/g, '')
  if (!disstid) throw new Error('无效的歌单 id')
  const n = clampInt(limit, 1, 100, 30)
  const p = clampInt(page, 1, 100, 1)
  const query = new URLSearchParams({
    disstid,
    type: '1',
    json: '1',
    utf8: '1',
    onlysong: '0',
    new_format: '1',
    format: 'json',
    outCharset: 'utf-8',
  })
  const json = await getJson(`${HOSTS.c}/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?${query}`, opts)
  const cd = json?.cdlist?.[0]
  if (!cd) throw new Error('未获取到歌单（id 可能无效或歌单已删除）')
  const all = (cd.songlist || []).map((s) => normalizeSong(s)).filter(Boolean)
  const start = (p - 1) * n
  return {
    id: disstid,
    name: cd.dissname || '',
    desc: truncate(cd.desc || '', 200),
    cover: cd.logo || '',
    total: all.length,
    page: p,
    limit: n,
    songs: all.slice(start, start + n),
  }
}

function truncate(text, max) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export { normalizeQuality }
