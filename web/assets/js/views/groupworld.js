/** 视图:群聊小世界 GroupWorld（社会记忆层）—— 配置 + 数据浏览双标签
 *  配置：读写 agent.groupWorld.* （/api/config 点路径）。
 *  数据：GET /api/groupworld/{stats,members,profile,episodes,communities} （仅主人面板；§12.3 群内仅自查）。
 *  红线：online 默认 false（先观察再放量）；minOnlineConfidence 后端强制 ≥0.55；敏感推断默认拦截。
 */
(function () {
  window.VIEWS = window.VIEWS || {}

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

  const TagEditor = {
    name: 'TagEditor',
    props: { modelValue: { type: Array, required: true }, placeholder: { type: String, default: '回车添加' }, mono: { type: Boolean, default: false } },
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      const input = Vue.ref('')
      const add = () => { const v = input.value.trim(); if (v && !props.modelValue.includes(v)) emit('update:modelValue', [...props.modelValue, v]); input.value = '' }
      const del = (i) => emit('update:modelValue', props.modelValue.filter((_, j) => j !== i))
      return { input, add, del }
    },
    template: `
    <div class="row g6 wrap" :style="'justify-content:flex-end' + (mono ? ';font-family:var(--mono,monospace)' : '')">
      <span v-for="(t, i) in modelValue" :key="t + i" class="pill p-pri" style="cursor:default" :class="{mono: mono}">
        {{ t }}<v-icon name="x" style="cursor:pointer" @click="del(i)"/>
      </span>
      <input v-model="input" class="inp" :class="{mono: mono}" style="width:120px;padding:5px 10px;font-size:12px" :placeholder="placeholder" enterkeyhint="enter" @keydown.enter.prevent="add" @keyup.enter.prevent="add">
      <button type="button" class="btn b-soft b-sm" @click="add" title="添加"><v-icon name="plus"/></button>
    </div>`,
  }

  const DEFAULTS = {
    enabled: false, groups: [], online: false,
    ingestion: { rawMessageRetentionDays: 30, segmentIdleSeconds: 300, segmentMaxMessages: 100, ignoreCommandMessages: true, ignoreSystemNotices: true, topicShiftEnabled: true, topicShiftWindow: 6, topicShiftSimThreshold: 0.06 },
    analysis: { schedule: '7 * * * *', minSegmentMessages: 4, maxSegmentsPerRun: 50, modelProfile: '', maxDailyCallsPerGroup: 100, retryCount: 1, maxTokens: 1200, episodeMergeSim: 0.85 },
    profiles: { hotActiveDays30d: 10, warmMessageCount30d: 5, minOnlineConfidence: 0.55, maxTraitsPerUser: 5, temporaryTraitTtlDays: 14, traitMergeSimThreshold: 0.82 },
    graph: { activeEdgeDays: 90, maxNeighborsPerUser: 40, maxOnlineHops: 1, weeklyCommunityDetection: true, minCommunitySize: 3 },
    retrieval: { plannerTokenBudget: 800, replyerTokenBudget: 500, maxEpisodes: 3, maxRelationships: 5, cacheTtlSeconds: 60 },
    privacy: { allowUserOptOut: true, allowUserInspect: true, allowUserCorrect: true, blockSensitiveInference: true },
  }

  const TIER = { hot: '常驻', warm: '偶尔', cold: '潜水', archived: '已离开' }
  const SRC = { explicit: '自述', statistical: '统计', inferred: '推断', admin_corrected: '纠正' }
  const EPT = { shared_event: '共同经历', running_joke: '群梗', ongoing_topic: '持续话题', conflict: '冲突', achievement: '成果' }
  const parseArr = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }

  window.VIEWS.groupworld = {
    name: 'GroupWorldView',
    components: { CfgRow, TagEditor },
    setup() {
      const { ref, reactive, watch, computed, onMounted, nextTick } = Vue
      const { toast } = window.UI
      const M = window.MOCK

      // ── 配置 ──
      const withDefaults = (h) => {
        const merge = (base, over) => {
          const out = Array.isArray(base) ? [...base] : { ...base }
          for (const k of Object.keys(base)) {
            if (over && typeof over[k] !== 'undefined' && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], over[k])
            else if (over && typeof over[k] !== 'undefined') out[k] = over[k]
          }
          return out
        }
        return merge(DEFAULTS, h || {})
      }
      // 初始即填默认值：避免配置接口返回前模板访问 form.ingestion.* 等空对象刷屏报错
      const form = reactive(withDefaults({}))
      let origSnapshot = {}
      const dirty = ref(false)
      let dirtySuppressed = true
      watch(form, () => { if (!dirtySuppressed) dirty.value = true }, { deep: true })
      const syncForm = (snap) => {
        dirtySuppressed = true
        const detached = withDefaults(JSON.parse(JSON.stringify(snap || {})))
        for (const k of Object.keys(form)) delete form[k]
        Object.assign(form, detached)
        origSnapshot = JSON.parse(JSON.stringify(form))
        dirty.value = false
        nextTick(() => { dirtySuppressed = false })
      }
      const buildChanges = (orig, frm, prefix = 'agent.groupWorld', out = {}) => {
        for (const k of Object.keys(frm)) {
          const p = prefix + '.' + k, a = orig?.[k], b = frm[k]
          if (b && typeof b === 'object' && !Array.isArray(b) && a && typeof a === 'object') buildChanges(a, b, p, out)
          else if (JSON.stringify(a) !== JSON.stringify(b)) out[p] = b
        }
        return out
      }
      const save = async () => {
        const changes = buildChanges(origSnapshot, JSON.parse(JSON.stringify(form)))
        if (!Object.keys(changes).length) { toast('无改动', 'warn'); return }
        try {
          await window.api.put('/config', { changes })
          await window.store.loadConfig()
          if (M.config?.groupWorld) syncForm(M.config.groupWorld)
          toast('已保存（已热加载）', 'success')
        } catch (e) { toast(e.message, 'error') }
      }
      const reset = () => {
        dirtySuppressed = true
        for (const k of Object.keys(form)) delete form[k]
        Object.assign(form, JSON.parse(JSON.stringify(origSnapshot)))
        dirty.value = false
        nextTick(() => { dirtySuppressed = false })
        toast('已还原为当前生效配置', 'info')
      }
      const enableWarn = computed(() => form.enabled === true && !(form.groups || []).length)
      const onlineWarn = computed(() => form.online === true && form.enabled !== true)

      // ── 标签 + 数据浏览 ──
      const tab = ref('config')
      const dataGid = ref('')
      const sub = ref('members')
      const stats = ref(null)
      const members = ref([])
      const episodes = ref([])
      const communities = ref([])
      const detail = ref(null)
      const loading = ref(false)
      const dataGroups = computed(() => ((form.groups || []).map((g) => String(g))))

      const loadData = async () => {
        if (!dataGid.value) return
        loading.value = true; detail.value = null
        try {
          const [s, m, ep, cm] = await Promise.all([
            window.api.get('/groupworld/stats', { groupId: dataGid.value }).catch(() => null),
            window.api.get('/groupworld/members', { groupId: dataGid.value, limit: 300 }).catch(() => []),
            window.api.get('/groupworld/episodes', { groupId: dataGid.value }).catch(() => []),
            window.api.get('/groupworld/communities', { groupId: dataGid.value }).catch(() => []),
          ])
          stats.value = s; members.value = m || []; episodes.value = ep || []; communities.value = cm || []
        } catch (e) { toast(e.message, 'error') }
        loading.value = false
      }
      const openProfile = async (userId) => {
        try { detail.value = await window.api.get('/groupworld/profile', { groupId: dataGid.value, userId }) }
        catch (e) { toast(e.message, 'error') }
      }
      const switchTab = async (t) => {
        tab.value = t
        if (t === 'data' && !dataGid.value && dataGroups.value.length) { dataGid.value = dataGroups.value[0]; await loadData() }
      }
      const tierName = (t) => TIER[t] || t || '?'
      const srcName = (s) => SRC[s] || s || '?'
      const epName = (t) => EPT[t] || t || '?'
      const pct = (v) => ((Number(v) || 0) * 100).toFixed(0) + '%'
      const shortId = (s) => String(s || '').slice(-8)

      onMounted(async () => {
        try { await window.store.loadConfig(); if (M.config) syncForm(M.config.groupWorld) } catch (e) { toast(e.message, 'error') }
      })

      return {
        form, dirty, save, reset, enableWarn, onlineWarn,
        tab, sub, switchTab, dataGid, dataGroups, stats, members, episodes, communities, detail, loading,
        loadData, openProfile, tierName, srcName, epName, pct, shortId, parseArr,
        sections: [], // 占位（配置页锚点导航已内联）
      }
    },
    template: `
    <div>
      <!-- 顶栏：配置 / 数据浏览 -->
      <div class="seg" style="display:inline-flex;margin-bottom:14px;background:var(--card,rgba(255,255,255,.7));border:1px solid var(--line);border-radius:10px;padding:3px">
        <button class="btn" :class="tab==='config' ? 'b-pri' : 'b-line'" @click="switchTab('config')"><v-icon name="config"/> 配置</button>
        <button class="btn" :class="tab==='data' ? 'b-pri' : 'b-line'" @click="switchTab('data')"><v-icon name="group"/> 数据浏览</button>
      </div>

      <!-- ════════════ 配置 ════════════（本页无锚点侧栏，不用 .cf-wrap 双列栅格） -->
      <div v-if="tab==='config'">
        <div class="note">
          <v-icon name="info" />
          <div>
            <b>群聊小世界 GroupWorld</b>：按群隔离的社会记忆层——持续摄入→会话切片→小时增量分析→画像/关系/事件/小圈子，
            可选把「局部社会现场」注入伪人 Planner/Replyer。
            <span class="pill p-rose" style="font-size:10px;padding:2px 7px;margin:0 4px">观察优先</span>
            <b>online 默认关</b>：先跑几天、用「数据浏览」核对画像质量，再翻 online 放量。
          </div>
        </div>
        <div v-if="enableWarn" class="note n-rose"><v-icon name="warn"/><div>总开关已开，但白名单为空 —— 不会在任何群生效。</div></div>
        <div v-if="onlineWarn" class="note n-rose"><v-icon name="warn"/><div>online=开 但总开关未开 —— 在线注入不会生效。</div></div>

        <div class="card cf-sec open"><div class="cf-sh"><span class="ct-ico" style="background:var(--grad)"><v-icon name="group"/></span><div><div class="ct-t">总开关 / 白名单</div><div class="ct-s">先加白名单群跑观测，核对画像质量后再开在线注入</div></div></div>
          <div class="cf-body"><div class="cf-grid">
            <cfg-row name="启用 GroupWorld"><v-switch v-model="form.enabled"/></cfg-row>
            <cfg-row name="在线注入 Planner/Replyer" desc="默认关：开=注入伪人决策与回复；关=仅观测" danger><v-switch v-model="form.online"/></cfg-row>
            <cfg-row full name="白名单群"><tag-editor v-model="form.groups" placeholder="输入群号回车" :mono="true"/></cfg-row>
          </div></div>
        </div>

        <div class="card cf-sec open"><div class="cf-sh"><span class="ct-ico" style="background:var(--grad-sky)"><v-icon name="filter"/></span><div><div class="ct-t">摄入 / 会话切片</div><div class="ct-s">原始消息落库、静默切片与主题漂移切分</div></div></div>
          <div class="cf-body"><div class="cf-grid">
            <cfg-row name="原始消息保留(天)"><input type="number" class="inp" style="width:110px" min="1" max="365" v-model.number="form.ingestion.rawMessageRetentionDays"></cfg-row>
            <cfg-row name="切片静默阈值(秒)"><input type="number" class="inp" style="width:120px" min="60" max="1800" v-model.number="form.ingestion.segmentIdleSeconds"></cfg-row>
            <cfg-row name="单片段最大消息数"><input type="number" class="inp" style="width:110px" min="20" max="200" v-model.number="form.ingestion.segmentMaxMessages"></cfg-row>
            <cfg-row name="忽略 #指令消息" desc="不摄入以 # 开头的指令消息"><v-switch v-model="form.ingestion.ignoreCommandMessages"/></cfg-row>
            <cfg-row name="忽略系统通知" desc="不摄入入群/撤回等系统事件"><v-switch v-model="form.ingestion.ignoreSystemNotices"/></cfg-row>
            <cfg-row name="主题漂移切分" desc="TextTiling 式：换话题但无静默间隙时也提前分割（提高分析质量；词面 bigram 相似度）"><v-switch v-model="form.ingestion.topicShiftEnabled"/></cfg-row>
            <cfg-row name="漂移比较近窗" desc="参与相似度比较的近窗有效消息数"><input type="number" class="inp" style="width:90px" min="2" max="30" v-model.number="form.ingestion.topicShiftWindow"></cfg-row>
            <cfg-row name="漂移相似度阈值" desc="近窗相似度低于此值即提前分割（越小越激进）"><input type="number" class="inp" style="width:100px" min="0" max="0.5" step="0.01" v-model.number="form.ingestion.topicShiftSimThreshold"></cfg-row>
          </div></div>
        </div>

        <div class="card cf-sec open"><div class="cf-sh"><span class="ct-ico" style="background:var(--grad-mint)"><v-icon name="cpu"/></span><div><div class="ct-t">分析 / 预算</div><div class="ct-s">小时增量分析的调度、模型与调用预算</div></div></div>
          <div class="cf-body"><div class="cf-grid">
            <cfg-row name="分析 cron"><input class="inp mono" style="width:170px" v-model="form.analysis.schedule" placeholder="7 * * * *"></cfg-row>
            <cfg-row name="片段最小有效消息数"><input type="number" class="inp" style="width:110px" min="1" max="50" v-model.number="form.analysis.minSegmentMessages"></cfg-row>
            <cfg-row name="每轮最多片段数"><input type="number" class="inp" style="width:110px" min="1" max="500" v-model.number="form.analysis.maxSegmentsPerRun"></cfg-row>
            <cfg-row name="分析模型" desc="已集中到 配置中心 → 模型配置（功能分配）"><span class="mut2 mono" style="font-size:12px">{{ form.analysis.modelProfile || '(留空=主模型)' }}</span></cfg-row>
            <cfg-row name="每群每日调用预算"><input type="number" class="inp" style="width:110px" min="0" max="10000" v-model.number="form.analysis.maxDailyCallsPerGroup"></cfg-row>
            <cfg-row name="非法 JSON 重试次数"><input type="number" class="inp" style="width:90px" min="0" max="5" v-model.number="form.analysis.retryCount"></cfg-row>
            <cfg-row name="maxTokens"><input type="number" class="inp" style="width:110px" min="256" v-model.number="form.analysis.maxTokens"></cfg-row>
            <cfg-row name="事件语义去重阈值" desc="embedding 余弦 ≥ 此值视为同一事件（需配 recall.embedProvider；未配只按同 title 去重）"><input type="number" class="inp" style="width:100px" min="0.5" max="1" step="0.01" v-model.number="form.analysis.episodeMergeSim"></cfg-row>
          </div></div>
        </div>

        <div class="card cf-sec open"><div class="cf-sh"><span class="ct-ico" style="background:var(--grad-vio)"><v-icon name="memory"/></span><div><div class="ct-t">画像 / 关系图</div><div class="ct-s">成员分层、画像特征上限与关系边维护</div></div></div>
          <div class="cf-body"><div class="cf-grid">
            <cfg-row name="hot 活跃天数(30d)"><input type="number" class="inp" style="width:100px" min="1" max="30" v-model.number="form.profiles.hotActiveDays30d"></cfg-row>
            <cfg-row name="warm 发言数(30d)"><input type="number" class="inp" style="width:100px" min="1" v-model.number="form.profiles.warmMessageCount30d"></cfg-row>
            <cfg-row name="在线最低置信度" desc="后端强制 ≥0.55" danger><input type="number" class="inp" style="width:100px" min="0.55" max="0.99" step="0.01" v-model.number="form.profiles.minOnlineConfidence"></cfg-row>
            <cfg-row name="每成员画像上限"><input type="number" class="inp" style="width:90px" min="1" max="20" v-model.number="form.profiles.maxTraitsPerUser"></cfg-row>
            <cfg-row name="近义特征合并阈值" desc="每日维护：同用户同类型特征 embedding 余弦 ≥ 此值合并（需配 recall.embedProvider）"><input type="number" class="inp" style="width:100px" min="0.5" max="1" step="0.01" v-model.number="form.profiles.traitMergeSimThreshold"></cfg-row>
            <cfg-row name="关系边活跃窗口(天)"><input type="number" class="inp" style="width:100px" min="7" max="365" v-model.number="form.graph.activeEdgeDays"></cfg-row>
            <cfg-row name="每成员一跳关系上限"><input type="number" class="inp" style="width:100px" min="0" max="200" v-model.number="form.graph.maxNeighborsPerUser"></cfg-row>
            <cfg-row name="每周小圈子识别"><v-switch v-model="form.graph.weeklyCommunityDetection"/></cfg-row>
          </div></div>
        </div>

        <div class="card cf-sec open"><div class="cf-sh"><span class="ct-ico" style="background:var(--grad-honey)"><v-icon name="shield"/></span><div><div class="ct-t">在线检索 / 隐私</div><div class="ct-s">注入伪人的检索预算与群友自查/退出权利</div></div></div>
          <div class="cf-body"><div class="cf-grid">
            <cfg-row name="Planner token 预算" desc="注入 Planner 的社会现场摘要上限"><input type="number" class="inp" style="width:110px" min="100" v-model.number="form.retrieval.plannerTokenBudget"></cfg-row>
            <cfg-row name="Replyer token 预算" desc="注入 Replyer 的社会现场摘要上限"><input type="number" class="inp" style="width:110px" min="100" v-model.number="form.retrieval.replyerTokenBudget"></cfg-row>
            <cfg-row name="在线返回旧事上限" desc="单次注入最多携带几条事件/群梗"><input type="number" class="inp" style="width:90px" min="0" v-model.number="form.retrieval.maxEpisodes"></cfg-row>
            <cfg-row name="在线返回关系上限" desc="单次注入最多携带几条关系"><input type="number" class="inp" style="width:90px" min="0" v-model.number="form.retrieval.maxRelationships"></cfg-row>
            <cfg-row name="允许查看画像" desc="群友可发 #查看我的群聊画像 自查"><v-switch v-model="form.privacy.allowUserInspect"/></cfg-row>
            <cfg-row name="允许纠正画像" desc="群友可发 #纠正我的群聊画像 补充/纠正"><v-switch v-model="form.privacy.allowUserCorrect"/></cfg-row>
            <cfg-row name="允许退出建模" desc="群友可发 #关闭我的群聊建模 退出（清除派生数据）"><v-switch v-model="form.privacy.allowUserOptOut"/></cfg-row>
            <cfg-row name="拦截敏感推断" danger><v-switch v-model="form.privacy.blockSensitiveInference"/></cfg-row>
          </div></div>
        </div>

        <Transition name="fade">
          <div v-if="dirty" class="savebar">
            <span class="dirty-dot"></span><span style="font-weight:700;font-size:13px">有未保存的修改</span>
            <div class="row g10" style="margin-left:auto">
              <button class="btn b-line" @click="reset"><v-icon name="undo"/>还原</button>
              <button class="btn b-pri" @click="save"><v-icon name="save"/>保存（热加载）</button>
            </div>
          </div>
        </Transition>
      </div>

      <!-- ════════════ 数据浏览（仅主人面板） ════════════ -->
      <div v-else>
        <div v-if="!dataGroups.length" class="note n-rose"><v-icon name="warn"/><div>白名单为空 —— 先在「配置」加入群号并保存，才会有数据。</div></div>
        <div class="row g10 wrap" style="margin-bottom:14px;align-items:center">
          <select class="sel" style="width:200px" v-model="dataGid" @change="loadData">
            <option v-for="g in dataGroups" :value="g">群 {{ g }}</option>
          </select>
          <button class="btn b-soft" @click="loadData"><v-icon name="refresh"/> 刷新</button>
          <span v-if="stats && stats.ready === false" class="pill p-rose">GroupWorld 未就绪（sqlite3 未装？）</span>
        </div>

        <!-- 统计卡 -->
        <div v-if="stats" class="row g10 wrap" style="margin-bottom:16px">
          <div class="card" style="flex:1;min-width:120px;padding:12px 14px"><div class="mut2" style="font-size:11px">成员</div><div class="num" style="font-size:22px;font-weight:800">{{ stats.members }}</div><div class="mut2" style="font-size:11px">hot {{ stats.hotMembers }}</div></div>
          <div class="card" style="flex:1;min-width:120px;padding:12px 14px"><div class="mut2" style="font-size:11px">特征</div><div class="num" style="font-size:22px;font-weight:800">{{ stats.traits }}</div></div>
          <div class="card" style="flex:1;min-width:120px;padding:12px 14px"><div class="mut2" style="font-size:11px">关系边</div><div class="num" style="font-size:22px;font-weight:800">{{ stats.edges }}</div></div>
          <div class="card" style="flex:1;min-width:120px;padding:12px 14px"><div class="mut2" style="font-size:11px">事件/群梗</div><div class="num" style="font-size:22px;font-weight:800">{{ stats.episodes }}</div></div>
          <div class="card" style="flex:1;min-width:120px;padding:12px 14px"><div class="mut2" style="font-size:11px">小圈子</div><div class="num" style="font-size:22px;font-weight:800">{{ stats.communities }}</div></div>
          <div class="card" style="flex:1;min-width:120px;padding:12px 14px"><div class="mut2" style="font-size:11px">今日调用</div><div class="num" style="font-size:22px;font-weight:800">{{ stats.cursor?.daily_calls_today || 0 }}</div><div class="mut2" style="font-size:11px">待分析片段 {{ stats.pendingSegments }}<span v-if="stats.deadSegments" style="color:var(--rose)"> · 失败 {{ stats.deadSegments }}</span></div></div>
        </div>

        <!-- 子标签 -->
        <div class="seg" style="display:inline-flex;margin-bottom:12px;border:1px solid var(--line);border-radius:10px;padding:3px">
          <button class="btn b-sm" :class="sub==='members' ? 'b-pri' : 'b-line'" @click="sub='members'">成员 ({{ members.length }})</button>
          <button class="btn b-sm" :class="sub==='episodes' ? 'b-pri' : 'b-line'" @click="sub='episodes'">事件/群梗 ({{ episodes.length }})</button>
          <button class="btn b-sm" :class="sub==='communities' ? 'b-pri' : 'b-line'" @click="sub='communities'">小圈子 ({{ communities.length }})</button>
        </div>

        <!-- 成员表 -->
        <div v-if="sub==='members'" class="card" style="padding:0;overflow:hidden">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="background:var(--bg,var(--line));text-align:left"><th style="padding:8px 12px">昵称</th><th>分层</th><th>30天</th><th>活跃天</th><th>最后发言</th><th></th></tr></thead>
            <tbody>
              <tr v-for="m in members" :key="m.user_id" style="border-top:1px solid var(--line)">
                <td style="padding:8px 12px"><b>{{ m.current_nickname || m.user_id }}</b><div class="mut2 mono" style="font-size:11px">{{ shortId(m.user_id) }}</div></td>
                <td><span class="pill" :class="m.activity_tier==='hot'?'p-pri':m.activity_tier==='warm'?'p-sky':'p-soft'">{{ tierName(m.activity_tier) }}</span></td>
                <td>{{ m.message_count_30d }}</td>
                <td>{{ m.active_days_30d }}</td>
                <td class="mut2" style="font-size:12px">{{ m.last_spoke_at ? new Date(m.last_spoke_at).toLocaleString('zh-CN') : '-' }}</td>
                <td style="text-align:right;padding-right:12px"><button class="btn b-soft b-sm" @click="openProfile(m.user_id)"><v-icon name="search"/> 画像</button></td>
              </tr>
              <tr v-if="!members.length"><td colspan="6" class="mut2" style="padding:20px;text-align:center">暂无成员数据（需开启并在该群有对话积累）</td></tr>
            </tbody>
          </table>
        </div>

        <!-- 事件 -->
        <div v-if="sub==='episodes'" class="row g10 wrap">
          <div v-for="e in episodes" :key="e.id" class="card" style="flex:1;min-width:280px;padding:12px 14px">
            <div class="row g6" style="align-items:center"><span class="pill p-vio">{{ epName(e.episode_type) }}</span><b>{{ e.title }}</b><span class="mut2" style="font-size:11px">重要度 {{ pct(e.importance) }} · 可信 {{ pct(e.confidence) }}</span></div>
            <div class="mut" style="margin-top:6px;font-size:13px">{{ e.summary }}</div>
            <div class="mut2" style="font-size:11px;margin-top:4px">{{ e.occurred_at ? new Date(e.occurred_at).toLocaleDateString('zh-CN') : '' }} · 参与 {{ parseArr(e.participant_ids).length }} 人</div>
          </div>
          <div v-if="!episodes.length" class="mut2" style="padding:20px">暂无事件/群梗（由小时分析从对话中抽取）</div>
        </div>

        <!-- 圈子 -->
        <div v-if="sub==='communities'" class="row g10 wrap">
          <div v-for="c in communities" :key="c.id" class="card" style="flex:1;min-width:280px;padding:12px 14px">
            <div class="row g6" style="align-items:center"><span class="pill p-honey">{{ parseArr(c.member_ids).length }}人圈</span><span class="mut2" style="font-size:11px">{{ c.algorithm }}</span></div>
            <div class="mut" style="margin-top:6px;font-size:13px">{{ c.summary }}</div>
            <div v-if="parseArr(c.topic_tags).length" class="row g6 wrap" style="margin-top:6px"><span v-for="t in parseArr(c.topic_tags)" class="pill p-soft" style="font-size:11px">{{ t }}</span></div>
          </div>
          <div v-if="!communities.length" class="mut2" style="padding:20px">暂无小圈子（每周聚类自动产出；需 graph.weeklyCommunityDetection=on 且有足够互动）</div>
        </div>

        <!-- 画像详情抽屉 -->
        <div v-if="detail" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:50;display:flex;justify-content:flex-end" @click.self="detail=null">
          <div class="card" style="width:min(560px,92vw);height:100vh;overflow:auto;border-radius:0;padding:18px 20px">
            <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px">
              <b style="font-size:16px">{{ detail.profile?.current_nickname || '成员' }} 的画像</b>
              <button class="btn b-line b-sm" @click="detail=null"><v-icon name="x"/></button>
            </div>
            <div v-if="!detail.profile" class="mut2">该成员暂无统计行（可能已被清理或为陌生人）。</div>
            <div v-if="detail.profile" class="mut2" style="font-size:12px;margin-bottom:10px">分层 {{ tierName(detail.profile.activity_tier) }} · 30天 {{ detail.profile.message_count_30d }} 条 / {{ detail.profile.active_days_30d }} 天 · mono {{ shortId(detail.profile.user_id) }}</div>

            <div style="font-weight:700;margin:10px 0 6px">画像特征（{{ detail.traits.length }}）</div>
            <div v-for="t in detail.traits" :key="t.id" class="card" style="padding:10px 12px;margin-bottom:8px">
              <div class="row g6" style="align-items:center;flex-wrap:wrap">
                <span class="pill" :class="t.source_type==='inferred'?'p-soft':t.source_type==='admin_corrected'?'p-pri':'p-sky'">{{ srcName(t.source_type) }}</span>
                <span class="pill p-soft" style="font-size:11px">{{ t.trait_type }}</span>
                <span class="mut2" style="font-size:11px">可信 {{ pct(t.confidence) }} · 证据 {{ t.evidence_count }} · {{ t.status }}</span>
              </div>
              <div style="margin-top:4px">{{ t.trait_value }}</div>
              <details v-if="detail.evidByTrait[t.id]?.length" style="margin-top:4px"><summary class="mut2" style="font-size:11px;cursor:pointer">证据 {{ detail.evidByTrait[t.id].length }} 条</summary>
                <div v-for="(ev,i) in detail.evidByTrait[t.id]" :key="i" class="mut2 mono" style="font-size:11px;padding:2px 0">· {{ ev.evidence_text }} <span v-if="ev.message_id">[#{{ shortId(ev.message_id) }}]</span></div>
              </details>
            </div>
            <div v-if="!detail.traits.length" class="mut2">暂无特征。</div>

            <div style="font-weight:700;margin:14px 0 6px">与机器人的主观关系</div>
            <div v-if="detail.botRels.length">
              <div v-for="br in detail.botRels" :key="br.bot_id" class="mut" style="font-size:13px">
                bot {{ shortId(br.bot_id) }}：熟悉 {{ pct(br.familiarity) }} · 好感 {{ pct(br.affinity) }} · 信任 {{ pct(br.trust) }} · 互动 {{ br.interaction_count }} 次<span v-if="br.interaction_style"> · {{ br.interaction_style }}</span>
              </div>
            </div>
            <div v-else class="mut2">尚无直接互动记录。</div>

            <div style="font-weight:700;margin:14px 0 6px">一跳关系（{{ detail.edges.length }}）</div>
            <div v-for="e in detail.edges" :key="e.from_user_id+e.to_user_id" class="mut" style="font-size:12px;padding:2px 0">
              · {{ shortId(e.from_user_id) }} → {{ shortId(e.to_user_id) }} · 强度 {{ pct(e.interaction_strength) }}（回复 {{ e.reply_count_30d }}/@ {{ e.mention_count_30d }}）<span v-if="e.inferred_relation"> · {{ e.inferred_relation }}</span>
            </div>
            <div v-if="!detail.edges.length" class="mut2">暂无关系边。</div>
          </div>
        </div>
      </div>
    </div>`,
  }
})()
