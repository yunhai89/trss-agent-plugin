/**
 * QQ 音乐请求签名（zzc）—— 逆向算法移植。
 *
 * 来源（当前仍在维护的 QQ 音乐逆向项目）：
 *  - L-1124/QQMusicApi（Python，持续更新）：qqmusic_api/algorithms/sign.py
 *    文档站 https://l-1124.github.io/QQMusicApi/
 *  - jixunmoe/qmweb-sign（Node，npm @jixun/qmweb-sign）：zzc + ag-1
 *    分析文 https://jixun.uk/posts/2024/qqmusic-zzc-sign/
 *
 * 用途：现代网关 `https://u6.y.qq.com/cgi-bin/musics.fcg` 要求 URL 携带 `sign`，
 * 其值 = zzcSign(请求体原始字符串)。旧网关 `musicu.fcg` 不校验 sign。
 * 本工具默认走旧网关，现代接口（歌曲详情 / 榜单目录）走签名网关。
 *
 * 已用公开测试向量离线自检：zzcSign('123') === 'zzcec1b555gzqzg7laztguyjl2bu20r6x1w50c55f60'
 */
import crypto from 'node:crypto'

const PART_1_INDEXES = [23, 14, 6, 36, 16, 7, 19]
const PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5]
const SCRAMBLE_VALUES = [
  89, 39, 179, 150, 218, 82, 58, 252, 177, 52,
  186, 123, 120, 64, 242, 133, 143, 161, 121, 179,
]

/**
 * 计算 zzc 签名。
 * @param {string|Buffer} payload 待签名的请求体明文（现代网关为 JSON 字符串）
 * @returns {string} 形如 `zzc...` 的小写签名
 */
export function zzcSign(payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const hash = crypto.createHash('sha1').update(bytes).digest('hex').toUpperCase()
  const part1 = PART_1_INDEXES.map((i) => hash[i]).join('')
  const part2 = PART_2_INDEXES.map((i) => hash[i]).join('')
  const part3 = Buffer.alloc(SCRAMBLE_VALUES.length)
  for (let i = 0; i < SCRAMBLE_VALUES.length; i++) {
    part3[i] = SCRAMBLE_VALUES[i] ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16)
  }
  const b64 = part3.toString('base64').replace(/[\\/+=]/g, '')
  return `zzc${part1}${b64}${part2}`.toLowerCase()
}

/**
 * QQ 音乐 hash33（用于 g_tk）。逐字符 h = h*33 + code，最后 & 0x7fffffff。
 * 用 BigInt 复刻 Python 任意精度累加，避免长字符串在 32 位截断下与参考实现不一致。
 * @param {string} str
 * @param {number} h 初始值（g_tk 场景传 5381）
 * @returns {number}
 */
export function hash33(str, h = 0) {
  let acc = BigInt(Math.trunc(h) >>> 0)
  for (const ch of String(str)) acc = acc * 33n + BigInt(ch.codePointAt(0))
  return Number(acc & 0x7fffffffn)
}
