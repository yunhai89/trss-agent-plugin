/**
 * 视图:外置工具（tools/<包>/tool.config.js 约定）
 *
 * 列表页只展示每个工具包的基础信息卡片（图标/名称/介绍/作者/版本）；
 * 点击卡片或「配置」按钮单独打开配置弹窗（字段按 schema 动态渲染）。
 * 数据：GET /api/tool-packs；保存：PUT /api/config（agent.tools.<包名>.<key>），热加载即时生效。
 */
(function () {
  window.VIEWS = window.VIEWS || {}

  /* 行容器（共享实现见 components.js UI.makeCfgRow）：必须按视图局部注册 */
  const CfgRow = window.UI.makeCfgRow()

  window.VIEWS.toolpacks = {
    name: 'ToolPacksView',
    components: { CfgRow },
    setup() {
      const { ref, reactive, onMounted } = Vue
      const packs = ref([])
      const state = reactive({}) // 包名 → 当前表单值
      const active = ref(null) // 当前打开配置的包
      const loading = ref(false)

      const defaultsOf = (pack) => {
        const out = {}
        for (const f of pack.config || []) out[f.key] = pack.values?.[f.key] !== undefined ? pack.values[f.key] : f.default
        return out
      }
      const ensure = (pack) => { if (!state[pack.name]) state[pack.name] = defaultsOf(pack); return state[pack.name] }
      const load = async () => {
        loading.value = true
        try {
          const list = (await window.store.loadToolPacks()) || []
          for (const p of list) ensure(p)
          packs.value = list
        } catch (e) { window.toast?.(e?.message || '加载失败', 'error') } finally { loading.value = false }
      }
      const openCfg = (p) => { ensure(p); active.value = p }
      const closeCfg = () => { active.value = null }
      const dirty = (p) => JSON.stringify(state[p.name]) !== JSON.stringify(defaultsOf(p))
      const reset = (p) => { state[p.name] = defaultsOf(p); window.toast?.('已还原', 'info') }
      const save = async (p) => {
        const changes = {}
        for (const f of p.config || []) changes[`agent.tools.${p.name}.${f.key}`] = state[p.name][f.key]
        try {
          await window.api.put('/config', { changes })
          await load()
          window.toast?.('已保存（已热加载）', 'success')
          closeCfg()
        } catch (e) { window.toast?.(e?.message || '保存失败', 'error') }
      }
      const iconUrl = (p) => /^(https?:|data:)/i.test(p.info?.icon || '')

      onMounted(load)
      return { packs, state, active, loading, load, dirty, reset, save, openCfg, closeCfg, iconUrl }
    },
    template: `
    <div>
      <page-head title="外置工具" icon="tool" desc="tools/ 目录下自研工具（tool.config.js 约定）· 点击卡片打开配置">
        <button class="btn b-sm" @click="load"><v-icon name="refresh"/>刷新</button>
      </page-head>

      <div v-if="!packs.length" class="card" style="--i:1;padding:8px">
        <empty-state icon="tool" text="未发现外置工具" sub="把工具包放进插件 tools/ 目录，并在其内提供 tool.config.js（含 info 与 config schema）"/>
      </div>

      <div v-for="(p, i) in packs" :key="p.name" class="card" :style="{'--i': i + 1, cursor: 'pointer'}" @click="openCfg(p)">
        <div class="cf-sh" style="cursor:pointer">
          <span class="ct-ico" style="background:var(--grad-vio)">
            <img v-if="iconUrl(p)" :src="p.info.icon" alt="" style="width:20px;height:20px;object-fit:contain"/>
            <v-icon v-else :name="p.info.icon || 'tool'"/>
          </span>
          <div style="flex:1;min-width:0">
            <div class="ct-t">{{ p.info.title || p.name }} <span class="mut2 mono" style="font-size:11px;font-weight:500">{{ p.name }}<template v-if="p.info.version"> · v{{ p.info.version }}</template></span></div>
            <div class="ct-s">{{ p.info.description || '（无描述）' }}<template v-if="p.info.author"> · 作者：{{ p.info.author }}</template></div>
          </div>
          <div class="row g6" @click.stop>
            <a v-if="p.info.homepage" :href="p.info.homepage" target="_blank" rel="noopener" class="btn b-sm"><v-icon name="globe"/>主页</a>
            <button class="btn b-pri b-sm" @click="openCfg(p)"><v-icon name="config"/>配置</button>
          </div>
        </div>
      </div>

      <v-modal v-if="active" :title="(active.info.title || active.name) + ' · 配置'" icon="config" center width="720px" @close="closeCfg">
        <div class="desc mb10" v-if="active.info.description">
          {{ active.info.description }}<template v-if="active.info.author"> · 作者：{{ active.info.author }}</template>
          <span class="mut2 mono">（{{ active.name }}<template v-if="active.info.version"> v{{ active.info.version }}</template>）</span>
        </div>
        <div v-if="!active.config.length" class="desc">该工具未声明配置项（tool.config.js 的 config 为空）。</div>
        <div class="cf-grid" v-else>
          <cfg-row v-for="f in active.config" :key="f.key" :name="f.label || f.key" :desc="f.description || ('agent.tools.' + active.name + '.' + f.key)" :full="f.type === 'text' || f.type === 'json'">
            <v-switch v-if="f.type === 'boolean'" v-model="state[active.name][f.key]"/>
            <select v-else-if="f.type === 'enum'" class="inp" style="width:200px" v-model="state[active.name][f.key]">
              <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <input v-else-if="f.type === 'number'" type="number" class="inp" style="width:130px" :min="f.min" :max="f.max" :step="f.step" v-model.number="state[active.name][f.key]">
            <textarea v-else-if="f.type === 'text' || f.type === 'json'" class="inp mono" style="width:100%;min-height:54px" :placeholder="f.placeholder || ''" v-model="state[active.name][f.key]"></textarea>
            <input v-else class="inp mono" style="width:260px" :placeholder="f.placeholder || ''" v-model="state[active.name][f.key]">
          </cfg-row>
        </div>
        <template #foot>
          <button class="btn b-line" @click="reset(active)"><v-icon name="undo"/>还原</button>
          <button class="btn b-pri" :disabled="!dirty(active)" @click="save(active)"><v-icon name="save"/>保存并热加载</button>
        </template>
      </v-modal>
    </div>`,
  }
})()
