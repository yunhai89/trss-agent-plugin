/**
 * 数据层：fetch 驱动的响应式 store（生产用，取代 mock.js 的静态假数据）。
 * 形态与 mock.js 完全一致（window.MOCK = Vue.reactive），视图 `const M = window.MOCK` 无需改动。
 * 仅 index.html 加载本文件；smoke.mjs 仍用 mock.js（不加载本文件），两者互不影响。
 *
 * 鉴权：URL ?token= → localStorage → 请求带 Authorization Bearer；4010 清 token + 通知 app 显示登录。
 */
;(function () {
  const { reactive } = Vue

  // 覆盖为空 reactive（mock.js 若已加载则被覆盖；视图读取零改动，loadX 后填充）
  const MOCK = window.MOCK = reactive({
    config: null, scopes: [], memories: {}, recall: {}, profile: {}, personas: [], personaLore: [], skills: [], tools: [], toolPacks: [], kb: [],
    conversations: [], sessions: {}, logFiles: [], logFilesTotal: 0, schedules: [], confirms: [], personaAdoptions: [],
    suggestions: [], perceptions: [], tokenTrend: [], requestTrend: [], toolTop: [],
    totalRequests: 0, totalToolCalls: 0, totalTokens: 0,
    stickerLib: null, tts: null,
  })

  const TOKEN_KEY = 'agents_token'
  /** 合法 token 形态：随机 hex/urlsafe（#agent登录 48 hex；控制台令牌同） */
  const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/

  /**
   * 归一化登录 token：允许直接粘贴**整条登录地址**或带中文的整段消息。
   *
   * 背景（线上故障）：用户把 `#agent登录` 返回的整段内容（含「🌐 公网地址：」等中文）粘进登录框，
   * 旧代码原样存进 localStorage 并塞进 Authorization 头 → 浏览器直接抛
   * `Failed to execute 'fetch' ... String contains non ISO-8859-1 code point`，
   * 之后每个页面（人设库等）的所有接口都失败。
   * @param {any} raw 用户输入/URL 参数
   * @returns {string} 合法 token；非法返回空串
   */
  function normalizeToken(raw) {
    let s = String(raw ?? '').trim()
    if (!s) return ''
    // 整条登录地址：取 ?token= / &token= 参数（URL 编码的也还原）
    const m = s.match(/[?&#]token=([^&#\s]+)/i)
    if (m) {
      try { s = decodeURIComponent(m[1]) } catch { s = m[1] }
      s = s.trim()
    }
    // 粘贴文本里 token 前后可能有引号/中文标点：只保留合法字符段
    if (!TOKEN_RE.test(s)) {
      const hit = s.match(/[A-Za-z0-9_-]{16,128}/)
      s = hit ? hit[0] : ''
    }
    return TOKEN_RE.test(s) ? s : ''
  }

  const api = window.api = (() => {
    const BASE = '/api'
    const getToken = () => localStorage.getItem(TOKEN_KEY) || ''
    const setToken = (t) => {
      const v = normalizeToken(t)
      if (v) localStorage.setItem(TOKEN_KEY, v)
      else localStorage.removeItem(TOKEN_KEY)
      return v
    }
    const request = async (method, p, { query, body, raw } = {}) => {
      // 只拼接有值的查询参数：跳过 null/undefined（否则 new URLSearchParams 会写成字面量
      // "scopeId=undefined"，后端当有效值过滤 → 结果恒空）。空字符串仍保留（语义可能与缺省不同）。
      let qs = ''
      if (query) {
        const sp = new URLSearchParams()
        for (const [k, v] of Object.entries(query)) { if (v != null) sp.append(k, String(v)) }
        qs = sp.toString()
      }
      const url = BASE + p + (qs ? '?' + qs : '')
      const opt = { method, headers: {} }
      // 读取时再归一一次：旧版本可能把中文/整段消息存进了 localStorage，
      // 直接拼进 Authorization 会让 fetch 抛 ISO-8859-1 错误（所有页面全挂）。
      const rawTok = getToken()
      const tk = normalizeToken(rawTok)
      if (rawTok && tk !== rawTok) setToken(tk) // 自愈：能归一就写回归一值，不能归一（空）就清掉
      if (tk) opt.headers.Authorization = 'Bearer ' + tk
      if (raw && raw.body !== undefined) {
        // 二进制直传（参考音频等）：Content-Type 用文件自身类型
        opt.headers['Content-Type'] = raw.type || 'application/octet-stream'
        opt.body = raw.body
      } else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body) }
      let r
      try { r = await fetch(url, opt) }
      catch (e) { throw new Error('网络错误：' + (e?.message || e)) }
      const j = await r.json().catch(() => ({ code: 5000, msg: '响应非 JSON' }))
      if (j.code === 4010) {
        setToken('')
        try { window.dispatchEvent(new Event('agents-need-login')) } catch { /* noop */ }
        throw new Error(j.msg || '未登录')
      }
      if (j.code !== 0) throw new Error(j.msg || ('错误码 ' + j.code))
      return j.data
    }
    return {
      get: (p, q) => request('GET', p, { query: q }),
      post: (p, b) => request('POST', p, { body: b }),
      // 二进制直传（参考音频等）：body 为 File/Blob，服务端对应 raw body 路由
      postRaw: (p, body, q) => request('POST', p, { query: q, raw: { body, type: body?.type } }),
      put: (p, b) => request('PUT', p, { body: b }),
      del: (p) => request('DELETE', p),
      getToken, setToken, normalizeToken,
    }
  })()

  // URL ?token= 落地到 localStorage（仅登录直跳用一次，落地后清 URL）
  window.storeLoginFromUrl = function () {
    const u = new URLSearchParams(location.search)
    const t = api.normalizeToken(u.get('token') || '')
    if (t) { api.setToken(t); history.replaceState(null, '', location.pathname + location.hash) }
    return !!t
  }

  // 各资源 loadX（视图 onMounted 按需调用；smoke 不触发 onMounted，故不影响冒烟）
  window.store = {
    MOCK,
    async loadConfig() { MOCK.config = await api.get('/config') },
    async loadStickerLib() { MOCK.stickerLib = await api.get('/sticker') },
    async loadScopes() { MOCK.scopes = await api.get('/scopes') },
    async loadTools() { MOCK.tools = await api.get('/tools') },
    async loadToolPacks() { MOCK.toolPacks = await api.get('/tool-packs'); return MOCK.toolPacks },
    async loadKb() { MOCK.kb = await api.get('/kb') },
    async loadMemories(scopeId) { MOCK.memories[scopeId] = await api.get('/memories', { scopeId }) },
    async loadRecall(userId) { MOCK.recall[userId] = await api.get('/recall', { userId }) },
    async loadProfile(userId) { MOCK.profile[userId] = await api.get('/profile', { userId }) },
    async loadPersonas() { MOCK.personas = await api.get('/personas') },
    async loadPersonaLore() { MOCK.personaLore = await api.get('/persona-lore') },
    async loadSkills() { MOCK.skills = await api.get('/skills') },
    async loadConversations(userId, groupId) { MOCK.conversations = userId ? await api.get('/conversations', { userId, groupId }) : await api.get('/conversations') },
    async loadSession(convId, userId, groupId) { MOCK.sessions[convId] = await api.get('/sessions', { convId, userId, groupId }) },
    async loadLogFiles(query) {
      const d = await api.get('/logs/files', query)
      MOCK.logFiles = (d.items || []).map((f) => ({ ...f, events: [] }))
      MOCK.logFilesTotal = d.total ?? MOCK.logFiles.length
    },
    async loadLogEvents(file) {
      const d = await api.get('/logs', { file })
      const i = MOCK.logFiles.findIndex((f) => f.file === file)
      if (i >= 0) MOCK.logFiles[i].events = d.events
      return d
    },
    async loadSchedule() { MOCK.schedules = await api.get('/schedule') },
    async loadConfirm() { MOCK.confirms = await api.get('/confirm') },
    async loadPersonaAdoptions(status) { MOCK.personaAdoptions = await api.get('/persona-adoptions', status ? { status } : undefined) },
    async loadSuggestions(scopeId, status) { MOCK.suggestions = await api.get('/suggestions', { scopeId, status }) },
    async loadOverview(query = {}) {
      const d = await api.get('/overview', query)
      MOCK.tokenTrend = d.tokenTrend; MOCK.requestTrend = d.requestTrend; MOCK.toolTop = d.toolTop
      MOCK.cache = d.cache || null
      MOCK.perceptions = d.perceptions
      MOCK.totalRequests = d.totalRequests || 0; MOCK.totalToolCalls = d.totalToolCalls || 0; MOCK.totalTokens = d.totalTokens || 0
      // 工具成功/失败/成功率与数据源标记（后端 /api/overview 已返回）。
      // 曾漏拷这四个字段 → 概览页「异常」恒 0、成功率恒「暂无」、KV 明细块永不渲染。
      // 注意 null 与 0 语义不同：null = 尚无 KV 数据（显示「暂无」），0 = 真实为零。
      MOCK.toolOk = d.toolOk ?? null
      MOCK.toolFail = d.toolFail ?? null
      MOCK.toolSuccessRate = d.toolSuccessRate ?? null
      MOCK.toolFailRate = d.toolFailRate ?? null
      MOCK.statsSource = d.statsSource || 'log'
      if (d.counts) MOCK.counts = d.counts
    },
  }
})()
