/**
 * Stagehand 会话管理 —— per-scopeKey 持久单例 + idle 超时自动关。
 *
 * 设计：同一 scopeUserId（数据归属身份，与 session/recall 一致）复用同一 Stagehand 会话与页面，
 * 支持 goto→act→extract 多步任务（Stagehand 的核心价值）。
 *   - acquire(scopeKey)：命中 touch、未命中启动；并发同 key 用 in-flight Promise 去重（防重复启动）。
 *   - get(scopeKey)：仅返回已存在会话（不启动），供 observe/extract/act 用；无则返回 null（提示先 goto）。
 *   - idle 超时：每次 touch 重设定时器；触发 stagehand.close()+browser.close()+清 Map。
 *   - closeAll()：runtime 失效/进程退出时清场。
 */
import Log from '../../utils/Log.js'
import { launchBrowser, getStagehandClass } from './browser.js'

export class SessionManager {
  /**
   * @param {object} opt { cfg: agent.stagehand, buildModel: ()=>modelConfig|undefined }
   *   buildModel 决定传给 Stagehand.create 的 model 配置（{generate} 复用 provider 或 {modelName,apiKey} 原生）。
   *   launcher 可选注入（测试用），签名 (cfg)=>Promise<{browser,close}>；缺省用 browser.js。
   */
  constructor({ cfg = {}, buildModel, launcher } = {}) {
    this._cfg = cfg
    this._buildModel = typeof buildModel === 'function' ? buildModel : () => undefined
    this._launcher = launcher || null
    this._sessions = new Map() // scopeKey -> { stagehand, page, close, browser, timer, lastUsed }
    this._inflight = new Map() // scopeKey -> Promise<page>（并发去重）
  }

  /** 启动或复用会话，返回 { stagehand, page }。 */
  async acquire(scopeKey) {
    const existing = this._sessions.get(scopeKey)
    if (existing) {
      this._touch(scopeKey)
      return { stagehand: existing.stagehand, page: existing.page }
    }
    if (this._inflight.has(scopeKey)) return this._inflight.get(scopeKey)
    const p = (async () => {
      try {
        const entry = await this._launch(scopeKey)
        return { stagehand: entry.stagehand, page: entry.page }
      } finally {
        this._inflight.delete(scopeKey)
      }
    })()
    this._inflight.set(scopeKey, p)
    return p
  }

  /** 返回已存在会话 { stagehand, page }（touch），无则 null（不启动）。 */
  get(scopeKey) {
    const entry = this._sessions.get(scopeKey)
    if (!entry) return null
    this._touch(scopeKey)
    return { stagehand: entry.stagehand, page: entry.page }
  }

  async _launch(scopeKey) {
    let browser, close, stagehand
    if (this._launcher) {
      // 注入路径（测试用）：launcher 返回 { browser, close, stagehand, page }
      const injected = await this._launcher(this._cfg)
      browser = injected.browser
      close = injected.close
      stagehand = injected.stagehand
    } else {
      const Stagehand = await getStagehandClass()
      ;({ browser, close } = await launchBrowser(this._cfg))
      const model = this._buildModel()
      stagehand = await Stagehand.create({
        browser,
        ...(model ? { model } : {}),
        domSettleTimeoutMs: Number(this._cfg.domSettleTimeoutMs) || 3000,
      })
    }
    const page = await resolveFirstPage(browser)
    if (!page) {
      try { await stagehand.close() } catch { /* noop */ }
      try { await close() } catch { /* noop */ }
      throw new Error('Stagehand 启动后无可用页面')
    }
    const entry = { stagehand, page, close, browser, timer: null, lastUsed: Date.now() }
    this._sessions.set(scopeKey, entry)
    this._touch(scopeKey)
    Log.info(`[stagehand] 会话已启动 scope=${scopeKey}`)
    return entry
  }

  _touch(scopeKey) {
    const entry = this._sessions.get(scopeKey)
    if (!entry) return
    entry.lastUsed = Date.now()
    if (entry.timer) clearTimeout(entry.timer)
    const ms = Number(this._cfg.idleTimeoutMs) || 300000
    const t = setTimeout(() => { this._close(scopeKey, 'idle').catch(() => {}) }, ms)
    if (typeof t.unref === 'function') t.unref()
    entry.timer = t
  }

  async _close(scopeKey, reason) {
    const entry = this._sessions.get(scopeKey)
    if (!entry) return
    this._sessions.delete(scopeKey)
    if (entry.timer) clearTimeout(entry.timer)
    try { await entry.stagehand.close() } catch { /* noop */ }
    try { await entry.close() } catch { /* noop */ }
    Log.info(`[stagehand] 会话已关闭 scope=${scopeKey}(${reason})`)
  }

  async closeAll() {
    const keys = [...this._sessions.keys()]
    await Promise.all(keys.map((k) => this._close(k, 'shutdown')))
  }

  /** 测试/诊断用：当前会话数。 */
  size() { return this._sessions.size }
}

/** 从 browser 对象取首个 page（兼容 pages() 同步/异步）。 */
async function resolveFirstPage(browser) {
  try {
    const ctx = browser?.context
    if (!ctx) return null
    const pages = typeof ctx.pages === 'function' ? await ctx.pages() : (ctx.pages || [])
    return Array.isArray(pages) ? pages[0] : null
  } catch {
    return null
  }
}
