/**
 * Web 面板鉴权：主人私聊 #agents登录 → 发 token（24h，滑动续期）→ 前端 URL ?token= 转 localStorage → Authorization Bearer。
 *
 * 纯内存 Map（模块级单例，Yunzai 热重载不丢；进程重启需重新登录）。
 * 故意不依赖 getRuntime()/KV——apiKey 未配时用户仍能登录面板填配置（运行时恢复前置）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Config from '../../utils/Config.js'
import Log from '../../utils/Log.js'

const TTL_MS = 24 * 60 * 60 * 1000
const _tokens = new Map() // token -> { masterId, createdAt, expiresAt }

/** 签发 token（绑定 masterId） */
export function issueToken(masterId) {
  const token = crypto.randomBytes(24).toString('hex')
  const now = Date.now()
  _tokens.set(token, { masterId: String(masterId), createdAt: now, expiresAt: now + TTL_MS })
  return token
}

/**
 * 校验 token；命中且未过期则滑动续期 24h，返回 { masterId }；否则 null。
 * 除会话令牌外，也接受「控制台令牌」（启动时打印的固定地址用，见 ensureConsoleToken）——
 * 这让**还没有协议端**的首次部署也能直接打开面板填配置（此前只能先连 QQ 发 #agents登录）。
 */
export function verifyToken(token) {
  if (!token) return null
  const r = _tokens.get(token)
  if (r) {
    if (Date.now() > r.expiresAt) { _tokens.delete(token); return null }
    r.expiresAt = Date.now() + TTL_MS
    return r
  }
  const consoleRec = verifyConsoleToken(token)
  if (consoleRec) return { masterId: 'console', console: true, createdAt: consoleRec.createdAt, expiresAt: consoleRec.expiresAt }
  return null
}

// ───────────────────────── 控制台令牌（首次启动即可登录） ─────────────────────────

const CONSOLE_TTL_HOURS_DEFAULT = 24 * 30 // 30 天；每次使用滑动续期，过期后下次启动自动换新
const CONSOLE_REFRESH_MIN_MS = 10 * 60 * 1000 // 续期落盘节流（避免每个 API 请求都写文件）
const CONSOLE_DIR_NAME = 'web'
const CONSOLE_FILE = 'console-token.json'
let _lastConsoleRefresh = 0

/** 控制台令牌目录（data/web/），可用 opts.dir 覆盖（测试） */
export function consoleTokenDir(opts = {}) {
  return opts.dir || path.join(Config.path.data, CONSOLE_DIR_NAME)
}

/** 控制台令牌 TTL（毫秒）：agent.webApi.consoleTokenTtlHours，默认 30 天 */
export function consoleTokenTtlMs(cfg = null) {
  const c = cfg || Config.get().agent?.webApi || {}
  const h = Number(c.consoleTokenTtlHours)
  return Number.isFinite(h) && h > 0 ? Math.round(h * 60 * 60 * 1000) : CONSOLE_TTL_HOURS_DEFAULT * 60 * 60 * 1000
}

function readConsoleFile(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, CONSOLE_FILE), 'utf8')
    const rec = JSON.parse(raw)
    return rec && typeof rec.token === 'string' && rec.token.length >= 32 ? rec : null
  } catch { return null }
}

function writeConsoleFile(dir, rec) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, CONSOLE_FILE)
    fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 })
    try { fs.chmodSync(file, 0o600) } catch { /* Windows 无权限位，忽略 */ }
    return true
  } catch (e) {
    Log.warn('[web] 控制台令牌写入失败（不影响本次启动）', e?.message || e)
    return false
  }
}

/**
 * 取（必要时生成）控制台令牌。过期则换新并落盘。
 * @param {object} [opts] { dir, ttlMs, now }
 * @returns {{token:string, createdAt:number, expiresAt:number, ttlMs:number, regenerated:boolean}}
 */
export function ensureConsoleToken(opts = {}) {
  const dir = consoleTokenDir(opts)
  const now = Number(opts.now) || Date.now()
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : consoleTokenTtlMs()
  const old = readConsoleFile(dir)
  if (old && old.expiresAt > now) {
    return { token: old.token, createdAt: old.createdAt || now, expiresAt: old.expiresAt, ttlMs, regenerated: false }
  }
  const rec = { token: crypto.randomBytes(24).toString('hex'), createdAt: now, expiresAt: now + ttlMs, ttlHours: Math.round(ttlMs / 3.6e6) }
  writeConsoleFile(dir, rec)
  return { ...rec, ttlMs, regenerated: true }
}

/**
 * 校验控制台令牌；命中且未过期 → 滑动续期（落盘节流 10 分钟）。
 * @returns {object|null} 令牌记录
 */
export function verifyConsoleToken(token, opts = {}) {
  if (!token || token.length < 32) return null
  const dir = consoleTokenDir(opts)
  const now = Number(opts.now) || Date.now()
  const rec = readConsoleFile(dir)
  if (!rec || rec.token !== token) return null
  if (rec.expiresAt <= now) return null
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : consoleTokenTtlMs()
  if (now - _lastConsoleRefresh >= CONSOLE_REFRESH_MIN_MS) {
    _lastConsoleRefresh = now
    const next = { ...rec, expiresAt: now + ttlMs }
    writeConsoleFile(dir, next)
    return next
  }
  return rec
}

/** 吊销控制台令牌（下次启动重新生成；也用于泄露应急） */
export function revokeConsoleToken(opts = {}) {
  const dir = consoleTokenDir(opts)
  try { fs.unlinkSync(path.join(dir, CONSOLE_FILE)); return true } catch { return false }
}

/** 撤销（登出/泄露应急） */
export function revokeToken(token) {
  return _tokens.delete(token)
}

// ───────────────────────── 启动横幅：默认访问地址（带 token） ─────────────────────────

/**
 * 拼面板访问地址（纯函数）。
 * @param {object} p { token, port, localHost, lanHost, publicHost }
 * @returns {{local:string, lan:string, public:string}}
 */
export function formatConsoleUrls({ token, port, localHost = '127.0.0.1', lanHost = '', publicHost = '' }) {
  const q = `/?token=${token}`
  const at = (h) => `http://${h}:${port}${q}`
  return {
    local: at(localHost),
    lan: lanHost && lanHost !== localHost ? at(lanHost) : '',
    public: publicHost ? at(publicHost) : '',
  }
}

function publicHostOf(cfg) {
  const pu = String(cfg?.publicUrl || '').trim()
  if (!pu) return ''
  return pu.replace(/^https?:\/\//i, '').replace(/[\/:].*$/, '')
}

/**
 * 启动时输出带 token 的面板地址，并写一份到 data/web/console-url.txt。
 *
 * 解决「首次部署还没有协议端（QQ 未连）→ 发不了 #agents登录 → 进不去面板 → 配不了模型」的死锁：
 * 面板服务本身不依赖协议端与运行时，启动日志直接给出可用地址即可完成首次配置。
 *
 * @param {object} [opts]
 * @param {number} [opts.port]
 * @param {object} [opts.cfg] webApi 配置块（默认读 Config）
 * @param {string} [opts.dir] 令牌/地址文件目录（默认 data/web）
 * @param {string} [opts.publicHost] 指定公网 host（测试/不探测）
 * @param {()=>Promise<string|null>} [opts.detectPublic] 公网 IP 探测（默认内置）
 * @param {(line:string)=>void} [opts.logger] 日志输出（默认 Log.mark）
 * @returns {Promise<object|null>} 地址信息；未启用/关闭提示时返回 null
 */
export async function announceConsoleAccess(opts = {}) {
  const cfg = opts.cfg || Config.get().agent?.webApi || {}
  if (cfg.enable === false) return null
  if (cfg.printTokenOnStart === false) return null
  const port = Number(opts.port || cfg.port) || 6098
  const dir = consoleTokenDir(opts)
  const ttlMs = consoleTokenTtlMs(cfg)
  const rec = ensureConsoleToken({ dir, ttlMs })
  const log = typeof opts.logger === 'function' ? opts.logger : (line) => Log.mark(line)

  const loopback = localHost()
  const lanHost = detectLanIp()
  const knownPublic = opts.publicHost || publicHostOf(cfg)
  const first = formatConsoleUrls({ token: rec.token, port, localHost: loopback, lanHost, publicHost: knownPublic })

  const lines = [
    '[web] 面板默认访问地址（带 token，无需 #agents登录；协议端未配置时也能进面板配模型）',
    `[web]   本地  ${first.local}`,
    first.lan ? `[web]   内网  ${first.lan}` : '',
    first.public ? `[web]   公网  ${first.public}` : '',
    `[web]   令牌有效期 ${Math.round(ttlMs / 86400000)} 天（使用中自动续期，过期后下次启动换新）；地址副本：${path.join(dir, 'console-url.txt')}`,
    '[web]   不想在日志里显示？agent.webApi.printTokenOnStart=false',
  ].filter(Boolean)
  for (const line of lines) log(line)

  const writeUrls = (publicUrl) => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = path.join(dir, 'console-url.txt')
      const text = [
        '# agents-plugin Web 管理面板访问地址（含登录 token，勿泄露/勿提交到仓库）',
        '# 首次部署还没有协议端时也可用：面板服务不依赖 QQ 连接与模型运行时。',
        `本地: ${first.local}`,
        first.lan ? `内网: ${first.lan}` : '',
        publicUrl ? `公网: ${publicUrl}` : '',
        `生成时间: ${new Date(rec.createdAt).toLocaleString('zh-CN')}`,
        `令牌文件: ${path.join(dir, CONSOLE_FILE)}`,
        '',
      ].filter((l) => l !== '').join('\n') + '\n'
      fs.writeFileSync(file, text, { mode: 0o600 })
      try { fs.chmodSync(file, 0o600) } catch { /* Windows 无权限位 */ }
    } catch { /* 写地址副本失败不影响启动 */ }
  }
  writeUrls(first.public)

  // 公网地址：未配置 publicUrl 时异步探测（不阻塞启动，探测到再补一行）
  if (!knownPublic) {
    const probe = typeof opts.detectPublic === 'function' ? opts.detectPublic : detectPublicIp
    try {
      const pub = await probe()
      if (pub) {
        const url = formatConsoleUrls({ token: rec.token, port, localHost: loopback, lanHost, publicHost: pub }).public
        writeUrls(url)
        log(`[web]   公网  ${url}${cfg.publicUrl ? '' : '（自动探测出口 IP；端口未放行则用内网/本地地址）'}`)
        return { ...first, public: url, tokenFile: path.join(dir, CONSOLE_FILE), urlFile: path.join(dir, 'console-url.txt'), regenerated: rec.regenerated }
      }
    } catch { /* 无外网：只输出本地/内网 */ }
  }

  return { ...first, tokenFile: path.join(dir, CONSOLE_FILE), urlFile: path.join(dir, 'console-url.txt'), regenerated: rec.regenerated }
}

/** express 中间件：校验 Authorization: Bearer <token> 或 ?token=（仅登录直跳用） */
export async function authMiddleware(req, res, next) {
  const tok = (req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim() || String(req.query.token || '')
  const r = verifyToken(tok)
  if (!r) return res.status(401).json({ code: 4010, data: null, msg: '未认证或 token 已失效，请重新 #agents登录' })
  req.master = r.masterId
  return next()
}

/** 探测本机 LAN IP（跳过内环 / docker / br / veth 虚拟网卡） */
export function detectLanIp() {
  try {
    const nets = os.networkInterfaces()
    for (const [ifname, list] of Object.entries(nets)) {
      if (/^(docker|br-|veth|virbr)/.test(ifname)) continue
      for (const n of list || []) {
        if (n.family === 'IPv4' && !n.internal) return n.address
      }
    }
  } catch { /* noop */ }
  return '127.0.0.1'
}

/** 自动探测公网出口 IP（云服务器经 NAT，自不知公网 IP；调外部 API 获取）。10 分钟缓存。 */
let _publicIp = null
let _publicIpAt = 0
const PRIVATE_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/
async function detectPublicIp() {
  if (_publicIp && Date.now() - _publicIpAt < 600000) return _publicIp
  // 实测（2026-07，本机 Node fetch）：4.ipw.cn / api.ipify.org / ifconfig.me 均失败，
  // 改用成功率高的 ident.me / api.ip.sb（纯文本），ip-api.com/json 作 JSON 兜底（慢但稳）。
  const apis = [
    'https://ident.me',
    'https://api.ip.sb/ip',
    'http://ip-api.com/json',
    'https://api.ipify.org',
    'https://ifconfig.me/ip',
  ]
  for (const url of apis) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'curl/8' } })
      if (!r.ok) continue
      let ip = (await r.text()).trim()
      if (url.includes('ip-api.com')) { try { ip = JSON.parse(ip).query || '' } catch { ip = '' } }
      // 必须是合法公网 IPv4（排除私网/回环，防 API 返回内网代理地址）
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !PRIVATE_RE.test(ip)) {
        _publicIp = ip
        _publicIpAt = Date.now()
        return ip
      }
    } catch { /* 超时 / 无外网 → 试下一个 */ }
  }
  return null
}

/** 解析对外 host：publicUrl（用户配）> 自动探测公网 IP > 内网 IP 兜底 */
async function resolveHost(cfg) {
  const pu = cfg?.publicUrl || ''
  if (pu) {
    const h = pu.replace(/^https?:\/\//, '').replace(/[\/:].*$/, '')
    if (h) return h
  }
  const pub = await detectPublicIp()
  if (pub) return pub
  return detectLanIp()
}

/**
 * 本地访问地址（固定 127.0.0.1，不读任何配置）。
 * 服务端监听 0.0.0.0，天然覆盖本机回环；此地址用于同机/内网直连，避免域名走公网 NAT 回环不通。
 */
export function localHost() {
  return '127.0.0.1'
}

/** #agents登录 命令处理（permission:'master' 已挡权限；群聊提示去私聊） */
export async function handleAgentsLogin(e) {
  const cfg = Config.get().agent?.webApi || {}
  if (cfg.enable === false) { await e.reply('Web 面板未启用（config: agent.webApi.enable）'); return true }
  if (e.isGroup) { await e.reply('为安全，请在私聊对我发送 #agents登录'); return true }
  const port = Number(cfg.port) || 6098
  const host = await resolveHost(cfg)
  const token = issueToken(e.user_id)
  const publicUrl = `http://${host}:${port}/?token=${token}`
  const localUrl = `http://${localHost()}:${port}/?token=${token}`
  Log.mark(`[web] master ${e.user_id} 登录面板（公网 host=${host}，本地 ${localHost()}）`)
  // 公网/本地两个地址【分两条消息发送】，绝不合并（便于分别复制、避免长文本被适配器截断/换行错乱）
  await e.reply(`🌐 公网地址：\n${publicUrl}`)
  await e.reply(`💻 本地地址：\n${localUrl}`)
  return true
}
