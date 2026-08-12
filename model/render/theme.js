/**
 * 统一浅色主题 —— 回复图 / 帮助图 / 聊天列表 / 人设列表 共用。
 * 设计：全浅色、柔和不刺眼、留克制的强调色（蓝），代码块 github-light 风格高亮。
 * 卡片用 #container 包裹（Yunzai 渲染器优先截 #container，得到干净卡片）。
 */

export const ACCENT = '#3b82f6' // 主强调色（蓝）

export const THEME_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  background: #eef1f6;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif;
  -webkit-font-smoothing: antialiased;
  color: #374151;
}
#container {
  width: 720px;
  max-width: 720px;
  background: #ffffff;
  border: 1px solid #eef0f3;
  border-radius: 18px;
  padding: 30px 36px;
  box-shadow: 0 10px 34px rgba(20, 30, 60, .06);
  font-size: 15px;
  line-height: 1.78;
  color: #374151;
  overflow: hidden;
}
#container > :last-child { margin-bottom: 0; }

/* 标题 */
h1, h2, h3, h4, h5, h6 {
  color: #111827;
  font-weight: 650;
  line-height: 1.35;
  margin: 1.3em 0 .55em;
}
h1 { font-size: 1.62em; padding-bottom: .3em; border-bottom: 1px solid #e5e7eb; }
h2 { font-size: 1.34em; padding-bottom: .25em; border-bottom: 1px solid #eef0f3; }
h3 { font-size: 1.16em; }
h4 { font-size: 1.02em; }
h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }

p { margin: .65em 0; }
a { color: #2563eb; text-decoration: none; }
a:hover { text-decoration: underline; }
strong, b { color: #111827; font-weight: 680; }
em, i { color: #4b5563; }
del { color: #9ca3af; }

/* 行内代码 */
code, kbd, samp {
  font-family: "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: .9em;
}
:not(pre) > code {
  color: #be185d;
  background: #f4f4f5;
  padding: .15em .42em;
  border-radius: 6px;
  border: 1px solid #eceef1;
  word-break: break-word;
}

/* 代码块 + highlight.js 浅色主题（github-light 风） */
pre {
  position: relative;
  background: #f8f9fb;
  border: 1px solid #e8ebef;
  border-radius: 12px;
  padding: 16px 18px;
  margin: 1em 0;
  overflow-x: auto;
  line-height: 1.62;
}
pre code {
  font-size: 13px;
  color: #24292e;
  background: transparent;
  padding: 0;
  border: 0;
  display: block;
  white-space: pre;
}
/* 顶部语言标签（取 data-lang 渲染，见 md.js） */
pre[data-lang]::before {
  content: attr(data-lang);
  position: absolute;
  top: 8px;
  right: 12px;
  font: 600 10px/1 -apple-system, "PingFang SC", sans-serif;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: #9aa3b2;
  background: #eef1f6;
  padding: 4px 8px;
  border-radius: 6px;
}

/* highlight.js token 着色（浅色） */
.hljs { color: #24292e; background: transparent; }
.hljs-comment, .hljs-quote { color: #6a737d; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-type, .hljs-name { color: #6f42c1; }
.hljs-string, .hljs-attr, .hljs-template-string, .hljs-addition { color: #0a7d31; }
.hljs-number, .hljs-symbol, .hljs-bullet, .hljs-link, .hljs-meta, .hljs-selector-id { color: #005cc5; }
.hljs-title, .hljs-title.function_, .hljs-section, .hljs-built_in { color: #6f42c1; font-weight: 600; }
.hljs-variable, .hljs-template-variable, .hljs-property { color: #b08400; }
.hljs-tag { color: #22863a; }
.hljs-deletion { color: #b31d28; background: #ffeef0; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }

/* 引用 */
blockquote {
  margin: .9em 0;
  padding: 8px 16px;
  border-left: 3px solid ${ACCENT};
  background: #f5f8ff;
  border-radius: 0 10px 10px 0;
  color: #4b5563;
}
blockquote p { margin: .3em 0; }

/* 列表 */
ul, ol { margin: .65em 0; padding-left: 1.6em; }
li { margin: .28em 0; }
li::marker { color: ${ACCENT}; }
ul ul, ol ol, ul ol, ol ul { margin: .2em 0; }
.task-list-item { list-style: none; margin-left: -1.2em; }
.task-list-item input { margin-right: .5em; transform: translateY(1px); }

/* 表格 */
table {
  width: 100%;
  border-collapse: collapse;
  margin: 1em 0;
  font-size: 14px;
  overflow: hidden;
  border-radius: 10px;
}
th, td {
  border: 1px solid #e5e7eb;
  padding: 8px 13px;
  text-align: left;
  vertical-align: top;
}
th { background: #f3f4f6; color: #111827; font-weight: 650; }
tbody tr:nth-child(even) { background: #fafbfc; }

/* 分隔线 / 图片 */
hr { border: 0; border-top: 1px solid #e5e7eb; margin: 1.4em 0; }
img { max-width: 100%; border-radius: 10px; }
/* 表情包（图片模式内嵌进回复图）：块级独占一行、限高，与文字合成一张图 */
.sticker { display: block; max-height: 96px; width: auto; margin: 8px auto; border-radius: 8px; }

/* 专用：帮助图 / 列表图的辅助类（复用主题时可用） */
.head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 18px; padding-bottom: 16px; border-bottom: 1px solid #eef0f3; }
.head .title { font-size: 1.46em; font-weight: 700; color: #111827; }
.head .sub { font-size: .82em; color: #9aa3b2; font-weight: 500; }
.section-title { font-size: 1.02em; font-weight: 680; color: ${ACCENT}; margin: 18px 0 8px; }
.row { display: flex; align-items: baseline; gap: 12px; padding: 7px 0; border-bottom: 1px dashed #f0f1f4; }
.row:last-child { border-bottom: 0; }
.row .k { font-family: "SFMono-Regular", Consolas, monospace; font-size: .9em; color: #be185d; background: #f4f4f5; padding: 1px 7px; border-radius: 6px; white-space: nowrap; }
.row .v { color: #4b5563; flex: 1; }
.badge { display: inline-block; font-size: .72em; font-weight: 600; color: ${ACCENT}; background: #e8f0ff; padding: 1px 7px; border-radius: 20px; margin-left: 6px; }
.footer { margin-top: 20px; padding-top: 14px; border-top: 1px solid #eef0f3; font-size: .76em; color: #9aa3b2; text-align: center; }
.tip { font-size: .86em; color: #6b7280; background: #f5f8ff; border: 1px solid #e3ecff; border-radius: 10px; padding: 9px 13px; margin: 10px 0; }
`

/**
 * 回复图专用浅色覆盖样式（REPLY_CSS）——经 buildHtml 的 extraCss 注入，叠加在 THEME_CSS（浅色蓝）之上。
 * 只影响 AI 回复图（renderReplyImage），不影响帮助图/聊天列表/人设列表（它们用 THEME_CSS 浅色）。
 *
 * 配色与 web 管理面板（main.css · modern-minimal 浅色冷蓝）+ THEME_CSS 完全统一：
 * 冷白画布 / 白卡片 / 蓝 #3b82f6 强调 / github-light 代码高亮。
 * THEME_CSS 本就是目标浅色蓝调，此处仅做两层克制定制，给回复图一个可识别身份而不破坏统一：
 *   ① 顶部 3px 蓝色发丝线（回复卡识别标记，区别于帮助图）；
 *   ② 略强的卡片阴影（回复图常单独发送，需更明确的浮起感）。
 * 其余（链接 / inline code / 代码块 / 引用 / 表格 / 徽标）一律继承 THEME_CSS 的浅色蓝。
 */
export const REPLY_CSS = `
html, body { background: #eef1f6; }
#container {
  background: #ffffff; border: 1px solid #e5e9f0; color: #1f2937;
  border-top: 3px solid #3b82f6;            /* 回复图识别：顶部蓝色发丝线 */
  box-shadow: 0 14px 44px rgba(20,30,60,.10);
}
#container .footer { border-top: 1px solid #eef0f3; color: #9aa3b2; }
`

/** 微信聊天界面样式（renderReplyImage 传 chat 参数时启用，覆盖卡片为聊天排版） */
export const CHAT_CSS = `
#container.chat { background: #ededed; border: 0; border-radius: 0; box-shadow: none; padding: 0; color: #333; width: 720px; font-size: 15px; line-height: 1.6; }
.chat-head { padding: 12px 16px; text-align: center; color: #555; font-size: 13px; border-bottom: 1px solid #dcdcdc; }
.chat-body { padding: 18px 14px; display: flex; flex-direction: column; gap: 20px; }
.msg { display: flex; align-items: flex-start; gap: 8px; }
.msg.user { justify-content: flex-end; }
.msg .avatar { width: 40px; height: 40px; border-radius: 4px; flex-shrink: 0; background: #ddd; object-fit: cover; }
.msg .bubble { max-width: 75%; padding: 9px 12px; border-radius: 4px; word-break: break-word; box-sizing: border-box; }
.user-b { background: #95ec69; color: #000; }  /* 微信绿气泡 */
.ai-content { display: flex; flex-direction: column; gap: 4px; max-width: 82%; }
.ai-name { font-size: 12px; color: #888; margin-left: 4px; }
.ai-b { background: #fff; color: #333; border: 1px solid #e5e5e5; }  /* AI 白气泡 */
.ai-b pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 8px; }
.ai-b :not(pre)>code { background: #f0f0f0; color: #c7254e; }
.ai-b h1,.ai-b h2,.ai-b h3 { color: #24292e; }
.chat-foot { padding: 8px 16px; text-align: right; color: #999; font-size: 12px; border-top: 1px solid #dcdcdc; }
`

/** 转义 */
function _esc(s){return String(s ?? '').replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}

/**
 * 构建微信聊天界面 HTML（renderReplyImage 传 chat 参数时用）。
 * @param {object} p { bodyHtml(已渲染的 AI 回复), chat={userText,userName,userAvatar,aiName,aiAvatar,groupName,groupId,tokens} }
 */
export function buildChatHtml({ messages = [], head = '', tokens, reasoningTokens, model, inputTokens, outputTokens } = {}) {
  const renderMsg = (m) => {
    const av = m.avatar ? `<img class="avatar" src="${_esc(m.avatar)}" referrerpolicy="no-referrer">` : ''
    if (m.role === 'user') return `<div class="msg user"><div class="bubble user-b">${_esc(m.text || '').replace(/\n/g, '<br>')}</div>${av}</div>`
    return `<div class="msg ai">${av}<div class="ai-content">${m.name ? `<div class="ai-name">${_esc(m.name)}</div>` : ''}<div class="bubble ai-b">${m.html || _esc(m.text || '')}</div></div></div>`
  }
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${THEME_CSS}${CHAT_CSS}</style></head>
<body><div id="container" class="chat">
<div class="chat-head">${_esc(head)}</div>
<div class="chat-body">${(messages || []).map(renderMsg).join('\n')}</div>
${tokens != null ? `<div class="chat-foot">${model ? `${_esc(model)} · ` : ''}输入: ${Number(inputTokens) || 0} · 输出: ${Number(outputTokens) || 0}${reasoningTokens ? `（思考: ${Number(reasoningTokens) || 0}）` : ''}</div>` : ''}
</div></body></html>`
}
