# 配置参考

> 本文是主 README 的拆分文档。返回 [README](../README.md)。

## ⚙️ 配置总览

配置文件：`plugins/agents-plugin/config/config.yaml`（**566 个配置叶子**，全部带注释；Web 配置中心可全量编辑）。
下面按主题列出 `agent.*` 下的配置块，字段细节见 「详细配置参考」 与 Web 配置中心。

| 主题 | 配置块（点路径） | 说明 |
| --- | --- | --- |
| **基础与回复** | `trigger` `triggerCommand` `commandPassThrough` `privateChat` `isolation.enable` `progress` `progressRecall` `reply.mode/atSender/quote/narrate/renderScale` `render.*` | 触发方式、私聊开关、数据隔离、进度与回复渲染 |
| **模型** | `providerId` `modelId` `llmProviders[]` `llmModels[]` `fallbackModels[]` `utilityModel` `proxy` `reasoningFields` `temperature` `maxTokens` | 引用制厂商/模型、回退、旁路小模型、代理 |
| **思考** | `thinking` `thinkingAuto.*` `jev.*` | 手动思考 / 自动判档（规则·小模型·Jev） |
| **上下文与缓存** | `contextWindow` `contextMsgHighWater/LowWater` `contextHighRatio/LowRatio` `compaction.*` `cacheControl` `promptCacheKey` `keepReasoning` `stream` `reflect*` `finalizeMaxTokens` `rootTokenBudget` | 压缩水位、缓存策略、收尾与预算 |
| **循环与工具** | `maxTurns` `loop.*` `maxToolResultChars` `toolConcurrency.maxParallel` `toolSchemaValidate` `toolDiscovery.*` `taskStore.*` | 轮次预算与智能终止、工具发现/并发/账本 |
| **记忆** | `memoryLimits` `memory.*` `recall.*` `profile.*` `kb.*` | 声明式记忆、长期召回、用户画像、知识库 |
| **自动化** | `schedule.*` `selfReview.*` `evolution.*` `toolEvo.*` | 定时任务、自评审进化、工具进化 |
| **安全与权限** | `masters` `chatPermission` `masterSkipConfirm` `confirmTimeout` `guardAction` `guardSensitivity` `untrustedGuard` `redactSecrets` `policy.categoryMin` | 主人、审批、注入防御、脱敏、RBAC |
| **多模态** | `media.*` `vision.*` `perception.*` `stt.*` `tts.*` `document.*` `diagram.*` `sticker.*` `download.*` | 媒体/识图/情境/语音/文档/示意图/表情包/下载 |
| **执行面** | `sandbox.*`（`mode`/`network`/`audit`/TTL/并发…） `stagehand.*` `tempFiles.*` `calc.*` | E2B 沙箱、浏览器自动化、临时文件、计算 |
| **协作** | `multiagent.*` `research.*` `mcp.*` `skill.*` `tools.*` `miyoushe.*` | 子代理、深度研究、MCP、技能、工具包 |
| **群聊智能（早期）** | `humanize.*` `groupWorld.*` `selfState.*` | 伪人 / 群世界 / 自我状态 |
| **接入与观测** | `webApi.*`（`enable/port/publicUrl/printTokenOnStart/consoleTokenTtlHours`） `qqBot.*` `qqOfficial.*` `persona.*` `personaLore.*` `devLog.*` | Web 面板（含启动默认地址）、官方机器人、人设、日志 |

> 💡 **改配置前先看「安全与权限」与「执行面」**：沙箱、审批、RBAC 是高危开关，默认已按安全侧取值。

---

## ⚙️ 详细配置参考

> 以下为逐字段参考（配置文件本身带注释；Web 配置中心与本节同源）。
> 未提到的字段用默认值即可；拿不准的项建议在 Web 配置中心改（有校验与说明）。


> 用户配置 `config/config.yaml` **带完整注释**（由默认配置生成，保存只写差异）；本表是逐字段说明，未提到的字段用默认值即可。
>
> **保存只写差异**（v1.41 起）：`Config.save()` 只把「与默认值不同」的键写盘；老版本留下的「默认值全量快照」会在启动时自动压缩为差异（原文件备份为 `config.yaml.bak`）。因此插件升级后的**新默认值会自动对你生效**（此前快照里的旧值会永久覆盖新默认）。

### 基础

| 字段 | 说明 |
| --- | --- |
| `debug` | `true` 等价于**强制开启全链路 devLog**（工具入参/每轮 token/搜索词等）；真正的日志开关是 `agent.devLog.enable`（默认开；仅 `devLog.enable=false` 且 `debug` 未开时才静默）。Web 配置中心「基础设置」与锅巴都有开关，也可直接改 yaml |

### `agent` —— 对话与模型

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `trigger` | `at` | 触发模式：`at`(艾特) / `command`(触发词) / `both` |
| `triggerCommand` | `#ai` | `trigger` 为 command/both 时的触发词 |
| `providerId` | 空 | **★必填** 基础模型选用哪个厂商条目（见下方 ↴ `llmProviders`） |
| `modelId` | 空 | **★必填** 基础模型选用哪个模型条目（须挂在上述厂商下） |
| `llmProviders` | `[]` | 厂商清单 `[{ id, name, protocol, preset, baseURL, apiKey }]`；没有“默认厂商”，被 `providerId` 选中的那个就是主接入 |
| `llmModels` | `[]` | 模型清单 `[{ id, name, providerId, model, temperature, maxTokens, thinking, note }]`；`thinking/温度/maxTokens` 在被主对话链路使用时覆盖全局 |
| `protocol` / `preset` / `baseURL` / `apiKey` / `model` | 镜像 | 上面引用的**解析结果**，加载时自动回填；勿手改，改厂商 Key / 换模型会自动跟随 |
| `utilityModel` | 空 | 播报等旁路小模型（留空=沿用主模型）；可填任意已注册厂商的模型（运行时按注册表解析端点，不再局限主厂商） |
| `fallbackModels` | `[]` | 回退模型**唯一真源**（主模型失败时按顺序尝试）：`[{ model, baseURL, apiKey, protocol }]`，每条独立端点/协议，**可跨厂商**（如主 DeepSeek、回退 GPT）。旧版扁平字段 `fallbackModel`/`fallbackBaseURL`/`fallbackApiKey`/`fallbackProtocol` 已废弃：启动时自动把有效条目迁移进数组并删除扁平键；Web/锅巴面板都只编辑数组 |
| `reasoningFields` | `[]` | 推理字段归一化（如 `["reasoning_content"]`），preset 通常已带；**空数组=未配置**（不会向 provider 下发空数组） |
| `maxTurns` | `200` | 单次对话工具调用轮次预算（面板上限已放宽到 1000；旧版面板上限 100 会把默认值静默截断） |
| `temperature` | `0.2` | 采样温度 |
| `maxTokens` | 空 | 单次回复最大 token（留空=厂商默认；Anthropic 默认 4096） |
| `contextWindow` | 空 | 模型上下文窗口 token 数（如 `100000`）；配置后启用 token 高低水位压缩（超 `contextHighRatio` 压到 `contextLowRatio`、保留首条意图、`cacheEpoch` 分代），未配置按下面两个消息条数水位（默认 30→18）压缩。**这是提升多轮缓存命中率的头号开关**：窗口吃满后每轮几乎全量命中前缀缓存，见 [记忆体系与上下文缓存](memory-and-context.md) |
| `contextMsgHighWater` | `30` | **未配置 `contextWindow` 时**生效：会话历史达到该消息条数即触发压缩 |
| `contextMsgLowWater` | `18` | 消息条数水位下的压后目标：压缩后保留最近 N 条消息 |
| `contextHighRatio` | `0.65` | token 压缩高水位比例（占 `contextWindow`，0.3~0.95）。想进一步提高命中率可上调（如 `0.8`），代价是单次请求更长 |
| `contextLowRatio` | `0.45` | 压后目标比例（须小于高水位）。压得更深（如 `0.15`）能让「新增→再压」周期更长、命中率更高；压缩无损（原文归档，`context_recall` 可恢复） |
| `maxToolResultChars` | `8000` | 单条工具结果字符上限，超长截断防上下文膨胀 |
| `promptCacheKey` | `false` | OpenAI 官方 `prompt_cache_key` 稳定会话路由（多轮命中前缀缓存的命中率更高）。仅当当前 provider 声明支持该能力（OpenAI 官方 preset）时才下发，兼容网关/其它厂商一律不发 |
| `keepReasoning` | `false` | 是否把推理(`reasoning_content`)回灌历史；默认 `false` 省 context。thinking 模式下带工具调用的轮次按协议必需始终回传（不受此开关影响），否则上游会报 "reasoning_content must be passed back" |
| `stream` | `false` | 逐字流式输出（依赖适配器、不稳，默认关） |
| `progress` | `true` | 工具调用时推送节流进度消息（消除"干等"，默认开） |
| `progressRecall` | `3` | 进度消息多少秒后自动撤回（适配器不支持则忽略） |
| `reply.mode` | `image` | 回复渲染：`image`（markdown→浅色图片，默认）/ `text`（纯文本）。**QQ 官方机器人下自动走 Markdown 直发，本项被忽略** |
| `reply.atSender` | `true` | 群聊回复时艾特发言人（私聊不艾特） |
| `reply.quote` | `true` | 群聊回复时引用触发消息（私聊不引用）；人多时便于定位回复对象，可与 `atSender` 同开 |
| `reply.narrate` | `true` | 中途播报：模型调工具时附带的思路/进展文本自动转发给用户（参考 OpenClaw） |
| `reply.renderScale` | `3` | 回复图片渲染倍率（deviceScaleFactor，3=超清；越大越清晰但越耗内存/体积） |
| `qqOfficial.markdown.enable` | `true` | QQ 官方机器人下 Markdown 直发（不渲染图片）；平台拒绝自动降级纯文本。OneBot 不受影响 |
| `qqOfficial.markdown.maxChars` | `3500` | 单条 Markdown 上限（超出按行分片；官方约 4000） |
| `qqOfficial.markdown.templateId` | 空 | 官方后台申请的 Markdown 模板 ID（填了走模板消息） |
| `qqOfficial.keyboard.enable` | `true` | 注册 `send_keyboard` 工具（Markdown + inline keyboard，≤5×5，单轮 ≤3 张） |
| `qqOfficial.progress` | `false` | 官方协议下是否发「思考中…」等进度（默认关，官方主动推送有频控） |
| `qqOfficial.narrate` | `false` | 官方协议下是否中途播报（默认关） |
| `qqBot.enable` / `qqBot.appId` / `qqBot.appSecret` | `false` / 空 / 空 | **自实现 QQBot 适配器**：只需 AppID + AppSecret 直连官方网关（不需要机器人 QQ 号/Token）。与 Yunzai-QQBot-Plugin 二选一 |
| `qqBot.accounts` | `[]` | 多账号：`[{name,appId,appSecret,sandbox,intents,markdown}]`（与扁平字段二选一） |
| `qqBot.markdown` | `auto` | `auto`=先试 Markdown、无权限自动降级纯文本并记忆；`true`/`false` 强制 |
| `qqBot.preferMarkdownText` | `false` | 纯文本回复也走 Markdown 消息 |
| `qqBot.sandbox` | `false` | 连开放平台沙箱环境 |
| `qqBot.intents` | `0` | 事件订阅位图（0=默认只订群@+C2C=33554432；按钮交互=100663296，频道=1073741825。未开通的位会被 4013 拒绝，插件自动降级） |
| `qqBot.apiBase` / `qqBot.tokenUrl` | 空 | 覆盖 OpenAPI 基址/token 端点（默认 `api.bot.qq.com`，失败自动回退 `api.sgroup.qq.com` / `bots.qq.com`） |
| `thinking` | 空 | 思考模式（手动），provider 原生形状：`{ type: "enabled", budget_tokens: 16000 }`（`type` 可为 `enabled`/`disabled`，留空=不开启；`budget_tokens` 上限统一到 **128000**，各协议按同一 clamp）。锅巴面板用「开启深度思考 + 思考预算」两个控件读写同一字段 |
| `thinkingAuto` | 关 | 思考自动决策：`{ enable, classifier, model, timeoutMs, maxBudget, budgets:{low,medium,high}, style }`。判档方式 `classifier`：`auto`=规则不确定时用小模型判（省调用）/`always`=总是小模型/`off`=纯规则/`jev`=由 Jev 判档（需开启 Jev）；小模型带超时、缓存，失败自动回退规则，不阻塞对话。档位→厂商原生字段（MiMo/Kimi/GLM/豆包→`thinking`、DeepSeek→`thinking`+`reasoning_effort`、Qwen→`enable_thinking`+`thinking_budget`、MiniMax→`adaptive`、Anthropic→`budget_tokens`、o/GPT-5→`reasoning_effort`、Gemini→`thinking_level`）。模型级 `thinking` 显式覆盖仍优先。**能力自适应**：能力表没明确表态的（新）型号默认乐观启用思考——厂商若拒绝思考字段，请求层自动剥离重试一次并记忆（之后自动判为不支持，`[chat]` 日志随之转 off，无需重启）；明确判为不支持的模型（如 gpt-4o）启动时有 `[thinking]` 警告，可设 `agent.media.caps.thinking=true` 强制 |
| `memoryLimits` | 空 | 声明式记忆字符上限，如 `{ memory: 2200, user: 1375 }` |
| `systemPrompt` | 空 | 默认身份 system prompt（留空用富默认身份）。**优先级**：人设覆盖 > 进化产出的 agent 提示词 > 本项 > 内置默认（v1.26.30 修：此前注册表里预置的内置模板会被当成「进化产出」，导致本项写了也不生效） |
| `chatPermission` | `master` | `#ai` 命令权限：`master`/`admin`/`owner`/`all` |
| `privateChat` | `false` | 私聊是否触发对话；默认关（私聊不响应，仅群内 @/命令触发），设 `true` 开启 |
| `masters` | `[]` | 主人/审批通知 ID 列表：QQ 号，或 QQ 官方机器人 openid（`/uid` 的完整 `user_id` / 去前缀值，如 `807AC…`） |
| `masterSkipConfirm` | `false` | ⚠️高危：主人发起的确认类工具（如 `schedule_task`）免 `#确认` 直接执行（仅主人，控制台有日志不在聊天提示；denylist 仍硬拦）。注：terminal 已沙箱化、stagehand act 不单独审批，均不走此门 |
| `confirmTimeout` | `300` | 审批超时自动拒绝（秒） |
| `guardAction` | `flag` | 注入防御动作：`block`(拦截)/`flag`(隔离标注)/`sanitize`(脱敏) |
| `guardSensitivity` | `medium` | 防御灵敏度：`low`(0.95)/`medium`(0.7)/`high`(0.5) |
| `redactSecrets` | `true` | 外发文本统一脱敏（回复/中途播报/错误提示/续跑），屏蔽 API Key / token 等敏感信息；`false`=全部不脱敏（慎用） |

### `agent.policy` —— RBAC 策略

```yaml
policy:
  categoryMin:
    message: 1        # 覆盖内置类别最低角色
    mcp_write: 2      # 自定义类别（如 MCP 写工具需群管以上）
```

内置类别阶梯：`query:0` / `personal:0` / `message:1` / `group_manage:2` / `system:3`。角色：`member<admin<owner<master(99)`。

### `agent.media` —— 多模态 / 文件

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enable` | `true` | **多模态总开关**：`false` 时同时关闭附件收集/视觉子模型装配（`ctx.vision` 置空）、表情自动发现与工具看图；主对话按纯文本处理 |
| `active` | `true` | 主动收集（消息/引用/合并转发/群文件中的图片文件） |
| `passive` | `true` | 被动工具（`list_group_files`/`get_group_file`/`read_attachment`）；`false`=不注册这组工具（`read_attachment` 是全员可用的 `query` 类，介意权限面时关掉） |
| `maxImages` | `4` | 单次随消息发送最大图片数 |
| `maxFileBytes` | `8388608` | 单文件字节上限 |
| `degrade` | `note` | 非视觉模型降级：`skip`/`note`/`text` |
| `caps` | 空 | 覆盖模型能力判定（一般无需配置），如 `{ vision: true, file: true }` |

### `agent.vision` —— 视觉子模型

主模型不支持视觉时，由视觉子模型识图 → 文本描述 → 主模型回答。主模型支持视觉则直发原图、不走此路径。`vision.model` 留空时：主模型支持视觉 → 复用主模型；主模型纯文本 → 视觉子模型禁用（此时识图/看视频不可用，必须显式配置）。`vision.model` 若指向「模型列表」里已注册的模型，会自动复用该模型所属厂商的 `protocol/baseURL/apiKey`（避免把 MIMO 模型名发到 commandcode 主通道）；未注册或显式填写了下面任一连接字段时，才回退主通道配置。**受多模态总开关 `agent.media.enable` 约束**：`media.enable=false` 时视觉子模型不装配（表情自动发现/工具看图一并停用）。

**视频也走视觉子模型**（主模型没有视频原生块路径）：用户发送的视频、以及 `bilibili__analyze` 的「看视频」都会把视频字节交给它输出文本报告。看视频要求 **OpenAI 兼容协议 + 模型声明视频能力**（`media.caps.video`，`mimo` 系 omni 已内置；纯图像 VL 模型会明确跳过并回退字幕/转录），视频报告输出上限建议 ≥2048 tokens、思考型模型建议关思考。

```yaml
vision:
  enable: true
  model: "mimo-2.5"     # 视觉模型 ID：主模型支持视觉时可留空复用主模型；主模型纯文本时必须显式指定（否则视觉子模型禁用；看视频需支持 video_url）
  # 以下可选：覆盖为独立厂商
  protocol:             # 如 anthropic
  preset:
  baseURL: ""
  apiKey: ""            # 空则复用主 apiKey
  maxTokens: 1024          # 识图/视频报告输出上限；**显式配置优先于模型条目的 maxTokens**（未显式配置才用条目值）
  describePrompt: ""    # 自定义"描述这张图"指令
```

### `agent.perception` —— 情境感知

每轮对话开头注入的「情境」里，若会话历史很少（新会话、刚清空、久未发言），会额外补一小段近期群聊记录，避免模型对群内近况一无所知；历史已足够时改用常规注入，二者互斥不重复。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `sparseInject` | `true` | 稀薄上下文时补全群聊；`false` 关闭（仅保留常规情境注入） |
| `sparseThreshold` | `6` | 触发阈值：会话历史条数 **小于** 该值才补 |

```yaml
perception:
  sparseInject: true
  sparseThreshold: 6
```

### `agent.tempFiles` —— 临时文件自动清理

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enable` | `true` | 是否清理插件临时目录（`data/temp`） |
| `ttlHours` | `24` | 超过该时长的临时文件删除 |
| `maxFiles` | `500` | 目录内文件数上限（仍超限时从最旧的开始删） |

`data/temp` 会积累 PDF/Excel 转档、STT 音频、下载中转、渲染图、日志包等中间产物（此前只有 diagram 有专属清理，其余只增不减，磁盘占满后媒体/文档功能整族失败）。清理器只删普通文件、不跟随符号链接、不越出 `temp` 目录，目录本身保留；启动时扫一次，之后每 30 分钟扫一次（定时器 `unref`，不阻止进程退出）。

### `agent.tools` —— 工具 SDK

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `builtin` | `true` | 启用内置工具包（群信息/群管/米游社/Enka 展柜与配装） |
| `dir` | `tools` | 自定义工具包目录（相对插件根，自动加载） |

### `agent.miyoushe` —— 米游社

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `cookie` | 空 | 可选，提升搜索成功率/看全文；不填可匿名搜索 |
| `defaultGid` | `2` | 默认游戏 gid（2原神/6星铁/8绝区零/1崩坏三/4未定/3崩坏学院2） |

### Enka 角色展柜（无需配置）

内置 `enka_genshin` / `enka_hsr` / `enka_zzz` 三个展柜工具，以及 `enka_build` 配装分析工具：按 UID 查询原神、崩坏：星穹铁道、绝区零玩家**公开在游戏展柜里**的角色，可进一步读取逐件圣遗物（遗器/驱动盘）的主副词条、武器（光锥/音擎）、命座（星魂/影画），供 LLM 诊断并给出优化建议。

- Enka.Network 是公开接口，**不需要 API Key**；插件自带 User-Agent 与按 `ttl` 的短缓存，不会枚举或批量抓取。
- UID 为 8~10 位数字（绝区零国服为 8 位，原神/星铁为 9~10 位）；玩家未开启展柜、UID 不存在或 Enka 维护时会返回可读提示。
- 仅能读取公开数据，不能查未展示角色、实时面板或账号隐私信息。
- `enka_build` 只提供当前配装快照与词条汇总，不替代伤害计算器；优化建议会结合角色定位、队伍与版本环境。

### `agent.persona` —— 人设

```yaml
persona:
  defaultId: ""   # 全局默认人设 id：未单独 #人设 切换的用户生效；留空=用 systemPrompt / 内置默认身份
  skipInjectionCheck: false   # ⚠️ 高危：跳过人设/人设资料落盘前的「越狱/提示注入」检测（默认关）
  styleExamples: []   # 沟通风格示例（结构化数组 { sceneType, speechAct, tone, familiarity, text }）；伪人链路的样本读取 humanize 块同名键，见 [项目亮点与能力地图](features.md) 中伪人模式相关说明
personaLore:        # 人设资料库（agent.personaLore；世界观/口癖等长尾资料 + 补充完善）
  dir: ""           # 资料库目录（留空=data/persona-lore）
  adoptionsDir: ""  # 采纳队列目录（留空=data/persona-adoptions）
```

> 人设库目录固定为插件内 `data/personas`；上面 `personaLore.dir` 是**人设资料**（长尾知识/补齐草稿）的目录，与 persona 人设库不同层。

> Web 配置中心 / 锅巴的「默认人设」是下拉框，选项来自内置人设 + 自定义人设库；用户发 `#人设` 单独切换后以该用户绑定为准，`#重置人设` 会回到这里的全局默认。
>
> 自建人设正文（systemPrompt）上限 **20000 字**。默认会拒绝含「忽略安全 / 禁止拒答 / 绕过审批」等越狱/注入指令的角色卡（报错 `persona_injection`）；若确认是自建可信内容且被误判，可临时开启 `skipInjectionCheck` 保存后再关闭——已保存内容不会再次扫描。开启期间内容会原样进入 system 身份层，风险自负。

### `agent.search` —— 统一搜索 🧪早期

> 🧪 搜索为早期功能，效果取决于搜索源可用性。任填一个 key 即用该源；都不填回退 SearXNG，再兜底 DDG（始终可用）。

**防信息茧房的搜索纪律（内置于系统提示，无需配置）**：Agent 被告知"关键事实至少两个独立来源交叉验证、下结论前先找反证、争议话题并列双方依据、冲突不静默选一个"；`web_search` 支持一次并行发 2~4 个不同角度的 `queries`（换措辞/换来源/官方一手/找反证），结果按 URL 去重合并并标注来源与时间，部分查询失败会显式提示覆盖缺口；核对一手页面用 `web_extract` 读正文（摘要可能断章取义）。

```yaml
search:
  timeout: 0                 # 搜索源超时（毫秒）；0/未填=用各源默认。也可单源覆盖（tavily: { apiKey: "", timeout: 20000 }）
  tavily:    { apiKey: "" }
  exa:       { apiKey: "" }
  perplexity: { apiKey: "" }
  brave:     { apiKey: "" }
  searxng:   { url: "" }     # 如 http://localhost:8080
  ddg: true                  # 本地 DDG 兜底（默认开）
```

### `agent.diagram` —— 示意图生成（diagram_render）

> Agent 对话里说「画一下 XX 的流程图/架构图/时序图」即可生图。**不用文生图模型**——文字、连线、层级精确可靠：
> LLM 只提交语义结构（节点/连线/分组/时序消息），插件确定性编译为 D2，由**自托管 Kroki** 容器渲染 SVG，
> 经安全检查后用 resvg 转高清 PNG（默认宽 1600、2x 清晰度、内置中文字体）随回复发送。
>
> - **支持图类型**：flowchart / architecture（容器分组）/ sequence / state / class / er / mindmap
> - **主题**：paper-blue（默认）/ soft-pastel / technical / midnight（深色）/ sketch（手绘，仅 D2）
> - **安全边界**：LLM 不能提交 SVG/HTML/坐标/路径；默认禁用公共 Kroki（用户内容不出内网）；SVG 输出按不可信内容检查（拒脚本/外链/实体）；临时文件只写 `data/diagram/`（内容哈希命名 + TTL 清理）
> - **容错**：Kroki 不可用 → 连接超时/熔断/结构化失败（可配本地 `beautiful-mermaid` 回退），绝不挂死 Agent 或让用户无回复

**部署 Kroki 容器**（默认引擎依赖，一次性）：

```bash
# 推荐：一键脚本（缺 Docker 自动安装、镜像国内加速、健康检查）
sh plugins/agents-plugin/scripts/install-kroki.sh

# 或手动（已装 Docker）：
docker compose -f docs/deploy/kroki-compose.yaml up -d
# 然后保持 agent.diagram.kroki.endpoint: http://127.0.0.1:8000
```

> 脚本默认在缺少 Docker 时用发行版包管理器自动安装并启动（apt/dnf/yum/apk）；
> 非交互环境需显式 `-y` 或 `DOCKER_ASSUME_YES=1`，`DOCKER_AUTO_INSTALL=0` 可关闭自动安装只做检测。

```yaml
diagram:
  enable: true                       # 总开关（旧键名 enabled 仍兼容）
  renderer: kroki                    # 自托管 Kroki 渲染 D2
  fallbackRenderer: none             # Kroki 失败的本地回退：none | beautiful-mermaid
  defaultTheme: paper-blue           # paper-blue | soft-pastel | technical | midnight | sketch
  defaultFormat: png                 # png | svg（svg 以可编辑源文件发送）
  timeoutMs: 15000                   # 渲染总预算（编译+HTTP+栅格化）
  targetWidth: 1600                  # 输出宽度（px）
  maxNodes: 50                       # 规模上限（连线 2 倍；超出拒绝渲染并提示模型）
  tempTtlMinutes: 30                 # 临时图保留时长
  kroki:
    endpoint: "http://127.0.0.1:8000"
    allowPublicEndpoint: false       # ⚠️ true=允许 kroki.io 公共服务（图内容将发第三方，强制 HTTPS）
    connectTimeoutMs: 2000           # 连接/响应头超时
    requestTimeoutMs: 12000          # 单请求总超时（覆盖响应体读取全程）
    maxResponseBytes: 4194304        # SVG 响应上限（流式字节计数）
    maxConcurrency: 2
    circuitBreaker: { enabled: true, failureThreshold: 3, cooldownMs: 30000 }
    d2: { layout: elk }              # dagre | elk（sequence 固定 dagre）
    imageTag: ""                     # 部署镜像版本声明（进缓存 key；升级镜像后更新）
```

**使用示例**：

```text
你：用图画一下这个插件的工作流程
Bot：（流程图图片）用户消息 → Yunzai → Agent Loop → 工具调用 → 渲染回复
你：画个时序图看看工具调用过程
Bot：（时序图图片）用户/Agent/工具 三方消息序列
```

**常见排查**：

| 症状 | 原因与处理 |
| --- | --- |
| 回复「渲染服务不可用」 | Kroki 容器未启动/endpoint 配错：`docker compose -f docs/deploy/kroki-compose.yaml up -d`；或配置 `fallbackRenderer: beautiful-mermaid` 本地回退 |
| 连续失败每次都要等很久才回 | 熔断器生效中（连续 3 次失败短路 30s），检查容器 `docker logs agents-kroki` |
| 图太大被拒（output_too_large） | 减少 nodes/edges 数量，或调低 `targetWidth` |
| 中文显示为方框 | 理论不会发生（内置字体）；若手动删除了 `resources/fonts/`，恢复该文件或保留系统 Noto CJK |
| 中文流程图正常但主题色不对 | Kroki 镜像版本的 D2 主题编号差异：更新 `kroki.imageTag` 并调整 `model/diagram/themes.js` 后重启 |

### `agent.research` —— 深度研究 🧪早期

> 🧪 **深度研究处于早期开发，效果可能差或不可用**（见顶部「重要提示」）。受搜索源、模型能力、token 消耗影响大，仅作辅助。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `permission` | `master` | `master`（防 token 滥用）/ `all` |
| `maxRounds` | `3` | 外层 Supervisor 最大轮次 |
| `maxConcurrent` | `3` | 子代理并发上限 |
| `workerModel` | 空 | 子代理模型（空则用主模型；省钱可填便宜模型） |
| `evaluation` | `true` | 是否跑五维评估 |

### `agent.multiagent` —— 子代理编排

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enable` | `true` | 注册 `spawn_subagent` 三件套，主 Agent 自行决定是否委派子任务（独立上下文，只能调用 query 类工具） |
| `topology` | `spawn` | `spawn`=异步三件套（`spawn/check/extend_subagent`，可长轮询、快到预算可续期）/ `orchestrator`=同步 `orchestrate` 工具（分解→委派→综合） |
| `maxConcurrent` | `3` | 同时运行的子代理数上限（进程级 Semaphore） |
| `maxSpawnsPerConversation` | `5` | 单次对话最多创建几个子代理（按会话计数） |
| `workerMaxTurns` | `200` | 子代理工具循环上限 |
| `workerTimeBudgetMs` | `3600000` | 子代理时间预算（默认 60 分钟）：`spawn_subagent` 未显式传 `timeBudgetMs` 时用它；硬顶 2 小时，`extend_subagent` 单次最多再 +60 分钟 |
| `workerMaxTokens` | `16384` | 子代理单轮最大输出 tokens（防长报告被 `max_tokens` 拦腰截断） |
| `resultCap` | `48000` | 结果回传上限（字符）：`check_subagent`/编排结果给主代理的完整度（防长报告被腰斩；默认远超全局 `maxToolResultChars`） |
| `reserveTokens` | `32000` | `orchestrate` 启动前向根任务预留的 token 额度；不足则拒绝启动 |
| `workerModel` | 空 | 子代理模型（空=主模型；可跨厂商，填便宜模型降本） |
| `defaultTools` | `[web_search, memory_search]` | 子代理默认可用工具（模型未指定时；仅 query 类安全工具） |

> 子代理的默认值（v1.30.0 起）：**轮数 200、时间 60 分钟、单轮输出 16384、结果回传 48000 字符**；任务结束后的结果保留 60 分钟（期间随时 `check_subagent` 取回）。根任务整体预算（`agent.loop.timeBudgetMs` 默认 **60 分钟**，已与 `multiagent.workerTimeBudgetMs` 对齐；`agent.loop.tokenBudget` 默认 480000）在「推理参数」调整——想让根任务等满一个满预算子代理，根预算不要低于子代理预算。
>
> **取消语义**（v1.30.1 修）：只有真正的取消（`#取消任务`/主动停止、`#agent重载`/退出）才会连带取消在跑子代理；**根任务时间预算到点只是本轮进收尾，不牵连子代理**——子代理按自身预算继续跑完，结果经后台回推（此前会被误杀成「已中止：未知原因」）。非正常结束的子代理一律带可读原因（超时=时间预算耗尽、中止=父任务取消/运行时关闭）。

### `agent.mcp` —— MCP 服务端

```yaml
mcp:
  requestTimeout: 60000
  servers:
    fs:                           # stdio 子进程示例
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-filesystem", "./"]
      prefix: "fs"
      category: "query"           # 字符串：该服务端所有工具同类；或按工具映射 { read_file: "query", write_file: "system", default: "query" }
    remote:                       # HTTP 远程示例
      transport: "http"
      url: "https://example.com/mcp"
      headers: { Authorization: "Bearer ..." }
      listen: false
      prefix: "rmt"
      enabled: true
```

> **⚠️ Docker / 精简镜像没有 `npx`？—— MCP 握手超时（ENOENT）**
>
> 部分 Yunzai Docker 镜像只装了 `node`、**没有 `npm`/`npx`/`corepack`**（某些 `trss`/`miao` 镜像即如此）。此时上面 `command: "npx"` 会启动失败：
> ```
> [mcp] xxx 连接失败：传输关闭（进程退出码-2；spawn 失败：ENOENT spawn npx（npx 不在 PATH？…））
> ```
> （旧版本这种情况只甩一句看不懂的 `request timeout: initialize`；现已**立即**报出 ENOENT + 退出码 + stderr 末尾，便于定位。）
>
> **判断**：`docker exec <容器> command -v npx` —— 输出为空就是容器里没装 npx。
>
> **解决方案（任选其一，推荐 ①）**：
>
> 1. **给容器补上 npm/npx（一次性脚本，推荐）**：仓库自带 [`scripts/bootstrap-npm-docker.sh`](../scripts/bootstrap-npm-docker.sh)，纯 `node + curl + tar` 实现、不依赖包管理器：
>    ```bash
>    docker cp plugins/agents-plugin/scripts/bootstrap-npm-docker.sh <容器>:/tmp/bs.sh
>    docker exec <容器> sh /tmp/bs.sh
>    # 装好后 npx 进入容器 PATH，上面 MCP 配置无需任何改动
>    ```
>    ⚠️ 脚本装在「运行中的容器」里，**容器一旦重建（重新 `docker run`）会丢失**，需重跑；想一劳永逸请把它加进镜像 entrypoint / Dockerfile。
> 2. **改用绝对路径**：若容器别处有 `npx`/`node`，把 `command` 换成绝对路径（如 `/usr/local/bin/npx`）。
> 3. **绕开 npx**：容器内 `npm i -g <mcp包>` 全局安装后，用 `command: "/usr/bin/node"` + `args: ["<全局模块入口 js 的绝对路径>"]` 直接跑；或改用 `transport: "http"` 连远程 MCP，本地无需任何进程。

### `agent.tts` —— 语音合成（GPT-SoVITS / IndexTTS 2.5 / 豆包 / MiniMax / MiMo）

把文字合成为语音发到聊天（Agent 工具 `tts_speak`）。五家服务商任选其一（`provider` 切换）：**GPT-SoVITS**（本机/自托管 api_v2，音色与语气由参考音频决定，无音色库、无情绪参数）、**IndexTTS 2.5**（本机/内网自托管，音色参考 + 情绪参考/向量）、**豆包**（火山引擎 Seed-TTS，语音指令 / 多情感标签）、**MiniMax**（speech-2.8/2.6/02，9 种情绪标签）、**MiMo**（小米 MiMo-V2.5-TTS，预置音色 + 自然语言风格指令）。**总开关默认关（opt-in）**：需在 Web 面板「语音合成」或配置里显式 `enable: true` 后，`tts_speak` 才会注册、自动语音才生效；**自动语音 `autoReply` 也默认关**（开总闸不会自动每条回复都出语音，需再显式打开）；云服务商仅在「总开关开 + 选中该服务商 + 密钥/音色齐全」时才会把讲稿发往对应平台。

```yaml
tts:
  enable: false            # 总开关（默认关，opt-in）；开启后 tts_speak 才注册、自动语音才生效
  provider: indextts       # sovits | indextts | doubao | minimax | mimo
  autoReply: false         # 开启后每条最终回复自动合成语音（文字/图片照常发，随后追加语音）；默认关，仅 enable=true 时有效
  replyMaxChars: 300       # 自动语音最大字符数（超长按句截断；0=不限）
  hdVoice: true            # 发送前高清化：响度标准化 + 存在感补偿（需宿主 ffmpeg，失败自动回退）
  judgeModel: ""           # 情绪判定模型（IndexTTS/豆包/MiniMax/MiMo 共用；留空=indextts.model→utilityModel→主模型）
  judgeTimeoutMs: 300000   # 情绪判定总预算（毫秒，默认 5 分钟）
  sovits:                  # GPT-SoVITS（api_v2，默认 9880）：音色=参考音频，无音色库/无情绪参数
    endpoint: "http://127.0.0.1:9880"  # api_v2 地址（不是 WebUI 的 9874）
    refAudioPath: ""       # 参考音频的【服务端本地绝对路径】，3~10 秒
    promptText: ""         # 参考音频逐字文本（与音频一致，否则音色会漂）
    promptLang: zh         # 参考音频语种：zh/en/ja/ko/yue
    textLang: zh           # 默认合成语种：zh/en/ja/ko/yue（GPT-SoVITS 不支持 AR/ES）
    textSplitMethod: cut5  # cut0~cut5；长文本由服务端切段
    filterNonChinese: false # 排障用：true 时只送汉字+数字+中文标点
    maxChars: 200          # 单次朗读上限（超出按句截断；本地卡约 0.3~0.4 秒/字）
    timeoutMs: 120000      # 单次合成超时（毫秒）
  indextts:
    endpoint: "http://127.0.0.1:7860"   # IndexTTS 服务地址（Web 面板「语音合成」可测试连接）
    lang: ZH
    voice: ""                # 默认音色参考名（在 Web 面板上传参考音频时命名；留空=最新上传）
    emotionMode: same        # same=沿用音色参考情绪 | audio=情绪参考音频 | vector=8 维情绪向量
    emotionRef: ""           # audio 模式默认情绪参考（可来自其他说话人）
    emotionWeight: 0.65      # audio 模式情绪影响强度 0~1
    autoEmotion: true        # vector 模式由 LLM 结合「文本 + 近期对话上下文」自动调节情绪
    tier: pro                # pro=整段一套情绪 | max=按需拆分逐段情绪 + ffmpeg 合并
    segmentGapMs: 300        # max 档段间静音
    model: ""                # 情绪判定用模型（模型条目 id/模型名；留空=utilityModel→主模型）
    judgeTimeoutMs: 300000   # 情绪判定单次调用总预算（毫秒，默认 5 分钟；超时中止请求并回退；快失败在预算内重试一次，慢超时不重试）
  doubao:                  # 豆包语音合成（火山引擎 Seed-TTS，HTTP Chunked 单向流式）
    apiKey: ""             # 火山引擎 API Key（新版控制台 → API Key 管理，按资源开通「语音合成」）
    resourceId: seed-tts-2.0  # seed-tts-2.0 | seed-tts-1.0 | seed-tts-1.0-concurr（决定可用音色与计费）
    speaker: ""            # 音色 ID（控制台音色库 voice_type，如 zh_female_vv_uranus_bigtts）
    model: ""              # ""=默认 | seed-tts-2.0-standard | seed-tts-2.0-expressive（语音指令建议 expressive）
    autoEmotion: true      # LLM 判定情绪：2.0 音色→context_texts 语音指令；1.0 音色→emotion 标签
    instruct: ""           # 固定语音指令（留空=LLM 判定生成，仅 2.0 音色）
    emotion: ""            # 固定情感标签（1.0 多情感音色；LLM 失败/关闭时回退）
    emotionScale: 0        # 0=按判定强度自动（1~5）；手动=固定 emotion_scale
    speechRate: 0          # 语速 -50~100（100=2 倍速）
    loudnessRate: 0        # 音量 -50~100（100=2 倍音量）
    sampleRate: 24000
    format: wav            # wav | mp3（max 档分段拼接固定 wav）
    useTagParser: false    # 声音复刻 2.0 表现力增强版 Cot 标签解析
    tier: pro              # pro=整段一次 | max=LLM 分段逐段情绪 + ffmpeg 合并
    segmentGapMs: 300      # max 档段间静音（毫秒；0=不留空隙）
    maxSegmentChars: 140   # max 档单段字符上限（LLM 分段/标点回退，防拆得过碎）
  minimax:                 # MiniMax 语音（T2A V2）
    endpoint: "https://api.minimaxi.com/v1/t2a_v2"   # 国际站 https://api.minimax.io/v1/t2a_v2
    apiKey: ""             # MiniMax API Key（平台 → 接口密钥）
    groupId: ""            # 可选：旧版账号 URL 查询参数 GroupId
    model: speech-2.8-hd   # 2.6/2.8 支持全部 9 种情绪
    voiceId: ""            # 音色 ID（系统音色或复刻音色，如 male-qn-qingse）
    autoEmotion: true      # LLM 判定 → happy/sad/angry/fearful/disgusted/surprised/calm
    emotion: ""            # 固定情绪标签（回退用）
    speed: 1.0             # 0.5~2.0 | vol 音量 | pitch 音调 -12~12
    sampleRate: 32000
    format: wav            # wav | mp3 | flac（max 档固定 wav）
    languageBoost: ""      # 语种增强：留空=自动；Chinese/English/Japanese/Arabic/Spanish/auto
    tier: pro
    segmentGapMs: 300      # max 档段间静音（毫秒；0=不留空隙）
    maxSegmentChars: 140   # max 档单段字符上限（LLM 分段/标点回退）
  mimo:                    # 小米 MiMo TTS（MiMo-V2.5-TTS，OpenAI 兼容）
    endpoint: "https://api.xiaomimimo.com/v1"
    apiKey: ""             # MiMo 开放平台 API Key
    model: mimo-v2.5-tts   # mimo-v2.5-tts（预置音色）| mimo-v2.5-tts-voicedesign（文字设计音色，style 必填）
    voice: mimo_default    # 预置音色：mimo_default/冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean
    autoEmotion: true      # LLM 判定 → 自然语言风格指令（复合情绪/语速/发声方式/导演式）+ 音频标签
    style: ""              # 固定风格/音色描述指令（留空=LLM 生成；voicedesign 必填；可写"用东北话说""用唱歌的方式"）
    tagMode: auto          # 音频标签：auto=句首 (风格) + 行内 [标签]（原文保真校验，改写即丢弃）| style=只加句首 | off=不用
    format: wav            # wav | mp3（max 档固定 wav）
    tier: pro
    segmentGapMs: 300      # max 档段间静音（毫秒；0=不留空隙）
    maxSegmentChars: 140   # max 档单段字符上限（LLM 分段/标点回退）
```

- 配置入口：Web 管理面板 → **语音合成**（服务卡片 → 弹窗配置：GPT-SoVITS 接口地址/参考音频路径/参考文本；IndexTTS 接口地址/音色参考与情绪参考上传+命名/情绪模式与 8 维滑块；云服务商接口地址/密钥/音色）。「测试连接」会真实合成 2 个字（官方探活方式；GPT-SoVITS 首次加载模型可能稍慢）。
- **IndexTTS 无需 API Key**：官方本体（`127.0.0.1:7860/7862`）本身没有鉴权，插件直连接口地址即可，不发送任何鉴权头；若服务前另配了鉴权网关，请让网关放行本机请求。
- **GPT-SoVITS 接入要点**（[文档](https://github.com/RVC-Boss/GPT-SoVITS)）：填 api_v2 地址（默认 `http://127.0.0.1:9880`，不是 WebUI 的 9874）、**服务端本地**参考音频绝对路径（3~10 秒）与逐字参考文本；音色和语气完全由参考音频决定，没有情绪参数，也没有 `pro/max` 档位——长文本由服务端 `textSplitMethod` 切段后整段返回，插件不做 LLM 情绪判定、不做 ffmpeg 分段拼接。`textLang` 只支持 `zh/en/ja/ko/yue`（AR/ES 会回落到 `textLang`，服务端不支持）。参考音频与参考文本必须一致，否则音色会漂。
- **自动语音**（`autoReply`，**默认关**，需显式打开）：每条最终回复自动追加语音——文字/图片照常发送，语音内容是正文剥除 markdown/代码/链接/表格/emoji 后的文本（超长按句截断，`replyMaxChars`）；合成全过程有 `[tts] 合成开始/完成` 日志。`tts_speak` 工具保留给指定音色/情绪的点播（本轮已点播则不重复补发）。**讲稿清洗在合成入口统一执行**（点播同样生效），破折号（——）会转成停顿而不是被读成"减减"。
- **情绪判定（IndexTTS/豆包/MiniMax/MiMo 共用一条 LLM 链路）**：由一次旁路 LLM 调用结合文本与近期对话判定 8 维情绪（高兴/愤怒/悲伤/害怕/厌恶/忧郁/惊讶/平静），并可直接产出自然语言风格指令（`style`，支持复合情绪/语速/发声方式/导演式）与音频标签（`tag`/`tagged`）——IndexTTS 直接下发向量；豆包 1.0 → `emotion` 标签 + `emotion_scale`（由向量强度换算）；豆包 2.0 → 优先用 LLM `style` 作 `context_texts` 语音指令（无则回退向量模板）；MiniMax → 9 标签之一（忧郁→sad）；MiMo → LLM `style` 作 user 风格指令 + 按 `tagMode` 组合句首 `(风格)` 与行内 `[标签]`（保真校验）。GPT-SoVITS 没有情绪参数，不参与这条链路。`judgeModel` 可指定更快/更便宜的小模型，`judgeTimeoutMs` 控制单次判定总预算（默认 5 分钟，单次尝试最多用一半）——快失败（网络/限流等秒级返回）会在剩余预算内自动重试一次；打满单次预算的**慢超时不再重试**（慢模型重试必然再超时，避免白等第二个半预算）；判定失败只影响情绪、不影响出语音，日志会给出预算/尝试次数/耗时与"自动判定失败→回退默认"标注便于排查。
- **云服务商接入要点**：
  - **豆包**（[文档](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)）：HTTP Chunked 单向流式（NDJSON，base64 分片按序拼接，`code 20000000` 结束）；新版控制台只需 `X-Api-Key` + 资源版本；`resourceId` 决定可用音色（2.0 音色以 `_uranus_bigtts` 结尾）与计费；语音指令仅 2.0/复刻 2.0 支持（建议 `model: seed-tts-2.0-expressive`）。
  - **MiniMax**（[文档](https://platform.minimaxi.com/docs/api-reference/speech-t2a-http)）：`POST /v1/t2a_v2`（Bearer 鉴权；旧版账号可填 `groupId`），响应 `data.audio` 为 **hex** 编码；情绪仅 `speech-2.6/2.8` 全量支持（`fluent/whisper` 仅 2.6；2.8 不支持 whisper）。
  - **MiMo**（[文档](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)）：OpenAI 兼容 `chat/completions`，朗读文本必须放在 `assistant` 消息、风格指令放 `user` 消息，响应 `choices[0].message.audio.data`（base64）；情绪控制已按文档补全——LLM 判定后**直接生成自然语言风格指令**（支持复合情绪"压抑的愤怒/带着哽咽的笑意"、语速与发声方式、导演式角色/场景/指导、唱歌与方言点名），并按 `tagMode` 追加**音频标签**：句首 `(风格)` + 行内 `[笑]/[叹气]/[颤抖]/[语速加快]` 等（插入前后做原文保真校验，任何改写/增删一律丢弃该标签文本）；max 档逐段独立风格与标签；`voicedesign` 模型用「固定风格指令」描述音色（不走自动情绪与标签）。
  - 三家云服务的 API Key 保存在插件本机 `config/config.yaml`（与 LLM Key 同机制），面板/错误信息会回显配置本身但不会把密钥写入日志；讲稿仅在选中该服务商且配置齐全时才发送到对应平台。
- **高清语音**（`hdVoice`，默认开）：发送前经 ffmpeg 做响度标准化（-15 LUFS / 真峰 -2dB，两遍测量 linear 归一化）+ 存在感补偿（4kHz +自适应、6kHz 高架，先 EQ 后响度）+ 24kHz 对齐——TTS 输出普遍偏轻偏闷，这一步显著提升清晰度；失败自动回退原始音频（需宿主 ffmpeg）。
- 三种情绪模式：`same` 沿用音色参考的情绪；`audio` 另给一段情绪参考音频（`emotionWeight` 调影响强度）；`vector` 保留音色、用 8 维向量控制高兴/愤怒/悲伤/害怕/厌恶/忧郁/惊讶/平静，默认由 LLM 自动调节。
- 档位：`pro` 一次合成（快）；`max` LLM 按需拆分、逐段情绪分别合成后用 **ffmpeg** 拼接（更细腻、更耗时，宿主要装 ffmpeg）。GPT-SoVITS 没有档位，始终一次请求、由服务端切段。
- 何时用语音、各模式怎么选：见技能 [`skills/tts.md`](../skills/tts.md)（Agent 按需加载，不占常驻上下文）。

---
