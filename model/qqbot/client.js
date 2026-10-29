/**
 * QQ 官方机器人客户端（AppID + AppSecret）——协议层门面。
 *
 * 组合 token（AppID+AppSecret 换 access_token）→ api（REST）→ gateway（WebSocket）：
 *  - start()/stop()/status() 生命周期
 *  - 事件：message / interaction / ready / error / state
 *  - send(scene, targetId, segments, { msgId })：把 Yunzai 消息段拆成官方消息发送，
 *    markdown 无权限时自动降级文本；图片等富媒体自动上传后以 msg_type=7 发送
 *
 * 与框架无关（不 import Yunzai），可离线测试（注入 fetch / WebSocket）。
 */

import { TokenManager } from './token.js'
import { QQBotApi, MSG_TYPE, explainError } from './api.js'
import { QQBotGateway, DEFAULT_INTENTS } from './gateway.js'
import { normalizeEvent } from './events.js'
import { buildMessageJobs, splitText, MAX_MARKDOWN_CHARS } from './payload.js'

/** markdown 不被允许时平台返回的错误码（命中则自动转纯文本并记忆） */
const MARKDOWN_UNSUPPORTED = new Set(['304036', '40034010', '40034008', '40034009', '40054005'])

/** 读取本地文件为 base64（仅在需要上传本地图片时用；失败返回 null） */
async function fileToBase64(path) {
  try {
    const fs = await import('node:fs/promises')
    const buf = await fs.readFile(path)
    return buf.toString('base64')
  } catch {
    return null
  }
}

/** 从 markdown 里剥掉语法，作为降级纯文本 */
export function markdownToPlain(text) {
  let s = String(text ?? '')
  if (!s) return ''
  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => code.trim())
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/!\[[^\]]*\]\(([^)]+)\)/g, '$1')
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => (t && t !== u ? `${t}（${u}）` : u))
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  s = s.replace(/^\s*>\s?/gm, '')
  s = s.replace(/^\s*[-*+]\s+/gm, '· ')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2').replace(/~~([^~]+)~~/g, '$1')
  return s.trim()
}

export class QQBotClient {
  /**
   * @param {object} opts
   * @param {string} opts.appId
   * @param {string} opts.appSecret
   * @param {string} [opts.name] 展示名（日志/多账号）
   * @param {boolean} [opts.sandbox] 沙箱环境（api 域名带 sandbox.）
   * @param {string} [opts.apiBase] 覆盖 API 基址
   * @param {string} [opts.tokenUrl] 覆盖 token 端点
   * @param {number} [opts.intents]
   * @param {'auto'|true|false} [opts.markdown] markdown 能力：auto=先试再记忆
   * @param {boolean} [opts.preferMarkdownText] 纯文本也走 markdown（默认 false）
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {Function} [opts.WebSocketImpl]
   * @param {(level:string, ...args:any[])=>void} [opts.logger]
   * @param {number} [opts.maxReconnectAttempts]
   */
  constructor({
    appId, appSecret, name = '', sandbox = false, apiBase = '', tokenUrl = '', intents = DEFAULT_INTENTS,
    markdown = 'auto', preferMarkdownText = false, fetchImpl = null, WebSocketImpl = null,
    logger = () => {}, maxReconnectAttempts = 30,
  } = {}) {
    this.appId = String(appId || '').trim()
    this.appSecret = String(appSecret || '').trim()
    this.name = name || this.appId
    this.logger = logger
    this.markdownMode = markdown === false ? false : (markdown === true ? true : 'auto')
    this.markdownUsable = markdown === false ? false : true
    this.preferMarkdownText = preferMarkdownText === true
    this._handlers = new Map()

    const base = String(apiBase || '').trim()
      || (sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com')
    this.tokenManager = new TokenManager({ tokenUrl: tokenUrl || undefined, fetchImpl, logger })
    this.api = new QQBotApi({ tokenManager: this.tokenManager, baseUrl: base, fetchImpl, logger })
    this.gateway = new QQBotGateway({
      appId: this.appId,
      appSecret: this.appSecret,
      getToken: () => this.tokenManager.getAccessToken(this.appId, this.appSecret),
      getGatewayUrl: async () => {
        const url = await this.api.getGatewayUrl(this.creds())
        return url
      },
      intents,
      WebSocketImpl,
      logger,
      onDispatch: ({ t, d, s }) => this._dispatch(t, d, s),
      onState: (info) => this._emit('state', info),
      maxReconnectAttempts,
    })
  }

  creds() { return { appId: this.appId, appSecret: this.appSecret } }

  /** 事件订阅：message / interaction / ready / error / state */
  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set())
    this._handlers.get(event).add(fn)
    return () => this.off(event, fn)
  }

  off(event, fn) {
    this._handlers.get(event)?.delete(fn)
  }

  _emit(event, payload) {
    for (const fn of this._handlers.get(event) || []) {
      try { fn(payload) } catch (e) { this.logger('warn', `[qqbot:client] ${event} 回调异常`, e?.message || e) }
    }
  }

  status() {
    return {
      appId: this.appId,
      name: this.name,
      ...this.gateway.status(),
      token: this.tokenManager.status(this.appId),
      markdownUsable: this.markdownUsable,
    }
  }

  async start() {
    if (!this.appId || !this.appSecret) throw new Error('QQ 官方机器人需要 appId 与 appSecret（AppID + AppSecret 即可，无需机器人 QQ 号/Token）')
    this.logger('info', '[qqbot:client] 启动', `appId=${this.appId}`, `name=${this.name}`)
    // 先取一次 token：失败时直接抛出（配置错误不该静默重连几十次）
    await this.tokenManager.getAccessToken(this.appId, this.appSecret)
    await this.gateway.start()
  }

  stop() {
    this.gateway.stop()
    this.logger('info', '[qqbot:client] 已停止', `appId=${this.appId}`)
  }

  _dispatch(t, d, s) {
    try {
      const ev = normalizeEvent(t, d, { appId: this.appId })
      if (!ev) return
      if (ev.type === 'message') this._emit('message', ev)
      else if (ev.type === 'interaction') {
        // 先应答交互（否则平台会重推），再把按钮文本当用户消息分发
        this.api.acknowledgeInteraction(this.creds(), ev.interactionId).catch((e) => {
          this.logger('debug', '[qqbot:client] 交互应答失败（忽略）', e?.message || e)
        })
        this._emit('interaction', ev)
      }
    } catch (e) {
      this.logger('error', '[qqbot:client] 事件处理异常', t, e?.message || e)
    }
  }

  /**
   * 发送消息（兼容 e.reply 返回值结构：{ message_id:[], data:[], error:[] }）。
   * @param {'group'|'c2c'|'guild'|'guild_dm'} scene
   * @param {string} targetId group_openid / user_openid / channel_id / guild_id
   * @param {Array|string} segments Yunzai 消息段
   * @param {object} [opts] { msgId, ownerId, templateId }
   * @returns {Promise<{message_id:string[], data:any[], error:any[]}>}
   */
  async send(scene, targetId, segments, { msgId = '', ownerId = '', templateId = '' } = {}) {
    const rets = { message_id: [], data: [], error: [] }
    if (!targetId) {
      rets.error.push(new Error('缺少目标 openid'))
      return rets
    }
    const jobs = buildMessageJobs(segments, {
      msgId,
      ownerId,
      templateId,
      preferMarkdown: this.preferMarkdownText && this.markdownUsable,
    })
    if (!jobs.length) {
      rets.error.push(new Error('消息内容为空'))
      return rets
    }
    for (const job of jobs) {
      try {
        if (job.kind === 'media') {
          const r = await this._sendMedia(scene, targetId, job)
          if (r) rets.message_id.push(String(r?.id || r?.message_id || 'ok'))
          if (r) rets.data.push(r)
          continue
        }
        let result
        try {
          result = await this.api.sendMessage(this.creds(), scene, targetId, job.payload, { msgId: job.msgId })
        } catch (e) {
          // markdown 不被允许 → 自动降级纯文本（并记住该账号不可用 markdown）
          if (job.kind === 'markdown' && this._isMarkdownBlocked(e)) {
            const plain = markdownToPlain(job.payload?.markdown?.content || '')
            if (plain) {
              this.logger('warn', '[qqbot:client] Markdown 不可用，降级纯文本', e?.message || e)
              result = await this.api.sendMessage(this.creds(), scene, targetId, { content: plain, keyboard: job.payload?.keyboard }, { msgId: job.msgId })
            } else throw e
          } else throw e
        }
        const id = String(result?.id || result?.message_id || '')
        if (id) rets.message_id.push(id)
        rets.data.push(result || {})
      } catch (e) {
        this.logger('warn', '[qqbot:client] 发送失败', `${job.kind} → ${scene}`, e?.message || e)
        rets.error.push(e)
      }
    }
    return rets
  }

  _isMarkdownBlocked(err) {
    const code = String(err?.code ?? '')
    const msg = String(err?.message || '')
    const hit = MARKDOWN_UNSUPPORTED.has(code) || (code === '' && /markdown|304036/i.test(msg))
    if (hit && this.markdownMode === 'auto') {
      if (this.markdownUsable) this.logger('warn', '[qqbot:client] 该机器人没有 Markdown 权限，后续自动改用纯文本（到 QQ 开放平台可申请开通）')
      this.markdownUsable = false
    }
    return hit || this.markdownUsable === false
  }

  /** 富媒体：上传 → 发送 msg_type=7 */
  async _sendMedia(scene, targetId, job) {
    const source = job.source || {}
    let body
    if (source.url) body = { fileType: job.fileType, url: source.url }
    else if (source.base64) body = { fileType: job.fileType, base64: source.base64 }
    else if (source.path) {
      const b64 = await fileToBase64(source.path)
      if (!b64) {
        // 本地文件读不到：降级为文本提示，不让整条回复失败
        this.logger('warn', '[qqbot:client] 本地媒体读取失败，跳过', source.path)
        return null
      }
      body = { fileType: job.fileType, base64: b64 }
    } else return null

    const up = await this.api.uploadMedia(this.creds(), scene, targetId, body)
    const fileInfo = up?.file_info
    if (!fileInfo) {
      this.logger('warn', '[qqbot:client] 富媒体上传未返回 file_info', JSON.stringify(up || {}).slice(0, 200))
      return null
    }
    return this.api.sendMessage(this.creds(), scene, targetId, { media: { file_info: fileInfo } }, { msgId: job.msgId })
  }

  /** 撤回 */
  async recall(scene, targetId, messageId) {
    return this.api.recallMessage(this.creds(), scene, targetId, messageId)
  }

  /** 主动消息（无 msg_id） */
  async sendProactive(scene, targetId, textOrSegments) {
    return this.send(scene, targetId, textOrSegments, { msgId: '' })
  }

  /** 拆分超长 markdown（供上层复用） */
  static splitMarkdown(md, max = MAX_MARKDOWN_CHARS) { return splitText(md, max) }
}

export default QQBotClient
