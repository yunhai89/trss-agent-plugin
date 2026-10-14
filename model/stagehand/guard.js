/**
 * Stagehand 安全护栏 + 真机指纹 —— 供 browser.js（启动参数）与 index.js（导航前校验）共用。
 *
 * 两件事：
 *  1) 出口目标限制：仅允许 http/https，拒绝环回/私有/链路本地/元数据/保留地址（含域名解析结果、
 *     IPv4 混淆写法、IPv6 映射与主机名尾点），防止宿主浏览器被用来 SSRF 打内网
 *     （本地浏览器跑在插件宿主进程，不是 E2B 沙箱）。
 *  2) 真机化指纹：启动参数（UA/语言/视口/触屏/去自动化 flag）+ init script 规避脚本，
 *     降低被目标站点风控拦截的概率（只能降低，不能保证；绕过风控也可能违反站点 ToS）。
 *
 * SSRF 能力边界（不宣称完整防护）：
 *  - 入口 DNS/IP 校验只覆盖顶层导航的初始 URL；页面重定向、iframe、子资源、页面 fetch
 *    由 Stagehand DomainPolicy 在请求级按【域名】拦截（见 compileDomainPolicy）。
 *  - DomainPolicy 只接受域名 / IPv4 字面量规则，无法表达 IPv6、CIDR、单标签主机；
 *    这些只能靠入口校验兜底，且 DNS 重绑定（解析后再解析到内网）无法在此层根除。
 *  - 私有网段无法枚举成域名规则，因此"子资源访问私有 IP"不被 DomainPolicy 覆盖。
 */
import dns from 'node:dns/promises'
import net from 'node:net'

/** 元数据/本地主机名黑名单（DomainPolicy/域名级兜底） */
export const BLOCKED_HOSTS = [
  'localhost', 'localhost.localdomain',
  'metadata.google.internal', 'metadata.goog',
  '169.254.169.254', '169.254.170.2', '100.100.100.200', // 云元数据端点
]

/** DomainPolicy 规则格式约束（与 Stagehand SDK 一致：>=2 个标签、标签为 alnum/hyphen 且不首尾连字符） */
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const MAX_DOMAIN_LEN = 253

/** 去掉 IPv6 方括号、尾点，转小写。空串返回 ''。 */
export function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
}

function ipv4ToInt(ip) {
  const p = String(ip).split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
}

/** IPv4 是否属于不可出网地址段（环回/私有/链路本地/保留/多播/文档/CGNAT） */
function isPrivateV4Int(v) {
  if (v == null) return true
  const a = (v >>> 24) & 0xff
  const b = (v >>> 16) & 0xff
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && ((v >>> 8) & 0xff) === 0) return true // 192.0.0.0/24
  if (a === 192 && b === 0 && ((v >>> 8) & 0xff) === 2) return true // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && ((v >>> 8) & 0xff) === 99) return true // 192.88.99.0/24
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && ((v >>> 8) & 0xff) === 100) return true // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && ((v >>> 8) & 0xff) === 113) return true // 203.0.113.0/24 TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // 多播/保留
  return false
}

/** IPv6 → 16 字节数组；非法返回 null。展开 `::` 与 IPv4 结尾。 */
function ipv6ToBytes(ip) {
  let s = normalizeHost(ip)
  if (s.includes('%')) s = s.split('%')[0] // zone id
  if (!net.isIPv6(s)) return null
  const v4tail = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  let tail = []
  if (v4tail) {
    const vi = ipv4ToInt(v4tail[1])
    if (vi == null) return null
    tail = [(vi >>> 24) & 0xff, (vi >>> 16) & 0xff, (vi >>> 8) & 0xff, vi & 0xff]
    s = s.slice(0, v4tail.index) + '0:0'
  }
  const [headStr, tailStr] = s.includes('::') ? s.split('::') : [s, null]
  const head = headStr ? headStr.split(':').filter(Boolean) : []
  const tailHextets = tailStr != null ? (tailStr ? tailStr.split(':').filter(Boolean) : []) : null
  let hextets
  if (tailHextets != null) {
    const fill = 8 - head.length - tailHextets.length
    if (fill < 0) return null
    hextets = [...head, ...Array(fill).fill('0'), ...tailHextets]
  } else {
    hextets = head
  }
  if (hextets.length !== 8) return null
  const bytes = []
  for (const h of hextets) {
    const n = parseInt(h, 16)
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null
    bytes.push((n >> 8) & 0xff, n & 0xff)
  }
  if (tail.length) { for (let i = 0; i < 4; i++) bytes[12 + i] = tail[i] }
  return bytes.length === 16 ? bytes : null
}

/** IPv6 字节数组是否属于不可出网段（环回/未指定/ULA/link-local/多播/映射/NAT64/文档/6to4/discard） */
function isPrivateV6Bytes(b) {
  if (!b || b.length !== 16) return true
  const allZero = b.every((x) => x === 0)
  if (allZero) return true // ::
  const loopback = b.slice(0, 15).every((x) => x === 0) && b[15] === 1
  if (loopback) return true // ::1
  if ((b[0] & 0xfe) === 0xfc) return true // fc00::/7 ULA
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10 link-local
  if (b[0] === 0xff) return true // ff00::/8 多播
  // ::ffff:0:0/96 映射 IPv4
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isPrivateV4Int(((b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15]) >>> 0)
  }
  // 64:ff9b::/96 NAT64
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return isPrivateV4Int(((b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15]) >>> 0)
  }
  // 2001:db8::/32 文档
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true
  // 2002::/16 6to4（内嵌 IPv4 可能为私网）
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateV4Int(((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0)
  // 100::/64 discard
  if (b.slice(0, 8).every((x) => x === 0) && b[8] === 0x01 && b.slice(9).every((x) => x === 0)) return true
  return false
}

/** IPv4/IPv6 是否属于不可出网的地址段。非 IP 一律当作不可信（true）。 */
export function isPrivateIp(ip) {
  const s = normalizeHost(ip)
  if (!s) return true
  if (net.isIPv4(s)) return isPrivateV4Int(ipv4ToInt(s))
  const v6 = ipv6ToBytes(s)
  if (v6) return isPrivateV6Bytes(v6)
  return true
}

/**
 * 把宽松的 IPv4 写法（整数 / 十六进制 / 八进制 / 少段）解析为标准点分十进制。
 * 例如 2130706433 / 0x7f000001 / 127.1 / 0177.0.0.1 → 127.0.0.1。非 IPv4 写法返回 null。
 */
export function parseLooseIPv4(host) {
  const h = String(host || '').trim()
  if (!h || /[^0-9a-fxX.]/i.test(h)) return null
  const parts = h.split('.')
  if (parts.length < 1 || parts.length > 4) return null
  const nums = []
  for (const p of parts) {
    if (!p) return null
    let n
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16)
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8)
    else if (/^\d+$/.test(p)) n = parseInt(p, 10)
    else return null
    if (!Number.isFinite(n) || n < 0) return null
    nums.push(n)
  }
  let v
  if (nums.length === 1) v = nums[0]
  else if (nums.length === 2) { if (nums[0] > 0xff || nums[1] > 0xffffff) return null; v = nums[0] * 0x1000000 + nums[1] }
  else if (nums.length === 3) { if (nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return null; v = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2] }
  else { if (nums.some((n) => n > 0xff)) return null; v = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2] * 0x100 + nums[3] }
  if (v > 0xffffffff) return null
  return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`
}

/** 主机名是否为本地/元数据黑名单（含子域；忽略尾点与大小写） */
export function hostIsBlocked(host, extra = []) {
  const h = normalizeHost(host)
  if (!h) return true
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true
  return [...BLOCKED_HOSTS, ...extra].some((b) => {
    const norm = normalizeHost(b)
    if (!norm) return false
    return h === norm || h.endsWith(`.${norm}`)
  })
}

function withTimeout(promise, ms, onTimeout) {
  if (!ms || ms <= 0) return promise
  return new Promise((resolve, reject) => {
    let done = false
    const t = setTimeout(() => { done = true; reject(new Error(onTimeout || `超时（${ms}ms）`)) }, ms)
    if (typeof t.unref === 'function') t.unref()
    Promise.resolve(promise).then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v) } },
      (e) => { if (!done) { done = true; clearTimeout(t); reject(e) } },
    )
  })
}

/**
 * 导航前校验：协议 + 主机黑名单 + IP/域名解析结果不得为内网。
 * @param {string} rawUrl
 * @param {object} [opts] { blockedHosts, lookup, timeoutMs, signal }
 * @returns {Promise<{ ok:boolean, url?:string, reason?:string }>}
 */
export async function assertUrlAllowed(rawUrl, { blockedHosts = [], lookup = dns.lookup, timeoutMs = 5000, signal = null } = {}) {
  let u
  try { u = new URL(String(rawUrl || '')) } catch { return { ok: false, reason: 'URL 非法' } }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: '仅允许 http/https 协议' }
  if (signal?.aborted) return { ok: false, reason: '已取消' }
  const host = normalizeHost(u.hostname)
  if (!host) return { ok: false, reason: 'URL 缺少主机名' }
  if (hostIsBlocked(host, blockedHosts)) return { ok: false, reason: `禁止访问本地/内网/元数据主机：${host}` }
  // IP 字面量（含混淆写法）：直接判定，不做 DNS
  const loose = parseLooseIPv4(host)
  if (net.isIPv4(host) || loose) {
    const ip = net.isIPv4(host) ? host : loose
    if (isPrivateIp(ip)) return { ok: false, reason: `禁止访问内网 IP：${ip}` }
    return { ok: true, url: u.href }
  }
  if (net.isIPv6(host)) {
    if (isPrivateIp(host)) return { ok: false, reason: `禁止访问内网 IPv6：${host}` }
    return { ok: true, url: u.href }
  }
  let addrs
  try {
    addrs = await withTimeout(lookup(host, { all: true }), timeoutMs, `域名解析超时：${host}`)
  } catch (e) {
    if (signal?.aborted) return { ok: false, reason: '已取消' }
    return { ok: false, reason: `域名解析失败：${host}（${e?.message || e}）` }
  }
  if (signal?.aborted) return { ok: false, reason: '已取消' }
  const list = (Array.isArray(addrs) ? addrs : [addrs]).filter(Boolean)
  if (!list.length) return { ok: false, reason: `域名无解析结果：${host}` }
  if (list.some((a) => isPrivateIp(a?.address))) return { ok: false, reason: `域名解析到内网地址：${host}` }
  return { ok: true, url: u.href }
}

/**
 * 把禁访主机名单编译成 Stagehand DomainPolicy 支持的规则。
 * SDK 只接受「域名（>=2 标签）或 IPv4 字面量」的精确/`*.` 通配规则；
 * IPv6、CIDR、单标签主机无法表达 → 归入 unrepresentable（由入口校验兜底，调用方可告警）。
 * 精确域名会同时补 `*.domain` 以覆盖子域（SDK 通配不匹配裸域）。
 * @returns {{ blockedDomains: string[], unrepresentable: string[] }}
 */
export function compileDomainPolicy(blockedHosts = BLOCKED_HOSTS) {
  const blockedDomains = new Set()
  const unrepresentable = []
  for (const raw of blockedHosts) {
    let h = normalizeHost(raw)
    if (!h) continue
    if (h.includes('://') || h.includes('/')) { // 允许误填 URL：取 hostname
      try { h = normalizeHost(new URL(String(raw)).hostname) } catch { unrepresentable.push(String(raw)); continue }
    }
    const isV4 = net.isIPv4(h)
    const labels = h.split('.')
    const validDomain = !isV4 && labels.length >= 2 && labels.length <= 127 && h.length <= MAX_DOMAIN_LEN && labels.every((l) => DOMAIN_LABEL_RE.test(l))
    if (isV4) {
      blockedDomains.add(h)
    } else if (validDomain) {
      blockedDomains.add(h)
      blockedDomains.add(`*.${h}`)
    } else {
      unrepresentable.push(String(raw))
    }
  }
  return { blockedDomains: [...blockedDomains], unrepresentable }
}

/** 真实设备指纹池（UA 与 platform/视口/dsf/触屏保持一致；按 Chromium 版本对齐） */
export const DEVICE_PROFILES = [
  {
    name: 'win-chrome', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Win32', viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, hasTouch: false, locale: 'zh-CN', mobile: false,
  },
  {
    name: 'win-chrome-hd', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Win32', viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, hasTouch: false, locale: 'zh-CN', mobile: false,
  },
  {
    name: 'mac-chrome', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'MacIntel', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, hasTouch: false, locale: 'zh-CN', mobile: false,
  },
  {
    name: 'android-chrome', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l', viewport: { width: 393, height: 851 }, deviceScaleFactor: 2.75, hasTouch: true, locale: 'zh-CN', mobile: true,
  },
]

export function pickDeviceProfile(rand = Math.random, cfg = {}) {
  if (cfg.userAgent) {
    const base = DEVICE_PROFILES[0]
    return { ...base, name: 'custom', ...(cfg.mobile === true ? { hasTouch: true, mobile: true } : {}), ua: String(cfg.userAgent) }
  }
  const idx = Math.min(DEVICE_PROFILES.length - 1, Math.floor(rand() * DEVICE_PROFILES.length))
  return DEVICE_PROFILES[idx]
}

/**
 * 真机化启动参数。stealth=false 时退回最小配置（仅 headless/chromiumSandbox/executablePath）。
 * @returns {object} LocalBrowserLaunchOptions
 */
export function buildLaunchOptions(cfg = {}, profile) {
  const opts = {
    headless: cfg.headless !== false,
    chromiumSandbox: false, // 服务器通常无 sandbox 权限
  }
  if (cfg.executablePath) opts.executablePath = String(cfg.executablePath)
  // 代理：浏览器访问受限站点（被墙/需代理）时与搜索/抓取一致走 agent.proxy 或环境变量代理
  if (cfg.proxy) {
    try {
      const u = new URL(String(cfg.proxy))
      opts.proxy = { server: `${u.protocol}//${u.host}` }
      if (u.username) opts.proxy.username = decodeURIComponent(u.username)
      if (u.password) opts.proxy.password = decodeURIComponent(u.password)
    } catch {
      opts.proxy = { server: String(cfg.proxy) }
    }
  }
  if (cfg.stealth === false) return opts
  opts.ignoreDefaultArgs = ['--enable-automation', '--disable-extensions']
  opts.locale = profile.locale || 'zh-CN'
  opts.viewport = profile.viewport
  opts.deviceScaleFactor = profile.deviceScaleFactor
  opts.hasTouch = !!profile.hasTouch
  opts.args = [
    '--disable-blink-features=AutomationControlled',
    '--exclude-switches=enable-automation',
    '--disable-infobars',
    '--no-first-run',
    '--no-default-browser-check',
    `--lang=${profile.locale || 'zh-CN'}`,
    `--user-agent=${profile.ua}`,
    `--window-size=${profile.viewport.width},${profile.viewport.height}`,
  ]
  return opts
}

/** 注入到每个页面的规避脚本（抹自动化痕迹、补齐常被风控读取的指纹字段） */
export function buildStealthInitScript(profile) {
  const platform = profile.platform || 'Win32'
  const languages = [profile.locale || 'zh-CN', 'zh', 'en']
  return `(() => {
  const def = (obj, prop, value) => { try { Object.defineProperty(obj, prop, { get: () => value, configurable: true }) } catch (e) {} };
  def(navigator, 'webdriver', undefined);
  def(navigator, 'platform', ${JSON.stringify(platform)});
  def(navigator, 'languages', ${JSON.stringify(languages)});
  def(navigator, 'hardwareConcurrency', 8);
  def(navigator, 'deviceMemory', 8);
  if (!window.chrome) { window.chrome = {} }
  if (!window.chrome.runtime) { window.chrome.runtime = {} }
  def(navigator, 'plugins', [1, 2, 3, 4, 5]);
  try {
    const origQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (origQuery) {
      window.navigator.permissions.query = (p) => (p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery.call(window.navigator.permissions, p));
    }
  } catch (e) {}
  try {
    const patchGL = (proto) => {
      const gp = proto.getParameter.bind(proto);
      proto.getParameter = function (p) {
        if (p === 37445) return 'Intel Inc.';      // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
        return gp(p);
      };
    };
    if (window.WebGLRenderingContext) patchGL(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patchGL(WebGL2RenderingContext.prototype);
  } catch (e) {}
})();`
}
