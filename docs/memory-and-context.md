# 记忆体系与上下文缓存

> 本文是主 README 的拆分文档。返回 [README](../README.md)。

## 🧠 记忆体系（参考 OpenClaw「文件即真相」）

两层记忆，互补：

- **声明式记忆（`MEMORY.md` / `USER.md`）**：Agent 的个人笔记 / 用户画像，**Markdown 文件、人可读可编辑**（位于插件目录 `data/memories/`，按 scope 分目录）。每条一行 `- ` bullet，有字符预算（memory 2200 / user 1375）。模型用 `memory` 工具 add/replace/remove 维护，自动注入 system prompt。旧版 `memory.json`/`user.json` 首次加载自动迁移为 `.md`。可直接编辑文件，重启后生效。
- **召回式记忆（`memory_search` 工具）**：跨会话的长期记忆（偏好/身份/事实/近期事项），相似度×时间衰减召回。**模型主动检索**——回答涉及用户先前说过的偏好、历史决策、待办前，先调 `memory_search(query)` 核实，不要凭印象作答（移植 OpenClaw "Mandatory recall step" 语义）。结果带类型与日期引用。
- **统一用户画像（`agent.profile`）**：把上述散落证据收敛成分面结构（身份/沟通风格/偏好/忌讳/专长/事实），每条带证据、置信、来源（observed/inferred/corrected）与审计链，动态注入且**可纠错、可演进**。隐式风格（消息长短/表情/提问率/活跃时段）由统计推断并标注「（推断）」，样本不足不推断。
- **纠错闭环**：用户明确纠正（"不是X，是Y"/"更正：…"）时，旧记忆标记 `corrected` 不再召回/注入（保留 `prev` 审计链），更正说法以高置信写入；画像同步按"命中旧说法→整句替换"更新。
- **召回质量**：候选多于要取条数时按 MMR + 每类上限去冗余，避免同义旧事挤满上下文；记录每条记忆的"注入/被引用"使用反馈，反复注入却从未被引用的自动降权。

指令：`#记忆` 查看、`#忘掉 <关键词>` 遗忘；`#画像` 查看用户画像、`#忘记画像 <关键词>` 从画像移除。

### 本地向量索引（知识库 RAG）

知识库（`kb_search`）在 embedding 检索之上增加了一层**插件内嵌的本地向量库**：

- 存储：`data/vectors/kb/vectors.bin`，单文件格式（magic + JSON 元数据 + Float32 向量），写入用 `tmp + rename` 原子替换。
- 基线检索：Flat / exact cosine，Top-K 小顶堆；零 native 依赖。
- 可选 ANN：`agent.kb.vectorBackend: auto` 时若装了 `hnswlib-node` 就用 HNSW（`data/vectors/kb/hnsw.bin`），否则退回 Flat。HNSW 参数 `m` / `efConstruction` / `efSearch` / `rerank` 可调；ANN 只负责取候选，最终统一用 Flat 向量精确重排，降低近似索引的召回损失。
- GPU（可选）：`cuvs-node` + NVIDIA GPU 时可用 CAGRA（`data/vectors/kb/cuvs.bin`）。**不会自动启用**：必须同时设置 `vectorBackend: cuvs` 与 `vectorGpuConsent: true`，且建议先确认 GPU 空闲，避免抢占用户已有任务。未授权/模块缺失/GPU 不可用时自动回退 HNSW 或 Flat。
- 一致性：KV 里的 `chunks[].embedding` 仍是事实源，向量文件只是可重建的加速层；索引缺失、损坏或与当前 embedding 模型签名不一致时会自动按 KV 重建，或降级为 BM25 词面检索。
- 换 embedding 模型后，签名校验会阻止新旧向量混用；执行 `#知识库重建` 重新 embedding 并重建索引。
- 关闭本地索引：`agent.kb.vectorStore: false`，退回 KV 内全量 cosine 扫描。

安装可选后端：

```bash
pnpm add hnswlib-node                      # CPU HNSW（普通云服务器推荐）
# GPU（Linux x86_64 + CUDA 12.x，安装包约 1.8GB）：
pnpm add cuvs-node
```

> npm 11+ 默认阻止依赖的 install script；若安装后 `#向量库状态` 仍显示 Flat，执行 `npm install-scripts approve hnswlib-node && npm rebuild hnswlib-node`。`hnswlib-node` 编译失败不会影响插件加载，只是自动回退 Flat。
>
> 服务器性能自检：`node scripts/vector-benchmark.mjs --n=10000 --dim=128 --queries=50 --topk=5`（检测 GPU/后端并用合成向量测建库与查询延迟；`--cuvs` 需确认 GPU 空闲）。

> 说明：个人召回记忆（`RecallStore`）每用户默认上限 200 条，线性扫描成本很低，暂不单独建向量索引；后续扩大上限或做跨用户全局检索时再复用同一套 `LocalVectorStore`。

---

## 💰 上下文压缩与缓存经济性

面板「Token 缓存 · 命中率」= `cacheRead / observedInput`（同一窗口内 run end 累计，单位是 token）。稳态下它有一个能算出来的上界：

```
命中率 ≈ 1 − 2·d·H / (H² − K²)
```

- `d` = 每轮真正新增的 token（新用户消息 + 工具结果 + 注入的情境/记忆 + 回复与推理回灌）——必然 miss 一次，之后一直命中；
- `H` = 压缩高水位（`contextWindow × contextHighRatio`）；
- `K` = 压后目标（`contextWindow × contextLowRatio`）。

据此得到的实践结论（v1.26.3 / v1.26.4 两处修复都由此而来）：

1. **一定要配 `contextWindow`**：不配则按消息条数水位（`contextMsgHighWater`/`contextMsgLowWater`，默认 30→18）压缩，上下文长期只有 ~2 万 token，命中率被压在 60% 上下；
2. **窗口吃满 + 压得深**：`H` 越大、`K` 越小命中率越高（`H` 大让同一段前缀被反复复用；`K` 小让「前缀重建」的代价更小）。例如 `H=0.8W, K=0.15W` 明显优于默认 `0.65/0.45`；
3. **别让前缀变形**：system 里的工具目录必须与「本轮激活了哪些工具」无关（v1.26.3 起固定为配置静态集，此前每激活一批工具就整段重付）；
4. **收尾/评判调用要与主请求同形**：`tool_choice:'none'` 会让服务端丢掉 tools 段、换成另一套渲染，这类调用整段 miss（v1.26.4 起不再下发，改由指令禁工具）；
5. **`d` 越小越好**：`keepReasoning: false`（少回灌推理）、`maxToolResultChars` 适度收紧、情境注入量（日志里的 `ctx` 字数）别过大。

6. **窗口口径要准（v1.26.6）**：`contextWindow` 按**估算 token** 计数，估算器自 v1.26.6 起 CJK 感知（中文/日文/韩文 ≈ 1 token/字，其余 ≈ 1 token/4 字符）。此前统一按「字符数 ÷ 4」，中文会话的真实请求量被低估 1.5~2.4 倍——实测把 `contextWindow` 配成 32000 的会话，真实 `prompt_tokens` 能涨到 14 万，压缩时机不可预期、还可能顶穿模型真实窗口。请把 `contextWindow` 填成**模型真实窗口**。

7. **反思反馈不许进 `system`（v1.26.11）**：交付前自检判定「需要修正」时，反馈文本此前被拼进 `system` 参数——`system` 是请求最前缀，末尾追加一段也会让其后的**全部历史消息**失去前缀复用。实机归因：7 次 `revise=true` 之后的轮次命中率平均只有 **13.6%**（最小只剩 4,096 token），其余轮次 97%+。现改为在请求 `messages` 尾部追加一条 `role:'system'` 消息：模型仍把反馈当系统自检指令（不会回「你说的对…」），而 `system` 与历史前缀逐字节不变（真实 relay 同场景实测 92.4% 命中）。
8. **warm Token 命中率（面板 v1.26.13 起）**：面板新增「warm Token 命中率」——剔除每个会话首个请求（必然全 miss）后的**稳态**命中率，这才是「多轮对话缓存命中率」的真实指标；面板头条 `Token 命中率` 含冷启动（新会话、重启、缓存过期各一次全 miss），会被摊薄。`scripts/cache-hit-report.mjs` 同时输出两个口径与各自是否达标。
9. **工具数组必须跨轮恒定（v1.26.12，`toolDiscovery.stableList` 默认开）**：受控探针（真实 relay）实测——把 `tools` 数组从 6 个**追加**到 7 个，命中率由 97.6% 直接掉到 **0.0%**（退回 6 个又恢复 97.6%）；同法在 `system` 尾部追加一段同样是 **0.0%**。原因是 `tools`/`system` 都渲染在请求最前缀，尾部追加会让其后全部 token 位置偏移。按需发现模式会让 `activeTools` 随 `tool_search` 命中增长，**每激活一次就打穿一次缓存**：实机一次 run 内 `toolsSent` 12→33→43，那几轮命中率只有 25%/33%/32%/34%。现在默认每轮下发 registry 全量工具定义（首轮多付约 1 万 token，之后全部命中）；如需旧的追加式增长（省首轮 token、但每次激活打穿缓存）设 `toolDiscovery.stableList: false`。
10. **声明式记忆快照不许进 `system`（v1.26.22）**：`MEMORY.md`/`USER.md` 的快照此前注入 `system`，而模型**在会话内调用 `memory` 工具写一条记忆就会改变它** → `system` 变化 → 其后全部历史前缀失效。实机归因（23:00 窗口）：3 轮 `break:memory_snapshot` 命中率仅 **4.5%**，miss 263,317 token（占该窗口全部 miss 的 **83.7%**）。现改为注入**本轮 user 消息尾部**（与情境/召回记忆同一处理），跨 run 的 `system` 逐字节不变；写入的记忆在**下一个 run** 的 user 消息里可见。

11. **表情目录不许进 `system`（v1.26.37）**：表情目录（`sticker.listTopN`，含自动发现入库的条目）此前是 `system` 的一段——而 `sticker.autoDiscover` 开着时**任意群成员发一张图**就会改变它，等于「谁发了张新图」就改掉该用户/该群**后续所有会话**的前缀。实机取证：14 个会话首轮前缀指纹里 `stickerVersion` 有 **4 种**取值，而 `systemHash`/`toolHash`/`guardHash` 全同；会话 5 首轮 `prompt 66,177` 只命中 `4,096`（6.2%）。受控探针证明 relay 的前缀缓存**不按会话分桶**（换全新 `sessionId`、同前缀仍 97.4% 命中）——也就是说 `system`+`tools` 一旦逐字节稳定，**新会话可直接复用这段前缀**。现改为**会话首轮注入 user 消息一次**（不重复写历史、仍过不可信边界标注），`system` 从此与表情发现无关。

> 压缩是**无损**的：被移出窗口的原文整块归档（sha256 内容寻址），窗口内留结构化台账，随时可用 `context_recall` 工具按 ref/关键词取回原文——所以「压得深」不等于「丢历史」。
> 面板的 cold/warm 分层：`cold` = 该会话首个请求（必然全 miss），`warm` = 其余请求；衡量改造效果只看 warm 层。

### 实测（`stress/real/cache-hit-sim.mjs`，真实 provider）

用插件自己的 `Agent` + 真实端点跑多轮群聊（含工具轮、情境注入、按需激活工具），逐轮记录
`prompt_tokens` / `cached_tokens`；每轮新增量 `d` 按实机日志口径构造（≈4K token/轮）：

| 场景 | `contextWindow` | high/low | 压缩次数 | Token 命中率（全部） | warm |
| --- | --- | --- | --- | --- | --- |
| A 现状档 | 32000 | 0.65/0.45 | 2 | 94.45% | 94.64% |
| B 推荐档 | 200000 | 0.8/0.1 | 0 | 97.66% | 97.88% |
| C 推荐档 | 128000 | 0.8/0.1 | 0 | 97.66% | 97.88% |
| D 长会话（CJK 估算器） | 256000 | 0.8/0.1 | 0 | 98.79% | 98.85% |

结论：修复 v1.26.3（工具目录静态化）、v1.26.4（收尾/评判同形）与 v1.26.11（反思反馈不进 system）之后，
命中率已由实机的 66% 升到 95% 以上；窗口比例决定的是**余量**（`H` 越大、`K` 越小越接近上限），而 `H` 小的档
一旦进入「压缩周期」就会掉到 95% 以下（A 档两次压缩各带一次 ~25% 的整段重建）。

自测（未配 Key 自动跳过；`CACHE_ASSERT=1` 时 warm 命中率低于 `CACHE_MIN_RATE`（默认 0.95）以退出码 1 失败）：

```bash
AGENTS_CONFIG=/path/to/config.yaml SIM_WINDOW=256000 SIM_HIGH=0.8 SIM_LOW=0.1 SIM_TURNS=40 \
  node stress/real/cache-hit-sim.mjs
```

要贴近实机「多个群各自冷启动」的形态，用 `SIM_SESSIONS`（会话数，每个会话有独立 system 前缀＝各自冷启动）、
`SIM_RUNS`（每会话的 run 次数；一次用户消息 = 一个 run，上下文在其中累积）、`SIM_GAP_MS`（run 之间的空闲间隔）：

```bash
AGENTS_CONFIG=/path/to/config.yaml SIM_WINDOW=256000 SIM_HIGH=0.8 SIM_LOW=0.1 \
  SIM_SESSIONS=5 SIM_RUNS=3 SIM_TURNS=6 node stress/real/cache-hit-sim.mjs
```

汇总会额外打印每个会话各自的命中率与「命中 <50% 的轮」清单（冷启动轮应只出现在每个会话的首次调用）。

### 核对线上命中率（`scripts/cache-hit-report.mjs`）

面板只给一个总数，排查时要看「miss 花在哪」。该脚本直接读 `data/logs`（默认目录，可用 `--dir` 指定实机插件日志目录），
按面板同口径算出 `cacheRead / observedInput`，并把 miss 归到具体原因（支持 `--dir/--since/--top/--target/--json`）：

```bash
node scripts/cache-hit-report.mjs --dir /path/to/plugins/agents-plugin/data/logs
# --since '2026-10-16 21:00' 只看重载后的新会话；--target 0.95 自定义目标；--json 供脚本消费
```

输出的四类 miss 含义：`break:tool_schema` 等 `break:*` = 前缀被打断（工具目录/记忆快照变化，v1.26.3 起目录已固定）；
`COMPACTED/after cache_compact` = 压缩后整段重建（放大 `contextWindow` 可消除）；`cold` = 会话首个请求，必然 miss；
`turn:纯新增内容` = 每轮真正新增的 token，**无法靠缓存消除**，只能靠减小 `d`（`keepReasoning:false`、收紧
`maxToolResultChars`、控制情境注入量）。

### 清空命中率统计（面板 · v1.28.0 起）

命中率是两个数据源合成：**Redis 日统计**（`agents:stats:day:*`，面板趋势/工具统计/命中率主源）与 **devLog 会话日志**
（`data/logs/*.log`，时间线与「未观测旧日志」计数）。想让面板的命中率从一次干净的改动后重新计时（例如刚推出
`contextWindow` 调参 / 刚上线缓存修复，不想被历史污染），在概览 → **Token 缓存** 卡点「**清空统计**」：
确认弹窗会明示影响面，执行后**两处一起清**（日统计键全删 + 日志文件全删，并失效 overview 的 60s 聚合缓存），
下次对话从零累计。记忆/人设/会话/定时/配置一律不动；此操作不可恢复，且**日志时间线会同时清空**——
若只想保留日志排查，请手工在配置里改 `agent.devLog.dir` 或先备份 `data/logs`。

---
