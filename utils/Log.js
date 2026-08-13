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

export default Log
