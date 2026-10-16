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
 *
 * 沙箱档（显式 kb.crawl.execution=sandbox，且 agent.sandbox.mode=e2b）：web_crawl 工具改经
 * runCrawl4aiInSandbox 在会话沙箱内执行（上传脚本 + 请求文件 stdin 重定向，同一 python 协议与结果映射），
 * 宿主不再 spawn python；沙箱模板缺 crawl4ai 时探测失败 → crawlUrl 走 fetch 降级（纯 HTTP，非 shell）。
 * **默认档是本地**（执行面解析见 index.js 的 resolveCrawlExecution）：crawl4ai 与 diagram 的本机
 * Kroki 同类，是固定能力的本机引擎，不随 sandbox.mode 进沙箱——沙箱模板没装 crawl4ai 时，
 * 硬走沙箱会让整条链路恒降级 fetch，反而丢掉宿主已装好的浏览器。
 * 请求体拼装（buildCrawl4aiRequest）与结果映射（mapCrawl4aiOutput）两档共用，杜绝口径漂移。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import Config from '../../utils/Config.js'
import { openToolSession, runToolCommand, sandboxTmp, shellQuote } from '../sandbox/bridge.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const IS_WIN = process.platform === 'win32'

export const CRAWL4AI_VENV_DIR = process.env.CRAWL4AI_VENV || path.join(PLUGIN_ROOT, '.crawl4ai-venv')
export const CRAWL4AI_SCRIPT = process.env.CRAWL4AI_PYSCRIPT || path.join(PLUGIN_ROOT, 'python', 'crawl4ai_fetch.py')
export const CRAWL4AI_TIMEOUTS = {
  defaultMs: 90_000,     // 单页抓取总预算（含浏览器启动；crawlTimeout 可覆盖）
  probeTtlMs: 300_000,   // 可用性探测缓存 5 分钟（探测=spawn 一次 import 检查）
  probeNegativeTtlMs: 30_000, // 探测「不可用」结果的短 TTL：安装/修复后尽快被识别（不必等 5 分钟或重启）
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
 *  - undetected: 用 UndetectedAdapter 深度补丁（反爬升级档；需 venv 内 patchright 可用）
 *  - proxy: 浏览器代理（http/socks URL；agent.proxy 透传，与 fetch 路径一致）
 *  - waitUntil: 导航完成条件（domcontentloaded/load/networkidle/commit）
 *  - headless / scanFullPage / maxScrollSteps / extraArgs（内部策略注入，非 LLM 参数）
 * @returns {Promise<{success, markdown?, title?, via, code?, error?, stderrTail?, extracted?, extractedCount?, links?, stats?}>}
 *  成功形态与 crawlWithFetch 对齐（success/markdown/title + via:'crawl4ai'），crawlUrl 可统一消费。
 */
export async function runCrawl4ai(url, {
  python, script, timeoutMs = null, maxChars = 60000,
  waitFor = null, jsCode = null, jsBeforeWait = null, delayMs = null,
  cssSelector = null, extract = null, links = false, stealth = false,
  flatShadowDom = false, virtualScroll = null,
  undetected = false, proxy = null, waitUntil = null, headless = null,
  scanFullPage = false, maxScrollSteps = null, extraArgs = null,
  userDataDir = null, storageState = null, sessionCapture = false,
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

  // spawn 的同步返回不代表启动成功：解释器缺失/不可执行时 Node 用异步 'error' 事件报告
  // ENOENT/EACCES。必须无条件先挂 error/exit 监听再讨论 pid——曾因 `!proc.pid` 提前 return，
  // 使 error 事件无监听器升级为 Unhandled 'error' event，打崩调用宿主（爬虫不可用时
  // 上层 fetch 降级的预期也随之被破坏）。缺 pid 只跳过 stdin/计时器，绝不跳过监听。
  return await new Promise((resolve) => {
    let stdout = ''
    let stderrTail = ''
    let settled = false
    let timedOut = false
    let timer = null
    const STDOUT_CAP = 32 * 1024 * 1024 // python 侧 max_chars 截断后的 32MB 硬顶（防失控内存）
    const STDERR_TAIL = 8 * 1024

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { proc.stdin?.destroy() } catch { /* 已关 */ }
      resolve(result)
    }

    proc.stdout?.on('data', (d) => { if (stdout.length < STDOUT_CAP) stdout += d })
    proc.stderr?.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-STDERR_TAIL) // 环形留尾（并发 drain 不堵 pipe）
    })
    // stdin 写失败（子进程即退 EPIPE 等）经流 error 事件上报；同步 try/catch 接不住。
    // 独立 no-op 消费，最终结果仍由 error/exit/超时统一结算，不在此处抢先 finish。
    proc.stdin?.on('error', () => { /* 由 exit/timeout 统一收尾 */ })
    proc.on('error', (e) => finish({ success: false, via: 'crawl4ai', code: 'spawn_failed', error: e?.message || String(e) }))

    proc.on('exit', (code, signal) => {
      if (settled) return
      // 解析 stdout 最后一条可解析 JSON 行（容忍半包/坏帧混排）；协议映射与沙箱档共用同一口径
      finish(mapCrawl4aiOutput(parseProtocolLine(stdout), { url, exitCode: code, timedOut, signal, stderrTail }))
    })

    // 无 pid（解释器缺失）：error 事件即将结算，跳过计时器/写 stdin（写失败流已单独消费）
    if (proc.pid == null) return

    // 分阶段超时：快照后代 → TERM 组 → 宽限 → KILL 组+快照（exit 事件收尾 reap）
    timer = setTimeout(() => {
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
      if (!proc.stdin) throw new Error('stdin 不可用')
      const req = buildCrawl4aiRequest({
        url, timeout,
        maxChars, waitFor, jsCode, jsBeforeWait, delayMs, cssSelector, extract, links,
        stealth, undetected, proxy, waitUntil, headless, scanFullPage, maxScrollSteps,
        extraArgs, flatShadowDom, virtualScroll, userDataDir, storageState, sessionCapture,
      })
      proc.stdin.write(JSON.stringify(req) + '\n')
      proc.stdin.end()
    } catch (e) {
      finish({ success: false, via: 'crawl4ai', code: 'spawn_failed', error: `stdin 写入失败：${e?.message || e}` })
    }
  })
}

/**
 * 请求体拼装（宿主 stdin 与沙箱请求文件共用同一份——避免两处口径漂移）。
 * 字段与 python/crawl4ai_fetch.py 的请求协议一一对应。
 */
export function buildCrawl4aiRequest({
  url, timeout = CRAWL4AI_TIMEOUTS.defaultMs, maxChars = 60000,
  waitFor = null, jsCode = null, jsBeforeWait = null, delayMs = null,
  cssSelector = null, extract = null, links = false,
  stealth = false, undetected = false, proxy = null, waitUntil = null, headless = null,
  scanFullPage = false, maxScrollSteps = null, extraArgs = null, flatShadowDom = false, virtualScroll = null,
  userDataDir = null, storageState = null, sessionCapture = false,
} = {}) {
  const req = { url, timeout_s: Math.round(timeout / 1000), max_chars: maxChars }
  if (waitFor) req.wait_for = String(waitFor).trim()
  if (jsCode) req.js_code = Array.isArray(jsCode) ? jsCode : String(jsCode)
  if (jsBeforeWait) req.js_before_wait = String(jsBeforeWait)
  if (delayMs != null) req.delay_ms = Number(delayMs)
  if (cssSelector) req.css_selector = String(cssSelector)
  if (extract && typeof extract === 'object') req.extract = extract
  if (links) req.links = true
  if (stealth) req.stealth = true
  if (undetected) req.undetected = true
  if (proxy) req.proxy = String(proxy)
  if (waitUntil) req.wait_until = String(waitUntil)
  if (headless === false || headless === true) req.headless = headless
  if (scanFullPage) req.scan_full_page = true
  if (maxScrollSteps != null) req.max_scroll_steps = Number(maxScrollSteps)
  if (Array.isArray(extraArgs) && extraArgs.length) req.extra_args = extraArgs.map(String)
  if (flatShadowDom) req.flat_shadow_dom = true
  if (virtualScroll && typeof virtualScroll === 'object') req.virtual_scroll = virtualScroll
  // 会话：user_data_dir 为显式 opt-in（共享 profile 目录与并发浏览器互斥，见 kb.crawl.sessionProfile）；
  // storage_state 是默认路径（把该站已有 cookie 注入浏览器上下文，无 profile 锁问题）
  if (userDataDir) req.user_data_dir = String(userDataDir)
  const cookies = storageState && Array.isArray(storageState.cookies) ? storageState.cookies : null
  if (cookies && cookies.length) req.storage_state = { cookies, origins: Array.isArray(storageState.origins) ? storageState.origins : [] }
  if (sessionCapture) req.session_capture = true
  return req
}

/** 解析 python 侧单行 JSON 协议输出（容忍半包/坏帧混排） */
function parseProtocolLine(stdout) {
  let parsed = null
  for (const line of String(stdout || '').split('\n').reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try { parsed = JSON.parse(t); break } catch { /* 坏帧：继续找上一行 */ }
  }
  return parsed
}

/** 协议输出 → 统一结果形态（宿主与沙箱共用解析口径） */
function mapCrawl4aiOutput(parsed, { url, exitCode = null, timedOut = false, signal = null, stderrTail = null } = {}) {
  const extra = stderrTail ? { stderrTail: String(stderrTail).trim().slice(-2000) } : {}
  if (parsed == null) {
    const code = timedOut
      ? 'request_timeout'
      : (signal ? 'crashed' : (exitCode === 0 ? 'protocol_error' : 'crashed'))
    return { success: false, via: 'crawl4ai', code, error: `stdout 无可解析 JSON（exit=${exitCode}${signal ? ' sig=' + signal : ''}）`, ...extra }
  }
  if (parsed.ok) {
    return {
      success: true, via: 'crawl4ai',
      markdown: String(parsed.markdown || ''), title: String(parsed.title || ''),
      url: parsed.url || url, statusCode: parsed.status_code,
      ...(Array.isArray(parsed.extracted) ? { extracted: parsed.extracted, extractedCount: parsed.extracted_count ?? parsed.extracted.length } : {}),
      ...(parsed.links && typeof parsed.links === 'object' ? { links: parsed.links } : {}),
      ...(parsed.crawl_stats && typeof parsed.crawl_stats === 'object' ? { stats: parsed.crawl_stats } : {}),
      // 浏览器回传的 cookie（best-effort，取决于 crawl4ai 版本能否导出）：交 session-store 合并
      ...(Array.isArray(parsed.cookies) && parsed.cookies.length ? { cookies: parsed.cookies } : {}),
    }
  }
  const fallback = exitCode === 3
    ? 'invalid_request'
    : (timedOut || exitCode === 124 ? 'request_timeout' : 'crawl_failed')
  return { success: false, via: 'crawl4ai', code: parsed.code || fallback, error: String(parsed.error || `exit=${exitCode}`), ...extra }
}

// ── 沙箱档（agent.sandbox.mode=e2b）：crawl4ai 在会话沙箱内执行，不落宿主 shell ──

const SANDBOX_SCRIPT_REMOTE = '/home/user/.agent-tmp/crawl4ai_fetch.py'
const PROBE_TIMEOUT_MS = 20000
const _scriptUploaded = new Map() // sandboxId -> 脚本内容哈希（同沙箱只传一次；脚本更新后自动重传）
const _probeCache = new Map() // sandboxId -> { at, result }（探测缓存；按沙箱 id，天然随沙箱回收过期）
const CACHE_MAX_KEYS = 200 // 长驻进程防无界增长（沙箱 id 全局唯一，不会复用）

/** 写入有界缓存（超限丢最旧条目） */
function putCapped(map, key, value) {
  map.set(key, value)
  if (map.size > CACHE_MAX_KEYS) map.delete(map.keys().next().value)
}

/** 沙箱内 python3 可 import crawl4ai？（按沙箱 id 缓存：可用 5min / 不可用 30s，便于会话内现装现用） */
export async function probeCrawl4aiInSandbox(box) {
  const sess = await openToolSession(box, { purpose: 'tool:web_crawl:probe' })
  const key = sess.sandboxId
  const now = Date.now()
  const cached = _probeCache.get(key)
  const ttl = cached?.result?.ok ? CRAWL4AI_TIMEOUTS.probeTtlMs : CRAWL4AI_TIMEOUTS.probeNegativeTtlMs
  if (cached && now - cached.at < ttl) return cached.result
  const code = 'from importlib.metadata import version; print(version("crawl4ai"))'
  const r = await runToolCommand(box, sess, `python3 -c ${shellQuote(code)}`, { timeoutMs: PROBE_TIMEOUT_MS, maxOutput: 2000, label: 'web_crawl:probe' })
  const result = r.ok
    ? { ok: true, version: (String(r.stdout).trim().split('\n').pop() || 'unknown').slice(0, 40), sandbox: true }
    : {
        ok: false, sandbox: true,
        // importlib.metadata 对未安装的包抛 PackageNotFoundError（不是 ModuleNotFoundError）——
        // 两者都归入「模板未装」，否则退化成无信息量的「探测失败（1）」
        reason: r.limited
          ? '本会话命令数已达上限'
          : (/ModuleNotFoundError|No module named|PackageNotFoundError|No package metadata/i.test(String(r.stderr)) ? '沙箱模板未装 crawl4ai' : `沙箱内探测失败（${r.sandboxError?.kind || r.exitCode || 'unknown'}）`),
        hint: '把 crawl4ai 装进 agent.sandbox.template 指向的 E2B 模板（scripts/install-crawl4ai.sh 是宿主安装，不适用沙箱）',
      }
  putCapped(_probeCache, key, { at: now, result })
  return result
}

/**
 * 沙箱档运行一次 crawl4ai 抓取（上传脚本 → 请求文件 → python3 script.py < req.json → 单行 JSON 协议）。
 * @returns 与 runCrawl4ai 同形的结果
 */
export async function runCrawl4aiInSandbox(box, url, opts = {}) {
  const {
    script, timeoutMs = CRAWL4AI_TIMEOUTS.defaultMs, maxChars = 60000,
    waitFor = null, jsCode = null, jsBeforeWait = null, delayMs = null,
    cssSelector = null, extract = null, links = false, stealth = false,
    flatShadowDom = false, virtualScroll = null, undetected = false,
    proxy = null, waitUntil = null, headless = null, scanFullPage = false,
    maxScrollSteps = null, extraArgs = null, signal = null,
  } = opts
  if (waitFor && !/^(css:|js:)/.test(String(waitFor).trim())) {
    return { success: false, via: 'crawl4ai', code: 'invalid_request', error: 'waitFor 需以 css: 或 js: 开头' }
  }
  const scriptPath = script || CRAWL4AI_SCRIPT
  let src
  try { src = fs.readFileSync(scriptPath, 'utf8') } catch (e) {
    return { success: false, via: 'crawl4ai', code: 'spawn_failed', error: `沙箱抓取脚本不可读：${e?.message || e}` }
  }
  const req = buildCrawl4aiRequest({
    url, timeout: timeoutMs, maxChars, waitFor, jsCode, jsBeforeWait, delayMs,
    cssSelector, extract, links, stealth, undetected, proxy, waitUntil, headless,
    scanFullPage, maxScrollSteps, extraArgs, flatShadowDom, virtualScroll,
  })
  const dir = sandboxTmp('crawl')
  const sess = await openToolSession(box, { purpose: 'tool:web_crawl' })
  const hash = createHash('sha256').update(src).digest('hex')
  if (_scriptUploaded.get(sess.sandboxId) !== hash) {
    await sess.write({ path: SANDBOX_SCRIPT_REMOTE, data: src })
    putCapped(_scriptUploaded, sess.sandboxId, hash)
  }
  await sess.write({ path: `${dir}/req.json`, data: JSON.stringify(req) })
  // 沙箱命令为固定拼装；请求体走文件 stdin 重定向（与宿主档同一协议）
  const shellTimeoutSec = Math.min(Math.ceil(timeoutMs / 1000) + 60, box.maxTimeout)
  const r = await runToolCommand(box, sess, `python3 ${shellQuote(SANDBOX_SCRIPT_REMOTE)} < ${shellQuote(`${dir}/req.json`)}`, {
    timeoutMs: shellTimeoutSec * 1000,
    maxOutput: 32 * 1024,
    signal,
    label: 'web_crawl',
  })
  try { await runToolCommand(box, sess, `rm -rf ${shellQuote(dir)}`, { timeoutMs: 15000, maxOutput: 300, label: 'web_crawl:cleanup' }) } catch { /* noop */ }
  if (r.limited) return { success: false, via: 'crawl4ai', code: 'crawl_failed', error: r.error, sandbox: true }
  if (r.sandboxError || r.error) {
    return { success: false, via: 'crawl4ai', code: 'crashed', error: `沙箱执行失败（${r.sandboxError?.kind || 'unknown'}）：${String(r.stderr || '').slice(0, 200)}`, sandbox: true }
  }
  const out = mapCrawl4aiOutput(parseProtocolLine(r.stdout), { url, exitCode: r.exitCode, timedOut: r.timedOut === true, stderrTail: r.stderr })
  return { ...out, sandbox: true }
}

// importlib.metadata 拿发行版号（某些版本 crawl4ai.__version__ 是 module 而非字符串）
const PROBE_CODE = 'from importlib.metadata import version; print(version("crawl4ai"))'

let probeCache = { key: null, at: 0, result: null }

/** 清空可用性探测缓存（安装 crawl4ai 后 / 运行时重建时调用，立即重新探测）。 */
export function resetCrawl4aiProbe() { probeCache = { key: null, at: 0, result: null } }

/**
 * 可用性探测（带 TTL 缓存）：venv python -c "import crawl4ai" 是否成功。
 * 版本串仅诊断用；判活看退出码（垃圾版本串仍算可用——降级判定不该被输出格式绑架）。
 * 命中缓存 TTL：可用结果按 probeTtlMs（5min），不可用结果按 probeNegativeTtlMs（短，便于安装后尽快恢复）。
 * 结果对象含 python（实际探测的解释器路径）：装到别的插件副本目录时，日志能直接看出路径不符。
 */
export async function isCrawl4aiAvailable({ python = null, probeArg = null, ttl = null } = {}) {
  const py = python || venvPython()
  const key = `${py}|${JSON.stringify(probeArg)}`
  const now = Date.now()
  const ttlMs = ttl ?? CRAWL4AI_TIMEOUTS.probeTtlMs
  const cached = probeCache.result
  const effTtl = ttlMs <= 0 ? 0 : (cached?.ok ? ttlMs : Math.min(ttlMs, CRAWL4AI_TIMEOUTS.probeNegativeTtlMs))
  if (effTtl > 0 && probeCache.key === key && now - probeCache.at < effTtl && cached) return cached
  const result = await new Promise((resolve) => {
    let out = ''
    let settled = false
    let timer = null
    let proc
    try {
      proc = spawn(py, probeArg ?? ['-c', PROBE_CODE], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ ok: false, reason: 'spawn_failed', error: e?.message || String(e), python: py })
    }
    // 先挂监听再判断 pid：解释器缺失时 spawn 仍返回 ChildProcess（pid 为 undefined），
    // ENOENT/EACCES 经异步 'error' 事件上报——提前 return 会让它无监听器而打崩宿主。
    const settle = (r) => {
      if (settled) return false
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
      return true
    }
    proc.stdout?.on('data', (d) => { out += d })
    proc.stderr?.on('data', () => { /* 并发 drain：探测通常无 stderr，但不能让 pipe 满堵 */ })
    proc.on('error', (e) => settle({ ok: false, reason: 'spawn_failed', error: e?.message || String(e), python: py }))
    proc.on('exit', (code) => {
      if (!settle(code === 0
        ? { ok: true, version: (String(out).trim().split('\n').pop() || 'unknown').slice(0, 40), python: py }
        : { ok: false, reason: `exit=${code}`, hint: '未安装？跑 scripts/install-crawl4ai.sh', python: py })) return
    })
    if (proc.pid == null) return // 缺 pid：等待上面的 error 事件结算
    timer = setTimeout(() => {
      if (!settle({ ok: false, reason: 'probe_timeout', python: py })) return
      try { proc.kill('SIGKILL') } catch { /* 已退出 */ }
    }, CRAWL4AI_TIMEOUTS.probeRunMs)
  })
  probeCache = { key, at: now, result }
  return result
}
