# 扩展开发（工具 / 技能）

> 本文是主 README 的拆分文档。返回 [README](../README.md)。

## 🧩 扩展开发（工具 / 技能）

本插件支持两种扩展，**详细的开发文档（完整 API 参考 + 示例）已独立到 [开发指南.md](../开发指南.md)**：

- **工具（Tool）**：给模型新增"动作"，模型可直接调用执行。放 `tools/` 目录自动加载，用 `defineToolPack` / `defineTool` / `param` SDK 编写。
- **技能（Skill）**：渐进式披露的"说明书"，不新增动作、只教模型"什么场景用哪些工具、按什么顺序"。放 `skills/` 目录自动加载，写 `SKILL.md`。

👉 完整的 SDK API（`defineTool` / `param.*` / `getGroup` / `ok` / `fail`…）、运行时 `ctx` 字段、`meta` 选项（审批 / 串行 / 结果截断）、`category` 与 RBAC、多组完整示例与常见陷阱，见 **[开发指南.md](../开发指南.md)**。

### 🧰 外置工具 / 技能收集仓

社区外置工具与技能集中收集在 **[trss-agent-tools](https://gitee.com/YunXi-67/trss-agent-tools)**（[GitHub 镜像](https://github.com/yunhai89/trss-agent-tools)），云崽插件索引库风格、欢迎 PR 提交你的工具/技能：

- 把工具包目录整个复制到本插件 `tools/`、技能复制到 `skills/` 即可使用（示例：QQ 音乐 `qqmusic`）。
- 工具包内提供固定模板 `tool.config.js`（`info`：标题/介绍/作者/版本/图标 + 配置 schema）；插件运行时自动读取，web 面板「系统 → 外置工具」按 schema 动态渲染，**新增工具无需改前端**。
- 用户配置统一存 `agent.tools.<包名>`，复用配置热加载；运行时用 `getToolConfig('<包名>')` 读取。详见 [开发指南.md](../开发指南.md) 与收集仓 [CONTRIBUTING.md](https://gitee.com/YunXi-67/trss-agent-tools/blob/master/CONTRIBUTING.md)。

---
