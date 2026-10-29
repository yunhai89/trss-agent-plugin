# 配置互搏「全量修复」计划（FIX v2）

目标：把 `audit/FIX_STATUS.md` 的「未修复」清单与报告 P2 剩余项全部落地；测试通过；提交并推送（延续上一轮「修复后推送远端」的约定）。
原则：不新增依赖；行为变更必须同步文档/面板/单测；每个 owner 只改自己作用域文件；yaml 只由 Lead 改。

## 统一决策（所有 owner 共同遵守）

| # | 决策 |
| --- | --- |
| D1 | **F7 回退模型单真源**：yaml 删除 `fallbackModel/fallbackBaseURL/fallbackApiKey/fallbackProtocol`；运行时只读 `fallbackModels[]`；`Config.load()` 做一次性迁移（扁平→数组后清空扁平键）；锅巴改为 `agent.fallbackModels` JSON textarea；Web 数组编辑器保留；README 同步 |
| D2 | **F16 保存不再快照默认值**：`Config.save()` 只写「相对默认值的差异」；启动 `load()` 做一次性压缩（user 文件中与默认值 deep-equal 的键删掉，写 `.bak` 备份）；移除 load/reload 的「缺失键写回全量」自愈 |
| D3 | **F17 统一归一**：`utils/Config.js` 导出 `normalize(data)`（镜像迁移/回填、fallback 迁移、类型强转如 cacheControl 布尔→三态、数值 null 清理），`save()`/`load()` 必须走它；面板只保留 UI 虚拟字段转换（thinking enable/budget、MCP serversJson、masters/alwaysOn 换行） |
| D4 | 新增 yaml 键（代码已在读、此前不可见）：`contextMsgHighWater: 30`、`contextMsgLowWater: 18`、`personaLore: { dir: "", adoptionsDir: "" }`、`persona.styleExamples: []`、`humanize.groupsOverride: {}`、`humanize.memory.model: ""`、`sandbox.verifyTemplate: ""`；apps/agent.js 把 contextMsg* 传给 Agent |
| D5 | `tts.autoReply` 默认改 `false`（总开关默认关时不留「开总闸即每条语音」的惊喜），yaml 注释说明 |
| D6 | `loop.timeBudgetMs` 默认 1800000 → **3600000**（与 `multiagent.workerTimeBudgetMs` 对齐，修 README 自述矛盾） |
| D7 | `debug` 顶层键纳入 Web 配置中心：`GET /api/config` 额外返回 `debug`；`PUT /api/config` 接受点路径 `debug`（布尔）；Web 基础设置加开关 |
| D8 | `diagram` 配置键统一 `enable`：`model/diagram/index.js` 读 `cfg.enable ?? cfg.enabled ?? true`（兼容旧 `enabled`） |
| D9 | `selfReview.dailyBudgetTokens: 0` = **关闭后台自评审**（不再等于「不限」）；help/README 同步 |
| D10 | 思考预算上限统一：手动 `thinking.budget_tokens` 与自动 `maxBudget` 都允许到 **128000**（`model/llm/thinking.js` 统一 clamp，面板 min/max 对齐） |
| D11 | 「父关子开」默认组合：文档标注前提（锅巴 help/yaml 注释）；`tts.autoReply` 改 false（D5）；`sticker.sendStickerTool` 保留 true 但 help 写明「仅 sticker.enable=true 时注册」；`comfyui.command.enable` 已注明 |
| D12 | `schedule_task` 保持群级作用域（任务链要结合群上下文），yaml 注释明确「提醒按用户，任务链按会话」；不改代码 |
| D13 | 面板 canonical 数值域（两面板必须一致）：`maxTurns 1..1000`、`temperature 0..2 step .1`、`contextWindow min 1000`、`contextHighRatio .3..95 step .05`、`contextLowRatio .05..9 step .05`、`progressRecall 0..120`、`renderScale 1..4`、`thinking.budget_tokens 1024..128000 step 1024`、`thinkingAuto.maxBudget 1024..128000 step 1024`、`judge/toolDiscovery/minScore 0..1 step .05`、`toolDiscovery.topK 1..20`、`recall.cap min 10`、`recall.extractEvery min 1`、`profile.maxChars 100..2000 step 50`、`profile.maxPerFacet 1..20`、`selfReview.every min 5`、`multiagent.maxConcurrent 1..10`、`workerMaxTurns 1..1000`、`jev thresholds 0..1 step .05` |
| D14 | `vision.maxTokens` 显式配置优先于模型条目 `maxTokens`（只有未显式配置时才用条目值）（Lead/apps） |
| D15 | `media.enable=false` 作为**多模态总开关**：同时关闭视觉子模型装配与 `ctx.vision`（表情自动发现/工具看图一并停用）（Lead/apps） |
| D16 | `redactSecrets=false` 对所有外发文本统一生效（播报/错误/续跑不再无条件脱敏）：抽 `maybeRedact()`（Lead/apps） |
| D17 | `reasoningFields` 为空数组视为未配置（不向 provider 传空数组）（Lead/apps） |
| D18 | `humanize.memory.model` 支持跨厂商：按 modelRouter 解析 provider+真实模型名（T3） |
| D19 | `groupWorld.analysis.schedule` 热加载：cron 任务改为每分钟触发 + 自实现 5 字段 cron 匹配，配置改动即时生效（T3） |
| D20 | 文档：README/开发指南同步以上全部行为与字段；锅巴覆盖说明从「常用项」改为列出新增块 |

## 写作用域

| Owner | 文件 |
| --- | --- |
| Lead | `utils/Config.js`、`apps/agent.js`、`config/default_config/config.yaml`、`package.json`、`audit/FIX_STATUS.md`、`audit/配置互搏排查报告.md`（状态更新） |
| T1 web | `web/assets/js/views/config.js`、`web/assets/js/mock.js`、`model/web/api.js` |
| T2 guoba | `guoba.support.js` |
| T3 runtime | `apps/groupworld.js`、`apps/humanize.js`、`model/evolution/review.js`、`model/diagram/index.js`、`model/humanize/memory-store.js`、`model/llm/thinking.js`、相关 `*.test.mjs` |
| T4 docs | `README.md`、`开发指南.md` |

## 任务明细

### T1（web）
1. D7 `debug`：`GET /api/config` 返回 `{...agent, debug}`；`PUT /api/config` 接受 `debug`（布尔）并写根；Web 基础设置加「调试日志」Switch（`form.debug`），保存时在 changes 里单独带 `debug`。
2. PUT `/api/config` 对 `agent.tts.*` 套用与 `/api/tts/config` 相同的白名单/类型校验（防绕过）；校验逻辑抽公共函数。
3. 删除 `OPT.degrade` 死枚举；`media.degrade` 改为 Select：`skip / note / text`（与 README/convert.js 一致）。
4. 删除「视觉/Embedding 选跨厂商时自动拷贝端点字段」逻辑（`onFeatureSel` 中 vision/embed 分支），运行时已按注册表路由；保留字段作为旧配置兼容（不主动写）。同步说明文案。
5. 常驻工具编辑器：显示「配置里已有但当前未注册」的条目（可删除），避免配置项看不见。
6. mock.js 配置 mock 对齐真实默认（maxTurns 200、trigger at、stt.enable true、thinking null、renderScale 3、contextHighRatio 0.65 等；逐项对照 config.yaml），并注明「仅 smoke 测试用」。
7. D13 面板 min/max 对齐（web 侧）；补 D4 新增键的表单（contextMsgHigh/LowWater、personaLore.dir/adoptionsDir、persona.styleExamples、humanize.groupsOverride（JSON）、humanize.memory.model、sandbox.verifyTemplate）。
8. 「全量配置项」标题/说明与锅巴覆盖说明改准确；`feature-assign-check.mjs` 旧注释清理（若在作用域外只报告）。
9. 自检：`node web/dev/config-search-check.mjs`、`feature-assign-check.mjs`、`smoke.mjs`、`node --check`。

### T2（guoba）
1. F7：删除扁平 fallback 四项，新增 `agent.fallbackModels` JSON textarea（与 Web 一致，说明数组优先、可跨厂商、旧扁平字段由 Config 自动迁移）。
2. 补关键缺失字段（安全/行为总开关，约 60~80 个）：
   - 基础：`agent.privateChat`、`agent.isolation.enable`、`agent.reply.atSender`、`agent.reply.quote`、`agent.render.card`、`agent.cacheControl`（Select off/auto/explicit）、`agent.promptCacheKey`、`agent.reflect`、`agent.finalizeMaxTokens`、`agent.rootTokenBudget`、`agent.reasoningFields`（每行一个）、`agent.memoryLimits`（JSON）。
   - 上下文/循环：`agent.contextHighRatio/contextLowRatio/contextMsgHighWater/contextMsgLowWater`、`agent.loop.*`（5 项）、`agent.compaction.enable/archiveDir`、`agent.toolConcurrency.maxParallel`、`agent.toolSchemaValidate`、`agent.keepReasoning` 已有。
   - 知识库/下载：`agent.kb.enable/crawlEnable/chunkSize/chunkOverlap/topK/minScore/crawlTimeout`、`agent.download.enable/maxMB/sendLimitMB/maxTimeoutSec/bin/dir`。
   - 沙箱：`agent.sandbox.network.allowInternet`（Switch）、`allowOut`/`denyOut`（多行→数组）、`audit`、`defaultCwd`、`sandboxTtlMs`、`concurrencyWaitMs`、`requestTimeoutMs`、`retries`、`allowPublicTraffic`、`verifyTemplate`。
   - 多模态/表情/TTS/进化：`agent.media.enable/active/passive/maxImages/maxFileBytes/degrade(Select skip/note/text)/capsFromApi`；`agent.sticker.enable/maxPerReply/cooldown/sendRate/antiConsecutive/groupOnly/listTopN/sendStickerTool`；`agent.tts.enable/provider/autoReply/replyMaxChars/hdVoice`；`agent.selfReview.*` 已大部分有 → 补 `agent.selfReview.autoApply*` 已存在则跳过；`agent.toolEvo.dbPath/artifactsDir`。
   - 子系统总闸：`agent.humanize.enable/groups/shadow/threshold`、`agent.groupWorld.enabled/groups/online`、`agent.selfState.enabled/shadowMode/groups`、`agent.comfyui.enable/host/cloud/confirm`、`agent.diagram.enable/renderer`、`agent.stt.enable/apiBase/apiKey/model/language`、`agent.calc.enable/python/timeout`、`agent.miysoushe`（如已有跳过）。
   - `agent.policy.categoryMin`（JSON textarea）。
   - Jev：补 `thresholds.lowConfidence/highConfidence`；删除 `jev.apiKey` 死掩码特判（面板无该字段）或保留注明 legacy（二选一，倾向删）。
   - `agent.devLog.enable/dir`。
   - D4 新增键（contextMsg*、personaLore.dir/adoptionsDir、persona.styleExamples、humanize.memory.model、sandbox.verifyTemplate、humanize.groupsOverride）。
3. 数组字段统一多行文本↔数组（alwaysOn/shell.intercept/masters 已有转换，新 allowOut/denyOut/reasoningFields/categoryMin 照此办理，setConfigData 侧补反转）。
4. D13 min/max 对齐；所有新字段 help 与 yaml 语义一致；`debug` help 保持 D7 口径。
5. 验证：`node --check`、实际加载 `supportGuoba()`（field 数量、无重复 path）、现有锅巴相关测试（如有）。

### T3（runtime misc）
1. D9 `model/evolution/review.js`：`dailyBudgetTokens===0` → 构造器 warn 一次 + `_budgetExhausted()` 返回 true（跳过评审）；`tick()` 入口提前返回；补单测（0=关闭、>0 仍生效）。
2. D10 `model/llm/thinking.js`：`clampBudget` 的 cap 统一上限 128000（已有 DEFAULT_MAX_BUDGET 则对齐），手动 budget 路径也 clamp；补单测。
3. D18 `model/humanize/memory-store.js` + `apps/humanize.js`：`humanize.memory.model` 通过 modelRouter 解析 provider 与真实模型名（条目 id→entry.model），传给 memory-store；缺省沿用现行为。
4. D19 `apps/groupworld.js`：`analysis.schedule` 热加载——注册每分钟 cron（`* * * * *`），实现 5 字段 cron 匹配（`*`、`*/n`、`a-b`、逗号列表），命中且当分钟未跑过才执行 hourlyTask；改配置即时生效；构造日志说明。补/改相关测试（groupworld test 或 apps 层若可）。
5. D8 `model/diagram/index.js`：`this.cfg.enabled` 支持 `cfg.enable ?? cfg.enabled`（yaml 键是 enable）。
6. `apps/humanize.js`：`humanize.groupsOverride` 若代码已读（runtime-manager.js:77），确认 yaml 新键生效即可；无需改逻辑。
7. 检查 `model/humanize/memory-store.js` 的 `memory.model` 是否也应回退 `utilityModel`（按 yaml 承诺），统一注释。
8. 跑相关单测：`model/agent/test.mjs`、`model/agent/jev/*`、`model/groupworld/test.mjs`、`model/humanize/test.mjs`、`model/evolution/test.mjs`（存在则跑）；`node --check`。

### T4（docs）
1. README：回退模型改为「仅 `fallbackModels[]`（旧扁平字段自动迁移）」；`tts.autoReply` 默认 false；`loop.timeBudgetMs` 默认 1h 与 worker 对齐说明；`selfReview.dailyBudgetTokens:0=关闭`；`debug` 可在 Web 配置；`vision.maxTokens` 优先级；`media.enable` 为多模态总开关（含视觉/表情发现）；新增隐藏键（contextMsgHigh/LowWater、personaLore.dir、persona.styleExamples、humanize.groupsOverride、humanize.memory.model、sandbox.verifyTemplate）；沙箱面板新增字段说明；锅巴覆盖说明更新为「已覆盖常用+安全项，完整仍在 Web/yaml」。
2. 开发指南同步（grep 上述关键词）。
3. 检查 README 示例 yaml 与实际默认值一致（tts/loop/fallback）。
4. 不改代码。

## 验收（Lead）
- 全量 `node scripts/run-tests.mjs` → 0 失败；`node --check` 所有改动 js；web 三个自检通过。
- Config F7/F16 沙箱复现：新装→保存只差量；旧全量快照→启动压缩为差量并留 .bak；扁平 fallback 迁移成数组且扁平键清空。
- 版本 1.40.1 → 1.41.0；更新 `audit/FIX_STATUS.md` 与报告状态；commit + push origin master。
