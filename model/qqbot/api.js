/**
 * QQ 官方机器人 REST API 客户端（api.sgroup.qq.com / v2 消息接口）。
 *
 * 覆盖本插件用到的能力：
 *  - 网关地址 GET /gateway
 *  - 发消息 POST /v2/groups/{group_openid}/messages、/v2/users/{openid}/messages
 *           POST /channels/{channel_id}/messages（频道）、POST /dms/{guild_id}/messages（频道私聊）
 *  - 撤回 DELETE 上述同路径 /{message_id}
 *  - 富媒体上传 POST /v2/{groups|users}/{id}/files → file_info，再以 msg_type=7 发送
 *  - 按钮交互应答 PUT /interactions/{id}
 *  - 主动/被动消息：带 msg_id 为被动回复（5 分钟内、同一 msg_id 有次数限制），否则主动消息
 *
 * 鉴权：Authorization: QQBot {access_token}（token 由 token.js 用 AppID+AppSecret 换取）。
 * 错误映射把常见业务码翻成人话（供日志/卡片提示），纯依赖注入，可离线测试。
 */

import { TokenManager } from './token.js'

/**
 * OpenAPI 基址。2026 官方文档统一地址为 `https://api.bot.qq.com`；
 * 旧版 SDK/文档仍用 `https://api.sgroup.qq.com` → 主用新域名，网络/404 级失败自动回退旧域名。
 */
export const API_BASES = [
  'https://api.bot.qq.com',
  'https://api.sgroup.qq.com',
]
/** 主基址（兼容旧引用/测试） */
export const API_BASE = API_BASES[0]

/** 消息类型（官方 msg_type） */
export const MSG_TYPE = { TEXT: 0, MARKDOWN: 2, ARK: 3, EMBED: 4, MEDIA: 7 }

/** 媒体 file_type */
export const FILE_TYPE = { IMAGE: 1, VIDEO: 2, AUDIO: 3, FILE: 4 }

/** 业务错误码 → 人话（可执行建议）。未收录的回落到 `code message` */
export const ERROR_HINTS = {
  11253: '该能力官方未开放或未授权（内邀/白名单限制）',
  11201: '机器人不在目标会话或参数错误',
  304103: '被动回复已过期（msg_id 5 分钟窗口）：改为主动消息，或等用户再发一条',
  40034005: '被动回复已过期（msg_id 5 分钟窗口）：改为主动消息',
  304036: '该机器人没有 Markdown 消息权限：改用纯文本，或到 QQ 开放平台申请 Markdown 能力',
  40034029: '键盘按钮超限（最多 5 行 × 每行 5 个）',
  305007: 'keyboard 结构不合法（rows/buttons 层级或字段错误）',
  340069: 'msg_type 无效（0=文本 / 2=Markdown / 7=富媒体）',
  22006: '消息类型与内容不匹配（msg_type 要和实际字段对应）',
  40034004: '富媒体转存失败：换可公网直连的 URL，或改用本地文件 base64 上传',
  304080: 'file_info 无效或过期：重新上传后再发',
  40101: '频控：请求太快，稍后再试',
  40054005: '消息内容为空',
  50001: '接口调用异常，稍后重试',
}

/** 把业务错误码翻成「码 + 人话」 */
export function explainError(code, message = '') {
  const key = String(code ?? '')
  const hint = ERROR_HINTS[key]
  const text = message ? String(message).slice(0, 200) : ''
  return hint ? `[${key}] ${hint}${text ? `（${text}）` : ''}` : `[${key}] ${text || '未知错误'}`
}

/** 按会话类型拼消息路径 */
export function messagePath(scene, targetId) {
  switch (scene) {
    case 'c2c': return `/v2/users/${targetId}/messages`
    case 'group': return `/v2/groups/${targetId}/messages`
    case 'guild': return `/channels/${targetId}/messages`
    case 'guild_dm': return `/dms/${targetId}/messages`
    default: throw new Error(`未知会话类型：${scene}`)
  }
}

/** 按会话类型拼富媒体上传路径（频道暂不支持） */
export function mediaPath(scene, targetId) {
  if (scene === 'c2c') return `/v2/users/${targetId}/files`
  if (scene === 'group') return `/v2/groups/${targetId}/files`
  return null
}

/** 每个 msg_id 的被动回复序号（0..65535），保证同一 msg_id 的多次回复合法 */
export class MsgSeqAllocator {
  constructor() { this.map = new Map() }
  next(msgId) {
    if (!msgId) return 1
    const n = (this.map.get(msgId) || 0) + 1
    const seq = n % 65536
    this.map.set(msgId, seq)
    // 防 Map 无限增长：超过 2000 个 msg_id 清掉最早的一半
    if (this.map.size > 2000) {
      const keys = [...this.map.keys()].slice(0, 1000)
      for (const k of keys) this.map.delete(k)
    }
    return seq || 1
  }
}

export class QQBotApi {
  /**
   * @param {object} opts
   * @param {TokenManager} opts.tokenManager
   * @param {string} [opts.baseUrl]
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {(level:string, ...args:any[])=>void} [opts.logger]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.uploadTimeoutMs]
   */
  constructor({ tokenManager, baseUrl = '', baseUrls = API_BASES, fetchImpl = null, logger = () => {}, timeoutMs = 30_000, uploadTimeoutMs = 120_000 } = {}) {
    if (!tokenManager) throw new Error('QQBotApi 需要 tokenManager')
    this.tokenManager = tokenManager
    // baseUrl 显式指定时只用它；否则按 baseUrls 依次回退（新域名优先）
    this.baseUrls = (baseUrl ? [String(baseUrl)] : (Array.isArray(baseUrls) && baseUrls.length ? baseUrls : API_BASES))
      .map((u) => String(u).replace(/\/+$/, ''))
    this._goodBase = ''
    this.baseUrl = this.baseUrls[0]
    this.fetchImpl = fetchImpl
    this.logger = logger
    this.timeoutMs = timeoutMs
    this.uploadTimeoutMs = uploadTimeoutMs
    this.seq = new MsgSeqAllocator()
  }

  _fetch() {
    const f = this.fetchImpl || globalThis.fetch
    if (typeof f !== 'function') throw new Error('当前环境没有 fetch（请升级 Node >= 18）')
    return f
  }

  /**
   * 底层请求（自动取 token、超时、错误人话化）。
   * @returns {Promise<any>} 解析后的 JSON
   */
  async request(creds, method, path, body = null, { timeoutMs = null, upload = false } = {}) {
    try {
      return await this._doRequest(creds, method, path, body, { timeoutMs, upload })
    } catch (e) {
      // token 被提前失效（改密钥 / 平台侧注销 / 缓存时钟偏差）时：清缓存重取一次再重试。
      // 不做这层的话所有发送/查询都会一直 401 直到 2h 后缓存自然过期，用户只能重启。
      if (e?.status === 401 || e?.status === 403) {
        this.logger('warn', '[qqbot:api] token 失效，重新获取后重试一次', `status=${e.status}`, `${method} ${path}`)
        this.tokenManager.clearCache(creds.appId)
        return await this._doRequest(creds, method, path, body, { timeoutMs, upload })
      }
      throw e
    }
  }

  async _doRequest(creds, method, path, body = null, { timeoutMs = null, upload = false } = {}) {
    const token = await this.tokenManager.getAccessToken(creds.appId, creds.appSecret ?? creds.clientSecret)
    const bases = this._goodBase ? [this._goodBase, ...this.baseUrls.filter((b) => b !== this._goodBase)] : [...this.baseUrls]
    let lastErr = null
    for (const base of bases) {
      try {
        const r = await this._requestAt(base, token, creds, method, path, body, { timeoutMs, upload })
        this._goodBase = base
        return r
      } catch (e) {
        lastErr = e
        // 只对「网络级/网关级」失败换域名：业务错误（有 code）重试也没用
        const retriable = !e?.code || e.code === 'BAD_JSON' || /HTTP 404|HTML|网络|超时/.test(String(e?.message || ''))
        if (!retriable || base === bases[bases.length - 1]) break
        this.logger('debug', '[qqbot:api] 基址失败，回退下一个', base, e?.message || e)
      }
    }
    throw lastErr
  }

  async _requestAt(base, token, creds, method, path, body, { timeoutMs = null, upload = false } = {}) {
    const url = `${base}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs || (upload ? this.uploadTimeoutMs : this.timeoutMs))
    let res
    try {
      this.logger('debug', '[qqbot:api]', method, url, body ? `body=${safePreview(body)}` : '')
      res = await this._fetch()(url, {
        method,
        headers: {
          Authorization: `QQBot ${token}`,
          'Content-Type': 'application/json',
          'X-Union-Appid': String(creds.appId || ''),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      })
    } catch (e) {
      const name = e?.name === 'AbortError' ? '请求超时' : (e?.message || String(e))
      throw new Error(`QQ Bot API 请求失败（${method} ${path}）：${name}`)
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text().catch(() => '')
    const traceId = res.headers?.get?.('x-tps-trace-id') || ''
    if (!res.ok) {
      let code = ''
      let msg = text
      try { const j = JSON.parse(text); code = j.code ?? j.err_code ?? ''; msg = j.message ?? j.msg ?? text } catch { /* 非 JSON（HTML 网关错误） */ }
      const htmlHint = /^\s*</.test(text) ? '（网关返回 HTML，通常是平台临时故障）' : ''
      const err = new Error(`QQ Bot API ${res.status}：${explainError(code, msg)}${htmlHint}${traceId ? ` · trace=${traceId}` : ''}`)
      err.status = res.status
      err.code = code
      throw err
    }
    if (!text) return {}
    try { return JSON.parse(text) } catch {
      const err = new Error(`QQ Bot API 响应不是 JSON（${method} ${path}）：${text.slice(0, 160)}`)
      err.code = 'BAD_JSON'
      throw err
    }
  }

  /** 取 WebSocket 网关地址 */
  async getGatewayUrl(creds) {
    const data = await this.request(creds, 'GET', '/gateway')
    const url = data?.url
    if (!url) throw new Error('QQ Bot 网关地址为空（检查 AppID/AppSecret 与机器人权限）')
    return url
  }

  /**
   * 发送消息。
   * @param {object} creds { appId, appSecret }
   * @param {'group'|'c2c'|'guild'|'guild_dm'} scene
   * @param {string} targetId group_openid / user_openid / channel_id / guild_id
   * @param {object} payload 官方消息体（content / markdown / keyboard / media / msg_type ...）
   * @param {object} [opts] { msgId } 传了就是被动回复（自动分配 msg_seq）
   */
  async sendMessage(creds, scene, targetId, payload, { msgId = null } = {}) {
    const body = { ...payload }
    if (msgId) {
      body.msg_id = msgId
      body.msg_seq = body.msg_seq ?? this.seq.next(msgId)
    }
    if (body.msg_type == null) {
      if (body.markdown) body.msg_type = MSG_TYPE.MARKDOWN
      else if (body.media) body.msg_type = MSG_TYPE.MEDIA
      else if (body.ark) body.msg_type = MSG_TYPE.ARK
      else if (body.embed) body.msg_type = MSG_TYPE.EMBED
      else body.msg_type = MSG_TYPE.TEXT
    }
    // 清理 undefined，避免平台把 null 当非法值
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k]
    return this.request(creds, 'POST', messagePath(scene, targetId), body)
  }

  /** 撤回消息 */
  async recallMessage(creds, scene, targetId, messageId) {
    return this.request(creds, 'DELETE', `${messagePath(scene, targetId)}/${messageId}`)
  }

  /**
   * 上传富媒体（群/私聊）。
   * @returns {Promise<{file_info?:string, file_uuid?:string, ttl?:number}>}
   */
  async uploadMedia(creds, scene, targetId, { fileType = FILE_TYPE.IMAGE, url = '', base64 = '', srvSendMsg = false }) {
    const path = mediaPath(scene, targetId)
    if (!path) throw new Error(`会话类型 ${scene} 不支持富媒体上传`)
    const body = { file_type: fileType, srv_send_msg: srvSendMsg === true }
    if (base64) body.file_data = base64
    else if (url) body.url = url
    else throw new Error('上传富媒体需要 url 或 base64')
    return this.request(creds, 'POST', path, body, { upload: true })
  }

  /** 频道私信：先创建 DM 会话（返回 guild_id），再按 guild_dm 场景发消息 */
  async createDms(creds, { recipientId, sourceGuildId }) {
    if (!recipientId || !sourceGuildId) throw new Error('创建频道私信需要 recipientId 与 sourceGuildId')
    return this.request(creds, 'POST', '/users/@me/dms', { recipient_id: recipientId, source_guild_id: sourceGuildId })
  }

  /** 按钮交互应答（不回应平台会重推） */
  async acknowledgeInteraction(creds, interactionId, data = null) {
    const body = { code: 0 }
    if (data) body.data = data
    return this.request(creds, 'PUT', `/interactions/${interactionId}`, body)
  }
}

/** 日志用的安全预览（token/secret 不打印） */
function safePreview(body) {
  try {
    const s = JSON.stringify(body)
    return s.length > 400 ? `${s.slice(0, 400)}…` : s
  } catch { return '[unserializable]' }
}

export default QQBotApi
