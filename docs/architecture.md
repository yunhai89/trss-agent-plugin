# 架构与目录

> 本文是主 README 的拆分文档。返回 [README](../README.md)。

## 🏗️ 架构与目录

```
apps/                 事件分发与回复编排（Yunzai plugin 入口）
  ├─ agent.js         对话主链路（触发→上下文→ReAct→发送）、全部主人/用户指令、运行时装配
  ├─ qqbot.js         自实现 QQ 官方机器人适配器（网关/会话/事件投递 + #qqbot 指令）
  ├─ humanize.js      伪人模式 app（旁听/门控/决策/发送 + 配置校验）
  ├─ groupworld.js    群聊小世界 app（旁听摄入/定时分析/隐私指令）
  ├─ research.js      深度研究入口
  ├─ web.js           Web 面板 HTTP 服务 + #agent登录
  ├─ help.js / render.js / sticker*.js / comfyui-draw.js / update.js
model/                纯逻辑层（零 Yunzai 依赖，可离线测试）
  ├─ agent/           ReAct 内核、循环终止器、工具注册/策略/审批、会话、记忆、压缩归档、回复队列
  ├─ llm/             模型能力注册表、思考判档、embedding、缓存与熔断
  ├─ openai/ anthropic/  协议传输层（流式/重试/错误映射）
  ├─ qqbot/           自实现 QQBot 协议层：token（AppID+AppSecret）/api（v2 REST）/gateway（WebSocket）/events/payload/client/accounts
  ├─ qqofficial/      官方协议适配层：识别/ID/scope 安全/Markdown/键盘/权限门/工具
  ├─ web/             Web 面板 API 路由、鉴权、日志读取、脱敏
  ├─ memory|recall|profile|kb    记忆体系
  ├─ persona|personaLore|prompt  人设与提示词
  ├─ media|vision|stt|tts|document|diagram|comfyui|sticker  多模态与表达
  ├─ search|tavily|crawl|research|miyoushe|enka  检索与内容
  ├─ sandbox|terminal|stagehand|toolkit|toolEvo  执行面、工具 SDK、工具进化
  ├─ multiagent|mcp|skill|schedule  协作与扩展
  ├─ humanize|groupworld|selfstate  群聊智能三件套
  └─ render            浅色主题 + markdown→图片
web/                  Web 管理面板前端（22 个视图，无构建步骤；index.html + assets/js/views/*）
config/               default_config/（模型默认值真源） + config.yaml（用户配置，gitignore）
scripts/              测试运行器、配置对账、环境安装脚本
skills/               技能说明书（SKILL.md 生态）
tools/                外置工具包（自动加载 + tool.config.js 声明配置）
utils/                Config（读写/归一/差异保存/热加载）、Log、DevLog、path
stress/               E2E 接线回归（真实入口 + 桩协议/模型）
```

**配置真源与治理**

- 四类配置面：`config.yaml` 默认值 + Web 配置中心（全量）+ 锅巴（383 字段常用项）+ README/开发指南；
  运行时读取统一经 `utils/Config.js`：`deepMerge 默认值 → normalizeConfig 归一 → 差异落盘 → 热加载`。
- 保存只写差异（不改默认值的键不落盘），老版本全量快照启动时自动压缩（备份 `.bak`）→ 升级后的新默认值自动生效。
- 供应商/模型引用、fallback、`cacheControl`/`thinking` 类型、官方机器人账号等结构由归一逻辑统一收敛，三个入口不会互相打架。
- 历史审计与修复记录按维护策略移出仓库（本地保留，不入版本控制）。

**扩展点**

1. **工具**：`tools/<包>/index.js` + `tool.config.js`（SDK 见 [开发指南](../开发指南.md)）；
2. **技能**：`skills/*.md`（`SKILL.md` 格式，`reload_skills` 热加载）；
3. **提示词**：`model/prompt` 模板 + 自进化覆盖（`#审阅进化`）；
4. **协议端**：`apps/qqbot.js` 适配器模板（新增协议端可参照 `Bot.adapter` 契约）。

---
