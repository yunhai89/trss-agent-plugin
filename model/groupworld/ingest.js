/**
 * GroupWorldIngester —— 实时轻量处理（设计文档 §6.1）。
 *
 * 每条消息进入后立即执行不依赖 LLM 的处理：
 *   1. 归一化文本/引用/@/时间（由 humanize normalizer 完成，这里只做适配）；
 *   2. 幂等落 gw_messages（UNIQUE 去重，重复写入不重复统计）；
 *   3. 更新发送者 gw_member_profiles（计数/小时直方图/均长/last_spoke_at）；
 *   4. 对明确回复、@ 创建或更新有向 gw_edges；
 *   5. 写入 gw_cursor 占位（首次见到该群）。
 *
 * 这一步绝不调用高成本模型。7d/30d 窗口的精确统计、活跃天数、reply/mention_ratio、co_dialogue、
 * interaction_strength 由 maintenance（§6.4）每日重算；实时只做廉价增量（命名上带 _30d，drift<24h）。
 *
 * 输入 AmbientMessage（来自 model/humanize/message-normalizer.js normalizeYunzaiEvent）：
 *   { id, groupId, userId, displayName, timestamp, text, segments, replyToId, atBot, isSelf, isCommand, media }
 */
import Log, { ANSI } from '../../utils/Log.js'
import { estTokens } from './scoring.js'

/** 从消息段提取所有 @ 的 user_id（含机器人，边建到机器人也无害）。 */
export function extractMentions(segments) {
  const out = []
  for (const s of Array.isArray(segments) ? segments : []) {
    if (s && s.type === 'at' && s.qq != null && String(s.qq) !== '' && String(s.qq) !== 'all') out.push(String(s.qq))
  }
  return [...new Set(out)]
}

/** 推断 message_type。 */
export function deriveMessageType(norm) {
  if (norm?.isCommand) return 'command'
  const hasMedia = Array.isArray(norm?.media) && norm.media.length > 0
  const hasText = String(norm?.text || '').trim().length > 0
  if (hasMedia && hasText) return 'mixed'
  if (hasMedia) return 'media'
  return 'text'
}

export class GroupWorldIngester {
  /**
   * @param {object} opts { dao, trace? }
   *   dao = model/groupworld/db.js 的 dao
   *   trace = 可选 { record(event, data) }
   */
  constructor({ dao, trace = null } = {}) {
    if (!dao) throw new Error('GroupWorldIngester 需要 dao')
    this.dao = dao
    this.trace = trace
  }

  /**
   * 幂等摄入一条消息。返回 { id, isNew }。
   * @param {object} norm AmbientMessage
   */
  async ingestMessage(norm) {
    if (!norm || !norm.groupId || !norm.userId || !norm.id) return { id: null, isNew: false }
    const now = Date.now()
    const groupId = String(norm.groupId)
    const userId = String(norm.userId)
    const messageId = String(norm.id)
    const mentions = extractMentions(norm.segments)
    const msgType = deriveMessageType(norm)

    // 解析被回复者：从 gw_messages 查 replyToId 的发送者
    let replyToUserId = null
    if (norm.replyToId) {
      try {
        const row = await this.dao.get('SELECT sender_id FROM gw_messages WHERE group_id=? AND message_id=?', [groupId, String(norm.replyToId)])
        if (row?.sender_id) replyToUserId = String(row.sender_id)
      } catch { /* noop */ }
    }

    // 幂等写 gw_messages
    let isNew = true
    let rowid = null
    try {
      const res = await this.dao.run(
        `INSERT INTO gw_messages(group_id,message_id,sender_id,reply_to_user_id,reply_to_msg_id,mentioned_users,plain_text,message_type,sent_at,ingest_version,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [groupId, messageId, userId, replyToUserId, norm.replyToId ? String(norm.replyToId) : null,
          JSON.stringify(mentions), String(norm.text || ''), msgType, Number(norm.timestamp) || now, 1, now],
      )
      rowid = res?.lastID ?? null
    } catch (e) {
      // UNIQUE 冲突 = 已存在，幂等跳过（不重复统计）
      if (/UNIQUE|constraint/i.test(String(e?.message || e))) {
        isNew = false
        return { id: messageId, isNew: false }
      }
      Log.warn('[groupworld] ingest 写消息失败', e?.message || e)
      return { id: null, isNew: false }
    }

    if (isNew) {
      // bot 自身发言：消息照常入库（群友"回复 bot"的 reply 链解析靠查 gw_messages，不能排除），
      // 但不建成员档案、不算社交边、不进活跃统计——bot 的关系走独立的 gw_bot_rel 主观关系表
      if (!norm.isSelf) {
        await this._upsertProfile(groupId, userId, norm, msgType, now)
        // 有向边：回复
        if (replyToUserId && replyToUserId !== userId) {
          await this._bumpEdge(groupId, userId, replyToUserId, 'reply', now)
        }
        // 有向边：@
        for (const muid of mentions) {
          if (muid && muid !== userId) await this._bumpEdge(groupId, userId, muid, 'mention', now)
        }
      }
      // 游标占位
      try { await this.dao.run('INSERT OR IGNORE INTO gw_cursor(group_id) VALUES (?)', [groupId]) } catch { /* noop */ }
      this.trace?.record?.('gw_ingest', { groupId, isNew: true, msgType, reply: !!replyToUserId, mentions: mentions.length, ms: Date.now() - now })
    }
    return { id: messageId, isNew, rowid }
  }

  /** 增量更新成员 profile（廉价；精确窗口由 maintenance 重算）。 */
  async _upsertProfile(groupId, userId, norm, msgType, now) {
    const len = [...String(norm.text || '')].length
    const hour = new Date(Number(norm.timestamp) || now).getHours()
    const name = String(norm.displayName || userId).slice(0, 128)
    const spokeAt = Number(norm.timestamp) || now
    try {
      // 原子 upsert（修复 M1）：此前是 SELECT→本地累加→UPDATE/INSERT 的 check-then-act，
      // 并发（apps/groupworld.js 每个 message 事件独立并发摄入）时两条链都走 INSERT，
      // 后者撞 PRIMARY KEY(group_id,user_id) 被 catch 吞掉 → 该条消息的计数/直方图/均值永久丢失
      // （实测并发两条：message_count_30d=1 而 gw_messages=2）。
      // 现在计数、均值、时间戳全部交给 SQL 累加；直方图仍是尽力而为（并发下可能少记一格，可接受）。
      const row = await this.dao.get('SELECT active_hour_histogram FROM gw_member_profiles WHERE group_id=? AND user_id=?', [groupId, userId]).catch(() => null)
      const hist = (() => { try { return JSON.parse(row?.active_hour_histogram || '{}') } catch { return {} } })()
      hist[String(hour)] = (Number(hist[String(hour)]) || 0) + 1
      await this.dao.run(
        `INSERT INTO gw_member_profiles(group_id,user_id,current_nickname,activity_tier,message_count_7d,message_count_30d,active_days_30d,avg_message_length,active_hour_histogram,last_spoke_at,opt_out,created_at,updated_at)
         VALUES (?,?,?,'warm',1,1,1,?,?,?,0,?,?)
         ON CONFLICT(group_id,user_id) DO UPDATE SET
           current_nickname=excluded.current_nickname,
           message_count_7d=gw_member_profiles.message_count_7d+1,
           message_count_30d=gw_member_profiles.message_count_30d+1,
           avg_message_length=ROUND((IFNULL(gw_member_profiles.avg_message_length,0)*gw_member_profiles.message_count_30d+?)/(gw_member_profiles.message_count_30d+1),2),
           active_hour_histogram=excluded.active_hour_histogram,
           last_spoke_at=excluded.last_spoke_at,
           updated_at=excluded.updated_at`,
        [groupId, userId, name, len, JSON.stringify(hist), spokeAt, now, now, len],
      )
    } catch (e) { Log.warn('[groupworld] upsert profile 失败', groupId, userId, e?.message || e) }
  }

  /**
   * 增量有向边。kind: 'reply' | 'mention'。
   * 创建/更新 (group, from, to)；last_interacted_at 推进。
   */
  async _bumpEdge(groupId, fromUserId, toUserId, kind, now) {
    const col = kind === 'reply' ? 'reply_count_30d' : 'mention_count_30d'
    try {
      // 原子 upsert（修复 M1 同族）：UPDATE 无命中再 INSERT 的写法在并发下同样会撞
      // PRIMARY KEY(group_id,from_user_id,to_user_id) 并被 catch 吞掉 → 边计数少记。
      await this.dao.run(
        `INSERT INTO gw_edges(group_id,from_user_id,to_user_id,${col},first_interacted_at,last_interacted_at,updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(group_id,from_user_id,to_user_id) DO UPDATE SET
           ${col}=gw_edges.${col}+1, last_interacted_at=excluded.last_interacted_at, updated_at=excluded.updated_at`,
        [groupId, fromUserId, toUserId, 1, now, now, now],
      )
    } catch (e) { Log.warn('[groupworld] bump edge 失败', groupId, fromUserId, toUserId, e?.message || e) }
  }

  // —— 清理（被 deleteUserProfile / 群清理调用）——

  /** 删某成员全部派生数据（画像/特征/证据/边/主观关系/事件参与者/圈子成员）。原始消息保留（审计），但下游失效。
   *  纯删除：不写 optout（#删除≠#关闭；是否停止建模由 service.setOptOut 单独决定）。
   *  幂等：全部为 DELETE/JSON 过滤操作，重复执行零副作用。 */
  async purgeUser(groupId, userId) {
    if (!groupId || !userId) return false
    try {
      await this.dao.txn(async () => {
        await this.dao.run('DELETE FROM gw_member_profiles WHERE group_id=? AND user_id=?', [groupId, userId])
        // 证据先删（trait 子查询须在 traits 删除**之前**执行；曾因顺序颠倒致证据恒残留），
        // 双路径兜底：subject_user_id 直接定位 + trait 子查询覆盖未回填的存量行
        await this.dao.run(
          'DELETE FROM gw_evidence WHERE group_id=? AND (subject_user_id=? OR (target_type=? AND target_id IN (SELECT id FROM gw_traits WHERE group_id=? AND user_id=?)))',
          [groupId, userId, 'trait', groupId, userId],
        )
        // edge 证据（from=该用户；evidence_text "from>to:hint" 前缀兜底，覆盖未回填存量）
        await this.dao.run("DELETE FROM gw_evidence WHERE group_id=? AND target_type='edge' AND (subject_user_id=? OR evidence_text LIKE ?)", [groupId, userId, `${userId}>%`])
        await this.dao.run('DELETE FROM gw_traits WHERE group_id=? AND user_id=?', [groupId, userId])
        await this.dao.run('DELETE FROM gw_edges WHERE group_id=? AND (from_user_id=? OR to_user_id=?)', [groupId, userId, userId])
        await this.dao.run('DELETE FROM gw_bot_rel WHERE group_id=? AND user_id=?', [groupId, userId])
        // SelfState（ss_*）同库：此前只清 gw_*，导致 #删除我的画像 后 ss_events/ss_emotions/
        // ss_concerns/ss_expectations 里该成员的行仍留着并继续影响情绪投影与心事面板。
        await this.dao.run('DELETE FROM ss_events WHERE group_id=? AND actor_user_id=?', [groupId, userId])
        await this.dao.run('DELETE FROM ss_emotions WHERE group_id=? AND target_user_id=?', [groupId, userId])
        await this.dao.run('DELETE FROM ss_concerns WHERE group_id=? AND target_user_id=?', [groupId, userId])
        await this.dao.run('DELETE FROM ss_expectations WHERE group_id=? AND target_user_id=?', [groupId, userId])
        // 事件为群级数据不整行删，但参与者列表必须移除该用户（可恢复画像的关联）
        const eps = await this.dao.all('SELECT id, participant_ids FROM gw_episodes WHERE group_id=?', [groupId]).catch(() => [])
        for (const ep of eps) {
          let parts = []; try { parts = JSON.parse(ep.participant_ids || '[]') } catch { /* noop */ }
          if (parts.map(String).includes(String(userId))) {
            await this.dao.run('UPDATE gw_episodes SET participant_ids=?, updated_at=? WHERE id=?', [JSON.stringify(parts.map(String).filter((p) => p !== String(userId))), Date.now(), ep.id])
          }
        }
        // 圈子（阶段统计）：成员表移除该用户；若因此空心化则整行删除（下周聚类自然重建）
        const cms = await this.dao.all('SELECT id, member_ids, core_member_ids FROM gw_communities WHERE group_id=?', [groupId]).catch(() => [])
        for (const cm of cms) {
          const strip = (s) => { let a = []; try { a = JSON.parse(s || '[]') } catch { /* noop */ } return a.map(String).filter((p) => p !== String(userId)) }
          const members = strip(cm.member_ids)
          const cores = strip(cm.core_member_ids)
          if (members.length === 0) await this.dao.run('DELETE FROM gw_communities WHERE id=?', [cm.id])
          else await this.dao.run('UPDATE gw_communities SET member_ids=?, core_member_ids=? WHERE id=?', [JSON.stringify(members), JSON.stringify(cores), cm.id])
        }
      })
      Log.mark('[groupworld]', `${ANSI.y}清理成员${ANSI.R} 群${groupId} 用户${userId}`)
      return true
    // 写库异常不再静默：返回 false，避免 service/apps 层回「已删除」假成功（M-058）
    } catch (e) { Log.warn('[groupworld] purgeUser 失败', e?.message || e); return false }
  }

  /** 写/删 optout（#关闭/#开启 我的群聊建模）。 */
  async setOptOut(groupId, userId, on, now = Date.now()) {
    if (!groupId || !userId) return false
    try {
      if (on) await this.dao.run('INSERT OR REPLACE INTO gw_optout(group_id,user_id,opted_at) VALUES (?,?,?)', [groupId, userId, now])
      else await this.dao.run('DELETE FROM gw_optout WHERE group_id=? AND user_id=?', [groupId, userId])
      return true
    } catch (e) { Log.warn('[groupworld] setOptOut 失败', e?.message || e); return false }
  }

  async isOptedOut(groupId, userId) {
    if (!groupId || !userId) return false
    try { return !!(await this.dao.get('SELECT 1 FROM gw_optout WHERE group_id=? AND user_id=?', [groupId, userId])) } catch { return false }
  }

  /** 删某群全部派生数据（保留原始消息可选）。true=已清理，false=写库失败（调用方不再回假成功，M-058）。 */
  async purgeGroup(groupId, { keepMessages = false } = {}) {
    if (!groupId) return false
    // ss_* 与 gw_* 同库：整群清理必须一并删掉 SelfState 的情绪/心事/期待/迁移/群心境，
    // 否则「已有画像已清除」的承诺不成立（情绪投影与心事面板仍带着旧群的残留）
    const tables = ['gw_segments', 'gw_member_profiles', 'gw_traits', 'gw_evidence', 'gw_edges', 'gw_bot_rel', 'gw_episodes', 'gw_communities', 'gw_cursor', 'gw_optout',
      'ss_events', 'ss_emotions', 'ss_concerns', 'ss_expectations', 'ss_transitions', 'ss_group_state']
    if (!keepMessages) tables.unshift('gw_messages')
    try {
      await this.dao.txn(async () => {
        for (const t of tables) await this.dao.run(`DELETE FROM ${t} WHERE group_id=?`, [groupId])
      })
      Log.mark('[groupworld]', `${ANSI.y}清理整群${ANSI.R} 群${groupId}（${keepMessages ? '保留原始消息' : '全删'}）`)
      return true
    } catch (e) { Log.warn('[groupworld] purgeGroup 失败', e?.message || e); return false }
  }
}

export { estTokens }
