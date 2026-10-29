/**
 * 一次性提醒 —— 经注入的 scheduler（默认 node-schedule 适配器）+ KV 持久化 + 重启恢复。
 * 对应 yunhai lib/agent/schedule.js。fire 回调由调用方注入（解耦 QQ 发送路径）。
 *
 * 库本体不 import node-schedule（保持离线可测）；apps 用 nodeScheduleAdapter() 装配，测试注入 fake scheduler。
 */

import { createKeyedLock } from './store/lock.js'
import { guardUserIntent } from './evidence.js'

export class ScheduleStore {
  constructor({ kv, prefix = 'Yz:agent:rem:', scheduler, logger = null } = {}) {
    if (!kv) throw new Error('ScheduleStore 需要 kv')
    if (!scheduler) throw new Error('ScheduleStore 需要 scheduler（{ scheduleJob(date, fn), cancelJob(job) }）')
    this.kv = kv
    this.prefix = prefix
    this.scheduler = scheduler
    this.logger = logger // 可选：记录「记录已删除，跳过触发」等异常路径
    this._jobs = new Map()
    this._seq = 0
    this._lock = createKeyedLock() // 提醒列表是单键 RMW：并发 add/cancel 会丢记录
  }

  _key() { return `${this.prefix}jobs` }
  /** 读取任务列表。null = 坏值（非空但非数组）：调用方必须拒绝写回，否则整份提醒列表会被覆盖掉。 */
  async _load() {
    const v = await this.kv.get(this._key())
    if (v == null || v === '') return []
    if (Array.isArray(v)) return v
    return null
  }
  /** 写路径专用：坏值时抛错拒绝写回（否则一次坏值就把整份提醒列表覆盖掉） */
  async _loadForWrite() {
    const arr = await this._load()
    if (arr === null) throw new Error('提醒列表数据损坏（不是数组），已拒绝写入以免清空；请先备份或清空该键')
    return arr
  }

  async _save(arr) { await this.kv.set(this._key(), arr) }

  /**
   * 生成下一个 id。传入已加载列表，取「已有 id 最大值 + 1」——`_seq` 不持久化，
   * 重启后从 0 开始会与 KV 里已有 id 撞号（导致 cancel 错任务）。
   */
  _nextId(arr = []) {
    const used = new Set(arr.map((r) => String(r?.id ?? '')))
    let max = this._seq
    for (const r of arr) {
      const n = parseInt(r?.id, 10)
      if (Number.isFinite(n) && n > max) max = n
    }
    // 取模回绕会撞号（2026-10-17 审计 L3）：第 10 万条后 `_seq` 被 max 钉住，连续两次 add 都得到
    // `00000`，此后任一方 cancel 会按 id 全量过滤、把两条一起删掉（提醒不响 / 周期任务静默停摆）。
    // 这里在 0..99999 里找第一个未被占用的 id；极端全满时退回时间戳 id。
    for (let step = 1; step <= 100000; step++) {
      const n = (max + step) % 100000
      const id = String(n).padStart(5, '0')
      if (!used.has(id)) { this._seq = n; return id }
    }
    this.logger?.('warn', '[schedule] 定时任务 id 空间已满，回退时间戳 id')
    return `t${Date.now().toString(36)}`
  }

  async add(info, fire) {
    return this._lock.withLock(this._key(), async () => {
      const arr = await this._loadForWrite()
      const id = info.id || this._nextId(arr)
      const atNum = info.at instanceof Date ? info.at.getTime() : Number(info.at)
      // type: 'reminder'(发静态 message) | 'task'(跑 Agent 任务链 + 发结果)
      // cron: 有则周期重复（node-schedule.scheduleJob(cron)）；无则用 at 一次性
      const rec = {
        id, userId: info.userId, groupId: info.groupId, selfId: info.selfId,
        at: Number.isFinite(atNum) ? atNum : null,
        message: info.message,
        type: info.type || 'reminder',
        cron: info.cron || null,
        prompt: info.prompt || null,
        createdAt: info.createdAt || Date.now(),
      }
      arr.push(rec)
      // 先注册成功再落盘（2026-10-17 审计 L1）：node-schedule 对无法解析的 cron / 无效 Date 返回 null
      // 而非抛错，原实现照样写进 KV 并回报「已设置」⇒ 面板与列表都显示已排期，实际永不触发。
      if (!this._schedule(rec, fire)) {
        arr.pop()
        return { error: rec.cron ? `非法的 cron 表达式：${rec.cron}` : `无效的触发时间：${rec.at}` }
      }
      await this._save(arr)
      return rec
    })
  }

  _schedule(rec, fire) {
    // 幂等：同一 id 若已有 job，先取消旧 job 再排新的。
    // 否则重复 restore（插件热重载 / 多次 getRuntime）会在同一记录上叠加多个 job，
    // 到点并发触发 N 次（生产事故：一次性任务链被触发 21 次）。
    const prev = this._jobs.get(rec.id)
    if (prev?.job) { try { this.scheduler.cancelJob(prev.job) } catch { /* noop */ } }
    // cron → scheduleJob(cron) 周期触发，fire 后不 cancel（持续重复）
    // 无 cron → scheduleJob(Date) 一次性，fire 后 cancel
    const isCron = !!rec.cron
    const spec = isCron ? rec.cron : new Date(rec.at)
    const job = this.scheduler.scheduleJob(spec, async () => {
      // 触发前回查持久层：记录若已被删除（面板/命令取消、外部清理、另一实例已触发过），
      // 本进程内残留的定时器不得再发一次——否则「删掉的提醒照发」「多实例重复发」无解。
      try {
        const alive = ((await this._load()) || []).some((r) => String(r.id) === String(rec.id))
        if (!alive) {
          this._jobs.delete(String(rec.id))
          this.logger?.('warn', `[schedule] 记录 ${rec.id} 已不在存储中，跳过本次触发`)
          return
        }
      } catch { /* 读取失败时按原语义继续触发，避免因存储抖动丢提醒 */ }
      try { await fire?.(rec) } catch { /* noop */ }
      if (!isCron) { try { await this.cancel(rec.id) } catch { /* noop */ } }
    })
    // node-schedule 对非法 cron / 无效时间返回 null（不抛错）：必须把「没排上」如实回给调用方，
    // 否则记录照样落 KV、列表显示已排期，实际永不触发（2026-10-17 审计 L1）。
    if (!job) {
      this.logger?.('warn', `[schedule] 无法排期（${isCron ? `cron=${rec.cron}` : `at=${rec.at}`}），已拒绝写入`)
      return null
    }
    this._jobs.set(rec.id, { job, info: rec })
    return job
  }

  /** 取消本实例已排的全部 job（热重载/关闭时调，防止旧 job 泄漏继续触发） */
  shutdown() {
    for (const { job } of this._jobs.values()) { try { this.scheduler.cancelJob(job) } catch { /* noop */ } }
    this._jobs.clear()
  }

  /**
   * 取消指定 id。
   * @returns {Promise<{ok:boolean, removed:number, code?:string}>} 结构化结果——
   *   此前内层函数没有 return，调用方按真值判定成功，导致 reminder_cancel / DELETE /api/schedule
   *   恒报「未找到」（记录其实已删）；命令路径不读返回值、永远回「已取消」，同一缺陷两条路径结论相反。
   */
  async cancel(id) {
    return this._lock.withLock(this._key(), async () => {
      const key = String(id)
      const j = this._jobs.get(key)
      if (j?.job) { try { this.scheduler.cancelJob(j.job) } catch { /* noop */ } }
      this._jobs.delete(key)
      const arr = await this._loadForWrite()
      const next = arr.filter((r) => String(r.id) !== key)
      const removed = arr.length - next.length
      if (removed) await this._save(next)
      return removed ? { ok: true, removed } : { ok: false, removed: 0, code: 'not_found' }
    })
  }

  /**
   * 按归属列出。userId 为群共享**新形态**（`__group__:<gid>`）时，同时带上该群的旧版无群号记录
   * （2026-10-17 回归审计 medium-5：作用域迁移后 reminder_list 看不到升级前设的提醒，
   *  而 `#定时任务列表` 走 selectScheduleForList 能看到，同一份数据两套可见性）。
   * @param {string} userId
   * @param {{ groupId?: string|null }} [opts]
   */
  async listByUser(userId, { groupId = null } = {}) {
    const uid = String(userId)
    const shared = isSharedScopeId(uid)
    return ((await this._load()) || [])
      .filter((r) => String(r?.userId) === uid || (shared && isLegacySharedRecord(r, groupId)))
      .sort(_sortRec)
  }
  async listAll() { return ((await this._load()) || []).sort(_sortRec) }

  /** 重启恢复：cron 任务始终重排（不过期）；一次性仅 at>now 重排，过期丢弃。
   *  幂等：先取消本实例已排全部 job 再重排，重复调用不会叠加触发。 */
  async restore(fire) {
    this.shutdown()
    const arr = (await this._load()) || [] // 坏值时按空恢复（记录保留在 KV 里，交由用户/面板处置）
    const now = Date.now()
    const live = []
    for (const rec of arr) {
      if (rec.cron) { live.push(rec); this._schedule(rec, fire) }          // cron：始终重排
      else if (rec.at > now) { live.push(rec); this._schedule(rec, fire) } // 一次性未过期
    }
    if (live.length !== arr.length) await this._save(live)
    return { restored: live.length, dropped: arr.length - live.length }
  }
}

/**
 * 从全量调度中挑出「#定时任务列表」应展示的条目（纯函数，便于离线测试）：
 *  - 所有任务链（type='task'，群级、prompt 非私密）；
 *  - 仅该用户本人的其余条目（提醒等，避免把他人私聊提醒内容暴露给所有人）。
 * 去重，任务链在前。修复「AI 建了提醒、web 看得到、#定时任务列表 返回暂无」。
 */
/**
 * 群共享模式的作用域 id。
 *
 * 2026-10-17 审计 C2/C3：原实现所有群共用字面量 `'__group__'`，于是
 * ① `selectScheduleForList` 的归属判定 `u === scopeUserId` 让 A 群成员能列出（并取消）B 群的提醒/任务；
 * ② 群共享的 recall/profile 键也以它为键，不同群的长期记忆互相串。
 * 现改为带群号的 `__group__:<gid>`，跨群天然隔离。旧键记录仍可被本群识别（见 selectScheduleForList
 * 与 apps/agent.js:ownsScheduleRecord 的 legacyShared 分支），但**不再跨群可见**。
 */
export const SHARED_SCOPE_PREFIX = '__group__'

/** 群共享作用域 id：有群号带群号，无群号退回旧字面量（私聊/无群上下文不应走到这里） */
export function sharedScopeId(groupId) {
  const g = groupId == null || groupId === '' ? '' : String(groupId)
  return g ? `${SHARED_SCOPE_PREFIX}:${g}` : SHARED_SCOPE_PREFIX
}

/** 是否为群共享作用域 id（新旧两种形态都算） */
export function isSharedScopeId(v) {
  const s = String(v ?? '')
  return s === SHARED_SCOPE_PREFIX || s.startsWith(`${SHARED_SCOPE_PREFIX}:`)
}

/** 是否为「旧版」无群号群共享记录（跨群同名，必须再比 groupId 才能判定归属） */
export function isLegacySharedRecord(rec, groupId) {
  if (String(rec?.userId ?? '') !== SHARED_SCOPE_PREFIX) return false
  const g = groupId == null || groupId === '' ? '' : String(groupId)
  return g !== '' && String(rec?.groupId ?? '') === g
}

export function selectScheduleForList(all = [], { userId = '', scopeUserId = '', isMaster = false, groupId = null } = {}) {
  const uid = String(userId)
  const suid = String(scopeUserId || '')
  const isMine = (r) => {
    if (!r) return false
    const u = String(r.userId)
    if (u === uid) return true
    // 旧版群共享记录（字面量 '__group__'）没有群信息就无法判定归属：必须再比 groupId，
    // 否则「传 __group__ 当作用域」的旧调用口径会把别群条目一起列出（审计 C2）。
    if (u === SHARED_SCOPE_PREFIX) return isLegacySharedRecord(r, groupId)
    return !!suid && u === suid
  }
  // 任务链同样按归属过滤：type='task' 并非天然"群级非私密"——私聊用 reminder_set 带 prompt
  // 建的记录也是 type='task' 且 groupId=null，曾无条件列出，把他人私聊任务描述泄露给任意用户。
  const tasks = (all || []).filter((r) => r?.type === 'task' && (isMaster || isMine(r)))
  const mine = (all || []).filter(isMine)
  const seen = new Set()
  const out = []
  for (const r of [...tasks, ...mine]) { if (r && !seen.has(r.id)) { seen.add(r.id); out.push(r) } }
  return out
}

/** 列表排序：cron 重复任务排前（按 createdAt），一次性按 at 升序 */
function _sortRec(a, b) {
  if (a.cron && !b.cron) return -1
  if (!a.cron && b.cron) return 1
  if (a.cron && b.cron) return (a.createdAt || 0) - (b.createdAt || 0)
  return (a.at || 0) - (b.at || 0)
}

/**
 * 调度记录 → 可读行（#定时任务列表 / #我的提醒 / 复用）。
 * 明确标注类型，避免"AI 创建了但列表看不到"的歧义：
 *  - [周期 cron] 周期任务链；[一次性任务 时间] 带 prompt 的一次性任务链；[提醒 时间] 静态提醒。
 */
export function formatScheduleList(list = []) {
  return (list || []).filter(Boolean).map((r) => {
    const id = `#${r.id}`
    const text = String(r.prompt || r.message || '').slice(0, 50)
    if (r.cron) return `${id} [周期 ${r.cron}] ${text}`
    const at = r.at ? new Date(r.at).toLocaleString('zh-CN') : '待定'
    if (r.type === 'task' || r.prompt) return `${id} [一次性任务 ${at}] ${text}`
    return `${id} [提醒 ${at}] ${text}`
  })
}

/**
 * 调度意图识别（纯函数，供 Agent 做"周期 vs 一次性"路由硬门）：
 * 命中「周期节律词 + 邻近调度动词」才判为 recurring——避免"每天都很累，提醒我早点睡"
 * 这类含周期词但并非周期任务请求的误判（逗号/句读处断开，不跨句匹配）。
 * 例：「每2小时给我最新网络热点」→ recurring；「中秋提醒我买斐济北」→ null。
 * @returns {'recurring'|null}
 */
const _CADENCE = '(?:每天|每日|每周|每星期|每月|每个?月|每年|每工作日|工作日|每\\s*隔?\\s*(?:\\d+|[一二两三四五六七八九十]+)?\\s*(?:秒|分钟|分|小时|钟头|天|日|周|星期|个月|月))'
const _SCHED_CUE = '(?:提醒|通知|发给我|发我|发送|发给|推送|播报|告诉我|给我|汇报|总结|同步|更新|监控|定时|任务|叫我|别忘|记得)'
const _RE_CAD_THEN_CUE = new RegExp(`${_CADENCE}[^，。；;！!？?\\n]{0,24}?${_SCHED_CUE}`)
const _RE_CUE_THEN_CAD = new RegExp(`${_SCHED_CUE}[^，。；;！!？?\\n]{0,24}?${_CADENCE}`)
export function detectScheduleIntent(text) {
  const s = String(text || '').trim()
  if (!s) return null
  if (_RE_CAD_THEN_CUE.test(s) || _RE_CUE_THEN_CAD.test(s)) return 'recurring'
  return null
}

// ── 自然语言 → cron 解析（全时间段；失败返回 null）──
const _CN_NUM = { '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 }
const _WEEK = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 }
// 中文时段偏移：下午/晚上 → +12（下午3=15）；凌晨/早上/上午/中午 → +0
const _PERIOD = { '凌晨': 0, '清晨': 0, '早上': 0, '早晨': 0, '上午': 0, '中午': 0, '下午': 12, '午后': 12, '傍晚': 12, '晚上': 12, '夜间': 12, '夜里': 12, '深夜': 12 }
const _PERIOD_RE = '(?:凌晨|清晨|早上|早晨|上午|中午|下午|午后|傍晚|晚上|夜间|夜里|深夜)'
const _HM = '\\d{1,2}(?::\\d{1,2}|点(?:\\d{1,2})?)?' // 时间：8 / 8:30 / 8点30 / 8点
function _cnNum(s) { if (s == null) return null; if (/^\d+$/.test(s)) return Number(s); return _CN_NUM[s] ?? null }
// "8" "8点" "8:30" "8点30" → [H, M]；period（下午/晚上）按 _PERIOD 偏移
function _hm(s, period) {
  const m = String(s || '').match(/^(\d{1,2})(?::(\d{1,2})|点(\d{1,2})?)?$/)
  if (!m) return null
  let h = Number(m[1]); const min = m[2] != null ? Number(m[2]) : (m[3] != null && m[3] !== '' ? Number(m[3]) : 0)
  if (period) h += (_PERIOD[period] || 0)
  if (h > 23 || min > 59) return null
  return [h, min]
}

/**
 * 自然语言时间 → 5 段 cron。支持：
 *   每[N]分钟/小时 | 每天H点[:M]（含中文时段：下午3/晚上8→+12）| 工作日H点 | 周X H点
 *   每月X号H点 | 每 N 天 H点 | 时间段（9点到18点每2小时）| 多时间点（8点和20点）
 *   裸时段H点（下午3点→每天15点）。中文数字兼容。失败返回 null。
 */
export function parseCron(text) {
  const t = String(text || '').trim().replace(/\s+/g, '')
  if (!t) return null
  let m
  // 每 N 分钟 / 每分钟
  if ((m = t.match(/^每(\d+|[一二两三四五六七八九十]+)?分钟$/))) { const n = m[1] ? (_cnNum(m[1]) || 1) : 1; return (n >= 1 && n <= 59) ? (n === 1 ? '* * * * *' : `*/${n} * * * *`) : null }
  // 每 N 小时 / 每小时
  if ((m = t.match(/^每(\d+|[一二两三四五六七八九十]+)?小时$/))) { const n = m[1] ? (_cnNum(m[1]) || 1) : 1; return (n >= 1 && n <= 23) ? (n === 1 ? '0 * * * *' : `0 */${n} * * *`) : null }
  // 时间段：H点(到|-|~)H点 每 N 小时（如 9点到18点每2小时 / 9-18点每2小时）
  if ((m = t.match(/^(\d{1,2})(?:点|:)?(?:到|-|—|~)(\d{1,2})(?:点|:)?每(\d+|[一二两三四五六七八九十]+)小时$/))) {
    const h1 = Number(m[1]), h2 = Number(m[2]), n = m[3] ? (_cnNum(m[3]) || 1) : 1
    if (h1 <= h2 && h2 <= 23 && n >= 1) return `0 ${h1}-${h2}/${n} * * *`
  }
  // 多时间点：H点(和/、/,)H点(…)，如 8点和20点 / 8点、14点、20点
  if (/^(?:每天)?\d{1,2}(?:点|:)\d{0,2}(?:(?:和|、|,)\d{1,2}(?:点|:)\d{0,2})+$/.test(t)) {
    const pts = [...t.matchAll(/(\d{1,2})(?:点|:)(\d{1,2})?/g)].map((x) => [Number(x[1]), x[2] ? Number(x[2]) : 0])
    if (pts.every(([h, mi]) => h <= 23 && mi <= 59)) {
      // 分钟相同 → 单条表达式即可（hours 列表语义正确）；
      // 分钟不同 → 5 段 cron **无法**表达 {(8,30),(20,15)} 这种配对（minute 与 hour 是笛卡尔积），
      // 曾直接拼 `30,15 8,20 * * *` 让实际触发变成 4 次。此处如实返回 null，
      // 由调用方提示用户拆成多条任务，绝不生成语义错误的表达式。
      const mins = [...new Set(pts.map((p) => p[1]))]
      if (mins.length === 1) {
        const hours = [...new Set(pts.map((p) => p[0]))].sort((a, b) => a - b).join(',')
        return `${mins[0]} ${hours} * * *`
      }
      return null
    }
  }
  // 每月X号[时段H点]（如 每月1号8点 / 每月15号下午3点）
  if ((m = t.match(new RegExp(`^每月(\\d{1,2})号?(${_PERIOD_RE})?(${_HM})?$`)))) {
    const day = Number(m[1]); const tm = _hm(m[3] || '0', m[2])
    if (day >= 1 && day <= 31 && tm) return `${tm[1]} ${tm[0]} ${day} * *`
  }
  // 每 N 天[时段H点]（如 每3天8点 / 每隔2天晚上9点）
  if ((m = t.match(new RegExp(`^每(?:隔)?(\\d+|[一二三四五六七八九十]+)天(${_PERIOD_RE})?(${_HM})?$`)))) {
    const n = _cnNum(m[1]) || 1; const tm = _hm(m[3] || '0', m[2])
    if (n >= 1 && n <= 31 && tm) return `${tm[1]} ${tm[0]} */${n} * *`
  }
  // 工作日[时段H点]
  if ((m = t.match(new RegExp(`^工作日(${_PERIOD_RE})?(${_HM})?$`)))) { const tm = _hm(m[2] || '0', m[1]); return tm ? `${tm[1]} ${tm[0]} * * 1-5` : null }
  // 每周X/周X/星期X + [时段H点]
  if ((m = t.match(new RegExp(`^(?:每周|周|星期)([日天一二三四五六])(${_PERIOD_RE})?(${_HM})?$`)))) { const w = _WEEK[m[1]]; const tm = _hm(m[3] || '0', m[2]); return (w != null && tm) ? `${tm[1]} ${tm[0]} * * ${w}` : null }
  // 每天 + [时段H点]
  if ((m = t.match(new RegExp(`^每天(${_PERIOD_RE})?(${_HM})?$`)))) { const tm = _hm(m[2] || '0', m[1]); return tm ? `${tm[1]} ${tm[0]} * * *` : null }
  // 裸时段H点（如 下午3点 / 晚上8点）→ 默认每天
  if ((m = t.match(new RegExp(`^(${_PERIOD_RE})(${_HM})$`)))) { const tm = _hm(m[2], m[1]); return tm ? `${tm[1]} ${tm[0]} * * *` : null }
  return null
}

/** 便利适配器：在 apps 里装配真实 node-schedule */
export async function nodeScheduleAdapter() {
  const mod = await import('node-schedule')
  const schedule = mod.default || mod
  return {
    scheduleJob(date, fn) { return schedule.scheduleJob(date, fn) },
    cancelJob(job) { job?.cancel?.() },
  }
}

/**
 * reminder_set 工具：让 AI 通过对话为当前用户设一次性提醒。
 * execute 调 ctx.reminder.add（由 apps 注入：绑定 rt.schedule + fireReminder + selfId）。
 * 时间由 LLM 推算成 ISO 8601（带时区），避免本库引入自然语言时间解析依赖。
 */
export const reminderSetTool = {
  name: 'reminder_set',
  description: '设置【一次性】提醒（只触发一次，不是周期任务）：N分钟后/3点/明天X点。只按【用户明确说出】的时间与意图设置；不要给自己写「自留提醒」，也不要把你的推断/计划/记忆当成用户交代的事（实机事故：模型把系统注入块里的身份描述当成「主人要求」，自行设了 8:00 提醒并写进长期记忆）。① 只填 message → 到点发静态提醒；② 填 prompt → 到点跑一次 Agent 任务并把结果发回。若用户要“每天/每周/每N小时”这类【周期重复】需求，不要用本工具——先用 tool_search 找到 schedule_task 并用它创建 cron 任务。at 是未来时间、ISO 8601 带时区（如 2026-08-06T15:05:00+08:00），由你根据用户措辞 + 当前时间（见【运行能力盘点】）推算。**必须带 evidence＝用户原话片段**（插件会核对是否真出现在用户消息里；系统注入块/长期记忆/你自己的推断都不能当证据）。',
  category: 'personal',
  parameters: {
    type: 'object',
    properties: {
      at: { type: 'string', description: '触发时间，ISO 8601 带时区（如 2026-08-06T15:05:00+08:00）；必须是未来时间' },
      evidence: { type: 'string', description: '用户原话片段（必填）：用户哪句话要求了这条提醒，原样贴入；插件会核对，对不上则拒绝创建' },
      message: { type: 'string', description: '模式①提醒内容（到点原样发送）。填了 prompt 时可留空或简短标题' },
      prompt: { type: 'string', description: '模式②可选：到点执行的任务描述（填则变任务链——到点 Agent 自主调工具完成 + 发结果）。如"搜索今日AI资讯并总结5条"' },
    },
    required: ['at', 'evidence'],
  },
  async execute(p, ctx) {
    const g = guardUserIntent({ evidence: p.evidence, userTexts: ctx?.userTexts, what: '一次性提醒' })
    if (g.error) return g
    const at = new Date(p.at)
    if (isNaN(at.getTime())) return { error: `无法解析时间「${p.at}」，请用 ISO 8601 带时区（如 2026-08-06T15:05:00+08:00）` }
    if (at.getTime() <= Date.now()) return { error: `时间「${p.at}」已过，须是未来时间` }
    if (!ctx?.reminder?.add) return { error: '定时服务未就绪' }
    const isTask = !!(p.prompt && String(p.prompt).trim())
    if (!isTask && !p.message) return { error: '需提供 message（提醒内容）或 prompt（到点任务）' }
    try {
      // 提醒归属始终按真实用户（与 yaml「提醒/笔记/人设始终按用户」一致，同 notes 工具口径）；
      // 旧版群共享记录（userId='__group__:*'）仍按 listByUser/ownsScheduleRecord 的兼容分支可见、可取消。
      const rec = await ctx.reminder.add({
        userId: ctx.userId || ctx.scopeUserId,
        groupId: ctx.groupId || null,
        selfId: ctx.selfId || '',
        at: at.getTime(),
        message: p.message || '',
        prompt: isTask ? String(p.prompt).trim() : null,
      })
      if (rec?.error) return rec // 排期失败（非法时间/服务不可用）不要让上层按成功回复
      return {
        ok: true, id: rec.id, at: at.toLocaleString('zh-CN'),
        note: isTask ? `已设一次性任务链，到点跑 Agent（${String(p.prompt).slice(0, 40)}）+ 发结果` : '已设提醒，到时间会主动发消息给用户',
      }
    } catch (e) {
      return { error: `设置失败：${e?.message || e}` }
    }
  },
}

/**
 * schedule_task 工具：LLM 通过对话创建 cron 重复任务链（到点跑 Agent + 发结果）。
 * category=system（master）+ alwaysConfirm（cron 重复烧 token + 主动发群，需主人审批）。
 * execute 调 ctx.cronTask.add（apps 注入：绑 rt.schedule.add + makeFireDispatch + parseCron）。
 */
export const scheduleTaskTool = {
  name: 'schedule_task',
  description: '创建 cron 重复定时任务链（到点自动跑 Agent 任务 + 把结果发到当前会话）。用户说"每天X点做YY/每N小时ZZ/工作日X点"等重复需求时用。只按【用户明确说出】的重复需求创建；不要凭自己的推断或计划替用户排期（若要为自己安排后续动作，请在回复里说明并征得同意）。**必须带 evidence＝用户原话片段**（插件会核对；系统注入块/长期记忆里的内容不能当证据）。时间用自然语言，到点由 Agent 自主调工具完成任务并发送结果。',
  category: 'system',
  meta: { summary: '创建定时任务链', alwaysConfirm: true },
  parameters: {
    type: 'object',
    properties: {
      when: { type: 'string', description: '触发时间，自然语言：每天8点 / 每2小时 / 工作日9点 / 每周一8点30 / 每30分钟' },
      evidence: { type: 'string', description: '用户原话片段（必填）：用户哪句话要求了这个周期任务，原样贴入；插件会核对' },
      prompt: { type: 'string', description: '到点执行的任务描述（Agent 自主调工具完成 + 发结果，如"搜索今日AI资讯并总结5条"）' },
    },
    required: ['when', 'prompt', 'evidence'],
  },
  async execute(p, ctx) {
    const g = guardUserIntent({ evidence: p.evidence, userTexts: ctx?.userTexts, what: '定时任务' })
    if (g.error) return g
    if (!ctx?.cronTask?.add) return { error: '定时任务服务未就绪' }
    try {
      const rec = await ctx.cronTask.add({ when: p.when, prompt: p.prompt })
      if (rec?.error) return rec
      return { ok: true, id: rec.id, cron: rec.cron, when: p.when, prompt: p.prompt, note: `已创建定时任务（${rec.cron}），到点跑 Agent + 发结果到本会话` }
    } catch (e) {
      return { error: `创建失败：${e?.message || e}` }
    }
  },
}

/**
 * reminder_list 工具：列出当前用户的所有提醒/定时任务。
 */
export const reminderListTool = {
  name: 'reminder_list',
  description: '查看当前用户的所有提醒和定时任务（包括一次性提醒和 cron 重复任务）。用户问"我有哪些提醒/定时任务"或需要取消前先查看时用。',
  category: 'personal',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_p, ctx) {
    try {
      // 归属按真实用户（ctx.userId 优先，群共享模式下也不再落到 '__group__' 作用域；与写入端一致）；
      // 同时兼容查询旧版群共享作用域（__group__:*）里的旧记录，避免升级后「已有提醒」从列表消失。
      // 带上 groupId：旧版无群号记录靠它判定归属（见 listByUser JSDoc）
      const uids = [...new Set([ctx?.userId, ctx?.scopeUserId].filter((x) => x != null && x !== '').map(String))]
      const reminders = []
      if (ctx?.reminder?.list) {
        const seen = new Set()
        for (const u of uids) {
          const list = await ctx.reminder.list(u, { groupId: ctx?.groupId || null })
          for (const r of list || []) {
            const k = String(r?.id)
            if (!seen.has(k)) { seen.add(k); reminders.push(r) }
          }
        }
      }
      const crons = ctx?.cronTask?.list ? await ctx.cronTask.list() : []
      const items = []
      for (const r of reminders) {
        const at = new Date(r.at).toLocaleString('zh-CN')
        items.push({ id: r.id, type: r.prompt ? '任务链' : '提醒', at, message: (r.message || r.prompt || '').slice(0, 60) })
      }
      for (const c of crons) {
        items.push({ id: c.id, type: 'cron重复', cron: c.cron, prompt: (c.prompt || '').slice(0, 60) })
      }
      if (!items.length) return { count: 0, note: '当前没有任何提醒或定时任务' }
      return { count: items.length, items }
    } catch (e) {
      return { error: `查询失败：${e?.message || e}` }
    }
  },
}

/**
 * reminder_cancel 工具：取消指定 id 的提醒或定时任务。
 */
export const reminderCancelTool = {
  name: 'reminder_cancel',
  description: '取消指定 id 的提醒或定时任务。用户说"取消我的提醒/定时任务"时用。id 从 reminder_list 获取。',
  category: 'personal',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '要取消的提醒/任务 id（从 reminder_list 获取）' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(p, ctx) {
    const id = String(p.id || '').trim()
    if (!id) return { error: '需要提供 id（从 reminder_list 获取）' }
    try {
      if (ctx?.reminder?.cancel) {
        const r = await ctx.reminder.cancel(id)
        if (r === true || r?.ok) return { ok: true, id, note: r?.note || '已取消提醒' }
      }
      if (ctx?.cronTask?.cancel) {
        const r = await ctx.cronTask.cancel(id)
        if (r === true || r?.ok) return { ok: true, id, note: r?.note || '已取消定时任务' }
      }
      return { error: `未找到 id=${id} 的提醒或定时任务。用 reminder_list 查看当前列表。` }
    } catch (e) {
      return { error: `取消失败：${e?.message || e}` }
    }
  },
}
