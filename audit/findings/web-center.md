# Web 配置中心（config.js / model/web/api.js / store·mock）↔ yaml / 锅巴 发现

> 审计范围：`web/assets/js/views/config.js`（423 个 `form.*` 绑定）、`model/web/api.js`（GET / PUT /api/config、TTS 子配置、脱敏）、`web/assets/js/store.js`、`web/assets/js/mock.js`、`utils/Config.js`（保存后归一）、`guoba.support.js`（字段覆盖对比）、`config/default_config/config.yaml`。只读审计，未改任何源码/配置。
> 交叉核对：`audit/tools/inventory.json`（yaml 叶子 × 锅巴 × config.js 绑定 × 代码出现次数）。

## 结论摘要（按严重度）
1. [P0] Web 新建/编辑模型条目固定写 `temperature: null`（清空则写 `""`），运行时 `Number.isFinite(Number(null))===true` → 模型级温度被钉成 **0**，全局 `agent.temperature: 0.2` 被静默忽略（配置面板与运行时对「留空=继承」理解相反）。
2. [P1] 基础模型下拉允许「（未选择）」，`providerId/modelId` 可被清空/指向已删条目；`Config.js` 故意不回填镜像字段 → 面板显示「未选择」，运行时继续用**上一次解析出的旧 model/Key + 本次新 baseURL**，只在日志里留一条 WARN。
3. [P1] 回退模型双真源：Web 只读写 `agent.fallbackModels`（数组），锅巴只读写 `agent.fallbackModel*`（扁平），运行时两者**取并集** → Web 面板删光回退后扁平回退仍然生效，且两个面板互相看不见对方配的回退。
4. [P1] 数值项「设过就回不去」：`buildChanges` 对 number 原值用 `parseNum`，清空输入框得到 `null` 直接 `continue`（不提交）；原值为 `null` 时 `''` 也被跳过 → `maxTokens` / `contextWindow` 一旦填过就**无法清回「未配置」**，而 yaml 明确「未配置按消息条数水位压缩」。
5. [P1] 旁路小模型（`agent.utilityModel`）在「基础 / 模型」卡只能选主厂商模型（desc 还写「只能从当前所选厂商的模型里选」），而同一页面「功能分配」卡对同一字段可跨厂商、yaml 注释与运行时 model-router 也支持跨厂商；同一 key 两套选项集。
6. [P1] `agent.cacheControl` 三源类型不一致：yaml 是布尔 `false`，面板是字符串三态 `off/auto/explicit` select → 首屏 select 无匹配项显示**空白**；一旦保存，配置类型从 boolean 变 string。
7. [P1] 锅巴 `agent.kb.crawl.execution` 的选项值是 `host`，yaml/Web/代码认的是 `local`；锅巴保存后写入 `host`，运行时按 `==='sandbox'?'sandbox':'local'` 归一，面板回到 Web 后该 select 无匹配项显示空白。
8. [P1] `PUT /api/config` 不拒绝镜像字段：提交 `agent.model/protocol/preset/baseURL/apiKey` 会 `setPath` 成功并把 `applied` 计数 +1，返回「已保存」，但 `Config.save()` 内的 `normalizeBaseModel → syncBaseModel` 会立刻用引用解析结果覆盖它们（磁盘上不是提交值）。
9. [P1] `PUT /api/config` 对非 `agent.*` 路径 `continue` 静默丢弃（不计数、不进 `rejected`、不提示）→ 顶层 `debug`（yaml:1、锅巴:98）无 Web 入口；混合提交时前端只看到「已保存 N 项」，其余漏存无告知。

## 明细

### C1 [P0] [F] 模型条目 `temperature: null` 被运行时当成 0，覆盖全局温度
- 证据 A：`web/assets/js/views/config.js:474`（`ensureModelEntry` 里新建条目 `{ ..., temperature: null, maxTokens: null, thinking: 'inherit', ... }`）、`config.js:525`（模型弹窗新建草稿同样 `temperature: null`）、`config.js:2406` 温度输入框 `placeholder="（空=功能默认）"`；`config.js:401-404` 数组整体提交（空串 `''` 也会被原样写进 `temperature`）。
- 证据 B：`apps/agent.js:1085` `const regTemperature = Number.isFinite(Number(regEntry?.temperature)) ? Number(regEntry.temperature) : null`，`apps/agent.js:1161` `temperature: regTemperature != null ? regTemperature : cfg.temperature`；`model/agent/provider/openai.js:54` `temperature != null` 即下发。`Number(null)===0` 且 `Number.isFinite(0)===true`。
- 打架点：面板/弹窗承诺「空=功能默认（继承全局 0.2）」，代码把「显式 null」和「字符串空」都算成合法数字 0 → 模型条目的温度被钉死为 0；同一段代码对 `maxTokens` 多了 `> 0` 保护（`apps/agent.js:1086`），说明是漏判。
- 影响面：所有按官方引导在 Web「模型列表」建主模型的用户——主对话与视觉子模型都变成 temperature=0（README 明确「勿设 0 避免复读式回复」），回复呆板/复读、工具循环更容易打转，且面板上看不出任何异常。
- 建议：真源改成「只有显式数字才覆盖」——运行时 `typeof x === 'number' && Number.isFinite(x)`（或先判 `x == null` 返回 null）；写入侧不要产出 `null`/`''` 温度（缺省就不写该键），弹窗 placeholder 与行为对齐。
- 置信度：高（写入侧与读取侧均已核对；跨 apps/** 的一行请 Lead 交 apps 审计员复核）

### C2 [P1] [P] 基础模型引用可清空/失效，但镜像字段继续生效 → 面板「未选择」而运行时用旧端点
- 证据 A：`web/assets/js/views/config.js:1097-1100` 厂商下拉含 `<option v-if="form.llmProviders.length" value="">（未选择）</option>`，`config.js:1107-1110` 模型下拉同样有「（未选择）」（`setBaseProvider` 只会在有模型时自动挑第一个，`config.js:466-469`；用户可以手动选回空）。`config.js:546` 主模型槽位 `set: (v) => { if (!v) form.modelId = '' }`。
- 证据 B：`utils/Config.js:117-129` `resolveBaseModel()` 在 `modelId` 为空或模型不属于该厂商时返回 `null`；`Config.js:169-177` `syncBaseModel()` 在 `resolved===null` 时**直接 return，不动镜像**；`Config.js:197-204` 只打一条 `Log.warn('基础模型引用失效…运行时仍在用上一次解析出的接入信息')`；`apps/agent.js:518-536` 运行时正是用 `cfg.protocol/preset/baseURL/apiKey/model` 构造主 provider。
- 打架点：yaml 注释（`config.yaml:9-13`、`:115-116`）宣称「单一真源是 providerId/modelId，镜像只读、随引用回填」；但只要引用不完整，**实际真源就退回镜像**。典型实景：用户从 A 厂商切到 B 厂商后没选模型 → 面板「（未选模型）」，运行时用 yaml 默认 `model: deepseek-chat`（`config.yaml:18`）打到 B 的 baseURL，表现为 404/模型不存在，用户对着「未选择」的面板无从排查。
- 影响面：换厂商/删模型/手抖选空的所有用户；`agent.model` 默认值非空（`deepseek-chat`）使问题必现。
- 建议：要么把「引用不完整」变成保存期硬错误（面板禁用保存 + 后端 400），要么在引用失效时清空镜像并让运行时明确「未配置主模型」；至少把 WARN 提升为面板可见状态（GET /api/config 带 `baseModelResolved: false`）。
- 置信度：高

### C3 [P1] [D] 回退模型双真源：Web 数组 vs 锅巴扁平，Web 删不干净
- 证据 A：`web/assets/js/views/config.js:678-679`（`addFallback/delFallback` 只操作 `form.fallbackModels`）、`config.js:1208-1213`（「回退模型链」只渲染 `form.fallbackModels`，全文件没有 `form.fallbackModel` 单数绑定）；`guoba.support.js:118-121` 只提供 `agent.fallbackModel/BaseURL/ApiKey/Protocol` 四个扁平字段；`config.yaml:24-36` 两套并存，注释称「锅巴面板单回退…多回退用上面数组」。
- 证据 B：`apps/agent.js:566-568` `const fbList = [...cfg.fallbackModels]; if (cfg.fallbackModel && cfg.fallbackApiKey) fbList.push({...})` —— 数组与扁平**取并集**，没有去重。
- 打架点：两个面板各自以为自己是回退链的唯一入口。用户在 Web 把「回退模型链」清空并保存，锅巴配的扁平回退仍在生效（还会被静默追加到链尾）；反之在锅巴改回退，Web 面板显示「没有回退」。同一模型在两处都配还会被尝试两次。
- 影响面：所有用过锅巴配单回退、之后转到 Web 面板的用户；排障时「我明明删了回退」无解。
- 建议：只保留 `fallbackModels` 数组为真源；锅巴的扁平字段改成读到时一次性迁移进数组并清空（或至少 Web 面板把扁平回退作为只读条目展示出来）。
- 置信度：高

### C4 [P1] [F] 数值项清空=「不提交」：maxTokens/contextWindow 无法回到「未配置」
- 证据 A：`web/assets/js/views/config.js:401-405`
  ```js
  } else if (typeof a === 'number') { const n = parseNum(b); if (n === null) continue; if (n !== a) out[p] = n }
  else if (b === '' && typeof a !== 'string') continue
  ```
  `parseNum`（`web/assets/js/components.js:557-561`）对 `''` 返回 `null` → 清空输入框永远不产生 diff。
- 证据 B：`config.yaml:94-95` `maxTokens:` / `contextWindow:` 默认就是**空**，`:96` 注释「未配置按消息条数水位（30→18）压缩」；面板 `config.js:1527-1531` 两个输入框 `placeholder="null"`，即 UI 鼓励用户「留空」。
- 打架点：UI 呈现「留空 = 未配置（走消息条数水位 / 厂商默认）」，但一旦填过数字，再清空保存 = **什么都没发生**（旧值仍在生效，且不报「无改动」）。用户以为关掉了 token 压缩，实际还在按旧窗口压缩。
- 影响面：调 `contextWindow`/`maxTokens` 后想回退的用户；表现为「配置面板空了但行为没变」。
- 建议：数值字段清空应提交 `null`（`out[p] = null`），后端 `setPath` 写 null 后由运行时按 `??` 兜底；或给每个数值框加显式「恢复默认」按钮并在 buildChanges 支持删除键。
- 置信度：高

### C5 [P1] [D/L] `agent.utilityModel` 两个控件两套选项集，且同页说明自相矛盾
- 证据 A：`config.js:1146`（基础卡）`<cfg-row full name="旁路小模型" desc="…只能从当前所选厂商的模型里选（旁路任务走主 provider 端点）">`，下拉选项只来自 `mainModels`（`config.js:1148-1153`，`v-for="m in mainModels"`，跨厂商模型只能以「（不在当前厂商下）」占位显示、无法选中）。
- 证据 B：同一页面「功能分配」卡把同一字段做成可选任意厂商：`config.js:547`（`{ key:'utility', get:()=>form.utilityModel, set:v=>{form.utilityModel=v} }`，选项来自 `knownModels`＝全注册表，`config.js:558-577`）、`config.js:1321-1328`（每行 desc 写「可选任意厂商（运行时按注册表解析端点）」）；`config.yaml:19` 注释「可来自任意厂商」；`apps/agent.js:940` `modelRouter.resolve(cfg.recall?.model || cfg.utilityModel || cfg.model)`。
- 打架点：同页 1318 行的块级说明还写「主端点类功能（旁路/记忆/评审/子代理/伪人/群世界）**只能用与基础模型同端点厂商**的模型」，而 1321-1328 行逐行说明写「可选任意厂商」，`FEATURES` 全部 `mainOnly:false`（`config.js:545-556`）——同一卡片内两份说明互相打脸，基础卡的下拉还按旧约束实现。
- 影响面：想把旁路/记忆/评审模型换成便宜跨厂商模型的用户，在基础卡根本选不到（必须知道去「功能分配」卡）；按 1318 行说明操作的用户会以为做不到。
- 建议：删掉 1318 行的旧约束说明；基础卡的「旁路小模型」下拉改用 `knownModels`（或直接移除该行，只保留「功能分配」卡这一个入口）。
- 置信度：高

### C6 [P1] [O] `cacheControl` 布尔 vs 三态字符串：首屏空白 + 保存后类型漂移
- 证据 A：`config.yaml:120` `cacheControl: false`（yaml 是布尔）；`config.js:1576-1580` 是 `<select v-model="form.cacheControl">`，选项只有字符串 `off / auto / explicit`。
- 证据 B：`apps/agent.js:1203` `cfg.cacheControl === true ? 'explicit' : (cfg.cacheControl === 'auto' || cfg.cacheControl === 'explicit' ? String(...) : 'off')`；`model/agent/Agent.js:332` 同样三态（说明运行时同时接受 bool 与字符串）。
- 打架点：`v-model` 把布尔 `false` 赋给 select → 无匹配 option，选中项为「空」，用户看不到当前实际值（实际是 off）；用户一旦选择「off」，YAML 里该键从 `false` 变成 `"off"`，类型被改，注释「默认 false」与实际不符。
- 影响面：所有打开「推理参数 → 高级」的用户都会看到空白控件；改动后产生无意义的类型漂移（外部脚本/文档按 bool 判断会失效）。
- 建议：二选一——yaml/文档统一成三态字符串（并把默认值写成 `off`），或面板改成布尔开关 + 「强制 explicit」二段式；总之别让同一 key 有两种类型。
- 置信度：高

### C7 [P1] [O] 锅巴 `kb.crawl.execution` 选项值 `host` 与 yaml/Web/代码的 `local` 不一致
- 证据 A：`guoba.support.js:273` `{ field:'agent.kb.crawl.execution', ... options:[{label:'宿主(推荐)', value:'host'}, {label:'沙箱', value:'sandbox'}] }`。
- 证据 B：`config.yaml:164` `execution: local  # local（默认）…| sandbox=…`；`config.js:104` `crawlExec: [['local','local 宿主 venv(默认)'],['sandbox','sandbox 会话沙箱']]`（`config.js:1903-1904` 同）；`model/crawl/index.js:430` `String(cfg?.crawl?.execution || 'local').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'local'`。
- 打架点：锅巴面板选「宿主」会把 `agent.kb.crawl.execution` 写成 `"host"`——一个任何文档/代码都不认的值；运行时按「非 sandbox 一律 local」处理（行为侥幸一致），但回到 Web 面板该 select 无 `host` 选项 → 显示空白；用户此时若在 Web 保存别的字段不会触发 diff，若动这个下拉则会把它改回 `local`（锅巴的选择被静默改写）。
- 影响面：用锅巴配置抓取执行面的用户；跨面板来回切换后配置值在 `host/local` 之间漂移。
- 建议：锅巴选项值改成 `local`（label 保留「宿主」）。
- 置信度：高

### C8 [P1] [P] `PUT /api/config` 允许写镜像字段并谎报成功（写了会被 Config.js 同步回填覆盖）
- 证据 A：`model/web/api.js:680-692` 只校验 `p.startsWith('agent.')`，然后 `setPath(cfg, p, val); n++`；`api.js:695-697` `Config.save(cfg)` 后返回 `ok(res,{applied:n},'已保存（已热加载）')`。
- 证据 B：`utils/Config.js:291-295` `save()` 第一行就 `normalizeBaseModel(data)`；`Config.js:169-177` `syncBaseModel()` 用 `resolveBaseModel()` 的结果**无条件覆盖** `protocol/preset/baseURL/apiKey/model`（`BASE_MODEL_MIRROR`，`Config.js:111`）——只要 `providerId/modelId` 有效。yaml:12-13 也注明这 5 项「只读镜像，每次加载自动回填，勿手改」。
- 打架点：接口层对镜像字段既不拒绝也不提示，计数 +1、返回成功；落盘前被归一覆盖。任何按「GET /api/config → 改一个值 → PUT 回去」写的客户端（外部脚本、未来表单、老版本面板）都会遇到「保存成功但值没变」，而且没有任何错误可查。
- 影响面：所有直接调 `PUT /api/config` 的集成方；面板暂未发送这些字段，属**潜伏**冲突，但接口是公共写口（锅巴/脚本共用同一套 `setPath` 语义）。
- 建议：在 `PUT /api/config` 显式拒绝（或忽略并记 `rejected`）`agent.protocol/preset/baseURL/apiKey/model`，提示「请通过 agent.providerId/modelId 选择」——与 `Config.js` 的注释一致。
- 置信度：高（接口行为确定；触发面取决于调用方，故列 P1 而非 P0）

### C9 [P1] [N/P] `PUT /api/config` 静默丢弃非 `agent.*` 路径，返回值仍称「已保存 N 项」
- 证据 A：`model/web/api.js:681` `if (!p.startsWith('agent.')) continue // 仅允许 agent.* 命名空间`——不 `n++`、不 push 到 `rejected`；`api.js:694` 只有 `rejected.length && !n` 才失败；`api.js:697` 消息按实际 `n` 报「已保存 N 项」。
- 证据 B：`config.yaml:1` `debug: false` 是顶层键，锅巴有入口（`guoba.support.js:98` `{ field:'debug', ... }`），Web 面板完全没有（`inventory.json`: `debug web=false guoba=true`）；`GET /api/config`（`api.js:66-69`）也只返回 `agent` 子树。
- 打架点：同一个「配置中心」写口，锅巴能改 `debug`、Web 连读都读不到；混合提交时前端拿到 HTTP 200 + 「已保存 N 项」，漏掉的部分完全没有反馈（对比 TTS 端点：`api.js:1093` 同样 `continue`，但 `api.js:1116` 在 `n===0` 时明确报错并列出支持字段）。
- 影响面：任何非 Web 面板发起的混合提交；用户/脚本以为改全了。
- 建议：非 `agent.` 前缀进 `rejected` 并在返回消息里列出（与 TTS 端点对齐）；若 `debug` 属面板能力，给 `GET/PUT` 增加白名单顶层键。
- 置信度：高

### C10 [P2] [X] 锅巴 `reply.renderScale` 帮助写「2=高清（默认）」，yaml/README/代码默认是 3
- 证据 A：`guoba.support.js:137` `bottomHelpMessage: 'deviceScaleFactor：2=高清（默认），1=普通；…'`，范围 `min:1,max:4`。
- 证据 B：`config.yaml:130` `renderScale: 3  # 3=超清默认`；`README.md:284` `| reply.renderScale | 3 | …`；`apps/agent.js:2423` `scale: cfg.reply?.renderScale ?? 3`；`config.js:1624-1625`（`desc="deviceScaleFactor 1~4"`，无默认值说明）。
- 打架点：锅巴把「默认」写成 2，实际默认 3；用户按锅巴说明以为当前是 2，或以为改成 2 是「恢复默认」（其实是从 3 降档）。
- 影响面：所有在锅巴改清晰度的用户；回复图清晰度/内存占用的判断依据错误。
- 建议：锅巴帮助改成「3=超清（默认）；2=高清；1=普通」。
- 置信度：高

### C11 [P2] [O/X] `stagehand.permission` 三方默认不一致：yaml/面板 `all`（全员），锅巴帮助与代码兜底 `master`
- 证据 A：`config.yaml:507` `permission: all        # all（全部成员）| master（仅主人）`；`config.js:174` 兜底 `form.stagehand.permission='all'`，`config.js:2168` 说明「permission=all 时全部成员可用」。
- 证据 B：`guoba.support.js:321` 同一功能块的帮助写「**仅框架主人可用**，act 写动作需 #确认」；`model/stagehand/index.js:45` `String(cfg.permission || 'master')…`（缺键时兜底 master，与 yaml 默认相反）。
- 打架点：默认值（all＝全员可用）与文档/兜底（仅主人）方向相反；一旦字段缺失（旧配置/手删），同一份代码会变成「仅主人」，与面板显示的全员可用不同。
- 影响面：Stagehand 权限判定；管理员以为默认安全（仅主人），实际默认对全员开放。
- 建议：统一为 master 兜底并把 yaml 默认改成 master（与锅巴说明一致），或反过来改文档；至少让 `|| 'master'` 与 yaml 默认同值。
- 置信度：高

### C12 [P2] [O] Web 兜底 `temperature=1` 与 yaml 默认 0.2 打架
- 证据 A：`config.js:172` `if (form.temperature == null) form.temperature = 1`。
- 证据 B：`config.yaml:50` `temperature: 0.2  # 工具调用稳定性（建议 0.1~0.3；勿设 0…）`；`guoba.support.js:124` 范围 0~2 step 0.1；运行时 `apps/agent.js:1161` 直接用 `cfg.temperature`。
- 打架点：凡配置里缺该键（手删、老版本迁移、`null`）的用户，面板显示 1（远离建议区间 0.1~0.3）而不是 0.2/让用户显式选择；而且这个 1 会被当成「用户改动」在下次保存时写进配置（`buildChanges` 认为 `orig.temperature===undefined !== 1`）。
- 影响面：配置缺字段者首屏即「越界值」，一保存就固化。
- 建议：兜底改成 0.2（与 yaml 对齐），或改成 `null`+placeholder「留空=厂商默认」。
- 置信度：中（触发需要配置缺键，正常合并后不会缺）

### C13 [P2] [O] `mock.js` 与真实默认值大面积不一致，却被 api.js 称为「事实标准」
- 证据 A：`model/web/api.js:3` 注释 `形状严格对齐 web/assets/js/mock.js（事实标准，非文档 TS）`；`mock.js:12` `trigger:'both'`、`:39` `maxTurns:25`、`:42` `thinking:{type:'enabled',…}`、`:127` `stt:{enable:false,…}`、`:291/306/316` 日志示例 `maxTurns: 50`。
- 证据 B：`config.yaml:4` `trigger: at`、`:39` `maxTurns: 200`、`:51` `thinking:`（null）、`:375` `stt.enable: true`；`README.md:268` maxTurns 默认 200。
- 打架点：`mock.js` 被冒烟测试（`web/dev/smoke.mjs:56`）和文档当作接口形状基准，但它连默认值都与 yaml 不一致（trigger/maxTurns/stt/thinking），用它渲染的面板/截图会展示一套不存在的配置。
- 影响面：开发/回归环境（生产 `index.html` 只加载 `store.js`，`store.js` 用空 reactive 覆盖 `MOCK`，故不影响线上）。
- 建议：mock 只保留「形状」，默认值从 yaml 生成（或标注为「示例值，非默认值」），避免它继续被引用为事实标准。
- 置信度：高（差异确定；严重度因仅开发期而 P2）

### C14 [P2] [N/X] 配置中心缺字段，与「§1 全量配置项」的自我定位不符
- 证据 A：`config.js:1` 头注释 `视图:配置中心(§1 全量配置项,可编辑 mock)`；`inventory.json` 中 `agent.perception.sparseInject/sparseThreshold`、`agent.search.timeout`、`agent.webApi.enable/port/publicUrl`、`agent.research.maxRounds/workerModel` 均 `web=false guoba=true`；`agent.rootTokenBudget`、`agent.jev.maxStateChars`、`agent.jev.thresholds.lowConfidence/highConfidence`、`agent.recall.usage.{containment,penalizeAfter,penalty}`、`agent.profile.inferAfter`、`agent.media.capsFromApi` 为 `web=false guoba=false`（任何面板都没有入口）。
- 证据 B：对应默认值与说明都在 yaml 里被当作可调项写注释：`config.yaml:246-247`（perception）、`:295`（search.timeout）、`:560-562`（webApi）、`:77`（jev.maxStateChars）、`:85-86`（jev low/highConfidence）、`:145-147`（recall.usage）、`:157`（profile.inferAfter）、`:232`（capsFromApi）、`:115`（rootTokenBudget）；其中 `lowConfidence/highConfidence` 是 Jev 决策链的活跃阈值（`model/agent/jev/decisions.js:36,135`）。
- 打架点：视图自称全量，实际有一批「只能手改 yaml 或去锅巴」的字段；Jev 六阈值里 Web 只给 4 个（`config.js:1195,1198,1891,2321`），漏掉的两个还是决策下限（`Math.max(terminalRiskFloor, highConfidence)`）。
- 影响面：只走 Web 面板的用户无法调这些字段；两个 Jev 阈值没有面板入口，调参只能改文件。
- 建议：要么补全表单（至少 jev 两阈值、search.timeout、perception 两项），要么把视图描述从「全量」改成「常用项」。
- 置信度：高（差集来自 inventory 交叉核对；个别字段可能由其他视图覆盖，见下表说明）

### C15 [P2] [N] 「常驻工具」清单只显示当前已注册工具，已配置但未注册的条目不可见/不可删
- 证据 A：`config.js:647-655` `allTools = computed(() => M.tools || [])`（来自 `GET /api/tools`，需 runtime 就绪：`api.js:154-158`），`toggleAlwaysOn` 只在已注册 id 上取反；模板 `config.js:1870-1882` 遍历 `toolCats/toolsByCat`，`v-if="!allTools.length"` 时整块替换为「工具列表加载中或运行时未就绪…」。
- 证据 B：`config.yaml:254-266` 给出 `toolDiscovery.alwaysOn` 的默认列表（12 项，含 `diagram_render`/`spawn_subagent` 等），锅巴用多行文本框（`guoba.support.js:164`）可看到全量文本。
- 打架点：配置里已有的 alwaysOn 条目，只要该工具当前未注册（工具包禁用、MCP 关闭、runtime 未就绪如 apiKey 未配），面板就**完全不显示**；用户勾选/取消别的工具时数组被整体替换式更新（`form.toolDiscovery.alwaysOn = [...a, id]`），这些幽灵条目原样保留——看不见、删不掉。
- 影响面：排查「为什么某工具总是常驻/为什么常驻列表空」的用户；runtime 未就绪时更是整块空白。
- 建议：把 `form.toolDiscovery.alwaysOn` 中不在 `/tools` 返回里的条目渲染成「（未注册）」标签（可点击删除），与 guoba 的可见性对齐。
- 置信度：高

### C16 [P2] [P] `thinkingAuto.enable=true` 时保存任意字段会把手写 `agent.thinking` 静默清成 null
- 证据 A：`config.js:275` `if (form.thinkingAuto.enable) form.thinking = null // 互斥…载入即归一`；这行在 `origSnapshot = JSON.parse(JSON.stringify(snap))`（`config.js:163`）**之后**执行 → `form` 与快照不等；`config.js:133` 还有 watch 在开关打开时同样置 null；`buildChanges` 因此把 `agent.thinking: null` 放进 changes。
- 证据 B：`config.js:919-933`（`thinkingOn`/`thinkingBudget` 计算属性说明 thinking 是 provider 原生 `{type,budget_tokens}`）；`config.yaml:52` 注释「开启后覆盖上面的手动 thinking」——运行时本来就会覆盖（`apps/agent.js:1131,1163-1168`），无需销毁原值；锅巴同样处理（`guoba.support.js:415`）。
- 打架点：注释承诺的是「覆盖」（可恢复），面板实现的是「载入即抹掉并写回磁盘」。用户手写的 `agent.thinking:{type:'enabled',budget_tokens:8000}` 只要开过 thinkingAuto 再保存任何无关字段，就永久变成 null；关掉 thinkingAuto 后手写配置再也回不来。
- 影响面：开过「思考自动决策」后又关掉的用户；手写/锅巴配置的 thinking 被吞。
- 建议：只做运行时覆盖，不在 syncForm/save 里改 `agent.thinking`；确需互斥时至少不把它写回磁盘。
- 置信度：高

### C17 [P2] [O/X] 「深度思考」开关：`{type:'disabled'}` 显示为「开」，开启时硬编码 16000 丢用户预算
- 证据 A：`config.js:919-922` `thinkingOn` 的 getter 是 `!!form.thinking`（任何对象都为真），setter 是 `form.thinking = v ? { type:'enabled', budget_tokens: 16000 } : null`；`config.js:930-933` `thinkingBudget` 在 `form.thinking` 为 null 时也显示默认 16000。
- 证据 B：运行时把 `thinking` 当 provider 原生对象透传（`apps/agent.js:1163` `thinking: regThinking || cfg.thinking || null`；`model/agent/Agent.js:1889`），并明确支持 `type:'disabled'`（`apps/agent.js:1084` `regEntry.thinking === 'off' ? { type:'disabled' }`）。
- 打架点：`{type:'disabled'}` 在面板显示为「深度思考：开」，用户据此以为在思考；关→开 一次会把原有 `budget_tokens`（如 8000）重置成 16000，属于额外静默改值。
- 影响面：手写 `thinking:{type:'disabled'}` 或用模型级 thinking=off 的用户；预算被改大导致单轮 token 成本上升。
- 建议：getter 改成 `form.thinking && form.thinking.type !== 'disabled'`；setter 保留 `form.thinking?.budget_tokens ?? 16000`。
- 置信度：中（`type:'disabled'` 主要由模型级字段产生，`agent.thinking` 直写少见）

### C18 [P2] [D] 视觉/Embedding 端点副本双源：选非主厂商时把 Key/地址抄进 `vision.*`/`recall.embed*`，之后不跟随
- 证据 A：`config.js:596-607` `onFeatureSel` 对 `vision` 写 `form.vision.protocol/preset/baseURL/apiKey = prov.*`，对 `embed` 写 `form.recall.embedBaseURL/embedApiKey`（同主厂商时反而清空）。
- 证据 B：运行时优先用注册表路由，未命中才回退这些副本：`apps/agent.js:1317-1345`（`vRoute.matched ? … : createProvider({ … apiKey: vcfg.apiKey || cfg.apiKey })`，`vRoute.matched` 时忽略 `vcfg.baseURL/apiKey`）；面板还把副本只读展示出来（`config.js:1848` `{{ form.vision?.baseURL ? ' @ ' + form.vision.baseURL : '' }}`）。
- 打架点：同一份 Key 存两处；用户在「厂商配置」换 Key 后，`vision.apiKey` 副本不更新（运行时有路由时用不到，一旦删了模型条目/引用失效就退回旧 Key），且 Web 面板对这两个副本没有独立编辑入口（选主厂商时被主动清空），用户无法发现。
- 影响面：换过 Key / 删过模型条目的用户会出现「主模型正常、识图 401」。
- 建议：只保留引用（`vision.model` / `recall.embedProvider`）为真源，删除自动写副本的逻辑；确需兜底时在读取侧实时从注册表解析，不要落盘复制密钥。
- 置信度：中（副本在路由命中时不影响，属潜伏分叉）

### C19 [P2] [O] 同一字段两面板 min/max 校验不一致（9 个）
- 证据 A（Web，`config.js`）：`jev.timeoutMs` 只 `min=500`（`:1185`）；`tempFiles.maxFiles` `min=1`（`:2038`）；`tempFiles.ttlHours` `min=1` 无上限（`:2035`）；`thinkingAuto.timeoutMs` `min=500`（`:1513`）、`maxBudget` `min=1024`（`:1516`）、`budgets.low/medium/high` `min=1024`（`:1519/1522/1525`）；`kb.crawl.sessionTtlHours` step=0.1（`:2055`）。
- 证据 B（锅巴，`guoba.support.js`）：`jev.timeoutMs min:500 max:60000`（`:209`）；`tempFiles.maxFiles min:10 max:100000`（`:286`）；`tempFiles.ttlHours min:1 max:720`（`:285`）；`thinkingAuto.timeoutMs max:15000`（`:189`）、`maxBudget max:128000`（`:190`）、`budgets.low/medium max:64000`（`:191-192`）、`high max:128000`（`:193`）；`sessionTtlHours step:1`（`:278`）。
- 打架点：同一 key 两个面板的有效取值域不同（如 `tempFiles.maxFiles` 锅巴最少 10、Web 可 1；`jev.timeoutMs` 锅巴封顶 60s、Web 可填 600000）。锅巴填的值回到 Web 面板会显示越界（箭头卡住），反之亦然；谁也没在运行时再校验（`api.js`/`Config.save` 都不 clamp）。
- 影响面：跨面板编辑同一配置的管理员；误以为「面板拦住了就是非法值」。
- 建议：把范围表提取成单一来源（如 `model/…/spec.js` 或 yaml 注释旁的元数据），两个面板共同消费。
- 置信度：高（核对为逐字段 min/max 扫描）

### C20 [P2] [P] 两道写门松紧不一：`/api/tts/config` 有白名单+clamp，`/api/config` 前缀全放行
- 证据 A：`model/web/api.js:1068-1119`：`SAFE_KEY` 白名单（只允许 `enable/provider/autoReply/replyMaxChars/hdVoice/judgeModel/judgeTimeoutMs` 与 5 个服务商前缀）、`BOOL_KEYS` 强转、`replyMaxChars` clamp 0~5000、数字 `Number.isFinite` 校验、`endpoint` 只允许 http(s)、其余字符串截断 500。
- 证据 B：`model/web/api.js:677-692`（`/api/config`）只有 `agent.` 前缀与原型链防护，然后 `setPath` 原样写入；`Config.save`（`utils/Config.js:291-295`）不做类型/范围校验。
- 打架点：同一份 `agent.tts.*` 配置，走 TTS 页面受白名单/类型/clamp 保护，走 `/api/config` 可以把它写成任意类型/越界值（例如把 `agent.tts.replyMaxChars` 设成 `"abc"` 或负数，把 `agent.tts.sovits.endpoint` 设成 `file:///etc/passwd`），下次 `normalizeTtsConfig`/请求时才炸。两条路径对同一数据给出不同可信度。
- 影响面：任何能发 `/api/config` 的客户端（面板其他视图、脚本、第三方集成）；TTS 端点的防护形同虚设。
- 建议：把 TTS 字段的校验抽成一个可复用的 `validateAgentPatch(path,value)`，`/api/config` 对 `agent.tts.*` 也调用；或在 `/api/config` 里把 `agent.tts.*` 转交同一实现。
- 置信度：中（需要非面板客户端主动构造；面板自身不会发这些路径）

### C21 [P2] [O/P] 「保存一个字段」= 把当时全部默认值固化成用户配置（默认值真源被快照化）
- 证据 A：`model/web/api.js:677` `const cfg = Config.get()`（= `load()` 里 `deepMerge(def, user)` 的全量合并结果，`utils/Config.js:229`），`:695` `Config.save(cfg)`；`Config.js:291-295` `save()` 把整份 `data` 交给 `writeUser()`（`Config.js:87-92` YAML 全量序列化）。
- 证据 B：`Config.js:230-235` 的自愈逻辑（`hasMissingKeys` → `writeUser(merged)`）本就会在升级时把全量默认写进用户配置；`config.yaml` 里的默认值/注释只存在于 `default_config/`（`Config.js:6-7` 注释「默认值来源」）。
- 打架点：第一次用 Web（或任何 `PUT /api/config`）保存后，用户 `config/config.yaml` 变成一份「当时的默认值快照 + 改动」。之后插件升级改默认值（如 `maxTurns`、`renderScale`、各种阈值），对老用户**完全不生效**——因为 `deepMerge(def, user)` 里 user 全都有键，`default_config` 成了只对新装用户有效的第二真源。
- 影响面：所有升级用户；表现为「升级说明说改了默认值，我这边没变」，排查成本高。
- 建议：保存时只写「与默认值不同的键」（diff-write），或在 yaml 里存 provenance（哪些键是默认继承）；至少让 `PUT /api/config` 只写本次 changes 的路径而不是全量。
- 置信度：中（行为确定；是否有意如此需 Lead 结合设计意图判断——注释只说了「用户 config 是程序生成、重写无损」，未提默认值冻结问题）

### C22 [P2] [F] 锅巴 `thinking` 虚拟字段的转换依赖「enable 与 budget 同时出现在 data 里」
- 证据 A：`guoba.support.js:338-340` `getConfigData` 把 `agent.thinking` 合成为 `{enable, budget_tokens}` 虚拟对象；`:356-363` `if ('agent.thinking.enable' in (data||{}))` 才做 `{type,budget_tokens}` 还原并删除那两个键。
- 证据 B：`utils/Config.js:291-295` 保存后；`apps/agent.js:1163` 运行时把 `cfg.thinking` 当 provider 原生对象整体透传（`{type:'enabled'|'disabled'|...}`），无 type 的对象会被原样发给厂商（`model/agent/provider/anthropic.js:237` `body.thinking = thinking`）。
- 打架点：如果锅巴只提交变更字段、而用户只动了「思考预算(tokens)」，`agent.thinking.enable` 不在 data 里 → 走通用 `setPath` 写入 `agent.thinking.budget_tokens`，若此时 `agent.thinking` 为 null（yaml 默认），会得到 `{budget_tokens:N}`（无 `type`）→ 下发给 Anthropic 的 `thinking` 非法；若锅巴每次提交全量，则这条不成立（需 Lead 按 Guoba-Plugin 实际行为判定）。
- 影响面：只用锅巴改思考预算的用户；错误表现是对话 400 或思考字段被厂商拒绝。
- 建议：在 `setConfigData` 里对 `agent.thinking.budget_tokens` 单独处理（无论 enable 是否在 data 中都走还原逻辑）。
- 置信度：中（取决于锅巴 setConfigData 的入参是「变更集」还是「全量」）

## 附录 A：三方差集（mandated 清单 1/2）
口径：yaml 叶子 542（`agent.*` 491）、锅巴 `field` 143、`config.js` 去重 `form.*` 路径 423（含 2 个 computed 包装：`memoryLimits.memory/user`、`thinking.budget_tokens`）。交叉核对用 `audit/tools/inventory.json`。

- **Web 独有（yaml 里没有该路径）**：0。423 个绑定除上述 2 个 computed 包装（其父对象在 yaml 里是 `null` 占位：`config.yaml:51` `thinking:`、`:131` `memoryLimits:`）外，全部能落到 yaml 叶子——即面板没有「发明字段」，但兜底默认值仍可能与 yaml 不同（见 C12）。
- **锅巴独有（yaml 有、Web 无）**：12 个 —— `agent.fallbackModel/BaseURL/ApiKey/Protocol`（C3）、`agent.perception.sparseInject/sparseThreshold`、`agent.search.timeout`、`agent.webApi.enable/port/publicUrl`、`agent.research.maxRounds/workerModel`、以及虚拟字段 `agent.mcp.serversJson`、`agent.thinking.enable/budget_tokens`（后三者由 `getConfigData/setConfigData` 合成，非真实配置路径）。
- **任何面板都没有入口（yaml 有、config.js 与 guoba 都没有，且经全 views 文本扫描确认非动态渲染）**：`agent.jev.maxStateChars`（`:77`）、`agent.jev.thresholds.lowConfidence/highConfidence`（`:85-86`）、`agent.rootTokenBudget`（`:115`）、`agent.recall.usage.containment/penalizeAfter/penalty`（`:145-147`）、`agent.profile.inferAfter`（`:157`）、`agent.media.capsFromApi`（`:232`），另有 `humanize.memory.minConsolidateMessages`、`humanize.persona.aliases`（置信度中，humanize 视图可能以动态方式覆盖）。（`agent.tts.*` 的 33 个"无 Web 绑定"是 TTS 页按 `model/tts/providers.js` 的 fields schema 动态渲染，不算缺失。）
- **枚举/范围对照**：`select` 默认值无匹配项 1 处（`cacheControl`，布尔 vs 字符串，C6）；`min/max` 与锅巴不一致 9 处（C19）；数值默认值越界 0 处（扫全部 `min=` 绑定的 `form.*`）；布尔/数字控件与 yaml 类型错配 2 处（`cacheControl` 真问题、`sandbox.mode` 为 YAML 1.2 下 `off` 字符串，非问题）。

## 附录 B：PUT /api/config 写入语义核验（mandated 清单 3/5）
- 点路径与 yaml 结构一致：是（`setPath` 逐段建对象，`utils/path.js:37-50`）；`agent.mcp.servers` 特殊处理为整图提交（`config.js:396-399`），与 `setPath` 替换语义一致。
- 允许写镜像字段：是（C8）。
- 白名单/静默失败：非 `agent.*` 静默丢弃（C9）；`agent.jev.apiKey` 掩码识别正确（`api.js:683-689`，`redact.js` 只掩码 jev key，其余明文，符合注释约定）。
- 整份覆盖/丢字段：不丢已知字段（写的是全量合并对象）；副作用是默认值快照化（C21）。
- 保存→热加载→归一→再 GET 闭环：`Config.save` 先归一（`Config.js:292`）再落盘，`api.js:696` 再 `reload(true)`；类型被改的路径有 `cacheControl`（bool→string，C6）、`agent.thinking`（对象→null，C16）、`vision.protocol/preset`（null→''，无害）；字段被丢弃的路径有 `maxTokens/contextWindow` 无法清空（C4）。

## 方法与限制
- yaml 用 PyYAML 解析（YAML 1.1），唯一受影响的 token 是 `config.yaml:473` 的 `mode: off`（PyYAML 读成 `False`）；本仓库 `yaml@^2.5.0` 是 YAML 1.2，`off` 仍为字符串，故未就此出条目。
- 未运行仓库测试/服务（只读审计，依赖静态证据 + `inventory.json` 交叉核对）；C1/C18/C20/C22 涉及 `apps/**` 与 `model/**` 的读取行，请 Lead 交对应审计员复核是否为同一根因。
