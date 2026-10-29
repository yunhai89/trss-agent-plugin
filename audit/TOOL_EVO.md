# Tool Evolution / 工具元数据排障记录

> 历史事故与修复决策留档。改工具元数据 / seed / manifest 前先读这里，避免踩同一个坑。

## toolEvo seed 全量失败（v1.45.2）

**现象**：启动日志 `[toolEvo] seed 失败 manifest 校验失败: /permissions/sideEffects/0 must be equal to one of the allowed values`。

**原因**：内置工具 `diagram_render` 的 meta 写 `sideEffects: ['file_write']`，不在 manifest schema 枚举
`{none, read, write, network, message, delete}` 内。`seedBuiltinTools` 遍历内置工具时**第一条脏数据就抛错**，
整批 seed 中止 → 后续内置工具全部没有入库版本（调用埋点 `version_id=null`、健康检测漏报）。
更糟的是旧 seed 先 `createTool` 再 `createVersion`，失败会在 `tools` 表留下**无 active 版本的空壳**，
下次启动因「已存在」直接 `continue`，永远补不上版本（次生问题）。

**修复**：
1. `diagram_render` 改为合法值 `write`（语义不变：仅写插件 `data/diagram/` 临时目录）。
2. `manifest.js` 新增 `normalizeSideEffects()`：别名纠正（`file_write→write`、`send→message`、`http→network`…）、
   去重、空值补 `none`、未知值剔除并收集；`makeManifest` 统一走归一化，第三方工具脏 meta 不再连累整批。
3. `seedBuiltinTools` 返回 `warnings`（未知副作用值 / 空壳自愈），`apps/agent.js` 逐条 `Log.warn`。
4. 空壳自愈：已存在但无 `active_version_id` 的工具会**补建版本并绑定**，修复历史残留；二次 seed 幂等。
5. schema 未放宽：`validateManifest` 仍拒绝未归一的 `file_write`（证明是入口兜底而非降低标准）；
   自动生成候选的 `generationPermissionViolations` 仍只允许 `none/read`（别名归一后同样被拦截）。

**验证**：
- `node model/toolEvo/manifest.test.mjs`（32 断言：别名/去重/空值/未知、makeManifest 归一后通过 schema、
  schema 未放宽、生成闸仍只允许 none/read）
- `node model/toolEvo/integration.test.mjs`（10 用例：新增「脏 sideEffects 不连累整批入库」与
  「无版本空壳工具自愈补建 + 幂等」）
