/**
 * 静态资源版本化：给 index.html 里本地资源 URL（assets/、vendor/）追加 `?v=<版本>`。
 *
 * 目的：面板发版后浏览器仍可能命中旧 JS 缓存（部分客户端不按 max-age=0 重新校验），
 * 导致「服务端已修、页面仍旧」（如 suggestions.js 旧版渲染报错整页空白）。加版本查询串后，
 * 版本一变 URL 就变，浏览器必取新文件；同版本内仍可正常 304 复用。
 */
const LOCAL_RE = /(\s(?:src|href)=")((?:assets|vendor)\/[^"]+)(")/g

/** 给本地资源 URL 追加 ?v=version（幂等：已带 ?v= 的不重复追加；version 为空则原样返回） */
export function versionAssetUrls(html, version) {
  const v = String(version ?? '').trim()
  if (!v) return String(html ?? '')
  return String(html ?? '').replace(LOCAL_RE, (m, pre, url, post) => {
    if (/[?&]v=/.test(url)) return m
    return `${pre}${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(v)}${post}`
  })
}
