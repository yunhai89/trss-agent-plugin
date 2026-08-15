/**
 * 应用外壳:hash 路由 + PC 悬浮侧栏 / 移动端顶条 + 底部 Dock + 登录态
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
        { id: 'kb', name: '知识库', icon: 'book' },
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
    { group: '系统', items: [{ id: 'config', name: '配置中心', icon: 'config' }, { id: 'humanize', name: '伪人模式', icon: 'group' }, { id: 'groupworld', name: '群聊小世界', icon: 'globe' }, { id: 'selfstate', name: '自我状态', icon: 'bot' }, { id: 'sticker', name: '表情包', icon: 'smile' }] },
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
    groupworld: ['群聊小世界', '群聊社会记忆层 · 画像/关系/事件/圈子'],
    selfstate: ['自我状态', '自我认知与情绪 · 心境/情绪/期待/心事'],
    sticker: ['表情包', '配置 + 库概览 · 发送策略 / 自动发现'],
  }
  /* 移动端底部 Dock:四个常用 + 更多 */
  const DOCK = [
    { id: 'dashboard', name: '概览', icon: 'home' },
    { id: 'memory', name: '记忆', icon: 'memory' },
    { id: 'sessions', name: '会话', icon: 'session' },
    { id: 'confirm', name: '审批', icon: 'confirm', badge: () => (window.MOCK?.confirms || []).length },
  ]

  const App = {
    name: 'App',
    setup() {
      const route = ref((location.hash || '#/dashboard').slice(2))
      const valid = computed(() => !!window.VIEWS[route.value])
      if (!valid.value) route.value = 'dashboard'
      const menuOpen = ref(false) // 移动端全屏菜单
      window.addEventListener('hashchange', () => {
        const r = location.hash.slice(2)
        route.value = window.VIEWS[r] ? r : 'dashboard'
        menuOpen.value = false
        window.scrollTo({ top: 0 })
      })
      const go = (id) => { location.hash = '#/' + id; menuOpen.value = false }
      const view = computed(() => window.VIEWS[route.value])
      const title = computed(() => TITLES[route.value] || ['', ''])
      const group = computed(() => (NAV.find((g) => g.items.some((it) => it.id === route.value)) || {}).group || '')

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
      const logout = () => { loggedIn.value = false; window.api && window.api.setToken('') }

      onMounted(async () => {
        if (!loggedIn.value) return
        try { await window.store.loadScopes() } catch { /* 未登录或运行时未就绪，各页 load 时再处理 */ }
      })

      return { route, go, view, title, group, NAV, DOCK, menuOpen, loggedIn, loginInput, doLogin, logout }
    },
    template: `
    <div v-if="!loggedIn" class="login-wrap">
      <div class="login-card">
        <div class="login-logo"><v-icon name="bot"/></div>
        <h2 style="margin:16px 0 4px;font-size:20px">agents-plugin <span class="grad-t">管理面板</span></h2>
        <p class="mut2" style="font-size:12.5px;margin:0 0 18px">私聊 bot 发送 <b>#agents登录</b>，将返回的 token 粘贴到下方</p>
        <input class="inp" v-model="loginInput" placeholder="粘贴登录 token" style="margin-bottom:12px;text-align:left" @keyup.enter="doLogin"/>
        <button class="btn b-pri" style="width:100%;padding:11px" @click="doLogin"><v-icon name="key"/>登 录</button>
      </div>
    </div>
    <div v-else class="shell">
      <!-- PC 悬浮侧栏 -->
      <aside class="rail">
        <div class="rail-head">
          <div class="brand-badge"><v-icon name="bot"/></div>
          <div>
            <div class="brand-t grad-t">agents-plugin</div>
            <div class="brand-s">AI Agents 管理面板</div>
          </div>
        </div>
        <nav class="rail-nav">
          <template v-for="g in NAV" :key="g.group">
            <div class="nav-sec">{{ g.group }}</div>
            <div v-for="it in g.items" :key="it.id" class="nav-link" :class="{on: route === it.id}" @click="go(it.id)">
              <v-icon :name="it.icon"/><span>{{ it.name }}</span>
              <span v-if="it.badge && it.badge()" class="nav-badge">{{ it.badge() }}</span>
            </div>
          </template>
        </nav>
        <div class="rail-foot"><span class="st-dot"></span>TRSS-Yunzai · 插件运行中</div>
      </aside>

      <div class="stage">
        <!-- PC 胶囊顶栏 -->
        <header class="bar">
          <div>
            <div class="bar-ts">{{ group }}</div>
            <div class="bar-tt">{{ title[0] }}</div>
          </div>
          <div class="bar-acts">
            <span class="pill p-mint"><span class="st-dot"></span>运行中</span>
            <button class="bar-btn" @click="logout" title="退出登录"><v-icon name="logout"/>退出</button>
          </div>
        </header>
        <!-- 移动端顶条 -->
        <header class="m-top">
          <div class="brand-badge"><v-icon name="bot"/></div>
          <div>
            <div class="mut2" style="font-size:10.5px;line-height:1.2">{{ group }}</div>
            <div class="m-tt">{{ title[0] }}</div>
          </div>
          <button class="m-x" @click="logout" title="退出登录"><v-icon name="logout"/></button>
        </header>
        <main class="page">
          <Transition name="page" mode="out-in">
            <component :is="view" :key="route"/>
          </Transition>
        </main>
      </div>

      <!-- 移动端底部 Dock -->
      <nav class="dock">
        <div v-for="d in DOCK" :key="d.id" class="dock-i" :class="{on: route === d.id}" @click="go(d.id)">
          <span v-if="d.badge && d.badge()" class="dock-badge">{{ d.badge() }}</span>
          <v-icon :name="d.icon"/><span>{{ d.name }}</span>
        </div>
        <div class="dock-i" :class="{on: menuOpen}" @click="menuOpen = !menuOpen">
          <v-icon name="grid"/><span>更多</span>
        </div>
      </nav>
      <!-- 移动端全屏菜单 -->
      <Transition name="fade">
        <div v-if="menuOpen" class="sheet-back" @click="menuOpen = false"></div>
      </Transition>
      <div v-if="menuOpen" class="sheet">
        <div class="sheet-grip"></div>
        <template v-for="g in NAV" :key="g.group">
          <div class="sheet-sec">{{ g.group }}</div>
          <div class="sheet-grid">
            <div v-for="it in g.items" :key="it.id" class="sheet-item" :class="{on: route === it.id}" @click="go(it.id)">
              <span v-if="it.badge && it.badge()" class="nav-badge">{{ it.badge() }}</span>
              <v-icon :name="it.icon"/><span>{{ it.name }}</span>
            </div>
          </div>
        </template>
      </div>
      <toast-host/>
    </div>`,
  }

  const app = createApp(App)
  window.UI.register(app)
  app.mount('#app')
})()
