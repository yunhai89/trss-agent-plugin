/**
 * 媒体解析 —— 把 MediaFile 描述符解析为 {buffer, mime, ext, bytes}。
 *
 * 框架优先：Bot.download(url) → {buffer}；Bot.fileType({file}) → {type:{mime,ext}}。
 * 兜底自实现：无 Bot 时用 fetcher(node-fetch) 取字节 + inferMime 魔数嗅探（零依赖）。
 * 链接发现：url 缺失时尝试 getFileUrl/fs.download（群文件场景）。
 *
 * NapCat/OneBot 直连兜底（关键）：引用消息、历史消息里的图片/文件经 get_msg 取到时往往
 * 没有 url（或已过期，见 napcat 文档 §13.7），群文件段只有 file_id。此时若拿到事件 e，
 * 直接调 OneBot 原生接口取字节：
 *   - get_file(file_id) → 返回 base64 / url（文件类，最稳，base64 不依赖共享文件系统）
 *   - get_image(file)   → 返回本地路径或 url（图片）
 *   - get_record(file)  → 返回语音路径（audio）
 */

import fs from 'node:fs'

const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', log: 'text/plain',
  html: 'text/html', htm: 'text/html', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
  js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python', java: 'text/x-java',
  c: 'text/x-c', cpp: 'text/x-cpp', go: 'text/x-go', rs: 'text/x-rust', sh: 'application/x-sh',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  flv: 'video/x-flv', wmv: 'video/x-ms-wmv', m4v: 'video/x-m4v', '3gp': 'video/3gpp', mpeg: 'video/mpeg', mpg: 'video/mpeg',
  ts: 'video/mp2t', m2ts: 'video/mp2t',
  avif: 'image/avif', heic: 'image/heic', heif: 'image/heic',
  zip: 'application/zip', '7z': 'application/x-7z-compressed', gz: 'application/gzip', tar: 'application/x-tar',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

const MIME_EXT = Object.fromEntries(Object.entries(EXT_MIME).map(([e, m]) => [m, e]))

/** 魔数嗅探（零依赖）—— 命中常见格式；不命中返回 null */
export function sniffMagic(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null
  const h = buf
  // PNG / JPG / GIF / BMP
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return 'image/png'
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'image/jpeg'
  if (h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46) return 'image/gif'
  if (h[0] === 0x42 && h[1] === 0x4d) return 'image/bmp'
  // RIFF: webp / wav / avi
  if (h.length >= 12 && h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46) {
    const fourcc = buf.toString('ascii', 8, 12)
    if (fourcc === 'WEBP') return 'image/webp'
    if (fourcc === 'WAVE') return 'audio/wav'
    if (fourcc === 'AVI ') return 'video/x-msvideo'
  }
  // EBML: matroska(.mkv) / webm
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) {
    const head = buf.toString('latin1', 0, Math.min(buf.length, 128)).toLowerCase()
    return head.includes('webm') ? 'video/webm' : 'video/x-matroska'
  }
  // FLV
  if (h[0] === 0x46 && h[1] === 0x4c && h[2] === 0x56 && h[3] === 0x01) return 'video/x-flv'
  // MPEG-PS / MPEG-ES（00 00 01 BA/B3）
  if (h[0] === 0x00 && h[1] === 0x00 && h[2] === 0x01 && (h[3] === 0xba || h[3] === 0xb3)) return 'video/mpeg'
  // PDF
  if (h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46) return 'application/pdf'
  // ZIP 家族（docx/xlsx/pptx/zip/odt 等 —— 统称 zip，按扩展名细化在外层）
  if (h[0] === 0x50 && h[1] === 0x4b && (h[2] === 0x03 || h[2] === 0x05 || h[2] === 0x07)) return 'application/zip'
  // OGG
  if (h[0] === 0x4f && h[1] === 0x67 && h[2] === 0x67 && h[3] === 0x53) return 'audio/ogg'
  // ID3 / MP3
  if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) return 'audio/mpeg'
  if (h[0] === 0xff && (h[1] === 0xfb || h[1] === 0xf3 || h[1] === 0xf2)) return 'audio/mpeg'
  // ISO BMFF (ftyp)：按 major_brand 细分 mp4/mov/m4a/3gp/avif/heic
  if (h.length >= 12 && h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70) {
    const brand = buf.toString('ascii', 8, 12)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return 'image/heic'
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4'
    if (brand === 'qt  ') return 'video/quicktime'
    if (brand.startsWith('3gp') || brand.startsWith('3g2')) return 'video/3gpp'
    return 'video/mp4'
  }
  return null
}

/**
 * 综合名称扩展 + 魔数推断 mime。
 *
 * **魔数优先**：名称/扩展名常与实际字节不符（QQ 图片转码、改扩展名、file 字段是哈希名），
 * 而 Anthropic 等端点对 image 块的 media_type 强校验「声明类型必须与内容一致」，按名称下发的
 * image/jpeg 配 PNG 字节会直接 400（inline image declared media type does not match its content）。
 * 故先按字节判定，仅当魔数无结论时才回退名称扩展。
 */
export function inferMime(name, buf) {
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  const nameMime = ext ? EXT_MIME[ext] : null
  // 1) 魔数（对 zip 家族再用名称扩展细化 docx/xlsx 等）
  const magic = sniffMagic(buf)
  if (magic) {
    if (magic === 'application/zip' && ext && /^(docx|xlsx|pptx|odt|ods|odp)$/.test(ext)) {
      return { mime: EXT_MIME[ext] || magic, ext }
    }
    // ftyp 家族魔数只到 video/mp4 粒度；名称明确是音频容器（m4a/mp4a）时保留名称类型
    if (magic === 'video/mp4' && nameMime?.startsWith('audio/')) return { mime: nameMime, ext }
    return { mime: magic, ext: MIME_EXT[magic] || ext || null }
  }
  // 2) 名称扩展（魔数无结论）
  if (nameMime) return { mime: nameMime, ext }
  // 3) 文本嗅探（无 NUL 字节 → utf8 文本）
  if (Buffer.isBuffer(buf) && buf.length && !buf.slice(0, Math.min(buf.length, 1024)).includes(0)) {
    return { mime: 'text/plain', ext: ext || 'txt' }
  }
  return { mime: 'application/octet-stream', ext: ext || 'bin' }
}

export function mimeFromName(name) {
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  return ext ? EXT_MIME[ext] || null : null
}

export function asBase64(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('base64') : ''
}

/** 是否文本类（可直接 utf8 解码喂给模型） */
export function isTextLike(mime) {
  return !!mime && /^(text\/|application\/(json|xml|javascript|x-sh|x-python|x-yaml))/.test(mime)
}

/** 是否图片（视觉模型可识） */
export function isImage(mime) {
  return !!mime && mime.startsWith('image/')
}

/** 截断文本（按字符，避免超大文件撑爆上下文） */
export function truncateText(buf, maxChars = 12000) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '')
  if (s.length <= maxChars) return s
  return `${s.slice(0, maxChars)}\n…[已截断，共 ${s.length} 字符]`
}

/** http(s) 取字节：带超时 + 1 次重试。CDN 抖动/慢响应时裸 fetch 会偶发失败被上层静默吞掉，
 *  导致整张图丢失；这里对超时/网络类错误重试一次，4xx 等非瞬态错误不重试。 */
async function httpToBuffer(fetchFn, url, { timeout = 30000, retries = 1 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (agents-plugin)' } }
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        opts.signal = AbortSignal.timeout(timeout)
      }
      const res = await fetchFn(url, opts)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      lastErr = err
      const transient = err?.name === 'AbortError'
        || /timeout|fetch failed|ECONN|ETIMEDOUT|EAI_|socket hang up|network/i.test(err?.message || '')
      if (!transient) break
    }
  }
  throw lastErr || new Error('http fetch failed')
}

/** 从 base64://、http(s)://、file://、裸路径等多种来源取 Buffer */
async function toBuffer(source, { bot, fetcher }) {
  if (Buffer.isBuffer(source)) return source
  if (typeof source !== 'string') return null
  // 框架优先：Bot.Buffer 统一处理所有形态（含临时 file:// 溢出）
  if (bot?.Buffer) {
    try { const b = await bot.Buffer(source, {}); if (Buffer.isBuffer(b)) return b } catch { /* noop */ }
  }
  if (source.startsWith('base64://')) return Buffer.from(source.slice(9), 'base64')
  if (/^https?:\/\//i.test(source)) {
    const f = fetcher || globalThis.fetch
    if (f) return await httpToBuffer(f, source)
  }
  // 本地路径（get_image/get_file/get_record 返回的 NapCat 本地路径；同机部署可直接读）
  const localPath = source.startsWith('file://') ? source.slice(7) : source
  if (source.startsWith('file://') || /^([\/~]|[a-zA-Z]:[\\/])/.test(source)) {
    try { return fs.readFileSync(localPath) } catch { /* noop */ }
  }
  return null
}

/** 从 OneBot sendApi 的（可能被 Proxy 包装的）返回里取字段 */
function pickField(r, ...keys) {
  if (!r) return null
  for (const k of keys) {
    const v = r[k] ?? r?.data?.[k]
    if (v) return v
  }
  return null
}

/**
 * NapCat/OneBot 原生接口取字节（引用/历史/群文件场景，url 缺失或下载失败时的兜底）。
 * 需要 e.bot.sendApi；调用方无 e 时直接返回 null。
 */
async function napcatBytes(mf, e, { bot, fetcher, log }) {
  const sendApi = e?.bot?.sendApi
  if (typeof sendApi !== 'function') return null
  const seg = mf.segment || {}
  // 回填直链：引用/历史消息段常常本就没有 url（NapCat get_msg 取回的引用消息尤甚）。
  // 这里只要 napcat 给出了一个 http 直链，就写回 mf.url —— 哪怕最终字节仍取不到，
  // 上层 describeImages 也能把这个地址交给主模型/MCP，不再"没有图片可看"。
  const rememberUrl = (u) => {
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) mf.url = mf.url || u
  }
  try {
    // 文件类（file_id）→ get_file 返回 base64 / url（base64 不依赖共享文件系统，最稳）
    const fileId = seg.file_id || mf.fid
    if (fileId) {
      const r = await sendApi('get_file', { file_id: fileId })
      rememberUrl(pickField(r, 'url'))
      const b64 = pickField(r, 'base64')
      if (b64) return Buffer.from(b64, 'base64')
      const url = pickField(r, 'url')
      if (url) { const b = await toBuffer(url, { bot, fetcher }); if (b) return b }
    }
    // 图片/语音/视频/文件（file 标识）→ 各专用接口返回本地路径或 url。
    // NapCat 文档：图片 get_file 失败再降级 get_image；语音 get_record；**视频只用 get_file，无 get_image 降级**。
    const file = seg.file
    if (file) {
      const action = mf.kind === 'audio' ? 'get_record' : mf.kind === 'image' ? 'get_image' : 'get_file'
      const params = action === 'get_record' ? { file, out_format: 'mp3' } : { file }
      const r = await sendApi(action, params)
      const target = pickField(r, 'url', 'file')
      rememberUrl(target)
      if (target) { const b = await toBuffer(target, { bot, fetcher }); if (b) return b }
    }
  } catch (err) {
    log?.(`napcat 取字节失败(${mf.kind}/${mf.source}): ${err?.message || err}`)
  }
  return null
}

/**
 * 解析单个 MediaFile：补全 url（群文件）→ 下载字节 → 推断 mime/ext。
 * 失败不抛错，置 resolveError，交由上层决定降级或跳过。
 */
export async function resolveMedia(mf, { bot, fetcher, e, log } = {}) {
  if (!mf) return mf
  if (mf.buffer) { // 已解析
    if (!mf.mime) Object.assign(mf, inferMime(mf.name, mf.buffer))
    if (mf.bytes == null) mf.bytes = mf.buffer.length
    return mf
  }

  // 补全 url（群文件 / 离线文件无 url）
  if (!mf.url && mf.fid) {
    const pick = bot || null
    try {
      if (pick?.getFileUrl) mf.url = await pick.getFileUrl(mf.fid)
      else if (pick?.fs?.download) mf.url = (await pick.fs.download(mf.fid, mf.busid))?.url || null
    } catch { /* noop */ }
  }

  // 框架优先下载：Bot.download(url) → {buffer}
  let buffer = null
  if (mf.url && bot?.download) {
    try { const r = await bot.download(mf.url); buffer = r?.buffer || null } catch { /* noop */ }
  }
  // 兜底：自实现取字节
  if (!buffer && mf.url) {
    try { buffer = await toBuffer(mf.url, { bot, fetcher }) } catch { /* noop */ }
  }
  // 段内联 base64（部分适配器 image 段的 file 字段是 base64://）
  if (!buffer && mf.segment?.file && typeof mf.segment.file === 'string') {
    try { buffer = await toBuffer(mf.segment.file, { bot, fetcher }) } catch { /* noop */ }
  }
  // NapCat/OneBot 原生接口兜底：引用/历史/群文件 url 缺失或失效时，用 get_file/get_image/get_record 取字节
  if (!buffer && e) {
    try { buffer = await napcatBytes(mf, e, { bot, fetcher, log }) } catch { /* noop */ }
  }

  if (!buffer) {
    mf.resolveError = mf.url ? 'download_failed' : 'no_url'
    log?.(`取字节失败(${mf.kind}/${mf.source} ${mf.name}): ${mf.resolveError}`)
    return mf
  }

  mf.buffer = buffer
  mf.bytes = buffer.length
  Object.assign(mf, inferMime(mf.name, buffer))
  return mf
}

/** 批量解析（并发） */
export async function resolveAll(list, opts) {
  return Promise.all((list || []).map((m) => resolveMedia(m, opts)))
}

export { EXT_MIME, MIME_EXT }
