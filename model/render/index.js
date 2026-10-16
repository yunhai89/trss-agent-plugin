/**
 * 渲染公共出口 —— 统一浅色主题的 HTML 文档构建。
 * 回复图 / 帮助图 / 聊天列表 / 人设列表 共用 buildHtml + THEME_CSS。
 *
 * 不含截图动作（screenshot 在 apps/render.js，由 app 层组合，避免 model 反向依赖 apps）。
 */
import { THEME_CSS, CSP_META } from './theme.js'

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

/**
 * 构建完整 HTML 文档（Yunzai 渲染器会截 #container 卡片）。
 * @param {object} p
 * @param {string} p.title     卡片大标题（可选）
 * @param {string} p.subtitle  标题旁副标题（可选）
 * @param {string} p.bodyHtml  正文 HTML（已渲染，如 mdToHtml 的输出或自定义结构）
 * @param {string} p.footer    页脚（可选）
 * @param {string} p.extraCss  追加样式（可选，覆盖主题）
 */
export function buildHtml({ title, subtitle, bodyHtml = '', footer, extraCss = '' } = {}) {
  let head = ''
  if (title || subtitle) {
    head = `<div class="head">${title ? `<div class="title">${esc(title)}</div>` : ''}${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}</div>`
  }
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${CSP_META}
<style>${THEME_CSS}${extraCss ? '\n' + extraCss : ''}</style>
</head>
<body>
<div id="container" class="card">
${head}
${bodyHtml}
${footer ? `<div class="footer">${esc(footer)}</div>` : ''}
</div>
</body>
</html>`
}

export { THEME_CSS, CSP_META } from './theme.js'
export { mdToHtml, mdToHtmlSync, fallbackMd, isHighlightAvailable } from './md.js'
