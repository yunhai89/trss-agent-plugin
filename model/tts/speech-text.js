/**
 * 回复文本 → 语音文本（stripForSpeech）—— 自动 TTS 只朗读"适合听"的部分。
 *
 * 规则（确定性，便于测试）：
 *  - 代码围栏整体移除（含内容——代码读出来无意义）；行内反引号只去符号、保留文字；
 *  - 图片移除；链接保留标题文字、URL 去掉；裸 URL / 邮箱去掉；
 *  - HTML 标签去掉，但保留 IndexTTS 注音标注 <字|拼音>（半角 | 结构，按发音控制）；
 *  - 表格行整体移除；标题/引用/列表/水平线等 md 标记去符号留文字；
 *  - 粗体/斜体/删除线标记去符号留文字；emoji/零宽字符去掉；
 *  - 换行 → 句号（保留停顿感），合并重复标点；
 *  - maxChars>0 时按句子边界截断（防一条回复合成出几分钟语音）。
 *
 * 设计为纯函数：模型回复里的任何格式都不应让 TTS 读出生硬的符号。
 */

/** 注音标注（<汉字|拼音>，IndexTTS 发音控制）——必须保留 */
const PINYIN_ANNOTATION = /^<[^<>\s|]{1,16}\|[^<>\s]{1,64}>$/

export function stripForSpeech(text, { maxChars = 300 } = {}) {
  let s = String(text || '')
  if (!s.trim()) return ''

  // 1) 贴纸标记 / 内联工具调用残留（正常已在回复外发前剥除，这里兜底）
  s = s.replace(/\[sticker:[^\]]+\]/gi, '')
  s = s.replace(/<\/?(?:tool_calls|invoke|parameter)[^>]*>/gi, '')

  // 2) 代码围栏（含内容）
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/~~~[\s\S]*?~~~/g, ' ')

  // 3) 图片移除；链接保留文字
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

  // 4) 裸 URL / 邮箱
  s = s.replace(/https?:\/\/[^\s<>"')]+/gi, ' ')
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')

  // 5) HTML 标签（保留注音标注）
  s = s.replace(/<[^<>\n]{1,80}>/g, (m) => (PINYIN_ANNOTATION.test(m) ? m : ''))

  // 6) 表格行（|...|）与分隔线
  s = s.replace(/^\s*\|.*\|\s*$/gm, ' ')

  // 7) 行级 md 标记：标题 / 引用 / 列表 / 水平线
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  s = s.replace(/^\s{0,3}>\s?/gm, '')
  s = s.replace(/^\s{0,3}[-*+]\s+/gm, '')
  s = s.replace(/^\s{0,3}\d+[.)]\s+/gm, '')
  s = s.replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, '')

  // 8) 行内强调/删除线/行内代码标记：去符号留文字
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  s = s.replace(/\*([^*\n]+)\*/g, '$1')
  s = s.replace(/__([^_\n]+)__/g, '$1')
  s = s.replace(/~~([^~\n]+)~~/g, '$1')
  s = s.replace(/`([^`\n]*)`/g, '$1')

  // 9) emoji / 零宽字符（读不出来或读出怪音）
  s = s.replace(/[\uFE0F\u200D\u200B]/g, '')
  s = s.replace(/\p{Extended_Pictographic}/gu, '')

  // 10) 换行 → 句号；清理标点/空白（先清空白再合并重复标点，防清出 '。。'）
  s = s.replace(/\r/g, '')
  s = s.replace(/\n+/g, '。')
  s = s.replace(/[ \t]+/g, ' ')
  s = s.replace(/\s+([，。！？；：、])/g, '$1')
  s = s.replace(/\s*[。．]\s*/g, '。')
  s = s.replace(/[，、；：]\s*。/g, '。')
  s = s.replace(/。[，、；：]/g, '。')
  s = s.replace(/[。．!！?？;；，,、:：]{2,}/g, (m) => m[0])
  s = s.replace(/^[。，、；：!！?？~\-*#>\s]+/, '')
  s = s.replace(/[，、；：\s]+$/, '')
  if (!s.trim()) return ''

  // 11) 截断（优先落在句子边界）
  const max = Number(maxChars) || 0
  if (max > 0 && s.length > max) {
    const cut = s.slice(0, max)
    const puncts = ['。', '！', '？', '；', '，', '、']
    let idx = -1
    for (const p of puncts) idx = Math.max(idx, cut.lastIndexOf(p))
    if (idx >= Math.floor(max * 0.5)) {
      s = cut.slice(0, idx + 1)
    } else {
      s = cut.replace(/[，、；：\s]+$/, '') + '。'
    }
  }
  return s
}
