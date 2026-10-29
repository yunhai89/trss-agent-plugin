/**
 * QQBot 账号读写（Web「账号」页面 / API 共用；纯函数，离线可测）。
 *
 * 配置里账号有两种写法：
 *  - `agent.qqBot.accounts[]`：多账号（推荐）
 *  - `agent.qqBot.appId/appSecret`：扁平单账号（历史写法，仍支持）
 * 本模块把它们统一成列表；任何写操作都会先把扁平写法迁进 accounts[]，
 * 避免「面板改了但运行时读的仍是旧扁平字段」这类双真源问题。
 *
 * 安全：对外输出永不含 appSecret（只给 hasSecret / secretMasked）。
 */

const ALLOWED_MARKDOWN = new Set(['auto', 'true', 'false'])

function str(v, max = 200) {
  return v == null ? '' : String(v).trim().slice(0, max)
}

function bool(v, dft = false) {
  if (v === undefined) return dft
  return v === true || v === 'true' || v === 1 || v === '1'
}

function normIntents(v, dft = 0) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return dft
  return Math.floor(n)
}

function normMarkdown(v, dft = 'auto') {
  if (v === true) return 'true'
  if (v === false) return 'false'
  const s = String(v ?? '').trim().toLowerCase()
  return ALLOWED_MARKDOWN.has(s) ? s : dft
}

/** 账号对象的可写字段（appId 是主键，不允许改） */
const EDITABLE = ['name', 'appSecret', 'sandbox', 'intents', 'markdown', 'preferMarkdownText', 'apiBase', 'tokenUrl']

/** 扁平单账号 → 账号条目（source=flat 仅用于展示，不落盘） */
function flatAccount(qq) {
  if (!qq || !str(qq.appId)) return null
  return {
    appId: str(qq.appId),
    appSecret: str(qq.appSecret, 400),
    name: str(qq.name) || str(qq.appId),
    sandbox: bool(qq.sandbox),
    intents: normIntents(qq.intents, 0),
    markdown: normMarkdown(qq.markdown, 'auto'),
    preferMarkdownText: bool(qq.preferMarkdownText),
    apiBase: str(qq.apiBase, 300),
    tokenUrl: str(qq.tokenUrl, 300),
    source: 'flat',
  }
}

/**
 * 读账号列表（不修改配置）。
 * @param {object} agentCfg agent 配置块
 * @returns {Array<object>}
 */
export function listAccounts(agentCfg = {}) {
  const qq = agentCfg?.qqBot || {}
  const arr = Array.isArray(qq.accounts) ? qq.accounts : []
  const out = []
  const seen = new Set()
  for (const a of arr) {
    if (!a || typeof a !== 'object') continue
    const appId = str(a.appId ?? a.appid)
    if (!appId || seen.has(appId)) continue
    seen.add(appId)
    out.push({
      appId,
      appSecret: str(a.appSecret ?? a.secret ?? a.clientSecret, 400),
      name: str(a.name) || appId,
      sandbox: bool(a.sandbox),
      intents: normIntents(a.intents, 0),
      markdown: normMarkdown(a.markdown, 'auto'),
      preferMarkdownText: bool(a.preferMarkdownText),
      apiBase: str(a.apiBase, 300),
      tokenUrl: str(a.tokenUrl, 300),
      source: 'accounts',
    })
  }
  if (!out.length) {
    const flat = flatAccount(qq)
    if (flat) out.push(flat)
  }
  return out
}

/**
 * 写前归一：把扁平写法迁进 accounts[] 并清掉扁平字段（幂等）。
 * @returns {boolean} 是否发生修改
 */
export function normalizeAccountsConfig(agentCfg = {}) {
  if (!agentCfg || typeof agentCfg !== 'object') return false
  const qq = agentCfg.qqBot = (agentCfg.qqBot && typeof agentCfg.qqBot === 'object') ? agentCfg.qqBot : {}
  if (!Array.isArray(qq.accounts)) qq.accounts = []
  let dirty = false
  const flat = flatAccount(qq)
  if (flat) {
    const exists = qq.accounts.some((a) => a && str(a.appId ?? a.appid) === flat.appId)
    if (!exists) {
      const { source, ...entry } = flat
      qq.accounts.push(entry)
      dirty = true
    }
    for (const k of ['appId', 'appSecret', 'name', 'sandbox', 'intents', 'markdown', 'preferMarkdownText', 'apiBase', 'tokenUrl']) {
      if (k in qq) { delete qq[k]; dirty = true }
    }
  }
  return dirty
}

/**
 * 新增或更新账号。
 * @param {object} agentCfg agent 配置块（会被就地修改）
 * @param {object} input { appId, appSecret?, name?, sandbox?, intents?, markdown?, preferMarkdownText?, apiBase?, tokenUrl? }
 * @returns {{ok:true, account:object, created:boolean}|{ok:false, error:string}}
 */
export function upsertAccount(agentCfg, input = {}) {
  if (!agentCfg || typeof agentCfg !== 'object') return { ok: false, error: '配置未就绪' }
  const appId = str(input.appId ?? input.appid)
  if (!appId) return { ok: false, error: '缺少 appId（QQ 开放平台 → 开发设置 → 机器人 AppID）' }
  if (!/^\d{4,}$/.test(appId)) return { ok: false, error: `appId「${appId}」格式不像 QQ 机器人 AppID（应为纯数字）` }
  const qq = agentCfg.qqBot = (agentCfg.qqBot && typeof agentCfg.qqBot === 'object') ? agentCfg.qqBot : {}
  normalizeAccountsConfig(agentCfg)
  if (!Array.isArray(qq.accounts)) qq.accounts = []

  const idx = qq.accounts.findIndex((a) => a && str(a.appId ?? a.appid) === appId)
  const created = idx < 0
  let account
  if (created) {
    const appSecret = str(input.appSecret, 400)
    if (!appSecret) return { ok: false, error: '新增账号必须填 appSecret（AppSecret 只保存，不会回显）' }
    account = { appId, appSecret }
    qq.accounts.push(account)
  } else {
    account = qq.accounts[idx]
    account.appId = appId
  }
  // 逐字段更新（appSecret 传空=保持原值，兼容「编辑时不改密钥」）
  for (const k of EDITABLE) {
    if (!(k in (input || {}))) continue
    if (k === 'appSecret') {
      const v = str(input.appSecret, 400)
      if (v) account.appSecret = v
      continue
    }
    if (k === 'sandbox') account.sandbox = bool(input.sandbox, bool(account.sandbox))
    else if (k === 'preferMarkdownText') account.preferMarkdownText = bool(input.preferMarkdownText, bool(account.preferMarkdownText))
    else if (k === 'intents') account.intents = normIntents(input.intents, normIntents(account.intents, 0))
    else if (k === 'markdown') account.markdown = normMarkdown(input.markdown, normMarkdown(account.markdown, 'auto'))
    else account[k] = str(input[k], k === 'name' ? 100 : 300)
  }
  if (!account.name) account.name = appId
  qq.enable = true // 加账号即视为要启用
  return { ok: true, account: { ...account, source: 'accounts' }, created }
}

/**
 * 删除账号。
 * @returns {{ok:boolean, removed:boolean}}
 */
export function removeAccount(agentCfg, appId) {
  const id = str(appId)
  if (!agentCfg || !id) return { ok: false, removed: false }
  const qq = agentCfg.qqBot = (agentCfg.qqBot && typeof agentCfg.qqBot === 'object') ? agentCfg.qqBot : {}
  normalizeAccountsConfig(agentCfg)
  const before = Array.isArray(qq.accounts) ? qq.accounts.length : 0
  qq.accounts = (Array.isArray(qq.accounts) ? qq.accounts : []).filter((a) => !(a && str(a.appId ?? a.appid) === id))
  return { ok: true, removed: qq.accounts.length < before }
}

/**
 * 对外安全视图：不含 appSecret 明文，只给掩码与是否已配置。
 */
export function publicAccount(account = {}, status = null) {
  const secret = str(account.appSecret, 400)
  const tail = secret.length > 6 ? secret.slice(-4) : ''
  return {
    appId: str(account.appId),
    name: str(account.name) || str(account.appId),
    sandbox: bool(account.sandbox),
    intents: normIntents(account.intents, 0),
    markdown: normMarkdown(account.markdown, 'auto'),
    preferMarkdownText: bool(account.preferMarkdownText),
    apiBase: str(account.apiBase, 300),
    tokenUrl: str(account.tokenUrl, 300),
    source: account.source || 'accounts',
    hasSecret: !!secret,
    secretMasked: secret ? `••••••••${tail}` : '',
    status: status || null,
  }
}

/**
 * 兼容适配器 normalizeAccounts 的条目形状（appSecret/name/sandbox/intents/...）。
 */
export function toAdapterAccount(account = {}) {
  return {
    appId: str(account.appId),
    appSecret: str(account.appSecret, 400),
    name: str(account.name) || str(account.appId),
    sandbox: bool(account.sandbox),
    intents: normIntents(account.intents, 0),
    markdown: normMarkdown(account.markdown, 'auto'),
    preferMarkdownText: bool(account.preferMarkdownText),
    apiBase: str(account.apiBase, 300),
    tokenUrl: str(account.tokenUrl, 300),
  }
}

export default { listAccounts, normalizeAccountsConfig, upsertAccount, removeAccount, publicAccount, toAdapterAccount }
