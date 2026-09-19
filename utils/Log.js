/**
 * 统一日志封装，兼容 TRSS-Yunzai 与 Miao-Yunzai。
 * 优先使用 TRSS 的 Bot.makeLog，其次使用全局 logger，最后回退 console。
 * 等级：trace / debug / info / mark / warn / error / fatal
 */

const TAG = 'agents-plugin'

/** ANSI 颜色（控制台彩色日志用；非终端或被 logger 转义时原样显示，无害） */
export const ANSI = Object.freeze({
  R: '\x1b[0m', r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[34m', m: '\x1b[35m', c: '\x1b[36m', gry: '\x1b[90m', B: '\x1b[1m',
})

function log(level, ...args) {
  try {
    if (typeof Bot !== 'undefined' && typeof Bot.makeLog === 'function') {
      return Bot.makeLog(level, args.length === 1 ? args[0] : args, TAG)
    }
  } catch (e) {
    // ignore and fall through
  }

  const lg = typeof logger !== 'undefined' ? logger : console
  const fn = typeof lg[level] === 'function' ? lg[level] : lg.info
  if (typeof fn === 'function') fn.call(lg, `[${TAG}]`, ...args)
}

const Log = {
  trace: (...a) => log('trace', ...a),
  debug: (...a) => log('debug', ...a),
  info: (...a) => log('info', ...a),
  mark: (...a) => log('mark', ...a),
  warn: (...a) => log('warn', ...a),
  error: (...a) => log('error', ...a),
  fatal: (...a) => log('fatal', ...a),
}

/**
 * 创建带 tag 的分级 logger：(level='debug', ...args) → log(level, '[tag]', ...args)
 * 这样库内 `logger('warn', msg)` 会真正按 warn 级别输出（而非被吞成 debug）。
 */
Log.tag = function tag(tag) {
  return (level = 'debug', ...args) => log(level, `[${tag}]`, ...args)
}

/** 把任意值截断为单行日志字符串（对象先 JSON 化），避免日志被超大内容撑爆 */
Log.brief = function brief(v, n = 160) {
  let s
  if (v == null) s = String(v)
  else if (typeof v === 'string') s = v
  else {
    try { s = JSON.stringify(v) } catch { s = String(v) }
  }
  s = String(s).replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s
}

// ─── 启动横幅 / 对齐面板 ───
// 终端里 CJK / 全角 / emoji 占 2 列，按显示宽度对齐才能排整齐。
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1faff], [0x20000, 0x3fffd],
]
function charWidth(cp) {
  if (cp === 0x2329 || cp === 0x232a) return 2
  for (const [a, b] of WIDE_RANGES) if (cp >= a && cp <= b) return 2
  return 1
}

/** 字符串显示宽度（CJK/全角/emoji 记 2 列） */
export function strWidth(s) {
  let w = 0
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0))
  return w
}

/**
 * 渲染对齐面板（纯函数，便于离线测试）：
 *   ┌─ title ─────────────
 *   │ 标签  值
 *   └─────────────────────
 * 值为 null/undefined/空串的行自动跳过；标签按最宽项对齐。
 * @param {string} title
 * @param {Array<[string, any]>} rows
 */
export function renderPanel(title, rows = [], { minWidth = 44, separator = '  ' } = {}) {
  const pairs = (rows || []).filter((r) => Array.isArray(r) && r.length >= 2 && r[1] != null && String(r[1]) !== '')
  const labelW = pairs.reduce((m, [k]) => Math.max(m, strWidth(k)), 0)
  const valueW = pairs.reduce((m, [, v]) => Math.max(m, strWidth(v)), 0)
  const head = `─ ${title} `
  const width = Math.max(minWidth, 2 + labelW + separator.length + valueW, 1 + strWidth(head))
  const lines = []
  lines.push('┌' + head + '─'.repeat(Math.max(0, width - 1 - strWidth(head))))
  for (const [k, v] of pairs) {
    const pad = ' '.repeat(Math.max(0, labelW - strWidth(k)))
    lines.push(`│ ${k}${pad}${separator}${v}`)
  }
  lines.push('└' + '─'.repeat(width - 1))
  return lines.join('\n')
}

/** 输出对齐面板（整块单次日志，避免逐行 logger 前缀打断排版） */
Log.panel = function panel(title, rows, opts) {
  return log('info', renderPanel(title, rows, opts))
}

export default Log
