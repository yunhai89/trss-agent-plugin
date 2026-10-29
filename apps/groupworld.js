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
import { stripSelfPrefix } from '../model/qqofficial/index.js'
import { installMasterGate } from '../model/qqofficial/guard.js'

let _gw = null
let _gwFailed = null
let _gwFailedAt = 0
/** 装配失败后的短路窗口：窗口内直接抛旧错误（避免每条群消息都重试装配），超时后允许再试以自愈。
 *  M-057：此前 _gwFailed 一旦置位即永久短路——启动时未配 apiKey 这类瞬时故障，
 *  之后补好配置/热重载也救不回来（agent 侧 _runtimeFailed 有配置修好后重试的出口，这里没有）。 */
const GW_RETRY_MS = 60_000

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

/**
 * 功能模型引用归一（F20/C2）：analysis.modelProfile 可能填 `llmModels[].id`（如 mabc123）或裸模型名。
 * 经 modelRouter 命中条目 → 返回条目里的真实模型名（否则把 id 当模型名下发给上游 → invalid model 400）；
 * 留空/未命中 → 原样返回（留空维持旧的「主模型/utilityModel」行为）。
 */
function resolveModelRef(ref, rt = null) {
  const v = String(ref ?? '').trim()
  if (!v) return ''
  try {
    const r = rt?.modelRouter?.resolve?.(v)
    if (r?.matched) return String(r.entry?.model || r.model || v)
    // 条目命中但 provider 缺失：router 仍把 model 归一条目真名，避免条目 id 被当模型名下发给主厂商
    if (r?.entry?.model) return String(r.entry.model)
  } catch { /* noop */ }
  return v
}

/** 功能模型引用 → provider（经 modelRouter；留空/未命中回退主 provider）。 */
function resolveModelProvider(ref, rt = null) {
  try { return rt?.modelRouter?.resolve?.(ref)?.provider || rt?.provider || null } catch { return rt?.provider || null }
}

/** 惰性构建 GroupWorldService 单例（带并发去重：预热/接入可能并发首调）。 */
let _gwPromise = null
export async function getGroupWorld() {
  if (_gw) return _gw
  if (_gwFailed && Date.now() - _gwFailedAt < GW_RETRY_MS) throw _gwFailed
  if (_gwPromise) return _gwPromise
  _gwPromise = (async () => {
    const rt = await getRuntime()
    const trace = makeTrace()
    const { embedFn, embedModel } = buildEmbed(rt)
    // 功能模型引用归一（F20/C2）：modelProfile 可填模型条目 id → provider/模型都按真实条目解析；
    // provider 在装配时按归一后的 ref 解析，cfg 包装层则保证分析调用拿到的也是真实模型名。
    const modelProfile = () => resolveModelRef(Config.get().agent?.groupWorld?.analysis?.modelProfile, rt)
    const gwCfgFn = () => {
      const c = Config.get().agent?.groupWorld || {}
      const raw = c.analysis?.modelProfile
      const model = resolveModelRef(raw, rt)
      return model === String(raw ?? '').trim()
        ? c
        : { ...c, analysis: { ...(c.analysis || {}), modelProfile: model } }
    }
    const svc = new GroupWorldService({
      provider: resolveModelProvider(modelProfile(), rt),
      cfg: gwCfgFn,
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
  })().catch((e) => { _gwFailed = e; _gwFailedAt = Date.now(); Log.warn('[groupworld] 装配失败（agent 未初始化？），旁听暂停', e?.message || e); throw e }).finally(() => { _gwPromise = null })
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

// ───────────────────────── analysis.schedule（5 字段 cron 匹配，D19） ─────────────────────────

/** 默认小时分析 cron（每小时 :07）；配置非法/留空时回落到这里。 */
export const DEFAULT_ANALYSIS_SCHEDULE = '7 * * * *'
/** 各字段取值范围：分 时 日 月 周（周 0-7，7 视作周日） */
const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

/** 解析单字段（逗号列表的每项 → {lo,hi,step}）；非法返回 null。支持通配、步长（星号/n）、单值、a-b 区间、区间步长。 */
function parseCronField(field, min, max) {
  const f = String(field ?? '').trim()
  if (!f) return null
  const out = []
  for (const raw of f.split(',')) {
    const part = raw.trim()
    if (!part) return null
    let step = 1
    let rangePart = part
    const slash = part.indexOf('/')
    if (slash >= 0) {
      if (!/^\d+$/.test(part.slice(slash + 1))) return null
      step = Number(part.slice(slash + 1))
      rangePart = part.slice(0, slash)
      if (step <= 0) return null
    }
    let lo
    let hi
    if (rangePart === '*' || rangePart === '?') { lo = min; hi = max }
    else if (/^\d+$/.test(rangePart)) { lo = Number(rangePart); hi = slash >= 0 ? max : lo }
    else {
      const m = rangePart.match(/^(\d+)-(\d+)$/)
      if (!m) return null
      lo = Number(m[1]); hi = Number(m[2])
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi || lo < min || hi > max) return null
    out.push({ lo, hi, step })
  }
  return out.length ? out : null
}

const cronFieldMatches = (parsed, value) => parsed.some(({ lo, hi, step }) => value >= lo && value <= hi && (value - lo) % step === 0)

/** 5 字段表达式是否可解析（配置校验用；避免写错 cron 后「永不触发」且无提示） */
export function isValidCron(expr) {
  const fields = String(expr ?? '').trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every((f, i) => parseCronField(f, CRON_RANGES[i][0], CRON_RANGES[i][1]) !== null)
}

/**
 * 5 字段 cron 匹配（分钟 时 日 月 周）。
 * 支持通配、步长（星号/n）、单值、a-b 区间、区间步长、逗号列表；周字段 0/7 均为周日。
 * 日与周「同时受限」时按 Vixie cron 语义取 OR（任一命中即触发）；否则两字段都须命中（AND）。
 * 非法表达式返回 false（不抛错）。
 * @param {string} expr 5 字段 cron
 * @param {Date} [date] 判定时刻（默认当前；单测注入）
 */
export function cronMatches(expr, date = new Date()) {
  const fields = String(expr ?? '').trim().split(/\s+/)
  if (fields.length !== 5) return false
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return false
  const parsed = fields.map((f, i) => parseCronField(f, CRON_RANGES[i][0], CRON_RANGES[i][1]))
  if (parsed.some((p) => !p)) return false
  const [, , domField, , dowField] = fields
  if (!cronFieldMatches(parsed[0], d.getMinutes())) return false
  if (!cronFieldMatches(parsed[1], d.getHours())) return false
  if (!cronFieldMatches(parsed[3], d.getMonth() + 1)) return false
  const domOk = cronFieldMatches(parsed[2], d.getDate())
  const dow = d.getDay()
  const dowOk = cronFieldMatches(parsed[4], dow) || (dow === 0 && cronFieldMatches(parsed[4], 7))
  const domRestricted = !/^[*?]$/.test(domField)
  const dowRestricted = !/^[*?]$/.test(dowField)
  // Vixie cron：日、周同时受限 → OR；否则 AND
  return domRestricted && dowRestricted ? (domOk || dowOk) : (domOk && dowOk)
}

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
        // 群标识不再要求纯数字：QQ 官方机器人是 openid（`<appid>:<group_openid>` / 频道 `qg_g-c`）
        { reg: '^#群世界状态(?:\\s+(\\S+))?$', fnc: 'gwStatus', permission: 'master' },
        { reg: '^#群世界清理\\s+(\\S+)$', fnc: 'gwPurge', permission: 'master' },
        // 旁听 catch-all（最后）
        { reg: '^[\\s\\S]*$', fnc: 'onAmbient', log: false },
      ],
    })
    // QQ 官方机器人：规则级 permission:master 改为插件内判定（openid 不是 QQ 号）
    installMasterGate(this)
    // 定时任务：小时增量分析 / 每日维护 / 每周小圈子
    // D19 热加载：analysis.schedule 不再在构造期固化进 task cron（此前改后必须重启）。
    // 改为固定「每分钟」触发，_hourlyTick 每次按**当前配置**的 5 字段 cron 判断是否命中，
    // 命中且本分钟未跑过才执行；默认仍等效 '7 * * * *'（每小时 :07）。
    this._lastHourlyMinute = ''
    this.task = [
      { name: '群世界-小时分析', cron: '* * * * *', fnc: this._hourlyTick.bind(this) },
      { name: '群世界-每日维护', cron: '30 4 * * *', fnc: this.dailyTask.bind(this) },
      { name: '群世界-每周聚类', cron: '15 3 * * 1', fnc: this.weeklyTask.bind(this) },
    ]
    Log.info(`[groupworld] 小时分析调度：每分钟检查 analysis.schedule=${this._analysisSchedule()}（热加载即时生效；默认 ${DEFAULT_ANALYSIS_SCHEDULE}）`)
    // 异步预热（不阻塞构造）：默认关不预装配（C10）——未启用不建库/装配，关=整层 no-op；
    // 热开启后由消息路径或状态命令首次调用装配。
    if (cfgNow().enabled === true) getGroupWorld().catch(() => {})
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
    // 命令消息与系统事件不摄入（文档 §6.1）
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

  /** 当前生效的小时分析 cron（每次 tick 重读配置；非法/留空 → 默认 '7 * * * *'） */
  _analysisSchedule() {
    const s = String(cfgNow().analysis?.schedule || '').trim()
    return isValidCron(s) ? s : DEFAULT_ANALYSIS_SCHEDULE
  }

  /** 每分钟 cron 入口（Yunzai this.task 调用；无参） */
  async _hourlyTick() {
    await this._runHourlyIfDue(new Date())
  }

  /**
   * 到点判断 + 同分钟去重：命中当前配置的 cron 且本分钟未跑过才执行 hourlyTask。
   * 配置每 tick 重读 → 改 analysis.schedule 无需重启（D19）。
   * @param {Date} [now] 判定时刻（单测注入）
   * @returns {Promise<boolean>} 本次是否真的执行了 hourlyTask
   */
  async _runHourlyIfDue(now = new Date()) {
    if (cfgNow().enabled !== true) return false
    if (!cronMatches(this._analysisSchedule(), now)) return false
    const d = now instanceof Date ? now : new Date(now)
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`
    if (this._lastHourlyMinute === key) return false // 同一分钟多 tick 只跑一次（如手动触发 + cron 重叠）
    this._lastHourlyMinute = key
    await this.hourlyTask()
    return true
  }

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
    // M-058：数据层未就绪时 inspectUserProfile 恒回 null，不能当成「暂无数据」误导用户
    if (gw.isReady?.() === false) return e.reply('群聊小世界数据层未就绪，暂时无法查询（请稍后重试或检查 gw.db 可写性）。', true)
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
      // M-058：区分「数据层未就绪（写不进去）」与「内容被敏感过滤」，后者此前会误导成内容问题
      if (gw.isReady?.() === false) return e.reply('群聊小世界数据层未就绪，本次纠正未生效，请稍后重试。', true)
      await e.reply('该内容包含不适宜建模的敏感信息（如证件/住址/健康/政治等），未被记录。请换一般性描述（兴趣/习惯/称呼偏好等）。')
      return true
    }
    await e.reply('已记录你的补充/纠正（将作为高可信信息）。发送 #查看我的群聊画像 可核对。')
    return true
  }

  async gwDelete() {
    const e = this.e
    let gw; try { gw = await getGroupWorld() } catch (err) { return e.reply(`群聊小世界未就绪：${err?.message || err}`, true) }
    const okDel = await gw.deleteUserProfile(e.group_id, e.user_id)
    // M-058：此前无条件回「已删除」——未就绪/写库失败时用户以为数据已删
    if (!okDel) return e.reply('群聊小世界数据层未就绪或写入失败，本次删除未生效，请稍后重试。', true)
    await e.reply('已删除你的群聊画像（画像/特征/关系/主观关系）。如需停止后续建模，发送 #关闭我的群聊建模。')
    return true
  }

  async gwOptOut() {
    const e = this.e
    let gw; try { gw = await getGroupWorld() } catch (err) { return e.reply(`群聊小世界未就绪：${err?.message || err}`, true) }
    const c = cfgNow()
    if (c.privacy?.allowUserOptOut === false) return e.reply('管理员已关闭退出选项。', true)
    const on = /关闭/.test(e.msg)
    const okOpt = await gw.setOptOut(e.group_id, e.user_id, on) // service 层关闭时已内置清除派生数据
    // M-058：此前无条件回「已关闭」——未写入 gw_optout 时消息仍会被采集，与承诺相反
    if (!okOpt) return e.reply('群聊小世界数据层未就绪或写入失败，本次操作未生效，请稍后重试。', true)
    await e.reply(`已${on ? '关闭' : '开启'}对你在此群的聊天建模。${on ? '已有画像已清除，后续消息不再被分析。' : ''}`)
    return true
  }

  // ─────────────── 主人指令 ───────────────

  async gwStatus() {
    const e = this.e
    let gw; try { gw = await getGroupWorld() } catch (err) { return e.reply(`群聊小世界未就绪：${err?.message || err}`, true) }
    const c = cfgNow()
    // 群标识：显式参数（任意非空白 token）> 当前群 > 白名单首个。
    // 官方机器人 group_id 含冒号，不能再用 \d+；比较时同时认「完整 ID」与「去前缀 ID」。
    const token = String(e.msg || '').match(/^#群世界状态(?:\s+(\S+))?$/)?.[1] || ''
    const rawToken = token ? stripSelfPrefix(token, e) : ''
    const matchGroup = (id) => {
      const list = Array.isArray(c.groups) ? c.groups.map(String) : []
      return list.find((x) => x === token || stripSelfPrefix(x, e) === rawToken) || (token || (e.group_id ? String(e.group_id) : ''))
    }
    const gid = token ? matchGroup(token) : (e.group_id ? String(e.group_id) : (c.groups[0] ? String(c.groups[0]) : null))
    const lines = [
      `群聊小世界：${c.enabled ? '✅已开启' : '❌未开启'}（online=${c.online === true}）`,
      `白名单群：${(c.groups || []).join('、') || '(空)'}`,
    ]
    if (gid) {
      const s = await gw.getStats(gid)
      if (s) {
        lines.push(`- 群 ${gid}：成员 ${s.members}（hot ${s.hotMembers}）｜特征 ${s.traits}｜关系边 ${s.edges}｜事件 ${s.episodes}｜圈子 ${s.communities}`)
        // M-081 附带：预算 0（禁用）此前被 `|| 100` 显示成 100，管理员看不到真实配置
        const budget = Number.isFinite(Number(c.analysis?.maxDailyCallsPerGroup)) ? Math.max(0, Number(c.analysis.maxDailyCallsPerGroup)) : 100
        lines.push(`  待分析片段 ${s.pendingSegments}｜失败 ${s.deadSegments}｜今日调用 ${s.cursor?.daily_calls_today || 0}/${budget}`)
      }
    }
    await e.reply(lines.join('\n'))
    return true
  }

  async gwPurge() {
    const e = this.e
    let gw; try { gw = await getGroupWorld() } catch (err) { return e.reply(`群聊小世界未就绪：${err?.message || err}`, true) }
    // 官方机器人群标识是 openid（含冒号），按 token 解析；兼容「完整 ID」与「去前缀 ID」
    const token = String(e.msg || '').match(/^#群世界清理\s+(\S+)$/)?.[1] || ''
    if (!token) return e.reply('用法：#群世界清理 <群号/群 ID>（官方机器人为 openid，可先用 /groupid 查看）', true)
    const c = cfgNow()
    const rawToken = stripSelfPrefix(token, e)
    const gid = (Array.isArray(c.groups) ? c.groups.map(String) : []).find((x) => x === token || stripSelfPrefix(x, e) === rawToken) || token
    const okPurge = await gw.purgeGroup(gid, { keepMessages: false })
    // M-058：未就绪（null）/写库失败（false）时不再回「已清理」
    if (!okPurge) return e.reply('群聊小世界数据层未就绪或清理失败，本次清理未生效，请稍后重试。', true)
    await e.reply(`已清理群 ${gid} 的全部 GroupWorld 数据（含原始消息）。`)
    return true
  }
}
