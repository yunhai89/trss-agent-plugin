# 锅巴面板（guoba.support.js）↔ config.yaml ↔ 运行时代码 发现

审计范围：`guoba.support.js`（426 行，143 个 schema field）、`config/default_config/config.yaml`（764 行，542 个叶子）、README.md 第 245 行起「详细配置」表，以及 `apps/agent.js` / `model/**` 中对应读点。只读审计，未改任何源码/配置。
统计口径：面板 field 143 个 = 140 个 yaml 叶子 + 3 个派生/虚拟字段（`agent.thinking.enable`、`agent.thinking.budget_tokens`、`agent.mcp.serversJson`，均在 `setConfigData` 特判处理）。面板覆盖率 **140/542 ≈ 25.8%**。

## 结论摘要（按严重度）

1. [P0] 默认「常驻工具集」三源打架：yaml 默认 12 个、代码 `DEFAULT_ALWAYS_ON` 13 个、面板说明第三个版本；默认运行时缺 `context_recall`/`schedule_task`/`kb_search`/`reminder_set`，却多出 3 个 subagent 工具（C1）。
2. [P0] Stagehand 权限面：面板写「仅框架主人可用」、yaml 默认 `permission: all`（全员）、代码按 `permission=all → category:'query'` 放行；面板还没有 `permission` 字段，启用即全员可用（C2）。
3. [P0] 沙箱 terminal 权限：yaml 注释称「仅 terminal 主人可用（验证码认领）」，代码/README/面板均明写「全员可用」，安全边界预期错位（C3）。
4. [P1] `debug` 是死配置：面板/yaml/README 三处都说开详细日志，代码里除 `#状态` 显示外无人读取（C4）。
5. [P1] 种子①`contextWindow` 面板说明三方不符：面板「超 80% 压缩、留空不压缩」，实际 65%→45% 双水位、留空按消息条数 30→18 压缩（C5）。
6. [P1] 种子②`renderScale` 默认错：面板「2=高清（默认）」，yaml/README/代码默认 3（C6）。
7. [P1] `crawl.execution` 选项枚举与 yaml/代码不匹配：面板写 `host`，yaml/代码用 `local`（C7）。
8. [P1] 代码兜底默认 ≠ yaml 默认：`maxTurns` 200/50/90、`maxToolResultChars` 8000/4000、`chatPermission` master/all——清空或缺失字段时静默改行为，权限项还会放宽（C8）。
9. [P1] 面板开启 `thinkingAuto` 会**永久删除**手动 `thinking` 配置（yaml 只说「覆盖」）（C9）。
10. [P1] 锅巴无法完成首次模型配置（无 `llmProviders`/`llmModels`/`apiKey`），`providerId/modelId` 写错只告警、运行时继续用旧镜像，面板显示与实际分叉（C10）。
11. [P1] 面板缺 20+ 个行为/安全总开关（`privateChat`、`isolation`、`kb.enable`、`download.enable`、`sandbox.network.*`、`stagehand.permission`…），部分 help 还指向面板里不存在的控件（C11~C13）。
12. [P2] 其余 9 条：MCP 文本框「可直接增删键」与「只合并不删除」实现自相矛盾（C15）、Jev 阈值缺 2 项（C16）、`dailyBudgetTokens` 0=不限（C17）、思考预算上限 64k/128k 不一致（C18）、回退模型双真源（C19）、`jev.apiKey` 死路径（C20）、视觉字段缺 6 项（C21）、面板覆盖仅 26%（C22）、sessionPersist 写死 12h（C23）。

## 明细

### C1 [P0] [O] `toolDiscovery.alwaysOn` 默认值三源不一致，默认常驻工具集与代码设计相反

- 证据 A：`config/default_config/config.yaml:254-266` —— 默认 `alwaysOn` 列表为 `tool_search, clarify, memory_search, web_search, skill, get_chat_history, diagram_render, spawn_subagent, check_subagent, extend_subagent, get_group_file, list_group_files`（12 个）。
- 证据 B：`model/agent/Agent.js:45-46` —— `DEFAULT_ALWAYS_ON = ['tool_search','clarify','memory_search','web_search','kb_search','skill','get_chat_history','reminder_set','schedule_task','context_recall','diagram_render','get_group_file','list_group_files']`（13 个），同行注释明确写「context_recall 常驻：压缩档案消息直接引用它恢复原文，不能等 tool_search；schedule_task 常驻：否则『每天/每周』类周期需求只能看到 reminder_set」。
- 证据 C：`model/agent/Agent.js:838` / `:1461` —— `td.alwaysOn?.length ? td.alwaysOn : DEFAULT_ALWAYS_ON`；`apps/agent.js:1196` 把 yaml 数组透传为 `alwaysOn`，因此**非空 yaml 列表永远压过代码内置默认**，代码精心维护的 `DEFAULT_ALWAYS_ON` 在默认配置下是死代码。面板说明是第三个版本：`guoba.support.js:164` 称默认含 `reminder_set / schedule_task / 群文件工具`。
- 打架点：yaml 默认缺 `context_recall/schedule_task/kb_search/reminder_set`，多出 3 个 subagent 工具；面板说明又按代码默认宣传。默认安装后 compressor 归档恢复、周期任务、知识库检索、提醒工具都不在常驻 tools 数组里，只能靠 `tool_search` 检索到（而代码注释说 context_recall 不能等检索）；反之 subagent 三件套默认常驻是 yaml 单方面决定、代码默认已不含。
- 影响面：所有未改 `alwaysOn` 的用户（默认即命中）；长对话压缩恢复、定时/周期任务、知识库、提醒功能的默认可达性。
- 建议：以代码 `DEFAULT_ALWAYS_ON` 为唯一真源——把 yaml 默认改成同一列表（或按 yaml 注释「留空用内置默认」把 yaml 默认置空），面板 help 同步；确认 subagent 三件套是否应常驻。
- 置信度：高

### C2 [P0] [X] Stagehand 权限面：面板说「仅框架主人」，yaml 默认 `all`（全员），且面板无 permission 字段

- 证据 A：`guoba.support.js:321` —— `agent.stagehand.enable` 的 `bottomHelpMessage`：「act/extract/observe 自然语言原语；**仅框架主人可用**，act 写动作需 #确认」。
- 证据 B：`config/default_config/config.yaml:502,507` —— 注释「`permission=all`：全部成员可用 goto/observe/extract」+ `permission: all # all（全部成员）| master（仅主人）`；`model/stagehand/index.js:44-45` —— `const category = String(cfg.permission || 'master').toLowerCase() === 'all' ? 'query' : 'system'`（query=全员 allow）。README:1054 也写明 `permission=all` 时全员可用。
- 证据 C：面板 schema 中**没有** `agent.stagehand.permission` 字段（`guoba.support.js:320-329` 只有 enable/mode/headless/executablePath/browserbaseApiKey/region/modelName/modelApiKey/idleTimeoutMs），用户无法从锅巴改回 master。
- 打架点：面板 help 与代码兜底默认（`|| 'master'`）一致，但与 yaml 默认 `all` 相反；yaml 默认生效后，用户在面板里「启用浏览器自动化」实际是把 goto/observe/extract 开放给**全部群成员**（云模式还按调用计费），与面板的安全承诺相反，且没有面板开关可纠正。
- 影响面：所有通过锅巴启用 Stagehand 的实例；群成员可驱动宿主浏览器访问任意（非内网）站点、消耗 Browserbase 配额/费用。
- 建议：面板补 `agent.stagehand.permission` Select（`master`/`all`，默认 `master`），并把 yaml 默认改为 `master`；若产品决定默认 all，则面板 help 必须改成「全部成员可用」。
- 置信度：高

### C3 [P0] [X] 沙箱 terminal 权限：yaml 注释「仅主人 + 验证码认领」vs 代码「全员可用」

- 证据 A：`config/default_config/config.yaml:468-472` —— 「`terminal` 工具的唯一执行面 / **仅 terminal 主人可用（验证码认领：#agents设置主人 → 控制台打印验证码 → 直接把码发到会话）**；沙箱化后不再有 #确认 审批与命令黑名单」。
- 证据 B：`model/terminal/exec.js:33` —— `category: 'query', // rank 0：所有用户 allow（工具内部不再有身份门槛）`；`apps/agent.js:800-802` 注册时日志写「全员可用」；`guoba.support.js:305` 面板 bottomHelp 也写「**全员可用**（按会话隔离沙箱…无需认领主人）」；README:130/940 同样明写全员可用。
- 打架点：yaml 默认配置是用户手改 yaml 时最常看的真源，它仍在宣传「仅主人 + 验证码认领」的旧权限模型；实际上只要 `sandbox.mode=e2b`，任何群成员都能执行 shell（出口默认全放通、按会话计费）。同一文件内还自相矛盾：既说「仅主人」，又说「不再有 #确认 审批」（审批对象正是主人）。
- 影响面：按 yaml 注释理解安全边界的运维者；开启 e2b 后陌生群成员可执行命令、外发数据、烧 E2B 配额。
- 建议：删除/改写 yaml 468-472 行为「terminal 全员可用（无身份门槛），成本由单会话命令数/并发/超时兜底；网络出口默认放通，可用 `sandbox.network.allowInternet:false` 断网」；若产品仍要主人门控，则在代码 `category` 改 `system` 并同步面板。
- 置信度：高

### C4 [P1] [N] `debug` 是死配置：面板/yaml/README 都承诺「开详细日志」，运行时不读

- 证据 A：`guoba.support.js:98` —— `{ field: 'debug', label: '调试日志', bottomHelpMessage: '打印工具入参/每轮 token/搜索词等，排查时开启', component: 'Switch' }`；`config/default_config/config.yaml:1` —— `debug: false`；`README.md:253` —— 「`true` 打开详细日志（工具入参/每轮 token/搜索词等），排查时开启」。
- 证据 B：全仓 `debug` 配置的读点只有 `apps/help.js:206-211`（`#状态` 里显示「调试日志：开/关」）。`utils/Log.js:14-30,43` 的日志级别完全委托框架 `Bot.makeLog(level, ...)`，插件从不按 `Config.get().debug` 调级别；真正的详细日志开关是 `agent.devLog.enable`（`utils/DevLog.js:28`），而面板没有该字段。
- 打架点：三个面向用户的真源都说打开它会得到详细日志，实际唯一效果是状态页文案变化；用户开着 `debug` 排查永远拿不到「工具入参/每轮 token/搜索词」。
- 影响面：所有按文档排障的用户；LOG 排查路径失效。
- 建议：把 `Config.get().debug` 接线到 Log 级别（或把它改名为 `devLog.enable` 的别名并驱动 DevLog），否则从 yaml/面板/README 一并删除。
- 置信度：高

### C5 [P1] [X/L] `contextWindow` 面板说明与实现三方不符（种子①）

- 证据 A：`guoba.support.js:129` —— `bottomHelpMessage: '如 32000；**超 80% 自动压缩历史保留首条意图；留空不压缩**'`。
- 证据 B：`config/default_config/config.yaml:95-100` —— 「配置后启用 token 高低水位压缩（**超 contextHighRatio 压到 contextLowRatio**、保留首条意图…），**未配置按消息条数水位（30→18）压缩**」，`contextHighRatio: 0.65`、`contextLowRatio: 0.45`；`model/agent/Agent.js:277-286`（`contextWindow` 在则 token 水位，否则 `contextMsgHighWater=30`、`contextMsgLowWater=18`）、`:291-295`（比例默认 0.65/0.45）、`:1611-1650`（`_highWater/_lowWater` 二选一）；README:271 与 1250 同 yaml；`apps/agent.js:1181-1183` 把 0.65/0.45 传下去。
- 打架点：面板三个说法全错——①水位不是 80% 而是 65%；②留空不是「不压缩」，而是改用消息条数水位 30→18（默认就压缩，且会重建前缀、掉缓存命中）；③面板把 `contextHighRatio/contextLowRatio` 单独放在下面，但用户若信面板「留空不压缩」，只调比例不填 `contextWindow` 时比例完全无效（`Agent.js:1625` `useToken=!!contextWindow`）。
- 影响面：上下文成本/缓存命中/长对话历史保留预期；按面板理解配置的所有用户。
- 建议：面板 help 改为「留空=按消息条数 30→18 压缩；填模型真实窗口后启用高低水位（默认 65%→45%，见下方两项）」；或让「留空不压缩」成真（代码支持显式关闭）。
- 置信度：高

### C6 [P1] [O/X] `renderScale` 默认值面板写错（种子②）

- 证据 A：`guoba.support.js:137` —— `bottomHelpMessage: 'deviceScaleFactor：**2=高清（默认）**，1=普通；越大越清晰但越耗内存'`，`min:1, max:4`。
- 证据 B：`config/default_config/config.yaml:130` —— `renderScale: 3 # 回复图片渲染倍率（deviceScaleFactor，3=超清默认；2=高清；1=普通…）`；`apps/agent.js:2423` —— `scale: cfg.reply?.renderScale ?? 3`；`apps/render.js:92-93` —— `_renderReplyImage = async (content, { scale = 3, … })` + `clamp [1,4]`；README:284 —— 默认 `3`、3=超清。
- 打架点：面板把非默认值 2 标成默认，且没有「3=超清」选项文案；用户信面板主动设 2，清晰度反而低于出厂默认。
- 影响面：所有在锅巴里调过/看过该项的用户；回复图观感。
- 建议：面板文案改成「3=超清（默认）/2=高清/1=普通」，与 yaml、README、web 配置中心口径统一。
- 置信度：高

### C7 [P1] [O] `kb.crawl.execution` 面板选项值 `host` 不在 yaml/代码词表里

- 证据 A：`guoba.support.js:273` —— Select 选项 `{ label: '宿主(推荐)', value: 'host' }, { label: '沙箱', value: 'sandbox' }`，help 写「host=宿主 venv（默认…）」。
- 证据 B：`config/default_config/config.yaml:164` —— `execution: local # local（默认）=宿主 venv crawl4ai…| sandbox=…`；`model/crawl/index.js:425-440` —— `resolveCrawlExecution` 只判 `=== 'sandbox'`，其余（含 `host`）一律按 `'local'`；README:828/837 也用 `local`。
- 打架点：yaml 默认值 `local` 不在面板 options 里（下拉回显会是未知值/空白）；用户选「宿主」写进配置的 `host` 是 yaml/README/代码都不认识的第三个词，当前恰好被 `!== 'sandbox'` 兜成 local，但这属隐患（任何后续 `=== 'local'` 的读点都会踩空）。
- 影响面：所有在面板改过抓取执行面的用户；配置字面值与文档不一致，排障时 grep yaml/README 找不到 `host`。
- 建议：面板选项 value 改 `local`（label 保留「宿主」），yaml/代码/面板统一 `local|sandbox`；或在 `resolveCrawlExecution` 显式兼容 `host` 并在 yaml 注释登记。
- 置信度：高

### C8 [P1] [O] 代码兜底默认 ≠ yaml 默认：清空/缺键时静默换一套值（含权限放宽）

- 证据 A：`config/default_config/config.yaml:39` `maxTurns: 200`；`:104` `maxToolResultChars: 8000`；`:209` `chatPermission: master`。
- 证据 B：`apps/agent.js:1159` `maxTurns: cfg.maxTurns ?? 50`；`model/agent/Agent.js:248` `this.maxTurns = config.maxTurns ?? 90`（同一字段三套默认 200/50/90）；`apps/agent.js:1185` `maxToolResultChars: cfg.maxToolResultChars ?? 4000`、`Agent.js:303` 也是 4000（yaml 8000）；`apps/agent.js:1969` `String(cfg?.chatPermission || 'all')`、`:1954` 日志同为 `|| 'all'`（yaml `master`）。
- 打架点：`Config.load` 的 deepMerge 平时能用 yaml 默认掩盖这些差异，但只要用户手改 yaml 置 `null`/空、面板清空字段、或旧配置缺键（自愈补全失败时），运行时回落到**代码自己的**默认：`maxTurns` 变小（200→50）、工具结果上限减半（8000→4000）、`chatPermission` 从「仅主人」放宽到「所有人」。同一字段在 `apps` 与 `Agent` 两层还有 50/90 两个默认，第三处再漂移。
- 影响面：清空过面板字段/手改 yaml 的用户；`chatPermission` 属安全降级（群里任何人都能用 `#ai`）。
- 建议：删除代码侧兜底默认，统一「yaml 默认 → deepMerge 后必存在」；`chatPermission` 兜底至少改成 `'master'`；`apps` 传给 `Agent` 时不要二次兜底（或与 Agent 一致）。
- 置信度：高

### C9 [P1] [D/P] 面板开 `thinkingAuto` 会永久删除手动 `thinking`；yaml 只说「覆盖」

- 证据 A：`config/default_config/config.yaml:52` —— 「thinkingAuto（opt-in）：…**开启后覆盖上面的手动 thinking**（模型级 thinking 覆盖仍优先）」；`guoba.support.js:186` help 同样写「开启后覆盖上面的手动 thinking」。
- 证据 B：`guoba.support.js:356-363` 把面板的 `thinking.enable/budget_tokens` 写回 `cfg.agent.thinking = enable ? {type:'enabled',budget_tokens} : null`；随后 `:414-415` —— `if (cfg.agent?.thinkingAuto?.enable === true) cfg.agent.thinking = null`，并把整包 `Config.save(cfg)` 落盘。
- 打架点：yaml/面板描述的是「运行时覆盖（override）」，实现却是「保存时**删除**人工配置」。用户先配手动 budget 16000，再勾「思考自动决策」→ 落盘的 `agent.thinking` 被清成 null；以后关掉自动决策，手动思考配置不会恢复，且无任何提示。
- 影响面：同时使用两套思考开关的用户；手工配好的 thinking 配置丢失。
- 建议：保存时不要写盘删除手动 thinking（仅运行时让 auto 优先）；或提供显式「清除手动 thinking」开关并在 help 说明会删配置。
- 置信度：高

### C10 [P1] [N/O] 锅巴无法完成首次模型配置；镜像引用写错时面板与运行时静默分叉

- 证据 A：`guoba.support.js:113-116` —— 注释自认「基础模型改为引用制：**锅巴无联动控件**，此处只手填厂商条目 id / 模型条目 id；厂商端点与模型条目请在 Web 配置中心维护」；面板只有 `providerId`/`modelId` 两个自由文本 `Input`，无 `llmProviders`/`llmModels`/`agent.apiKey` 字段（三者均在 yaml 中：`:17-23`）。
- 证据 B：`utils/Config.js:117-129` `resolveBaseModel` 在引用失效时返回 null，`:190-204` `warnDanglingBaseRef` 注释「**此时故意不清空镜像字段…否则面板显示『未选择』而运行时仍在用旧端点，属于静默分叉**」——只打一条 warn，不落盘、不阻断；运行时 `apps/agent.js:520` 直接 `const protocol = cfg.protocol || 'openai'` 使用旧镜像。
- 打架点：面板 help 写「空=未选厂商 / 空=未选模型」，让用户以为清空即停用；实际清空/填错后运行时继续用上一次解析出的 `protocol/preset/baseURL/apiKey/model`（`Config.js` 自己承认这是「静默分叉」）。同时只用锅巴的用户根本无法录入厂商/模型/Key，插件首次配置必须去 Web 中心或手改 yaml——与 README:209「安装 Guoba 后即可图形化编辑本插件配置」不符。
- 影响面：只用锅巴的部署者（首次配置走不通）；providerId/modelId 手填错误的用户（面板显示与实际端点不一致，排障方向被带偏）。
- 建议：面板补「厂商/模型」只读展示（当前解析结果 + 失效告警徽标）与选择器（或至少把 `llmProviders` 暴露为 JSON 文本域）；`providerId/modelId` 为空/失效时在面板层显式展示「仍在用旧端点」。
- 置信度：高

### C11 [P1] [N] 面板缺大量行为总开关，用户只能手改 yaml

- 证据 A：`guoba.support.js` 全表无下列关键字段（143 个 field 中不存在）：`agent.privateChat`、`agent.isolation.enable`、`agent.media.*`、`agent.reply.atSender`、`agent.reply.quote`、`agent.compaction.enable`、`agent.loop.*`（6 项）、`agent.devLog.enable`、`agent.schedule.taskEnabled`、`agent.taskStore.enable`、`agent.toolConcurrency.maxParallel`、`agent.toolSchemaValidate`、`agent.reflect`、`agent.finalizeMaxTokens`、`agent.rootTokenBudget`、`agent.memoryLimits`、`agent.policy.categoryMin`、`agent.reasoningFields`、`agent.tools.builtin/dir`、`agent.render.*`、`agent.cacheControl`、`agent.promptCacheKey`。
- 证据 B：这些在默认 yaml 里都有默认值且语义重要：`config.yaml:6`（`privateChat: false`，私聊默认不响应）、`:7-8`（`isolation.enable: true` 多用户隔离）、`:225-234`（`media.enable/active/passive/maxImages`）、`:127-128`（`reply.atSender/quote: true`）、`:101-102`（`compaction.enable`）、`:40-49`（`loop.*`）、`:220-222`（`devLog`）。代码确实读它们：`apps/agent.js:1947`（`cfg.privateChat !== true` 直接不响应私聊）、`:1940`（`cfg.media?.enable !== false` 参与触发判定）、`:2398,2400`（`reply.quote/atSender`）。
- 打架点：README:209 宣称「安装 Guoba 后 `#锅巴登录` 即可图形化编辑本插件配置」，但最常被问的「为什么私聊不回复」「怎么关多用户隔离」「怎么不艾特/不引用」在面板里找不到；用户只能去 yaml 手改，且改错了没有面板可回滚。
- 影响面：只用锅巴的用户；私聊/隔离/媒体/回复样式等高频行为项。
- 建议：优先补 `privateChat`、`isolation.enable`、`reply.atSender/quote`、`media.enable`、`devLog.enable`、`compaction.enable`、`schedule.taskEnabled`、`loop.*`；其余在 README 明确「仅 yaml/Web 中心可配」。
- 置信度：高

### C12 [P1] [N] 沙箱网络/审计配置面板全缺，而面板 help 明确让用户「按 allowOut 白名单收紧」

- 证据 A：`guoba.support.js:305` —— `agent.sandbox.mode` 的 bottomHelp：「沙箱化后…**网络出口默认放通（可按 allowOut 白名单收紧）**」。
- 证据 B：`guoba.support.js:300-317` 的 E2B 分组只有 mode/apiKey/apiUrl/domain/sandboxUrl/template/maxTimeout/maxSandboxes/idleMs/maxCommandsPerSession，**没有** `network.allowInternet`/`network.allowOut`/`network.denyOut`/`audit`/`defaultCwd`/`sandboxTtlMs`/`concurrencyWaitMs`/`requestTimeoutMs`/`retries`/`allowPublicTraffic`；这些全部存在于 `config.yaml:480-499`，且 `:489-497` 有大段安全注释（「要断网请用 allowInternet:false」「denyOut 不要写 0.0.0.0/0」）。
- 打架点：面板 help 指着一个面板里不存在的控件；从锅巴启用 E2B 的用户默认拿到「出口全放通、无审计日志」，想收紧必须去找 yaml 的深层 key，而 yaml 的告警注释在面板里完全看不到。
- 影响面：所有从面板开启沙箱的用户；沙箱出口与命令审计的安全默认。
- 建议：E2B 分组补 `allowInternet` Switch + `allowOut`/`denyOut` 文本域（每行一条）+ `audit` Switch；或把 help 改成「出口/审计需在 yaml 或 Web 中心配置」并给出 key 名。
- 置信度：高

### C13 [P1] [N] 面板能调抓取/下载细节，却没有对应总开关

- 证据 A：`guoba.support.js:271-287` 暴露了 `kb.crawl.*` 11 个字段（engine/execution/stealth/retryBlocked/allowPrivateHosts/sessionPersist/sessionTtlHours/sessionProfile/siteMemory/perHostIntervalMs/hostConcurrency），以及 `download.allowPrivateHosts`。
- 证据 B：`config.yaml:158-160` 的 `kb.enable: true`（知识库总开关：关则不注册 kb_search、不入库）、`kb.crawlEnable: true`（关则不注册 web_crawl）；`:181-185` 的 `crawlTimeout/chunkSize/chunkOverlap/topK/minScore`；`:532-541` 的 `download.enable/maxMB/sendLimitMB/maxTimeoutSec/bin/dir`。这些在面板 schema 里一个都没有。
- 打架点：控制面不完整——用户能在面板调「抓内网/会话持久化/并发」这些危险细节，却无法从面板关掉网页抓取或知识库；下载同理（只看得见 SSRF 开关，看不到功能总闸和大小/超时限额）。
- 影响面：想禁用 KB/抓取/下载的部署者；给子账号/群使用时误开抓取能力。
- 建议：在对应分组顶部补 `kb.enable`、`kb.crawlEnable`、`download.enable` 及关键限额（chunkSize/topK/minScore/crawlTimeout、maxMB/sendLimitMB/maxTimeoutSec）。
- 置信度：高

### C14 [P1] [L] `contextLowRatio` 面板允许 low ≥ high，代码静默夹紧、无任何提示

- 证据 A：`guoba.support.js:231-232` —— high 项 `min:0.3,max:0.95`、low 项 `min:0.05,max:0.9`，两者独立校验；low 的 help 只写「默认 0.45，**须小于高水位**」。
- 证据 B：`model/agent/Agent.js:291-295` —— `this.contextHighRatio = ratio(..., 0.65, 0.3, 0.95)`；`const lowCap = Math.max(0.05, this.contextHighRatio - 0.05)`；`this.contextLowRatio = Math.min(ratio(config.contextLowRatio, 0.45, 0.05, lowCap), lowCap)`。
- 打架点：面板能保存 high=0.3 / low=0.9 这种组合，运行时 low 被悄悄改成 0.25（high-0.05），配置里仍是 0.9——用户以为「压到 90%」实际「压到 25%」，压缩深度/缓存命中与预期相反，且日志/面板都不会提示被夹紧。
- 影响面：调过压缩水位比例的用户；长对话成本与缓存命中率。
- 建议：面板对 low 的 max 跟随 high（或保存时校验并报错）；代码夹紧时 `Log.warn` 一次「contextLowRatio 被夹到 high-0.05」。
- 置信度：高

### C15 [P2] [X] MCP 文本框「可直接增删键」与「只合并不删除」实现自相矛盾

- 证据 A：`guoba.support.js:293` `helpMessage`：「保存时自动合并：新服务加入、同名更新、其它已有服务一律保留…」；`:294` `bottomHelpMessage` 却说「框里默认显示你现有的全部服务，**可直接增删键**。删除某个服务用聊天指令 #停止mcp <名字>」。
- 证据 B：`guoba.support.js:367-391` 的合并实现——`const merged = { ...existing }`，遍历 incoming 时只做「新键 added++ / 同名 merged[k]=v」，**没有任何删除分支**；文本框里删掉的键不会被移除。
- 打架点：同一字段的两段说明互相矛盾（「可直接增删键」vs「删除用 #停止mcp」）；实现只支持「增/改」，用户在 textarea 删除服务后保存，配置里服务仍在，且面板会再次把它显示回来，误以为删除失败/又自动加回。
- 影响面：用面板维护 MCP 服务的用户；被误以为移除的服务仍会被加载、连出网。
- 建议：删掉「可直接增删键」，明确写「只增/改，不删；删除用 #停止mcp」；若要支持删除，实现差集删除并二次确认。
- 置信度：高

### C16 [P2] [N] Jev 两个通用置信阈值（lowConfidence/highConfidence）面板缺，代码却在用

- 证据 A：`config.yaml:84-90` —— `thresholds` 同时定义 `lowConfidence: 0.5`、`highConfidence: 0.9`、`thinkingMinConfidence`、`toolNoulFloor`、`terminalRiskFloor`、`reflectFloor` 六项。
- 证据 B：`guoba.support.js:214-217` 只暴露后四项，没有 `lowConfidence`/`highConfidence`；而代码确实消费：`model/agent/jev/decisions.js:35-36` 「lowConfidence 是通用低置信边界…与 thinkingMinConfidence **取更严者**」，`:133-135` `const floor = Math.max(th.terminalRiskFloor, th.highConfidence)` —— highConfidence 直接参与「破坏性命令是否放行」。
- 打架点：面板上 jev 阈值看起来「已可全调」，实际上决定思考回退与破坏性命令放行的两个下限被藏起来；用户在面板把 terminalRiskFloor 调低以为放宽了破坏性命令，仍可能被 highConfidence=0.9 卡住（或反之）。
- 影响面：调 Jev 门控的用户；破坏性 shell 命令放行门槛的可见性。
- 建议：面板补这两项（与其余四项同组同 op 规则），或在 help 明写「lowConfidence/highConfidence 只能 yaml 改」。
- 置信度：高

### C17 [P2] [F] `selfReview.dailyBudgetTokens` 的 0 = 不限（烧钱），面板却当「预算」呈现

- 证据 A：`guoba.support.js:175` —— `bottomHelpMessage: '自评审日预算上限，耗尽则只采迹不评审'`，`componentProps: { min: 0, step: 10000 }`（允许 0）。
- 证据 B：`model/evolution/review.js:103` —— `this.dailyBudgetTokens = Math.max(0, Number(dailyBudgetTokens) || 0)`；`:117` —— `return this.dailyBudgetTokens > 0 && this._usedTokens >= this.dailyBudgetTokens`（**0 时恒 false = 不设上限**）；`config.yaml:195` 注释也没有「0=不限」的说明。
- 打架点：默认 yaml 是 200000（有上限）；一旦用户在面板把该字段清空/填 0，语义翻转成「无限预算」，与「耗尽则只采迹不评审」的 help 直觉相反（用户以为 0=关闭自评审/不花钱）。
- 影响面：手动调低/清零自评审预算的用户；后台 LLM 成本失控。
- 建议：0 改为「禁用评审」并在 help 写明；或保持 0=不限但 help/yaml 明确写「0=不设上限（不建议）」。
- 置信度：高

### C18 [P2] [O] 手动思考预算（max 64000）与自动思考预算（max 128000）上限不一致

- 证据 A：`guoba.support.js:185` —— `agent.thinking.budget_tokens`：`min:1024,max:64000,step:1024`；同面板 `:190` `thinkingAuto.maxBudget` 与 `:193` `budgets.high` 都是 `max:128000`。
- 证据 B：两者最终走同一编码通道：`model/llm/thinking.js:89-95` `clampBudget(depth, budgets, maxBudget)`（`Math.min(b, cap)`）、`:127-143` `encodeThinking` → `{ thinking: { type:'enabled', budget_tokens: b } }`；yaml `:58-62` 的自动 budgets 默认 4096/8192/16384。
- 打架点：同一个 `budget_tokens` 语义，手动档被面板限制到 64000、自动档可到 128000；yaml/README/help 都没解释 64k 的来源（是否为 Anthropic 协议硬限制）。用户想手动给大预算时会被面板拒绝，而打开自动档又能下发 2 倍预算。
- 影响面：深度思考用户；Anthropic/兼容端点的大预算配置。
- 建议：统一上限（若 64k 是 Anthropic 硬限制，则自动档也应按协议夹紧并在 help 写清）；面板 help 注明差异来源。
- 置信度：中（128k/64k 的来源需 Lead 结合厂商协议复核）

### C19 [P2] [D/P] 回退模型双真源：`fallbackModels[]` 与面板扁平字段，面板设的排最后且无法编辑数组

- 证据 A：`config.yaml:24-36` —— `fallbackModels: []`（多回退数组，注释「多回退用数组（在此 yaml 配）」）与 `fallbackModel/fallbackBaseURL/fallbackApiKey/fallbackProtocol`（注释「锅巴面板单回退（扁平字段，方便表单填写）」）并存。
- 证据 B：面板只暴露扁平四项（`guoba.support.js:118-121`），没有数组编辑；`apps/agent.js:567-568` —— `const fbList = [...(cfg.fallbackModels||[])]`，随后 `if (cfg.fallbackModel && cfg.fallbackApiKey) fbList.push({...扁平...})`，即**数组先试、面板扁平回退追加在最后**（优先级最低）。
- 打架点：两套真源控制同一效果；面板/README 均未说明二者优先级，用户在面板填的「回退模型」若同时存在数组会排到最后；多回退只能手改 yaml；`fallbackProtocol` 面板只有 openai/anthropic。
- 影响面：配置多回退的用户；主模型失败时的实际回退顺序与预期不符。
- 建议：合并为单一真源（面板编辑数组，或 yaml 删掉扁平字段只保留数组）；在面板 help 写明「与 yaml fallbackModels 同时存在时，yaml 数组优先」。
- 置信度：高

### C20 [P2] [N] `agent.jev.apiKey` 掩码/跳过逻辑是无对应字段的死路径

- 证据 A：`guoba.support.js:341-342` 在 `getConfigData` 把 `data.agent.jev.apiKey` 替换为 `JEV_KEY_MASK`；`:394-400` 在保存时对 `agent.jev.apiKey`/整块 `agent.jev` 做「掩码=未修改」跳过，注释写「安全要求」。
- 证据 B：面板 schema 里**没有** `agent.jev.apiKey` 字段（`:200-217`）；`config.yaml:70-90` 的 jev 块也不含 `apiKey`/`baseURL`；只有 `apps/agent.js:1096-1097` 仍兼容读取 `prov?.apiKey || cfg.jev.apiKey`、`prov?.baseURL || cfg.jev.baseURL`（旧字段）。`model/web/redact.js:19-24` 才是该掩码约定的出处（Web 配置中心）。
- 打架点：锅巴里既没有可填 Jev Key 的控件，也没有可提交的 jev 对象，两段掩码特判永远不会被面板触发；仅手改 yaml 老字段的用户，其 key 在面板数据里被掩码但界面上看不到/改不了，属死代码 + 不可配置。
- 影响面：想用 Jev 但只用锅巴的用户（必须去 Web 中心建 `preset=jev` 厂商条目）；维护该掩码逻辑的人。
- 建议：要么在面板补 Jev Key（带掩码 + 跳过写回）字段，要么删掉 `guoba.support.js` 里的掩码特判，并在 yaml/README 明确「Jev Key 只在 Web 厂商条目配置」。
- 置信度：高

### C21 [P2] [N] 视觉子模型面板只暴露 3/9 字段，缺连接配置

- 证据 A：`guoba.support.js:244-247` —— 视觉分组只有 `vision.enable`、`vision.model`、`vision.apiKey`。
- 证据 B：`config.yaml:235-244` 的 vision 块还有 `protocol`、`preset`、`baseURL`、`maxTokens: 1024`、`describePrompt`（「下列连接字段留空即启用自动路由」）；`apps/agent.js:1320`（`resolveVisionBaseURL({ vcfg, … mainBaseURL: cfg.baseURL })`）、`:1329`（`vcfg.maxTokens || 1024`）、`:1343`（`describePrompt: vcfg.describePrompt`）实际读取这些字段。
- 打架点：面板给了 `apiKey` 却不给 `baseURL`——用户填了独立视觉服务的 Key 后，请求仍打到主 `baseURL`（`apps/agent.js:1330-1337` 的 `vBaseURL` 回退逻辑），典型表现「识图报 404/鉴权失败」。`maxTokens`（yaml 默认 1024，README 建议视频≥2048）与 `describePrompt` 也只能手改 yaml。
- 影响面：主模型非 OpenAI 兼容、或视觉模型走独立端点的用户；视频报告长度调优。
- 建议：补齐 `vision.protocol/preset/baseURL/maxTokens`，并让 baseURL 与 apiKey 相邻展示（或把 apiKey 字段的 help 改成「仅在复用主通道时有用」）。
- 置信度：高

### C22 [P2] [O/X] 面板覆盖缺口：140/542（≈26%）yaml 叶子，多个功能整块零覆盖，与「图形化编辑全部配置」不符

- 证据 A：脚本比对 `guoba.support.js` 的 143 个 field 与 `config.yaml` 的 542 个叶子：面板实际映射 140 个（另 3 个为派生字段），**402 个 yaml 叶子不在面板**。整块零覆盖（yaml 叶子数）：`tts` 80、`humanize` 56、`selfState` 40、`groupWorld` 36、`diagram` 28、`comfyui` 15、`sticker` 12、`multiagent` 11、`media` 8、`loop` 6、`stt` 5、`calc` 3、`miyoushe` 3、`evolution` 3、`skill` 2、`tools` 2、`devLog` 2、`schedule` 2、`taskStore` 2、`policy` 1、`document` 1（详见上文 C11~C13 的安全/行为项）。
- 证据 B：`README.md:209` —— 「安装 Guoba-Plugin 后，`#锅巴登录` 进入 Web 面板即可**图形化编辑本插件配置**」；README 的「详细配置」表（245 行起）逐项列出这些字段作为用户可配置项。
- 打架点：README 的口径是「面板=配置入口」，实际面板只覆盖约 1/4，且缺失的多数是功能开关（tts/stt/comfyui/sticker/diagram/media/multiagent/groupWorld/humanize）而不是安全镜像；用户会以为「面板里没有=插件没有这个功能」。
- 影响面：所有只用锅巴部署的用户；新手看不到大部分功能入口。
- 建议：README 改为「锅巴面板覆盖常用项；完整配置请用 Web 配置中心或 yaml」；面板按使用频率补分组（至少每块一个总开关 + 3~5 个关键参数）。
- 置信度：高

### C23 [P2] [X] `sessionPersist` 面板 help 写死「12h」，但有效期由相邻字段可调

- 证据 A：`guoba.support.js:277` —— `bottomHelpMessage: '…存到 data/crawl/sessions.json（0600），**12h 内复用**'`；`:278` 紧挨着 `agent.kb.crawl.sessionTtlHours`（`min:0.1,max:720`）。
- 证据 B：`config.yaml:171-173` —— `sessionPersist: true` 注释说「12h 内复用」，但 `sessionTtlHours: 12 # 会话有效期（小时）` 明确可配、且代码按该值判过期（yaml 注释「超期视为过期」）。
- 打架点：改了 `sessionTtlHours` 后，面板 help 仍宣称 12h，排查「会话凭证提前/延后过期」时被误导；同一分组两个字段，一个可调一个把可调值写死。
- 影响面：调过会话有效期的抓取排障用户。
- 建议：help 改成「按下方『会话有效期』复用（默认 12h）」。
- 置信度：高

## 附：已核实的「无问题」项与方法说明

- **镜像字段未被面板暴露**：`agent.protocol/preset/baseURL/apiKey/model` 均不在面板 schema 中（`guoba.support.js` 无这些 field）；`Config.save` 会先走 `normalizeBaseModel`（`utils/Config.js:241-244,290-295`）从 `providerId/modelId` 回填镜像，因此即使有旧值也不会被面板写坏。风险在引用写错时的静默分叉（见 C10），不在镜像可写性。
- **面板无脏键**：143 个 field 中 140 个精确对应 yaml 叶子，3 个派生字段（`agent.thinking.enable/budget_tokens`、`agent.mcp.serversJson`）都在 `getConfigData`/`setConfigData` 有专门的双向转换，不会把虚拟键写进配置。
- **数值边界截断检查**：逐一核对面板 InputNumber 的 `min/max/step` 与 yaml 默认值——所有**非空**默认值都落在范围内、且不被 `step` 截断（`maxTurns` 200≤1000、`thinkingAuto.timeoutMs` 2500/step500、`dailyBudgetTokens` 200000/step10000、`sandbox.idleMs` 300000/step10000、`stagehand.idleTimeoutMs` 300000/step60000、`profile.maxChars` 600/step50 等均整除）。历史 `maxTurns` 面板 max=100 截断默认 200 的问题已修复（面板 help 也注明了）。遗留风险是「面板边界比代码合法域窄」（如 `contextWindow` min 1000 而代码接受任意 >0、`confirmTimeout` min 10）——当前 yaml 默认不会触发，故不单列条目。
- **Select 枚举 vs 代码合法值**：逐项核对 `trigger/chatPermission/guardAction/guardSensitivity/reply.mode/thinkingAuto.classifier/toolDiscovery.method/research.permission/sandbox.mode/stagehand.mode/stagehand.region/kb.crawl.engine/fallbackProtocol/persona.defaultId`，默认值均在 options 内且与代码判断一致；唯一不匹配是 `kb.crawl.execution`（C7）。
- 方法：Node 脚本用 js-yaml 解析默认配置取 542 叶子，正则提取面板 143 field 做双向差集；再对每个面板字段用 `grep` 定位运行时代码读点与默认值/枚举判断。所有行号以当前工作树为准。
