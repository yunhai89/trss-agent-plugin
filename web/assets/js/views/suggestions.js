/** 视图:自进化建议(§2.5 · suggestions 待审列表) */
(function () {
  window.VIEWS = window.VIEWS || {}

  const KIND = {
    memory: { name: '记忆', cls: 'p-honey', icon: 'memory' },
    skill: { name: '技能', cls: 'p-vio', icon: 'skill' },
    prompt: { name: 'Prompt', cls: 'p-sky', icon: 'edit' },
  }
  const ACTION = {
    add: { name: '新增', cls: 'p-green' },
    remove: { name: '删除', cls: 'p-rose' },
    replace: { name: '替换', cls: 'p-honey' },
  }
  const STATUS = {
    pending: { name: '待审', cls: 'p-honey' },
    applied: { name: '已应用', cls: 'p-green' },
    apply_failed: { name: '应用失败', cls: 'p-rose' },
  }

  window.VIEWS.suggestions = {
    name: 'SuggestionsView',
    setup() {
      const { ref, computed, onMounted } = Vue
      const { toast, fmt } = window.UI
      const M = window.MOCK

      const status = ref('all')
      const kind = ref('all')
      const list = computed(() => M.suggestions
        .filter((s) => status.value === 'all' || s.status === status.value)
        .filter((s) => kind.value === 'all' || s.kind === kind.value)
        .slice().sort((a, b) => b.ts - a.ts))

      const decide = async (s, ok) => {
        try {
          if (ok) {
            await window.api.post(`/suggestions/${s.id}/apply`)
            toast(`建议 ${s.id} 已应用`)
          } else {
            await window.api.del(`/suggestions/${s.id}`)
            toast(`建议 ${s.id} 已驳回`, 'info')
          }
          await window.store.loadSuggestions()
        } catch (e) { toast(e.message, 'error') }
      }

      const pendingCount = computed(() => M.suggestions.filter((s) => s.status === 'pending').length)

      /* 惰性加载:拉全部建议(scopeId/status 均可选);status/kind 为纯客户端筛选 */
      onMounted(async () => { try { await window.store.loadSuggestions() } catch (e) { toast(e.message, 'error') } })

      return { list, status, kind, decide, pendingCount, KIND, ACTION, STATUS, fmt }
    },
    template: `
    <div>
      <div class="card pad row-b wrap g14" style="--i:0">
        <div class="ct">
          <span class="ct-ico" style="background:var(--grad-rose)"><v-icon name="evolution"/></span>
          <div>
            <div class="ct-t">进化建议</div>
            <div class="ct-s">后台自评审产出 · memory 类可自动应用，prompt/skill 类默认落盘待人工把关</div>
          </div>
        </div>
        <div class="row g10 wrap">
          <div class="seg">
            <button :class="{on: status === 'all'}" @click="status = 'all'">全部</button>
            <button v-for="(v, k) in STATUS" :key="k" :class="{on: status === k}" @click="status = k">{{ v.name }}</button>
          </div>
          <div class="seg">
            <button :class="{on: kind === 'all'}" @click="kind = 'all'">全部类</button>
            <button v-for="(v, k) in KIND" :key="k" :class="{on: kind === k}" @click="kind = k">{{ v.name }}</button>
          </div>
        </div>
      </div>

      <TransitionGroup name="list" tag="div" class="mt16" style="display:flex;flex-direction:column;gap:12px;position:relative">
        <div v-for="(s, i) in list" :key="s.id" class="card pad lift" :style="{'--i': i + 1}">
          <div class="row-b wrap g10">
            <div class="row g6 wrap">
              <span class="pill" :class="KIND[s.kind].cls"><v-icon :name="KIND[s.kind].icon"/>{{ KIND[s.kind].name }}</span>
              <span class="pill" :class="ACTION[s.action].cls">{{ ACTION[s.action].name }}</span>
              <span class="pill p-line">target: {{ s.target }}</span>
              <span class="pill" :class="STATUS[s.status].cls">{{ STATUS[s.status].name }}</span>
            </div>
            <div class="row g10">
              <div class="meter" style="width:90px" :class="s.confidence > 0.85 ? 'm-mint' : s.confidence > 0.65 ? '' : 'm-honey'">
                <i :style="{width: s.confidence * 100 + '%'}"></i>
              </div>
              <span class="mut num" style="font-size:11.5px">置信 {{ (s.confidence * 100).toFixed(0) }}%</span>
            </div>
          </div>

          <!-- replace:diff 视图;其它:单 payload -->
          <div v-if="s.action === 'replace' && s.newPayload" class="diff-g mt12">
            <div class="diff-p old"><div class="diff-tag" style="color:var(--rose)">旧值 payload</div>{{ s.payload }}</div>
            <div class="diff-p new"><div class="diff-tag" style="color:var(--green)">新值 newPayload</div>{{ s.newPayload }}</div>
          </div>
          <p v-else class="mt12" style="font-size:13px;padding:10px 14px;border-radius:12px;background:rgba(255,255,255,.5);border:1px solid var(--line)">{{ s.payload }}</p>

          <div class="row-b wrap mt12" style="align-items:center">
            <span class="mut2" style="font-size:11.5px">
              <span class="mono">{{ s.id }}</span> · scope <span class="mono">{{ s.scopeId }}</span> · {{ fmt.ago(s.ts) }}
              <span v-if="s.error" style="color:var(--rose)"> · 失败原因:{{ s.error }}</span>
            </span>
            <div v-if="s.status === 'pending'" class="row g10">
              <button class="btn b-danger b-sm" @click="decide(s, false)"><v-icon name="x"/>驳回</button>
              <button class="btn b-ok b-sm" @click="decide(s, true)"><v-icon name="check"/>应用</button>
            </div>
          </div>
        </div>
      </TransitionGroup>
      <empty-state v-if="!list.length" icon="evolution" text="该筛选下暂无建议" sub="每 N 轮对话后台自评审产出,见配置中心 · 自进化"/>
    </div>`,
  }
})()
