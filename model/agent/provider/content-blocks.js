/**
 * 跨协议内容块归一 —— Provider 发送前的最后一道协议适配。
 *
 * 历史消息按会话持久化，携带的内容块是「生成它时那家 provider 的原生形状」。一旦同一会话
 * 切模型（如 Anthropic→OpenAI）或主模型失败后回退到不同协议的端点，旧块会被原样回放给新端点，
 * 被其 serde 直接拒绝（如 `unknown variant 'image', expected text/image_url/file`），整轮 400。
 *
 * 不变量：**发给 provider 的每个内容块都必须是该协议的原生形状**；无法用原生块表达的一律降级为
 * text 占位，绝不透传（宁可丢附件也不中断整轮对话）。
 *
 * 各协议原生块：
 *  - openai:   text / image_url / input_audio / video_url / file
 *  - anthropic: text / image{source} / document{source}
 *  - gemini:   text / image{data,mime_type} / audio{...} / video{...} / document{...}
 *
 * 注意：本模块只做「历史块 ↔ 目标协议」的适配；从媒体文件新建块的职责在 model/media/convert.js。
 */

const TEXT = (t) => ({ type: 'text', text: String(t ?? '') })
const UNSUPPORTED = (b, proto) => TEXT(`[${b.type || 'unknown'} 内容块在 ${proto} 协议下不支持，已忽略]`)

/** image / image_url / {data,mime_type} / anthropic{source} → { data, mime } 或 { url } */
function readImage(b) {
  const src = b.source || {}
  if (src.type === 'base64' && src.data) return { data: src.data, mime: src.media_type || b.mime_type || 'image/png' }
  if (src.type === 'url' && src.url) return parseUrl(src.url)
  if (b.data) return { data: b.data, mime: b.mime_type || 'image/png' }
  const url = b.image_url?.url || b.url
  if (typeof url === 'string' && url) return parseUrl(url)
  return null
}

/** data: URL → {data,mime}；http(s) → {url} */
function parseUrl(url) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(url)
  return m ? { data: m[2], mime: m[1] } : { url }
}

// ── 目标：OpenAI Chat Completions ─────────────────────────────────────
export function toOpenAIContent(content) {
  if (!Array.isArray(content)) return content
  const out = []
  for (const b of content) {
    if (b == null) continue
    if (typeof b !== 'object') { out.push(TEXT(b)); continue }
    switch (b.type) {
      case 'text': out.push(TEXT(b.text)); break
      case 'image_url': case 'input_audio': case 'video_url': out.push(b); break
      case 'image': {
        const img = readImage(b)
        if (img?.data) out.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })
        else if (img?.url) out.push({ type: 'image_url', image_url: { url: img.url } })
        break
      }
      default: out.push(UNSUPPORTED(b, 'OpenAI'))
    }
  }
  return out
}

// ── 目标：Anthropic Messages ──────────────────────────────────────────
export function toAnthropicContent(content) {
  if (!Array.isArray(content)) return content
  const out = []
  for (const b of content) {
    if (b == null) continue
    if (typeof b !== 'object') { out.push(TEXT(b)); continue }
    if (b.type === 'text') { out.push(TEXT(b.text)); continue }
    if (b.type === 'image' && b.source) { out.push(b); continue } // 已是 Anthropic 原生
    if (b.type === 'document' && b.source) { out.push(b); continue }
    if (b.type === 'document' && b.data) { // Gemini 扁平 document → Anthropic source
      out.push({ type: 'document', source: { type: 'base64', media_type: b.mime_type || 'application/pdf', data: b.data } })
      continue
    }
    if (b.type === 'image' || b.type === 'image_url') {
      const img = readImage(b)
      if (img?.data) out.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } })
      else if (img?.url) out.push({ type: 'image', source: { type: 'url', url: img.url } })
      continue
    }
    out.push(UNSUPPORTED(b, 'Anthropic'))
  }
  return out
}

// ── 目标：Gemini Interactions Content_2（扁平 data/mime_type）──────────
export function toGeminiContent(content) {
  if (!Array.isArray(content)) return content
  const out = []
  for (const b of content) {
    if (b == null) continue
    if (typeof b !== 'object') { out.push(TEXT(b)); continue }
    switch (b.type) {
      case 'text': out.push(TEXT(b.text)); break
      case 'image': case 'image_url': {
        const img = readImage(b)
        if (img?.data) out.push({ type: 'image', data: img.data, mime_type: img.mime })
        else if (img?.url) out.push(TEXT(`[图片（${img.url}）在 Gemini 协议下无法作为原生块发送，已忽略]`))
        break
      }
      case 'audio': case 'input_audio': {
        const a = readAudio(b)
        if (a) out.push(a)
        break
      }
      case 'video': case 'video_url': {
        const v = readVideo(b)
        if (v) out.push(v)
        break
      }
      case 'document': {
        const src = b.source || {}
        if (b.data) out.push({ type: 'document', data: b.data, mime_type: b.mime_type || 'application/pdf' })
        else if (src.type === 'base64' && src.data) out.push({ type: 'document', data: src.data, mime_type: src.media_type || 'application/pdf' })
        else out.push(UNSUPPORTED(b, 'Gemini'))
        break
      }
      default: out.push(UNSUPPORTED(b, 'Gemini'))
    }
  }
  return out
}

function readAudio(b) {
  if (b.data) return { type: 'audio', data: b.data, mime_type: b.mime_type || 'audio/mpeg' }
  const d = b.input_audio?.data
  if (d) return { type: 'audio', data: d, mime_type: 'audio/' + (b.input_audio.format || 'mpeg') }
  const src = b.source || {}
  if (src.type === 'base64' && src.data) return { type: 'audio', data: src.data, mime_type: src.media_type || 'audio/mpeg' }
  return null
}

function readVideo(b) {
  if (b.data) return { type: 'video', data: b.data, mime_type: b.mime_type || 'video/mp4' }
  const url = b.video_url?.url || b.url
  if (typeof url === 'string' && url) {
    const p = parseUrl(url)
    if (p.data) return { type: 'video', data: p.data, mime_type: p.mime }
    return null // http 直链 Gemini Interactions 无原生块 → 降级丢
  }
  return null
}
