/**
 * QQ 官方机器人 WebSocket 网关（协议层，零依赖）。
 *
 * 协议要点（官方开放平台 Gateway）：
 *  - 先 GET /gateway 拿 wss 地址；连接后服务端下发 op=10 HELLO（heartbeat_interval）
 *  - 收到 HELLO 后发 op=2 IDENTIFY（token: "QQBot {access_token}", intents, shard:[0,1]）
 *    有 session_id + seq 时改发 op=6 RESUME（断线续传，官方支持约 30 分钟内）
 *  - 每 heartbeat_interval 发 op=1 HEARTBEAT（d=最近 seq）；服务端回 op=11 ACK
 *  - op=0 DISPATCH 是业务事件（t=事件名、d=数据、s=序号）
 *  - op=7 RECONNECT / close code 4006/4007/4009 → 清 session 重连；4004 鉴权失败（不重连）；
 *    4900-4913 服务端错误重连；4008 频控 → 60s 后重连
 *
 * WebSocket 实现优先用 Node 原生全局 WebSocket（Node >= 22），其次动态 import('ws')
 * （Yunzai 自带 ws）。全部通过构造参数注入，便于离线测试状态机。
 */

/** 事件订阅位（intents） */
export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
  INTERACTION: 1 << 26,
}

/**
 * 默认订阅：QQ 群 @ 消息 + C2C + 按钮交互。
 * 频道（GUILDS | PUBLIC_GUILD_MESSAGES）需机器人有频道权限，默认不订阅——
 * 未授权的 intents 会让网关直接拒绝连接（4914/4013），对只用 QQ 群的用户是纯风险。
 * 频道/频道私信用户请在 agent.qqBot.intents 显式配置：1 | (1<<30) = 1073741825。
 */
export const DEFAULT_INTENTS = INTENTS.GROUP_AND_C2C | INTENTS.INTERACTION

export const OP = {
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11,
}

/** 重连退避（毫秒） */
export const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]

/** 网关关闭码语义 */
export const CLOSE_CODE_HINT = {
  4004: '鉴权失败（AppID/AppSecret 错误或 token 失效）',
  4006: '会话失效，需要重新连接',
  4007: 'seq 越界，需要重新连接',
  4008: '连接被频控，60 秒后重试',
  4009: '会话超时，需要重新连接',
  4010: '连接无效',
  4011: '机器人离线',
  4012: '无效的 API 版本',
  4013: '无效的 intents',
  4014: 'intents 无权限（检查开放平台的事件订阅）',
  4900: '服务端内部错误',
  4913: '服务端内部错误',
  4914: 'intents 不足',
  4915: 'intents 被禁止',
}

/** 解析 WebSocket 实现（原生优先；返回 {Ctor, kind}） */
export async function resolveWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return { Ctor: globalThis.WebSocket, kind: 'native' }
  try {
    const mod = await import('ws')
    const Ctor = mod?.WebSocket || mod?.default || mod
    if (typeof Ctor === 'function') return { Ctor, kind: 'ws' }
  } catch { /* 未安装 ws */ }
  throw new Error('当前 Node 没有全局 WebSocket，且未安装 ws 依赖：请升级到 Node >= 22，或在 Yunzai 根目录安装 ws')
}

/**
 * 网关客户端（EventEmitter 风格，但零依赖：注册回调即可）。
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @param {()=>Promise<string>} opts.getToken
 * @param {()=>Promise<string>} opts.getGatewayUrl
 * @param {number} [opts.intents]
 * @param {Function} [opts.WebSocketImpl] 注入 WebSocket 类（测试用）
 * @param {(level, ...args)=>void} [opts.logger]
 * @param {(event:{t:string,d:any,s:number})=>void} [opts.onDispatch]
 * @param {(info:{state:string,...})=>void} [opts.onState]
 * @param {number[]} [opts.reconnectDelays]
 * @param {number} [opts.maxReconnectAttempts]
 */
export class QQBotGateway {
  constructor({
    appId, appSecret, getToken, getGatewayUrl, intents = DEFAULT_INTENTS,
    WebSocketImpl = null, logger = () => {}, onDispatch = () => {}, onState = () => {},
    reconnectDelays = RECONNECT_DELAYS, maxReconnectAttempts = 30,
    heartbeatJitterMs = 0,
  } = {}) {
    this.appId = appId
    this.appSecret = appSecret
    this.getToken = getToken
    this.getGatewayUrl = getGatewayUrl
    this.intents = intents
    this.WebSocketImpl = WebSocketImpl
    this.logger = logger
    this.onDispatch = onDispatch
    this.onState = onState
    this.reconnectDelays = reconnectDelays
    this.maxReconnectAttempts = maxReconnectAttempts
    this.heartbeatJitterMs = heartbeatJitterMs

    this.ws = null
    this.state = 'idle' // idle | connecting | open | closed | stopped
    this.sessionId = null
    this.lastSeq = null
    this.heartbeatTimer = null
    this.reconnectTimer = null
    this.reconnectAttempts = 0
    this.stopped = false
    this.startedAt = 0
    this.lastEventAt = 0
    this.readyAt = 0
    this.lastClose = null
  }

  /** 当前状态（诊断用） */
  status() {
    return {
      state: this.state,
      appId: this.appId,
      sessionId: this.sessionId,
      lastSeq: this.lastSeq,
      reconnectAttempts: this.reconnectAttempts,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      lastEventAt: this.lastEventAt,
      lastClose: this.lastClose,
    }
  }

  _setState(state, extra = {}) {
    this.state = state
    try { this.onState({ state, appId: this.appId, ...extra }) } catch (e) { this.logger('warn', '[qqbot:gateway] onState 回调异常', e?.message || e) }
  }

  async _resolveWsClass() {
    if (this.WebSocketImpl) return this.WebSocketImpl
    if (!this._wsClass) {
      const { Ctor, kind } = await resolveWebSocket()
      this._wsClass = Ctor
      this.logger('debug', '[qqbot:gateway] WebSocket 实现', kind)
    }
    return this._wsClass
  }

  /** 启动（首次连接；失败按退避重试，直到 stop()） */
  async start() {
    if (this.state === 'connecting' || this.state === 'open') return
    this.stopped = false
    this.startedAt = Date.now()
    await this._connect()
  }

  /** 停止（清定时器、关连接、不再重连） */
  stop() {
    this.stopped = true
    this._clearTimers()
    this.sessionId = null
    this.lastSeq = null
    try { this.ws?.close?.() } catch { /* noop */ }
    this.ws = null
    this._setState('stopped')
  }

  _clearTimers() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
  }

  _scheduleReconnect(overrideDelay = null) {
    if (this.stopped) return
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger('error', '[qqbot:gateway] 重连次数已达上限，停止重连', `attempts=${this.reconnectAttempts}`)
      this._setState('closed', { reason: 'max_reconnect_attempts' })
      return
    }
    const delay = overrideDelay ?? this.reconnectDelays[Math.min(this.reconnectAttempts, this.reconnectDelays.length - 1)]
    this.reconnectAttempts++
    this.logger('warn', `[qqbot:gateway] ${Math.round(delay / 1000)}s 后重连`, `第 ${this.reconnectAttempts} 次`)
    this._setState('connecting', { retryInMs: delay })
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this._connect().catch((e) => this.logger('error', '[qqbot:gateway] 重连失败', e?.message || e))
    }, delay)
  }

  async _connect() {
    if (this.stopped) return
    this._clearTimers()
    this._setState('connecting')
    let ws
    try {
      const WsCtor = await this._resolveWsClass()
      const token = await this.getToken()
      const url = await this.getGatewayUrl()
      this.logger('info', '[qqbot:gateway] 连接', url)
      ws = new WsCtor(url, { headers: { 'User-Agent': 'trss-agent-plugin/qqbot' } })
    } catch (e) {
      this.logger('error', '[qqbot:gateway] 建立连接失败', e?.message || e)
      this._scheduleReconnect()
      return
    }
    this.ws = ws
    this.readyAt = 0

    // 原生 WebSocket 用 addEventListener；ws 包同时有 on()（两者都兼容）
    const on = (name, fn) => {
      if (typeof ws.addEventListener === 'function') ws.addEventListener(name, (ev) => fn(ev?.data ?? ev))
      else if (typeof ws.on === 'function') ws.on(name, (arg) => fn(name === 'message' ? arg : arg))
    }
    on('open', () => {
      this.logger('debug', '[qqbot:gateway] WebSocket 已连接')
      this._setState('open')
    })
    on('message', (data) => { this._handleMessage(data).catch((e) => this.logger('error', '[qqbot:gateway] 处理消息异常', e?.message || e)) })
    on('close', (ev) => this._handleClose(ev))
    on('error', (err) => this.logger('warn', '[qqbot:gateway] WebSocket 错误', err?.message || String(err)))
  }

  async _send(payload) {
    const ws = this.ws
    if (!ws) return false
    const text = JSON.stringify(payload)
    try {
      if (typeof ws.send === 'function') {
        // 部分实现 send 是 async；这里统一 await，失败降级
        await ws.send(text)
        return true
      }
    } catch (e) {
      this.logger('warn', '[qqbot:gateway] 发送失败', e?.message || e)
    }
    return false
  }

  async _handleMessage(raw) {
    let text = raw
    if (typeof text !== 'string') {
      try {
        if (text instanceof ArrayBuffer) text = Buffer.from(text).toString('utf8')
        else if (ArrayBuffer.isView(text)) text = Buffer.from(text.buffer, text.byteOffset, text.byteLength).toString('utf8')
        else text = String(text)
      } catch { return }
    }
    let payload
    try { payload = JSON.parse(text) } catch { return this.logger('debug', '[qqbot:gateway] 非 JSON 帧（忽略）') }
    const { op, d, s, t } = payload || {}
    if (typeof s === 'number') this.lastSeq = s

    switch (op) {
      case OP.HELLO:
        await this._identifyOrResume(d || {})
        break
      case OP.DISPATCH: {
        this.lastEventAt = Date.now()
        if (t === 'READY') {
          this.sessionId = d?.session_id || this.sessionId
          this.readyAt = Date.now()
          this.reconnectAttempts = 0
          this._setState('ready', { sessionId: this.sessionId, user: d?.user || null })
          this.logger('mark', '[qqbot:gateway] READY', `session=${this.sessionId}`)
        } else if (t === 'RESUMED') {
          this.readyAt = Date.now()
          this.reconnectAttempts = 0
          this._setState('ready', { sessionId: this.sessionId, resumed: true })
          this.logger('info', '[qqbot:gateway] RESUMED（断线续传成功）')
        }
        try { this.onDispatch({ t, d, s }) } catch (e) { this.logger('warn', '[qqbot:gateway] dispatch 回调异常', e?.message || e) }
        break
      }
      case OP.HEARTBEAT_ACK:
        break
      case OP.RECONNECT:
        this.logger('info', '[qqbot:gateway] 服务端要求重连')
        this._handleClose({ code: 4009 })
        break
      case OP.INVALID_SESSION: {
        const canResume = d === true
        this.logger('warn', '[qqbot:gateway] INVALID_SESSION', canResume ? '（可续传）' : '（会话失效，清 session）')
        if (!canResume) { this.sessionId = null; this.lastSeq = null }
        this._handleClose({ code: 4006 })
        break
      }
      default:
        this.logger('debug', '[qqbot:gateway] 未知 op', op)
    }
  }

  async _identifyOrResume(hello) {
    const interval = Number(hello?.heartbeat_interval) > 0 ? Number(hello.heartbeat_interval) : 40000
    let token
    try { token = await this.getToken() } catch (e) {
      this.logger('error', '[qqbot:gateway] 取 token 失败，重连', e?.message || e)
      this._handleClose({ code: 4004 })
      return
    }
    if (this.sessionId && this.lastSeq != null) {
      await this._send({ op: OP.RESUME, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq } })
      this.logger('debug', '[qqbot:gateway] 已发送 RESUME', `seq=${this.lastSeq}`)
    } else {
      await this._send({ op: OP.IDENTIFY, d: { token: `QQBot ${token}`, intents: this.intents, shard: [0, 1] } })
      this.logger('debug', '[qqbot:gateway] 已发送 IDENTIFY', `intents=${this.intents}`)
    }
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      this._send({ op: OP.HEARTBEAT, d: this.lastSeq }).catch(() => {})
    }, interval)
    if (typeof this.heartbeatTimer?.unref === 'function') this.heartbeatTimer.unref()
  }

  _handleClose(ev = {}) {
    const code = Number(ev?.code ?? 0)
    const reason = String(ev?.reason ?? '')
    this.lastClose = { code, reason, at: Date.now() }
    this._clearTimers()
    const hint = CLOSE_CODE_HINT[code] ? `（${CLOSE_CODE_HINT[code]}）` : ''
    this.logger(code === 1000 ? 'info' : 'warn', '[qqbot:gateway] 连接关闭', `code=${code}${hint}`, reason || '')
    try { this.ws?.close?.() } catch { /* noop */ }
    this.ws = null
    if (this.stopped) { this._setState('stopped'); return }

    // 4004 鉴权失败：重连没有意义，等配置修复后手动重连
    if (code === 4004) {
      this._setState('closed', { reason: 'auth_failed', hint: CLOSE_CODE_HINT[4004] })
      return
    }
    // 会话类错误：清 session 后重连（不带 RESUME）
    if ([4006, 4007, 4009, 4010, 4011, 4012, 4013, 4014].includes(code)) { this.sessionId = null; this.lastSeq = null }
    // 4008 频控：固定 60s
    this._scheduleReconnect(code === 4008 ? 60_000 : null)
  }
}

export default QQBotGateway
