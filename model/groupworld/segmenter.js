/**
 * ConversationSegmenter —— 会话切片器（设计文档 §6.2）。
 *
 * LLM 分析的输入单位是 ConversationSegment，不是"一小时全部消息"。切片条件：
 *   - 群连续静默 ≥ segmentIdleSeconds（默认 300s，文档 3~8min）后结束当前片段；
 *   - 单片达到 segmentMaxMessages（默认 100，文档 60~120）强制截断；
 *   - 仅表情/签到/机器人通知等低价值消息：标记 low_value，不计入"有效信息量"，但仍在片段内推进时间线；
 *   - 引用链强相关：本实现靠 idle gap + 时间顺序天然保留（被引用消息通常紧邻）；
 *   - 片段闭合（status=closed）后才进入小时分析；open 片段不分析（对话可能还在继续）。
 *
 * 幂等：按 gw_cursor.last_segmented_msg_id 水位推进；重复执行只处理新增消息。
 *
 * 无状态：每次 processGroup 从 DB 重建"当前 open 片段"上下文。
 */
import { createHash } from 'node:crypto'
import Log from '../../utils/Log.js'
import { textSim } from './embedding.js'

// 低价值消息判定（纯表情/极短反应/系统/命令）。不计入有效信息量，但仍占位时间线。
const SHORT_REACTIONS = new Set(['', '哈', '哈哈', '哈哈哈', '草', '笑死', '好', '嗯', '啊', '哦', '6', '666', '？', '?', '对', '是的', '牛', '卧槽', 'nb', 'NB', '收到', 'ok', 'OK'])
const EMOJI_ONLY = /^\s*(?:\[[^\]]+\]\s*)+$/ // 仅 [图片]/[表情]/[签到] 等占位
const SYSTEM_HINT = /^(?:\[系统\]|\[QQ\]|\[提示\]|签到成功|今日已签)/

/** 判定低价值消息。 */
export function isLowValue(row) {
  if (!row) return true
  if (row.message_type === 'command' || row.message_type === 'system') return true
  const t = String(row.plain_text || '').trim()
  if (SYSTEM_HINT.test(t)) return true
  if (EMOJI_ONLY.test(t)) return true
  if (t.length <= 6 && SHORT_REACTIONS.has(t)) return true
  return false
}

/** 片段幂等键：group + 首条 message_id（同首条必同片段）。 */
function segIdemKey(groupId, startMsgId) {
  return createHash('sha256').update(`${groupId}|${startMsgId}`).digest('hex').slice(0, 16)
}

export class ConversationSegmenter {
  /**
   * @param {object} opts { dao, trace? }
   */
  constructor({ dao, trace = null } = {}) {
    if (!dao) throw new Error('ConversationSegmenter 需要 dao')
    this.dao = dao
    this.trace = trace
  }

  /**
   * 处理一个群的新增消息：折叠进片段 + 闭合静默片段。返回 { processed, closed }。
   * @param {string} groupId
   * @param {object} cfg { segmentIdleSeconds?, segmentMaxMessages? }
   * @param {number} now
   */
  async processGroup(groupId, cfg = {}, now = Date.now()) {
    const idleMs = Math.max(60, (Number(cfg.segmentIdleSeconds) || 300)) * 1000
    const maxMsg = Math.max(10, Math.min(200, Number(cfg.segmentMaxMessages) || 100))
    // 主题漂移切分（TextTiling 式，§6.2「明显更换主题时可提前分割」）
    const shiftOn = cfg.topicShiftEnabled !== false
    const winSize = Math.max(2, Number(cfg.topicShiftWindow) || 6)
    const shiftThr = Number.isFinite(Number(cfg.topicShiftSimThreshold)) ? Number(cfg.topicShiftSimThreshold) : 0.06
    const minSplit = Math.max(3, Number(cfg.minSegmentMessages) || 4)

    // 确保 cursor 行存在（防直接写库/迁移后水位 UPDATE 静默失效 → 重复处理）
    try { await this.dao.run('INSERT OR IGNORE INTO gw_cursor(group_id) VALUES (?)', [groupId]) } catch { /* noop */ }
    // 水位
    const cur = await this.dao.get('SELECT last_segmented_msg_id FROM gw_cursor WHERE group_id=?', [groupId])
    const watermark = Number(cur?.last_segmented_msg_id) || 0

    // 新增消息（正序）
    const msgs = await this.dao.all(
      'SELECT id,message_id,sender_id,plain_text,message_type,sent_at,reply_to_msg_id FROM gw_messages WHERE group_id=? AND id>? ORDER BY sent_at ASC, id ASC LIMIT 500',
      [groupId, watermark],
    )
    if (!msgs.length) return { processed: 0, closed: await this._closeIdleOpen(groupId, idleMs, now) }

    let open = await this._currentOpen(groupId)
    let closed = 0; let topicSplits = 0
    for (const m of msgs) {
      const gap = open && open.lastSentAt ? m.sent_at - open.lastSentAt : 0
      // 需新开片段：无 open / 静默超阈值 / 当前片段已满
      let needNew = !open || gap >= idleMs || open.msgCount >= maxMsg
      // 主题漂移：片段已具最小规模 + 新消息是有效长文本 + 不属于片段内引用链 + 与近窗词面相似度跌破阈值
      if (!needNew && shiftOn && open && open.msgCount >= minSplit
          && !isLowValue(m) && [...String(m.plain_text || '')].length >= 6
          && !(m.reply_to_msg_id && open.msgIds?.has(String(m.reply_to_msg_id)))) {
        const sim = textSim((open.recentTexts || []).slice(-winSize).join(' '), String(m.plain_text || ''))
        if (sim < shiftThr) { needNew = true; topicSplits++ }
      }
      if (needNew) {
        if (open && open.id) { await this._close(open, now, open.msgCount >= maxMsg ? 'full' : (gap >= idleMs ? 'idle' : 'topic_shift')); closed++ }
        open = await this._open(groupId, m) // _open 不预记首条，由下方 _append 统一计数（修首条双计）
      }
      await this._append(open, m)
    }
    // 推进水位到本批最后一条
    await this.dao.run('UPDATE gw_cursor SET last_segmented_msg_id=? WHERE group_id=?', [msgs[msgs.length - 1].id, groupId])
    // 顺带闭合已静默的 open（分析任务期望 closed 才处理）
    closed += await this._closeIdleOpen(groupId, idleMs, now)
    this.trace?.record?.('gw_segment', { groupId, processed: msgs.length, closed, topicSplits })
    return { processed: msgs.length, closed, topicSplits }
  }

  /** 取当前 open 片段（含内存追踪的 lastSentAt/msgCount/recentTexts/msgIds，漂移检测用）。 */
  async _currentOpen(groupId) {
    const row = await this.dao.get("SELECT * FROM gw_segments WHERE group_id=? AND status='open' ORDER BY id DESC LIMIT 1", [groupId])
    if (!row) return null
    const lastMsg = await this.dao.get('SELECT sent_at FROM gw_messages WHERE group_id=? AND message_id=?', [groupId, row.end_msg_id])
    // 重建近窗文本 + 片内消息 id 集（重启后漂移检测/引用链守卫仍可用）
    let recentTexts = []; const msgIds = new Set()
    try {
      const endAt = Number(lastMsg?.sent_at) || Number(row.started_at) || 0
      const rows = await this.dao.all(
        'SELECT message_id, plain_text, message_type FROM gw_messages WHERE group_id=? AND sent_at BETWEEN ? AND ? ORDER BY sent_at ASC, id ASC',
        [groupId, Number(row.started_at) || 0, endAt],
      )
      for (const r of rows) {
        msgIds.add(String(r.message_id))
        if (!isLowValue(r)) recentTexts.push(String(r.plain_text || ''))
      }
      recentTexts = recentTexts.slice(-12)
    } catch { /* noop */ }
    return { ...row, lastSentAt: Number(lastMsg?.sent_at) || Number(row.started_at) || 0, msgCount: Number(row.msg_count) || 0, lowValue: Number(row.low_value_count) || 0, recentTexts, msgIds }
  }

  /** 开新片段（不预记首条；由 _append 统一计数，避免首条双计）。 */
  async _open(groupId, firstMsg) {
    const now = Date.now()
    const idemKey = segIdemKey(groupId, firstMsg.message_id)
    const res = await this.dao.run(
      `INSERT INTO gw_segments(group_id,idem_key,start_msg_id,end_msg_id,msg_count,low_value_count,started_at,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [groupId, idemKey, firstMsg.message_id, firstMsg.message_id, 0, 0, firstMsg.sent_at, 'open', now],
    )
    return { id: res?.lastID ?? null, group_id: groupId, idem_key: idemKey, start_msg_id: firstMsg.message_id, end_msg_id: firstMsg.message_id, msgCount: 0, lowValue: 0, lastSentAt: firstMsg.sent_at, started_at: firstMsg.sent_at, recentTexts: [], msgIds: new Set() }
  }

  /** 追加一条消息到 open 片段（维护近窗文本 + 片内消息 id 集）。 */
  async _append(open, m) {
    open.msgCount += 1
    open.lastSentAt = m.sent_at
    open.msgIds = open.msgIds || new Set()
    open.msgIds.add(String(m.message_id))
    if (isLowValue(m)) open.lowValue += 1
    else {
      open.recentTexts = open.recentTexts || []
      open.recentTexts.push(String(m.plain_text || ''))
      if (open.recentTexts.length > 12) open.recentTexts.splice(0, open.recentTexts.length - 12)
    }
    await this.dao.run(
      'UPDATE gw_segments SET end_msg_id=?, msg_count=?, low_value_count=? WHERE id=?',
      [m.message_id, open.msgCount, open.lowValue, open.id],
    )
  }

  /** 闭合片段。 */
  async _close(open, now, reason) {
    if (!open?.id) return
    await this.dao.run('UPDATE gw_segments SET status=?, closed_at=? WHERE id=?', ['closed', now, open.id])
    this.trace?.record?.('gw_segment', { groupId: open.group_id, segId: open.id, closed: true, msgCount: open.msgCount, reason })
  }

  /** 若当前 open 片段已静默超阈值，闭合之。返回闭合数。 */
  async _closeIdleOpen(groupId, idleMs, now) {
    const open = await this._currentOpen(groupId)
    if (!open) return 0
    if (now - open.lastSentAt >= idleMs) { await this._close(open, now, 'idle'); return 1 }
    return 0
  }

  /**
   * 取待分析片段（closed 且 informative 达阈值、未分析）。供 analyzer 用。
   * @param {string} groupId
   * @param {object} cfg { minSegmentMessages?, maxSegmentsPerRun? }
   */
  async pendingSegments(groupId, cfg = {}, { maxSegmentsPerRun = 50 } = {}) {
    const minMsg = Math.max(1, Number(cfg.minSegmentMessages) || 4)
    const rows = await this.dao.all(
      `SELECT * FROM gw_segments WHERE group_id=? AND status='closed' ORDER BY id ASC LIMIT ?`,
      [groupId, Math.max(1, maxSegmentsPerRun) + 20],
    )
    const out = []
    for (const r of rows) {
      // 有效信息量 = 总条数 - 低价值条数；不足阈值则标记 analyzed(low_value) 跳过，不占用 LLM 预算
      const informative = (Number(r.msg_count) || 0) - (Number(r.low_value_count) || 0)
      if (informative < minMsg) {
        await this.dao.run('UPDATE gw_segments SET status=?, analyzed_at=? WHERE id=?', ['analyzed', Date.now(), r.id])
        continue
      }
      // 装载片段消息：时间窗用 [started_at, 末条消息 sent_at]（不用 closed_at——那是闭合墙钟，远晚于末条，会吸进相邻片段消息）
      const endRow = await this.dao.get('SELECT sent_at FROM gw_messages WHERE group_id=? AND message_id=?', [groupId, r.end_msg_id])
      const msgs = await this.dao.all(
        'SELECT message_id,sender_id,reply_to_user_id,reply_to_msg_id,mentioned_users,plain_text,message_type,sent_at FROM gw_messages WHERE group_id=? AND sent_at BETWEEN ? AND ? ORDER BY sent_at ASC, id ASC',
        [groupId, Number(r.started_at) || 0, Number(endRow?.sent_at) || Number(r.started_at) || Date.now()],
      )
      out.push({ segment: r, messages: msgs, informative })
      if (out.length >= maxSegmentsPerRun) break
    }
    return out
  }
}

export { segIdemKey }
