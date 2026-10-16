/**
 * 抓取「站点策略」两件套 —— per-host 限速闸门 + 站点难度记忆。
 *
 * ① createHostGate：同一站点的抓取串行化 + 最小间隔（含抖动）。反爬系统最先看的就是
 *    请求节奏：同一 host 连打（一次对话里追问几个页面）比单次慢速抓取更容易被风控。
 * ② createSiteMemory：按 host 记住「哪个档位真的能过」（fetch / crawl4ai / undetected），
 *    下次直接走有效档位，省掉必败路径的重试（每次重试都是一次新的可疑请求）。
 *
 * 两者都只影响抓取调度，不改变任何返回值语义；配置关闭时 index.js 完全不创建它们。
 */

import fs from 'node:fs'
import path from 'node:path'
import Config from '../../utils/Config.js'
import Log from '../../utils/Log.js'

export const SITE_FILE = 'sites.json'
export const SITE_VERSION = 1

/** 默认落盘目录：与 session-store 同目录（插件 data/crawl/） */
export function defaultCrawlDir() {
  const base = Config.path?.data || path.join(Config.path?.plugin || process.cwd(), 'data')
  return path.join(base, 'crawl')
}

// ───────────────────────── ① 限速闸门 ─────────────────────────

/**
 * 同 host 并发/间隔闸门。
 * @param {object} o intervalMs 两次「开始」的最小间隔；concurrency 同 host 并发上限；
 *   jitterMs 随机抖动上界（避免固定节奏）；maxWaitMs 等待上限（超时放行，不卡死对话）。
 * @returns {{ acquire(host): Promise<() => void>, stats(host?): object, reset(): void }}
 */
export function createHostGate({
  intervalMs = 0, concurrency = 1, jitterMs = 0, maxWaitMs = 15000,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), jitter = Math.random,
} = {}) {
  const interval = Math.max(0, Number(intervalMs) || 0)
  const conc = Math.max(1, Math.floor(Number(concurrency) || 1))
  const jit = Math.max(0, Number(jitterMs) || 0)
  const states = new Map()

  const stOf = (host) => {
    let s = states.get(host)
    if (!s) { s = { active: 0, lastStart: null, waiters: [], waits: 0 }; states.set(host, s) }
    return s
  }
  const pump = (s) => {
    // 先占槽再唤醒：`active` 若留到被唤醒者的微任务里才自增，while 判断时 active 还没涨，
    // 会一次性把**全部**排队者放行（实测 concurrency=1 时 maxActive=3、间隔也被绕过）。
    while (s.waiters.length && s.active < conc) {
      s.active++
      s.waiters.shift()()
    }
  }

  return {
    async acquire(host) {
      const s = stOf(host)
      // 已有等待者时也排队：保持 FIFO，避免后来的请求插队（否则限速形同虚设）
      if (s.active >= conc || s.waiters.length) {
        // 槽位由 release()/pump() 在唤醒前记入 active，这里不再自增（否则重复计数）
        await new Promise((resolve) => { s.waiters.push(resolve) })
      } else {
        s.active++
      }
      if (interval > 0 && s.lastStart != null) {
        const gap = interval + (jit > 0 ? Math.floor(jitter() * jit) : 0)
        const wait = s.lastStart + gap - now()
        if (wait > 0) {
          s.waits++
          await sleep(Math.min(wait, Math.max(0, maxWaitMs)))
        }
      }
      s.lastStart = now()
      let released = false
      return () => {
        if (released) return
        released = true
        s.active = Math.max(0, s.active - 1)
        pump(s)
      }
    },
    stats(host) {
      if (host) { const s = stOf(host); return { active: s.active, queued: s.waiters.length, waits: s.waits } }
      return { hosts: states.size }
    },
    reset() { states.clear() },
  }
}

// ───────────────────────── ② 站点难度记忆 ─────────────────────────

const BLOCK_CODES = new Set(['blocked', 'challenge', 'http_403', 'http_429'])

/**
 * 站点难度记忆（按 host 记录有效档位/被拦截次数）。
 * @param {object} o dir 落盘目录；ttlDays 多久未访问即忘；maxHosts 条目上限。
 */
export function createSiteMemory({ dir = null, ttlDays = 30, maxHosts = 500, now = () => Date.now(), logger = Log } = {}) {
  const root = dir || defaultCrawlDir()
  const file = path.join(root, SITE_FILE)
  let data = null
  let dirty = false

  function load() {
    if (data) return data
    data = { version: SITE_VERSION, hosts: {} }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.hosts && typeof parsed.hosts === 'object') {
        data = { version: SITE_VERSION, hosts: parsed.hosts }
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        try { fs.renameSync(file, `${file}.bad`) } catch { /* 改名失败不阻塞 */ }
        logger?.('warn', `[crawl] 站点记忆损坏（${e?.message || e}），已重置：${file}`)
      }
    }
    return data
  }

  function prune() {
    const d = load()
    const t = now()
    const ttlMs = Math.max(0, Number(ttlDays) || 0) * 86400_000
    let changed = false
    for (const [host, e] of Object.entries(d.hosts)) {
      if (ttlMs > 0 && t - Number(e?.updatedAt || 0) > ttlMs) { delete d.hosts[host]; changed = true }
    }
    const hosts = Object.keys(d.hosts)
    if (hosts.length > maxHosts) {
      hosts.sort((a, b) => Number(d.hosts[a]?.updatedAt || 0) - Number(d.hosts[b]?.updatedAt || 0))
      for (const h of hosts.slice(0, hosts.length - maxHosts)) { delete d.hosts[h]; changed = true }
    }
    if (changed) dirty = true
    return changed
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
      logger?.('warn', `[crawl] 站点记忆写入失败（${e?.message || e}）：${file}`)
      return false
    }
  }

  const get = (host) => load().hosts[host] || null

  return {
    dir: root,
    file,
    /**
     * 记录一次抓取结果（tier: 'fetch' | 'crawl4ai' | 'undetected'）。
     * 只在档位/结果变化时落盘，避免每次抓取都写文件。
     */
    note(host, { ok = false, tier = 'crawl4ai', code = null } = {}) {
      if (!host) return
      const d = load()
      const t = now()
      let e = d.hosts[host]
      if (!e) { e = { ok: 0, blocked: 0, tier: null, blockTier: null, lastCode: null, updatedAt: t }; d.hosts[host] = e }
      const before = JSON.stringify([e.tier, e.blocked, e.blockTier, e.lastCode])
      if (ok) {
        e.ok = (e.ok || 0) + 1
        e.tier = tier
        e.lastOkAt = t
      } else {
        e.fail = (e.fail || 0) + 1
        if (BLOCK_CODES.has(String(code || ''))) {
          e.blocked = (e.blocked || 0) + 1
          e.blockTier = tier
        }
        e.lastCode = code || e.lastCode || null
        e.lastFailAt = t
      }
      e.updatedAt = t
      if (JSON.stringify([e.tier, e.blocked, e.blockTier, e.lastCode]) !== before) dirty = true
    },
    /**
     * 下次优先档位：
     *  - 上次成功且是 fetch → 'fetch'（静态页不必起浏览器）
     *  - 上次成功是 undetected → 'undetected'（普通档已知过不去，别浪费一轮）
     *  - 上次在 crawl4ai 档被拦截、且从未在 crawl4ai 成功过 → 'undetected'
     *  - 其余 → null（走默认阶梯）
     */
    preferredTier(host) {
      const e = get(host)
      if (!e) return null
      if (e.tier === 'fetch') return 'fetch'
      if (e.tier === 'undetected') return 'undetected'
      if (e.blockTier === 'crawl4ai' && Number(e.blocked) > 0 && e.tier !== 'crawl4ai') return 'undetected'
      return null
    },
    stats(host) {
      if (host) {
        const e = get(host)
        return e ? { ...e } : null
      }
      const d = load()
      return { hosts: Object.keys(d.hosts).length, file }
    },
    prune,
    flush: save,
    _reset() { data = null; dirty = false },
  }
}
