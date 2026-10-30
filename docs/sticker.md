# 表情包

> 本文是主 README 的拆分文档。返回 [README](../README.md)。

## 🎭 表情包（LLM 自主附带）

模型在回复中自主判断并内嵌表情包，增强拟人感——模型在文本里写 `[sticker:名称]`，插件在发送层解析替换为对应表情包图片：

- **图片模式（默认）**：表情包**内嵌进渲染出的整张回复图片**（文字 + 表情合成一张图）。
- **文本模式**：文本段 + 表情图片段混排发出。

> ℹ️ **表情资源仅来自自动发现**（MaiBot 式）：被动采集群内图片 → 视觉判定+打标 → 入库；不再从远端仓库克隆/更新。功能默认关闭；未开启或库为空 → 不注入清单、模型看不到该功能，零影响。

### 自动发现

开启 `sticker.enable` + `sticker.autoDiscover`，且主模型支持视觉、或已开 `agent.vision.enable` 并（主模型纯文本时）配好 `agent.vision.model` 后，群内图片会被：

1. sha256 去重 → 2. 视觉判定（拒绝照片/普通图片/文档，只收表情包）→ 3. 打标（名称/标签/语义描述）→ 4. 存 `resources/stickers/images/discovered/` 并写入 `index.json`。

入库条目上限 `maxDiscovered`（超限按 `usageCount` 升序淘汰冷门）；单张大小上限 `discoverMaxSizeMB`；采集群白名单 `discoverGroups`（空=所有群）。

### 频率管控（防"每条都带 → 反而更 AI"）

四层叠加，保证偶发而非每条都蹦：① **prompt 强约束**（偶尔/严肃场景不用）；② **概率闸 `sendRate`**（门控通过后仅按概率真正带图）；③ **冷却 `cooldown`**（同会话最小间隔）；④ **防连发**（上一条带过则本条不带）。

### 用法（仅主人）

| 指令 | 说明 |
| --- | --- |
| `#表情包状态` | 总数 / 体积 / 高频 Top5 |
| `#表情包开启` / `#表情包关闭` | 热开关 |

关键配置（`agent.sticker`，`enable` 默认关）：

```yaml
sticker:
  enable: false          # 总开关
  sendRate: 0.25         # 概率闸：门控通过后实际带图概率
  cooldown: 300          # 同会话两次带图最小间隔（秒）
  maxPerReply: 2         # 单条回复最多贴纸数（1~5，硬上限 5；0/非法 → 默认 2，不是「不限」）
  antiConsecutive: true  # 防连发
  autoDiscover: false    # 自动发现总开关（需 sticker.enable + agent.vision.enable +（主模型纯文本时）agent.vision.model）
  discoverGroups: []     # 采集群白名单（空=所有群都采集）
  maxDiscovered: 200     # 自动发现条目上限
  discoverMaxSizeMB: 5   # 单张采集大小上限 MB
```

> **合规**：自动发现只采集群内公开图片，经视觉判定过滤照片/文档；发送侧只发本地 `images/` 内物理存在的文件。
>
> **前置条件**：`sendStickerTool`（默认 `true`）只在 `sticker.enable=true` 时注册 `send_sticker` 工具；`autoDiscover` 还要求多模态总开关 `agent.media.enable` 未关（视觉判定依赖视觉子模型），主模型无视觉能力时需另配 `agent.vision.model`。

---
