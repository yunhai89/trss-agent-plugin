/** 视图:伪人模式（群聊环境参与者）独立配置页
 *  读/写 agent.humanize.* （经 /api/config 点路径 changes，与配置中心同机制）。
 *  红线提示：默认 shadow（只记录决策不实发）；privateMemoryInGroup 强制 false（禁用控件）。
 */
(function () {
  window.VIEWS = window.VIEWS || {}

  /* 行容器:左名称/说明,右控件（与 config.js 同构，本页自包含） */
  const CfgRow = {
    name: 'CfgRow',
    props: { name: String, desc: { type: String, default: '' }, danger: Boolean, full: Boolean },
    template: `
    <div class="cf-item" :class="{full: full, dg: danger}">
      <div class="info">
        <div class="name">{{ name }}<span v-if="danger" class="pill p-rose" style="margin-left:7px;font-size:10px;padding:3px 8px">高危</span></div>
        <div class="desc" v-if="desc">{{ desc }}</div>
      </div>
      <div class="ctl"><slot/></div>
    </div>`,
  }

  /* 标签编辑器（群白名单 / 主题 / 黑名单工具等数组字段） */
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
      <input v-model="input" class="inp" :class="{mono: mono}" style="width:140px;padding:5px 10px;font-size:12px" :placeholder="placeholder" @keydown.enter.prevent="add">
    </div>`,
  }

  const OPT = {
    triggerMode: [['necessity', '必要性评分（推荐）'], ['frequency', '有效发言频率']],
    quoteTarget: [['auto', 'auto（Planner 决定）'], ['always', 'always（总是引用）'], ['never', 'never（不引用）']],
    learningStyle: [['shadow', 'shadow（只采集）'], ['review', 'review（人工审核）'], ['on', 'on（已审核注入）'], ['off', 'off（关闭）']],
  }

  /* 默认值兜底（与 model/humanize/default-config.js 对齐；旧 config 缺字段时防 v-model 报错） */
  const DEFAULTS = {
    enable: false, groups: [], shadow: true, triggerMode: 'necessity', talkValue: 0.35,
    mentionHandledByDirectAgent: true, debounceMs: 1200, plannerTimeoutMs: 30000, maxPlannerRounds: 4,
    contextMessages: 30, threshold: 80, cooldownSeconds: 45, presenceWindowSeconds: 300, maxRepliesPer10Minutes: 4,
    bufferCapacity: 150, bufferTtlHours: 2, idleBackoffBaseSeconds: 15, idleBackoffCapSeconds: 300,
    idleBackoffStartCount: 2, bypassPendingCount: 6, personaName: '', botId: '',
    redactSecrets: true,
    persona: { name: '', prompt: '', fromPersonaId: '' },
    planner: { model: '', temperature: 0.2, maxTokens: 800, allowedReadTools: [] },
    replyer: { model: '', temperature: 0.7, maxTokens: 500, maxChars: 500 },
    reply: { maxBubbles: 3, typingSpeed: 1.0, minDelayMs: 600, maxDelayMs: 3500, typos: false, allowSticker: true, quoteTarget: 'auto' },
    behaviorPolicy: { topics: [], avoidTopics: [], initiative: 0.35, humor: 0.4, answerUnknownQuestions: false, interruptHumanConversation: false, maxRepliesPer10Minutes: 4 },
    learning: { style: 'shadow', jargon: 'shadow', behavior: false, minSamples: 20, requireReview: true },
    safety: { blockCommands: true, blockDestructiveTools: true, privateMemoryInGroup: false, maxConcurrentGroups: 1 },
  }

  window.VIEWS.humanize = {
    name: 'HumanizeView',
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

      /* 深合并默认值（保证子对象存在） */
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
        // 清空后重填（防止字段残留）。深拷贝 snap：form 不得与 store 的 reactive 对象共享引用
        // （否则数组字段 form.groups 会别名 M.config.humanize.groups，导致 v-model 回写后
        // buildChanges 比较 origSnapshot 与 form 时偶发判等异常，保存提示「无改动」）。
        // 注：config.js 在调用处深拷贝 M.config；本页调用处未拷贝，故在此处补拷贝，效果等价。
        const detached = withDefaults(JSON.parse(JSON.stringify(snap || {})))
        for (const k of Object.keys(form)) delete form[k]
        Object.assign(form, detached)
        origSnapshot = JSON.parse(JSON.stringify(form))
        dirty.value = false
        nextTick(() => { dirtySuppressed = false })
      }

      /* 点路径 diff（前缀 agent.humanize） */
      const buildChanges = (orig, frm, prefix = 'agent.humanize', out = {}) => {
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
          if (M.config?.humanize) syncForm(M.config.humanize)
          toast('已保存（已热加载）', 'success')
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

      /* 分区折叠 */
      const sections = [
        { id: 'basic', name: '总开关 / 白名单', icon: 'group', grad: 'var(--grad)' },
        { id: 'persona', name: '角色人设', icon: 'persona', grad: 'var(--grad-vio)' },
        { id: 'gate', name: '门控 / 评分', icon: 'zap', grad: 'var(--grad-sky)' },
        { id: 'llm', name: 'Planner / Replyer', icon: 'cpu', grad: 'var(--grad-mint)' },
        { id: 'reply', name: '发送编排', icon: 'send', grad: 'var(--grad-honey)' },
        { id: 'policy', name: '行为政策 / 学习', icon: 'bot', grad: 'var(--grad-rose)' },
        { id: 'safety', name: '安全 / 红线', icon: 'shield', grad: 'var(--grad)' },
      ]
      const open = reactive(Object.fromEntries(sections.map((s) => [s.id, s.id === 'basic'])))
      const activeSec = ref('basic')
      const jump = (id) => {
        open[id] = true
        activeSec.value = id
        document.getElementById('hz-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      const onScroll = () => {
        for (const s of sections) {
          const el = document.getElementById('hz-' + s.id)
          if (el && el.getBoundingClientRect().top > 60 && el.getBoundingClientRect().top < 240) { activeSec.value = s.id; break }
        }
      }

      onMounted(async () => {
        window.addEventListener('scroll', onScroll, { passive: true })
        try {
          await window.store.loadConfig()
          if (M.config) syncForm(M.config.humanize)
        } catch (e) { toast(e.message, 'error') }
      })
      // onUnmounted: 简单清理（本视图常驻，scroll 监听与 config 页同模式，切换路由不主动移除以保持一致）
      window.removeEventListener('scroll', onScroll)

      const talkPct = computed(() => (form.talkValue || 0) * 100 + '%')
      const tempPlannerPct = computed(() => ((form.planner?.temperature ?? 0.2) / 1) * 100 + '%')
      const tempReplyerPct = computed(() => ((form.replyer?.temperature ?? 0.7) / 1) * 100 + '%')
      const humorPct = computed(() => (form.behaviorPolicy?.humor ?? 0) * 100 + '%')
      const initiativePct = computed(() => (form.behaviorPolicy?.initiative ?? 0) * 100 + '%')
      /* enable=true 但白名单空 → 不生效提示 */
      const enableWarn = computed(() => form.enable === true && !(form.groups || []).length)

      return {
        form, dirty, save, reset, sections, open, activeSec, jump, OPT,
        talkPct, tempPlannerPct, tempReplyerPct, humorPct, initiativePct, enableWarn,
      }
    },
    template: `
    <div class="cf-wrap">
      <!-- 锚点导航 -->
      <div class="cf-nav">
        <a v-for="s in sections" :key="s.id" :class="{on: activeSec === s.id}" @click="jump(s.id)">{{ s.name }}</a>
      </div>

      <div>
        <!-- 红线提示条 -->
        <div class="note">
            <v-icon name="info" />
            <div>
              <b>伪人模式</b>：在任务型 Agent 旁新增「持续旁听→低成本门控→工具化决策→独立表达→可中断发送」的群聊参与者。
              <span class="pill p-rose" style="font-size:10px;padding:2px 7px;margin:0 4px">红线</span>
              环境模式普通文本<b>永不发送</b>，只有 human_reply/human_react 才产生对外消息；user_private 记忆<b>绝不注入群聊</b>。
              <br><span class="mut2">默认 shadow（只记录决策、不实发）；建议先 shadow 观察决策（#伪人决策），调好门控与文风后再改 false 实发。</span>
            </div>
        </div>

        <div v-if="enableWarn" class="note n-rose">
          <v-icon name="warn"/><div>总开关已开，但白名单为空 —— 不会在任何群生效。请在「总开关 / 白名单」添加群号。</div>
        </div>

        <!-- ===== 总开关 / 白名单 ===== -->
        <div :id="'hz-basic'" class="card cf-sec" :class="{open: open.basic}">
          <div class="cf-sh" @click="open.basic = !open.basic">
            <span class="ct-ico" style="background:var(--grad)"><v-icon name="group"/></span>
            <div><div class="ct-t">总开关 / 白名单</div><div class="ct-s">启用、白名单群与 shadow 观察模式</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.basic"><div class="cf-grid">
            <cfg-row name="启用伪人模式" desc="开启后旁听白名单群的普通消息（不影响 #ai/@ 任务型 Agent）">
              <v-switch v-model="form.enable"/>
            </cfg-row>
            <cfg-row full name="白名单群" desc="显式群号（字符串）；空数组=不开启；@/#ai 仍由 Direct Agent 独占">
              <tag-editor v-model="form.groups" placeholder="输入群号回车" :mono="true"/>
            </cfg-row>
            <cfg-row name="shadow 观察模式" desc="true=只记录决策 trace、不真实发送（强烈建议先观察）">
              <v-switch v-model="form.shadow"/>
            </cfg-row>
            <cfg-row name="触发模式" desc="necessity=评分触发（推荐）；frequency=有效发言频率">
              <select class="sel" style="width:190px" v-model="form.triggerMode"><option v-for="o in OPT.triggerMode" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="机器人群内名字" desc="提及昵称判定用；留空=自动取 Bot.nickname">
              <input class="inp" style="width:170px" v-model="form.personaName" placeholder="留空=自动">
            </cfg-row>
            <cfg-row name="机器人自身 QQ" desc="self 判定/防环用；留空=自动探测 Bot.uin">
              <input class="inp mono" style="width:170px" v-model="form.botId" placeholder="留空=自动">
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== 角色人设 ===== -->
        <div :id="'hz-persona'" class="card cf-sec" :class="{open: open.persona}">
          <div class="cf-sh" @click="open.persona = !open.persona">
            <span class="ct-ico" style="background:var(--grad-rose)"><v-icon name="persona"/></span>
            <div><div class="ct-t">角色人设</div><div class="ct-s">MaiBot 式角色卡——身份/性格/说话风格；注入 Planner 决策 + Replyer 发言（与主 Agent 人设独立）</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.persona"><div class="cf-grid">
            <cfg-row name="角色名" desc="留空=用上方「机器人群内名字」">
              <input class="inp" style="width:170px" v-model="form.persona.name" placeholder="留空=自动">
            </cfg-row>
            <cfg-row name="复用人设 id" desc="角色卡为空时，按 id/名复用 PersonaStore 已建人设（如 raiden-ei）；留空=不复用">
              <input class="inp" style="width:170px" v-model="form.persona.fromPersonaId" placeholder="如 raiden-ei">
            </cfg-row>
            <cfg-row full name="角色卡（角色设定正文）" desc="自由多段，MaiBot 式：身份/性格/【语气】【口癖】【距离感】【偏好】等。为空且未复用 → 回落主 Agent 人设">
              <textarea class="inp mono" style="width:100%;min-height:180px;font-size:12px;line-height:1.6;resize:vertical" v-model="form.persona.prompt" placeholder="你是「小汐」，群里一个爱聊天的技术宅。性格随和有点皮，喜欢接梗。&#10;【语气】轻松口语，偶尔用「哈」「确实」，不端着。&#10;【口癖】赞同爱说「确实是」；遇到有意思的回「有点东西」。&#10;【偏好】对 AI/编程/数码话题兴致高；八卦闲聊也会接，但不主动挑起。&#10;【不做】不发长篇大论、不列要点清单。"></textarea>
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== 门控 / 评分 ===== -->
        <div :id="'hz-gate'" class="card cf-sec" :class="{open: open.gate}">
          <div class="cf-sh" @click="open.gate = !open.gate">
            <span class="ct-ico" style="background:var(--grad-sky)"><v-icon name="zap"/></span>
            <div><div class="ct-t">门控 / 评分</div><div class="ct-s">确定性必要性评分 + debounce + 退避（规则先于 LLM）</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.gate"><div class="cf-grid">
            <cfg-row name="评分阈值" desc="final≥阈值 才进 Planner（默认 80，强信号强制候选）">
              <input type="number" class="inp" style="width:110px" min="1" max="120" v-model.number="form.threshold">
            </cfg-row>
            <cfg-row name="主动性 talkValue" desc="0~1；不等于回复概率，影响频率倍率与压力门槛">
              <div class="row g10" style="width:200px">
                <input type="range" class="rng" min="0.05" max="1" step="0.05" v-model.number="form.talkValue" :style="{'--fill': talkPct}">
                <b class="num" style="width:34px;text-align:right">{{ Number(form.talkValue||0).toFixed(2) }}</b>
              </div>
            </cfg-row>
            <cfg-row name="debounce 安静窗(ms)" desc="burst 后等待的安静窗口再评估（下限 200）">
              <input type="number" class="inp" style="width:120px" min="200" max="10000" step="100" v-model.number="form.debounceMs">
            </cfg-row>
            <cfg-row name="回复冷却(秒)" desc="成功回复后的冷却；强信号可绕过">
              <input type="number" class="inp" style="width:110px" min="0" max="600" v-model.number="form.cooldownSeconds">
            </cfg-row>
            <cfg-row name="在场统计窗口(秒)" desc="机器人发言占比统计窗口（默认 5 分钟）">
              <input type="number" class="inp" style="width:120px" min="60" v-model.number="form.presenceWindowSeconds">
            </cfg-row>
            <cfg-row name="10 分钟最大回复数" desc="频率硬上限（强信号可绕过）">
              <input type="number" class="inp" style="width:110px" min="0" max="60" v-model.number="form.maxRepliesPer10Minutes">
            </cfg-row>
            <cfg-row name="退避绕过门槛" desc="待处理新消息达此数绕过 idle backoff">
              <input type="number" class="inp" style="width:110px" min="1" v-model.number="form.bypassPendingCount">
            </cfg-row>
            <cfg-row name="注入消息条数" desc="注入 Prompt 的最近消息数（存储 150，注入默认 30）">
              <input type="number" class="inp" style="width:110px" min="5" max="100" v-model.number="form.contextMessages">
            </cfg-row>
            <cfg-row name="缓冲条数 / TTL(小时)" desc="单群消息环缓冲容量与保留时长">
              <div class="row g6">
                <input type="number" class="inp" style="width:90px" min="20" v-model.number="form.bufferCapacity">
                <input type="number" class="inp" style="width:80px" min="1" v-model.number="form.bufferTtlHours">
              </div>
            </cfg-row>
            <cfg-row name="退避基数 / 上限 / 起始" desc="连续无动作指数退避 15/30/60/120/240…(cap 300)">
              <div class="row g6">
                <input type="number" class="inp" style="width:80px" min="1" v-model.number="form.idleBackoffBaseSeconds">
                <input type="number" class="inp" style="width:80px" min="10" v-model.number="form.idleBackoffCapSeconds">
                <input type="number" class="inp" style="width:70px" min="1" v-model.number="form.idleBackoffStartCount">
              </div>
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== Planner / Replyer ===== -->
        <div :id="'hz-llm'" class="card cf-sec" :class="{open: open.llm}">
          <div class="cf-sh" @click="open.llm = !open.llm">
            <span class="ct-ico" style="background:var(--grad-mint)"><v-icon name="cpu"/></span>
            <div><div class="ct-t">Planner / Replyer</div><div class="ct-s">决策器与可见文本生成（双层职责）</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.llm"><div class="cf-grid">
            <cfg-row name="Planner 最大轮数" desc="内部工具循环上限（默认 4）">
              <input type="number" class="inp" style="width:90px" min="1" max="6" v-model.number="form.maxPlannerRounds">
            </cfg-row>
            <cfg-row name="Planner 超时(ms)" desc="超时默认沉默">
              <input type="number" class="inp" style="width:130px" min="5000" max="120000" step="1000" v-model.number="form.plannerTimeoutMs">
            </cfg-row>
            <cfg-row name="Planner 模型" desc="留空=utilityModel→主模型">
              <input class="inp mono" style="width:200px" v-model="form.planner.model" placeholder="留空=主模型">
            </cfg-row>
            <cfg-row name="Planner 温度" desc="低温求稳定（默认 0.2）">
              <div class="row g10" style="width:200px">
                <input type="range" class="rng" min="0" max="1" step="0.05" v-model.number="form.planner.temperature" :style="{'--fill': tempPlannerPct}">
                <b class="num" style="width:30px;text-align:right">{{ Number(form.planner.temperature||0).toFixed(2) }}</b>
              </div>
            </cfg-row>
            <cfg-row name="Planner maxTokens" desc="单轮分析 token 上限">
              <input type="number" class="inp" style="width:110px" min="200" v-model.number="form.planner.maxTokens">
            </cfg-row>
            <cfg-row full name="Planner 白名单只读工具" desc="仅查询类；写/删/管理/终端/发送工具一律被拒（双保险）">
              <tag-editor v-model="form.planner.allowedReadTools" placeholder="如 memory_search / web_search" :mono="true"/>
            </cfg-row>
            <cfg-row name="Replyer 模型" desc="留空=主模型">
              <input class="inp mono" style="width:200px" v-model="form.replyer.model" placeholder="留空=主模型">
            </cfg-row>
            <cfg-row name="Replyer 温度" desc="文风多样性（默认 0.7）">
              <div class="row g10" style="width:200px">
                <input type="range" class="rng" min="0" max="1" step="0.05" v-model.number="form.replyer.temperature" :style="{'--fill': tempReplyerPct}">
                <b class="num" style="width:30px;text-align:right">{{ Number(form.replyer.temperature||0).toFixed(2) }}</b>
              </div>
            </cfg-row>
            <cfg-row name="Replyer maxTokens / maxChars" desc="单次回复 token/字符上限（超长低温重写）">
              <div class="row g6">
                <input type="number" class="inp" style="width:90px" min="100" v-model.number="form.replyer.maxTokens">
                <input type="number" class="inp" style="width:90px" min="100" v-model.number="form.replyer.maxChars">
              </div>
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== 发送编排 ===== -->
        <div :id="'hz-reply'" class="card cf-sec" :class="{open: open.reply}">
          <div class="cf-sh" @click="open.reply = !open.reply">
            <span class="ct-ico" style="background:var(--grad-honey)"><v-icon name="send"/></span>
            <div><div class="ct-t">发送编排</div><div class="ct-s">分段 / 输入延迟 / 引用 / 表情包</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.reply"><div class="cf-grid">
            <cfg-row name="单次最多气泡" desc="拆成 1~3 段分泡发送">
              <input type="number" class="inp" style="width:90px" min="1" max="5" v-model.number="form.reply.maxBubbles">
            </cfg-row>
            <cfg-row name="输入速度倍率" desc="越大越快（模拟输入延迟）">
              <input type="number" class="inp" style="width:100px" min="0.1" max="3" step="0.1" v-model.number="form.reply.typingSpeed">
            </cfg-row>
            <cfg-row name="延迟范围(ms)" desc="后续段最小/最大输入延迟">
              <div class="row g6">
                <input type="number" class="inp" style="width:100px" min="0" v-model.number="form.reply.minDelayMs">
                <input type="number" class="inp" style="width:100px" min="100" v-model.number="form.reply.maxDelayMs">
              </div>
            </cfg-row>
            <cfg-row name="引用目标消息" desc="首段是否引用目标">
              <select class="sel" style="width:190px" v-model="form.reply.quoteTarget"><option v-for="o in OPT.quoteTarget" :value="o[0]">{{ o[1] }}</option></select>
            </cfg-row>
            <cfg-row name="尾随表情包" desc="复用 sticker cooldown/sendRate/antiConsecutive">
              <v-switch v-model="form.reply.allowSticker"/>
            </cfg-row>
            <cfg-row name="自动错字" desc="第一版强制关闭（技术内容不误伤）" danger>
              <v-switch v-model="form.reply.typos"/>
            </cfg-row>
          </div></div>
        </div>

        <!-- ===== 行为政策 / 学习 ===== -->
        <div :id="'hz-policy'" class="card cf-sec" :class="{open: open.policy}">
          <div class="cf-sh" @click="open.policy = !open.policy">
            <span class="ct-ico" style="background:var(--grad-rose)"><v-icon name="persona"/></span>
            <div><div class="ct-t">行为政策 / 学习</div><div class="ct-s">「何时参与」（与人设「怎么说」分离）</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.policy"><div class="cf-grid">
            <cfg-row full name="关注主题" desc="命中加分（+10~25）；普通关联场景的主要触发源之一">
              <tag-editor v-model="form.behaviorPolicy.topics" placeholder="如 游戏 / AI / 项目"/>
            </cfg-row>
            <cfg-row full name="回避主题" desc="命中应沉默或谨慎">
              <tag-editor v-model="form.behaviorPolicy.avoidTopics" placeholder="如 私人纠纷"/>
            </cfg-row>
            <cfg-row name="主动性" desc="行为政策主动性 0~1">
              <div class="row g10" style="width:200px">
                <input type="range" class="rng" min="0" max="1" step="0.05" v-model.number="form.behaviorPolicy.initiative" :style="{'--fill': initiativePct}">
                <b class="num" style="width:30px;text-align:right">{{ Number(form.behaviorPolicy.initiative||0).toFixed(2) }}</b>
              </div>
            </cfg-row>
            <cfg-row name="幽默倾向" desc="0~1">
              <div class="row g10" style="width:200px">
                <input type="range" class="rng" min="0" max="1" step="0.05" v-model.number="form.behaviorPolicy.humor" :style="{'--fill': humorPct}">
                <b class="num" style="width:30px;text-align:right">{{ Number(form.behaviorPolicy.humor||0).toFixed(2) }}</b>
              </div>
            </cfg-row>
            <cfg-row name="回答不确定问题" desc="关=事实不足宁可沉默，不编造">
              <v-switch v-model="form.behaviorPolicy.answerUnknownQuestions"/>
            </cfg-row>
            <cfg-row name="打断人类对话" desc="关=顺畅进行的人类对话中保持沉默">
              <v-switch v-model="form.behaviorPolicy.interruptHumanConversation"/>
            </cfg-row>
            <cfg-row name="群内最大回复/10分钟" desc="行为政策层频率上限（覆盖全局）">
              <input type="number" class="inp" style="width:110px" min="0" max="60" v-model.number="form.behaviorPolicy.maxRepliesPer10Minutes">
            </cfg-row>
            <div class="full" style="margin-top:6px;padding-top:10px;border-top:1px dashed var(--line)">
              <div class="mut" style="font-size:12px;font-weight:700;margin-bottom:8px"><v-icon name="info"/> 表达/黑话学习（Phase 4 · 仅 shadow 采集，不进 Prompt）</div>
              <div class="cf-grid">
                <cfg-row name="表达样本采集">
                  <select class="sel" style="width:150px" v-model="form.learning.style"><option v-for="o in OPT.learningStyle" :value="o[0]">{{ o[1] }}</option></select>
                </cfg-row>
                <cfg-row name="黑话样本采集">
                  <select class="sel" style="width:150px" v-model="form.learning.jargon"><option v-for="o in OPT.learningStyle" :value="o[0]">{{ o[1] }}</option></select>
                </cfg-row>
                <cfg-row name="行为学习" desc="第一版建议关闭">
                  <v-switch v-model="form.learning.behavior"/>
                </cfg-row>
                <cfg-row name="最小样本数" desc="达到才生成候选">
                  <input type="number" class="inp" style="width:100px" min="5" v-model.number="form.learning.minSamples">
                </cfg-row>
                <cfg-row name="需人工审核" desc="开=候选须经主人审核才注入；关=自动注入（不建议）">
                  <v-switch v-model="form.learning.requireReview"/>
                </cfg-row>
              </div>
            </div>
          </div></div>
        </div>

        <!-- ===== 安全 / 红线 ===== -->
        <div :id="'hz-safety'" class="card cf-sec" :class="{open: open.safety}">
          <div class="cf-sh" @click="open.safety = !open.safety">
            <span class="ct-ico" style="background:var(--grad)"><v-icon name="shield"/></span>
            <div><div class="ct-t">安全 / 红线</div><div class="ct-s">硬约束（后端强制，不可绕过）</div></div>
            <v-icon class="cf-arrow" name="chevron"/>
          </div>
          <div class="cf-body" v-show="open.safety"><div class="cf-grid">
            <cfg-row name="阻断命令触发" desc="命令消息绝不触发环境回复">
              <v-switch v-model="form.safety.blockCommands"/>
            </cfg-row>
            <cfg-row name="阻断破坏性工具" desc="写/删/管理/终端工具对 Planner 不可见">
              <v-switch v-model="form.safety.blockDestructiveTools"/>
            </cfg-row>
            <cfg-row name="发送前脱敏" desc="拦截回复中的秘钥/Token（redactSecrets）">
              <v-switch v-model="form.redactSecrets"/>
            </cfg-row>
            <cfg-row name="私聊记忆注入群聊" desc="隐私红线：强制 false，不可开启（后端校验会强制改回）" danger>
              <v-switch v-model="form.safety.privateMemoryInGroup" :disabled="true"/>
            </cfg-row>
            <cfg-row name="同时 Planning 群数上限" desc="全局信号量；默认 1（MVP）">
              <input type="number" class="inp" style="width:90px" min="1" max="10" v-model.number="form.safety.maxConcurrentGroups">
            </cfg-row>
            <cfg-row name="@机器人 由 Direct Agent 接管" desc="环境模式不从此触发（独占回复）">
              <v-switch v-model="form.mentionHandledByDirectAgent"/>
            </cfg-row>
            <div class="full" style="margin-top:8px;padding:10px 14px;border:1px dashed var(--line);border-radius:10px;background:rgba(255,255,255,.42)">
              <div class="mut2" style="font-size:12px;line-height:1.7">
                <b>运行期可观察</b>：群里发 <code>#伪人状态</code> 看活跃运行时；<code>#伪人决策 [n]</code> 看最近 n 条门控/规划 trace；
                <code>#伪人开关 on|off</code> 快速切换。保存本页即热加载生效（进行中的规划会被取消）。
              </div>
            </div>
          </div></div>
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
