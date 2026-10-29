/**
 * QQ 官方机器人 access_token 管理（AppID + AppSecret，无需机器人 QQ 号 / 旧版 Token）。
 *
 * 官方端点：POST https://bots.qq.com/app/getAppAccessToken
 *   body { appId, clientSecret } → { access_token, expires_in }
 * 注意：旧版适配器把「机器人 QQ 号 / AppID / Token / AppSecret」四段拼在连接串里，
 * 那是 QQ 频道 v1 时代 Authorization 需要 `Bot {appid}.{token}` 的遗留；现行开放平台鉴权只认
 * AppID + AppSecret 换 access_token，本模块即按现行方案实现。
 *
 * 特性：按 appId 缓存、并发单飞（同一 appId 只发一次请求）、提前刷新（默认过期前 5 分钟）、
 * 失败重试由调用方（gateway 重连）兜底。纯依赖注入，可离线测试。
 */

/**
 * 官方 token 端点。2026 官方文档（api-call-guide）已迁到 api.bot.qq.com；
 * 旧文档/SDK 仍用 bots.qq.com，两者都用同一接口 → 主用新域名，失败自动回退旧域名。
 */
export const TOKEN_URLS = [
  'https://api.bot.qq.com/app/getAppAccessToken',
  'https://bots.qq.com/app/getAppAccessToken',
]
/** 主端点（兼容旧引用/测试） */
export const TOKEN_URL = TOKEN_URLS[0]
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_REFRESH_AHEAD_MS = 5 * 60 * 1000

/**
 * @typedef {object} TokenManagerOptions
 * @property {string} [tokenUrl] 覆盖默认端点
 * @property {typeof fetch} [fetchImpl] 注入 fetch（测试用）
 * @property {(level:string, ...args:any[])=>void} [logger] 日志
 * @property {number} [timeoutMs] 单次请求超时
 * @property {number} [refreshAheadMs] 提前刷新窗口
 */

export class TokenManager {
  /** @param {TokenManagerOptions} [opts] */
  constructor({ tokenUrl = '', tokenUrls = TOKEN_URLS, fetchImpl = null, logger = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, refreshAheadMs = DEFAULT_REFRESH_AHEAD_MS } = {}) {
    // tokenUrl 显式指定时只用它；否则按 tokenUrls 依次回退（新域名优先）
    this.tokenUrls = tokenUrl ? [tokenUrl] : (Array.isArray(tokenUrls) && tokenUrls.length ? tokenUrls : TOKEN_URLS)
    this._goodUrl = ''
    this.tokenUrl = this.tokenUrls[0]
    this.fetchImpl = fetchImpl
    this.logger = logger
    this.timeoutMs = timeoutMs
    this.refreshAheadMs = refreshAheadMs
    /** @type {Map<string, {token:string, expiresAt:number}>} */
    this.cache = new Map()
    /** @type {Map<string, Promise<string>>} */
    this.pending = new Map()
  }

  _fetch() {
    const f = this.fetchImpl || globalThis.fetch
    if (typeof f !== 'function') throw new Error('当前环境没有 fetch，无法获取 QQ Bot access_token（请升级 Node >= 18）')
    return f
  }

  /**
   * 取 access_token（命中缓存直接返回；并发调用复用同一请求）。
   * @param {string} appId
   * @param {string} clientSecret
   * @returns {Promise<string>}
   */
  async getAccessToken(appId, clientSecret) {
    const id = String(appId || '').trim()
    const secret = String(clientSecret || '').trim()
    if (!id) throw new Error('缺少 appId')
    if (!secret) throw new Error('缺少 appSecret')

    const cached = this.cache.get(id)
    if (cached) {
      const remain = cached.expiresAt - Date.now()
      const ahead = Math.min(this.refreshAheadMs, Math.max(0, remain / 3))
      if (remain > ahead) return cached.token
    }
    const inflight = this.pending.get(id)
    if (inflight) return inflight

    const task = this._request(id, secret).finally(() => this.pending.delete(id))
    this.pending.set(id, task)
    return task
  }

  async _request(appId, clientSecret) {
    const urls = this._goodUrl ? [this._goodUrl, ...this.tokenUrls.filter((u) => u !== this._goodUrl)] : [...this.tokenUrls]
    let lastErr = null
    for (const url of urls) {
      try {
        return await this._requestAt(url, appId, clientSecret)
      } catch (e) {
        lastErr = e
        this.logger('debug', '[qqbot:token] 端点失败，尝试下一个', url, e?.message || e)
      }
    }
    throw lastErr || new Error('获取 access_token 失败：无可用端点')
  }

  async _requestAt(url, appId, clientSecret) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res
    try {
      this.logger('debug', '[qqbot:token] POST', url, `appId=${appId}`)
      res = await this._fetch()(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret }),
        signal: controller.signal,
      })
    } catch (e) {
      const name = e?.name === 'AbortError' ? '请求超时' : (e?.message || String(e))
      throw new Error(`获取 access_token 失败（网络）：${name}`)
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text().catch(() => '')
    if (!res.ok) {
      // 401/403 常见于 AppSecret 错误；429 频控；5xx 平台抖动
      const hint = res.status === 401 || res.status === 403
        ? 'AppID/AppSecret 不匹配或无权限，请到 QQ 开放平台核对'
        : res.status === 429 ? '请求过于频繁（频控），稍后重试' : '开放平台暂时异常，稍后重试'
      throw new Error(`获取 access_token 失败（HTTP ${res.status}）：${hint}${text ? ` · ${text.slice(0, 160)}` : ''}`)
    }
    let data
    try { data = JSON.parse(text) } catch { throw new Error(`获取 access_token 失败：响应不是 JSON（${text.slice(0, 120)}）`) }
    if (!data?.access_token) {
      const code = data?.code ?? data?.err_code
      const msg = data?.message ?? data?.msg ?? text.slice(0, 160)
      throw new Error(`获取 access_token 失败：${code ? `[${code}] ` : ''}${msg || '响应缺少 access_token'}`)
    }
    const ttl = Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : 7200 * 1000
    this._goodUrl = url
    this.cache.set(appId, { token: data.access_token, expiresAt: Date.now() + ttl })
    this.logger('debug', '[qqbot:token] ok', `appId=${appId}`, `ttl=${Math.round(ttl / 1000)}s`)
    return data.access_token
  }

  /** 清缓存（强制下次重新取） */
  clearCache(appId) {
    if (appId) this.cache.delete(String(appId).trim())
    else this.cache.clear()
  }

  /** 状态（诊断用） */
  status(appId) {
    const cached = this.cache.get(String(appId || '').trim())
    if (!cached) return { state: 'none', expiresAt: null, fetching: this.pending.has(String(appId || '').trim()) }
    const remain = cached.expiresAt - Date.now()
    const ahead = Math.min(this.refreshAheadMs, Math.max(0, remain / 3))
    return { state: remain > ahead ? 'valid' : 'stale', expiresAt: cached.expiresAt, remainMs: remain, fetching: this.pending.has(String(appId || '').trim()) }
  }
}

export default TokenManager
