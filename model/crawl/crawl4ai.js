/**
 * crawl4ai Python 子进程监管（一次性模式）—— 真浏览器渲染抓取。
 *
 * 契约（python-subprocess-supervision）：
 *  - argv 列表 + shell:false：[venvPython, scripts/crawl4ai_fetch.py]，请求走 stdin JSON
 *    （URL 长度/特殊字符不占 argv，杜绝拼接注入面）；
 *  - stdout=机器协议（单行 JSON），stderr=日志（并发 drain，只留尾部 8KB 防爆内存）；
 *  - 超时分阶段：先快照后代进程（Linux /proc PPID 链，覆盖 setsid 逃逸组杀的孙进程）
 *    → SIGTERM 进程组 → 宽限 → SIGKILL 进程组+快照 → reap；
 *  - 结构化错误：spawn_failed / request_timeout / protocol_error / crashed /
 *    crawl_failed / invalid_request；取消/超时/崩溃分别可辨。
 *
 * 每次调用 spawn 新进程（浏览器启停 ~2-5s）：工具调用频率低，换实现简单性与进程隔离。
 * venv 由 scripts/install-crawl4ai.sh 创建；未安装时 isCrawl4aiAvailable() 探测失败，
 * crawlUrl 自动降级 fetch+cheerio（保持现有降级语义）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Config from '../../utils/Config.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const IS_WIN = process.platform === 'win32'

export const CRAWL4AI_VENV_DIR = process.env.CRAWL4AI_VENV || path.join(PLUGIN_ROOT, '.crawl4ai-venv')
export const CRAWL4AI_SCRIPT = process.env.CRAWL4AI_PYSCRIPT || path.join(PLUGIN_ROOT, 'python', 'crawl4ai_fetch.py')
export const CRAWL4AI_TIMEOUTS = {
  defaultMs: 90_000,     // 单页抓取总预算（含浏览器启动；crawlTimeout 可覆盖）
  probeTtlMs: 300_000,   // 可用性探测缓存 5 分钟（探测=spawn 一次 import 检查）
  probeRunMs: 15_000,    // 探测自身超时
  termGraceMs: 250,      // SIGTERM → SIGKILL 宽限
}

const venvPython = () => path.join(CRAWL4AI_VENV_DIR, IS_WIN ? 'Scripts' : 'bin', IS_WIN ? 'python.exe' : 'python3')

/** Linux：按 PPID 链快照 pid 的全部后代（组杀前调用——父死后会重挂 PID1，扫不到了） */
function snapshotDescendants(rootPid) {
  const pids = []
  if (!fs.existsSync('/proc') || !Number.isFinite(rootPid)) return pids
  try {
    const ppids = new Map() // pid -> ppid
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8')
        // comm 字段可能含空格/括号：取最后一个 ')' 之后的部分
        const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        ppids.set(Number(name), Number(after[1]))
      } catch { /* 进程消失：跳过 */ }
    }
    const byPpid = new Map()
    for (const [pid, ppid] of ppids) {
      if (!byPpid.has(ppid)) byPpid.set(ppid, [])
      byPpid.get(ppid).push(pid)
    }
    const queue = [rootPid]
    while (queue.length) {
      const cur = queue.shift()
      for (const child of byPpid.get(cur) || []) {
        pids.push(child)
        queue.push(child)
      }
    }
    return pids
  } catch {
    return pids // /proc 不可用（非 Linux）：退回纯进程组信号
  }
}

const killPid = (pid, sig) => { try { process.kill(pid, sig) } catch { /* 已退出 */ } }

/**
 * 运行一次 crawl4ai 抓取（官方完整交互能力透传——同态渲染/结构化抽取/链接清单）。
 * @param {object} o 高级参数（与 python/crawl4ai_fetch.py 请求协议一一对应）：
 *  - waitFor: 'css:SELECTOR' | 'js:() => bool'（等动态渲染完成）
 *  - jsCode: string | string[]（滚动/点击触发懒加载；多段依序执行）
 *  - jsBeforeWait: string（导航后先触发再等待——官方 goto → js_before_wait → wait_for 顺序）
 *  - delayMs: number（hydration 余量；不传用 python 侧默认 800）
 *  - cssSelector / extract({baseSelector,fields}) / links / stealth / flatShadowDom / virtualScroll
 * @returns {Promise<{success, markdown?, title?, via, code?, error?, stderrTail?, extracted?, extractedCount?, links?}>}
 *  成功形态与 crawlWithFetch 对齐（success/markdown/title + via:'crawl4ai'），crawlUrl 可统一消费。
 */
export async function runCrawl4ai(url, {
  python, script, timeoutMs = null, maxChars = 60000,
  waitFor = null, jsCode = null, jsBeforeWait = null, delayMs = null,
  cssSelector = null, extract = null, links = false, stealth = false,
  flatShadowDom = false, virtualScroll = null,
} = {}) {
  const py = python || venvPython()
  const sc = script || CRAWL4AI_SCRIPT
  const cfgTimeout = Number(Config.get?.()?.agent?.kb?.crawlTimeout)
  const timeout = timeoutMs ?? (Number.isFinite(cfgTimeout) && cfgTimeout > 0 ? cfgTimeout * 1000 + 30_000 : CRAWL4AI_TIMEOUTS.defaultMs)
  // 前置快失败：wait_for 前缀白名单（python 侧同款校验——不为此起浏览器进程）
  if (waitFor && !/^(css:|js:)/.test(String(waitFor).trim())) {
    return { success: false, via: 'crawl4ai', code: 'invalid_request', error: 'waitFor 需以 css: 或 js: 开头' }
  }

  let proc
  try {
    // 前置存在性检查：解释器/脚本缺失直接结构化 spawn_failed（不进入「子进程启动后秒退」
    // 的 crashed 歧义——node/python 都存在但脚本缺失时 exit 1 无法与真崩溃区分）
    if (!fs.existsSync(sc)) return { success: false, via: 'crawl4ai', code: 'spawn_failed', error: `脚本不存在：${sc}` }
    proc = spawn(py, [sc], { stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WIN }) // argv + shell 默认 false
  } catch (e) {
    return { success: false, via: 'crawl4ai', code: 'spawn_failed', error: e?.message || String(e) }
  }
  if (!proc.pid) {
    return { success: false, via: 'crawl4ai', code: 'spawn_failed', error: 'spawn 未获得 pid（解释器不存在？）' }
  }

  return await new Promise((resolve) => {
    let stdout = ''
    let stderrTail = ''
    let settled = false
    let timedOut = false
    const STDOUT_CAP = 32 * 1024 * 1024 // python 侧 max_chars 截断后的 32MB 硬顶（防失控内存）
    const STDERR_TAIL = 8 * 1024

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { proc.stdin?.destroy() } catch { /* 已关 */ }
      resolve(result)
    }

    proc.stdout.on('data', (d) => { if (stdout.length < STDOUT_CAP) stdout += d })
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-STDERR_TAIL) // 环形留尾（并发 drain 不堵 pipe）
    })
    proc.on('error', (e) => finish({ success: false, via: 'crawl4ai', code: 'spawn_failed', error: e?.message || String(e) }))

    proc.on('exit', (code, signal) => {
      if (settled) return
      // 解析 stdout 最后一条可解析 JSON 行（容忍半包/坏帧混排）
      let parsed = null
      for (const line of String(stdout).split('\n').reverse()) {
        const t = line.trim()
        if (!t.startsWith('{')) continue
        try { parsed = JSON.parse(t); break } catch { /* 坏帧：继续找上一行 */ }
      }
      const stderr = { stderrTail: stderrTail.trim().slice(-2000) }
      if (parsed == null) {
        // stdout 无协议输出：按退出原因分类——超时/被杀=请求超时，声称成功=协议错误，其余=子进程崩溃
        const code2 = timedOut ? 'request_timeout' : (signal ? 'crashed' : (code === 0 ? 'protocol_error' : 'crashed'))
        finish({ success: false, via: 'crawl4ai', code: code2, error: `stdout 无可解析 JSON（exit=${code}${signal ? ' sig=' + signal : ''}）`, ...stderr })
        return
      }
      if (parsed.ok) {
        finish({
          success: true, via: 'crawl4ai',
          markdown: String(parsed.markdown || ''), title: String(parsed.title || ''),
          url: parsed.url || url, statusCode: parsed.status_code,
          ...(Array.isArray(parsed.extracted) ? { extracted: parsed.extracted, extractedCount: parsed.extracted_count ?? parsed.extracted.length } : {}),
          ...(parsed.links && typeof parsed.links === 'object' ? { links: parsed.links } : {}),
        })
        return
      }
      const code4 = code === 3 ? 'invalid_request' : (timedOut ? 'request_timeout' : (code === 124 ? 'request_timeout' : 'crawl_failed'))
      finish({ success: false, via: 'crawl4ai', code: parsed.code || code4, error: String(parsed.error || `exit=${code}`), ...stderr })
    })

    // 分阶段超时：快照后代 → TERM 组 → 宽限 → KILL 组+快照（exit 事件收尾 reap）
    const timer = setTimeout(() => {
      timedOut = true
      const extra = snapshotDescendants(proc.pid)
      try { if (!IS_WIN) process.kill(-proc.pid, 'SIGTERM'); else proc.kill('SIGTERM') } catch { /* 组已消失 */ }
      setTimeout(() => {
        try { if (!IS_WIN) process.kill(-proc.pid, 'SIGKILL'); else proc.kill('SIGKILL') } catch { /* 已退出 */ }
        for (const pid of extra) killPid(pid, 'SIGKILL') // 逃逸进程组的孙进程（setsid 的 chromium 等）
      }, CRAWL4AI_TIMEOUTS.termGraceMs)
      // 不在这里 finish：等 exit 事件带上 timedOut 标记统一收尾（避免双结算）
    }, timeout)

    // 请求写 stdin（背压兜底：请求体小，写满管道概率可忽略；destroy on error 已覆盖）
    try {
      const req = { url, timeout_s: Math.round(timeout / 1000), max_chars: maxChars }
      if (waitFor) req.wait_for = String(waitFor).trim()
      if (jsCode) req.js_code = Array.isArray(jsCode) ? jsCode : String(jsCode)
      if (jsBeforeWait) req.js_before_wait = String(jsBeforeWait)
      if (delayMs != null) req.delay_ms = Number(delayMs)
      if (cssSelector) req.css_selector = String(cssSelector)
      if (extract && typeof extract === 'object') req.extract = extract
      if (links) req.links = true
      if (stealth) req.stealth = true
      if (flatShadowDom) req.flat_shadow_dom = true
      if (virtualScroll && typeof virtualScroll === 'object') req.virtual_scroll = virtualScroll
      proc.stdin.write(JSON.stringify(req) + '\n')
      proc.stdin.end()
    } catch (e) {
      finish({ success: false, via: 'crawl4ai', code: 'spawn_failed', error: `stdin 写入失败：${e?.message || e}` })
    }
  })
}

// importlib.metadata 拿发行版号（某些版本 crawl4ai.__version__ 是 module 而非字符串）
const PROBE_CODE = 'from importlib.metadata import version; print(version("crawl4ai"))'

let probeCache = { key: null, at: 0, result: null }

/**
 * 可用性探测（带 TTL 缓存）：venv python -c "import crawl4ai" 是否成功。
 * 版本串仅诊断用；判活看退出码（垃圾版本串仍算可用——降级判定不该被输出格式绑架）。
 */
export async function isCrawl4aiAvailable({ python = null, probeArg = null, ttl = null } = {}) {
  const py = python || venvPython()
  const key = `${py}|${JSON.stringify(probeArg)}`
  const now = Date.now()
  const ttlMs = ttl ?? CRAWL4AI_TIMEOUTS.probeTtlMs
  if (ttlMs > 0 && probeCache.key === key && now - probeCache.at < ttlMs && probeCache.result) return probeCache.result
  const result = await new Promise((resolve) => {
    let out = ''
    let settled = false
    let proc
    try {
      proc = spawn(py, probeArg ?? ['-c', PROBE_CODE], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ ok: false, reason: 'spawn_failed', error: e?.message || String(e) })
    }
    if (!proc.pid) return resolve({ ok: false, reason: 'spawn_failed', error: '无 pid' })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { proc.kill('SIGKILL') } catch { /* 已退出 */ }
      resolve({ ok: false, reason: 'probe_timeout' })
    }, CRAWL4AI_TIMEOUTS.probeRunMs)
    proc.stdout.on('data', (d) => { out += d })
    proc.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, reason: 'spawn_failed' }) } })
    proc.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        const version = String(out).trim().split('\n').pop().slice(0, 40)
        resolve({ ok: true, version: version || 'unknown' })
      } else {
        resolve({ ok: false, reason: `exit=${code}`, hint: '未安装？跑 scripts/install-crawl4ai.sh' })
      }
    })
  })
  probeCache = { key, at: now, result }
  return result
}
