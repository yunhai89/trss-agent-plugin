/** 视图:QQ 官方机器人账号（自实现适配器 · AppID + AppSecret 直连） */
;(function () {
  window.VIEWS = window.VIEWS || {}

  const STATUS_CN = {
    ready: '已连接', open: '已连接', connecting: '连接中', connecting_retry: '重连中',
    closed: '已关闭', stopped: '已停止', idle: '未连接', auth_failed: '鉴权失败',
  }
  const STATUS_CLASS = {
    ready: 'p-green', open: 'p-green', connecting: 'p-honey', closed: 'p-rose', stopped: 'p-mute', idle: 'p-mute', auth_failed: 'p-rose',
  }

  /* 行容器（与 humanize/groupworld/sticker 同：共享实现见 components.js UI.makeCfgRow） */
  const CfgRow = window.UI.makeCfgRow()

  window.VIEWS.qqbot = {
    name: 'QqbotView',
    components: { CfgRow },
    setup() {
      const { ref, computed, onMounted, reactive } = Vue
      const { toast } = window.UI

      const data = ref({ enable: false, adapterReady: false, accounts: [], connected: 0, total: 0 })
      const loading = ref(false)
      const busy = ref('')
      const showForm = ref(false)
      const editing = ref(null) // 正在编辑的 appId；null=新增
      const form = reactive({ appId: '', appSecret: '', name: '', sandbox: false, intents: 0, markdown: 'auto', preferMarkdownText: false })
      const reveal = reactive({}) // appId -> 是否显示密钥说明（实际不含明文）

      const load = async () => {
        loading.value = true
        try { data.value = await window.api.get('/qqbot') }
        catch (e) { toast(e.message, 'error') }
        finally { loading.value = false }
      }
      onMounted(load)

      const accounts = computed(() => data.value.accounts || [])
      const connectedCount = computed(() => accounts.value.filter((a) => a.status && (a.status.connected || a.status.state === 'ready')).length)

      const statusOf = (a) => a.status || null
      const statusState = (a) => (a.status && (a.status.state || (a.status.connected ? 'ready' : 'idle'))) || 'idle'
      const statusCn = (a) => {
        const st = statusOf(a)
        if (!st) return '未连接'
        if (st.reason === 'auth_failed') return '鉴权失败（检查 AppID/AppSecret）'
        return STATUS_CN[st.state] || (st.connected ? '已连接' : st.state || '未连接')
      }
      const statusClass = (a) => {
        const st = statusOf(a)
        if (!st) return 'p-mute'
        if (st.reason === 'auth_failed') return 'p-rose'
        return STATUS_CLASS[st.state] || (st.connected ? 'p-green' : 'p-mute')
      }
      const sessionShort = (a) => {
        const sid = a.status && a.status.sessionId
        return sid ? String(sid).slice(0, 8) + '…' : ''
      }
      const connectedAtStr = (a) => {
        const ts = a.status && (a.status.readyAt || a.status.connectedAt)
        return ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
      }
      const markdownCn = (a) => {
        if (a.markdown === 'false') return '纯文本'
        if (a.markdown === 'true') return '总是 Markdown'
        return a.status && a.status.markdownUsable === false ? 'auto（平台未开通→纯文本）' : 'auto'
      }

      const openAdd = () => {
        editing.value = null
        Object.assign(form, { appId: '', appSecret: '', name: '', sandbox: false, intents: 0, markdown: 'auto', preferMarkdownText: false })
        showForm.value = true
      }
      const openEdit = (a) => {
        editing.value = a.appId
        Object.assign(form, {
          appId: a.appId,
          appSecret: '', // 编辑时不回显；留空=保持原值
          name: a.name || '',
          sandbox: !!a.sandbox,
          intents: Number(a.intents) || 0,
          markdown: a.markdown || 'auto',
          preferMarkdownText: !!a.preferMarkdownText,
        })
        showForm.value = true
      }
      const closeForm = () => { showForm.value = false; editing.value = null }

      const save = async () => {
        if (!/^\d{4,}$/.test(String(form.appId || '').trim())) { toast('appId 应为纯数字（QQ 开放平台 → 开发设置）', 'warn'); return }
        if (!editing.value && !String(form.appSecret || '').trim()) { toast('新增账号必须填 AppSecret', 'warn'); return }
        busy.value = 'save'
        const body = {
          appId: String(form.appId).trim(),
          appSecret: String(form.appSecret || '').trim(),
          name: String(form.name || '').trim(),
          sandbox: !!form.sandbox,
          intents: Number(form.intents) || 0,
          markdown: form.markdown,
          preferMarkdownText: !!form.preferMarkdownText,
        }
        try {
          const r = editing.value
            ? await window.api.put('/qqbot/accounts/' + encodeURIComponent(editing.value), body)
            : await window.api.post('/qqbot/accounts', body)
          data.value = r
          toast(editing.value ? '账号已更新并重连' : '账号已添加，正在连接…', 'success')
          closeForm()
          // 连接是异步的：稍后再刷新一次状态
          setTimeout(load, 1500)
        } catch (e) { toast(e.message, 'error') }
        finally { busy.value = '' }
      }

      const connect = async (a) => {
        busy.value = a.appId
        try { data.value = await window.api.post('/qqbot/accounts/' + encodeURIComponent(a.appId) + '/connect'); toast('已发起连接', 'success'); setTimeout(load, 1200) }
        catch (e) { toast(e.message, 'error') }
        finally { busy.value = '' }
      }
      const disconnect = async (a) => {
        const okDel = await window.UI.confirm({ title: '断开账号', message: `断开 <b>${a.name}（${a.appId}）</b> 的网关连接？<br>断开后该机器人收不到消息，可随时重连。` })
        if (!okDel) return
        busy.value = a.appId
        try { data.value = await window.api.post('/qqbot/accounts/' + encodeURIComponent(a.appId) + '/disconnect'); toast('已断开', 'info') }
        catch (e) { toast(e.message, 'error') }
        finally { busy.value = '' }
      }
      const remove = async (a) => {
        const okDel = await window.UI.confirm({
          title: '删除账号', danger: true, confirmText: '删除账号',
          message: `将从配置中删除 <b>${a.name}（${a.appId}）</b> 并断开连接。AppSecret 一并删除，不可恢复。`,
        })
        if (!okDel) return
        busy.value = a.appId
        try { data.value = await window.api.del('/qqbot/accounts/' + encodeURIComponent(a.appId)); toast('账号已删除', 'success') }
        catch (e) { toast(e.message, 'error') }
        finally { busy.value = '' }
      }
      const reloadAll = async () => {
        busy.value = 'reload'
        try { data.value = await window.api.post('/qqbot/reload'); toast('已按当前配置重连', 'success'); setTimeout(load, 1500) }
        catch (e) { toast(e.message, 'error') }
        finally { busy.value = '' }
      }
      const copy = async (text) => {
        try { await navigator.clipboard.writeText(text); toast('已复制', 'success') }
        catch { toast('复制失败，请手动选择', 'warn') }
      }

      return {
        data, loading, busy, showForm, editing, form, reveal,
        accounts, connectedCount,
        statusOf, statusState, statusCn, statusClass, sessionShort, connectedAtStr, markdownCn,
        openAdd, openEdit, closeForm, save, connect, disconnect, remove, reloadAll, copy, load,
      }
    },
    template: `
    <div>
      <page-head title="QQ 官方机器人账号" icon="bot" desc="自实现适配器：只需 AppID + AppSecret 直连官方网关（无需机器人 QQ 号与 Token）。与 Yunzai-QQBot-Plugin 二选一，否则同一条机器人会重复收发">
        <button class="btn b-line" @click="load" :disabled="loading"><v-icon name="refresh"/>刷新状态</button>
        <button class="btn b-line" @click="reloadAll" :disabled="busy === 'reload'"><v-icon name="refresh"/>重连全部</button>
        <button class="btn b-pri" @click="openAdd"><v-icon name="plus"/>添加账号</button>
      </page-head>

      <div class="grid g2" style="margin-bottom:12px">
        <div class="card pad lift" style="--i:1">
          <div class="row-b mb8">
            <div class="ct">
              <span class="ct-ico" style="background:var(--grad-sky)"><v-icon name="bot"/></span>
              <div><div class="ct-t">适配器状态</div><div class="ct-s">WebSocket 网关 + v2 REST 自实现</div></div>
            </div>
            <span class="pill" :class="data.adapterReady ? 'p-green' : 'p-rose'">{{ data.adapterReady ? '已就绪' : '未初始化' }}</span>
          </div>
          <div class="row g6 wrap" style="font-size:12.5px">
            <span class="pill" :class="data.enable ? 'p-green' : 'p-mute'">适配器开关：{{ data.enable ? '开' : '关' }}</span>
            <span class="pill p-sky">已连接 {{ connectedCount }} / {{ data.total }}</span>
            <span class="pill p-mute">账号 {{ data.total }} 个</span>
          </div>
          <div v-if="!data.adapterReady" class="mut2" style="font-size:12px;margin-top:8px">
            适配器未初始化：需在 Yunzai 进程内运行（本页面在独立 Web 服务里只读配置）。首次启用后重启 Yunzai 生效。
          </div>
          <div v-else-if="!data.enable" class="mut2" style="font-size:12px;margin-top:8px">
            适配器开关为关：添加账号会自动开启；也可在「配置中心 → QQ 官方机器人」打开 <code>agent.qqBot.enable</code>。
          </div>
        </div>

        <div class="card pad lift" style="--i:2">
          <div class="ct mb8">
            <span class="ct-ico" style="background:var(--grad-honey)"><v-icon name="info"/></span>
            <div><div class="ct-t">接入提示</div><div class="ct-s">QQ 开放平台 → 开发设置</div></div>
          </div>
          <ul class="mut2" style="font-size:12.5px;margin:0;padding-left:18px;line-height:1.9">
            <li>只需 <b>AppID + AppSecret</b> 两段；官方已明确 <b>Token 鉴权废弃</b>，不用再填机器人 QQ 号。</li>
            <li>连上后群里 @ 机器人即可对话；发 <code>/uid</code>、<code>/groupid</code> 配主人与群白名单。</li>
            <li>被动回复窗口 5 分钟、同一消息最多 5 条；插件已自动限制。</li>
            <li>机器人没开通 Markdown 权限时，会自动降级纯文本（状态标记「平台未开通」）。</li>
          </ul>
        </div>
      </div>

      <!-- 添加 / 编辑表单 -->
      <div v-if="showForm" class="card pad" style="margin-bottom:12px">
        <div class="row-b mb8">
          <div class="ct">
            <span class="ct-ico" style="background:var(--grad-vio)"><v-icon name="plus"/></span>
            <div>
              <div class="ct-t">{{ editing ? '编辑账号' : '添加 QQ 机器人账号' }}</div>
              <div class="ct-s">{{ editing ? '改密钥/参数后会立即重连；AppSecret 留空表示不修改' : '填 AppID 与 AppSecret 即可，其余可留默认' }}</div>
            </div>
          </div>
          <button class="btn b-line b-sm" @click="closeForm">取消</button>
        </div>
        <div class="cf-grid">
          <cfg-row name="AppID" desc="纯数字，QQ 开放平台 → 开发设置 → 机器人 AppID">
            <input class="inp mono" style="width:220px" v-model="form.appId" :disabled="!!editing" placeholder="如 102012345">
          </cfg-row>
          <cfg-row name="AppSecret" :desc="editing ? '留空=保持原值（不会回显）' : '开发设置 → AppSecret（保存后不回显，只给掩码）'">
            <input class="inp mono" type="password" style="width:280px" v-model="form.appSecret" :placeholder="editing ? '留空=不修改' : 'AppSecret'">
          </cfg-row>
          <cfg-row name="显示名称(可选)" desc="仅面板/日志展示，留空用 AppID">
            <input class="inp" style="width:200px" v-model="form.name" placeholder="如 主号">
          </cfg-row>
          <cfg-row name="Markdown 能力" desc="auto=先试、无权限自动纯文本并记忆 | true=总是 | false=纯文本">
            <select class="sel" style="width:170px" v-model="form.markdown">
              <option value="auto">auto（推荐）</option>
              <option value="true">true（总是）</option>
              <option value="false">false（纯文本）</option>
            </select>
          </cfg-row>
          <cfg-row name="纯文本也走 Markdown" desc="平台支持时，普通文本回复也用 Markdown 消息渲染">
            <v-switch v-model="form.preferMarkdownText"/>
          </cfg-row>
          <cfg-row name="沙箱环境" desc="连开放平台沙箱（api 域名 sandbox.）">
            <v-switch v-model="form.sandbox"/>
          </cfg-row>
          <cfg-row name="事件订阅位图(intents)" desc="0=默认（群@ + C2C + 按钮交互；频道需 1073741825）">
            <input type="number" class="inp" style="width:150px" min="0" v-model.number="form.intents">
          </cfg-row>
        </div>
        <div class="row g6" style="margin-top:10px">
          <button class="btn b-pri" @click="save" :disabled="busy === 'save'"><v-icon name="check"/>{{ editing ? '保存并重连' : '添加并连接' }}</button>
          <span class="mut2" style="font-size:12px">保存后立即尝试连接；首次启用若适配器未初始化，需重启 Yunzai。</span>
        </div>
      </div>

      <!-- 账号列表 -->
      <div v-if="!accounts.length" class="card pad">
        <empty-state icon="bot" text="还没有配置 QQ 机器人账号" sub="点右上角「添加账号」，填 AppID 与 AppSecret 即可；也支持直接在 config.yaml 的 agent.qqBot.accounts 里配置"></empty-state>
      </div>

      <div v-else class="grid g2">
        <div v-for="(a, i) in accounts" :key="a.appId" class="card pad lift" :style="'--i:' + (i + 1)">
          <div class="row-b mb8">
            <div class="ct">
              <span class="ct-ico" :style="'background:' + (a.status && (a.status.connected || a.status.state === 'ready') ? 'var(--grad-mint)' : 'var(--grad-sky)')"><v-icon name="bot"/></span>
              <div>
                <div class="ct-t">{{ a.name }} <span class="mut2 mono" style="font-size:12px">· {{ a.appId }}</span></div>
                <div class="ct-s">
                  <span class="pill" :class="statusClass(a)">{{ statusCn(a) }}</span>
                  <span v-if="sessionShort(a)" class="pill p-mute" style="margin-left:6px">session {{ sessionShort(a) }}</span>
                  <span v-if="a.sandbox" class="pill p-honey" style="margin-left:6px">沙箱</span>
                </div>
              </div>
            </div>
            <span class="pill" :class="a.hasSecret ? 'p-green' : 'p-rose'">{{ a.hasSecret ? '密钥已配置' : '缺 AppSecret' }}</span>
          </div>

          <div class="mut2" style="font-size:12px;line-height:1.9">
            <div>AppSecret：<code>{{ a.secretMasked || '（未配置）' }}</code>
              <button class="btn b-line b-sm" style="margin-left:6px;padding:1px 8px" @click="reveal[a.appId] = !reveal[a.appId]">
                {{ reveal[a.appId] ? '收起' : '说明' }}
              </button>
            </div>
            <div v-if="reveal[a.appId]" class="mut2" style="font-size:11.5px">
              出于安全，AppSecret 不回显明文；如需更换请点「编辑」并填写新密钥（留空=保持不变）。
            </div>
            <div>Markdown：{{ markdownCn(a) }}<span v-if="connectedAtStr(a)"> · 连接于 {{ connectedAtStr(a) }}</span></div>
            <div v-if="a.status && a.status.lastClose && a.status.lastClose.code">
              最近断开：code {{ a.status.lastClose.code }}<span v-if="a.status.lastClose.reason">（{{ a.status.lastClose.reason }}）</span>
              <span v-if="a.status.reconnectAttempts"> · 重连次数 {{ a.status.reconnectAttempts }}</span>
            </div>
          </div>

          <div class="row g6 wrap" style="margin-top:10px">
            <button class="btn b-pri b-sm" @click="connect(a)" :disabled="busy === a.appId"><v-icon name="link"/>连接</button>
            <button class="btn b-line b-sm" @click="disconnect(a)" :disabled="busy === a.appId"><v-icon name="x"/>断开</button>
            <button class="btn b-line b-sm" @click="openEdit(a)"><v-icon name="edit"/>编辑</button>
            <button class="btn b-line b-sm" style="color:var(--rose,#e5484d)" @click="remove(a)" :disabled="busy === a.appId"><v-icon name="trash"/>删除</button>
            <button class="btn b-line b-sm" @click="copy(a.appId)"><v-icon name="copy"/>复制 AppID</button>
          </div>
        </div>
      </div>

      <div class="card pad" style="margin-top:12px">
        <div class="ct mb8">
          <span class="ct-ico" style="background:var(--grad-sky)"><v-icon name="info"/></span>
          <div><div class="ct-t">排障</div><div class="ct-s">连接不上时按顺序看这里</div></div>
        </div>
        <ul class="mut2" style="font-size:12.5px;margin:0;padding-left:18px;line-height:1.9">
          <li><b>鉴权失败（code 4004）</b>：AppID/AppSecret 不匹配；到 QQ 开放平台重新复制，注意别把 AppSecret 和 Token 搞混（Token 已废弃）。</li>
          <li><b>intents 被拒（4013/4914）</b>：机器人没有对应事件权限；默认只订阅群@+C2C，频道用户需在账号里填 <code>intents=1073741825</code>。</li>
          <li><b>连接中/反复重连</b>：看「最近断开」错误码；4008 是平台频控（60s 后重试），4006/4007/4009 会自动清会话重连。</li>
          <li><b>同时装了 Yunzai-QQBot-Plugin</b>：请停用那边同一机器人，否则会重复收发消息。</li>
          <li>也可以私聊机器人发 <code>#qqbot状态</code> / <code>#qqbot重连</code> / <code>#qqbot账号</code> 查看。</li>
        </ul>
      </div>
    </div>
    `,
  }
})()
