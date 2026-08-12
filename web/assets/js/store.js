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
    config: null, scopes: [], memories: {}, recall: {}, personas: [], skills: [], tools: [], kb: [],
    conversations: [], sessions: {}, logFiles: [], logFilesTotal: 0, schedules: [], confirms: [],
    suggestions: [], perceptions: [], tokenTrend: [], requestTrend: [], toolTop: [],
    totalRequests: 0, totalToolCalls: 0, totalTokens: 0,
  })

  const TOKEN_KEY = 'agents_token'
  const api = window.api = (() => {
    const BASE = '/api'
    const getToken = () => localStorage.getItem(TOKEN_KEY) || ''
    const setToken = (t) => { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY) }
    const request = async (method, p, { query, body } = {}) => {
      const url = BASE + p + (query ? '?' + new URLSearchParams(query).toString() : '')
      const opt = { method, headers: {} }
      const tk = getToken()
      if (tk) opt.headers.Authorization = 'Bearer ' + tk
      if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body) }
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
      put: (p, b) => request('PUT', p, { body: b }),
      del: (p) => request('DELETE', p),
      getToken, setToken,
    }
  })()

  // URL ?token= 落地到 localStorage（仅登录直跳用一次，落地后清 URL）
  window.storeLoginFromUrl = function () {
    const u = new URLSearchParams(location.search)
    const t = u.get('token')
    if (t) { api.setToken(t); history.replaceState(null, '', location.pathname + location.hash) }
    return !!t
  }

  // 各资源 loadX（视图 onMounted 按需调用；smoke 不触发 onMounted，故不影响冒烟）
  window.store = {
    MOCK,
    async loadConfig() { MOCK.config = await api.get('/config') },
    async loadScopes() { MOCK.scopes = await api.get('/scopes') },
    async loadTools() { MOCK.tools = await api.get('/tools') },
    async loadKb() { MOCK.kb = await api.get('/kb') },
    async loadMemories(scopeId) { MOCK.memories[scopeId] = await api.get('/memories', { scopeId }) },
    async loadRecall(userId) { MOCK.recall[userId] = await api.get('/recall', { userId }) },
    async loadPersonas() { MOCK.personas = await api.get('/personas') },
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
    async loadSuggestions(scopeId, status) { MOCK.suggestions = await api.get('/suggestions', { scopeId, status }) },
    async loadOverview() {
      const d = await api.get('/overview')
      MOCK.tokenTrend = d.tokenTrend; MOCK.requestTrend = d.requestTrend; MOCK.toolTop = d.toolTop
      MOCK.perceptions = d.perceptions
      MOCK.totalRequests = d.totalRequests || 0; MOCK.totalToolCalls = d.totalToolCalls || 0; MOCK.totalTokens = d.totalTokens || 0
      if (d.counts) MOCK.counts = d.counts
    },
  }
})()
