/** 视图:语音合成（TTS）—— 服务商配置卡片 + 参考音频库 + 情绪化支持
 *  配置读/写 agent.tts.*（经 /api/tts/config 点路径 changes，与配置中心同机制）；
 *  参考音频上传/删除走 /api/tts/refs（二进制直传，命名后模型按名字引用）。
 *  多服务商：providers 由后端下发，点击服务卡片在弹窗里编辑该服务专属配置。
 */
(function () {
  window.VIEWS = window.VIEWS || {}

  /* 行容器（共享实现见 components.js UI.makeCfgRow） */
  const CfgRow = window.UI.makeCfgRow()

  /* 8 种情绪（与后端 emotion.js 同口径；向量顺序：高兴/愤怒/悲伤/害怕/厌恶/忧郁/惊讶/平静） */
  const EMOTIONS = [
    { key: 'happy', zh: '高兴', hint: '开心/喜悦/兴奋/期待' },
    { key: 'angry', zh: '愤怒', hint: '生气/斥责/抗议' },
    { key: 'sad', zh: '悲伤', hint: '难过/失落/同情' },
    { key: 'afraid', zh: '害怕', hint: '恐惧/紧张/担心' },
    { key: 'disgusted', zh: '厌恶', hint: '嫌弃/反感/吐槽' },
    { key: 'melancholic', zh: '忧郁', hint: '低落/疲惫/怀旧' },
    { key: 'surprised', zh: '惊讶', hint: '吃惊/意外/惊喜' },
    { key: 'calm', zh: '平静', hint: '中性/安抚/日常' },
  ]

  const I_DEFAULTS = {
    endpoint: '', lang: 'ZH', timeoutMs: 300000, voice: '',
    emotionMode: 'same', emotionRef: '', emotionWeight: 0.65,
    autoEmotion: true, vector: [], tier: 'pro',
    segmentGapMs: 300, maxSegmentChars: 140, model: '',
    durationFactor: 1.0, maxTextTokensPerSegment: 100,
  }

  window.VIEWS.tts = {
    name: 'TtsView',
    components: { CfgRow },
    setup() {
      const { ref, reactive, computed, onMounted } = Vue
      const { toast } = window.UI

      const loading = ref(false)
      const error = ref('')
      const data = ref(null)
      const sections = [
        { id: 'main', name: '总开关 / 服务商' },
        { id: 'services', name: 'TTS 服务' },
      ]
      const open = reactive({ main: true, services: true })
      const jump = (id) => {
        open[id] = true
        document.getElementById('tts-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }

      /* IndexTTS 弹窗表单（detached；保存时 diff → indextts.* 点路径） */
      const modal = reactive({ show: false, service: null })
      const form = reactive({})
      let orig = {}
      const testState = reactive({ running: false, result: null })

      const syncForm = (payload) => {
        const src = { ...I_DEFAULTS, ...(payload?.indextts || {}) }
        for (const k of Object.keys(form)) delete form[k]
        Object.assign(form, JSON.parse(JSON.stringify(src)))
        orig = JSON.parse(JSON.stringify(form))
      }

      const load = async () => {
        loading.value = true; error.value = ''
        try {
          const d = await window.api.get('/tts')
          data.value = d
          syncForm(d)
        } catch (e) { error.value = e?.message || String(e) }
        finally { loading.value = false }
      }

      /* ── 全局（启用/默认服务商）即时保存 ── */
      const put = async (changes, msg) => {
        try {
          await window.api.put('/tts/config', { changes })
          await load()
          if (msg) toast(msg, 'success')
        } catch (e) { toast(e.message, 'error') }
      }
      const toggleEnable = (v) => put({ enable: !!v }, v ? '已启用 TTS' : '已关闭 TTS')
      const setProvider = (v) => put({ provider: v }, '已切换默认服务商')
      const toggleAutoReply = (v) => put({ autoReply: !!v }, v ? '已开启自动语音回复' : '已关闭自动语音回复')
      const saveReplyMaxChars = (v) => put({ replyMaxChars: Math.max(0, Math.min(5000, Number(v) || 0)) }, '已保存自动语音字数上限')
      const toggleHdVoice = (v) => put({ hdVoice: !!v }, v ? '已开启高清语音' : '已关闭高清语音')

      /* ── 服务卡片 → 弹窗 ── */
      const openService = (p) => {
        if (!data.value) return
        modal.service = p
        syncForm(data.value)
        testState.result = null
        modal.show = true
      }
      const buildChanges = (a, b, prefix, out = {}) => {
        for (const k of Object.keys(b)) {
          const p = prefix + '.' + k
          const x = a?.[k], y = b[k]
          if (y && typeof y === 'object' && !Array.isArray(y) && x && typeof x === 'object' && !Array.isArray(x)) buildChanges(x, y, p, out)
          else if (JSON.stringify(x) !== JSON.stringify(y)) out[p] = y
        }
        return out
      }
      const saveModal = async () => {
        const changes = buildChanges(orig, JSON.parse(JSON.stringify(form)), 'indextts')
        if (!Object.keys(changes).length) { toast('无改动', 'warn'); return }
        try {
          await window.api.put('/tts/config', { changes })
          await load()
          modal.show = false
          toast('已保存（已热加载）', 'success')
        } catch (e) { toast(e.message, 'error') }
      }

      const testConn = async () => {
        testState.running = true; testState.result = null
        try {
          const r = await window.api.post('/tts/test', { endpoint: form.endpoint, apiKey: form.apiKey })
          testState.result = { ok: true, msg: `连接成功 · fn_index=${r.fnIndex} · ${r.tookMs}ms` }
        } catch (e) { testState.result = { ok: false, msg: e.message } }
        finally { testState.running = false }
      }

      /* ── 参考音频库 ── */
      const fileEl = ref(null)
      const upload = reactive({ name: '', kind: 'voice', file: null, busy: false })
      const onPick = (e) => { upload.file = e.target.files?.[0] || null; if (upload.file && !upload.name) upload.name = upload.file.name.replace(/\.[^.]+$/, '') }
      const doUpload = async () => {
        if (!upload.file) return toast('请先选择音频文件', 'warn')
        if (!String(upload.name || '').trim()) return toast('请给参考音频命名（模型按名字引用）', 'warn')
        upload.busy = true
        try {
          await window.api.postRaw('/tts/refs', upload.file, { name: upload.name.trim(), kind: upload.kind, filename: upload.file.name })
          toast(`已上传「${upload.name.trim()}」`, 'success')
          upload.name = ''; upload.file = null
          if (fileEl.value) fileEl.value.value = ''
          await load()
        } catch (e) { toast(e.message, 'error') }
        finally { upload.busy = false }
      }
      const delRef = async (r) => {
        if (!window.confirm(`删除参考音频「${r.name}」？（正在使用它的音色会失效）`)) return
        try { await window.api.del('/tts/refs/' + r.id); await load(); toast('已删除', 'success') }
        catch (e) { toast(e.message, 'error') }
      }
      const refUrl = (r) => `/api/tts/refs/${r.id}/audio?token=${encodeURIComponent(window.api.getToken() || '')}`
      const refs = computed(() => data.value?.refs || [])
      const voiceRefs = computed(() => refs.value.filter((r) => r.kind === 'voice'))
      const emoRefs = computed(() => refs.value.filter((r) => r.kind === 'emotion'))
      const kindZh = (k) => (k === 'emotion' ? '情绪参考' : '音色参考')
      const sizeKb = (n) => (n ? (n / 1024).toFixed(0) + ' KB' : '—')

      /* ── 情绪向量 UI ── */
      const vecOf = (k) => Number(form.vector?.[EMOTIONS.findIndex((e) => e.key === k)] || 0)
      const setVec = (k, v) => {
        const i = EMOTIONS.findIndex((e) => e.key === k)
        const arr = Array.isArray(form.vector) && form.vector.length === 8 ? [...form.vector] : [0, 0, 0, 0, 0, 0, 0, 0]
        arr[i] = Number(v) || 0
        form.vector = arr
      }
      const vecSum = computed(() => (Array.isArray(form.vector) ? form.vector.reduce((a, b) => a + (Number(b) || 0), 0) : 0))

      onMounted(load)

      return {
        loading, error, data, load, sections, open, jump,
        modal, form, saveModal, openService, testConn, testState,
        upload, onPick, doUpload, delRef, refUrl, refs, voiceRefs, emoRefs, kindZh, sizeKb, fileEl,
        toggleEnable, setProvider, toggleAutoReply, saveReplyMaxChars, toggleHdVoice,
        EMOTIONS, vecOf, setVec, vecSum,
      }
    },
    template: `
    <div class="cf-wrap">
      <div class="cf-nav">
        <a v-for="s in sections" :key="s.id" :class="{on: open[s.id]}" @click="jump(s.id)">{{ s.name }}</a>
      </div>

      <div>
        <div class="note">
          <v-icon name="music"/>
          <div>
            <b>语音合成（TTS）</b>：开启后<strong>每条最终回复都会自动追加语音</strong>（文字/图片照常发；合成内容为剥除 md/代码后的正文）。Agent 工具 <code>tts_speak</code> 用于指定音色/情绪的点播（本轮已点播则不再自动补发）。
            <span class="mut2">情绪三种模式：沿用音色参考 / 情绪参考音频 / 8 维向量（默认由 LLM 结合文本与上下文自动调节）；pro=整段一套情绪，max=按需拆分逐段情绪后合成拼接。详细说明见技能 <code>tts</code>。</span>
          </div>
        </div>

        <div v-if="error" class="note n-rose"><v-icon name="warn"/><div>{{ error }}（点下方刷新重试）</div></div>

        <!-- ===== 总开关 ===== -->
        <div id="tts-main" class="card cf-sec" :class="{open: open.main}">
          <div class="cf-sh" @click="open.main = !open.main">
            <span class="ct-ico" style="background:var(--grad)"><v-icon name="music"/></span>
            <div><div class="ct-t">总开关 / 默认服务商</div><div class="ct-s">关=tts_speak 工具不注册；服务商配置在下方卡片内</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.main"><div class="cf-grid">
            <cfg-row name="启用语音合成" desc="关=Agent 不再注册 tts_speak、也不自动合成回复语音（改完即热加载）">
              <v-switch :model-value="!!data?.enable" @update:modelValue="toggleEnable"/>
            </cfg-row>
            <cfg-row name="自动语音回复" desc="开启后每条最终回复自动合成语音（文字/图片照常发，随后追加语音；内容为剥除 md/代码后的正文）">
              <v-switch :model-value="!!data?.autoReply" @update:modelValue="toggleAutoReply"/>
            </cfg-row>
            <cfg-row name="自动语音字数上限" desc="超长按句子边界截断（防一条回复合成出几分钟语音）；0=不限">
              <input type="number" class="inp" style="width:120px" min="0" max="5000" step="50" :value="data?.replyMaxChars != null ? data.replyMaxChars : 300" @change="saveReplyMaxChars($event.target.value)">
            </cfg-row>
            <cfg-row name="高清语音" desc="发送前响度标准化 + 清晰度补偿（修 TTS 输出偏轻偏闷；需宿主 ffmpeg，失败自动回退原始音频）">
              <v-switch :model-value="!!data?.hdVoice" @update:modelValue="toggleHdVoice"/>
            </cfg-row>
            <cfg-row name="默认服务商" desc="后续接入其它 TTS 服务时在此切换">
              <select class="sel" style="width:220px" :value="data?.provider || 'indextts'" @change="setProvider($event.target.value)" :disabled="(data?.providers || []).length < 2">
                <option v-for="p in (data?.providers || [])" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== 服务列表（点击卡片 → 该服务专属配置弹窗） ===== -->
        <div id="tts-services" class="card cf-sec" :class="{open: open.services}">
          <div class="cf-sh" @click="open.services = !open.services">
            <span class="ct-ico" style="background:var(--grad-sky)"><v-icon name="layers"/></span>
            <div><div class="ct-t">TTS 服务</div><div class="ct-s">点击服务卡片打开对应配置（参考音频 / 接口地址 / 情绪化支持）</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.services">
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">
              <div v-for="p in (data?.providers || [])" :key="p.id" class="card lift" style="cursor:pointer;padding:14px 16px" @click="openService(p)">
                <div class="row g10" style="align-items:center">
                  <span class="ct-ico" style="background:var(--grad)"><v-icon name="music"/></span>
                  <div style="flex:1;min-width:0">
                    <div style="font-weight:800">{{ p.name }}</div>
                    <div class="mut2" style="font-size:11.5px;margin-top:2px">{{ p.desc }}</div>
                  </div>
                  <span class="pill" :class="p.configured ? 'p-green' : 'p-rose'">{{ p.configured ? '已配置' : '未配置' }}</span>
                </div>
                <div class="row g6" style="margin-top:10px;align-items:center">
                  <span class="mut2" style="font-size:11.5px"><v-icon name="user"/> 音色参考 {{ voiceRefs.length }} 条 · 情绪参考 {{ emoRefs.length }} 条</span>
                  <button class="btn b-soft b-sm" style="margin-left:auto">配置 <v-icon name="arrowr"/></button>
                </div>
              </div>
              <div class="card" style="padding:14px 16px;border-style:dashed;display:flex;align-items:center;gap:10px;color:var(--mut,#8a93a6)">
                <v-icon name="plus"/><span style="font-size:12.5px">更多 TTS 服务接入中（结构已按多服务商预留）</span>
              </div>
            </div>
            <div v-if="loading" class="mut2" style="font-size:12px;margin-top:10px">加载中…</div>
            <div v-else-if="data && !(data.providers || []).length" class="mut2" style="font-size:12px;margin-top:10px">暂无可用服务。</div>
          </div>
        </div>

        <!-- ===== IndexTTS 配置弹窗 ===== -->
        <v-modal v-if="modal.show" :title="(modal.service?.name || 'TTS 服务') + ' · 配置'" icon="music" width="min(780px,94vw)" @close="modal.show = false">
          <div class="cf-grid">
            <div class="cf-sub full"><v-icon name="link"/> 接口</div>
            <cfg-row full name="接口地址" desc="IndexTTS 服务地址（如 http://127.0.0.1:7860；v1.2 起该端口由鉴权网关承接）">
              <div class="row g6">
                <input class="inp mono" style="width:320px" v-model="form.endpoint" placeholder="http://127.0.0.1:7860">
                <button class="btn b-line b-sm" @click="testConn" :disabled="testState.running">{{ testState.running ? '测试中…' : '测试连接' }}</button>
              </div>
            </cfg-row>
            <cfg-row full name="API Key" desc="鉴权网关的 API Key（itts_xxx）——请求头 X-API-Key；官方无鉴权网关时留空">
              <input class="inp mono" style="width:320px" v-model="form.apiKey" placeholder="itts_xxx（可留空）" autocomplete="off">
            </cfg-row>
            <cfg-row full name="连接状态" desc="测试只读取服务 /config 并动态解析 fn_index 与情绪选项（不做真实合成）">
              <span v-if="testState.result" class="pill" :class="testState.result.ok ? 'p-green' : 'p-rose'">{{ testState.result.msg }}</span>
              <span v-else class="mut2" style="font-size:12px">未测试</span>
            </cfg-row>

            <div class="cf-sub full"><v-icon name="user"/> 参考音频（上传时命名；模型按名字引用）</div>
            <div class="full">
              <div class="row g6 wrap" style="align-items:center;margin-bottom:8px">
                <input ref="fileEl" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac" class="inp" style="width:220px" @change="onPick">
                <input class="inp" style="width:130px" v-model="upload.name" placeholder="命名（如 芙宁娜）">
                <select class="sel" style="width:120px" v-model="upload.kind">
                  <option value="voice">音色参考</option>
                  <option value="emotion">情绪参考</option>
                </select>
                <button class="btn b-pri b-sm" @click="doUpload" :disabled="upload.busy">{{ upload.busy ? '上传中…' : '上传' }}</button>
                <span class="mut2" style="font-size:11px">建议 6~12 秒单人清晰录音；情绪参考可来自其他说话人</span>
              </div>
              <div v-if="!refs.length" class="mut2" style="font-size:12px">还没有参考音频——先上传一条音色参考，再按需上传情绪参考。</div>
              <div v-for="r in refs" :key="r.id" class="row g6 wrap" style="align-items:center;border-top:1px solid var(--line);padding:6px 0">
                <span style="min-width:110px;font-weight:700;font-size:12.5px">{{ r.name }}</span>
                <span class="pill" :class="r.kind === 'emotion' ? 'p-honey' : 'p-pri'" style="font-size:10.5px">{{ kindZh(r.kind) }}</span>
                <span class="mut2" style="font-size:11px">{{ sizeKb(r.size) }}</span>
                <audio :src="refUrl(r)" controls preload="none" style="height:30px;max-width:230px;margin-left:auto"></audio>
                <button class="btn b-line b-sm" @click="delRef(r)"><v-icon name="trash"/></button>
              </div>
            </div>

            <div class="cf-sub full"><v-icon name="zap"/> 情绪化支持</div>
            <cfg-row name="默认情绪模式" desc="same=沿用音色参考的情绪 | audio=另配情绪参考音频 | vector=8 维向量（LLM 可自动调节）">
              <select class="sel" style="width:230px" v-model="form.emotionMode">
                <option value="same">Same as the voice reference（沿用）</option>
                <option value="audio">Use emotion reference audio（情绪参考）</option>
                <option value="vector">Use emotion vectors（情绪向量）</option>
              </select>
            </cfg-row>
            <cfg-row name="默认音色参考" desc="留空=最新上传的音色参考；工具调用可用 voice 参数覆盖">
              <select class="sel" style="width:200px" v-model="form.voice">
                <option value="">（最新上传）</option>
                <option v-for="r in voiceRefs" :key="r.id" :value="r.name">{{ r.name }}</option>
              </select>
            </cfg-row>

            <template v-if="form.emotionMode === 'audio'">
              <cfg-row name="默认情绪参考" desc="audio 模式使用的情绪参考音频（可来自其他说话人）">
                <select class="sel" style="width:200px" v-model="form.emotionRef">
                  <option value="">（未指定）</option>
                  <option v-for="r in emoRefs" :key="r.id" :value="r.name">{{ r.name }}</option>
                </select>
              </cfg-row>
              <cfg-row name="情绪影响强度" desc="emotionWeight 0~1：越大越贴近情绪参考的语气（默认 0.65）">
                <div class="row g10" style="width:220px">
                  <input type="range" class="rng" min="0" max="1" step="0.05" v-model.number="form.emotionWeight">
                  <b class="num" style="width:36px;text-align:right">{{ Number(form.emotionWeight || 0).toFixed(2) }}</b>
                </div>
              </cfg-row>
            </template>

            <template v-if="form.emotionMode === 'vector'">
              <cfg-row name="LLM 自动调节" desc="开=结合要朗读的文本与近期对话上下文自动判定情绪（推荐）；关=使用下方默认向量">
                <v-switch v-model="form.autoEmotion"/>
              </cfg-row>
              <cfg-row name="档位 tier" desc="pro=整段文本一套情绪一次合成（快）| max=按需拆分逐段情绪，分别合成后 ffmpeg 合并（更细腻，长文本耗时更久）">
                <select class="sel" style="width:230px" v-model="form.tier">
                  <option value="pro">pro · 整段一套情绪</option>
                  <option value="max">max · 按需拆分逐段情绪</option>
                </select>
              </cfg-row>
              <div class="full" style="border:1px dashed var(--line);border-radius:10px;padding:10px 12px">
                <div class="row-b" style="margin-bottom:6px">
                  <span style="font-weight:700;font-size:12.5px">默认情绪向量（LLM 自动调节失败时的回退）</span>
                  <span class="mut2" style="font-size:11px">单值 0~1.2 · 总和 ≤ 1.5（超出自动按比例缩放）· 当前和 {{ vecSum.toFixed(2) }}</span>
                </div>
                <div v-for="e in EMOTIONS" :key="e.key" class="row g10" style="align-items:center;margin:4px 0">
                  <span style="width:52px;font-size:12.5px">{{ e.zh }}</span>
                  <input type="range" class="rng" min="0" max="1.2" step="0.05" :value="vecOf(e.key)" @input="setVec(e.key, $event.target.value)" style="flex:1">
                  <b class="num" style="width:36px;text-align:right">{{ vecOf(e.key).toFixed(2) }}</b>
                  <span class="mut2" style="width:120px;font-size:11px">{{ e.hint }}</span>
                </div>
              </div>
            </template>

            <div class="cf-sub full"><v-icon name="config"/> 高级参数</div>
            <cfg-row name="语言 lang" desc="合成语言（默认 ZH）">
              <select class="sel" style="width:110px" v-model="form.lang">
                <option v-for="l in ['ZH','EN','JA','AR','ES']" :key="l" :value="l">{{ l }}</option>
              </select>
            </cfg-row>
            <cfg-row name="语速/时长系数" desc="durationFactor 0.5~2.0，越小语速越快（默认 1.0）">
              <input type="number" class="inp" style="width:100px" min="0.5" max="2" step="0.1" v-model.number="form.durationFactor">
            </cfg-row>
            <cfg-row name="超时(毫秒)" desc="单次合成/单段超时（分段长文本会分别计时；默认 300000）">
              <input type="number" class="inp" style="width:130px" min="10000" step="10000" v-model.number="form.timeoutMs">
            </cfg-row>
            <cfg-row name="服务端分段上限" desc="maxTextTokensPerSegment：单段最大 token（建议 80~120）">
              <input type="number" class="inp" style="width:100px" min="20" max="500" v-model.number="form.maxTextTokensPerSegment">
            </cfg-row>
            <cfg-row name="max 档段间静音(ms)" desc="分段拼接时插入的静音（默认 300；0=不留空隙）">
              <input type="number" class="inp" style="width:110px" min="0" max="2000" step="50" v-model.number="form.segmentGapMs">
            </cfg-row>
            <cfg-row name="max 档单段字数" desc="LLM 分段时每段字符上限（防拆得过碎，默认 140）">
              <input type="number" class="inp" style="width:110px" min="20" max="500" v-model.number="form.maxSegmentChars">
            </cfg-row>
            <cfg-row full name="情绪判定模型" desc="vector 自动调节用的小模型（模型条目 id/模型名）；留空=utilityModel→主模型">
              <input class="inp mono" style="width:280px" v-model="form.model" placeholder="留空=utilityModel→主模型">
            </cfg-row>
          </div>
          <template #foot>
            <div class="row g10" style="margin-left:auto">
              <button class="btn b-line" @click="modal.show = false">取消</button>
              <button class="btn b-pri" @click="saveModal"><v-icon name="save"/>保存（热加载）</button>
            </div>
          </template>
        </v-modal>
      </div>
    </div>`,
  }
})()
