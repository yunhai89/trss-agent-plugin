/**
 * 一次性提醒 —— 经注入的 scheduler（默认 node-schedule 适配器）+ KV 持久化 + 重启恢复。
 * 对应 yunhai lib/agent/schedule.js。fire 回调由调用方注入（解耦 QQ 发送路径）。
 *
 * 库本体不 import node-schedule（保持离线可测）；apps 用 nodeScheduleAdapter() 装配，测试注入 fake scheduler。
 */

export class ScheduleStore {
  constructor({ kv, prefix = 'Yz:agent:rem:', scheduler } = {}) {
    if (!kv) throw new Error('ScheduleStore 需要 kv')
    if (!scheduler) throw new Error('ScheduleStore 需要 scheduler（{ scheduleJob(date, fn), cancelJob(job) }）')
    this.kv = kv
    this.prefix = prefix
    this.scheduler = scheduler
    this._jobs = new Map()
    this._seq = 0
  }

  _key() { return `${this.prefix}jobs` }
  async _load() { const v = await this.kv.get(this._key()); return Array.isArray(v) ? v : [] }
  async _save(arr) { await this.kv.set(this._key(), arr) }
  _nextId() { this._seq = (this._seq + 1) % 100000; return String(this._seq).padStart(5, '0') }

  async add(info, fire) {
    const arr = await this._load()
    const id = info.id || this._nextId()
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
    await this._save(arr)
    this._schedule(rec, fire)
    return rec
  }

  _schedule(rec, fire) {
    // cron → scheduleJob(cron) 周期触发，fire 后不 cancel（持续重复）
    // 无 cron → scheduleJob(Date) 一次性，fire 后 cancel
    const isCron = !!rec.cron
    const spec = isCron ? rec.cron : new Date(rec.at)
    const job = this.scheduler.scheduleJob(spec, async () => {
      try { await fire?.(rec) } catch { /* noop */ }
      if (!isCron) { try { await this.cancel(rec.id) } catch { /* noop */ } }
    })
    this._jobs.set(rec.id, { job, info: rec })
  }

  async cancel(id) {
    const j = this._jobs.get(id)
    if (j?.job) this.scheduler.cancelJob(j.job)
    this._jobs.delete(id)
    const arr = (await this._load()).filter((r) => r.id !== id)
    await this._save(arr)
  }

  async listByUser(userId) { return (await this._load()).filter((r) => r.userId === userId).sort(_sortRec) }
  async listAll() { return (await this._load()).sort(_sortRec) }

  /** 重启恢复：cron 任务始终重排（不过期）；一次性仅 at>now 重排，过期丢弃 */
  async restore(fire) {
    const arr = await this._load()
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

/** 列表排序：cron 重复任务排前（按 createdAt），一次性按 at 升序 */
function _sortRec(a, b) {
  if (a.cron && !b.cron) return -1
  if (!a.cron && b.cron) return 1
  if (a.cron && b.cron) return (a.createdAt || 0) - (b.createdAt || 0)
  return (a.at || 0) - (b.at || 0)
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
      const hours = [...new Set(pts.map((p) => p[0]))].sort((a, b) => a - b).join(',')
      const mins = [...new Set(pts.map((p) => p[1]))].sort((a, b) => a - b).join(',')
      return `${mins} ${hours} * * *`
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
  description: '设置一次性定时任务（N分钟后/3点/明天X点 触发一次）。两种模式：① 只填 message → 到点发静态提醒消息；② 填 prompt → 到点跑 Agent 任务链（自主调工具完成，如联网搜索/查知识库）+ 发结果。用户说"N分钟后提醒我XX"或"N分钟后帮我搜索YY/做ZZ"时用。at 是未来时间、ISO 8601 带时区（如 2026-08-06T15:05:00+08:00），由你根据用户措辞 + 当前时间（见【运行能力盘点】）推算。',
  category: 'personal',
  parameters: {
    type: 'object',
    properties: {
      at: { type: 'string', description: '触发时间，ISO 8601 带时区（如 2026-08-06T15:05:00+08:00）；必须是未来时间' },
      message: { type: 'string', description: '模式①提醒内容（到点原样发送）。填了 prompt 时可留空或简短标题' },
      prompt: { type: 'string', description: '模式②可选：到点执行的任务描述（填则变任务链——到点 Agent 自主调工具完成 + 发结果）。如"搜索今日AI资讯并总结5条"' },
    },
    required: ['at'],
  },
  async execute(p, ctx) {
    const at = new Date(p.at)
    if (isNaN(at.getTime())) return { error: `无法解析时间「${p.at}」，请用 ISO 8601 带时区（如 2026-08-06T15:05:00+08:00）` }
    if (at.getTime() <= Date.now()) return { error: `时间「${p.at}」已过，须是未来时间` }
    if (!ctx?.reminder?.add) return { error: '定时服务未就绪' }
    const isTask = !!(p.prompt && String(p.prompt).trim())
    if (!isTask && !p.message) return { error: '需提供 message（提醒内容）或 prompt（到点任务）' }
    try {
      const rec = await ctx.reminder.add({
        userId: ctx.scopeUserId,
        groupId: ctx.groupId || null,
        selfId: ctx.selfId || '',
        at: at.getTime(),
        message: p.message || '',
        prompt: isTask ? String(p.prompt).trim() : null,
      })
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
  description: '创建 cron 重复定时任务链（到点自动跑 Agent 任务 + 把结果发到当前会话）。用户说"每天X点做YY/每N小时ZZ/工作日X点"等重复需求时用。时间用自然语言，到点由 Agent 自主调工具完成任务并发送结果。',
  category: 'system',
  meta: { summary: '创建定时任务链', alwaysConfirm: true },
  parameters: {
    type: 'object',
    properties: {
      when: { type: 'string', description: '触发时间，自然语言：每天8点 / 每2小时 / 工作日9点 / 每周一8点30 / 每30分钟' },
      prompt: { type: 'string', description: '到点执行的任务描述（Agent 自主调工具完成 + 发结果，如"搜索今日AI资讯并总结5条"）' },
    },
    required: ['when', 'prompt'],
  },
  async execute(p, ctx) {
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
      const reminders = ctx?.reminder?.list ? await ctx.reminder.list(ctx.scopeUserId) : []
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
        const ok = await ctx.reminder.cancel(id)
        if (ok) return { ok: true, id, note: '已取消提醒' }
      }
      if (ctx?.cronTask?.cancel) {
        const ok = await ctx.cronTask.cancel(id)
        if (ok) return { ok: true, id, note: '已取消定时任务' }
      }
      return { error: `未找到 id=${id} 的提醒或定时任务。用 reminder_list 查看当前列表。` }
    } catch (e) {
      return { error: `取消失败：${e?.message || e}` }
    }
  },
}
