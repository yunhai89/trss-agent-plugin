/** 视图:审批门(§3.5 · 纯内存,重启清空) */
(function () {
  window.VIEWS = window.VIEWS || {}

  window.VIEWS.confirm = {
    name: 'ConfirmView',
    setup() {
      const { ref, computed, onMounted, onUnmounted } = Vue
      const { toast, fmt } = window.UI
      const M = window.MOCK
      /* confirmTimeout 来自 config;未加载时取默认 300s */
      const TIMEOUT = computed(() => (M.config?.confirmTimeout || 300) * 1000)

      /* 直接读 MOCK.confirms:侧边栏徽标/概览计数联动更新 */
      const items = computed(() => M.confirms)
      const tick = ref(0)
      const timer = setInterval(() => tick.value++, 1000)
      let pollTimer = null

      /* 读 tick 建立依赖,倒计时环每秒刷新 */
      const remain = (c) => { void tick.value; return Math.max(0, TIMEOUT.value - (Date.now() - c.createdAt)) }
      const remainPct = (c) => (remain(c) / TIMEOUT.value) * 100
      const ringOffset = (c) => 2 * Math.PI * 19 * (1 - remainPct(c) / 100)

      const decide = async (c, ok) => {
        try {
          await window.api.post(`/confirm/${c.id}/decide`, { approve: ok })
          await window.store.loadConfirm()
          toast(ok ? `已批准 ${c.tool}(不真正执行)` : `已拒绝 ${c.tool}`, ok ? 'success' : 'info')
        } catch (e) { toast(e.message, 'error') }
      }

      const danger = (tool) => ['terminal', 'send_like'].includes(tool)

      /* 惰性加载:config(取 confirmTimeout)+ 队列;5s 轮询(后端管超时淘汰) */
      onMounted(async () => {
        try { await window.store.loadConfig() } catch { /* 忽略 */ }
        try { await window.store.loadConfirm() } catch (e) { toast(e.message, 'error') }
        pollTimer = setInterval(() => window.store.loadConfirm().catch(() => {}), 5000)
      })
      onUnmounted(() => { clearInterval(timer); if (pollTimer) clearInterval(pollTimer) })

      return { items, tick, remain, remainPct, ringOffset, decide, danger, fmt, TIMEOUT }
    },
    template: `
    <div>
      <div class="card pad row-b wrap g14" style="--i:0">
        <div class="ct">
          <span class="ct-ico" style="background:var(--grad-honey)"><v-icon name="confirm"/></span>
          <div>
            <div class="ct-t">待审批队列</div>
            <div class="ct-s">纯内存不持久化 · 超时({{ TIMEOUT / 1000 }}s)自动拒绝 · 模拟环境不会真正执行</div>
          </div>
        </div>
        <span class="pill" :class="items.length ? 'p-honey' : 'p-green'" style="font-size:13px;padding:7px 15px">
          {{ items.length ? items.length + ' 条待审批' : '队列已清空' }}
        </span>
      </div>

      <TransitionGroup name="list" tag="div" class="grid g2 mt16" style="position:relative">
        <div v-for="(c, i) in items" :key="c.id" class="card lift pad" :style="{'--i': i + 1}">
          <div class="row g14" style="align-items:flex-start">
            <!-- 倒计时环 -->
            <div class="cd-ring">
              <svg width="46" height="46">
                <circle cx="23" cy="23" r="19" fill="none" stroke="rgba(104,116,186,.16)" stroke-width="5"/>
                <circle cx="23" cy="23" r="19" fill="none" stroke-linecap="round" stroke-width="5"
                  :stroke="remainPct(c) > 40 ? 'var(--mint)' : 'var(--rose)'"
                  :stroke-dasharray="2 * Math.PI * 19" :stroke-dashoffset="ringOffset(c)"
                  style="transition:stroke-dashoffset 1s linear, stroke .5s"/>
              </svg>
              <div class="cd-num num">{{ Math.ceil(remain(c) / 1000) }}</div>
            </div>
            <div style="flex:1;min-width:0">
              <div class="row g6 wrap">
                <span class="pill" :class="danger(c.tool) ? 'p-rose' : 'p-sky'"><v-icon :name="danger(c.tool) ? 'warn' : 'tool'"/>{{ c.tool }}</span>
                <span class="pill p-line mono">#{{ c.id }}</span>
              </div>
              <div class="mut mt8" style="font-size:12px">
                申请人 <b class="mono">{{ c.ctx.user }}</b> · {{ c.ctx.gid ? '群 ' + c.ctx.gid : '私聊' }} · {{ fmt.ago(c.createdAt) }}发起
              </div>
              <div class="mut" style="font-size:12px;margin-top:2px">事由:{{ c.ctx.reason }}</div>
            </div>
          </div>
          <div class="mt12"><json-block :data="c.args"/></div>
          <div class="row g10 mt12" style="justify-content:flex-end">
            <button class="btn b-danger" @click="decide(c, false)"><v-icon name="x"/>拒绝</button>
            <button class="btn b-ok" @click="decide(c, true)"><v-icon name="check"/>批准执行</button>
          </div>
        </div>
      </TransitionGroup>
      <empty-state v-if="!items.length" icon="confirm" text="暂无待审批项" sub="高危工具(terminal 写命令等)发起时会出现在这里"/>
    </div>`,
  }
})()
