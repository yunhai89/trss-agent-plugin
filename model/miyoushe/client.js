/**
 * 米游社（miyoushe / 米哈游社区 BBS）API 客户端 —— 移植自 miyoushe.service.ts。
 *
 * 关键：DS 签名（salt + 时间戳 + 随机串 → md5），设备 id，固定请求头。
 * fetcher 可注入（便于离线测试）；无则用 globalThis.fetch。
 * 零新增依赖：仅用 node:crypto。
 */

import crypto from 'node:crypto'

export const MIYOUSHE_CONFIG = {
  appVersion: '2.104.0',
  clientType: '4',
  salt: 'EJncUPGnOHajenjLhBOsdpwEMZmiCmQX',
  referer: 'https://www.miyoushe.com',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  apiBase: 'https://bbs-api.mihoyo.com',
}

/** 官方 gid 对照：1=崩坏三 2=原神 3=崩坏学院2 4=未定事件簿 6=星穹铁道 8=绝区零 */
export const GAME_GIDS = {
  原神: 2, 崩坏星穹铁道: 6, 星穹铁道: 6, 崩坏3: 1, 崩坏三: 1,
  绝区零: 8, 未定事件簿: 4, 崩坏学院2: 3,
}
export const GID_PATHS = { 1: 'bh3', 2: 'ys', 3: 'bh2', 4: 'wd', 6: 'sr', 8: 'zzz' }
export const GID_NAMES = { 1: '崩坏三', 2: '原神', 3: '崩坏学院2', 4: '未定事件簿', 6: '崩坏星穹铁道', 8: '绝区零' }

function md5(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex')
}

function getRandomStr(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length))
  return result
}

/** 生成 DS 签名：t,r,md5(salt=&t=&r=) */
export function generateDS(salt = MIYOUSHE_CONFIG.salt) {
  const t = Math.floor(Date.now() / 1000)
  const r = getRandomStr(6)
  return `${t},${r},${md5(`salt=${salt}&t=${t}&r=${r}`)}`
}

/** 拼接查询串（保持键排序以保证 DS/缓存稳定；值统一 URL 编码，避免 & / # 拆参数） */
function sortedQueryString(obj) {
  if (!obj || !Object.keys(obj).length) return ''
  const params = new URLSearchParams()
  for (const k of Object.keys(obj).sort()) params.set(k, String(obj[k]))
  return params.toString()
}

export function buildHeaders(cookie) {
  const headers = {
    'x-rpc-app_version': MIYOUSHE_CONFIG.appVersion,
    'x-rpc-client_type': MIYOUSHE_CONFIG.clientType,
    'x-rpc-device_id': crypto.randomUUID().replace(/-/g, '').toUpperCase(),
    'X-Requested-With': 'XMLHttpRequest',
    DS: generateDS(),
    Referer: MIYOUSHE_CONFIG.referer,
    'User-Agent': MIYOUSHE_CONFIG.userAgent,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Origin: 'https://www.miyoushe.com',
    Host: 'bbs-api.mihoyo.com',
  }
  if (cookie) headers.Cookie = String(cookie).replace(/[^\x20-\x7E]/g, '')
  return headers
}

/** HTML → 纯文本 */
export function htmlToText(html) {
  if (!html) return ''
  let text = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  text = text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/** 从 HTML 抽取图片 URL（去重） */
export function extractImagesFromHtml(html) {
  if (!html) return []
  const urls = []
  const regex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi
  let match
  while ((match = regex.exec(String(html))) !== null) urls.push(match[1])
  return [...new Set(urls)]
}

/** 帖子解析（详情接口状态在 post.post_status，搜索在 post.stat） */
export function parsePostFromItem(item, gid = 2) {
  const post = item?.post || {}
  const user = item?.user || {}
  const imageList = item?.image_list || []
  const topics = item?.topics || []
  const forum = item?.forum || {}
  const postStatus = post.post_status || post.stat || {}

  const rawHtml = post.content || ''
  const plainText = htmlToText(rawHtml)
  const htmlImages = extractImagesFromHtml(rawHtml)
  const allImages = [...new Set([...imageList.map((img) => img.url || img), ...htmlImages])]
  const gamePath = GID_PATHS[gid] || 'ys'

  return {
    postId: post.post_id,
    title: post.subject || '',
    content: rawHtml,
    plainText,
    summary: post.summary || '',
    cover: post.cover || '',
    images: allImages,
    stats: {
      like: postStatus.like_num ?? 0,
      reply: postStatus.reply_num ?? 0,
      collect: postStatus.bookmark_num ?? postStatus.collect_num ?? 0,
      view: postStatus.view_num ?? 0,
      share: postStatus.forward_num ?? 0,
    },
    flags: {
      isTop: !!postStatus.is_top,
      isGood: !!postStatus.is_good,
      isOfficial: !!postStatus.is_official,
      isOriginal: post.is_original === 1,
    },
    author: {
      uid: user.uid || '',
      nickname: user.nickname || '匿名',
      avatar: user.avatar_url || user.avatar || '',
      level: user.level_exp?.level || 0,
    },
    forum: { id: forum.id || '', name: forum.name || '' },
    topics: topics.map((t) => t.name || ''),
    createdAt: post.created_at || 0,
    link: `https://www.miyoushe.com/${gamePath}/article/${post.post_id}`,
  }
}

/** 单个请求默认超时（毫秒）——上游卡死时不至于永久占住工具调用 */
export const MIYOUSHE_TIMEOUT_MS = 15000

async function request(url, { fetcher, cookie, signal } = {}) {
  const f = fetcher || globalThis.fetch
  if (!f) throw new Error('米游社请求需要 fetcher 或 globalThis.fetch')
  const opts = { method: 'GET', headers: buildHeaders(cookie) }
  const timeoutSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(MIYOUSHE_TIMEOUT_MS)
    : null
  const combined = signal && timeoutSignal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeoutSignal])
    : signal || timeoutSignal
  if (combined) opts.signal = combined
  const res = await f(url, opts)
  if (!res.ok) throw new Error(`米游社请求失败: ${res.status}`)
  const data = await res.json()
  if (data.retcode !== 0) throw new Error(`米游社 API 错误: [${data.retcode}] ${data.message}`)
  return data.data
}

/** 搜索帖子 */
export async function searchPosts(keyword, { gid = 2, page = 1, pageSize = 5, cookie, fetcher, signal } = {}) {
  const query = sortedQueryString({ gids: String(gid), keyword, page: String(page), page_size: String(pageSize) })
  const url = `${MIYOUSHE_CONFIG.apiBase}/post/wapi/searchPosts?${query}`
  const data = await request(url, { fetcher, cookie, signal })
  const posts = (data?.posts || []).map((item) => parsePostFromItem(item, gid))
  return { keyword, posts }
}

/** 帖子详情 */
export async function getPostDetail(postId, { gid = 2, cookie, fetcher, signal } = {}) {
  const query = sortedQueryString({ gids: String(gid), post_id: String(postId), read: '1' })
  const url = `${MIYOUSHE_CONFIG.apiBase}/post/wapi/getPostFull?${query}`
  const data = await request(url, { fetcher, cookie, signal })
  return parsePostFromItem(data?.post || {}, gid)
}

/** 帖子评论（失败返回空数组，不抛错） */
export async function getPostReplies(postId, { gid = 2, isHot = true, size = 5, cookie, fetcher, signal } = {}) {
  const query = sortedQueryString({ gids: String(gid), is_hot: String(isHot), post_id: String(postId), size: String(size) })
  const url = `${MIYOUSHE_CONFIG.apiBase}/post/wapi/getPostReplies?${query}`
  let data
  try { data = await request(url, { fetcher, cookie, signal }) } catch { return [] }
  return (data?.list || []).map((item) => {
    const reply = item.reply || item
    const user = item.user || {}
    return {
      replyId: reply.reply_id || '',
      content: htmlToText(reply.content || ''),
      like: reply.like_num || 0,
      author: { nickname: user.nickname || '匿名', level: user.level_exp?.level || 0 },
      createdAt: reply.created_at || 0,
    }
  })
}

/** 游戏名 → gid（模糊匹配，默认原神 2；也接受纯数字 gid） */
export function getGameGid(gameName) {
  if (gameName == null) return 2
  const s = String(gameName).trim()
  if (!s) return 2
  // 工具 schema 声明「游戏名或 gid」：数字 gid 直接放行（此前会走 name.includes → 回落原神 2）
  if (/^\d+$/.test(s) && GID_NAMES[Number(s)] != null) return Number(s)
  if (GAME_GIDS[s] != null) return GAME_GIDS[s]
  for (const [name, gid] of Object.entries(GAME_GIDS)) {
    if (s.includes(name) || name.includes(s)) return gid
  }
  return 2
}

export function getGameList() {
  return Object.entries(GID_NAMES)
    .map(([gid, name]) => `${name}(gid=${gid})`)
    .join('、')
}
