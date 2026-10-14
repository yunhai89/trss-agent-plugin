/** 视图:审批门(§3.5 · 工具确认=纯内存重启清空；人设采纳=持久化待审) */
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
      /* 人设资料采纳待审（持久化，须批准才 draft→active） */
      const adoptions = computed(() => (M.personaAdoptions || []).filter((p) => p.status === 'pending'))
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

      /* 人设采纳待审：批准=采纳当前草稿生效；驳回=保留草稿 */
      const decideAdopt = async (a, ok) => {
        try {
          const r = await window.api.post(`/persona-adoptions/${a.id}/${ok ? 'approve' : 'reject'}`, {})
          await window.store.loadPersonaAdoptions()
          const name = a.personaName || a.personaId
          if (ok) toast(r?.ingestError ? `已采纳「${name}」（长尾入库提示：${r.ingestError}）` : `已采纳「${name}」，之后使用该人设以已核实事实为先`)
          else toast(`已驳回「${name}」的采纳请求（草稿保留）`, 'info')
        } catch (e) { toast(e.message, 'error') }
      }

      // 需二次确认的工具里风险最高的几个（terminal 已沙箱化、不再走审批队列）
      const danger = (tool) => ['send_like', 'stagehand', 'stagehand_act'].includes(tool)

      /* 惰性加载:config(取 confirmTimeout)+ 队列;5s 轮询(后端管超时淘汰) */
      onMounted(async () => {
        try { await window.store.loadConfig() } catch { /* 忽略 */ }
        try { await window.store.loadConfirm() } catch (e) { toast(e.message, 'error') }
        try { await window.store.loadPersonaAdoptions() } catch { /* 兼容旧后端：无人设采纳队列 */ }
        pollTimer = setInterval(() => {
          window.store.loadConfirm().catch(() => {})
          window.store.loadPersonaAdoptions().catch(() => {})
        }, 5000)
      })
      onUnmounted(() => { clearInterval(timer); if (pollTimer) clearInterval(pollTimer) })

      return { items, adoptions, tick, remain, remainPct, ringOffset, decide, decideAdopt, danger, fmt, TIMEOUT }
    },
    template: `
    <div>
      <div class="card pad row-b wrap g14" style="--i:0">
        <div class="ct">
          <span class="ct-ico" style="background:var(--grad-honey)"><v-icon name="confirm"/></span>
          <div>
            <div class="ct-t">待审批队列</div>
            <div class="ct-s">工具确认=纯内存不持久化 · 超时({{ TIMEOUT / 1000 }}s)自动拒绝；人设采纳=持久待审 · 须批准才生效</div>
          </div>
        </div>
        <span class="pill" :class="(items.length + adoptions.length) ? 'p-honey' : 'p-green'" style="font-size:13px;padding:7px 15px">
          {{ (items.length + adoptions.length) ? (items.length + adoptions.length) + ' 条待审批' : '队列已清空' }}
        </span>
      </div>

      <!-- 人设资料采纳待审（持久） -->
      <div v-if="adoptions.length" class="card pad" style="margin-top:16px;--i:1">
        <div class="ct" style="margin-bottom:12px">
          <span class="ct-ico" style="background:var(--grad-vio)"><v-icon name="persona"/></span>
          <div>
            <div class="ct-t">人设资料采纳待审</div>
            <div class="ct-s">#采纳补齐 /  Web 采纳 会先进入此队列；批准后草稿才 draft→active 并注入身份层</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div v-for="a in adoptions" :key="a.id" class="card pad lift">
            <div class="row-b wrap g10">
              <div class="row g6 wrap">
                <span class="pill p-vio"><v-icon name="persona"/>{{ a.personaName || a.personaId }}</span>
                <span class="pill p-line mono">#{{ a.id }}</span>
                <span class="pill p-line mono">{{ a.personaId }}</span>
              </div>
              <span class="mut2" style="font-size:11.5px">{{ a.via === 'qq' ? 'QQ' : 'Web' }} 提交 · {{ a.by || '—' }} · {{ fmt.ago(a.createdAt) }}</span>
            </div>
            <div v-if="a.snapshot && a.snapshot.summary" class="mut mt8" style="font-size:13px">{{ a.snapshot.summary }}</div>
            <div v-if="a.snapshot && a.snapshot.facts" class="json-block mt8" style="max-height:180px;overflow:auto;white-space:pre-wrap;font-size:12px">{{ a.snapshot.facts }}</div>
            <div class="mut2 mt8" style="font-size:11.5px">
              出处 {{ a.snapshot?.sourceCount || 0 }} 条 · 长尾 {{ a.snapshot?.rawNotesLen || 0 }} 字（批准后入库供检索）
            </div>
            <div class="row g10 mt12" style="justify-content:flex-end">
              <button class="btn b-danger" @click="decideAdopt(a, false)"><v-icon name="x"/>驳回（保留草稿）</button>
              <button class="btn b-ok" @click="decideAdopt(a, true)"><v-icon name="check"/>批准采纳</button>
            </div>
          </div>
        </div>
      </div>

      <div class="ct" v-if="items.length" style="margin:18px 2px 10px">
        <span class="ct-ico" style="background:var(--grad-honey)"><v-icon name="confirm"/></span>
        <div><div class="ct-t">工具确认</div><div class="ct-s">需二次确认的工具（stagehand act / 定时任务等）</div></div>
      </div>
      <TransitionGroup name="list" tag="div" class="grid g2" :style="{marginTop: items.length ? '0' : '16px', position:'relative'}">
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
      <empty-state v-if="!items.length && !adoptions.length" icon="confirm" text="暂无待审批项" sub="需二次确认的工具（如 stagehand act / 定时任务等）与人设资料采纳（#采纳补齐）发起时会出现在这里；终端命令已改在 E2B 沙箱内直接执行，不走审批"/>
    </div>`,
  }
})()
