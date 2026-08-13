/** 视图:会话回放(§3.1 session + §3.2 conversation) */
(function () {
  window.VIEWS = window.VIEWS || {}

  window.VIEWS.sessions = {
    name: 'SessionsView',
    setup() {
      const { ref, computed, onMounted, watch } = Vue
      const M = window.MOCK
      const { fmt } = window.UI

      /* conversations/sessions 接口需 userId+groupId;视图无选择器,默认取首个 scope */
      const userId = ref('')
      const groupId = ref('')
      const activeId = ref('')
      const convs = computed(() => M.conversations)
      const conv = computed(() => M.conversations.find((c) => c.id === activeId.value))
      const session = computed(() => M.sessions[activeId.value] || { messages: [] })

      const showReasoning = ref({})
      const showArgs = ref({})
      const toggleR = (i) => { showReasoning.value[i] = !showReasoning.value[i] }
      const toggleA = (i, j) => { showArgs.value[i + '_' + j] = !showArgs.value[i + '_' + j] }

      const parseArgs = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s } }

      /* 切对话 → 用该对话自带的 scope 拉会话消息（全局列表下每个对话归属不同 scope） */
      watch(activeId, (id) => {
        if (!id) return
        const c = M.conversations.find((x) => x.id === id)
        if (c) window.store.loadSession(id, c.scopeUserId, c.scopeGroupId || 'private').catch(() => {})
      })

      /* 全局加载所有对话（与概览"活跃对话"同源，避免依赖 memories 目录选 scope 导致回放列表为空）→ 默认选最新一条 */
      onMounted(async () => {
        try {
          await window.store.loadConversations()
          if (M.conversations[0]) activeId.value = M.conversations[0].id
        } catch { /* 忽略,运行时未就绪时列表为空 */ }
      })

      return { convs, activeId, conv, session, showReasoning, showArgs, toggleR, toggleA, parseArgs, fmt }
    },
    template: `
    <div class="grid cols-320" style="align-items:start">
      <!-- 对话列表 -->
      <div class="card pad" style="--i:0">
        <div class="ct mb8">
          <span class="ct-ico" style="background:var(--grad-sky)"><v-icon name="session"/></span>
          <div>
            <div class="ct-t">对话列表</div>
            <div class="ct-s" style="font-size:11.5px">按用户维护多对话 · 滑动窗口 20 条</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <div v-for="c in convs" :key="c.id" class="cv-item" :class="{on: c.id === activeId}" @click="activeId = c.id">
            <div class="row-b">
              <span style="font-weight:700;font-size:13px" class="ell">{{ c.title }}</span>
              <span class="pill p-pri" style="flex:0 0 auto">{{ c.count }}</span>
            </div>
            <div class="mut ell" style="font-size:11.5px;margin-top:3px">{{ c.preview }}</div>
            <div class="mut2" style="font-size:10.5px;margin-top:4px">更新 {{ fmt.ago(c.updatedAt) }}</div>
          </div>
        </div>
        <empty-state v-if="!convs.length" icon="session" text="暂无对话"/>
      </div>

      <!-- 消息流 -->
      <div class="card" style="--i:1;overflow:hidden">
        <div class="row-b wrap g10" style="padding:15px 20px;border-bottom:1px solid var(--line);background:rgba(255,255,255,.38)">
          <div style="min-width:0">
            <div style="font-weight:800;font-size:14px">{{ conv?.title || '会话回放' }}</div>
            <div class="mut2 mono ell" style="font-size:11px">{{ session.key }}</div>
          </div>
          <span v-if="session.scopeUserId" class="pill p-mint"><v-icon name="user"/>{{ session.scopeUserId }}</span>
        </div>
        <div class="chat" style="max-height:640px;overflow-y:auto">
          <template v-for="(m, i) in session.messages" :key="i">
            <!-- system -->
            <div v-if="m.role === 'system'" class="msg">
              <div class="m-b s"><b>SYSTEM</b> · {{ m.content }}</div>
            </div>
            <!-- user -->
            <div v-else-if="m.role === 'user'" class="msg u">
              <div class="m-ava" style="background:var(--grad-honey)">我</div>
              <div class="m-b u">{{ m.content }}</div>
            </div>
            <!-- assistant -->
            <div v-else-if="m.role === 'assistant'" class="msg">
              <div class="m-ava" style="background:var(--grad)"><v-icon name="bot" style="width:16px;height:16px"/></div>
              <div style="max-width:76%;min-width:0">
                <div class="m-b a" style="max-width:100%">
                  <span v-if="m.content" style="white-space:pre-wrap">{{ m.content }}</span>
                  <span v-else class="mut2" style="font-size:12px">(无文本,仅工具调用)</span>
                  <div v-if="m.reasoning">
                    <span class="tc-tag" style="background:var(--vio-bg);color:var(--vio);border-color:rgba(134,85,232,.24)" @click="toggleR(i)">
                      <v-icon name="memory"/>推理过程 {{ showReasoning[i] ? '▲' : '▼' }}
                    </span>
                    <Transition name="expand"><pre v-if="showReasoning[i]" class="code mt8" style="white-space:pre-wrap">{{ m.reasoning }}</pre></Transition>
                  </div>
                  <div v-if="m.tool_calls">
                    <span v-for="(tc, j) in m.tool_calls" :key="tc.id" class="tc-tag" @click="toggleA(i, j)">
                      <v-icon name="tool"/>{{ tc.function.name }} {{ showArgs[i + '_' + j] ? '▲' : '▼' }}
                    </span>
                    <Transition name="expand">
                      <div v-if="m.tool_calls.some((tc, j) => showArgs[i + '_' + j])">
                        <pre v-for="(tc, j) in m.tool_calls" v-show="showArgs[i + '_' + j]" :key="tc.id" class="code mt8">{{ parseArgs(tc.function.arguments) }}</pre>
                      </div>
                    </Transition>
                  </div>
                </div>
              </div>
            </div>
            <!-- tool result -->
            <div v-else-if="m.role === 'tool'" class="msg">
              <div class="m-ava" style="background:var(--grad-mint)"><v-icon name="tool" style="width:15px;height:15px"/></div>
              <div class="m-b t"><b>{{ m.name }}</b> → {{ m.content }}</div>
            </div>
          </template>
          <empty-state v-if="!session.messages.length" icon="session" text="该对话暂无消息记录"/>
        </div>
      </div>
    </div>`,
  }
})()
