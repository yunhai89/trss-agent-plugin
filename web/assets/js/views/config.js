/** 视图:配置中心(§1 全量配置项,可编辑 mock) */
(function () {
  window.VIEWS = window.VIEWS || {}

  /* 行容器:左名称/说明,右控件 */
  const CfgRow = {
    name: 'CfgRow',
    props: { name: String, desc: { type: String, default: '' }, danger: Boolean, full: Boolean },
    template: `
    <div class="cf-item" :class="{full: full, dg: danger}">
      <div class="info">
        <div class="name">{{ name }}<span v-if="danger" class="pill p-rose" style="margin-left:7px;font-size:10px;padding:3px 8px">高危</span></div>
        <div class="desc" v-if="desc">{{ desc }}</div>
      </div>
      <div class="ctl"><slot/></div>
    </div>`,
  }

  /* 标签编辑器 */
  const TagEditor = {
    name: 'TagEditor',
    props: { modelValue: { type: Array, required: true }, placeholder: { type: String, default: '回车添加' }, mono: { type: Boolean, default: false } },
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
    <div class="row g6 wrap" :style="'justify-content:flex-end' + (mono ? ';font-family:var(--mono,monospace)' : '')">
      <span v-for="(t, i) in modelValue" :key="t" class="pill p-pri" :class="{mono: mono}" style="cursor:default">
        {{ t }}<v-icon name="x" style="cursor:pointer" @click="del(i)"/>
      </span>
      <input v-model="input" class="inp" :class="{mono: mono}" style="width:100px;padding:5px 10px;font-size:12px" :placeholder="placeholder" enterkeyhint="enter" @keydown.enter.prevent="add" @keyup.enter.prevent="add">
      <button type="button" class="btn b-soft b-sm" @click="add" title="添加"><v-icon name="plus"/></button>
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
      <div class="row g6">
        <input class="inp mono" style="flex:1;min-width:140px" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" :placeholder="placeholder">
        <button type="button" class="btn b-soft b-sm" @click="load" :disabled="loading">{{ loading ? '加载中…' : '拉取列表' }}</button>
      </div>
      <div v-if="open" @click="open = false" style="position:fixed;inset:0;z-index:20"></div>
      <div v-if="open" class="mp-drop">
        <div style="padding:8px;border-bottom:1px solid var(--line)">
          <input class="inp" style="width:100%;font-size:12px;padding:6px 10px" v-model="search" placeholder="搜索模型 id / 名称（无匹配可直接上方手填）">
        </div>
        <div style="overflow:auto;flex:1">
          <div v-if="!filtered.length" class="mut2" style="padding:10px;font-size:12px">无匹配模型，可直接在输入框手填</div>
          <div v-for="m in filtered" :key="m.id" @click="setModel(m.id)" class="mp-item">
            <b class="mono">{{ m.id }}</b> <span v-if="m.name && m.name !== m.id" class="mut2">{{ m.name }}</span>
          </div>
        </div>
      </div>
    </div>`,
  }

  const OPT = {
    trigger: [['at', '@机器人触发'], ['command', '触发词触发'], ['both', '两者皆可']],
    protocol: [['openai', 'OpenAI 兼容'], ['anthropic', 'Anthropic 兼容'], ['gemini', 'Gemini 原生(官方SDK)']],
    preset: [['deepseek', 'DeepSeek'], ['openai', 'OpenAI'], ['gemini', 'Gemini'], ['dashscope', '通义(DashScope)'], ['zhipu', '智谱'], ['moonshot', 'Kimi(Moonshot)'], ['mimo', '小米(MiMo)'], ['minimax', 'MiniMax(M3)'], ['doubao', '豆包(火山方舟)'], ['anthropic', 'Anthropic'], ['openrouter', 'OpenRouter(聚合)'], ['opencode', 'OpenCode Zen'], ['opencode-go', 'OpenCode Go(订阅)']],
    permission: [['master', '仅主人'], ['admin', '管理员'], ['owner', '群主'], ['all', '所有人']],
    guardAction: [['block', '拦截(block)'], ['flag', '隔离标注(flag)'], ['sanitize', '脱敏(sanitize)']],
    guardSensitivity: [['low', '低 (0.95)'], ['medium', '中 (0.7)'], ['high', '高 (0.5)']],
    reflect: [['off', '关闭'], ['auto', '自动'], ['always', '总是']],
    replyMode: [['image', '图片渲染'], ['text', '纯文本']],
    degrade: [['describe', 'describe 转文字描述'], ['ignore', 'ignore 忽略']],
    researchPerm: [['master', '仅主人(防滥用)'], ['all', '所有人']],
    shMode: [['local', 'local 本地(Playwright+chromium,默认)'], ['cloud', 'cloud Browserbase 云']],
    crawlEngine: [['crawl4ai', 'crawl4ai 真浏览器(默认)'], ['fetch', 'fetch 纯 HTTP']],
    dgRenderer: [['kroki', 'kroki 自托管容器(默认)']],
    dgFallback: [['none', '无(结构化失败)'], ['beautiful-mermaid', '本地 beautiful-mermaid']],
    dgTheme: [['paper-blue', '米白纸蓝'], ['soft-pastel', '柔和粉彩'], ['technical', '技术蓝灰'], ['midnight', '午夜深色'], ['sketch', '手绘素描(仅D2)']],
    dgFormat: [['png', 'PNG 图片'], ['svg', 'SVG 源文件']],
    dgLayout: [['elk', 'elk(复杂图,默认)'], ['dagre', 'dagre(轻量)']],
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
        // 豆包（火山方舟 Ark）：完全 OpenAI 兼容（chat /chat/completions + embedding /embeddings 同根）；
        // model 填推理接入点 ID（ep-xxx）或模型 ID；embedding 模型（doubao-embedding）走同一 baseURL
        doubao: 'https://ark.cn-beijing.volces.com/api/v3',
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
        // 无损压缩 + 网页抓取引擎兜底（旧 config 无此字段时 v-model 不报错）
        if (!form.compaction) form.compaction = {}
        if (form.compaction.enable == null) form.compaction.enable = true
        if (!form.kb) form.kb = {}
        if (!form.kb.crawl) form.kb.crawl = {}
        if (form.kb.crawl.engine == null) form.kb.crawl.engine = 'crawl4ai'
        // diagram 示意图兜底（旧配置无此块防 v-model 报错）
        if (!form.diagram) form.diagram = {}
        if (!form.diagram.kroki) form.diagram.kroki = {}
        if (form.diagram.enable == null) form.diagram.enable = true
        if (form.diagram.renderer == null) form.diagram.renderer = 'kroki'
        if (form.diagram.fallbackRenderer == null) form.diagram.fallbackRenderer = 'none'
        if (form.diagram.defaultTheme == null) form.diagram.defaultTheme = 'paper-blue'
        if (form.diagram.defaultFormat == null) form.diagram.defaultFormat = 'png'
        if (form.diagram.kroki.endpoint == null) form.diagram.kroki.endpoint = 'http://127.0.0.1:8000'
        if (form.diagram.kroki.allowPublicEndpoint == null) form.diagram.kroki.allowPublicEndpoint = false
        if (!form.diagram.kroki.circuitBreaker) form.diagram.kroki.circuitBreaker = {}
        if (form.diagram.kroki.circuitBreaker.enabled == null) form.diagram.kroki.circuitBreaker.enabled = true
        if (!form.diagram.kroki.d2) form.diagram.kroki.d2 = {}
        if (form.diagram.kroki.d2.layout == null) form.diagram.kroki.d2.layout = 'elk'
        if (!form.terminal) form.terminal = {}
        if (form.terminal.skipConfirm == null) form.terminal.skipConfirm = false
        if (!form.download) form.download = {}
        if (!form.multiagent) form.multiagent = {}
        // 统一模型配置块兜底（recall/selfReview/vision 原有；humanize/groupWorld 为新纳入字段）
        if (!form.recall) form.recall = {}
        if (!form.selfReview) form.selfReview = {}
        if (!form.vision) form.vision = {}
        if (!form.humanize) form.humanize = {}
        if (!form.humanize.planner) form.humanize.planner = {}
        if (form.humanize.planner.model == null) form.humanize.planner.model = ''
        if (!form.humanize.replyer) form.humanize.replyer = {}
        if (form.humanize.replyer.model == null) form.humanize.replyer.model = ''
        if (!form.groupWorld) form.groupWorld = {}
        if (!form.groupWorld.analysis) form.groupWorld.analysis = {}
        if (form.groupWorld.analysis.modelProfile == null) form.groupWorld.analysis.modelProfile = ''
        // selfState 兜底
        if (!form.selfState) form.selfState = {}
        if (form.selfState.enabled == null) form.selfState.enabled = false
        if (form.selfState.shadowMode == null) form.selfState.shadowMode = true
        if (!form.selfState.emotion) form.selfState.emotion = {}
        if (form.selfState.emotion.maxNormalImpulse == null) form.selfState.emotion.maxNormalImpulse = 0.2
        if (form.selfState.emotion.maxHighSalienceImpulse == null) form.selfState.emotion.maxHighSalienceImpulse = 0.35
        if (form.selfState.emotion.moodEmaAlpha == null) form.selfState.emotion.moodEmaAlpha = 0.3
        if (form.selfState.emotion.moodResetHours == null) form.selfState.emotion.moodResetHours = 6
        if (!form.selfState.eventDetection) form.selfState.eventDetection = {}
        if (form.selfState.eventDetection.semantic == null) form.selfState.eventDetection.semantic = true
        if (!form.selfState.resentment) form.selfState.resentment = {}
        if (form.selfState.resentment.maxSingleEventDelta == null) form.selfState.resentment.maxSingleEventDelta = 0.05
        if (!form.selfState.expectations) form.selfState.expectations = {}
        if (form.selfState.expectations.minimumWindowSeconds == null) form.selfState.expectations.minimumWindowSeconds = 90
        if (form.selfState.expectations.minIgnoredConfidence == null) form.selfState.expectations.minIgnoredConfidence = 0.65
        if (!form.selfState.stability) form.selfState.stability = {}
        if (form.selfState.stability.maxNegativeMoodHours == null) form.selfState.stability.maxNegativeMoodHours = 24
        // 厂商/模型注册表（数组整体提交）
        if (!Array.isArray(form.llmProviders)) form.llmProviders = []
        if (!Array.isArray(form.llmModels)) form.llmModels = []
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
      /* —— 厂商/模型注册表：厂商=端点(protocol/preset/baseURL/apiKey)，模型=绑厂商的条目；功能槽位引用模型 —— */
      const genId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      const provById = (id) => id === 'main'
        ? { id: 'main', name: '主厂商', protocol: form.protocol, preset: form.preset, baseURL: form.baseURL, apiKey: form.apiKey }
        : form.llmProviders.find((p) => p.id === id)
      const provName = (id) => id === 'main' ? '主厂商' : (form.llmProviders.find((p) => p.id === id)?.name || id || '?')
      // 附加厂商：列表 + 查看/编辑弹窗（与模型列表同交互）；选预设/切协议自动填 baseURL
      const provModal = reactive({ show: false, mode: 'view', index: -1, draft: {} })
      const openProvView = (i) => { provModal.show = true; provModal.mode = 'view'; provModal.index = i; provModal.draft = JSON.parse(JSON.stringify(form.llmProviders[i] || {})) }
      const openProvEdit = (i) => {
        provModal.show = true; provModal.mode = 'edit'
        if (i === -1) { provModal.index = -1; provModal.draft = { id: genId('p'), name: '', protocol: form.protocol || 'openai', preset: '', baseURL: '', apiKey: '' } }
        else { provModal.index = i; provModal.draft = JSON.parse(JSON.stringify(form.llmProviders[i] || {})) }
      }
      const saveProv = () => {
        const d = provModal.draft
        if (!String(d.baseURL || '').trim()) { toast('接口地址 baseURL 不能为空', 'warn'); return }
        if (provModal.index === -1) form.llmProviders.push(JSON.parse(JSON.stringify(d)))
        else form.llmProviders.splice(provModal.index, 1, JSON.parse(JSON.stringify(d)))
        provModal.show = false
      }
      const delProvider = (i) => form.llmProviders.splice(i, 1)
      const onProvPreset = (p) => {
        const u = PRESET_URLS[p.preset]
        if (u) p.baseURL = typeof u === 'string' ? u : (u[p.protocol] || u.openai)
      }
      const testing = reactive({})
      const testProvider = async (p) => {
        testing[p.id] = true
        try {
          const list = await window.api.get('/models', { protocol: p.protocol, baseURL: p.baseURL, apiKey: p.apiKey, preset: p.preset })
          toast(`「${p.name || p.baseURL || '未命名'}」连接成功，可用模型 ${list.length} 个`, 'success')
        } catch (e) { toast(`「${p.name || p.baseURL || '未命名'}」连接失败：${e.message}`, 'error') }
        finally { testing[p.id] = false }
      }
      // 模型注册表：列表 + 查看/编辑弹窗（编辑可改思考开关等参数；查看只读）
      const modelModal = reactive({ show: false, mode: 'view', index: -1, draft: {} })
      const THK_ZH = { inherit: '继承全局', on: '开启思考', off: '关闭思考' }
      const openModelView = (i) => { modelModal.show = true; modelModal.mode = 'view'; modelModal.index = i; modelModal.draft = JSON.parse(JSON.stringify(form.llmModels[i] || {})) }
      const openModelEdit = (i) => {
        modelModal.show = true; modelModal.mode = 'edit'
        if (i === -1) { modelModal.index = -1; modelModal.draft = { id: genId('m'), name: '', providerId: 'main', model: '', temperature: null, maxTokens: null, thinking: 'inherit', note: '' } }
        else { modelModal.index = i; modelModal.draft = JSON.parse(JSON.stringify(form.llmModels[i] || {})) }
        if (!modelModal.draft.thinking) modelModal.draft.thinking = 'inherit'
      }
      const saveModel = () => {
        const d = modelModal.draft
        if (!String(d.model || '').trim()) { toast('模型 ID 不能为空', 'warn'); return }
        if (modelModal.index === -1) form.llmModels.push(JSON.parse(JSON.stringify(d)))
        else form.llmModels.splice(modelModal.index, 1, JSON.parse(JSON.stringify(d)))
        modelModal.show = false
      }
      const delModel = (i) => form.llmModels.splice(i, 1)

      /* 功能分配：槽位 ← 注册表模型。writePath 主端点类功能（旁路/记忆/评审/子代理/伪人/群世界）
         与主 provider 同端点，只能选主厂商模型；视觉/Embedding/主模型选其它厂商时自动同步其端点。 */
      const FEATURES = [
        { key: 'main', label: '主模型', mainOnly: false, hint: '对话主力：推理/工具调用/复杂任务，建议用强模型', get: () => form.model, set: (v) => { form.model = v } },
        { key: 'utility', label: '旁路小模型', mainOnly: true, hint: '高频小任务（意图识别/摘要），推荐便宜快速的小模型', get: () => form.utilityModel, set: (v) => { form.utilityModel = v } },
        { key: 'vision', label: '视觉模型', mainOnly: false, hint: '看图/多模态理解，必须选支持图片输入的模型', get: () => form.vision?.model || '', set: (v) => { if (!form.vision) form.vision = {}; form.vision.model = v } },
        { key: 'recall', label: '记忆抽取模型', mainOnly: true, hint: '短文本结构化抽取，小模型即可，量大省钱', get: () => form.recall?.model || '', set: (v) => { if (!form.recall) form.recall = {}; form.recall.model = v } },
        { key: 'embed', label: 'Embedding 模型', mainOnly: false, hint: '语义检索/近邻检测用，需厂商有 /embeddings 端点（DeepSeek 无，留空则全部回落词面匹配）', get: () => form.recall?.embedProvider || '', set: (v) => { if (!form.recall) form.recall = {}; form.recall.embedProvider = v } },
        { key: 'review', label: '自进化评审模型', mainOnly: true, hint: '代码/方案评审，输出结构化结论，中等模型够用', get: () => form.selfReview?.model || '', set: (v) => { if (!form.selfReview) form.selfReview = {}; form.selfReview.model = v } },
        { key: 'worker', label: '子代理模型', mainOnly: true, hint: '并行子任务执行，性价比优先（可多实例并发）', get: () => form.multiagent?.workerModel || '', set: (v) => { if (!form.multiagent) form.multiagent = {}; form.multiagent.workerModel = v } },
        { key: 'hzp', label: '伪人 Planner 模型', mainOnly: true, hint: '群聊参与决策（该不该接话），高频调用，小-中模型重速度', get: () => form.humanize?.planner?.model || '', set: (v) => { if (!form.humanize) form.humanize = {}; if (!form.humanize.planner) form.humanize.planner = {}; form.humanize.planner.model = v } },
        { key: 'hzr', label: '伪人 Replyer 模型', mainOnly: true, hint: '写群聊台词要像真人，语感重要，建议与主模型同档', get: () => form.humanize?.replyer?.model || '', set: (v) => { if (!form.humanize) form.humanize = {}; if (!form.humanize.replyer) form.humanize.replyer = {}; form.humanize.replyer.model = v } },
        { key: 'gw', label: '群世界分析模型', mainOnly: true, hint: '批量 JSON 抽取（画像/事件），小模型即可，注意每日预算', get: () => form.groupWorld?.analysis?.modelProfile || '', set: (v) => { if (!form.groupWorld) form.groupWorld = {}; if (!form.groupWorld.analysis) form.groupWorld.analysis = {}; form.groupWorld.analysis.modelProfile = v } },
      ]
      const featureVal = (f) => f.get() || ''
      // 下拉候选 = 模型列表注册表 ∪ 配置中已在用的模型（各功能当前值 + 回退链）——已配置未入册的也能直接选
      const knownModels = computed(() => {
        // 注册表别名索引：raw 条目（当前配置在用/回退链）有同 id 注册条目时也带别名显示
        const aliasOf = new Map()
        for (const m of form.llmModels || []) if (m && m.model && !aliasOf.has(m.model)) aliasOf.set(m.model, m.name || '')
        const seen = new Map()
        for (const m of form.llmModels || []) {
          if (!m || !m.model) continue
          const k = m.model + '|' + (m.name || '') // 同 id 不同别名各自保留
          if (!seen.has(k)) seen.set(k, { model: m.model, label: (m.name ? m.name + ' · ' : '') + m.model, fromRegistry: true, id: m.id, main: m.providerId === 'main', provName: m.providerId === 'main' ? '' : provName(m.providerId) })
        }
        for (const f of FEATURES) {
          const v = featureVal(f)
          if (!v || aliasOf.has(v)) continue // 已有注册条目（带别名）就不重复列
          if (![...seen.values()].some((x) => x.model === v)) seen.set(v + '|__raw', { model: v, label: (aliasOf.get(v) ? aliasOf.get(v) + ' · ' : '') + v + '（当前配置在用）', fromRegistry: false, main: true, provName: '' })
        }
        for (const fb of form.fallbackModels || []) {
          if (!fb?.model || aliasOf.has(fb.model)) continue
          if (![...seen.values()].some((x) => x.model === fb.model)) seen.set(fb.model + '|__fb', { model: fb.model, label: (aliasOf.get(fb.model) ? aliasOf.get(fb.model) + ' · ' : '') + fb.model + '（回退链）', fromRegistry: false, main: true, provName: '' })
        }
        return [...seen.values()]
      })
      const featureSel = (f) => {
        const v = featureVal(f)
        if (!v) return ''
        const hit = form.llmModels.find((m) => m.model === v && (!f.mainOnly || m.providerId === 'main'))
        if (hit) return hit.id
        return knownModels.value.some((m) => m.model === v) ? 'raw:' + v : '__custom'
      }
      const onFeatureSel = (f, val) => {
        if (val === '__custom') return // 手动模式：保留当前值，走旁边的输入框
        if (val === '') { f.set(''); return }
        if (val.startsWith('raw:')) { f.set(val.slice(4)); return } // 已配置未入册的模型：直接写值
        const m = form.llmModels.find((x) => x.id === val)
        if (!m) return
        f.set(m.model)
        const prov = provById(m.providerId)
        const isMain = m.providerId === 'main'
        if (f.key === 'main' && !isMain && prov?.baseURL) {
          form.protocol = prov.protocol || form.protocol; form.preset = prov.preset || ''; form.baseURL = prov.baseURL; form.apiKey = prov.apiKey
          toast('已将该厂商接入信息同步为主厂商（基础 / 模型）', 'info')
        }
        if (f.key === 'vision') {
          if (!form.vision) form.vision = {}
          if (!isMain && prov?.baseURL) { form.vision.protocol = prov.protocol || ''; form.vision.preset = prov.preset || ''; form.vision.baseURL = prov.baseURL; form.vision.apiKey = prov.apiKey }
          else { form.vision.protocol = ''; form.vision.preset = ''; form.vision.baseURL = ''; form.vision.apiKey = '' }
        }
        if (f.key === 'embed') {
          if (!form.recall) form.recall = {}
          if (!isMain && prov?.baseURL) { form.recall.embedBaseURL = prov.baseURL; form.recall.embedApiKey = prov.apiKey }
          else { form.recall.embedBaseURL = ''; form.recall.embedApiKey = '' }
        }
      }

      const sections = [
        { id: 'basic', name: '基础 / 模型', icon: 'cpu', grad: 'var(--grad)' },
        { id: 'providers', name: '厂商配置', icon: 'tool', grad: 'var(--grad-vio)' },
        { id: 'models', name: '模型列表', icon: 'bot', grad: 'var(--grad-mint)' },
        { id: 'features', name: '功能分配', icon: 'zap', grad: 'var(--grad-honey)' },
        { id: 'selfstate', name: '自我状态', icon: 'bot', grad: 'var(--grad-rose)' },
        { id: 'reason', name: '推理参数', icon: 'zap', grad: 'var(--grad-sky)' },
        { id: 'reply', name: '进度 / 回复渲染', icon: 'send', grad: 'var(--grad-mint)' },
        { id: 'memory', name: '记忆系统', icon: 'memory', grad: 'var(--grad-honey)' },
        { id: 'evolution', name: '自进化', icon: 'evolution', grad: 'var(--grad-rose)' },
        { id: 'security', name: '权限 / 安全 / 日志', icon: 'shield', grad: 'var(--grad)' },
        { id: 'mcp', name: 'MCP 服务', icon: 'tool', grad: 'var(--grad-mint)' },
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
        // 厂商/模型注册表 + 功能分配
        delProvider, testProvider, testing, provById, provName, provModal, openProvView, openProvEdit, saveProv,
        delModel, modelModal, openModelView, openModelEdit, saveModel, THK_ZH, knownModels, onProvPreset,
        FEATURES, featureVal, featureSel, onFeatureSel,
      }
    },
    template: `
    <div class="cf-wrap">
      <!-- 锚点导航 -->
      <div class="cf-nav">
        <a v-for="s in sections" :key="s.id" :class="{on: activeSec === s.id}" @click="jump(s.id)">{{ s.name }}</a>
      </div>

      <div>
        <!-- ===== §1.1 基础 / 模型 ===== -->
        <div :id="'cfg-basic'" class="card cf-sec" :class="{open: open.basic}">
          <div class="cf-sh" @click="open.basic = !open.basic">
            <span class="ct-ico" style="background:var(--grad)"><v-icon name="cpu"/></span>
            <div><div class="ct-t">基础 / 模型</div><div class="ct-s">触发方式、协议预设、主模型与回退 · 全部模型统一在此配置</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.basic"><div class="cf-grid">
            <div class="cf-sub"><v-icon name="send"/>触发 / 会话</div>
            <cfg-row name="触发模式" desc="at=被@ / command=触发词 / both 两者">
              <select class="sel" style="width:150px" v-model="form.trigger"><option v-for="o in OPT.trigger" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="触发词" desc="command/both 时生效">
              <input class="inp" style="width:150px" v-model="form.triggerCommand" placeholder="#ai">
            </cfg-row>
            <cfg-row name="多用户数据隔离" desc="开启后按 (群,用户) 隔离记忆与会话">
              <v-switch v-model="form.isolation.enable"/>
            </cfg-row>

            <div class="cf-sub"><v-icon name="link"/>主接入（对话主模型）</div>
            <cfg-row name="协议" desc="API 兼容协议">
              <select class="sel" style="width:170px" v-model="form.protocol"><option v-for="o in OPT.protocol" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="厂商预设" desc="自动填 baseURL / headers / 字段映射">
              <select class="sel" style="width:170px" v-model="form.preset"><option v-for="o in OPT.preset" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="接口地址 baseURL" desc="OpenAI 兼容接口地址">
              <input class="inp" style="width:260px" v-model="form.baseURL" placeholder="https://api.deepseek.com">
            </cfg-row>
            <cfg-row name="API Key" desc="主模型密钥(明文)">
              <input class="inp mono" style="width:260px" v-model="form.apiKey" placeholder="sk-...">
            </cfg-row>
            <cfg-row full name="主模型 ID" desc="对话主模型；可手输，或点「拉取列表」按当前厂商拉取可用模型">
              <model-picker v-model="form.model" :protocol="form.protocol" :base-url="form.baseURL" :api-key="form.apiKey" :preset="form.preset"/>
            </cfg-row>
            <div class="full" v-if="form.preset === 'openrouter'" style="margin-top:6px;padding:10px;border:1px dashed var(--line);border-radius:10px">
              <div class="row-b mb8">
                <div style="font-weight:800;font-size:13px">🔍 OpenRouter 模型搜索</div>
                <button class="btn b-soft b-sm" @click="loadOrModels">{{ orLoading ? '加载中…' : (orModels.length ? '已加载 '+orModels.length+' 个' : '加载模型目录') }}</button>
              </div>
              <div v-if="orModels.length">
                <input class="inp" style="width:100%" v-model="orSearch" placeholder="搜索模型 id/名称（如 gpt / claude / gemini）">
                <div style="max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:8px;margin-top:6px">
                  <div v-for="m in orFiltered" :key="m.id" @click="pickOrModel(m.id)" style="padding:6px 10px;cursor:pointer;border-bottom:1px solid var(--line);font-size:12px">
                    <b>{{ m.id }}</b> <span class="mut2">{{ m.name }}<span v-if="m.context"> · {{ Math.round(m.context/1000) }}k ctx</span><span v-if="m.prompt"> · $ {{ (m.prompt * 1000000).toFixed(2) }}/M</span></span>
                  </div>
                </div>
              </div>
              <div class="row-b" style="margin-top:10px">
                <span class="mut" style="font-size:12px">Key 余额</span>
                <button class="btn b-line b-sm" @click="loadOrKey">查询余额</button>
              </div>
              <div v-if="orKey" class="mut2" style="font-size:11px;margin-top:4px">
                剩余 $ {{ orKey.limit_remaining ?? '∞' }} / 上限 $ {{ orKey.limit ?? '∞' }} · 已用 $ {{ orKey.usage ?? 0 }}（本月 $ {{ orKey.usage_monthly ?? 0 }}）<span v-if="orKey.is_free_tier"> · 免费层</span>
              </div>
            </div>
            <cfg-row name="旁路小模型" desc="进度播报等旁路任务;留空=主模型">
              <input class="inp" style="width:180px" v-model="form.utilityModel" placeholder="留空=主模型">
            </cfg-row>

            <div class="cf-sub"><v-icon name="shield"/>网络 / 容错</div>
            <cfg-row name="代理" desc="http 代理(留空=直连)">
              <input class="inp mono" style="width:240px" v-model="form.proxy" placeholder="http://127.0.0.1:7890">
            </cfg-row>

            <div class="full">
              <div class="row-b mb12">
                <div style="font-weight:800;font-size:13px">回退模型链</div>
                <button class="btn b-soft b-sm" @click="addFallback"><v-icon name="plus"/>添加回退</button>
              </div>
              <TransitionGroup name="list" tag="div" style="display:flex;flex-direction:column;gap:10px;position:relative">
                <div v-for="(fb, i) in form.fallbackModels" :key="i" class="mem-row">
                  <div class="row g10 wrap" style="flex:1">
                    <span class="pill p-line mono" style="min-width:26px;justify-content:center">{{ i + 1 }}</span>
                    <input class="inp" style="width:190px" v-model="fb.model" placeholder="模型 ID">
                    <select class="sel" style="width:130px" v-model="fb.protocol"><option v-for="o in OPT.protocol" :value="o[0]">{{ o[1] }}</option></select>
                    <input class="inp mono" style="width:170px" v-model="fb.baseURL" placeholder="baseURL">
                    <input class="inp mono" style="width:150px" v-model="fb.apiKey" placeholder="apiKey">
                  </div>
                  <button class="bic dg" @click="delFallback(i)"><v-icon name="trash"/></button>
                </div>
              </TransitionGroup>
            </div>

            <!-- 各功能模型选择已拆分至 厂商配置 / 模型配置 两个分区 -->
            <div class="full" style="margin-top:6px;padding:10px 14px;border:1px dashed var(--line);border-radius:10px">
              <div class="mut2" style="font-size:12px"><v-icon name="info"/> 多服务商与各功能模型选择已拆分至 <b>厂商配置</b>（服务商地址/Key）、<b>模型列表</b>（添加/管理模型）与 <b>功能分配</b>（各功能用哪个模型）三个分区。</div>
            </div>
          </div></div>
        </div>

        <!-- ===== 厂商配置 ===== -->
        <div :id="'cfg-providers'" class="card cf-sec" :class="{open: open.providers}">
          <div class="cf-sh" @click="open.providers = !open.providers">
            <span class="ct-ico" style="background:var(--grad-vio)"><v-icon name="tool"/></span>
            <div><div class="ct-t">厂商配置（LLM 服务商）</div><div class="ct-s">主厂商在「基础 / 模型」编辑；此处维护附加服务商，模型在「模型配置」中绑定厂商</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.providers"><div class="cf-grid">
            <div class="full" style="padding:11px 14px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.42)">
              <div class="row g10 wrap" style="align-items:center">
                <span class="pill p-pri">主厂商</span>
                <span class="mut mono" style="font-size:12px">{{ form.protocol }}{{ form.preset ? ' · ' + form.preset : '' }}</span>
                <span class="mut2 mono ell" style="font-size:12px;flex:1;min-width:180px">{{ form.baseURL || '(未填接口地址)' }}</span>
                <span class="pill" :class="form.apiKey ? 'p-mint' : 'p-line'" style="font-size:11px">{{ form.apiKey ? 'Key 已填' : 'Key 未填' }}</span>
                <button type="button" class="btn b-line b-sm" @click="jump('basic')"><v-icon name="edit"/>前往「基础 / 模型」编辑</button>
              </div>
            </div>
            <div class="full">
              <div class="row-b mb12">
                <div style="font-weight:800;font-size:13px">附加厂商（{{ form.llmProviders.length }}）</div>
                <button class="btn b-soft b-sm" @click="openProvEdit(-1)"><v-icon name="plus"/>添加厂商</button>
              </div>
              <div style="display:flex;flex-direction:column;gap:8px">
                <div v-for="(p, i) in form.llmProviders" :key="p.id" class="card" style="padding:10px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                  <div style="flex:1;min-width:220px">
                    <div class="row g6" style="align-items:center">
                      <b style="font-size:13px">{{ p.name || '（未命名）' }}</b>
                      <span class="pill p-line" style="font-size:10px">{{ (OPT.protocol.find((o) => o[0] === p.protocol) || ['', p.protocol])[1] }}</span>
                      <span v-if="p.preset" class="pill p-honey" style="font-size:10px">{{ (OPT.preset.find((o) => o[0] === p.preset) || ['', p.preset])[1] }}</span>
                    </div>
                    <div class="mono mut" style="font-size:12px;margin-top:2px">{{ p.baseURL || '(未填接口地址)' }}</div>
                  </div>
                  <div class="row g6">
                    <button class="btn b-line b-sm" @click="testProvider(p)" :disabled="testing[p.id]">{{ testing[p.id] ? '测试中…' : '测试' }}</button>
                    <button class="btn b-line b-sm" @click="openProvView(i)"><v-icon name="search"/>查看</button>
                    <button class="btn b-soft b-sm" @click="openProvEdit(i)"><v-icon name="edit"/>编辑</button>
                    <button class="btn b-line b-sm" style="color:var(--rose,#e5484d)" @click="delProvider(i)"><v-icon name="trash"/>删除</button>
                  </div>
                </div>
              </div>
              <div v-if="!form.llmProviders.length" class="mut2" style="font-size:12px;padding:6px 2px">暂无附加厂商——只用主厂商可不添加；需要跨厂商模型（如视觉/Embedding 用别家）时在此添加。</div>
            </div>
          </div></div>
        </div>

        <!-- ===== 模型配置 ===== -->
        <div :id="'cfg-models'" class="card cf-sec" :class="{open: open.models}">
          <div class="cf-sh" @click="open.models = !open.models">
            <span class="ct-ico" style="background:var(--grad-mint)"><v-icon name="bot"/></span>
            <div><div class="ct-t">模型列表</div><div class="ct-s">在已建厂商下创建/管理模型（可拉取列表）；各功能用哪个模型 → 「功能分配」分区</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.models"><div class="cf-grid">
            <div class="full">
              <div class="row-b mb12">
                <div style="font-weight:800;font-size:13px">模型列表（{{ form.llmModels.length }}）</div>
                <button class="btn b-soft b-sm" @click="openModelEdit(-1)"><v-icon name="plus"/>添加模型</button>
              </div>
              <div style="display:flex;flex-direction:column;gap:8px">
                <div v-for="(m, i) in form.llmModels" :key="m.id" class="card" style="padding:10px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                  <div style="flex:1;min-width:220px">
                    <div class="row g6" style="align-items:center">
                      <b style="font-size:13px">{{ m.name || '（未命名）' }}</b>
                      <span class="pill p-line" style="font-size:10px">{{ m.providerId === 'main' ? '主厂商' : provName(m.providerId) }}</span>
                      <span v-if="m.thinking === 'on'" class="pill p-honey" style="font-size:10px">思考</span>
                      <span v-else-if="m.thinking === 'off'" class="pill p-rose" style="font-size:10px">禁思考</span>
                    </div>
                    <div class="mono mut" style="font-size:12px;margin-top:2px">{{ m.model || '(未填模型 ID)' }}</div>
                    <div class="mut2" style="font-size:11px;margin-top:2px" v-if="m.note || m.temperature != null || m.maxTokens != null">{{ [m.note, m.temperature != null ? '温度 ' + m.temperature : '', m.maxTokens != null ? 'maxTokens ' + m.maxTokens : ''].filter(Boolean).join(' · ') }}</div>
                  </div>
                  <div class="row g6">
                    <button class="btn b-line b-sm" @click="openModelView(i)"><v-icon name="search"/>查看</button>
                    <button class="btn b-soft b-sm" @click="openModelEdit(i)"><v-icon name="edit"/>编辑</button>
                    <button class="btn b-line b-sm" style="color:var(--rose,#e5484d)" @click="delModel(i)"><v-icon name="trash"/>删除</button>
                  </div>
                </div>
              </div>
              <div v-if="!form.llmModels.length" class="mut2" style="font-size:12px;padding:6px 2px">暂无模型——添加后可在「功能分配」分区一键选用。</div>
            </div>
          </div></div>
        </div>

        <!-- ===== 功能分配 ===== -->
        <div :id="'cfg-features'" class="card cf-sec" :class="{open: open.features}">
          <div class="cf-sh" @click="open.features = !open.features">
            <span class="ct-ico" style="background:var(--grad-honey)"><v-icon name="zap"/></span>
            <div><div class="ct-t">功能分配</div><div class="ct-s">各功能（旁路/记忆/评审/子代理/伪人/群世界/视觉/Embedding）用哪个模型</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.features"><div class="cf-grid">
            <div class="full" style="padding:10px 12px;border:1px dashed var(--line);border-radius:10px;margin-bottom:4px">
              <div class="mut2" style="font-size:12px">从「模型列表」分区选择；留空=该功能默认回落（主模型/旁路小模型）。主端点类功能（旁路/记忆/评审/子代理/伪人/群世界）只能用<b>主厂商</b>的模型；视觉 / Embedding / 主模型选其它厂商时会自动同步其接入信息。</div>
            </div>
            <cfg-row v-for="f in FEATURES" :key="f.key" :name="f.label" :desc="(f.hint ? f.hint + '；' : '') + (f.mainOnly ? '仅主厂商（与主接入同端点）' : '可选任意厂商（自动同步端点）')">
              <div class="row g6">
                <select class="sel" style="width:250px" :value="featureSel(f)" @change="onFeatureSel(f, $event.target.value)">
                  <option value="">（留空 = 默认回落）</option>
                  <option v-for="m in knownModels" :key="(m.fromRegistry ? m.id : 'raw:' + m.model)" :value="(m.fromRegistry ? m.id : 'raw:' + m.model)" :disabled="f.mainOnly && m.fromRegistry && !m.main">
                    {{ m.label }}{{ m.provName ? '（' + m.provName + '）' : '' }}
                  </option>
                  <option v-if="featureVal(f) && featureSel(f) === '__custom'" value="__custom">手动：{{ featureVal(f) }}</option>
                </select>
                <input v-if="featureSel(f) === '__custom'" class="inp mono" style="width:170px" :value="featureVal(f)" @input="f.set($event.target.value)" placeholder="手动填模型 ID">
              </div>
            </cfg-row>
            <cfg-row name="Stagehand 原生模型" desc="浏览器自动化原生 SDK（独立体系，不走注册表）">
              <div class="row g6">
                <input class="inp mono" style="width:190px" v-model="form.stagehand.modelName" placeholder="留空=复用 provider">
                <input class="inp mono" style="width:130px" v-model="form.stagehand.modelApiKey" placeholder="apiKey 可空">
              </div>
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== 自我状态 SelfState ===== -->
        <div :id="'cfg-selfstate'" class="card cf-sec" :class="{open: open.selfstate}">
          <div class="cf-sh" @click="open.selfstate = !open.selfstate">
            <span class="ct-ico" style="background:var(--grad-rose)"><v-icon name="bot"/></span>
            <div><div class="ct-t">自我状态 SelfState</div><div class="ct-s">自我认知与情绪（GroupWorld 配套层）；默认 shadow 计算，观察后放量</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.selfstate"><div class="cf-grid">
            <div class="full" style="padding:10px 12px;border:1px dashed var(--line);border-radius:10px;margin-bottom:4px">
              <div class="mut2" style="font-size:12px"><v-icon name="info"/> 红线：情绪只是偏置，不影响功能/权限/工具结果；不外显数值；跨群隔离；禁卖惨。详细参数（期待窗口/反思/retention）见 config.yaml agent.selfState。</div>
            </div>
            <cfg-row name="启用 SelfState" desc="总开关；挂在伪人链路（需伪人白名单群）。关=整层 no-op"><v-switch v-model="form.selfState.enabled"/></cfg-row>
            <cfg-row name="Shadow Mode" desc="计算/入库/审计但不影响发言；观察期保持开，核对质量后再关" danger><v-switch v-model="form.selfState.shadowMode"/></cfg-row>
            <cfg-row name="普通事件脉冲上限" desc="单次事件最大情绪变化"><input type="number" class="inp" style="width:100px" min="0.05" max="0.5" step="0.01" v-model.number="form.selfState.emotion.maxNormalImpulse"></cfg-row>
            <cfg-row name="高显著脉冲上限" desc="高置信公开重复攻击上限"><input type="number" class="inp" style="width:100px" min="0.1" max="0.5" step="0.01" v-model.number="form.selfState.emotion.maxHighSalienceImpulse"></cfg-row>
            <cfg-row name="心境惯性系数" desc="EMA α：0=心境冻结，1=无惯性直跟随情绪（0.3≈被骂后低落持续一晚）"><input type="number" class="inp" style="width:100px" min="0.05" max="1" step="0.05" v-model.number="form.selfState.emotion.moodEmaAlpha"></cfg-row>
            <cfg-row name="心境回基线时长(时)" desc="超过该时长无状态迁移 → 心境自动回基线（睡一觉恢复）"><input type="number" class="inp" style="width:100px" min="1" max="48" v-model.number="form.selfState.emotion.moodResetHours"></cfg-row>
            <cfg-row name="语义近邻检测" desc="embedding 语义分类层（需「长期记忆→embedding 模型」已配；未配自动回落关键词）"><v-switch v-model="form.selfState.eventDetection.semantic"/></cfg-row>
            <cfg-row name="单次怨气增量上限" desc="记仇的单次上限"><input type="number" class="inp" style="width:100px" min="0.01" max="0.2" step="0.01" v-model.number="form.selfState.resentment.maxSingleEventDelta"></cfg-row>
            <cfg-row name="期待等待窗下限(秒)" desc="动态窗口 = max(群节奏, 目标响应, 此值)"><input type="number" class="inp" style="width:100px" min="30" max="1800" v-model.number="form.selfState.expectations.minimumWindowSeconds"></cfg-row>
            <cfg-row name="冷落判定置信门槛" desc="ignore_score 达此值才算高置信被冷落（防误判）"><input type="number" class="inp" style="width:100px" min="0.6" max="0.95" step="0.05" v-model.number="form.selfState.expectations.minIgnoredConfidence"></cfg-row>
            <cfg-row name="负心境恢复上限(小时)" desc="负状态超时强制进入恢复流程"><input type="number" class="inp" style="width:100px" min="1" max="48" v-model.number="form.selfState.stability.maxNegativeMoodHours"></cfg-row>
            <div class="full" style="padding:8px 12px;border:1px dashed var(--line);border-radius:10px">
              <div class="mut2" style="font-size:12px">实时状态/情绪/期待/心事/关系情感 → 侧栏「自我状态」页。</div>
            </div>
          </div></div>
        </div>

        <!-- ===== §1.2 推理参数 ===== -->
        <div :id="'cfg-reason'" class="card cf-sec" :class="{open: open.reason}">
          <div class="cf-sh" @click="open.reason = !open.reason">
            <span class="ct-ico" style="background:var(--grad-sky)"><v-icon name="zap"/></span>
            <div><div class="ct-t">推理参数</div><div class="ct-s">采样、轮次、思考预算与上下文</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.reason"><div class="cf-grid">
            <cfg-row name="采样温度" desc="0~2,越低越稳定">
              <div class="row g10" style="width:200px">
                <input type="range" class="rng" min="0" max="2" step="0.1" v-model.number="form.temperature" :style="{'--fill': tempPct}">
                <b class="num" style="width:30px;text-align:right">{{ form.temperature.toFixed(1) }}</b>
              </div>
            </cfg-row>
            <cfg-row name="工具调用轮次上限" desc="单次请求最多工具往返">
              <input type="number" class="inp" style="width:110px" min="1" max="100" v-model.number="form.maxTurns">
            </cfg-row>
            <cfg-row name="重复动作上限" desc="同工具+相同参数连续允许次数(超出→终止,防死循环)">
              <input type="number" class="inp" style="width:90px" min="1" v-model.number="form.loop.maxSameAction">
            </cfg-row>
            <cfg-row name="连续失败上限" desc="连续工具失败次数(超出→终止)">
              <input type="number" class="inp" style="width:90px" min="1" v-model.number="form.loop.maxConsecutiveFailures">
            </cfg-row>
            <cfg-row name="无进展窗口" desc="连续 N 步无新事实→终止">
              <input type="number" class="inp" style="width:90px" min="1" v-model.number="form.loop.noProgressWindow">
            </cfg-row>
            <cfg-row name="时间预算(ms)" desc="单次对话超时(0=不限)">
              <input type="number" class="inp" style="width:120px" min="0" step="1000" v-model.number="form.loop.timeBudgetMs">
            </cfg-row>
            <cfg-row name="token 预算" desc="单次对话累计工作 token 上限(0=不限,收尾不占)">
              <input type="number" class="inp" style="width:120px" min="0" step="1000" v-model.number="form.loop.tokenBudget">
            </cfg-row>
            <cfg-row name="收尾宽限(ms)" desc="预算耗尽后收尾总结的独立时间窗">
              <input type="number" class="inp" style="width:120px" min="1000" step="1000" v-model.number="form.loop.finalizeGraceMs">
            </cfg-row>
            <cfg-row name="深度思考" desc="模型先思考再作答(更慢更耗 token)">
              <v-switch v-model="thinkingOn"/>
            </cfg-row>
            <cfg-row name="思考预算 tokens" desc="thinking.budget_tokens">
              <input type="number" class="inp" style="width:130px" min="1024" step="1024" :disabled="!form.thinking" v-model.number="form.thinking.budget_tokens">
            </cfg-row>
            <cfg-row name="单次回复最大 token" desc="留空=厂商默认">
              <input type="number" class="inp" style="width:130px" min="1" v-model.number="form.maxTokens" placeholder="null">
            </cfg-row>
            <cfg-row name="上下文窗口" desc="超 65% 压到 45%(滞回分代,缓存友好)">
              <input type="number" class="inp" style="width:130px" min="1000" v-model.number="form.contextWindow">
            </cfg-row>
            <cfg-row name="无损压缩" desc="原文归档+台账,context_recall 可恢复">
              <v-switch v-model="form.compaction.enable"/>
            </cfg-row>
            <cfg-row name="工具结果字符上限" desc="超出截断,防爆 context">
              <input type="number" class="inp" style="width:130px" min="100" v-model.number="form.maxToolResultChars">
            </cfg-row>
            <cfg-row name="反思模式" desc="回复前自检回环">
              <select class="sel" style="width:130px" v-model="form.reflect"><option v-for="o in OPT.reflect" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="反思回环次数" desc="reflectMaxIterations">
              <input type="number" class="inp" style="width:110px" min="1" max="5" v-model.number="form.reflectMaxIterations">
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
        <div :id="'cfg-reply'" class="card cf-sec" :class="{open: open.reply}">
          <div class="cf-sh" @click="open.reply = !open.reply">
            <span class="ct-ico" style="background:var(--grad-mint)"><v-icon name="send"/></span>
            <div><div class="ct-t">进度 / 回复渲染</div><div class="ct-s">进度消息、渲染方式与中途播报</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.reply"><div class="cf-grid">
            <cfg-row name="工具调用进度消息" desc="消除干等,默认开">
              <v-switch v-model="form.progress"/>
            </cfg-row>
            <cfg-row name="进度消息撤回(秒)" desc="0=不撤回">
              <input type="number" class="inp" style="width:110px" min="0" max="120" v-model.number="form.progressRecall">
            </cfg-row>
            <cfg-row name="回复渲染方式" desc="image=markdown 渲染精美浅色图">
              <div class="seg">
                <button v-for="o in OPT.replyMode" :class="{active: form.reply.mode === o[0]}" @click="form.reply.mode = o[0]">{{ o[1] }}</button>
              </div>
            </cfg-row>
            <cfg-row name="回复图清晰度倍率" desc="deviceScaleFactor 1~4">
              <input type="number" class="inp" style="width:110px" min="1" max="4" v-model.number="form.reply.renderScale">
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
        <div :id="'cfg-memory'" class="card cf-sec" :class="{open: open.memory}">
          <div class="cf-sh" @click="open.memory = !open.memory">
            <span class="ct-ico" style="background:var(--grad-honey)"><v-icon name="memory"/></span>
            <div><div class="ct-t">记忆系统</div><div class="ct-s">声明式记忆 + 长期记忆召回</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.memory"><div class="cf-grid">
            <cfg-row name="声明式记忆" desc="注入 MEMORY.md / USER.md 到 system">
              <v-switch v-model="form.memory.enable"/>
            </cfg-row>
            <cfg-row name="记忆注入扫描" desc="写长期记忆前扫描指令注入">
              <v-switch v-model="form.memory.threatScan"/>
            </cfg-row>
            <cfg-row name="MEMORY 字符上限" desc="Agent 个人笔记上限">
              <input type="number" class="inp" style="width:120px" min="200" v-model.number="form.memoryLimits.memory">
            </cfg-row>
            <cfg-row name="USER 字符上限" desc="用户画像上限">
              <input type="number" class="inp" style="width:120px" min="200" v-model.number="form.memoryLimits.user">
            </cfg-row>
            <cfg-row name="长期记忆条数上限" desc="每用户;超限按价值淘汰">
              <input type="number" class="inp" style="width:120px" min="10" v-model.number="form.recall.cap">
            </cfg-row>
            <cfg-row name="LLM 抽取间隔(轮)" desc="每 N 轮触发一次抽取">
              <input type="number" class="inp" style="width:120px" min="1" v-model.number="form.recall.extractEvery">
            </cfg-row>
            <div class="full" style="padding:8px 12px;border:1px dashed var(--line);border-radius:10px">
              <div class="mut2" style="font-size:12px"><v-icon name="info"/> 抽取 / Embedding 模型已移至 <b>模型配置（功能分配）</b></div>
            </div>
          </div></div>
        </div>

        <!-- ===== §1.5 自进化 ===== -->
        <div :id="'cfg-evolution'" class="card cf-sec" :class="{open: open.evolution}">
          <div class="cf-sh" @click="open.evolution = !open.evolution">
            <span class="ct-ico" style="background:var(--grad-rose)"><v-icon name="evolution"/></span>
            <div><div class="ct-t">自进化</div><div class="ct-s">后台自评审与改进建议落盘</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.evolution"><div class="cf-grid">
            <cfg-row name="后台自评审" desc="每 N 轮异步评审,不阻塞回复">
              <v-switch v-model="form.selfReview.enable"/>
            </cfg-row>
            <cfg-row name="评审间隔(轮)" desc="每 N 轮触发一次">
              <input type="number" class="inp" style="width:120px" min="5" v-model.number="form.selfReview.every">
            </cfg-row>
            <cfg-row name="评审用模型" desc="已移至 模型配置（功能分配）">
              <span class="mut2 mono" style="font-size:12px">{{ form.selfReview?.model || '(留空=主模型)' }}</span>
            </cfg-row>
            <!-- 模型输入已集中到 基础/模型；上面仅显示当前生效值 -->
            <cfg-row name="日 token 预算" desc="耗尽则只采迹不评审">
              <input type="number" class="inp" style="width:150px" min="0" step="10000" v-model.number="form.selfReview.dailyBudgetTokens">
            </cfg-row>
            <cfg-row name="记忆自动应用" desc="有回滚+威胁扫描+置信度闸">
              <v-switch v-model="form.selfReview.autoApplyMemory"/>
            </cfg-row>
            <cfg-row name="prompt 自动应用" desc="默认关:落盘待审,人工把关" danger>
              <v-switch v-model="form.selfReview.autoApplyPrompt"/>
            </cfg-row>
            <cfg-row class="full" name="产物目录" desc="traces / prompts / suggestions">
              <div class="row g6 wrap" style="justify-content:flex-end">
                <span class="pill mono">{{ form.evolution.traceDir }}</span>
                <span class="pill mono">{{ form.evolution.promptDir }}</span>
                <span class="pill mono">{{ form.evolution.suggestionDir }}</span>
              </div>
            </cfg-row>
            <div class="full" style="margin-top:4px;padding-top:12px;border-top:1px dashed var(--line2)">
              <div class="mut" style="font-size:12px;font-weight:700;margin-bottom:8px"><v-icon name="tool"/> 工具进化（Tool Evolution）</div>
              <div class="cf-grid">
                <cfg-row name="工具进化" desc="版本化工具库(生成→验证→审批→晋升)">
                  <v-switch v-model="form.toolEvo.enable"/>
                </cfg-row>
                <cfg-row name="候选修复次数" desc="生成失败自动修复上限">
                  <input type="number" class="inp" style="width:90px" min="0" max="3" v-model.number="form.toolEvo.maxRepairAttempts">
                </cfg-row>
                <cfg-row name="检索接受阈值" desc="与去重阈值分开(§12.1)">
                  <input type="number" class="inp" style="width:100px" min="0" max="1" step="0.01" v-model.number="form.toolEvo.retrievalThreshold">
                </cfg-row>
                <cfg-row name="去重阈值" desc="候选去重相似度">
                  <input type="number" class="inp" style="width:100px" min="0" max="1" step="0.01" v-model.number="form.toolEvo.deduplicationThreshold">
                </cfg-row>
              </div>
            </div>
          </div></div>
        </div>

        <!-- ===== §1.6 权限 / 安全 / 日志 ===== -->
        <div :id="'cfg-security'" class="card cf-sec" :class="{open: open.security}">
          <div class="cf-sh" @click="open.security = !open.security">
            <span class="ct-ico" style="background:var(--grad)"><v-icon name="shield"/></span>
            <div><div class="ct-t">权限 / 安全 / 日志</div><div class="ct-s">主人、审批、注入防御与全链路日志</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.security"><div class="cf-grid">
            <cfg-row name="#ai 命令权限" desc="谁可以触发对话">
              <select class="sel" style="width:140px" v-model="form.chatPermission"><option v-for="o in OPT.permission" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="确认超时(秒)" desc="审批门超时自动拒绝">
              <input type="number" class="inp" style="width:120px" min="10" v-model.number="form.confirmTimeout">
            </cfg-row>
            <cfg-row name="注入防御动作" desc="命中提示词注入时的处理">
              <select class="sel" style="width:170px" v-model="form.guardAction"><option v-for="o in OPT.guardAction" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="防御灵敏度" desc="阈值越低越严格">
              <select class="sel" style="width:150px" v-model="form.guardSensitivity"><option v-for="o in OPT.guardSensitivity" :value="o[0]">{{ o[1] }}</option></select>
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
              <select class="sel" style="width:120px" v-model="form.devLog.level"><option value="info">info</option><option value="warn">warn</option><option value="debug">debug</option></select>
            </cfg-row>
            <cfg-row class="full" name="主人列表" desc="主人 QQ 号(明文,点标签删除)">
              <div class="row g6 wrap" style="justify-content:flex-end">
                <span v-for="(m, i) in form.masters" :key="i" class="pill p-line mono" style="cursor:pointer" @click="delMaster(i)" title="点击删除">{{ m }} <v-icon name="x"/></span>
                <input class="inp" style="width:130px;padding:4px 9px;font-size:12px" v-model="masterInput" placeholder="输入 QQ 回车添加" @keydown.enter.prevent.stop="addMaster">
                <button type="button" class="btn b-soft b-sm" @click="addMaster" style="padding:4px 10px;font-size:12px">添加</button>
              </div>
            </cfg-row>
            <cfg-row class="full" name="默认身份 systemPrompt" desc="留空用富默认身份;被人设覆盖时失效">
              <textarea class="txa" style="min-height:64px" v-model="form.systemPrompt" placeholder="留空=使用内置默认身份"></textarea>
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== 表情包（已独立成页） ===== -->
        <div class="note n-honey">
          <v-icon name="smile"/>
          <div style="flex:1"><b>表情包</b>配置已移至独立页：<b>系统 → 表情包</b>（含发送策略、自动发现、库概览/目录启停）。</div>
          <button class="btn b-line b-sm" @click="location.hash = '#/sticker'">前往<v-icon name="arrowr"/></button>
        </div>

        <!-- ===== §1.7 多模态 / 工具 / 扩展 ===== -->
        <div :id="'cfg-ext'" class="card cf-sec" :class="{open: open.ext}">
          <div class="cf-sh" @click="open.ext = !open.ext">
            <span class="ct-ico" style="background:var(--grad-sky)"><v-icon name="tool"/></span>
            <div><div class="ct-t">多模态 / 工具 / 扩展</div><div class="ct-s">视觉、搜索、MCP、终端与各子系统</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.ext"><div class="cf-grid">
            <cfg-row name="多模态" desc="图片/文件输入总开关">
              <v-switch v-model="form.media.enable"/>
            </cfg-row>
            <cfg-row name="单次最多图片" desc="media.maxImages">
              <input type="number" class="inp" style="width:110px" min="1" max="20" v-model.number="form.media.maxImages">
            </cfg-row>
            <cfg-row name="视觉子模型" desc="主模型无视觉时图转文；各字段留空=复用主配置">
              <v-switch v-model="form.vision.enable"/>
            </cfg-row>
            <cfg-row full name="视觉模型" desc="已移至 模型配置（功能分配）（模型 ID / 接口 / Key）">
              <span class="mut2 mono" style="font-size:12px">{{ form.vision?.model || '(留空=复用主模型)' }}{{ form.vision?.baseURL ? ' @ ' + form.vision.baseURL : '' }}</span>
            </cfg-row>
            <cfg-row name="工具按需发现" desc="常驻少数工具,其余 tool_search 动态注入">
              <v-switch v-model="form.toolDiscovery.enable"/>
            </cfg-row>
            <cfg-row name="tool_search 返回数 / 最低分" desc="topK 与 minScore">
              <div class="row g6">
                <input type="number" class="inp" style="width:80px" min="1" max="20" v-model.number="form.toolDiscovery.topK">
                <input type="number" class="inp" style="width:90px" min="0" max="1" step="0.05" v-model.number="form.toolDiscovery.minScore">
              </div>
            </cfg-row>
            <cfg-row class="full" name="常驻工具" desc="不经搜索始终可用；从已注册工具勾选（留空=用内置默认 6 个）">
              <div v-if="!allTools.length" class="mut2" style="font-size:12px">工具列表加载中或运行时未就绪…</div>
              <div v-else style="max-height:220px;overflow-y:auto;border:1px solid var(--line);border-radius:8px;padding:8px 12px;background:rgba(255,255,255,.42)">
                <div v-for="cat in toolCats" :key="cat" style="margin-bottom:8px">
                  <div class="mut" style="font-size:11px;margin:3px 0 4px;text-transform:uppercase;letter-spacing:.5px">{{ cat }}</div>
                  <div style="display:flex;flex-wrap:wrap;gap:4px">
                    <label v-for="t in toolsByCat(cat)" :key="t.id" :title="t.description" class="pill" :class="{'p-pri': (form.toolDiscovery.alwaysOn||[]).includes(t.id)}" style="cursor:pointer;user-select:none;font-size:12px">
                      <input type="checkbox" :checked="(form.toolDiscovery.alwaysOn||[]).includes(t.id)" @change="toggleAlwaysOn(t.id)" style="display:none">
                      {{ t.name }}
                    </label>
                  </div>
                </div>
              </div>
            </cfg-row>

            <cfg-row name="网页抓取引擎" desc="crawl4ai 真浏览器渲染(未装自动降级 fetch)">
              <select class="sel" style="width:150px" v-model="form.kb.crawl.engine"><option v-for="o in OPT.crawlEngine" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>

            <cfg-row name="Tavily 搜索 Key" desc="任填一个搜索源即启用">
              <input class="inp mono" style="width:220px" v-model="form.search.tavily.apiKey" placeholder="tvly-...">
            </cfg-row>
            <cfg-row class="full" name="Exa / Brave / PPLX Key" desc="其余搜索源密钥(明文)">
              <div class="row g6 wrap">
                <input class="inp mono" style="width:150px" v-model="form.search.exa.apiKey" placeholder="Exa">
                <input class="inp mono" style="width:150px" v-model="form.search.brave.apiKey" placeholder="Brave">
                <input class="inp mono" style="width:150px" v-model="form.search.perplexity.apiKey" placeholder="Perplexity">
              </div>
            </cfg-row>
            <cfg-row name="DDG 兜底" desc="本地 DuckDuckGo,免 key">
              <v-switch v-model="form.search.ddg"/>
            </cfg-row>
            <cfg-row name="深度研究权限" desc="#研究 命令">
              <select class="sel" style="width:170px" v-model="form.research.permission"><option v-for="o in OPT.researchPerm" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row class="full" name="米游社 Cookie" desc="明文">
              <input class="inp mono" style="width:100%" v-model="form.miyoushe.cookie" placeholder="cookie 字符串">
            </cfg-row>
            <cfg-row class="full" name="Pixiv refreshToken" desc="明文">
              <input class="inp mono" style="width:100%" v-model="form.pixiv.refreshToken" placeholder="refresh token">
            </cfg-row>
            <cfg-row name="语音转写 STT" desc="whisper 兼容接口">
              <v-switch v-model="form.stt.enable"/>
            </cfg-row>
            <cfg-row name="Python 计算沙盒" desc="calc:python3 超时秒">
              <div class="row g6">
                <v-switch v-model="form.calc.enable"/>
                <input type="number" class="inp" style="width:90px" min="1" v-model.number="form.calc.timeout">
              </div>
            </cfg-row>
            <!-- MCP 服务端已拆到独立「MCP 服务」section -->

            <div class="full subpanel sp-rose">
              <div class="row g10 mb12" style="font-weight:800;color:var(--rose)"><v-icon name="warn"/>终端执行(高危)</div>
              <div class="desc mb10" style="color:var(--rose)">主机直接执行 shell（无容器隔离）。仅 terminal 主人可用：发 <code>#agents设置主人</code>→控制台验证码→直接发码认领。每条命令需 <code>#确认</code>；黑名单硬拦。</div>
              <div class="cf-grid">
                <cfg-row name="启用 shell 执行" desc="真机任意命令执行，无法 100% 安全" danger>
                  <v-switch v-model="form.terminal.enable"/>
                </cfg-row>
                <cfg-row name="命令超时上限(秒)">
                  <input type="number" class="inp" style="width:110px" min="1" max="3600" v-model.number="form.terminal.maxTimeout">
                </cfg-row>
                <cfg-row class="full" name="命令黑名单" desc="灾难命令正则（即使已确认也硬拦；空=用默认 rm -rf / mkfs / dd of=/dev 等）">
                  <tag-editor v-model="form.terminal.blocklist" placeholder="回车添加"/>
                </cfg-row>
                <cfg-row class="full" name="主人命令免 #确认" desc="⚠️ 开=terminal 主人命令免审批直跑（黑名单仍硬拦）。真机任意命令执行，高危，默认关" danger>
                  <v-switch v-model="form.terminal.skipConfirm"/>
                </cfg-row>
              </div>
            </div>

            <div class="full subpanel sp-sky">
              <div class="row g10 mb12" style="font-weight:800;color:var(--sky)">🌐 Stagehand 浏览器自动化</div>
              <div class="desc mb10">act/extract/observe 自然语言原语；仅框架主人可用，act 写动作需 <code>#确认</code>。会话 per-scope 隔离 + 5min idle 自动关。</div>
              <div class="cf-grid">
                <cfg-row name="启用浏览器自动化" desc="依赖 @browserbasehq/stagehand+zod（云崽根 pnpm install）">
                  <v-switch v-model="form.stagehand.enable"/>
                </cfg-row>
                <cfg-row name="浏览器模式">
                  <select class="sel" style="width:190px" v-model="form.stagehand.mode"><option v-for="o in OPT.shMode" :value="o[0]">{{ o[1] }}</option></select>
                </cfg-row>
                <cfg-row name="无头模式(本地)" desc="服务器建议开">
                  <v-switch v-model="form.stagehand.headless"/>
                </cfg-row>
                <cfg-row name="chrome 路径(本地,可选)" desc="空=默认/CHROME_PATH；可填复用已装 chrome">
                  <input class="inp mono" style="width:200px" v-model="form.stagehand.executablePath" placeholder="留空=默认">
                </cfg-row>
                <cfg-row name="Browserbase apiKey" desc="云模式必填（bb_live_...）">
                  <input class="inp mono" style="width:200px" v-model="form.stagehand.browserbaseApiKey" placeholder="bb_live_...">
                </cfg-row>
                <cfg-row name="云区域(可选)">
                  <select class="sel" style="width:190px" v-model="form.stagehand.region"><option v-for="o in OPT.shRegion" :value="o[0]">{{ o[1] }}</option></select>
                </cfg-row>
                <cfg-row name="Stagehand 原生模型(可选)" desc="已移至 模型配置（功能分配）">
                  <span class="mut2 mono" style="font-size:12px">{{ form.stagehand?.modelName || '(留空=复用 provider)' }}</span>
                </cfg-row>
                <cfg-row name="会话空闲超时(毫秒)">
                  <input type="number" class="inp" style="width:130px" min="60000" step="60000" v-model.number="form.stagehand.idleTimeoutMs">
                </cfg-row>
              </div>
            </div>

            <div class="full" style="margin-top:4px;padding-top:12px;border-top:1px dashed var(--line2)">
              <div class="mut" style="font-size:12px;font-weight:700;margin-bottom:8px"><v-icon name="image"/> 示意图生成（diagram_render · 流程图/架构图/时序图）</div>
              <div class="cf-grid">
                <cfg-row name="启用示意图工具" desc="画流程图/架构图/时序图/状态图等，随回复发图">
                  <v-switch v-model="form.diagram.enable"/>
                </cfg-row>
                <cfg-row name="渲染引擎" desc="自托管 Kroki 容器渲染 D2（部署见 docs/deploy/kroki-compose.yaml）">
                  <select class="sel" style="width:230px" v-model="form.diagram.renderer"><option v-for="o in OPT.dgRenderer" :value="o[0]">{{ o[1] }}</option></select>
                </cfg-row>
                <cfg-row name="失败回退" desc="Kroki 不可用时的本地回退引擎">
                  <select class="sel" style="width:230px" v-model="form.diagram.fallbackRenderer"><option v-for="o in OPT.dgFallback" :value="o[0]">{{ o[1] }}</option></select>
                </cfg-row>
                <cfg-row name="默认主题">
                  <select class="sel" style="width:160px" v-model="form.diagram.defaultTheme"><option v-for="o in OPT.dgTheme" :value="o[0]">{{ o[1] }}</option></select>
                </cfg-row>
                <cfg-row name="默认格式">
                  <select class="sel" style="width:150px" v-model="form.diagram.defaultFormat"><option v-for="o in OPT.dgFormat" :value="o[0]">{{ o[1] }}</option></select>
                </cfg-row>
                <cfg-row name="Kroki endpoint" desc="自托管地址（docker service 名/127.0.0.1/内网 IP）">
                  <input class="inp mono" style="width:220px" v-model="form.diagram.kroki.endpoint" placeholder="http://127.0.0.1:8000">
                </cfg-row>
                <cfg-row name="D2 布局" desc="sequence 固定 dagre；分组/ER/架构走此项">
                  <select class="sel" style="width:160px" v-model="form.diagram.kroki.d2.layout"><option v-for="o in OPT.dgLayout" :value="o[0]">{{ o[1] }}</option></select>
                </cfg-row>
                <cfg-row name="连接/响应头超时(ms)">
                  <input type="number" class="inp" style="width:100px" min="500" step="500" v-model.number="form.diagram.kroki.connectTimeoutMs">
                </cfg-row>
                <cfg-row name="单请求总超时(ms)" desc="覆盖响应体读取全程">
                  <input type="number" class="inp" style="width:100px" min="1000" step="1000" v-model.number="form.diagram.kroki.requestTimeoutMs">
                </cfg-row>
                <cfg-row name="渲染并发上限">
                  <input type="number" class="inp" style="width:80px" min="1" max="8" v-model.number="form.diagram.kroki.maxConcurrency">
                </cfg-row>
                <cfg-row name="SVG 响应上限(B)" desc="流式字节计数，超限即断">
                  <input type="number" class="inp" style="width:110px" min="65536" step="65536" v-model.number="form.diagram.kroki.maxResponseBytes">
                </cfg-row>
                <cfg-row name="失败熔断" desc="连续 3 次失败后短路 30s（防宕机期反复等满超时）">
                  <v-switch v-model="form.diagram.kroki.circuitBreaker.enabled"/>
                </cfg-row>
                <cfg-row name="Kroki 镜像版本声明" desc="部署的镜像 tag（进缓存 key；升级镜像后更新使旧缓存失效）">
                  <input class="inp mono" style="width:140px" v-model="form.diagram.kroki.imageTag" placeholder="如 0.6.4">
                </cfg-row>
                <cfg-row name="渲染总预算(ms)" desc="编译+HTTP+栅格化全程">
                  <input type="number" class="inp" style="width:100px" min="3000" step="1000" v-model.number="form.diagram.timeoutMs">
                </cfg-row>
                <cfg-row name="输出宽度(px)" desc="默认 1600（2x 清晰度）">
                  <input type="number" class="inp" style="width:90px" min="800" step="100" v-model.number="form.diagram.targetWidth">
                </cfg-row>
                <cfg-row name="节点数上限" desc="spec 规模限制（连线 2 倍）">
                  <input type="number" class="inp" style="width:80px" min="5" max="50" v-model.number="form.diagram.maxNodes">
                </cfg-row>
                <cfg-row name="临时文件保留(分)" desc="data/diagram/ TTL 清理">
                  <input type="number" class="inp" style="width:90px" min="5" v-model.number="form.diagram.tempTtlMinutes">
                </cfg-row>
                <cfg-row class="full" danger name="允许公共 Kroki" desc="⚠️ 开启后图中标题/节点/架构信息将发送到第三方渲染服务（强制 HTTPS）；默认关闭且不作为静默回退">
                  <v-switch v-model="form.diagram.kroki.allowPublicEndpoint"/>
                </cfg-row>
              </div>
            </div>

            <div class="full" style="margin-top:4px;padding-top:12px;border-top:1px dashed var(--line2)">
              <div class="mut" style="font-size:12px;font-weight:700;margin-bottom:8px"><v-icon name="file"/> 媒体下载（yt-dlp · 仅主人，受约束）</div>
              <div class="cf-grid">
                <cfg-row name="启用媒体下载" desc="web_download 工具；依赖系统 yt-dlp + ffmpeg（合并格式）">
                  <v-switch v-model="form.download.enable"/>
                </cfg-row>
                <cfg-row name="单文件大小上限(MB)" desc="yt-dlp --max-filesize，超限中止">
                  <input type="number" class="inp" style="width:100px" min="1" v-model.number="form.download.maxMB">
                </cfg-row>
                <cfg-row name="发送大小上限(MB)" desc="超过此大小不自动发 QQ（返回本地路径供 SFTP 取）">
                  <input type="number" class="inp" style="width:100px" min="1" v-model.number="form.download.sendLimitMB">
                </cfg-row>
                <cfg-row name="下载超时(秒)" desc="maxTimeoutSec">
                  <input type="number" class="inp" style="width:100px" min="10" v-model.number="form.download.maxTimeoutSec">
                </cfg-row>
                <cfg-row name="yt-dlp 路径" desc="空=PATH 中的 yt-dlp">
                  <input class="inp mono" style="width:180px" v-model="form.download.bin" placeholder="留空=自动">
                </cfg-row>
                <cfg-row name="输出目录" desc="空=插件 data/temp/downloads">
                  <input class="inp mono" style="width:180px" v-model="form.download.dir" placeholder="留空=默认">
                </cfg-row>
              </div>
            </div>

            <div class="full" style="margin-top:4px;padding-top:12px;border-top:1px dashed var(--line2)">
              <div class="mut" style="font-size:12px;font-weight:700;margin-bottom:8px"><v-icon name="bot"/> 子代理编排（spawn_subagent · 主 Agent 自主委派子任务）</div>
              <div class="cf-grid">
                <cfg-row name="启用子代理委派" desc="注册 spawn_subagent，主模型自行决定是否创建子代理">
                  <v-switch v-model="form.multiagent.enable"/>
                </cfg-row>
                <cfg-row name="最大并发子代理" desc="同时运行子代理数上限（进程级 Semaphore）">
                  <input type="number" class="inp" style="width:90px" min="1" max="10" v-model.number="form.multiagent.maxConcurrent">
                </cfg-row>
                <cfg-row name="单次对话上限" desc="单次对话最多创建几个子代理（防失控）">
                  <input type="number" class="inp" style="width:90px" min="1" max="20" v-model.number="form.multiagent.maxSpawnsPerConversation">
                </cfg-row>
                <cfg-row name="子代理工具循环上限" desc="workerMaxTurns（防烧 token）">
                  <input type="number" class="inp" style="width:90px" min="1" max="50" v-model.number="form.multiagent.workerMaxTurns">
                </cfg-row>
                <cfg-row name="子代理模型" desc="已移至 模型配置（功能分配）">
                  <span class="mut2 mono" style="font-size:12px">{{ form.multiagent?.workerModel || '(留空=主模型)' }}</span>
                </cfg-row>
                <cfg-row full name="子代理默认工具" desc="模型未指定时的默认可用工具（仅 query 类安全）">
                  <tag-editor v-model="form.multiagent.defaultTools" placeholder="如 web_search / memory_search" :mono="true"/>
                </cfg-row>
              </div>
            </div>
          </div></div>
        </div>

        <!-- ===== MCP 服务（独立 section）===== -->
        <div :id="'cfg-mcp'" class="card cf-sec" :class="{open: open.mcp}">
          <div class="cf-sh" @click="open.mcp = !open.mcp">
            <span class="ct-ico" style="background:var(--grad-mint)"><v-icon name="tool"/></span>
            <div><div class="ct-t">MCP 服务</div><div class="ct-s">MCP 协议服务端（stdio / http）· 请求超时</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.mcp"><div class="cf-grid">
            <cfg-row name="MCP 请求超时(ms)" desc="mcp.requestTimeout">
              <input type="number" class="inp" style="width:130px" min="1000" step="1000" v-model.number="form.mcp.requestTimeout">
            </cfg-row>
            <div class="full">
              <div class="row-b mb12">
                <div style="font-weight:800;font-size:13px">MCP 服务端列表</div>
                <button class="btn b-pri b-sm" @click="openNewMcp"><v-icon name="plus"/>新建 MCP</button>
              </div>
              <div v-if="!(form.mcp?.servers && Object.keys(form.mcp.servers).length)" class="mut2" style="font-size:12px;padding:8px">暂无 MCP 服务，点「新建 MCP」添加</div>
              <div v-for="(srv, name) in (form.mcp?.servers || {})" :key="name" class="mem-row" style="flex-direction:column;align-items:stretch;gap:8px">
                <div class="row g6 wrap" style="align-items:center">
                  <v-icon name="tool" style="color:var(--pri)"/>
                  <b style="min-width:90px;font-size:13px">{{ name }}</b>
                  <span class="pill" :class="srv._type === 'http' ? 'p-rose' : 'p-pri'" style="font-size:10px;padding:2px 8px">{{ srv._type }}</span>
                  <span style="flex:1"></span>
                  <button class="bic dg" @click="delMcp(name)" title="删除"><v-icon name="trash"/></button>
                </div>
                <template v-if="srv._type === 'http'">
                  <input class="inp mono" style="width:100%" v-model="srv._url" placeholder="url：https://mcp.example.com/sse">
                  <div class="mut2" style="font-size:11px">headers（KEY: VALUE 每行一个）</div>
                  <textarea class="txa mono" style="min-height:48px;width:100%" v-model="srv._headersText" placeholder="Authorization: Bearer xxx"></textarea>
                </template>
                <template v-else>
                  <div class="mut2" style="font-size:11px">stdio 配置（粘贴单服务 JSON：command/args/env）</div>
                  <textarea class="txa mono" style="min-height:120px;width:100%;font-size:12px" v-model="srv._json" spellcheck="false" placeholder='{ "command": "npx", "args": ["-y", "@z_ai/mcp-server"], "env": { "Z_AI_API_KEY": "xxx" } }'></textarea>
                </template>
              </div>
            </div>
          </div></div>
        </div>

        <!-- 新建 MCP 弹窗（弹窗内始终有 stdio/http 选择）-->
        <v-modal v-if="mcpModal.show" title="新建 MCP 服务" icon="plus" @close="mcpModal.show = false">
          <div class="row g6 wrap" style="align-items:center;margin-bottom:10px">
            <input class="inp mono" style="width:170px;font-weight:700" v-model="mcpModal.name" placeholder="服务名（如 zai-mcp-server）">
            <select class="sel" style="width:110px" v-model="mcpModal.type">
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </div>
          <template v-if="mcpModal.type === 'http'">
            <input class="inp mono" style="width:100%;margin-bottom:8px" v-model="mcpModal.url" placeholder="url：https://mcp.example.com/sse">
            <div class="mut2" style="font-size:11px;margin-bottom:4px">headers（KEY: VALUE 每行一个）</div>
            <textarea class="txa mono" style="min-height:80px;width:100%" v-model="mcpModal.headersText" placeholder="Authorization: Bearer xxx"></textarea>
          </template>
          <template v-else>
            <div class="mut2" style="font-size:11px;margin-bottom:4px">stdio 配置 JSON（command/args/env）</div>
            <textarea class="txa mono" style="min-height:140px;width:100%;font-size:12px" v-model="mcpModal.stdioJson" spellcheck="false"></textarea>
          </template>
          <template #foot>
            <button class="btn b-line" @click="mcpModal.show = false">取消</button>
            <button class="btn b-pri" @click="confirmNewMcp"><v-icon name="check"/>添加</button>
          </template>
        </v-modal>

        <!-- 模型详情弹窗：查看（只读）/ 编辑（含思考开关等参数） -->
        <v-modal v-if="modelModal.show" :title="(modelModal.mode === 'view' ? '查看模型' : (modelModal.index === -1 ? '添加模型' : '编辑模型'))" :icon="modelModal.mode === 'view' ? 'search' : 'edit'" center @close="modelModal.show = false">
          <div class="row g6 wrap" style="align-items:center;margin-bottom:10px">
            <input class="inp" style="width:150px;font-weight:700" v-model="modelModal.draft.name" placeholder="别名（如 便宜小模型）" :disabled="modelModal.mode === 'view'">
            <select class="sel" style="width:170px" v-model="modelModal.draft.providerId" :disabled="modelModal.mode === 'view'">
              <option value="main">主厂商</option>
              <option v-for="p in form.llmProviders" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
            </select>
          </div>
          <div style="margin-bottom:10px">
            <model-picker v-if="modelModal.mode === 'edit'" v-model="modelModal.draft.model" :protocol="(provById(modelModal.draft.providerId) || {}).protocol || form.protocol" :base-url="(provById(modelModal.draft.providerId) || {}).baseURL || form.baseURL" :api-key="(provById(modelModal.draft.providerId) || {}).apiKey || form.apiKey" :preset="(provById(modelModal.draft.providerId) || {}).preset || form.preset" placeholder="模型 ID（选择厂商后可拉取列表）"/>
            <div v-else class="inp mono" style="width:100%;box-sizing:border-box">{{ modelModal.draft.model || '(未填)' }}</div>
          </div>
          <div class="row g6 wrap" style="margin-bottom:10px">
            <label class="row g6" style="font-size:12px">
              <span class="mut2">温度</span>
              <input type="number" class="inp" style="width:80px" min="0" max="2" step="0.1" v-model.number="modelModal.draft.temperature" placeholder="（空=功能默认）" :disabled="modelModal.mode === 'view'">
            </label>
            <label class="row g6" style="font-size:12px">
              <span class="mut2">maxTokens</span>
              <input type="number" class="inp" style="width:90px" min="0" step="256" v-model.number="modelModal.draft.maxTokens" placeholder="（空=厂商默认）" :disabled="modelModal.mode === 'view'">
            </label>
            <label class="row g6" style="font-size:12px">
              <span class="mut2">思考</span>
              <select class="sel" style="width:120px" v-model="modelModal.draft.thinking" :disabled="modelModal.mode === 'view'">
                <option value="inherit">继承全局</option>
                <option value="on">开启思考</option>
                <option value="off">关闭思考</option>
              </select>
            </label>
          </div>
          <input class="inp" style="width:100%;margin-bottom:10px;box-sizing:border-box" v-model="modelModal.draft.note" placeholder="备注 / 用途（可空）" :disabled="modelModal.mode === 'view'">
          <div class="mut2" style="font-size:11px;margin-bottom:10px">思考/温度/maxTokens 在该模型被主对话链路使用时生效（覆盖全局 agent.thinking 等）。</div>
          <div class="row g10" style="justify-content:flex-end">
            <button class="btn b-line b-sm" @click="modelModal.show = false">{{ modelModal.mode === 'view' ? '关闭' : '取消' }}</button>
            <button v-if="modelModal.mode === 'edit'" class="btn b-pri b-sm" @click="saveModel"><v-icon name="save"/>保存</button>
          </div>
        </v-modal>

        <!-- 厂商详情弹窗：查看（只读）/ 编辑（选预设自动填地址） -->
        <v-modal v-if="provModal.show" :title="(provModal.mode === 'view' ? '查看厂商' : (provModal.index === -1 ? '添加厂商' : '编辑厂商'))" :icon="provModal.mode === 'view' ? 'search' : 'edit'" center @close="provModal.show = false">
          <div class="row g6 wrap" style="align-items:center;margin-bottom:10px">
            <input class="inp" style="width:150px;font-weight:700" v-model="provModal.draft.name" placeholder="厂商名称（如 豆包）" :disabled="provModal.mode === 'view'">
            <select class="sel" style="width:140px" v-model="provModal.draft.protocol" :disabled="provModal.mode === 'view'" @change="onProvPreset(provModal.draft)"><option v-for="o in OPT.protocol" :value="o[0]">{{ o[1] }}</option></select>
            <select class="sel" style="width:160px" v-model="provModal.draft.preset" :disabled="provModal.mode === 'view'" @change="onProvPreset(provModal.draft)"><option value="">预设(无)</option><option v-for="o in OPT.preset" :value="o[0]">{{ o[1] }}</option></select>
          </div>
          <input class="inp mono" style="width:100%;margin-bottom:10px;box-sizing:border-box" v-model="provModal.draft.baseURL" placeholder="接口地址 baseURL（选预设自动填充）" :disabled="provModal.mode === 'view'">
          <input class="inp mono" style="width:100%;margin-bottom:10px;box-sizing:border-box" v-model="provModal.draft.apiKey" placeholder="API Key" :disabled="provModal.mode === 'view'">
          <div class="mut2" style="font-size:11px;margin-bottom:10px">选预设厂商会自动填 baseURL；协议/预设变化也会重填（MiniMax/OpenCode 等双协议地址不同）。模型在「模型列表」分区绑定厂商。</div>
          <div class="row g10" style="justify-content:flex-end">
            <button class="btn b-line b-sm" @click="provModal.show = false">{{ provModal.mode === 'view' ? '关闭' : '取消' }}</button>
            <button v-if="provModal.mode === 'edit'" class="btn b-soft b-sm" @click="testProvider(provModal.draft)" :disabled="testing[provModal.draft.id]">{{ testing[provModal.draft.id] ? '测试中…' : '测试连接' }}</button>
            <button v-if="provModal.mode === 'edit'" class="btn b-pri b-sm" @click="saveProv"><v-icon name="save"/>保存</button>
          </div>
        </v-modal>

        <!-- 保存栏 -->
        <Transition name="fade">
          <div v-if="dirty" class="savebar">
            <span class="dirty-dot"></span>
            <span style="font-weight:700;font-size:13px">有未保存的修改</span>
            <span class="mut2" style="font-size:12px">Mock 环境:保存仅写入内存,刷新还原</span>
            <div style="margin-left:auto" class="row g10">
              <button class="btn b-line" @click="reset"><v-icon name="undo"/>放弃修改</button>
              <button class="btn b-pri" @click="save"><v-icon name="save"/>保存并热加载</button>
            </div>
          </div>
        </Transition>
      </div>

    </div>`,
  }
})()
