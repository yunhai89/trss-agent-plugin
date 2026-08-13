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
      const detail = ref(null)
      const editor = ref({ show: false, idx: -1, form: null })

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

      onMounted(async () => { try { await window.store.loadPersonas() } catch (e) { toast(e.message, 'error') } })

      return { personas, detail, editor, openCreate, openEdit, tagInput, addTag, applyEdit, del, AVA_BG, fmt }
    },
    template: `
    <div>
      <page-head title="人设库" icon="persona" desc="data/personas/&lt;id&gt;.json · 内置为代码常量(只读)，自定义可编辑">
        <button class="btn b-pri" @click="openCreate"><v-icon name="plus"/>新建人设</button>
      </page-head>

      <div class="grid g3 stagger">
        <div v-for="(p, i) in personas" :key="p.id" class="card lift ps-card" :style="{'--i': i + 1}" @click="detail = p">
          <div class="row-b">
            <div class="ps-ava" :style="{background: AVA_BG[i % AVA_BG.length]}">{{ p.avatar }}</div>
            <span v-if="p.builtin" class="pill p-line"><v-icon name="lock"/>内置</span>
            <span v-else class="pill p-vio">自定义</span>
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
