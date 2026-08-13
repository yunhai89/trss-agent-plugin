/** 视图:定时任务（一次性提醒 + cron 重复任务链） */
;(function () {
  window.VIEWS = window.VIEWS || {}

  window.VIEWS.schedule = {
    name: 'ScheduleView',
    setup() {
      const { ref, computed, onMounted, onUnmounted } = Vue
      const { toast, fmt } = window.UI
      const M = window.MOCK

      const tick = ref(0)
      const timer = setInterval(() => tick.value++, 1000)

      const jobs = computed(() => (M.schedules || []).slice().sort((a, b) => {
        // task(cron) 排前按 createdAt；reminder 按 at
        if (a.type === 'task' && b.type !== 'task') return -1
        if (a.type !== 'task' && b.type === 'task') return 1
        if (a.type === 'task') return (a.createdAt || 0) - (b.createdAt || 0)
        return (a.at || 0) - (b.at || 0)
      }))
      const until = (ts) => { void tick.value; return fmt.until(ts) }
      const del = async (j) => {
        try {
          await window.api.del(`/schedule/${j.id}`)
          await window.store.loadSchedule()
          toast('已取消该任务', 'info')
        } catch (e) { toast(e.message, 'error') }
      }

      const addModal = ref({ show: false, type: 'reminder', message: '', groupId: '', inHours: 2, when: '', prompt: '' })
      const add = async () => {
        const m = addModal.value
        const body = { userId: window.MOCK.config?.masters?.[0] || 'master', groupId: m.groupId || null }
        if (m.type === 'task') {
          if (!m.when.trim() || !m.prompt.trim()) { toast('任务链需时间 + 任务描述', 'warn'); return }
          body.type = 'task'; body.when = m.when.trim(); body.prompt = m.prompt.trim()
        } else {
          if (!m.message.trim()) { toast('请填写提醒内容', 'warn'); return }
          body.message = m.message.trim(); body.at = Date.now() + m.inHours * 3600e3
        }
        try {
          await window.api.post('/schedule', body)
          await window.store.loadSchedule()
          toast(m.type === 'task' ? '定时任务已创建（到点跑 Agent + 发结果）' : '提醒已创建')
          addModal.value.show = false
          addModal.value.message = ''; addModal.value.when = ''; addModal.value.prompt = ''
        } catch (e) { toast(e.message, 'error') }
      }

      onMounted(async () => { try { await window.store.loadSchedule() } catch (e) { toast(e.message, 'error') } })
      onUnmounted(() => clearInterval(timer))

      return { jobs, tick, until, del, addModal, add, fmt }
    },
    template: `
    <div>
      <page-head title="定时任务" icon="schedule" desc="一次性提醒（到点发静态消息）+ cron 重复任务链（到点跑 Agent + 发结果）。时间支持自然语言：每天8点 / 每2小时 / 工作日9点">
        <button class="btn b-pri" @click="addModal.show = true"><v-icon name="plus"/>新建任务</button>
      </page-head>

      <div class="grid g3 stagger">
        <div v-for="(j, i) in jobs" :key="j.id" class="card lift pad" :style="{'--i': i + 1}">
          <div class="row-b">
            <span class="pill" :class="j.type === 'task' ? 'p-green' : (j.groupId ? 'p-sky' : 'p-vio')">
              <v-icon :name="j.type === 'task' ? 'tool' : (j.groupId ? 'group' : 'user')"/>{{ j.type === 'task' ? '任务链' : (j.groupId ? '群 ' + j.groupId : '私聊') }}
            </span>
            <button class="bic dg" @click="del(j)"><v-icon name="trash"/></button>
          </div>
          <template v-if="j.type === 'task'">
            <div class="mono mt12" style="font-size:12px;color:var(--mint)">⏱ {{ j.cron }}</div>
            <p class="mt8" style="font-size:13.5px;font-weight:600;line-height:1.7;min-height:44px">{{ j.prompt }}</p>
          </template>
          <template v-else>
            <p class="mt12" style="font-size:13.5px;font-weight:600;line-height:1.7;min-height:44px">{{ j.message }}</p>
            <div class="hr" style="margin:12px 0"></div>
            <div class="grad-t num" style="font-weight:800;font-size:20px">{{ until(j.at) }}</div>
            <div class="mut2" style="font-size:11px;margin-top:2px">{{ new Date(j.at).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) }} 触发</div>
          </template>
          <div class="mut2" style="font-size:11px;text-align:right;margin-top:8px">bot {{ j.selfId || '?' }} · #{{ j.id }}</div>
        </div>
      </div>
      <empty-state v-if="!jobs.length" icon="schedule" text="暂无定时任务"/>

      <v-modal v-if="addModal.show" title="新建定时任务" icon="plus" @close="addModal.show = false">
        <div class="seg mb12">
          <button :class="{on: addModal.type==='reminder'}" @click="addModal.type='reminder'">一次性提醒</button>
          <button :class="{on: addModal.type==='task'}" @click="addModal.type='task'">cron 重复任务</button>
        </div>
        <div class="field mb12">
          <label class="f-label">目标群（留空=私聊）</label>
          <input class="inp" v-model="addModal.groupId" placeholder="群号">
        </div>
        <template v-if="addModal.type==='task'">
          <div class="field mb12">
            <label class="f-label">时间（自然语言）</label>
            <input class="inp" v-model="addModal.when" placeholder="每天8点 / 每2小时 / 工作日9点 / 每周一8点30 / 每30分钟">
          </div>
          <div class="field">
            <label class="f-label">任务描述（到点 Agent 执行 + 发结果）</label>
            <textarea class="txa" v-model="addModal.prompt" placeholder="如：搜索今日AI资讯并总结5条"></textarea>
          </div>
        </template>
        <template v-else>
          <div class="field mb12">
            <label class="f-label">提醒内容</label>
            <textarea class="txa" v-model="addModal.message" placeholder="到点发送的文本"></textarea>
          </div>
          <div class="field">
            <label class="f-label">N 小时后触发</label>
            <input type="number" class="inp" min="1" v-model.number="addModal.inHours">
          </div>
        </template>
        <template #foot>
          <button class="btn b-line" @click="addModal.show = false">取消</button>
          <button class="btn b-pri" @click="add"><v-icon name="check"/>创建</button>
        </template>
      </v-modal>
    </div>`,
  }
})()
