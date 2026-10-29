/**
 * 锅巴插件（Guoba-Plugin）配置面板适配。
 *
 * Guoba 启动时会扫描各插件目录下的 guoba.support.js，调用导出的 supportGuoba()，
 * 用返回的 schemas 渲染 Web 配置面板。前端点「确定」后调用 setConfigData，
 * 我们把改动合并进 Config 并保存——Config 的 fs.watch 会自动热加载（无需重启 Yunzai）。
 *
 * 适配契约（Guoba-Plugin v1.4.2）：
 *   getConfigData()        返回配置对象，schemas 的 field 用「点路径」从中取值展示
 *   setConfigData(data,{Result})  data = { 'agent.model': value, ... } 点路径映射；持久化后 Result.ok()
 *   component: SOFT_GROUP_BEGIN(分组) / Input / InputTextArea / InputNumber / Switch / Select
 *   Select: componentProps: { options: [{label, value}] }
 */
import Config from './utils/Config.js'
import Log from './utils/Log.js'
import fs from 'node:fs'
import path from 'node:path'
import { setPath } from './utils/path.js'
import { JEV_KEY_MASK } from './model/web/redact.js'
import { BUILTIN_PERSONAS } from './model/persona/defaults.js'

/** setPath 已提取到 utils/path.js（web 路由与 guoba 共用） */

/** 解包 { mcpServers: {...} }（用户常贴 Claude Desktop 标准包装） */
function unwrapServers(s) {
  return s && typeof s === 'object' && s.mcpServers ? s.mcpServers : s
}

/** 默认人设下拉选项：内置 + data/personas 自定义（锅巴面板不支持异步选项，启动时快照） */
function personaOptions() {
  const out = [{ label: '不使用（用 systemPrompt / 内置默认身份）', value: '' }]
  const seen = new Set()
  const push = (p) => {
    if (!p?.id || seen.has(p.id)) return
    seen.add(p.id)
    out.push({ label: `${p.name || p.id}（${p.id}）`, value: p.id })
  }
  for (const p of BUILTIN_PERSONAS) push(p)
  try {
    const dir = Config.path.personas
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try { push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) } catch { /* 跳过坏文件 */ }
    }
  } catch { /* 目录不存在=只有内置 */ }
  return out
}

// 常用选项集
const OPT = {
  trigger: [
    { label: '@机器人触发', value: 'at' },
    { label: '触发词触发', value: 'command' },
    { label: '两者皆可', value: 'both' },
  ],
  bool: [
    { label: '开', value: true },
    { label: '关', value: false },
  ],
  permission: [
    { label: '仅主人', value: 'master' },
    { label: '管理员', value: 'admin' },
    { label: '群主', value: 'owner' },
    { label: '所有人', value: 'all' },
  ],
  guardAction: [
    { label: '拦截(block)', value: 'block' },
    { label: '隔离标注(flag)', value: 'flag' },
    { label: '脱敏(sanitize)', value: 'sanitize' },
  ],
  guardSensitivity: [
    { label: '低(0.95)', value: 'low' },
    { label: '中(0.7)', value: 'medium' },
    { label: '高(0.5)', value: 'high' },
  ],
}

// 支持锅巴
export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'agents-plugin',
      title: 'AI Agents 插件',
      description: '多模型对话 · 工具调用 · 长期记忆 · 人设 · 多模态 · 深度研究 · MCP · 群管 · 终端(E2B 沙箱)',
      author: ['云汐'],
      authorLink: ['https://github.com/'],
      link: 'https://github.com/',
      isV3: true,
      isV2: false,
      showInMenu: 'auto',
      icon: 'mdi:robot-outline',
      iconColor: '#3b82f6',
    },
    configInfo: {
      schemas: [
        // —— 基础 ——
        { label: '基础设置', component: 'SOFT_GROUP_BEGIN' },
        { field: 'debug', label: '调试日志', bottomHelpMessage: '等价于强制开启全链路 devLog（真正日志开关是 agent.devLog.enable）；临时排查时开启', component: 'Switch' },
        { field: 'agent.trigger', label: '触发模式', component: 'Select', componentProps: { options: OPT.trigger } },
        { field: 'agent.triggerCommand', label: '触发词', bottomHelpMessage: 'trigger 为 command/both 时生效，如 #ai', component: 'Input', componentProps: { placeholder: '#ai' } },
        { field: 'agent.chatPermission', label: '#ai 命令权限', component: 'Select', componentProps: { options: OPT.permission } },
        { field: 'agent.masters', label: '接收审批通知的 master QQ', bottomHelpMessage: '每行一个 QQ 号', component: 'InputTextArea', componentProps: { placeholder: '每行一个 QQ 号' } },
        { field: 'agent.systemPrompt', label: '默认身份 systemPrompt', bottomHelpMessage: '留空用富默认身份；被人设覆盖时失效', component: 'InputTextArea' },

        // —— 模型 ——
        // —— Web 管理面板（独立 HTTP 服务，脱离锅巴）——
        { label: 'Web 管理面板', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.webApi.enable', label: '启用 Web 面板', bottomHelpMessage: '独立 HTTP 服务；主人私聊 #agents登录 取带 token 的访问地址（24h 有效）', component: 'Switch' },
        { field: 'agent.webApi.port', label: '面板端口', bottomHelpMessage: '监听 0.0.0.0；默认 6098（避开 Yunzai 2536 / 锅巴 6099）', component: 'InputNumber', componentProps: { min: 1, max: 65535 } },
        { field: 'agent.webApi.publicUrl', label: '对外地址(可选)', bottomHelpMessage: '留空自动探测本机 LAN IP；填 http://1.2.3.4:6098 覆盖', component: 'Input', componentProps: { placeholder: '留空=自动探测' } },

        { label: '模型与对话', component: 'SOFT_GROUP_BEGIN' },
        // 基础模型改为引用制：锅巴无联动控件，此处只手填厂商条目 id / 模型条目 id；
        // 厂商端点与模型条目请在 Web 配置中心（#agents登录 → 厂商配置 / 模型列表）维护。
        { field: 'agent.providerId', label: '基础厂商 ID', bottomHelpMessage: '「厂商配置」里厂商条目的 id（含接口地址与 Key）；空=未选厂商', component: 'Input', componentProps: { placeholder: '如 pxxxx' } },
        { field: 'agent.modelId', label: '基础模型 ID', bottomHelpMessage: '「模型列表」里模型条目的 id（须挂在上述厂商下）；空=未选模型', component: 'Input', componentProps: { placeholder: '如 mxxxx' } },
        { field: 'agent.utilityModel', label: '播报小模型(可选)', bottomHelpMessage: '进度播报等旁路任务用的小模型；留空=沿用主模型。可填任意已注册厂商的模型（运行时按注册表解析端点，不再局限主厂商）', component: 'Input', componentProps: { placeholder: '留空=主模型' } },
        { field: 'agent.fallbackModel', label: '回退模型ID(可选)', bottomHelpMessage: '主模型失败时回退到的模型，如 gpt-4o / claude-3-5-sonnet；可跨厂商（另配下面的 URL+Key/协议）。与 yaml fallbackModels 数组并存时数组先试、本项排最后', component: 'Input', componentProps: { placeholder: '留空=不回退' } },
        { field: 'agent.fallbackBaseURL', label: '回退模型URL', bottomHelpMessage: '回退模型的 baseURL', component: 'Input', componentProps: { placeholder: 'https://api.openai.com/v1' } },
        { field: 'agent.fallbackApiKey', label: '回退模型Key', component: 'Input', componentProps: { placeholder: 'sk-gpt-xxx' } },
        { field: 'agent.fallbackProtocol', label: '回退模型协议', component: 'Select', componentProps: { options: [{ label: 'openai', value: 'openai' }, { label: 'anthropic', value: 'anthropic' }] } },
        { field: 'agent.proxy', label: '代理(可选)', bottomHelpMessage: 'HTTP/SOCKS 代理（http://host:port 或 socks5://host:port），国内访问 GPT/Gemini 等海外 LLM；留空=直连', component: 'Input', componentProps: { placeholder: '留空=直连' } },
        { field: 'agent.maxTurns', label: '工具调用轮次上限', bottomHelpMessage: '默认 200；上限放宽到 1000（此前面板上限 100 会把默认值静默截断）', component: 'InputNumber', componentProps: { min: 1, max: 1000 } },
        { field: 'agent.temperature', label: '采样温度', bottomHelpMessage: '留空=厂商默认', component: 'InputNumber', componentProps: { min: 0, max: 2, step: 0.1 } },
        { field: 'agent.maxTokens', label: '单次回复最大 token', bottomHelpMessage: '留空=厂商默认（Anthropic 默认 4096）', component: 'InputNumber', componentProps: { min: 1 } },

        // —— 上下文与流式 ——
        { label: '上下文与流式', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.contextWindow', label: '上下文窗口(token)', bottomHelpMessage: '请填模型真实窗口（如 32000）：留空=按消息条数 30→18 压缩；填写后按 contextHighRatio（默认 65%）→ contextLowRatio（默认 45%）高低水位压缩（保留首条意图）', component: 'InputNumber', componentProps: { min: 1000 } },
        { field: 'agent.maxToolResultChars', label: '工具结果字符上限', component: 'InputNumber', componentProps: { min: 100 } },
        { field: 'agent.keepReasoning', label: '回灌推理(reasoning)到历史', bottomHelpMessage: '默认关：省 context', component: 'Switch' },
        { field: 'agent.stream', label: '逐字流式输出', bottomHelpMessage: '依赖适配器，不稳；默认关', component: 'Switch' },
        { field: 'agent.progress', label: '工具调用进度消息', bottomHelpMessage: '消除干等；默认开', component: 'Switch' },
        { field: 'agent.progressRecall', label: '进度消息撤回(秒)', bottomHelpMessage: 'N 秒后自动撤回进度消息；0=不撤回；适配器不支持则忽略', component: 'InputNumber', componentProps: { min: 0, max: 120 } },
        { field: 'agent.reply.mode', label: '回复渲染方式', component: 'Select', componentProps: { options: [{ label: '图片（markdown→精美浅色图，默认）', value: 'image' }, { label: '纯文本', value: 'text' }] } },
        { field: 'agent.reply.narrate', label: '中途播报', bottomHelpMessage: '模型调工具时附带的思路/进展自动转发给用户（别埋头苦干）；默认开', component: 'Switch' },
        { field: 'agent.reply.renderScale', label: '回复图清晰度倍率', bottomHelpMessage: 'deviceScaleFactor：3=超清（默认）/ 2=高清 / 1=普通；越大越清晰但越耗内存', component: 'InputNumber', componentProps: { min: 1, max: 4 } },

        // —— 记忆与召回 ——
        { label: '记忆与召回', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.memory.enable', label: '声明式记忆', bottomHelpMessage: '注入 MEMORY.md/USER.md 到 system；默认开', component: 'Switch' },
        { field: 'agent.memory.threatScan', label: '记忆注入扫描', bottomHelpMessage: '写长期记忆前扫描指令注入（命中标 suspect，召回屏蔽，#记忆 仍可见原文）；默认开', component: 'Switch' },
        { field: 'agent.recall.cap', label: '长期记忆条数上限', bottomHelpMessage: '每用户上限；超限按价值(confidence/level/时间)淘汰，非 FIFO', component: 'InputNumber', componentProps: { min: 10 } },
        { field: 'agent.recall.extractEvery', label: 'LLM 抽取间隔(轮)', bottomHelpMessage: '每 N 轮触发一次 LLM 抽取（意图词"记住/叫我"等仍即时触发）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.recall.model', label: '抽取用模型(可选)', bottomHelpMessage: '留空=utilityModel→主模型；可跨厂商（填模型 id 或已注册模型名）', component: 'Input', componentProps: { placeholder: '留空=主模型' } },
        { field: 'agent.recall.embedProvider', label: '语义召回 embedding(可选)', bottomHelpMessage: '填 embedding 模型 id 走 cosine 语义匹配；留空=关键词 jaccard 召回', component: 'Input', componentProps: { placeholder: '留空=关键词召回' } },
        { field: 'agent.recall.minScore', label: '召回最低分', bottomHelpMessage: '低于此综合分的记忆不注入（0=仅过滤零相关；配 embedding 后可调大如 0.3 更严格）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.recall.diversity.enable', label: '召回去冗余(MMR)', bottomHelpMessage: '候选多于要取条数时兼顾相关与多样，避免同义旧事挤满上下文；默认开', component: 'Switch' },
        { field: 'agent.recall.diversity.lambda', label: '去冗余相关权重', bottomHelpMessage: '1=纯相关排序；越小越鼓励多样（建议 0.5~0.8）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.recall.diversity.perTypeCap', label: '同类型最多条数', bottomHelpMessage: '同一记忆类型最多入选条数（选不满时自动放宽）', component: 'InputNumber', componentProps: { min: 1, max: 10 } },
        { field: 'agent.recall.usage.enable', label: '记忆使用反馈', bottomHelpMessage: '记录注入/被引用；反复注入却从未被引用的记忆自动降权；默认开', component: 'Switch' },

        // —— 用户画像（统一用户模型）——
        { label: '用户画像（统一用户模型）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.profile.enable', label: '启用用户画像', bottomHelpMessage: '跨会话归纳身份/沟通风格/偏好/忌讳，动态注入；带证据可纠错；默认开', component: 'Switch' },
        { field: 'agent.profile.infer', label: '隐式风格推断', bottomHelpMessage: '从消息长度/表情/提问率/活跃时段推断沟通风格（标注"推断"）；默认开', component: 'Switch' },
        { field: 'agent.profile.maxChars', label: '画像注入上限(字符)', bottomHelpMessage: '注入 system 动态块的字符上限，防膨胀', component: 'InputNumber', componentProps: { min: 100, max: 2000, step: 50 } },
        { field: 'agent.profile.maxPerFacet', label: '每分面保留条数', bottomHelpMessage: '身份/偏好/沟通风格等每个分面最多保留条数，低置信先淘汰', component: 'InputNumber', componentProps: { min: 1, max: 20 } },

        // —— 在线自进化 ——
        // —— 工具按需发现 ——
        { label: '工具按需发现（Tool Discovery）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.toolDiscovery.enable', label: '启用按需发现', bottomHelpMessage: '控制 system 工具速查与 tool_search/激活记录；默认开。注意 stableList=true 时 tools schema 仍每轮全量下发（缓存优先），本开关不减少 schema token', component: 'Switch' },
        { field: 'agent.toolDiscovery.alwaysOn', label: '常驻工具(每行一个)', bottomHelpMessage: '不经过搜索、始终可用的工具名（每行一个）；留空=用内置默认（含 tool_search / clarify / memory_search / web_search / kb_search / skill / get_chat_history / reminder_set / schedule_task / context_recall / diagram_render / 群文件工具等）', component: 'InputTextArea' },
        { field: 'agent.toolDiscovery.topK', label: 'tool_search 返回数', component: 'InputNumber', componentProps: { min: 1, max: 20 } },
        { field: 'agent.toolDiscovery.stableList', label: '工具数组跨轮恒定', bottomHelpMessage: '每轮下发全量工具定义（首轮多付约 1 万 token，之后全部命中缓存）。关掉会随工具激活改变 tools 数组，实测任何变化都会让整段 prompt 缓存归零（命中率 0%）', component: 'Switch' },
        { field: 'agent.toolDiscovery.minScore', label: '最低相似度', bottomHelpMessage: '低于此值不返回；jaccard 下 0.1 较宽松', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },

        { label: '在线自进化', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.selfReview.enable', label: '后台自评审', bottomHelpMessage: '每 N 轮对话后台异步自我评审，产出改进 suggestion；不阻塞回复；默认开', component: 'Switch' },
        { field: 'agent.selfReview.every', label: '评审间隔(轮)', bottomHelpMessage: '每 N 轮对话触发一次后台自评审', component: 'InputNumber', componentProps: { min: 5 } },
        { field: 'agent.selfReview.model', label: '评审用模型(可选)', bottomHelpMessage: '留空=utilityModel→主模型；建议廉价小模型降本；可跨厂商', component: 'Input', componentProps: { placeholder: '留空=主模型' } },
        { field: 'agent.selfReview.autoApplyMemory', label: '记忆自动应用', bottomHelpMessage: '记忆类 suggestion 自动写入（有回滚+威胁扫描+置信度闸）；默认开', component: 'Switch' },
        { field: 'agent.selfReview.autoApplyPrompt', label: 'prompt 自动应用【不建议】', bottomHelpMessage: 'prompt/技能类自动应用；默认关（落盘待审，#审阅进化 人工把关）', component: 'Switch' },
        { field: 'agent.selfReview.dailyBudgetTokens', label: '日 token 预算', bottomHelpMessage: '自评审日预算上限，耗尽则只采迹不评审', component: 'InputNumber', componentProps: { min: 0, step: 10000 } },

        // —— 工具进化（Tool Evolution）——
        { label: '工具进化（Tool Evolution）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.toolEvo.enable', label: '工具进化', bottomHelpMessage: '版本化工具库：生成→AST/沙箱验证→审批→晋升；默认开', component: 'Switch' },
        { field: 'agent.toolEvo.maxRepairAttempts', label: '候选修复次数', bottomHelpMessage: '候选生成失败自动修复上限（建议≤2，防把安全限制修掉）', component: 'InputNumber', componentProps: { min: 0, max: 3 } },

        // —— 深度思考 ——
        { label: '深度思考（Thinking）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.thinking.enable', label: '开启深度思考', bottomHelpMessage: 'Anthropic 等支持的扩展思考：模型先思考再作答（更慢、更耗 token，但复杂问题质量更高）', component: 'Switch' },
        { field: 'agent.thinking.budget_tokens', label: '思考预算(tokens)', component: 'InputNumber', componentProps: { min: 1024, max: 64000, step: 1024 } },
        { field: 'agent.thinkingAuto.enable', label: '思考自动决策', bottomHelpMessage: '按提问复杂度自动决定是否思考与深度（闲聊不思考、复杂问题深度思考）；开启后覆盖上面的手动 thinking（模型级覆盖仍优先）。能力表未表态的新型号默认乐观启用；厂商拒绝思考字段会自动剥离记忆（转不支持，无需重启）', component: 'Switch' },
        { field: 'agent.thinkingAuto.classifier', label: '判档方式', bottomHelpMessage: 'auto=规则不确定时用小模型判（省调用）/ always=总是小模型 / off=纯规则 / jev=由 Jev 判档（需开启 Jev）', component: 'Select', componentProps: { options: [{ label: 'auto（小模型+规则）', value: 'auto' }, { label: 'always（总是小模型）', value: 'always' }, { label: 'off（纯规则）', value: 'off' }, { label: 'jev（由 Jev 判档，需开启 Jev）', value: 'jev' }] } },
        { field: 'agent.thinkingAuto.model', label: '判档小模型(可选)', bottomHelpMessage: '留空=utilityModel→主模型；建议用廉价小模型降本', component: 'Input', componentProps: { placeholder: '留空=utilityModel' } },
        { field: 'agent.thinkingAuto.timeoutMs', label: '判档超时(ms)', bottomHelpMessage: '小模型判档超时/失败自动回退规则', component: 'InputNumber', componentProps: { min: 500, max: 15000, step: 500 } },
        { field: 'agent.thinkingAuto.maxBudget', label: '自动预算上限(tokens)', bottomHelpMessage: '自动模式单轮思考预算硬顶，防烧太多', component: 'InputNumber', componentProps: { min: 1024, max: 128000, step: 1024 } },
        { field: 'agent.thinkingAuto.budgets.low', label: '低深度预算', component: 'InputNumber', componentProps: { min: 1024, max: 64000, step: 1024 } },
        { field: 'agent.thinkingAuto.budgets.medium', label: '中深度预算', component: 'InputNumber', componentProps: { min: 1024, max: 64000, step: 1024 } },
        { field: 'agent.thinkingAuto.budgets.high', label: '高深度预算', component: 'InputNumber', componentProps: { min: 1024, max: 128000, step: 1024 } },

        // —— Jev（TypeSafe 判断模型，opt-in，作为「厂商 + 模型」注册）——
        {
          label: 'Jev 判断模型（TypeSafe）',
          component: 'SOFT_GROUP_BEGIN',
        },
        {
          field: 'agent.jev.enable',
          label: '启用 Jev',
          bottomHelpMessage: '⚠️ 会把用户对话内容与 shell 命令发往第三方 TypeSafe（typesafe.ai）做结构化判断，属新增数据外发面。默认关闭；失败/低置信一律无感回退现有方案。需先在「厂商配置」添加 preset=jev 的厂商（或 OpenRouter）、在「模型列表」给它挂 jev 模型。语言/工具/失败路径见 Web 配置中心。',
          component: 'Switch',
        },
        { field: 'agent.jev.providerId', label: 'Jev 厂商 id', bottomHelpMessage: '引用 llmProviders[].id（preset=jev 或 openrouter）；推荐用 Web 配置中心下拉选择', component: 'Input' },
        { field: 'agent.jev.modelId', label: 'Jev 模型条目 id', bottomHelpMessage: '引用 llmModels[].id（挂在上面厂商下）', component: 'Input' },
        { field: 'agent.jev.model', label: 'Jev 模型 ID（手填）', bottomHelpMessage: '留空=用 modelId 指向的注册模型；可直接填 jev-latest / jev-1.13.0', component: 'Input', componentProps: { placeholder: 'jev-latest' } },
        { field: 'agent.jev.timeoutMs', label: 'Jev 超时(ms)', bottomHelpMessage: '超时/失败自动回退现有方案；Jev 典型延迟 ~100-300ms', component: 'InputNumber', componentProps: { min: 500, max: 60000, step: 500 } },
        { field: 'agent.jev.maxRetries', label: 'Jev 重试次数', bottomHelpMessage: '408/429/5xx 指数退避重试（401/422 不重试）；连续失败 3 次熔断 30s', component: 'InputNumber', componentProps: { min: 0, max: 5 } },
        { field: 'agent.jev.decisions.llmTool', label: '注册 jev 工具', bottomHelpMessage: '让主 LLM 在需要判断时主动把 state+questions 发给 Jev 取结构化答案', component: 'Switch' },
        { field: 'agent.jev.decisions.terminalRisk', label: 'shell：Jev 风险检查', bottomHelpMessage: 'terminal 执行前用 Jev 判只读/可逆/破坏性；破坏性默认拒绝（回退：现有行为）', component: 'Switch' },
        { field: 'agent.jev.allowDestructive', label: 'shell：允许破坏性命令', bottomHelpMessage: '⚠️ 关闭=破坏性一律拒绝（fail-closed，推荐）；开启=仅当 Jev 置信度≥破坏性阈值才放行', component: 'Switch' },
        { field: 'agent.jev.thresholds.toolNoulFloor', label: '工具激活阈值', bottomHelpMessage: '工具 noul 概率达到此值才激活（0~1）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.jev.thresholds.terminalRiskFloor', label: '破坏性命令置信阈值', bottomHelpMessage: '仅「允许破坏性命令」开启时用于高置信放行判定（0~1）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.jev.thresholds.thinkingMinConfidence', label: '思考档位置信阈值', bottomHelpMessage: 'thinkingMinConfidence：低于则回退规则判档（0~1）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.jev.thresholds.reflectFloor', label: '反思触发阈值', bottomHelpMessage: 'reflectFloor：noul 概率达标才反思（0~1）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },

        // —— Shell 命令安全 + 工具选择方法 ——
        { label: 'Shell 命令安全', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.shell.intercept', label: '自定义拦截指令', bottomHelpMessage: '大小写不敏感子串匹配，命中即拒绝 terminal 执行；每行一条（如 rm -rf /）。留空=不拦截。推荐用 Web 配置中心编辑', component: 'InputTextArea', componentProps: { rows: 3, placeholder: '每行一条，如：\nrm -rf /\nmkfs' } },
        { field: 'agent.toolDiscovery.method', label: '工具选择方法', bottomHelpMessage: 'llm=主 LLM 经 tool_search 自主发现（默认）/ jev=由 Jev 从全量工具目录选择（需开启 Jev）', component: 'Select', componentProps: { options: [{ label: 'llm 自主发现和选择', value: 'llm' }, { label: 'jev 决策', value: 'jev' }] } },

        // —— 安全与审批 ——
        { label: '安全与审批', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.guardAction', label: '注入防御动作', component: 'Select', componentProps: { options: OPT.guardAction } },
        { field: 'agent.guardSensitivity', label: '防御灵敏度', component: 'Select', componentProps: { options: OPT.guardSensitivity } },
        { field: 'agent.untrustedGuard', label: '外部内容注入扫描', bottomHelpMessage: '工具结果/网页/MCP/记忆等外部内容命中注入特征时加边界标注（不阻断）；默认开，关闭会削弱间接注入防御', component: 'Switch' },
        { field: 'agent.persona.defaultId', label: '默认人设', bottomHelpMessage: '未单独 #人设 切换的用户生效；留空=用「默认身份 systemPrompt」/内置默认身份。选项=内置+自定义人设（新增人设后重载插件刷新）', component: 'Select', componentProps: { options: personaOptions() } },
        { field: 'agent.persona.skipInjectionCheck', label: '人设注入检测免检【高危】', helpMessage: '⚠️ 高危！开启后新建/编辑人设、人设资料不再校验「疑似越狱/提示注入」，内容会原样进入 system 身份层。', bottomHelpMessage: '默认关。仅在你完全信任自建角色卡时开启；命中误报时可临时开启保存后再关闭（已保存内容不会再次扫描）。', component: 'Switch' },
        { field: 'agent.contextHighRatio', label: '压缩高水位比例', bottomHelpMessage: '仅填了 contextWindow 后生效：历史占窗口比例超过它触发压缩（默认 0.65；256K 窗口建议 0.8）。越晚压越省缓存，命中率公式见 README「缓存经济性」', component: 'InputNumber', componentProps: { min: 0.3, max: 0.95, step: 0.05 } },
        { field: 'agent.contextLowRatio', label: '压缩低水位比例', bottomHelpMessage: '压缩后保留到该比例（默认 0.45，须小于高水位）。压得越深则每轮新增相对越少、稳态命中率越高', component: 'InputNumber', componentProps: { min: 0.05, max: 0.9, step: 0.05 } },
        { field: 'agent.redactSecrets', label: '回复脱敏(屏蔽 API Key)', bottomHelpMessage: '发送前屏蔽回复里的密钥/token；默认开', component: 'Switch' },
        { field: 'agent.confirmTimeout', label: '审批超时(秒)', component: 'InputNumber', componentProps: { min: 10 } },
        {
          field: 'agent.masterSkipConfirm',
          label: '主人任务免确认【高危】',
          helpMessage: '高危！开启后主人发起的确认类工具（如 terminal 写命令）跳过 #确认 直接执行。',
          bottomHelpMessage: '⚠️ 高危：开启后主人的命令不再审批、直接执行（仅在控制台打印日志，不在聊天提示，防刷屏）。denylist 灾难命令仍硬拦。开启即视为你知晓风险、自担后果。默认关。',
          component: 'Switch',
        },

        // —— 视觉 ——
        { label: '视觉子模型', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.vision.enable', label: '启用视觉子模型', bottomHelpMessage: '主模型不支持视觉时，由它把图转文本', component: 'Switch' },
        { field: 'agent.vision.model', label: '视觉模型 ID', component: 'Input', componentProps: { placeholder: 'mimo-2.5' } },
        { field: 'agent.vision.apiKey', label: '视觉模型 API Key', bottomHelpMessage: '空则复用主 apiKey', component: 'Input' },

        // —— 情境感知 ——
        { label: '情境感知', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.perception.sparseInject', label: '稀薄上下文补全群聊', bottomHelpMessage: '新会话/历史很少时，额外注入一小段近期群聊记录，避免模型对群内近况一无所知。默认开', component: 'Switch' },
        { field: 'agent.perception.sparseThreshold', label: '补全触发阈值(条)', bottomHelpMessage: '会话历史少于该条数时触发上面的补全（默认 6）', component: 'InputNumber', componentProps: { min: 0, max: 100 } },

        // —— 深度研究 ——
        { label: '深度研究', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.research.permission', label: '#研究 权限', component: 'Select', componentProps: { options: [{ label: '仅主人(防滥用)', value: 'master' }, { label: '所有人', value: 'all' }] } },
        { field: 'agent.research.maxRounds', label: '最大轮次', component: 'InputNumber', componentProps: { min: 1, max: 10 } },
        { field: 'agent.research.workerModel', label: '子代理模型', bottomHelpMessage: '空则用主模型；可填任意已注册厂商的模型省钱（可跨厂商）', component: 'Input' },

        // —— 搜索服务 ——
        { label: '搜索服务（web_search / 深度研究）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.search.tavily.apiKey', label: 'Tavily API Key', bottomHelpMessage: '任填一个即启用该源；都不填回退 SearXNG，再兜底 DDG', component: 'Input', componentProps: { placeholder: 'tvly-xxx' } },
        { field: 'agent.search.exa.apiKey', label: 'Exa API Key', component: 'Input' },
        { field: 'agent.search.perplexity.apiKey', label: 'Perplexity API Key', component: 'Input' },
        { field: 'agent.search.brave.apiKey', label: 'Brave API Key', component: 'Input' },
        { field: 'agent.search.searxng.url', label: 'SearXNG 地址', bottomHelpMessage: '自建/公共 SearXNG 实例', component: 'Input', componentProps: { placeholder: 'http://localhost:8080' } },
        { field: 'agent.search.ddg', label: 'DDG 兜底', bottomHelpMessage: '本地 DuckDuckGo，免 key、默认开（最后兜底）', component: 'Switch' },
        { field: 'agent.search.timeout', label: '搜索超时(ms)', bottomHelpMessage: '0/留空=各源默认（DDG 15s）；慢源可调大', component: 'InputNumber', componentProps: { min: 0, max: 120000 } },

        // —— MCP ——
        { label: '网页抓取（抗反爬）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.kb.crawl.engine', label: '抓取引擎', bottomHelpMessage: 'crawl4ai=真浏览器渲染（默认，需 scripts/install-crawl4ai.sh 装好）；fetch=纯 HTTP+cheerio', component: 'Select', componentProps: { options: [{ label: 'crawl4ai 浏览器', value: 'crawl4ai' }, { label: '纯 HTTP fetch', value: 'fetch' }] } },
        { field: 'agent.kb.crawl.execution', label: '抓取执行位置', bottomHelpMessage: 'local=宿主 venv crawl4ai（默认，与 sandbox.mode 无关）；sandbox=在 E2B 沙箱内跑（需模板预装 crawl4ai，未就绪降级纯 HTTP fetch）', component: 'Select', componentProps: { options: [{ label: '宿主(local，推荐)', value: 'local' }, { label: '沙箱(sandbox)', value: 'sandbox' }] } },
        { field: 'agent.kb.crawl.stealth', label: '反检测', bottomHelpMessage: 'playwright-stealth + 模拟用户行为，默认开', component: 'Switch' },
        { field: 'agent.kb.crawl.retryBlocked', label: '被拦后强化重试', bottomHelpMessage: '403/CF 挑战等被拦时自动 undetected+stealth 再试一轮', component: 'Switch' },
        { field: 'agent.kb.crawl.allowPrivateHosts', label: '允许抓内网', bottomHelpMessage: '允许抓本机/内网/元数据地址（默认禁，防 SSRF）。本机 DNS 把公网域名解析到内网时也需要它', component: 'Switch' },
        { field: 'agent.kb.crawl.sessionPersist', label: '站点会话持久化', bottomHelpMessage: '按 host 保存 cookie（含 CF 清关凭证）到 data/crawl/sessions.json（0600），按下方「会话有效期」复用（默认 12h）', component: 'Switch' },
        { field: 'agent.kb.crawl.sessionTtlHours', label: '会话有效期(小时)', component: 'InputNumber', componentProps: { min: 0.1, max: 720, step: 1 } },
        { field: 'agent.kb.crawl.sessionProfile', label: '持久浏览器 profile', bottomHelpMessage: '保留完整浏览器 profile（登录态更稳），但浏览器会全局串行、占磁盘；默认关', component: 'Switch' },
        { field: 'agent.kb.crawl.siteMemory', label: '站点难度记忆', bottomHelpMessage: '记住上次哪档有效：fetch 够用就不再起浏览器；被拦过下次直接 undetected', component: 'Switch' },
        { field: 'agent.kb.crawl.perHostIntervalMs', label: '同站最小间隔(ms)', bottomHelpMessage: '默认 1200，含抖动；同一对话连抓几个页面时最重要', component: 'InputNumber', componentProps: { min: 0, max: 60000, step: 100 } },
        { field: 'agent.kb.crawl.hostConcurrency', label: '同站并发', bottomHelpMessage: '默认 1（串行）', component: 'InputNumber', componentProps: { min: 1, max: 8 } },
        { label: '临时文件与下载', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.tempFiles.enable', label: '自动清理 data/temp', bottomHelpMessage: '转档/截图/下载产物长期堆积占盘；默认开', component: 'Switch' },
        { field: 'agent.tempFiles.ttlHours', label: '保留小时数', component: 'InputNumber', componentProps: { min: 1, max: 720 } },
        { field: 'agent.tempFiles.maxFiles', label: '最多保留文件数', component: 'InputNumber', componentProps: { min: 10, max: 100000 } },
        { field: 'agent.download.allowPrivateHosts', label: '允许下载内网地址', bottomHelpMessage: 'web_download 默认拒绝环回/内网/元数据地址（防 SSRF）；确认环境可信时才开', component: 'Switch' },
        { label: 'MCP 服务端', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.mcp.requestTimeout', label: '请求超时(毫秒)', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },
        {
          field: 'agent.mcp.serversJson',
          label: 'MCP 服务端（粘贴新增 · 自动合并）',
          helpMessage: '粘贴标准 mcpServers JSON（如 { "mcpServers": { "名字": { "command":"npx", "args":[...] } } }），保存时自动合并：新服务加入、同名更新、其它已有服务一律保留。可反复粘贴累积多个。删除某个服务用聊天指令 #停止mcp <名字>。',
          bottomHelpMessage: '示例（粘一个就加一个，互不覆盖）：\n{\n  "mcpServers": {\n    "moegirl": { "command": "npx", "args": ["-y", "moegirl-wiki-mcp"] }\n  }\n}\n\nstdio：command/args/env；http：type/url/headers。框里默认显示你现有的全部服务；保存**只增/改、不删**——删除某个服务请用聊天指令 #停止mcp <名字>。Docker 精简镜像无 npx 见 README「agent.mcp」排查。',
          component: 'InputTextArea',
          componentProps: { placeholder: '{\n  "mcpServers": {\n    "xxx": { "command": "npx", "args": ["-y", "xxx"] }\n  }\n}', autosize: { minRows: 8, maxRows: 24 } },
        },

        // —— E2B 沙箱（terminal 的唯一执行面）——
        { label: 'E2B 沙箱（终端执行）', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'agent.sandbox.mode',
          label: '执行面模式',
          helpMessage: 'off=不注册终端工具（宿主无 shell 执行面）；e2b=命令在 E2B 微虚机内执行。',
          bottomHelpMessage: '沙箱化后不再有 #确认 审批与命令黑名单：命令跑在独立 Firecracker microVM 里，网络出口默认放通。**全员可用**（按会话隔离沙箱，无需认领主人；成本由单会话命令数/并发/超时上限兜底）。要收紧出口请到 yaml / Web 配置中心的 agent.sandbox.network 配 allowOut 白名单，或 allowInternet:false 断网。连不上 E2B 时一律拒绝执行（绝不回退到本机）。',
          component: 'Select',
          componentProps: { options: [{ label: 'off（关闭）', value: 'off' }, { label: 'e2b（沙箱执行）', value: 'e2b' }] },
        },
        { field: 'agent.sandbox.apiKey', label: 'E2B API Key', bottomHelpMessage: 'E2B 云或自托管团队的 key（敏感：已在回复脱敏中屏蔽）', component: 'Input', componentProps: { placeholder: 'e2b_xxx' } },
        { field: 'agent.sandbox.apiUrl', label: '控制面地址(自托管)', bottomHelpMessage: '如 http://192.168.1.10:3000；云托管留空', component: 'Input', componentProps: { placeholder: '留空=云默认' } },
        { field: 'agent.sandbox.domain', label: '沙箱域名(自托管)', bottomHelpMessage: '自托管沙箱域名；云托管留空', component: 'Input', componentProps: { placeholder: '留空=云默认 e2b.app' } },
        { field: 'agent.sandbox.sandboxUrl', label: '数据面地址(自托管)', bottomHelpMessage: '无通配 DNS 时填 client-proxy 地址（如 http://<host>:3002）；留空=默认', component: 'Input', componentProps: { placeholder: '留空=默认' } },
        { field: 'agent.sandbox.template', label: '沙箱模板', bottomHelpMessage: 'CPU/内存/预装依赖由模板承载（官方 base 起步）', component: 'Input', componentProps: { placeholder: 'base' } },
        { field: 'agent.sandbox.maxTimeout', label: '单命令超时上限(秒)', component: 'InputNumber', componentProps: { min: 1, max: 3600 } },
        { field: 'agent.sandbox.maxSandboxes', label: '并发沙箱上限', bottomHelpMessage: '超出进入等待队列；等待超时按配额失败', component: 'InputNumber', componentProps: { min: 1, max: 64 } },
        { field: 'agent.sandbox.idleMs', label: '闲置回收(毫秒)', bottomHelpMessage: '会话沙箱空闲超时后销毁（默认 300000=5 分钟）', component: 'InputNumber', componentProps: { min: 10000, step: 10000 } },
        { field: 'agent.sandbox.maxCommandsPerSession', label: '单会话命令数上限', bottomHelpMessage: '防长任务把配额/账单打爆；0=不限', component: 'InputNumber', componentProps: { min: 0 } },

        // —— Stagehand 浏览器自动化 ——
        { label: 'Stagehand 浏览器自动化', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.stagehand.enable', label: '启用浏览器自动化', bottomHelpMessage: 'act/extract/observe 自然语言原语；访问权限由下方「访问权限」控制（默认仅框架主人），act 写动作需 #确认。依赖 @browserbasehq/stagehand+zod（云崽根 pnpm install）', component: 'Switch' },
        { field: 'agent.stagehand.permission', label: '访问权限', bottomHelpMessage: 'master=仅框架主人（默认）；all=全部成员可用 goto/observe/extract（act 写动作仍需 #确认）。开放给全员意味着群成员可驱动宿主浏览器并消耗 Browserbase/LLM 配额，慎用', component: 'Select', componentProps: { options: [{ label: '仅主人(master)', value: 'master' }, { label: '全部成员(all)', value: 'all' }] } },
        { field: 'agent.stagehand.mode', label: '浏览器模式', component: 'Select', componentProps: { options: [{ label: 'local 本地(默认)', value: 'local' }, { label: 'cloud Browserbase', value: 'cloud' }] } },
        { field: 'agent.stagehand.headless', label: '无头模式(本地)', bottomHelpMessage: '本地模式是否无头；服务器建议开', component: 'Switch' },
        { field: 'agent.stagehand.executablePath', label: 'chrome 路径(可选)', bottomHelpMessage: '本地 chrome 可执行路径（空=Stagehand 自定/CHROME_PATH；可填复用已装 chrome）', component: 'Input', componentProps: { placeholder: '留空=默认' } },
        { field: 'agent.stagehand.browserbaseApiKey', label: 'Browserbase apiKey', bottomHelpMessage: '云模式必填（bb_live_...）；本地模式留空', component: 'Input', componentProps: { placeholder: 'bb_live_...' } },
        { field: 'agent.stagehand.region', label: '云区域(可选)', component: 'Select', componentProps: { options: [{ label: '默认 us-west-2', value: '' }, { label: 'us-east-1', value: 'us-east-1' }, { label: 'eu-central-1', value: 'eu-central-1' }, { label: 'ap-southeast-1', value: 'ap-southeast-1' }] } },
        { field: 'agent.stagehand.modelName', label: 'Stagehand 原生模型(可选)', bottomHelpMessage: '如 google/gemini-2.5-flash、openai/gpt-5；空=复用插件 provider(仅 OpenAI 兼容)；云模式空=Model Gateway 自动选', component: 'Input', componentProps: { placeholder: '留空=复用插件 provider' } },
        { field: 'agent.stagehand.modelApiKey', label: '原生模型 apiKey(可选)', bottomHelpMessage: '原生模型 apiKey；云模式部分 provider 可空', component: 'Input' },
        { field: 'agent.stagehand.idleTimeoutMs', label: '会话空闲超时(毫秒)', component: 'InputNumber', componentProps: { min: 60000, step: 60000 } },
      ],
      // 获取配置数据（前端展示）
      getConfigData() {
        const data = JSON.parse(JSON.stringify(Config.get()))
        // masters 数组 → 多行文本（textarea 展示）
        if (Array.isArray(data?.agent?.masters)) data.agent.masters = data.agent.masters.join('\n')
        if (Array.isArray(data?.agent?.toolDiscovery?.alwaysOn)) data.agent.toolDiscovery.alwaysOn = data.agent.toolDiscovery.alwaysOn.join('\n')
        if (Array.isArray(data?.agent?.shell?.intercept)) data.agent.shell.intercept = data.agent.shell.intercept.join('\n')
        // thinking：provider 原生 {type,budget_tokens}|null → 面板友好 {enable,budget_tokens}
        const tk = data?.agent?.thinking
        data.agent.thinking = { enable: !!tk && tk?.type !== 'disabled', budget_tokens: tk?.budget_tokens || 16000 }
        // Jev API Key：只显示掩码（安全要求）；保存时掩码视为"未修改"跳过
        if (data?.agent?.jev && data.agent.jev.apiKey) data.agent.jev.apiKey = JEV_KEY_MASK
        // mcp.servers（对象 map）→ 标准 mcpServers JSON 文本（serversJson 虚拟字段，textarea 展示/编辑）
        try {
          const servers = unwrapServers(data?.agent?.mcp?.servers || {})
          data.agent.mcp = { ...(data.agent?.mcp || {}), serversJson: JSON.stringify({ mcpServers: servers }, null, 2) }
          delete data.agent.mcp.servers
        } catch { /* noop */ }
        return data
      },
      // 保存配置（前端点确定后调用）；合并点路径 → Config.save → 强制热加载
      setConfigData(data, { Result }) {
        const cfg = Config.get()
        const notes = []
        // 深度思考：面板 {enable,budget_tokens} → provider 原生 {type:'enabled',budget_tokens}|null
        if ('agent.thinking.enable' in (data || {})) {
          const cur = cfg.agent?.thinking || {}
          const enable = data['agent.thinking.enable']
          const budget = data['agent.thinking.budget_tokens'] ?? cur.budget_tokens ?? 16000
          cfg.agent.thinking = enable ? { type: 'enabled', budget_tokens: Number(budget) || 16000 } : null
          delete data['agent.thinking.enable']
          delete data['agent.thinking.budget_tokens']
        }
        // MCP servers：面板 mcpServers JSON → 合并进现有 servers（新键加入/同名更新，其它保留）。
        // 支持 { "mcpServers": {...} } 标准包装 或 裸 { name: cfg }；解析失败则保留原配置并提示。
        // 这样「粘一个加一个」可累积多个服务，不会覆盖已配置的。
        if ('agent.mcp.serversJson' in (data || {})) {
          const raw = String(data['agent.mcp.serversJson'] || '').trim()
          try {
            if (raw) {
              const incoming = unwrapServers(JSON.parse(raw))
              if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
                throw new Error('需为 { "mcpServers": {...} } 对象')
              }
              const existing = cfg.agent?.mcp?.servers || {}
              const merged = { ...existing }
              let added = 0
              for (const [k, v] of Object.entries(incoming)) {
                if (!k) continue
                if (!(k in merged)) added++
                merged[k] = v
              }
              cfg.agent.mcp = { ...(cfg.agent?.mcp || {}), servers: merged }
              notes.push(`MCP 已合并：新增 ${added} 个，当前共 ${Object.keys(merged).length} 个（删除某服务用 #停止mcp）`)
            }
          } catch (e) {
            Log.warn('[guoba] MCP serversJson 解析失败，已保留原配置', e?.message || e)
            notes.push(`MCP 配置 JSON 解析失败已忽略（保留原配置）：${e?.message || e}`)
          }
          delete data['agent.mcp.serversJson']
        }
        for (const [p, v] of Object.entries(data || {})) {
          let val = v
          // Jev Key 掩码 = 用户未修改：跳过，避免把掩码写进配置
          if (p === 'agent.jev.apiKey' && val === JEV_KEY_MASK) continue
          // 整块 agent.jev 提交时同样过滤掩码（否则掩码会被当作真实 key 写入）
          if (p === 'agent.jev' && val && typeof val === 'object' && !Array.isArray(val) && val.apiKey === JEV_KEY_MASK) {
            val = { ...val }
            delete val.apiKey
          }
          if (p === 'agent.masters' && typeof val === 'string') {
            val = val.split('\n').map((s) => String(s).trim()).filter(Boolean)
          }
          if (p === 'agent.masters') val = val.map((x) => String(x))
          if (p === 'agent.toolDiscovery.alwaysOn' && typeof val === 'string') {
            val = val.split('\n').map((s) => String(s).trim()).filter(Boolean)
          }
          if (p === 'agent.shell.intercept' && typeof val === 'string') {
            val = val.split('\n').map((s) => String(s).trim()).filter(Boolean)
          }
          // 原型污染防护：非法路径段（__proto__/prototype/constructor）单独记录并跳过，不影响其余字段
          try { setPath(cfg, p, val) } catch (e) { notes.push(`${p} 被拒：${e?.message || e}`) }
        }
        // 注意：开启「思考自动决策」不再删除手动 thinking 配置——运行时由 thinkingAuto 优先（覆盖而非删除），
        // 关掉自动决策后手动配置仍可恢复（yaml 语义是「覆盖」；此前保存即写 null 属静默丢配置）。
        Config.save(cfg)
        // save 已预更新内存 _data，文件监听的 reload 看不到变化、不会通知；
        // 故显式强制 reload(true) 触发热加载（运行时重建）并打日志。
        Log.mark('[guoba] 已通过锅巴保存配置，触发热加载')
        Config.reload(true)
        const msg = notes.length ? `保存成功（已自动热加载）。注意：${notes.join('；')}` : '保存成功（已自动热加载，无需重启）'
        return Result.ok({}, msg)
      },
    },
  }
}
