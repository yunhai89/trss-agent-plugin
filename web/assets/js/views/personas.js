/** 视图:人设库(§2.2 · 内置只读 + 自定义) */
(function () {
  window.VIEWS = window.VIEWS || {}

  const AVA_BG = ['linear-gradient(135deg,#eef0fe,#e2e5fd)', 'linear-gradient(135deg,#e4f8f5,#d3f3ec)', 'linear-gradient(135deg,#fdf3e2,#fbe9c8)', 'linear-gradient(135deg,#fdecef,#fad9e0)', 'linear-gradient(135deg,#e8f6fe,#d3ecfc)']

  window.VIEWS.personas = {
    name: 'PersonasView',
    setup() {
      const { ref, computed, onMounted } = Vue
      const { toast, fmt } = window.UI
      const M = window.MOCK

      const personas = computed(() => M.personas)
      const personaLore = computed(() => M.personaLore || [])
      const loreMap = computed(() => Object.fromEntries(personaLore.value.map((l) => [l.id, l])))
      const loreOf = (p) => (p && p.id ? loreMap.value[p.id] : null) || null
      // 合并结构：有独立草稿时主资料带 .draft 字段；展示以草稿优先（待采纳内容）
      const lorePending = (p) => { const l = loreOf(p); return !!(l && l.draft) }
      const loreView = (p) => { const l = loreOf(p); return l ? (l.draft || l) : null }
      const detail = ref(null)
      const editor = ref({ show: false, idx: -1, form: null })
      const busy = ref('')

      const openCreate = () => {
        editor.value = { show: true, idx: -1, form: { id: '', name: '', description: '', tags: [], avatar: '🙂', greeting: '', systemPrompt: '', builtin: false, creator: '2854196310', createdAt: Date.now() } }
      }
      const openEdit = (p, i) => {
        if (p.builtin) { toast('内置人设为代码常量,只读不可改', 'warn'); return }
        editor.value = { show: true, idx: i, form: JSON.parse(JSON.stringify(p)) }
      }
      const tagInput = ref('')
      const addTag = () => {
        const f = editor.value.form
        const v = tagInput.value.trim()
        if (v && f.tags.length < 8 && !f.tags.includes(v)) f.tags.push(v)
        tagInput.value = ''
      }
      const applyEdit = async () => {
        const f = editor.value.form
        if (!f.name.trim() || !f.systemPrompt.trim()) { toast('名称与 systemPrompt 必填', 'warn'); return }
        const payload = JSON.parse(JSON.stringify(f))
        try {
          if (editor.value.idx === -1) {
            await window.api.post('/personas', payload)
            toast(`人设「${f.name}」已创建`)
          } else {
            await window.api.put(`/personas/${f.id}`, payload)
            toast(`人设「${f.name}」已更新`)
          }
          await window.store.loadPersonas()
          editor.value.show = false
        } catch (e) {
          const msg = e.message || ''
          if (/内置/.test(msg)) toast('内置人设只读', 'warn')
          else toast(msg, 'error')
        }
      }
      const del = async (p, i) => {
        if (p.builtin) { toast('内置人设不可删除', 'warn'); return }
        try {
          await window.api.del(`/personas/${p.id}`)
          await window.store.loadPersonas()
          toast(`已删除人设「${p.name}」`, 'info')
        } catch (e) {
          const msg = e.message || ''
          if (/内置/.test(msg)) toast('内置人设只读', 'warn')
          else toast(msg, 'error')
        }
      }

      onMounted(async () => {
        try { await window.store.loadPersonas() } catch (e) { toast(e.message, 'error') }
        try { await window.store.loadPersonaLore() } catch { /* 兼容旧后端：无人设资料库 */ }
      })

      // —— 人设资料库：补齐 / 采纳 / 丢弃（草稿须采纳才生效）——
      const loadLore = async () => { try { await window.store.loadPersonaLore() } catch { /* noop */ } }
      const doComplete = async (p) => {
        if (busy.value) return
        busy.value = 'complete'
        try { await window.api.post(`/persona-lore/${p.id}/complete`, {}); await loadLore(); toast(`已为「${p.name}」生成补齐草稿，预览后采纳生效`) }
        catch (e) { toast(e.message || '补齐失败', 'error') } finally { busy.value = '' }
      }
      const doAdopt = async (p) => {
        if (busy.value) return
        busy.value = 'adopt'
        try { const r = await window.api.post(`/persona-lore/${p.id}/adopt`, {}); await loadLore(); toast(r?.ingestError ? `已采纳（长尾入库提示：${r.ingestError}）` : '已采纳人设资料，之后使用该人设以已核实事实为先') }
        catch (e) { toast(e.message || '采纳失败', 'error') } finally { busy.value = '' }
      }
      const doDiscard = async (p) => {
        if (busy.value) return
        busy.value = 'discard'
        const wasDraft = lorePending(p)
        try { await window.api.del(`/persona-lore/${p.id}`); await loadLore(); toast(wasDraft ? '已丢弃待审草稿（生效资料保留）' : '已丢弃人设资料', 'info') }
        catch (e) { toast(e.message || '丢弃失败', 'error') } finally { busy.value = '' }
      }

      return { personas, personaLore, loreOf, lorePending, loreView, detail, editor, openCreate, openEdit, tagInput, addTag, applyEdit, del, busy, doComplete, doAdopt, doDiscard, AVA_BG, fmt }
    },
    template: `
    <div>
      <page-head title="人设库" icon="persona" desc="data/personas/&lt;id&gt;.json + data/persona-lore/&lt;id&gt;.json · 内置为代码常量(只读)，可补齐/采纳角色设定资料">
        <button class="btn b-pri" @click="openCreate"><v-icon name="plus"/>新建人设</button>
      </page-head>

      <div class="grid g3 stagger">
        <div v-for="(p, i) in personas" :key="p.id" class="card lift ps-card" :style="{'--i': i + 1}" @click="detail = p">
          <div class="row-b">
            <div class="ps-ava" :style="{background: AVA_BG[i % AVA_BG.length]}">{{ p.avatar }}</div>
            <span v-if="p.builtin" class="pill p-line"><v-icon name="lock"/>内置</span>
            <span v-else class="pill p-vio">自定义</span>
            <span v-if="lorePending(p)" class="pill p-pri" style="font-size:10px">待审草稿</span>
            <span v-else-if="loreOf(p) && loreOf(p).status === 'active'" class="pill p-mint" style="font-size:10px">资料✓</span>
            <span v-else-if="loreOf(p)" class="pill p-pri" style="font-size:10px">资料草稿</span>
          </div>
          <div>
            <div style="font-weight:800;font-size:15px">{{ p.name }}</div>
            <div class="mut" style="font-size:12px;margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">{{ p.description }}</div>
          </div>
          <div class="row g6 wrap">
            <span v-for="t in p.tags" :key="t" class="pill p-pri" style="font-size:10.5px">{{ t }}</span>
          </div>
          <div class="row-b" style="margin-top:auto">
            <span class="mut2" style="font-size:11px">{{ fmt.ago(p.createdAt) }}创建</span>
            <div class="row g6" @click.stop>
              <button class="bic" @click="openEdit(p, i)" :title="p.builtin ? '内置只读' : '编辑'"><v-icon name="edit"/></button>
              <button class="bic dg" @click="del(p, i)"><v-icon name="trash"/></button>
            </div>
          </div>
        </div>
      </div>

      <!-- 详情 -->
      <v-modal v-if="detail" :title="detail.name" icon="persona" width="720px" @close="detail = null">
        <div class="row g14" style="align-items:flex-start">
          <div class="ps-ava" style="width:64px;height:64px;font-size:32px;flex:0 0 64px" :style="{background: AVA_BG[0]}">{{ detail.avatar }}</div>
          <div style="flex:1;min-width:0">
            <div class="row g6 wrap">
              <span class="pill" :class="detail.builtin ? 'p-line' : 'p-vio'">{{ detail.builtin ? '内置(代码常量)' : '自定义 .json' }}</span>
              <span v-for="t in detail.tags" :key="t" class="pill p-pri">{{ t }}</span>
            </div>
            <p class="mut mt8" style="font-size:13px">{{ detail.description }}</p>
          </div>
        </div>
        <div class="hr"></div>
        <div class="field">
          <label class="f-label">开场白 greeting</label>
          <div class="m-b a" style="max-width:100%">{{ detail.greeting }}</div>
        </div>
        <div class="field mt16">
          <label class="f-label">systemPrompt</label>
          <pre class="code" style="white-space:pre-wrap">{{ detail.systemPrompt }}</pre>
        </div>
        <div class="hr"></div>
        <div class="row-b">
          <label class="f-label" style="margin:0">角色设定资料（已核实事实）</label>
          <div class="row g6" style="flex-wrap:wrap">
            <button class="btn b-soft b-sm" :disabled="!!busy" @click="doComplete(detail)"><v-icon name="search"/>{{ busy === 'complete' ? '检索中…' : (loreOf(detail) ? '重取' : '补齐') }}</button>
            <button v-if="loreView(detail) && (lorePending(detail) || loreView(detail).status !== 'active')" class="btn b-pri b-sm" :disabled="!!busy" @click="doAdopt(detail)"><v-icon name="check"/>采纳</button>
            <button v-if="loreView(detail)" class="btn b-line b-sm" :disabled="!!busy" @click="doDiscard(detail)"><v-icon name="trash"/>丢弃</button>
          </div>
        </div>
        <div v-if="!loreView(detail)" class="mut2 mt8" style="font-size:12.5px">暂无资料。点「补齐」让 Agent 检索角色设定并生成草稿（也可在群里发 <span class="mono">#人设补齐 {{ detail.id }}</span>）。</div>
        <template v-else>
          <div class="row g6 wrap mt8">
            <span class="pill" :class="loreView(detail).status === 'active' && !lorePending(detail) ? 'p-mint' : 'p-pri'">{{ lorePending(detail) ? '待采纳草稿' : (loreView(detail).status === 'active' ? '已生效' : '草稿（未生效）') }}</span>
            <span v-if="loreOf(detail) && loreOf(detail).refreshCron" class="pill p-vio">定时：{{ loreOf(detail).refreshCron }}</span>
          </div>
          <p v-if="loreView(detail).summary" class="mut mt8" style="font-size:13px">{{ loreView(detail).summary }}</p>
          <label class="f-label mt16">事实</label>
          <pre class="code" style="white-space:pre-wrap">{{ loreView(detail).facts || '（无）' }}</pre>
          <template v-if="loreView(detail).sources && loreView(detail).sources.length">
            <label class="f-label mt16">出处</label>
            <div v-for="(s, i) in loreView(detail).sources" :key="i" class="mut2" style="font-size:12px">[{{ i + 1 }}] {{ s.title || s.ref }}<span v-if="s.ref && s.title">（{{ s.ref }}）</span></div>
          </template>
        </template>
        <div class="mut2 mt16" style="font-size:11.5px">id: <span class="mono">{{ detail.id }}</span> · creator: {{ detail.creator || '—' }} · {{ new Date(detail.createdAt).toLocaleString('zh-CN') }}</div>
      </v-modal>

      <!-- 编辑/新建 -->
      <v-modal v-if="editor.show" :title="editor.idx === -1 ? '新建人设' : '编辑人设 · ' + editor.form.name" icon="edit" width="720px" @close="editor.show = false">
        <div class="grid g2" style="gap:14px">
          <div class="field"><label class="f-label">名称</label><input class="inp" v-model="editor.form.name"></div>
          <div class="field"><label class="f-label">头像 emoji</label><input class="inp" v-model="editor.form.avatar" maxlength="4"></div>
          <div class="field" style="grid-column:1/-1"><label class="f-label">一句话描述</label><input class="inp" v-model="editor.form.description"></div>
          <div class="field" style="grid-column:1/-1">
            <label class="f-label">标签(≤8,回车添加)</label>
            <div class="row g6 wrap">
              <span v-for="(t, i) in editor.form.tags" :key="t" class="pill p-pri">{{ t }}<v-icon name="x" style="cursor:pointer" @click="editor.form.tags.splice(i, 1)"/></span>
              <input class="inp" style="width:110px;padding:5px 10px;font-size:12px" v-model="tagInput" enterkeyhint="enter" @keydown.enter.prevent="addTag" @keyup.enter.prevent="addTag" placeholder="回车添加">
              <button type="button" class="btn b-soft b-sm" @click="addTag" title="添加"><v-icon name="plus"/></button>
            </div>
          </div>
          <div class="field" style="grid-column:1/-1"><label class="f-label">开场白</label><input class="inp" v-model="editor.form.greeting"></div>
          <div class="field" style="grid-column:1/-1">
            <label class="f-label">systemPrompt</label>
            <textarea class="txa" style="min-height:130px" v-model="editor.form.systemPrompt"></textarea>
          </div>
        </div>
        <template #foot>
          <button class="btn b-line" @click="editor.show = false">取消</button>
          <button class="btn b-pri" @click="applyEdit"><v-icon name="check"/>保存</button>
        </template>
      </v-modal>
    </div>`,
  }
})()
