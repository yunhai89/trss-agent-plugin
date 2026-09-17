/**
 * Stagehand 安全护栏 + 真机指纹 —— 供 browser.js（启动参数）与 index.js（导航前校验）共用。
 *
 * 两件事：
 *  1) 出口目标限制：仅允许 http/https，拒绝环回/私有/链路本地/元数据等地址（含域名解析结果），
 *     防止宿主浏览器被用来 SSRF 打内网（本地浏览器跑在插件宿主进程，不是 E2B 沙箱）。
 *  2) 真机化指纹：启动参数（UA/语言/视口/触屏/去自动化 flag）+ init script 规避脚本，
 *     降低被目标站点风控拦截的概率（只能降低，不能保证；绕过风控也可能违反站点 ToS）。
 */
import dns from 'node:dns/promises'
import net from 'node:net'

/** 元数据/本地主机名黑名单（DomainPolicy/域名级兜底） */
export const BLOCKED_HOSTS = [
  'localhost', 'localhost.localdomain',
  'metadata.google.internal', 'metadata.goog',
  '169.254.169.254', '169.254.170.2', '100.100.100.200', // 云元数据端点
]

/** IPv4/IPv6 是否属于不可出网的地址段（环回/私有/链路本地/保留/多播） */
export function isPrivateIp(ip) {
  const s = String(ip || '').trim().toLowerCase()
  if (!s) return true
  if (net.isIPv4(s)) {
    const [a, b] = s.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true // link-local（含云元数据）
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
    if (a >= 224) return true // 多播/保留
    return false
  }
  if (net.isIPv6(s)) {
    if (s === '::1' || s === '::') return true
    if (s.startsWith('fe80')) return true // link-local
    if (/^f[cd]/.test(s)) return true // unique local fc00::/7
    if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7)) // v4-mapped
    return false
  }
  return true // 非 IP 一律当作不可信
}

/** 主机名是否为本地/元数据黑名单（含子域） */
export function hostIsBlocked(host, extra = []) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true
  return [...BLOCKED_HOSTS, ...extra].some((b) => {
    const norm = String(b).toLowerCase().replace(/^\[|\]$/g, '')
    return h === norm || h.endsWith(`.${norm}`)
  })
}

/**
 * 导航前校验：协议 + 主机黑名单 + IP/域名解析结果不得为内网。
 * @returns {{ ok:boolean, url?:string, reason?:string }}
 */
export async function assertUrlAllowed(rawUrl, { blockedHosts = [], lookup = dns.lookup } = {}) {
  let u
  try { u = new URL(String(rawUrl || '')) } catch { return { ok: false, reason: 'URL 非法' } }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: '仅允许 http/https 协议' }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostIsBlocked(host, blockedHosts)) return { ok: false, reason: `禁止访问本地/内网/元数据主机：${host}` }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) return { ok: false, reason: `禁止访问内网 IP：${host}` }
    return { ok: true, url: u.href }
  }
  let addrs
  try { addrs = await lookup(host, { all: true }) } catch { return { ok: false, reason: `域名解析失败：${host}` } }
  const list = Array.isArray(addrs) ? addrs : [addrs]
  if (list.some((a) => isPrivateIp(a?.address))) return { ok: false, reason: `域名解析到内网地址：${host}` }
  return { ok: true, url: u.href }
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
