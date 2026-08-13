/** 视图:日志回放(§2.4 devLog · 会话文件 → traceId → 事件时间线) */
(function () {
  window.VIEWS = window.VIEWS || {}

  /* 12 种 event 的展示元数据 */
  const EV = {
    trigger: { name: '收到消息', icon: 'send', color: 'var(--sky)', bg: 'var(--sky-bg)' },
    media: { name: '媒体解析', icon: 'file', color: 'var(--vio)', bg: 'var(--vio-bg)' },
    input: { name: '输入归一化', icon: 'edit', color: 'var(--mint)', bg: 'var(--mint-bg)' },
    run_start: { name: 'Agent 启动', icon: 'play', color: 'var(--pri)', bg: 'var(--pri-soft)' },
    turn: { name: 'LLM 往返', icon: 'cpu', color: 'var(--sky)', bg: 'var(--sky-bg)' },
    tool: { name: '工具调用', icon: 'tool', color: 'var(--mint)', bg: 'var(--mint-bg)' },
    tool_discovery: { name: '工具动态发现', icon: 'search', color: 'var(--vio)', bg: 'var(--vio-bg)' },
    reflect: { name: '自检回环', icon: 'refresh', color: 'var(--honey)', bg: 'var(--honey-bg)' },
    recall_extract: { name: '记忆抽取', icon: 'memory', color: 'var(--honey)', bg: 'var(--honey-bg)' },
    run_end: { name: 'Agent 结束', icon: 'check', color: 'var(--green)', bg: 'var(--green-bg)' },
    reply: { name: '回复投递', icon: 'send', color: 'var(--pri)', bg: 'var(--pri-soft)' },
    error: { name: '异常', icon: 'warn', color: 'var(--rose)', bg: 'var(--rose-bg)' },
  }

  window.VIEWS.logs = {
    name: 'LogsView',
    setup() {
      const { ref, reactive, computed, onMounted } = Vue
      const M = window.MOCK
      const { fmt } = window.UI

      const fileIdx = ref(0)
      const files = computed(() => M.logFiles)
      const file = computed(() => M.logFiles[fileIdx.value])

      /* traceId 分组 */
      const traces = computed(() => {
        const map = new Map()
        for (const e of (file.value?.events || [])) {
          if (!map.has(e.traceId)) map.set(e.traceId, [])
          map.get(e.traceId).push(e)
        }
        return [...map.entries()].map(([traceId, events]) => {
          const start = events.find((e) => e.event === 'run_start')
          const end = events.find((e) => e.event === 'run_end')
          const trig = events.find((e) => e.event === 'trigger')
          return {
            traceId, events,
            time: events[0].time,
            hasError: events.some((e) => e.event === 'error'),
            turns: end?.turns ?? '—',
            totalMs: end?.totalMs,
            usage: end?.usage,
            model: start?.model,
            text: trig?.text || '(未知输入)',
          }
        })
      })

      const activeTrace = ref(traces.value[0]?.traceId)
      const pickFile = async (i) => {
        fileIdx.value = i
        activeTrace.value = null
        const f = M.logFiles[i]
        if (f) { try { await window.store.loadLogEvents(f.file) } catch { /* 忽略 */ } }
        Vue.nextTick(() => { activeTrace.value = traces.value[0]?.traceId })
      }
      const events = computed(() => traces.value.find((t) => t.traceId === activeTrace.value)?.events || [])

      /* 筛选：默认最新10条；日期范围/事件类型/关键词任意组合，留空即不过滤 */
      const filter = reactive({ from: '', to: '', event: '', q: '' })
      const hitTotal = computed(() => M.logFilesTotal ?? M.logFiles.length)
      const buildQuery = () => {
        const o = {}
        if (filter.from) o.from = filter.from
        if (filter.to) o.to = filter.to
        if (filter.event) o.event = filter.event
        if (filter.q.trim()) o.q = filter.q.trim()
        return o
      }
      const runFilter = async () => {
        fileIdx.value = 0
        activeTrace.value = null
        try {
          await window.store.loadLogFiles(buildQuery())
          if (M.logFiles[0]) await window.store.loadLogEvents(M.logFiles[0].file)
          Vue.nextTick(() => { activeTrace.value = traces.value[0]?.traceId })
        } catch { /* 忽略 */ }
      }
      const resetFilter = () => { filter.from = ''; filter.to = ''; filter.event = ''; filter.q = ''; runFilter() }

      const expanded = ref({})
      const toggle = (i) => { expanded.value[i] = !expanded.value[i] }

      /* 事件摘要行 */
      const summary = (e) => {
        switch (e.event) {
          case 'trigger': return `"${e.text}" · ${e.isGroup ? '群' + e.gid : '私聊'} · ${e.inputLen}字`
          case 'media': return e.files?.length ? `${e.files.length} 个附件:${e.files.map((f) => f.name).join(', ')}` : '无附件'
          case 'input': return `${e.inputKind} · caps vision=${e.caps.vision} file=${e.caps.file}`
          case 'run_start': return `${e.model} · 常驻工具 ${e.toolsSent} 个 ≈${e.toolsTokensEst} tok · maxTurns=${e.maxTurns}`
          case 'turn': {
            const u = e.usage || {}
            const b = e.breakdown
            const dist = b ? ` · 分布 身份${b.identity}/工具${b.tools}/记忆${b.memory}/技能${b.skills}/对话${b.conversation}` : ''
            return `第 ${e.turn} 轮 · finish=${e.finish} · ${(u.prompt_tokens||0)}+${(u.completion_tokens||0)} tok${dist} · ${e.ms}ms`
          }
          case 'tool': return `${e.name} · ${e.success ? '✓' : '✗'}${e.errorClass ? ' ' + e.errorClass : ''} · ${e.duration ?? e.ms}ms${e.summary ? ' · ' + e.summary : ''}`
          case 'tool_discovery': return `检索「${e.query}」· 命中 ${e.availableCount ?? (e.hits?.length || 0)} · 激活 [${(e.activated||[]).join(', ')}]${e.rejected?.length ? ' · 淘汰 ' + e.rejected.length : ''}`
          case 'reflect': return e.revise ? `需修正:${e.feedback}` : `通过:${e.feedback}`
          case 'recall_extract': return `scopeUser=${e.scopeUserId} · LLM=${e.hasLlm} · ${e.ms}ms`
          case 'run_end': return `${e.turns} 轮 · stop=${e.stopReason} · 总 ${e.usage.total} tok · ${fmt.dur(e.totalMs)}`
          case 'reply': return `${e.mode === 'image' ? '图片' : '文本'}模式 · ${e.delivered ? '已送达' : '未送达'} · ${e.replyLen || e.body?.length || 0}字`
          case 'error': return `${e.error}`
          default: return ''
        }
      }

      /* turn 事件的缓存命中占比 */
      const cachePct = (u) => fmt.pct(u.prompt_cache_hit_tokens, u.prompt_tokens)

      /* 惰性加载:文件列表 → 自动取首个文件事件流 */
      onMounted(async () => {
        try {
          await window.store.loadLogFiles()
          if (M.logFiles[0]) {
            await window.store.loadLogEvents(M.logFiles[0].file)
            activeTrace.value = traces.value[0]?.traceId
          }
        } catch { /* 忽略 */ }
      })

      return { files, fileIdx, pickFile, traces, activeTrace, events, expanded, toggle, EV, summary, cachePct, fmt, filter, hitTotal, runFilter, resetFilter }
    },
    template: `
    <div class="grid cols-300" style="align-items:start">
      <!-- 会话文件 -->
      <div class="card" style="--i:0;overflow:hidden">
        <div style="padding:16px 18px;border-bottom:1px solid var(--line)">
          <div class="ct">
            <span class="ct-ico" style="background:var(--grad)"><v-icon name="log"/></span>
            <div><div class="ct-t">会话日志文件</div><div class="ct-s">data/logs/ · 敏感度:高</div></div>
          </div>
          <div class="row g6 wrap" style="margin-top:12px">
            <input type="date" class="inp" v-model="filter.from" style="width:auto"/>
            <span class="mut2">~</span>
            <input type="date" class="inp" v-model="filter.to" style="width:auto"/>
          </div>
          <div class="row g6 wrap" style="margin-top:8px">
            <select class="sel" v-model="filter.event" style="width:auto;min-width:108px">
              <option value="">全部事件</option>
              <option v-for="(meta, key) in EV" :key="key" :value="key">{{ meta.name }}</option>
            </select>
            <input class="inp" v-model="filter.q" placeholder="关键词(时间/报错/工具名)" style="flex:1;min-width:120px"/>
          </div>
          <div class="row g6" style="margin-top:8px">
            <button class="btn b-pri b-sm" @click="runFilter" style="flex:1"><v-icon name="search"/>查询</button>
            <button class="btn b-line b-sm" @click="resetFilter" style="flex:1">重置</button>
          </div>
          <div class="mut2" style="margin-top:9px;font-size:11px">命中 {{ hitTotal }} 条 · 当前显示最新 {{ files.length }} 条</div>
        </div>
        <div v-for="(f, i) in files" :key="f.file" class="tf-item" :class="{on: fileIdx === i}" @click="pickFile(i)">
          <div style="font-weight:700;font-size:12.5px">{{ f.label }}</div>
          <div class="mut2 mono ell" style="font-size:10.5px;margin-top:2px">{{ f.file }}</div>
        </div>
        <empty-state v-if="!files.length" icon="log" text="暂无日志文件"/>
      </div>

      <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <!-- trace 选择 -->
        <div class="card pad" style="--i:1">
          <div class="ct mb12">
            <span class="ct-ico" style="background:var(--grad-honey)"><v-icon name="zap"/></span>
            <div><div class="ct-t">请求链路(traceId)</div><div class="ct-s" v-if="activeTrace">traceId: <span class="mono">{{ activeTrace }}</span></div></div>
          </div>
          <div class="row g10 wrap">
            <div v-for="t in traces" :key="t.traceId" class="scp" :class="{on: activeTrace === t.traceId}" @click="activeTrace = t.traceId">
              <v-icon :name="t.hasError ? 'warn' : 'check'"/>
              <span>{{ fmt.time(t.time).slice(0, 8) }}</span>
              <span class="mut2" style="font-weight:400">{{ t.turns }}轮 · {{ t.totalMs ? fmt.dur(t.totalMs) : '—' }}</span>
              <span v-if="t.usage" class="pill num" :class="activeTrace === t.traceId ? '' : 'p-pri'" style="font-size:10px">{{ fmt.num(t.usage.total) }} tok</span>
            </div>
          </div>
        </div>

        <!-- 事件时间线 -->
        <div class="tl">
          <div v-for="(e, i) in events" :key="i" class="tl-i" :style="{'--i': i}">
            <div class="tl-dot" :style="{background: EV[e.event].color}"><v-icon :name="EV[e.event].icon"/></div>
            <div class="tl-c">
              <div class="tl-h" @click="toggle(i)">
                <span class="pill" :style="{background: EV[e.event].bg, color: EV[e.event].color}">{{ e.event }}</span>
                <b style="font-size:13px">{{ EV[e.event].name }}</b>
                <span class="mut mono tl-sum" style="font-size:11px">{{ summary(e) }}</span>
                <span class="mut2 mono tl-time" style="margin-left:auto;font-size:11px;flex:0 0 auto">{{ fmt.time(e.time) }}</span>
                <v-icon name="chevron" :style="{transform: expanded[i] ? 'rotate(180deg)' : '', transition: 'transform .25s', color: 'var(--ink3)', flex: '0 0 auto'}"/>
              </div>
              <Transition name="expand">
                <div v-if="expanded[i]" class="tl-b">
                  <div v-if="e.event === 'turn'" class="mb12">
                    <div class="row-b" style="font-size:11.5px;margin-bottom:4px">
                      <span class="mut">prompt 缓存命中</span>
                      <span class="num mut">{{ e.usage.prompt_cache_hit_tokens }}/{{ e.usage.prompt_tokens }} ({{ cachePct(e.usage) }}%)</span>
                    </div>
                    <div class="meter m-mint"><i :style="{width: cachePct(e.usage) + '%'}"></i></div>
                  </div>
                  <div v-if="e.event === 'tool_discovery'" class="mb12">
                    <div class="tchip-f">
                      <span v-for="(h, j) in e.hits" :key="h.name" class="tchip" :style="{'--i': j}">{{ h.name }} · {{ h.score }}</span>
                      <span v-for="(a, j) in e.activated" :key="a" class="tchip" :style="{'--i': j + 2, background: 'var(--mint-bg)', color: 'var(--mint)', borderColor: 'rgba(11,163,148,.24)'}">+{{ a }}</span>
                    </div>
                  </div>
                  <json-block :data="e"/>
                </div>
              </Transition>
            </div>
          </div>
        </div>
        <empty-state v-if="!events.length" icon="log" text="请选择一条链路"/>
      </div>
    </div>`,
  }
})()
