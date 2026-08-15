/** 视图:自我状态 SelfState（自我认知与情绪）—— 状态概览 + 关系情感 + 控制
 *  GET /api/selfstate/{overview,relations,stats} + POST /api/selfstate/{reset,clear-member,freeze}
 *  §19 管理页（仅主人）；shadowMode 下计算照常、投影中性。
 */
(function () {
  window.VIEWS = window.VIEWS || {}

  const MOOD_ZH = { positive: '不错', neutral: '平稳', slightly_negative: '有点低落', negative: '明显低落' }
  const EMO_ZH = { amusement: '好笑', joy: '高兴', pride: '自豪', gratitude: '感激', relief: '释然', curiosity: '好奇', annoyance: '烦躁', anger: '生气', hurt: '受伤', sadness: '难过', embarrassment: '尴尬', loneliness: '孤独', disappointment: '失望', anxiety: '不安', resentment: '怨气' }
  const CONCERN_ZH = { unresolved_disrespect: '未解决的不尊重', unresolved_exclusion: '被排斥感', unresolved_rejection: '被拒绝', unappreciated_help: '帮助被轻视', ignored_pattern: '被冷落模式' }

  window.VIEWS.selfstate = {
    name: 'SelfStateView',
    setup() {
      const { ref, reactive, computed, onMounted } = Vue
      const { toast } = window.UI
      const M = window.MOCK

      const tab = ref('state')
      const dataGid = ref('')
      const overview = ref(null)
      const relations = ref([])
      const loading = ref(false)

      const dataGroups = computed(() => ((M.config?.humanize?.groups || []).map(String)))

      const load = async () => {
        if (!dataGid.value) return
        loading.value = true
        try {
          const [ov, rel] = await Promise.all([
            window.api.get('/selfstate/overview', { groupId: dataGid.value }).catch(() => null),
            window.api.get('/selfstate/relations', { groupId: dataGid.value }).catch(() => []),
          ])
          overview.value = ov; relations.value = rel || []
        } catch (e) { toast(e.message, 'error') }
        loading.value = false
      }
      const switchTab = async (t) => {
        tab.value = t
        if (t === 'state' && !dataGid.value && dataGroups.value.length) { dataGid.value = dataGroups.value[0]; await load() }
      }
      const mood = computed(() => {
        const v = Number(overview.value?.state?.valence ?? 0)
        return v >= 0.15 ? 'positive' : v > -0.15 ? 'neutral' : v > -0.45 ? 'slightly_negative' : 'negative'
      })
      const resetGroup = async () => {
        try { await window.api.post('/selfstate/reset', { groupId: dataGid.value }); toast('已重置该群自我状态', 'success'); await load() } catch (e) { toast(e.message, 'error') }
      }
      const clearMember = async (uid) => {
        try { await window.api.post('/selfstate/clear-member', { groupId: dataGid.value, userId: uid }); toast('已清除该成员情感残留', 'success'); await load() } catch (e) { toast(e.message, 'error') }
      }
      const toggleFreeze = async () => {
        try {
          await window.api.post('/selfstate/freeze', { groupId: dataGid.value, frozen: !(overview.value?.state?.expression_frozen) })
          toast(overview.value?.state?.expression_frozen ? '已解冻情绪外显' : '已冻结情绪外显（继续影子计算）', 'success')
          await load()
        } catch (e) { toast(e.message, 'error') }
      }
      const pct = (v) => ((Number(v) || 0) * 100).toFixed(0) + '%'
      const emoZh = (t) => EMO_ZH[t] || t
      const concZh = (t) => CONCERN_ZH[t] || t

      onMounted(async () => { try { await window.store.loadConfig(); if (dataGroups.value.length) { dataGid.value = dataGroups.value[0]; await load() } } catch { /* noop */ } })

      return { tab, switchTab, dataGid, dataGroups, overview, relations, loading, load, mood, resetGroup, clearMember, toggleFreeze, pct, emoZh, concZh, MOOD_ZH }
    },
    template: `
    <div>
      <div class="seg" style="display:inline-flex;margin-bottom:14px;border:1px solid var(--line);border-radius:10px;padding:3px">
        <button class="btn" :class="tab==='state' ? 'b-pri' : 'b-line'" @click="switchTab('state')"><v-icon name="bot"/> 状态概览</button>
        <button class="btn" :class="tab==='relations' ? 'b-pri' : 'b-line'" @click="switchTab('relations')"><v-icon name="group"/> 关系情感</button>
      </div>

      <div class="row g10 wrap" style="margin-bottom:14px;align-items:center">
        <select class="sel" style="width:200px" v-model="dataGid" @change="load">
          <option v-for="g in dataGroups" :value="g">群 {{ g }}</option>
        </select>
        <button class="btn b-soft" @click="load"><v-icon name="refresh"/> 刷新</button>
        <span v-if="overview" class="pill" :class="overview.enabled ? 'p-mint' : 'p-line'">{{ overview.enabled ? '已启用' : '未启用' }}</span>
        <span v-if="overview" class="pill" :class="overview.shadowMode ? 'p-honey' : 'p-rose'">shadow={{ overview.shadowMode }}</span>
        <span v-if="overview?.state?.expression_frozen" class="pill p-rose">外显已冻结</span>
      </div>

      <div v-if="!dataGroups.length" class="note n-rose"><v-icon name="warn"/><div>伪人白名单为空——SelfState 挂在伪人链路上，先在「伪人模式」加群。</div></div>

      <!-- 状态概览 -->
      <div v-else-if="tab==='state'">
        <div v-if="overview" class="row g10 wrap" style="margin-bottom:16px">
          <div class="card" style="flex:1;min-width:130px;padding:12px 14px"><div class="mut2" style="font-size:11px">总体心境</div><div style="font-size:20px;font-weight:800">{{ MOOD_ZH[mood] }}</div></div>
          <div class="card" style="flex:1;min-width:130px;padding:12px 14px"><div class="mut2" style="font-size:11px">精力</div><div style="font-size:20px;font-weight:800">{{ pct(overview.state?.energy) }}</div></div>
          <div class="card" style="flex:1;min-width:130px;padding:12px 14px"><div class="mut2" style="font-size:11px">社交安心感</div><div style="font-size:20px;font-weight:800">{{ pct(overview.state?.social_security) }}</div></div>
          <div class="card" style="flex:1;min-width:130px;padding:12px 14px"><div class="mut2" style="font-size:11px">状态版本</div><div class="mono" style="font-size:20px;font-weight:800">v{{ overview.state?.state_version ?? '-' }}</div></div>
        </div>

        <div class="row g10 wrap">
          <div class="card" style="flex:1.4;min-width:300px;padding:14px">
            <div style="font-weight:800;font-size:13px;margin-bottom:8px">活跃情绪（{{ overview?.emotions?.length || 0 }}）</div>
            <div v-for="e in (overview?.emotions || [])" :key="e.id" class="row g8" style="align-items:center;padding:5px 0;border-bottom:1px solid var(--line)">
              <span class="pill p-honey">{{ emoZh(e.emotion_type) }}</span>
              <div style="flex:1;height:6px;border-radius:3px;background:var(--line);overflow:hidden"><div :style="{width: pct(e.intensity), height:'100%', background:'var(--honey)'}"></div></div>
              <span class="mut2 mono" style="font-size:11px;min-width:70px;text-align:right">{{ (e.intensity*100).toFixed(0) }}% · {{ emoZh(e.cause?.event_type || '').replace(/_/g,' ') || '衰减中' }}</span>
            </div>
            <div v-if="!(overview?.emotions||[]).length" class="mut2" style="font-size:12px;padding:8px 0">暂无活跃情绪</div>
          </div>
          <div style="flex:1;min-width:280px;display:flex;flex-direction:column;gap:10px">
            <div class="card" style="padding:14px">
              <div style="font-weight:800;font-size:13px;margin-bottom:6px">未解决期待（{{ overview?.expectations?.length || 0 }}）</div>
              <div v-for="x in (overview?.expectations || []).slice(0,5)" :key="x.id" class="mut" style="font-size:12px;padding:3px 0">· {{ x.expectation_type }} → {{ x.target_user_id || '任何人' }} · {{ new Date(x.expires_at).toLocaleTimeString('zh-CN') }} 到期</div>
              <div v-if="!(overview?.expectations||[]).length" class="mut2" style="font-size:12px">暂无待回应期待</div>
            </div>
            <div class="card" style="padding:14px">
              <div style="font-weight:800;font-size:13px;margin-bottom:6px">未解决心事（{{ overview?.concerns?.length || 0 }}）</div>
              <div v-for="c in (overview?.concerns || []).slice(0,5)" :key="c.id" class="mut" style="font-size:12px;padding:3px 0">· <b>{{ concZh(c.concern_type) }}</b> → {{ c.target_user_id }}：{{ c.summary?.slice(0, 40) }}</div>
              <div v-if="!(overview?.concerns||[]).length" class="mut2" style="font-size:12px">暂无未决心事</div>
            </div>
            <div class="card" style="padding:14px">
              <div style="font-weight:800;font-size:13px;margin-bottom:6px">最近反思（{{ overview?.reflections?.length || 0 }}）</div>
              <div v-for="r in (overview?.reflections || []).slice(0,3)" :key="r.id" class="mut" style="font-size:12px;padding:3px 0">· {{ r.summary?.slice(0, 60) }}</div>
              <div v-if="!(overview?.reflections||[]).length" class="mut2" style="font-size:12px">暂无反思叙事</div>
            </div>
          </div>
        </div>

        <div class="card" style="margin-top:12px;padding:14px">
          <div style="font-weight:800;font-size:13px;margin-bottom:8px">控制</div>
          <div class="row g10 wrap">
            <button class="btn b-line" @click="resetGroup"><v-icon name="refresh"/> 重置本群自我状态</button>
            <button class="btn b-line" @click="toggleFreeze"><v-icon name="shield"/> {{ overview?.state?.expression_frozen ? '解冻' : '冻结' }}情绪外显</button>
            <span class="mut2" style="font-size:12px">shadow 开关在 配置中心 → 自我状态；误判标记/单事件重评在 日志时间线 ss_event 详情。</span>
          </div>
        </div>
      </div>

      <!-- 关系情感 -->
      <div v-else-if="tab==='relations'">
        <div class="card" style="padding:0;overflow:hidden">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="text-align:left"><th style="padding:8px 12px">成员</th><th>好感</th><th>感激</th><th>受伤</th><th>怨气</th><th>失望</th><th>戒备</th><th>未决</th><th></th></tr></thead>
            <tbody>
              <tr v-for="r in relations" :key="r.user_id" style="border-top:1px solid var(--line)">
                <td style="padding:8px 12px"><b class="mono">{{ r.user_id }}</b></td>
                <td>{{ pct(r.affinity) }}</td><td>{{ pct(r.gratitude) }}</td><td>{{ pct(r.hurt) }}</td>
                <td><span :class="(r.resentment||0) > 0.3 ? 'pill p-rose' : 'pill p-line'">{{ pct(r.resentment) }}</span></td>
                <td>{{ pct(r.disappointment) }}</td><td>{{ pct(r.guardedness) }}</td><td>{{ r.unresolved_event_count || 0 }}</td>
                <td style="text-align:right;padding-right:12px"><button class="btn b-soft b-sm" @click="clearMember(r.user_id)">清除残留</button></td>
              </tr>
              <tr v-if="!relations.length"><td colspan="9" class="mut2" style="padding:20px;text-align:center">暂无关系情感数据（需 selfState.enabled 且有互动积累）</td></tr>
            </tbody>
          </table>
        </div>
        <div class="note" style="margin-top:12px"><v-icon name="info"/><div>管理员调试视图，不向普通群友公开主观关系数据。「清除残留」只清情感列，不动熟悉度/信任。</div></div>
      </div>
    </div>`,
  }
})()
