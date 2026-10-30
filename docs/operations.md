# 运维：环境变量、SearXNG、日志与自检

> 本文是主 README 的拆分文档。返回 [README](../README.md)。

## 🔧 运维与排障

### 环境变量（可选）

| 变量 | 作用 |
| --- | --- |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | 进程级代理兜底（优先级低于 `agent.proxy`）；浏览器渲染与降级 fetch 均遵守 |
| `PUPPETEER_EXECUTABLE_PATH` | 指定渲染用 Chromium/Chrome 可执行文件（容器/自定义安装时用） |
| `GEMINI_API_KEY` | Gemini 协议未配 apiKey 时的兜底 Key |
| `CRAWL4AI_VENV` / `CRAWL4AI_PYSCRIPT` | 自建 crawl4ai 虚拟环境路径 / 抓取脚本路径（默认自动探测） |
| `E2B_API_KEY` / `E2B_API_URL` / `E2B_DOMAIN` / `E2B_SANDBOX_URL` | E2B 沙箱凭据与自托管端点（优先级高于 `agent.sandbox.*`） |
| `AGENTS_CONFIG` | 指定插件配置文件路径（真实模型冒烟/模拟器用它读实机配置） |
| `REAL_LLM_API_KEY` / `REAL_LLM_BASE_URL` / `REAL_LLM_MODEL` / `REAL_LLM_PROTOCOL` / `REAL_LLM_PRESET` | 真实模型冒烟（`stress/real/*`）的凭据与模型覆盖；也可用 `AGENTS_CONFIG=<config.yaml>` 复用插件配置。**未设则打印 `SKIP_FILE:` 跳过** |
| `KROKI_INTEGRATION` / `KROKI_ENDPOINT` | 真实 Kroki 容器集成测试开关与端点（默认跳过） |
| `E2B_INTEGRATION` | E2B 真连接集成测试开关（默认跳过） |

分级日志（`utils/Log.js`）：`mark`（里程碑）/ `info`（研究进度）/ `debug`（工具入参·每轮 token）/ `warn` / `error`。真正的全链路日志开关是 `agent.devLog.enable`（默认开，按会话分文件写 `data/logs/`）；`debug: true` 等价于强制开启 devLog（即使 `devLog.enable=false`），可在 Web 配置中心「基础设置」或锅巴直接勾选。开启后可看到 AI 每次调用工具的名称、入参、结果与每轮 token 用量，深度研究的迭代轮次与搜索词，便于排查。

### 🔍 SearXNG（自建免费搜索后端）安装

搜索（`web_search`/`#研究`）若无 Tavily/Exa 等 key，可自建 SearXNG（免费、无 key、隐私）。

> ⚠️ **必须给实例开启 JSON 格式**：SearXNG 默认只输出 HTML，而插件走的是 JSON API。未开启时请求 `format=json` 会被实例拒绝，日志报 `SearXNG HTTP 403`。

```bash
# 1) 写一份启用 json 的 settings（挂载进容器）
mkdir -p /opt/searxng
cat > /opt/searxng/settings.yml <<'YAML'
use_default_settings: true
server:
  secret_key: "change-me-to-a-random-string"
  limiter: false
search:
  formats:
    - html
    - json
YAML

# 2) 启动
docker run -d --name searxng --restart=always -p 8080:8080 \
  -v /opt/searxng/settings.yml:/etc/searxng/settings.yml \
  -e SEARXNG_BASE_URL=http://localhost:8080 \
  docker.m.daocloud.io/searxng/searxng:latest

# 3) 自检：应返回 JSON（不是 403）
curl -s "http://localhost:8080/search?q=test&format=json" | head -c 200
```

> 已有实例补开 json：编辑其 `settings.yml` 的 `search.formats` 加入 `json`，再 `docker restart searxng`（改配置不会热生效）。

配置里填：

```yaml
search:
  searxng: { url: "http://localhost:8080" }
```

> 生产建议给 SearXNG 加 reverse proxy + auth（见 [SearXNG 文档](https://docs.searxng.org)）。插件按其 JSON API 调用，无需额外适配。
> 无 key 且未部署 SearXNG 时会回退 DuckDuckGo 抓取；部分网络（如国内）访问不了 DuckDuckGo，此时只能靠 SearXNG 或搜索 API Key。

---

### 日志字段说明

一次典型对话会在控制台打出五行 `mark` 日志，各字段含义如下（以实际输出为例）：

```
[trigger] user=3891977697 gid=960179589 mode=at inputLen=83
[chat]    user=3891977697 gid=960179589 conv=3 model=mimo-v2.5-pro persona=default vision=off thinkingAuto=off thinking=off ctx=1116字
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
| `thinking` | 思考状态：`thinkingAuto=on depth=.. budget=.. by=model\|rule` = 自动决策已生效（`depth` 档位 / `budget` 预算 / `by` 判档来源：小模型或规则）；`thinkingAuto=off thinking=on/off` = 自动决策未生效，显示静态 `agent.thinking` 开关。新/未表态型号默认乐观启用（显示 on）；若厂商拒绝思考字段会自动剥离并记忆，之后转 off（见启动 `[thinking]` 警告与 `thinkingAuto` 配置说明） |
| `ctx` | 注入 system 的「情境感知」文本长度（字）：含时间/发言者/运行能力盘点/近期群聊等；为空则不显示 |

**`[agent] run start`** —— ReAct 主循环开始：

| 字段 | 含义 |
| --- | --- |
| `msgs` | 发给模型的历史消息条数（会话窗口裁剪后，含本轮 user） |
| `tools` | 注册给模型的工具总数（内置 + 自定义 + MCP） |
| `maxTurns` | 工具调用轮次预算上限（`agent.maxTurns`，默认 200） |

**`[agent] run end` / `[chat] reply`** —— 循环结束 / 回复发出后：

| 字段 | 含义 |
| --- | --- |
| `turns` | 实际执行的模型轮次数（`1` = 一次性回复，未调工具） |
| `stop` | 终止原因：`stop`/`end_turn` = 正常回复结束；`clarify` = 澄清短路退出；`max_turns` = 轮次耗尽；`blocked` = 被注入防御拦截 |
| `usage` | token 用量：`run end` 的 `{in,out}` 与 `reply` 的 `in:../out:..` 是同一份累计值（多轮累加） |
| `replyLen` | 最终回复字符数 |
| `totalMs` | 本轮总耗时（毫秒），仅 `run end` 有 |

> **排查要点**：`turns` 很大 / `stop=max_turns` → 多步任务卡住或工具反复失败；`usage.in` 持续偏高 → 上下文/记忆膨胀，考虑设 `contextWindow` 开压缩；`ctx` 字数 → 判断情境注入量是否过大。

**MCP 连不上时先看报错措辞**：`request timeout: initialize` = 服务端进程起来了但没在超时内响应握手（npx 首次下载慢 / 网络不通 / 命令错误）；`ENOENT spawn npx` / `进程退出码-2` = 容器里压根没有 npx（精简 Docker 镜像常见）—— 解决方案见 [配置参考](configuration.md) 的 `agent.mcp` 章节 ⚠️ 说明；`进程退出码 N` + stderr = 服务端启动即崩溃（缺 API Key / 依赖 / Node 版本，看 stderr 末尾）。

### 自检与测试

```bash
cd plugins/agents-plugin
npm test                      # 离线测试全套（130+ 文件 / 6000+ 断言，不联网、不需要 API Key）
node model/<模块>/test.mjs    # 单模块自检（如 model/qqbot/test.mjs）
node web/dev/smoke.mjs        # 前端模板编译 + 视图 setup 冒烟
node web/dev/config-search-check.mjs
node scripts/run-tests.mjs --help 2>/dev/null || true
```
