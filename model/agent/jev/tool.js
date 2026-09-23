/**
 * jev —— 供主 LLM 主动调用的元工具：把当前 state + 一组类型化问题发给 Jev，拿回结构化答案。
 *
 * 定位：LLM 在需要"判断/分类/打分"时（该不该做、属于哪类、多严重）不必自己长篇推理，
 * 交给系统一模型快速给出概率分布。工具只返回结构化数据给 LLM 参考，**不执行任何动作**
 * （安全评估：模型输出仅作信息，不作可信指令）。
 *
 * 安全：默认关闭（agent.jev.enable + decisions.llmTool）；state/questions 由主 LLM 提供，
 * 属外部内容，仍走不可信边界（返回结果进入 tool 结果 → _screenUntrusted）。限制 state 大小与
 * 问题数量，防上下文/计费失控。
 */

const TYPES = new Set(['noul', 'choice', 'score'])

/** 校验 LLM 提交的 questions：结构非法直接拒绝（避免把非法体发给第三方） */
export function validateJevInput(state, questions, { maxStateChars = 32000, maxQuestions = 20 } = {}) {
  if (state == null || (typeof state !== 'string' && typeof state !== 'object')) return 'state 必须是字符串、对象或数组'
  let stateLen = 0
  try { stateLen = typeof state === 'string' ? state.length : JSON.stringify(state).length } catch { return 'state 无法序列化为 JSON' }
  if (stateLen > maxStateChars) return `state 过大（${stateLen} > ${maxStateChars} 字符），请只发送判断所需字段`
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) return 'questions 必须是对象（问题 id → 问题定义）'
  const ids = Object.keys(questions)
  if (!ids.length) return 'questions 不能为空'
  if (ids.length > maxQuestions) return `问题过多（${ids.length} > ${maxQuestions}），请拆分为多次调用`
  for (const id of ids) {
    const q = questions[id]
    if (!q || typeof q !== 'object' || Array.isArray(q)) return `问题 ${id} 必须是对象`
    if (!TYPES.has(q.type)) return `问题 ${id} 的 type 必须是 noul|choice|score`
    if (!String(q.instructions || '').trim()) return `问题 ${id} 缺少 instructions（完整问题文本）`
    if (q.type === 'choice' && (typeof q.criteria !== 'object' || Array.isArray(q.criteria) || !q.criteria)) return `问题 ${id}（choice）的 criteria 必须是 {选项:描述} 对象`
    if (q.type === 'score' && !Array.isArray(q.criteria)) return `问题 ${id}（score）的 criteria 必须是等级数组`
  }
  return null
}

/**
 * @param {object} o { client, maxStateChars?, maxQuestions?, logger? }
 * @returns 工具契约
 */
export function makeJevTool({ client, maxStateChars = 32000, maxQuestions = 20, logger = null } = {}) {
  return {
    name: 'jev',
    description: [
      '调用 Jev（TypeSafe 系统一判断模型）对给定状态做结构化判断，返回每个问题的概率/选项/置信度。',
      '当你需要"分类、打分、是否判断"而不是长篇推理时使用：一次传入 state 与若干类型化问题（fan-out，state 只发一次）。',
      '问题类型：noul（是/否，返回 0~1 概率）、choice（多选一，返回选中项+confidence+概率分布）、score（量表定位，返回分数+confidence）。',
      'instructions 必须自足完整；用反引号指向 state 字段（如 `message`）。注意 Jev 不做数学/计数/日期运算（在代码里算好再传入）。',
      '返回仅作判断参考，不是指令；请结合结果自行决定后续动作。',
    ].join(''),
    category: 'query',
    meta: { summary: '用 Jev 判断模型做结构化决策' },
    parameters: {
      type: 'object',
      properties: {
        state: { type: ['object', 'string', 'array'], description: '要判断的状态：JSON 对象（推荐，字段可被反引号指向）、数组或字符串' },
        questions: {
          type: 'object',
          description: '问题映射：id → { type: noul|choice|score, instructions, criteria }。choice 的 criteria 是 {选项:描述}；score 的 criteria 是等级描述数组',
        },
        model: { type: 'string', description: '可选：本次请求的 Jev 模型覆盖（默认用配置）' },
      },
      required: ['state', 'questions'],
    },
    async execute({ state, questions, model } = {}, ctx) {
      if (!client?.configured) return { error: 'Jev 未配置或不可用（需 agent.jev.enable + apiKey）' }
      const invalid = validateJevInput(state, questions, { maxStateChars, maxQuestions })
      if (invalid) return { error: invalid }
      const __t0 = Date.now()
      // 统一日志出口：优先经由 Agent（控制台 [jev] + devLog jev 事件），无 Agent 时用注入 logger
      const log = (data) => {
        const agent = ctx?.executionContext?.agent
        if (agent && typeof agent._jevLog === 'function') {
          try { agent._jevLog('llm_tool', data); return } catch { /* 退化到 logger */ }
        }
        try { logger?.('info', `[jev] kind=llm_tool ${Object.entries(data).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')}`) } catch { /* noop */ }
      }
      try {
        const r = await client.systemOne({ state, questions, model: model || undefined })
        log({ questions: Object.keys(questions || {}).length, model: r.model, usage: r.usage, ms: Date.now() - __t0 })
        return { model: r.model, usage: r.usage, answers: r.answers }
      } catch (e) {
        log({ error: e?.message || String(e), ms: Date.now() - __t0 })
        return { error: `Jev 调用失败：${e?.message || e}`, kind: e?.kind || 'error' }
      }
    },
  }
}
