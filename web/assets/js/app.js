/**
 * 应用外壳:hash 路由 + 侧边栏 + 顶栏 + 登录态
 */
(function () {
  const { createApp, ref, computed, onMounted } = Vue

  const NAV = [
    { group: '总览', items: [{ id: 'dashboard', name: '概览', icon: 'dashboard' }] },
    {
      group: '数据中心', items: [
        { id: 'memory', name: '声明式记忆', icon: 'memory' },
        { id: 'recall', name: '长期记忆', icon: 'recall' },
        { id: 'personas', name: '人设库', icon: 'persona' },
        { id: 'skills', name: '技能', icon: 'skill' },
        { id: 'kb', name: '知识库', icon: 'skill' },
        { id: 'sessions', name: '会话回放', icon: 'session' },
        { id: 'logs', name: '日志时间线', icon: 'log' },
      ],
    },
    {
      group: '运行时', items: [
        { id: 'schedule', name: '定时任务', icon: 'schedule' },
        { id: 'confirm', name: '审批门', icon: 'confirm', badge: () => (window.MOCK?.confirms || []).length },
        { id: 'suggestions', name: '进化建议', icon: 'evolution', badge: () => (window.MOCK?.suggestions || []).filter((s) => s.status === 'pending').length },
        { id: 'evolution', name: '工具进化', icon: 'tool', badge: () => (window.MOCK?.tevoTools || []).filter((v) => v.status === 'verified').length },
      ],
    },
    { group: '系统', items: [{ id: 'config', name: '配置中心', icon: 'config' }, { id: 'humanize', name: '伪人模式', icon: 'group' }] },
  ]
  const TITLES = {
    dashboard: ['概览', '插件运行状态与核心指标'],
    memory: ['声明式记忆', 'MEMORY.md / USER.md · 按 scope 隔离'],
    recall: ['长期记忆', 'LLM 抽取沉淀 · L2/L3/L4 分层'],
    personas: ['人设库', '内置 + 自定义人设'],
    skills: ['技能', 'skills/*.md · 按需/常驻注入'],
    kb: ['知识库', '全局文档库 · embedding RAG'],
    sessions: ['会话回放', '对话列表与消息历史'],
    logs: ['日志时间线', 'devLog 全链路 · traceId 串联'],
    schedule: ['定时任务', '到点投递提醒'],
    confirm: ['审批门', '高危工具人工把关'],
    suggestions: ['进化建议', '自评审产出的待审改进项'],
    evolution: ['工具进化', 'Tool Evolution · 候选生成/验证/审批/版本'],
    config: ['配置中心', 'config.yaml 全量配置项'],
    humanize: ['伪人模式', '群聊环境参与者 · 旁听/门控/决策/发送'],
  }

  const App = {
    name: 'App',
    setup() {
      const route = ref((location.hash || '#/dashboard').slice(2))
      const valid = computed(() => !!window.VIEWS[route.value])
      if (!valid.value) route.value = 'dashboard'
      const navOpen = ref(false) // 移动端抽屉
      window.addEventListener('hashchange', () => {
        const r = location.hash.slice(2)
        route.value = window.VIEWS[r] ? r : 'dashboard'
        window.scrollTo({ top: 0 })
      })
      const go = (id) => { location.hash = '#/' + id; navOpen.value = false }
      const view = computed(() => window.VIEWS[route.value])
      const title = computed(() => TITLES[route.value] || ['', ''])

      // 登录态：URL ?token= 落地 → localStorage；无 token 显示登录框
      const loggedIn = ref(false)
      try {
        if (typeof window.storeLoginFromUrl === 'function' && window.storeLoginFromUrl()) loggedIn.value = true
        else if (window.api?.getToken?.()) loggedIn.value = true
      } catch { /* noop */ }
      window.addEventListener('agents-need-login', () => { loggedIn.value = false })
      const loginInput = ref('')
      const doLogin = async () => {
        const t = loginInput.value.trim()
        if (!t) return
        window.api.setToken(t)
        try { await window.store.loadScopes(); loggedIn.value = true }
        catch (e) { window.api.setToken(''); alert('登录失败：' + (e?.message || e)) }
      }

      onMounted(async () => {
        if (!loggedIn.value) return
        try { await window.store.loadScopes() } catch { /* 未登录或运行时未就绪，各页 load 时再处理 */ }
      })

      return { route, go, view, title, NAV, navOpen, loggedIn, loginInput, doLogin }
    },
    template: `
    <div v-if="!loggedIn" class="login-wrap">
      <div class="login-card">
        <div class="brand-mark" style="width:48px;height:48px;font-size:26px"><v-icon name="bot"/></div>
        <h2 style="margin:14px 0 4px">agents-plugin 管理面板</h2>
        <p style="color:var(--muted,#888);font-size:13px;margin:0 0 16px">私聊 bot 发送 <b>#agents登录</b>，将返回的 token 粘贴到下方</p>
        <input v-model="loginInput" placeholder="粘贴登录 token" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--border,#ddd);border-radius:8px;font-size:14px;margin-bottom:12px" @keyup.enter="doLogin"/>
        <button style="width:100%;padding:10px;background:var(--brand,#6366f1);color:#fff;border:0;border-radius:8px;font-size:14px;cursor:pointer" @click="doLogin">登录</button>
      </div>
    </div>
    <div v-else class="layout">
      <!-- 侧边栏(移动端为抽屉) -->
      <aside class="sidebar" :class="{open: navOpen}">
        <div class="side-brand">
          <div class="brand-mark"><v-icon name="bot"/></div>
          <div>
            <div class="brand-name">agents-plugin</div>
            <div class="brand-sub">AI Agents 管理面板</div>
          </div>
          <button class="modal-x" style="margin-left:auto" @click="navOpen = false"><v-icon name="x"/></button>
        </div>
        <nav class="side-nav">
          <template v-for="g in NAV" :key="g.group">
            <div class="nav-group-label">{{ g.group }}</div>
            <div v-for="it in g.items" :key="it.id" class="nav-item" :class="{active: route === it.id}" @click="go(it.id)">
              <v-icon :name="it.icon"/><span>{{ it.name }}</span>
              <span v-if="it.badge && it.badge()" class="nav-badge">{{ it.badge() }}</span>
            </div>
          </template>
        </nav>
        <div class="side-foot"><span class="dot"></span>TRSS-Yunzai · 插件运行中</div>
      </aside>
      <Transition name="fade">
        <div v-if="navOpen" class="side-backdrop" @click="navOpen = false"></div>
      </Transition>

      <!-- 主区 -->
      <div class="main">
        <header class="topbar">
          <button class="nav-burger" @click="navOpen = true"><v-icon name="menu"/></button>
          <div>
            <div class="topbar-title">{{ title[0] }}</div>
            <div class="topbar-sub">{{ title[1] }}</div>
          </div>
          <div class="topbar-right">
            <button class="topbar-btn" @click="loggedIn = false; window.api && window.api.setToken('')" title="退出登录">退出</button>
          </div>
        </header>
        <main class="page">
          <Transition name="page" mode="out-in">
            <component :is="view" :key="route"/>
          </Transition>
        </main>
      </div>
      <toast-host/>
    </div>`,
  }

  const app = createApp(App)
  window.UI.register(app)
  app.mount('#app')
})()
