/**
 * Cookie 基础件（抓取链路共用）——Jar、解析、Playwright storage_state 互转。
 *
 * 为什么单独成文件：cookie 会话在两条路径上都要用（fetch 的 Cookie 头 / 浏览器的
 * storage_state），且需要落盘复用（见 session-store.js）。放在这里避免 index.js ↔
 * session-store.js 互相 import（循环依赖）。
 *
 * 安全约定：cookie **值**永不进日志；落盘只写 domain/path/name/value/expires/secure/httpOnly。
 */

export function defaultCookiePath(reqPath) {
  const p = String(reqPath || '/')
  if (!p.startsWith('/')) return '/'
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export function cookieDomainMatch(cookieDomain, host) {
  const d = String(cookieDomain || '').replace(/^\./, '').toLowerCase()
  if (!d) return false
  return host === d || host.endsWith('.' + d)
}

export function cookiePathMatch(cookiePath, reqPath) {
  const cp = String(cookiePath || '/')
  const rp = String(reqPath || '/')
  if (rp === cp) return true
  if (!rp.startsWith(cp)) return false
  return cp.endsWith('/') || rp[cp.length] === '/'
}

export function parseSetCookie(line, host, reqPath) {
  const s = String(line || '')
  const semi = s.indexOf(';')
  const pair = (semi === -1 ? s : s.slice(0, semi)).trim()
  const eq = pair.indexOf('=')
  if (eq <= 0) return null
  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim()
  if (!name) return null
  let domain = host
  let path = defaultCookiePath(reqPath)
  let expires = null
  let secure = false
  let httpOnly = false
  if (semi !== -1) {
    for (const attr of s.slice(semi + 1).split(';')) {
      const i = attr.indexOf('=')
      const k = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase()
      const v = i === -1 ? '' : attr.slice(i + 1).trim()
      if (k === 'domain' && v) {
        const d = v.replace(/^\./, '').toLowerCase()
        if (!cookieDomainMatch(d, host)) return null // 跨域伪造的 Domain 直接拒绝
        domain = d
      } else if (k === 'path' && v.startsWith('/')) {
        path = v
      } else if (k === 'max-age' && /^-?\d+$/.test(v)) {
        expires = Date.now() + Number(v) * 1000
      } else if (k === 'expires') {
        const t = Date.parse(v)
        if (!Number.isNaN(t)) expires = t
      } else if (k === 'secure') {
        secure = true
      } else if (k === 'httponly') {
        httpOnly = true
      }
    }
  }
  if (expires != null && expires <= Date.now()) return null
  return { key: `${domain}\n${path}\n${name}`, domain, path, name, value, expires, secure, httpOnly }
}

/** 组合 Set-Cookie 头（无 getSetCookie 时）按 `, name=` 切分——Expires 里的逗号不会命中该模式 */
export function splitCombinedSetCookie(raw) {
  return String(raw || '').split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=)/g).map((s) => s.trim()).filter(Boolean)
}

export function getSetCookieLines(res) {
  const h = res?.headers
  if (!h) return []
  try {
    if (typeof h.getSetCookie === 'function') {
      const list = h.getSetCookie()
      if (Array.isArray(list) && list.length) return list.filter(Boolean).map(String)
    }
  } catch { /* 继续用组合头 */ }
  const raw = typeof h.get === 'function' ? h.get('set-cookie') : null
  return raw ? splitCombinedSetCookie(raw) : []
}

/**
 * 极简 Cookie Jar —— 纯 HTTP 重定向/重试之间保持会话（很多站点首访发 cookie 才给正文）。
 * 安全：只在内存（不落盘——落盘由 session-store.js 显式负责）、只发往 domain/path/secure
 * 匹配的 host、容量上限、日志不打印 cookie 值。
 */
export function createCookieJar({ max = 300, seed = null } = {}) {
  const store = new Map() // key -> cookie（插入序即 LRU 顺序）
  const evict = () => { while (store.size > max) store.delete(store.keys().next().value) }
  // 预置（持久化会话恢复用）：直接放结构化 cookie，避免把值拼成 Set-Cookie 文本再解析一遍
  for (const c of seed || []) {
    if (c && c.name && c.domain && (c.expires == null || c.expires > Date.now())) store.set(c.key || `${c.domain}\n${c.path || '/'}\n${c.name}`, c)
  }
  return {
    size: () => store.size,
    clear: () => store.clear(),
    /** 当前全部 cookie（持久化回写用；含过期未清理项，由调用方/落盘层过滤） */
    cookies: () => [...store.values()],
    /** 组装请求 Cookie 头（匹配 host/path/secure；顺带清理过期项） */
    header(target) {
      let u
      try { u = new URL(String(target)) } catch { return '' }
      const host = u.hostname.toLowerCase()
      const path = u.pathname || '/'
      const https = u.protocol === 'https:'
      const parts = []
      for (const [key, c] of store) {
        if (c.expires != null && c.expires <= Date.now()) { store.delete(key); continue }
        if (c.secure && !https) continue
        if (!cookieDomainMatch(c.domain, host) || !cookiePathMatch(c.path, path)) continue
        parts.push(`${c.name}=${c.value}`)
      }
      return parts.join('; ')
    },
    /** 存入响应 Set-Cookie（不合法/过期/跨域拒绝） */
    store(target, lines) {
      let u
      try { u = new URL(String(target)) } catch { return }
      const host = u.hostname.toLowerCase()
      for (const line of lines || []) {
        const c = parseSetCookie(line, host, u.pathname || '/')
        if (!c) continue
        store.delete(c.key)
        store.set(c.key, c)
      }
      evict()
    },
  }
}

/** 我们的 cookie 结构 → Playwright storage_state 的 cookie 形态（浏览器路径注入用） */
export function toPlaywrightCookie(c) {
  const expires = c?.expires != null ? Math.floor(Number(c.expires) / 1000) : -1
  return {
    name: String(c?.name || ''),
    value: String(c?.value ?? ''),
    domain: String(c?.domain || ''),
    path: String(c?.path || '/'),
    expires: Number.isFinite(expires) ? expires : -1,
    httpOnly: c?.httpOnly === true,
    secure: c?.secure === true,
    sameSite: 'Lax',
  }
}

/** Playwright/浏览器回传的 cookie → 我们的结构（非法项返回 null） */
export function fromPlaywrightCookie(c, fallbackDomain = '') {
  if (!c || typeof c !== 'object') return null
  const name = String(c.name || '').trim()
  if (!name) return null
  const domain = String(c.domain || fallbackDomain || '').replace(/^\./, '').toLowerCase()
  if (!domain) return null
  const path = String(c.path || '/')
  const rawExp = Number(c.expires)
  const expires = Number.isFinite(rawExp) && rawExp > 0 ? rawExp * 1000 : null
  if (expires != null && expires <= Date.now()) return null
  return {
    key: `${domain}\n${path}\n${name}`,
    domain,
    path: path.startsWith('/') ? path : '/',
    name,
    value: String(c.value ?? ''),
    expires,
    secure: c.secure === true,
    httpOnly: c.httpOnly === true,
  }
}
