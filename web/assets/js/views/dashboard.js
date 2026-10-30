/** 视图:概览（账册朱批 · 首屏 = 抬头 + 三行关键数字 + 今日待批；账目 = 账簿行，点开看明细） */
(function () {
  window.VIEWS = window.VIEWS || {}

  window.VIEWS.dashboard = {
    name: 'DashboardView',
    setup() {
      const { computed, onMounted, ref } = Vue
      const M = window.MOCK
      const fmt = window.UI.fmt
      const { toast } = window.UI

      /* —— 抬头 —— */
      const today = (() => {
        const d = new Date()
        const w = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
        return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${w}`
      })()

      /* —— 三行关键数字 —— */
      const conversations = computed(() => M.counts?.conversations ?? (M.conversations || []).length)
      const adoptions = computed(() => (M.personaAdoptions || []).filter((p) => p.status === 'pending'))
      const pendSug = computed(() => (M.suggestions || []).filter((s) => s.status === 'pending'))
      const pending = computed(() => (M.confirms || []).length + adoptions.value.length + pendSug.value.length)
      const failures = computed(() => M.toolFail ?? 0)
      const sandbox = computed(() => M.config?.sandbox?.mode || 'off')

      /* —— 今日待批：工具确认（内存）+ 人设采纳（持久）+ 进化建议（持久） —— */
      const todo = computed(() => [
        ...(M.confirms || []).map((c) => ({
          key: 'c' + c.id, kind: 'tool', id: c.id,
          name: `工具确认 · ${c.tool}`,
          sub: `${c.ctx?.user || '—'}${c.ctx?.gid ? ' · 群 ' + c.ctx.gid : ' · 私聊'} · ${c.ctx?.reason || '需二次确认'}`,
          act: '批准执行',
        })),
        ...adoptions.value.map((a) => ({
          key: 'a' + a.id, kind: 'persona', id: a.id,
          name: `人设采纳 · ${a.personaName || a.personaId}`,
          sub: `${a.via === 'qq' ? 'QQ' : 'Web'} 提交 · ${a.by || '—'} · ${fmt.ago(a.createdAt)}`,
          act: '批准采纳',
        })),
        ...pendSug.value.map((s) => ({
          key: 's' + s.id, kind: 'suggestion', id: s.id,
          name: `进化建议 · ${s.title || s.kind || '改进项'}`,
          sub: `${s.summary || s.payload || ''}`.slice(0, 72) || '待审改进项',
          act: '采纳建议',
        })),
      ])
      const todoShown = computed(() => todo.value.slice(0, 5))
      const todoRest = computed(() => Math.max(0, todo.value.length - todoShown.value.length))

      const stamping = ref('')
      const approve = async (item) => {
        stamping.value = item.key
        try {
          if (item.kind === 'tool') {
            await window.api.post(`/confirm/${item.id}/decide`, { approve: true })
            await window.store.loadConfirm()
          } else if (item.kind === 'persona') {
            await window.api.post(`/persona-adoptions/${item.id}/approve`, {})
            await window.store.loadPersonaAdoptions()
          } else {
            await window.api.post(`/suggestions/${item.id}/apply`)
            await window.store.loadSuggestions(null, 'pending')
          }
          toast(`已批：${item.name}`, 'success')
        } catch (e) { toast(e.message, 'error') } finally {
          setTimeout(() => { stamping.value = '' }, 420)
        }
      }

      /* —— 账目：Token 消耗趋势（四条缓存线） —— */
      const chart = computed(() => {
        const W = 560, Hgt = 180, PAD = 8
        const trend = M.tokenTrend || []
        const empty = { W, H: Hgt, lineIn: '', lineOut: '', lineHitIn: '', lineHitOut: '', lineMissIn: '', lineMissOut: '', areaIn: '', areaOut: '', days: [], dots: [], single: false, hasCached: false }
        if (!trend.length) return empty
        const hasCached = trend.some((d) => (d.cacheRead || 0) > 0 || (d.cached || 0) > 0 || (d.uncached || 0) > 0)
        for (const d of trend) {
          const read = d.cacheRead ?? d.cached ?? 0
          const obsIn = d.observedInput || (read > 0 ? Math.max(read, d.input || 0) : 0)
          d.hitIn = read
          d.missIn = d.uncached != null ? d.uncached : Math.max(0, (d.input || 0) - read)
          const ratio = obsIn > 0 ? Math.min(1, read / obsIn) : 0
          d.hitOut = Math.round((d.output || 0) * ratio)
          d.missOut = (d.output || 0) - d.hitOut
        }
        const maxV = Math.max(...trend.map((d) => Math.max(d.input + d.output, d.hitIn + d.missIn))) || 1
        const denom = (trend.length - 1) || 1
        const pt = (i, v) => [PAD + (i * (W - PAD * 2)) / denom, Hgt - PAD - (v / maxV) * (Hgt - PAD * 2 - 14)]
        const line = (key) => trend.map((d, i) => pt(i, d[key]).map((n) => n.toFixed(1)).join(',')).join(' ')
        const area = (key) => {
          const pts = trend.map((d, i) => pt(i, d[key]))
          return `M${pts[0][0]},${Hgt - PAD} ` + pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') + ` L${pts[pts.length - 1][0]},${Hgt - PAD} Z`
        }
        const dots = trend.length === 1 ? [{ x: pt(0, 0)[0], yIn: pt(0, trend[0].input)[1], yOut: pt(0, trend[0].output)[1] }] : []
        const rows = [...trend].reverse().map((d) => ({ day: d.day, input: d.input || 0, cached: d.hitIn || 0, miss: d.missIn || 0, output: d.output || 0, hitOut: d.hitOut || 0, missOut: d.missOut || 0 }))
        return { W, H: Hgt, lineIn: line('input'), lineOut: line('output'), lineHitIn: hasCached ? line('hitIn') : '', lineHitOut: hasCached ? line('hitOut') : '', lineMissIn: hasCached ? line('missIn') : '', lineMissOut: hasCached ? line('missOut') : '', areaIn: area('input'), areaOut: area('output'), days: trend.map((d) => d.day), dots, single: trend.length === 1, hasCached, rows }
      })

      /* —— 账目：请求趋势（每日对话轮次） —— */
      const reqChart = computed(() => {
        const W = 560, Hgt = 180, PAD = 8
        const trend = M.requestTrend || []
        if (!trend.length) return { W, H: Hgt, bars: [], days: [], max: 0 }
        const maxV = Math.max(...trend.map((d) => d.count)) || 1
        const slot = (W - PAD * 2) / trend.length
        const bw = Math.max(4, slot - 6)
        const bars = trend.map((d, i) => {
          const h = (d.count / maxV) * (Hgt - PAD * 2 - 14)
          return { x: PAD + i * slot + (slot - bw) / 2, y: Hgt - PAD - h, w: bw, h, count: d.count }
        })
        return { W, H: Hgt, bars, days: trend.map((d) => d.day), max: maxV }
      })

      const toolTop = computed(() => M.toolTop || [])
      const toolMax = computed(() => Math.max(1, ...(M.toolTop || []).map((t) => t.count)))

      const switches = computed(() => {
        const cfg = M.config || {}
        return [
          { name: '声明式记忆', on: cfg.memory?.enable },
          { name: '威胁扫描', on: cfg.memory?.threatScan },
          { name: '工具按需发现', on: cfg.toolDiscovery?.enable },
          { name: '后台自评审', on: cfg.selfReview?.enable },
          { name: '流式输出', on: cfg.stream },
          { name: '多模态', on: cfg.media?.enable },
          { name: '视觉子模型', on: cfg.vision?.enable },
          { name: '终端(E2B 沙箱)', on: cfg.sandbox?.mode === 'e2b', danger: true },
        ]
      })

      const perceptions = computed(() => M.perceptions || [])
      const totalTokens = computed(() => (M.tokenTrend || []).reduce((s, d) => s + d.input + d.output, 0))

      /* 缓存统计（完整 Agent 流口径；未观测旧日志不进分母） */
      const win = Vue.ref('7d')
      /* 第 6 轮审计：账目行文案原先写死「近 7 日」，切到 1h/24h/new/all 后与数据窗口不符 */
      const winLabel = computed(() => ({ '1h': '近 1 小时', '24h': '近 24 小时', '7d': '近 7 日', 'new': '部署后', 'all': '全部时间' }[win.value] || '近 7 日'))
      const cacheStats = computed(() => {
        const c = M.cache || null
        if (c) {
          const pct = (v) => (v == null ? null : Math.max(0, Math.min(100, v * 100)))
          const hitRate = pct(c.tokenHitRate)
          return {
            input: c.observedInput || 0, output: c.observedOutput || 0, cached: c.totalCacheRead || 0,
            cacheWrite: c.totalCacheWrite || 0, miss: Math.max(0, (c.observedInput || 0) - (c.totalCacheRead || 0)),
            hitRate, missRate: hitRate == null ? 0 : 100 - hitRate, requestHitRate: pct(c.requestHitRate), warmHitRate: pct(c.warmRequestHitRate),
            warmTokenHitRate: pct(c.warmTokenHitRate),
            unobserved: c.unobservedRequests || 0, observedReq: c.observedRequests || 0,
            warmObserved: c.warmObserved || 0, warmHit: c.warmHit || 0, coldObserved: c.coldObserved || 0,
            hasData: (c.observedRequests || 0) > 0, hasRequestRate: c.requestHitRate != null,
          }
        }
        const t = M.tokenTrend || []
        const input = t.reduce((s, d) => s + (d.input || 0), 0)
        const output = t.reduce((s, d) => s + (d.output || 0), 0)
        const cached = t.reduce((s, d) => s + (d.cached || 0), 0)
        const hitRate = input > 0 ? (cached / input) * 100 : 0
        return { input, output, cached, cacheWrite: 0, miss: Math.max(0, input - cached), hitRate, missRate: input > 0 ? 100 - hitRate : 0, hasData: input > 0, hasRequestRate: false, unobserved: 0 }
      })
      const setWin = async (w) => {
        win.value = w
        try { await window.store.loadOverview({ window: w }) } catch { /* 忽略 */ }
      }
      /* 清空 Token 缓存命中统计：数据源有两处（Redis 日统计 + devLog 日志），后端一次清两处并
         失效 overview 聚合缓存，前端随后重载 —— 可见结果 = 命中率/趋势/工具统计全部归零。
         危险动作，先过确认弹窗（说明口径，避免误清日志）。 */
      const clearing = ref(false)
      const clearCache = async () => {
        const ask = await window.UI.confirm({
          title: '清空 Token 缓存统计',
          icon: 'warn',
          danger: true,
          confirmText: '清空统计',
          message: '将清空 <b>全部 Token 缓存命中数据</b>：Redis 日统计 + 会话日志（devLog）文件。<br>'
            + '影响：概览的命中率、Token 趋势、工具统计从零重新累计；<b>日志时间线</b>同时清空。<br>'
            + '不受影响：记忆 / 人设 / 会话 / 定时 / 配置。此操作不可恢复。',
        })
        if (!ask) return
        clearing.value = true
        try {
          const r = await window.api.post('/cache/clear', {})
          M.cache = null // 先清本地缓存载荷：避免重载间隙仍显示旧命中率
          await window.store.loadOverview({ window: win.value })
          toast(`已清空：日统计 ${r?.kvRemoved ?? 0} 天 · 日志 ${r?.logsRemoved ?? 0} 个文件`, 'success')
        } catch (e) { toast(e.message, 'error') } finally { clearing.value = false }
      }

      /* —— 账目行（账簿语法：序号 + 名称 + 右列数值；点开看明细） —— */
      const open = ref('')
      const toggle = (id) => { open.value = open.value === id ? '' : id }
      const books = computed(() => [
        {
          id: 'token', name: 'Token 消耗', unit: 'tokens',
          sub: `${winLabel.value} · ${M.statsSource === 'kv' ? '按 Redis 日统计聚合（本地时区）' : '按 devLog 聚合（过渡，产生对话后切 Redis）'}`,
          value: fmt.num(totalTokens.value),
        },
        {
          id: 'tool', name: '工具调用', unit: '次',
          sub: `${winLabel.value} · 成功率 ${M.toolSuccessRate != null ? (M.toolSuccessRate * 100).toFixed(1) + '%' : '暂无'}`,
          value: fmt.num(M.totalToolCalls || 0),
        },
        {
          id: 'cache', name: 'Token 缓存', unit: '命中率',
          sub: '未观测旧日志不进命中率 · cold/warm 分层',
          value: cacheStats.value.hitRate != null ? cacheStats.value.hitRate.toFixed(1) + '%' : '—',
        },
        {
          id: 'req', name: '请求', unit: '次',
          sub: `${winLabel.value} · 每日对话轮次（devLog run_end 计数）`,
          value: fmt.num(M.totalRequests || 0),
        },
        {
          id: 'recall', name: '长期记忆', unit: '条',
          sub: `上限 ${M.config?.recall?.cap || '—'} 条/用户 · 抽取每 ${M.config?.recall?.extractEvery || '—'} 轮`,
          value: fmt.num(Object.values(M.recall || {}).flat().length),
        },
        {
          id: 'switch', name: '功能开关', unit: 'ON',
          sub: '当前生效配置一览（只读，修改请前往配置中心）',
          value: `${switches.value.filter((s) => s.on).length}/${switches.value.length}`,
        },
        {
          id: 'percept', name: '群情境', unit: '个群',
          sub: 'perception:met / last_active',
          value: fmt.num(perceptions.value.length),
        },
      ])

      /* 惰性加载：概览聚合 + 配置（开关速览）+ 三类待批队列 */
      onMounted(async () => {
        try { await window.store.loadOverview() } catch { /* 未就绪,忽略 */ }
        try { await window.store.loadConfig() } catch { /* 忽略 */ }
        try { await window.store.loadConfirm() } catch { /* 忽略 */ }
        try { await window.store.loadPersonaAdoptions() } catch { /* 兼容旧后端：无人设采纳队列 */ }
        try { await window.store.loadSuggestions(null, 'pending') } catch { /* 忽略 */ }
      })

      return { today, conversations, pending, failures, sandbox, todo, todoShown, todoRest, stamping, approve, chart, reqChart, toolTop, toolMax, switches, perceptions, totalTokens, cacheStats, win, setWin, clearCache, clearing, books, open, toggle, fmt, M }
    },
    template: `
    <div class="lg">
      <!-- 抬头 -->
      <header class="lg-head">
        <div class="lg-date">{{ today }}</div>
        <div class="lg-title">agents-plugin <span class="grad-t">管理面板</span></div>
        <div class="lg-sub">
          多模型对话 · 工具调用 · 长期记忆 · 人设 · 多模态 · MCP · 沙箱。近 7 日累计消耗
          <b class="mono num">{{ fmt.num(totalTokens) }}</b> tokens。
        </div>
        <div class="lg-seal">账</div>
      </header>

      <!-- 三行关键数字 -->
      <div class="lg-tally">
        <div>
          <span class="k">活跃对话</span>
          <span class="v">{{ fmt.num(conversations) }}</span>
          <span class="q">群聊 / 私聊会话</span>
        </div>
        <div>
          <span class="k">待审批</span>
          <span class="v" :class="{ c: pending > 0 }">{{ fmt.num(pending) }}</span>
          <span class="q">工具 · 人设 · 建议</span>
        </div>
        <div>
          <span class="k">异常</span>
          <span class="v" :class="{ c: failures > 0 }">{{ fmt.num(failures) }}</span>
          <span class="q">近 7 日工具失败</span>
        </div>
      </div>

      <!-- 今日待批 -->
      <section>
        <div class="lg-sec-h">
          <h2>今日待批</h2>
          <span class="lg-rule"></span>
          <span class="lg-seal sm">批</span>
        </div>
        <div class="lg-rx">
          <div v-for="(t, i) in todoShown" :key="t.key" class="lg-row">
            <span class="lg-no">{{ i + 1 }}</span>
            <div class="lg-t">
              <div class="name">{{ t.name }}</div>
              <div class="sub">{{ t.sub }}</div>
            </div>
            <button class="lg-approve" :class="{ stamped: stamping === t.key }"
              :title="t.act" :aria-label="t.act" :disabled="!!stamping" @click="approve(t)">批</button>
          </div>
          <div v-if="!todo.length" class="lg-empty">
            <v-icon name="check"/>今日无事：没有在等你定的事
          </div>
          <div v-else-if="todoRest" class="lg-empty">
            <v-icon name="info"/>还有 {{ todoRest }} 条 → 去
            <a href="#/confirm">审批门</a> 或 <a href="#/suggestions">进化建议</a>
          </div>
        </div>
      </section>

      <!-- 脚注 -->
      <div class="lg-foot">
        <span>E2B 沙箱 <b class="mono">{{ sandbox }}</b>（连不上即拒绝执行，绝不回退宿主）</span>
        <span class="mono">#agent登录 · 24h 滑动续期</span>
      </div>

      <!-- 账目（账簿行：点开看明细） -->
      <div class="lg-book-h">
        <h2>账目</h2>
        <span class="lg-rule"></span>
      </div>

      <div class="lg-rx">
        <div v-for="(b, i) in books" :key="b.id" class="lg-acc">
          <button type="button" class="lg-arow" :class="{ open: open === b.id }" :aria-expanded="open === b.id" @click="toggle(b.id)">
            <span class="lg-no">{{ i + 1 }}</span>
            <span class="lg-t">
              <span class="name">{{ b.name }}</span>
              <span class="sub">{{ b.sub }}</span>
            </span>
            <span class="lg-aval">{{ b.value }}<span class="u2">{{ b.unit }}</span></span>
            <svg class="lg-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
          </button>

          <Transition name="expand">
            <div v-if="open === b.id" class="lg-abody">
              <!-- Token 消耗明细 -->
              <template v-if="b.id === 'token'">
                <div class="row g14 wrap" style="font-size:12px">
                  <span class="row g6"><i style="width:10px;height:10px;border-radius:2px;background:var(--ch-in)"></i>输入</span>
                  <span class="row g6"><i style="width:10px;height:10px;border-radius:2px;background:var(--ch-out)"></i>输出</span>
                  <span v-if="chart.hasCached" class="row g6"><i style="width:10px;height:10px;border-radius:2px;background:var(--ch-hit-in)"></i>命中·输入</span>
                  <span v-if="chart.hasCached" class="row g6"><i style="width:10px;height:10px;border-radius:2px;background:var(--ch-hit-out)"></i>命中·输出</span>
                  <span v-if="chart.hasCached" class="row g6"><i style="width:10px;height:10px;border-radius:2px;background:var(--ch-miss-in)"></i>未命中·输入</span>
                  <span v-if="chart.hasCached" class="row g6"><i style="width:10px;height:10px;border-radius:2px;background:var(--ch-miss-out)"></i>未命中·输出</span>
                </div>
                <svg v-if="chart.lineIn" :viewBox="'0 0 ' + chart.W + ' ' + chart.H" style="width:100%;margin-top:12px;display:block">
                  <defs>
                    <linearGradient id="agIn" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" style="stop-color:var(--ch-in);stop-opacity:.22"/><stop offset="100%" style="stop-color:var(--ch-in);stop-opacity:0"/>
                    </linearGradient>
                    <linearGradient id="agOut" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" style="stop-color:var(--ch-out);stop-opacity:.2"/><stop offset="100%" style="stop-color:var(--ch-out);stop-opacity:0"/>
                    </linearGradient>
                  </defs>
                  <path :d="chart.areaIn" fill="url(#agIn)"/>
                  <path :d="chart.areaOut" fill="url(#agOut)"/>
                  <polyline :points="chart.lineIn" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
                    pathLength="1" style="stroke:var(--ch-in);stroke-dasharray:1;stroke-dashoffset:1;animation:dashIn 1.2s .15s var(--eo) forwards"/>
                  <polyline :points="chart.lineOut" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
                    pathLength="1" style="stroke:var(--ch-out);stroke-dasharray:1;stroke-dashoffset:1;animation:dashIn 1.2s .35s var(--eo) forwards"/>
                  <polyline v-if="chart.lineHitIn" :points="chart.lineHitIn" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
                    style="stroke:var(--ch-hit-in)" stroke-dasharray="10 5"/>
                  <polyline v-if="chart.lineHitOut" :points="chart.lineHitOut" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
                    style="stroke:var(--ch-hit-out)" stroke-dasharray="4 4"/>
                  <polyline v-if="chart.lineMissIn" :points="chart.lineMissIn" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
                    style="stroke:var(--ch-miss-in)" stroke-dasharray="2 3"/>
                  <polyline v-if="chart.lineMissOut" :points="chart.lineMissOut" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
                    style="stroke:var(--ch-miss-out)" stroke-dasharray="1 4"/>
                  <template v-if="chart.single && chart.dots.length">
                    <circle :cx="chart.dots[0].x" :cy="chart.dots[0].yIn" r="3.5" style="fill:var(--ch-in)"/>
                    <circle :cx="chart.dots[0].x" :cy="chart.dots[0].yOut" r="3.5" style="fill:var(--ch-out)"/>
                  </template>
                </svg>
                <div v-if="chart.lineIn" class="row-b" style="padding:0 6px;font-size:12px;color:var(--ink2)">
                  <span v-for="d in chart.days" :key="d">{{ d }}</span>
                </div>
                <div v-if="chart.rows && chart.rows.length" class="mt12" style="max-height:180px;overflow:auto;border-top:1px dashed var(--line2)">
                  <table style="width:100%;border-collapse:collapse;font-size:12px" class="mono">
                    <thead><tr style="color:var(--ink2);text-align:right">
                      <th style="text-align:left;padding:6px 8px;font-weight:600">日期</th>
                      <th style="padding:6px;color:var(--ch-in)">输入</th>
                      <th v-if="chart.hasCached" style="padding:6px;color:var(--ch-hit-in)">命中·输入</th>
                      <th v-if="chart.hasCached" style="padding:6px;color:var(--ch-miss-in)">未命中·输入</th>
                      <th style="padding:6px;color:var(--ch-out)">输出</th>
                      <th v-if="chart.hasCached" style="padding:6px;color:var(--ch-hit-out)">命中·输出</th>
                      <th v-if="chart.hasCached" style="padding:6px;color:var(--ch-miss-out)">未命中·输出</th>
                    </tr></thead>
                    <tbody>
                      <tr v-for="r in chart.rows" :key="r.day" style="text-align:right;border-top:1px solid var(--line)">
                        <td style="text-align:left;padding:5px 8px;color:var(--ink2)">{{ r.day }}</td>
                        <td style="padding:5px 6px">{{ fmt.num(r.input) }}</td>
                        <td v-if="chart.hasCached" style="padding:5px 6px">{{ fmt.num(r.cached) }}</td>
                        <td v-if="chart.hasCached" style="padding:5px 6px">{{ fmt.num(r.miss) }}</td>
                        <td style="padding:5px 6px">{{ fmt.num(r.output) }}</td>
                        <td v-if="chart.hasCached" style="padding:5px 6px">{{ fmt.num(r.hitOut) }}</td>
                        <td v-if="chart.hasCached" style="padding:5px 6px">{{ fmt.num(r.missOut) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div v-else style="padding:20px 8px;text-align:center;color:var(--ink2);font-size:13px">暂无数据：产生对话（@机器人 / #ai）后自动统计</div>
              </template>

              <!-- 工具调用明细 -->
              <template v-else-if="b.id === 'tool'">
                <div v-if="M.statsSource === 'kv'" class="row g6 wrap" style="font-size:12px">
                  <span class="pill p-sky">成功 {{ M.toolOk ?? 0 }}</span>
                  <span class="pill p-honey">失败 {{ M.toolFail ?? 0 }}</span>
                  <span class="pill p-sky">成功率 {{ M.toolSuccessRate != null ? (M.toolSuccessRate * 100).toFixed(1) + '%' : '暂无' }}</span>
                </div>
                <div v-if="toolTop.length" class="mt12" style="display:flex;flex-direction:column;gap:12px">
                  <div v-for="t in toolTop" :key="t.name">
                    <div class="row-b" style="font-size:12.5px;margin-bottom:5px">
                      <span class="mono" style="font-weight:700">{{ t.name }}</span>
                      <span class="mut num">{{ t.count }} 次<template v-if="t.rate != null"> · <span :style="{color: t.rate >= 0.9 ? 'var(--mint)' : 'var(--honey)'}">{{ (t.rate * 100).toFixed(0) }}%</span><span class="mut2">（{{ t.ok }}/{{ t.count }}）</span></template></span>
                    </div>
                    <div class="meter"><i :style="{width: (t.count / toolMax * 100) + '%'}"></i></div>
                  </div>
                </div>
                <div v-else style="padding:20px 8px;text-align:center;color:var(--ink2);font-size:13px">暂无数据：产生对话后自动统计</div>
              </template>

              <!-- Token 缓存明细 -->
              <template v-else-if="b.id === 'cache'">
                <div class="row-b wrap g10">
                  <span class="mut2" style="font-size:12px">观测窗口</span>
                  <button type="button" class="btn b-danger b-sm" :disabled="clearing" @click="clearCache">
                    <v-icon name="trash"/>{{ clearing ? '清空中…' : '清空统计' }}
                  </button>
                </div>
                <div class="row g6" style="font-size:11.5px;margin-top:10px">
                  <button v-for="w in ['1h','24h','7d','new','all']" :key="w" class="btn" :class="win===w?'b-pri':'b-line'" style="padding:4px 9px;font-size:11.5px" @click="setWin(w)">{{ w==='new'?'部署后':(w==='all'?'全部':w) }}</button>
                </div>
                <template v-if="cacheStats.hasData">
                  <div class="row g10 wrap" style="margin-top:10px;font-size:12px">
                    <span class="pill p-honey">请求命中率 {{ cacheStats.requestHitRate != null ? cacheStats.requestHitRate.toFixed(1) + '%' : '暂无' }}</span>
                    <span class="pill p-mint">Token 命中率 {{ cacheStats.hitRate != null ? cacheStats.hitRate.toFixed(1) + '%' : '暂无' }}</span>
                    <span v-if="cacheStats.warmTokenHitRate != null" class="pill p-mint">warm Token 命中率 {{ cacheStats.warmTokenHitRate.toFixed(1) }}%（剔除每个会话首个请求，即多轮对话的稳态命中率）</span>
                    <span v-if="cacheStats.warmHitRate != null" class="pill p-sky">warm 请求命中率 {{ cacheStats.warmHitRate.toFixed(1) }}%（{{ cacheStats.warmHit }}/{{ cacheStats.warmObserved }}）</span>
                    <span class="pill">cold {{ cacheStats.coldObserved }}</span>
                    <span v-if="cacheStats.unobserved > 0" class="pill" style="opacity:.75">未观测旧日志 {{ cacheStats.unobserved }} 条（不进分母）</span>
                  </div>
                  <div class="mt12" style="display:flex;flex-direction:column;gap:14px">
                    <div>
                      <div class="row-b" style="font-size:12.5px;margin-bottom:6px">
                        <span style="font-weight:700;color:var(--ch-in)">输入 tokens</span>
                        <span class="num" style="font-weight:700">{{ fmt.num(cacheStats.input) }}</span>
                      </div>
                      <div class="row g6 wrap" style="margin-bottom:6px;font-size:11.5px">
                        <span style="color:var(--ch-hit-in)">缓存读取 {{ fmt.num(cacheStats.cached) }}（{{ cacheStats.hitRate != null ? cacheStats.hitRate.toFixed(1) : '?' }}%）</span>
                        <span style="color:var(--ch-miss-in)">未缓存输入 {{ fmt.num(cacheStats.miss) }}</span>
                        <span v-if="cacheStats.cacheWrite > 0" style="color:var(--ink2)">缓存写入 {{ fmt.num(cacheStats.cacheWrite) }}</span>
                      </div>
                      <div style="display:flex;height:10px;border-radius:2px;overflow:hidden;background:var(--well);border:1px solid var(--line)">
                        <i :style="{width: cacheStats.hitRate + '%', background: 'var(--ch-hit-in)'}"></i>
                        <i :style="{width: cacheStats.missRate + '%', background: 'var(--ch-miss-in)'}"></i>
                      </div>
                    </div>
                    <div>
                      <div class="row-b" style="font-size:12.5px;margin-bottom:6px">
                        <span style="font-weight:700;color:var(--ch-out)">输出 tokens</span>
                        <span class="num" style="font-weight:700">{{ fmt.num(cacheStats.output) }}</span>
                      </div>
                      <div class="meter"><i :style="{width: '100%', background: 'var(--ch-out)'}"></i></div>
                      <div style="font-size:11.5px;color:var(--ink3);margin-top:5px">输出生成不走前缀缓存，按全价计；缓存写入为 Anthropic cache_creation / OpenAI cache_write</div>
                    </div>
                    <div class="row-b" style="font-size:12px;padding-top:10px;border-top:1px dashed var(--line2)">
                      <span style="color:var(--ink2)">合计</span>
                      <span class="num" style="font-weight:700">{{ fmt.num(cacheStats.input + cacheStats.output) }} tokens</span>
                    </div>
                  </div>
                </template>
                <div v-else style="padding:20px 8px;text-align:center;color:var(--ink2);font-size:13px">暂无缓存数据：产生对话后自动统计（旧日志无缓存字段时仅显示趋势线）</div>
              </template>

              <!-- 请求明细 -->
              <template v-else-if="b.id === 'req'">
                <div class="row-b" style="font-size:12px;color:var(--ink2)">
                  <span>每日对话轮次</span>
                  <span class="pill p-pri">峰值 {{ reqChart.max }} / 日</span>
                </div>
                <svg v-if="reqChart.bars.length" :viewBox="'0 0 ' + reqChart.W + ' ' + reqChart.H" style="width:100%;margin-top:12px;display:block">
                  <rect v-for="(bar, i) in reqChart.bars" :key="i" :x="bar.x" :y="bar.y" :width="bar.w" :height="bar.h" rx="2" style="fill:var(--ch-in)">
                    <title>{{ bar.count }} 次</title>
                  </rect>
                </svg>
                <div v-if="reqChart.bars.length" class="row-b" style="padding:0 6px;font-size:12px;color:var(--ink2)">
                  <span v-for="d in reqChart.days" :key="d">{{ d }}</span>
                </div>
                <div v-else style="padding:20px 8px;text-align:center;color:var(--ink2);font-size:13px">暂无数据：产生对话（@机器人 / #ai）后自动统计</div>
              </template>

              <!-- 长期记忆 -->
              <template v-else-if="b.id === 'recall'">
                <div style="font-size:12.5px;color:var(--ink2)">
                  文件即真相：MEMORY.md / USER.md 人可读可编辑；LLM 抽取沉淀后按 scope 隔离。
                  明细见 <a href="#/recall">长期记忆</a> 与 <a href="#/memory">声明式记忆</a>。
                </div>
              </template>

              <!-- 功能开关 -->
              <template v-else-if="b.id === 'switch'">
                <div class="grid g4" style="gap:10px">
                  <div v-for="s in switches" :key="s.name" class="row-b"
                    style="padding:9px 12px;border-radius:6px;background:var(--paper);border:1px solid var(--line);font-size:12.5px;font-weight:700">
                    <span>{{ s.name }}</span>
                    <span class="pill" :class="s.on ? (s.danger ? 'p-rose' : 'p-green') : ''" style="font-size:11.5px;padding:3px 9px">
                      {{ s.on ? 'ON' : 'OFF' }}
                    </span>
                  </div>
                </div>
              </template>

              <!-- 群情境 -->
              <template v-else-if="b.id === 'percept'">
                <div style="display:flex;flex-direction:column;gap:10px">
                  <div v-for="p in perceptions" :key="p.groupId" class="row-b"
                    style="padding:10px 14px;border-radius:6px;background:var(--paper);border:1px solid var(--line)">
                    <div>
                      <div class="mono" style="font-weight:700;font-size:13px">群 {{ p.groupId }}</div>
                      <div class="mut2" style="font-size:11.5px">入群 {{ fmt.ago(p.met.at) }}</div>
                    </div>
                    <span class="pill" :class="(Date.now() - p.lastActive.at) > 6*3600e3 ? 'p-honey' : 'p-green'">
                      {{ (Date.now() - p.lastActive.at) > 6*3600e3 ? '久离 ' : '活跃 ' }}{{ fmt.ago(p.lastActive.at) }}
                    </span>
                  </div>
                  <empty-state v-if="!perceptions.length" icon="group" text="暂无群感知数据"/>
                </div>
              </template>
            </div>
          </Transition>
        </div>
      </div>
    </div>`,
  }
})()
