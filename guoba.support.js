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
 *
 * 面板只做「UI 表示层转换」，不做业务归一（归一由 utils/Config.js normalize/D3 负责）：
 *   - 多行文本 ↔ 数组：masters / alwaysOn / intercept / reasoningFields / allowOut / denyOut / 各 groups
 *   - JSON 文本域 ↔ 对象/数组：fallbackModels / memoryLimits / policy.categoryMin / persona.styleExamples / humanize.groupsOverride
 *   - 深度思考：{ enable, budget_tokens } ↔ provider 原生 { type, budget_tokens } | null
 *   - MCP：serversJson（标准 mcpServers JSON）↔ agent.mcp.servers map（只合并不删除）
 * 这些虚拟表示只存在于 getConfigData 的副本里；setConfigData 会在写回前把点路径还原成真实类型。
 */
import Config from './utils/Config.js'
import Log from './utils/Log.js'
import fs from 'node:fs'
import path from 'node:path'
import { setPath, getPath } from './utils/path.js'
import { BUILTIN_PERSONAS } from './model/persona/defaults.js'

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

/** 多行文本 → 数组（去空行/去首尾空白）；非字符串原样返回 */
function linesToArray(v) {
  if (typeof v !== 'string') return v
  return v.split('\n').map((s) => String(s).trim()).filter(Boolean)
}

/** 面板「多行文本 ↔ 数组」字段（getConfigData 侧 join、setConfigData 侧 split） */
const MULTILINE_FIELDS = new Set([
  'agent.masters',
  'agent.toolDiscovery.alwaysOn',
  'agent.shell.intercept',
  'agent.reasoningFields',
  'agent.sandbox.network.allowOut',
  'agent.sandbox.network.denyOut',
  'agent.humanize.groups',
  'agent.groupWorld.groups',
  'agent.selfState.groups',
  'agent.sticker.discoverGroups',
  'agent.stagehand.blockedHosts',
  'agent.diagram.kroki.allowedDiagramTypes',
])

/**
 * 面板「JSON 文本域」字段：{ array, empty, label }
 * empty = 文本域清空时写回的值（null 表示恢复默认）
 */
const JSON_FIELDS = {
  'agent.fallbackModels': { array: true, empty: [], label: '回退模型列表' },
  'agent.persona.styleExamples': { array: true, empty: [], label: '风格示例' },
  'agent.humanize.groupsOverride': { array: false, empty: {}, label: '伪人群级覆盖' },
  'agent.memoryLimits': { array: false, empty: null, label: '记忆字符上限' },
  'agent.policy.categoryMin': { array: false, empty: null, label: '权限类别下限' },
  'agent.media.caps': { array: false, empty: null, label: '多模态能力覆盖' },
}

/**
 * 解析 JSON 文本域。空串 → null（调用方按 empty 处理）；类型不符/语法错误 → { error }。
 * @returns {{ ok:true, value:any }|{ ok:false, error:string }}
 */
function parseJsonField(raw, { array = false } = {}) {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: true, value: null }
  let v
  try { v = JSON.parse(s) } catch (e) { return { ok: false, error: `JSON 语法错误：${e?.message || e}` } }
  if (array) {
    if (!Array.isArray(v)) return { ok: false, error: '需为 JSON 数组（[...]）' }
  } else if (v === null || Array.isArray(v) || typeof v !== 'object') {
    return { ok: false, error: '需为 JSON 对象（{...}）' }
  }
  return { ok: true, value: v }
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
  reflect: [
    { label: 'auto 自动（默认：多轮/用工具时）', value: 'auto' },
    { label: 'off 关闭', value: 'off' },
    { label: 'always 每次最终回复都反思', value: 'always' },
    { label: 'jev 由 Jev 判断（需开启 Jev）', value: 'jev' },
  ],
  cacheControl: [
    { label: 'off 关闭（默认；兼容网关安全）', value: 'off' },
    { label: 'auto 官方端点自动开启', value: 'auto' },
    { label: 'explicit 强制开启', value: 'explicit' },
  ],
  degrade: [
    { label: 'skip 丢弃', value: 'skip' },
    { label: 'note 占位说明（默认）', value: 'note' },
    { label: 'text 文本类提取', value: 'text' },
  ],
  ttsProvider: [
    { label: 'indextts（本地，默认）', value: 'indextts' },
    { label: 'sovits（本地 GPT-SoVITS）', value: 'sovits' },
    { label: 'doubao（豆包）', value: 'doubao' },
    { label: 'minimax（MiniMax）', value: 'minimax' },
    { label: 'mimo（小米 MiMo）', value: 'mimo' },
  ],
  topology: [
    { label: 'spawn 异步三件套（默认）', value: 'spawn' },
    { label: 'orchestrator 同步编排', value: 'orchestrator' },
  ],
  researchPerm: [
    { label: '仅主人（防滥用）', value: 'master' },
    { label: '所有人', value: 'all' },
  ],
  dgFallback: [
    { label: 'none 无（结构化失败）', value: 'none' },
    { label: 'beautiful-mermaid 本地渲染', value: 'beautiful-mermaid' },
  ],
  dgTheme: [
    { label: 'paper-blue 米白纸蓝', value: 'paper-blue' },
    { label: 'soft-pastel 柔和粉彩', value: 'soft-pastel' },
    { label: 'technical 技术蓝灰', value: 'technical' },
    { label: 'midnight 午夜深色', value: 'midnight' },
    { label: 'sketch 手绘素描', value: 'sketch' },
  ],
  dgFormat: [
    { label: 'png 图片', value: 'png' },
    { label: 'svg 源文件', value: 'svg' },
  ],
  lang5: [
    { label: '中文', value: 'zh' },
    { label: '英文', value: 'en' },
    { label: '日文', value: 'ja' },
    { label: '韩文', value: 'ko' },
    { label: '粤语', value: 'yue' },
  ],
  ixLang: [
    { label: 'ZH 中文', value: 'ZH' },
    { label: 'EN 英文', value: 'EN' },
    { label: 'JA 日文', value: 'JA' },
    { label: 'AR 阿拉伯', value: 'AR' },
    { label: 'ES 西班牙', value: 'ES' },
  ],
  emoMode: [
    { label: 'same 沿用音色情绪', value: 'same' },
    { label: 'audio 情绪参考音频', value: 'audio' },
    { label: 'vector 情绪向量', value: 'vector' },
  ],
  tier: [
    { label: 'pro 整段', value: 'pro' },
    { label: 'max 逐段', value: 'max' },
  ],
  wavmp3: [
    { label: 'wav', value: 'wav' },
    { label: 'mp3', value: 'mp3' },
  ],
  wavmp3flac: [
    { label: 'wav', value: 'wav' },
    { label: 'mp3', value: 'mp3' },
    { label: 'flac', value: 'flac' },
  ],
  doubaoRes: [
    { label: 'seed-tts-2.0', value: 'seed-tts-2.0' },
    { label: 'seed-tts-1.0', value: 'seed-tts-1.0' },
    { label: 'seed-tts-1.0-concurr', value: 'seed-tts-1.0-concurr' },
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
        { field: 'agent.commandPassThrough', label: '指令透传', bottomHelpMessage: '默认开：以 # 等开头的 @/私聊消息若不是本插件触发词，交给 Yunzai 与其它插件处理（#设置主人/#重启/#帮助 等）；关掉后会被当成 AI 提问', component: 'Switch' },
        { field: 'agent.privateChat', label: '私聊触发对话', bottomHelpMessage: '默认关（私聊不响应，仅群内 @/命令触发）；开启后私聊任何消息直接触发，独立会话与记忆', component: 'Switch' },
        { field: 'agent.isolation.enable', label: '多用户数据隔离', bottomHelpMessage: '默认开：每个群每个用户完全独立（会话/长期记忆/召回/群历史）；关=同群共享（群体型 bot）。跨群始终隔离；私聊按用户', component: 'Switch' },
        { field: 'agent.chatPermission', label: '#ai 命令权限', component: 'Select', componentProps: { options: OPT.permission } },
        { field: 'agent.masters', label: '主人 / 审批通知 ID', bottomHelpMessage: '每行一个：普通协议填 QQ 号；QQ 官方机器人填 /uid 打印的完整 user_id 或去前缀 openid（如 807AC...，不是 QQ 号）', component: 'InputTextArea', componentProps: { placeholder: 'QQ 号或官方机器人 openid，每行一个' } },
        { field: 'agent.systemPrompt', label: '默认身份 systemPrompt', bottomHelpMessage: '留空用富默认身份；被人设覆盖时失效', component: 'InputTextArea' },

        // —— Web 管理面板（独立 HTTP 服务，脱离锅巴）——
        { label: 'Web 管理面板', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.webApi.enable', label: '启用 Web 面板', bottomHelpMessage: '独立 HTTP 服务；主人私聊 #agent登录 取带 token 的访问地址（24h 有效）', component: 'Switch' },
        { field: 'agent.webApi.port', label: '面板端口', bottomHelpMessage: '监听 0.0.0.0；默认 6098（避开 Yunzai 2536 / 锅巴 6099）', component: 'InputNumber', componentProps: { min: 1, max: 65535 } },
        { field: 'agent.webApi.publicUrl', label: '对外地址(可选)', bottomHelpMessage: '留空自动探测本机 LAN IP；填 http://1.2.3.4:6098 覆盖', component: 'Input', componentProps: { placeholder: '留空=自动探测' } },
        { field: 'agent.webApi.printTokenOnStart', label: '启动时打印访问地址', bottomHelpMessage: '启动日志输出带 token 的默认地址并写 data/web/console-url.txt：首次部署还没有协议端、发不了 #agent登录 时靠它进面板。（关闭后仍可用 #agent登录，或删 data/web/console-token.json 让下次启动重新打印）', component: 'Switch' },
        { field: 'agent.webApi.consoleTokenTtlHours', label: '启动地址令牌有效期(小时)', bottomHelpMessage: '默认 720（30 天）；使用中滑动续期，过期后下次启动自动换新', component: 'InputNumber', componentProps: { min: 1, max: 8760 } },

        { label: '模型与对话', component: 'SOFT_GROUP_BEGIN' },
        // 基础模型改为引用制：锅巴无联动控件，此处只手填厂商条目 id / 模型条目 id；
        // 厂商端点与模型条目请在 Web 配置中心（#agent登录 → 厂商配置 / 模型列表）维护。
        { field: 'agent.providerId', label: '基础厂商 ID', bottomHelpMessage: '「厂商配置」里厂商条目的 id（含接口地址与 Key）；空=未选厂商', component: 'Input', componentProps: { placeholder: '如 pxxxx' } },
        { field: 'agent.modelId', label: '基础模型 ID', bottomHelpMessage: '「模型列表」里模型条目的 id（须挂在上述厂商下）；空=未选模型', component: 'Input', componentProps: { placeholder: '如 mxxxx' } },
        { field: 'agent.utilityModel', label: '播报小模型(可选)', bottomHelpMessage: '进度播报等旁路任务用的小模型；留空=沿用主模型。可填任意已注册厂商的模型（运行时按注册表解析端点，不再局限主厂商）', component: 'Input', componentProps: { placeholder: '留空=主模型' } },
        { field: 'agent.reasoningFields', label: '推理字段归一(每行一个)', bottomHelpMessage: '如 reasoning_content；留空=用厂商 preset 自带设置（空数组视为未配置，不向 provider 传空数组）', component: 'InputTextArea', componentProps: { rows: 2, placeholder: 'reasoning_content' } },
        {
          field: 'agent.fallbackModels',
          label: '回退模型列表(JSON)',
          helpMessage: '主模型失败时按数组顺序依次尝试；每条独立 model/baseURL/apiKey/protocol（可跨厂商、可多条）。这是**唯一真源**：旧版扁平 fallbackModel* 字段已废弃，启动时由 Config 一次性迁移进本数组。',
          bottomHelpMessage: 'JSON 数组示例：\n[\n  { "model": "gpt-4o", "baseURL": "https://api.openai.com/v1", "apiKey": "sk-gpt-xxx", "protocol": "openai" }\n]\n留空=不回退；JSON 解析失败会保留原配置并提示。',
          component: 'InputTextArea',
          componentProps: { autosize: { minRows: 3, maxRows: 12 }, placeholder: '[]' },
        },
        { field: 'agent.proxy', label: '代理(可选)', bottomHelpMessage: 'HTTP(S) 代理（http://host:port）；国内访问 GPT/Gemini 等海外 LLM 用，留空=直连。SOCKS 暂不支持', component: 'Input', componentProps: { placeholder: '留空=直连' } },
        { field: 'agent.maxTurns', label: '工具调用轮次上限', bottomHelpMessage: '默认 256；上限 1000（旧面板上限 100 会把默认值静默截断）', component: 'InputNumber', componentProps: { min: 1, max: 1000 } },
        { field: 'agent.temperature', label: '采样温度', bottomHelpMessage: '留空=厂商默认；yaml 默认 0.2（建议 0.1~0.3）', component: 'InputNumber', componentProps: { min: 0, max: 2, step: 0.1 } },
        { field: 'agent.maxTokens', label: '单次回复最大 token', bottomHelpMessage: '留空=厂商默认（Anthropic 默认 4096）', component: 'InputNumber', componentProps: { min: 1 } },

        // —— 上下文与流式 ——
        { label: '上下文与流式', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.contextWindow', label: '上下文窗口(token)', bottomHelpMessage: '请填模型真实窗口（如 32000）：留空=按消息条数 30→18 压缩；填写后按 contextHighRatio（默认 65%）→ contextLowRatio（默认 45%）高低水位压缩（保留首条意图）', component: 'InputNumber', componentProps: { min: 1000 } },
        { field: 'agent.maxToolResultChars', label: '工具结果字符上限', bottomHelpMessage: '默认 8000；内容获取类工具可经 meta.resultCap 单独放宽到 12000', component: 'InputNumber', componentProps: { min: 100 } },
        { field: 'agent.keepReasoning', label: '回灌推理(reasoning)到历史', bottomHelpMessage: '默认关：省 context', component: 'Switch' },
        { field: 'agent.stream', label: '逐字流式输出', bottomHelpMessage: '依赖适配器，不稳；默认关', component: 'Switch' },
        { field: 'agent.progress', label: '工具调用进度消息', bottomHelpMessage: '消除干等；默认开', component: 'Switch' },
        { field: 'agent.progressRecall', label: '进度消息撤回(秒)', bottomHelpMessage: 'N 秒后自动撤回进度消息；0=不撤回；适配器不支持则忽略', component: 'InputNumber', componentProps: { min: 0, max: 120 } },
        { field: 'agent.reply.mode', label: '回复渲染方式', component: 'Select', componentProps: { options: [{ label: '图片（markdown→精美浅色图，默认）', value: 'image' }, { label: '纯文本', value: 'text' }] } },
        { field: 'agent.reply.narrate', label: '中途播报', bottomHelpMessage: '模型调工具时附带的思路/进展自动转发给用户（别埋头苦干）；默认开', component: 'Switch' },
        { field: 'agent.reply.atSender', label: '群聊回复艾特发言人', bottomHelpMessage: '默认开；私聊不艾特', component: 'Switch' },
        { field: 'agent.reply.quote', label: '群聊回复引用触发消息', bottomHelpMessage: '默认开；私聊不引用；可与艾特同开，人多时便于定位回复对象', component: 'Switch' },
        { field: 'agent.reply.renderScale', label: '回复图清晰度倍率', bottomHelpMessage: 'deviceScaleFactor：3=超清（默认）/ 2=高清 / 1=普通；越大越清晰但越耗内存', component: 'InputNumber', componentProps: { min: 1, max: 4 } },
        { field: 'agent.render.card', label: '卡片图渲染', bottomHelpMessage: '帮助/列表等卡片图开关（默认开）；弱服务器可关，直接回文本避免渲染卡死。回复图由上面的「回复渲染方式」控制', component: 'Switch' },
        { field: 'agent.cacheControl', label: 'Anthropic 显式缓存断点', bottomHelpMessage: 'off=关闭（默认，兼容网关安全）/ auto=官方端点自动开 / explicit=强制；OpenAI 兼容端自动前缀缓存无需开', component: 'Select', componentProps: { options: OPT.cacheControl } },
        { field: 'agent.promptCacheKey', label: 'OpenAI prompt_cache_key', bottomHelpMessage: '稳定会话路由（仅 OpenAI 官方端点/支持该能力的模型下发；兼容网关绝不发）；默认关', component: 'Switch' },
        { field: 'agent.reflect', label: '自我反思/自纠', bottomHelpMessage: '默认 auto：仅多轮或用工具时反思；always=每次最终回复都反思；jev=由 Jev 判断（需开启 Jev）', component: 'Select', componentProps: { options: OPT.reflect } },

        // —— 上下文压缩 · 循环预算 ——
        { label: '上下文压缩 · 循环预算', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.contextMsgHighWater', label: '消息条数高水位', bottomHelpMessage: '未配置 contextWindow 时的消息条数压缩阈值（默认 30，达到即压缩）；配置了 contextWindow 后由 token 水位接管', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.contextMsgLowWater', label: '消息条数低水位', bottomHelpMessage: '消息条数水位压缩后保留的条数（默认 18；须小于高水位）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.loop.maxSameAction', label: '同动作连续上限', bottomHelpMessage: '同一工具+相同参数连续允许次数（默认 2；超出→duplicate_action 终止，防 ping 死循环）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.loop.maxConsecutiveFailures', label: '连续失败上限', bottomHelpMessage: '连续工具失败次数上限（默认 3；超出→consecutive_failures 终止）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.loop.noProgressWindow', label: '无进展窗口(步)', bottomHelpMessage: '连续 N 步无新事实→no_progress 终止（默认 4）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.loop.timeBudgetMs', label: '工作时间预算(毫秒)', bottomHelpMessage: '单次对话工作时间预算（默认 3600000=60 分钟，超出终止在途调用并进入收尾）', component: 'InputNumber', componentProps: { min: 60000, step: 60000 } },
        { field: 'agent.loop.tokenBudget', label: '有效工作 token 预算', bottomHelpMessage: '单次对话累计有效工作 token 上限（默认 480000；未命中输入+缓存写+输出，缓存命中读按 0.1x 折算）', component: 'InputNumber', componentProps: { min: 0, step: 10000 } },
        { field: 'agent.loop.finalizeGraceMs', label: '收尾宽限(毫秒)', bottomHelpMessage: '预算/时间耗尽后，收尾总结调用的独立时间窗（默认 45000）', component: 'InputNumber', componentProps: { min: 0, step: 1000 } },
        { field: 'agent.compaction.enable', label: '无损上下文压缩归档', bottomHelpMessage: '默认开：被移出窗口的原文整块归档（sha256），可用 context_recall 恢复；关=不归档、不注册恢复工具（回滚杠杆）', component: 'Switch' },
        { field: 'agent.compaction.archiveDir', label: '压缩归档目录', bottomHelpMessage: '默认 data/context-archive（按会话分目录）', component: 'Input', componentProps: { placeholder: 'data/context-archive' } },
        { field: 'agent.toolConcurrency.maxParallel', label: '只读工具并发上限', bottomHelpMessage: '单批工具调用的全局滚动并发池（默认 3；独占/资源类工具另行串行）', component: 'InputNumber', componentProps: { min: 1, max: 16 } },
        { field: 'agent.toolSchemaValidate', label: '工具参数 schema 预校验', bottomHelpMessage: '缺参/类型错误/多余参数在副作用前结构化回报；默认开（关=回滚杠杆）', component: 'Switch' },
        { field: 'agent.finalizeMaxTokens', label: '收尾输出 token 上限', bottomHelpMessage: '异常停止后最后一次交付的输出上限（默认 2048；太小会截断总结/子代理报告）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.rootTokenBudget', label: '根任务 token 预算', bottomHelpMessage: '主/编排/子代理/反思合计上限（0=不限，默认 0）；嵌套工作开始前预留', component: 'InputNumber', componentProps: { min: 0, step: 1000 } },

        // —— 记忆与召回 ——
        { label: '记忆与召回', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.memory.enable', label: '声明式记忆', bottomHelpMessage: '注入 MEMORY.md/USER.md 到 system；默认开', component: 'Switch' },
        { field: 'agent.memory.threatScan', label: '记忆注入扫描', bottomHelpMessage: '写长期记忆前扫描指令注入（命中标 suspect，召回屏蔽，#记忆 仍可见原文）；默认开', component: 'Switch' },
        { field: 'agent.memoryLimits', label: '记忆字符上限(JSON)', bottomHelpMessage: '声明式记忆注入的字符上限示例：{ "memory": 2200, "user": 1375 }；留空=用内置默认', component: 'InputTextArea', componentProps: { autosize: { minRows: 2, maxRows: 6 }, placeholder: '{ "memory": 2200, "user": 1375 }' } },
        { field: 'agent.recall.cap', label: '长期记忆条数上限', bottomHelpMessage: '每用户上限（默认 256）；超限按价值(confidence/level/时间)淘汰，非 FIFO', component: 'InputNumber', componentProps: { min: 10 } },
        { field: 'agent.recall.extractEvery', label: 'LLM 抽取间隔(轮)', bottomHelpMessage: '每 N 轮触发一次 LLM 抽取（默认 10；意图词"记住/叫我"等仍即时触发）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.recall.model', label: '抽取用模型(可选)', bottomHelpMessage: '留空=utilityModel→主模型；可跨厂商（填模型 id 或已注册模型名）', component: 'Input', componentProps: { placeholder: '留空=主模型' } },
        { field: 'agent.recall.embedProvider', label: '语义召回 embedding(可选)', bottomHelpMessage: '填 embedding 模型 id 走 cosine 语义匹配；留空=关键词 jaccard 召回。独立 embedding 端点请用 Web 配置中心或 yaml 的 recall.embedBaseURL/embedApiKey', component: 'Input', componentProps: { placeholder: '留空=关键词召回' } },
        { field: 'agent.recall.minScore', label: '召回最低分', bottomHelpMessage: '低于此综合分的记忆不注入（0=仅过滤零相关；配 embedding 后可调大如 0.3 更严格）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.recall.diversity.enable', label: '召回去冗余(MMR)', bottomHelpMessage: '候选多于要取条数时兼顾相关与多样，避免同义旧事挤满上下文；默认开', component: 'Switch' },
        { field: 'agent.recall.diversity.lambda', label: '去冗余相关权重', bottomHelpMessage: '1=纯相关排序；越小越鼓励多样（建议 0.5~0.8）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.recall.diversity.perTypeCap', label: '同类型最多条数', bottomHelpMessage: '同一记忆类型最多入选条数（选不满时自动放宽）', component: 'InputNumber', componentProps: { min: 1, max: 10 } },
        { field: 'agent.recall.usage.enable', label: '记忆使用反馈', bottomHelpMessage: '记录注入/被引用；反复注入却从未被引用的记忆自动降权；默认开', component: 'Switch' },

        // —— 用户画像（统一用户模型）——
        { label: '用户画像（统一用户模型）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.profile.enable', label: '启用用户画像', bottomHelpMessage: '跨会话归纳身份/沟通风格/偏好/忌讳，动态注入；带证据可纠错；默认开', component: 'Switch' },
        { field: 'agent.profile.infer', label: '隐式风格推断', bottomHelpMessage: '从消息长度/表情/提问率/活跃时段推断沟通风格（标注"推断"）；默认开', component: 'Switch' },
        { field: 'agent.profile.maxChars', label: '画像注入上限(字符)', bottomHelpMessage: '注入 system 动态块的字符上限（默认 600），防膨胀', component: 'InputNumber', componentProps: { min: 100, max: 2000, step: 50 } },
        { field: 'agent.profile.maxPerFacet', label: '每分面保留条数', bottomHelpMessage: '身份/偏好/沟通风格等每个分面最多保留条数（默认 8），低置信先淘汰', component: 'InputNumber', componentProps: { min: 1, max: 20 } },

        // —— 工具按需发现 ——
        { label: '工具按需发现（Tool Discovery）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.toolDiscovery.enable', label: '启用按需发现', bottomHelpMessage: '控制 system 工具速查与 tool_search/激活记录；默认开。注意 stableList=true 时 tools schema 仍每轮全量下发（缓存优先），本开关不减少 schema token', component: 'Switch' },
        { field: 'agent.toolDiscovery.alwaysOn', label: '常驻工具(每行一个)', bottomHelpMessage: '不经过搜索、始终可用的工具名（每行一个）；留空=用内置默认（含 tool_search / clarify / memory_search / web_search / kb_search / skill / get_chat_history / reminder_set / schedule_task / context_recall / diagram_render / 群文件工具等）', component: 'InputTextArea' },
        { field: 'agent.toolDiscovery.topK', label: 'tool_search 返回数', bottomHelpMessage: '默认 8', component: 'InputNumber', componentProps: { min: 1, max: 20 } },
        { field: 'agent.toolDiscovery.stableList', label: '工具数组跨轮恒定', bottomHelpMessage: '每轮下发全量工具定义（首轮多付约 1 万 token，之后全部命中缓存）。关掉会随工具激活改变 tools 数组，实测任何变化都会让整段 prompt 缓存归零（命中率 0%）', component: 'Switch' },
        { field: 'agent.toolDiscovery.minScore', label: '最低相似度', bottomHelpMessage: '低于此值不返回（默认 0.3；jaccard 下 0.1 较宽松）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },

        { label: '在线自进化', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.selfReview.enable', label: '后台自评审', bottomHelpMessage: '每 N 轮对话后台异步自我评审，产出改进 suggestion；不阻塞回复；默认开', component: 'Switch' },
        { field: 'agent.selfReview.every', label: '评审间隔(轮)', bottomHelpMessage: '每 N 轮对话触发一次后台自评审（默认 20，per-scope 计数）', component: 'InputNumber', componentProps: { min: 5 } },
        { field: 'agent.selfReview.model', label: '评审用模型(可选)', bottomHelpMessage: '留空=utilityModel→主模型；建议廉价小模型降本；可跨厂商', component: 'Input', componentProps: { placeholder: '留空=主模型' } },
        { field: 'agent.selfReview.autoApplyMemory', label: '记忆自动应用', bottomHelpMessage: '记忆类 suggestion 自动写入（有回滚+威胁扫描+置信度闸）；默认开', component: 'Switch' },
        { field: 'agent.selfReview.autoApplyPrompt', label: 'prompt 自动应用【不建议】', bottomHelpMessage: 'prompt/技能类自动应用；默认关（落盘待审，#审阅进化 人工把关）', component: 'Switch' },
        { field: 'agent.selfReview.dailyBudgetTokens', label: '日 token 预算', bottomHelpMessage: '自评审日 token 预算（默认 256000）；耗尽则只采迹不评审；0=关闭后台自评审（不再等于「不限」）', component: 'InputNumber', componentProps: { min: 0, step: 10000 } },

        // —— 工具进化（Tool Evolution）——
        { label: '工具进化（Tool Evolution）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.toolEvo.enable', label: '工具进化', bottomHelpMessage: '版本化工具库：生成→AST/沙箱验证→审批→晋升；默认开', component: 'Switch' },
        { field: 'agent.toolEvo.dbPath', label: '工具库路径', bottomHelpMessage: 'sqlite 库（默认 data/evolution/tevo.db）', component: 'Input', componentProps: { placeholder: 'data/evolution/tevo.db' } },
        { field: 'agent.toolEvo.artifactsDir', label: '工具制品目录', bottomHelpMessage: '默认 data/evolution/tools（TOOL.md/index.js/manifest.json/tests.json）', component: 'Input', componentProps: { placeholder: 'data/evolution/tools' } },
        { field: 'agent.toolEvo.maxRepairAttempts', label: '候选修复次数', bottomHelpMessage: '候选生成失败自动修复上限（默认 2，建议≤2，防把安全限制修掉）', component: 'InputNumber', componentProps: { min: 0, max: 3 } },

        // —— 深度思考 ——
        { label: '深度思考（Thinking）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.thinking.enable', label: '开启深度思考', bottomHelpMessage: 'Anthropic 等支持的扩展思考：模型先思考再作答（更慢、更耗 token，但复杂问题质量更高）；留空=不手动开启', component: 'Switch' },
        { field: 'agent.thinking.budget_tokens', label: '思考预算(tokens)', bottomHelpMessage: '手动思考预算（默认 16000）；上限 128000', component: 'InputNumber', componentProps: { min: 1024, max: 128000, step: 1024 } },
        { field: 'agent.thinkingAuto.enable', label: '思考自动决策', bottomHelpMessage: '按提问复杂度自动决定是否思考与深度（闲聊不思考、复杂问题深度思考）；开启后覆盖上面的手动 thinking（模型级覆盖仍优先，不会删除手动配置）。能力表未表态的新型号默认乐观启用；厂商拒绝思考字段会自动剥离记忆（转不支持，无需重启）', component: 'Switch' },
        { field: 'agent.thinkingAuto.classifier', label: '判档方式', bottomHelpMessage: 'auto=规则不确定时用小模型判（省调用）/ always=总是小模型 / off=纯规则 / jev=由 Jev 判档（需开启 Jev）', component: 'Select', componentProps: { options: [{ label: 'auto（小模型+规则）', value: 'auto' }, { label: 'always（总是小模型）', value: 'always' }, { label: 'off（纯规则）', value: 'off' }, { label: 'jev（由 Jev 判档，需开启 Jev）', value: 'jev' }] } },
        { field: 'agent.thinkingAuto.model', label: '判档小模型(可选)', bottomHelpMessage: '留空=utilityModel→主模型；建议用廉价小模型降本', component: 'Input', componentProps: { placeholder: '留空=utilityModel' } },
        { field: 'agent.thinkingAuto.timeoutMs', label: '判档超时(ms)', bottomHelpMessage: '小模型判档超时/失败自动回退规则（默认 2500）', component: 'InputNumber', componentProps: { min: 500, max: 15000, step: 500 } },
        { field: 'agent.thinkingAuto.maxBudget', label: '自动预算上限(tokens)', bottomHelpMessage: '自动模式单轮思考预算硬顶（默认 32768），防烧太多；上限 128000', component: 'InputNumber', componentProps: { min: 1024, max: 128000, step: 1024 } },
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
        { field: 'agent.jev.timeoutMs', label: 'Jev 超时(ms)', bottomHelpMessage: '超时/失败自动回退现有方案（默认 4000；Jev 典型延迟 ~100-300ms）', component: 'InputNumber', componentProps: { min: 500, max: 60000, step: 500 } },
        { field: 'agent.jev.maxRetries', label: 'Jev 重试次数', bottomHelpMessage: '408/429/5xx 指数退避重试（401/422 不重试；默认 1）；连续失败 3 次熔断 30s', component: 'InputNumber', componentProps: { min: 0, max: 5 } },
        { field: 'agent.jev.decisions.llmTool', label: '注册 jev 工具', bottomHelpMessage: '让主 LLM 在需要判断时主动把 state+questions 发给 Jev 取结构化答案', component: 'Switch' },
        { field: 'agent.jev.decisions.terminalRisk', label: 'shell：Jev 风险检查', bottomHelpMessage: 'terminal 执行前用 Jev 判只读/可逆/破坏性；破坏性默认拒绝（回退：现有行为）', component: 'Switch' },
        { field: 'agent.jev.allowDestructive', label: 'shell：允许破坏性命令', bottomHelpMessage: '⚠️ 关闭=破坏性一律拒绝（fail-closed，推荐）；开启=仅当 Jev 置信度≥破坏性阈值才放行', component: 'Switch' },
        { field: 'agent.jev.thresholds.lowConfidence', label: '通用低置信阈值', bottomHelpMessage: '低于此值回退现有方案（默认 0.5；与 thinkingMinConfidence 取更严者决定思考回退）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.jev.thresholds.highConfidence', label: '通用高置信阈值', bottomHelpMessage: '破坏性命令放行下限（默认 0.9；实际取 max(terminalRiskFloor, 本值)）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.jev.thresholds.toolNoulFloor', label: '工具激活阈值', bottomHelpMessage: '工具 noul 概率达到此值才激活（默认 0.6，0~1）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.jev.thresholds.terminalRiskFloor', label: '破坏性命令置信阈值', bottomHelpMessage: '仅「允许破坏性命令」开启时用于高置信放行判定（默认 0.75，0~1）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.jev.thresholds.thinkingMinConfidence', label: '思考档位置信阈值', bottomHelpMessage: 'thinkingMinConfidence：低于则回退规则判档（默认 0.5，0~1）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.jev.thresholds.reflectFloor', label: '反思触发阈值', bottomHelpMessage: 'reflectFloor：noul 概率达标才反思（默认 0.5，0~1）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },

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
        { field: 'agent.personaLore.dir', label: '人设资料库目录', bottomHelpMessage: '长尾知识/补齐资料目录；留空=data/persona-lore', component: 'Input', componentProps: { placeholder: '留空=data/persona-lore' } },
        { field: 'agent.personaLore.adoptionsDir', label: '人设采纳队列目录', bottomHelpMessage: '采纳队列目录；留空=data/persona-adoptions', component: 'Input', componentProps: { placeholder: '留空=data/persona-adoptions' } },
        { field: 'agent.persona.styleExamples', label: '沟通风格示例(JSON)', bottomHelpMessage: 'JSON 数组，元素含 sceneType/speechAct/tone/familiarity/text；留空或 [] = 用默认人设内置示例。示例：[{"sceneType":"banter","tone":"playful","text":"就这？我上我也行"}]', component: 'InputTextArea', componentProps: { autosize: { minRows: 2, maxRows: 8 }, placeholder: '[]' } },
        { field: 'agent.contextHighRatio', label: '压缩高水位比例', bottomHelpMessage: '仅填了 contextWindow 后生效：历史占窗口比例超过它触发压缩（默认 0.65；256K 窗口建议 0.8）。越晚压越省缓存，命中率公式见 README「缓存经济性」', component: 'InputNumber', componentProps: { min: 0.3, max: 0.95, step: 0.05 } },
        { field: 'agent.contextLowRatio', label: '压缩低水位比例', bottomHelpMessage: '压缩后保留到该比例（默认 0.45，须小于高水位；若 ≥ 高水位会被运行时夹到「高水位−0.05」）。压得越深则每轮新增相对越少、稳态命中率越高', component: 'InputNumber', componentProps: { min: 0.05, max: 0.9, step: 0.05 } },
        { field: 'agent.redactSecrets', label: '回复脱敏(屏蔽 API Key)', bottomHelpMessage: '发送前屏蔽回复里的密钥/token；默认开', component: 'Switch' },
        { field: 'agent.confirmTimeout', label: '审批超时(秒)', bottomHelpMessage: '超时自动拒绝（默认 300 秒）', component: 'InputNumber', componentProps: { min: 10 } },
        {
          field: 'agent.masterSkipConfirm',
          label: '主人任务免确认【高危】',
          helpMessage: '高危！开启后主人发起的确认类工具（如 schedule_task）跳过 #确认 直接执行。',
          bottomHelpMessage: '⚠️ 高危：开启后主人的命令不再审批、直接执行（仅在控制台打印日志，不在聊天提示，防刷屏）。denylist 灾难命令仍硬拦。开启即视为你知晓风险、自担后果。默认关。',
          component: 'Switch',
        },
        { field: 'agent.policy.categoryMin', label: '权限类别最低角色(JSON)', bottomHelpMessage: '覆盖内置类别最低角色（JSON 对象，如 {"message":1,"mcp_write":2}）；角色 member<admin<owner<master。留空=内置阶梯 query:0/personal:0/message:1/group_manage:2/system:3', component: 'InputTextArea', componentProps: { autosize: { minRows: 2, maxRows: 6 }, placeholder: '{ "message": 1, "mcp_write": 2 }' } },

        // —— 视觉 ——
        { label: '视觉子模型', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.vision.enable', label: '启用视觉子模型', bottomHelpMessage: '主模型不支持视觉时，由它把图转文本（受 agent.media.enable 总开关约束）', component: 'Switch' },
        { field: 'agent.vision.model', label: '视觉模型 ID', component: 'Input', componentProps: { placeholder: 'mimo-2.5' } },
        { field: 'agent.vision.apiKey', label: '视觉模型 API Key', bottomHelpMessage: '空则复用主 apiKey（独立端点/协议请用 Web 配置中心或 yaml 的 vision.* 连接字段）', component: 'Input' },

        // —— 情境感知 ——
        { label: '情境感知', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.perception.sparseInject', label: '稀薄上下文补全群聊', bottomHelpMessage: '新会话/历史很少时，额外注入一小段近期群聊记录，避免模型对群内近况一无所知。默认开', component: 'Switch' },
        { field: 'agent.perception.sparseThreshold', label: '补全触发阈值(条)', bottomHelpMessage: '会话历史少于该条数时触发上面的补全（默认 6）', component: 'InputNumber', componentProps: { min: 0, max: 100 } },

        // —— 深度研究 ——
        { label: '深度研究', component: 'SOFT_GROUP_BEGIN' },

        // —— 搜索服务 ——
        { label: '搜索服务（web_search / 深度研究）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.search.tavily.apiKey', label: 'Tavily API Key', bottomHelpMessage: '任填一个即启用该源；都不填回退 SearXNG，再兜底 DDG', component: 'Input', componentProps: { placeholder: 'tvly-xxx' } },
        { field: 'agent.search.exa.apiKey', label: 'Exa API Key', component: 'Input' },
        { field: 'agent.search.perplexity.apiKey', label: 'Perplexity API Key', component: 'Input' },
        { field: 'agent.search.brave.apiKey', label: 'Brave API Key', component: 'Input' },
        { field: 'agent.search.searxng.url', label: 'SearXNG 地址', bottomHelpMessage: '自建/公共 SearXNG 实例', component: 'Input', componentProps: { placeholder: 'http://localhost:8080' } },
        { field: 'agent.search.ddg', label: 'DDG 兜底', bottomHelpMessage: '本地 DuckDuckGo，免 key、默认开（最后兜底）', component: 'Switch' },

        // —— 知识库与网页抓取 ——
        { label: '知识库与网页抓取', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.kb.enable', label: '知识库总开关', bottomHelpMessage: '默认开；关则不注册 kb_search、不入库（下面的 chunk/topK/minScore 仅开启时生效）', component: 'Switch' },
        { field: 'agent.kb.vectorStore', label: '本地向量索引', bottomHelpMessage: '默认开；纯 JS Flat 精确检索，落盘 data/vectors/kb；关=退回 KV 内全量 cosine 扫描', component: 'Switch' },
        { field: 'agent.kb.vectorBackend', label: '向量后端', bottomHelpMessage: 'auto=有 hnswlib-node 就用 HNSW，否则 Flat；hnsw=强制 HNSW；flat=纯 JS；cuvs=GPU（需授权+装 cuvs-node）', component: 'Select', componentProps: { options: [{ label: 'auto（推荐）', value: 'auto' }, { label: 'HNSW（CPU）', value: 'hnsw' }, { label: 'Flat（纯 JS）', value: 'flat' }, { label: 'cuVS（GPU）', value: 'cuvs' }] } },
        { field: 'agent.kb.vectorGpuConsent', label: 'GPU 向量检索授权', bottomHelpMessage: '默认关：即使检测到 GPU 也不会自动启用 cuVS，避免抢占用户 GPU 任务；确认显卡空闲后再开', component: 'Switch' },
        { field: 'agent.kb.hnsw.m', label: 'HNSW m', bottomHelpMessage: '每个节点最大出边（默认 16；越大召回越高、内存/建库越慢）', component: 'InputNumber', componentProps: { min: 4 } },
        { field: 'agent.kb.hnsw.efConstruction', label: 'HNSW efConstruction', bottomHelpMessage: '建库搜索宽度（默认 256；越大质量越好、建库越慢）', component: 'InputNumber', componentProps: { min: 4 } },
        { field: 'agent.kb.hnsw.efSearch', label: 'HNSW efSearch', bottomHelpMessage: '查询搜索宽度（默认 256；越大召回越高、查询越慢）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.kb.hnsw.rerank', label: 'ANN 候选重排倍数', bottomHelpMessage: '取 topK×倍数候选，再用 Flat 向量精确重排（默认 4）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.kb.cuvs.rerank', label: 'cuVS 候选重排倍数', bottomHelpMessage: 'GPU 候选倍数（默认 4）；最终仍用 Flat 向量精确重排', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.kb.crawlEnable', label: '网页抓取开关', bottomHelpMessage: '默认开；关则不注册 web_crawl 与 URL 入库/刷新（下面 crawl.* 仅在开启时生效）', component: 'Switch' },
        { field: 'agent.kb.crawl.engine', label: '抓取引擎', bottomHelpMessage: 'crawl4ai=真浏览器渲染（默认，需 scripts/install-crawl4ai.sh 装好）；fetch=纯 HTTP+cheerio', component: 'Select', componentProps: { options: [{ label: 'crawl4ai 浏览器', value: 'crawl4ai' }, { label: '纯 HTTP fetch', value: 'fetch' }] } },
        { field: 'agent.kb.crawl.execution', label: '抓取执行位置', bottomHelpMessage: 'local=宿主 venv crawl4ai（默认，与 sandbox.mode 无关）；sandbox=在 E2B 沙箱内跑（需模板预装 crawl4ai，未就绪降级纯 HTTP fetch）', component: 'Select', componentProps: { options: [{ label: '宿主(local，推荐)', value: 'local' }, { label: '沙箱(sandbox)', value: 'sandbox' }] } },
        { field: 'agent.kb.crawl.stealth', label: '反检测', bottomHelpMessage: 'playwright-stealth + 模拟用户行为，默认开', component: 'Switch' },
        { field: 'agent.kb.crawl.retryBlocked', label: '被拦后强化重试', bottomHelpMessage: '403/CF 挑战等被拦时自动 undetected+stealth 再试一轮', component: 'Switch' },
        { field: 'agent.kb.crawl.allowPrivateHosts', label: '允许抓内网', bottomHelpMessage: '允许抓本机/内网/元数据地址（默认禁，防 SSRF）。本机 DNS 把公网域名解析到内网时也需要它', component: 'Switch' },
        { field: 'agent.kb.crawl.sessionPersist', label: '站点会话持久化', bottomHelpMessage: '按 host 保存 cookie（含 CF 清关凭证）到 data/crawl/sessions.json（0600），按下方「会话有效期」复用（默认 12h）', component: 'Switch' },
        { field: 'agent.kb.crawl.sessionTtlHours', label: '会话有效期(小时)', bottomHelpMessage: '默认 12；超期视为过期', component: 'InputNumber', componentProps: { min: 0.1, max: 720, step: 1 } },
        { field: 'agent.kb.crawl.sessionProfile', label: '持久浏览器 profile', bottomHelpMessage: '保留完整浏览器 profile（登录态更稳），但浏览器会全局串行、占磁盘；默认关', component: 'Switch' },
        { field: 'agent.kb.crawl.siteMemory', label: '站点难度记忆', bottomHelpMessage: '记住上次哪档有效：fetch 够用就不再起浏览器；被拦过下次直接 undetected', component: 'Switch' },
        { field: 'agent.kb.crawl.perHostIntervalMs', label: '同站最小间隔(ms)', bottomHelpMessage: '默认 1200，含抖动；同一对话连抓几个页面时最重要', component: 'InputNumber', componentProps: { min: 0, max: 60000, step: 100 } },
        { field: 'agent.kb.crawl.hostConcurrency', label: '同站并发', bottomHelpMessage: '默认 1（串行）', component: 'InputNumber', componentProps: { min: 1, max: 8 } },
        { field: 'agent.kb.crawlTimeout', label: '单页抓取超时(秒)', bottomHelpMessage: '默认 60；crawl4ai 含浏览器启停另加 30s 余量', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.kb.chunkSize', label: '文档分块字符数', bottomHelpMessage: '默认 500', component: 'InputNumber', componentProps: { min: 50 } },
        { field: 'agent.kb.chunkOverlap', label: '分块重叠字符', bottomHelpMessage: '默认 50（保上下文连贯）', component: 'InputNumber', componentProps: { min: 0 } },
        { field: 'agent.kb.topK', label: 'kb_search 返回片段数', bottomHelpMessage: '默认 5', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.kb.minScore', label: '知识库最低相似度', bottomHelpMessage: '默认 0.3（cosine；低于不返回）；embedding 复用 recall.embedProvider', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },

        // —— 临时文件与下载 ——
        { label: '临时文件与下载', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.tempFiles.enable', label: '自动清理 data/temp', bottomHelpMessage: '转档/截图/下载产物长期堆积占盘；默认开', component: 'Switch' },
        { field: 'agent.tempFiles.ttlHours', label: '临时文件保留小时数', bottomHelpMessage: '默认 24', component: 'InputNumber', componentProps: { min: 1, max: 720 } },
        { field: 'agent.tempFiles.maxFiles', label: '临时文件最多保留数', bottomHelpMessage: '默认 500（仍超限时从最旧的开始删）', component: 'InputNumber', componentProps: { min: 10, max: 100000 } },
        { field: 'agent.download.enable', label: '媒体下载工具', bottomHelpMessage: 'yt-dlp 下载工具开关（默认开；需系统装 yt-dlp+ffmpeg）', component: 'Switch' },
        { field: 'agent.download.maxMB', label: '单文件大小上限(MB)', bottomHelpMessage: '默认 600（yt-dlp --max-filesize，超限中止）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.download.sendLimitMB', label: '自动发送大小上限(MB)', bottomHelpMessage: '默认 100；超过此大小不自动发 QQ（返回本地路径）', component: 'InputNumber', componentProps: { min: 0 } },
        { field: 'agent.download.maxTimeoutSec', label: '下载超时上限(秒)', bottomHelpMessage: '默认 600', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.download.bin', label: 'yt-dlp 路径', bottomHelpMessage: '空=PATH 中的 yt-dlp', component: 'Input', componentProps: { placeholder: '留空=PATH' } },
        { field: 'agent.download.dir', label: '下载输出目录', bottomHelpMessage: '空=data/temp/downloads', component: 'Input', componentProps: { placeholder: '留空=默认' } },
        { field: 'agent.download.allowPrivateHosts', label: '允许下载内网地址', bottomHelpMessage: 'web_download 默认拒绝环回/内网/元数据地址（防 SSRF）；确认环境可信时才开', component: 'Switch' },

        // —— MCP 服务端 ——
        { label: 'MCP 服务端', component: 'SOFT_GROUP_BEGIN' },
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
          bottomHelpMessage: '沙箱化后不再有 #确认 审批与命令黑名单：命令跑在独立 Firecracker microVM 里，网络出口默认放通。**全员可用**（按会话隔离沙箱，无需认领主人；成本由单会话命令数/并发/超时上限兜底）。出口与审计见本组下方 network/audit。连不上 E2B 时一律拒绝执行（绝不回退到本机）。',
          component: 'Select',
          componentProps: { options: [{ label: 'off（关闭）', value: 'off' }, { label: 'e2b（沙箱执行）', value: 'e2b' }] },
        },
        { field: 'agent.sandbox.apiKey', label: 'E2B API Key', bottomHelpMessage: 'E2B 云或自托管团队的 key（敏感：已在回复脱敏中屏蔽）', component: 'Input', componentProps: { placeholder: 'e2b_xxx' } },
        { field: 'agent.sandbox.apiUrl', label: '控制面地址(自托管)', bottomHelpMessage: '如 http://192.168.1.10:3000；云托管留空', component: 'Input', componentProps: { placeholder: '留空=云默认' } },
        { field: 'agent.sandbox.domain', label: '沙箱域名(自托管)', bottomHelpMessage: '自托管沙箱域名；云托管留空', component: 'Input', componentProps: { placeholder: '留空=云默认 e2b.app' } },
        { field: 'agent.sandbox.sandboxUrl', label: '数据面地址(自托管)', bottomHelpMessage: '无通配 DNS 时填 client-proxy 地址（如 http://<host>:3002）；留空=默认', component: 'Input', componentProps: { placeholder: '留空=默认' } },
        { field: 'agent.sandbox.template', label: '沙箱模板', bottomHelpMessage: 'CPU/内存/预装依赖由模板承载（官方 base 起步）', component: 'Input', componentProps: { placeholder: 'base' } },
        { field: 'agent.sandbox.verifyTemplate', label: '验证专用模板(可选)', bottomHelpMessage: 'toolEvo 候选行为验证用的沙箱模板；留空=复用上面的 template', component: 'Input', componentProps: { placeholder: '留空=复用 template' } },
        { field: 'agent.sandbox.maxTimeout', label: '单命令超时上限(秒)', bottomHelpMessage: '默认 600', component: 'InputNumber', componentProps: { min: 1, max: 3600 } },
        { field: 'agent.sandbox.defaultCwd', label: '沙箱内默认目录', bottomHelpMessage: '默认 /home/user（宿主路径在沙箱内无意义）', component: 'Input', componentProps: { placeholder: '/home/user' } },
        { field: 'agent.sandbox.idleMs', label: '闲置回收(毫秒)', bottomHelpMessage: '会话沙箱空闲超时后销毁（默认 300000=5 分钟）', component: 'InputNumber', componentProps: { min: 10000, step: 10000 } },
        { field: 'agent.sandbox.sandboxTtlMs', label: '沙箱 TTL(毫秒)', bottomHelpMessage: '默认 600000；命中租约且过半衰时自动续期', component: 'InputNumber', componentProps: { min: 60000, step: 60000 } },
        { field: 'agent.sandbox.maxSandboxes', label: '并发沙箱上限', bottomHelpMessage: '默认 4；超出进入等待队列（等待超时见下项）', component: 'InputNumber', componentProps: { min: 1, max: 64 } },
        { field: 'agent.sandbox.concurrencyWaitMs', label: '等并发名额超时(毫秒)', bottomHelpMessage: '等待并发沙箱名额的最长时间（默认 15000；超时按配额失败）', component: 'InputNumber', componentProps: { min: 0, step: 1000 } },
        { field: 'agent.sandbox.maxCommandsPerSession', label: '单会话命令数上限', bottomHelpMessage: '防长任务把配额/账单打爆（默认 50）；0=不限', component: 'InputNumber', componentProps: { min: 0 } },
        { field: 'agent.sandbox.requestTimeoutMs', label: 'SDK 请求超时(毫秒)', bottomHelpMessage: '默认 60000', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },
        { field: 'agent.sandbox.retries', label: 'SDK 重试次数', bottomHelpMessage: '默认 1（云默认 3，降为 1 控延迟）', component: 'InputNumber', componentProps: { min: 0, max: 10 } },
        { field: 'agent.sandbox.allowPublicTraffic', label: '公开 URL 免 token', bottomHelpMessage: '默认关=沙箱公开链接也要求 token（收紧，推荐）；开启后公开链接可被直接访问', component: 'Switch' },
        { field: 'agent.sandbox.audit', label: '命令审计日志', bottomHelpMessage: '每条命令写审计日志（会话键/退出码/命令前 200 字符，不含密钥）；默认开；仅 sandbox.mode=e2b 时生效', component: 'Switch' },
        { field: 'agent.sandbox.network.allowInternet', label: '允许沙箱联网', bottomHelpMessage: '仅 sandbox.mode=e2b 时生效。默认开=放通全部出口；关=断网（配了 allowOut 白名单时白名单仍放行）。要断网优先用它，别在 denyOut 写 0.0.0.0/0', component: 'Switch' },
        { field: 'agent.sandbox.network.allowOut', label: '出口白名单(每行一个)', bottomHelpMessage: '仅 sandbox.mode=e2b 时生效。留空=不限；填了只放行这些域名/CIDR，其余全部拒绝。注意只写 IP/CIDR 时 E2B 不会自动放行 DNS——白名单里请写域名', component: 'InputTextArea', componentProps: { rows: 3, placeholder: 'api.openai.com\npypi.org' } },
        { field: 'agent.sandbox.network.denyOut', label: '额外拒绝网段(每行一个)', bottomHelpMessage: '仅 sandbox.mode=e2b 时生效。如 169.254.169.254/32（防云元数据）；留空=不加额外拒绝。★不要写 0.0.0.0/0：会连 DNS 一起拒绝导致完全断网，断网请用上面的「允许沙箱联网」开关', component: 'InputTextArea', componentProps: { rows: 2, placeholder: '169.254.169.254/32' } },

        // —— Stagehand 浏览器自动化 ——
        { label: 'Stagehand 浏览器自动化', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.stagehand.enable', label: '启用浏览器自动化', bottomHelpMessage: 'act/extract/observe 自然语言原语；访问权限由下方「访问权限」控制（默认仅框架主人），act 不单独审批。依赖 @browserbasehq/stagehand+zod（云崽根 pnpm install）', component: 'Switch' },
        { field: 'agent.stagehand.permission', label: '访问权限', bottomHelpMessage: 'master=仅框架主人（默认）；all=全部成员可用 goto/observe/extract/act（act 直接改变页面状态，无单独审批）。开放给全员意味着群成员可驱动宿主浏览器并消耗 Browserbase/LLM 配额，慎用', component: 'Select', componentProps: { options: [{ label: '仅主人(master)', value: 'master' }, { label: '全部成员(all)', value: 'all' }] } },
        { field: 'agent.stagehand.mode', label: '浏览器模式', component: 'Select', componentProps: { options: [{ label: 'local 本地(默认)', value: 'local' }, { label: 'cloud Browserbase', value: 'cloud' }] } },
        { field: 'agent.stagehand.headless', label: '无头模式(本地)', bottomHelpMessage: '本地模式是否无头；服务器建议开', component: 'Switch' },
        { field: 'agent.stagehand.executablePath', label: 'chrome 路径(可选)', bottomHelpMessage: '本地 chrome 可执行路径；留空=自动探测（executablePath→CHROME_PATH/PUPPETEER_EXECUTABLE_PATH→Puppeteer 自带 Chromium→~/.cache 缓存→系统路径）。服务器上装了 chromium 或 Yunzai 自带 puppeteer 时通常无需填写', component: 'Input', componentProps: { placeholder: '留空=默认' } },
        { field: 'agent.stagehand.browserbaseApiKey', label: 'Browserbase apiKey', bottomHelpMessage: '云模式必填（bb_live_...）；本地模式留空', component: 'Input', componentProps: { placeholder: 'bb_live_...' } },
        { field: 'agent.stagehand.region', label: '云区域(可选)', component: 'Select', componentProps: { options: [{ label: '默认 us-west-2', value: '' }, { label: 'us-east-1', value: 'us-east-1' }, { label: 'eu-central-1', value: 'eu-central-1' }, { label: 'ap-southeast-1', value: 'ap-southeast-1' }] } },
        { field: 'agent.stagehand.modelName', label: 'Stagehand 原生模型(可选)', bottomHelpMessage: '如 google/gemini-2.5-flash、openai/gpt-5；空=复用插件 provider(仅 OpenAI 兼容)；云模式空=Model Gateway 自动选', component: 'Input', componentProps: { placeholder: '留空=复用插件 provider' } },
        { field: 'agent.stagehand.modelApiKey', label: '原生模型 apiKey(可选)', bottomHelpMessage: '原生模型 apiKey；云模式部分 provider 可空', component: 'Input' },
        { field: 'agent.stagehand.idleTimeoutMs', label: '会话空闲超时(毫秒)', bottomHelpMessage: '默认 300000=5 分钟', component: 'InputNumber', componentProps: { min: 60000, step: 60000 } },

        // —— 多模态（media）——
        { label: '多模态（media）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.media.enable', label: '多模态总开关', bottomHelpMessage: '默认开；false=同时关闭附件收集/视觉子模型/表情自动发现/工具看图（视觉组的 enable 也受它约束）', component: 'Switch' },
        { field: 'agent.media.active', label: '主动收集附件', bottomHelpMessage: '消息/引用/合并转发/群文件中的图片文件；默认开', component: 'Switch' },
        { field: 'agent.media.passive', label: '被动工具', bottomHelpMessage: 'list_group_files/get_group_file/read_attachment；默认开', component: 'Switch' },
        { field: 'agent.media.maxImages', label: '单次最大图片数', bottomHelpMessage: '默认 4', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.media.maxFileBytes', label: '单文件字节上限', bottomHelpMessage: '默认 8388608（8MB）', component: 'InputNumber', componentProps: { min: 0, step: 1048576 } },
        { field: 'agent.media.degrade', label: '非视觉模型降级', component: 'Select', componentProps: { options: OPT.degrade } },
        { field: 'agent.media.capsFromApi', label: '从厂商拉取模态能力', bottomHelpMessage: '从 /models 拉取模态元数据判定模型能力（OpenRouter 等；MiMo 无此数据→回退内置表）；默认开', component: 'Switch' },

        // —— 表情包（sticker）——
        { label: '表情包（sticker）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.sticker.enable', label: '表情包总开关', bottomHelpMessage: '默认关；未开则不注入清单、不解析，零影响', component: 'Switch' },
        { field: 'agent.sticker.maxPerReply', label: '单条回复最多贴纸数', bottomHelpMessage: '默认 2（硬上限 5；填 0/非法值按 2 处理，要关闭请用上面的总开关）', component: 'InputNumber', componentProps: { min: 1, max: 5 } },
        { field: 'agent.sticker.cooldown', label: '带图回复冷却(秒)', bottomHelpMessage: '同会话两次带图回复最小间隔（默认 300）', component: 'InputNumber', componentProps: { min: 0 } },
        { field: 'agent.sticker.sendRate', label: '带图概率闸', bottomHelpMessage: '门控通过后实际带图概率（默认 0.25，防每条都带）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.sticker.antiConsecutive', label: '防连发', bottomHelpMessage: '上一条带过则本条不带；默认开', component: 'Switch' },
        { field: 'agent.sticker.groupOnly', label: '仅群聊启用', bottomHelpMessage: '默认关', component: 'Switch' },
        { field: 'agent.sticker.listTopN', label: '注入清单条数上限', bottomHelpMessage: '默认 30', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.sticker.sendStickerTool', label: '注册 send_sticker 工具', bottomHelpMessage: '按情绪跨全库选图（不受清单 top-N 限制）；默认开，且仅 sticker.enable=true 时注册', component: 'Switch' },

        // —— 语音合成（tts）——
        { label: '语音合成（tts）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.tts.enable', label: '语音合成总开关', bottomHelpMessage: '默认关（opt-in）：开=注册 tts_speak 并允许自动语音；关=完全静默（不注册、不合成）', component: 'Switch' },
        { field: 'agent.tts.provider', label: '服务商', bottomHelpMessage: '云服务商仅在选中且配置齐全时才出网；详细音色/情绪参数见 Web 配置中心或 yaml', component: 'Select', componentProps: { options: OPT.ttsProvider } },
        { field: 'agent.tts.autoReply', label: '每条回复自动合成语音', bottomHelpMessage: '默认关；开启后每条最终回复自动追加语音（仅 tts.enable=true 时生效）', component: 'Switch' },
        { field: 'agent.tts.replyMaxChars', label: '自动语音最大字符数', bottomHelpMessage: '超长按句截断（默认 300；0=不限）', component: 'InputNumber', componentProps: { min: 0 } },
        { field: 'agent.tts.hdVoice', label: '发送前高清化', bottomHelpMessage: '响度标准化 + 存在感补偿（需宿主 ffmpeg，失败回退原始音频）；默认开', component: 'Switch' },

        // —— 语音转写（stt）——
        { label: '语音转写（stt）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.stt.enable', label: 'transcribe_media 工具', bottomHelpMessage: '默认开；需填 apiKey 才可用，关则不注册', component: 'Switch' },
        { field: 'agent.stt.apiBase', label: 'STT API 地址', bottomHelpMessage: 'Whisper 兼容接口（如 https://api.openai.com/v1/audio/transcriptions）', component: 'Input', componentProps: { placeholder: 'https://api.openai.com/v1/audio/transcriptions' } },
        { field: 'agent.stt.apiKey', label: 'STT API Key', bottomHelpMessage: 'OpenAI/Groq/Azure 等', component: 'Input' },
        { field: 'agent.stt.model', label: 'STT 模型', bottomHelpMessage: '默认 whisper-1', component: 'Input', componentProps: { placeholder: 'whisper-1' } },
        { field: 'agent.stt.language', label: '语言提示', bottomHelpMessage: '如 zh/en；留空自动检测', component: 'Input', componentProps: { placeholder: '留空=自动' } },

        // —— 计算（calc）——
        { label: '计算（calc）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.calc.enable', label: 'Python 计算工具', bottomHelpMessage: '默认开；启用 E2B 沙箱后改在会话沙箱内执行（模板需含 python3）', component: 'Switch' },
        { field: 'agent.calc.python', label: 'python 可执行文件', bottomHelpMessage: '默认 python3；容器内路径可能不同', component: 'Input', componentProps: { placeholder: 'python3' } },
        { field: 'agent.calc.timeout', label: '单次计算超时(秒)', bottomHelpMessage: '默认 10（防死循环）', component: 'InputNumber', componentProps: { min: 1 } },

        // —— 示意图（diagram）——
        { label: '示意图（diagram）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.diagram.enable', label: '示意图生成工具', bottomHelpMessage: '默认开；未部署 Kroki 时工具返回结构化失败，不影响对话', component: 'Switch' },
        { field: 'agent.diagram.renderer', label: '渲染器', bottomHelpMessage: '默认 kroki（自托管 Kroki 容器渲染 D2）；内部部署细节见 docs/deploy/kroki-compose.yaml', component: 'Input', componentProps: { placeholder: 'kroki' } },

        // —— ComfyUI ——
        { label: 'ComfyUI', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.comfyui.enable', label: 'ComfyUI 工具总开关', bottomHelpMessage: '默认关；关则不注册 comfyui__* 工具', component: 'Switch' },

        // —— 米游社（miyoushe）——
        { label: '米游社（miyoushe）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.miyoushe.cookie', label: '米游社 cookie', bottomHelpMessage: '扫码/抓包获取；敏感信息已在回复脱敏中屏蔽', component: 'Input' },
        { field: 'agent.miyoushe.defaultGid', label: '默认社区 gid', bottomHelpMessage: '默认 2', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.miyoushe.maxImages', label: '单帖最多发图数', bottomHelpMessage: '默认 9（攻略图集帖，避免只发一张）', component: 'InputNumber', componentProps: { min: 1, max: 20 } },

        // —— 子代理编排（multiagent）——
        { label: '子代理编排（multiagent）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.multiagent.enable', label: '允许创建子代理', bottomHelpMessage: '主 Agent 可自主创建隔离子代理委派任务；默认开', component: 'Switch' },
        { field: 'agent.multiagent.topology', label: '编排拓扑', bottomHelpMessage: 'spawn=异步三件套 spawn/check/extend_subagent（默认）/ orchestrator=同步编排工具 orchestrate', component: 'Select', componentProps: { options: OPT.topology } },
        { field: 'agent.multiagent.maxConcurrent', label: '同时运行子代理上限', bottomHelpMessage: '默认 3', component: 'InputNumber', componentProps: { min: 1, max: 10 } },
        { field: 'agent.multiagent.maxSpawnsPerConversation', label: '单次对话最多创建数', bottomHelpMessage: '默认 5（topology=spawn 时生效）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.multiagent.workerMaxTurns', label: '子代理工具轮次上限', bottomHelpMessage: '默认 256（防失控烧 token；上界 1000）', component: 'InputNumber', componentProps: { min: 1, max: 1000 } },
        { field: 'agent.multiagent.workerModel', label: '子代理模型(可选)', bottomHelpMessage: '空=复用主模型；可填任意已注册厂商的模型降本（可跨厂商）', component: 'Input', componentProps: { placeholder: '留空=主模型' } },

        // —— 伪人模式（humanize）——
        { label: '伪人模式（humanize）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.humanize.enable', label: '伪人模式总开关', bottomHelpMessage: '⚠️ 早期开发，默认关；即便 true，groups 为空也不开启。建议先 shadow=true 观察 #伪人决策 质量再放量', component: 'Switch' },
        { field: 'agent.humanize.groups', label: '白名单群号(每行一个)', bottomHelpMessage: '显式白名单；空=不开启', component: 'InputTextArea', componentProps: { rows: 3, placeholder: '123456789' } },
        { field: 'agent.humanize.groupsOverride', label: '群级覆盖(JSON)', bottomHelpMessage: '按群覆盖 humanize 配置，JSON 对象：{ "群号": { "threshold": 90 } }（深度合并到本块）；留空=无覆盖', component: 'InputTextArea', componentProps: { autosize: { minRows: 2, maxRows: 8 }, placeholder: '{}' } },
        { field: 'agent.humanize.shadow', label: '影子模式', bottomHelpMessage: 'true=只记录决策 trace、不真实发送（默认开；先观察再放量）', component: 'Switch' },
        { field: 'agent.humanize.threshold', label: '必要性评分阈值', bottomHelpMessage: 'final>=该值才进 Planner（默认 80）', component: 'InputNumber', componentProps: { min: 0, max: 100 } },
        { field: 'agent.humanize.memory.model', label: '伪人记忆模型(可选)', bottomHelpMessage: '伪人记忆抽取/整合模型；留空=utilityModel→主模型；可跨厂商（填模型条目 id 或模型名）', component: 'Input', componentProps: { placeholder: '留空=utilityModel' } },

        // —— 群聊小世界（groupWorld）——
        { label: '群聊小世界（groupWorld）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.groupWorld.enabled', label: '社会记忆层总开关', bottomHelpMessage: '默认关；即便 true，groups 为空也不开启', component: 'Switch' },
        { field: 'agent.groupWorld.groups', label: '白名单群号(每行一个)', bottomHelpMessage: '显式白名单；空=不开启', component: 'InputTextArea', componentProps: { rows: 3, placeholder: '123456789' } },
        { field: 'agent.groupWorld.online', label: '在线注入伪人', bottomHelpMessage: '默认关（先观察再上线）；消费方只有伪人链路，需 humanize.enable=true 且群在 humanize.groups 白名单内才有效', component: 'Switch' },

        // —— 自我认知（selfState）——
        { label: '自我认知（selfState）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.selfState.enabled', label: '自我认知层总开关', bottomHelpMessage: '默认关；关=整层 no-op', component: 'Switch' },
        { field: 'agent.selfState.shadowMode', label: '影子模式', bottomHelpMessage: '计算入库但不影响发言（默认开，观察期）；false 才注入伪人 Planner/Replyer（需 humanize.enable=true）', component: 'Switch' },
        { field: 'agent.selfState.groups', label: '维护群号(每行一个)', bottomHelpMessage: '定时反思/维护的群白名单；留空=复用 groupWorld.groups → humanize.groups', component: 'InputTextArea', componentProps: { rows: 2, placeholder: '留空=复用上游白名单' } },

        // —— QQ 官方机器人（QQBot / QQ 频道）——
        { label: 'QQ 官方机器人（QQBot / 频道）', component: 'SOFT_GROUP_BEGIN' },
        { label: 'QQ 官方机器人 · 自实现适配器（AppID + AppSecret）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.qqBot.enable', label: '启用自实现适配器', bottomHelpMessage: '本插件直接连 QQ 官方网关，只需 AppID + AppSecret（不需要机器人 QQ 号与 Token）。账号增删/连接状态建议用 Web 面板「机器人账号」页；⚠️ 与 Yunzai-QQBot-Plugin 二选一，否则重复收发', component: 'Switch' },
        { field: 'agent.qqBot.appId', label: 'AppID', bottomHelpMessage: 'QQ 开放平台 → 开发设置 → 机器人 AppID', component: 'Input', componentProps: { placeholder: '如 102012345' } },
        { field: 'agent.qqBot.appSecret', label: 'AppSecret', bottomHelpMessage: 'QQ 开放平台 → 开发设置 → AppSecret（敏感：回复发送前会脱敏）', component: 'Input', componentProps: { placeholder: 'AppSecret' } },
        { field: 'agent.qqBot.markdown', label: 'Markdown 能力', bottomHelpMessage: 'auto=先试 Markdown、无权限自动降级纯文本并记忆（推荐）| true=总是 | false=纯文本', component: 'Select', componentProps: { options: [{ label: 'auto（推荐）', value: 'auto' }, { label: 'true 总是 Markdown', value: 'true' }, { label: 'false 纯文本', value: 'false' }] } },
        { field: 'agent.qqBot.preferMarkdownText', label: '纯文本也走 Markdown', bottomHelpMessage: '平台支持时，纯文本回复也用 Markdown 消息渲染', component: 'Switch' },
        { field: 'agent.qqBot.sandbox', label: '沙箱环境', bottomHelpMessage: '连开放平台沙箱（api 域名 sandbox.）', component: 'Switch' },
        { field: 'agent.qqBot.intents', label: '事件订阅位图(intents)', bottomHelpMessage: '0=默认只订群@+C2C（33554432）；按钮交互填 100663296、频道填 1073741825。填平台未开通的位会被 close 4013 拒绝（插件会自动降级重连），一般保持 0', component: 'InputNumber', componentProps: { min: 0 } },
        { field: 'agent.qqBot.accounts', label: '多账号(JSON)', bottomHelpMessage: '数组：[{name,appId,appSecret,sandbox,intents,markdown}]；与上面扁平字段二选一（留空用扁平）', component: 'InputTextArea', componentProps: { autosize: { minRows: 2, maxRows: 8 }, placeholder: '[]' } },
        { field: 'agent.qqBot.apiBase', label: 'OpenAPI 基址(可选)', bottomHelpMessage: '默认 https://api.bot.qq.com（失败自动回退 api.sgroup.qq.com）；自建代理时填', component: 'Input', componentProps: { placeholder: '留空=官方' } },
        { field: 'agent.qqBot.tokenUrl', label: 'token 端点(可选)', bottomHelpMessage: '默认 https://api.bot.qq.com/app/getAppAccessToken（失败自动回退 bots.qq.com）', component: 'Input', componentProps: { placeholder: '留空=官方' } },

        { field: 'agent.qqOfficial.markdown.enable', label: 'Markdown 直发', bottomHelpMessage: '仅 QQ 官方机器人适配器生效：回复用原生 Markdown 消息（不再渲染成图片）；平台拒绝时自动降级纯文本。OneBot/ICQQ 不受影响', component: 'Switch' },
        { field: 'agent.qqOfficial.markdown.maxChars', label: 'Markdown 单条上限(字符)', bottomHelpMessage: '超出按行分片发送（官方上限约 4000，默认 3500）', component: 'InputNumber', componentProps: { min: 500, max: 4000, step: 100 } },
        { field: 'agent.qqOfficial.markdown.templateId', label: 'Markdown 模板 ID(可选)', bottomHelpMessage: 'QQ 后台申请的模板 ID；填了走模板消息（忽略正文直接渲染）', component: 'Input', componentProps: { placeholder: '留空=原始 Markdown' } },
        { field: 'agent.qqOfficial.keyboard.enable', label: '按钮卡片工具(send_keyboard)', bottomHelpMessage: '注册 send_keyboard 工具：Markdown + inline keyboard（≤5 行 × ≤5 个；回调按钮默认仅触发者可点）。仅官方协议可发', component: 'Switch' },
        { field: 'agent.qqOfficial.progress', label: '官方下发进度消息', bottomHelpMessage: '默认关：官方机器人主动推送有频控/需权限，关=不发「思考中…」；需要时打开', component: 'Switch' },
        { field: 'agent.qqOfficial.narrate', label: '官方下中途播报', bottomHelpMessage: '默认关：同上，避免被动回复窗口外的消息被平台拒绝', component: 'Switch' },

        // —— 调试日志（devLog）——
        { label: '调试日志（devLog）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.devLog.enable', label: '全链路日志', bottomHelpMessage: '记录 AI 全链路（缩进 JSON 人工可读），方便 #上报错误 排查；生产环境默认开', component: 'Switch' },
        { field: 'agent.devLog.dir', label: '日志目录', bottomHelpMessage: '留空=data/logs', component: 'Input', componentProps: { placeholder: '留空=默认' } },

        // —— 视觉子模型（补充） ——
        { label: '视觉子模型（补充）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.vision.protocol', label: '视觉协议', bottomHelpMessage: '如 anthropic；留空=复用主协议', component: 'Input' },
        { field: 'agent.vision.preset', label: '视觉厂商预设', bottomHelpMessage: '留空=复用主预设', component: 'Input' },
        { field: 'agent.vision.baseURL', label: '视觉 baseURL', bottomHelpMessage: '留空=复用主 baseURL', component: 'Input' },
        { field: 'agent.vision.maxTokens', label: '识图/视频报告输出上限(tokens)', bottomHelpMessage: '显式配置优先于模型条目的 maxTokens；视频报告建议 ≥2048', component: 'InputNumber', componentProps: { min: 256, step: 256 } },
        { field: 'agent.vision.describePrompt', label: '自定义识图指令', bottomHelpMessage: '留空=内置指令（不影响视频）', component: 'InputTextArea', componentProps: { autosize: { minRows: 2, maxRows: 6 } } },

        // —— 定时任务 / 任务账本 ——
        { label: '定时任务 / 任务账本', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.schedule.taskEnabled', label: '定时任务链开关', bottomHelpMessage: 'false=拒绝创建 #定时任务（提醒按用户归属，任务链按会话/群级归属）', component: 'Switch' },
        { field: 'agent.schedule.taskMaxTurns', label: '任务链轮次上限', bottomHelpMessage: '默认 256（防失控烧 token）', component: 'InputNumber', componentProps: { min: 1, max: 1000 } },
        { field: 'agent.taskStore.enable', label: '可恢复任务账本', bottomHelpMessage: '默认关（开发阶段）；开启后任务事件/检查点落 sqlite，#任务列表/#继续任务 可用', component: 'Switch' },
        { field: 'agent.taskStore.dir', label: '任务账本目录', bottomHelpMessage: '默认 data/tasks', component: 'Input' },

        // —— 工具 / 渲染 ——
        { label: '工具 / 渲染', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.tools.builtin', label: '内置工具包', bottomHelpMessage: '群信息/群管/米游社/Enka 等（默认开）', component: 'Switch' },
        { field: 'agent.tools.dir', label: '自定义工具包目录', bottomHelpMessage: '相对插件根（默认 tools）', component: 'Input' },
        { field: 'agent.render.helpTimeoutMs', label: '帮助图渲染超时(ms)', bottomHelpMessage: '帮助卡片最长，弱机器/冷缓存首次渲染常超过普通卡片；默认 300000（5 分钟），超时降级文本并进入冷却', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },
        { field: 'agent.render.timeoutMs', label: '卡片图渲染超时(ms)', bottomHelpMessage: '普通列表卡片；超时降级文本（默认 15000）', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },
        { field: 'agent.render.replyTimeoutMs', label: '回复图渲染超时(ms)', bottomHelpMessage: '默认 30000', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },

        // —— 记忆召回（补充） ——
        { label: '记忆召回（补充）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.recall.usage.containment', label: '记忆被引用判定阈值', bottomHelpMessage: '最终回复对记忆词元包含率 ≥ 该值判为被引用（默认 0.5）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.recall.usage.penalizeAfter', label: '未引用降权次数', bottomHelpMessage: '注入达此次数且从未被引用 → 降权（默认 5）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.recall.usage.penalty', label: '降权系数', bottomHelpMessage: '0.5=权重减半（默认 0.5）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.recall.embedBaseURL', label: 'embedding 接口地址', bottomHelpMessage: '留空=复用主 baseURL', component: 'Input' },
        { field: 'agent.recall.embedApiKey', label: 'embedding apiKey', bottomHelpMessage: '留空=复用主 apiKey', component: 'Input' },
        { field: 'agent.profile.inferAfter', label: '隐式推断起始消息数', bottomHelpMessage: '累计消息数达到此值后才开始隐式推断（默认 8）', component: 'InputNumber', componentProps: { min: 1 } },

        // —— 深度研究（research） ——
        { label: '深度研究（research）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.research.maxConcurrent', label: '并发 worker 上限', bottomHelpMessage: '默认 3', component: 'InputNumber', componentProps: { min: 1, max: 10 } },
        { field: 'agent.research.permission', label: '#研究 权限', component: 'Select', componentProps: { options: [{ label: '仅主人(防滥用)', value: 'master' }, { label: '所有人', value: 'all' }] } },
        { field: 'agent.research.maxRounds', label: '最大轮次', bottomHelpMessage: '默认 3', component: 'InputNumber', componentProps: { min: 1, max: 10 } },
        { field: 'agent.research.workerModel', label: '子代理模型', bottomHelpMessage: '空则用主模型；可填任意已注册厂商的模型省钱（可跨厂商）', component: 'Input' },
        { field: 'agent.research.evaluation', label: '交叉验证', bottomHelpMessage: '对研究结果做评估/对抗验证（默认开）', component: 'Switch' },

        // —— 技能 / 搜索 / MCP ——
        { label: '技能 / 搜索 / MCP', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.skill.dir', label: '技能目录', bottomHelpMessage: '相对插件根（默认 skills）', component: 'Input' },
        { field: 'agent.skill.historyCount', label: '技能历史注入条数', bottomHelpMessage: '默认 15', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.search.timeout', label: '搜索超时(ms)', bottomHelpMessage: '0/留空=各源默认（DDG 15s）；慢源可调大；单源覆盖需 yaml（如 tavily: { timeout: 20000 }）', component: 'InputNumber', componentProps: { min: 0, max: 120000 } },
        { field: 'agent.mcp.requestTimeout', label: '请求超时(毫秒)', bottomHelpMessage: '默认 60000', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },

        // —— 表情包（补充） ——
        { label: '表情包（补充）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.sticker.autoDiscover', label: '自动发现总开关', bottomHelpMessage: '需 sticker.enable + agent.vision.enable（主模型无视觉时还需 vision.model）', component: 'Switch' },
        { field: 'agent.sticker.discoverGroups', label: '采集群白名单(每行一个)', bottomHelpMessage: '空=所有群都采集', component: 'InputTextArea', componentProps: { rows: 3, placeholder: "123456789" } },
        { field: 'agent.sticker.maxDiscovered', label: '自动发现条目上限', bottomHelpMessage: '超限按 usageCount 升序淘汰（默认 256）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.sticker.discoverMaxSizeMB', label: '单张采集大小上限(MB)', bottomHelpMessage: '0=不限（默认 5）', component: 'InputNumber', componentProps: { min: 0 } },

        // —— ComfyUI（补充） ——
        { label: 'ComfyUI（补充）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.comfyui.apiKey', label: 'Cloud X-API-Key', bottomHelpMessage: 'cloud=true 时必填', component: 'Input' },
        { field: 'agent.comfyui.host', label: '服务地址', bottomHelpMessage: '本地/远程/Cloud（如 http://127.0.0.1:8188）', component: 'Input', componentProps: { placeholder: 'http://127.0.0.1:8188' } },
        { field: 'agent.comfyui.cloud', label: 'Comfy Cloud 路由', bottomHelpMessage: 'true=走云端点（host 填 https://cloud.comfy.org；cloud 时 apiKey 必填）', component: 'Switch' },
        { field: 'agent.comfyui.confirm', label: '生成需主人审批', bottomHelpMessage: '默认开（#确认/#拒绝）；false=免审批直接生成，每次消耗 GPU，谨慎关闭', component: 'Switch' },
        { field: 'agent.comfyui.workflowDir', label: '工作流目录', bottomHelpMessage: 'ComfyUI user 目录下（默认 user/default/workflows，递归）', component: 'Input' },
        { field: 'agent.comfyui.workflowCacheTtl', label: '工作流缓存(秒)', bottomHelpMessage: '默认 300', component: 'InputNumber', componentProps: { min: 0 } },
        { field: 'agent.comfyui.timeout', label: '单次生成最长等待(秒)', bottomHelpMessage: '默认 300（视频工作流自动放宽到 900）', component: 'InputNumber', componentProps: { min: 10 } },
        { field: 'agent.comfyui.pollInterval', label: '轮询初始间隔(秒)', bottomHelpMessage: '默认 1.5', component: 'InputNumber', componentProps: { min: 0.5, step: 0.5 } },
        { field: 'agent.comfyui.pollMaxInterval', label: '轮询最大间隔(秒)', bottomHelpMessage: '默认 8', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.comfyui.maxImages', label: '单次最多发图数', bottomHelpMessage: '默认 4', component: 'InputNumber', componentProps: { min: 1, max: 10 } },
        { field: 'agent.comfyui.outputDir', label: '产物落盘目录', bottomHelpMessage: '留空=data/temp', component: 'Input' },
        { field: 'agent.comfyui.command.enable', label: '#画图 指令', bottomHelpMessage: '仅在 comfyui.enable=true 时有效', component: 'Switch' },
        { field: 'agent.comfyui.command.masterOnly', label: '#画图 仅主人', bottomHelpMessage: '默认 false', component: 'Switch' },
        { field: 'agent.comfyui.command.cooldown', label: '#画图 冷却(秒)', bottomHelpMessage: '0=不限（默认 30）', component: 'InputNumber', componentProps: { min: 0 } },

        // —— 示意图（补充） ——
        { label: '示意图（补充）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.diagram.fallbackRenderer', label: '本地回退渲染器', bottomHelpMessage: 'Kroki 失败时：none / beautiful-mermaid（需已装依赖）', component: 'Select', componentProps: { options: OPT.dgFallback } },
        { field: 'agent.diagram.defaultTheme', label: '默认主题', bottomHelpMessage: '', component: 'Select', componentProps: { options: OPT.dgTheme } },
        { field: 'agent.diagram.defaultFormat', label: '默认输出格式', bottomHelpMessage: '', component: 'Select', componentProps: { options: OPT.dgFormat } },
        { field: 'agent.diagram.timeoutMs', label: '渲染总预算(ms)', bottomHelpMessage: '默认 15000', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },
        { field: 'agent.diagram.targetWidth', label: '默认输出宽度(px)', bottomHelpMessage: '默认 1600', component: 'InputNumber', componentProps: { min: 200, step: 100 } },
        { field: 'agent.diagram.maxNodes', label: '节点数上限', bottomHelpMessage: '默认 50', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.diagram.maxEdges', label: '连线数上限', bottomHelpMessage: '默认 100', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.diagram.kroki.enabled', label: 'Kroki 启用', bottomHelpMessage: '默认开', component: 'Switch' },
        { field: 'agent.diagram.kroki.endpoint', label: 'Kroki 地址', bottomHelpMessage: '自托管地址（默认 http://127.0.0.1:8000）', component: 'Input' },
        { field: 'agent.diagram.kroki.allowPublicEndpoint', label: '允许公共 Kroki【高危】', bottomHelpMessage: 'true=允许 kroki.io（图中文字将发往第三方）；且强制 HTTPS', component: 'Switch' },
        { field: 'agent.diagram.kroki.allowedDiagramTypes', label: '图类型白名单(每行一个)', bottomHelpMessage: '模型不可指定；默认 d2', component: 'InputTextArea', componentProps: { rows: 2, placeholder: "d2" } },

        // —— TTS 子配置（补充） ——
        { label: 'TTS 子配置（补充）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.tts.judgeModel', label: '情绪判定模型', bottomHelpMessage: '留空=indextts.model→utilityModel→主模型；可跨厂商', component: 'Input', componentProps: { placeholder: "留空=utilityModel" } },
        { field: 'agent.tts.judgeTimeoutMs', label: '情绪判定总预算(ms)', bottomHelpMessage: '默认 300000（全局优先；indextts.judgeTimeoutMs 为历史兜底键）', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },
        { field: 'agent.tts.sovits.endpoint', label: 'SoVITS 接口地址', bottomHelpMessage: 'api_v2（默认 http://127.0.0.1:9880）', component: 'Input' },
        { field: 'agent.tts.sovits.refAudioPath', label: '参考音频路径', bottomHelpMessage: '服务端本地绝对路径，3~10 秒', component: 'Input' },
        { field: 'agent.tts.sovits.promptText', label: '参考音频逐字文本', bottomHelpMessage: '必须与音频一致，否则音色漂移', component: 'Input' },
        { field: 'agent.tts.sovits.promptLang', label: '参考音频语种', bottomHelpMessage: '', component: 'Select', componentProps: { options: OPT.lang5 } },
        { field: 'agent.tts.sovits.textLang', label: '默认合成语种', bottomHelpMessage: '', component: 'Select', componentProps: { options: OPT.lang5 } },
        { field: 'agent.tts.sovits.maxChars', label: '单次朗读上限(字)', bottomHelpMessage: '默认 256', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.tts.sovits.timeoutMs', label: '单次合成超时(ms)', bottomHelpMessage: '默认 120000', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },
        { field: 'agent.tts.indextts.endpoint', label: 'IndexTTS 接口地址', bottomHelpMessage: '如 http://127.0.0.1:7860', component: 'Input' },
        { field: 'agent.tts.indextts.lang', label: '合成语言', bottomHelpMessage: '', component: 'Select', componentProps: { options: OPT.ixLang } },
        { field: 'agent.tts.indextts.voice', label: '默认音色参考名', bottomHelpMessage: '留空=最新上传的音色', component: 'Input' },
        { field: 'agent.tts.indextts.emotionMode', label: '情绪模式', bottomHelpMessage: 'same=沿用音色参考情绪 / audio=情绪参考音频 / vector=8 维情绪向量', component: 'Select', componentProps: { options: OPT.emoMode } },
        { field: 'agent.tts.indextts.tier', label: '情绪档位', bottomHelpMessage: 'pro=整段一套 / max=按需拆分逐段', component: 'Select', componentProps: { options: OPT.tier } },
        { field: 'agent.tts.indextts.timeoutMs', label: '合成超时(ms)', bottomHelpMessage: '默认 300000', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },
        { field: 'agent.tts.indextts.model', label: 'IndexTTS 情绪判定模型', bottomHelpMessage: '留空=tts.judgeModel→utilityModel→主模型', component: 'Input', componentProps: { placeholder: "留空=utilityModel" } },
        { field: 'agent.tts.doubao.endpoint', label: '豆包 TTS 地址', bottomHelpMessage: '默认 openspeech.bytedance.com/api/v3/tts/unidirectional', component: 'Input' },
        { field: 'agent.tts.doubao.apiKey', label: '豆包 API Key', bottomHelpMessage: '火山引擎 API Key', component: 'Input' },
        { field: 'agent.tts.doubao.resourceId', label: '豆包资源 ID', bottomHelpMessage: 'seed-tts-2.0 | seed-tts-1.0 | seed-tts-1.0-concurr', component: 'Select', componentProps: { options: OPT.doubaoRes } },
        { field: 'agent.tts.doubao.speaker', label: '豆包音色 ID', bottomHelpMessage: '控制台 voice_type', component: 'Input' },
        { field: 'agent.tts.doubao.model', label: '豆包模型', bottomHelpMessage: '留空=默认 / seed-tts-2.0-standard / seed-tts-2.0-expressive', component: 'Input' },
        { field: 'agent.tts.doubao.format', label: '豆包输出格式', bottomHelpMessage: '', component: 'Select', componentProps: { options: OPT.wavmp3 } },
        { field: 'agent.tts.doubao.timeoutMs', label: '豆包超时(ms)', bottomHelpMessage: '默认 120000', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },
        { field: 'agent.tts.minimax.endpoint', label: 'MiniMax TTS 地址', bottomHelpMessage: '国际站 https://api.minimax.io/v1/t2a_v2', component: 'Input' },
        { field: 'agent.tts.minimax.apiKey', label: 'MiniMax API Key', bottomHelpMessage: '平台 → 接口密钥', component: 'Input' },
        { field: 'agent.tts.minimax.model', label: 'MiniMax 模型', bottomHelpMessage: 'speech-2.8-hd / 2.8-turbo / 2.6-*', component: 'Input' },
        { field: 'agent.tts.minimax.voiceId', label: 'MiniMax 音色 ID', bottomHelpMessage: '系统音色或复刻音色', component: 'Input' },
        { field: 'agent.tts.minimax.format', label: 'MiniMax 输出格式', bottomHelpMessage: '', component: 'Select', componentProps: { options: OPT.wavmp3flac } },
        { field: 'agent.tts.minimax.timeoutMs', label: 'MiniMax 超时(ms)', bottomHelpMessage: '默认 120000', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },
        { field: 'agent.tts.mimo.endpoint', label: 'MiMo TTS 地址', bottomHelpMessage: '默认 https://api.xiaomimimo.com/v1', component: 'Input' },
        { field: 'agent.tts.mimo.apiKey', label: 'MiMo API Key', bottomHelpMessage: '开放平台 Key', component: 'Input' },
        { field: 'agent.tts.mimo.model', label: 'MiMo 模型', bottomHelpMessage: 'mimo-v2.5-tts | mimo-v2.5-tts-voicedesign', component: 'Input' },
        { field: 'agent.tts.mimo.voice', label: 'MiMo 预置音色', bottomHelpMessage: 'mimo_default / 冰糖 / 茉莉 / 苏打 / 白桦 等', component: 'Input' },
        { field: 'agent.tts.mimo.format', label: 'MiMo 输出格式', bottomHelpMessage: '', component: 'Select', componentProps: { options: OPT.wavmp3 } },
        { field: 'agent.tts.mimo.timeoutMs', label: 'MiMo 超时(ms)', bottomHelpMessage: '默认 120000', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },

        // —— Stagehand（补充） ——
        { label: 'Stagehand（补充）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.stagehand.stealth', label: '真机化指纹', bottomHelpMessage: '随机设备 UA/视口/语言/触屏 + 去自动化 flag', component: 'Switch' },
        { field: 'agent.stagehand.userAgent', label: '固定 UA', bottomHelpMessage: '留空=按设备指纹池随机', component: 'Input' },
        { field: 'agent.stagehand.maxSessions', label: '并发浏览器会话上限', bottomHelpMessage: '默认 3', component: 'InputNumber', componentProps: { min: 1, max: 20 } },
        { field: 'agent.stagehand.opTimeoutMs', label: '单次操作截止(ms)', bottomHelpMessage: '默认 60000', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },
        { field: 'agent.stagehand.llmTimeoutMs', label: '单次 LLM 推理截止(ms)', bottomHelpMessage: '默认 30000', component: 'InputNumber', componentProps: { min: 1000, step: 1000 } },
        { field: 'agent.stagehand.maxCallsPerMinute', label: '每会员每分钟上限', bottomHelpMessage: '默认 10', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.stagehand.maxCallsPerDay', label: '每会员每日上限', bottomHelpMessage: '默认 256', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.stagehand.domSettleTimeoutMs', label: 'act 前 DOM 稳定等待(ms)', bottomHelpMessage: '默认 3000', component: 'InputNumber', componentProps: { min: 0, step: 500 } },
        { field: 'agent.stagehand.blockedHosts', label: '额外禁访主机(每行一个)', bottomHelpMessage: '默认内网/元数据黑名单之外再追加', component: 'InputTextArea', componentProps: { rows: 2, placeholder: "example.com" } },

        // —— 沙箱 / 多模态（补充） ——
        { label: '沙箱 / 多模态（补充）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.sandbox.toolEvoVerifyTimeoutMs', label: 'toolEvo 用例验证超时(ms)', bottomHelpMessage: '沙箱模式单用例（默认 5000）', component: 'InputNumber', componentProps: { min: 500, step: 500 } },
        { field: 'agent.media.caps', label: '能力覆盖(JSON)', bottomHelpMessage: '如 { "vision": true, "video": true }；留空=按协议+模型名自动判定', component: 'InputTextArea', componentProps: { autosize: { minRows: 2, maxRows: 6 }, placeholder: "{}" } },

        // —— 群聊小世界（补充） ——
        { label: '群聊小世界（补充）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.groupWorld.analysis.schedule', label: '分析 cron（热加载）', bottomHelpMessage: '小时增量分析（默认 7 * * * *）；改后即时生效，无需重启', component: 'Input' },
        { field: 'agent.groupWorld.analysis.minSegmentMessages', label: '片段最小消息数', bottomHelpMessage: '低于该值的片段跳过分析（默认 4）', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.groupWorld.analysis.maxSegmentsPerRun', label: '每轮最多分析片段数', bottomHelpMessage: '默认 50', component: 'InputNumber', componentProps: { min: 1 } },
        { field: 'agent.groupWorld.analysis.modelProfile', label: '分析模型(可选)', bottomHelpMessage: '留空=主模型/utilityModel；可跨厂商', component: 'Input', componentProps: { placeholder: "留空=主模型" } },
        { field: 'agent.groupWorld.analysis.maxDailyCallsPerGroup', label: '每群每日调用预算', bottomHelpMessage: '默认 100（熔断；0=停用分析）', component: 'InputNumber', componentProps: { min: 0 } },
        { field: 'agent.groupWorld.analysis.maxTokens', label: '分析输出上限(tokens)', bottomHelpMessage: '默认 1200', component: 'InputNumber', componentProps: { min: 100, step: 100 } },
        { field: 'agent.groupWorld.retrieval.plannerTokenBudget', label: 'Planner 现场 token 预算', bottomHelpMessage: '默认 800', component: 'InputNumber', componentProps: { min: 100, step: 100 } },
        { field: 'agent.groupWorld.retrieval.replyerTokenBudget', label: 'Replyer 现场 token 预算', bottomHelpMessage: '默认 500', component: 'InputNumber', componentProps: { min: 100, step: 100 } },

        // —— 自我认知（补充） ——
        { label: '自我认知（补充）', component: 'SOFT_GROUP_BEGIN' },
        { field: 'agent.selfState.eventDetection.minEventConfidence', label: '事件最低置信度', bottomHelpMessage: '默认 0.55', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.05 } },
        { field: 'agent.selfState.emotion.maxActiveEmotions', label: '并存情绪上限', bottomHelpMessage: '默认 8', component: 'InputNumber', componentProps: { min: 1, max: 20 } },
        { field: 'agent.selfState.emotion.minVisibleIntensity', label: '最低可见强度', bottomHelpMessage: '低于该强度不进投影（默认 0.18）', component: 'InputNumber', componentProps: { min: 0, max: 1, step: 0.01 } },
        { field: 'agent.selfState.resentment.maxSingleEventDelta', label: '单次怨气增量上限', bottomHelpMessage: '默认 0.05', component: 'InputNumber', componentProps: { min: 0, max: 0.5, step: 0.01 } },
        { field: 'agent.selfState.planner.maxStateTokens', label: '状态投影 token 上限', bottomHelpMessage: '默认 220', component: 'InputNumber', componentProps: { min: 50, step: 10 } },
        { field: 'agent.selfState.stability.maxNegativeMoodHours', label: '负心境恢复上限(小时)', bottomHelpMessage: '默认 24（≤48）', component: 'InputNumber', componentProps: { min: 1, max: 48 } },
      ],
      // 获取配置数据（前端展示）
      getConfigData() {
        const data = JSON.parse(JSON.stringify(Config.get()))
        // 多行文本 ↔ 数组：数组 → 换行文本（textarea 展示）
        for (const p of MULTILINE_FIELDS) {
          const v = getPath(data, p)
          if (Array.isArray(v)) setPath(data, p, v.join('\n'))
        }
        // JSON 文本域 ↔ 对象/数组（空值显示为空，便于用 placeholder 提示示例）
        setPath(data, 'agent.fallbackModels', JSON.stringify(Array.isArray(data?.agent?.fallbackModels) ? data.agent.fallbackModels : [], null, 2))
        const ml = data?.agent?.memoryLimits
        setPath(data, 'agent.memoryLimits', ml && typeof ml === 'object' && !Array.isArray(ml) && Object.keys(ml).length ? JSON.stringify(ml, null, 2) : '')
        const cm = data?.agent?.policy?.categoryMin
        setPath(data, 'agent.policy.categoryMin', cm && typeof cm === 'object' && !Array.isArray(cm) && Object.keys(cm).length ? JSON.stringify(cm, null, 2) : '')
        const se = data?.agent?.persona?.styleExamples
        setPath(data, 'agent.persona.styleExamples', JSON.stringify(Array.isArray(se) ? se : [], null, 2))
        const go = data?.agent?.humanize?.groupsOverride
        setPath(data, 'agent.humanize.groupsOverride', go && typeof go === 'object' && !Array.isArray(go) && Object.keys(go).length ? JSON.stringify(go, null, 2) : '')
        const mc = data?.agent?.media?.caps
        setPath(data, 'agent.media.caps', mc && typeof mc === 'object' && !Array.isArray(mc) && Object.keys(mc).length ? JSON.stringify(mc, null, 2) : '')
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
        // JSON 文本域 → 真实对象/数组（解析失败保留原配置并提示，不阻塞其余字段保存）
        for (const [p, spec] of Object.entries(JSON_FIELDS)) {
          if (!(p in (data || {}))) continue
          const raw = data[p]
          delete data[p]
          if (Array.isArray(raw) || (raw && typeof raw === 'object')) { setPath(cfg, p, raw); continue }
          const r = parseJsonField(raw, spec)
          if (!r.ok) {
            Log.warn(`[guoba] ${spec.label} JSON 解析失败，已保留原配置`, r.error)
            notes.push(`${spec.label} JSON 解析失败已保留原配置：${r.error}`)
            continue
          }
          setPath(cfg, p, r.value == null ? spec.empty : r.value)
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
          // 多行文本 → 数组（统一转字符串，群号/QQ/工具名/指令片段/域名都为字符串）
          if (MULTILINE_FIELDS.has(p) && typeof val === 'string') val = linesToArray(val)
          if (MULTILINE_FIELDS.has(p) && Array.isArray(val)) val = val.map((x) => String(x))
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
