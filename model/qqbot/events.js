/**
 * QQ 官方机器人网关事件归一化（纯函数，离线可测）。
 *
 * 官方 DISPATCH 事件（t）→ 本插件内部结构：
 *  - GROUP_AT_MESSAGE_CREATE   QQ 群 @机器人 消息（群机器人只能收到 @ 消息）
 *  - C2C_MESSAGE_CREATE        单聊消息
 *  - AT_MESSAGE_CREATE         频道里 @机器人 的消息
 *  - DIRECT_MESSAGE_CREATE     频道私信
 *  - INTERACTION_CREATE        按钮点击（回调）
 *
 * 内部结构保留 openid 原始字段，ID 拼接（`<appId>:<openid>` / `qg_...`）由适配层完成，
 * 与本插件既有的 QQ 官方识别（model/qqofficial）保持同一套形态。
 */

/** 官方事件名常量 */
export const GATEWAY_EVENTS = {
  READY: 'READY',
  RESUMED: 'RESUMED',
  GROUP_AT_MESSAGE_CREATE: 'GROUP_AT_MESSAGE_CREATE',
  GROUP_MESSAGE_CREATE: 'GROUP_MESSAGE_CREATE',
  C2C_MESSAGE_CREATE: 'C2C_MESSAGE_CREATE',
  AT_MESSAGE_CREATE: 'AT_MESSAGE_CREATE',
  DIRECT_MESSAGE_CREATE: 'DIRECT_MESSAGE_CREATE',
  INTERACTION_CREATE: 'INTERACTION_CREATE',
}

function textOf(v) {
  return v == null ? '' : String(v)
}

/**
 * 归一化一条网关事件。
 * @param {string} t 事件名
 * @param {any} d 事件数据
 * @param {object} [opts] { appId }
 * @returns {object|null} 内部事件；不关心的事件返回 null
 */
export function normalizeEvent(t, d, { appId = '' } = {}) {
  if (!t || !d) return null
  switch (t) {
    case GATEWAY_EVENTS.GROUP_AT_MESSAGE_CREATE:
    case GATEWAY_EVENTS.GROUP_MESSAGE_CREATE:
      return normalizeGroupMessage(d, { appId, eventName: t })
    case GATEWAY_EVENTS.C2C_MESSAGE_CREATE:
      return normalizeC2CMessage(d, { appId })
    case GATEWAY_EVENTS.AT_MESSAGE_CREATE:
      return normalizeGuildMessage(d, { appId })
    case GATEWAY_EVENTS.DIRECT_MESSAGE_CREATE:
      return normalizeGuildDirectMessage(d, { appId })
    case GATEWAY_EVENTS.INTERACTION_CREATE:
      return normalizeInteraction(d, { appId })
    default:
      return null
  }
}

function normalizeGroupMessage(d, { appId, eventName }) {
  const groupOpenid = textOf(d.group_openid)
  const memberOpenid = textOf(d.author?.member_openid)
  if (!groupOpenid || !memberOpenid) return null
  return {
    type: 'message',
    scene: 'group',
    eventName,
    appId,
    messageId: textOf(d.id),
    content: textOf(d.content),
    timestamp: textOf(d.timestamp),
    userId: memberOpenid,
    groupOpenid,
    username: textOf(d.author?.username) || memberOpenid,
    // 群机器人只在被 @ 时收到消息；带上 mentions 供上层判断（self 号段需要 appId 与 mentions 对比）
    mentions: Array.isArray(d.mentions) ? d.mentions : [],
    attachments: Array.isArray(d.attachments) ? d.attachments : [],
    msgElements: Array.isArray(d.msg_elements) ? d.msg_elements : [],
    raw: d,
  }
}

function normalizeC2CMessage(d, { appId }) {
  const userOpenid = textOf(d.author?.user_openid)
  if (!userOpenid) return null
  return {
    type: 'message',
    scene: 'c2c',
    eventName: GATEWAY_EVENTS.C2C_MESSAGE_CREATE,
    appId,
    messageId: textOf(d.id),
    content: textOf(d.content),
    timestamp: textOf(d.timestamp),
    userId: userOpenid,
    groupOpenid: null,
    username: textOf(d.author?.username) || userOpenid,
    mentions: [],
    attachments: Array.isArray(d.attachments) ? d.attachments : [],
    msgElements: Array.isArray(d.msg_elements) ? d.msg_elements : [],
    raw: d,
  }
}

function normalizeGuildMessage(d, { appId }) {
  const userId = textOf(d.author?.id)
  const channelId = textOf(d.channel_id)
  const guildId = textOf(d.guild_id)
  if (!userId || !channelId) return null
  return {
    type: 'message',
    scene: 'guild',
    eventName: GATEWAY_EVENTS.AT_MESSAGE_CREATE,
    appId,
    messageId: textOf(d.id),
    content: textOf(d.content),
    timestamp: textOf(d.timestamp),
    userId,
    groupOpenid: null,
    guildId,
    channelId,
    username: textOf(d.author?.username) || userId,
    mentions: Array.isArray(d.mentions) ? d.mentions : [],
    attachments: Array.isArray(d.attachments) ? d.attachments : [],
    msgElements: [],
    raw: d,
  }
}

function normalizeGuildDirectMessage(d, { appId }) {
  const userId = textOf(d.author?.id)
  const guildId = textOf(d.guild_id)
  if (!userId) return null
  return {
    type: 'message',
    scene: 'guild_dm',
    eventName: GATEWAY_EVENTS.DIRECT_MESSAGE_CREATE,
    appId,
    messageId: textOf(d.id),
    content: textOf(d.content),
    timestamp: textOf(d.timestamp),
    userId,
    groupOpenid: null,
    guildId,
    channelId: null,
    username: textOf(d.author?.username) || userId,
    mentions: [],
    attachments: [],
    msgElements: [],
    raw: d,
  }
}

/**
 * 按钮点击 → 归一成「一条用户消息」：回调文本就是用户点按钮想说的话（如 `#确认 12`），
 * 上层按普通消息投给插件，权限校验/命令路由全部复用。scene 由 chat_type 决定：
 *   0=频道 1=群聊 2=单聊（官方 interaction.chat_type）
 */
function normalizeInteraction(d, { appId }) {
  const resolved = d?.data?.resolved || {}
  const chatType = Number(d?.chat_type)
  const groupOpenid = textOf(d.group_openid)
  const userOpenid = textOf(d.user_openid) || textOf(d.group_member_openid) || textOf(resolved.user_id)
  let scene = 'c2c'
  if (chatType === 1 || groupOpenid) scene = 'group'
  else if (chatType === 0 || d?.guild_id || d?.channel_id) scene = 'guild'
  const content = textOf(resolved.button_data)
  return {
    type: 'interaction',
    scene,
    eventName: GATEWAY_EVENTS.INTERACTION_CREATE,
    appId,
    interactionId: textOf(d.id),
    messageId: textOf(resolved.message_id),
    content,
    buttonId: textOf(resolved.button_id),
    userId: userOpenid,
    groupOpenid: groupOpenid || null,
    guildId: textOf(d.guild_id) || null,
    channelId: textOf(d.channel_id) || null,
    timestamp: textOf(d.timestamp),
    username: '',
    mentions: [],
    attachments: [],
    msgElements: [],
    raw: d,
  }
}

/**
 * 归一化附件 → 本插件内部媒体引用（不下载，交给上层按需处理）。
 * @param {Array} attachments 官方 attachments 数组
 */
export function normalizeAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return []
  return attachments.map((a) => ({
    type: String(a?.content_type || '').startsWith('image/') ? 'image'
      : String(a?.content_type || '').startsWith('video/') ? 'video'
        : String(a?.content_type || '').startsWith('audio/') ? 'audio'
          : String(a?.content_type || '') === 'voice' ? 'voice' : 'file',
    url: textOf(a?.url),
    filename: textOf(a?.filename),
    contentType: textOf(a?.content_type),
    size: Number(a?.size) || null,
    width: Number(a?.width) || null,
    height: Number(a?.height) || null,
    asrText: textOf(a?.asr_refer_text) || '',
  }))
}

export default { GATEWAY_EVENTS, normalizeEvent, normalizeAttachments }
