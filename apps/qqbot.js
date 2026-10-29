/**
 * QQ 官方机器人适配器（自实现，AppID + AppSecret 直连）。
 *
 * 为什么在本插件里自实现：
 *  - TRSS-Yunzai 的 QQBot 适配器（Yunzai-QQBot-Plugin / qq-group-bot）仍要求
 *    「机器人QQ号:AppID:Token:AppSecret」四段连接串——Token 是 QQ 频道 v1 时代的遗留鉴权；
 *    现行开放平台只需 AppID + AppSecret 换 access_token（bots.qq.com/app/getAppAccessToken）。
 *  - 本适配器直接实现网关 + v2 REST，配置只需两段密钥，并原生支持 Markdown 消息与 inline keyboard。
 *
 * 注册方式与原生适配器一致：模块加载时 `Bot.adapter.push(adapter)`，
 * 框架 Listener 阶段调用 `adapter.load()` 建立连接；连接成功后 `Bot[id] = {...}` 并 `Bot.em('connect.<id>')`。
 * 事件按 TRSS 约定投递（message.group.normal / message.private.friend），其它插件（含本插件）无感复用。
 *
 * ⚠️ 与 Yunzai-QQBot-Plugin 二选一：两者都连同一条机器人会重复收/发消息。
 */

import plugin from '../../../lib/plugins/plugin.js'
import Config from '../utils/Config.js'
import Log from '../utils/Log.js'
import { QQBotClient } from '../model/qqbot/client.js'
import { DEFAULT_INTENTS, INTENTS, CLOSE_CODE_HINT } from '../model/qqbot/gateway.js'
import { installMasterGate } from '../model/qqofficial/guard.js'

/** 适配器标识（与 model/qqofficial 的 detectAdapter 对齐：id/name 都能识别为 QQ 官方机器人） */
const ADAPTER_ID = 'QQBot'
const ADAPTER_NAME = 'QQBot'
/** Bot.adapter 去重键（按 path 去重；与 Yunzai-QQBot-Plugin 的 data/QQBot/ 区分开，避免被跳过） */
const ADAPTER_PATH = 'data/QQBotAgent/'
const VERSION = 'trss-agent-plugin/qqbot-adapter v1'

/** 被动回复窗口：官方规定 5 分钟内可用 msg_id 回复，且同一 msg_id 最多 5 次 */
const PASSIVE_WINDOW_MS = 5 * 60 * 1000
const PASSIVE_MAX_PER_MSG = 5

/** 账号配置归一化（支持 accounts[] 或扁平 appId/appSecret 单账号） */
export function normalizeAccounts(cfg = {}) {
  const qq = cfg.agent?.qqBot || cfg.qqBot || {}
  if (qq.enable === false) return []
  const list = Array.isArray(qq.accounts) && qq.accounts.length
    ? qq.accounts
    : (qq.appId || qq.appSecret ? [{ appId: qq.appId, appSecret: qq.appSecret }] : [])
  const out = []
  for (const a of list) {
    if (!a || typeof a !== 'object') continue
    const appId = String(a.appId ?? a.appid ?? '').trim()
    const appSecret = String(a.appSecret ?? a.secret ?? a.clientSecret ?? '').trim()
    if (!appId || !appSecret) {
      Log.warn('[qqbot] 账号缺少 appId/appSecret，已跳过（AppID + AppSecret 两段即可，不需要机器人 QQ 号/Token）')
      continue
    }
    out.push({
      appId,
      appSecret,
      name: String(a.name || '').trim() || appId,
      sandbox: a.sandbox === true,
      // intents=0（默认配置）表示「用默认订阅」，不能原样传给网关（IDENTIFY intents=0 会被平台以 4013 拒绝）
      intents: (Number(a.intents) > 0 ? Number(a.intents) : null)
        ?? (Number(qq.intents) > 0 ? Number(qq.intents) : DEFAULT_INTENTS),
      markdown: a.markdown ?? qq.markdown ?? 'auto',
      preferMarkdownText: (a.preferMarkdownText ?? qq.preferMarkdownText) === true,
      apiBase: String(a.apiBase || qq.apiBase || '').trim(),
      tokenUrl: String(a.tokenUrl || qq.tokenUrl || '').trim(),
    })
  }
  return out
}

/** 官方时间戳（ISO 或秒/毫秒数字）→ 秒 */
function timeSeconds(ts) {
  if (!ts) return Math.floor(Date.now() / 1000)
  if (/^\d+$/.test(String(ts))) {
    const n = Number(ts)
    return n > 1e12 ? Math.floor(n / 1000) : n
  }
  const t = Date.parse(ts)
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000)
}

/**
 * 构造适配器实例（依赖注入便于离线测试）。
 * @param {object} [opts]
 * @param {Function} [opts.clientFactory] (account, adapter) => QQBotClient
 * @param {object} [opts.bot] Bot 全局（默认 globalThis.Bot）
 * @param {object} [opts.config] Config（默认 utils/Config.js）
 * @param {(level:string,...args:any[])=>void} [opts.logger]
 */
export function createQQBotAdapter({ clientFactory = null, bot = null, config = null, logger = null } = {}) {
  const getBot = () => bot || globalThis.Bot
  const getCfg = () => (config || Config).get() || {}
  const log = logger || ((level, ...args) => Log[level]?.(...args))

  const adapter = {
    id: ADAPTER_ID,
    name: ADAPTER_NAME,
    path: ADAPTER_PATH,
    version: VERSION,
    /** @type {Map<string, object>} appId → {client, account, connectedAt} */
    clients: new Map(),
    /** @type {Map<string, Map<string, number>>} appId → msgId → 已用被动回复次数 */
    _passiveUsed: new Map(),
    /** @type {Map<string, string>} `${appId}:${openid}` → 频道私信会话 guild_id */
    _dmCache: new Map(),
    _inflight: null,

    /** 框架 Listener 阶段调用：读配置并连接所有账号 */
    async load() {
      const accounts = normalizeAccounts(getCfg())
      if (!accounts.length) {
        log('debug', '[qqbot] 未配置 agent.qqBot 账号（enable=false 或缺少 appId/appSecret），适配器不启动')
        return
      }
      // 串行连接，避免同一时间大量 token 请求
      for (const account of accounts) {
        try {
          await adapter.connect(account)
        } catch (e) {
          log('error', '[qqbot] 账号连接失败', account.name, e?.message || e)
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
      log('mark', `[qqbot] 适配器就绪：${adapter.clients.size}/${accounts.length} 个账号`)
    },

    /** 连接单个账号（可重入：已连接则先停旧） */
    async connect(account) {
      const B = getBot()
      if (!B) throw new Error('Bot 全局不存在（需在 Yunzai 环境运行）')
      const appId = account.appId
      if (adapter.clients.has(appId)) adapter.disconnect(appId)

      const client = clientFactory
        ? clientFactory(account, adapter)
        : new QQBotClient({
          appId: account.appId,
          appSecret: account.appSecret,
          name: account.name,
          sandbox: account.sandbox,
          intents: account.intents,
          markdown: account.markdown,
          preferMarkdownText: account.preferMarkdownText,
          apiBase: account.apiBase,
          tokenUrl: account.tokenUrl,
          logger: log,
        })

      client.on('message', (ev) => adapter._onMessage(appId, ev))
      client.on('interaction', (ev) => adapter._onInteraction(appId, ev))
      client.on('state', (info) => {
        if (info?.state === 'closed' && info?.reason === 'auth_failed') {
          log('error', '[qqbot] 鉴权失败，请检查 AppID/AppSecret', appId, info?.hint || '')
        }
      })

      const entry = { client, account, connectedAt: 0, bot: null }
      adapter.clients.set(appId, entry)
      await client.start()
      // 等 READY（最多 20s）；失败仍保留客户端由网关自行重连
      const startedAt = Date.now()
      while (!entry.connectedAt && Date.now() - startedAt < 20_000) {
        await new Promise((r) => setTimeout(r, 200))
        if (client.status?.().state === 'ready') entry.connectedAt = Date.now()
        if (client.status?.().state === 'closed') break
      }
      if (!entry.connectedAt) {
        const st = client.status?.() || {}
        if (st.reason === 'invalid_intents') {
          log('error', '[qqbot] 连接失败：intents 不被平台接受，已停止重连', appId, st.hint || '')
        } else if (st.state === 'closed') {
          log('error', '[qqbot] 连接失败', appId, st.hint || st.reason || st.lastClose?.code || '')
        } else {
          log('warn', '[qqbot] 连接尚未就绪（网关会在后台继续重连）', appId)
        }
        return false
      }
      adapter._attachBot(appId, entry)
      return true
    },

    /** 断线/停用单个账号 */
    disconnect(appId) {
      const entry = adapter.clients.get(appId)
      if (!entry) return
      try { entry.client.stop?.() } catch { /* noop */ }
      adapter.clients.delete(appId)
      adapter._passiveUsed.delete(appId)
      const B = getBot()
      if (B?.bots?.[appId]) {
        delete B.bots[appId]
        const idx = B.uin ? [...B.uin].indexOf(appId) : -1
        if (idx >= 0) B.uin.splice(idx, 1)
      }
      log('info', '[qqbot] 已断开账号', appId)
    },

    /** 全部断开（插件卸载/热重载用） */
    stopAll() {
      for (const appId of [...adapter.clients.keys()]) adapter.disconnect(appId)
    },

    /** 状态（#qqbot状态） */
    status() {
      const out = []
      for (const [appId, entry] of adapter.clients) {
        out.push({
          appId,
          name: entry.account.name,
          connected: !!entry.connectedAt,
          connectedAt: entry.connectedAt || null,
          ...(entry.client.status?.() || {}),
        })
      }
      return out
    },

    /** 把 client 挂进 Bot[id]，并提供兼容原生适配器的 pickFriend/pickGroup/pickMember 等 */
    _attachBot(appId, entry) {
      const B = getBot()
      if (!B) return
      const account = entry.account
      if (!B.bots) B.bots = {}
      const adapterRef = adapter

      const sendScene = (scene, targetId, msgId) => (msg, quote) => {
        const passive = adapterRef._passiveMsgId(appId, msgId)
        return entry.client.send(scene, targetId, msg, { msgId: passive, ownerId: entry._ownerOpenid || '' })
      }

      const bot = {
        adapter: adapterRef,
        sdk: entry.client,
        appid: appId,
        uin: appId,
        info: { id: appId, appid: appId, name: account.name, avatar: '' },
        get nickname() { return account.name },
        get avatar() { return '' },
        version: { id: ADAPTER_ID, name: ADAPTER_NAME, version: VERSION },
        stat: { start_time: Math.floor(Date.now() / 1000) },
        fl: new Map(),
        gl: new Map(),
        gml: new Map(),
        login: async () => { await entry.client.start(); return true },
        logout: async () => { entry.client.stop(); return true },
        pickFriend: (userId) => adapterRef._pickFriend(appId, entry, userId),
        get pickUser() { return this.pickFriend },
        pickGroup: (groupId) => adapterRef._pickGroup(appId, entry, groupId),
        pickMember: (groupId, userId) => adapterRef._pickMember(appId, entry, groupId, userId),
        getFriendMap: () => bot.fl,
        getGroupMap: () => bot.gl,
        getMemberMap: () => bot.gml,
        sendPrivateMsg: (userId, msg, quote) => sendScene('c2c', adapterRef._rawOpenid(userId), '')(msg, quote),
        sendGroupMsg: (groupId, msg, quote) => sendScene('group', adapterRef._rawGroupOpenid(groupId), '')(msg, quote),
        callback: {},
        _entry: entry,
      }
      entry.bot = bot
      entry.connectedAt = entry.connectedAt || Date.now()
      B.bots[appId] = bot
      // 只经 Bot.em（框架 prepareEvent 会自动补 bot/friend/group 并广播到所有监听器）；
      // 再额外 B.emit 会让 connect 监听器执行两次（Bot.uin 重复 push 虽幂等，但欢迎消息会发两遍）
      B.em?.(`connect.${appId}`, { self_id: appId })
      log('mark', `[qqbot] ${ADAPTER_NAME}(${ADAPTER_ID}) ${account.name} 已连接`, appId)
    },

    /** 被动回复 msg_id：5 分钟内 + 同一 msg_id 次数未超限才带；否则返回空（主动消息） */
    _passiveMsgId(appId, msgId) {
      if (!msgId) return ''
      if (!adapter._passiveUsed.has(appId)) adapter._passiveUsed.set(appId, new Map())
      const used = adapter._passiveUsed.get(appId)
      const n = used.get(msgId) || 0
      if (n >= PASSIVE_MAX_PER_MSG) return ''
      used.set(msgId, n + 1)
      return msgId
    },

    /** 去掉 `<appId>:` 前缀 */
    _rawOpenid(userId) {
      const s = String(userId ?? '')
      for (const appId of adapter.clients.keys()) {
        if (s.startsWith(`${appId}:`)) return s.slice(appId.length + 1)
      }
      return s
    },

    /** 群标识 → 原始 group_openid / 频道 channel_id */
    _rawGroupOpenid(groupId) {
      const s = String(groupId ?? '')
      if (s.startsWith('qg_')) {
        const body = s.slice(3)
        const idx = body.lastIndexOf('-')
        return idx > 0 ? body.slice(idx + 1) : body
      }
      for (const appId of adapter.clients.keys()) {
        if (s.startsWith(`${appId}:`)) return s.slice(appId.length + 1)
      }
      return s
    },

    /** 群标识 → 频道 guild_id（qg_ 前缀时） */
    _rawGuildId(groupId) {
      const s = String(groupId ?? '')
      if (!s.startsWith('qg_')) return ''
      const body = s.slice(3)
      const idx = body.lastIndexOf('-')
      return idx > 0 ? body.slice(0, idx) : body
    },

    _pickFriend(appId, entry, userId) {
      const raw = adapter._rawOpenid(userId)
      const isGuildDm = String(userId ?? '').startsWith('qg_')
      return {
        ...(entry.bot?.fl?.get(String(userId)) || {}),
        friend: true,
        user_id: String(userId),
        sendMsg: (msg, quote) => {
          if (isGuildDm) return adapter._sendGuildDm(appId, entry, raw, msg, quote)
          return entry.client.send('c2c', raw, msg, { msgId: '', ownerId: raw })
        },
        recallMsg: (messageId) => (isGuildDm
          ? Promise.resolve(false) // 频道私信撤回需要 DM guild_id，未缓存时不做（不误删别人消息）
          : entry.client.recall('c2c', raw, messageId)),
        getMsg: async () => null,
      }
    },

    _pickGroup(appId, entry, groupId) {
      const raw = adapter._rawGroupOpenid(groupId)
      const isGuild = String(groupId ?? '').startsWith('qg_')
      return {
        ...(entry.bot?.gl?.get(String(groupId)) || {}),
        group: true,
        group_id: String(groupId),
        sendMsg: (msg, quote) => entry.client.send(isGuild ? 'guild' : 'group', raw, msg, { msgId: '', ownerId: '' }),
        recallMsg: (messageId) => entry.client.recall(isGuild ? 'guild' : 'group', raw, messageId),
        pickMember: (userId) => adapter._pickMember(appId, entry, groupId, userId),
        getMemberMap: () => entry.bot?.gml?.get(String(groupId)) || new Map(),
      }
    },

    _pickMember(appId, entry, groupId, userId) {
      const gml = entry.bot?.gml?.get(String(groupId))
      return {
        ...(gml?.get(String(userId)) || {}),
        group_id: String(groupId),
        user_id: String(userId),
        sendMsg: (msg, quote) => {
          const raw = adapter._rawOpenid(userId)
          return entry.client.send('c2c', raw, msg, { msgId: '', ownerId: raw })
        },
      }
    },

    /** 频道私信：先建 DM 会话再发 */
    async _sendGuildDm(appId, entry, userOpenid, msg, quote) {
      const key = `${appId}:${userOpenid}`
      let guildId = adapter._dmCache.get(key)
      if (!guildId) {
        const ev = entry._lastGuild || {}
        const r = await entry.client.api.createDms(entry.client.creds(), { recipientId: userOpenid, sourceGuildId: ev.guildId })
        guildId = r?.guild_id
        if (guildId) adapter._dmCache.set(key, guildId)
      }
      if (!guildId) return { message_id: [], data: [], error: [new Error('频道私信会话创建失败')] }
      return entry.client.send('guild_dm', guildId, msg, { msgId: '', ownerId: '' })
    },

    /** 收到消息 → 构造 Yunzai 事件并投递 */
    _onMessage(appId, ev) {
      const entry = adapter.clients.get(appId)
      if (!entry) return
      const B = getBot()
      if (!B) return
      entry._lastGuild = ev
      if (ev.scene === 'guild_dm' || ev.scene === 'guild') entry._lastGuild = ev
      entry._ownerOpenid = ev.userId

      const isGroup = ev.scene === 'group' || ev.scene === 'guild'
      const userId = ev.scene === 'guild' || ev.scene === 'guild_dm' ? `qg_${ev.userId}` : `${appId}:${ev.userId}`
      const groupId = ev.scene === 'group' ? `${appId}:${ev.groupOpenid}`
        : ev.scene === 'guild' ? `qg_${ev.guildId}-${ev.channelId}` : null

      const message = []
      // 只有真正被 @ 的消息才补 at 段（框架据此设置 e.atBot → trigger=at 才触发）。
      // QQ 群机器人在开启「全量消息」权限后会收到 GROUP_MESSAGE_CREATE（群内任意消息），
      // 若无条件补 at 段，插件会把每条群聊都当 @ 而回复（线上实测「不管发什么都回复」）。
      const isGroupAt = ev.scene === 'group' && ev.atBot === true
      const isGuildAt = ev.scene === 'guild' && ev.atBot === true
      if (isGroupAt || isGuildAt) message.push({ type: 'at', qq: appId })
      if (ev.scene === 'group' && ev.atBot !== true) {
        // 保留原始内容里的提及信息（供群世界/伪人旁听分析），但不影响触发判定
        for (const m of ev.mentions || []) {
          if (m?.is_you) continue
          const qq = m?.user_openid || m?.member_openid || m?.id
          if (qq) message.push({ type: 'at', qq: String(qq) })
        }
      }
      if (ev.content) message.push({ type: 'text', text: ev.content })
      for (const a of ev.attachments || []) {
        if (a.type === 'image') message.push({ type: 'image', url: a.url, file: a.url, name: a.filename })
        else if (a.type === 'audio' || a.type === 'voice') message.push({ type: 'record', file: a.url, url: a.url })
        else message.push({ type: 'file', name: a.filename || a.url, file: a.url, url: a.url })
      }

      const time = timeSeconds(ev.timestamp)
      const data = {
        post_type: 'message',
        message_type: isGroup ? 'group' : 'private',
        sub_type: ev.scene === 'c2c' || ev.scene === 'guild_dm' ? 'friend' : 'normal',
        self_id: appId,
        user_id: userId,
        group_id: groupId || undefined,
        message_id: ev.messageId,
        message,
        raw_message: ev.content || '',
        // 不要设置 data.msg：TRSS loader.dealEvent 会用 message 段累加出 e.msg
        // （`e.msg = (e.msg || '') + dealText(text段)`）。这里再给一份初值会导致
        // 「#设置主人」变成「#设置主人#设置主人」——带 $ 结尾的框架规则/本插件规则全部匹配失败
        // （线上实测：#状态 这类前缀规则能中，精确匹配的 #设置主人 / #agents更新 没反应）。
        // msg: ev.content || '',
        time,
        sender: { user_id: userId, nickname: ev.username || ev.userId },
        // 供本插件识别官方协议（也兼容 adapter 元数据推断）
        adapter_id: ADAPTER_ID,
        adapter_name: ADAPTER_NAME,
        _qqbot: { scene: ev.scene, appId, openid: ev.userId, groupOpenid: ev.groupOpenid, guildId: ev.guildId, channelId: ev.channelId, atBot: ev.atBot === true, eventName: ev.eventName },
      }
      data.reply = (msg, quote, opts) => {
        const passive = adapter._passiveMsgId(appId, ev.messageId)
        if (ev.scene === 'guild_dm') {
          // 频道私信需要先建 DM 会话（guild_id），不能直接拿 user_openid 当 guild_id
          return adapter._sendGuildDm(appId, entry, ev.userId, msg, quote)
        }
        const target = ev.scene === 'group' ? ev.groupOpenid : ev.userId
        const scene = ev.scene === 'c2c' ? 'c2c' : ev.scene
        return entry.client.send(scene, target, msg, { msgId: passive, ownerId: ev.userId, ...(opts || {}) })
      }

      try {
        B.bots[appId] = B.bots[appId] || entry.bot
        B.em('message', data)
      } catch (e) {
        log('error', '[qqbot] 事件投递失败', e?.message || e)
      }
      log('info', `[qqbot] 收到消息 [${data.message_type}] ${data.user_id}: ${String(ev.content || '').slice(0, 80)}`)
    },

    /** 按钮点击 → 当作「用户发了一句话」，走普通消息通道 */
    _onInteraction(appId, ev) {
      const entry = adapter.clients.get(appId)
      if (!entry) return
      if (!ev.content) {
        log('debug', '[qqbot] 按钮点击无回调文本（忽略）', ev.buttonId)
        return
      }
      adapter._onMessage(appId, {
        ...ev,
        messageId: ev.messageId,
        content: ev.content,
        username: '',
        attachments: [],
        atBot: true, // 按钮是机器人卡片上的点击，天然是「针对机器人」的交互，应当触发
        eventName: 'INTERACTION_CREATE',
      })
    },
  }

  return adapter
}

// ───────────────────────── 适配器注册（框架加载本模块时） ─────────────────────────
let _adapter = null
try {
  if (typeof Bot !== 'undefined' && Array.isArray(Bot.adapter)) {
    _adapter = createQQBotAdapter()
    Bot.adapter.push(_adapter)
    Log.debug('[qqbot] 已注册自实现适配器（AppID + AppSecret）')
  }
} catch (e) {
  Log.warn('[qqbot] 适配器注册失败（非 Yunzai 环境可忽略）', e?.message || e)
}

export { _adapter as adapter }

/**
 * 控制指令插件。
 * 注：真正收/发消息由上面的适配器负责；这里只提供状态/重连/账号管理入口。
 */
export class QQBotManage extends plugin {
  constructor() {
    super({
      name: 'QQ官方机器人适配器',
      dsc: '自实现 QQBot 适配器（AppID+AppSecret）：状态/重连/账号',
      event: 'message',
      priority: 100,
      rule: [
        { reg: '^#qqbot状态$', fnc: 'status' },
        { reg: '^#qqbot重连$', fnc: 'reload' },
        { reg: '^#qqbot账号$', fnc: 'accounts' },
      ],
    })
    installMasterGate(this)
  }

  async status() {
    if (!_adapter) return this.reply('未初始化 QQBot 适配器（本进程不是 Yunzai 环境）')
    const list = _adapter.status()
    if (!list.length) return this.reply('未配置 QQ 官方机器人账号（agent.qqBot.accounts：appId + appSecret 两段即可）')
    const lines = list.map((s) => {
      const state = s.state || (s.connected ? 'ready' : 'disconnected')
      const at = s.readyAt || s.connectedAt
      const closeCode = s.lastClose?.code
      const closeHint = closeCode && CLOSE_CODE_HINT[closeCode] ? `（${CLOSE_CODE_HINT[closeCode]}）` : ''
      return `· ${s.name}（${s.appId}）：${state}${at ? ` · 连接于 ${new Date(at).toLocaleString('zh-CN')}` : ''}`
        + `${s.intents ? ` · intents=${s.intents}` : ''}`
        + `${s.sessionId ? ` · session=${String(s.sessionId).slice(0, 8)}…` : ''}`
        + `${closeCode ? ` · 最近断开 code=${closeCode}${closeHint}` : ''}`
        + `${s.markdownUsable === false ? ' · Markdown 未开通(已自动纯文本)' : ''}`
    })
    return this.reply(['QQ 官方机器人适配器：', ...lines].join('\n'))
  }

  async reload() {
    if (!_adapter) return this.reply('未初始化 QQBot 适配器')
    _adapter.stopAll()
    await _adapter.load()
    return this.status()
  }

  async accounts() {
    const accounts = normalizeAccounts(Config.get())
    if (!accounts.length) return this.reply('未配置账号。在 agent.qqBot.accounts 填 appId + appSecret（不需要机器人 QQ 号与 Token）')
    return this.reply(['已配置账号（AppID + AppSecret）：', ...accounts.map((a) => `· ${a.name}：${a.appId}${a.sandbox ? '（沙箱）' : ''}`)].join('\n'))
  }
}

export { INTENTS }
