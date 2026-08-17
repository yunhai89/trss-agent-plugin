/**
 * apps/groupworld.js —— 群聊小世界旁听 app + 定时任务 + 隐私指令（设计文档 §4、§6、§12）。
 *
 * 职责：
 *  - 旁听群消息（catch-all，priority 低→先跑；永远 return false 不阻断其他插件）；
 *    归一化后幂等摄入 GroupWorld（独立于 humanize 是否启用——社会记忆与是否发言解耦）；
 *  - 定时任务：小时增量分析 / 每日维护 / 每周小圈子（Yunzai this.task，node-schedule 自动重注册）；
 *  - 隐私指令（§12.2）：#查看/纠正/删除我的群聊画像、#关闭/开启我的群聊建模；主人 #群世界状态/清理。
 *
 * 复用 getRuntime().provider；DB/dataDir 用 Config.path.data/groupworld；归一化复用 humanize normalizer。
 * 在线影响 Planner/Replyer 由 apps/humanize.js 经 GroupWorldService 注入（见 humanize 在线接入）。
 */

import { createHash } from 'node:crypto'
import path from 'node:path'
import plugin from '../../../lib/plugins/plugin.js'
import Config from '../utils/Config.js'
import Log, { ANSI } from '../utils/Log.js'
import devLog from '../utils/DevLog.js'
import { getRuntime } from './agent.js'
import { embed } from '../model/llm/embed.js'
import { buildEmbed } from '../model/llm/embed-wiring.js'
import { normalizeYunzaiEvent, collectSelfIds } from '../model/humanize/message-normalizer.js'
import { GroupWorldService } from '../model/groupworld/index.js'

let _gw = null
let _gwFailed = null

/** 取机器人自身 id 集合。 */
function botSelfIds(e) {
  const ids = []
  try {
    if (typeof Bot !== 'undefined' && Bot) {
      if (Bot.uin) ids.push(String(Bot.uin))
      if (Bot.uins) for (const u of Bot.uins) ids.push(String(u))
    }
  } catch { /* noop */ }
  if (e?.self_id) ids.push(String(e.self_id))
  if (e?.bot?.uin) ids.push(String(e.bot.uin))
  return [...new Set(ids)]
}

/** 惰性构建 GroupWorldService 单例（带并发去重：预热/接入可能并发首调）。 */
let _gwPromise = null
export async function getGroupWorld() {
  if (_gw) return _gw
  if (_gwFailed) throw _gwFailed
  if (_gwPromise) return _gwPromise
  _gwPromise = (async () => {
    const rt = await getRuntime()
    const trace = makeTrace()
    const { embedFn, embedModel } = buildEmbed(rt)
    const svc = new GroupWorldService({
      provider: rt.provider,
      cfg: () => Config.get().agent?.groupWorld || {},
      dataDir: path.join(Config.path.data, 'groupworld'),
      botId: botSelfIds(null)[0] || null,
      trace,
      embedFn,
      embedModel,
    })
    await svc.init()
    _gw = svc
    _gwFailed = null
    return svc
  })().catch((e) => { _gwFailed = e; Log.warn('[groupworld] 装配失败（agent 未初始化？），旁听暂停', e?.message || e); throw e }).finally(() => { _gwPromise = null })
  return _gwPromise
}

/** 极简 trace：groupId 哈希后写伪人独立日志目录（data/humanize-logs/gw-<日>.log，与主 agents 日志分离）。 */
function makeTrace() {
  const hash = (gid) => 'g_' + createHash('sha256').update(String(gid || '')).digest('hex').slice(0, 10)
  return {
    record(event, data = {}) {
      try {
        const { groupId, ...rest } = data
        const rec = { ...rest }
        if (groupId != null) rec.groupIdHash = hash(groupId)
        // 伪人链路日志独立目录（曾把字符串当 scope 传 → devLogFilename 解构全空
        // → private-unknown-0-*.log 落进主 agents 目录，污染 web 日志时间线 + 日期筛选）
        const d = new Date()
        const p2 = (n) => String(n).padStart(2, '0')
        const day = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
        devLog(event, rec, null, null, { dir: Config.path.humanizeLogs, filename: `gw-${day}.log` }).catch(() => {})
      } catch { /* noop */ }
    },
  }
}

/** 当前生效配置。 */
function cfgNow() {
  const c = Config.get().agent?.groupWorld || {}
  return c
}

// 触发命令检测
function isCommandText(text) { return /^\s*#/.test(String(text || '')) }

// ───────────────────────── 插件类 ─────────────────────────

export class GroupWorld extends plugin {
  constructor() {
    super({
      name: '群聊小世界',
      dsc: '群聊社会记忆层：旁听摄入→切片→分析→画像/关系/事件；可选注入 Planner/Replyer（默认观察）',
      event: 'message',
      priority: 2, // 先于 agent.js(9999) 跑，旁听后 return false 不阻断
      rule: [
        // 隐私指令（§12.2）
        { reg: '^#查看我的群聊画像$', fnc: 'gwInspect' },
        { reg: '^#纠正我的群聊画像\\s+([\\s\\S]+)$', fnc: 'gwCorrect' },
        { reg: '^#删除我的群聊画像$', fnc: 'gwDelete' },
        { reg: '^#(?:关闭|开启)我的群聊建模$', fnc: 'gwOptOut' },
        // 主人指令
        { reg: '^#群世界状态(?:\\s+(\\d+))?$', fnc: 'gwStatus', permission: 'master' },
        { reg: '^#群世界清理\\s+(\\d+)$', fnc: 'gwPurge', permission: 'master' },
        // 旁听 catch-all（最后）
        { reg: '^[\\s\\S]*$', fnc: 'onAmbient', log: false },
      ],
    })
    // 定时任务：小时增量分析 / 每日维护 / 每周小圈子
    // analysis.schedule 接线（曾为死配置键，cron 硬编码）：构造期读取，改后需重启生效
    const hourlyCron = (() => {
      const s = String(cfgNow().analysis?.schedule || '').trim()
      return /^(\S+\s+){4}\S+$/.test(s) ? s : '7 * * * *'
    })()
    this.task = [
      { name: '群世界-小时分析', cron: hourlyCron, fnc: this.hourlyTask.bind(this) },
      { name: '群世界-每日维护', cron: '30 4 * * *', fnc: this.dailyTask.bind(this) },
      { name: '群世界-每周聚类', cron: '15 3 * * 1', fnc: this.weeklyTask.bind(this) },
    ]
    // 异步预热
    getGroupWorld().catch(() => {})
  }

  /** 旁听入口：归一化 + 幂等摄入。永远 return false。 */
  async onAmbient() {
    const e = this.e
    if (!e.isGroup) return false
    const c = cfgNow()
    if (c.enabled !== true || !Array.isArray(c.groups) || !c.groups.map(String).includes(String(e.group_id))) return false

    let gw
    try { gw = await getGroupWorld() } catch { return false }

    const selfIds = botSelfIds(e)
    const norm = normalizeYunzaiEvent(e, { selfIds, botNames: [], isCommand: isCommandText, platform: 'qq' })
    // 命令/系统通知不摄入（文档 §6.1 ingestion.ignoreCommandMessages/ignoreSystemNotices）
    const ing = c.ingestion || {}
    if ((ing.ignoreCommandMessages !== false && norm.isCommand) || norm.message_type === 'system') return false

    try {
      await gw.ingestMessage(norm)
    } catch (err) {
      Log.warn('[groupworld] 摄入失败', e.group_id, err?.message || err)
    }
    return false
  }

  // ─────────────── 定时任务 ───────────────

  async hourlyTask() {
    const c = cfgNow()
    if (c.enabled !== true) return
    let gw; try { gw = await getGroupWorld() } catch { return }
    for (const gid of (c.groups || []).map(String)) {
      try { await gw.runHourlyAnalysis(gid) } catch (e) { Log.warn('[groupworld] 小时分析失败', gid, e?.message || e) }
    }
  }

  async dailyTask() {
    const c = cfgNow()
    if (c.enabled !== true) return
    let gw; try { gw = await getGroupWorld() } catch { return }
    for (const gid of (c.groups || []).map(String)) {
      try { await gw.runDailyMaintenance(gid) } catch (e) { Log.warn('[groupworld] 每日维护失败', gid, e?.message || e) }
    }
  }

  async weeklyTask() {
    const c = cfgNow()
    if (c.enabled !== true || c.graph?.weeklyCommunityDetection === false) return
    let gw; try { gw = await getGroupWorld() } catch { return }
    for (const gid of (c.groups || []).map(String)) {
      try { await gw.runWeeklyCommunity(gid) } catch (e) { Log.warn('[groupworld] 每周聚类失败', gid, e?.message || e) }
    }
  }

  // ─────────────── 隐私指令（§12.2/12.3） ───────────────

  async gwInspect() {
    const e = this.e
    let gw; try { gw = await getGroupWorld() } catch (err) { return e.reply(`群聊小世界未就绪：${err?.message || err}`, true) }
    const c = cfgNow()
    if (c.privacy?.allowUserInspect === false) return e.reply('管理员已关闭画像自查。', true)
    const data = await gw.inspectUserProfile(e.group_id, e.user_id)
    if (!data) return e.reply('暂无你的群聊画像数据。', true)
    if (data.optedOut) return e.reply('你已关闭群聊建模，当前没有进行画像。发送「#开启我的群聊建模」可恢复。', true)
    const lines = [`「你的群聊画像」（群 ${e.group_id}）`]
    const p = data.profile
    if (p) {
      const tier = { hot: '常驻活跃', warm: '偶尔出现', cold: '较少发言', archived: '长期未活跃' }[p.activity_tier] || p.activity_tier
      lines.push(`活跃度：${tier}（近30天 ${p.message_count_30d || 0} 条 / ${p.active_days_30d || 0} 天）`)
    } else { lines.push('活跃度：暂未形成统计') }
    if (data.traits.length) {
      lines.push('画像条目：')
      for (const t of data.traits.slice(0, 8)) {
        const src = t.source_type === 'explicit' || t.source_type === 'admin_corrected' ? '本人/纠正' : t.source_type === 'statistical' ? '统计' : '系统推断'
        const conf = t.source_type === 'inferred' ? `（可信${(t.confidence * 100) | 0}%）` : ''
        lines.push(`· [${src}] ${t.trait_value}${conf}`)
      }
    } else { lines.push('画像条目：暂无（需更多对话观察）') }
    lines.push('', '可发送：#纠正我的群聊画像 <内容> / #删除我的群聊画像 / #关闭我的群聊建模')
    await e.reply(lines.join('\n'))
    return true
  }

  async gwCorrect() {
    const e = this.e
    let gw; try { gw = await getGroupWorld() } catch (err) { return e.reply(`群聊小世界未就绪：${err?.message || err}`, true) }
    const c = cfgNow()
    if (c.privacy?.allowUserCorrect === false) return e.reply('管理员已关闭画像纠正。', true)
    const content = e.msg.match(/^#纠正我的群聊画像\s+([\s\S]+)$/)?.[1]?.trim()
    if (!content) return e.reply('用法：#纠正我的群聊画像 <你想补充/纠正的内容>', true)
    const okCorr = await gw.correctUserProfile(e.group_id, e.user_id, content)
    if (!okCorr) {
      await e.reply('该内容包含不适宜建模的敏感信息（如证件/住址/健康/政治等），未被记录。请换一般性描述（兴趣/习惯/称呼偏好等）。')
      return true
    }
    await e.reply('已记录你的补充/纠正（将作为高可信信息）。发送 #查看我的群聊画像 可核对。')
    return true
  }

  async gwDelete() {
    const e = this.e
    let gw; try { gw = await getGroupWorld() } catch (err) { return e.reply(`群聊小世界未就绪：${err?.message || err}`, true) }
    await gw.deleteUserProfile(e.group_id, e.user_id)
    await e.reply('已删除你的群聊画像（画像/特征/关系/主观关系）。如需停止后续建模，发送 #关闭我的群聊建模。')
    return true
  }

  async gwOptOut() {
    const e = this.e
    let gw; try { gw = await getGroupWorld() } catch (err) { return e.reply(`群聊小世界未就绪：${err?.message || err}`, true) }
    const c = cfgNow()
    if (c.privacy?.allowUserOptOut === false) return e.reply('管理员已关闭退出选项。', true)
    const on = /关闭/.test(e.msg)
    await gw.setOptOut(e.group_id, e.user_id, on) // service 层关闭时已内置清除派生数据
    await e.reply(`已${on ? '关闭' : '开启'}对你在此群的聊天建模。${on ? '已有画像已清除，后续消息不再被分析。' : ''}`)
    return true
  }

  // ─────────────── 主人指令 ───────────────

  async gwStatus() {
    const e = this.e
    let gw; try { gw = await getGroupWorld() } catch (err) { return e.reply(`群聊小世界未就绪：${err?.message || err}`, true) }
    const c = cfgNow()
    const gid = e.msg.match(/\d+/)?.[0] || (c.groups[0] ? String(c.groups[0]) : null)
    const lines = [
      `群聊小世界：${c.enabled ? '✅已开启' : '❌未开启'}（online=${c.online === true}）`,
      `白名单群：${(c.groups || []).join('、') || '(空)'}`,
    ]
    if (gid) {
      const s = await gw.getStats(gid)
      if (s) {
        lines.push(`- 群 ${gid}：成员 ${s.members}（hot ${s.hotMembers}）｜特征 ${s.traits}｜关系边 ${s.edges}｜事件 ${s.episodes}｜圈子 ${s.communities}`)
        lines.push(`  待分析片段 ${s.pendingSegments}｜失败 ${s.deadSegments}｜今日调用 ${s.cursor?.daily_calls_today || 0}/${c.analysis?.maxDailyCallsPerGroup || 100}`)
      }
    }
    await e.reply(lines.join('\n'))
    return true
  }

  async gwPurge() {
    const e = this.e
    let gw; try { gw = await getGroupWorld() } catch (err) { return e.reply(`群聊小世界未就绪：${err?.message || err}`, true) }
    const gid = e.msg.match(/\d+/)?.[0]
    if (!gid) return e.reply('用法：#群世界清理 <群号>', true)
    await gw.purgeGroup(gid, { keepMessages: false })
    await e.reply(`已清理群 ${gid} 的全部 GroupWorld 数据（含原始消息）。`)
    return true
  }
}
