/** 视图:任务账本（P0-3 可恢复任务：阶段/事件/取消/恢复检查点） */
;(function () {
  window.VIEWS = window.VIEWS || {}

  const PHASES = ['', 'running', 'paused', 'waiting_input', 'interrupted', 'completed', 'failed', 'cancelled']
  const PHASE_CN = { running: '运行中', paused: '已暂停', waiting_input: '等待输入', interrupted: '已中断', completed: '已完成', failed: '失败', cancelled: '已取消', queued: '排队中' }
  const PHASE_CLASS = { completed: 'p-green', running: 'p-sky', paused: 'p-honey', waiting_input: 'p-honey', interrupted: 'p-honey', queued: 'p-vio', failed: 'p-rose', cancelled: 'p-rose' }

  window.VIEWS.tasks = {
    name: 'TasksView',
    setup() {
      const { ref, onMounted } = Vue
      const { toast } = window.UI

      const data = ref({ enabled: false, tasks: [] })
      const loading = ref(false)
      const phase = ref('')
      const detail = ref(null)
      const events = ref([])

      const load = async () => {
        loading.value = true
        try {
          data.value = await window.api.get('/tasks', phase.value ? { phase: phase.value, limit: 100 } : { limit: 100 })
        } catch (e) { toast(e.message, 'error') }
        loading.value = false
      }
      const open = async (t) => {
        try {
          const d = await window.api.get('/tasks/' + encodeURIComponent(t.taskId))
          detail.value = d.task
          events.value = d.events || []
        } catch (e) { toast(e.message, 'error') }
      }
      const cancel = async (t) => {
        try {
          await window.api.post('/tasks/' + encodeURIComponent(t.taskId) + '/cancel')
          toast('已取消任务', 'info')
          detail.value = null
          await load()
        } catch (e) { toast(e.message, 'error') }
      }
      const resume = async (t) => {
        try {
          await window.api.post('/tasks/' + encodeURIComponent(t.taskId) + '/resume')
          toast('已恢复检查点（阶段一不自动重放副作用）', 'info')
          detail.value = null
          await load()
        } catch (e) { toast(e.message, 'error') }
      }
      const phaseCn = (p) => PHASE_CN[p] || p || '-'
      const phaseClass = (p) => PHASE_CLASS[p] || 'p-vio'
      const isTerminal = (p) => ['completed', 'failed', 'cancelled'].includes(p)
      const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

      onMounted(load)

      return { data, loading, phase, PHASES, detail, events, load, open, cancel, resume, phaseCn, phaseClass, isTerminal, fmtTime }
    },
    template: `
    <div>
      <page-head title="任务账本" icon="schedule" desc="可恢复任务记录（P0-3）：任务阶段、事件与检查点。启用后记录每次任务的关键边界；阶段一恢复仅取回检查点，不自动重放副作用">
        <select class="inp" style="width:150px" v-model="phase" @change="load">
          <option v-for="p in PHASES" :key="p" :value="p">{{ p ? (p) : '全部阶段' }}</option>
        </select>
        <button class="btn b-line" @click="load"><v-icon name="refresh"/>刷新</button>
      </page-head>

      <div v-if="!data.enabled" class="card pad" style="text-align:center;padding:40px">
        <v-icon name="schedule" style="font-size:34px;opacity:.5"/>
        <p class="mt12" style="font-weight:600">任务账本未启用</p>
        <p class="mut2" style="font-size:12.5px;margin-top:6px">在「配置中心 → agent.taskStore.enable」开启后，任务会在关键边界落盘为可恢复记录。</p>
      </div>

      <template v-else>
        <div class="grid g3 stagger">
          <div v-for="(t, i) in data.tasks" :key="t.taskId" class="card lift pad" :style="{'--i': i + 1}" @click="open(t)">
            <div class="row-b">
              <span class="pill" :class="phaseClass(t.phase)">{{ phaseCn(t.phase) }}</span>
              <span class="mut2 mono" style="font-size:11px">{{ fmtTime(t.updatedAt) }}</span>
            </div>
            <div class="mono mt12" style="font-size:11.5px;word-break:break-all">{{ t.taskId }}</div>
            <div class="mut2 mt8" style="font-size:12px">
              {{ t.stopReason ? '停止：' + t.stopReason : 'completion：' + (t.completion || '-') }}
              · 事件回合 {{ t.revision }}
            </div>
            <div class="mut2" style="font-size:11px;margin-top:6px">{{ t.scopeKey }}</div>
          </div>
        </div>
        <empty-state v-if="!data.tasks.length && !loading" icon="schedule" text="暂无任务记录"/>
      </template>

      <v-modal v-if="detail" title="任务详情" icon="schedule" @close="detail = null">
        <div class="mono mb12" style="font-size:12px;word-break:break-all">{{ detail.taskId }}</div>
        <div class="row-b mb12">
          <span class="pill" :class="phaseClass(detail.phase)">{{ phaseCn(detail.phase) }}</span>
          <span class="mut2" style="font-size:12px">{{ detail.stopReason || '-' }} · {{ detail.completion || '-' }}</span>
        </div>
        <div class="mut2 mb12" style="font-size:12px">scope：{{ detail.scopeKey }} · 会话游标：{{ detail.sessionCursor }}</div>
        <div class="f-label mb8">事件（{{ events.length }}）</div>
        <div style="max-height:280px;overflow:auto">
          <div v-for="e in events" :key="e.seq" class="mut2" style="font-size:12px;padding:4px 0;border-bottom:1px solid var(--line)">
            <span class="mono">#{{ e.seq }}</span> {{ e.kind }}<span v-if="e.callId"> ({{ e.callId }})</span><span v-if="e.phase"> → {{ e.phase }}</span>
          </div>
        </div>
        <template #foot>
          <button class="btn b-line" @click="detail = null">关闭</button>
          <button v-if="!isTerminal(detail.phase)" class="btn b-line" @click="resume(detail)"><v-icon name="refresh"/>恢复检查点</button>
          <button v-if="!isTerminal(detail.phase)" class="btn" style="background:var(--rose);color:#fff" @click="cancel(detail)"><v-icon name="trash"/>取消任务</button>
        </template>
      </v-modal>
    </div>`,
  }
})()
