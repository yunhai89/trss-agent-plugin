# 最近版本

> 本文是主 README 的拆分文档。返回 [README](../README.md)。

## 🧾 最近版本

| 版本 | 内容 |
| --- | --- |
| **v1.46.9** | cuVS GPU 真机落地：新增 `cuvs.algorithm`（默认 `brute_force` GPU 精确检索，`cagra` 可选；`cagra` 单次 k 上限 64）、cuVS 持久化/增删改与 KnowledgeStore 集成真机测试；`cuvs-node` 改为可选 peer（不强制普通用户下载 1.8GB）；新增 [GPU 向量检索部署文档](deploy/gpu-vector.md)，含 RTX 2080 实测基线与回滚 |
| **v1.46.8** | 向量库新增可选 HNSW（hnswlib-node）与 NVIDIA GPU cuVS/CAGRA（cuvs-node）后端：`auto` 在装了 hnswlib-node 时用 HNSW，GPU 必须显式 `vectorBackend: cuvs` + `vectorGpuConsent: true` 才启用（启动只检测/提示，绝不自动占用 GPU）；ANN 候选统一用 Flat 向量精确重排，索引损坏/换模型自动回退或重建；新增 `#向量库状态` 与 `scripts/vector-benchmark.mjs` 性能自检 |
| **v1.46.7** | 新增插件内嵌本地向量库：知识库改用纯 JS Flat 精确索引（`data/vectors/kb/vectors.bin`，单文件原子落盘 + Top-K 小顶堆），KV 仍是事实源；索引缺失/损坏/换 embedding 模型时自动重建或降级词面检索；新增 `agent.kb.vectorStore` 开关与 `LocalVectorStore` 单测 |
| **v1.46.6** | Stagehand 浏览器自动化 `stagehand__act` 取消单独审批：移除 `meta.alwaysConfirm`，点击/输入/提交作为多步浏览器任务直接执行（仍受 `stagehand.permission`/RBAC 控制，保留同一会话串行）；文档、锅巴与 Web 面板提示同步 |
| **v1.46.5** | `audit/` 移出版本控制（本地保留）并加入 `.gitignore`；README/架构文档移除审计目录链接 |
| **v1.46.4** | 项目地址迁移：GitHub 仓库更新为 `yunhai89/yunzai-agent-plugin`；README clone URL、package homepage/repository/bugs、Enka UA 链接同步 |
| **v1.46.3** | 项目名称去 TRSS：package name/UA/工具作者标识改为 `yunzai-agent-plugin`；README 增加英文定位；仓库 slug/clone URL 仍为 `trss-agent-plugin`，需在 GitHub/Gitee 手动改名后同步 |
| **v1.46.2** | SEO / 品牌标签优化：主标题与 package keywords 不再以 TRSS 为主标签，改为 Yunzai AI Agent Plugin；补充 AI Agent / QQ Bot badges、适用场景与 repository/homepage/bugs 元数据 |
| **v1.46.1** | 文档重构：主 README 仅保留项目介绍、安装与快速排障；能力地图、协议接入、Web 面板、指令、配置、安全、执行面、运维、完整 FAQ、更新日志、鸣谢等拆到 `docs/`，新增文档索引 |
| **v1.46.0** | 指令统一：`#agents帮助/状态/登录/更新/版本/更新日志/重载` 全部改为 `#agent帮助/状态/登录/更新/版本/更新日志/重载`；插件显示名同步为 `agent*`（仓库/配置路径仍为 `agents-plugin`）。旧 `#agents*` 不再匹配，请更新收藏与脚本 |
| **v1.45.14** | 修复 QQ 官方机器人 `get_chat_history` 必然失败（官方 OpenAPI 没有群历史接口）：新增进程内群消息环形缓存（每群 200 条 / 24h，按 message_id 去重），`get_chat_history` 在协议端不支持/返回空/调用失败时自动回退本地缓存；空缓存返回可读 `note` 而不是 error，避免模型无意义重试。开启官方平台「全量消息」可积累更多历史 |
| **v1.45.13** | 修复 Web 配置中心「主人列表」只接受 5-11 位 QQ 号：QQ 官方机器人主人 ID 是 openid（如 `807AC1596B40D96591A5ACBEB3CFFA4D`、`1903797111:807AC…`、`qg_807AC…`），此前输入框直接提示「QQ 号需 5-11 位数字」无法添加。现兼容 QQ 号与官方 openid 三种形态，锅巴/yaml/README 提示同步 |
| **v1.45.12** | 修复 `stagehand__extract/observe/act` 报 `400 MissingSessionID: Request is missing x-opencode-session`：goto 正常但 Stagehand 内部 LLM 请求只带了 `Authorization`，未带主 provider preset 的 UA 与会话头。现透传 `User-Agent` + `x-opencode-session`（值绑定浏览器会话 key），OpenCode Zen/Go 下三个原语恢复可用 |
| **v1.45.11** | 修复 Stagehand 仍探测不到本机 Chromium：Puppeteer v19+ 缓存目录是 `chrome/linux-<ver>/chrome-linux64/chrome`、Playwright 新版是 `chromium-<rev>/chrome-linux64/chrome`，此前只匹配纯数字目录与 `chrome-linux`，导致 v1.45.10 的自动探测在真实机器上全部落空。现兼容新旧布局、支持 `PUPPETEER_CACHE_DIR`/`PLAYWRIGHT_BROWSERS_PATH`、多版本按数字取最新 |
| **v1.45.10** | 修复 `stagehand__goto` 报 `The CHROME_PATH environment variable must be set…`：Stagehand v4 未给 `executablePath` 时只认系统 Chrome。新增本地 Chromium 自动探测（配置 → 环境变量 → **Puppeteer 自带 Chromium** → `~/.cache` 缓存 → 系统路径），找不到时给出安装/配置建议而非 SDK 晦涩报错 |
| **v1.45.9** | 修复 Web 面板登录后所有页面报 `Failed to execute 'fetch' … String contains non ISO-8859-1 code point`：用户把 `#agent登录` 返回的整段内容（含中文）粘进登录框时会原样存进 localStorage 并拼进 `Authorization` 请求头。现统一归一化 token（支持直接粘贴**完整登录链接**、自动抽取 48 位 token、剥离中文/脏字符），历史脏值读取时自愈，非法输入明确提示 |
| **v1.45.8** | 帮助图渲染超时默认改为 **300000ms（5 分钟）**：新增 `agent.render.helpTimeoutMs`，与普通卡片图 `render.timeoutMs`（默认 15s）分开——帮助卡片最长，弱机器/冷缓存首次渲染常超过 15s，此前会直接降级成文本；超时仍按原策略降级并进入冷却 |
| **v1.45.7** | 修复按钮卡片「本人点自己的按钮提示无权限操作」：群聊 `specify_user_ids` 未剥 `<appId>:` 前缀（平台只认原始 openid）；私聊 C2C/频道私信客户端不支持 `type:0` 指定用户按钮 → 自动降级 `type:2`（私聊仅对方一人，安全等价） |
| **v1.45.6** | QQBot 叶子级加固：被动回复严格按 5 分钟窗口（长任务不再用过期 msg_id 白发送失败）；Markdown 回复正确 @ 回复人（`<qqbot-at-user>`，此前被静默丢弃）；API 401 自动刷新 token 重试、start 阶段 token 5xx 退避重试；媒体 >10MB 跳过不读入内存；频道私信 ID/源频道修正；READY 迟到补挂载、断连中断连接等待、`_attachBot` 幂等；网络类 token 失败继续重连（此前一次抖动永久掉线）；回填 bot.fl/gl/gml 并对齐 login/logout 契约 |
| **v1.45.5** | 修复官方机器人下指令文本翻倍：适配器预设了 `data.msg`，而 TRSS `dealEvent` 会把 `message` 里的 text 段再累加一次 → `e.msg` 变成「#设置主人#设置主人」，导致 `^#设置主人$` / `^#agent更新$` 这类精确匹配规则失效（`^#状态` 前缀规则却正常，表现为「有的指令能用有的不能」）。现已不预设 `msg`，交由框架从消息段构建 |
| **v1.45.4** | 修复官方机器人下**云崽框架指令被 AI 抢占**（`@机器人 + #设置主人` 无反应）：新增「指令透传」——以 `#`/`＃`/`/` 等开头且不是本插件触发词的消息 `return false` 交给后续插件处理（`agent.commandPassThrough` 默认开，可关）；面板/锅巴/文档同步 |
| **v1.45.3** | 修复 QQ 群机器人「不管发什么都回复」：开启全量消息权限后 `GROUP_MESSAGE_CREATE`（非 @）也被无条件补 `at` 段 → `e.atBot=true` → `trigger=at` 全量触发。现按事件类型 + `mentions.is_you` 判定，只对真正 @ 回复；按钮点击仍正常触发；非 @ 群消息保留投递供伪人/群世界旁听 |
| **v1.45.2** | 修复 toolEvo seed 全量失败：内置工具 `diagram_render` 的 `sideEffects:['file_write']` 不在枚举内 → 整批内置工具无法入库（埋点/健康检测失效）。现改正为 `write`，并在 seed 入口做副作用归一化（别名纠正 + 未知值剔除告警 + 无版本空壳工具自愈补建） |
| **v1.45.1** | 修复 QQBot 网关无限重连：`intents: 0` 被原样下发（IDENTIFY intents=0 → 平台 4013）现回落为 33554432；4013/4914 按「只降不升」自动降级 intents 重连（耗尽则停止并给出可执行提示）；同一 socket 重复 close 不再双计重连；INVALID_SESSION 不再提前合成 4006（保留真实 close 码用于判断降级）；默认 intents 改为最小可用集（群@+C2C） |
| **v1.45.0** | 首次启动即给 Web 默认访问地址（带 token，持久化 + 启动日志 + `data/web/console-url.txt`）：**没有协议端也能进面板配模型**；面板内一键复制；登录只在「认证失败」时清 token（运行时未就绪不再误报登录失败） |
| **v1.44.1** | 文档重构：项目介绍按最新能力重排（能力地图 / 三协议端接入 / Web 面板 / 完整指令表 / 架构与配置治理 / 运维 FAQ） |
| **v1.44.0** | Web 新增「机器人账号」页：QQBot 账号增删改 / 连接状态 / 排障；账号单一真源（`accounts[]`）；新 API `/api/qqbot*` |
| **v1.43.1** | 对齐 2026 官方文档域名：`api.bot.qq.com` 主用，`bots.qq.com` / `api.sgroup.qq.com` 自动回退 |
| **v1.43.0** | 自实现 QQ 官方机器人适配器：AppID + AppSecret 直连（官网已标 Token 弃用）；网关 IDENTIFY/RESUME/心跳/重连；v2 REST 发消息/富媒体上传；Responsive markdown / keyboard / 被动回复 5 次上限 |
| **v1.42.0** | 适配 QQ 官方机器人协议：Markdown 直发、inline keyboard（`send_keyboard` 工具）、`/uid`、`/groupid`、scope 目录安全化、ID 非数字兼容、主人兜底 |
| **v1.41.0 / v1.41.1** | 配置审计全量修复：保存改差异、默认值版本化、统一归一、回退模型单真源、锅巴覆盖 379 字段（52 分组） |
| **v1.40.x** | 配置互搏修复：温度 null→0、清空基础模型被回填、chatPermission 兜底、media/kb/render 开关真正生效、Stagehand 默认仅主人等 |
| v1.39.x | 伪人模式：角色人设接入人设库、热重载后运行时重建、接话追问识别 |
| v1.38.0 | 群聊最终回复引用触发消息 |
| v1.37.x | Enka 配装分析；视觉模型按注册表跨厂商路由 |
| v1.36.0 | Enka 角色展柜（原神/星铁/绝区零） |
| v1.35.x | GPT-SoVITS 补齐（五家 TTS 服务商） |
| v1.34.x | Command Code 服务商预设；网络 Happy Eyeballs 修复 |
| v1.29.0 | 子代理预算默认 30 分钟 / 200 轮 + 独立配置卡片 |
| v1.28.0 | Web：自绘确认/输入弹窗、配置中心搜索、命中率统计清空 |
| v1.27.0 | 思考能力乐观默认 + 运行时自适应学习 |

> 完整历史见 `#agent更新日志` 或 `git log`。

---
