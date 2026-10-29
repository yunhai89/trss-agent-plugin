# 配置内部自相矛盾 / 跨子系统开关 / README 承诺 发现（审计 D：logic-precedence）

审计对象：`config/default_config/config.yaml`（764 行全文）语义级审查 + `README.md`「⚙️ 详细配置」（245 行起）及其叙述承诺 + 为验证覆盖关系抽取的必要代码（apps/agent.js、apps/humanize.js、apps/groupworld.js、apps/comfyui-draw.js、apps/sticker-watch.js、model/humanize/**、model/groupworld/**、model/selfstate/**、model/agent/**、model/llm/**、model/tts/**、model/media/**、model/sticker/**）。
方法：不以「逐 key 找读点」为目的；每条均为**双侧证据 + 行号**，只在注释/文档与实现冲突或两个开关互相抵消时立项。只读审计，未改任何源码/配置。

## 结论摘要（5~10 条，按严重度）

1. [P1] `humanize.maxRepliesPer10Minutes` 有两个同名真源，顶层那个**永久失效**，生效的 `behaviorPolicy` 副本又绕过了 0~60 钳制——「频率硬上限」既可被配置成无效也能被配置成无界。
2. [P1] 功能模型的「留空回退链」有**三套不同实现**：humanize/GroupWorld/SelfState 只解析 provider、把配置原文当 model 下发（填「模型条目 id」会 400），且注释承诺的 `utilityModel→主模型` 在这些链路里根本没接。
3. [P1] GroupWorld `online` 与 SelfState `shadowMode` 的消费方**只有 humanize 的 Planner/Replyer**；默认 `humanize.enable=false` 时单独把 `online:true` / `shadowMode:false` 打开是纯静默空操作，yaml 未声明这条级联前提。
4. [P1] `agent.media.passive` 是**死配置**：README 明确承诺可用它关闭被动工具，代码只计算了 `passiveEnabled` 却无人消费，三个被动工具无条件注册（`read_attachment` 还是全员可用的 `query` 类）。
5. [P1] `kb.enable:false` / `kb.crawlEnable:false` 只关工具注册：`#知识库添加` 仍会入库、URL 仍会抓取/定时刷新；与 yaml 注释「关则不注册 kb_search、不入库」不符。
6. [P2] README 回退模型说明「同 provider」与 yaml/实现的「每条独立 baseURL/apiKey/protocol（可跨厂商）」直接矛盾，且详细配置表完全没有回退字段。
7. [P2] `comfyui.enable:false`（默认）时 `#画图/#画图列表/#反推` 仍注册并**吞掉消息**回「未启用」，与 yaml「关则不注册、零影响」不符；`command.enable:true` 作为关闭父开关的子项进一步误导。
8. [P2] 表情包有 4 个开关控同一件事（`sticker.enable` / `sendStickerTool` / `autoDiscover` / `humanize.reply.allowSticker`），默认组合 `enable=false + sendStickerTool=true + allowSticker=true` 语义自相矛盾；`autoDiscover` 的前置条件注释（写 `agent.vision.model`）漏了真正强制的 `agent.vision.enable`。
9. [P2] `toolDiscovery.enable` 与 `stableList` 同一小节的两段注释互相否定（「只常驻少数核心工具、其余搜索后注入」vs「每轮下发全量工具定义」），实际是 stableList 胜出（全量下发）。
10. [P2] 三个默认关闭的子系统（humanize / GroupWorld / SelfState）启动即无条件预装配并建 sqlite/跑 DDL；且 SelfState 的定时反思/维护群清单取自 `humanize.groups`（自身无 groups 键）、与 README「热加载无需重启」「关=整层 no-op」等承诺存在多处偏差（C10/C11/C12/C13/C14/C15/C16）。

## 明细

### C1 [P1] [D] `humanize.maxRepliesPer10Minutes` 双真源：顶层键永久失效，生效副本绕过钳制
- 证据 A：`config/default_config/config.yaml:584` `maxRepliesPer10Minutes: 4      # 10 分钟内最大回复数（频率硬上限）`；同一文件 `:639` 在 `behaviorPolicy:` 下又有 `maxRepliesPer10Minutes: 4`。
- 证据 B：`model/humanize/runtime-manager.js:99` `maxRepliesPer10Minutes: gcfg.behaviorPolicy?.maxRepliesPer10Minutes ?? gcfg.maxRepliesPer10Minutes ?? 4`；`model/humanize/turn-scheduler.js:229` `const maxRate = c.behaviorPolicy?.maxRepliesPer10Minutes ?? rt.maxRepliesPer10Minutes` —— 频率闸两处都优先取 `behaviorPolicy` 副本。而 `model/humanize/default-config.js:171` `c.behaviorPolicy = resolveBehaviorPolicy(c.behaviorPolicy)` 保证 `behaviorPolicy` 恒被默认值填满（`model/humanize/behavior-policy.js:14-18` 默认含 `maxRepliesPer10Minutes:4`），所以 `?? gcfg.maxRepliesPer10Minutes` 永不触达；顶层键只在 `default-config.js:119` 被 clamp(0,60)，`behaviorPolicy` 里的同名值**完全不做钳制/校验**（`behavior-policy.js:24-38` 仅做深合并）。
- 打架点：用户改 `agent.humanize.maxRepliesPer10Minutes`（yaml 称作「频率硬上限」的正是这个）零效果；要真正改只能改 `behaviorPolicy.maxRepliesPer10Minutes`，而那里填 0/负数/9999 都会被原样采用（`turn-scheduler.js:230` 仅 `maxRate > 0` 判非零 → 0 等于关闭上限）。两个默认值相同（4）掩盖了问题，只有用户动手配置时才暴露。
- 影响面：伪人模式频率管控；启用了伪人但按 yaml 位置调频的用户，实际频率不按预期变化（过频或完全不受限）。
- 建议：只保留 `behaviorPolicy.maxRepliesPer10Minutes` 一个真源，并把它纳入 `validateHumanizeConfig` 的 0~60 钳制；或删掉 `behaviorPolicy` 副本改为读顶层。
- 置信度：高

### C2 [P1] [P/O] 功能模型「留空回退链」三套实现：utilityModel 被跳过、模型条目 id 被当模型名下发
- 证据 A（正确写法，解析后取 `.model`）：`apps/agent.js:940` `const recallTarget = modelRouter.resolve(cfg.recall?.model || cfg.utilityModel || cfg.model)` 且调用处 `model: recallTarget.model || cfg.model`；`:955`（thinkingAuto）、`:992`（selfReview）同形。
- 证据 B（错位写法，只取 `.provider`）：`apps/humanize.js:101` `const providerForModel = (ref) => (rt.modelRouter?.resolve(ref)?.provider) || rt.provider`；下游 `model/humanize/planner.js:100` `const model = pcfg.model || c.model || null`、`model/humanize/replyer.js:131` `const model = rcfg.model || c.model || null`、`model/humanize/scene.js:302` `model: this.model || this._cfgFn()?.planner?.model || undefined`、`model/groupworld/analyzer.js:117` `const model = acfg.modelProfile || null`、`model/selfstate/service.js:61` `const model = cFn().eventDetection?.ambiguousIntentModelProfile || null`。
- 证据 C（承诺侧）：`config.yaml:616` `planner.model: "" # 留空=utilityModel→主模型`、`:667` `modelProfile: "" # 留空=主模型/utilityModel`、`:712` `ambiguousIntentModelProfile: "" # 留空=主模型`；而 `model/selfstate/default-config.js:25` 又写 `留空=utilityModel→主模型`（同一字段两处注释自相矛盾）。
- 打架点：① 留空时 `resolve('')` 返回 `{provider:主, model:null}`，planner/replyer 把 `null` 传给 provider（provider 回落到 `defaultModel`=主模型）→ 注释承诺的 `utilityModel` 永远不被读取；② 用户按注释填「模型条目 id（如 `mabc123`）」时，`resolve` 能据此选对厂商 provider，但真正下发的 model 字符串是 `mabc123` 本身而非 `entry.model` → 上游 `invalid model` 400：humanize Planner/Replyer/Scene、GroupWorld 分析、SelfState 歧义评价全部静默失效（humanize 表现为不回复，GW 片段进 dead_letter，SS 降级默认值）。
- 影响面：所有「跨厂商廉价小模型」配置路径中的 humanize/GroupWorld/SelfState 三条；按 yaml 注释填 id 的用户必踩。
- 建议：仿 `apps/agent.js:940` 抽一个 `resolveFeatureModel(ref, {utility:true})` 公共函数，供 humanize/GW/SS 使用（同时修正 SS/GW 的 provider 解析与 cron 路径），并统一「留空是否回退 utilityModel」的口径与注释。
- 置信度：高

### C3 [P1] [D/P] 社会记忆三层开关级联未声明：GW.online / SelfState 投影与摄入全部寄生 humanize（默认关 → 单开无效）
- 证据 A（配置承诺各自独立）：`config.yaml:652` `online: false # 在线影响 Planner/Replyer（默认关：先观察再上线）`；`:704-705` `selfState.enabled: false # 总开关（关=整层 no-op）` / `shadowMode: true # …false 才注入 Planner/Replyer`；却没有一处说明这些「Planner/Replyer」是**伪人模式**的 Planner/Replyer，且前提是 `humanize.enable=true` + `humanize.groups` 命中（`:571`、`:574` 默认 `false`/`[]`）。
- 证据 B（唯一消费方）：`apps/humanize.js:153-156` `gwLazy = getGroupWorld()…; gwPlannerCtx… gw.buildPlannerContext(ctx); gwReplyerCtx…`；`:182-183` `ssPlannerProj… ss.buildPlannerProjection(ctx); ssReplyerCap… ss.buildReplyerCapsule(ctx)`。这些闭包只被注入伪人 Planner/Replyer；`model/groupworld/service.js:109/114` `if (!await this.init() || !this.cfg().online) return {empty:true…}`、`model/selfstate/projector.js:37/94` `if (cfg.enabled !== true || …) return NEUTRAL();` / `if (cfg.shadowMode === true …)`，没有第二个调用方。
- 证据 C（摄入也在 humanize 链路里）：`apps/humanize.js:613` 先 `if (cfg.enable !== true || !cfg.groups.includes(group_id)) return false`，SelfState 的事件感知 `ss.onMessage(...)` 在 `:669`（在 gate 之后）→ 即使 `selfState.enabled=true`，humanize 关着时 SelfState 一条消息也收不到；GW 摄入则另有 `apps/groupworld.js:147` 自己的 gate（enabled 即可），所以 GW 的「观察模式」能独立跑，但 `online` 注入不能。
- 打架点：三个子系统在 yaml 里表现为可独立开启的开关，实际生效链是 `humanize.enable && humanize.groups命中 && (GW.online / SS.enabled && !SS.shadowMode && humanize.shadow==false)`；只翻 `groupWorld.online` 或 `selfState.shadowMode` 是纯静默无效果（GW 仍会按 enabled 采集+烧分析调用，却不注入任何上下文）。
- 影响面：按「先观察再上线」流程配置 GW/SS 的用户，翻 `online`/`shadowMode` 后毫无变化且无日志提示；也会误判「在线注入没生效=画像质量差」。
- 建议：在 yaml/README 明确三层级联关系（或让 GW.online / SS 投影同时供主 Agent 使用）；启动日志打印「GW online=true 但 humanize 未开启 → 在线注入不会发生」类提示。
- 置信度：高

### C4 [P1] [N/X] `agent.media.passive` 死配置：README 承诺可关被动工具，实际无人消费
- 证据 A：`config/default_config/config.yaml:228` `passive: true`；`README.md:315` 表格行：`passive`｜`true`｜「被动工具（`list_group_files`/`get_group_file`/`read_attachment`）」（暗示可关）。
- 证据 B：`model/media/index.js:86` 仅 `passiveEnabled: config.passive !== false,` —— 全仓再无任何地方读取 `passiveEnabled`（对 `passiveEnabled`/`media.passive` 的引用只此一处）；三个被动工具在 `apps/agent.js:756` `.register(...makeMediaTools())` **无条件注册**（`makeMediaTools` 见 `model/media/tool.js:210-213` 固定返回三件套）。其中 `read_attachment` 是 `category: 'query'`（`model/media/tool.js:181-183`）——任意群成员可用。
- 打架点：把 `agent.media.passive` 设为 false 后工具照旧出现在模型中、照旧可被任意成员调用；用户以为收窄了权限面，实际没有任何变化。
- 影响面：想通过配置关掉被动取文件能力的部署（权限/成本敏感场景）；`media.enable=false` 也管不到这三个工具（它们不读 media 配置）。
- 建议：二选一——要么在 `apps/agent.js` 注册处按 `cfg.media?.passive !== false` 决定是否注册，要么从 yaml/README 删除该字段。
- 置信度：高

### C5 [P1] [L] 知识库/抓取总开关只关工具注册，命令入库与 URL 定时抓取照旧发生
- 证据 A：`config/default_config/config.yaml:159` `enable: true # 知识库总开关（关则不注册 kb_search、不入库）`；`:160` `crawlEnable: true # 网页抓取开关（web_crawl 工具 + URL 入库/刷新；关则不注册 web_crawl）`。
- 证据 B：`apps/agent.js:759` `if (cfg.kb?.enable !== false) tools.register(makeKbSearchTool(knowledge))`、`:761` `if (cfg.kb?.crawlEnable !== false) tools.register(webCrawlTool)` —— 这是这两个键的**全部**读取点（全仓 grep `crawlEnable` 仅 `:761`）。而 `#知识库添加` 无条件执行 `apps/agent.js:3330` `rt.knowledge.ingestUrl(text)` / `:3335` `rt.knowledge.ingest(...)`（未判 kb.enable）；`ingestUrl` 内部 `model/agent/knowledge.js:213` 直接 `crawlUrl(u)`（`model/crawl/index.js:560` 起，不读 crawlEnable）；KB URL 定时刷新还在 `apps/agent.js:677` `knowledge.attachScheduler(scheduler)` + `:1529` `restoreRefreshJobs(...)` 无条件挂载。
- 打架点：用户把 `kb.enable` / `kb.crawlEnable` 置 false（例如想彻底停止联网抓取/写库）后，`#知识库添加`、`#知识库刷新` 与既有 URL 定时刷新仍会抓网页并写 KV；只有 `kb_search`/`web_crawl` 两个工具消失。
- 影响面：数据外发/存储合规与成本预期；关闭开关被当作「断网/停止入库」语义使用的部署。
- 建议：在 `addKnowledge`/`refresh*`/`restoreRefreshJobs` 入口统一判 `kb.enable`（抓取入口再判 `crawlEnable`），或把 yaml 注释改成「仅控制工具注册」。
- 置信度：高

### C6 [P2] [X] README 回退模型「（同 provider）」与 yaml/实现「可跨厂商」矛盾
- 证据 A：`README.md:74` 表格行：「🔁 回退模型 ｜ 主模型失败自动依次尝试 `fallbackModels`（同 provider）｜ ✅ 稳定」（原文明确写「同 provider」）；README「详细配置」全表没有 `fallbackModels`/`fallbackModel*` 任何一行。
- 证据 B：`config/default_config/config.yaml:24-25` `# 回退模型：主模型失败时依次尝试。每条独立 baseURL/apiKey/protocol（可跨厂商）。`；`apps/agent.js:565-590` 对每条回退**各建一个 provider**（`createProvider({ protocol: fbp, … apiKey, baseURL })`），显然不要求同厂商。
- 打架点：README 把跨厂商回退说成同 provider 回退；按 README 理解不会去配 baseURL/protocol，实际不配就用默认 openai 端点直发——回退要么打错端点要么静默失败。另：`apps/agent.js:570` `if (!fb || !fb.model || !fb.apiKey) continue` 对缺 apiKey 的条目静默跳过（无启动告警），「依次尝试」的承诺对无鉴权网关不成立。
- 影响面：使用 GPT/Gemini 等第二厂商做回退的用户；README 是唯一文档入口（yaml 用户配置写出时注释会被剥掉，见 `README.md:249`「配置文件不含注释」）。
- 建议：修正 README 为「可跨厂商，每条独立 baseURL/apiKey/protocol」，把回退字段补进详细配置表；对缺 apiKey 被跳过的条目打 warn。
- 置信度：高

### C7 [P2] [D/X] `comfyui.enable:false` 默认下指令仍注册并吞消息回「未启用」，「零影响」不成立
- 证据 A：`config/default_config/config.yaml:275` `enable: false # ComfyUI 工具总开关（关则不注册 comfyui__* 工具，零影响）`；同一节 `:283` `enable: true # 关=不响应 #画图 指令（交给其它插件/LLM）`（父开关关着，子开关却开着）。
- 证据 B：`apps/comfyui-draw.js:44-48` 三条正则 `^#画图列表$` / `^#画图(\s|\d|$)` / `^#反推(\s|$)` 在构造器里**无条件注册**；`:58-60` `if (!c.enable) { await this.reply('ComfyUI 未启用（config agent.comfyui.enable=false）'); return 'handled' }`；调用处 `:185-187` `if (gate === 'handled') return true` → 消息被本插件消费，其它插件收不到。工具侧确实按 `tools/comfyui/index.js:379-383` `factory: () => { if (!cfg().enable) return [] }` 关闭。
- 打架点：`comfyui.enable=false` 的默认配置下，用户/其它画图插件发 `#画图` 会收到「ComfyUI 未启用」而不是交给别人处理——配置承诺的「零影响」只在工具注册层面成立；`command.enable:true` 又暗示指令可用。
- 影响面：默认配置的所有用户（装了别的画图插件时指令冲突）；按 yaml 关 comfyui 期待静默的用户。
- 建议：`_gate` 首判 `!c.enable` 时返回 `'skip'` 而不是回复并 `handled`；或在 `enable=false` 时干脆不注册这三条 rule；yaml 的 `command.enable` 注释改为「仅在 comfyui.enable=true 时有效」。
- 置信度：高

### C8 [P2] [D/X] 表情包 4 个开关控同一效果，默认组合自相矛盾，前置条件注释不准
- 证据 A：`config/default_config/config.yaml:317` `enable: false # 表情包总开关（未开 → 不注入清单、不解析，零影响）`；`:329` `sendStickerTool: true # 注册 send_sticker 工具…`；`:325` `autoDiscover: false # 自动发现总开关（需 sticker.enable + agent.vision.model）`；`agent.humanize.reply.allowSticker: true`（`:631`）。
- 证据 B：`apps/agent.js:905` `if (cfg.sticker?.enable && cfg.sticker?.sendStickerTool !== false)`（send_sticker 工具以 enable 为前置）；`apps/humanize.js:348` `getStickerCatalog: () => (cfgFn().reply?.allowSticker !== false && sticker?.enabled?.() ? …)`；`model/sticker/manager.js:85-89` `enabled()` 还要求索引条目>0（「三重门」）；`apps/sticker-watch.js:62` `if (cfg.enable !== true || cfg.autoDiscover !== true) return false`，`:109-113` 真正缺的是 `rt.vision`（`agent.vision.enable` 门控，`apps/agent.js:1285`），提示文案自己写的是「需 agent.vision.enable=true 且 agent.vision.model…」。
- 打架点：默认配置呈现「总开关关、子开关 sendStickerTool=true、humanize.allowSticker=true」的矛盾组合；只改 `sendStickerTool`/`allowSticker` 不会有任何效果（都以 `sticker.enable` 为前置）；`autoDiscover` 注释把前置条件写成 `agent.vision.model`，实际还强制要 `agent.vision.enable=true`，而 `vision.model` 在「主模型支持视觉」时可不填（见 C13）。
- 影响面：所有想开/关表情包的用户；以为分开关可单独控制的人。
- 建议：子开关统一改为「父开关开启时才显示/生效」，yaml 注释标注「以下三项均以 sticker.enable=true 为前提」；修正 autoDiscover 前置条件为 `sticker.enable + agent.vision.enable +（主模型无视觉时）agent.vision.model`。
- 置信度：高

### C9 [P2] [D/X] `toolDiscovery.enable` 与 `stableList` 同节注释互相否定，实际全量下发
- 证据 A：`config/default_config/config.yaml:252` `enable: true # 工具按需发现（默认开）：LLM 只常驻少数核心工具，其余经 tool_search 检索后动态注入。关则回退全量常驻`；同一节 `:269` `stableList: true # …开=每轮下发全量工具定义（首轮多付约 1 万 token，之后全部命中）；false=旧的追加式增长`。
- 证据 B：`model/agent/Agent.js:1544` `if (this.stableToolList) return [...Object.values(this._metaTools), ...this.tools.list()]` —— 默认 `stableToolList=true`（`:364` `config.toolDiscovery?.stableList !== false`）时**每轮都下发 registry 全量 + 元工具**；`tool_search`/`alwaysOn`/`topK` 只影响系统目录（`:1460` 起的 `toolCatalog`）与 `activeTools` 记录，不再影响 tools 数组。apps 侧两个值都原样传入：`apps/agent.js:1193-1199`。
- 打架点：同一个小节里，`enable` 的注释说「只常驻少数、其余检索后动态注入」，`stableList` 的注释说「每轮下发全量」——两者不可能同时成立；实现选后者，`toolDiscovery.enable` 的「按需」语义只剩工具目录/提示层，模型实际始终能看到全部 schema 并可绕过 tool_search 直接调用。
- 影响面：按「省首轮 token/限制可见工具」预期配置的用户；也影响对 1 万 token 首轮开销的预期（注释已在 stableList 处披露，但 enable 处未说明）。
- 建议：改写 `toolDiscovery.enable` 注释为「控制 tool_search 目录与 activeTools 记录；stableList=true 时 tools schema 仍全量下发」；或把两个开关合并为一个三态模式。
- 置信度：高

### C10 [P2] [L/N] 三个默认关闭的子系统仍无条件预装配/建库/跑 DDL（「关=整层 no-op」「默认全关」名不副实）
- 证据 A：`config/default_config/config.yaml:566` `# 默认全关 + shadow…`、`:571` `humanize.enable: false`、`:650` `groupWorld.enabled: false`、`:704` `selfState.enabled: false # 总开关（关=整层 no-op）`。
- 证据 B：`apps/humanize.js:517` 构造器结尾 `getHumanize().catch(() => {})` 无条件预热；`apps/groupworld.js:138` 构造器 `getGroupWorld().catch(() => {})`；`model/groupworld/service.js:50-64` `init()` **没有 enabled 判断**，直接 `Db.initDb({dir})` 并装配 analyzer/retriever 等全部组件；`model/selfstate/service.js:55-60` 也是先 `await Db.initDb({ dir: this.dataDir })` 再 `if (!cFn().enabled) return false`；humanize 预热还会连带 `apps/humanize.js:153` `gwLazy = getGroupWorld()` 与 ssLazy 的 SelfStateService。`apps/humanize.js:534-537` 每小时 cron 先 `await getHumanize()` 再判 `cfg.enable`。
- 打架点：默认配置下即会在 `data/groupworld/gw.db`、`data/humanize/memory.db` 建库并跑全部迁移 DDL，SelfState「关=整层 no-op」只在**装配后行为层**成立，初始化副作用仍然发生；humanize/groupworld 未启用时仍每群消息进入 catch-all（`apps/humanize.js:610-613` 先 `getHumanize()` 才判 enable）。
- 影响面：默认部署的磁盘/启动开销与「零影响」预期；弱设备、无 sqlite3 环境的告警噪音。
- 建议：`GroupWorldService.init()` 与 prewarm 处先判 `enabled`；humanize 构造器在 `enable=false && groups空` 时延迟装配；把 SelfState 的 `initDb` 推迟到真正 enabled 后。
- 置信度：高

### C11 [P2] [X/L] SelfState 定时反思/维护的群清单取自 `humanize.groups`，SelfState 自身没有 groups 键
- 证据 A：`config/default_config/config.yaml:703-705` selfState 只有 `enabled/shadowMode`，无 `groups`；群白名单只存在于 `:651` `groupWorld.groups` 与 `:574` `humanize.groups`。
- 证据 B：`apps/humanize.js:586` `for (const gid of (Config.get().agent?.humanize?.groups || []).map(String)) await ss.runReflection(gid)`；`:599` `…humanize?.groups || [] … ss.runMaintenance(gid)`。且这两个 cron 内部各自 `new SelfStateService({ provider: (await getRuntime())?.provider || null, … })`（`:581-584`、`:594-597`），既忽略 `ambiguousIntentModelProfile` 的 provider 解析（与 C2 同源），也与 humanize 装配的 ssLazy 实例不是同一个。
- 打架点：`selfState.enabled=true` 时，若用户只配了 `groupWorld.groups` 或没配 `humanize.groups`，每日反思/维护对任何群都不跑（cron 静默 no-op）；反过来，humanize 的群白名单成了 SelfState 的隐式配置真源，yaml 里没有任何声明。
- 影响面：启用 SelfState 的部署（反思/衰减/超时恢复全部依赖这两个 cron）。
- 建议：给 `selfState` 加显式 `groups`（或明确文档化「复用 humanize.groups」），cron 复用同一 service 单例。
- 置信度：高

### C12 [P2] [X] README 宣传的长任务恢复命令在默认配置下不可用
- 证据 A：`README.md:724-725` 表格行：「`#任务列表` / `#任务状态 +id`｜长任务（token/时间预算中断后落盘）列表 / 状态」与「`#继续任务 +id` / `#恢复任务 +id`｜让中断的长任务接着跑 / 从落盘恢复」（无任何前置条件说明）。
- 证据 B：`config/default_config/config.yaml:109` `taskStore.enable: false # 默认关闭（开发阶段开关…）`；`apps/agent.js:622-623` `if (cfg.taskStore?.enable === true) { …taskStore = new TaskStore… }`，默认 `taskStore=null`；命令处理里 `apps/agent.js:3528/3539` 等 `if (!rt.taskStore) return this.e.reply('任务账本未启用（config agent.taskStore.enable=true）'), true`。
- 打架点：README 把「长任务中断后落盘/继续/恢复」当默认能力列出，实际默认配置下这些命令只会回「任务账本未启用」；需要用户自行改 yaml 打开（面板也未必暴露，见 guoba/web-center 审计）。
- 影响面：长任务功能的所有用户（默认体验）。
- 建议：README 标注「需 `agent.taskStore.enable: true`」；或把 taskStore 默认改为开启并把「开发阶段」注释去掉。
- 置信度：高

### C13 [P2] [X] README `vision.model`「必填才启用」与 yaml/实现「留空=复用支持视觉的主模型」矛盾
- 证据 A：`README.md:330` `model: "mimo-2.5"     # 视觉模型 ID（必填才启用；看视频需支持 video_url）`。
- 证据 B：`config/default_config/config.yaml:237` `model: "" # 视觉子模型（识图 + 看视频）：留空=主模型支持视觉时复用主模型；主模型纯文本时必须显式指定`；`apps/agent.js:1306-1315` 明确分支：`if (!vcfg.model && !vCaps.vision) { Log.warn('…视觉子模型已禁用…') } else if (!vCaps.vision) { warn } else { … if (!vcfg.model && cfg.model) Log.debug('vision.model 未配，复用支持视觉的主模型', vModel); vision = new VisionService({ provider: vProvider, model: vModel, … }) }` —— 未配 model 且主模型支持视觉时会用主模型组装 VisionService。
- 打架点：README 说「必填才启用」，yaml 与代码说「留空可复用主模型」（视频路径也确实走该服务）；按 README 理解会误以为不填 model 就没有视觉能力。
- 影响面：文档读者对 `vision.model` 的必填性判断。
- 建议：README 改为「主模型支持视觉时可留空复用；主模型纯文本时必填（否则视觉子模型禁用）」。
- 置信度：高

### C14 [P2] [N/X] README `agent.persona.dir` 是死字段；真实读取的 `agent.personaLore.dir` 未文档化且 yaml 无此段
- 证据 A：`README.md:391-393` `persona:\n  dir: ""   # 自定义人设目录（默认 data/agents-plugin/personas）`。
- 证据 B：`config/default_config/config.yaml:217-219` persona 下只有 `defaultId`/`skipInjectionCheck`，无 `dir`；`apps/agent.js:608-612` `const personaDir = Config.path.personas; … new PersonaStore({ dir: personaDir, … })`（人设目录写死，不读任何 `persona.dir`）；唯一被读的目录键是 `apps/agent.js:684` `path.resolve(PLUGIN_ROOT, cfg.personaLore?.dir || 'data/persona-lore')`（`agent.personaLore.dir`，yaml/README 均未提）。
- 打架点：README 指向的键无人读取；用户改它不会生效，真正能改的键不存在于默认配置与文档中（手写才有用）。
- 影响面：想迁移/自定义人设目录的部署。
- 建议：删除 README 的 `persona.dir` 行；若要支持自定义目录，在 yaml 增加 `agent.personaLore.dir` 并在 README 说明。
- 置信度：高

### C15 [P2] [L] `render.card` 只控 `#agents帮助`，yaml 注释承诺「帮助/列表/回复图」
- 证据 A：`config/default_config/config.yaml:116-117` `render: # 卡片图渲染（帮助/列表/回复图）`、`card: true # 帮助等卡片图开关；弱服务器可置 false 直接回文本，避免渲染卡死`。
- 证据 B：全仓仅 `apps/help.js:164-165` 读 `render.card !== false`（`#agents帮助`）；`#聊天列表` `apps/agent.js:2599` `const img = await screenshot('agents-plugin/chat-list', html)` 与 `#人设列表` `:3748` `screenshot('agents-plugin/persona-list', html)` 均无 `render.card` 判断；回复图由 `agent.reply.mode`(+`replyTimeoutMs`, `apps/agent.js:2422`/`apps/render.js:88`) 控制，也不看 `render.card`。
- 打架点：弱服务器按注释把 `render.card` 置 false 后，只有帮助图退化为文本，两个列表指令仍会走图片渲染（可能正是「渲染卡死」来源）；回复图与 render 段无直接关系，「回复图」注释不成立。
- 影响面：弱设备/无 puppeteer 环境；按注释做降级的用户。
- 建议：让 `#聊天列表`/`#人设列表` 同样尊重 `render.card`（失败/关闭时回退文本），注释改为如实描述。
- 置信度：高

### C16 [P2] [X/L] `groupWorld.analysis.schedule` 构造期读取、改后需重启，与 README「热加载无需重启」承诺冲突
- 证据 A：`README.md:207` `**支持热加载**：改完配置保存即可，**无需重启 Yunzai**…`（未列例外）。
- 证据 B：`apps/groupworld.js:127-132` `// analysis.schedule 接线（曾为死配置键，cron 硬编码）：构造期读取，改后需重启生效`、`const hourlyCron = (() => { const s = String(cfgNow().analysis?.schedule…); return …})( )`，随后 `this.task = [{ cron: hourlyCron, fnc: this.hourlyTask… }]`；`model/groupworld/default-config.js` 无热重载重建逻辑。
- 打架点：用户按 README 期望热改 `agent.groupWorld.analysis.schedule` 后即时生效，实际要重启 Yunzai；配置注释本身也没写这个例外。
- 影响面：调整 GW 分析频率的用户；排障时会误判「配置没生效」。
- 建议：把 cron 注册包进 `Config.onChange` 重排（或 `#agents重载` 时重建），并在 yaml 注释注明当前行为。
- 置信度：高

### C17 [P2] [D/L] `media.enable` 不是「多模态总开关」：只关主对话，视觉/表情发现/媒体工具照旧可用
- 证据 A：`README.md:311` 表格行：`enable`｜`true`｜「多模态总开关」。
- 证据 B：`apps/agent.js:2116-2121` `// media.enable=false：关闭多模态（不收集/不注入附件/不转视觉），纯文本处理`，`const mediaEnabled = cfg.media?.enable !== false; const media = mediaEnabled ? createMediaService({…}) : null` —— 只影响主对话这一处；`apps/agent.js:1285` 视觉子模型装配只判 `cfg.vision?.enable === true`，不看 `media.enable`；`apps/agent.js:1746` `ctx.vision = rt?.vision || null`（所有工具运行入口都能拿视觉）；`apps/sticker-watch.js:84` `const vision = rt.vision` + `:121` `manager.discover(…, { vision, … })`（表情包自动发现仍会把群图片送视觉模型）。
- 打架点：README 把 `media.enable` 描述为总开关（用户常用它来关掉多模态成本/外发面），实际关掉后表情包自动发现（若已开）与 `bilibili__analyze` 等工具的看图/看视频仍走视觉模型；只有主对话不再收附件。
- 影响面：为控成本/隐私关多模态的部署。
- 建议：把 `media.enable=false` 在 `vision` 装配与 `attachToolRuntime` 里一并生效，或改 README 为「主对话多模态开关」。
- 置信度：中

### C18 [P2] [D] TTS 默认组合「总开关关 + autoReply=true」，且总开关用 `=== true` 严格门
- 证据 A：`config/default_config/config.yaml:381-383` `enable: false # 总开关（默认关，opt-in）：开=注册 tts_speak 并允许自动语音；关=完全静默（不注册、不合成）`、`autoReply: true # 开启后每条最终回复自动合成语音`。
- 证据 B：`apps/agent.js:842` `if (cfg.tts?.enable === true) { … tts = new TtsService(…) }`（严格布尔，yaml 写 `enable: 1`/`"true"` 会静默不生效）；`:2540` `if (delivered && rt.tts && cfg.tts?.autoReply !== false && …)` —— `rt.tts` 存在才走，故默认 `autoReply:true` 被 `enable:false` 完全遮蔽，当前行为安全但默认配置呈现互相矛盾的开关组合（一个默认开、一个默认关且前者恒被后者否决）。
- 打架点：并非运行故障，而是默认配置语义不自洽 + 类型严格性陷阱；一旦用户开 `tts.enable` 而未意识到 `autoReply` 默认 true，会立刻每条最终回复都产生语音（成本/打扰），与「opt-in、完全静默」的直觉不符。
- 影响面：首次开启 TTS 的用户；用字符串/数字写布尔值的 yaml 手写用户。
- 建议：`tts.enable=false` 时把 `autoReply` 默认渲染为 false（或 yaml 里明确注释「仅在 enable=true 后生效」并统一 boolean 校验）。
- 置信度：高

### C19 [P2] [O] 默认时间预算自相矛盾：根任务 30 分钟 < 子代理 60 分钟
- 证据 A：`config/default_config/config.yaml:44` `timeBudgetMs: 1800000 # 单次对话工作时间预算（…30 分钟，给深度研究/子代理等待留量）`；`:551` `workerTimeBudgetMs: 3600000 # 子代理时间预算（毫秒，默认 60 分钟…）`。
- 证据 B：`README.md:513` `根任务整体预算（agent.loop.timeBudgetMs 默认 30 分钟…）…想等满一个长跑子代理，根预算要不低于子代理预算`；`apps/agent.js:513` 启动日志同口径打印两者。
- 打架点：README 自己说明「想等满一个长跑子代理，根预算要不低于子代理预算」，而默认配置恰好是 30 < 60——开箱状态下根任务会在子代理跑完前先进入收尾/交付，子代理只能靠后台回推结果（v1.30.1 起「根预算到点不牵连子代理」，故功能不坏，但与文档给的配置规则相反）。
- 影响面：使用 `spawn_subagent` 长任务的默认部署（预期管理/资源规划）。
- 建议：把默认 `loop.timeBudgetMs` 调到 ≥ 子代理（如 3600000），或在 yaml 注释中写明「默认 30min < 子代理 60min 是有意为之（根先收尾、子代理后台跑完回推）」。
- 置信度：高

---

### 复核备注（非发现条目，供 Lead 判重）
- 已排除的「疑似矛盾」：① `compaction.enable:true` + `contextWindow` 留空**并非死路径**——`model/agent/Agent.js:1619-1635`（消息数水位默认 30→18 见 `:285-286`） 无 contextWindow 时按消息数水位（30→18）触发 `compactMessages`，且 `archive` 在 count 模式下同样生效（`model/agent/compact/index.js:286/345`）；② `thinkingAuto` 覆盖手动 `thinking`、模型级 `thinking` 优先的声明与实现一致（`apps/agent.js:1131/1163-1167`、`model/agent/Agent.js:580/1878-1889`）；③ `humanize.enable=true && groups=[]` 与 `groupWorld.enabled=true && groups=[]` 的「不开启」硬约束确有代码强制（`model/humanize/default-config.js:152-155`、`model/groupworld/default-config.js:71-80`）；④ `selfState` 红线字段虽在 `validateSelfStateConfig` 被强制（`model/selfstate/default-config.js:125-129`），但这些字段本身无人消费、红线实际硬编码在 `projector.js/prompts.js`，属「配置无效但行为安全」，不单独立项。
- 与其它审计员可能重叠：回退模型「双真源/面板不可见」已由 guoba(C19)/web-center 覆盖，本文件 C6 只保留 **README 叙事与实现矛盾** 这一侧；`toolDiscovery.alwaysOn` 三源不一致见 guoba C1，本文件 C9 只记 **enable vs stableList 的语义互斥**。
