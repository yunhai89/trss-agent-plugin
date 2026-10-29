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
| `node model/qqbot/test.mjs` | **105 断言**：token 缓存/单飞/错误、REST 路径与消息体、错误码人话、网关 IDENTIFY/RESUME/心跳/关闭码、事件归一化、键盘/媒体/分片、client 发送与 markdown 降级 |
| `node --import ./stress/e2e/hooks.mjs stress/e2e/qqbot-adapter.mjs` | **39 断言**：模块加载注册适配器、账号归一化（扁平/多账号/缺密钥）、`Bot[id]`+pick*、事件字段（含 ID 拼接与 adapter_id）、被动回复 5 次上限、按钮回调投递、断连清理 |
| `node scripts/run-tests.mjs` | 见仓库提交记录（全量通过） |
