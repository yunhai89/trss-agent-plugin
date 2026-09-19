/** 视图:统一用户画像 profile(§3.4 · KV · 按用户 · 结构化分面 + 证据/置信/来源) */
(function () {
  window.VIEWS = window.VIEWS || {}

  const FACETS = {
    identity: { name: '身份', cls: 'p-vio' },
    communication: { name: '沟通风格', cls: 'p-mint' },
    preference: { name: '偏好', cls: 'p-sky' },
    expertise: { name: '专长', cls: 'p-honey' },
    sensitivity: { name: '忌讳/雷点', cls: 'p-rose' },
    fact: { name: '其他事实', cls: 'p-line' },
  }
  const SOURCE = {
    observed: { name: '观察', cls: 'p-mint' },
    inferred: { name: '推断', cls: 'p-honey' },
    corrected: { name: '更正', cls: 'p-vio' },
  }

  window.VIEWS.profile = {
    name: 'ProfileView',
    setup() {
      const { ref, computed, onMounted, watch } = Vue
      const { toast, fmt } = window.UI
      const M = window.MOCK

      const userIds = computed(() => [...new Set((M.scopes || []).map((s) => s.userId).filter(Boolean))])
      const userId = ref('')
      const facet = ref('all')
      const showSuperseded = ref(false)

      const data = computed(() => M.profile[userId.value] || { entries: [], stats: {} })
      const disabled = computed(() => !!data.value.disabled)

      const entries = computed(() => (data.value.entries || [])
        .filter((e) => facet.value === 'all' || e.facet === facet.value)
        .filter((e) => showSuperseded.value || e.status !== 'superseded')
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)))

      const stats = computed(() => {
        const s = data.value.stats || {}
        const msgs = s.msgs || 0
        const avg = msgs ? Math.round((s.chars || 0) / msgs) : 0
        const hours = Object.entries(s.hours || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
        return { msgs, avg, hours, emojiRate: msgs ? Math.round(((s.emojis || 0) / msgs) * 100) : 0, askRate: msgs ? Math.round(((s.questions || 0) / msgs) * 100) : 0 }
      })

      const activeCount = computed(() => (data.value.entries || []).filter((e) => e.status !== 'superseded').length)

      const expanded = ref({})
      const toggle = (id) => { expanded.value[id] = !expanded.value[id] }

      const del = async (e) => {
        try {
          await window.api.del(`/profile/${userId.value}/${e.id}`)
          await window.store.loadProfile(userId.value)
          toast('已移除该画像条目（保留审计链）', 'info')
        } catch (err) { toast(err.message, 'error') }
      }

      const clearUser = async () => {
        if (!userId.value) return
        try {
          await window.api.del(`/profile/${userId.value}`)
          await window.store.loadProfile(userId.value)
          toast('已清空该用户画像')
        } catch (err) { toast(err.message, 'error') }
      }

      const addModal = ref({ show: false, facet: 'communication', claim: '', confidence: 0.9 })
      const add = async () => {
        const m = addModal.value
        if (!m.claim.trim()) return
        try {
          await window.api.post(`/profile/${userId.value}`, {
            facet: m.facet, claim: m.claim.trim(), confidence: m.confidence,
          })
          await window.store.loadProfile(userId.value)
          toast('已写入画像（过威胁扫描）')
          addModal.value.show = false
          addModal.value.claim = ''
        } catch (err) { toast(err.message, 'error') }
      }

      onMounted(async () => {
        try {
          await window.store.loadScopes()
          if (!userId.value && userIds.value[0]) userId.value = userIds.value[0]
          if (userId.value) await window.store.loadProfile(userId.value)
        } catch (e) { toast(e.message, 'error') }
      })
      watch(userId, (v) => { if (v) window.store.loadProfile(v).catch((e) => toast(e.message, 'error')) })

      return { userIds, userId, facet, showSuperseded, entries, stats, activeCount, disabled, expanded, toggle, del, clearUser, addModal, add, FACETS, SOURCE, fmt }
    },
    template: `
    <div>
      <page-head title="用户画像" icon="user" desc="统一用户模型 · 身份/沟通风格/偏好/忌讳分面 · 带证据与置信 · 可纠错（推断项标注 来源=推断）">
        <button class="btn b-line" @click="clearUser"><v-icon name="trash"/>清空</button>
        <button class="btn b-pri" @click="addModal.show = true"><v-icon name="plus"/>写入画像</button>
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
              <button :class="{on: facet === 'all'}" @click="facet = 'all'">全部</button>
              <button v-for="(v, k) in FACETS" :key="k" :class="{on: facet === k}" @click="facet = k">{{ v.name }}</button>
            </div>
            <span class="pill" :class="showSuperseded ? 'p-honey' : ''" style="cursor:pointer" @click="showSuperseded = !showSuperseded">
              <v-icon name="clock"/>{{ showSuperseded ? '含已替换' : '隐藏已替换' }}
            </span>
          </div>
        </div>
        <div class="mut2 mt12" style="font-size:12px">
          键 <span class="mono">Yz:agent:profile:{{ userId || '—' }}</span>
        </div>
      </div>

      <div v-if="disabled" class="card pad mt16">
        <empty-state icon="user" text="用户画像未启用" sub="在 配置中心 → 记忆系统 打开「用户画像」后生效"/>
      </div>

      <template v-else>
        <!-- 统计摘要 -->
        <div class="card pad mt16" style="--i:2">
          <div class="row-b wrap g14">
            <div class="ct">
              <span class="ct-ico" style="background:var(--grad)"><v-icon name="user"/></span>
              <div><div class="ct-t">画像概览</div><div class="ct-s">{{ activeCount }} 条有效画像</div></div>
            </div>
            <div class="row g10 wrap">
              <span class="pill p-line">消息 {{ stats.msgs }}</span>
              <span class="pill p-line">平均 {{ stats.avg }} 字</span>
              <span class="pill p-line">提问率 {{ stats.askRate }}%</span>
              <span class="pill p-line">表情率 {{ stats.emojiRate }}%</span>
              <span v-for="h in stats.hours" :key="h[0]" class="pill p-sky">{{ String(h[0]).padStart(2,'0') }}:00 · {{ h[1] }}</span>
            </div>
          </div>
        </div>

        <TransitionGroup name="list" tag="div" class="grid g2 mt16" style="position:relative">
          <div v-for="(e, i) in entries" :key="e.id" class="card lift pad" :class="{suspect: e.suspect}" :style="{'--i': i + 3}">
            <div class="row-b">
              <div class="row g6 wrap">
                <span class="pill" :class="FACETS[e.facet]?.cls || 'p-line'">{{ FACETS[e.facet]?.name || e.facet }}</span>
                <span class="pill" :class="SOURCE[e.source]?.cls || 'p-line'">{{ SOURCE[e.source]?.name || e.source }}</span>
                <span v-if="e.status === 'superseded'" class="pill p-line"><v-icon name="clock"/>已替换</span>
                <span v-if="e.suspect" class="pill p-rose"><v-icon name="warn"/>疑似注入</span>
              </div>
              <button class="bic dg" @click="del(e)"><v-icon name="trash"/></button>
            </div>
            <p class="mt12" style="font-size:13px;line-height:1.7" :class="{'mut': e.status === 'superseded'}">{{ e.claim }}</p>
            <div class="row-b mt12 wrap g8">
              <div class="row g10">
                <div class="meter" style="width:90px" :class="e.confidence > 0.85 ? 'm-mint' : e.confidence > 0.6 ? '' : 'm-honey'">
                  <i :style="{width: e.confidence * 100 + '%'}"></i>
                </div>
                <span class="mut num" style="font-size:11.5px">置信 {{ (e.confidence * 100).toFixed(0) }}%</span>
              </div>
              <span class="mut2" style="font-size:11.5px">更新于 {{ fmt.ago(e.updatedAt) }}</span>
            </div>
            <div v-if="e.evidence && e.evidence.length" class="mut2 mt12" style="font-size:11px">
              证据 <span class="mono">{{ e.evidence.join(', ') }}</span>
            </div>
            <div v-if="e.prev && e.prev.length" class="mt12">
              <span class="pill p-line" style="cursor:pointer;font-size:10.5px" @click="toggle(e.id)">
                <v-icon name="clock"/>{{ expanded[e.id] ? '收起历史版本' : e.prev.length + ' 个被替换旧值' }}
              </span>
              <Transition name="expand">
                <div v-if="expanded[e.id]" class="mt12" style="display:flex;flex-direction:column;gap:6px">
                  <div v-for="(p, j) in e.prev" :key="j" style="padding:8px 11px;border-radius:10px;background:var(--well);font-size:12px" class="mut">
                    <s>{{ p.claim }}</s>
                    <span class="mut2" style="margin-left:8px;font-size:11px">置信 {{ (p.confidence * 100).toFixed(0) }}% · {{ fmt.ago(p.updatedAt) }}</span>
                  </div>
                </div>
              </Transition>
            </div>
          </div>
        </TransitionGroup>
        <empty-state v-if="!entries.length" icon="user" text="该筛选下暂无画像条目" sub="继续对话会自动归纳，也可手动写入"/>
      </template>

      <!-- 写入弹窗 -->
      <v-modal v-if="addModal.show" title="写入用户画像" icon="plus" @close="addModal.show = false">
        <div class="grid g2" style="gap:14px">
          <div class="field">
            <label class="f-label">分面</label>
            <select class="sel" v-model="addModal.facet"><option v-for="(v, k) in FACETS" :value="k">{{ v.name }}</option></select>
          </div>
          <div class="field">
            <label class="f-label">置信度 {{ (addModal.confidence * 100).toFixed(0) }}%</label>
            <input type="range" class="rng" min="0.1" max="1" step="0.05" v-model.number="addModal.confidence" :style="{'--fill': addModal.confidence * 100 + '%'}">
          </div>
          <div class="field" style="grid-column:1/-1">
            <label class="f-label">画像内容</label>
            <textarea class="txa" v-model="addModal.claim" maxlength="200" placeholder="例如:偏好简短直接的回答，不要客套"></textarea>
            <span class="f-help">写入来源标记为「更正」（人工权威），会过威胁扫描；相似条目自动合并。</span>
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
