/** 视图:概览 Dashboard */
(function () {
  window.VIEWS = window.VIEWS || {}

  window.VIEWS.dashboard = {
    name: 'DashboardView',
    setup() {
      const { computed, onMounted } = Vue
      const M = window.MOCK
      const fmt = window.UI.fmt

      const stats = computed(() => {
        const cfg = M.config || {}
        return [
          {
            icon: 'cpu', grad: 'var(--grad)', label: '主模型', value: cfg.model || '—',
            sub: `${cfg.preset || '—'} · ${cfg.protocol || '—'}`,
          },
          {
            icon: 'recall', grad: 'var(--grad-mint)', label: '长期记忆条目', value: Object.values(M.recall || {}).flat().length,
            sub: `上限 ${cfg.recall?.cap || '—'} 条/用户 · 抽取每 ${cfg.recall?.extractEvery || '—'} 轮`, count: true,
          },
          {
            icon: 'session', grad: 'var(--grad-sky)', label: '活跃对话', value: M.counts?.conversations ?? 0,
            sub: '群聊/私聊会话总数', count: true,
          },
          {
            icon: 'confirm', grad: 'var(--grad-honey)', label: '待审批 / 待审建议', value: (M.confirms || []).length + (M.suggestions || []).filter((s) => s.status === 'pending').length,
            sub: '审批为纯内存,重启清空', count: true,
          },
          {
            icon: 'zap', grad: 'var(--grad-rose)', label: '近 7 日请求', value: M.totalRequests || 0,
            sub: '对话轮次 (run_end 聚合)', count: true,
          },
          {
            icon: 'tool', grad: 'var(--grad-vio)', label: '工具调用次数', value: M.totalToolCalls || 0,
            sub: '近 7 日累计', count: true,
          },
        ]
      })

      /* Token 面积图(SVG 手绘) —— computed 依赖 M.tokenTrend,loadOverview 后重算。
       * 注意 trend.length===1 时不能除以 (length-1)=0 → 用 denom=(length-1)||1 兜底，单点补圆点 */
      const chart = computed(() => {
        const W = 560, Hgt = 180, PAD = 8
        const trend = M.tokenTrend || []
        const empty = { W, H: Hgt, lineIn: '', lineOut: '', lineHitIn: '', lineHitOut: '', lineMissIn: '', lineMissOut: '', areaIn: '', areaOut: '', days: [], dots: [], single: false, hasCached: false }
        if (!trend.length) return empty
        const hasCached = trend.some((d) => (d.cacheRead || 0) > 0 || (d.cached || 0) > 0 || (d.uncached || 0) > 0)
        // 四条缓存线（命中/未命中 × 输入/输出）：
        //   命中输入 = cacheRead；未命中输入 = uncached（后端未回填时用 input-cacheRead 钳 0）
        //   输出按该日命中输入占比线性拆分 hitOut/missOut（输出生成本身不走前缀缓存，此处是成本归因视角）
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
        const dots = trend.length === 1 ? [{ x: pt(0, 0)[0], yIn: pt(0, trend[0].input)[1], yOut: pt(0, trend[0].output)[1], yHitIn: hasCached ? pt(0, trend[0].hitIn || 0)[1] : null, yHitOut: hasCached ? pt(0, trend[0].hitOut || 0)[1] : null, yMissIn: hasCached ? pt(0, trend[0].missIn || 0)[1] : null, yMissOut: hasCached ? pt(0, trend[0].missOut || 0)[1] : null }] : []
        // 每日数值表（图旁 tokens 明细，与折线同序；天多时倒序显示最新在前）
        const rows = [...trend].reverse().map((d) => ({ day: d.day, input: d.input || 0, cached: d.hitIn || 0, miss: d.missIn || 0, output: d.output || 0, hitOut: d.hitOut || 0, missOut: d.missOut || 0 }))
        return { W, H: Hgt, lineIn: line('input'), lineOut: line('output'), lineHitIn: hasCached ? line('hitIn') : '', lineHitOut: hasCached ? line('hitOut') : '', lineMissIn: hasCached ? line('missIn') : '', lineMissOut: hasCached ? line('missOut') : '', areaIn: area('input'), areaOut: area('output'), days: trend.map((d) => d.day), dots, single: trend.length === 1, hasCached, rows }
      })

      /* 请求趋势柱状图（每日对话轮次 = run_end 计数） */
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
          { name: '终端(高危)', on: cfg.terminal?.enable, danger: true },
        ]
      })

      const perceptions = computed(() => M.perceptions || [])
      const totalTokens = computed(() => (M.tokenTrend || []).reduce((s, d) => s + d.input + d.output, 0))
      /* 缓存统计（独立卡）。口径 = 一整个完整 Agent 流累计（后端 normalizeUsage/mergeUsage），
       * 观测分母：未观测旧日志不进命中率；cold/warm 分层（warm 命中率才是改造真实效果） */
      const win = Vue.ref('7d')
      const cacheStats = computed(() => {
        const c = M.cache || null
        if (c) {
          const pct = (v) => (v == null ? null : Math.max(0, Math.min(100, v * 100)))
          return {
            input: c.observedInput || 0, output: 0, cached: c.totalCacheRead || 0,
            cacheWrite: c.totalCacheWrite || 0, miss: Math.max(0, (c.observedInput || 0) - (c.totalCacheRead || 0)),
            hitRate: pct(c.tokenHitRate), requestHitRate: pct(c.requestHitRate), warmHitRate: pct(c.warmRequestHitRate),
            unobserved: c.unobservedRequests || 0, observedReq: c.observedRequests || 0,
            warmObserved: c.warmObserved || 0, warmHit: c.warmHit || 0, coldObserved: c.coldObserved || 0,
            hasData: (c.observedRequests || 0) > 0, hasRequestRate: c.requestHitRate != null,
          }
        }
        // 旧后端 fallback（无 /overview.cache 字段）
        const t = M.tokenTrend || []
        const input = t.reduce((s, d) => s + (d.input || 0), 0)
        const cached = t.reduce((s, d) => s + (d.cached || 0), 0)
        const hitRate = input > 0 ? (cached / input) * 100 : 0
        return { input, output: 0, cached, cacheWrite: 0, miss: Math.max(0, input - cached), hitRate, missRate: input > 0 ? 100 - hitRate : 0, hasData: input > 0, hasRequestRate: false, unobserved: 0 }
      })
      const setWin = async (w) => {
        win.value = w
        try { await window.store.loadOverview({ window: w }) } catch { /* 忽略 */ }
      }

      /* 惰性加载:概览聚合 + 配置(开关速览/统计卡用);失败静默(各页自有 load) */
      onMounted(async () => {
        try { await window.store.loadOverview() } catch { /* 未就绪,忽略 */ }
        try { await window.store.loadConfig() } catch { /* 忽略 */ }
      })

      return { stats, chart, reqChart, toolTop, toolMax, switches, perceptions, totalTokens, cacheStats, win, setWin, fmt, M }
    },
    template: `
    <div>
      <!-- Hero -->
      <div class="hero" style="--i:0">
        <div class="h-blob b1"></div><div class="h-blob b2"></div><div class="h-blob b3"></div>
        <div style="position:relative">
          <div class="row g10 wrap">
            <h2>agents-plugin <span class="grad-t">管理面板</span></h2>
            <span class="pill p-mint"><v-icon name="zap"/>运行中</span>
            <span class="pill p-sky">v0.3.0</span>
          </div>
          <p>多模型对话 · 工具调用 · 长期记忆 · 人设 · 多模态 · 深度研究 · MCP · 自进化。
            近 7 日累计消耗 <b class="num" style="color:var(--pri)">{{ fmt.num(totalTokens) }}</b> tokens。</p>
          <div class="hero-qs">
            <span class="qs"><v-icon name="zap"/>请求 <b class="num">{{ fmt.num(M.totalRequests || 0) }}</b></span>
            <span class="qs"><v-icon name="tool"/>工具调用 <b class="num">{{ fmt.num(M.totalToolCalls || 0) }}</b></span>
            <span class="qs"><v-icon name="session"/>活跃对话 <b class="num">{{ fmt.num(M.counts?.conversations ?? 0) }}</b></span>
            <span class="qs"><v-icon name="recall"/>长期记忆 <b class="num">{{ fmt.num(Object.values(M.recall || {}).flat().length) }}</b></span>
          </div>
        </div>
      </div>

      <!-- 统计卡片 -->
      <div class="grid g3 mt16 stagger">
        <div v-for="(s, i) in stats" :key="s.label" class="card lift stat" :style="{'--i': i+1}">
          <div class="st-ico" :style="{background: s.grad}"><v-icon :name="s.icon"/></div>
          <div class="st-v">
            <count-up v-if="s.count" :to="s.value"/>
            <span v-else class="mono" style="font-size:19px">{{ s.value }}</span>
          </div>
          <div class="st-l">{{ s.label }}</div>
          <div class="st-s">{{ s.sub }}</div>
        </div>
      </div>

      <!-- 图表区 -->
      <div class="grid mt16 cols-w">
        <div class="card pad lift" style="--i:7">
          <div class="row-b wrap g10">
            <div class="ct">
              <span class="ct-ico" style="background:var(--grad)"><v-icon name="zap"/></span>
              <div><div class="ct-t">Token 消耗趋势</div><div class="ct-s">按 devLog run_end.usage 聚合 · 近 7 日</div></div>
            </div>
            <div class="row g14" style="font-size:12px">
              <span class="row g6"><i style="width:10px;height:10px;border-radius:3px;background:#6366f1"></i>输入</span>
              <span class="row g6"><i style="width:10px;height:10px;border-radius:3px;background:#2dd4bf"></i>输出</span>
              <span v-if="chart.hasCached" class="row g6"><i style="width:10px;height:10px;border-radius:3px;background:transparent;border:2px dashed #2563eb"></i>命中·输入</span>
              <span v-if="chart.hasCached" class="row g6"><i style="width:10px;height:10px;border-radius:3px;background:transparent;border:2px dashed #38bdf8"></i>命中·输出</span>
              <span v-if="chart.hasCached" class="row g6"><i style="width:10px;height:10px;border-radius:3px;background:transparent;border:2px dotted #f97316"></i>未命中·输入</span>
              <span v-if="chart.hasCached" class="row g6"><i style="width:10px;height:10px;border-radius:3px;background:transparent;border:2px dotted #eab308"></i>未命中·输出</span>
            </div>
          </div>
          <svg v-if="chart.lineIn" :viewBox="'0 0 ' + chart.W + ' ' + chart.H" style="width:100%;margin-top:14px;display:block">
            <defs>
              <linearGradient id="agIn" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#6366f1" stop-opacity=".28"/><stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>
              </linearGradient>
              <linearGradient id="agOut" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#2dd4bf" stop-opacity=".25"/><stop offset="100%" stop-color="#2dd4bf" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <path :d="chart.areaIn" fill="url(#agIn)"/>
            <path :d="chart.areaOut" fill="url(#agOut)"/>
            <polyline :points="chart.lineIn" fill="none" stroke="#6366f1" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
              pathLength="1" style="stroke-dasharray:1;stroke-dashoffset:1;animation:dashIn 1.4s .2s var(--eo) forwards"/>
            <polyline :points="chart.lineOut" fill="none" stroke="#2dd4bf" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
              pathLength="1" style="stroke-dasharray:1;stroke-dashoffset:1;animation:dashIn 1.4s .5s var(--eo) forwards"/>
            <polyline v-if="chart.lineHitIn" :points="chart.lineHitIn" fill="none" stroke="#2563eb" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"
              stroke-dasharray="10 5"/>
            <polyline v-if="chart.lineHitOut" :points="chart.lineHitOut" fill="none" stroke="#38bdf8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
              stroke-dasharray="4 4"/>
            <polyline v-if="chart.lineMissIn" :points="chart.lineMissIn" fill="none" stroke="#f97316" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"
              stroke-dasharray="2 3"/>
            <polyline v-if="chart.lineMissOut" :points="chart.lineMissOut" fill="none" stroke="#eab308" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
              stroke-dasharray="1 4"/>
            <template v-if="chart.single && chart.dots.length">
              <circle :cx="chart.dots[0].x" :cy="chart.dots[0].yIn" r="3.5" fill="#6366f1"/>
              <circle :cx="chart.dots[0].x" :cy="chart.dots[0].yOut" r="3.5" fill="#2dd4bf"/>
              <circle v-if="chart.dots[0].yHitIn != null" :cx="chart.dots[0].x" :cy="chart.dots[0].yHitIn" r="3.5" fill="none" stroke="#2563eb" stroke-width="2.6"/>
              <circle v-if="chart.dots[0].yHitOut != null" :cx="chart.dots[0].x" :cy="chart.dots[0].yHitOut" r="3" fill="none" stroke="#38bdf8" stroke-width="1.8"/>
              <rect v-if="chart.dots[0].yMissIn != null" :x="chart.dots[0].x - 3.2" :y="chart.dots[0].yMissIn - 3.2" width="6.4" height="6.4" fill="none" stroke="#f97316" stroke-width="2.6"/>
              <rect v-if="chart.dots[0].yMissOut != null" :x="chart.dots[0].x - 2.8" :y="chart.dots[0].yMissOut - 2.8" width="5.6" height="5.6" fill="none" stroke="#eab308" stroke-width="1.8"/>
            </template>
          </svg>
          <div v-if="chart.lineIn" class="row-b" style="padding:0 8px;font-size:11px;color:var(--ink3)">
            <span v-for="d in chart.days" :key="d">{{ d }}</span>
          </div>
          <div v-if="chart.rows && chart.rows.length" class="mt16" style="max-height:180px;overflow:auto;border-top:1px dashed var(--line)">
            <table style="width:100%;border-collapse:collapse;font-size:11.5px" class="mono">
              <thead><tr style="color:var(--ink3);text-align:right">
                <th style="text-align:left;padding:6px 8px;font-weight:600">日期</th>
                <th style="padding:6px 6px;color:#6366f1">输入</th>
                <th v-if="chart.hasCached" style="padding:6px 6px;color:#2563eb">命中·输入</th>
                <th v-if="chart.hasCached" style="padding:6px 6px;color:#f97316">未命中·输入</th>
                <th style="padding:6px 6px;color:#2dd4bf">输出</th>
              </tr></thead>
              <tbody>
                <tr v-for="r in chart.rows" :key="r.day" style="text-align:right;border-top:1px solid var(--line)">
                  <td style="text-align:left;padding:5px 8px;color:var(--ink2)">{{ r.day }}</td>
                  <td style="padding:5px 6px">{{ fmt.num(r.input) }}</td>
                  <td v-if="chart.hasCached" style="padding:5px 6px">{{ fmt.num(r.cached) }}</td>
                  <td v-if="chart.hasCached" style="padding:5px 6px">{{ fmt.num(r.miss) }}</td>
                  <td style="padding:5px 6px">{{ fmt.num(r.output) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else style="padding:34px 16px;text-align:center;color:var(--ink3)">
            <div style="font-weight:700;font-size:13px;margin-bottom:4px;color:var(--ink2)">暂无数据</div>
            <div style="font-size:11.5px">产生对话（@机器人 / #ai）后自动统计</div>
          </div>
        </div>

        <div class="card pad lift" style="--i:8">
          <div class="ct">
            <span class="ct-ico" style="background:var(--grad-vio)"><v-icon name="tool"/></span>
            <div><div class="ct-t">工具调用 Top5</div><div class="ct-s">按 tool 事件计数 · 近 7 日</div></div>
          </div>
          <div v-if="toolTop.length" class="mt16" style="display:flex;flex-direction:column;gap:13px">
            <div v-for="(t, i) in toolTop" :key="t.name" :style="{'--i': i, animation: 'fadeUp .5s var(--eo) backwards', animationDelay: (i * 60) + 'ms'}">
              <div class="row-b" style="font-size:12.5px;margin-bottom:5px">
                <span class="mono" style="font-weight:700">{{ t.name }}</span>
                <span class="mut num">{{ t.count }} 次</span>
              </div>
              <div class="meter" :class="['', 'm-mint', 'm-honey', 'm-rose', ''][i]">
                <i :style="{width: (t.count / toolMax * 100) + '%', transitionDelay: (i * 90 + 200) + 'ms'}"></i>
              </div>
            </div>
          </div>
          <div v-else style="padding:34px 16px;text-align:center;color:var(--ink3)">
            <div style="font-weight:700;font-size:13px;margin-bottom:4px;color:var(--ink2)">暂无数据</div>
            <div style="font-size:11.5px">产生对话后自动统计</div>
          </div>
        </div>

        <!-- Token 缓存统计（独立卡：完整 Agent 流用量口径 + 输入/输出与占比） -->
        <div class="card pad lift" style="--i:9">
          <div class="row-b wrap g10">
            <div class="ct">
              <span class="ct-ico" style="background:linear-gradient(135deg,#2563eb,#f97316)"><v-icon name="zap"/></span>
              <div><div class="ct-t">Token 缓存统计</div><div class="ct-s">观测口径：未观测旧日志不进命中率 · cold/warm 分层</div></div>
            </div>
            <div class="row g6" style="font-size:11px">
              <button v-for="w in ['1h','24h','7d','new','all']" :key="w" class="btn" :class="win===w?'b-pri':'b-line'" style="padding:3px 9px;font-size:11px" @click="setWin(w)">{{ w==='new'?'部署后':(w==='all'?'全部':w) }}</button>
            </div>
          </div>
          <div v-if="cacheStats.hasData" class="row g10 wrap" style="margin-top:12px;font-size:11.5px">
            <span class="pill p-honey">请求命中率 {{ cacheStats.requestHitRate != null ? cacheStats.requestHitRate.toFixed(1) + '%' : '暂无' }}</span>
            <span class="pill p-mint">Token 命中率 {{ cacheStats.hitRate != null ? cacheStats.hitRate.toFixed(1) + '%' : '暂无' }}</span>
            <span v-if="cacheStats.warmHitRate != null" class="pill p-sky">warm 命中率 {{ cacheStats.warmHitRate.toFixed(1) }}%（{{ cacheStats.warmHit }}/{{ cacheStats.warmObserved }}）</span>
            <span class="pill">cold {{ cacheStats.coldObserved }}</span>
            <span v-if="cacheStats.unobserved > 0" class="pill" style="opacity:.75">未观测旧日志 {{ cacheStats.unobserved }} 条（不进分母）</span>
          </div>
          <template v-if="cacheStats.hasData">
            <div class="mt16" style="display:flex;flex-direction:column;gap:14px">
              <div>
                <div class="row-b" style="font-size:12.5px;margin-bottom:6px">
                  <span style="font-weight:700;color:#6366f1">输入 tokens</span>
                  <span class="num" style="font-weight:700">{{ fmt.num(cacheStats.input) }}</span>
                </div>
                <div class="row g6" style="margin-bottom:6px;font-size:11px">
                  <span style="color:#2563eb">缓存读取 {{ fmt.num(cacheStats.cached) }}（{{ cacheStats.hitRate != null ? cacheStats.hitRate.toFixed(1) : '?' }}%）</span>
                  <span style="color:#f97316">未缓存输入 {{ fmt.num(cacheStats.miss) }}</span>
                  <span v-if="cacheStats.cacheWrite > 0" style="color:#a78bfa">缓存写入 {{ fmt.num(cacheStats.cacheWrite) }}</span>
                </div>
                <div style="display:flex;height:10px;border-radius:6px;overflow:hidden;background:var(--line)">
                  <i :style="{width: cacheStats.hitRate + '%', background: 'linear-gradient(90deg,#2563eb,#38bdf8)', transition: 'width .8s var(--eo)'}"></i>
                  <i :style="{width: cacheStats.missRate + '%', background: 'linear-gradient(90deg,#f97316,#fbbf24)'}"></i>
                </div>
              </div>
              <div>
                <div class="row-b" style="font-size:12.5px;margin-bottom:6px">
                  <span style="font-weight:700;color:#2dd4bf">输出 tokens</span>
                  <span class="num" style="font-weight:700">{{ fmt.num(cacheStats.output) }}</span>
                </div>
                <div class="meter"><i :style="{width: '100%', background: 'linear-gradient(90deg,#2dd4bf,#14b8a6)'}"></i></div>
                <div style="font-size:11px;color:var(--ink3);margin-top:5px">输出生成不走前缀缓存，按全价计；缓存写入为 Anthropic cache_creation / OpenAI cache_write</div>
              </div>
              <div class="row-b" style="font-size:12px;padding-top:10px;border-top:1px dashed var(--line)">
                <span style="color:var(--ink3)">合计</span>
                <span class="num" style="font-weight:700">{{ fmt.num(cacheStats.input + cacheStats.output) }} tokens</span>
              </div>
            </div>
          </template>
          <div v-else style="padding:34px 16px;text-align:center;color:var(--ink3)">
            <div style="font-weight:700;font-size:13px;margin-bottom:4px;color:var(--ink2)">暂无缓存数据</div>
            <div style="font-size:11.5px">产生对话后自动统计（旧日志无缓存字段时仅显示趋势线）</div>
          </div>
        </div>
      </div>

      <!-- 请求趋势柱状图（近 7 日对话轮次） -->
      <div class="card pad lift mt16" style="--i:10">
        <div class="row-b wrap g10">
          <div class="ct">
            <span class="ct-ico" style="background:var(--grad-sky)"><v-icon name="zap"/></span>
            <div><div class="ct-t">请求趋势（每日对话轮次）</div><div class="ct-s">按 devLog run_end 计数 · 近 7 日 · 共 {{ fmt.num(M.totalRequests || 0) }} 次</div></div>
          </div>
          <span class="pill p-pri" style="font-size:11px">峰值 {{ reqChart.max }} / 日</span>
        </div>
        <svg v-if="reqChart.bars.length" :viewBox="'0 0 ' + reqChart.W + ' ' + reqChart.H" style="width:100%;margin-top:14px;display:block">
          <defs>
            <linearGradient id="agReq" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#8b5cf6" stop-opacity=".9"/><stop offset="100%" stop-color="#6366f1" stop-opacity=".45"/>
            </linearGradient>
          </defs>
          <rect v-for="(b, i) in reqChart.bars" :key="i" :x="b.x" :y="b.y" :width="b.w" :height="b.h" rx="4"
            fill="url(#agReq)" :style="{ animation: 'fadeUp .5s var(--eo) backwards', animationDelay: (i * 70 + 120) + 'ms' }">
            <title>{{ b.count }} 次</title>
          </rect>
        </svg>
        <div v-if="reqChart.bars.length" class="row-b" style="padding:0 8px;font-size:11px;color:var(--ink3)">
          <span v-for="d in reqChart.days" :key="d">{{ d }}</span>
        </div>
        <div v-else style="padding:34px 16px;text-align:center;color:var(--ink3)">
          <div style="font-weight:700;font-size:13px;margin-bottom:4px;color:var(--ink2)">暂无数据</div>
          <div style="font-size:11.5px">产生对话（@机器人 / #ai）后自动统计</div>
        </div>
      </div>

      <!-- 状态行 -->
      <div class="grid mt16 cols-w">
        <div class="card pad lift" style="--i:10">
          <div class="ct">
            <span class="ct-ico" style="background:var(--grad-honey)"><v-icon name="config"/></span>
            <div><div class="ct-t">功能开关速览</div><div class="ct-s">当前生效配置一览(只读,修改请前往配置中心)</div></div>
          </div>
          <div class="grid g4 mt16" style="gap:12px">
            <div v-for="s in switches" :key="s.name" class="row-b"
              style="padding:9px 13px;border-radius:12px;background:rgba(255,255,255,.5);border:1px solid var(--line);font-size:12.5px;font-weight:700">
              <span>{{ s.name }}</span>
              <span class="pill" :class="s.on ? (s.danger ? 'p-rose' : 'p-green') : ''" style="font-size:10.5px;padding:3px 9px">
                {{ s.on ? 'ON' : 'OFF' }}
              </span>
            </div>
          </div>
        </div>
        <div class="card pad lift" style="--i:11">
          <div class="ct">
            <span class="ct-ico" style="background:var(--grad-mint)"><v-icon name="group"/></span>
            <div><div class="ct-t">群情境感知</div><div class="ct-s">perception:met / last_active</div></div>
          </div>
          <div class="mt16" style="display:flex;flex-direction:column;gap:10px">
            <div v-for="p in perceptions" :key="p.groupId" class="row-b"
              style="padding:10px 14px;border-radius:12px;background:rgba(255,255,255,.5);border:1px solid var(--line)">
              <div>
                <div class="mono" style="font-weight:800;font-size:13px">群 {{ p.groupId }}</div>
                <div class="mut2" style="font-size:11px">入群 {{ fmt.ago(p.met.at) }}</div>
              </div>
              <span class="pill" :class="(Date.now() - p.lastActive.at) > 6*3600e3 ? 'p-honey' : 'p-green'">
                {{ (Date.now() - p.lastActive.at) > 6*3600e3 ? '久离 ' : '活跃 ' }}{{ fmt.ago(p.lastActive.at) }}
              </span>
            </div>
            <empty-state v-if="!perceptions.length" icon="group" text="暂无群感知数据"/>
          </div>
        </div>
      </div>
    </div>`,
  }
})()
