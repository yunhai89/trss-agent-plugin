/**
 * 渲染前图片内联 —— 把 HTML 里 <img src="远程url"> 的图片下载转 base64 data URL 内联进 HTML。
 *
 * 解决两个问题：
 *   1. 防盗链：米游社等图片域名检查 Referer，puppeteer 截图时浏览器直接加载被拒
 *      → 服务端带 Referer 下载后内联，截图不再走浏览器网络。
 *   2. 可靠性：内联后截图不依赖浏览器加载，规避加载失败/超时导致的图位空白。
 *
 * 安全：SSRF 校验（拒绝私网/loopback/非 http(s)）；限制：并发/超时/字节/数量；
 *       下载或解码失败 → 移除该 <img>、留 alt 文本，不阻塞渲染。
 * 参考 OpenClaw managed-image-attachments.ts（下载→resize→内联）+ 自补 Referer 伪造 / 小图筛选
 * （这两样 OpenClaw 未做）。
 */

import Log from '../../utils/Log.js'
import { assertUrlAllowed } from '../stagehand/guard.js'

/** 默认 Referer 域名映射：按图片 host 匹配，解决防盗链（米游社系图床需 www.miyoushe.com）*/
const DEFAULT_REFERERS = {
  'webstatic.mihoyo.com': 'https://www.miyoushe.com',
  'upload-bbs.mihoyo.com': 'https://www.miyoushe.com',
  'upload.miyoushe.com': 'https://www.miyoushe.com',
  'bbs.mihoyo.com': 'https://www.miyoushe.com',
}

const LIMITS = {
  maxImages: 8, // 单条回复最多内联图片数
  maxBytes: 3 * 1024 * 1024, // 单张字节上限（下载后）
  concurrency: 5, // 并发下载数
  timeoutMs: 8000, // 单张下载超时
  minEdge: 300, // 小图筛选：任一边 <300px 丢弃（去头像/图标/表情）
  maxEdge: 1400, // resize：最长边上限
  jpegQuality: 0.85,
}

/**
 * SSRF 校验：拒绝非 http(s)、loopback、私网、link-local、元数据地址与解析到内网的域名。
 *
 * 曾自行实现一套正则：`host === '::1'` 永远匹配不到 IPv6 字面量（URL.hostname 形如 `[::1]`），
 * `fd00::/8`、`::ffff:127.0.0.1`、十进制/十六进制混淆写法也全都能绕过。
 * 现统一复用 stagehand/guard.js 的 assertUrlAllowed（含宽松 IPv4、IPv6 映射/NAT64/6to4、
 * 域名解析结果全量校验），保持全仓一套 SSRF 判据。
 */
async function isAllowedRemoteUrl(raw) {
  const r = await assertUrlAllowed(raw).catch(() => ({ ok: false }))
  return !!r?.ok
}

/** 按图片 host 选 Referer（DEFAULT_REFERERS + 调用方 refererMap）*/
function pickReferer(imgUrl, refererMap = {}) {
  let u
  try { u = new URL(imgUrl) } catch { return null }
  const host = u.hostname.toLowerCase()
  const map = { ...DEFAULT_REFERERS, ...refererMap }
  for (const [k, v] of Object.entries(map)) {
    if (host === k || host.endsWith('.' + k)) return v
  }
  return null
}

/**
 * 带 Referer + 超时下载图片，返回 { buf, mime } 或 null。
 * 重定向逐跳复验：`redirect:'follow'` 会让"公网 URL 302 到 127.0.0.1/元数据地址"绕过入口校验，
 * 故改为 manual，每跳重新跑 SSRF 判定（上限 3 跳），并默认限制在 3MB 内。
 */
async function download(url, refererMap, depth = 0) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LIMITS.timeoutMs)
  try {
    const referer = pickReferer(url, refererMap)
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; agents-plugin)',
        Accept: 'image/*,*/*;q=0.8',
        ...(referer ? { Referer: referer } : {}),
      },
    })
    // 重定向：逐跳复验目标地址（防 302 到内网/元数据）
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc || depth >= 3) return null
      let next
      try { next = new URL(loc, url).href } catch { return null }
      if (!(await isAllowedRemoteUrl(next))) return null
      return await download(next, refererMap, depth + 1)
    }
    if (!res.ok) return null
    const len = Number(res.headers.get('content-length') || 0)
    if (len && len > LIMITS.maxBytes) return null // 声明且超大 → 省下载
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf || buf.length > LIMITS.maxBytes || buf.length < 100) return null
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (mime && !mime.startsWith('image/')) return null
    return { buf, mime: mime || 'image/jpeg' }
  } catch { return null } finally { clearTimeout(timer) }
}

/**
 * 解码 + 小图筛选 + resize + 编码为 data URL（@napi-rs/canvas，已装）。
 * @returns {Promise<{dataUrl?:string, skip?:boolean}>} skip=true 表示被小图筛掉
 */
async function processToDataUrl(buf) {
  const { loadImage, createCanvas } = await import('@napi-rs/canvas')
  const img = await loadImage(buf)
  if (!img.width || !img.height) throw new Error('empty image')
  if (img.width < LIMITS.minEdge || img.height < LIMITS.minEdge) return { skip: true } // 小图/图标/头像丢弃
  let w = img.width
  let h = img.height
  if (Math.max(w, h) > LIMITS.maxEdge) {
    const s = LIMITS.maxEdge / Math.max(w, h)
    w = Math.round(w * s)
    h = Math.round(h * s)
  }
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff' // JPEG 无 alpha，白底避免透明区变黑
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  const out = canvas.toBuffer('image/jpeg', { quality: LIMITS.jpegQuality })
  return { dataUrl: `data:image/jpeg;base64,${out.toString('base64')}` }
}

/** 并发限制执行（保序） */
async function pMap(items, fn, concurrency = 5) {
  const ret = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      ret[idx] = await fn(items[idx], idx).catch(() => null)
    }
  }
  const ws = []
  for (let k = 0; k < Math.min(concurrency, items.length); k++) ws.push(worker())
  await Promise.all(ws)
  return ret
}

/** 把 img 标签里的 src 替换为 dataUrl（base64 不含引号，双引号包裹安全）*/
function replaceSrc(imgTag, dataUrl) {
  return imgTag.replace(/(\bsrc=)["'][^"']*["']/i, `$1"${dataUrl}"`)
}

/** 移除 img 标签、留 alt 文本（避免图位空白/占位破坏布局）*/
function imgToAlt(imgTag) {
  const alt = imgTag.match(/\balt=["']([^"']*)["']/i)
  return alt && alt[1] ? alt[1] : ''
}

/**
 * 把 HTML 里 <img src="远程url"> 的图片下载转 base64 data URL 内联。
 * @param {string} html mdToHtml 输出的 HTML（含 <img>）
 * @param {object} opts { refererMap?:object, maxImages?:number }
 * @returns {Promise<string>} 内联后的 HTML（图片失败的 <img> 被替换为 alt 文本）
 */
export async function inlineImages(html, opts = {}) {
  if (!html || html.indexOf('<img') === -1) return html
  const refererMap = opts.refererMap || {}
  const maxImages = opts.maxImages || LIMITS.maxImages

  // 收集所有 <img>（任意 src），按协议分类
  const imgRe = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*\/?>/gi
  const http = [] // http(s) 远程图：内联候选
  const remove = [] // 非 http(s)/data 的 img（file:/javascript:/相对路径等）+ 超上限的 → 移除
  let m
  while ((m = imgRe.exec(html)) !== null) {
    const raw = m[0]
    const url = m[1]
    if (/^https?:\/\//i.test(url)) {
      if (http.length < maxImages) http.push({ raw, url })
      else remove.push({ raw }) // 超上限
    } else if (/^data:/i.test(url)) {
      // data URL 已内联，保留不动
    } else {
      remove.push({ raw }) // 安全防御：移除非 http(s)/data 的 img src
    }
  }
  if (!http.length && !remove.length) return html

  // SSRF 过滤（异步：含域名解析，防 DNS 指向内网）
  const checks = await pMap(http, async (x) => ({ x, ok: await isAllowedRemoteUrl(x.url) }), 5)
  const valid = checks.filter((c) => c.ok).map((c) => c.x)
  const httpRemove = checks.filter((c) => !c.ok).map((c) => c.x) // SSRF 非法 → 移除

  // 并发下载 + 处理
  const results = await pMap(valid, async (x) => {
    const dl = await download(x.url, refererMap)
    if (!dl) return { ...x, dataUrl: null }
    const r = await processToDataUrl(dl.buf).catch(() => null)
    return { ...x, dataUrl: r?.dataUrl || null }
  })

  // 替换：成功的换 src=dataUrl；失败/SSRF/超上限/非http → 移除留 alt
  let out = html
  for (const r of results) {
    if (!r) continue
    const repl = r.dataUrl ? replaceSrc(r.raw, r.dataUrl) : imgToAlt(r.raw)
    out = out.split(r.raw).join(repl) // split/join 避免 raw 里正则元字符
  }
  for (const x of [...httpRemove, ...remove]) {
    out = out.split(x.raw).join(imgToAlt(x.raw))
  }
  const inlined = results.filter((r) => r?.dataUrl).length
  if (inlined) Log.debug('[render:inline]', `内联 ${inlined}/${http.length} 张图片`)
  return out
}
