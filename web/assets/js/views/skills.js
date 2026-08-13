/** 视图:技能(§2.3 · skills/*.md frontmatter + 正文) */
(function () {
  window.VIEWS = window.VIEWS || {}

  window.VIEWS.skills = {
    name: 'SkillsView',
    setup() {
      const { ref, onMounted } = Vue
      const detail = ref(null)
      const q = ref('')
      const filtered = () => window.MOCK.skills.filter((s) =>
        !q.value || s.name.includes(q.value) || s.description.includes(q.value) || s.when.keywords.some((k) => k.includes(q.value)))
      onMounted(async () => { try { await window.store.loadSkills() } catch { /* 忽略 */ } })
      return { skills: window.MOCK.skills, detail, q, filtered }
    },
    template: `
    <div>
      <page-head title="技能" icon="skill" desc="skills/*.md · YAML frontmatter 描述触发条件，正文为使用说明；always=true 常驻注入">
        <input class="inp" style="width:230px" v-model="q" placeholder="搜索名称 / 关键词…">
      </page-head>

      <div class="card" style="--i:1;overflow:hidden">
        <div class="tbl-w">
        <table class="tbl">
          <thead><tr><th style="width:220px">技能</th><th>描述</th><th style="width:90px">优先级</th><th style="width:90px">常驻</th><th style="width:220px">触发关键词</th></tr></thead>
          <tbody>
            <tr v-for="(s, i) in filtered()" :key="s.name" @click="detail = s" style="cursor:pointer">
              <td><span class="mono" style="font-weight:800;color:var(--pri)">{{ s.name }}</span></td>
              <td class="mut ell" style="max-width:300px">{{ s.description }}</td>
              <td><span class="pill" :class="s.priority >= 15 ? 'p-honey' : 'p-line'">P{{ s.priority }}</span></td>
              <td><span class="pill" :class="s.when.always ? 'p-green' : ''">{{ s.when.always ? 'always' : '按需' }}</span></td>
              <td>
                <div class="row g6 wrap">
                  <span v-for="k in s.when.keywords" :key="k" class="pill p-sky" style="font-size:10.5px">{{ k }}</span>
                  <span v-for="r in s.when.regex" :key="r" class="pill p-vio mono" style="font-size:10.5px">{{ r }}</span>
                  <span v-if="!s.when.keywords.length && !s.when.regex.length" class="mut2" style="font-size:11.5px">—</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <empty-state v-if="!filtered().length" icon="search" text="没有匹配的技能"/>
      </div>

      <!-- 详情 -->
      <v-modal v-if="detail" :title="detail.name" icon="skill" width="720px" @close="detail = null">
        <div class="row g6 wrap">
          <span class="pill p-honey">P{{ detail.priority }}</span>
          <span class="pill" :class="detail.when.always ? 'p-green' : 'p-line'">{{ detail.when.always ? 'always 常驻' : '按需触发' }}</span>
          <span v-for="k in detail.when.keywords" :key="k" class="pill p-sky">{{ k }}</span>
        </div>
        <p class="mut mt12" style="font-size:13px">{{ detail.description }}</p>
        <div class="hr"></div>
        <div class="field">
          <label class="f-label">frontmatter</label>
          <pre class="code">---
name: {{ detail.name }}
description: "{{ detail.description }}"
when: [{{ detail.when.keywords.join(', ') }}]
priority: {{ detail.priority }}
always: {{ detail.when.always }}
---</pre>
        </div>
        <div class="field mt16">
          <label class="f-label">正文(markdown)</label>
          <pre class="code" style="white-space:pre-wrap">{{ detail.body }}</pre>
        </div>
      </v-modal>
    </div>`,
  }
})()
