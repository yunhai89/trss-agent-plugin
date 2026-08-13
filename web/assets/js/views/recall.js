/** 视图:长期记忆 recall(§3.3 · KV · 按用户) */
(function () {
  window.VIEWS = window.VIEWS || {}

  const LEVEL = {
    L2: { name: 'L2 近期', cls: 'p-sky', desc: '近期上下文事实' },
    L3: { name: 'L3 偏好', cls: 'p-vio', desc: '用户偏好' },
    L4: { name: 'L4 事实', cls: 'p-mint', desc: '稳定事实/身份' },
  }

  window.VIEWS.recall = {
    name: 'RecallView',
    setup() {
      const { ref, computed, onMounted, watch } = Vue
      const { toast, fmt } = window.UI
      const M = window.MOCK

      /* 用户清单来自 scope 列表(唯一 userId);recall 接口按单用户取 */
      const userIds = computed(() => [...new Set((M.scopes || []).map((s) => s.userId).filter(Boolean))])
      const userId = ref('')
      const level = ref('all')
      const showSuspect = ref(true)

      const entries = computed(() => (M.recall[userId.value] || [])
        .filter((e) => level.value === 'all' || e.level === level.value)
        .filter((e) => showSuspect.value || !e.suspect)
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt))

      const expanded = ref({})
      const toggle = (id) => { expanded.value[id] = !expanded.value[id] }

      const del = async (e) => {
        try {
          await window.api.del(`/recall/${userId.value}/${e.id}`)
          await window.store.loadRecall(userId.value)
          toast('已删除该条长期记忆', 'info')
        } catch (err) { toast(err.message, 'error') }
      }

      const addModal = ref({ show: false, level: 'L3', type: 'preference', content: '', confidence: 0.8 })
      const add = async () => {
        const m = addModal.value
        if (!m.content.trim()) return
        try {
          await window.api.post(`/recall/${userId.value}`, {
            level: m.level, type: m.type, content: m.content.trim(), confidence: m.confidence,
          })
          await window.store.loadRecall(userId.value)
          toast('已写入长期记忆(已过威胁扫描)')
          addModal.value.show = false
          addModal.value.content = ''
        } catch (err) { toast(err.message, 'error') }
      }

      /* 惰性加载:scope 列表定默认用户 → 拉该用户 recall;切用户重拉 */
      onMounted(async () => {
        try {
          await window.store.loadScopes()
          if (!userId.value && userIds.value[0]) userId.value = userIds.value[0]
          if (userId.value) await window.store.loadRecall(userId.value)
        } catch (e) { toast(e.message, 'error') }
      })
      watch(userId, (v) => { if (v) window.store.loadRecall(v).catch((e) => toast(e.message, 'error')) })

      return { userIds, userId, level, showSuspect, entries, expanded, toggle, del, addModal, add, LEVEL, fmt }
    },
    template: `
    <div>
      <page-head title="长期记忆" icon="recall" desc="LLM 抽取沉淀 · L2/L3/L4 分层 · 上限 200 条超限按价值淘汰，命中注入扫描的条目召回屏蔽但排查保留">
        <button class="btn b-pri" @click="addModal.show = true"><v-icon name="plus"/>写入记忆</button>
      </page-head>

      <div class="card pad" style="--i:1">
        <div class="row-b wrap g14">
          <div class="scp-bar">
            <span class="scp-lab">用户</span>
            <div v-for="u in userIds" :key="u" class="scp" :class="{on: u === userId}" @click="userId = u">
              <v-icon name="user"/><span class="mono">{{ u }}</span>
            </div>
          </div>
          <div class="row g10 wrap">
            <div class="seg">
              <button :class="{on: level === 'all'}" @click="level = 'all'">全部</button>
              <button v-for="(v, k) in LEVEL" :key="k" :class="{on: level === k}" @click="level = k">{{ k }}</button>
            </div>
            <span class="pill" :class="showSuspect ? 'p-honey' : ''" style="cursor:pointer" @click="showSuspect = !showSuspect">
              <v-icon name="shield"/>{{ showSuspect ? '含可疑条目' : '已隐藏可疑' }}
            </span>
          </div>
        </div>
        <div class="mut2 mt12" style="font-size:12px">
          键 <span class="mono">Yz:agent:mem:{{ userId || '—' }}</span>
        </div>
      </div>

      <TransitionGroup name="list" tag="div" class="grid g2 mt16" style="position:relative">
        <div v-for="(e, i) in entries" :key="e.id" class="card lift pad" :class="{suspect: e.suspect}" :style="{'--i': i + 2}">
          <div class="row-b">
            <div class="row g6 wrap">
              <span class="pill" :class="LEVEL[e.level].cls">{{ LEVEL[e.level].name }}</span>
              <span class="pill p-line mono">{{ e.type }}</span>
              <span v-if="e.suspect" class="pill p-rose"><v-icon name="warn"/>疑似注入</span>
            </div>
            <button class="bic dg" @click="del(e)"><v-icon name="trash"/></button>
          </div>
          <p class="mt12" style="font-size:13px;line-height:1.7">{{ e.content }}</p>
          <div class="row-b mt12 wrap g8">
            <div class="row g10">
              <div class="meter" style="width:90px" :class="e.confidence > 0.85 ? 'm-mint' : e.confidence > 0.6 ? '' : 'm-honey'">
                <i :style="{width: e.confidence * 100 + '%'}"></i>
              </div>
              <span class="mut num" style="font-size:11.5px">置信 {{ (e.confidence * 100).toFixed(0) }}%</span>
            </div>
            <span class="mut2" style="font-size:11.5px">更新于 {{ fmt.ago(e.updatedAt) }}</span>
          </div>
          <div v-if="e.prev && e.prev.length" class="mt12">
            <span class="pill p-line" style="cursor:pointer;font-size:10.5px" @click="toggle(e.id)">
              <v-icon name="clock"/>{{ expanded[e.id] ? '收起历史版本' : e.prev.length + ' 个被覆盖旧值' }}
            </span>
            <Transition name="expand">
              <div v-if="expanded[e.id]" class="mt12" style="display:flex;flex-direction:column;gap:6px">
                <div v-for="(p, j) in e.prev" :key="j" style="padding:8px 11px;border-radius:10px;background:var(--well);font-size:12px" class="mut">
                  <s>{{ p.content }}</s>
                  <span class="mut2" style="margin-left:8px;font-size:11px">置信 {{ (p.confidence * 100).toFixed(0) }}% · {{ fmt.ago(p.updatedAt) }}</span>
                </div>
              </div>
            </Transition>
          </div>
        </div>
      </TransitionGroup>
      <empty-state v-if="!entries.length" icon="recall" text="该筛选下暂无记忆条目"/>

      <!-- 写入弹窗 -->
      <v-modal v-if="addModal.show" title="写入长期记忆" icon="plus" @close="addModal.show = false">
        <div class="grid g2" style="gap:14px">
          <div class="field">
            <label class="f-label">层级</label>
            <select class="sel" v-model="addModal.level"><option v-for="(v, k) in LEVEL" :value="k">{{ v.name }} · {{ v.desc }}</option></select>
          </div>
          <div class="field">
            <label class="f-label">类型</label>
            <select class="sel" v-model="addModal.type">
              <option value="preference">preference 偏好</option><option value="name">name 称呼</option>
              <option value="identity">identity 身份</option><option value="fact">fact 事实</option>
            </select>
          </div>
          <div class="field" style="grid-column:1/-1">
            <label class="f-label">内容</label>
            <textarea class="txa" v-model="addModal.content" placeholder="例如:用户周五晚上有固定开黑活动"></textarea>
          </div>
          <div class="field" style="grid-column:1/-1">
            <label class="f-label">置信度 {{ (addModal.confidence * 100).toFixed(0) }}%</label>
            <input type="range" class="rng" min="0.1" max="1" step="0.05" v-model.number="addModal.confidence" :style="{'--fill': addModal.confidence * 100 + '%'}">
          </div>
        </div>
        <template #foot>
          <button class="btn b-line" @click="addModal.show = false">取消</button>
          <button class="btn b-pri" @click="add"><v-icon name="check"/>写入</button>
        </template>
      </v-modal>
    </div>`,
  }
})()
