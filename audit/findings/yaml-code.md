# 审计 A：config.yaml 默认值 ↔ 运行时读点 发现

审计对象：`config/default_config/config.yaml`（764 行，全部叶子 542 个）逐 key 建立「配置 key × 代码读点文件:行」矩阵，并对每个有读点的 key 回读 5~15 行上下文，核对默认值、注释承诺、`||/??/三元` 假值语义与硬编码。
范围：`apps/*.js`、`model/**`、`utils/*`（不含 Config.js）、`tools/**`、`index.js`；**不含** `web/assets/**`、`model/web/**`、`guoba.support.js`（其他审计员范围，仅作交叉证据引用）。
方法说明：配置始终经 `Config.js` deepMerge 默认值，因此「代码兜底默认与 yaml 不同」只在用户写 null / 清空 / 写假值时暴露；本文件把它们与「零读取」「假值吞掉」「注释承诺不成立」分开计。与 guoba / logic-precedence 已交付条目重叠处均已标注，供 Lead 合并去重。

## 结论摘要（按严重度）

1. [P1] `agent.proxy` 注释承诺 HTTP/SOCKS 双协议，实际只用 undici `ProxyAgent`（仅 http/https），`socks5://` 会抛错→**静默直连**。
2. [P1] TTS 情绪判定超时有两个键且各只覆盖一半服务商：`tts.judgeTimeoutMs` 对默认的 IndexTTS **完全无效**，yaml「统一生效」不成立。
3. [P1] `debug` 是**零读取死配置**（唯一读点是 `#agent状态` 展示文案），面板/README 承诺的「工具入参/每轮 token」不会出现（与 guoba C4 同源）。
4. [P1] `toolDiscovery.alwaysOn` 两套默认清单冲突：yaml 12 项永远压过代码 `DEFAULT_ALWAYS_ON` 13 项，代码注释声称「必须常驻」的 context_recall/schedule_task/reminder_set/kb_search 默认全不在常驻目录（与 guoba C1 同源）。
5. [P1] `humanize.maxRepliesPer10Minutes` 同名双键，顶层（yaml:584）**永久失效**，生效的是 behaviorPolicy 副本（与 logic-precedence C1 同源）。
6. [P1] `agent.media.passive` 死配置：代码只算出 `passiveEnabled` 无人消费，三个被动工具无条件注册（与 logic-precedence C4 同源）。
7. [P1] `kb.enable`「总开关/不入库」只接在工具注册处，`#知识库添加`/URL 入库/定时刷新照跑（与 logic-precedence C5 同源）。
8. [P2] 云端 TTS `segmentGapMs: 0` 被 `|| 300` 吞掉（yaml 明写「0=不留空隙」），而 IndexTTS 路径 0 生效——同一键两种语义。
9. [P2] `jev.model` 与 `jev.modelId` 同时配置时**注册模型赢**，与 yaml「手填优先，留空才用 modelId」相反。
10. [P2] 另有 10 条 P2：Jev 阈值双控取 max、crawl 执行面与注释相反、代码兜底默认双轨、yaml 缺失的隐藏配置键、redactSecrets 半接线、isolation=false 下提醒变群共享、resultCap 注释与硬编码不符、allowedReadTools 只按名字黑名单、vision.maxTokens 被模型列表覆盖、thinking 空标量无形状说明、sandbox.audit 退出码承诺只兑现一半。

## 明细

### C01 [P1] [X/L] `agent.proxy` 承诺 SOCKS，实际仅 HTTP(S) 且失败静默直连
- 证据 A：`config/default_config/config.yaml:37` `proxy: ""  # HTTP/SOCKS 代理（如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080）；……留空=直连`
- 证据 B：`apps/agent.js:459-469` `const { ProxyAgent } = await import('undici'); const dispatcher = new ProxyAgent(proxy); ... catch { Log.warn('代理不可用……将直连'); return null }`。undici `ProxyAgent` 构造时只接受 `http:`/`https:` URI，其它协议抛 `InvalidArgumentError`（不支持 socks）；且 `package.json` 未声明 `undici`（仅 cheerio 传递依赖，`pnpm-lock.yaml:2467` 归在 cheerio 依赖下）。
- 打架点：填 `socks5://127.0.0.1:1080` → `new ProxyAgent` 抛错 → 被 catch → `proxyFetch=null` → 全部请求**直连**，只有一行 warn。用户以为已走代理。
- 影响面：国内服务器经 SOCKS 访问 GPT/Gemini 的部署（注释推荐的正是这个场景）；模型连接失败会被误判为 key/端点问题。
- 建议：换支持 socks 的 dispatcher（`socks-proxy-agent` + 自定义 http agent），或把可选值限定为 http(s) 并在 socks 配置时显式报错；`undici` 提升为显式依赖。
- 置信度：高（SOCKS 不支持）；依赖未声明部分：中

### C02 [P1] [D/X] TTS 情绪判定超时：全局 `judgeTimeoutMs` 与 `indextts.judgeTimeoutMs` 各覆盖一半，注释「统一生效」不成立
- 证据 A：`config.yaml:410` `judgeTimeoutMs: 300000 # 情绪判定单次调用总预算（……）`（位于 `tts.indextts`）；`config.yaml:467` `judgeTimeoutMs: 300000 # 情绪判定总预算（毫秒，默认 5 分钟，统一生效）`（全局）
- 证据 B：`model/tts/service.js:353`、`:389`（IndexTTS 的 pro/max 两条路径）只用 `Number(ix.judgeTimeoutMs) || TTS_DEFAULTS.indextts.judgeTimeoutMs`，**不读全局**；`:482-483` `_judgeTimeoutMs()` 才是「全局 → indextts（历史）→ 默认」；`:562` 云端服务商（豆包/MiniMax/MiMo）走 `_judgeTimeoutMs()`。
- 打架点：改全局 `tts.judgeTimeoutMs` 对默认服务商 IndexTTS 无效；改 `indextts.judgeTimeoutMs` 对三家云服务商无效。两个键都只「半生效」，而 yaml 把全局键写成「统一生效」。
- 影响面：TTS 用户按 yaml 调超时防长时间挂起（IndexTTS 默认单次最多 5 分钟且 max 档逐段调用）。
- 建议：IndexTTS 两条路径统一改调 `_judgeTimeoutMs()`；或把 indextts 键标为 legacy 并从 yaml 删除。
- 置信度：高

### C03 [P1] [N/X] `debug` 零读取死配置（yaml 键存在、代码从不消费）
- 证据 A：`config.yaml:1` `debug: false`；`guoba.support.js:98` 面板字段「调试日志 · 打印工具入参/每轮 token/搜索词等」；`README.md:253`「`true` 打开详细日志」、`README.md:1180`「开启 `debug: true` 可看到 AI 每次调用工具的名称、入参……」。
- 证据 B：全仓 `Config.get().debug` 唯一读点是 `apps/help.js:206-211`（`#agent状态` 里显示「调试日志：开/关」）。`utils/Log.js:14-30` 完全按 level 转 `Bot.makeLog`，从不读该配置；真正决定详细日志的是 `agent.devLog.enable`（`utils/DevLog.js:111` `if (cfg().enable === false) return`）。
- 打架点：打开 `debug` 只改状态页一行文案，日志量/内容不变；用户按面板排查永远拿不到承诺的信息。
- 影响面：所有用户（尤其按「排查时开启」操作的人）。
- 建议：把 `Config.get().debug` 接到 Log 级别/DevLog 开关，或从 yaml+面板+README 一并删除并把文档改指 `devLog.enable`。
- 置信度：高
- 注：与 guoba C4 同源，本文件从「yaml 叶子零读取」矩阵独立复核确认。

### C04 [P1] [O] `toolDiscovery.alwaysOn` 两套默认清单互相冲突，yaml 默认压死代码内置默认
- 证据 A：`config.yaml:254-266` 默认 12 项：tool_search/clarify/memory_search/web_search/skill/get_chat_history/diagram_render/**spawn_subagent/check_subagent/extend_subagent**/get_group_file/list_group_files。
- 证据 B：`model/agent/Agent.js:46` `DEFAULT_ALWAYS_ON` 13 项：额外含 **kb_search/reminder_set/schedule_task/context_recall**、不含 spawn 三件套；同行注释明确「context_recall 常驻：压缩档案消息直接引用它恢复原文，不能等 tool_search；schedule_task 常驻：否则『每天/每周』只能看到 reminder_set」。`Agent.js:838`/`:1461` 均为 `td.alwaysOn?.length ? td.alwaysOn : DEFAULT_ALWAYS_ON`，而 `config.yaml:254` 默认非空 → **yaml 列表恒胜**，代码内置默认在默认部署下是死代码。
- 打架点：默认配置下常驻目录与代码注释声明的「必须常驻」相反：context_recall/schedule_task/reminder_set/kb_search 进不了 system 常驻目录（模型需先 tool_search 才知道有）；用户按 yaml「留空用内置默认」清空后，清单又换成另一套（多 4 项、少 3 项），行为突变。
- 影响面：长对话压缩后恢复原文、周期任务、知识库检索、提醒功能的默认可发现性。
- 建议：合并为单一真源（把代码注释声称必须常驻的 4 项并入 yaml，或删掉 yaml 硬清单让内置默认生效）；同步更新 guoba 面板默认说明。
- 置信度：高
- 注：与 guoba C1 同源（其把面板第三版清单也列入），本文件补充「yaml 12 项 vs 代码 13 项」精确差集。

### C05 [P1] [D/N] humanize 频率上限同名双键，顶层键永久失效
- 证据 A：`config.yaml:584` `maxRepliesPer10Minutes: 4 # 10 分钟内最大回复数（频率硬上限）`；同文件 `:639`（`behaviorPolicy` 下）又有 `maxRepliesPer10Minutes: 4`。
- 证据 B：`model/humanize/runtime-manager.js:99` `maxRepliesPer10Minutes: gcfg.behaviorPolicy?.maxRepliesPer10Minutes ?? gcfg.maxRepliesPer10Minutes ?? 4`；`model/humanize/turn-scheduler.js:229` `const maxRate = c.behaviorPolicy?.maxRepliesPer10Minutes ?? rt.maxRepliesPer10Minutes`。`model/humanize/default-config.js:171` 又把 behaviorPolicy 恒填默认（`behavior-policy.js:14-18` 含 4），故 `?? gcfg.maxRepliesPer10Minutes` 永不触达。
- 打架点：用户改顶层（yaml 所谓「频率硬上限」）零效果；只有 behaviorPolicy 副本生效，而副本不受 `validateHumanizeConfig` 的 0~60 钳制。
- 影响面：启用伪人模式后调频（防刷屏）的用户。
- 建议：只留一个真源并纳入 clamp。
- 置信度：高
- 注：与 logic-precedence C1 同源，此处仅保留矩阵复核结论。

### C06 [P1] [N] `agent.media.passive` 死配置（yaml 有、代码算了不用）
- 证据 A：`config.yaml:228` `passive: true`（同节 `active: true` 在 `model/media/index.js:50` 真正生效）。
- 证据 B：`model/media/index.js:85-86` 仅 `passiveEnabled: config.passive !== false,` —— 全仓（含 web，排除 node_modules）对 `passiveEnabled` 的引用只此一处；三个被动工具 `read_attachment`（`apps/agent.js:756` `makeMediaTools()` 无条件注册）、`list_group_files`/`get_group_file`（`:770` `groupFileTools` 无条件注册）只受 `tools.builtin` 控制。
- 打架点：`passive:false` 关不掉被动工具；与 `active`（有读点）不对称，用户以为两侧都能关。
- 影响面：想收窄被动取文件能力（权限/成本）的部署。
- 建议：注册处按 `cfg.media?.passive !== false` 决定是否注册，或删除该键。
- 置信度：高
- 注：与 logic-precedence C4 同源，独立复核确认「全仓唯一引用」。

### C07 [P1] [N/X] `kb.enable`「总开关/不入库」只接在工具注册处
- 证据 A：`config.yaml:159` `enable: true # 知识库总开关（关则不注册 kb_search、不入库）`
- 证据 B：`apps/agent.js:759` 只 gate `makeKbSearchTool` 注册；`apps/agent.js:666-669` `new KnowledgeStore(...)` 无条件创建；`:3330` `rt.knowledge.ingestUrl(text)` / `:3335` `rt.knowledge.ingest(...)`（`#知识库添加`）不判 `kb.enable`；URL 定时刷新 `:677` `knowledge.attachScheduler(scheduler)` + `:1529` `restoreRefreshJobs(...)` 也无条件。（Web 侧 `model/web/api.js:777/802` 同样无判断，属其他审计员范围。）
- 打架点：关闭总开关后仍能通过命令/定时任务抓网页并写入知识库；只有 `kb_search` 工具消失。yaml「不入库」不成立。
- 影响面：以「关知识库=停止抓取/停止落盘」为预期的部署（隐私/成本）。
- 建议：在 add/refresh/restore 入口统一判 `kb.enable`（抓取入口再判 `crawlEnable`），或把注释改成「仅控制工具注册」。
- 置信度：高
- 注：与 logic-precedence C5 同源，独立复核确认。

### C08 [P2] [F] 云端 TTS `segmentGapMs: 0` 被 `|| 300` 吞掉，与 yaml「0=不留空隙」冲突
- 证据 A：`config.yaml:431`（doubao）、`:450`（minimax）、`:463`（mimo）均写 `segmentGapMs: 300 # max 档段间静音（毫秒；0=不留空隙）`。
- 证据 B：`model/tts/service.js:631` 云端 max 档 `gapMs: Number(cfgProv.segmentGapMs) || 300`（0 → 300）；对照 IndexTTS 同功能 `:441` 直接传 `gapMs: ix.segmentGapMs`（0 保留）；`model/tts/audio.js:70` `if (Number(gapMs) > 0)` 证明 0 是合法语义（不加静音）。
- 打架点：同一配置项在三家云服务商上「0=不留空隙」失效，仍插 300ms 静音；IndexTTS 上生效。
- 影响面：max 档逐段合成、要求无缝连读的 TTS 用户。
- 建议：改成 `Number.isFinite(Number(x)) ? ... : 300`（保留 0）。
- 置信度：高

### C09 [P2] [P] `jev.model` 与 `jev.modelId` 同时配置时，注册模型优先，与 yaml 注释相反
- 证据 A：`config.yaml:74` `model: ""  # 手填模型 ID（留空=用 modelId 指向的注册模型；……）`（语义：填了就用手填值）
- 证据 B：`apps/agent.js:1094-1098` `const mdl = llmModels.find(m => m.id === cfg.jev.modelId); ... const model = mdl?.model || cfg.jev.model || ''` —— 注册条目模型先生效，手填 `jev.model` 被忽略。
- 打架点：用户想用 `jev.model` 临时覆盖/钉版本（如 `jev-1.13.0`），若 modelId 仍指向条目则不生效。
- 影响面：Jev 选型/版本回退场景（opt-in）。
- 建议：改为 `cfg.jev.model || mdl?.model`，或改 yaml 注释。
- 置信度：高

### C10 [P2] [D] Jev 置信度阈值双控：通用 low/high 与专用 thinkingMinConfidence/terminalRiskFloor 取 max，专用键会被静默压过
- 证据 A：`config.yaml:84-90` 六个阈值并列，注释按「各自独立语义」表述（lowConfidence=通用低置信、thinkingMinConfidence=思考档、terminalRiskFloor=破坏性命令）。
- 证据 B：`model/agent/jev/decisions.js:36` `confidence < Math.max(th.thinkingMinConfidence, th.lowConfidence)`；`:135` `const floor = Math.max(th.terminalRiskFloor, th.highConfidence)`。
- 打架点：调高 `lowConfidence` 会让 `thinkingMinConfidence` 失效；调低 `highConfidence` 不产生任何放宽；yaml 未说明「取更严者」的耦合。两个专用键在通用键更大时完全无效。
- 影响面：Jev 门控调参（opt-in，影响破坏性命令放行/思考回退）。
- 建议：yaml 注明 max 语义，或删除通用键只留专用键。
- 置信度：高

### C11 [P2] [X] `kb.crawl.execution=sandbox` 在 `sandbox.mode≠e2b` 时回落宿主 crawl4ai，与 yaml「不改跑宿主」相反
- 证据 A：`config.yaml:164-166` `execution: local ... | sandbox=显式改在会话沙箱内跑（需 agent.sandbox.mode=e2b 且模板预装 crawl4ai；**沙箱未就绪即降级纯 HTTP fetch，不改跑宿主 crawl4ai**）`
- 证据 B：`model/crawl/index.js:439-440` `execution=sandbox` 且未选择 e2b 时返回 `{ execution:'local', note:'kb.crawl.execution=sandbox 需要 agent.sandbox.mode=e2b，本次按本地 crawl4ai 执行' }`；`:423-424` 注释也写「配置矛盾……按本地执行并记 note」；调用处 `:761-770` 据此走宿主 crawl4ai。
- 打架点：用户为「不在宿主跑浏览器」而选 sandbox，忘开 e2b 时会在宿主静默启动 crawl4ai（真正的 fail-closed 分支 `:433-438` 只在 mode=e2b 但沙箱不可用时生效）。
- 影响面：安全姿势依赖「sandbox 档绝不在宿主执行」的部署。
- 建议：与 yaml 对齐（此分支降级纯 fetch 或直接拒绝），或改注释。
- 置信度：高

### C12 [P2] [O] 代码兜底默认与 yaml 默认双轨，清空/缺键时静默换一套值
- 证据 A：`config.yaml:39` `maxTurns: 200`；`:104` `maxToolResultChars: 8000`；`:554` `reserveTokens: 32000`；`:499` `toolEvoVerifyTimeoutMs: 5000`。
- 证据 B：`apps/agent.js:1159` `maxTurns: cfg.maxTurns ?? 50`；`:1185` `maxToolResultChars: cfg.maxToolResultChars ?? 4000`；`:1399` `const reserve = Math.max(0, Number(cfg.multiagent?.reserveTokens) || 8000)`；`:1051` `verifyTimeoutMs: cfg.sandbox?.toolEvoVerifyTimeoutMs || 3000`；`model/agent/Agent.js:248` `this.maxTurns = config.maxTurns ?? 90`（同一 key 的第二套默认）；`Agent.js:303` `?? 4000`。
- 打架点：用户把 `maxTurns` 清成 null/删键时，apps 给 50、Agent 内部默认 90、yaml 说 200——三套值；启动日志 `apps/agent.js:513` 还把 `?? 50` 打出来，误导排障；maxToolResultChars 清空后 8000→4000，单条工具结果被腰斩一半。
- 影响面：手工编辑 yaml / 迁移旧配置的用户；排障日志可信度。
- 建议：yaml 为唯一默认真源，删除代码内重复默认（或至少与 yaml 对齐）；日志打印实际生效值。
- 置信度：高
- 注：与 guoba C8 同源（其从面板「清空字段」角度记录），此处补 `Agent.js:248` 的第三套 maxTurns 默认与 `[limits]` 日志。

### C13 [P2] [N] 代码读取但 yaml/默认真源中不存在的隐藏配置键（yaml 不是完整真源）
- 证据 A（yaml 侧缺失）：`config.yaml` 无 `agent.personaLore.*`、无 `humanize.groupsOverride.*`、无 `humanize.persona.styleExamples`、无 `contextMsgHighWater/LowWater`（:96 注释只写「未配置按消息条数水位（30→18）压缩」却不暴露键）、无 `sandbox.verifyTemplate`、无 `humanize.memory.model`。
- 证据 B（代码侧读取）：`apps/agent.js:684` `cfg.personaLore?.dir`、`:693` `cfg.personaLore?.adoptionsDir`；`model/humanize/runtime-manager.js:77` `base.groupsOverride?.[groupId]`；`apps/humanize.js:335` `cfg.persona?.styleExamples`；`model/agent/Agent.js:285-286` `config.contextMsgHighWater ?? 30` / `config.contextMsgLowWater ?? 18`；`model/sandbox/index.js:262` `cfg.verifyTemplate || cfg.template`；`model/diagram/index.js:125` 读 `this.cfg.enabled`（yaml 键是 `enable`）；`model/humanize/memory-store.js:163/446` 用 `memory.model`，而其 provider 由 `cfgFn().model`（同样不在 yaml）决定 → 跨厂商填 id 会发到主端点。
- 打架点：这些行为只能靠手写未公开键改变；Config 自愈/面板/文档都看不到它们，yaml「默认值真源」不完整；`humanize.memory.model` 即使手写也可能因 provider 未跟随而 400。
- 影响面：想调压缩水位、人设资料库目录、群级 humanize 覆盖、伪人记忆模型的用户。
- 建议：把仍在使用的隐藏键补进 yaml+面板，删除/改名其余；`diagram.enabled` 与 `enable` 统一。
- 置信度：高（键存在）；跨厂商 memory.model 失效场景：中

### C14 [P2] [L] `agent.redactSecrets:false` 只对部分发送路径生效
- 证据 A：`config.yaml:216` `redactSecrets: true  # 发送前脱敏：屏蔽回复中的 API Key/token 等敏感信息`
- 证据 B：`apps/agent.js:2373` 最终正文、`:2300` 流式增量按开关决定是否脱敏；但 `:2351` 中途播报 `safeReply(redactSecrets(res.content))`、`:2583` run_error 错误消息、`:3593` `#续跑` 输出均**无条件**调用 `redactSecrets(...)`，不判配置。
- 打架点：关闭脱敏用于排障时，正文能看到原文，播报/报错/续跑仍被替换成 `***`，表现为「开关只关了一半」。
- 影响面：调试/排障场景；对「关=完全明文」有依赖的二次开发。
- 建议：抽取统一发送封装 `maybeRedact(text)` 按配置决定，所有外发路径共用。
- 置信度：高

### C15 [P2] [L/X] `isolation.enable=false` 时「提醒」变群共享，与 yaml「提醒/笔记/人设始终按用户」冲突
- 证据 A：`config.yaml:8` `…false=同群完全共享（群体型 bot，会话+记忆+群历史全群共用）。跨群始终隔离；私聊始终按用户。**提醒/笔记/人设始终按用户**。`
- 证据 B：`apps/agent.js:1621-1622`（及 `ctxFromInfo` :1695-1696）`const sharedGroup = isGroup && groupId && !isolation; const scopeUserId = sharedGroup ? sharedScopeId(groupId) : userId`；`model/agent/schedule.js:398` `reminder_set` 以 `userId: ctx.scopeUserId` 入库、`:460` `reminder_list` 以 `ctx.scopeUserId` 查询 → 关闭隔离的群里提醒归属 `__group__:<gid>`，全群共享；fire 时带 `groupId` 会发到群。对照笔记用真实用户（`model/agent/tools/notes.js:16,28` `ctx?.userId`），确实按用户。
- 打架点：关闭隔离后「提醒我」变成群级提醒（他人可列、可能发到群里），yaml 明确说提醒始终按用户；同一承诺下笔记/人设成立、提醒不成立。
- 影响面：`isolation.enable=false` 的群体型 bot。
- 建议：提醒/任务链改用 `ctx.userId`（与 notes 一致），或更新 yaml 说明。
- 置信度：高

### C16 [P2] [X] `maxToolResultChars` 注释把 12000 当规则，实际各工具硬编码 8000~48000 且全局配置无法上调已声明 resultCap 的工具
- 证据 A：`config.yaml:104` `maxToolResultChars: 8000  # 单条工具结果字符上限（内容获取类工具可经 meta.resultCap 单独放宽到 12000）`
- 证据 B：`model/agent/Agent.js:2350` `const max = tool?.meta?.resultCap ?? this.maxToolResultChars`（声明了 resultCap 的工具不读全局）；实际值：`model/group/notice.js:63` 8000、`model/crawl/index.js:736` 12000、`model/group/history.js:26` 12000、`model/group/forward.js:133` 14000、`model/enka/tools.js:213` 18000、`model/multiagent/spawn-tool.js:53` 48000。
- 打架点：注释把 12000 描述为统一放宽值，实际是 8000~48000 的散落硬编码；用户调大 `maxToolResultChars` 对被声明 resultCap 的工具（网页抓取/群记录等最常需要放大的）没有效果，yaml 未说明。
- 影响面：需要更长工具结果的用户（研究/抓取/报表）。
- 建议：注释改为「各工具自定」；或让 resultCap 从配置派生/可覆盖。
- 置信度：高

### C17 [P2] [L/X] humanize `allowedReadTools` 只按工具名黑名单过滤，写类/系统类工具可漏过「一律拒绝」承诺
- 证据 A：`config.yaml:619` `allowedReadTools: []  # Planner 可用的只读工具白名单；写/删/管理/终端/发送类一律拒绝`
- 证据 B：`model/humanize/default-config.js:88` `FORBIDDEN_READ_TOOLS = /^(?:send_|delete_|remove_|group_(kick|mute|set_|notice)|terminal|stagehand|file_to_pdf|upload_|create_group|transfer_|schedule_task|reminder_set|reload_skills|install_skill|memory$)/i`，`apps/humanize.js:83` 同样只按名字正则二次过滤——**不看 `tool.category`/`meta.sideEffects`**；`web_download`（`model/download/index.js:198-200`，`category:'system'`，会下载写盘并出网）名字不匹配该正则，会被放行并由 `buildReadTools` 直接执行 `t.execute(args, ctx)`（无 RBAC/confirm 门）。
- 打架点：管理员把 `web_download`（或未来新增/外置写类工具）加进白名单想「只读」时，伪人 Planner 会拿到真实执行能力且绕过权限门；yaml「一律拒绝」依赖不完整黑名单。
- 影响面：启用伪人 + 自定义 allowedReadTools 的部署（群消息不可信，存在注入驱动副作用面）。
- 建议：改成白名单校验「`category === 'query' || meta.sideEffects ⊆ ['none','read']` 且不在黑名单」，或按工具注册表动态判定。
- 置信度：高（实现如此）；实际被利用需管理员手工加白名单：中

### C18 [P2] [P] `agent.vision.maxTokens` 会被「模型列表」条目的 maxTokens 静默覆盖
- 证据 A：`config.yaml:243` `maxTokens: 1024  # 识图/观看报告输出上限（视频报告建议 2048+；思考型模型建议关思考）`
- 证据 B：`apps/agent.js:1326-1329` `const vReg = (cfg.llmModels || []).find(m => String(m.model) === String(vModel)); ... const vMaxTokens = Number.isFinite(Number(vReg?.maxTokens)) && Number(vReg.maxTokens) > 0 ? Number(vReg.maxTokens) : (vcfg.maxTokens || 1024)` —— 只要视觉模型在模型列表里配过 maxTokens（主对话常用），`vision.maxTokens` 就完全无效，且该覆盖只写在代码注释里。
- 打架点：用户按 yaml 调 `vision.maxTokens`（如视频报告要 2048）不生效，实际沿用主对话条目的上限；yaml 未声明优先级。
- 影响面：识图/看视频输出长度；视频报告被截断时难归因。
- 建议：yaml 注明模型条目优先，或让 vision.maxTokens 显式优先。
- 置信度：高

### C19 [P2] [X] `agent.thinking` 空标量无形状说明：yaml 只留空键，代码期望 provider-native 对象
- 证据 A：`config.yaml:51` `thinking:`（null，无注释、无取值说明；相邻 `thinkingAuto` 有整段注释）。
- 证据 B：`apps/agent.js:1163` `thinking: regThinking || cfg.thinking || null`；`model/agent/Agent.js:889` `return this.thinking ? { thinking: this.thinking } : {}`；`model/agent/provider/anthropic.js:237-239` 按 `thinking.type === 'enabled'` 取 `budget_tokens`，`model/agent/provider/openai.js:61` 把对象原样下发 `body.thinking = thinking`。即用户必须手写 `{ type: enabled, budget_tokens: N }`（或 disabled），写布尔/字符串会被原样下发导致协议错误或被厂商忽略。
- 打架点：yaml 把 `thinking` 呈现为可留空的简单开关，实际是个无 schema、无示例的 provider 原生对象；面板/文档也没给形状（锅巴把它做成布尔+预算虚拟字段，见 guoba C9），用户无法从配置面得知正确写法。
- 影响面：手动配置思考参数的用户；与 thinkingAuto 并存时优先级（模型级 > auto > 手写）也未在 yaml 说明。
- 建议：yaml 给出 shape 注释/删除该键（只留 thinkingAuto + 模型列表 thinking），或 normalize 支持 `on/off + budget` 简写。
- 置信度：高

### C20 [P2] [X] `sandbox.audit` 承诺「每条命令+退出码」审计，实际退出码只在失败时记录，工具路径完全不记
- 证据 A：`config.yaml:498` `audit: true  # 每条命令写审计日志（会话键/退出码/命令前 200 字符，不含密钥）`
- 证据 B：`model/terminal/exec.js:62` 执行前只记 `key` + 命令前 200 字符；`:71` 仅当 `timedOut || aborted || sandboxError || ok===false` 时才补记 `exit=${res.exitCode}`（成功命令的退出码从不记录）；`model/sandbox/bridge.js:87-89` 工具（calc/crawl/bilibili 等走沙箱的工具）只记命令，从无退出码/耗时。且输出是控制台 `Log.mark`，不是独立审计文件。
- 打架点：想用审计日志回溯「执行了什么、结果如何」时，成功命令缺退出码；工具转命令的链路完全缺结果字段。yaml 描述的字段集未兑现。
- 影响面：安全审计/排障依赖沙箱审计日志的部署。
- 建议：执行后统一记录 `exitCode/duration`，或把注释改为实际字段集；如需「审计」语义建议落独立文件。
- 置信度：中（「审计日志」是否仅指控制台日志存在解释空间）

## 低优先级清单（未单独立项，供 Lead 取舍）
- `agent.policy.categoryMin:`（`config.yaml:224`，空值无注释，`apps/agent.js:1154` `createPolicy({ categoryMin: cfg.policy?.categoryMin })` 与 `model/agent/policy.js:20-22` 内置 `CATEGORY_MIN` 合并）——「留空=内置」语义可接受，但 yaml 无任何说明/示例，且用户填任意 rank 无校验；属文档缺口（P2 边缘），不建议单列。
- `agent.confirmTimeout: 300`（`config.yaml:212`）无单位注释，代码按「秒」×1000（`apps/agent.js:673`），面板/README 未标单位 → 易被当毫秒填 300000（P2 文档缺口，未单列）。
- `agent.render.card` 仅 `#agent帮助` 读取（`apps/help.js:165`），与 yaml「帮助等卡片图」不符——已由 logic-precedence C15 覆盖，本文件不重复。
- `agent.miyoushe.maxImages` 在补齐/子代理 ctx（`apps/agent.js:1251`）未透传，回落代码默认 9 = yaml 默认，当前无行为差，仅提示一致性。
