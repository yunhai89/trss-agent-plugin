/** 视图:配置中心(§1 全量配置项,可编辑 mock) */
(function () {
  window.VIEWS = window.VIEWS || {}

  /* 行容器:左名称/说明,右控件 */
  const CfgRow = {
    name: 'CfgRow',
    props: { name: String, desc: { type: String, default: '' }, danger: Boolean },
    template: `
    <div class="cfg-item" :style="danger ? {borderColor:'#f3c8d1', background:'linear-gradient(180deg,#fff,#fff8f9)'} : {}">
      <div class="info">
        <div class="name">{{ name }}<span v-if="danger" class="chip chip-rose" style="margin-left:7px;font-size:10px;padding:2px 7px">高危</span></div>
        <div class="desc" v-if="desc">{{ desc }}</div>
      </div>
      <div class="ctl"><slot/></div>
    </div>`,
  }

  /* 标签编辑器 */
  const TagEditor = {
    name: 'TagEditor',
    props: { modelValue: { type: Array, required: true }, placeholder: { type: String, default: '回车添加' } },
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      const input = Vue.ref('')
      const add = () => {
        const v = input.value.trim()
        if (v && !props.modelValue.includes(v)) emit('update:modelValue', [...props.modelValue, v])
        input.value = ''
      }
      const del = (i) => emit('update:modelValue', props.modelValue.filter((_, j) => j !== i))
      return { input, add, del }
    },
    template: `
    <div class="flex gap6 wrap" style="justify-content:flex-end">
      <span v-for="(t, i) in modelValue" :key="t" class="chip chip-primary" style="cursor:default">
        {{ t }}<v-icon name="x" style="cursor:pointer" @click="del(i)"/>
      </span>
      <input v-model="input" class="input" style="width:110px;padding:4px 9px;font-size:12px" :placeholder="placeholder" @keydown.enter.prevent="add">
    </div>`,
  }

  /* 模型选择器：可搜索下拉（按当前 protocol/baseURL/apiKey/preset 拉厂商 /models）+ 手输兜底 */
  const ModelPicker = {
    name: 'ModelPicker',
    props: {
      modelValue: { type: String, default: '' },
      protocol: { type: String, default: '' },
      baseUrl: { type: String, default: '' },
      apiKey: { type: String, default: '' },
      preset: { type: String, default: '' },
      placeholder: { type: String, default: '模型 ID（可手输或点拉取列表）' },
    },
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      const { ref, computed } = Vue
      const { toast } = window.UI
      const open = ref(false)
      const loading = ref(false)
      const models = ref([])
      const search = ref('')
      const filtered = computed(() => {
        const q = search.value.trim().toLowerCase()
        const all = models.value
        if (!q) return all.slice(0, 100)
        return all.filter((m) => (m.id || '').toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q)).slice(0, 100)
      })
      const setModel = (id) => { emit('update:modelValue', id); open.value = false; search.value = '' }
      const load = async () => {
        loading.value = true
        try {
          models.value = await window.api.get('/models', { protocol: props.protocol, baseURL: props.baseUrl, apiKey: props.apiKey, preset: props.preset })
          open.value = true
          toast(`已加载 ${models.value.length} 个模型`, 'success')
        } catch (e) { toast(e.message, 'error') }
        finally { loading.value = false }
      }
      return { open, loading, models, search, filtered, setModel, load }
    },
    template: `
    <div style="position:relative;min-width:240px">
      <div class="flex gap6">
        <input class="input mono" style="flex:1;min-width:140px" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" :placeholder="placeholder">
        <button type="button" class="btn btn-soft btn-sm" @click="load" :disabled="loading">{{ loading ? '加载中…' : '拉取列表' }}</button>
      </div>
      <div v-if="open" @click="open = false" style="position:fixed;inset:0;z-index:20"></div>
      <div v-if="open" style="position:absolute;z-index:30;top:calc(100% + 4px);left:0;right:0;background:var(--surface,#fff);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);max-height:260px;display:flex;flex-direction:column">
        <div style="padding:6px;border-bottom:1px solid var(--border)">
          <input class="input" style="width:100%;font-size:12px;padding:4px 8px" v-model="search" placeholder="搜索模型 id / 名称（无匹配可直接上方手填）">
        </div>
        <div style="overflow:auto;flex:1">
          <div v-if="!filtered.length" class="muted-3" style="padding:10px;font-size:12px">无匹配模型，可直接在输入框手填</div>
          <div v-for="m in filtered" :key="m.id" @click="setModel(m.id)" style="padding:6px 10px;cursor:pointer;border-bottom:1px solid var(--border);font-size:12px">
            <b class="mono">{{ m.id }}</b> <span v-if="m.name && m.name !== m.id" class="muted-3">{{ m.name }}</span>
          </div>
        </div>
      </div>
    </div>`,
  }

  const OPT = {
    trigger: [['at', '@机器人触发'], ['command', '触发词触发'], ['both', '两者皆可']],
    protocol: [['openai', 'OpenAI 兼容'], ['anthropic', 'Anthropic 兼容'], ['gemini', 'Gemini 原生(官方SDK)']],
    preset: [['deepseek', 'DeepSeek'], ['openai', 'OpenAI'], ['gemini', 'Gemini'], ['dashscope', '通义(DashScope)'], ['zhipu', '智谱'], ['moonshot', 'Kimi(Moonshot)'], ['mimo', '小米(MiMo)'], ['minimax', 'MiniMax(M3)'], ['anthropic', 'Anthropic'], ['openrouter', 'OpenRouter(聚合)'], ['opencode', 'OpenCode Zen'], ['opencode-go', 'OpenCode Go(订阅)']],
    permission: [['master', '仅主人'], ['admin', '管理员'], ['owner', '群主'], ['all', '所有人']],
    guardAction: [['block', '拦截(block)'], ['flag', '隔离标注(flag)'], ['sanitize', '脱敏(sanitize)']],
    guardSensitivity: [['low', '低 (0.95)'], ['medium', '中 (0.7)'], ['high', '高 (0.5)']],
    reflect: [['off', '关闭'], ['auto', '自动'], ['always', '总是']],
    replyMode: [['image', '图片渲染'], ['text', '纯文本']],
    degrade: [['describe', 'describe 转文字描述'], ['ignore', 'ignore 忽略']],
    researchPerm: [['master', '仅主人(防滥用)'], ['all', '所有人']],
    shMode: [['local', 'local 本地(Playwright+chromium,默认)'], ['cloud', 'cloud Browserbase 云']],
    shRegion: [['', '默认 us-west-2'], ['us-east-1', 'us-east-1'], ['eu-central-1', 'eu-central-1'], ['ap-southeast-1', 'ap-southeast-1']],
  }

  window.VIEWS.config = {
    name: 'ConfigView',
    components: { CfgRow, TagEditor, ModelPicker },
    setup() {
      const { ref, reactive, watch, computed, onMounted, onUnmounted, nextTick } = Vue
      const { toast } = window.UI
      const M = window.MOCK

      /* 表单初始空,onMounted loadConfig 后填充;origSnapshot 用于 diff 与 reset */
      const form = reactive({})
      let origSnapshot = {}
      const dirty = ref(false)
      let dirtySuppressed = true
      watch(form, () => { if (!dirtySuppressed) dirty.value = true }, { deep: true })
      // preset → baseURL 自动联动：选厂商预设时自动填对应 baseURL（syncForm 加载时不覆盖，保留 config 已有值）
      const PRESET_URLS = {
        deepseek: 'https://api.deepseek.com',
        openai: 'https://api.openai.com/v1',
        gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
        dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        zhipu: 'https://open.bigmodel.cn/api/paas/v4',
        moonshot: 'https://api.moonshot.ai/v1',
        mimo: 'https://api.xiaomimimo.com/v1',
        // MiniMax 双协议：openai 走 /v1（chat/completions）；anthropic 走 /anthropic（client 自动拼 /v1/messages，不能带 /v1）
        minimax: { openai: 'https://api.minimaxi.com/v1', anthropic: 'https://api.minimaxi.com/anthropic' },
        anthropic: 'https://api.anthropic.com',
        openrouter: 'https://openrouter.ai/api/v1',
        // OpenCode 两套端点：openai 走 /chat/completions（baseURL 带 /v1）；anthropic 走 /messages（client 自动拼 /v1，baseURL 不能带）
        opencode: { openai: 'https://opencode.ai/zen/v1', anthropic: 'https://opencode.ai/zen' },
        'opencode-go': { openai: 'https://opencode.ai/zen/go/v1', anthropic: 'https://opencode.ai/zen/go' },
      }
      // preset 或 protocol 变化都重新联动 baseURL（OpenCode 在两种协议下 baseURL 不同）
      watch(() => [form.preset, form.protocol], ([p]) => {
        if (!dirtySuppressed && p && PRESET_URLS[p]) {
          const u = PRESET_URLS[p]
          form.baseURL = typeof u === 'string' ? u : (u[form.protocol] || u.openai)
        }
      })

      /* 同步 form 与快照(不触发 dirty) */
      const syncForm = (snap) => {
        dirtySuppressed = true
        Object.assign(form, snap)
        origSnapshot = JSON.parse(JSON.stringify(snap))
        mcpServersToUi()
        // 兜底：确保各子对象存在（防旧 config 无此字段时 v-model 报错）
        if (!form.stagehand) form.stagehand = {}
        if (!form.terminal) form.terminal = {}
        if (!form.download) form.download = {}
        if (!form.multiagent) form.multiagent = {}
        // multiagent.defaultTools 数组兜底（TagEditor 要求 modelValue 为 Array）
        const ma = form.multiagent
        if (ma && !Array.isArray(ma.defaultTools)) ma.defaultTools = ma.defaultTools == null ? [] : [ma.defaultTools]
        dirty.value = false
        nextTick(() => { dirtySuppressed = false })
      }

      /* 点路径 diff:全部字段明文,对象递归、数组/标量整体比较;MCP servers 整体提交(增删改不递归,避免删 server 漏掉) */
      const buildChanges = (orig, frm, prefix = 'agent', out = {}) => {
        for (const k of Object.keys(frm)) {
          const p = prefix + '.' + k, a = orig?.[k], b = frm[k]
          if (p === 'agent.mcp.servers') {
            if (JSON.stringify(a) !== JSON.stringify(b)) out[p] = b
            continue
          }
          if (b && typeof b === 'object' && !Array.isArray(b) && a && typeof a === 'object') buildChanges(a, b, p, out)
          else if (JSON.stringify(a) !== JSON.stringify(b)) out[p] = b
        }
        return out
      }

      const save = async () => {
        mcpServersFromUi()
        const changes = buildChanges(origSnapshot, JSON.parse(JSON.stringify(form)))
        if (!Object.keys(changes).length) { toast('无改动', 'warn'); return }
        try {
          await window.api.put('/config', { changes })
          await window.store.loadConfig()
          if (M.config) syncForm(JSON.parse(JSON.stringify(M.config)))
          toast('已保存(已热加载)', 'success')
        } catch (e) { toast(e.message, 'error') }
      }
      const reset = () => {
        dirtySuppressed = true
        Object.assign(form, JSON.parse(JSON.stringify(origSnapshot)))
        dirty.value = false
        nextTick(() => { dirtySuppressed = false })
        toast('已还原为当前生效配置', 'info')
      }

      /* 分区折叠 */
      const sections = [
        { id: 'basic', name: '基础 / 模型', icon: 'cpu', grad: 'var(--grad-primary)' },
        { id: 'reason', name: '推理参数', icon: 'zap', grad: 'var(--grad-sky)' },
        { id: 'reply', name: '进度 / 回复渲染', icon: 'send', grad: 'var(--grad-teal)' },
        { id: 'memory', name: '记忆系统', icon: 'memory', grad: 'var(--grad-amber)' },
        { id: 'evolution', name: '自进化', icon: 'evolution', grad: 'var(--grad-rose)' },
        { id: 'security', name: '权限 / 安全 / 日志', icon: 'shield', grad: 'var(--grad-primary)' },
        { id: 'mcp', name: 'MCP 服务', icon: 'tool', grad: 'var(--grad-teal)' },
        { id: 'ext', name: '多模态 / 工具 / 扩展', icon: 'tool', grad: 'var(--grad-sky)' },
      ]
      // 仅「基础/模型」默认展开，其余收起（配置多时便于查找）
      const open = reactive(Object.fromEntries(sections.map((s) => [s.id, s.id === 'basic'])))
      const activeSec = ref('basic')
      const jump = (id) => {
        open[id] = true
        activeSec.value = id
        document.getElementById('cfg-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      /* 滚动高亮锚点 */
      const onScroll = () => {
        for (const s of sections) {
          const el = document.getElementById('cfg-' + s.id)
          if (el && el.getBoundingClientRect().top > 60 && el.getBoundingClientRect().top < 240) { activeSec.value = s.id; break }
        }
      }
      /* 常驻工具勾选：从已注册工具列表（/tools）按类别选，避免用户手输工具名 */
      const allTools = computed(() => M.tools || [])
      const toolCats = computed(() => [...new Set(allTools.value.map((t) => t.category))].sort())
      const toolsByCat = (cat) => allTools.value.filter((t) => t.category === cat)
      const toggleAlwaysOn = (id) => {
        const a = Array.isArray(form.toolDiscovery?.alwaysOn) ? form.toolDiscovery.alwaysOn : []
        form.toolDiscovery.alwaysOn = a.includes(id) ? a.filter((x) => x !== id) : [...a, id]
      }

      onMounted(async () => {
        window.addEventListener('scroll', onScroll, { passive: true })
        try {
          await window.store.loadConfig()
          if (M.config) syncForm(JSON.parse(JSON.stringify(M.config)))
          window.store.loadTools().catch(() => {}) // 工具列表（失败不阻塞配置加载）
        } catch (e) { toast(e.message, 'error') }
      })
      onUnmounted(() => window.removeEventListener('scroll', onScroll))

      /* 回退模型列表(baseURL/apiKey 明文) */
      const addFallback = () => form.fallbackModels.push({ model: '', baseURL: '', apiKey: '', protocol: 'openai' })
      const delFallback = (i) => form.fallbackModels.splice(i, 1)

      /* masters(明文 QQ 数组) */
      const masterInput = ref('')
      const addMaster = () => {
        const v = masterInput.value.trim()
        if (!v) return
        if (!/^\d{5,11}$/.test(v)) { toast('QQ 号需 5-11 位数字', 'warn'); return }
        // 整体替换新数组（而非 push）：确保 reactive set 触发，push/splice 偶发不更新 UI/脏标记
        if (!form.masters.includes(v)) form.masters = [...form.masters, v]
        masterInput.value = ''
      }
      const delMaster = (i) => { form.masters = form.masters.filter((_, j) => j !== i) }

      /* MCP servers：逐个服务。stdio 粘贴单服务 JSON(command/args/env) / http 填 url+headers；
         新建走弹窗（弹窗内始终有 stdio/http 选择） */
      const mcpServersToUi = () => {
        if (!form.mcp) form.mcp = {}
        const servers = form.mcp.servers && typeof form.mcp.servers === 'object' ? form.mcp.servers : {}
        for (const srv of Object.values(servers)) {
          if (!srv || typeof srv !== 'object') continue
          srv._type = srv.type === 'http' ? 'http' : 'stdio'
          if (srv._type === 'stdio') {
            const cfg = { command: srv.command ?? 'npx', args: Array.isArray(srv.args) ? srv.args : [], env: srv.env || {} }
            srv._json = JSON.stringify(cfg, null, 2)
          } else {
            srv._url = srv.url || ''
            srv._headersText = srv.headers && typeof srv.headers === 'object' ? Object.entries(srv.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : ''
          }
        }
      }
      const mcpServersFromUi = () => {
        if (!form.mcp?.servers) return
        for (const srv of Object.values(form.mcp.servers)) {
          if (!srv || typeof srv !== 'object') continue
          if (srv._type === 'stdio') {
            try {
              const cfg = JSON.parse(String(srv._json || '{}'))
              srv.command = cfg.command || 'npx'
              srv.args = Array.isArray(cfg.args) ? cfg.args : []
              srv.env = cfg.env && typeof cfg.env === 'object' ? cfg.env : undefined
            } catch (e) { toast('MCP stdio JSON 解析失败：' + (e?.message || e) + '（保留旧值）', 'error') }
            delete srv.type
          } else {
            srv.type = 'http'
            srv.url = String(srv._url || '')
            const headers = {}
            for (const line of String(srv._headersText || '').split('\n')) { const idx = line.indexOf(':'); if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim() }
            srv.headers = Object.keys(headers).length ? headers : undefined
          }
          delete srv._type; delete srv._json; delete srv._url; delete srv._headersText
        }
      }
      const delMcp = (name) => { if (form.mcp?.servers) delete form.mcp.servers[name] }

      /* 新建 MCP 弹窗：弹窗内始终有 stdio/http 选择 */
      const mcpModal = reactive({
        show: false, name: '', type: 'stdio',
        stdioJson: '{\n  "command": "npx",\n  "args": ["-y", "package-name"],\n  "env": {}\n}',
        url: '', headersText: '',
      })
      const openNewMcp = () => {
        mcpModal.name = ''; mcpModal.type = 'stdio'
        mcpModal.stdioJson = '{\n  "command": "npx",\n  "args": ["-y", "package-name"],\n  "env": {}\n}'
        mcpModal.url = ''; mcpModal.headersText = ''
        mcpModal.show = true
      }
      // 从单个服务配置生成 UI server（含 _type + _json 或 _url/_headersText）
      const makeSrvUi = (cfg) => {
        if (!cfg || typeof cfg !== 'object') cfg = {}
        if (cfg.type === 'http' || cfg.url) {
          const headersText = cfg.headers && typeof cfg.headers === 'object' ? Object.entries(cfg.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : ''
          return { type: 'http', url: cfg.url || '', _type: 'http', _url: cfg.url || '', _headersText: headersText }
        }
        const c = { command: cfg.command || 'npx', args: Array.isArray(cfg.args) ? cfg.args : [], env: cfg.env || {} }
        return { command: c.command, args: c.args, env: c.env, _type: 'stdio', _json: JSON.stringify(c, null, 2) }
      }
      const confirmNewMcp = () => {
        if (!form.mcp) form.mcp = {}
        if (!form.mcp.servers || typeof form.mcp.servers !== 'object') form.mcp.servers = {}
        if (mcpModal.type === 'stdio') {
          let parsed
          try { parsed = JSON.parse(String(mcpModal.stdioJson || '{}')) }
          catch (e) { toast('stdio JSON 解析失败：' + (e?.message || e), 'error'); return }
          // 兼容完整 {mcpServers:{name:{...}}}（Claude Desktop 格式）：批量添加，name 取自 JSON
          if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
            let added = 0
            for (const [svName, svCfg] of Object.entries(parsed.mcpServers)) {
              if (!svCfg || typeof svCfg !== 'object') continue
              if (form.mcp.servers[svName]) { toast('服务「' + svName + '」已存在，跳过', 'warn'); continue }
              form.mcp.servers[svName] = makeSrvUi(svCfg)
              added++
            }
            if (!added) { toast('mcpServers 内无有效服务', 'warn'); return }
            mcpModal.show = false
            toast('已从 JSON 添加 ' + added + ' 个 MCP 服务', 'success')
            return
          }
          // 单服务 {command,args,env}：用弹窗 name
          const name = String(mcpModal.name || '').trim()
          if (!name) { toast('请填写服务名，或粘贴含 mcpServers 的完整 JSON', 'warn'); return }
          if (form.mcp.servers[name]) { toast('服务名已存在', 'warn'); return }
          form.mcp.servers[name] = makeSrvUi(parsed)
          mcpModal.show = false
          toast('已添加 MCP 服务「' + name + '」', 'success')
        } else {
          const name = String(mcpModal.name || '').trim()
          if (!name) { toast('请填写服务名', 'warn'); return }
          if (form.mcp.servers[name]) { toast('服务名已存在', 'warn'); return }
          form.mcp.servers[name] = { type: 'http', url: mcpModal.url || '', _type: 'http', _url: mcpModal.url || '', _headersText: mcpModal.headersText }
          mcpModal.show = false
          toast('已添加 MCP 服务「' + name + '」', 'success')
        }
      }

      /* thinking 开关兼容 */
      const thinkingOn = computed({
        get: () => !!form.thinking,
        set: (v) => { form.thinking = v ? { type: 'enabled', budget_tokens: 16000 } : null },
      })

      const tempPct = computed(() => (form.temperature / 2) * 100 + '%')

      /* OpenRouter 模型目录 + key 余额（preset=openrouter 时显示） */
      const orModels = ref([])
      const orSearch = ref('')
      const orLoading = ref(false)
      const loadOrModels = async () => {
        orLoading.value = true
        try { orModels.value = await window.api.get('/openrouter/models'); toast(`已加载 ${orModels.value.length} 个模型`, 'success') }
        catch (e) { toast(e.message, 'error') }
        finally { orLoading.value = false }
      }
      const orFiltered = computed(() => {
        const q = orSearch.value.trim().toLowerCase()
        const all = orModels.value
        if (!q) return all.slice(0, 50)
        return all.filter((m) => (m.id || '').toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q)).slice(0, 50)
      })
      const pickOrModel = (id) => { form.model = id; orSearch.value = ''; toast('已选 ' + id, 'success') }
      const orKey = ref(null)
      const loadOrKey = async () => {
        try { orKey.value = await window.api.get('/openrouter/key'); toast('余额已刷新', 'success') }
        catch (e) { toast(e.message, 'error') }
      }

      return {
        form, dirty, save, reset, sections, open, activeSec, jump, OPT,
        addFallback, delFallback, masterInput, addMaster, delMaster,
        mcpServersToUi, delMcp, mcpModal, openNewMcp, confirmNewMcp,
        thinkingOn, tempPct,
        orModels, orSearch, orLoading, loadOrModels, orFiltered, pickOrModel, orKey, loadOrKey,
        allTools, toolCats, toolsByCat, toggleAlwaysOn,
      }
    },
    template: `
    <div class="cfg-layout">
      <!-- 锚点导航 -->
      <div class="cfg-anchor">
        <a v-for="s in sections" :key="s.id" :class="{active: activeSec === s.id}" @click="jump(s.id)">{{ s.name }}</a>
      </div>

      <div>
        <!-- ===== §1.1 基础 / 模型 ===== -->
        <div :id="'cfg-basic'" class="card cfg-section" :class="{open: open.basic}">
          <div class="cfg-section-head" @click="open.basic = !open.basic">
            <span class="ico" style="background:var(--grad-primary)"><v-icon name="cpu"/></span>
            <div><div class="card-title" style="font-size:14px">基础 / 模型</div><div class="card-sub">触发方式、协议预设、主模型与回退</div></div>
            <v-icon class="arrow" name="chevron"/>
          </div>
          <div class="cfg-body" v-show="open.basic"><div class="cfg-grid">
            <cfg-row name="触发模式" desc="at=被@ / command=触发词 / both 两者">
              <select class="select" style="width:150px" v-model="form.trigger"><option v-for="o in OPT.trigger" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="触发词" desc="command/both 时生效">
              <input class="input" style="width:150px" v-model="form.triggerCommand" placeholder="#ai">
            </cfg-row>
            <cfg-row name="协议" desc="API 兼容协议">
              <select class="select" style="width:170px" v-model="form.protocol"><option v-for="o in OPT.protocol" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="厂商预设" desc="自动填 baseURL / headers / 字段映射">
              <select class="select" style="width:170px" v-model="form.preset"><option v-for="o in OPT.preset" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="接口地址 baseURL" desc="OpenAI 兼容接口地址">
              <input class="input" style="width:260px" v-model="form.baseURL" placeholder="https://api.deepseek.com">
            </cfg-row>
            <cfg-row name="API Key" desc="主模型密钥(明文)">
              <input class="input mono" style="width:260px" v-model="form.apiKey" placeholder="sk-...">
            </cfg-row>
            <cfg-row full name="主模型 ID" desc="对话主模型；可手输，或点「拉取列表」按当前厂商拉取可用模型">
              <model-picker v-model="form.model" :protocol="form.protocol" :base-url="form.baseURL" :api-key="form.apiKey" :preset="form.preset"/>
            </cfg-row>
            <div class="full" v-if="form.preset === 'openrouter'" style="margin-top:6px;padding:10px;border:1px dashed var(--border);border-radius:10px">
              <div class="flex between mb8">
                <div style="font-weight:800;font-size:13px">🔍 OpenRouter 模型搜索</div>
                <button class="btn btn-soft btn-sm" @click="loadOrModels">{{ orLoading ? '加载中…' : (orModels.length ? '已加载 '+orModels.length+' 个' : '加载模型目录') }}</button>
              </div>
              <div v-if="orModels.length">
                <input class="input" style="width:100%" v-model="orSearch" placeholder="搜索模型 id/名称（如 gpt / claude / gemini）">
                <div style="max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:8px;margin-top:6px">
                  <div v-for="m in orFiltered" :key="m.id" @click="pickOrModel(m.id)" style="padding:6px 10px;cursor:pointer;border-bottom:1px solid var(--border);font-size:12px">
                    <b>{{ m.id }}</b> <span class="muted-3">{{ m.name }}<span v-if="m.context"> · {{ Math.round(m.context/1000) }}k ctx</span><span v-if="m.prompt"> · $ {{ (m.prompt * 1000000).toFixed(2) }}/M</span></span>
                  </div>
                </div>
              </div>
              <div class="flex between" style="margin-top:10px">
                <span class="muted" style="font-size:12px">Key 余额</span>
                <button class="btn btn-ghost btn-sm" @click="loadOrKey">查询余额</button>
              </div>
              <div v-if="orKey" class="muted-3" style="font-size:11px;margin-top:4px">
                剩余 $ {{ orKey.limit_remaining ?? '∞' }} / 上限 $ {{ orKey.limit ?? '∞' }} · 已用 $ {{ orKey.usage ?? 0 }}（本月 $ {{ orKey.usage_monthly ?? 0 }}）<span v-if="orKey.is_free_tier"> · 免费层</span>
              </div>
            </div>
            <cfg-row name="旁路小模型" desc="进度播报等旁路任务;留空=主模型">
              <input class="input" style="width:180px" v-model="form.utilityModel" placeholder="留空=主模型">
            </cfg-row>
            <cfg-row name="多用户数据隔离" desc="开启后按 (群,用户) 隔离记忆与会话">
              <v-switch v-model="form.isolation.enable"/>
            </cfg-row>
            <cfg-row name="代理" desc="http 代理(留空=直连)">
              <input class="input mono" style="width:240px" v-model="form.proxy" placeholder="http://127.0.0.1:7890">
            </cfg-row>

            <div class="full">
              <div class="flex between mb10">
                <div style="font-weight:800;font-size:13px">回退模型链</div>
                <button class="btn btn-soft btn-sm" @click="addFallback"><v-icon name="plus"/>添加回退</button>
              </div>
              <TransitionGroup name="list" tag="div" style="display:flex;flex-direction:column;gap:10px;position:relative">
                <div v-for="(fb, i) in form.fallbackModels" :key="i" class="cfg-item" style="background:#fff">
                  <div class="flex gap10 wrap" style="flex:1">
                    <span class="chip chip-outline mono" style="min-width:26px;justify-content:center">{{ i + 1 }}</span>
                    <input class="input" style="width:190px" v-model="fb.model" placeholder="模型 ID">
                    <select class="select" style="width:130px" v-model="fb.protocol"><option v-for="o in OPT.protocol" :value="o[0]">{{ o[1] }}</option></select>
                    <input class="input mono" style="width:170px" v-model="fb.baseURL" placeholder="baseURL">
                    <input class="input mono" style="width:150px" v-model="fb.apiKey" placeholder="apiKey">
                  </div>
                  <button class="icon-btn danger" @click="delFallback(i)"><v-icon name="trash"/></button>
                </div>
              </TransitionGroup>
            </div>
          </div></div>
        </div>

        <!-- ===== §1.2 推理参数 ===== -->
        <div :id="'cfg-reason'" class="card cfg-section" :class="{open: open.reason}">
          <div class="cfg-section-head" @click="open.reason = !open.reason">
            <span class="ico" style="background:var(--grad-sky)"><v-icon name="zap"/></span>
            <div><div class="card-title" style="font-size:14px">推理参数</div><div class="card-sub">采样、轮次、思考预算与上下文</div></div>
            <v-icon class="arrow" name="chevron"/>
          </div>
          <div class="cfg-body" v-show="open.reason"><div class="cfg-grid">
            <cfg-row name="采样温度" desc="0~2,越低越稳定">
              <div class="flex gap10" style="width:200px">
                <input type="range" class="slider" min="0" max="2" step="0.1" v-model.number="form.temperature" :style="{'--fill': tempPct}">
                <b class="num" style="width:30px;text-align:right">{{ form.temperature.toFixed(1) }}</b>
              </div>
            </cfg-row>
            <cfg-row name="工具调用轮次上限" desc="单次请求最多工具往返">
              <input type="number" class="input" style="width:110px" min="1" max="100" v-model.number="form.maxTurns">
            </cfg-row>
            <cfg-row name="重复动作上限" desc="同工具+相同参数连续允许次数(超出→终止,防死循环)">
              <input type="number" class="input" style="width:90px" min="1" v-model.number="form.loop.maxSameAction">
            </cfg-row>
            <cfg-row name="连续失败上限" desc="连续工具失败次数(超出→终止)">
              <input type="number" class="input" style="width:90px" min="1" v-model.number="form.loop.maxConsecutiveFailures">
            </cfg-row>
            <cfg-row name="无进展窗口" desc="连续 N 步无新事实→终止">
              <input type="number" class="input" style="width:90px" min="1" v-model.number="form.loop.noProgressWindow">
            </cfg-row>
            <cfg-row name="时间预算(ms)" desc="单次对话超时(0=不限)">
              <input type="number" class="input" style="width:120px" min="0" step="1000" v-model.number="form.loop.timeBudgetMs">
            </cfg-row>
            <cfg-row name="token 预算" desc="单次对话 token 上限(0=不限)">
              <input type="number" class="input" style="width:120px" min="0" step="1000" v-model.number="form.loop.tokenBudget">
            </cfg-row>
            <cfg-row name="深度思考" desc="模型先思考再作答(更慢更耗 token)">
              <v-switch v-model="thinkingOn"/>
            </cfg-row>
            <cfg-row name="思考预算 tokens" desc="thinking.budget_tokens">
              <input type="number" class="input" style="width:130px" min="1024" step="1024" :disabled="!form.thinking" v-model.number="form.thinking.budget_tokens">
            </cfg-row>
            <cfg-row name="单次回复最大 token" desc="留空=厂商默认">
              <input type="number" class="input" style="width:130px" min="1" v-model.number="form.maxTokens" placeholder="null">
            </cfg-row>
            <cfg-row name="上下文窗口" desc="超 80% 自动压缩历史">
              <input type="number" class="input" style="width:130px" min="1000" v-model.number="form.contextWindow">
            </cfg-row>
            <cfg-row name="工具结果字符上限" desc="超出截断,防爆 context">
              <input type="number" class="input" style="width:130px" min="100" v-model.number="form.maxToolResultChars">
            </cfg-row>
            <cfg-row name="反思模式" desc="回复前自检回环">
              <select class="select" style="width:130px" v-model="form.reflect"><option v-for="o in OPT.reflect" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="反思回环次数" desc="reflectMaxIterations">
              <input type="number" class="input" style="width:110px" min="1" max="5" v-model.number="form.reflectMaxIterations">
            </cfg-row>
            <cfg-row name="回灌推理到历史" desc="默认关:省 context">
              <v-switch v-model="form.keepReasoning"/>
            </cfg-row>
            <cfg-row name="逐字流式输出" desc="依赖适配器,不稳,默认关">
              <v-switch v-model="form.stream"/>
            </cfg-row>
            <cfg-row class="full" name="reasoning 字段映射" desc="不同厂商的推理字段名">
              <tag-editor v-model="form.reasoningFields"/>
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== §1.3 进度 / 回复渲染 ===== -->
        <div :id="'cfg-reply'" class="card cfg-section" :class="{open: open.reply}">
          <div class="cfg-section-head" @click="open.reply = !open.reply">
            <span class="ico" style="background:var(--grad-teal)"><v-icon name="send"/></span>
            <div><div class="card-title" style="font-size:14px">进度 / 回复渲染</div><div class="card-sub">进度消息、渲染方式与中途播报</div></div>
            <v-icon class="arrow" name="chevron"/>
          </div>
          <div class="cfg-body" v-show="open.reply"><div class="cfg-grid">
            <cfg-row name="工具调用进度消息" desc="消除干等,默认开">
              <v-switch v-model="form.progress"/>
            </cfg-row>
            <cfg-row name="进度消息撤回(秒)" desc="0=不撤回">
              <input type="number" class="input" style="width:110px" min="0" max="120" v-model.number="form.progressRecall">
            </cfg-row>
            <cfg-row name="回复渲染方式" desc="image=markdown 渲染精美浅色图">
              <div class="seg">
                <button v-for="o in OPT.replyMode" :class="{active: form.reply.mode === o[0]}" @click="form.reply.mode = o[0]">{{ o[1] }}</button>
              </div>
            </cfg-row>
            <cfg-row name="回复图清晰度倍率" desc="deviceScaleFactor 1~4">
              <input type="number" class="input" style="width:110px" min="1" max="4" v-model.number="form.reply.renderScale">
            </cfg-row>
            <cfg-row name="群聊 @ 发言人" desc="回复时 at 触发者">
              <v-switch v-model="form.reply.atSender"/>
            </cfg-row>
            <cfg-row name="中途播报" desc="调工具时顺带转发思路/进展">
              <v-switch v-model="form.reply.narrate"/>
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== §1.4 记忆系统 ===== -->
        <div :id="'cfg-memory'" class="card cfg-section" :class="{open: open.memory}">
          <div class="cfg-section-head" @click="open.memory = !open.memory">
            <span class="ico" style="background:var(--grad-amber)"><v-icon name="memory"/></span>
            <div><div class="card-title" style="font-size:14px">记忆系统</div><div class="card-sub">声明式记忆 + 长期记忆召回</div></div>
            <v-icon class="arrow" name="chevron"/>
          </div>
          <div class="cfg-body" v-show="open.memory"><div class="cfg-grid">
            <cfg-row name="声明式记忆" desc="注入 MEMORY.md / USER.md 到 system">
              <v-switch v-model="form.memory.enable"/>
            </cfg-row>
            <cfg-row name="记忆注入扫描" desc="写长期记忆前扫描指令注入">
              <v-switch v-model="form.memory.threatScan"/>
            </cfg-row>
            <cfg-row name="MEMORY 字符上限" desc="Agent 个人笔记上限">
              <input type="number" class="input" style="width:120px" min="200" v-model.number="form.memoryLimits.memory">
            </cfg-row>
            <cfg-row name="USER 字符上限" desc="用户画像上限">
              <input type="number" class="input" style="width:120px" min="200" v-model.number="form.memoryLimits.user">
            </cfg-row>
            <cfg-row name="长期记忆条数上限" desc="每用户;超限按价值淘汰">
              <input type="number" class="input" style="width:120px" min="10" v-model.number="form.recall.cap">
            </cfg-row>
            <cfg-row name="LLM 抽取间隔(轮)" desc="每 N 轮触发一次抽取">
              <input type="number" class="input" style="width:120px" min="1" v-model.number="form.recall.extractEvery">
            </cfg-row>
            <cfg-row name="抽取用模型" desc="留空=utilityModel→主模型">
              <input class="input" style="width:170px" v-model="form.recall.model" placeholder="留空=主模型">
            </cfg-row>
            <cfg-row name="embedding 模型" desc="留空=关键词 jaccard 召回；填模型 id 走语义召回">
              <input class="input mono" style="width:200px" v-model="form.recall.embedProvider" placeholder="如 text-embedding-3-small / embedding-3">
            </cfg-row>
            <cfg-row name="embedding 接口 / Key" desc="留空=复用主 baseURL/apiKey；用专门 embedding 服务时填">
              <div class="flex gap6">
                <input class="input mono" style="width:200px" v-model="form.recall.embedBaseURL" placeholder="baseURL 留空=复用主">
                <input class="input mono" style="width:140px" v-model="form.recall.embedApiKey" placeholder="Key 留空=复用主">
              </div>
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== §1.5 自进化 ===== -->
        <div :id="'cfg-evolution'" class="card cfg-section" :class="{open: open.evolution}">
          <div class="cfg-section-head" @click="open.evolution = !open.evolution">
            <span class="ico" style="background:var(--grad-rose)"><v-icon name="evolution"/></span>
            <div><div class="card-title" style="font-size:14px">自进化</div><div class="card-sub">后台自评审与改进建议落盘</div></div>
            <v-icon class="arrow" name="chevron"/>
          </div>
          <div class="cfg-body" v-show="open.evolution"><div class="cfg-grid">
            <cfg-row name="后台自评审" desc="每 N 轮异步评审,不阻塞回复">
              <v-switch v-model="form.selfReview.enable"/>
            </cfg-row>
            <cfg-row name="评审间隔(轮)" desc="每 N 轮触发一次">
              <input type="number" class="input" style="width:120px" min="5" v-model.number="form.selfReview.every">
            </cfg-row>
            <cfg-row name="评审用模型" desc="建议廉价小模型降本">
              <input class="input" style="width:170px" v-model="form.selfReview.model" placeholder="留空=主模型">
            </cfg-row>
            <cfg-row name="日 token 预算" desc="耗尽则只采迹不评审">
              <input type="number" class="input" style="width:150px" min="0" step="10000" v-model.number="form.selfReview.dailyBudgetTokens">
            </cfg-row>
            <cfg-row name="记忆自动应用" desc="有回滚+威胁扫描+置信度闸">
              <v-switch v-model="form.selfReview.autoApplyMemory"/>
            </cfg-row>
            <cfg-row name="prompt 自动应用" desc="默认关:落盘待审,人工把关" danger>
              <v-switch v-model="form.selfReview.autoApplyPrompt"/>
            </cfg-row>
            <cfg-row class="full" name="产物目录" desc="traces / prompts / suggestions">
              <div class="flex gap6 wrap" style="justify-content:flex-end">
                <span class="chip mono">{{ form.evolution.traceDir }}</span>
                <span class="chip mono">{{ form.evolution.promptDir }}</span>
                <span class="chip mono">{{ form.evolution.suggestionDir }}</span>
              </div>
            </cfg-row>
            <div class="full" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--border)">
              <div class="muted" style="font-size:12px;font-weight:700;margin-bottom:8px"><v-icon name="tool"/> 工具进化（Tool Evolution）</div>
              <div class="cfg-grid">
                <cfg-row name="工具进化" desc="版本化工具库(生成→验证→审批→晋升)">
                  <v-switch v-model="form.toolEvo.enable"/>
                </cfg-row>
                <cfg-row name="候选修复次数" desc="生成失败自动修复上限">
                  <input type="number" class="input" style="width:90px" min="0" max="3" v-model.number="form.toolEvo.maxRepairAttempts">
                </cfg-row>
                <cfg-row name="检索接受阈值" desc="与去重阈值分开(§12.1)">
                  <input type="number" class="input" style="width:100px" min="0" max="1" step="0.01" v-model.number="form.toolEvo.retrievalThreshold">
                </cfg-row>
                <cfg-row name="去重阈值" desc="候选去重相似度">
                  <input type="number" class="input" style="width:100px" min="0" max="1" step="0.01" v-model.number="form.toolEvo.deduplicationThreshold">
                </cfg-row>
              </div>
            </div>
          </div></div>
        </div>

        <!-- ===== §1.6 权限 / 安全 / 日志 ===== -->
        <div :id="'cfg-security'" class="card cfg-section" :class="{open: open.security}">
          <div class="cfg-section-head" @click="open.security = !open.security">
            <span class="ico" style="background:var(--grad-primary)"><v-icon name="shield"/></span>
            <div><div class="card-title" style="font-size:14px">权限 / 安全 / 日志</div><div class="card-sub">主人、审批、注入防御与全链路日志</div></div>
            <v-icon class="arrow" name="chevron"/>
          </div>
          <div class="cfg-body" v-show="open.security"><div class="cfg-grid">
            <cfg-row name="#ai 命令权限" desc="谁可以触发对话">
              <select class="select" style="width:140px" v-model="form.chatPermission"><option v-for="o in OPT.permission" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="确认超时(秒)" desc="审批门超时自动拒绝">
              <input type="number" class="input" style="width:120px" min="10" v-model.number="form.confirmTimeout">
            </cfg-row>
            <cfg-row name="注入防御动作" desc="命中提示词注入时的处理">
              <select class="select" style="width:170px" v-model="form.guardAction"><option v-for="o in OPT.guardAction" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="防御灵敏度" desc="阈值越低越严格">
              <select class="select" style="width:150px" v-model="form.guardSensitivity"><option v-for="o in OPT.guardSensitivity" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="回复脱敏" desc="发送前屏蔽密钥/token">
              <v-switch v-model="form.redactSecrets"/>
            </cfg-row>
            <cfg-row name="全链路日志 devLog" desc="每会话一个日志文件">
              <v-switch v-model="form.devLog.enable"/>
            </cfg-row>
            <cfg-row name="主人任务免确认" desc="主人发起的确认类工具跳过审批,高危!" danger>
              <v-switch v-model="form.masterSkipConfirm"/>
            </cfg-row>
            <cfg-row name="日志级别" desc="devLog.level">
              <select class="select" style="width:120px" v-model="form.devLog.level"><option value="info">info</option><option value="warn">warn</option><option value="debug">debug</option></select>
            </cfg-row>
            <cfg-row class="full" name="主人列表" desc="主人 QQ 号(明文,点标签删除)">
              <div class="flex gap6 wrap" style="justify-content:flex-end">
                <span v-for="(m, i) in form.masters" :key="i" class="chip chip-outline mono" style="cursor:pointer" @click="delMaster(i)" title="点击删除">{{ m }} <v-icon name="x"/></span>
                <input class="input" style="width:130px;padding:4px 9px;font-size:12px" v-model="masterInput" placeholder="输入 QQ 回车添加" @keydown.enter.prevent.stop="addMaster">
                <button type="button" class="btn btn-soft btn-sm" @click="addMaster" style="padding:4px 10px;font-size:12px">添加</button>
              </div>
            </cfg-row>
            <cfg-row class="full" name="默认身份 systemPrompt" desc="留空用富默认身份;被人设覆盖时失效">
              <textarea class="textarea" style="min-height:64px" v-model="form.systemPrompt" placeholder="留空=使用内置默认身份"></textarea>
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== 表情包（已独立成页） ===== -->
        <div class="card" style="padding:12px 16px;margin-bottom:14px;border-left:4px solid var(--grad-amber)">
          <div class="flex gap10" style="align-items:center">
            <v-icon name="smile" style="font-size:18px;color:var(--brand,#6366f1)"/>
            <div style="font-size:13px;flex:1"><b>表情包</b>配置已移至独立页：<b>系统 → 表情包</b>（含发送策略、自动发现、库概览/目录启停）。</div>
            <button class="btn btn-ghost" @click="$root && (location.hash = '#/sticker')">前往表情包页 →</button>
          </div>
        </div>

        <!-- ===== §1.7 多模态 / 工具 / 扩展 ===== -->
        <div :id="'cfg-ext'" class="card cfg-section" :class="{open: open.ext}">
          <div class="cfg-section-head" @click="open.ext = !open.ext">
            <span class="ico" style="background:var(--grad-sky)"><v-icon name="tool"/></span>
            <div><div class="card-title" style="font-size:14px">多模态 / 工具 / 扩展</div><div class="card-sub">视觉、搜索、MCP、终端与各子系统</div></div>
            <v-icon class="arrow" name="chevron"/>
          </div>
          <div class="cfg-body" v-show="open.ext"><div class="cfg-grid">
            <cfg-row name="多模态" desc="图片/文件输入总开关">
              <v-switch v-model="form.media.enable"/>
            </cfg-row>
            <cfg-row name="单次最多图片" desc="media.maxImages">
              <input type="number" class="input" style="width:110px" min="1" max="20" v-model.number="form.media.maxImages">
            </cfg-row>
            <cfg-row name="视觉子模型" desc="主模型无视觉时图转文；各字段留空=复用主配置">
              <v-switch v-model="form.vision.enable"/>
            </cfg-row>
            <cfg-row full name="视觉模型 ID" desc="视觉模型名；留空=复用主模型。可手输或点「拉取列表」（按视觉接口或主接口拉取）">
              <model-picker v-model="form.vision.model" :protocol="form.vision.protocol || form.protocol" :base-url="form.vision.baseURL || form.baseURL" :api-key="form.vision.apiKey || form.apiKey" :preset="form.vision.preset || form.preset" placeholder="留空=复用主模型"/>
            </cfg-row>
            <cfg-row name="视觉接口地址" desc="baseURL；留空=复用主(跨厂商时填，如 https://dashscope.aliyuncs.com/compatible-mode/v1)">
              <input class="input mono" style="width:240px" v-model="form.vision.baseURL" placeholder="留空=复用主 baseURL">
            </cfg-row>
            <cfg-row name="视觉模型 Key" desc="apiKey；空则复用主 Key">
              <input class="input mono" style="width:240px" v-model="form.vision.apiKey" placeholder="留空=复用主 Key">
            </cfg-row>
            <cfg-row name="工具按需发现" desc="常驻少数工具,其余 tool_search 动态注入">
              <v-switch v-model="form.toolDiscovery.enable"/>
            </cfg-row>
            <cfg-row name="tool_search 返回数 / 最低分" desc="topK 与 minScore">
              <div class="flex gap6">
                <input type="number" class="input" style="width:80px" min="1" max="20" v-model.number="form.toolDiscovery.topK">
                <input type="number" class="input" style="width:90px" min="0" max="1" step="0.05" v-model.number="form.toolDiscovery.minScore">
              </div>
            </cfg-row>
            <cfg-row class="full" name="常驻工具" desc="不经搜索始终可用；从已注册工具勾选（留空=用内置默认 6 个）">
              <div v-if="!allTools.length" class="muted-3" style="font-size:12px">工具列表加载中或运行时未就绪…</div>
              <div v-else style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px 12px;background:var(--surface-2)">
                <div v-for="cat in toolCats" :key="cat" style="margin-bottom:8px">
                  <div class="muted" style="font-size:11px;margin:3px 0 4px;text-transform:uppercase;letter-spacing:.5px">{{ cat }}</div>
                  <div style="display:flex;flex-wrap:wrap;gap:4px">
                    <label v-for="t in toolsByCat(cat)" :key="t.id" :title="t.description" class="chip" :class="{'chip-primary': (form.toolDiscovery.alwaysOn||[]).includes(t.id)}" style="cursor:pointer;user-select:none;font-size:12px">
                      <input type="checkbox" :checked="(form.toolDiscovery.alwaysOn||[]).includes(t.id)" @change="toggleAlwaysOn(t.id)" style="display:none">
                      {{ t.name }}
                    </label>
                  </div>
                </div>
              </div>
            </cfg-row>

            <cfg-row name="Tavily 搜索 Key" desc="任填一个搜索源即启用">
              <input class="input mono" style="width:220px" v-model="form.search.tavily.apiKey" placeholder="tvly-...">
            </cfg-row>
            <cfg-row class="full" name="Exa / Brave / PPLX Key" desc="其余搜索源密钥(明文)">
              <div class="flex gap6 wrap">
                <input class="input mono" style="width:150px" v-model="form.search.exa.apiKey" placeholder="Exa">
                <input class="input mono" style="width:150px" v-model="form.search.brave.apiKey" placeholder="Brave">
                <input class="input mono" style="width:150px" v-model="form.search.perplexity.apiKey" placeholder="Perplexity">
              </div>
            </cfg-row>
            <cfg-row name="DDG 兜底" desc="本地 DuckDuckGo,免 key">
              <v-switch v-model="form.search.ddg"/>
            </cfg-row>
            <cfg-row name="深度研究权限" desc="#研究 命令">
              <select class="select" style="width:170px" v-model="form.research.permission"><option v-for="o in OPT.researchPerm" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row class="full" name="米游社 Cookie" desc="明文">
              <input class="input mono" style="width:100%" v-model="form.miyoushe.cookie" placeholder="cookie 字符串">
            </cfg-row>
            <cfg-row class="full" name="Pixiv refreshToken" desc="明文">
              <input class="input mono" style="width:100%" v-model="form.pixiv.refreshToken" placeholder="refresh token">
            </cfg-row>
            <cfg-row name="语音转写 STT" desc="whisper 兼容接口">
              <v-switch v-model="form.stt.enable"/>
            </cfg-row>
            <cfg-row name="Python 计算沙盒" desc="calc:python3 超时秒">
              <div class="flex gap6">
                <v-switch v-model="form.calc.enable"/>
                <input type="number" class="input" style="width:90px" min="1" v-model.number="form.calc.timeout">
              </div>
            </cfg-row>
            <!-- MCP 服务端已拆到独立「MCP 服务」section -->

            <div class="full" style="border:1.5px dashed #f0b6c2;border-radius:12px;padding:14px;background:linear-gradient(180deg,#fff,#fff8f9)">
              <div class="flex gap10 mb10" style="font-weight:800;color:var(--rose)"><v-icon name="warn"/>终端执行(高危)</div>
              <div class="desc mb10" style="color:var(--rose)">主机直接执行 shell（无容器隔离）。仅 terminal 主人可用：发 <code>#agents设置主人</code>→控制台验证码→直接发码认领。每条命令需 <code>#确认</code>；黑名单硬拦。</div>
              <div class="cfg-grid">
                <cfg-row name="启用 shell 执行" desc="真机任意命令执行，无法 100% 安全" danger>
                  <v-switch v-model="form.terminal.enable"/>
                </cfg-row>
                <cfg-row name="命令超时上限(秒)">
                  <input type="number" class="input" style="width:110px" min="1" max="3600" v-model.number="form.terminal.maxTimeout">
                </cfg-row>
                <cfg-row class="full" name="命令黑名单" desc="灾难命令正则（即使已确认也硬拦；空=用默认 rm -rf / mkfs / dd of=/dev 等）">
                  <tag-editor v-model="form.terminal.blocklist" placeholder="回车添加"/>
                </cfg-row>
              </div>
            </div>

            <div class="full" style="border:1.5px dashed #b6c8f0;border-radius:12px;padding:14px;background:linear-gradient(180deg,#fff,#f6f8ff)">
              <div class="flex gap10 mb10" style="font-weight:800;color:#3b6">🌐 Stagehand 浏览器自动化</div>
              <div class="desc mb10">act/extract/observe 自然语言原语；仅框架主人可用，act 写动作需 <code>#确认</code>。会话 per-scope 隔离 + 5min idle 自动关。</div>
              <div class="cfg-grid">
                <cfg-row name="启用浏览器自动化" desc="依赖 @browserbasehq/stagehand+zod（云崽根 pnpm install）">
                  <v-switch v-model="form.stagehand.enable"/>
                </cfg-row>
                <cfg-row name="浏览器模式">
                  <select class="select" style="width:190px" v-model="form.stagehand.mode"><option v-for="o in OPT.shMode" :value="o[0]">{{ o[1] }}</option></select>
                </cfg-row>
                <cfg-row name="无头模式(本地)" desc="服务器建议开">
                  <v-switch v-model="form.stagehand.headless"/>
                </cfg-row>
                <cfg-row name="chrome 路径(本地,可选)" desc="空=默认/CHROME_PATH；可填复用已装 chrome">
                  <input class="input mono" style="width:200px" v-model="form.stagehand.executablePath" placeholder="留空=默认">
                </cfg-row>
                <cfg-row name="Browserbase apiKey" desc="云模式必填（bb_live_...）">
                  <input class="input mono" style="width:200px" v-model="form.stagehand.browserbaseApiKey" placeholder="bb_live_...">
                </cfg-row>
                <cfg-row name="云区域(可选)">
                  <select class="select" style="width:190px" v-model="form.stagehand.region"><option v-for="o in OPT.shRegion" :value="o[0]">{{ o[1] }}</option></select>
                </cfg-row>
                <cfg-row name="Stagehand 原生模型(可选)" desc="如 google/gemini-2.5-flash；空=复用插件 provider(仅 OpenAI 兼容)；云模式空=自动选">
                  <input class="input mono" style="width:200px" v-model="form.stagehand.modelName" placeholder="留空=复用插件 provider">
                </cfg-row>
                <cfg-row name="原生模型 apiKey(可选)">
                  <input class="input mono" style="width:200px" v-model="form.stagehand.modelApiKey">
                </cfg-row>
                <cfg-row name="会话空闲超时(毫秒)">
                  <input type="number" class="input" style="width:130px" min="60000" step="60000" v-model.number="form.stagehand.idleTimeoutMs">
                </cfg-row>
              </div>
            </div>

            <div class="full" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--border)">
              <div class="muted" style="font-size:12px;font-weight:700;margin-bottom:8px"><v-icon name="file"/> 媒体下载（yt-dlp · 仅主人，受约束）</div>
              <div class="cfg-grid">
                <cfg-row name="启用媒体下载" desc="web_download 工具；依赖系统 yt-dlp + ffmpeg（合并格式）">
                  <v-switch v-model="form.download.enable"/>
                </cfg-row>
                <cfg-row name="单文件大小上限(MB)" desc="yt-dlp --max-filesize，超限中止">
                  <input type="number" class="input" style="width:100px" min="1" v-model.number="form.download.maxMB">
                </cfg-row>
                <cfg-row name="发送大小上限(MB)" desc="超过此大小不自动发 QQ（返回本地路径供 SFTP 取）">
                  <input type="number" class="input" style="width:100px" min="1" v-model.number="form.download.sendLimitMB">
                </cfg-row>
                <cfg-row name="下载超时(秒)" desc="maxTimeoutSec">
                  <input type="number" class="input" style="width:100px" min="10" v-model.number="form.download.maxTimeoutSec">
                </cfg-row>
                <cfg-row name="yt-dlp 路径" desc="空=PATH 中的 yt-dlp">
                  <input class="input mono" style="width:180px" v-model="form.download.bin" placeholder="留空=自动">
                </cfg-row>
                <cfg-row name="输出目录" desc="空=插件 data/temp/downloads">
                  <input class="input mono" style="width:180px" v-model="form.download.dir" placeholder="留空=默认">
                </cfg-row>
              </div>
            </div>

            <div class="full" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--border)">
              <div class="muted" style="font-size:12px;font-weight:700;margin-bottom:8px"><v-icon name="bot"/> 子代理编排（spawn_subagent · 主 Agent 自主委派子任务）</div>
              <div class="cfg-grid">
                <cfg-row name="启用子代理委派" desc="注册 spawn_subagent，主模型自行决定是否创建子代理">
                  <v-switch v-model="form.multiagent.enable"/>
                </cfg-row>
                <cfg-row name="最大并发子代理" desc="同时运行子代理数上限（进程级 Semaphore）">
                  <input type="number" class="input" style="width:90px" min="1" max="10" v-model.number="form.multiagent.maxConcurrent">
                </cfg-row>
                <cfg-row name="单次对话上限" desc="单次对话最多创建几个子代理（防失控）">
                  <input type="number" class="input" style="width:90px" min="1" max="20" v-model.number="form.multiagent.maxSpawnsPerConversation">
                </cfg-row>
                <cfg-row name="子代理工具循环上限" desc="workerMaxTurns（防烧 token）">
                  <input type="number" class="input" style="width:90px" min="1" max="50" v-model.number="form.multiagent.workerMaxTurns">
                </cfg-row>
                <cfg-row name="子代理模型" desc="空=复用主模型；填便宜模型可降本">
                  <input class="input mono" style="width:200px" v-model="form.multiagent.workerModel" placeholder="留空=主模型">
                </cfg-row>
                <cfg-row full name="子代理默认工具" desc="模型未指定时的默认可用工具（仅 query 类安全）">
                  <tag-editor v-model="form.multiagent.defaultTools" placeholder="如 web_search / memory_search" :mono="true"/>
                </cfg-row>
              </div>
            </div>
          </div></div>
        </div>

        <!-- ===== MCP 服务（独立 section）===== -->
        <div :id="'cfg-mcp'" class="card cfg-section" :class="{open: open.mcp}">
          <div class="cfg-section-head" @click="open.mcp = !open.mcp">
            <span class="ico" style="background:var(--grad-teal)"><v-icon name="tool"/></span>
            <div><div class="card-title" style="font-size:14px">MCP 服务</div><div class="card-sub">MCP 协议服务端（stdio / http）· 请求超时</div></div>
            <v-icon class="arrow" name="chevron"/>
          </div>
          <div class="cfg-body" v-show="open.mcp"><div class="cfg-grid">
            <cfg-row name="MCP 请求超时(ms)" desc="mcp.requestTimeout">
              <input type="number" class="input" style="width:130px" min="1000" step="1000" v-model.number="form.mcp.requestTimeout">
            </cfg-row>
            <div class="full">
              <div class="flex between mb10">
                <div style="font-weight:800;font-size:13px">MCP 服务端列表</div>
                <button class="btn btn-primary btn-sm" @click="openNewMcp"><v-icon name="plus"/>新建 MCP</button>
              </div>
              <div v-if="!(form.mcp?.servers && Object.keys(form.mcp.servers).length)" class="muted-3" style="font-size:12px;padding:8px">暂无 MCP 服务，点「新建 MCP」添加</div>
              <div v-for="(srv, name) in (form.mcp?.servers || {})" :key="name" class="cfg-item" style="background:#fff;flex-direction:column;align-items:stretch;gap:8px">
                <div class="flex gap6 wrap" style="align-items:center">
                  <v-icon name="tool" style="color:var(--primary)"/>
                  <b style="min-width:90px;font-size:13px">{{ name }}</b>
                  <span class="chip" :class="srv._type === 'http' ? 'chip-rose' : 'chip-primary'" style="font-size:10px;padding:2px 8px">{{ srv._type }}</span>
                  <span style="flex:1"></span>
                  <button class="icon-btn danger" @click="delMcp(name)" title="删除"><v-icon name="trash"/></button>
                </div>
                <template v-if="srv._type === 'http'">
                  <input class="input mono" style="width:100%" v-model="srv._url" placeholder="url：https://mcp.example.com/sse">
                  <div class="muted-3" style="font-size:11px">headers（KEY: VALUE 每行一个）</div>
                  <textarea class="textarea mono" style="min-height:48px;width:100%" v-model="srv._headersText" placeholder="Authorization: Bearer xxx"></textarea>
                </template>
                <template v-else>
                  <div class="muted-3" style="font-size:11px">stdio 配置（粘贴单服务 JSON：command/args/env）</div>
                  <textarea class="textarea mono" style="min-height:120px;width:100%;font-size:12px" v-model="srv._json" spellcheck="false" placeholder='{ "command": "npx", "args": ["-y", "@z_ai/mcp-server"], "env": { "Z_AI_API_KEY": "xxx" } }'></textarea>
                </template>
              </div>
            </div>
          </div></div>
        </div>

        <!-- 新建 MCP 弹窗（弹窗内始终有 stdio/http 选择）-->
        <v-modal v-if="mcpModal.show" title="新建 MCP 服务" icon="plus" @close="mcpModal.show = false">
          <div class="flex gap6 wrap" style="align-items:center;margin-bottom:10px">
            <input class="input mono" style="width:170px;font-weight:700" v-model="mcpModal.name" placeholder="服务名（如 zai-mcp-server）">
            <select class="select" style="width:110px" v-model="mcpModal.type">
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </div>
          <template v-if="mcpModal.type === 'http'">
            <input class="input mono" style="width:100%;margin-bottom:8px" v-model="mcpModal.url" placeholder="url：https://mcp.example.com/sse">
            <div class="muted-3" style="font-size:11px;margin-bottom:4px">headers（KEY: VALUE 每行一个）</div>
            <textarea class="textarea mono" style="min-height:80px;width:100%" v-model="mcpModal.headersText" placeholder="Authorization: Bearer xxx"></textarea>
          </template>
          <template v-else>
            <div class="muted-3" style="font-size:11px;margin-bottom:4px">stdio 配置 JSON（command/args/env）</div>
            <textarea class="textarea mono" style="min-height:140px;width:100%;font-size:12px" v-model="mcpModal.stdioJson" spellcheck="false"></textarea>
          </template>
          <template #foot>
            <button class="btn btn-ghost" @click="mcpModal.show = false">取消</button>
            <button class="btn btn-primary" @click="confirmNewMcp"><v-icon name="check"/>添加</button>
          </template>
        </v-modal>

        <!-- 保存栏 -->
        <Transition name="fade">
          <div v-if="dirty" class="cfg-savebar">
            <span class="dirty-dot"></span>
            <span style="font-weight:700;font-size:13px">有未保存的修改</span>
            <span class="muted-3" style="font-size:12px">Mock 环境:保存仅写入内存,刷新还原</span>
            <div style="margin-left:auto" class="flex gap10">
              <button class="btn btn-ghost" @click="reset"><v-icon name="undo"/>放弃修改</button>
              <button class="btn btn-primary" @click="save"><v-icon name="save"/>保存并热加载</button>
            </div>
          </div>
        </Transition>
      </div>

    </div>`,
  }
})()
