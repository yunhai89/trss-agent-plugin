# 配置互搏修复计划（FIX v1）

目标：修复 `audit/配置互搏排查报告.md` 中的 P0 全部 + 可安全落地的 P1/P2；**不改架构**（保存快照化/F16、统一 normalize/F17、面板 schema 统一/F15 留待后续）。
约束：只改代码/配置/文档；不新增依赖；每处改动确保语法合法（`node --check`）+ 相关离线测试通过；遵循仓库风格（中文注释、最小 diff）。

## 写作用域（严格不重叠）

| 负责人 | 文件 |
| --- | --- |
| Lead | `utils/Config.js`、`utils/DevLog.js`、`apps/agent.js`、`config/default_config/config.yaml`、`package.json` |
| T1 web | `web/assets/js/views/config.js`、`model/web/api.js` |
| T2 humanize | `apps/humanize.js`、`apps/groupworld.js`、`apps/comfyui-draw.js`、`model/humanize/**`、`model/groupworld/**`、`model/selfstate/**` |
| T3 model | `model/crawl/index.js`、`model/tts/**`、`model/agent/schedule.js`、`model/agent/jev/**`、`model/terminal/exec.js`、`model/agent/Agent.js` |
| T4 docs | `guoba.support.js`、`README.md`、`开发指南.md` |

## Lead（P0 + 核心 + yaml）

1. **P0 温度**：`apps/agent.js:1085` 与 `:1328` 改为显式判空（`null/''/undefined → null`，保留 0）：抽 `numOrNull(v)`；`regTemperature`、`vTemperature` 使用。
2. **P0 基础模型清空**：`utils/Config.js`
   - `migrateBaseModel` 只在**注册表为空**时迁移（`if ((agent.llmProviders||[]).length) return false`），避免清空 `providerId` 后被立刻重建；
   - `providerId` 为空且注册表非空时，清空镜像字段（`protocol='openai', preset='', baseURL='', apiKey='', model=''`）→ 运行时明确报「未选定模型」而不是静默用旧端点；
   - `reload()` 复用 `load()` 的自愈补全（缺失键写回），消除内存/文件不一致；
   - 迁移生成的模型条目不再写 `temperature: null`（删键）。
3. **chatPermission 兜底**：`apps/agent.js` 两处日志 `|| 'all'` → `|| 'master'`；`_hasChatPermission` 兜底 `master`，未知值仅主人放行并 warn 一次。
4. **`media.passive` 接线**：`apps/agent.js` 注册 `makeMediaTools()` / `groupFileTools` 时按 `cfg.media?.passive !== false` 决定。
5. **`kb.enable` / `crawlEnable` 门禁**：`addKnowledge` 入口判 `kb.enable`；URL 入库/`setKbRefresh`/`restoreRefreshJobs` 再判 `crawlEnable`；`#知识库刷新` 同判。
6. **`render.card=false`**：`chatList`/`personaList` 跳过 screenshot，直接走已有文本回退。
7. **`agent.proxy`**：`makeProxyFetch` 对 `socks://`/`socks5://` 显式 warn 并直连（不静默）；yaml 注释改「仅 http/https」。
8. **`debug` 接线**：`utils/DevLog.js` 的 `if (cfg().enable === false) return` 改为 `devLog.enable===false && debug!==true` 才 return；yaml `debug` 注释说明等价 devLog 强制开。
9. **yaml 注释/默认值**（逐条）：proxy、thinking 形状、apiKey 镜像、alwaysOn 置空走内置、cacheControl `"off"` 三态、stagehand.permission→`master`、terminal 权限注释按实际、confirmTimeout 单位、policy.categoryMin 示例、media.degrade 枚举、comfyui.command 前提、contextHighRatio 仅 contextWindow 生效、toolDiscovery topK/minScore 在 stableList 下的语义、humanize.behaviorPolicy 副本注释、loop.timeBudget vs worker 说明、tts 双 judgeTimeout 生效顺序、render 注释。
10. `package.json` 版本 1.39.3 → 1.40.0；最终统一跑检查/测试、review diff、commit、push。

## T1（web 前端 + PUT /api/config）

1. `PUT /api/config`：拒绝镜像字段写入（`agent.model|protocol|preset|baseURL|apiKey`），返回 `ignored` 列表并提示「由基础模型引用自动回填」；非 `agent.*` 路径不再静默 `continue`，同样计入 `ignored`。
2. 模型条目写入不再落 `temperature: null` / `maxTokens: null`（删键）；弹窗 placeholder 与文案同步「留空=继承全局/功能默认」。
3. `buildChanges` 数值项清空语义：原值为 number 时，清空（`''`）提交 `null`（配合 Lead 修正的运行时兜底，使「设过可清回未配置」成立）；其它类型维持现状。
4. 基础模型「（未选择）」/「留空=默认回落」文案改为「清空=停用主模型（需重新选择）」；确认清空后保存会写 `providerId=''`（Lead 侧已保证不会被迁移恢复）。
5. `utilityModel` 两控件/过时文案：只保留一个入口；删除「只能选当前厂商」等与运行时（支持跨厂商）矛盾的说明。
6. `cacheControl`：Select 值保持 `off/auto/explicit` 字符串；确保 yaml 改 `"off"` 后首屏正常回显；保存原值 `false` 时归一为 `'off'`。
7. Web 侧知识库端点（`model/web/api.js` 的 `/kb*` 写操作）补 `kb.enable`/`crawlEnable` 门禁，与 Lead 的命令侧一致。
8. stagehand 分区补 `permission` Select（master/all，默认 master），与 yaml/锅巴一致。

## T2（humanize / 群世界 / 自我状态 / comfyui）

1. **功能模型引用解析**（报告 F20）：`apps/humanize.js` 增加 `resolveModelRef(ref)`（经 `rt.modelRouter.resolve`，命中条目时返回 `entry.model` 真名）；在 `cfgFn()` 内归一 `planner.model`/`replyer.model`；`planner.model` 留空时按 yaml 承诺回落 `agent.utilityModel`（再回落主模型）；`providerForModel` 用归一后的值。
2. **GroupWorld**：`apps/groupworld.js` 的 service `cfg` 包装层归一 `analysis.modelProfile`（同样用 modelRouter），provider 用归一后的 provider。
3. **SelfState**：`apps/humanize.js` 的 `ssLazy` 与反思/维护 cron 构造 SelfStateService 时归一 `eventDetection.ambiguousIntentModelProfile`；SS 定时任务的群清单改为 `selfState.groups → groupWorld.groups → humanize.groups` 顺序回落（修正 C11）。
4. **humanize.maxReplies 双真源**（F19）：`model/humanize/runtime-manager.js`、`turn-scheduler.js` 优先读顶层 `maxRepliesPer10Minutes`；`validateHumanizeConfig` 对 behaviorPolicy 副本补 0~60 clamp。
5. **allowedReadTools 安全过滤**（P2 #41）：`apps/humanize.js` / `default-config.js` 除名字黑名单外，按 `tool.category !== 'query'` 或 `meta.sideEffects` 拒绝写/系统类工具。
6. **comfyui 吞消息**（F22）：`apps/comfyui-draw.js` `_gate` 在 `enable=false` 时返回 `'skip'`（不回复、不吞消息），与 yaml「零影响」一致。
7. **默认关不预装配**（逻辑 C10）：`apps/humanize.js`/`apps/groupworld.js` 的构造器预热仅在 `enable/enabled===true` 时执行；`model/groupworld/service.js init()`、`model/selfstate/service.js init()` 在未启用时直接返回（不建库/不跑 DDL）。

## T3（crawl / tts / jev / 提醒 / 审计 / Agent 默认）

1. **crawl execution 安全降级**（A C11）：`model/crawl/index.js:resolveCrawlExecution` 在 `execution=sandbox` 且未开 e2b 时返回 `sandboxRefused:true` + 说明「降级纯 HTTP fetch，不跑宿主 crawl4ai」，同步改文档注释。
2. **tts judgeTimeout**（F29）：IndexTTS 两条 `planEmotion` 路径改用 `this._judgeTimeoutMs()`（全局优先），yaml 注释由 Lead 同步。
3. **tts segmentGapMs 0**（A C08）：云端 `gapMs: Number(cfgProv.segmentGapMs) || 300` 改为保留 0（空/非法才 300）。
4. **jev.model 优先级**（A C09）：`apps/agent.js:1094` 属 Lead 文件——**不要动**；T3 只改 `model/agent/jev/**` 中阈值 `Math.max` 耦合的注释/日志（不改变行为），如需改优先级请交给 Lead。
5. **提醒按用户**（A C15）：`model/agent/schedule.js` 的 reminder add/list/cancel 使用 `ctx.userId || ctx.scopeUserId`，与 yaml「提醒始终按用户」一致（保留旧记录兼容）。
6. **sandbox.audit**（A C20）：`model/terminal/exec.js` 成功命令也记录 `exitCode/耗时`（一行），兑现 yaml 承诺。
7. **Agent 兜底默认对齐 yaml**（F6）：`model/agent/Agent.js` 的 `maxTurns ?? 90` → `?? 200`、`maxToolResultChars ?? 4000` → `?? 8000`（与 yaml 一致；apps 侧 Lead 同步）。
8. `model/agent/jev/decisions.js`：阈值 `Math.max` 处补一行注释说明「通用阈值取更严者」，减少「调了无效」的困惑（行为不变）。

## T4（锅巴 + README + 开发指南）

1. 锅巴文案：renderScale「3=超清（默认）」；contextWindow「留空=按消息条数 30→18 压缩；填真实窗口后按 65%→45%」；crawl.execution option value `local`；sessionPersist 不写死 12h；MCP 文本框删「可直接增删键」；toolDiscovery.alwaysOn help 与 yaml/代码对齐；stagehand 补 permission 字段且 enable help 与默认 master 一致；sandbox.mode help 与「全员可用 + 出口默认放通」一致；debug 说明改为 devLog。
2. README：fallback 改「可跨厂商，每条独立 baseURL/apiKey/protocol」并补配置表字段；`vision.model` 改为「主模型支持视觉可留空复用」；删 `persona.dir` 死字段说明；`#任务列表/#继续任务` 标注需 `taskStore.enable=true`；补「锅巴面板覆盖常用项，完整配置用 Web 中心/yaml」；`apiKey` 行与 yaml 权重一致（镜像 vs 厂商条目必填）；`agent.thinking` 给 shape 示例；stagehand 默认权限；media.passive 修复后可正常描述。
3. 开发指南如有同类过时描述一并修（先 grep 关键词再改）。

## 验收

- `node --check` 所有改动 .js（ESM 用 `node --check` 直接过）；`node scripts/run-tests.mjs`（若依赖可用）或相关单测。
- `git diff` 人工 review：无无关改动、无调试残留。
- Lead 统一 commit：`fix(config): 收敛配置真源与运行时互搏（P0 温度/基础模型清空 + P1 批量）`，再 push origin master。
