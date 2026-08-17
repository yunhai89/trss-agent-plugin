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
        const empty = { W, H: Hgt, lineIn: '', lineOut: '', lineCached: '', areaIn: '', areaOut: '', days: [], dots: [], single: false, hasCached: false }
        if (!trend.length) return empty
        const hasCached = trend.some((d) => (d.cached || 0) > 0) // 无缓存数据的日子（旧日志）不画空线
        // 未命中缓存 = 输入中没走缓存的部分（miss = input - cached，钳 0）——成本大头就是它
        for (const d of trend) d.miss = Math.max(0, (d.input || 0) - (d.cached || 0))
        const maxV = Math.max(...trend.map((d) => Math.max(d.input + d.output, d.cached || 0))) || 1
        const denom = (trend.length - 1) || 1
        const pt = (i, v) => [PAD + (i * (W - PAD * 2)) / denom, Hgt - PAD - (v / maxV) * (Hgt - PAD * 2 - 14)]
        const line = (key) => trend.map((d, i) => pt(i, d[key]).map((n) => n.toFixed(1)).join(',')).join(' ')
        const area = (key) => {
          const pts = trend.map((d, i) => pt(i, d[key]))
          return `M${pts[0][0]},${Hgt - PAD} ` + pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') + ` L${pts[pts.length - 1][0]},${Hgt - PAD} Z`
        }
        const dots = trend.length === 1 ? [{ x: pt(0, 0)[0], yIn: pt(0, trend[0].input)[1], yOut: pt(0, trend[0].output)[1], yCached: hasCached ? pt(0, trend[0].cached || 0)[1] : null, yMiss: hasCached ? pt(0, trend[0].miss || 0)[1] : null }] : []
        // 每日数值表（图旁 tokens 明细，与折线同序；天多时倒序显示最新在前）
        const rows = [...trend].reverse().map((d) => ({ day: d.day, input: d.input || 0, cached: d.cached || 0, miss: d.miss || 0, output: d.output || 0 }))
        return { W, H: Hgt, lineIn: line('input'), lineOut: line('output'), lineCached: hasCached ? line('cached') : '', lineMiss: hasCached ? line('miss') : '', areaIn: area('input'), areaOut: area('output'), days: trend.map((d) => d.day), dots, single: trend.length === 1, hasCached, rows }
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
      /* 缓存统计（独立卡，不挤在 Token 消耗趋势里）。口径 = 一整个完整 Agent 流的用量：
       * run_end.usage 是 Agent 全部工具轮 + 反思/收尾调用的累计（normalizeUsage/mergeUsage），
       * cached 同源累加——不是单次请求的末轮值 */
      const cacheStats = computed(() => {
        const t = M.tokenTrend || []
        const input = t.reduce((s, d) => s + (d.input || 0), 0)
        const output = t.reduce((s, d) => s + (d.output || 0), 0)
        const cached = t.reduce((s, d) => s + (d.cached || 0), 0)
        const miss = Math.max(0, input - cached)
        const hitRate = input > 0 ? (cached / input) * 100 : 0
        return { input, output, cached, miss, hitRate, missRate: input > 0 ? 100 - hitRate : 0, hasData: input > 0 }
      })

      /* 惰性加载:概览聚合 + 配置(开关速览/统计卡用);失败静默(各页自有 load) */
      onMounted(async () => {
        try { await window.store.loadOverview() } catch { /* 未就绪,忽略 */ }
        try { await window.store.loadConfig() } catch { /* 忽略 */ }
      })

      return { stats, chart, reqChart, toolTop, toolMax, switches, perceptions, totalTokens, cacheStats, fmt, M }
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
              <span v-if="chart.hasCached" class="row g6"><i style="width:10px;height:10px;border-radius:3px;background:transparent;border:2px dashed #f59e0b"></i>缓存命中</span>
              <span v-if="chart.hasCached" class="row g6"><i style="width:10px;height:10px;border-radius:3px;background:transparent;border:2px dotted #f43f5e"></i>未命中</span>
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
            <polyline v-if="chart.lineCached" :points="chart.lineCached" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
              stroke-dasharray="6 5"/>
            <polyline v-if="chart.lineMiss" :points="chart.lineMiss" fill="none" stroke="#f43f5e" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
              stroke-dasharray="2 4"/>
            <template v-if="chart.single && chart.dots.length">
              <circle :cx="chart.dots[0].x" :cy="chart.dots[0].yIn" r="3.5" fill="#6366f1"/>
              <circle :cx="chart.dots[0].x" :cy="chart.dots[0].yOut" r="3.5" fill="#2dd4bf"/>
              <circle v-if="chart.dots[0].yCached != null" :cx="chart.dots[0].x" :cy="chart.dots[0].yCached" r="3.5" fill="none" stroke="#f59e0b" stroke-width="2.2"/>
              <circle v-if="chart.dots[0] && chart.dots[0].yMiss != null" :cx="chart.dots[0].x" :cy="chart.dots[0].yMiss" r="3" fill="none" stroke="#f43f5e" stroke-width="1.8"/>
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
                <th v-if="chart.hasCached" style="padding:6px 6px;color:#f59e0b">命中</th>
                <th v-if="chart.hasCached" style="padding:6px 6px;color:#f43f5e">未命中</th>
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
              <span class="ct-ico" style="background:linear-gradient(135deg,#f59e0b,#f43f5e)"><v-icon name="zap"/></span>
              <div><div class="ct-t">Token 缓存统计</div><div class="ct-s">完整 Agent 流累计用量（全部工具轮+反思）· 近 7 日</div></div>
            </div>
            <span v-if="cacheStats.hasData" class="pill p-honey" style="font-size:11px">输入命中率 {{ cacheStats.hitRate.toFixed(1) }}%</span>
            <span v-else class="pill" style="font-size:11px">暂无数据</span>
          </div>
          <template v-if="cacheStats.hasData">
            <div class="mt16" style="display:flex;flex-direction:column;gap:14px">
              <div>
                <div class="row-b" style="font-size:12.5px;margin-bottom:6px">
                  <span style="font-weight:700;color:#6366f1">输入 tokens</span>
                  <span class="num" style="font-weight:700">{{ fmt.num(cacheStats.input) }}</span>
                </div>
                <div class="row g6" style="margin-bottom:6px;font-size:11px">
                  <span style="color:#f59e0b">命中 {{ fmt.num(cacheStats.cached) }}（{{ cacheStats.hitRate.toFixed(1) }}%）</span>
                  <span style="color:#f43f5e">未命中 {{ fmt.num(cacheStats.miss) }}（{{ cacheStats.missRate.toFixed(1) }}%）</span>
                </div>
                <div style="display:flex;height:10px;border-radius:6px;overflow:hidden;background:var(--line)">
                  <i :style="{width: cacheStats.hitRate + '%', background: 'linear-gradient(90deg,#f59e0b,#fbbf24)', transition: 'width .8s var(--eo)'}"></i>
                  <i :style="{width: cacheStats.missRate + '%', background: 'linear-gradient(90deg,#f43f5e,#fb7185)'}"></i>
                </div>
              </div>
              <div>
                <div class="row-b" style="font-size:12.5px;margin-bottom:6px">
                  <span style="font-weight:700;color:#2dd4bf">输出 tokens</span>
                  <span class="num" style="font-weight:700">{{ fmt.num(cacheStats.output) }}</span>
                </div>
                <div class="meter"><i :style="{width: '100%', background: 'linear-gradient(90deg,#2dd4bf,#14b8a6)'}"></i></div>
                <div style="font-size:11px;color:var(--ink3);margin-top:5px">输出生成不走前缀缓存，按全价计</div>
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
