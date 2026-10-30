# 常见问题（完整 FAQ）

> 本文是主 README 的拆分文档。返回 [README](../README.md)。

## 常见问题（FAQ）

**Q0：还没有协议端（QQ 没连上），怎么进 Web 面板配东西？**
看插件启动日志：会自动打印**带 token 的默认访问地址**（本地/内网/公网），也写在 `data/web/console-url.txt`。面板服务与令牌都不依赖协议端和模型运行时——打开就能进「配置中心」填厂商/模型。日志里没有？检查 `agent.webApi.enable`（默认 true）、`agent.webApi.printTokenOnStart`（默认 true）与端口是否被占用。

**Q1：机器人不回话？**
① 看日志 `[trigger]` 是否有触发记录；② `agent.trigger=at` 时确认是 @ 且消息含文字或媒体；③ 私聊需要 `agent.privateChat=true`；④ QQ 官方机器人需先 `/uid` 配 `agent.masters`；⑤ `agent.chatPermission` 会限制群内 `#ai` 命令（@ 对话不受限）。

**Q1.1：Web 面板登录后打开任意页面报 `Failed to execute 'fetch' … String contains non ISO-8859-1 code point`？**
说明浏览器 localStorage 里存的 token 不是纯 ASCII（典型：把 `#agent登录` 的整段回执含「🌐 公网地址：」等中文一起粘进了登录框）。v1.45.9 起已修复：登录框支持粘贴完整链接并自动抽取 token，历史脏值读取时会自愈。若你的面板还是旧前端（缓存），强刷页面（Ctrl/Cmd+Shift+R）后重新 `#agent登录` 粘贴一次即可。

**Q1.2：官方机器人连上了，但 `#设置主人` / `#重启` 等云崽指令没反应？**
v1.45.4 起已修：以前 `@机器人 + #指令` 会被本插件的 AI catch-all 抢先处理。现在以 `#`/`/` 开头且不是本插件触发词的消息会**透传**给 Yunzai 与其它插件（`agent.commandPassThrough` 默认开）。注意：① 群里没开「全量消息」权限时必须 **@机器人 + 指令**；② 私聊需 `agent.privateChat` 或直接 `#设置主人`（框架指令不受 privateChat 影响）；③ 若仍有插件级权限问题，先按提示走完 `#设置主人` 验证码流程。

**Q1.5：机器人在群里「不管发什么都回复」？**
① 确认是官方机器人且开放平台开了「全量消息」权限：该权限下普通群消息也会推送，插件本应按「事件类型 + mentions.is_you」只对 @ 回复（v1.45.3 修复了早前无条件补 `at` 段导致的全量误触发）；② 若 `agent.trigger=both`，`#ai` 命令也会触发，属预期；③ 伪人模式（`agent.humanize`）是另一条独立回复通路，可在配置里关掉。

**Q2：模型报 401/404/网络错误？**
到 Web 配置中心核对「厂商配置」的 baseURL / apiKey / protocol。国内访问海外模型建议配 `agent.proxy`（仅 HTTP(S)；SOCKS 会提示直连）。日志 `[provider]` 有重试原因。

**Q3：回复变成纯文本 / 图片渲染失败？**
`reply.mode=image` 需要 Chromium（Yunzai 自带 puppeteer）；渲染失败会自动退文本。官方机器人下本就走 Markdown，不是故障。弱服务器可设 `render.card=false`。
帮助图（`#agent帮助`）有独立超时 `agent.render.helpTimeoutMs`（默认 **300000ms = 5 分钟**）；若首次渲染仍超时（之后会进入冷却、暂时直接回文本），可在 Web 配置中心「进度 / 回复渲染」或锅巴调整该项，或把 `render.card=false` 直接走文本。

**Q4：Token 消耗/费用偏高？**
① 配置 `contextWindow` 让前缀缓存生效（命中率可达 90%+，见 [记忆体系与上下文缓存](memory-and-context.md)）；② 长任务看 `agent.loop.tokenBudget` 与 `maxTurns`；③ 旁路功能（记忆/评审/伪人）配 `utilityModel` 小模型；④ `#任务状态` 看 turns 与 stop 原因。

**Q5：QQ 官方机器人连不上？**
① 确认 AppID + AppSecret（Token 已废弃，不要填 Token）；② 用 Web「机器人账号」页看状态：4004=密钥错；4013/4914=intents 无权限（默认只订群@+C2C，**不用手填**；填了未开通的位会被拒绝，插件会自动降级并记日志）；4008=频控；③ 首次启用适配器需重启 Yunzai；④ 不要同时开 Yunzai-QQBot-Plugin。

**Q6：官方机器人里主人指令没权限？**
openid 不是 QQ 号，框架 master 判定不命中。发 `/uid`，把「完整 user_id」加到 `agent.masters`（或 Yunzai master 配置）。

**Q7：群白名单/提醒人设不生效？**
官方群 ID 是 `<appId>:<openid>` 而非 QQ 群号，用 `/groupid` 取值；提醒按用户、定时任务链按会话。

**Q8：改了配置没生效？**
配置保存会自动热加载；若仍不生效：确认改的是**插件目录** `config/config.yaml`；`#agent重载` 强制重建；**改代码**必须重启进程（ESM 模块缓存）。

**Q9：`#agent更新` 失败/冲突？**
说明本地改动与上游冲突，按提示 `git stash push -u` 后重试；未跟踪文件冲突用 `git clean -n` 预览再删；`#agent强制更新` 会丢弃未提交改动。

**Q10：沙箱连不上网 / DNS 不通？**
发 `#沙箱诊断`（`预览` 看实际下发、`实测` 沙箱内探测、`修复` 清旧版 `denyOut` 全拒）；自托管需确认 NAT/DNS；`sandbox.network.allowInternet` 与 `allowOut` 白名单会限制出口。

---
