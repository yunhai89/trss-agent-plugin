# Web 管理面板排障记录

## 登录 token 含中文导致全局 fetch 报错（v1.45.9）

**现象**：Web 面板登录后，打开人设库等任意页面报
`Failed to execute 'fetch' on 'Window': Failed to read the 'headers' property from 'RequestInit': String contains non ISO-8859-1 code point`，
所有接口全挂。

**原因**：用户把 `#agent登录` 返回的**整段消息**（含「🌐 公网地址：」等中文）粘进登录框；
旧前端原样存入 `localStorage.agents_token`，之后每次请求都塞进 `Authorization: Bearer <整段中文>`。
浏览器的 `RequestInit.headers` 只接受 ISO-8859-1，直接抛 TypeError（请求根本没发出）。

**修复**：
- `web/assets/js/store.js` 新增 `normalizeToken()`：
  - 支持直接粘贴完整登录链接（自动取 `?token=`，含 URL 解码）；
  - 支持带中文/emoji 的整段消息（抽取 16~128 位 `[A-Za-z0-9_-]` 片段）；
  - 仍不合法的输入返回空串；`setToken('')` 清空。
- 请求层读取 token 时再次归一，并把 localStorage 里的历史脏值自愈（能归一写回、不能归一清空）。
- 登录框提交前校验：非法输入弹窗明确提示（应为 48 位字母数字，或粘贴完整登录链接）。
- `?token=` 直跳同样归一。

**验证**：新增 `web/dev/token-normalize-check.mjs`（26 断言：hex/完整链接/带中文整段/url 编码中文/脏尾部、
setToken 不落库、历史脏值自愈且 Authorization 只含 ASCII、不可归一按未登录处理、`storeLoginFromUrl`）。
