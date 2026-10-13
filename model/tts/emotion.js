/**
 * 情绪规划（LLM 自动调节情绪向量）—— pro / max 两档的核心判定层。
 *
 * 设计：
 *  - 「手动调节情绪强度」不要求用户/模型手填滑块：默认由一次轻量 LLM 调用，结合**合成文本 + 近期对话上下文**
 *    判定情绪（只给文本不看上下文，会把反讽/玩笑/旁白判错）；
 *  - pro 档：整段文本一套向量 → 一次合成调用（IndexTTS 原生支持）；
 *  - max 档：LLM 按语义/停顿把文本拆成若干段，每段单独给向量 → 分段合成后用 ffmpeg 合并（见 service.js）。
 *    max 档的提示词与规则在此定义（每个情绪模式的详细说明随提示词一并下发给判定 LLM，
 *    面向 Agent 的同类说明收纳在 skills/tts.md，两处口径一致）。
 *  - 判定失败一律**如实回退**（不编造）：pro→用配置默认向量；max→按标点切分 + 整体向量。
 *
 * 输出契约（JSON）：
 *   pro : { "vector": { "happy":0.8, ... }, "reason": "一句话" }
 *   max : { "vector": { ...整体基调... }, "segments":[ { "text":"...", "vector":{...} } ], "reason":"..." }
 */
import { VECTOR_KEYS, VECTOR_ZH, clampVector, vectorToObject } from './indextts.js'

export const EMOTION_MODE_DOCS = {
  same: '沿用音色参考的情绪（Same as the voice reference）：情绪与音色都取自音色参考音频。适合"参考音频什么语气，就按什么语气说"的场景，不需要额外情绪控制。',
  audio: '情绪参考音频（Use emotion reference audio）：音色取音色参考，情绪另取一段情绪参考音频（可来自其他说话人）。emoWeight 控制情绪参考对输出的影响强度（0~1，越大越贴近情绪参考）。',
  vector: '情绪向量（Use emotion vectors）：保留音色参考，用 8 维向量手工控制情绪，可按需组合多种情绪，不需要额外录音；可由 LLM 结合文本与对话上下文自动判定（本模块职责）。',
}

/** 8 种情绪的选择指引（给判定 LLM；技能文档同口径） */
export const EMOTION_GUIDE = [
  ['高兴', 'happy', '开心、喜悦、兴奋、得意、期待、热情夸奖'],
  ['愤怒', 'angry', '生气、斥责、不满、抗议、被冒犯（含故作愤怒的吐槽）'],
  ['悲伤', 'sad', '伤心、难过、失落、离别、同情与安慰他人'],
  ['害怕', 'afraid', '恐惧、紧张、怯场、担心后果、危险预警'],
  ['厌恶', 'disgusted', '嫌弃、反感、恶心、不认同的吐槽'],
  ['忧郁', 'melancholic', '低落、疲惫、丧、怀旧、惆怅、深夜感慨'],
  ['惊讶', 'surprised', '吃惊、意外、惊喜、难以置信'],
  ['平静', 'calm', '中性陈述、日常应答、安抚；没有明显情绪时应压底平静'],
]

export const MAX_SEGMENTS = 12
export const MAX_SEGMENT_CHARS = 140

/**
 * 去掉风格/音频标签，得到"裸文本"（用于保真校验，确保 LLM 只插标签不改原文）。
 * 支持：行内 [标签]（半/全角方括号）与开头 (风格)（半/全角圆括号）。
 */
export function stripAudioTags(s) {
  return String(s || '')
    .replace(/^[（(][^（()）\n]{1,24}[)）]/, '')
    .replace(/[\[［][^\[\]［］\n]{1,24}[\]］]/g, '')
}

/** 规整化文本（去空白，用于保真比较） */
function normForCompare(s) {
  return String(s || '').replace(/\s+/g, '')
}

/** 清理风格指令：去控制字符/换行、限长；空返回 '' */
export function cleanStyleText(s, max = 80) {
  const t = String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : ''
}

/** 清理风格标签词：去掉会破坏 (风格) 语法的括号与标点，限长；空返回 '' */
export function cleanStyleTag(s, max = 24) {
  const t = cleanStyleText(s, max).replace(/[()（）\[\]［］,，、。;；:：]/g, ' ').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : ''
}

/** 校验带标签文本：去掉标签后必须与原文逐字一致，且确实插入了至少一个标签 */
export function isFaithfulTagged(tagged, original) {
  const a = String(tagged || '')
  const b = String(original || '')
  if (!a || !b) return false
  if (!/[\[［]/.test(a.replace(/^[（(][^（()）\n]{1,24}[)）]/, ''))) return false
  return normForCompare(stripAudioTags(a)) === normForCompare(b)
}

/** 情绪判定的系统提示词（含每个情绪模式的详细说明 + 8 情绪 + 输出契约） */
export function buildEmotionSystemPrompt() {
  return [
    '你是语音合成的"情绪导演"：阅读要朗读的文本与近期对话上下文，判定最合适的情绪向量，让合成语音的情绪像真人说话而不是客服播音。',
    '',
    '【情绪模式说明】（本次使用「情绪向量」模式；另两种模式不需要你判定）',
    ...Object.entries(EMOTION_MODE_DOCS).map(([k, v]) => `- ${k}：${v}`),
    '',
    '【8 种情绪】（键名固定，取值 0~1.2）',
    ...EMOTION_GUIDE.map(([zh, key, when]) => `- ${zh}（${key}）：${when}`),
    '',
    '【取值规范】',
    '- 单一主导情绪一般 0.6~0.95；可叠加 1~2 个次要情绪 0.1~0.3；不要同时给两个以上强情绪；',
    '- 各分量 0~1.2，总和不超过 1.5（超出会被系统按比例缩放）；',
    '- 文本没有明显情绪倾向时，用平静压底（calm 0.5~0.9）而不是全部为 0；',
    '- 反讽/玩笑/吐槽要结合上下文判断真实语气，不要只看字面。',
    '',
    '【风格指令 style】（可选，≤60 字的一句话）',
    '支持自然语言风格控制的 TTS（MiMo / 豆包 2.0）会直接使用它；写"怎么演"，比向量更细腻：',
    '- 可用复合情绪："压抑的愤怒""带着哽咽的笑意""温柔但疲惫""狂躁中透着温柔"；',
    '- 可指定语速/发声方式："语速偏慢，尾音带一点气声""声音明亮有活力，语速稍快"；',
    '- 角色扮演/旁白场景可写导演式："像深夜电台DJ，压低嗓音，句间留一点空白"；',
    '- 唱歌或方言直接点名："用唱歌的方式唱出来""用东北话说"。',
    '风格必须贴合文本与上下文；平静日常用"自然平实地念"即可，不必强加情绪。',
    '',
    '【音频标签 tag / tagged】（可选，仅 MiMo 支持；不确定就不给）',
    '- tag：1~2 个风格词，用于句首 (风格) 标签，从这些类别里选：基础情绪（开心/悲伤/愤怒/惊讶/兴奋/委屈/平静/冷漠）、复合情绪（怅然/欣慰/无奈/愧疚/释然/嫉妒/厌倦/忐忑）、语调（温柔/高冷/活泼/严肃/慵懒/俏皮/深沉/干练）、音色（磁性/清亮/稚嫩/甜美/沙哑）、人设腔调（夹子音/御姐音/正太音/大叔音/台湾腔）、方言（东北话/四川话/河南话/粤语）、唱歌。',
    '- tagged：在原文中插入行内 [音频标签] 的版本，标签只能从：吸气/叹气/长叹一口气/喘息/屏息、紧张/激动/疲惫/委屈/撒娇/心虚/震惊/不耐烦、颤抖/变调/破音/鼻音/气声/沙哑、笑/轻笑/大笑/冷笑/抽泣/呜咽/哽咽、语速加快/放慢语速 里选；放在它作用的词句旁边，最多 3 处，宁缺毋滥。',
    '- tagged 必须逐字保留原文：只允许插入 [标签]，不得改写、增删、调换任何字；做不到就省略 tagged 字段。',
    '',
    '【输出】只输出一个 JSON 对象，不要解释文字或代码块标记。键名必须用下列英文键（happy/angry/sad/afraid/disgusted/melancholic/surprised/calm），不要用中文名、不要自造键名；数值必须为 0~1.2。字段：',
    '- pro 模式：{"vector":{"happy":0.8,"calm":0.3},"style":"用开心的语气说，语速稍快","tag":"开心","tagged":"太好了[笑]，终于成了！","reason":"一句话说明判定依据"}',
    '- max 模式：{"vector":{"calm":0.5},"style":"整体自然平实","segments":[{"text":"原文片段（必须保持原文用词，不得改写/增删）","vector":{"happy":0.9},"style":"这一段轻快上扬","tag":"兴奋","tagged":"原文片段[笑]"}],"reason":"一句话"}',
    '- style/tag/tagged 都是可选字段；没有把握时省略，不要为凑字段硬编。',
    `- max 模式分段规则：按语义与自然停顿拆分（一句一段或逗号短句合并），相邻同情绪可合段；每段不超过 ${MAX_SEGMENT_CHARS} 字、最多 ${MAX_SEGMENTS} 段；文本很短时不拆（1 段）；`,
    '- 每段 text 必须逐字来自原文（顺序拼接后应还原原文，可忽略空白差异）。',
    '- 向量不能全为 0：没有明显情绪时也要给平静一个正数（如 calm 0.6）。',
  ].join('\n')
}

/**
 * 把近期对话消息压成"上下文"文本（供情绪判断）。
 * 只取 user/assistant 的文本内容，去掉工具调用/系统消息，逐条截断，整体限长。
 */
export function normalizeContext(messages, { maxMessages = 8, maxChars = 1600, perMsg = 220 } = {}) {
  const list = Array.isArray(messages) ? messages : []
  const lines = []
  for (const m of list) {
    const role = m?.role
    if (role !== 'user' && role !== 'assistant') continue
    let content = m?.content
    if (Array.isArray(content)) content = content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join(' ')
    content = String(content || '').replace(/\s+/g, ' ').trim()
    if (!content) continue
    if (content.length > perMsg) content = content.slice(0, perMsg) + '…'
    lines.push(`${role === 'user' ? '用户' : '助手'}：${content}`)
  }
  const tail = lines.slice(-maxMessages)
  let out = tail.join('\n')
  if (out.length > maxChars) out = out.slice(-maxChars)
  return out
}

/** 构造情绪判定提示词（system + user 两段） */
export function buildPlanPrompt({ text, tier = 'pro', context = '', voiceName = '', maxSegmentChars = MAX_SEGMENT_CHARS, maxSegments = MAX_SEGMENTS }) {
  const user = [
    `【音色参考】${voiceName || '（未命名）'}`,
    `【档位】${tier === 'max' ? `max：按需拆分逐段判定情绪（最多 ${maxSegments} 段、每段 ≤ ${maxSegmentChars} 字）` : 'pro：整段一套情绪'}`,
    context ? `【近期对话上下文】\n${context}` : '【近期对话上下文】（无，按文本本身判断）',
    `【要朗读的文本】\n${text}`,
  ].join('\n\n')
  return { system: buildEmotionSystemPrompt(), user }
}

/** 从 LLM 输出里抠出 JSON（容忍 ```json 围栏/前后废话） */
export function extractJson(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const unfenced = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  const candidates = [unfenced]
  const i = unfenced.indexOf('{'); const j = unfenced.lastIndexOf('}')
  if (i >= 0 && j > i) candidates.push(unfenced.slice(i, j + 1))
  for (const c of candidates) {
    try { return JSON.parse(c) } catch { /* 尝试下一个 */ }
  }
  return null
}

/** 去空白后比较 max 档分段是否忠实还原原文（防 LLM 改写台词） */
export function segmentsFaithful(segments, text) {
  const norm = (s) => String(s || '').replace(/\s+/g, '')
  const joined = norm(segments.map((s) => s.text).join(''))
  const orig = norm(text)
  if (!orig) return false
  const diff = Math.abs(joined.length - orig.length)
  return diff <= Math.max(4, Math.floor(orig.length * 0.15)) && joined.slice(0, Math.min(10, orig.length)) === orig.slice(0, Math.min(10, orig.length))
}

/** 按标点把文本切成 ≤maxChars 的片段（LLM 不可用/输出不合法时的确定性回退） */
export function splitByPunctuation(text, maxChars = MAX_SEGMENT_CHARS) {
  const s = String(text || '').trim()
  if (!s) return []
  const parts = s.split(/(?<=[。！？!?；;\n])/).map((x) => x.trim()).filter(Boolean)
  const out = []
  let cur = ''
  for (const p of parts) {
    if (cur && (cur + p).length > maxChars) { out.push(cur); cur = p }
    else cur += p
    // 单段仍超限：按 maxChars 强切
    while (cur.length > maxChars) { out.push(cur.slice(0, maxChars)); cur = cur.slice(maxChars) }
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 归一化 LLM 计划输出。
 * @returns {null | { vector: object, segments?: [{text, vector}], reason: string }} null=不可用（调用方回退）
 */
export function parsePlan(raw, { tier = 'pro', text = '', maxSegments = MAX_SEGMENTS, maxSegmentChars = MAX_SEGMENT_CHARS } = {}) {
  const obj = extractJson(raw)
  if (!obj || typeof obj !== 'object') return null
  // 全零/未知键（clamp 后无正数）视为无效：宁可回退默认，也不能"有 reason 但实际没情绪"地误导使用方
  const safeVec = (x) => {
    if (!x || typeof x !== 'object') return null
    const arr = clampVector(x)
    return arr.some((n) => n > 0) ? vectorToObject(arr) : null
  }
  /** 风格字段清理：style/tag 直接清洗；tagged 必须通过保真校验（只插标签不改原文），否则丢弃 */
  const styleFields = (src, originalText) => {
    const style = cleanStyleText(src?.style, 80)
    const tag = cleanStyleTag(src?.tag, 24)
    let tagged = String(src?.tagged || '').trim()
    if (!tagged || !isFaithfulTagged(tagged, originalText)) tagged = ''
    return { ...(style ? { style } : {}), ...(tag ? { tag } : {}), ...(tagged ? { tagged } : {}) }
  }
  const vector = safeVec(obj.vector)
  const reason = String(obj.reason || '').slice(0, 200)
  if (tier !== 'max') {
    if (!vector) return null
    return { vector, ...styleFields(obj, text), reason }
  }
  const segs = Array.isArray(obj.segments) ? obj.segments : []
  const cleaned = segs
    .map((s) => ({ src: s, text: String(s?.text || '').trim(), vector: safeVec(s?.vector) }))
    .filter((s) => s.text)
  if (!cleaned.length || cleaned.length > maxSegments) return null
  if (cleaned.some((s) => s.text.length > maxSegmentChars * 1.5)) return null
  if (!segmentsFaithful(cleaned, text)) return null
  // 段缺失/全零向量 → 用整体基调兜底（整体也没有则拒绝计划）
  for (const s of cleaned) if (!s.vector) s.vector = vector ? { ...vector } : null
  if (cleaned.some((s) => !s.vector)) return null
  // 每段独立风格字段（tagged 按该段原文校验）；整体 style/tag 作为缺省
  const overall = styleFields(obj, text)
  const segments = cleaned.map((s) => ({ text: s.text, vector: s.vector, ...styleFields(s.src, s.text) }))
  return { vector: vector || { ...cleaned[0].vector }, ...overall, segments, reason }
}

/**
 * 带超时的 Promise（定时器必须清理：此前未 clearTimeout 导致短进程空等满超时——
 * model/tts/test.mjs 曾因此 30s 才退出，CI 被拖慢）。
 * @param {Promise} promise
 * @param {number} ms 超时毫秒
 * @param {string} message 超时错误消息
 * @param {Function} [onTimeout] 超时回调（用于中止底层调用，如 AbortController.abort——
 *   不中止的话请求会继续跑到客户端 60s 超时/重试，白烧额度还占并发）
 */
export function withTimeout(promise, ms, message = '超时', onTimeout = null) {
  let timer
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => {
      try { onTimeout?.() } catch { /* noop */ }
      rej(new Error(message))
    }, ms)
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer))
}

/**
 * 调 LLM 规划情绪。
 * 预算语义（默认 300000ms=5 分钟，tts.judgeTimeoutMs 可配）：整个判定调用受总预算约束；
 * 单次尝试最多用一半预算，快速失败（网络/限流等）且预算尚余时再试一次——首次请求偶发
 * 卡在连接/重试退避时，新连接往往几秒就能成功；两次都超预算则如实施加默认值回退，不拖语音。
 * 超时会 abort 底层请求（signal 透传到 provider.chat → fetch），不再让它在后台空跑。
 * @param {{ run: Function }|Function} llm recallLlm 风格：run(prompt, { signal }) → { content }；也接受直接函数
 * @param {object} opts { text, tier, context, voiceName, maxSegmentChars, maxSegments, logger, timeoutMs }
 * @returns {Promise<null|{vector, segments?, reason}>} null=规划不可用（调用方按配置默认值回退）
 */
export async function planEmotion(llm, opts = {}) {
  const run = typeof llm === 'function' ? llm : llm?.run
  if (typeof run !== 'function') return null
  const { text, tier = 'pro', context = '', voiceName = '', logger, timeoutMs = 30000 } = opts
  if (!String(text || '').trim()) return null
  const { system, user } = buildPlanPrompt({
    text, tier, context, voiceName,
    maxSegmentChars: opts.maxSegmentChars || MAX_SEGMENT_CHARS,
    maxSegments: opts.maxSegments || MAX_SEGMENTS,
  })
  const prompt = `${system}\n\n${user}`

  const budget = Math.max(1000, Number(timeoutMs) || 30000)
  const sliceMs = Math.max(1000, Math.round(budget / 2))
  const t0 = Date.now()
  const deadline = t0 + budget
  const MAX_ATTEMPTS = 2
  let content = ''
  let lastErr = ''
  let attempts = 0
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remain = deadline - Date.now()
    if (remain < 1000) break
    const slice = Math.min(remain, sliceMs)
    const attemptStart = Date.now()
    attempts++
    const ctrl = new AbortController()
    try {
      const res = await withTimeout(
        run(prompt, { signal: ctrl.signal }),
        slice,
        '情绪判定超时',
        () => ctrl.abort(),
      )
      content = res?.content ?? res ?? ''
      lastErr = ''
      break
    } catch (e) {
      lastErr = e?.message || String(e)
      try { ctrl.abort() } catch { /* noop */ }
      // 只有「快失败」才值得在剩余预算内重试一次（连接重置/限流等通常秒级返回）。
      // 打满本片预算的慢超时（模型本身慢）再试一次同样会超时——直接回退，不再白等一个 slice。
      const elapsed = Date.now() - attemptStart
      if (/超时/.test(lastErr) || elapsed > slice * 0.6) break
    }
  }
  if (lastErr) {
    logger?.('warn', '[tts] 情绪判定调用失败，按默认值回退', `${lastErr}（预算 ${budget}ms，尝试 ${attempts} 次，耗时 ${Date.now() - t0}ms）`)
    return null
  }
  const plan = parsePlan(content, { tier, text, maxSegments: opts.maxSegments || MAX_SEGMENTS, maxSegmentChars: opts.maxSegmentChars || MAX_SEGMENT_CHARS })
  if (!plan) logger?.('warn', '[tts] 情绪判定输出不合法，按默认值回退', String(content).slice(0, 120))
  return plan
}

export { VECTOR_KEYS, VECTOR_ZH }
