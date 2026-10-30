# 文档索引

主 README 只保留项目介绍、安装与快速排障；完整内容按主题拆分在这里。

## 入门

- [项目亮点与能力地图](features.md) —— 全部能力清单与状态
- [分支、更新与重启](updating.md) —— 分支策略、自动更新、重启/重载边界
- [QQ 官方机器人接入](protocols/qq-official.md) —— 自实现适配器、ID 规则、主人配置、Markdown、按钮卡片
- [Web 管理面板](web-panel.md) —— 面板入口、配置中心、日志/会话/任务视图
- [指令一览](commands.md) —— 全部聊天、管理、运维指令

## 配置与运行时

- [配置参考](configuration.md) —— `agent.*` 全量配置说明
- [工具进化](tool-evolution.md) —— 生成 → 验证 → 审批 → 版本化
- [记忆体系与上下文缓存](memory-and-context.md) —— MEMORY/USER、召回、压缩、缓存经济性
- [安全与信任边界](security.md) —— RBAC、审批、注入防御、沙箱边界

## 执行面

- [终端执行与 E2B 沙箱](execution/e2b.md) —— 云托管 / 自托管 / 网络策略
- [网页抓取](execution/web-crawl.md) —— crawl4ai 与 HTTP 降级
- [Stagehand 浏览器自动化](execution/stagehand.md) —— goto / observe / extract / act
- [表情包](sticker.md) —— 自动发现、视觉打标、频率管控

## 开发与运维

- [架构与目录](architecture.md) —— 模块分层与配置治理
- [扩展开发](extensions.md) —— 工具包 / 技能入口
- [开发指南](../开发指南.md) —— 工具 / 技能完整 SDK 与示例
- [运维](operations.md) —— 环境变量、SearXNG、日志字段、自检
- [常见问题（完整 FAQ）](troubleshooting.md) —— 全量排障
- [更新日志](changelog.md) —— 最近版本记录
- [鸣谢、联系与许可证](credits.md) —— 参考项目与联系方式

[← 返回主 README](../README.md)
