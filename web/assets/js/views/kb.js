/** 视图:知识库（全局共享文档库，chunk+embedding RAG；支持网页 URL 入库 + 定时刷新） */
;(function () {
  window.VIEWS = window.VIEWS || {}
  window.VIEWS.kb = {
    name: 'KbView',
    setup() {
      const { ref, computed, onMounted } = Vue
      const M = window.MOCK
      const title = ref('')
      const text = ref('')
      const url = ref('')
      const urlTitle = ref('')
      const busy = ref(false)
      const msg = ref('')
      const reload = async () => { try { await window.store.loadKb() } catch { /* noop */ } }
      onMounted(reload)
      const add = async () => {
        if (!text.value.trim()) { msg.value = '请粘贴要入库的文本'; return }
        busy.value = true; msg.value = '入库中（分块 + 向量化）…'
        try {
          const r = await window.api.post('/kb', { title: title.value.trim(), text: text.value })
          msg.value = `✓ 已入库 ${r.id}：${r.chunkCount} 块${r.embedded ? '（已向量化）' : '（未配 embedding，关键词检索）'}`
          title.value = ''; text.value = ''; await reload()
        } catch (e) { msg.value = '入库失败：' + (e?.message || e) }
        finally { busy.value = false }
      }
      const addUrl = async () => {
        if (!url.value.trim()) { msg.value = '请输入网址'; return }
        busy.value = true; msg.value = '抓取入库中（可能需数秒）…'
        try {
          const r = await window.api.post('/kb/url', { url: url.value.trim(), title: urlTitle.value.trim() })
          msg.value = `✓ 已抓取入库 ${r.id}：${r.title}（${r.chunkCount} 块，via ${r.via}）`
          url.value = ''; urlTitle.value = ''; await reload()
        } catch (e) { msg.value = '抓取入库失败：' + (e?.message || e) }
        finally { busy.value = false }
      }
      const refreshDoc = async (id) => {
        busy.value = true; msg.value = `刷新中（${id}）…`
        try {
          const r = await window.api.post('/kb/' + id + '/refresh', {})
          msg.value = `✓ 已刷新 ${id}：${r.chunkCount} 块（via ${r.via}）`; await reload()
        } catch (e) { msg.value = '刷新失败：' + (e?.message || e) }
        finally { busy.value = false }
      }
      const remove = async (id) => {
        if (!confirm(`删除文档 ${id}？`)) return
        try { await window.api.del('/kb/' + id); msg.value = '已删除'; await reload() }
        catch (e) { msg.value = '删除失败：' + (e?.message || e) }
      }
      const rebuild = async () => {
        busy.value = true; msg.value = '重建索引中…'
        try { const r = await window.api.post('/kb/rebuild', {}); msg.value = `✓ 重建 ${r.rebuilt} 块` }
        catch (e) { msg.value = '重建失败：' + (e?.message || e) }
        finally { busy.value = false; await reload() }
      }
      const dateStr = (t) => t ? new Date(t).toLocaleString('zh-CN') : ''
      // docs 用计算属性：loadKb 会整体替换 MOCK.kb 数组，直接捕获会拿到空壳
      return { docs: computed(() => M.kb || []), title, text, url, urlTitle, busy, msg, add, addUrl, refreshDoc, remove, rebuild, dateStr }
    },
    template: `
    <div>
      <page-head title="知识库" icon="book" desc="全局共享文档库 · chunk + embedding 向量化 · 对话时 Agent 调 kb_search 检索（RAG）；支持网页 URL 入库 + 定时拉取最新">
        <button class="btn b-line" @click="rebuild" :disabled="busy"><v-icon name="refresh"/>重建索引</button>
      </page-head>

      <div class="grid g2">
        <div class="card pad lift" style="--i:1">
          <div class="ct mb12">
            <span class="ct-ico" style="background:var(--grad-sky)"><v-icon name="globe"/></span>
            <div><div class="ct-t">添加网页 URL</div><div class="ct-s">自动抓取正文 → 分块入库</div></div>
          </div>
          <div class="col" style="gap:8px">
            <input class="inp" v-model="url" placeholder="https://example.com/article">
            <input class="inp" v-model="urlTitle" placeholder="标题（可选，留空用页面标题）">
            <div class="row-b wrap g8">
              <span class="mut2" style="font-size:11.5px">可用 #知识库定时 &lt;id&gt; 每天8点 设定时刷新</span>
              <button class="btn b-pri b-sm" @click="addUrl" :disabled="busy"><v-icon name="globe"/>抓取入库</button>
            </div>
          </div>
        </div>

        <div class="card pad lift" style="--i:2">
          <div class="ct mb12">
            <span class="ct-ico" style="background:var(--grad-mint)"><v-icon name="file"/></span>
            <div><div class="ct-t">添加文档</div><div class="ct-s">粘贴文本 · 长文自动分块向量化</div></div>
          </div>
          <div class="col" style="gap:8px">
            <input class="inp" v-model="title" placeholder="标题（可选，留空自动命名）">
            <textarea class="txa mono" style="height:88px" v-model="text" placeholder="粘贴文档全文（FAQ / 资料 / 设定等）"></textarea>
            <div class="row-b wrap g8">
              <span class="mut2" style="font-size:11.5px">{{ msg }}</span>
              <button class="btn b-pri b-sm" @click="add" :disabled="busy"><v-icon name="plus"/>入库</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card mt16" style="--i:3;overflow:hidden">
        <div class="ct" style="padding:16px 20px">
          <span class="ct-ico" style="background:var(--grad)"><v-icon name="db"/></span>
          <div><div class="ct-t">已入库文档</div><div class="ct-s">{{ docs.length }} 篇 · 🌐 网页 / 📄 文本</div></div>
        </div>
        <div class="tbl-w">
        <table class="tbl">
          <thead><tr><th>标题</th><th style="width:120px">ID</th><th style="width:60px">分块</th><th style="width:150px">定时 / 刷新</th><th style="width:110px">操作</th></tr></thead>
          <tbody>
            <tr v-for="d in docs" :key="d.id">
              <td>
                <span>{{ d.url ? '🌐' : '📄' }}</span> {{ d.title }}
                <div v-if="d.url" class="mut2" style="font-size:11px;word-break:break-all">{{ d.url }}</div>
              </td>
              <td class="mono mut" style="font-size:11px">{{ d.id }}</td>
              <td><span class="pill">{{ d.chunkCount }}</span></td>
              <td class="mut" style="font-size:11px">
                <span v-if="d.refreshCron">⏰ {{ d.refreshCron }}</span>
                <span v-else class="mut2">—</span>
                <div v-if="d.lastCrawled" class="mut2">刷新 {{ dateStr(d.lastCrawled) }}</div>
                <div class="mut2">入库 {{ dateStr(d.createdAt) }}</div>
              </td>
              <td>
                <button v-if="d.url" class="bic" @click="refreshDoc(d.id)" :disabled="busy" title="刷新最新内容"><v-icon name="refresh"/></button>
                <button class="bic dg" @click="remove(d.id)" title="删除"><v-icon name="trash"/></button>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <empty-state v-if="!docs.length" icon="book" text="暂无文档" sub="上方粘贴文本或添加 URL，或 #知识库添加 命令"/>
      </div>
    </div>`,
  }
})()
