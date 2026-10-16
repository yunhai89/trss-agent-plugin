/**
 * QQ 音乐工具辅助函数（纯函数，无网络 / 无 Config 依赖，便于离线测试）。
 */

/** 固定上游域名（仅允许这些域名，防 SSRF） */
export const HOSTS = {
  c: 'https://c.y.qq.com',
  u: 'https://u.y.qq.com',
  u6: 'https://u6.y.qq.com',
  img: 'https://y.gtimg.cn',
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 默认请求头（QQ 音乐 web 端要求 Referer，否则返回 -1310 等错误） */
export function defaultHeaders(cookie) {
  const headers = {
    'User-Agent': DEFAULT_UA,
    Referer: 'https://y.qq.com/',
    Origin: 'https://y.qq.com',
  }
  const c = normalizeCookie(cookie)
  if (c) headers.Cookie = c
  return headers
}

/** 音质映射：filename 前缀 + 扩展名 */
export const QUALITY_MAP = {
  128: { prefix: 'M500', ext: '.mp3', label: '128kbps MP3' },
  320: { prefix: 'M800', ext: '.mp3', label: '320kbps MP3' },
  m4a: { prefix: 'C400', ext: '.m4a', label: 'M4A' },
  flac: { prefix: 'F000', ext: '.flac', label: 'FLAC' },
  ape: { prefix: 'A000', ext: '.ape', label: 'APE' },
}

/** 归一化音质参数，非法值回退 fallback */
export function normalizeQuality(value, fallback = '320') {
  const v = String(value ?? '').trim().toLowerCase()
  if (QUALITY_MAP[v]) return v
  return QUALITY_MAP[fallback] ? fallback : '320'
}

/** 拼接歌曲文件名：`{前缀}{mediaMid 或 songmid}{扩展名}`（有 strMediaMid 时必须用它） */
export function buildFilename(quality, songmid, mediaMid) {
  const q = QUALITY_MAP[normalizeQuality(quality)]
  return `${q.prefix}${mediaMid || songmid}${q.ext}`
}

/** 由 filename 前缀反推音质 key（找不到返回 ''） */
export function qualityFromFilename(filename) {
  const s = String(filename || '')
  for (const [key, q] of Object.entries(QUALITY_MAP)) {
    if (s.startsWith(q.prefix)) return key
  }
  return ''
}

/** cookie 归一化：字符串原样；对象 k=v 拼接 */
export function normalizeCookie(cookie) {
  if (!cookie) return ''
  if (typeof cookie === 'string') return cookie.trim()
  if (typeof cookie === 'object') {
    return Object.entries(cookie)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }
  return ''
}

function cookieValue(cookie, keys) {
  const text = normalizeCookie(cookie)
  if (!text) return ''
  for (const key of keys) {
    const m = text.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`, 'i'))
    // cookie 里的 % 序列可能是字面量（如已解码过的值含 '%'），decodeURIComponent 会抛 URIError；
    // 这里降级返回原串，避免异常逃出工具 try 块导致整次调用失败。
    if (m && m[1]) {
      const v = m[1].trim()
      try { return decodeURIComponent(v) } catch { return v }
    }
  }
  return ''
}

/** 从 cookie 解析登录 uin（去掉 QQ 惯用的 `o` 前缀） */
export function parseUinFromCookie(cookie) {
  const raw = cookieValue(cookie, ['qqmusic_uin', 'uin', 'wxuin', 'l_uin', 'p_uin'])
  const digits = raw.replace(/^o/i, '')
  return /^\d+$/.test(digits) ? digits : ''
}

/** 从 cookie 解析播放鉴权 authst */
export function parseAuthstFromCookie(cookie) {
  return cookieValue(cookie, ['qqmusic_key', 'qm_keyst'])
}

/** 上下限裁剪整数 */
export function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** songmid 合法性（QQ 音乐 mid 为 12~16 位字母数字） */
export function isValidSongmid(mid) {
  return typeof mid === 'string' && /^[0-9A-Za-z]{10,20}$/.test(mid)
}

/** 播放域名选择：优先 https、避开 http://ws 旧域 */
export function pickPlayDomain(sip) {
  if (!Array.isArray(sip)) return ''
  const urls = sip.filter((s) => typeof s === 'string' && s)
  return (
    urls.find((u) => u.startsWith('https://')) ||
    urls.find((u) => !u.startsWith('http://ws')) ||
    urls[0] ||
    ''
  )
}

/** 域名 + 路径安全拼接（仅接受 qq.com 系域名） */
export function joinPlayUrl(domain, path) {
  if (!domain || !path) return ''
  if (!isQqHost(domain)) return ''
  const d = domain.endsWith('/') ? domain.slice(0, -1) : domain
  const p = path.startsWith('/') ? path : `/${path}`
  return `${d}${p}`
}

/** 判断是否 QQ 音乐域（用于播放链接白名单，防 SSRF） */
export function isQqHost(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return host === 'qq.com' || host.endsWith('.qq.com')
  } catch {
    return false
  }
}

/** 去除高亮 HTML 标签（搜索结果字段可能含 <em>） */
export function stripTags(text) {
  return String(text ?? '').replace(/<[^>]*>/g, '')
}

/** 秒 → mm:ss */
export function fmtDuration(sec) {
  const s = Number(sec)
  if (!Number.isFinite(s) || s < 0) return ''
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${m}:${String(r).padStart(2, '0')}`
}

/** 专辑封面 URL（QQ 音乐 CDN，按 albummid） */
export function coverUrl(albummid, size = 300) {
  const mid = String(albummid || '').trim()
  if (!mid) return ''
  return `${HOSTS.img}/music/photo_new/T002R${size}x${size}M000${mid}.jpg`
}

/** 无封面时的兜底图（QQ 音乐分享卡片 image 必填，NapCat 自定义卡片缺 image 会被拒） */
export const DEFAULT_COVER = 'https://p.qpic.cn/qqconnect/0/app_100497308_1626060999/100'

/** 歌曲网页详情页（分享卡片跳转目标） */
export function songJumpUrl(songmid) {
  return `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(String(songmid || ''))}`
}

/** 把各接口的歌曲对象归一为统一字段 */
export function normalizeSong(raw) {
  if (!raw || typeof raw !== 'object') return null
  const src = raw.data && typeof raw.data === 'object' ? { ...raw.data, ...raw } : raw
  const mid = src.songmid || src.mid || ''
  const name = stripTags(src.songname || src.name || src.title || '')
  const singers = (Array.isArray(src.singer) ? src.singer : [])
    .map((s) => stripTags(s?.name || s?.title || ''))
    .filter(Boolean)
  if (!singers.length && src.singerName) singers.push(stripTags(src.singerName))
  const albumRaw = src.albumname || src.album?.name || ''
  const album = stripTags(albumRaw)
  const albumMid = src.albummid || src.albumMid || src.album?.mid || ''
  const interval = Number(src.interval || 0)
  const id = src.songid || src.id || src.songId || 0
  return {
    songmid: mid,
    songid: id,
    name,
    singers,
    album,
    albummid: albumMid,
    durationSec: interval,
    duration: fmtDuration(interval),
  }
}
