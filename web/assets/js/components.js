/**
 * 共享 UI 组件与工具函数(window.UI)
 * 所有组件注册到全局,模板字符串中直接使用。
 */
(function () {
  const { defineComponent, h, ref, reactive } = Vue

  /* ---------------- 工具函数 ---------------- */
  const fmt = {
    /** 相对时间:刚刚 / N分钟前 / N小时前 / N天前 / 日期 */
    ago(ts) {
      const d = Date.now() - ts
      if (d < 60e3) return '刚刚'
      if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前'
      if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前'
      if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前'
      const t = new Date(ts)
      return `${t.getMonth() + 1}-${String(t.getDate()).padStart(2, '0')}`
    },
    /** 毫秒 → 人类时长 */
    dur(ms) {
      if (ms < 1000) return ms + 'ms'
      if (ms < 60e3) return (ms / 1000).toFixed(1) + 's'
      return Math.floor(ms / 60e3) + 'm' + Math.round((ms % 60e3) / 1000) + 's'
    },
    /** 距未来的倒计时文本 */
    until(ts) {
      const d = ts - Date.now()
      if (d <= 0) return '已到期'
      const dd = Math.floor(d / 86400e3), hh = Math.floor((d % 86400e3) / 3600e3), mm = Math.floor((d % 3600e3) / 60e3), ss = Math.floor((d % 60e3) / 1000)
      if (dd > 0) return `${dd}天${hh}时后`
      if (hh > 0) return `${hh}时${mm}分后`
      if (mm > 0) return `${mm}分${ss}秒后`
      return `${ss}秒后`
    },
    num(n) { return n == null ? '—' : Number(n).toLocaleString('zh-CN') },
    bytes(n) {
      if (n == null) return '—'
      if (n < 1024) return n + ' B'
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1048576).toFixed(1) + ' MB'
    },
    time(iso) { const t = new Date(iso); return t.toTimeString().slice(0, 8) + '.' + String(t.getMilliseconds()).padStart(3, '0') },
    pct(a, b) { return b ? Math.round((a / b) * 100) : 0 },
  }

  /* ---------------- 图标库(24x24 stroke 风格) ---------------- */
  const ICONS = {
    dashboard: 'M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z',
    config: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2.1-1.6-2-3.5-2.5 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.5a7.5 7.5 0 0 0-2 1.2l-2.5-1-2 3.5L4.7 10.8a7.4 7.4 0 0 0 0 2.4l-2.1 1.6 2 3.5 2.5-1a7.5 7.5 0 0 0 2 1.2l.4 2.5h5l.4-2.5a7.5 7.5 0 0 0 2-1.2l2.5 1 2-3.5-2.1-1.6c.06-.4.1-.8.1-1.2Z',
    memory: 'M12 3a7 7 0 0 0-7 7c0 2.4 1.2 4.2 2.6 5.7.9 1 1.4 1.6 1.4 2.3v1h6v-1c0-.7.5-1.3 1.4-2.3C17.8 14.2 19 12.4 19 10a7 7 0 0 0-7-7ZM9 21h6v1H9v-1Z',
    recall: 'M12 8v4l3 3m6-3a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5',
    persona: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m12-14a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    skill: 'm12 2 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8L12 2Z',
    session: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z',
    log: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M9 13h6M9 17h6',
    schedule: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-14v6l4 2',
    confirm: 'M9 12l2 2 4-4m5.6 2A9 9 0 1 1 12 3a9 9 0 0 1 8.6 9Z',
    evolution: 'M12 22c5.5 0 10-4.5 10-10S17.5 2 12 2 2 6.5 2 12c0 1.8.5 3.6 1.3 5.1L2 22l5-1.2c1.5.8 3.2 1.2 5 1.2Zm-3-9 2 2 4-4',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35',
    plus: 'M12 5v14M5 12h14',
    edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7m-1.5-9.5a2.1 2.1 0 0 1 3 3L12 18l-4 1 1-4 9.5-9.5Z',
    trash: 'M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-6 5v6m4-6v6',
    x: 'M18 6 6 18M6 6l12 12',
    check: 'M20 6 9 17l-5-5',
    chevron: 'm6 9 6 6 6-6',
    lock: 'M7 11V7a5 5 0 0 1 10 0v4m-12 0h14v10H5V11Z',
    eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Zm11 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    zap: 'M13 2 3 14h9l-1 8 10-12h-9l1-8Z',
    tool: 'M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.7-3.7Z',
    bot: 'M12 2v3m-7 4h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Zm-3 5v3m20-3v3M9 14v2m6-2v2',
    key: 'm21 2-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78Zm0 0L19 3m-4 4 2 2',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
    warn: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-6v-4m0-4h.01',
    group: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2m22 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m12-14a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2ZM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
    refresh: 'M23 4v6h-6M1 20v-6h6m-3.5-2A9 9 0 0 1 19 7.5L23 10M1 14l4 2.5A9 9 0 0 0 20.5 12',
    send: 'm22 2-7 20-4-9-9-4 20-7Zm0 0L11 13',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm1-10 4 2',
    db: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3Zm9 2c0 1.66-4.03 3-9 3s-9-1.34-9-3m18 5c0 1.66-4.03 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5',
    cpu: 'M9 9h6v6H9zM4 4h16v16H4zM9 1v3m6-3v3M9 20v3m6-3v3M1 9h3m-3 6h3m16-6h3m-3 6h3',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6',
    play: 'm5 3 14 9-14 9V3Z',
    pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
    save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2ZM17 21v-8H7v8M7 3v5h8',
    undo: 'M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 7',
    menu: 'M3 6h18M3 12h18M3 18h18',
  }

  /* ---------------- <v-icon> ---------------- */
  const VIcon = defineComponent({
    name: 'VIcon',
    props: { name: { type: String, required: true }, fill: { type: Boolean, default: false } },
    setup(props) {
      /* width/height 用表现层属性:默认 1em,CSS 类规则可覆盖 */
      return () => h('svg', {
        viewBox: '0 0 24 24', width: '1em', height: '1em',
        fill: props.fill ? 'currentColor' : 'none',
        stroke: props.fill ? 'none' : 'currentColor',
        'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        innerHTML: `<path d="${ICONS[props.name] || ICONS.info}"/>`,
      })
    },
  })

  /* ---------------- <v-switch> ---------------- */
  const VSwitch = defineComponent({
    name: 'VSwitch',
    props: { modelValue: Boolean },
    emits: ['update:modelValue'],
    template: `<label class="switch">
      <input type="checkbox" :checked="!!modelValue" @change="$emit('update:modelValue', $event.target.checked)">
      <span class="slider"></span>
    </label>`,
  })

  /* ---------------- <v-modal> ---------------- */
  const VModal = defineComponent({
    name: 'VModal',
    components: { VIcon },
    props: { title: String, width: { type: String, default: '' }, icon: { type: String, default: '' } },
    emits: ['close'],
    template: `
    <Teleport to="body">
      <Transition name="modal" appear>
        <div class="overlay" @click.self="$emit('close')">
          <div class="modal" :style="width ? {width} : {}">
            <div class="modal-head">
              <slot name="head"><span class="modal-title">{{ title }}</span></slot>
              <button class="modal-x" @click="$emit('close')"><v-icon name="x"/></button>
            </div>
            <div class="modal-body"><slot/></div>
            <div class="modal-foot" v-if="$slots.foot"><slot name="foot"/></div>
          </div>
        </div>
      </Transition>
    </Teleport>`,
  })

  /* ---------------- <masked-value> 脱敏值(§5) ---------------- */
  const MaskedValue = defineComponent({
    name: 'MaskedValue',
    components: { VIcon },
    props: { value: { type: Object, required: true } }, // {configured, preview?}
    template: `
    <span class="masked" :title="value.configured ? '已脱敏:后端绝不返回明文' : '未配置'">
      <v-icon class="lock" name="lock"/>
      <span v-if="value.configured">{{ value.preview || '已配置' }}</span>
      <span v-else class="muted-3">未配置</span>
    </span>`,
  })

  /* ---------------- <ring-progress> 环形进度 ---------------- */
  const RingProgress = defineComponent({
    name: 'RingProgress',
    props: {
      percent: { type: Number, required: true },
      size: { type: Number, default: 132 },
      stroke: { type: Number, default: 11 },
      color: { type: String, default: 'url(#ringGrad)' },
    },
    computed: {
      r() { return (this.size - this.stroke) / 2 },
      c() { return 2 * Math.PI * this.r },
      offset() { return this.c * (1 - Math.min(this.percent, 100) / 100) },
    },
    template: `
    <div class="ring-wrap" :style="{width: size+'px', height: size+'px'}">
      <svg :width="size" :height="size">
        <defs>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#2563eb"/>
          </linearGradient>
        </defs>
        <circle class="ring-track" :cx="size/2" :cy="size/2" :r="r" :stroke-width="stroke"/>
        <circle class="ring-val" :cx="size/2" :cy="size/2" :r="r" :stroke-width="stroke"
          :stroke="color" :stroke-dasharray="c" :stroke-dashoffset="offset"/>
      </svg>
      <div class="ring-center"><slot :percent="percent"/></div>
    </div>`,
  })

  /* ---------------- <count-up> 数字滚动 ---------------- */
  const CountUp = defineComponent({
    name: 'CountUp',
    props: { to: { type: Number, required: true }, dur: { type: Number, default: 900 }, suffix: { type: String, default: '' } },
    setup(props) {
      const val = ref(0)
      const t0 = performance.now()
      const tick = (t) => {
        const p = Math.min((t - t0) / props.dur, 1)
        const e = 1 - Math.pow(1 - p, 3) // easeOutCubic
        val.value = Math.round(props.to * e)
        if (p < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      return () => h('span', { class: 'num' }, val.value.toLocaleString('zh-CN') + props.suffix)
    },
  })

  /* ---------------- <empty-state> ---------------- */
  const EmptyState = defineComponent({
    name: 'EmptyState',
    components: { VIcon },
    props: { icon: { type: String, default: 'db' }, text: { type: String, default: '暂无数据' }, sub: { type: String, default: '' } },
    template: `<div class="empty"><v-icon :name="icon"/><div style="font-weight:700">{{ text }}</div><div v-if="sub" style="font-size:12px">{{ sub }}</div><slot/></div>`,
  })

  /* ---------------- Toast 服务 ---------------- */
  const toastState = reactive({ list: [], seq: 0 })
  function toast(msg, type = 'success', ms = 2600) {
    const id = ++toastState.seq
    toastState.list.push({ id, msg, type })
    setTimeout(() => {
      const i = toastState.list.findIndex((t) => t.id === id)
      if (i > -1) toastState.list.splice(i, 1)
    }, ms)
  }
  const ToastHost = defineComponent({
    name: 'ToastHost',
    components: { VIcon },
    setup() {
      const icons = { success: 'check', warn: 'warn', error: 'x', info: 'info' }
      return { toastState, icons }
    },
    template: `
    <Teleport to="body">
      <div class="toast-wrap">
        <TransitionGroup name="toast">
          <div v-for="t in toastState.list" :key="t.id" class="toast" :class="t.type">
            <v-icon :name="icons[t.type] || 'info'"/><span>{{ t.msg }}</span>
          </div>
        </TransitionGroup>
      </div>
    </Teleport>`,
  })

  /* ---------------- <json-block> JSON 高亮块 ---------------- */
  const JsonBlock = defineComponent({
    name: 'JsonBlock',
    props: { data: null },
    computed: {
      text() {
        try { return typeof this.data === 'string' ? this.data : JSON.stringify(this.data, null, 2) } catch { return String(this.data) }
      },
    },
    template: `<pre class="code">{{ text }}</pre>`,
  })

  /* ---------------- <scope-picker> scope 选择器(§6) ---------------- */
  const ScopePicker = defineComponent({
    name: 'ScopePicker',
    components: { VIcon },
    props: { modelValue: { type: String, required: true } },
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      return { scopes: window.MOCK.scopes, emit }
    },
    template: `
    <div class="scope-bar">
      <span class="muted" style="font-size:12.5px;font-weight:700">数据隔离维度</span>
      <div v-for="s in scopes" :key="s.scopeId" class="scope-pill" :class="{active: s.scopeId === modelValue}"
        @click="emit('update:modelValue', s.scopeId)" :title="s.scopeId">
        <v-icon :name="s.type === 'private' ? 'user' : 'group'"/>
        <span>{{ s.label }}</span>
      </div>
    </div>`,
  })

  window.UI = {
    fmt, toast, toastState,
    register(app) {
      app.component('VIcon', VIcon)
      app.component('VSwitch', VSwitch)
      app.component('VModal', VModal)
      app.component('MaskedValue', MaskedValue)
      app.component('RingProgress', RingProgress)
      app.component('CountUp', CountUp)
      app.component('EmptyState', EmptyState)
      app.component('ToastHost', ToastHost)
      app.component('JsonBlock', JsonBlock)
      app.component('ScopePicker', ScopePicker)
    },
  }
})()
