/**
 * Jev 决策规格 —— 问题、准则、阈值与模型 ID 的**单一真源**，一起版本化。
 *
 * 接入文档要求：模型、问题、准则、阈值必须集中一个文件并一起版本化；任何一项变更后回放
 * 一批已知输入验证。这里只放"问什么"与"怎么判"，不放"怎么调"（client.js）与"怎么回退"
 * （decisions.js）。
 *
 * 三个原语构造器与官方 SDK 的 noul/choice/score 输出结构等价（见文档 §6/§7.3），
 * 但本地实现、零依赖：
 *   noul(instructions, criteria?) → { type:'noul', instructions, criteria? }
 *   choice(instructions, options) → { type:'choice', instructions, criteria:{label:desc} }
 *   score(instructions, levels)   → { type:'score', instructions, criteria:[desc] }
 */

export const JEV_SPEC_VERSION = 'jev-spec-1'
/** 默认模型：生产调优阈值后建议固定为版本化 ID（如 jev-1.13.0），并在日志记录响应 model */
export const JEV_MODEL_DEFAULT = 'jev-latest'

export const noul = (instructions, criteria) => (criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions })
export const choice = (instructions, options) => ({ type: 'choice', instructions, criteria: options })
export const score = (instructions, levels) => ({ type: 'score', instructions, criteria: levels })

/**
 * 思考深度判定（choice）。档位定义与 model/llm/thinking.js 的 off/low/medium/high 对齐；
 * 准则描述"情形"而非"程度"（文档 §6.3 铁律）。四档互斥且有覆盖，无需 other 兜底。
 */
export const THINKING_QUESTION = choice(
  'How much internal reasoning does `message` require before a correct answer can be given?',
  {
    off: 'No reasoning needed: greeting, small talk, an emotional reply, a simple fact lookup, or a direct command.',
    low: 'A short single-step reply: simple question and answer, light rewrite or translation, one clear request.',
    medium: 'Needs explanation or reasoning: reading or rewriting code, multi-step tasks, routine debugging, constrained requests.',
    high: 'Complex design or architecture, mathematical derivation or proof, multi-constraint trade-offs, long deep tasks.',
  },
)

/**
 * shell 命令风险判定（choice）。三档按"最坏后果"排序，覆盖只读/可逆/破坏性三类；
 * 传入的是沙箱内命令，故不涉及宿主（但沙箱内数据仍可能不可逆，故保留破坏性档）。
 */
export const SHELL_RISK_QUESTION = choice(
  'What is the worst-case impact of executing `command` inside an isolated Linux sandbox with no access to the host machine?',
  {
    readonly: 'Only reads or inspects data; it changes nothing.',
    reversible: 'Writes or changes files or state, but the change can be undone and does not destroy unrelated data.',
    destructive: 'Deletes or overwrites data, formats disks, kills critical processes, or is otherwise hard or impossible to undo.',
  },
)

/**
 * 工具选择判定（每工具一个 noul，文档 §9.2 语义计数）：Jev 无原生多选，
 * 对每个候选工具问一个是/否，代码按概率阈值聚合为激活集。
 * @param {number} i 候选工具在 state.tools 中的下标（instructions 用反引号指向字段）
 * @param {string} name 工具名（仅用于措辞可读性）
 */
export function toolActiveQuestion(i, name) {
  return noul(
    `Does completing the user request in \`request\` require the tool \`tools[${i}]\` (name "${name}") this turn? `
    + 'Answer yes only if the tool is genuinely needed to complete the request; answer no for merely related or potentially useful tools.',
    {
      true: 'The request cannot be completed without this tool.',
      false: 'The tool is not needed for this request.',
    },
  )
}

/**
 * 反思必要性判定（noul）：交付前是否需要自检回环。state 含 user_request 与 draft_reply。
 * 措辞成"高值=需要反思"，避免双重否定（文档 §13）。
 */
export const REFLECT_QUESTION = noul(
  'Does `draft_reply` need a careful self-review pass before being delivered to the user, given `user_request`?',
  {
    true: 'The reply may be incomplete, inaccurate, inconsistent with the request, or risky; a review could catch and fix a real problem.',
    false: 'The reply is short, simple and clearly correct; a review would waste time and tokens.',
  },
)

/**
 * 置信度三段式门控阈值（文档 §2.4/§10.2）。边界值按"答错的代价"校准，集中可配。
 *  - lowConfidence/highConfidence：通用三段（低→回退；中→保守；高→才碰破坏性）
 *  - thinkingMinConfidence：思考档位低于此值回退规则判档（thinking 非破坏性，保守回退即可）
 *  - toolNoulFloor：noul 概率达到此值才激活该工具（语义计数阈值）
 *  - terminalRiskFloor：破坏性命令需达到此置信度才允许执行（仅 allowDestructive=true 时）
 *  - reflectFloor：反思必要性 noul 概率达到此值才触发反思
 */
export const THRESHOLDS = {
  lowConfidence: 0.5,
  highConfidence: 0.9,
  thinkingMinConfidence: 0.5,
  toolNoulFloor: 0.6,
  terminalRiskFloor: 0.75,
  reflectFloor: 0.5,
}

/** 合并用户覆盖（保留默认值兜底，防止配置缺字段导致门控失效） */
export function resolveThresholds(over = {}) {
  const out = { ...THRESHOLDS }
  for (const k of Object.keys(THRESHOLDS)) {
    const v = Number(over?.[k])
    if (Number.isFinite(v)) out[k] = v
  }
  return out
}
