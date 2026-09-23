/** 视图:表情包（独立页）—— 配置 + 库概览
 *  配置读/写 agent.sticker.* （经 /api/config 点路径 changes，与配置中心同机制）。
 *  库概览读 GET /api/sticker（统计/目录启停），目录启停 POST /api/sticker/dir-toggle。
 *  含「自动发现」（MaiBot 式被动采集）配置。
 */
(function () {
  window.VIEWS = window.VIEWS || {}

  /* 行容器（共享实现见 components.js UI.makeCfgRow） */
  const CfgRow = window.UI.makeCfgRow()

  /* 标签编辑器（数组字段：discoverGroups） */
  const TagEditor = {
    name: 'TagEditor',
    props: { modelValue: { type: Array, required: true }, placeholder: { type: String, default: '回车添加' }, mono: { type: Boolean, default: false } },
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      const input = Vue.ref('')
      const add = () => {
        const v = input.value.trim()
        if (v && !props.modelValue.includes(v)) emit('update:modelValue', [...props.modelValue, v])
        input.value = ''
      }
      const del = (i) => emit('update:modelValue', props.modelValue.filter((_, j) => j !== i))
      return { input, add, del }
    },
    template: `
    <div class="row g6 wrap" :style="'justify-content:flex-end' + (mono ? ';font-family:var(--mono,monospace)' : '')">
      <span v-for="(t, i) in modelValue" :key="t + i" class="pill p-pri" style="cursor:default" :class="{mono: mono}">
        {{ t }}<v-icon name="x" style="cursor:pointer" @click="del(i)"/>
      </span>
      <input v-model="input" class="inp" :class="{mono: mono}" style="width:120px;padding:5px 10px;font-size:12px" :placeholder="placeholder" enterkeyhint="enter" @keydown.enter.prevent="add" @keyup.enter.prevent="add">
      <button type="button" class="btn b-soft b-sm" @click="add" title="添加"><v-icon name="plus"/></button>
    </div>`,
  }

  /* 默认值兜底（与 config.yaml agent.sticker 段对齐；旧 config 缺字段时防 v-model 报错） */
  const DEFAULTS = {
    enable: false,
    maxPerReply: 2, cooldown: 300, sendRate: 0.25, antiConsecutive: true, groupOnly: false,
    listTopN: 30,
    autoDiscover: false, discoverGroups: [], maxDiscovered: 200, discoverMaxSizeMB: 5,
    sendStickerTool: true,
  }

  window.VIEWS.sticker = {
    name: 'StickerView',
    components: { CfgRow, TagEditor },
    setup() {
      const { ref, reactive, watch, computed, onMounted, nextTick } = Vue
      const { toast } = window.UI
      const M = window.MOCK

      const form = reactive({})
      let origSnapshot = {}
      const dirty = ref(false)
      let dirtySuppressed = true
      watch(form, () => { if (!dirtySuppressed) dirty.value = true }, { deep: true })

      /* 库概览（独立于配置 form，只读 + 目录启停） */
      const lib = reactive({ loading: false, data: null, error: '' })
      const refreshLib = async () => {
        lib.loading = true; lib.error = ''
        try {
          await window.store.loadStickerLib()
          lib.data = M.stickerLib
        } catch (e) { lib.error = e?.message || String(e) }
        finally { lib.loading = false }
      }
      const withDefaults = (h) => {
        const merge = (base, over) => {
          const out = Array.isArray(base) ? [...base] : { ...base }
          for (const k of Object.keys(base)) {
            if (over && typeof over[k] !== 'undefined' && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
              out[k] = merge(base[k], over[k])
            } else if (over && typeof over[k] !== 'undefined') {
              out[k] = over[k]
            }
          }
          return out
        }
        return merge(DEFAULTS, h || {})
      }

      const syncForm = (snap) => {
        dirtySuppressed = true
        const detached = withDefaults(JSON.parse(JSON.stringify(snap || {})))
        for (const k of Object.keys(form)) delete form[k]
        Object.assign(form, detached)
        origSnapshot = JSON.parse(JSON.stringify(form))
        dirty.value = false
        nextTick(() => { dirtySuppressed = false })
      }

      /* 点路径 diff（前缀 agent.sticker） */
      const buildChanges = (orig, frm, prefix = 'agent.sticker', out = {}) => {
        for (const k of Object.keys(frm)) {
          const p = prefix + '.' + k, a = orig?.[k], b = frm[k]
          if (b && typeof b === 'object' && !Array.isArray(b) && a && typeof a === 'object') buildChanges(a, b, p, out)
          else if (JSON.stringify(a) !== JSON.stringify(b)) out[p] = b
        }
        return out
      }

      const save = async () => {
        const changes = buildChanges(origSnapshot, JSON.parse(JSON.stringify(form)))
        if (!Object.keys(changes).length) { toast('无改动', 'warn'); return }
        try {
          await window.api.put('/config', { changes })
          await window.store.loadConfig()
          if (M.config?.sticker) syncForm(M.config.sticker)
          toast('已保存（已热加载）', 'success')
          await refreshLib() // 启用状态等可能变化
        } catch (e) { toast(e.message, 'error') }
      }
      const reset = () => {
        dirtySuppressed = true
        for (const k of Object.keys(form)) delete form[k]
        Object.assign(form, JSON.parse(JSON.stringify(origSnapshot)))
        dirty.value = false
        nextTick(() => { dirtySuppressed = false })
        toast('已还原为当前生效配置', 'info')
      }

      const sections = [
        { id: 'basic', name: '基础 / 总开关', icon: 'smile', grad: 'var(--grad-honey)' },
        { id: 'send', name: '发送策略', icon: 'send', grad: 'var(--grad-sky)' },
        { id: 'discover', name: '自动发现', icon: 'bot', grad: 'var(--grad-rose)' },
        { id: 'lib', name: '表情包库', icon: 'image', grad: 'var(--grad)' },
      ]
      const open = reactive(Object.fromEntries(sections.map((s) => [s.id, s.id === 'basic'])))
      const activeSec = ref('basic')
      const jump = (id) => {
        open[id] = true
        activeSec.value = id
        document.getElementById('sk-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      const onScroll = () => {
        for (const s of sections) {
          const el = document.getElementById('sk-' + s.id)
          if (el && el.getBoundingClientRect().top > 60 && el.getBoundingClientRect().top < 240) { activeSec.value = s.id; break }
        }
      }

      const sendRatePct = computed(() => (form.sendRate || 0) * 100 + '%')

      onMounted(async () => {
        window.addEventListener('scroll', onScroll, { passive: true })
        try {
          await window.store.loadConfig()
          if (M.config) syncForm(M.config.sticker)
        } catch (e) { toast(e.message, 'error') }
        refreshLib()
      })
      window.removeEventListener('scroll', onScroll)

      return {
        form, dirty, save, reset, sections, open, activeSec, jump,
        sendRatePct, lib, refreshLib,
      }
    },
    template: `
    <div class="cf-wrap">
      <div class="cf-nav">
        <a v-for="s in sections" :key="s.id" :class="{on: activeSec === s.id}" @click="jump(s.id)">{{ s.name }}</a>
      </div>

      <div>
        <!-- 说明条 -->
        <div class="note">
            <v-icon name="smile" />
            <div>
              <b>表情包</b>：reply 时按情绪/语境贴图。资源仅来自<b>自动发现</b>（MaiBot 式）：被动采集群内图片 → 视觉判定+打标 → 入库。
              <span class="mut2">未启用时零影响（不注入清单、不解析）。命令：<code>#表情包状态</code> / <code>#表情包开启</code>。</span>
            </div>
        </div>

        <!-- ===== 基础 / 总开关 ===== -->
        <div :id="'sk-basic'" class="card cf-sec" :class="{open: open.basic}">
          <div class="cf-sh" @click="open.basic = !open.basic">
            <span class="ct-ico" style="background:var(--grad-honey)"><v-icon name="smile"/></span>
            <div><div class="ct-t">基础 / 总开关</div><div class="ct-s">总开关、清单注入</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.basic"><div class="cf-grid">
            <cfg-row name="启用表情包" desc="未启用 → 不注入清单、不解析贴图标记（零影响）">
              <v-switch v-model="form.enable"/>
            </cfg-row>
            <cfg-row name="清单注入上限" desc="prompt 注入的清单条数上限（listTopN）">
              <input type="number" class="inp" style="width:110px" min="5" max="200" v-model.number="form.listTopN">
            </cfg-row>
            <cfg-row name="仅群聊启用" desc="开=私聊不贴图">
              <v-switch v-model="form.groupOnly"/>
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== 发送策略 ===== -->
        <div :id="'sk-send'" class="card cf-sec" :class="{open: open.send}">
          <div class="cf-sh" @click="open.send = !open.send">
            <span class="ct-ico" style="background:var(--grad-sky)"><v-icon name="send"/></span>
            <div><div class="ct-t">发送策略</div><div class="ct-s">频率/概率闸门，避免每条都带图</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.send"><div class="cf-grid">
            <cfg-row name="单条最多贴图数" desc="单条回复最多贴的贴纸数（maxPerReply）">
              <input type="number" class="inp" style="width:90px" min="0" max="5" v-model.number="form.maxPerReply">
            </cfg-row>
            <cfg-row name="带图冷却(秒)" desc="同会话两次带图回复最小间隔（cooldown）">
              <input type="number" class="inp" style="width:110px" min="0" max="3600" v-model.number="form.cooldown">
            </cfg-row>
            <cfg-row name="带图概率 sendRate" desc="门控通过后实际带图概率（防每条都带 → 更像人）">
              <div class="row g10" style="width:200px">
                <input type="range" class="rng" min="0" max="1" step="0.05" v-model.number="form.sendRate" :style="{'--fill': sendRatePct}">
                <b class="num" style="width:34px;text-align:right">{{ Number(form.sendRate||0).toFixed(2) }}</b>
              </div>
            </cfg-row>
            <cfg-row name="防连发" desc="开=上一条带过则本条不带（antiConsecutive）">
              <v-switch v-model="form.antiConsecutive"/>
            </cfg-row>
            <cfg-row name="send_sticker 工具" desc="注册 send_sticker：按情绪跨全库选图（不受目录 top-N 限制）">
              <v-switch v-model="form.sendStickerTool"/>
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== 自动发现 ===== -->
        <div :id="'sk-discover'" class="card cf-sec" :class="{open: open.discover}">
          <div class="cf-sh" @click="open.discover = !open.discover">
            <span class="ct-ico" style="background:var(--grad-rose)"><v-icon name="bot"/></span>
            <div><div class="ct-t">自动发现（MaiBot 式）</div><div class="ct-s">被动采集群内 image 段 → 视觉判定+打标 → 入库</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.discover"><div class="cf-grid">
            <cfg-row name="自动发现" desc="需 sticker.enable + 视觉模型（agent.vision）。开=采集群内 image 段">
              <v-switch v-model="form.autoDiscover"/>
            </cfg-row>
            <cfg-row full name="采集群白名单" desc="群号字符串；空数组=所有群都采集">
              <tag-editor v-model="form.discoverGroups" placeholder="群号回车" :mono="true"/>
            </cfg-row>
            <cfg-row name="采集上限" desc="自动发现条目上限（maxDiscovered）；超限按 usageCount 升序淘汰冷门">
              <input type="number" class="inp" style="width:110px" min="10" max="2000" v-model.number="form.maxDiscovered">
            </cfg-row>
            <cfg-row name="单张大小上限(MB)" desc="0=不限（discoverMaxSizeMB）">
              <input type="number" class="inp" style="width:110px" min="0" max="50" v-model.number="form.discoverMaxSizeMB">
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== 表情包库（概览，只读 + 目录启停） ===== -->
        <div :id="'sk-lib'" class="card cf-sec" :class="{open: open.lib}">
          <div class="cf-sh" @click="open.lib = !open.lib">
            <span class="ct-ico" style="background:var(--grad)"><v-icon name="info"/></span>
            <div><div class="ct-t">表情包库</div><div class="ct-s">已入库统计（只读概览）</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.lib">
            <div class="row g10" style="align-items:center;margin-bottom:12px">
              <button class="btn b-line" @click="refreshLib" :disabled="lib.loading"><v-icon name="refresh"/> 刷新</button>
              <span v-if="lib.loading" class="mut">加载中…</span>
              <span v-if="lib.error" style="color:var(--rose);font-size:12px"><v-icon name="warn"/> {{ lib.error }}</span>
            </div>
            <div v-if="lib.data" class="cf-grid">
              <cfg-row name="总开关状态" desc="当前 sticker.enable">
                <span class="pill" :class="lib.data.enabled ? 'chip-green' : 'chip-rose'">{{ lib.data.enabled ? '已启用' : '未启用' }}</span>
              </cfg-row>
              <cfg-row name="入库总数 / 自动采集" desc="index 内 sticker 总数；其中 source=discovered（自动发现）计数">
                <b class="num">{{ lib.data.total }}</b><span class="mut" style="margin:0 8px">/</span><b class="num">{{ lib.data.discovered }}</b>
              </cfg-row>
            </div>
            <div v-else-if="!lib.loading && !lib.error" class="mut2" style="font-size:12px">点「刷新」加载库数据。</div>
          </div>
        </div>

        <!-- 保存条 -->
        <!-- 保存栏 -->
        <Transition name="fade">
          <div v-if="dirty" class="savebar">
            <span class="dirty-dot"></span>
            <span style="font-weight:700;font-size:13px">有未保存的修改</span>
            <div class="row g10" style="margin-left:auto">
              <button class="btn b-line" @click="reset"><v-icon name="undo"/>还原</button>
              <button class="btn b-pri" @click="save"><v-icon name="save"/>保存（热加载）</button>
            </div>
          </div>
        </Transition>
      </div>
    </div>`,
  }
})()
