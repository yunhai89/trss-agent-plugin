/**
 * 哔哩哔哩 Wbi 签名（Web 端风控签名）—— 逆向实现。
 *
 * 来源：哔哩哔哩野生 API 文档（realysy/bili-apis ≈ SocialSisterYi/bilibili-API-collect）
 *   docs/misc/sign/wbi.md
 *
 * 原理：
 *  1) 从 nav 接口的 wbi_img.img_url / sub_url 取文件名得 img_key / sub_key（全站统一、每日更替）；
 *  2) 按 MIXIN_KEY_ENC_TAB 重排 (img_key + sub_key) 取前 32 位 = mixin_key；
 *  3) 请求参数加 wts，按键名升序 URL 编码（字母大写、空格 %20），拼 mixin_key 后取 MD5 = w_rid。
 *
 * 已用文档测试向量离线自检（见 bilibili.test.mjs）。
 */
import crypto from 'node:crypto'

export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
]

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')

/** 与官方文档一致的 URL 编码：encodeURIComponent 后把 !'()* 也百分号编码（字母大写、空格 %20） */
export function encodeWbiValue(v) {
  return encodeURIComponent(String(v)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** 由 img_key + sub_key 生成 mixin_key（重排后取前 32 位） */
export function genMixinKey(imgKey, subKey) {
  const raw = String(imgKey || '') + String(subKey || '')
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32)
}

/** 从 nav 的 wbi_img url 中取 key（去路径与扩展名） */
export function keyFromWbiUrl(url) {
  const file = String(url || '').split('/').pop() || ''
  return file.replace(/\.[a-z0-9]+$/i, '')
}

/**
 * 对参数做 Wbi 签名，返回带 wts / w_rid 的新参数对象。
 * @param {object} params 原始请求参数
 * @param {string} imgKey
 * @param {string} subKey
 * @param {number} [wts] Unix 秒时间戳（测试用）
 */
export function encWbi(params, imgKey, subKey, wts = Math.round(Date.now() / 1000)) {
  const mixinKey = genMixinKey(imgKey, subKey)
  const withWts = { ...params, wts }
  const query = Object.keys(withWts).sort()
    .map((k) => `${encodeWbiValue(k)}=${encodeWbiValue(withWts[k])}`)
    .join('&')
  return { ...params, wts, w_rid: md5(query + mixinKey) }
}
