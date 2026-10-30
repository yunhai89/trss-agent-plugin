# QQ 官方机器人接入与协议差异

> 本文是主 README 的拆分文档。返回 [README](../../README.md)。

## 🤖 接入方式与 QQ 官方机器人

### 三种接入方式对比

| | OneBot / ICQQ | **自实现 QQBot 适配器（本插件）** | Yunzai-QQBot-Plugin |
| --- | --- | --- | --- |
| 需要什么 | QQ 号登录协议端 | **AppID + AppSecret**（两段） | 机器人QQ号 + AppID + Token + AppSecret（四段） |
| 谁在连接 | 外部协议端 | **本插件内建**（WebSocket + v2 REST） | 第三方适配器插件 |
| Markdown / 按钮卡片 | ❌（转图片或纯文本） | ✅ 原生支持 | ✅（依赖对方适配器） |
| ID 形态 | 数字 QQ 号/群号 | openid：`<appId>:<openid>` / `qg_...` | 同左 |
| 管理入口 | 协议端面板 | **Web「机器人账号」页** + `#qqbot*` 指令 | 对方插件 |
| 建议 | 个人号/自建 | ✅ 官方机器人首选 | 已有部署可继续用 |

> ⚠️ **自实现适配器与 Yunzai-QQBot-Plugin 二选一**：同一机器人同时连两个适配器会**重复收事件、重复回复**。

> 本章覆盖**两种官方接入**：本插件内建适配器（推荐，只需 AppID + AppSecret）与
> [Yunzai-QQBot-Plugin](https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin)（四段连接串，已有部署可继续用）。
> OneBot/ICQQ（NapCat 等）用户不需要本章任何配置，行为与以前完全一致。

### 自实现适配器：只需 AppID + AppSecret（推荐）

TRSS 官方 QQBot 适配器（[Yunzai-QQBot-Plugin](https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin)）的连接串是
「机器人 QQ 号 : AppID : Token : AppSecret」四段——其中 **Token 是 QQ 频道 v1 时代的遗留鉴权**。
官方文档已明确标注 **「Token（已弃用）」**：现行开放平台只需 **AppID + AppSecret** 换取 access_token
（`POST https://api.bot.qq.com/app/getAppAccessToken`，旧域名 `bots.qq.com` 仍可用，插件会自动回退），
因此本插件内置了一套完整适配器（网关 WebSocket + v2 REST），**填两段密钥即可连**，不依赖第三方适配器插件：

```yaml
agent:
  qqBot:
    enable: true
    appId: "102012345"        # QQ 开放平台 → 开发设置 → 机器人 AppID
    appSecret: "xxxxxxxx"     # 开发设置 → AppSecret（敏感：回复发送前会脱敏）
    # 多账号（可选，与上面扁平字段二选一）：
    # accounts:
    #   - { name: 主号, appId: "102012345", appSecret: "xxx" }
    #   - { name: 二号, appId: "102054321", appSecret: "yyy", sandbox: true }
    markdown: auto            # auto=先试 Markdown、无权限自动降级纯文本并记忆
    intents: 0                # 0=默认只订「群@ + C2C」=33554432；按钮交互=100663296，频道=1073741825
                              # 填了平台未开通的位会被 close 4013 拒绝——适配器会自动降级重连并在日志说明
```

**启用步骤**

1. **推荐用 Web 面板「机器人账号」页**（`#agent登录` → 左侧「系统 → 机器人账号」）：
   点「添加账号」填 AppID + AppSecret 即保存并自动连接；页面还提供连接/断开/编辑/删除、实时状态与排障提示。
   也可直接改 yaml（见上）或用聊天指令 `#qqbot账号` 只读查看。
2. 首次启用需重启 Yunzai（适配器在框架 Listener 阶段注册；之后改配置可在页面点「重连全部」或发 `#qqbot重连` 热重连）；
3. 群里 @ 机器人发一句话即可对话；发 `/uid`、`/groupid` 配主人与白名单（见下节）。

**管理指令**（主人）：

| 指令 | 作用 |
| --- | --- |
| `#qqbot状态` | 各账号连接状态、session、Markdown 是否可用 |
| `#qqbot重连` | 断开并按当前配置重连全部账号（改完配置不用重启） |
| `#qqbot账号` | 当前配置的账号列表（AppID 与沙箱标记，不打印密钥） |

**能力与边界**

| 项 | 支持情况 |
| --- | --- |
| QQ 群 @消息 / 私聊（C2C） / 频道消息 / 频道私信 | ✅ 收发（频道私信首次自动建 DM 会话） |
| 被动回复 | ✅ 5 分钟窗口内自动带 `msg_id`，同一 `msg_id` 最多 5 条，超出降级主动消息 |
| Markdown 消息 | ✅ `markdown: auto` 先试；机器人没开通权限（`304036`）自动改纯文本并记忆，不刷错误 |
| inline keyboard 按钮 | ✅ `send_keyboard` 工具；回调点击当作「用户发了一句话」投递（命令/权限全复用）。⚠️ 接收点击事件需该机器人已开通「交互」能力并配 `intents: 100663296`；未开通时自动降级为仅群@+C2C（按钮仍可展示，点击不回调） |
| 图片/文件 | ✅ 群与私聊走富媒体上传（URL 或本地文件 base64）→ `msg_type=7`；**频道暂不支持富媒体**（会跳过并记日志） |
| 长文本 | ✅ 3800 字一段分片发送 |
| 主动消息 | ⚠️ 受平台配额限制；本插件在窗口内优先被动回复 |
| 断线重连 | ✅ 按官方关闭码处理（4004 鉴权失败不重连、4008 频控 60s、4006/4007/4009 清 session 重连），指数退避 |

> ⚠️ **与 Yunzai-QQBot-Plugin 二选一**：两个适配器同时连同一条机器人会各收一份事件、各发一份消息（重复回复）。
> 想切回官方适配器：先停用本插件适配器（`agent.qqBot.enable: false` 并重启），再恢复对方的 token 配置。

### 群聊触发：只对真正 @ 的消息回复

QQ 群机器人在开放平台开启「全量消息」权限后，除了 `GROUP_AT_MESSAGE_CREATE`（@机器人）还会推送
`GROUP_MESSAGE_CREATE`（群内任意消息）。适配器按**事件类型 + mentions.is_you** 判定是否真的 @ 了机器人：

- 只有真正 @ 的群消息才会补 `at` 段 → 框架 `e.atBot=true` → `trigger=at` 才触发回复；
- 普通群消息照常投递（供伪人模式/群世界旁听与学习），但**不会触发 AI 回复**；
- 按钮点击（`INTERACTION_CREATE`）视为定向交互，正常触发；
- 私聊/频道私信无需 @。

> 若你把 `agent.trigger` 配成 `both`，群里发 `#ai 内容` 也会触发——这是命令模式，不是误触发。

### 协议差异：ID 不是 QQ 号

官方机器人返回的 ID 是 **openid**，不是 QQ 号/群号：

| 场景 | `user_id` | `group_id` |
| --- | --- | --- |
| QQ 群 | `<appid>:<member_openid>` | `<appid>:<group_openid>` |
| 私聊（C2C） | `<appid>:<user_openid>` | 无 |
| 频道 | `qg_<openid>` | `qg_<guild_id>-<channel_id>` |
| 频道私聊 | `qg_<openid>` | 无 |

因此**按 QQ 号配置的东西在官方机器人上不会生效**（主人列表、群白名单、`#群世界清理 <群号>` 等）。
插件已做兼容：ID 全链路按字符串处理、`scopeId` 目录安全化（数字 ID 仍原样，官方 openid 净化后加短哈希，Windows 也不会因 `:` 报错）。

### 两个排障指令：`/uid`、`/groupid`

| 指令 | 作用 |
| --- | --- |
| `/uid`（也认 `#uid`） | 打印发言人「完整 user_id / 去前缀 ID / 适配器 / 上下文 / scopeId / 是否主人」 |
| `/groupid`（也认 `#groupid`） | 打印当前群「完整 group_id / 去前缀 ID / 适配器 / 上下文」；频道会拆出 guild_id 与 channel_id；私聊会说明没有群聊 ID |

> TRSS-Yunzai 默认把行首 `/` 转成 `#`（`config.bot["/→#"]`），所以两种写法都能用。

示例（QQ 群）：

```
【发言人 ID】
完整 user_id：1024:U_OPENID
去前缀：U_OPENID
适配器：QQBot（QQ 官方机器人）
上下文：群聊
是否主人：否
scopeId：g1024-G_OPENID_u1024-U_OPENID
```

### 云崽（框架）指令与主人设置

官方机器人下框架指令同样可用（v1.45.4 起「指令透传」）：

- 群里必须 **@机器人 + `#指令`**（没有「全量消息」权限时）；开了全量消息权限后也可直接发 `#指令`；
- 以 `#`（含全角 `＃`）、`/` 等开头且不是本插件触发词（默认 `#ai`）的消息，会**交给 Yunzai 与其它插件处理**，
  不再被 AI 抢走；关闭 `agent.commandPassThrough` 可恢复旧行为；
- 第一次设置框架主人：私聊或 @机器人 发 **`#设置主人`** → 按提示回复验证码（TRSS 官方流程），
  完成后 `#重启` / `#状态` / `#帮助` 等框架指令即可用（框架按 `self_id:user_id` 记录，兼容官方 bot 的 openid 前缀）；
- 只给**本插件**授权主人：发 `/uid`，把「完整 user_id」加进 `agent.masters`（两条路互不影响；
  `#设置主人` 影响整个框架，`agent.masters` 只影响本插件）。

### 主人配置（官方机器人必看）

框架的 `permission: 'master'` 用 `e.user_id` 比对主人列表，而官方 `user_id` 是 `1024:U_OPENID` 这种形态，**填 QQ 号永远匹配不上**，表现为所有主人指令回「暂无权限」。
本插件已把规则级 master 校验下沉到插件内，两种方式任选：

1. **插件内（推荐）**：把 `/uid` 的「完整 user_id」或「去前缀 ID」加入 `agent.masters`（Web 配置中心 / 锅巴 panel / yaml 均可；Web「主人列表」输入框已支持直接粘贴 `807AC…` 这类 openid）。官方机器人下 `agent.masters` 同时用于审批通知与主人权限。
2. **框架层**：把同样的值加入 Yunzai 的 `config/config.yaml` → `master`（按 `self_id` 分组的列表）。

### Markdown 直发（默认开）

官方适配器支持原生 Markdown 消息，插件在官方协议下**自动改为 Markdown 直发**，不再把回复渲染成图片（`agent.reply.mode` 在官方下被忽略）：

- 长回复按 `agent.qqOfficial.markdown.maxChars`（默认 3500）按行分片发送，代码块会补闭合围栏；
- 平台拒绝 markdown 时**自动降级为纯文本**（剥掉 md 标记），不会丢消息；
- 需要官方模板消息时填 `agent.qqOfficial.markdown.templateId`（后台申请）。

```yaml
qqOfficial:
  markdown:
    enable: true      # 官方协议下 Markdown 直发（不渲染图片）
    maxChars: 3500    # 单条上限（超出分片；官方约 4000）
    templateId: ""    # 可选：官方 Markdown 模板 ID
```

### 按钮卡片（keyboard）与 `send_keyboard` 工具

官方机器人支持 inline keyboard。开启 `agent.qqOfficial.keyboard.enable`（默认开）后，模型可调用 `send_keyboard` 发「Markdown 正文 + 按钮」卡片。

> **按钮权限（v1.45.7 修复）**：群里回调按钮默认「仅触发者可点」——`permission.type=0` 的
> `specify_user_ids` 必须是**平台原始 openid**（框架侧 `e.user_id` 是 `<appId>:<openid>`，直接下发会让
> 本人点自己的按钮也提示「无权限操作」；适配器已自动剥前缀）。**私聊（C2C/频道私信）** 客户端不支持
> type:0 按钮（连点击事件都不产生），适配器会自动降级为 `type:2`（私聊仅对方一人，安全等价）。
>
> **回调事件与 intents**：要让「点击」真的变成一条用户消息，需要该机器人在开放平台开通「交互」能力，并把账号 `intents` 配成 `100663296`（群@+C2C+交互）；默认 `intents: 0`（=33554432，仅群@+C2C）下按钮可正常展示、但点击不会回调。填了未开通的位会被平台以 `4013 invalid intents` 拒绝连接——适配器会自动降级重连并在日志说明原因。

- 最多 **5 行 × 每行 5 个**按钮；单轮最多 **3 张**卡片；
- 按钮三类：`callback`（点击后把文本当作该用户发言发回，常写插件命令，如 `#确认 12`）、`link`（打开网址）、`input`（填输入框）；
- **回调按钮默认只有触发者本人可点**（防他人代点高危命令）；需要所有人可点时显式传 `public: true`，链接按钮不受限；
- 卡片在**本轮最终回复之后**投递，保证「进度 → 正文 → 卡片」的顺序；发送失败不影响对话终态。

模型侧调用示例（工具参数）：

```json
{
  "text": "### 下一步\n请选择要执行的操作",
  "keyboard": [
    [{ "text": "继续", "callback": "#ai 继续" }, { "text": "看文档", "link": "https://example.com" }],
    [{ "text": "输入自定义指令", "input": "#ai ", "send": false }]
  ]
}
```

### 官方模式下默认静音进度

官方机器人主动推送有频控/需权限，因此 `agent.qqOfficial.progress`、`agent.qqOfficial.narrate` **默认关**（不发「思考中…」与中途播报）。需要时打开：

```yaml
qqOfficial:
  progress: true   # 思考中…等进度
  narrate: true    # 中途播报
```

### 常见问题

- **按 QQ 号配白名单/主人不生效**：官方 openid ≠ QQ 号，请用 `/uid`、`/groupid` 的输出配置。
- **频道里没有被 @ 到**：频道不支持 OneBot 式 `segment.at`，官方机器人下已自动跳过 @（引用/正文仍正常）。
- **回复偶尔只发出一条**：官方「被动回复」窗口有限（约 5 分钟/条数限制），本插件已在官方模式默认关掉进度与播报来减少消息条数。
- **按钮点了没反应**：确认按钮是 `callback` 且当前协议为官方；回调走的是「把文本当用户消息」的通道，需要对应命令/触发词存在。
- **Miao-Yunzai 等非 TRSS 框架**：`segment.markdown/button` 不存在 → 插件自动退回纯文本/图片模式，不会报错。

---
