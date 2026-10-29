/**
 * Yunzai 消息段 → QQ 官方消息体（纯函数，离线可测）。
 *
 * 一个 Yunzai `e.reply([...segments])` 可能包含文字、markdown、按钮、图片、@、引用；
 * 官方 API 一条消息只能承载一种主体（文本 / markdown / 富媒体），因此这里拆成「发送任务」：
 *   { kind:'text'|'markdown'|'media', payload?, source?, fileType?, msgId? }
 * 由 client 逐条执行（媒体需先上传拿 file_info）。
 *
 * 官方结构速查：
 *  - 文本：{ content, msg_type:0, msg_id?, msg_seq?, keyboard? }
 *  - Markdown：{ markdown:{content} 或 {custom_template_id, params}, msg_type:2, keyboard? }
 *  - 富媒体：{ media:{file_info}, msg_type:7 }
 *  - 键盘：{ content:{ rows:[{ buttons:[{ id, render_data:{label,visited_label,style},
 *            action:{type, permission:{type,specify_user_ids?}, data, enter?} }] }] } }
 */

export const MAX_TEXT_CHARS = 3800
export const MAX_MARKDOWN_CHARS = 3800
export const KEYBOARD_MAX_ROWS = 5
export const KEYBOARD_MAX_PER_ROW = 5

let _idSeq = 0
/** 按钮 id（官方要求消息内唯一；无需全局唯一，但重复会渲染异常） */
export function buttonId() {
  _idSeq = (_idSeq + 1) % 1e9
  return `btn_${Date.now().toString(36)}_${_idSeq}`
}

function str(v) { return v == null ? '' : String(v) }

/**
 * 构造官方 inline keyboard。
 * @param {Array} rows 行数组：[[{ text, callback|link|input, send?, clicked_text?, permission?, public?, QQBot? }]]
 * @param {object} [opts] { ownerId } 回调按钮默认仅此人可点
 * @returns {object|null} 官方 keyboard 对象；无有效按钮返回 null
 */
export function buildKeyboard(rows, { ownerId = '' } = {}) {
  const input = Array.isArray(rows) ? rows : []
  const outRows = []
  for (const row of input) {
    if (outRows.length >= KEYBOARD_MAX_ROWS) break
    const list = Array.isArray(row) ? row : [row]
    const buttons = []
    for (const b of list) {
      if (buttons.length >= KEYBOARD_MAX_PER_ROW) break
      if (!b || typeof b !== 'object') continue
      const label = str(b.text ?? b.label).slice(0, 30)
      if (!label) continue
      /** @type {any} */
      const btn = {
        id: b.id ? str(b.id).slice(0, 64) : buttonId(),
        render_data: {
          label,
          visited_label: str(b.clicked_text ?? b.clickedText ?? label).slice(0, 30),
          style: Number.isInteger(b.style) ? b.style : 1,
          ...(b.QQBot?.render_data && typeof b.QQBot.render_data === 'object' ? b.QQBot.render_data : {}),
        },
      }
      if (b.link) {
        btn.action = { type: 0, permission: { type: 2 }, data: str(b.link).slice(0, 512), ...(b.QQBot?.action || {}) }
      } else if (b.input != null) {
        btn.action = {
          type: 2,
          permission: { type: 2 },
          data: str(b.input).slice(0, 200),
          enter: b.send !== false,
          ...(b.QQBot?.action || {}),
        }
      } else if (b.callback != null) {
        // 回调按钮：默认只允许触发者点击（防他人代点高危命令），public:true 才放开
        const to = b.permission === 'admin'
          ? { type: 1 }
          : Array.isArray(b.permission) && b.permission.length
            ? { type: 0, specify_user_ids: b.permission.map((x) => str(x)).slice(0, 10) }
            : (b.public === true || !ownerId ? { type: 2 } : { type: 0, specify_user_ids: [str(ownerId)] })
        btn.action = { type: 1, permission: to, data: str(b.callback).slice(0, 200), ...(b.QQBot?.action || {}) }
      } else {
        continue // 无动作按钮官方会报错，直接丢弃
      }
      buttons.push(btn)
    }
    if (buttons.length) outRows.push({ buttons })
  }
  return outRows.length ? { content: { rows: outRows } } : null
}

/**
 * 按上限切分文本（尽量在换行处断开，代码块补围栏不在此处理——markdown 分片由上层 qqofficial 负责）。
 */
export function splitText(text, max = MAX_TEXT_CHARS) {
  const s = str(text)
  if (s.length <= max) return s ? [s] : []
  const chunks = []
  let buf = ''
  for (const line of s.split('\n')) {
    if ((buf ? buf.length + 1 : 0) + line.length > max) {
      if (buf) { chunks.push(buf); buf = '' }
      let rest = line
      while (rest.length > max) { chunks.push(rest.slice(0, max)); rest = rest.slice(max) }
      buf = rest
    } else {
      buf = buf ? `${buf}\n${line}` : line
    }
  }
  if (buf) chunks.push(buf)
  return chunks
}

/** 解析 markdown 段数据 → 官方 markdown 对象 */
export function markdownPayload(data) {
  if (data && typeof data === 'object') {
    if (data.custom_template_id) return { custom_template_id: str(data.custom_template_id), ...(data.params ? { params: data.params } : {}) }
    if (data.templateId || data.template_id) {
      return { custom_template_id: str(data.templateId || data.template_id), ...(data.params ? { params: data.params } : {}) }
    }
    if (typeof data.content === 'string') return { content: str(data.content) }
  }
  return { content: str(data) }
}

/** 从 segment.image/record/video/file 的 file 字段解析出可上传的来源 */
export function resolveMediaSource(file) {
  if (file == null) return null
  if (Buffer.isBuffer(file)) return { base64: file.toString('base64'), bytes: file.length }
  if (typeof file === 'object') {
    if (file.buffer && Buffer.isBuffer(file.buffer)) return { base64: file.buffer.toString('base64'), bytes: file.buffer.length }
    if (typeof file.url === 'string') return resolveMediaSource(file.url)
    if (typeof file.file === 'string') return resolveMediaSource(file.file)
    return null
  }
  const s = str(file).trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return { url: s }
  if (s.startsWith('base64://')) { const b = s.slice(9); return { base64: b, bytes: Math.floor(b.length * 0.75) } }
  if (s.startsWith('data:')) {
    const idx = s.indexOf(';base64,'); if (idx < 0) return null
    const b = s.slice(idx + 8); return { base64: b, bytes: Math.floor(b.length * 0.75) }
  }
  return { path: s }
}

/**
 * at 段 → 官方 Markdown mention 标签。
 * 官方 Markdown 消息用 `<qqbot-at-user id="openid"/>` / `<qqbot-at-everyone />` 表示 @，
 * 纯文本消息不支持 at 段；不转的话「@回复人」在 Markdown 直发模式下会静默丢失（QQ 官方群默认走 Markdown）。
 * @param {Array} ats at 段的 qq 值（可能带 `<appId>:` 前缀）
 * @param {string} [appId] 用于剥前缀，还原平台 openid
 * @returns {string[]} 标签数组（去重）
 */
export function markdownMentionTags(ats = [], appId = '') {
  const out = []
  const seen = new Set()
  for (const item of ats || []) {
    let qq = str(item).trim()
    if (!qq) continue
    if (appId && qq.startsWith(`${appId}:`)) qq = qq.slice(appId.length + 1)
    // 只保留 openid 合法字符：防止配置/第三方传入 `" /><xxx` 之类破坏 Markdown 结构（无效 id 直接丢弃）
    qq = qq.replace(/[^A-Za-z0-9_:\-]/g, '')
    if (!qq) continue
    if (qq === 'all') {
      if (!seen.has('all')) { seen.add('all'); out.push('<qqbot-at-everyone />') }
      continue
    }
    if (seen.has(qq)) continue
    seen.add(qq)
    out.push(`<qqbot-at-user id="${qq}" />`)
  }
  return out
}

/**
 * 把 Yunzai 消息段数组拆成发送任务。
 * @param {Array|string|object} msg e.reply 的入参
 * @param {object} [opts]
 * @param {string} [opts.msgId] 被动回复的 msg_id（来自触发事件）
 * @param {boolean} [opts.preferMarkdown] 纯文本是否也走 markdown（官方兼容性未知时默认 false）
 * @param {string} [opts.ownerId] 按钮默认允许点击的用户 openid
 * @param {boolean} [opts.stripAt] 文本模式是否丢弃 @ 段（官方文本消息不支持 at 段）
 * @returns {Array<object>} 发送任务列表
 */
export function buildMessageJobs(msg, { msgId = '', preferMarkdown = false, ownerId = '', stripAt = true, templateId = '', appId = '' } = {}) {
  const segs = Array.isArray(msg) ? msg : (msg && typeof msg === 'object' && msg.type ? [msg] : [{ type: 'text', text: str(msg) }])
  const texts = []
  const markdowns = []
  const keyboards = []
  const medias = []
  const ats = []
  let replyId = ''
  let hasMarkdown = false

  for (const seg of segs) {
    if (!seg) continue
    if (typeof seg === 'string') { texts.push(seg); continue }
    switch (seg.type) {
      case 'text':
        if (str(seg.text).trim()) texts.push(str(seg.text))
        break
      case 'markdown':
        hasMarkdown = true
        markdowns.push(markdownPayload(seg.data))
        break
      case 'button':
        // segment.button(row1, row2, ...) 的 data 是行数组；单参数数组也要兼容
        if (Array.isArray(seg.data)) {
          const rows = seg.data.length && Array.isArray(seg.data[0]) && !seg.data[0].type ? seg.data : [seg.data]
          keyboards.push(...rows)
        }
        break
      case 'at':
        // 文本消息不支持 at 段（官方会忽略/报错）；markdown 模式转成 <qqbot-at-user/> 标签（见下）
        if (seg.qq) ats.push(seg.qq)
        break
      case 'reply':
        replyId = str(seg.id || seg.message_id || '')
        break
      case 'image':
        if (seg.file) medias.push({ source: resolveMediaSource(seg.file), fileType: 1, kind: 'image' })
        break
      case 'video':
        if (seg.file) medias.push({ source: resolveMediaSource(seg.file), fileType: 2, kind: 'video' })
        break
      case 'record':
        if (seg.file) medias.push({ source: resolveMediaSource(seg.file), fileType: 3, kind: 'audio' })
        break
      case 'file':
        if (seg.file) medias.push({ source: resolveMediaSource(seg.file), fileType: 4, kind: 'file' })
        break
      default:
        // face/ark/embed/xml/json/raw/node 等：官方 v2 不支持或需专用模板，静默跳过（避免整条失败）
        break
    }
  }

  const jobs = []
  const passiveId = msgId || replyId || ''
  const keyboard = keyboards.length ? buildKeyboard(keyboards, { ownerId }) : null
  const mdText = markdowns
    .map((m) => (m.content != null ? m.content : ''))
    .filter(Boolean)
    .join('\n\n')
  const plain = texts.join('').trim()

  if (hasMarkdown) {
    // @ 转 Markdown mention 标签：模板消息（custom_template_id）无法塞自定义文本，跳过
    const mentionTags = templateId ? [] : markdownMentionTags(ats, appId)
    const withMentions = (md) => {
      if (!md || !md.content || !mentionTags.length) return md
      const missing = mentionTags.filter((tag) => !md.content.includes(tag))
      return missing.length ? { ...md, content: `${md.content}\n${missing.join(' ')}` } : md
    }
    const payload = templateId
      ? { markdown: { custom_template_id: templateId, params: [] } }
      : (mdText ? { markdown: { content: mdText } } : (markdowns[0] ? { markdown: markdowns[0] } : null))
    const payload2 = payload && payload.markdown ? { ...payload, markdown: withMentions(payload.markdown) } : payload
    if (payload2) jobs.push({ kind: 'markdown', payload: withKeyboard(payload2, keyboard), msgId: passiveId })
  } else if (plain) {
    if (preferMarkdown) jobs.push({ kind: 'markdown', payload: withKeyboard({ markdown: { content: plain } }, keyboard), msgId: passiveId })
    else jobs.push({ kind: 'text', payload: withKeyboard({ content: plain }, keyboard), msgId: passiveId })
  }

  for (const m of medias) {
    if (!m.source) continue
    jobs.push({ kind: 'media', source: m.source, fileType: m.fileType, mediaKind: m.kind, msgId: passiveId })
  }
  return jobs
}

function withKeyboard(payload, keyboard) {
  return keyboard ? { ...payload, keyboard } : payload
}

export default { buildKeyboard, buildMessageJobs, splitText, markdownPayload, resolveMediaSource, markdownMentionTags, MAX_TEXT_CHARS, MAX_MARKDOWN_CHARS, KEYBOARD_MAX_ROWS, KEYBOARD_MAX_PER_ROW }
