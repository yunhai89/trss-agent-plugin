<div align="center">

# 🤖 Yunzai AI Agent Plugin

**Yunzai / Miao-Yunzai 的模块化 AI Agent 插件** —— 不只是聊天机器人：
多模型对话 · 工具调用 · 长期记忆 · 人设 · 多模态 · MCP · 群管 · E2B 沙箱 ·
**工具进化（Tool Evolution）** · **QQ 官方机器人适配（Markdown / 按钮卡片）** · **Web 管理面板**。

*A modular AI Agent plugin for Yunzai with self-evolving tools.*

一个插件，从「能回话」到「能干活、能记住、能进化」的完整闭环。

<img src="https://img.shields.io/badge/version-v1.46.3-blueviolet" alt="Version">
<img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="License">
<img src="https://img.shields.io/badge/platform-Yunzai-9cf" alt="Yunzai Plugin">
<img src="https://img.shields.io/badge/AI-Agent-7c3aed" alt="AI Agent">
<img src="https://img.shields.io/badge/QQ-Bot-12b7f5" alt="QQ Bot">
<img src="https://img.shields.io/badge/Node-ESM%20%7C%20%E2%89%A518-success" alt="Runtime">
<img src="https://img.shields.io/badge/QQ%E7%BE%A4-960179589-green" alt="QQ Group">

**QQ 群**：[960179589](https://qm.qq.com/q/960179589) ｜ **作者 QQ**：3891977697

[快速开始](#-安装与快速开始) · [文档导航](#文档导航) · [常见问题](#常见问题) · [更新日志](docs/changelog.md) · [开发指南](开发指南.md)

</div>

---

## 这是什么

一个跑在 Yunzai / Miao-Yunzai 里的 AI Agent 插件：把大模型对话、工具调用、长期记忆、人设、多模态、MCP、群管、沙箱和 Web 管理面板做成一套完整运行时。

- **对话与工具**：ReAct 多轮、并行工具、按需工具发现、结果截断、预算与终止器。
- **模型接入**：OpenAI / Anthropic / Gemini 三协议；厂商 + 模型引用制；跨厂商回退。
- **记忆与人设**：`MEMORY.md` / `USER.md`、长期记忆召回、用户画像、知识库 RAG、人设资料库。
- **官方机器人**：自实现 QQ 官方适配器（AppID + AppSecret），支持 Markdown / inline keyboard / 被动回复。
- **执行面**：E2B 沙箱终端、crawl4ai 网页抓取、Stagehand 浏览器自动化（可选）。
- **工程化**：配置热加载、工具 RBAC、审批、注入防御、离线测试、Web 配置中心。

## 适合哪些场景

- **QQ 群 / 私聊 AI 机器人**：接入 OneBot（NapCat / Lagrange）或 Yunzai 现有协议端。
- **QQ 官方机器人**：AppID + AppSecret 直连，支持 Markdown、inline keyboard、被动回复。
- **LLM 工具调用与自动化**：多轮 ReAct、并行工具、MCP、定时任务、子代理、E2B 沙箱终端。
- **长期记忆与知识库**：`MEMORY.md` / `USER.md`、用户画像、RAG、语义召回。
- **人设与多模态**：人设库、图片理解、语音合成、表情包、示意图、ComfyUI 画图。
- **多模型管理**：OpenAI / Anthropic / Gemini 兼容端点，厂商 + 模型引用制，Web 面板统一配置。

> ⚠️ **状态说明**
> - ✅ 核心能力（多模型 / 工具 / 记忆 / 人设 / 图片渲染 / MCP / 群管 / Web 面板）稳定可用。
> - 🤖 QQ 官方机器人：内置自实现适配器，只需 **AppID + AppSecret**；Web 面板有「机器人账号」页。
> - 🧪 深度研究 / 伪人模式 / 群聊小世界 / Stagehand 为早期功能，效果受模型与网络影响。
> - 💻 终端执行是可选高危能力，默认关闭；开启后命令跑在 E2B 沙箱内。

---

## 🚀 安装与快速开始

**三步即可用**：装插件 → 配模型 → 选协议端。

### 1. 安装

```bash
# Gitee（国内推荐）
git clone https://gitee.com/YunXi-67/trss-agent-plugin.git ./plugins/agents-plugin
# 或 GitHub
git clone https://github.com/yunhai89/trss-agent-plugin.git ./plugins/agents-plugin

cd ./plugins/agents-plugin && pnpm install   # markdown 渲染依赖（用 npm 亦可，但会多出 package-lock.json）
```

> 其余依赖随 Yunzai 提供（`ws` / `sharp` / `puppeteer` 等）。`#agent更新` 检测到 `package.json` 变动会自动 `pnpm install`。
> 重启 Yunzai 后，插件会在**自己的** `plugins/agents-plugin/config/config.yaml` 生成配置（不在 Yunzai 根；旧的 `Yunzai/config/agents-plugin.yaml` 会自动迁移）。

### 1.5 首次启动：先拿到面板地址（无需协议端）

**这一步解决了「没有协议端 → 发不了 `#agent登录` → 进不去面板」的死锁**：

- 插件启动时，日志会直接打印**带 token 的面板访问地址**（本地 / 内网 / 可探测到的公网）：
  ```
  [web] 面板默认访问地址（带 token，无需 #agent登录；协议端未配置时也能进面板配模型）
  [web]   本地  http://127.0.0.1:6098/?token=xxxxxxxx
  [web]   内网  http://192.168.1.7:6098/?token=xxxxxxxx
  ```
- 同一份地址也写到插件目录 **`data/web/console-url.txt`**（权限 600），方便事后找回；
- **面板服务不依赖 QQ 连接，也不依赖模型运行时**：即使一行配置都没有，也能打开面板 → 配置中心填模型，保存即热加载；
- 令牌默认 30 天有效（使用中自动续期，过期后下次启动自动换新）；不想在日志里出现，可设 `agent.webApi.printTokenOnStart: false` 关闭，或删 `data/web/console-token.json` 让下次启动重新生成；
- 已配好协议端后，仍可私聊机器人发 **`#agent登录`** 获取 24h 会话令牌（两条消息分别给公网/本地地址）。

### 2. 配模型（引用制）

**推荐**：主人私聊机器人发 **`#agent登录`**，打开 Web 面板「配置中心」：
**厂商配置**（接口地址 + Key）→ **模型列表**（在该厂商下挂模型）→ **基础 / 模型**（选中厂商与模型）。保存即热加载。

手写 yaml 的等价写法：

```yaml
agent:
  llmProviders:                 # 厂商配置：协议 / 预设 / 地址 / Key
    - id: pmain
      name: DeepSeek
      protocol: openai          # openai | anthropic | gemini
      preset: deepseek          # 预设：openai/deepseek/gemini/dashscope/zhipu/moonshot/mimo/minimax/doubao/anthropic/openrouter/opencode/opencode-go/commandcode…
      baseURL: ""
      apiKey: "sk-xxx"          # ★必填
  llmModels:                    # 模型列表：挂在某厂商下
    - id: mchat
      name: 主力
      providerId: pmain
      model: "deepseek-chat"
      temperature: 0.2          # 可选：模型级覆盖全局（留空=继承）
  providerId: pmain             # 基础模型：选哪个厂商
  modelId: mchat                # 基础模型：选哪个模型
```

- **只有这两个引用是真源**（`providerId` / `modelId`）；`protocol/preset/baseURL/apiKey/model` 是自动回填的只读镜像，手改会在下次加载被覆盖。
- 老配置（只有五个扁平字段）首次加载**自动迁移**成厂商+模型条目，无需重配。
- 主模型失败自动回退：`fallbackModels: [{ model, baseURL, apiKey, protocol }]`（可跨厂商；与主模型同协议或不同协议均可）。
- 旁路小模型（播报/记忆抽取等）用 `utilityModel`；可跨厂商，留空=沿用主模型。
- **Command Code**（`preset: commandcode`）：OpenAI + Anthropic 双兼容聚合网关，Key 在 [commandcode.ai/settings/keys](https://commandcode.ai/settings/keys) 生成；Claude 系列走 Anthropic 协议，其余走 OpenAI 协议。

### 3. 选协议端

| 协议端 | 适用 | 接入方式 |
| --- | --- | --- |
| **OneBot v11 / ICQQ**（NapCat、Lagrange 等，最常见） | QQ 号登录 | 无需本插件配置，Yunzai 连上即可用 |
| **QQ 官方机器人（自实现适配器，推荐）** | 官方开放平台机器人 | 本插件直接连：只需 **AppID + AppSecret**（详见 [QQ 官方机器人接入](docs/protocols/qq-official.md)；Web「机器人账号」页管理） |
| QQ 官方机器人（Yunzai-QQBot-Plugin） | 已有官方适配器插件 | 用对方插件连接；本插件自动识别 `QQBot` 适配器并启用官方能力 |
| QQ 频道（QQGuild） | 频道场景 | 用频道适配器连接；本插件识别 `qg_` ID 形态 |

接好后：

- 群里 **@机器人** 或发 **`#ai 你好`** 即可对话（`agent.trigger` 可配 `at` / `command` / `both`）；
- **私聊默认关闭**（`agent.privateChat=false`），需要私聊对话时打开；
- 发 **`#人设`** 切人设、**`#new`** 新建对话、**`#记忆`** 看记忆、**`#agent帮助`** 看指令卡片；
- 官方机器人用户先发 **`/uid`** 把主人 ID 加进 `agent.masters`，否则主人指令不可用（详见 [QQ 官方机器人接入](docs/protocols/qq-official.md)）。

### 图片回复（默认开启）

回复默认渲染成**浅色卡片图**（完整 markdown + 代码高亮），失败自动退文本。`agent.reply.mode`：`image`（默认）/ `text`。
> **QQ 官方机器人**下自动改为 Markdown 直发（不渲染图片），`reply.mode` 被忽略。

### 配置文件与热加载

- 配置在插件目录内（`config/config.yaml`）；保存即**热加载**（下次对话自动重建运行时）。
- 也可发 **`#agent重载`**（主人）立即重建；**改代码**则需重启（ESM 模块缓存）。
- **保存只写差异**：与默认值相同的键不落盘 → 升级后的新默认值会对老用户自动生效；历史全量快照会在启动时压缩（备份 `config.yaml.bak`）。

---

## 常见问题

**Q0：还没有协议端，怎么进 Web 面板？**
看启动日志中带 token 的地址，或读 `data/web/console-url.txt`。面板不依赖协议端与模型运行时。

**Q1：机器人不回话？**
看日志 `[trigger]` 是否有记录；确认 @ 且消息含文字/媒体；私聊需 `agent.privateChat=true`；官方机器人需先用 `/uid` 配 `agent.masters`。

**Q2：模型报 401/404/网络错误？**
到 Web 配置中心核对厂商 `baseURL` / `apiKey` / `protocol`；海外端点可配 `agent.proxy`。

**Q3：回复变纯文本 / 图片渲染失败？**
需要 Chromium；失败会自动退文本。官方机器人本来就走 Markdown。弱服务器可设 `agent.render.card=false`。

**Q5：QQ 官方机器人连不上？**
确认 AppID + AppSecret（Token 已废弃）；看 Web「机器人账号」页状态；4004=密钥错，4013/4914=intents 权限问题，4008=频控；不要和 Yunzai-QQBot-Plugin 同时开。

**Q8：改了配置没生效？**
保存后会自动热加载；仍不生效就发 `#agent重载`。**改代码必须重启进程**（ESM 模块缓存）。

**Q10：沙箱连不上网 / DNS 不通？**
发 `#沙箱诊断`（`预览` / `实测` / `修复`）；检查 `agent.sandbox.network.allowInternet` 与 `allowOut` 白名单。

> 完整排障（Web token、官方指令透传、全量消息误触发、Token 成本、主人权限、群白名单等）见 **[常见问题（完整 FAQ）](docs/troubleshooting.md)**。

---

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [文档索引](docs/README.md) | 全部拆分文档入口 |
| [项目亮点与能力地图](docs/features.md) | 全部能力清单与状态 |
| [分支、更新与重启](docs/updating.md) | 分支策略、自动更新、重启/重载边界 |
| [QQ 官方机器人接入](docs/protocols/qq-official.md) | 自实现适配器、ID 规则、主人配置、Markdown、按钮卡片 |
| [Web 管理面板](docs/web-panel.md) | 面板入口、配置中心、日志/会话/任务视图 |
| [指令一览](docs/commands.md) | 全部聊天、管理、运维指令 |
| [配置参考](docs/configuration.md) | `agent.*` 全量配置说明 |
| [工具进化](docs/tool-evolution.md) | 生成 → 验证 → 审批 → 版本化 |
| [记忆体系与上下文缓存](docs/memory-and-context.md) | MEMORY/USER、召回、压缩、缓存经济性 |
| [安全与信任边界](docs/security.md) | RBAC、审批、注入防御、沙箱边界 |
| [终端执行与 E2B 沙箱](docs/execution/e2b.md) | 云托管 / 自托管 / 网络策略 |
| [网页抓取](docs/execution/web-crawl.md) | crawl4ai 与 HTTP 降级 |
| [Stagehand 浏览器自动化](docs/execution/stagehand.md) | goto / observe / extract / act |
| [表情包](docs/sticker.md) | 自动发现、视觉打标、频率管控 |
| [架构与目录](docs/architecture.md) | 模块分层与配置治理 |
| [扩展开发](docs/extensions.md) | 工具包 / 技能入口 |
| [开发指南](开发指南.md) | 工具 / 技能完整 SDK 与示例 |
| [运维](docs/operations.md) | 环境变量、SearXNG、日志字段、自检 |
| [常见问题（完整 FAQ）](docs/troubleshooting.md) | 全量排障 |
| [更新日志](docs/changelog.md) | 最近版本记录 |
| [鸣谢、联系与许可证](docs/credits.md) | 参考项目与联系方式 |

---

## 📞 联系与许可证

- **QQ 群**：[960179589](https://qm.qq.com/q/960179589)
- **作者 QQ**：3891977697

[GPL-3.0](./LICENSE) · [鸣谢与参考项目](docs/credits.md)
