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
import { textSim, cosine } from './embedding.js'

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
   * @param {object} opts { dao, trace?, embedder? }
   *   embedder（可选）：话题漂移复核用——词面 textSim 判"该切"时用 embedding 余弦复核，
   *   同话题换措辞（textSim 假切）不切，防碎片化。未配 → 纯词面（零影响）。
   */
  constructor({ dao, trace = null, embedder = null } = {}) {
    if (!dao) throw new Error('ConversationSegmenter 需要 dao')
    this.dao = dao
    this.trace = trace
    this.embedder = embedder
    this._winEmbCache = new Map() // segmentId → 近窗向量（片段存活期内复用）
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

    // 新增消息：**按 id 取最低的 500 条**（不能按 sent_at 排序后 LIMIT：QQ 延迟投递会让
    // 「sent_at 更早、id 更大」的消息挤进本批，被 LIMIT 截掉的那条 id 又小于水位 → 永久跳过、
    // 静默不进世界模型）。取回后再按 sent_at 排序处理，兼顾「不丢消息」与「按时间切片段」。
    const msgs = await this.dao.all(
      'SELECT id,message_id,sender_id,plain_text,message_type,sent_at,reply_to_msg_id FROM gw_messages WHERE group_id=? AND id>? ORDER BY id ASC LIMIT 500',
      [groupId, watermark],
    )
    if (!msgs.length) return { processed: 0, closed: await this._closeIdleOpen(groupId, idleMs, now) }
    msgs.sort((a, b) => (Number(a.sent_at) || 0) - (Number(b.sent_at) || 0) || (Number(a.id) || 0) - (Number(b.id) || 0))

    // ── 阶段 1：纯内存决策（embedding 复核可能走网络，故不放进事务；见 db.js txn 的约定）──
    // 此前「_open 落库 + _append + 水位 UPDATE」三处分散执行：循环中途抛错、进程被杀、或水位
    // UPDATE 自身失败 → 段已落库但水位没推进；重跑时把同一批消息**重复 append**（msg_count 翻倍），
    // 或撞上 gw_segments 的 UNIQUE(group_id,idem_key) 直接抛错（该群切片长期失败，仅日志可见）。
    // 现在改成「内存计划 + 单事务落库」，新建段/追加计数/水位推进同生共死（修 H1）。
    const touched = [] // 本批涉及的片段（既有 open + 本批新建），按出现顺序
    // 跨段去重集：本批消息里"已被某个既有片段记录"的集合（见 _batchRecordedIds）。
    // 崩溃那一轮建出来的片段，其 start_msg_id 必落在同一批消息内，故这个集合有界且够用。
    const batchRecorded = await this._batchRecordedIds(groupId, msgs)
    let open = await this._currentOpen(groupId)
    if (open) {
      // 既有 open 段：自己的区间集 ∪ 跨段集（重跑时已被别段记录的消息不再吸进来）
      open.recordedIds = new Set([...open.recordedIds, ...batchRecorded])
      touched.push(open)
    }
    let closed = 0; let topicSplits = 0
    for (const m of msgs) {
      const gap = open && open.lastSentAt ? m.sent_at - open.lastSentAt : 0
      // 需新开片段：无 open / 静默超阈值 / 当前片段已满
      let needNew = !open || gap >= idleMs || open.msgCount >= maxMsg
      // 主题漂移：片段已具最小规模 + 新消息是有效长文本 + 不属于片段内引用链 + 与近窗词面相似度跌破阈值
      // （embedding 可用时复核：词面判"该切"但语义余弦仍高 = 同话题换措辞 → 不切，防碎片化）
      if (!needNew && shiftOn && open && open.msgCount >= minSplit
          && !isLowValue(m) && [...String(m.plain_text || '')].length >= 6
          && !(m.reply_to_msg_id && open.msgIds?.has(String(m.reply_to_msg_id)))) {
        const winText = (open.recentTexts || []).slice(-winSize).join(' ')
        const sim = textSim(winText, String(m.plain_text || ''))
        if (sim < shiftThr) {
          let stillSameTopic = false
          if (this.embedder) stillSameTopic = await this._sameTopicByEmbed(open, winText, String(m.plain_text || ''))
          if (!stillSameTopic) { needNew = true; topicSplits++ }
        }
      }
      if (needNew) {
        if (open) {
          // 只标计划态，真正的 UPDATE（与 trace）在事务里执行：
          // 新段此时还没落库、拿不到 id，trace 挪到阶段 2 才能带上真实 segId。
          open.closeReason = open.msgCount >= maxMsg ? 'full' : (gap >= idleMs ? 'idle' : 'topic_shift')
          open.closedAt = now
          closed++
        }
        open = this._openPlanned(groupId, m, batchRecorded) // 不预记首条，由 _appendPlanned 统一计数（修首条双计）
        touched.push(open)
      }
      this._appendPlanned(open, m)
    }
    // 推进水位到本批 MAX(id)（不能取 sent_at 序最后一条的 id：QQ 事件延迟投递/并发 INSERT 会让
    // 「sent_at 更早、id 更大」的消息排在前面，水位回退 → 下轮重复消费同一条消息）
    const maxId = msgs.reduce((mx, m) => Math.max(mx, Number(m.id) || 0), watermark)

    // ── 阶段 2：单事务落库（建段/复用段 + 追加计数 + 水位推进），任一失败整体回滚（修 H1）──
    await this.dao.txn(async () => {
      for (const seg of touched) {
        if (seg.isNew) {
          // ON CONFLICT DO NOTHING：旧版本遗留的「段已落库、水位未推进」半成品不再抛 UNIQUE → 不再永久卡死
          const ins = await this.dao.run(
            `INSERT INTO gw_segments(group_id,idem_key,start_msg_id,end_msg_id,msg_count,low_value_count,started_at,status,created_at)
             VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(group_id,idem_key) DO NOTHING`,
            [groupId, seg.idem_key, seg.start_msg_id, seg.end_msg_id, 0, 0, seg.started_at, 'open', Date.now()],
          )
          const row = await this.dao.get('SELECT * FROM gw_segments WHERE group_id=? AND idem_key=?', [groupId, seg.idem_key])
          if (!row) throw new Error(`[groupworld] 建段失败：${seg.idem_key}`)
          seg.id = row.id
          // changes=0 → 同 idem_key 的段已存在（旧版半成品）：以库中内容为基线，只补未记录的消息
          if (!(Number(ins?.changes) > 0)) await this._reuseExisting(seg, row)
        }
        if (seg.added.length) {
          await this.dao.run(
            'UPDATE gw_segments SET end_msg_id=?, msg_count=?, low_value_count=? WHERE id=?',
            [seg.endMsgId, seg.msgCount, seg.lowValue, seg.id],
          )
        }
        if (seg.closeReason) {
          const r = await this.dao.run("UPDATE gw_segments SET status='closed', closed_at=? WHERE id=? AND status='open'", [seg.closedAt || now, seg.id])
          if (Number(r?.changes) > 0 || seg.isNew) {
            this.trace?.record?.('gw_segment', { groupId, segId: seg.id, closed: true, msgCount: seg.msgCount, reason: seg.closeReason })
          }
        } else if (seg.reopen) {
          await this.dao.run("UPDATE gw_segments SET status='open', closed_at=NULL WHERE id=?", [seg.id])
        }
      }
      await this.dao.run('UPDATE gw_cursor SET last_segmented_msg_id=? WHERE group_id=?', [maxId, groupId])
      // 顺带闭合已静默的 open（分析任务期望 closed 才处理）
      closed += await this._closeIdleOpen(groupId, idleMs, now)
    })
    this.trace?.record?.('gw_segment', { groupId, processed: msgs.length, closed, topicSplits })
    return { processed: msgs.length, closed, topicSplits }
  }

  /** embedding 复核：新消息与片段近窗是否仍同话题（余弦 ≥0.55 视为同话题）。
   *  近窗向量按「segmentId + 窗口内容哈希」缓存：recentTexts 随每条消息演进，窗口变了必须重算
   *  （曾只按 segmentId 缓存一次——后续消息一直与旧窗口向量比较，漂移检测失真）。
   *  失败/null 不落缓存：下次漂移检测可重试（曾把 null 永久缓存，一次瞬时失败污染整个片段）。 */
  async _sameTopicByEmbed(open, winText, msgText) {
    try {
      // 计划态新段还没落库（无 id），用 idem_key 作缓存键——同一片段键稳定，等价于旧行为
      const segKey = open?.id != null ? String(open.id) : String(open?.idem_key || '')
      if (!segKey) return false
      const key = `${segKey}:${createHash('sha1').update(String(winText)).digest('hex').slice(0, 12)}`
      let winEmb = this._winEmbCache.get(key)
      if (winEmb === undefined) {
        const v = await this.embedder.embed(winText)
        if (!v) return false // 失败不缓存 → 可重试
        winEmb = v
        this._winEmbCache.set(key, v)
        if (this._winEmbCache.size > 100) { // 容量控制：清掉其它片段的旧键
          for (const k of this._winEmbCache.keys()) { if (!k.startsWith(`${segKey}:`)) this._winEmbCache.delete(k) }
        }
      }
      if (!winEmb) return false
      const msgEmb = await this.embedder.embed(msgText)
      if (!msgEmb) return false
      const c = cosine(winEmb, msgEmb)
      return c != null && c >= 0.55
    } catch { return false }
  }

  /** 取当前 open 片段（含内存追踪的 lastSentAt/msgCount/recentTexts/msgIds，漂移检测用）。 */
  async _currentOpen(groupId) {
    const row = await this.dao.get("SELECT * FROM gw_segments WHERE group_id=? AND status='open' ORDER BY id DESC LIMIT 1", [groupId])
    if (!row) return null
    const lastMsg = await this.dao.get('SELECT id, sent_at FROM gw_messages WHERE group_id=? AND message_id=?', [groupId, row.end_msg_id])
    // 重建近窗文本 + 片内消息 id 集（重启后漂移检测/引用链守卫仍可用）
    let recentTexts = []
    // recordedIds「确实已记入本段」：按 start/end 的**行 id 区间**取（与 pendingSegments 装载同口径），
    // 再并入时间窗集合；只用于追加去重——水位回退/崩溃重跑时同一条消息不再重复计数（修 H1 的重复 append）。
    // msgIds 沿用旧口径（区间 ∪ 时间窗），引用链守卫要的是"本段可能看过"的集合。
    const recordedIds = await this._segmentMsgIds(row)
    const msgIds = new Set(recordedIds)
    try {
      const endAt = Number(lastMsg?.sent_at) || Number(row.started_at) || 0
      const rows = await this.dao.all(
        'SELECT message_id, plain_text, message_type FROM gw_messages WHERE group_id=? AND sent_at BETWEEN ? AND ? ORDER BY sent_at ASC, id ASC',
        [groupId, Number(row.started_at) || 0, endAt],
      )
      for (const r of rows) {
        msgIds.add(String(r.message_id))
        recordedIds.add(String(r.message_id))
        if (!isLowValue(r)) recentTexts.push(String(r.plain_text || ''))
      }
      recentTexts = recentTexts.slice(-12)
    } catch { /* noop */ }
    return {
      ...row, isNew: false, added: [], closeReason: null, closedAt: 0, reopen: false,
      endMsgId: row.end_msg_id,
      // 本段末尾消息的行 id：追加新消息时用它比较，保证 end_msg_id 始终是"行 id 最大"那条
      // （装载侧按行 id 区间取数，见 _appendPlanned 注释与 2026-10-17 回归审计 high）
      maxRowId: Number(lastMsg?.id) || 0,
      lastSentAt: Number(lastMsg?.sent_at) || Number(row.started_at) || 0,
      msgCount: Number(row.msg_count) || 0, lowValue: Number(row.low_value_count) || 0,
      recentTexts, msgIds, recordedIds,
    }
  }

  /** 片段已记录的消息 id 集：按 start/end 消息的行 id 区间精确取（H3 同款口径，避免秒级 sent_at
   *  把相邻片段的消息算进来）；边界消息被保留期清理/定位不到时，退回首条消息兜底。 */
  async _segmentMsgIds(row) {
    const set = new Set()
    try {
      const bounds = await this.dao.get(
        `SELECT (SELECT id FROM gw_messages WHERE group_id=? AND message_id=?) AS lo,
                (SELECT id FROM gw_messages WHERE group_id=? AND message_id=?) AS hi`,
        [row.group_id, row.start_msg_id, row.group_id, row.end_msg_id],
      )
      if (bounds?.lo != null && bounds?.hi != null) {
        const rows = await this.dao.all(
          'SELECT message_id FROM gw_messages WHERE group_id=? AND id>=? AND id<=?',
          [row.group_id, bounds.lo, bounds.hi],
        )
        for (const r of rows) set.add(String(r.message_id))
      }
    } catch { /* noop */ }
    if (row.start_msg_id) set.add(String(row.start_msg_id))
    return set
  }

  /** 计划态开新片段（阶段 1 不落库；不预记首条，由 _appendPlanned 统一计数，避免首条双计）。 */
  _openPlanned(groupId, firstMsg, batchRecorded = null) {
    return {
      id: null, isNew: true, group_id: groupId,
      idem_key: segIdemKey(groupId, firstMsg.message_id),
      start_msg_id: firstMsg.message_id, end_msg_id: firstMsg.message_id,
      maxRowId: Number(firstMsg.id) || 0,
      started_at: firstMsg.sent_at, lastSentAt: firstMsg.sent_at,
      msgCount: 0, lowValue: 0, recentTexts: [], msgIds: new Set(),
      // recordedIds 以跨段去重集为初值：本批里已被别段记录的消息不再重复 append（崩溃重跑不重复消费）
      recordedIds: new Set(batchRecorded || []), batchIds: batchRecorded || null,
      added: [], closeReason: null, closedAt: 0, reopen: false,
    }
  }

  /** 本批消息中「已被某个既有片段记录」的 id 集（崩溃重跑的跨段去重，修 H1 的重复消费面）。
   *  只查 start_msg_id 落在本批内的片段：崩溃那一轮建出来的段都满足这一点，规模有界（≤批大小 ×
   *  片段数）；更早开启的 open 段由 _currentOpen 的区间集负责，不会漏。 */
  async _batchRecordedIds(groupId, msgs) {
    const set = new Set()
    try {
      const ids = [...new Set(msgs.map((m) => String(m.message_id)))]
      if (!ids.length) return set
      const rows = await this.dao.all(
        `SELECT * FROM gw_segments WHERE group_id=? AND start_msg_id IN (${ids.map(() => '?').join(',')})`,
        [groupId, ...ids],
      )
      for (const s of rows) {
        const got = await this._segmentMsgIds(s)
        for (const id of got) set.add(id)
      }
    } catch { /* noop */ }
    return set
  }

  /** 追加一条消息到计划态片段（纯内存；维护近窗文本 + 两个 id 集）。
   *  recordedIds 命中即跳过 → 崩溃重跑/水位回退时同一条消息不重复计数（修 H1）。 */
  _appendPlanned(open, m) {
    open.recordedIds = open.recordedIds || new Set()
    const mid = String(m.message_id)
    if (open.recordedIds.has(mid)) return false
    open.recordedIds.add(mid)
    open.msgIds = open.msgIds || new Set()
    open.msgIds.add(mid)
    open.added = open.added || []
    open.added.push(m)
    open.msgCount += 1
    // lastSentAt 按 sent_at 单调推进（静默闭合用它衡量"最近有多久没人说话"）；
    // end_msg_id 则必须指向「本段已追加消息中**行 id 最大**」的那条：pendingSegments 与 _segmentMsgIds
    // 都按 [start,end] 的**行 id 区间**装载与去重，若末尾只跟 sent_at 走，延迟投递消息（行 id 更大、
    // sent_at 更早）会落在区间之外 —— 既不送 LLM 分析，又被 recordedIds 当成"已记录"而不再补投，
    // 知识/记忆投影永久缺失（2026-10-17 回归审计 high：旧实现在此场景 pendingSegments 只取回 3/4 条）。
    const older = Number(m.sent_at) < Number(open.lastSentAt)
    if (!older) open.lastSentAt = m.sent_at
    const rid = Number(m.id) || 0
    if (rid > 0) {
      if (rid >= (open.maxRowId || 0)) { open.endMsgId = m.message_id; open.maxRowId = rid }
    } else if (!older) {
      open.endMsgId = m.message_id // 无行 id 信息（异常来源）时退回旧的 sent_at 口径
    }
    if (isLowValue(m)) open.lowValue += 1
    else {
      open.recentTexts = open.recentTexts || []
      open.recentTexts.push(String(m.plain_text || ''))
      if (open.recentTexts.length > 12) open.recentTexts.splice(0, open.recentTexts.length - 12)
    }
    return true
  }

  /** 复用同 idem_key 的既有片段（旧版本遗留「段已落库、水位未推进」半成品时的补救路径）：
   *  以库中计数为基线，只补记尚未入库的消息 —— 既不抛 UNIQUE 卡死，也不重复计数（修 H1）。 */
  async _reuseExisting(seg, row) {
    const existing = await this._segmentMsgIds(row)
    const kept = (seg.added || []).filter((m) => !existing.has(String(m.message_id)))
    const baseMsg = await this.dao.get('SELECT id, sent_at FROM gw_messages WHERE group_id=? AND message_id=?', [seg.group_id, row.end_msg_id]).catch(() => null)
    seg.isNew = false
    seg.msgIds = new Set([...existing, ...(seg.msgIds || [])].map(String))
    // 去重集 = 本段已记录 ∪ 跨段已记录（跨段集在 _openPlanned 时预置，复用后不能丢）
    seg.recordedIds = new Set([...existing, ...(seg.batchIds || [])])
    seg.msgCount = Number(row.msg_count) || 0
    seg.lowValue = Number(row.low_value_count) || 0
    seg.endMsgId = row.end_msg_id
    seg.maxRowId = Number(baseMsg?.id) || 0
    seg.started_at = row.started_at
    seg.lastSentAt = Number(baseMsg?.sent_at) || Number(row.started_at) || 0
    seg.recentTexts = []
    seg.added = []
    for (const m of kept) this._appendPlanned(seg, m)
    // 库中段已闭合/已分析但本次确有新消息 → 重新打开，避免补记的消息被当作"已分析"永久漏掉
    seg.reopen = kept.length > 0 && String(row.status || '') !== 'open'
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
    // 失败片段可重试（修复 H2）：此前只有 status='closed' 会被取走，一次瞬时异常（SQLITE_BUSY/入库抛错）
    // 把片段置 'failed' 后就再无入口 → attempt/retryCount 形同虚设、整段知识永久丢失。
    // 重试上限用 analysis.retryCount（与单轮内重试同源），attempt 超过上限的不再取。
    const retryLimit = Number.isFinite(Number(cfg.retryCount)) ? Math.max(0, Number(cfg.retryCount)) : 1
    const rows = await this.dao.all(
      `SELECT * FROM gw_segments WHERE group_id=? AND (status='closed' OR (status IN ('failed','dead_letter') AND attempt<=?)) ORDER BY id ASC LIMIT ?`,
      [groupId, retryLimit, Math.max(1, maxSegmentsPerRun) + 20],
    )
    const out = []
    for (const r of rows) {
      // 有效信息量 = 总条数 - 低价值条数；不足阈值则标记 analyzed(low_value) 跳过，不占用 LLM 预算
      const informative = (Number(r.msg_count) || 0) - (Number(r.low_value_count) || 0)
      if (informative < minMsg) {
        await this.dao.run('UPDATE gw_segments SET status=?, analyzed_at=? WHERE id=?', ['analyzed', Date.now(), r.id])
        continue
      }
      // 装载片段消息：按**行 id 区间**取（修复 H3：此前按 sent_at 时间窗取，而 QQ 时间戳是秒级，
      // 话题切换落在同一秒时相邻片段会互相吸消息 —— 实测 5 条同秒消息切两段后 4 条同时在两段，
      // 同一消息重复送 LLM、新片段把上一话题整段当上下文）。行 id 单调递增，边界由 start/end_msg_id 定位。
      const bounds = await this.dao.get(
        `SELECT (SELECT id FROM gw_messages WHERE group_id=? AND message_id=?) AS lo,
                (SELECT id FROM gw_messages WHERE group_id=? AND message_id=?) AS hi`,
        [groupId, r.start_msg_id, groupId, r.end_msg_id],
      ).catch(() => null)
      const MSG_COLS = 'message_id,sender_id,reply_to_user_id,reply_to_msg_id,mentioned_users,plain_text,message_type,sent_at'
      let msgs
      if (bounds?.lo != null && bounds?.hi != null) {
        msgs = await this.dao.all(
          `SELECT ${MSG_COLS} FROM gw_messages WHERE group_id=? AND id>=? AND id<=? ORDER BY id ASC`,
          [groupId, bounds.lo, bounds.hi],
        )
      } else {
        // 边界消息已被清理（purge/保留期）→ 退回时间窗；秒级精度可能多吸同秒消息，属极端兜底
        const endRow = await this.dao.get('SELECT sent_at FROM gw_messages WHERE group_id=? AND message_id=?', [groupId, r.end_msg_id])
        msgs = await this.dao.all(
          `SELECT ${MSG_COLS} FROM gw_messages WHERE group_id=? AND sent_at BETWEEN ? AND ? ORDER BY sent_at ASC, id ASC`,
          [groupId, Number(r.started_at) || 0, Number(endRow?.sent_at) || Number(r.started_at) || Date.now()],
        )
      }
      out.push({ segment: r, messages: msgs, informative })
      if (out.length >= maxSegmentsPerRun) break
    }
    return out
  }
}

export { segIdemKey }
