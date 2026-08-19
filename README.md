<div align="center">

# 🤖 TRSS AI Agent Plugin

> A modular AI Agent runtime for TRSS-Yunzai — LLM · Tool Calling · Memory · MCP · and self-evolving tools.

**基于 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) / [Miao-Yunzai](https://github.com/Le-niao/Yunzai-Bot) 的 AI Agent 插件框架** —— 不是普通插件，而是一套可演化的 Agent Runtime：多模型对话 · 工具调用 · 长期记忆 · 人设 · 多模态识图 · MCP · 群管 · 终端 · 图片渲染，外加**工具进化（Tool Evolution）**等差异化能力。

一个插件打通：多模型对话 · 工具调用 · 长期记忆 · 人设 · 多模态识图 · MCP · 群管 · 终端 · 图片渲染

<img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="License">
<img src="https://img.shields.io/badge/platform-TRSS%2FMiao--Yunzai-9cf" alt="Platform">
<img src="https://img.shields.io/badge/runtime-Node%20ESM-success" alt="Runtime">
<img src="https://img.shields.io/badge/AI-Agent-orange" alt="AI Agent">
<img src="https://img.shields.io/badge/QQ%E7%BE%A4-960179589-green" alt="QQ Group">

**QQ 群**：[960179589](https://qm.qq.com/q/960179589) ｜ **作者 QQ**：3891977697

</div>

---

> ## 📌 重要提示（先看）
>
> - 🎭 **表情包功能已恢复**：支持自动发现（群聊被动采集 → 视觉判定+打标 → 入库）+ 手动安装（manifest 驱动）+ LLM 自主引用 `[sticker:名称]`。配置 `agent.sticker` 开启。
> - 🧪 **深度搜索 / 深度研究（`#研究`）为早期功能**：依赖联网检索 + 多轮子代理编排，受搜索源、模型能力、token 消耗影响，效果可能不稳定甚至不可用。
> - ⚠️ **终端执行为高危能力**：默认关闭；开启 `agent.terminal.enable: true` 即视为自担风险（详见「安全声明」）。
> - ✅ **核心对话（多模型聊天 / 工具调用 / 记忆 / 人设 / 图片渲染 / MCP / 群管）稳定可用**，请以核心为主。

---

## ✨ 项目亮点

- **一插件打通全链路**：多模型对话 · 工具调用 · 长期记忆 · 人设 · 多模态识图 · MCP · 群管 · 终端 · 图片渲染，无需东拼西凑。
- **ReAct 内核 + 自我反思/自纠**：最终回复交付前门控自检（完整性 / 准确性 / 一致性），发现问题自动回环修正；多层频率闸防"每条都带表情"的 AI 感。
- **双协议多模型**：OpenAI / Anthropic 兼容，一行配置接 DeepSeek / Kimi / MiMo / 通义 / 智谱 / Gemini；视觉子模型让无视觉的主模型也能识图。
- **渐进式披露 + 结构化 prompt**：技能按需加载、工具目录速查、分层 system prompt（执行取向 / 服务准则 / 安全护栏），兼顾能力与上下文成本。
- **文件即真相的记忆**：`MEMORY.md` / `USER.md` 人可读可编辑 + `memory_search` 主动召回，跨会话不失忆、不串档。
- **安全纵深**：工具 RBAC + 主人审批 + allowlist 免审 + 黑名单硬拦 + 注入防御，高危动作不裸奔。
- **配置热加载 + 锅巴适配**：改配置即生效、免重启；锅巴 Web 面板可视化编辑。
- **回复默认渲染成精美图片**：markdown → 浅色卡片图（标题 / 列表 / 代码高亮 / 表格 / 引用全支持），失败退文本。
- **🧬 工具进化（Tool Evolution）**：Agent 经 LLM 生成新工具 → typescript AST 静态门 → 沙箱行为验证 → 主人审批上线，形成可验证 / 可回滚 / 权限不可自扩的工具生命周期（生成→验证→晋升→淘汰闭环）。

---

## 📌 功能一览

| 能力 | 说明 | 状态 |
| --- | --- | --- |
| 💬 多模型对话 | OpenAI / Anthropic 双协议，接 DeepSeek / Kimi / MiMo / 通义 / 智谱 / Gemini 等 | ✅ 稳定 |
| 🖼️ 图片渲染回复 | markdown → 精美**浅色卡片**图片（完整语法 + 代码高亮 + 底部会话/对话id），失败退文本 | ✅ 稳定 |
| 🔧 工具调用 | ReAct 内核、并行调用、RBAC + 主人审批、工具开发 SDK | ✅ 稳定 |
| 🧠 长期记忆 | MEMORY.md/USER.md 人可编辑 + `memory_search` 主动召回（参考 OpenClaw） | ✅ 稳定 |
| 🎭 人设系统 | 内置 6 角色 + 自建，替换身份层不缩水工具/记忆 | ✅ 稳定 |
| 🖼️ 多模态识图 | 视觉子模型（主模型无视觉时图转文） | ✅ 稳定 |
| 🔌 MCP | 完整 MCP 客户端（stdio / HTTP）、多服务端、按工具 RBAC | ✅ 稳定 |
| 👥 群聊工具 | 群信息 / 群管理 / 米游社搜索 | ✅ 稳定 |
| 📥 媒体下载 | 基于 yt-dlp 的视频/音频下载（受约束，仅主人），支持 YouTube/B站/抖音等 1000+ 站点 | ✅ 稳定 |
| 💻 终端执行 | **主机直接执行**（terminal 主人免确认可配 + 黑名单硬拦） | ⚠️ 高危可选 |
| 🌐 浏览器自动化 | **Stagehand**：goto/observe/extract/act 自然语言原语，本地或 Browserbase 云，会话跨调用保持 | 🧪 早期 |
| 🎭 表情包 | 自动发现（群聊被动采集→视觉打标→入库）+ 手动安装 + LLM 自主引用 `[sticker:名称]` | ✅ 稳定 |
| 🤖 伪人模式 | 群聊环境参与者：旁听→门控→Planner 决策→Replyer 自然回复（参照 MaiBot） | 🧪 早期 |
| 💬 私聊对话 | 私聊任何消息直接触发（不需 #ai/@），独立会话与记忆 | ✅ 稳定 |
| 🌐 代理访问 | HTTP/SOCKS 代理（国内服务器访问 GPT/Gemini 等海外 LLM） | ✅ 稳定 |
| 🔁 回退模型 | 主模型失败自动依次尝试 `fallbackModels`（同 provider） | ✅ 稳定 |
| 📂 日志分文件 | 按会话分文件 + 图片底部会话/对话id + `#上报错误` 打包发主人 | ✅ 稳定 |
| 🔍 统一搜索 | Tavily/Exa/Perplexity/Brave → SearXNG → DDG 兜底 | ✅ 稳定 |
| 📊 示意图生成 | 流程图/架构图/时序图/状态图/ER/思维导图：LLM 语义结构 → 自托管 Kroki D2 → 高清 PNG（文字/连线精确，非文生图） | ✅ 稳定 |
| 📚 深度研究 | `#研究` 五阶段管线（规划→检索→综合→引用→评估） | 🧪 早期 |
| 🧬 工具进化 | LLM 生成候选 → AST/沙箱验证 → 审批上线（版本化 / 可回滚 / 安全闸） | 🧪 早期 |

---

## 🧬 工具进化（Tool Evolution）

> Agent 不再只从固定工具列表中选择——它能**生成新工具、验证、审批上线、持续改进与淘汰**，形成可演化的工具库。这是本插件相对普通 Agent 框架的核心差异点，也是搜索词 `tool evolution agent` 的入口。

**完整生命周期**（安全纵深，五阶段）：

```
#进化工具 <能力描述>
  → LLM 生成（json_schema 结构化）
  → typescript AST 静态门（禁 require / child_process / process.env / eval / 一切 import；危险候选不入库）
  → 沙箱行为验证（node 隔离 + 测试断言 + 性能/超时门）
  → #采纳工具 <id>（master 审批）→ stable + 注入 → agent 经 tool_search 调用
  → 调用埋点 → 适应度 / 失败聚类 → #工具健康 检测 → #淘汰工具 下线
```

**安全原则**（不可妥协）：
- ① **生成闸**：只允许 `sideEffects ∈ {none, read}`；联网 / 发消息 / 删库等**固定受信适配器永不自动生成**
- ② **可信基不可被工具进化**：DB / 验证器 / 沙箱 / 审批 / 审计由人维护，工具不能改
- ③ **版本不可变 + 审计 + 权限单调不增 + 安全硬否决**（一票否决，非权重）

**命令族**（均 master）：`#进化工具` / `#工具进化列表` / `#采纳工具` / `#淘汰工具` / `#工具健康` + Web「工具进化」管理面板。

---

## 📑 目录

- [✨ 项目亮点](#-项目亮点)
- [📦 安装](#-安装)
- [🚀 快速开始](#-快速开始)
- [⚙️ 详细配置](#️-详细配置pluginsagents-pluginconfigconfigyaml)
- [🎮 指令](#-指令)
- [🧩 扩展开发（工具 / 技能）](开发指南.md)
- [🧠 记忆体系](#-记忆体系参考-openclaw文件即真相)
- [💻 终端执行 + 审批](#-终端执行--审批allowlist-自动放行)
- [🎭 表情包](#-表情包llm-自主附带)
- [🏗️ 架构](#️-架构)
- [🔧 日志](#-日志与排查)
- [📞 联系](#-联系)

---

## ⚠️ 安全声明

本插件提供**终端（shell）执行能力**，属于**高危工具**：

- shell 在**主机直接执行**任意命令（无容器隔离）——读写/删除文件、安装软件、访问网络、调用系统权限。
- terminal 仅「terminal 主人」可用：**不读 Yunzai 框架配置**，认领流程类似 Yunzai `#设置主人`——`#agents设置主人`（控制台打印验证码 + 进入监听）→ 直接发验证码认领，单主人（换人即重置）。每条命令需主人 `#确认`；灾难命令（`rm -rf /` 等）黑名单硬拦。**但任何防护都无法保证 100% 安全**——命令组合、解释器、环境差异等都可能绕过静态规则。
- **终端默认关闭**（`agent.terminal.enable` 默认 `false`），需在配置里**单独手动开启**。
- **开启 `agent.terminal.enable: true` 即表示你已知晓上述风险（含真机执行）、同意自行承担一切后果，与开发者无关。** 开发者会尽量保证安全性，但不作任何担保。

> 如不接受该风险，请保持 `terminal.enable: false`（默认）。不启用终端时，本插件不涉及任何主机命令执行，无此风险。

---

## 📦 安装

```bash
# Gitee（国内推荐）：
git clone https://gitee.com/YunXi-67/trss-agent-plugin.git ./plugins/agents-plugin
# 或 GitHub：
git clone https://github.com/yunhai89/trss-agent-plugin.git ./plugins/agents-plugin
cd ./plugins/agents-plugin && npm install      # 安装 markdown 渲染依赖（marked / highlight.js）
```

> 除 markdown 渲染（marked / marked-highlight / highlight.js，需在插件目录 `npm install`）外，其余依赖随 Yunzai 提供。`#agents更新`（git pull）后若 package.json 有变动，需重跑一次 `npm install`。
> 重启 Yunzai 后，首次启动自动在**插件自己的** `plugins/agents-plugin/config/config.yaml` 生成配置，填入 API Key 即可使用。

### 🖼️ 图片回复（默认开启）

机器人回复**默认渲染成精美浅色卡片图片**（完整 markdown + 代码语法高亮），渲染失败自动退文本。配置 `agent.reply.mode`：
- `image`（默认）：markdown → 浅色卡片图片（标题/列表/代码高亮/表格/引用全支持）
- `text`：纯文本回复

> 配置文件在插件目录内（不在 Yunzai 根）。若你之前用的是旧版 `Yunzai/config/agents-plugin.yaml`，首次加载会**自动迁移**到插件目录并删除旧文件（apiKey/masters 等全部保留）。
> **支持热加载**：改完配置保存即可，**无需重启 Yunzai**——下次对话自动用新配置重建运行时（provider/model/tools/skills/mcp）。也可发 `#agents重载`（主人）立即重建。
>
> **锅巴（Guoba）适配**：已支持。安装 [Guoba-Plugin](https://gitee.com/guoba-yunzai/guoba-plugin) 后，`#锅巴登录` 进入 Web 面板即可图形化编辑本插件配置；保存后**自动热加载**。适配文件为插件根 `guoba.support.js`。

---

## 🚀 快速开始

编辑 `plugins/agents-plugin/config/config.yaml`，最少只需填两项：

```yaml
agent:
  protocol: openai        # 或 anthropic
  preset: deepseek        # 厂商预设：openai/deepseek/gemini/dashscope/zhipu/moonshot/mimo/minimax（anthropic: anthropic/deepseek/mimo/minimax）
  apiKey: "sk-xxx"        # 你的 API Key
  model: "deepseek-chat"  # 模型 ID
```

群里 **@机器人** 或发 **`#ai 你好`** 即可对话。

---

## ⚙️ 详细配置（`plugins/agents-plugin/config/config.yaml`）

> 配置文件不含注释（保持整洁），所有字段含义在此说明。未用到的字段留空即可。

### 基础

| 字段 | 说明 |
| --- | --- |
| `debug` | `true` 打开详细日志（工具入参/每轮 token/搜索词等），排查时开启 |
| `prefix` | 命令前缀（保留备用） |

### `agent` —— 对话与模型

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `trigger` | `at` | 触发模式：`at`(艾特) / `command`(触发词) / `both` |
| `triggerCommand` | `#ai` | `trigger` 为 command/both 时的触发词 |
| `protocol` | `openai` | `openai` / `anthropic`（均支持各兼容端点） |
| `preset` | `deepseek` | 厂商预设（自动填 baseURL/headers/字段映射） |
| `baseURL` | 空 | 自定义 baseURL，覆盖 preset |
| `apiKey` | 空 | **必填** API Key |
| `model` | `deepseek-chat` | 模型 ID |
| `reasoningFields` | `[]` | 推理字段归一化（如 `["reasoning_content"]`），preset 通常已带 |
| `maxTurns` | `50` | 单次对话工具调用轮次预算 |
| `temperature` | 空 | 采样温度 |
| `maxTokens` | 空 | 单次回复最大 token（留空=厂商默认；Anthropic 默认 4096） |
| `contextWindow` | 空 | 模型上下文窗口 token 数（如 `32000`）；超 80% 自动压缩历史、保留首条意图 |
| `maxToolResultChars` | `4000` | 单条工具结果字符上限，超长截断防上下文膨胀 |
| `keepReasoning` | `false` | 是否把推理(`reasoning_content`)回灌历史；默认 `false` 省 context |
| `stream` | `false` | 逐字流式输出（依赖适配器、不稳，默认关） |
| `progress` | `true` | 工具调用时推送节流进度消息（消除"干等"，默认开） |
| `progressRecall` | `3` | 进度消息多少秒后自动撤回（适配器不支持则忽略） |
| `reply.mode` | `image` | 回复渲染：`image`（markdown→浅色图片，默认）/ `text`（纯文本） |
| `reply.atSender` | `true` | 群聊回复时艾特发言人（私聊不艾特） |
| `reply.narrate` | `true` | 中途播报：模型调工具时附带的思路/进展文本自动转发给用户（参考 OpenClaw） |
| `reply.renderScale` | `2` | 回复图片渲染倍率（deviceScaleFactor，2=高清；越大越清晰但越耗内存/体积） |
| `thinking` | 空 | 思考模式，如 `{ type: "enabled", budget_tokens: 16000 }` |
| `memoryLimits` | 空 | 声明式记忆字符上限，如 `{ memory: 2200, user: 1375 }` |
| `systemPrompt` | 空 | 默认身份 system prompt（留空用富默认身份；被人设覆盖时失效） |
| `chatPermission` | `master` | `#ai` 命令权限：`master`/`admin`/`owner`/`all` |
| `masters` | `[]` | 接收审批通知的 master QQ 号列表 |
| `masterSkipConfirm` | `false` | ⚠️高危：主人发起的确认类工具（terminal 写命令等）免 `#确认` 直接执行（仅主人，控制台有日志不在聊天提示；denylist 仍硬拦） |
| `confirmTimeout` | `300` | 审批超时自动拒绝（秒） |
| `guardAction` | `flag` | 注入防御动作：`block`(拦截)/`flag`(隔离标注)/`sanitize`(脱敏) |
| `guardSensitivity` | `medium` | 防御灵敏度：`low`(0.95)/`medium`(0.7)/`high`(0.5) |
| `redactSecrets` | `true` | 发送前脱敏：屏蔽回复中的 API Key / token 等敏感信息 |

### `agent.policy` —— RBAC 策略

```yaml
policy:
  categoryMin:
    message: 1        # 覆盖内置类别最低角色
    mcp_write: 2      # 自定义类别（如 MCP 写工具需群管以上）
```

内置类别阶梯：`query:0` / `personal:0` / `message:1` / `group_manage:2` / `system:3`。角色：`member<admin<owner<master(99)`。

### `agent.media` —— 多模态 / 文件

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enable` | `true` | 多模态总开关 |
| `active` | `true` | 主动收集（消息/引用/合并转发/群文件中的图片文件） |
| `passive` | `true` | 被动工具（`list_group_files`/`get_group_file`/`read_attachment`） |
| `maxImages` | `4` | 单次随消息发送最大图片数 |
| `maxFileBytes` | `8388608` | 单文件字节上限 |
| `degrade` | `note` | 非视觉模型降级：`skip`/`note`/`text` |
| `caps` | 空 | 覆盖模型能力判定（一般无需配置），如 `{ vision: true, file: true }` |

### `agent.vision` —— 视觉子模型

主模型不支持视觉时，由视觉子模型识图 → 文本描述 → 主模型回答。主模型支持视觉则直发原图、不走此路径。默认复用主模型 `protocol/baseURL/apiKey`，只换 `model`。

```yaml
vision:
  enable: true
  model: "mimo-2.5"     # 视觉模型 ID（必填才启用）
  # 以下可选：覆盖为独立厂商
  protocol:             # 如 anthropic
  preset:
  baseURL: ""
  apiKey: ""            # 空则复用主 apiKey
  maxTokens: 1024
  describePrompt: ""    # 自定义"描述这张图"指令
```

### `agent.tools` —— 工具 SDK

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `builtin` | `true` | 启用内置工具包（群信息/群管/米游社） |
| `dir` | `tools` | 自定义工具包目录（相对插件根，自动加载） |

### `agent.miyoushe` —— 米游社

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `cookie` | 空 | 可选，提升搜索成功率/看全文；不填可匿名搜索 |
| `defaultGid` | `2` | 默认游戏 gid（2原神/6星铁/8绝区零/1崩坏三/4未定/3崩坏学院2） |

### `agent.persona` —— 人设

```yaml
persona:
  dir: ""   # 自定义人设目录（默认 data/agents-plugin/personas）
```

### `agent.search` —— 统一搜索 🧪早期

> 🧪 搜索为早期功能，效果取决于搜索源可用性。任填一个 key 即用该源；都不填回退 SearXNG，再兜底 DDG（始终可用）。

```yaml
search:
  tavily:    { apiKey: "" }
  exa:       { apiKey: "" }
  perplexity: { apiKey: "" }
  brave:     { apiKey: "" }
  searxng:   { url: "" }     # 如 http://localhost:8080
  ddg: true                  # 本地 DDG 兜底（默认开）
```

### `agent.diagram` —— 示意图生成（diagram_render）

> Agent 对话里说「画一下 XX 的流程图/架构图/时序图」即可生图。**不用文生图模型**——文字、连线、层级精确可靠：
> LLM 只提交语义结构（节点/连线/分组/时序消息），插件确定性编译为 D2，由**自托管 Kroki** 容器渲染 SVG，
> 经安全检查后用 resvg 转高清 PNG（默认宽 1600、2x 清晰度、内置中文字体）随回复发送。
>
> - **支持图类型**：flowchart / architecture（容器分组）/ sequence / state / class / er / mindmap
> - **主题**：paper-blue（默认）/ soft-pastel / technical / midnight（深色）/ sketch（手绘，仅 D2）
> - **安全边界**：LLM 不能提交 SVG/HTML/坐标/路径；默认禁用公共 Kroki（用户内容不出内网）；SVG 输出按不可信内容检查（拒脚本/外链/实体）；临时文件只写 `data/diagram/`（内容哈希命名 + TTL 清理）
> - **容错**：Kroki 不可用 → 连接超时/熔断/结构化失败（可配本地 `beautiful-mermaid` 回退），绝不挂死 Agent 或让用户无回复

**部署 Kroki 容器**（默认引擎依赖，一次性）：

```bash
docker compose -f docs/deploy/kroki-compose.yaml up -d
# 然后保持 agent.diagram.kroki.endpoint: http://127.0.0.1:8000
```

```yaml
diagram:
  enable: true
  renderer: kroki                    # 自托管 Kroki 渲染 D2
  fallbackRenderer: none             # Kroki 失败的本地回退：none | beautiful-mermaid
  defaultTheme: paper-blue           # paper-blue | soft-pastel | technical | midnight | sketch
  defaultFormat: png                 # png | svg（svg 以可编辑源文件发送）
  timeoutMs: 15000                   # 渲染总预算（编译+HTTP+栅格化）
  targetWidth: 1600                  # 输出宽度（px）
  maxNodes: 50                       # 规模上限（连线 2 倍；超出拒绝渲染并提示模型）
  tempTtlMinutes: 30                 # 临时图保留时长
  kroki:
    endpoint: "http://127.0.0.1:8000"
    allowPublicEndpoint: false       # ⚠️ true=允许 kroki.io 公共服务（图内容将发第三方，强制 HTTPS）
    connectTimeoutMs: 2000           # 连接/响应头超时
    requestTimeoutMs: 12000          # 单请求总超时（覆盖响应体读取全程）
    maxResponseBytes: 4194304        # SVG 响应上限（流式字节计数）
    maxConcurrency: 2
    circuitBreaker: { enabled: true, failureThreshold: 3, cooldownMs: 30000 }
    d2: { layout: elk }              # dagre | elk（sequence 固定 dagre）
    imageTag: ""                     # 部署镜像版本声明（进缓存 key；升级镜像后更新）
```

**使用示例**：

```text
你：用图画一下这个插件的工作流程
Bot：（流程图图片）用户消息 → Yunzai → Agent Loop → 工具调用 → 渲染回复
你：画个时序图看看工具调用过程
Bot：（时序图图片）用户/Agent/工具 三方消息序列
```

**常见排查**：

| 症状 | 原因与处理 |
| --- | --- |
| 回复「渲染服务不可用」 | Kroki 容器未启动/endpoint 配错：`docker compose -f docs/deploy/kroki-compose.yaml up -d`；或配置 `fallbackRenderer: beautiful-mermaid` 本地回退 |
| 连续失败每次都要等很久才回 | 熔断器生效中（连续 3 次失败短路 30s），检查容器 `docker logs agents-kroki` |
| 图太大被拒（output_too_large） | 减少 nodes/edges 数量，或调低 `targetWidth` |
| 中文显示为方框 | 理论不会发生（内置字体）；若手动删除了 `resources/fonts/`，恢复该文件或保留系统 Noto CJK |
| 中文流程图正常但主题色不对 | Kroki 镜像版本的 D2 主题编号差异：更新 `kroki.imageTag` 并调整 `model/diagram/themes.js` 后重启 |

### `agent.research` —— 深度研究 🧪早期

> 🧪 **深度研究处于早期开发，效果可能差或不可用**（见顶部「重要提示」）。受搜索源、模型能力、token 消耗影响大，仅作辅助。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `permission` | `master` | `master`（防 token 滥用）/ `all` |
| `maxRounds` | `3` | 外层 Supervisor 最大轮次 |
| `maxConcurrent` | `3` | 子代理并发上限 |
| `workerModel` | 空 | 子代理模型（空则用主模型；省钱可填便宜模型） |
| `evaluation` | `true` | 是否跑五维评估 |

### `agent.mcp` —— MCP 服务端

```yaml
mcp:
  requestTimeout: 60000
  servers:
    fs:                           # stdio 子进程示例
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-filesystem", "./"]
      prefix: "fs"
      category: "query"           # 字符串：该服务端所有工具同类；或按工具映射 { read_file: "query", write_file: "system", default: "query" }
    remote:                       # HTTP 远程示例
      transport: "http"
      url: "https://example.com/mcp"
      headers: { Authorization: "Bearer ..." }
      listen: false
      prefix: "rmt"
      enabled: true
```

> **⚠️ Docker / 精简镜像没有 `npx`？—— MCP 握手超时（ENOENT）**
>
> 部分 Yunzai Docker 镜像只装了 `node`、**没有 `npm`/`npx`/`corepack`**（某些 `trss`/`miao` 镜像即如此）。此时上面 `command: "npx"` 会启动失败：
> ```
> [mcp] xxx 连接失败：传输关闭（进程退出码-2；spawn 失败：ENOENT spawn npx（npx 不在 PATH？…））
> ```
> （旧版本这种情况只甩一句看不懂的 `request timeout: initialize`；现已**立即**报出 ENOENT + 退出码 + stderr 末尾，便于定位。）
>
> **判断**：`docker exec <容器> command -v npx` —— 输出为空就是容器里没装 npx。
>
> **解决方案（任选其一，推荐 ①）**：
>
> 1. **给容器补上 npm/npx（一次性脚本，推荐）**：仓库自带 [`scripts/bootstrap-npm-docker.sh`](scripts/bootstrap-npm-docker.sh)，纯 `node + curl + tar` 实现、不依赖包管理器：
>    ```bash
>    docker cp plugins/agents-plugin/scripts/bootstrap-npm-docker.sh <容器>:/tmp/bs.sh
>    docker exec <容器> sh /tmp/bs.sh
>    # 装好后 npx 进入容器 PATH，上面 MCP 配置无需任何改动
>    ```
>    ⚠️ 脚本装在「运行中的容器」里，**容器一旦重建（重新 `docker run`）会丢失**，需重跑；想一劳永逸请把它加进镜像 entrypoint / Dockerfile。
> 2. **改用绝对路径**：若容器别处有 `npx`/`node`，把 `command` 换成绝对路径（如 `/usr/local/bin/npx`）。
> 3. **绕开 npx**：容器内 `npm i -g <mcp包>` 全局安装后，用 `command: "/usr/bin/node"` + `args: ["<全局模块入口 js 的绝对路径>"]` 直接跑；或改用 `transport: "http"` 连远程 MCP，本地无需任何进程。

---

## 🎮 指令

### 对话
| 指令 | 说明 |
| --- | --- |
| `@机器人 +内容` | 艾特对话（默认触发） |
| `#ai +内容` | 自定义触发词（`trigger=command/both`） |
| `#聊天列表` | 查看所有对话（图片） |
| `#进入聊天 +id` | 切换对话 |
| `#new` | 新建对话 |

### 人设
| 指令 | 说明 |
| --- | --- |
| `#人设` / `#人设列表` | 查看人设列表（图片） |
| `#人设 +id` | 切换人设 |
| `#人设详情 +id` | 查看人设内容 |
| `#新建人设 +名称 +内容` | 创建自定义人设并切换 |
| `#删除人设 +id` | 删除（仅创建者/master） |
| `#重置人设` | 恢复默认 |

### 深度研究 🧪
| 指令 | 说明 |
| --- | --- |
| `#研究 +主题` | 🧪 **早期功能**：深度研究（结果 PDF→高清图→文本），效果可能不稳定 |

### 记忆 / 提醒
| 指令 | 说明 |
| --- | --- |
| `#记忆` | 查看长期记忆 |
| `#忘掉 +关键词` | 按关键词遗忘 |
| `#我的提醒` / `#取消提醒 +id` | 提醒管理 |
| `#清空所有记录` | 清空**自己**的对话历史/记忆/笔记/提醒/人设绑定（不含配置；2 步确认） |

### 主人指令
| 指令 | 说明 |
| --- | --- |
| `#模型切换 +id` | 切换 LLM 模型 |
| `#启用mcp +名` / `#停止mcp +名` | MCP 服务端启停 |
| `#添加mcp +JSON` | 按标准 `mcpServers` JSON 添加 MCP（连接验证+持久化）。**私聊**发 `#添加mcp`（不带 JSON）进入交互式添加：直接粘贴 JSON 即自动测试并应用。如 `{ "mcpServers": { "zai": { "type":"stdio", "command":"npx", "args":[...], "env":{...} } } }` |
| `#mcp` | MCP 连接状态 |
| `#确认 +id` / `#拒绝 +id` / `#待确认` | 审批待执行危险动作 |
| `#agents帮助` / `#agents状态` | 帮助图 / 运行状态 |
| `#agents重载` | 热重载配置并立即重建运行时（model/tools/skills/mcp，无需重启框架） |
| `#agents更新` / `#agents强制更新` | git pull 拉取最新代码（强制=reset 后 rebase），有代码改动时自动重启 Yunzai 生效 |
| `#agents版本` / `#agents更新日志` | 最近提交时间 / 本次更新日志 |

---

## 🧩 扩展开发（工具 / 技能）

本插件支持两种扩展，**详细的开发文档（完整 API 参考 + 示例）已独立到 [开发指南.md](开发指南.md)**：

- **工具（Tool）**：给模型新增"动作"，模型可直接调用执行。放 `tools/` 目录自动加载，用 `defineToolPack` / `defineTool` / `param` SDK 编写。
- **技能（Skill）**：渐进式披露的"说明书"，不新增动作、只教模型"什么场景用哪些工具、按什么顺序"。放 `skills/` 目录自动加载，写 `SKILL.md`。

👉 完整的 SDK API（`defineTool` / `param.*` / `getGroup` / `ok` / `fail`…）、运行时 `ctx` 字段、`meta` 选项（审批 / 串行 / 结果截断）、`category` 与 RBAC、多组完整示例与常见陷阱，见 **[开发指南.md](开发指南.md)**。

---

## 🧠 记忆体系（参考 OpenClaw「文件即真相」）

两层记忆，互补：

- **声明式记忆（`MEMORY.md` / `USER.md`）**：Agent 的个人笔记 / 用户画像，**Markdown 文件、人可读可编辑**（位于 `Yunzai/data/agents-plugin/memories/`）。每条一行 `- ` bullet，有字符预算（memory 2200 / user 1375）。模型用 `memory` 工具 add/replace/remove 维护，自动注入 system prompt。旧版 `memory.json`/`user.json` 首次加载自动迁移为 `.md`。可直接编辑文件，重启后生效。
- **召回式记忆（`memory_search` 工具）**：跨会话的长期记忆（偏好/身份/事实/近期事项），相似度×时间衰减召回。**模型主动检索**——回答涉及用户先前说过的偏好、历史决策、待办前，先调 `memory_search(query)` 核实，不要凭印象作答（移植 OpenClaw "Mandatory recall step" 语义）。结果带类型与日期引用。

指令：`#记忆` 查看、`#忘掉 <关键词>` 遗忘。

---

## 💻 终端执行 + 审批（主人验证码认领）

> **⚠️ 高危**：见上方「安全声明」。`terminal` 默认关闭，需 `agent.terminal.enable: true` **单独开启**；开启即视为你知晓风险并自担后果。

`terminal` 工具让 Agent 在**主机直接执行** shell 命令（无容器隔离，比沙盒危险得多）。安全模型（纵深防御）：

- **terminal 主人（自包含，不读框架配置）**：不沿用 Yunzai 的 `e.isMaster` / `agent.masters`。认领流程（类似 Yunzai `#设置主人`）：
  1. 任意人发 `#agents设置主人` → **控制台打印**一个验证码（只有服务器持有者能看到），并进入监听态。
  2. 服务器持有者**直接把验证码发到当前会话**（无需任何命令前缀）→ 校验通过即成为 terminal 主人。验证码错误可在超时前重发。
  - **单主人 + 验证码重置**：每次 `#agents设置主人` 生成新验证码并重置监听，新码被认领后**替换旧主人**（换人即重置）。持久化到插件 `data/terminal-master.json`，重启不丢。
- **审批门**：terminal **每条命令都需主人 `#确认`**（不再有 allowlist 免审——真机执行没有「安全的只读命令」）。主人收到 DM（含命令预览 + 风险提示：⚠️写入/🌐网络/🔐提权/📦安装），`#确认 <id>` / `#拒绝 <id>`，超时自拒。
- **黑名单**：灾难性命令（`rm -rf /` / `mkfs` / `dd of=/dev/` / 关机重启 等）即使已确认也**硬拦**。
- 配置（`agent.terminal`）：`maxTimeout`（命令超时上限）、`blocklist`（追加灾难命令正则；空=用默认集）。

### 🔍 SearXNG（自建免费搜索后端）安装

搜索（`web_search`/`#研究`）若无 Tavily/Exa 等 key，可自建 SearXNG（免费、无 key、隐私）：

```bash
docker run -d --name searxng --restart=always -p 8080:8080 \
  -e SEARXNG_BASE_URL=http://localhost:8080 \
  docker.m.daocloud.io/searxng/searxng:latest
```

配置里填：

```yaml
search:
  searxng: { url: "http://localhost:8080" }
```

> 生产建议给 SearXNG 加 reverse proxy + auth（见 [SearXNG 文档](https://docs.searxng.org)）。插件按其 JSON API 调用，无需额外适配。

---

## 🌐 Stagehand 浏览器自动化（🧪 早期）

> 基于 [@browserbasehq/stagehand](https://docs.stagehand.dev) v4。Agent 用自然语言驱动真实浏览器：打开页面、点击、填表、抽取动态渲染后的结构化数据（弥补 web_crawl 不执行 JS 的不足）。

**4 个工具**（`category:'system'`，仅框架主人；`stagehand__act` 写动作额外需 `#确认`）：
- `stagehand__goto({url})` — 打开 URL（多步任务起点，页面跨调用保持）
- `stagehand__observe({instruction?})` — 列出可交互元素（只读）
- `stagehand__extract({instruction, schema})` — 按自然语言 + JSON Schema 抽结构化数据
- `stagehand__act({instruction})` — 点击/输入/提交（写动作，需 `#确认`）

**会话**：per-scopeUserId 懒启动 + 5min idle 自动关；同一会话复用同一页面，支持"打开 A 站→登录→抓数据"多步任务。

**配置**（`agent.stagehand`，默认关）：
```yaml
stagehand:
  enable: true
  mode: local          # local(本地 Playwright+chromium，默认) | cloud(Browserbase)
  headless: true
  executablePath: ""   # 本地 chrome 路径(空=默认/CHROME_PATH；可填复用已装 chrome)
  browserbaseApiKey: ""# 云模式必填
  modelName: ""        # Stagehand 原生模型(如 google/gemini-2.5-flash)；空=复用插件 provider(仅 OpenAI 兼容)；云模式空=自动选
  modelApiKey: ""
  idleTimeoutMs: 300000
```

- **LLM**：Stagehand 每次原语调用要一次 LLM 推理。`modelName` 留空时**复用插件已配的 OpenAI 兼容 provider**（deepseek/openai/mimo 等，走 json_schema 结构化输出）；插件协议为 anthropic 或想用更强模型，填 `modelName`（五大 provider：openai/anthropic/google/groq/cerebras）。
- **依赖**：`@browserbasehq/stagehand` + `zod`（云崽根 `pnpm install` 随 workspace 装入插件）；本地模式另需 chromium + 系统库（`libnss3 libatk-bridge2.0-dev libgtk-3-dev libxss1 libasound2`）。
- 云模式（Browserbase）不在主机跑浏览器、无需本地 chromium，但需 apiKey + 外网。

---

## 🎭 表情包（LLM 自主附带）

模型在回复中自主判断并内嵌表情包，增强拟人感——模型在文本里写 `[sticker:名称]`，插件在发送层解析替换为对应表情包图片：

- **图片模式（默认）**：表情包**内嵌进渲染出的整张回复图片**（文字 + 表情合成一张图）。
- **文本模式**：文本段 + 表情图片段混排发出。

> ℹ️ **表情源 = 作者官方仓库**（不接入用户自有/第三方仓库）。仓库带 **manifest（语义清单）**，插件按 `name/tags/docs` 做语义匹配，而非靠文件名猜。功能默认关闭，待官方仓库就绪后由 `#表情包安装` 拉取启用；未就绪前模型看不到该功能，零影响。

### 仓库格式（manifest 驱动）

官方仓库根目录放一个 manifest `.json`（数组），图文件按 `id` 命名（如 `000001.png`）：

```json
[
  { "id": 1, "name": "不愧是你", "tags": ["认可", "调侃"], "docs": "对对方的话表示佩服或无奈的认可" },
  { "id": 2, "name": "下次一定", "tags": ["敷衍", "承诺"], "docs": "嘴上答应实际并不想做" }
]
```

- `id`：对应图文件名（数字会补零 6 位，`1` ↔ `000001.png`）；
- `name`：表情名称，模型用 `[sticker:名称]` 引用，须全局唯一；
- `tags`：标签数组（兼容拼写 `tages`）；
- `docs`：一句话意思描述——**语义匹配的关键**。

### 频率管控（防"每条都带 → 反而更 AI"）

四层叠加，保证偶发而非每条都蹦：① **prompt 强约束**（偶尔/严肃场景不用）；② **概率闸 `sendRate`**（门控通过后仅按概率真正带图）；③ **冷却 `cooldown`**（同会话最小间隔）；④ **防连发**（上一条带过则本条不带）。

### 用法（仅主人）

| 指令 | 说明 |
| --- | --- |
| `#表情包安装` | 浅克隆官方仓库（自动测速选最快 GitHub 代理）→ 按 manifest 建索引 → 自动开启。进度只打控制台，群聊仅返回结果 |
| `#表情包更新` | 拉取上游；HEAD 未变则提示已是最新 |
| `#表情包状态` | 总数 / 体积 / 上游 commit / 高频 Top5 |
| `#表情包开启` / `#表情包关闭` | 热开关 |
| `#表情包目录` | 列出源目录及启停状态 |
| `#表情包目录 启用/停用 <目录>` | 子集管理（停用即清出） |

关键配置（`agent.sticker`，`enable` 默认关；未下载/未开 → 不注入清单、模型看不到该功能，零影响）：

```yaml
sticker:
  enable: false          # 总开关
  sendRate: 0.25         # 概率闸：门控通过后实际带图概率
  cooldown: 300          # 同会话两次带图最小间隔（秒）
  maxPerReply: 2
  antiConsecutive: true  # 防连发
  manifest: ""            # manifest 文件名（留空=自动识别根目录第一个合规 .json）
  excludeDirs: []         # 目录黑名单（不复制进 images/）
  githubProxies: []        # 克隆加速代理前缀数组（追加在内置代理之上，安装时测速选最快）
```

> **合规**：表情源为作者官方仓库，内容由作者把关。插件仍内置目录黑名单（`excludeDirs`）+ 文件名关键词过滤，且发送侧只发本地 `images/` 内物理存在的文件（黑名单目录不会被复制进来）。

---

## 🏗️ 架构

```
apps/        事件分发与回复编排（agent 对话 / research 研究 / help / render）
model/
  ├─ render                 统一浅色主题 + markdown→图片渲染（marked/highlight.js）
  ├─ openai · anthropic      协议传输层（流式/重试/熔断/failover）
  ├─ llm                     模型能力注册表 + 熔断器 + 连接池 + embedding
  ├─ agent                   ReAct 内核 + 工具/会话/记忆/防护/策略/审批
  ├─ prompt                  分层 system prompt 构建（执行取向/工具目录/技能/安全）
  ├─ evolution               GEPA 提示词自我进化引擎
  ├─ mcp                     Model Context Protocol 客户端（多服务端）
  ├─ multiagent              编排器-工人 / pipeline / parallel / router
  ├─ search · tavily         统一搜索（多源路由 + DDG 兜底）
  ├─ research                深度研究五阶段管线 + 报告渲染
  ├─ media                   多模态文件收集/解析/协议转换
  ├─ vision                  视觉子模型识图
  ├─ miyoushe                米游社帖子搜索
  ├─ group                   群信息 + 群管理工具
  ├─ persona                 人设库 + 激活绑定
  └─ toolkit                 工具开发 SDK + 自动加载器
tools/       自定义工具包（自动加载）
skills/      技能说明书（SKILL.md，自动加载）
utils/       Config 配置读写（插件目录 + 热加载） · Log 分级日志
```

每个 `model/*` 模块均有离线自检（`node model/<模块>/test.mjs`），合计 **960+ 断言全绿**。

---

## 🔧 日志与排查

分级日志（`utils/Log.js`）：`mark`（里程碑）/ `info`（研究进度）/ `debug`（工具入参·每轮 token）/ `warn` / `error`。开启 `debug: true` 可看到 AI 每次调用工具的名称、入参、结果与每轮 token 用量，深度研究的迭代轮次与搜索词，便于排查。

### 日志字段说明

一次典型对话会在控制台打出五行 `mark` 日志，各字段含义如下（以实际输出为例）：

```
[trigger] user=3891977697 gid=960179589 mode=at inputLen=83
[chat]    user=3891977697 gid=960179589 conv=3 model=mimo-v2.5-pro persona=default vision=off thinking=off ctx=1116字
[agent]   run start ... inputLen=83 msgs=21 tools=39 maxTurns=50
[agent]   run end turns=1 stop=stop usage={in:14816,out:808} replyLen=1098 totalMs=19188
[chat]    reply turns=1 stop=stop usage=in:14816/out:808 replyLen=1098
```

**`[trigger]`** —— 收到消息、判定触发方式时：

| 字段 | 含义 |
| --- | --- |
| `user` | 触发者 QQ |
| `gid` | 群号（私聊显示 `-`） |
| `mode` | 触发方式：`at`（艾特）/ `cmd`（触发词命令） |
| `inputLen` | 用户输入字符数 |

**`[chat]`** —— 单轮装配完成、调模型前（本轮上下文快照）：

| 字段 | 含义 |
| --- | --- |
| `conv` | 会话 id（`#进入聊天` / `#new` 切换；隔离多轮历史） |
| `model` | 当前主模型 id |
| `persona` | 当前人设 id（`default` = 内置默认身份） |
| `vision` | 主模型视觉能力：`on` = 直发原图 / `off` = 走视觉子模型图转文 |
| `thinking` | 模型深度思考（reasoning）开关：`on` = 已启用 `agent.thinking` / `off` = 未启用 |
| `ctx` | 注入 system 的「情境感知」文本长度（字）：含时间/发言者/运行能力盘点/近期群聊等；为空则不显示 |

**`[agent] run start`** —— ReAct 主循环开始：

| 字段 | 含义 |
| --- | --- |
| `msgs` | 发给模型的历史消息条数（会话窗口裁剪后，含本轮 user） |
| `tools` | 注册给模型的工具总数（内置 + 自定义 + MCP） |
| `maxTurns` | 工具调用轮次预算上限（`agent.maxTurns`，默认 50） |

**`[agent] run end` / `[chat] reply`** —— 循环结束 / 回复发出后：

| 字段 | 含义 |
| --- | --- |
| `turns` | 实际执行的模型轮次数（`1` = 一次性回复，未调工具） |
| `stop` | 终止原因：`stop`/`end_turn` = 正常回复结束；`clarify` = 澄清短路退出；`max_turns` = 轮次耗尽；`blocked` = 被注入防御拦截 |
| `usage` | token 用量：`run end` 的 `{in,out}` 与 `reply` 的 `in:../out:..` 是同一份累计值（多轮累加） |
| `replyLen` | 最终回复字符数 |
| `totalMs` | 本轮总耗时（毫秒），仅 `run end` 有 |

> **排查要点**：`turns` 很大 / `stop=max_turns` → 多步任务卡住或工具反复失败；`usage.in` 持续偏高 → 上下文/记忆膨胀，考虑设 `contextWindow` 开压缩；`ctx` 字数 → 判断情境注入量是否过大。

**MCP 连不上时先看报错措辞**：`request timeout: initialize` = 服务端进程起来了但没在超时内响应握手（npx 首次下载慢 / 网络不通 / 命令错误）；`ENOENT spawn npx` / `进程退出码-2` = 容器里压根没有 npx（精简 Docker 镜像常见）—— 解决方案见上文 `agent.mcp` 章节的 ⚠️ 说明；`进程退出码 N` + stderr = 服务端启动即崩溃（缺 API Key / 依赖 / Node 版本，看 stderr 末尾）。

---

## 🙏 鸣谢

本站在开发过程中参考/借鉴了以下开源项目与研究的思想与实现，谨致谢意：

**框架基座**

- [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) —— 插件运行的基座框架
- [Miao-Yunzai](https://github.com/Le-niao/Yunzai-Bot) —— Yunzai 生态前身
- [NapCat](https://github.com/NapNeko/NapCatQQ) —— OneBot 协议端（QQ 对接）

**伪人模式（核心参考）**

- **[MaiBot](https://github.com/MaiMai-with-u/MaiBot)**（MaiMai-with-u）—— 伪人模式的全程参照：对话关系链与指代消解（回复链解析、被引原文注入、防止认错说话对象）、回复必要性评分体系（强相关分/内容分/压力分/存在感惩罚/指数退避的骨架与参数）、Planner 工具调用式决策（`planner_no_tool_end`、wait 连续上限）、记忆命中作用域白名单（`_is_hit_allowed`：只允许活跃人物命中）、目标消息块防混淆措辞、表情包 `[sticker:名称]` 标记式发送、回复编排（`chat/utils`）。我们在其思路上做了自研增强：Conversation Grounding 层（三对象拆分 + 实体白名单 + 生成校验重生成）、对象纠错识别与情绪冲销、bot↔bot 闭环熔断。

**记忆与记忆体系**

- [OpenClaw](https://github.com/openclaw/openclaw) 「文件即真相」记忆设计（`MEMORY.md`/`USER.md` 人可读可编辑 + 主动召回）
- MaiBot 心意/记忆架构 —— 伪人独立记忆库的「睡眠整合」三层记忆设计（短时缓冲 → 每日整合 → 遗忘衰减）

**管理面板**

- [Guoba-Plugin](https://github.com/guoba-yunzai/guoba-plugin) —— 配置热加载与可视化面板思路（本插件自带 Web 面板）

**学术研究（GroupWorld × SelfState 设计文档引用）**

- Gratch & Marsella — *A Domain-independent Framework for Modeling Emotion* / *EMA: A Process Model of Appraisal Dynamics*（情绪评价理论 OCC/EMA）
- Steunebrink et al. — *A Formal Model of Emotions: An Analysis and Formalization of the OCC Model*
- Park et al. — [Generative Agents: Interactive Simulacra of Human Behavior](https://github.com/joonspk-research/generative-agents)（记忆流与社会仿真）
- Cai et al. — *From Triggers to Emotions: A CPM-Grounded Appraisal Multi-Agent*（情绪触发→评价多智能体）

若列举有遗漏或表述不当，欢迎指正，将及时补充修正。

---

## 📞 联系

- **QQ 群**：[960179589](https://qm.qq.com/q/960179589)
- **作者 QQ**：3891977697

问题反馈、功能建议、工具包分享欢迎进群交流。

## 许可证

[GPL-3.0](./LICENSE)
