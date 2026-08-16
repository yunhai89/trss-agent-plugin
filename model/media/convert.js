/**
 * 媒体 → 协议内容块（OpenAI / Anthropic）+ 非视觉降级。
 *
 * 关键：底层 model/openai|anthropic 的 provider 对 message.content 是"原样透传"，
 * 因此本文件直接产出**协议原生**的内容块数组，apps 层组装进 user 消息即可，无需改 provider。
 *
 * 视觉门控：caps.vision 决定图片/文件能否以原生块发送。
 *  - vision=true → 图片走 image_url / image 块；PDF/文档走 document/file 块（视 caps.file）
 *  - vision=false → 降级（degrade）：skip 丢弃 / note 占位文字 / text 文本提取（仅文本类）
 */

import { asBase64, isImage, isTextLike, truncateText } from './resolve.js'

/**
 * OpenAI Chat Completions 多模态块：
 *  image → image_url(data: 或 http url)；audio → input_audio；文件 → file(部分端点)。
 *  对不支持的原生块，降级为 text 描述。
 */
export function toOpenaiBlocks(media, { caps = {}, degrade = 'note' } = {}) {
  const blocks = []
  for (const mf of media) {
    if (mf.resolveError || !mf.buffer) {
      blocks.push({ type: 'text', text: degradeNote(mf, degrade, true) })
      continue
    }
    if (isImage(mf.mime)) {
      if (caps.vision) {
        blocks.push({ type: 'image_url', image_url: { url: dataUrl(mf) } })
      } else {
        const t = degradeBlock(mf, degrade)
        if (t) blocks.push({ type: 'text', text: t })
      }
      continue
    }
    if (mf.mime?.startsWith('audio/') && caps.vision) {
      const fmt = mf.ext || (mf.mime.includes('mpeg') ? 'mp3' : mf.mime.includes('wav') ? 'wav' : 'ogg')
      blocks.push({ type: 'input_audio', input_audio: { data: asBase64(mf.buffer), format: fmt } })
      continue
    }
    // 文档 / 其它文件
    const text = fileToText(mf, degrade)
    if (text != null) blocks.push({ type: 'text', text })
  }
  return blocks
}

/**
 * Anthropic Messages 多模态块：
 *  image → image(base64)；PDF → document(base64)；其余文档无原生块 → 降级 text。
 */
export function toAnthropicBlocks(media, { caps = {}, degrade = 'note' } = {}) {
  const blocks = []
  for (const mf of media) {
    if (mf.resolveError || !mf.buffer) {
      blocks.push({ type: 'text', text: degradeNote(mf, degrade, true) })
      continue
    }
    if (isImage(mf.mime)) {
      if (caps.vision) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mf.mime, data: asBase64(mf.buffer) } })
      } else {
        const t = degradeBlock(mf, degrade)
        if (t) blocks.push({ type: 'text', text: t })
      }
      continue
    }
    if (mf.mime === 'application/pdf' && caps.file) {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: asBase64(mf.buffer) } })
      continue
    }
    const text = fileToText(mf, degrade)
    if (text != null) blocks.push({ type: 'text', text })
  }
  return blocks
}

/**
 * Gemini Interactions 多模态块（Content_2 扁平结构：type + data(base64) + mime_type）：
 *  image → {type:'image', data, mime_type}；audio → {type:'audio',...}；PDF → {type:'document',...}；其余降级 text。
 *  参考 Gemini_API_完整开发文档.md §11（图像/音频/文档理解）。
 */
export function toGeminiBlocks(media, { caps = {}, degrade = 'note' } = {}) {
  const blocks = []
  for (const mf of media) {
    if (mf.resolveError || !mf.buffer) {
      blocks.push({ type: 'text', text: degradeNote(mf, degrade, true) })
      continue
    }
    if (isImage(mf.mime)) {
      if (caps.vision) {
        blocks.push({ type: 'image', data: asBase64(mf.buffer), mime_type: mf.mime })
      } else {
        const t = degradeBlock(mf, degrade)
        if (t) blocks.push({ type: 'text', text: t })
      }
      continue
    }
    if (mf.mime?.startsWith('audio/') && caps.vision) {
      blocks.push({ type: 'audio', data: asBase64(mf.buffer), mime_type: mf.mime })
      continue
    }
    if (mf.mime === 'application/pdf' && caps.file) {
      blocks.push({ type: 'document', data: asBase64(mf.buffer), mime_type: 'application/pdf' })
      continue
    }
    const text = fileToText(mf, degrade)
    if (text != null) blocks.push({ type: 'text', text })
  }
  return blocks
}

/** data: URL（OpenAI image_url 直接收 base64 data url；统一走 base64——直链省 token 的设想
 *  曾以 `mf.__preferUrl` 预留，但从未赋值且各兼容端点对远程图支持不一（MiniMax 连 detail 都拒），已删） */
function dataUrl(mf) {
  return `data:${mf.mime};base64,${asBase64(mf.buffer)}`
}

/** 文件 → 文本（文本类直接解码；其余按 degrade 策略） */
function fileToText(mf, degrade) {
  if (isTextLike(mf.mime)) return truncateText(mf.buffer)
  return degradeBlock(mf, degrade)
}

/** 非视觉/非原生块降级文本；degrade=skip 返回 null（丢弃） */
function degradeBlock(mf, degrade) {
  if (degrade === 'skip') return null
  if (degrade === 'text' && isTextLike(mf.mime)) return truncateText(mf.buffer)
  return degradeNote(mf, degrade, false)
}

/** 占位说明文字 */
function degradeNote(mf, degrade, errored) {
  if (degrade === 'skip') return null
  const size = mf.bytes ? `${(mf.bytes / 1024).toFixed(1)}KB` : '未知大小'
  // 图片只要有直链就附带，保证即便走到降级占位，主模型/MCP 仍能拿到地址去识别（不再"没有图片"）
  const urlHint = (mf.kind === 'image' && mf.url) ? `；图片直链可供视觉类工具/MCP 使用：${mf.url}` : ''
  if (errored) return `[附件 ${mf.name}（${size}）获取失败：${mf.resolveError || '未知'}${urlHint}]`
  const why = mf.kind === 'image' ? '当前模型不支持视觉' : '当前模型不支持该文件类型'
  return `[附件 ${mf.name}（${size}，${mf.mime || mf.kind}）：${why}${urlHint}]`
}

/**
 * 组装一条 user 消息的 content。
 *  - 无媒体 → 返回字符串（保持与既有纯文本路径完全一致，零侵入）
 *  - 视觉模型 + 有媒体 → 协议原生 content 数组（文本块在前，媒体块在后）
 *  - 非视觉模型 + 有媒体 → 字符串（文本 + 降级说明/提取，仍走纯文本路径）
 */
export function buildUserContent(text, media, { protocol = 'openai', caps = {}, degrade = 'note' } = {}) {
  const base = String(text || '')
  const usable = (media || []).filter((m) => m)
  if (!usable.length) return base

  const vision = !!caps.vision
  // 非视觉：全部降级为文本，拼成纯字符串（最大化兼容文本模型）
  if (!vision) {
    const parts = [base]
    for (const mf of usable) {
      const t = fileToText(mf, degrade)
      if (t != null) parts.push(t)
    }
    return parts.filter(Boolean).join('\n\n')
  }

  const mediaBlocks = protocol === 'anthropic'
    ? toAnthropicBlocks(usable, { caps, degrade })
    : protocol === 'gemini'
    ? toGeminiBlocks(usable, { caps, degrade })
    : toOpenaiBlocks(usable, { caps, degrade })
  const textBlock = base ? [{ type: 'text', text: base }] : []
  const content = [...textBlock, ...mediaBlocks]
  // 若媒体块全部降级为文本（如 PDF 降级），可退化为纯字符串减少结构开销
  if (content.every((b) => b.type === 'text')) {
    return content.map((b) => b.text).filter(Boolean).join('\n\n') || base
  }
  return content
}

export { asBase64 }
