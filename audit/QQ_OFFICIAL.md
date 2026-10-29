# QQ 官方机器人（QQBot / QQ 频道）适配说明

> 版本：v1.42.0 ｜ 实现：`model/qqofficial/` ｜ 测试：`model/qqofficial/test.mjs`（85 断言）+ `stress/e2e/qqofficial.mjs`（25 断言）

## 1. 为什么需要适配

TRSS-Yunzai 通过独立的适配器插件接入 QQ 官方机器人（`Yunzai-QQBot-Plugin`，adapter id `QQBot`）
与 QQ 频道（`QQGuild`）。这类协议端的事件字段与 OneBot/ICQQ **完全不同**：

| 场景 | `user_id` | `group_id` | `adapter_id` |
| --- | --- | --- | --- |
| QQ 群（官方） | `<appid>:<member_openid>` | `<appid>:<group_openid>` | `QQBot` |
| 私聊 C2C | `<appid>:<user_openid>` | 无 | `QQBot` |
| 频道 | `qg_<openid>` | `qg_<guild_id>-<channel_id>` | `QQGuild` |
| 频道私聊 | `qg_<openid>` | 无 | `QQGuild` |

本插件原先假设「ID 是数字 QQ 号」的地方因此全部失效，且 `scopeId` 会作为**目录名**
（memory / sessions / evolution suggestion），含 `:` 的 openid 在 Windows 上非法。
同时官方协议提供了 OneBot 没有的能力：**原生 Markdown 消息** 与 **inline keyboard 按钮**。

## 2. 落地内容

### 2.1 协议识别与 ID 归一（`model/qqofficial/index.js`）
- `detectAdapter(e)`：优先读 `e.adapter_id/adapter_name`（兼容 `e.bot.adapter`），缺失时按 ID 形态兜底
  （`<self_id>:…` / `qg_…`）；返回 `{ kind:'qqbot'|'guild'|'other', official }`，**不会误判 OneBot 数字 ID**。
- `contextKind/contextLabel`：group / c2c / guild / guild_dm / private。
- `stripSelfPrefix/rawUserId/rawGroupId/splitGuildId`：去 `<appid>:`、`qg_` 前缀；频道拆 guild/channel。
- `safeScopePart(id)`：目录安全化 —— 纯 `[A-Za-z0-9_-]` 原样返回（**数字 ID 保持历史目录兼容**），
  否则把非法字符换成 `-` 并追加 8 位 FNV 短哈希防撞。
- `deriveScope(e, isolation)`：与 `apps/agent.js` 的 `ctxOf` 同口径（离线可测）。

### 2.2 回复链路（`apps/agent.js`）
- 官方适配器 + `qqOfficial.markdown.enable`（默认 true）+ 框架有 `segment.markdown` → **Markdown 直发**：
  - 不渲染图片，按 `qqOfficial.markdown.maxChars`（默认 3500）按行分片，代码块自动补围栏；
  - 首片带 @/引用，异常停止原因并入末片；
  - 适配器返回 `{error:[…]}` 且无 `message_id`（平台拒绝 md / 模板未申请）→ **自动降级纯文本**（`markdownToPlain`）重发一次；
  - 表情包标记剥除（不会漏 `[sticker:x]` 字面量），表情图作为独立图片消息追加（失败忽略）。
- 官方模式下 `progress`/`narrate` **默认关**（`qqOfficial.progress/narrate`），避免主动推送频控；
  `ctx.replyMode='markdown'` 供工具分流。
- 流式（`stream=true`）只在 text 模式下启用；官方 markdown 模式始终整段分片发送。

### 2.3 Markdown 卡片 + inline keyboard（`model/qqofficial/tool.js`）
- 新工具 `send_keyboard`（category `personal`，`meta.sideEffects=['message']`）：
  - 入参 `text`（markdown）/ `keyboard`（行×按钮，≤5×5）/ `templateId`+`params`（官方模板）；
  - 按钮三类：`callback`（点击后把文本当用户消息发回）、`link`、`input`；
  - **回调按钮默认仅触发者本人可点**（`permission: [e.user_id]`），`public:true` 才放开；链接按钮不限；
  - 只**排队**（`ctx.pendingCards`），由 app 层在最终回复后 `flushPendingCards()` 投递（顺序稳定、失败不影响终态）；
  - 单轮上限 3 张；非官方协议执行期返回 `unsupported_protocol`，框架无 markdown 段返回 `unsupported_framework`。
- 与 `diagram_render` 同约定：工具绝不直接 `e.reply`。

### 2.4 主人权限兜底（`model/qqofficial/guard.js`）
- 框架 `permission:'master'` 用 `cfg.master[self_id].includes(e.user_id)` 判定；官方 openid 不是 QQ 号 →
  **45 条主人指令原本在官方机器人下永远不可用**。
- `installMasterGate(plugin)`：构造器里把规则级 `master` 改写为 `all` + 打 `__masterGate` 标记，
  并一次性包裹原型方法：入口用 `isOfficialMaster()` 复核（`e.isMaster` 或 `agent.masters`
  命中「完整 `<appid>:<openid>`」/「去前缀 openid」），拒绝时给出 `/uid` 指引。
- 已接入：`apps/agent.js`、`apps/groupworld.js`、`apps/humanize.js`、`apps/web.js`、`apps/help.js`。
- OneBot 场景判定等价于框架（仅 `e.isMaster`），不改变既有语义。

### 2.5 排障指令（`apps/agent.js`）
- `/uid`（兼容 `#uid`，TRSS 默认把行首 `/` 转 `#`）：完整 user_id / 去前缀 ID / 适配器 / 上下文 / scopeId / 是否主人 + 配置位置。
- `/groupid`（兼容 `#groupid`）：完整/去前缀 group_id、频道拆 guild/channel、私聊说明无群聊 ID + 白名单配置位置。

### 2.6 其它 ID 兼容
- `apps/groupworld.js`：`#群世界状态`/`#群世界清理` 规则从 `\d+` 改为 `\S+`，解析支持「完整/去前缀」匹配白名单。
- `apps/humanize.js`：`#伪人记忆` 同上。
- `model/web/api.js`：`SCOPE_ID_RE` 放宽到官方净化形态（`u_…` / `g…(_u…)`，字母/数字/`_`/`-`），
  `/scopes` 用 `lastIndexOf('_u')` 反解；仍禁止 `.` `/` `..` 防穿越。
- `utils/DevLog.js`：会话日志文件名净化（官方 ID 的 `:` 不再进文件名，Windows 合法）。

### 2.7 配置与面板
- yaml：新增 `agent.qqOfficial`（markdown.enable/maxChars/templateId、keyboard.enable、progress、narrate）。
- Web 配置中心：新增「QQ 官方机器人」卡片（含协议差异提示 + 6 个字段）。
- 锅巴面板：新增「QQ 官方机器人（QQBot / 频道）」分组（6 字段），`agent.masters` help 补充官方 ID 用法。
- README：新增「🤖 QQ 官方机器人（QQBot / QQ 频道）适配」整节 + 详细配置表 + 指令表；
  开发指南：新增「附录 A：QQ 官方机器人协议与 OneBot 的差异（写工具/命令必读）」。

## 3. 验证

| 项 | 结果 |
| --- | --- |
| `node model/qqofficial/test.mjs` | 85 通过 / 0 失败（识别、ID、scope 安全、段构造、分片、工具、权限门、诊断） |
| `node --import ./stress/e2e/hooks.mjs stress/e2e/qqofficial.mjs` | 25 通过 / 0 失败（markdown 直发、拒绝降级、卡片顺序/权限、/uid、/groupid、主人兜底、日志路径安全） |
| `node scripts/run-tests.mjs` | 131 文件通过 / 0 失败 / 11 跳过 |
| Web 自检 | config-search 20 / feature-assign 46 / smoke 全过 |
| 锅巴 | `supportGuoba()` 369 field / 无重复 path |

## 4. 已知边界

- 频道不支持 OneBot 式 `segment.at`：官方/频道下自动跳过 `atSender`（引用与正文正常）。
- 官方「被动回复」窗口有限，长任务的多条消息仍可能被平台限制；已默认关掉进度/播报降低条数。
- `send_keyboard` 在 OneBot 部署下仍会注册（执行期返回 unsupported_protocol），便于多协议混部；
  如只需 OneBot 可在面板关掉 `qqOfficial.keyboard.enable`。
- Miao-Yunzai 等非 TRSS 框架没有 `segment.markdown/button`：自动退回纯文本/图片模式，功能不缺失、不报错。

---

# 附：自实现 QQBot 适配器（v1.43.0，AppID + AppSecret 直连）

## 1. 动机

TRSS 官方适配器（`Yunzai-QQBot-Plugin` + `qq-group-bot` SDK）的连接串是
`机器人QQ号:AppID:Token:AppSecret` 四段。其中 **Token（`Bot {appid}.{token}`）是 QQ 频道 v1 时代的鉴权遗留**；
官方文档（`开发文档 → 起步指南 → 接入票据`）明确写 **「Token(已弃用)：可用于调用开放接口的鉴权。Token 的鉴权方式已废弃，请使用更安全的 Access Token 鉴权方式」**，
现行方案只需 **AppID + AppSecret** 换 `access_token`（2026 文档统一地址 `api.bot.qq.com`，旧域名自动回退）：

```
POST https://api.bot.qq.com/app/getAppAccessToken
Body: { "appId": "...", "clientSecret": "..." }
Resp: { "access_token": "...", "expires_in": 7200 }
```

本插件因此自带一套完整适配器（零新增依赖：原生 `fetch` + 原生 `WebSocket`，Node<22 自动回退 `ws`）：
协议层 `model/qqbot/`，框架桥接 `apps/qqbot.js`。

## 2. 结构

| 文件 | 职责 |
| --- | --- |
| `model/qqbot/token.js` | AppID+AppSecret → access_token；按 appId 缓存、并发单飞、提前 5 分钟刷新、错误人话化 |
| `model/qqbot/api.js` | v2 REST：发消息（文本/markdown/富媒体）、撤回、富媒体上传、创建频道私信、交互应答、`msg_seq` 分配、错误码→人话 |
| `model/qqbot/gateway.js` | WebSocket 网关：HELLO→IDENTIFY/RESUME、心跳、DISPATCH、关闭码语义与退避重连（4004 不重连 / 4008 60s / 4006 清 session） |
| `model/qqbot/events.js` | 网关事件归一化（GROUP_AT/C2C/AT_MESSAGE/DIRECT/INTERACTION）→ 内部结构 |
| `model/qqbot/payload.js` | Yunzai 消息段 → 官方消息体：文本/markdown（含模板）/inline keyboard/富媒体/引用；键盘 5×5 裁剪与默认权限（回调仅触发者） |
| `model/qqbot/client.js` | 门面：start/stop/status、send（markdown 无权限自动降级并记忆）、媒体上传、事件分发 |
| `apps/qqbot.js` | 适配器桥接：注册到 `Bot.adapter`、`load()` 连账号、`Bot[id]` + pickFriend/pickGroup/pickMember、事件投递（`message.group.normal` / `message.private.friend`）、被动回复 5 次/msg_id、`#qqbot状态/重连/账号` |

ID 形态与既有 `qqofficial` 层完全一致：`<appId>:<openid>`（群/私聊）、`qg_<guild>-<channel>`（频道），
所以 `/uid`、`/groupid`、Markdown 直发、keyboard 卡片、主人兜底全部直接复用。

## 3. 配置（`agent.qqBot`）

```yaml
qqBot:
  enable: true
  appId: "102012345"
  appSecret: "***"
  accounts: []            # 多账号；与扁平字段二选一
  intents: 0              # 0=默认（GROUP_AND_C2C | INTERACTION | PUBLIC_GUILD_MESSAGES | GUILDS）
  markdown: auto          # auto / true / false
  preferMarkdownText: false
  sandbox: false
  apiBase: ""             # 默认 https://api.sgroup.qq.com
  tokenUrl: ""            # 默认官方 token 端点
```

## 4. 与旧适配器的关系

- **二选一**：本适配器与 `Yunzai-QQBot-Plugin` 同时连同一条机器人会重复收发（两份事件 / 两份回复）。
- 本适配器 `path=data/QQBotAgent/`（与对方的 `data/QQBot/` 不同），`Bot.adapter` 去重不会互相吞掉——
  这是刻意为之（便于用户先并排验证再切换），但**必须只启用一个**。
- 切换回官方插件：`agent.qqBot.enable: false` → 重启 → 恢复对方 token 配置。

## 5. 已知边界

- **频道富媒体**（图片/文件）暂不支持：跳过并记日志（QQ 群 / C2C 完整支持）。
- **语音**：按 `file_type=3` 上传，平台要求 silk，wav/mp3 可能被拒（日志可见错误码）。
- **主动消息**：受平台配额限制；同一 `msg_id` 被动回复最多 5 条，超出后降级主动消息（可能被拒）。
- **网关事件**：默认只订阅 群@ + C2C + 频道消息 + 按钮交互；入群/退群等生命周期事件未映射成 Yunzai notice（不影响对话）。

## 6. 验证

| 项 | 结果 |
| --- | --- |
| `node model/qqbot/test.mjs` | **135 断言**：token 缓存/单飞/错误、REST 路径与消息体、错误码人话、网关 IDENTIFY/RESUME/心跳/关闭码、intents 默认最小集与 4013 自动降级（只降不升/耗尽停止）、重复 close 去重、INVALID_SESSION 不提前重连、事件归一化、键盘/媒体/分片、client 发送与 markdown 降级 |
| `node --import ./stress/e2e/hooks.mjs stress/e2e/qqbot-adapter.mjs` | **43 断言**：模块加载注册适配器、账号归一化（扁平/多账号/缺密钥/intents=0 回落默认）、`Bot[id]`+pick*、事件字段（含 ID 拼接与 adapter_id）、被动回复 5 次上限、按钮回调投递、断连清理 |
| `node scripts/run-tests.mjs` | 见仓库提交记录（全量通过） |


---

# 附：Web「机器人账号」页（v1.44.0）

`#agents登录` → 左侧「系统 → 机器人账号」，用于管理自实现适配器的多账号，不用再手改 yaml。

## 页面能力

| 区域 | 功能 |
| --- | --- |
| 适配器状态卡 | 适配器是否就绪（是否在 Yunzai 进程内）、`agent.qqBot.enable` 开关状态、已连接/总数 |
| 接入提示卡 | 只需 AppID+AppSecret（Token 已废弃）、`/uid`/`/groupid`、被动回复窗口、Markdown 自动降级 |
| 账号卡片 | 名称/AppID、连接状态（含 session 前缀、最近关闭码与重连次数）、密钥是否配置（只显示 `••••••••`+尾 4 位）、Markdown 模式、沙箱标记 |
| 操作 | 连接 / 断开 / 编辑（AppSecret 留空=不修改，保存后自动重连）/ 删除（二次确认，同时断开）/ 复制 AppID |
| 添加/编辑表单 | AppID、AppSecret、显示名称、Markdown 能力（auto/true/false）、纯文本也走 Markdown、沙箱、intents（频道需 1073741825） |
| 顶部动作 | 刷新状态 / 重连全部（按当前配置 `stopAll + load`，改完 yaml 免重启） |
| 排障卡 | 鉴权失败(4004)、intents(4013/4914)、频控(4008)、会话(4006/4007/4009)、与 Yunzai-QQBot-Plugin 二选一 |

## 后端接口（`model/web/api.js`）

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/qqbot` | 账号列表 + 实时连接状态（**不回显 AppSecret**，只有 `hasSecret` / `secretMasked`） |
| `POST /api/qqbot/accounts` | 新增（appId 纯数字校验；缺 appSecret 拒绝；保存后自动 `enable=true` 并尝试连接） |
| `PUT /api/qqbot/accounts/:appId` | 编辑（appSecret 传空=保持原值；已连接会重连） |
| `DELETE /api/qqbot/accounts/:appId` | 删除并断开 |
| `POST /api/qqbot/accounts/:appId/connect` / `disconnect` | 连接 / 断开单个账号 |
| `POST /api/qqbot/reload` | 按当前配置重连全部（`stopAll + load`） |
| `GET /api/qqbot/status` | 适配器原始状态（网关 state/session/重连次数，排障用） |

连接接口带 10s 上限：握手未完成时返回「已发起（后台继续）」而不是让浏览器一直挂起；随后刷新状态即可。

## 账号存储（单一真源）

- 统一写 `agent.qqBot.accounts[]`；历史上写在 `agent.qqBot.appId/appSecret` 的扁平单账号，
  在**首次写操作**时自动迁入 `accounts[]` 并清掉扁平字段（`model/qqbot/accounts.js: normalizeAccountsConfig`）。
- 密钥只落配置、不回显；`GET /api/qqbot` 只给掩码；删除账号即删除密钥。
- 账号与适配器条目形状由 `toAdapterAccount()` 对齐（`apps/qqbot.js: normalizeAccounts` 同字段）。

## 验证

- `node model/qqbot/accounts.test.mjs` → 41 断言（读取/归一/增删改/掩码/适配器形状）
- `node --import ./stress/e2e/hooks.mjs model/web/api.qqbot.test.mjs` → 35 断言
  （真实 express router + 桩适配器 + 桩 Config：空配置/校验/新增连接/编辑保持密钥/断开/重连全部/状态合并/扁平迁移/删除）
- `node web/dev/smoke.mjs` → 新视图模板编译 + setup 通过；config-search / feature-assign 全过


---

# 附：intents 与无限重连排障（v1.45.1）

**现象**：启动后日志反复 `INVALID_SESSION → close 4006 → close 4013 → 重连`，attempts 1s/2s/5s… 越滚越大。

**原因（两层）**：
1. `agent.qqBot.intents: 0` 本意是「用默认订阅」，但适配器归一化把 0 原样传给网关 → IDENTIFY 携带 `intents=0` → 平台以 `close 4013 invalid intents` 拒绝。
2. 网关在 `op=9 INVALID_SESSION` 时**提前合成** `close 4006` 并关闭 socket；随后服务端真实 close 帧（4013）又到达 → 同一 socket 被算成两次断开 → 重连次数双倍递增、真实错误码被 4006 掩盖。

**修复**：
- intents=0/非正数一律回落 `33554432`（仅群@+C2C）；默认不再包含交互位（未开通会被 4013）。
- 4013/4914/4915 按「只降不升」自动降级：剥交互位 → 剥频道位 → 退到群最小集/频道单聊；成功 READY 即用该值。全部候选都被拒 → 停止重连并写清 `hint`（`#qqbot状态` 可见）。
- INVALID_SESSION 不再提前断开，等真实 close 码决定「清 session 重连」还是「降级 intents」；3s 未收到 close 才兜底断开。
- 同一 socket 的重复 close 只处理一次（socket 身份判等），重连次数不再双计。
- 启动日志与 `#qqbot状态` 显示当前 `intents`、最近 close code 与中文说明。

**按钮回调**：需要机器人在开放平台开通「交互」能力，并配 `intents: 100663296`（群@+C2C+交互）。默认 `intents: 0` 下卡片可正常展示，但点击不会回调；若填了未开通的位，连接会被 4013 拒绝（此时代码会自动降级，日志会说明）。


---

# 附：非 @ 群消息误触发 AI 回复（v1.45.3）

**现象**：QQ 群里发任意消息（未 @ 机器人）也会收到 AI 回复；日志 `mode=at inputLen=2` 却直接 `[agent] run start`。

**原因**：适配器 `_onMessage` 对**所有**群消息无条件补了一个 `{type:'at', qq:appId}` 段——设计时假设
「QQ 群机器人只能收到 @ 消息」，但开放平台开启「全量消息」权限后会同时推送 `GROUP_MESSAGE_CREATE`
（群内任意消息）。假的 at 段让框架 `e.atBot=true`，`agent.trigger=at` 于是对每条群消息都触发。

**修复**：
- `events.js` 归一化时计算 `atBot`：`GROUP_AT_MESSAGE_CREATE` 恒为 true；`GROUP_MESSAGE_CREATE` 看
  `mentions`（`is_you===true` 或 id/openid 与 appId 相符）；私聊/频道私信恒 false。
- 适配器只有 `atBot=true` 的群/频道消息才补 `at` 段；非 @ 群消息保留正文与「他人提及」信息投递
  （供伪人模式/群世界旁听），但不设置 atBot。
- 按钮点击 `INTERACTION_CREATE` 归一为 `atBot=true`（定向交互必须能触发）。
- `data._qqbot` 增加 `atBot/eventName`，排障时可直接看出该消息是否被判定为 @。

**验证**：`model/qqbot/test.mjs` 144 断言（新增 GROUP_AT/GROUP_MESSAGE±mentions/C2C/频道私信 atBot 判定与
mentionsBot 单元）；`stress/e2e/qqbot-adapter.mjs` 47 断言（新增非 @ 群消息不补 at 段、@ 时补 at 段、
按钮点击触发）。


---

# 附：官方机器人下云崽框架指令被 AI 抢占（v1.45.4）

**现象**：QQ 官方机器人连上后，`#设置主人`、`#重启`、`#帮助` 等 Yunzai 框架指令没反应
（或只看到 AI 在回答/无响应）。

**原因**：官方机器人群里通常只有被 @ 才会收到消息，用户只能发「@机器人 + #指令」；而本插件的
AI 触发是 catch-all 规则（`^[\s\S]*$` → `onTrigger`），@ 消息会先进 AI：
`atMode && isAt && text` 成立即当作提问处理并返回 true，框架的 system 插件（`#设置主人` 等）根本没机会执行。
私聊开启 `privateChat` 后同理。

**修复**：
- `onTrigger` 新增「指令透传」：文本以 `#`（含全角 `＃`）、`/`、`＊` 等指令前缀开头、且**不是**本插件触发词
  （默认 `#ai`）时，记一条 `[trigger] 指令透传` 日志并 `return false`——框架 loader 对 `res === false`
  会继续下一个插件（见 Yunzai `lib/plugins/loader.js`），于是 system/其它插件正常处理。
- 新增配置 `agent.commandPassThrough`（默认 `true`）；关掉后恢复「指令也当 AI 提问」的旧行为。
- 面板（Web 配置中心「基础/模型」、锅巴）与 README/FAQ 同步说明。

**框架主人兼容性**：TRSS `#设置主人` 会写入 `master: ["<self_id>:<user_id>"]`；官方适配器下
`self_id=appId`、`user_id=<appId>:<openid>`，写入后为 `appId:appId:openid`，框架解析（按第一个 `:` 切分）
得到 `master[appId] = ["appId:openid"]` 正好等于 `e.user_id` → 框架 `e.isMaster` 正常为 true，
`#重启` 等 master 指令随之可用。只给本插件授权则用 `/uid` + `agent.masters`。

**验证**：`stress/e2e/agent-trigger-permission.mjs` 19 断言（新增：@机器人+#设置主人/#重启/全角＃帮助 透传、
privateChat 下私聊指令透传、普通文本仍进 AI、`#ai` 触发词不受影响、`commandPassThrough=false` 恢复旧行为）；
`node model/qqbot/test.mjs` 144 断言、全量 138 文件通过。

---

# 附：Web 配置中心「主人列表」无法添加官方机器人 openid（v1.45.13）

**现象**：QQ 官方机器人主人 ID 形如 `807AC1596B40D96591A5ACBEB3CFFA4D`
（或完整 `<appId>:<openid>`），但 Web 配置中心「主人列表」输入后提示
「QQ 号需 5-11 位数字」，无法添加；只能手改 yaml 或锅巴。

**原因**：`web/assets/js/views/config.js` 的 `addMaster()` 把输入写死为 `/^\d{5,11}$/`。
官方机器人 `user_id` 是 openid（32 位十六进制），不是 QQ 号，被前端校验直接拒绝。

**修复**：
- 校验改为同时接受：QQ 号（5-12 位数字）、纯 openid（`807AC…`）、完整
  `<appId>:<openid>`、频道前缀 `qg_<openid>`；
- Web 输入框标签/占位符/宽度、锅巴 `agent.masters` 帮助、默认 yaml 注释、README 配置表同步；
- `/uid` 的回执提示 Web「主人列表」可直接粘贴。

**验证**：`web/dev/smoke.mjs` 新增 2 断言（三种官方 ID 形态可添加、非法 ID 仍拒绝）；全量测试通过。


---

# 附：官方机器人下指令文本翻倍导致精确匹配失效（v1.45.5）

**现象**：升级 v1.45.4 后，`#设置主人` / `#agents更新` 仍无反应，但 `#状态` 能用；
日志里框架打印的是 `[#设置主人#设置主人][...]`、`text=#设置主人#设置主人`。

**原因**：适配器在事件数据里同时给了 `message: [{type:'text',text:'#设置主人'}]` **和** `msg: '#设置主人'`。
TRSS `lib/plugins/loader.js` 的 `dealEvent` 会用消息段累加文本：

```js
case "text": e.msg = (e.msg || "") + this.dealText(i.text)
```

于是 `e.msg` 变成 `#设置主人#设置主人`。
- 前缀/包含型规则（`^#(状态|统计)`、`^#ai`）仍能命中 → 看起来「部分指令正常」；
- 精确匹配规则（`^#设置主人$`、`^#*(agents)(插件)?(强制)?更新$`、本插件大量 `^...$` 规则）全部失配 → 无响应。

**修复**：适配器不再预设 `data.msg`（保留 `raw_message` 供日志兜底），`e.msg` 完全交给框架由 `message` 段构建。
回归断言：`stress/e2e/qqbot-adapter.mjs` 模拟 `dealEvent` 累加后 `e.msg === '#设置主人'`，且 `^#设置主人$` 可命中。

**教训**：适配器只提供「原始消息段 + raw_message」；`msg` 是 TRSS 的派生物，预设会造成双写。


---

# 附：QQBot 适配器叶子级审计与加固（v1.45.6）

在修完「触发/指令透传/文本翻倍」后，按调用链向下追到叶子函数，又发现并修复 9 处问题：

| # | 叶子 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | `apps/qqbot.js: _passiveMsgId` | 只数次数、不看时间：长任务/队列回复超过 5 分钟后仍带过期 `msg_id` → 平台 304103/40034005，整条回复失败 | 按**触发消息时间**判 5 分钟窗口；Map 条目带 `{n,at}` 并清理过期项（防泄漏） |
| 2 | `_rawOpenid` | 不认 `qg_` 前缀：频道用户 `qg_U` 被当 openid 传给 `createDms` | 同时剥 `<appId>:` 与 `qg_` |
| 3 | `_sendGuildDm` | `source_guild_id` 取 `entry._lastGuild`（最近一条频道事件）：多频道下可能拿错源频道 | 优先本次事件 `guildId` → 按用户缓存 → 最后才回退最近事件；缓存 1h 过期 |
| 4 | `connect` / `_attachBot` | ① start 抛错留下半初始化 client；② 等待期间 disconnect 仍会挂载；③ READY 晚于 20s 超时后永不挂载（哑连接）；④ 轮询与事件双触发重复 attach | 失败清理；`_aborted` 中断等待；`state=ready` 事件补挂载；`_attachBot` 幂等 |
| 5 | `model/qqbot/api.js: request` | token 提前失效后所有请求 401 直到缓存自然过期（2h），只能重启 | 401/403 清 token 缓存重取并重试一次 |
| 6 | `client.start` | token 端点 5xx/网络抖动一次就抛 → 账号起不来 | 网络类退避重试 3 次；鉴权类快速失败 |
| 7 | `payload.buildMessageJobs` | Markdown 直发模式下 `atSender` 段被忽略 → 群里回复**不 @ 回复人** | at 段转 `<qqbot-at-user id="…"/>` / `<qqbot-at-everyone />` 拼进 markdown；id 字符白名单清洗防标签注入 |
| 8 | `client._sendMedia` | 本地大文件直接 `readFile` + base64（10MB→13MB 字符串）可能撑爆内存/请求 | 先 `stat`、base64 先算字节，>10MB 跳过并告警；不发起上传 |
| 9 | `gateway._identifyOrResume` | 取 token 失败一律按 4004「鉴权失败」→ 一次网络抖动永久掉线 | 网络/5xx 类继续退避重连并清旧 session；仅鉴权类停止并提示 |
| 10 | `_attachBot` | `fl/gl/gml` 永远为空（框架/第三方插件读这些映射）；`logout()` 不从 `Bot.uin` 摘除 | 收到消息增量回填好友/群/成员映射；`logout` 走 `disconnect`、`login` 走 `connect`（对齐 `#Bot下线/#Bot上线` 契约） |

**验证**：`model/qqbot/test.mjs` 168 断言（新增 401 刷新重试、start 重试/鉴权快失败、Markdown mention、
媒体体积守卫、网关 token 失败分类、被动窗口）；`stress/e2e/qqbot-adapter.mjs` 68 断言（新增被动窗口/ID 去前缀、
`_attachBot` 幂等、等待期断连快速返回、fl/gl/gml 回填、login/logout 生命周期）。


---

# 附：按钮卡片「触发者自己点击提示无权限操作」（v1.45.7）

**现象**：模型通过 `send_keyboard` 发的卡片，**同一用户**点自己触发的按钮，QQ 客户端弹「无权限操作」；
更换按钮权限配置也无济于事。

**根因（两层）**：
1. **群聊**：`keyboard.action.permission.specify_user_ids` 只认**平台原始 openid**；TRSS 侧 `e.user_id`
   是 `<appId>:<openid>`，`qqofficial` 卡片路径与适配器都没剥前缀 → 平台匹配不到点击者，判定无权限。
2. **私聊（C2C / 频道私信）**：QQ 客户端**不支持** `permission.type=0`（指定用户）按钮——点击连
   `INTERACTION_CREATE` 都不产生（参考实现 dsh-qqbot 实测：私聊里 type:0 选项按钮点不动，
   同一张卡上 type:2 的按钮却能点）。

**修复**：
- `model/qqbot/payload.js: buildKeyboard` 统一归一化权限用户 id：剥 `<appId>:` 与 `qg_` 前缀，
  仅保留 `[A-Za-z0-9_-:]`；空结果回落 `type:2`。
- `buildKeyboard`/`buildMessageJobs` 新增 `scene` 维度：`c2c`/`guild_dm` 强制 `type:2`
  （私聊只有对方一人可点，安全等价）；`admin` 权限在私聊也降级为 `type:2`。
- `model/qqofficial/tool.js: flushPendingCards` 的 `ownerId` 改用 `rawUserId(e)`（平台原始 openid），
  与适配器归一化形成双保险。
- 适配器 `client.send` 把 `scene` 传入消息构造。

**验证**：`model/qqbot/test.mjs` 179 断言（新增：群聊 ownerId/permission 数组剥前缀、私聊强制 type:2、
admin 降级、scene 透传）；`model/qqofficial/test.mjs` 86 断言（卡片 flush 权限用原始 openid）。
