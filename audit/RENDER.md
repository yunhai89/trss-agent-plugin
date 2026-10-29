# 渲染超时与降级排障记录

## 帮助图渲染超时默认 5 分钟（v1.45.8）

**现象**：弱机器 / 首次冷缓存执行 `#agents帮助`，经常直接收到文本版帮助——图片渲染在 15s 内没完成。

**原因**：帮助卡片是最大的一张 HTML（全量指令/区块），首次渲染含 Chromium 冷启动 + 大图栅格化，
弱机器上常见 20~60s+；而帮助图与普通列表卡片共用 `agent.render.timeoutMs`（默认 15000），被同一预算误杀。

**修复**：
- 新增配置 `agent.render.helpTimeoutMs`，默认 **300000ms（5 分钟）**，只作用于 `#agents帮助`；
  普通卡片图仍用 `render.timeoutMs`（15s）、回复图用 `render.replyTimeoutMs`（30s），互不拖累。
- 解析函数 `apps/render.js: helpRenderTimeoutMs()`：`>0` 用配置值，否则回落 300000。
- 超时仍走原降级链路：`renderCardBuffer` 返回 null → 帮助回文本 + 进入冷却（冷却期内不再重渲染）。
- Web 配置中心「进度 / 回复渲染」与锅巴面板均可调整（`agent.render.helpTimeoutMs`）。

**验证**：`apps/render.test.mjs` 36 断言（新增：默认 300000、显式覆盖、0/负数回落、普通 timeoutMs 不影响帮助图）。
