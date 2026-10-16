/**
 * 抓取会话持久化 —— 按站点把 cookie（含 Cloudflare `cf_clearance` / `__cf_bm`、
 * Akamai `_abck` 这类**会话级通行证**）落盘复用。
 *
 * 背景：抓取链路此前每次调用都是「全新的第一次访客」——fetch 的 Cookie Jar 只活在单次
 * 调用内，浏览器路径每次新起上下文，清关 cookie 永远无法复用，于是每次都要重打一遍
 * 反爬挑战（甚至永远过不去）。本模块让 fetch 与浏览器两条路径共用同一份按站点会话。
 *
 * 安全：
 *  - 文件落在 `Config.path.data/crawl/sessions.json`（插件自用目录），权限 0o600；
 *  - **cookie 值绝不进日志**（日志只报 host 与条数）；
 *  - 只保存实际抓取过的 host（SSRF 门禁已挡内网/元数据地址）；
 *  - 容量与时效双上限：host 数、每 host 条数、TTL（默认 12h 未使用即清）。
 */

import fs from 'node:fs'
import path from 'node:path'
import Config from '../../utils/Config.js'
import Log from '../../utils/Log.js'
import { cookieDomainMatch, fromPlaywrightCookie, toPlaywrightCookie } from './cookies.js'

export const SESSION_FILE = 'sessions.json'
export const SESSION_VERSION = 1

/** 默认落盘目录：插件 data 目录下的 crawl/（测试传 dir 覆盖） */
export function defaultSessionDir() {
  const base = Config.path?.data || path.join(Config.path?.plugin || process.cwd(), 'data')
  return path.join(base, 'crawl')
}

const isExpired = (c, now) => c?.expires != null && Number(c.expires) <= now

/**
 * 创建持久会话存储。
 * @param {object} o
 *  - dir: 落盘目录（默认 defaultSessionDir()）
 *  - ttlHours: 某 host 多久未使用即整条清理（默认 12）
 *  - maxPerHost: 单 host cookie 条数上限（默认 200）
 *  - maxHosts: host 条目上限，超出按最近使用淘汰（默认 300）
 *  - now/logger: 便于测试注入
 */
export function createSessionStore({ dir = null, ttlHours = 12, maxPerHost = 200, maxHosts = 300, now = () => Date.now(), logger = Log } = {}) {
  const root = dir || defaultSessionDir()
  const file = path.join(root, SESSION_FILE)
  let data = null
  let dirty = false

  function load() {
    if (data) return data
    data = { version: SESSION_VERSION, hosts: {} }
    try {
      const raw = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.hosts && typeof parsed.hosts === 'object') {
        data = { version: SESSION_VERSION, hosts: parsed.hosts }
      }
    } catch (e) {
      // 文件不存在是常态（首次运行）；损坏则改名留证并重来，绝不让抓取因会话文件挂掉
      if (e?.code !== 'ENOENT') {
        try { fs.renameSync(file, `${file}.bad`) } catch { /* 改名失败不阻塞 */ }
        logger?.('warn', `[crawl] 会话文件损坏（${e?.message || e}），已重置：${file}`)
      }
    }
    return data
  }

  function hostEntry(host, create = false) {
    const d = load()
    let e = d.hosts[host]
    if (!e && create) { e = { cookies: [], updatedAt: now() }; d.hosts[host] = e }
    if (e && !Array.isArray(e.cookies)) e.cookies = []
    return e || null
  }

  /** 清理：过期 cookie、空条目、超 TTL 条目、超量 host（LRU） */
  function prune() {
    const d = load()
    const t = now()
    const ttlMs = Math.max(0, Number(ttlHours) || 0) * 3600_000
    let changed = false
    for (const [host, e] of Object.entries(d.hosts)) {
      const before = e.cookies?.length || 0
      let cookies = (e.cookies || []).filter((c) => c?.name && c?.domain && !isExpired(c, t))
      if (cookies.length > maxPerHost) cookies = cookies.slice(-maxPerHost)
      e.cookies = cookies
      if (cookies.length !== before) changed = true
      if (!cookies.length || (ttlMs > 0 && t - Number(e.updatedAt || 0) > ttlMs)) {
        delete d.hosts[host]
        changed = true
      }
    }
    const hosts = Object.keys(d.hosts)
    if (hosts.length > maxHosts) {
      hosts.sort((a, b) => Number(d.hosts[a]?.updatedAt || 0) - Number(d.hosts[b]?.updatedAt || 0))
      for (const h of hosts.slice(0, hosts.length - maxHosts)) { delete d.hosts[h]; changed = true }
    }
    if (changed) dirty = true
    return changed
  }

  /** 该 host 现在可用的 cookie（按 domain 匹配：抓 sub.example.com 也能拿到 .example.com 的清关 cookie） */
  function gather(host) {
    const d = load()
    const t = now()
    const byKey = new Map()
    for (const e of Object.values(d.hosts)) {
      for (const c of e.cookies || []) {
        if (!c?.name || !c?.domain || isExpired(c, t)) continue
        if (!cookieDomainMatch(c.domain, host)) continue
        byKey.set(c.key || `${c.domain}\n${c.path || '/'}\n${c.name}`, c)
      }
    }
    return [...byKey.values()]
  }

  /** upsert（按 domain+path+name）：浏览器回传与新 Set-Cookie 都走这里 */
  function upsert(host, cookies) {
    if (!cookies?.length) return 0
    const e = hostEntry(host, true)
    const t = now()
    const map = new Map((e.cookies || []).map((c) => [c.key || `${c.domain}\n${c.path || '/'}\n${c.name}`, c]))
    let n = 0
    for (const c of cookies) {
      if (!c?.name || !c?.domain || isExpired(c, t)) continue
      const key = c.key || `${c.domain}\n${c.path || '/'}\n${c.name}`
      if (map.has(key)) map.delete(key) // 重新写入视为最新（下面的条数上限据此保留最近 N 条）
      map.set(key, c)
      n++
    }
    if (n) {
      let list = [...map.values()]
      if (list.length > maxPerHost) list = list.slice(-maxPerHost)
      e.cookies = list
      e.updatedAt = t
      dirty = true
    }
    return n
  }

  function save() {
    prune()
    if (!dirty) return false
    try {
      fs.mkdirSync(root, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(load()), { mode: 0o600 })
      fs.renameSync(tmp, file)
      dirty = false
      return true
    } catch (e) {
      logger?.('warn', `[crawl] 会话写入失败（${e?.message || e}）：${file}`)
      return false
    }
  }

  return {
    dir: root,
    file,
    /** 该 host 的会话 cookie（供 fetch 路径预置 Jar / 浏览器路径转 storage_state） */
    cookiesFor: gather,
    /** 组装 Playwright storage_state（无 cookie 时返回 null，避免给浏览器塞空状态） */
    storageStateFor(host) {
      const cookies = gather(host).map(toPlaywrightCookie).filter((c) => c.name && c.domain)
      return cookies.length ? { cookies, origins: [] } : null
    },
    /** 合并浏览器回传的 cookie（Playwright 形态） */
    mergeFromBrowser(host, list) {
      const mapped = (Array.isArray(list) ? list : []).map((c) => fromPlaywrightCookie(c, host)).filter(Boolean)
      return upsert(host, mapped)
    },
    /** 合并 fetch 路径 Jar 中的 cookie（我们的结构） */
    merge(host, list) { return upsert(host, list) },
    prune,
    flush: save,
    stats() {
      const d = load()
      const hosts = Object.keys(d.hosts)
      return { hosts: hosts.length, cookies: hosts.reduce((n, h) => n + (d.hosts[h].cookies?.length || 0), 0), file }
    },
    /** 仅测试用：丢弃内存态 */
    _reset() { data = null; dirty = false },
  }
}

// ───────────────────────── 运行期单例（配置热加载后按需重建） ─────────────────────────

let _store = null
let _key = ''

/** 取当前配置对应的会话存储（dir/ttl 变化时重建；import 侧不持有跨配置实例） */
export function sessionStoreFor(policy = {}) {
  const key = `${policy.sessionDir || ''}|${policy.sessionTtlHours ?? 12}`
  if (_store && _key === key) return _store
  _store = createSessionStore({
    ...(policy.sessionDir ? { dir: policy.sessionDir } : {}),
    ttlHours: policy.sessionTtlHours ?? 12,
  })
  _key = key
  return _store
}

export function resetSessionStore() { _store = null; _key = '' }
