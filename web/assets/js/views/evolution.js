/** 视图:工具进化(Tool Evolution)· 候选版本/状态/审批/淘汰 */
;(function () {
  window.VIEWS = window.VIEWS || {}
  const STATUS = {
    draft: { name: '草稿', cls: 'p-line' },
    verified: { name: '待采纳', cls: 'p-honey' },
    stable: { name: '已上线', cls: 'p-green' },
    rejected: { name: '已拒绝', cls: 'p-rose' },
    deprecated: { name: '已淘汰', cls: 'p-line' },
    quarantined: { name: '隔离', cls: 'p-rose' },
  }

  window.VIEWS.evolution = {
    name: 'EvolutionView',
    setup() {
      const { ref, computed, onMounted } = Vue
      const { toast } = window.UI

      const list = ref([])
      const loading = ref(false)
      const filter = ref('')

      const load = async () => {
        loading.value = true
        try { list.value = await window.api.get('/tevo/tools') }
        catch (e) { toast(e.message, 'error') }
        finally { loading.value = false }
      }
      const approve = async (id) => {
        try { await window.api.post('/tevo/tools/' + id + '/approve'); toast('已采纳并注入，agent 可调用', 'success'); await load() }
        catch (e) { toast(e.message, 'error') }
      }
      const decommission = async (id) => {
        try { await window.api.post('/tevo/tools/' + id + '/decommission'); toast('已淘汰', 'info'); await load() }
        catch (e) { toast(e.message, 'error') }
      }
      const rollback = async (id) => {
        try { const r = await window.api.post('/tevo/tools/' + id + '/rollback'); toast(r.msg || '已设为当前上线版本', 'success'); await load() }
        catch (e) { toast(e.message, 'error') }
      }

      const stats = computed(() => {
        const c = { draft: 0, verified: 0, stable: 0, rejected: 0, deprecated: 0 }
        for (const v of list.value) c[v.status] = (c[v.status] || 0) + 1
        return c
      })
      const filtered = computed(() => filter.value ? list.value.filter((v) => v.status === filter.value) : list.value)

      onMounted(load)
      return { list, loading, filter, filtered, stats, load, approve, decommission, rollback, STATUS }
    },
    template: `
    <div>
      <page-head title="工具进化" icon="tool" desc="Tool Evolution · 候选生成(LLM+AST) → 验证(沙箱) → 审批 → 版本。在 QQ 对 bot 发 #进化工具 <能力描述> 生成候选">
        <button class="btn b-line" @click="load"><v-icon name="refresh"/>刷新</button>
      </page-head>

      <div class="card pad" style="--i:1">
        <div class="row g8 wrap mb16">
          <button class="pill" :class="filter === '' ? 'p-pri' : ''" style="cursor:pointer" @click="filter=''">全部 {{ list.length }}</button>
          <button class="pill" :class="filter === 'verified' ? 'p-honey' : ''" style="cursor:pointer" @click="filter='verified'">待采纳 {{ stats.verified || 0 }}</button>
          <button class="pill" :class="filter === 'stable' ? 'p-green' : ''" style="cursor:pointer" @click="filter='stable'">已上线 {{ stats.stable || 0 }}</button>
          <button class="pill" :class="filter === 'rejected' ? 'p-rose' : ''" style="cursor:pointer" @click="filter='rejected'">已拒绝 {{ stats.rejected || 0 }}</button>
        </div>

        <empty-state v-if="!filtered.length && !loading" icon="tool" text="暂无进化工具版本" sub="在 QQ 对 bot 发 #进化工具 <能力描述> 生成候选"/>

        <div style="display:flex;flex-direction:column;gap:10px">
          <div v-for="v in filtered" :key="v.id" class="mem-row" style="align-items:center">
            <span class="pill" :class="(STATUS[v.status] || STATUS.draft).cls">{{ (STATUS[v.status] || STATUS.draft).name }}</span>
            <div style="flex:1;min-width:0">
              <b style="font-size:13px" class="mono">{{ v.tool_id }}</b>
              <span class="mono mut" style="margin-left:8px">v{{ v.semver }}</span>
              <div class="mut2 mono ell" style="font-size:10.5px;margin-top:2px">id: {{ v.id }} · 生成模型: {{ v.generator_model || '—' }}</div>
            </div>
            <div class="row g6 wrap">
              <button v-if="v.status==='verified'" class="btn b-pri b-sm" @click="approve(v.id)"><v-icon name="check"/>采纳上线</button>
              <button v-if="v.status==='stable'" class="btn b-line b-sm" @click="rollback(v.id)"><v-icon name="undo"/>设为当前</button>
              <button v-if="v.status==='stable'" class="btn b-danger b-sm" @click="decommission(v.id)">淘汰</button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  }
})()
