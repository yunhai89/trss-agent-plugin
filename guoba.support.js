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
import { setPath } from './utils/path.js'

/** setPath 已提取到 utils/path.js（web 路由与 guoba 共用） */

/** 解包 { mcpServers: {...} }（用户常贴 Claude Desktop 标准包装） */
function unwrapServers(s) {
  return s && typeof s === 'object' && s.mcpServers ? s.mcpServers : s
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
  protocol: [
    { label: 'OpenAI 兼容', value: 'openai' },
    { label: 'Anthropic 兼容', value: 'anthropic' },
  ],
  preset: [
    { label: 'DeepSeek', value: 'deepseek' },
    { label: 'OpenAI', value: 'openai' },
    { label: 'Gemini', value: 'gemini' },
    { label: '通义(DashScope)', value: 'dashscope' },
    { label: '智谱', value: 'zhipu' },
    { label: 'Kimi(Moonshot)', value: 'moonshot' },
    { label: '小米(MiMo)', value: 'mimo' },
    { label: 'MiniMax(M3)', value: 'minimax' },
    { label: 'Anthropic', value: 'anthropic' },
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
      description: '多模型对话 · 工具调用 · 长期记忆 · 人设 · 多模态 · 深度研究 · MCP · 群管 · 终端',
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
        { field: 'debug', label: '调试日志', bottomHelpMessage: '打印工具入参/每轮 token/搜索词等，排查时开启', component: 'Switch' },
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
        { field: 'agent.protocol', label: '协议', component: 'Select', componentProps: { options: OPT.protocol } },
        { field: 'agent.preset', label: '厂商预设', bottomHelpMessage: '自动填 baseURL/headers/字段映射', component: 'Select', componentProps: { options: OPT.preset } },
        { field: 'agent.baseURL', label: '自定义 baseURL', bottomHelpMessage: '覆盖 preset', component: 'Input' },
        { field: 'agent.apiKey', label: 'API Key', component: 'Input', componentProps: { placeholder: 'sk-xxx' } },
        { field: 'agent.model', label: '模型 ID', component: 'Input', componentProps: { placeholder: 'deepseek-chat' } },
        { field: 'agent.utilityModel', label: '播报小模型(可选)', bottomHelpMessage: '进度播报等旁路任务用的小模型 id；留空=沿用主模型，填主 provider 支持的小模型可降本', component: 'Input', componentProps: { placeholder: '留空=主模型' } },
        { field: 'agent.fallbackModel', label: '回退模型ID(可选)', bottomHelpMessage: '主模型失败时回退到的模型，如 gpt-4o / claude-3-5-sonnet（需配下面的 URL+Key）', component: 'Input', componentProps: { placeholder: '留空=不回退' } },
        { field: 'agent.fallbackBaseURL', label: '回退模型URL', bottomHelpMessage: '回退模型的 baseURL', component: 'Input', componentProps: { placeholder: 'https://api.openai.com/v1' } },
        { field: 'agent.fallbackApiKey', label: '回退模型Key', component: 'Input', componentProps: { placeholder: 'sk-gpt-xxx' } },
        { field: 'agent.fallbackProtocol', label: '回退模型协议', component: 'Select', componentProps: { options: [{ label: 'openai', value: 'openai' }, { label: 'anthropic', value: 'anthropic' }] } },
        { field: 'agent.proxy', label: '代理(可选)', bottomHelpMessage: 'HTTP/SOCKS 代理（http://host:port 或 socks5://host:port），国内访问 GPT/Gemini 等海外 LLM；留空=直连', component: 'Input', componentProps: { placeholder: '留空=直连' } },
        { field: 'agent.maxTurns', label: '工具调用轮次上限', component: 'InputNumber', componentProps: { min: 1, max: 100 } },
        { field: 'agent.temperature', label: '采样温度', bottomHelpMessage: '留空=厂商默认', component: 'InputNumber', componentProps: { min: 0, max: 2, step: 0.1 } },
        { field: 'agent.maxTokens', label: '单次回复最大 token', bottomHelpMessage: '留空=厂商默认（Anthropic 默认 4096）', component: 'InputNumber', componentProps: { min: 1 } },

        // —— 上下文与流式 ——
        { label: '上下文与流式', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.contextWindow', label: '上下文窗口(token)', bottomHelpMessage: '如 32000；超 80% 自动压缩历史保留首条意图；留空不压缩', component: 'InputNumber', componentProps: { min: 1000 } },
        { field: 'agent.maxToolResultChars', label: '工具结果字符上限', component: 'InputNumber', componentProps: { min: 100 } },
        { field: 'agent.keepReasoning', label: '回灌推理(reasoning)到历史', bottomHelpMessage: '默认关：省 context', component: 'Switch' },
        { field: 'agent.stream', label: '逐字流式输出', bottomHelpMessage: '依赖适配器，不稳；默认关', component: 'Switch' },
        { field: 'agent.progress', label: '工具调用进度消息', bottomHelpMessage: '消除干等；默认开', component: 'Switch' },
        { field: 'agent.progressRecall', label: '进度消息撤回(秒)', bottomHelpMessage: 'N 秒后自动撤回进度消息；0=不撤回；适配器不支持则忽略', component: 'InputNumber', componentProps: { min: 0, max: 120 } },
        { field: 'agent.reply.mode', label: '回复渲染方式', component: 'Select', componentProps: { options: [{ label: '图片（markdown→精美浅色图，默认）', value: 'image' }, { label: '纯文本', value: 'text' }] } },
        { field: 'agent.reply.narrate', label: '中途播报', bottomHelpMessage: '模型调工具时附带的思路/进展自动转发给用户（别埋头苦干）；默认开', component: 'Switch' },
        { field: 'agent.reply.renderScale', label: '回复图清晰度倍率', bottomHelpMessage: 'deviceScaleFactor：2=高清（默认），1=普通；越大越清晰但越耗内存', component: 'InputNumber', componentProps: { min: 1, max: 4 } },

        // —— 记忆与召回 ——
        { label: '记忆与召回', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.memory.enable', label: '声明式记忆', bottomHelpMessage: '注入 MEMORY.md/USER.md 到 system；默认开', component: 'Switch' },
        { field: 'agent.memory.threatScan', label: '记忆注入扫描', bottomHelpMessage: '写长期记忆前扫描指令注入（命中标 suspect，召回屏蔽，#记忆 仍可见原文）；默认开', component: 'Switch' },
        { field: 'agent.recall.cap', label: '长期记忆条数上限', bottomHelpMessage: '每用户上限；超限按价值(confidence/level/时间)淘汰，非 FIFO', component: 'InputNumber', componentProps: { min: 10 } },
        { field: 'agent.recall.extractEvery', label: 'LLM 抽取间隔(轮)', bottomHelpMessage: '每 N 轮触发一次 LLM 抽取（意图词"记住/叫我"等仍即时触发）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.recall.model', label: '抽取用模型(可选)', bottomHelpMessage: '留空=utilityModel→主模型', component: 'Input', componentProps: { placeholder: '留空=主模型' } },
        { field: 'agent.recall.embedProvider', label: '语义召回 embedding(可选)', bottomHelpMessage: '填 embedding 模型 id 走 cosine 语义匹配；留空=关键词 jaccard 召回', component: 'Input', componentProps: { placeholder: '留空=关键词召回' } },

        // —— 在线自进化 ——
        // —— 工具按需发现 ——
        { label: '工具按需发现（Tool Discovery）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.toolDiscovery.enable', label: '启用按需发现', bottomHelpMessage: 'LLM 只常驻少数核心工具，其余经 tool_search 检索后动态注入（省 token）；默认开，关则回退全量常驻', component: 'Switch' },
        { field: 'agent.toolDiscovery.alwaysOn', label: '常驻工具(每行一个)', bottomHelpMessage: '不经过搜索、始终可用的工具名；留空用内置默认：tool_search / clarify / memory_search / web_search / skill / get_chat_history', component: 'InputTextArea' },
        { field: 'agent.toolDiscovery.topK', label: 'tool_search 返回数', component: 'InputNumber', componentProps: { min: 1, max: 20 } },
        { field: 'agent.toolDiscovery.minScore', label: '最低相似度', bottomHelpMessage: '低于此值不返回；jaccard 下 0.1 较宽松', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },

        { label: '在线自进化', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.selfReview.enable', label: '后台自评审', bottomHelpMessage: '每 N 轮对话后台异步自我评审，产出改进 suggestion；不阻塞回复；默认开', component: 'Switch' },
        { field: 'agent.selfReview.every', label: '评审间隔(轮)', bottomHelpMessage: '每 N 轮对话触发一次后台自评审', component: 'InputNumber', componentProps: { min: 5 } },
        { field: 'agent.selfReview.model', label: '评审用模型(可选)', bottomHelpMessage: '留空=utilityModel→主模型；建议廉价小模型降本', component: 'Input', componentProps: { placeholder: '留空=主模型' } },
        { field: 'agent.selfReview.autoApplyMemory', label: '记忆自动应用', bottomHelpMessage: '记忆类 suggestion 自动写入（有回滚+威胁扫描+置信度闸）；默认开', component: 'Switch' },
        { field: 'agent.selfReview.autoApplyPrompt', label: 'prompt 自动应用【不建议】', bottomHelpMessage: 'prompt/技能类自动应用；默认关（落盘待审，#审阅进化 人工把关）', component: 'Switch' },
        { field: 'agent.selfReview.dailyBudgetTokens', label: '日 token 预算', bottomHelpMessage: '自评审日预算上限，耗尽则只采迹不评审', component: 'InputNumber', componentProps: { min: 0, step: 10000 } },

        // —— 工具进化（Tool Evolution）——
        { label: '工具进化（Tool Evolution）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.toolEvo.enable', label: '工具进化', bottomHelpMessage: '版本化工具库：生成→AST/沙箱验证→审批→晋升；默认开', component: 'Switch' },
        { field: 'agent.toolEvo.maxRepairAttempts', label: '候选修复次数', bottomHelpMessage: '候选生成失败自动修复上限（建议≤2，防把安全限制修掉）', component: 'InputNumber', componentProps: { min: 0, max: 3 } },
        { field: 'agent.toolEvo.retrievalThreshold', label: '检索接受阈值', bottomHelpMessage: '与去重阈值分开（§12.1）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.01 } },
        { field: 'agent.toolEvo.deduplicationThreshold', label: '去重阈值', bottomHelpMessage: '候选去重相似度阈值', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.01 } },

        // —— 深度思考 ——
        { label: '深度思考（Thinking）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.thinking.enable', label: '开启深度思考', bottomHelpMessage: 'Anthropic 等支持的扩展思考：模型先思考再作答（更慢、更耗 token，但复杂问题质量更高）', component: 'Switch' },
        { field: 'agent.thinking.budget_tokens', label: '思考预算(tokens)', component: 'InputNumber', componentProps: { min: 1024, max: 64000, step: 1024 } },

        // —— 安全与审批 ——
        { label: '安全与审批', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.guardAction', label: '注入防御动作', component: 'Select', componentProps: { options: OPT.guardAction } },
        { field: 'agent.guardSensitivity', label: '防御灵敏度', component: 'Select', componentProps: { options: OPT.guardSensitivity } },
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

        // —— 深度研究 ——
        { label: '深度研究', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.research.permission', label: '#研究 权限', component: 'Select', componentProps: { options: [{ label: '仅主人(防滥用)', value: 'master' }, { label: '所有人', value: 'all' }] } },
        { field: 'agent.research.maxRounds', label: '最大轮次', component: 'InputNumber', componentProps: { min: 1, max: 10 } },
        { field: 'agent.research.workerModel', label: '子代理模型', bottomHelpMessage: '空则用主模型；可填便宜模型省钱', component: 'Input' },

        // —— 搜索服务 ——
        { label: '搜索服务（web_search / 深度研究）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.search.tavily.apiKey', label: 'Tavily API Key', bottomHelpMessage: '任填一个即启用该源；都不填回退 SearXNG，再兜底 DDG', component: 'Input', componentProps: { placeholder: 'tvly-xxx' } },
        { field: 'agent.search.exa.apiKey', label: 'Exa API Key', component: 'Input' },
        { field: 'agent.search.perplexity.apiKey', label: 'Perplexity API Key', component: 'Input' },
        { field: 'agent.search.brave.apiKey', label: 'Brave API Key', component: 'Input' },
        { field: 'agent.search.searxng.url', label: 'SearXNG 地址', bottomHelpMessage: '自建/公共 SearXNG 实例', component: 'Input', componentProps: { placeholder: 'http://localhost:8080' } },
        { field: 'agent.search.ddg', label: 'DDG 兜底', bottomHelpMessage: '本地 DuckDuckGo，免 key、默认开（最后兜底）', component: 'Switch' },

        // —— MCP ——
        { label: 'MCP 服务端', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.mcp.requestTimeout', label: '请求超时(毫秒)', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },
        {
          field: 'agent.mcp.serversJson',
          label: 'MCP 服务端（粘贴新增 · 自动合并）',
          helpMessage: '粘贴标准 mcpServers JSON（如 { "mcpServers": { "名字": { "command":"npx", "args":[...] } } }），保存时自动合并：新服务加入、同名更新、其它已有服务一律保留。可反复粘贴累积多个。删除某个服务用聊天指令 #停止mcp <名字>。',
          bottomHelpMessage: '示例（粘一个就加一个，互不覆盖）：\n{\n  "mcpServers": {\n    "moegirl": { "command": "npx", "args": ["-y", "moegirl-wiki-mcp"] }\n  }\n}\n\nstdio：command/args/env；http：type/url/headers。框里默认显示你现有的全部服务，可直接增删键。Docker 精简镜像无 npx 见 README「agent.mcp」排查。',
          component: 'InputTextArea',
          componentProps: { placeholder: '{\n  "mcpServers": {\n    "xxx": { "command": "npx", "args": ["-y", "xxx"] }\n  }\n}', autosize: { minRows: 8, maxRows: 24 } },
        },

        // —— ⚠️ 终端(高危) ——
        { label: '⚠️ 终端执行(高危)', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'agent.terminal.enable',
          label: '启用终端(shell)执行【高危】',
          helpMessage: '高危工具！真机任意命令执行，无容器隔离，比沙盒危险得多。仅 terminal 主人可用 + 每条命令 #确认 + 黑名单硬拦。',
          bottomHelpMessage: '⚠️ 高危：shell 在主机直接执行任意命令（无容器隔离）。仅 terminal 主人可用（验证码认领，不读框架配置：发 #agents设置主人 → 控制台查看验证码 → 直接发验证码认领，类似 Yunzai #设置主人）。每条命令需主人 #确认；灾难命令黑名单硬拦。开启即视为你知晓风险、自担后果，与开发者无关。默认关闭。',
          component: 'Switch',
        },
        { field: 'agent.terminal.maxTimeout', label: '命令超时上限(秒)', component: 'InputNumber', componentProps: { min: 1, max: 3600 } },
        { field: 'agent.terminal.blocklist', label: '黑名单正则(可选)', bottomHelpMessage: '灾难命令正则数组（空=用默认 rm -rf / mkfs / dd of=/dev/ / 关机重启 等）；即使已确认也硬拦', component: 'Input', componentProps: { placeholder: '留空=用默认黑名单' } },

        // —— Stagehand 浏览器自动化 ——
        { label: 'Stagehand 浏览器自动化', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.stagehand.enable', label: '启用浏览器自动化', bottomHelpMessage: 'act/extract/observe 自然语言原语；仅框架主人可用，act 写动作需 #确认。依赖 @browserbasehq/stagehand+zod（云崽根 pnpm install）', component: 'Switch' },
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
        // thinking：provider 原生 {type,budget_tokens}|null → 面板友好 {enable,budget_tokens}
        const tk = data?.agent?.thinking
        data.agent.thinking = { enable: !!tk && tk?.type !== 'disabled', budget_tokens: tk?.budget_tokens || 16000 }
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
          if (p === 'agent.masters' && typeof val === 'string') {
            val = val.split('\n').map((s) => String(s).trim()).filter(Boolean)
          }
          if (p === 'agent.masters') val = val.map((x) => String(x))
          if (p === 'agent.toolDiscovery.alwaysOn' && typeof val === 'string') {
            val = val.split('\n').map((s) => String(s).trim()).filter(Boolean)
          }
          setPath(cfg, p, val)
        }
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
