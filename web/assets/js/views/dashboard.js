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
            icon: 'cpu', grad: 'var(--grad-primary)', label: '主模型', value: cfg.model || '—',
            sub: `${cfg.preset || '—'} · ${cfg.protocol || '—'}`,
          },
          {
            icon: 'recall', grad: 'var(--grad-teal)', label: '长期记忆条目', value: Object.values(M.recall || {}).flat().length,
            sub: `上限 ${cfg.recall?.cap || '—'} 条/用户 · 抽取每 ${cfg.recall?.extractEvery || '—'} 轮`, count: true,
          },
          {
            icon: 'session', grad: 'var(--grad-sky)', label: '活跃对话', value: M.counts?.conversations ?? 0,
            sub: '群聊/私聊会话总数', count: true,
          },
          {
            icon: 'confirm', grad: 'var(--grad-amber)', label: '待审批 / 待审建议', value: (M.confirms || []).length + (M.suggestions || []).filter((s) => s.status === 'pending').length,
            sub: '审批为纯内存,重启清空', count: true,
          },
        ]
      })

      /* Token 面积图(SVG 手绘) —— computed 依赖 M.tokenTrend,loadOverview 后重算 */
      const chart = computed(() => {
        const W = 560, Hgt = 180, PAD = 8
        const trend = M.tokenTrend || []
        if (!trend.length) return { W, H: Hgt, lineIn: '', lineOut: '', areaIn: '', areaOut: '', days: [] }
        const maxV = Math.max(...trend.map((d) => d.input + d.output)) || 1
        const pt = (i, v) => [PAD + (i * (W - PAD * 2)) / (trend.length - 1), Hgt - PAD - (v / maxV) * (Hgt - PAD * 2 - 14)]
        const line = (key) => trend.map((d, i) => pt(i, d[key]).map((n) => n.toFixed(1)).join(',')).join(' ')
        const area = (key) => {
          const pts = trend.map((d, i) => pt(i, d[key]))
          return `M${pts[0][0]},${Hgt - PAD} ` + pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') + ` L${pts[pts.length - 1][0]},${Hgt - PAD} Z`
        }
        return { W, H: Hgt, lineIn: line('input'), lineOut: line('output'), areaIn: area('input'), areaOut: area('output'), days: trend.map((d) => d.day) }
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

      /* 惰性加载:概览聚合 + 配置(开关速览/统计卡用);失败静默(各页自有 load) */
      onMounted(async () => {
        try { await window.store.loadOverview() } catch { /* 未就绪,忽略 */ }
        try { await window.store.loadConfig() } catch { /* 忽略 */ }
      })

      return { stats, chart, toolTop, toolMax, switches, perceptions, totalTokens, fmt }
    },
    template: `
    <div>
      <!-- Hero -->
      <div class="hero" style="--i:0">
        <div class="hero-blob b1"></div><div class="hero-blob b2"></div><div class="hero-blob b3"></div>
        <div style="position:relative">
          <div class="flex gap10 wrap">
            <h2>agents-plugin 管理面板</h2>
            <span class="chip chip-primary"><v-icon name="zap"/>运行中</span>
            <span class="chip chip-sky">v0.2.0</span>
          </div>
          <p>多模型对话 · 工具调用 · 长期记忆 · 人设 · 多模态 · 深度研究 · MCP · 自进化。
            近 7 日累计消耗 <b class="num" style="color:var(--primary)">{{ fmt.num(totalTokens) }}</b> tokens。</p>
        </div>
      </div>

      <!-- 统计卡片 -->
      <div class="grid grid-4 mt16 stagger">
        <div v-for="(s, i) in stats" :key="s.label" class="card hoverable stat-card" :style="{'--i': i+1}">
          <div class="stat-icon" :style="{background: s.grad}"><v-icon :name="s.icon"/></div>
          <div class="stat-value">
            <count-up v-if="s.count" :to="s.value"/>
            <span v-else class="mono" style="font-size:19px">{{ s.value }}</span>
          </div>
          <div class="stat-label">{{ s.label }}</div>
          <div class="stat-trend muted-3">{{ s.sub }}</div>
        </div>
      </div>

      <!-- 图表区 -->
      <div class="grid mt16 cols-wide">
        <div class="card card-pad hoverable" style="--i:5">
          <div class="flex between">
            <div>
              <div class="card-title"><v-icon name="zap"/>Token 消耗趋势</div>
              <div class="card-sub">按 devLog run_end.usage 聚合 · 近 7 日</div>
            </div>
            <div class="flex gap14" style="font-size:12px">
              <span class="flex gap6"><i style="width:10px;height:10px;border-radius:3px;background:var(--primary)"></i>输入</span>
              <span class="flex gap6"><i style="width:10px;height:10px;border-radius:3px;background:var(--teal)"></i>输出</span>
            </div>
          </div>
          <svg :viewBox="'0 0 ' + chart.W + ' ' + chart.H" style="width:100%;margin-top:14px;display:block">
            <defs>
              <linearGradient id="agIn" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#3b82f6" stop-opacity=".28"/><stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
              </linearGradient>
              <linearGradient id="agOut" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#14b8a6" stop-opacity=".25"/><stop offset="100%" stop-color="#14b8a6" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <path :d="chart.areaIn" fill="url(#agIn)"/>
            <path :d="chart.areaOut" fill="url(#agOut)"/>
            <polyline :points="chart.lineIn" fill="none" stroke="#3b82f6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
              pathLength="1" style="stroke-dasharray:1;stroke-dashoffset:1;animation:dashIn 1.4s .2s var(--ease-out) forwards"/>
            <polyline :points="chart.lineOut" fill="none" stroke="#14b8a6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
              pathLength="1" style="stroke-dasharray:1;stroke-dashoffset:1;animation:dashIn 1.4s .5s var(--ease-out) forwards"/>
          </svg>
          <div class="flex between" style="padding:0 8px;font-size:11px;color:var(--text-3)">
            <span v-for="d in chart.days" :key="d">{{ d }}</span>
          </div>
        </div>

        <div class="card card-pad hoverable" style="--i:6">
          <div class="card-title"><v-icon name="tool"/>工具调用 Top5</div>
          <div class="card-sub">按 tool 事件计数 · 近 7 日</div>
          <div class="mt16" style="display:flex;flex-direction:column;gap:13px">
            <div v-for="(t, i) in toolTop" :key="t.name" :style="{'--i': i}" class="stagger" style="animation:fadeUp .5s var(--ease-out) backwards">
              <div class="flex between" style="font-size:12.5px;margin-bottom:5px">
                <span class="mono" style="font-weight:700">{{ t.name }}</span>
                <span class="muted num">{{ t.count }} 次</span>
              </div>
              <div class="progress" :class="['', 'teal', 'amber', 'rose', ''][i]">
                <i :style="{width: (t.count / toolMax * 100) + '%', transitionDelay: (i * 90 + 200) + 'ms'}"></i>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 状态行 -->
      <div class="grid mt16 cols-wide">
        <div class="card card-pad hoverable" style="--i:7">
          <div class="card-title"><v-icon name="config"/>功能开关速览</div>
          <div class="card-sub">当前生效配置一览(只读,修改请前往配置中心)</div>
          <div class="grid grid-4 mt16" style="gap:12px">
            <div v-for="s in switches" :key="s.name" class="flex between"
              style="padding:9px 13px;border-radius:10px;background:var(--surface-2);border:1px solid var(--border);font-size:12.5px;font-weight:700">
              <span>{{ s.name }}</span>
              <span class="chip" :class="s.on ? (s.danger ? 'chip-rose' : 'chip-green') : ''" style="font-size:10.5px;padding:2px 8px">
                {{ s.on ? 'ON' : 'OFF' }}
              </span>
            </div>
          </div>
        </div>
        <div class="card card-pad hoverable" style="--i:8">
          <div class="card-title"><v-icon name="group"/>群情境感知</div>
          <div class="card-sub">perception:met / last_active</div>
          <div class="mt16" style="display:flex;flex-direction:column;gap:10px">
            <div v-for="p in perceptions" :key="p.groupId" class="flex between"
              style="padding:10px 14px;border-radius:10px;background:var(--surface-2);border:1px solid var(--border)">
              <div>
                <div class="mono" style="font-weight:800;font-size:13px">群 {{ p.groupId }}</div>
                <div class="muted-3" style="font-size:11px">入群 {{ fmt.ago(p.met.at) }}</div>
              </div>
              <span class="chip" :class="(Date.now() - p.lastActive.at) > 6*3600e3 ? 'chip-amber' : 'chip-green'">
                {{ (Date.now() - p.lastActive.at) > 6*3600e3 ? '久离 ' : '活跃 ' }}{{ fmt.ago(p.lastActive.at) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  }
})()
