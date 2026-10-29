# 配置互搏修复记录（FIX v1 落地）

> 关联：`audit/配置互搏排查报告.md`（73 条：P0 2 / P1 27 / P2 44）
> 提交：`17370b5` fix(config): 收敛配置真源与运行时互搏（P0/P1 批量）(v1.40.0)
> 　　`21cf455` fix(config): 开启思考自动决策不再删除手动 thinking；补伪人级联说明 (v1.40.1)
> 验证：`node scripts/run-tests.mjs` → 128 文件通过 / 0 失败 / 11 跳过（需凭据或驱动器）

## 已修复（报告编号）

### P0
- **F1** 模型条目温度 null→0：`apps/agent.js` 用 `numOrNull` 判空（0 保留）；`utils/Config.js` 迁移、`web/assets/js/views/config.js` 新建/编辑模型条目不再落 `temperature:null`/`maxTokens:null`。
- **F2** 取消/清空基础模型：`Config.migrateBaseModel` 仅在注册表为空时迁移（清空 `providerId` 不再被重建）；`providerId`/`modelId` 清空时清镜像并让运行时 fail-fast；`reload()` 与 `load()` 同口径自愈；`PUT /api/config` 拒绝镜像字段（`agent.model/protocol/preset/baseURL/apiKey`）并返回 `ignored`；面板文案改「清空=停用主模型」。

### P1
- F3 `toolDiscovery.alwaysOn` 置空走代码内置 13 项真源；`toolDiscovery.enable/stableList` 注释语义修正（yaml/锅巴/Web）。
- F4 `renderScale` 锅巴文案改「3=超清（默认）」。
- F5 `kb.crawl.execution` 面板值 `host`→`local`。
- F6 代码兜底默认对齐 yaml：`maxTurns` 200、`maxToolResultChars` 8000、`reserveTokens/toolEvoVerifyTimeoutMs` 注释与启动日志；`chatPermission` 兜底 `master`（未知值仅主人 + warn）。
- F7 回退模型双真源：yaml 注明数组优先，Web/README 补说明，锅巴 help 同步（数据结构未合并，见「未修复」）。
- F8 `utilityModel` 去重（Web 只留「功能分配」卡）并删过时限制文案。
- F9 `cacheControl` 改三态 `"off"`（yaml/Web 载入与保存归一）。
- F10 `debug` 接线：`debug=true` 等价强制开启 devLog（`utils/DevLog.js`），三处文档同步。
- F11 `media.passive` 真正门控被动媒体工具注册。
- F12 `kb.enable/crawlEnable` 门控：`#知识库添加`、刷新、定时刷新恢复、Web `/kb*` 写端点。
- F13 Stagehand `permission` 默认 `master`（yaml/锅巴/Web 三方一致，锅巴补字段）。
- F14 沙箱 terminal 权限注释按实际「全员可用 + 出口默认放通」重写。
- F15 锅巴覆盖说明改为「常用项」，README 同步（面板字段未补全，见「未修复」）。
- F16 部分：`reload()` 增加与 `load()` 相同的缺失键自愈落盘（保存全量快照化未改，见「未修复」）。
- F17 部分：`thinking` 互斥归一从两个面板撤掉（不再写 null）；统一 `normalize()` 未做（见「未修复」）。
- F18 开启 thinkingAuto 不再删除手动 thinking（锅巴/Web 均改；运行时 auto 优先）。
- F19 `humanize.maxRepliesPer10Minutes` 顶层优先 + behaviorPolicy 副本钳制。
- F20 功能模型引用归一（humanize/GW/SS）：模型条目 id→真实模型名；planner 留空回落 `utilityModel`。
- F21 `groupWorld.online`/`selfState.shadowMode` 级联前提写入 yaml。
- F22 部分：`comfyui.enable=false` 不再吞 `#画图`（返回 skip）；`media.enable` 范围与 `tts.autoReply` 前提、`sticker` 子项前提补文档。
- F23 Web 数值项清空提交 `null`（配合运行时 `??` 默认，「设过可清回未配置」）。
- F24 `contextLowRatio` 被夹紧时 warn 一次。
- F25 锅巴 `contextWindow` 文案改为 65%→45% / 留空 30→18。
- F26 `render.card` 同时门控 `#聊天列表`/`#人设列表`。
- F27 README 与默认配置冲突修正（taskStore 前置、fallback 跨厂商、vision.model、persona.dir、锅巴覆盖范围、apiKey 权重、thinking 形状）。
- F28 `agent.proxy`：SOCKS 显式告警并直连，yaml/README 不再承诺 SOCKS。
- F29 TTS `judgeTimeoutMs` 全局优先生效（IndexTTS 两路径）。

### P2（已修）
- 云端 TTS `segmentGapMs:0` 保留 0；`jev.model` 手填优先；crawl `execution=sandbox` 且未开 e2b → fail-closed 降级纯 fetch（不跑宿主 crawl4ai）；提醒按用户归属（旧群记录兼容）；terminal 审计成功命令也记退出码/耗时；`maxRepliesPer10Minutes`/Jev 阈值耦合注释；`vision.maxTokens` 优先级注释；`sandbox.audit` 字段兑现；`confirmTimeout` 单位、`policy.categoryMin` 示例、`media.degrade` 枚举、`sessionPersist`/`contextRatio`/`allowOut` 指引、MCP 增删文案、fallback 说明等文档修正。
- 默认关不预装配：humanize/GW/SS 未启用不建库/跑 DDL（关=整层 no-op 名副其实）。
- 同步更新受影响单测契约（crawl execution / TTS / agent / comfyui）并修全新 checkout 下 `data/temp` 缺失导致的测试 ENOENT。

## 未修复（架构级，留待后续）

| 报告项 | 内容 | 原因 |
| --- | --- | --- |
| F16（完整） | 保存即把「默认值+用户值」全量落盘 → 默认值快照化，升级后新默认对老用户不生效 | 需「只写差异 + defaultsVersion 版本化」改造，影响所有保存入口，单独迭代 |
| F17（完整） | 两面板仍各有私有归一（thinking/MCP/masters 转换、PUT 点路径 diff），`Config.js` 无统一 `normalize()` | 需统一 schema/归一架构，改动面大 |
| F15 | 锅巴面板仍只覆盖约 1/4 配置叶子（沙箱 network/audit、tts/humanize/GW/SS 等无控件） | 需按功能补面板 + 双面板共用字段表；本轮仅修文案与危险默认 |
| F7（完整） | 回退模型仍双真源（`fallbackModels[]` + 扁平 `fallbackModel*`） | 合并需数据迁移与面板数组编辑器 |
| F22（剩余） | 部分「父关子开」默认组合仍在（如 `sticker.enable=false` + `sendStickerTool=true`） | 已补文档前提；默认值联动待产品决策 |
| P2 杂项 | Web `OPT.degrade` 死枚举（describe/ignore）、mock.js 与真实默认偏差、两面板 min/max 差异、`tts.enable === true` 严格布尔、`schedule_task` 仍群级 scope | 影响面小/需产品确认 |

## 验证记录

- `node --check`：全部改动 `.js` 通过。
- `node web/dev/config-search-check.mjs` 20/20、`feature-assign-check.mjs` 46/46、`smoke.mjs` 通过。
- `node scripts/run-tests.mjs`：128 通过 / 0 失败 / 11 跳过（真实凭据/驱动器测试按设计跳过）。
- 沙箱复现（`/tmp/cfgtest2`）：清空 providerId 不再被迁移恢复；清空 modelId 清镜像；模型条目无 `temperature:null`。

---

# FIX v2（v1.41.0）— 审计遗留项全量修复

> 对应 `audit/FIX_PLAN_V2.md` 的 D1~D20 与 T1~T4。

## 已完成

### 架构级（上一轮「未修复」全部落地）
- **F16 保存快照化**：`Config.save()` 只写「与默认值的差异」（`diffFromDefaults`）；老用户的默认值全量快照在启动时一次性压缩（备份 `config.yaml.bak`，已 gitignore）；`load/reload` 不再写全量、也不再对缺失键做全量回写。默认值克隆隔离（避免 `deepMerge` 浅拷贝污染默认值导致 diff 恒空）。
- **F17 统一归一**：`Config.normalizeConfig()` 作为唯一归一入口（镜像迁移/回填、fallback 迁移、`cacheControl` 布尔→三态、`thinking` 布尔→原生形状），`load/reload/save` 全部经它；面板只保留 UI 虚拟字段转换。
- **F7 回退模型单真源**：yaml 删除扁平四项，仅 `fallbackModels[]`；`utils/Config.js` 启动时把有效扁平条目迁移进数组并删键（缺 apiKey 时 warn）；运行时只读数组；锅巴改 JSON textarea；Web 保留数组编辑器；README 同步。
- **F15 锅巴覆盖**：143 → **254 field**（覆盖 yaml 叶子 25.8% → ≈45.9%），新增沙箱 network/audit、KB/下载、媒体/表情/TTS/STT、子系统总闸、policy、Jev 两阈值、devLog、D4 新键；数组/JSON 字段双向转换；删除 Jev 死掩码。
- **F22 剩余**：`tts.autoReply` 默认 false；`comfyui.enable=false` 不吞消息（上轮已修）；父关子开在 yaml/面板 help 全部标注。
- **D4 隐藏键可见化**：`contextMsgHighWater/LowWater`（并真正传给 Agent）、`personaLore.dir/adoptionsDir`、`persona.styleExamples`、`humanize.groupsOverride`、`humanize.memory.model`、`sandbox.verifyTemplate` 全部进 yaml + 两个面板 + 代码默认值。

### 行为修复
- **D9** `selfReview.dailyBudgetTokens: 0` = 关闭后台自评审（此前 0=不限会烧 token），构造期 warn 一次。
- **D10** 思考预算上限统一 **128000**（`MAX_THINKING_BUDGET`）：自动路径 `clampBudget` + 手动 `thinking.budget_tokens`（`Agent._reasoningOpts` 下发前 clamp）共用；面板两处 min/max 对齐。
- **D14** `vision.maxTokens` 显式配置优先于模型条目 `maxTokens`。
- **D15** `media.enable=false` 成为多模态总开关：同时关闭视觉子模型装配与工具侧 `ctx.vision`。
- **D16** 统一 `maybeRedact()`：`redactSecrets=false` 时播报/错误/续跑等全部发送路径一致不脱敏（此前只关一半）。
- **D17** `reasoningFields: []` 视为未配置，不下发空数组。
- **D18** `humanize.memory.model` 支持跨厂商（modelRouter 解析条目 id→真实模型名/provider），回退链 留空→utilityModel→主模型。
- **D19** `groupWorld.analysis.schedule` 热加载：固定每分钟 cron + 自实现 5 字段 cron 匹配（`*`、`*/n`、`a-b`、逗号、dom/dow OR），改配置即时生效。
- **D8** `agent.diagram.enable` 与旧 `enabled` 归一同源。
- **D7** 顶层 `debug` 进入 Web 配置中心（GET 下发、PUT 接受、面板开关）。
- **D5/D6** `tts.autoReply` 默认 false、`loop.timeBudgetMs` 默认 1h（与子代理预算对齐）。
- **P2 杂项**：Web `OPT.degrade` 死枚举修正为 `skip/note/text`；`mock.js` 对齐真实默认；两面板 min/max 统一到 canonical 域；PUT `/api/config` 对 `agent.tts.*` 复用 `/api/tts/config` 白名单校验；Web 删除 vision/embed 端点自动拷贝（运行时按注册表路由）；常驻工具编辑器可见已配未注册条目；`tts.enable` 布尔容错（`1/"true"` 不再静默失效）；`schedule_task` 群级作用域在 yaml 注明。
- **文档**：README/开发指南同步以上全部（回退单真源、保存只写差异、tts/loop/selfReview 默认、debug、vision.maxTokens、media 总开关、新键、锅巴覆盖、沙箱面板字段）。

## 仍未做（明确记录）
- 锅巴长尾细粒度项未面板化：vision 连接字段、stagehand 调参、tts 各 provider 子块、comfyui/sticker/diagram/schedule/taskStore/tools 子项、recall embedding 端点、research 参数 —（非安全/行为总闸，README 已说明用 Web/yaml）。
- `humanize` 已建群 Planner/Replyer provider 是装配期解析：热改型号后旧群 provider 不重建（既有边界）。
- `jeves`/`mcp` 之外的第三方写入路径未统一走 `Config.normalize`（`#模型切换` 等已各自处理；后续可再收敛）。

## 验证
- `node scripts/run-tests.mjs` → **129 文件通过 / 0 失败 / 11 跳过**。
- `node web/dev/{config-search-check,feature-assign-check,smoke}.mjs` 全过。
- Config 沙箱实测：保存只写差异（641 键默认 → 改 1 项仅写 2 行）；旧全量快照启动压缩为 0 键差异并留 `.bak`；扁平 fallback 迁移为数组且扁平键清空、重启后保留。
- 锅巴实测：`supportGuoba()` 290 schemas / 254 fields / 36 groups，0 重复 path；JSON/多行往返、非法 JSON 保留原值。

---

# FIX v2.1（v1.41.1）— 锅巴覆盖补全（254 → 363 field）

> 「全量修复」收尾：把 v2 遗留的「锅巴长尾细粒度项未面板化」补齐到行为/安全/常用调参级别。

- 新增 109 个字段、10 个分组：视觉子模型连接（protocol/preset/baseURL/maxTokens/describePrompt）、
  定时任务链与任务账本、工具/渲染、记忆召回补充（usage/embed/ profile.inferAfter）、深度研究、
  技能/搜索/MCP 超时、表情包自动发现、ComfyUI 全量常用项、示意图（主题/格式/尺寸/Kroki）、
  TTS 全量常用项（判定模型/超时 + SoVITS/IndexTTS/豆包/MiniMax/MiMo 连接与音色/格式）、
  Stagehand 调参与限流、沙箱 verifyTemplate、media.caps、群世界分析/检索预算、自我认知阈值。
- 表示层转换扩展：`sticker.discoverGroups` / `stagehand.blockedHosts` / `diagram.kroki.allowedDiagramTypes`
  走多行↔数组；`media.caps` 走 JSON 文本域（解析失败保留原值并提示）。
- 面板统计：**363 field / 50 分组**，0 重复路径，所有字段都能从真实配置取到值；
  yaml 叶子覆盖率 254/546 → **363/546 ≈ 66.5%**。
- 验证：`supportGuoba()` 加载通过；扁平点路径提交往返（数组/JSON/坏 JSON 保留原值）实测通过；
  `node scripts/run-tests.mjs` → 129 通过 / 0 失败 / 11 跳过。
