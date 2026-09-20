/**
 * 图片渲染的 HTML 构建器（纯函数，离线可测）。
 * 复用 model/render 的统一浅色主题（buildHtml + THEME_CSS）；
 * 结构行（命令/对话/人设）用 LIST_CSS（同调色板）补充布局。
 * 实际截图在 apps/render.js 经 Yunzai puppeteer 完成。
 */
import { buildHtml } from '../render/index.js'
import { ACCENT } from '../render/theme.js'

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 列表/结构行补充样式（复用主题调色板：白卡 + 蓝强调 + 浅灰分隔）
const LIST_CSS = `
.conv { display:flex; align-items:center; padding:12px 0; border-bottom:1px solid #f3f4f6; }
.conv:last-child { border-bottom:0; }
.conv.active { background:#f5f8ff; border-radius:12px; padding:12px 12px; border-bottom:0; margin:4px 0; }
.conv-id { flex:0 0 auto; width:50px; font-weight:700; color:${ACCENT}; font-size:1.05em; }
.conv-body { flex:1; min-width:0; padding:0 12px; }
.conv-title { font-weight:650; color:#111827; display:flex; align-items:center; gap:8px; margin-bottom:3px; font-size:1.02em; }
.conv-preview { font-size:.85em; color:#9ca3af; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.conv-meta { flex:0 0 auto; font-size:.8em; color:#9ca3af; text-align:right; line-height:1.6; }
.persona { display:flex; align-items:flex-start; gap:12px; padding:13px 0; border-bottom:1px solid #f3f4f6; }
.persona:last-child { border-bottom:0; }
.persona.active { background:#f5f8ff; border-radius:12px; padding:13px 12px; border-bottom:0; margin:4px 0; }
.persona-ava { flex:0 0 40px; width:40px; height:40px; border-radius:50%; background:linear-gradient(135deg,#93c5fd,${ACCENT}); color:#fff; display:flex; align-items:center; justify-content:center; font-size:16px; font-weight:650; }
.persona-body { flex:1; min-width:0; }
.persona-name { font-weight:650; color:#111827; display:flex; align-items:center; gap:7px; margin-bottom:3px; font-size:1.02em; }
.persona-desc { font-size:.88em; color:#6b7280; line-height:1.5; }
.persona-id { flex:0 0 auto; font-family:"SFMono-Regular",Consolas,monospace; font-size:.8em; color:#9ca3af; }
.empty { padding:48px 0; text-align:center; color:#9ca3af; font-size:1em; }
.tag { font-size:.72em; color:${ACCENT}; background:#e8f0ff; padding:1px 8px; border-radius:20px; font-weight:600; }
`

/**
 * 帮助图：sections = [{ title, commands:[{cmd, desc}] }]
 */
const SECTION_ICON = { '触发对话':'💬', '对话管理':'🗂️', '示意图':'📊', '记忆 / 提醒':'⏰', '知识库':'📚', '定时任务':'🗓️', '人设':'🎭', '深度研究':'🔍', '表情包':'😀', '主人指令':'👑', '在线自进化（主人）':'🧬', '群聊小世界':'🌐' }

/**
 * 帮助图专用样式（液态玻璃 / Liquid Glass）。
 * 叠在 THEME_CSS 之上，仅作用于 buildHelpHtml（聊天列表/人设列表仍用 LIST_CSS）。
 * 设计：流体彩色渐变背景 + 放大模糊的光斑，玻璃面板（半透明 + backdrop-filter）
 * 分层承载内容，柔和高光与内阴影营造厚度；网格自适应 2~4 列。
 * 纯静态图片，故不使用过渡/悬停；模糊失败时半透明底色仍保证可读（优雅降级）。
 */
const HELP_CSS = `
html, body {
  background:
    radial-gradient(1200px 720px at 8% -10%, #dbeafe 0%, rgba(219,234,254,0) 60%),
    radial-gradient(1000px 640px at 102% -4%, #ede9fe 0%, rgba(237,233,254,0) 58%),
    radial-gradient(920px 720px at 84% 108%, #ccfbf1 0%, rgba(204,251,241,0) 60%),
    radial-gradient(820px 640px at -4% 108%, #fef3c7 0%, rgba(254,243,199,0) 58%),
    linear-gradient(150deg, #eef3ff 0%, #f6f2ff 42%, #effcf7 72%, #fff8ec 100%);
}
#container {
  position: relative;
  overflow: hidden;
  width: 720px;
  max-width: 720px;
  border-radius: 28px;
  padding: 30px 34px 26px;
  background: linear-gradient(155deg, rgba(255,255,255,.74), rgba(255,255,255,.46));
  -webkit-backdrop-filter: blur(30px) saturate(185%);
  backdrop-filter: blur(30px) saturate(185%);
  border: 1px solid rgba(255,255,255,.78);
  box-shadow:
    0 30px 70px -24px rgba(30,41,99,.36),
    0 10px 30px -12px rgba(59,130,246,.18),
    inset 0 1px 0 rgba(255,255,255,.95),
    inset 0 -1px 0 rgba(255,255,255,.35);
}
/* 流体光斑：为上方玻璃层提供可被模糊折射的彩色背景 */
#container::before {
  content:''; position:absolute; inset:-34% -20%; z-index:0; pointer-events:none;
  background:
    radial-gradient(closest-side, rgba(96,165,250,.55), rgba(96,165,250,0) 72%) 12% 12%/46% 46% no-repeat,
    radial-gradient(closest-side, rgba(167,139,250,.50), rgba(167,139,250,0) 72%) 88% 6%/42% 42% no-repeat,
    radial-gradient(closest-side, rgba(45,212,191,.45), rgba(45,212,191,0) 72%) 86% 94%/46% 46% no-repeat,
    radial-gradient(closest-side, rgba(251,191,36,.42), rgba(251,191,36,0) 72%) 4% 96%/44% 44% no-repeat;
  filter: blur(42px);
}
#container > * { position: relative; z-index: 1; }

.head { border-bottom: 1px solid rgba(148,163,184,.28); }
.head .title {
  font-size: 1.52em; font-weight: 800; letter-spacing: -.015em;
  background: linear-gradient(120deg, #1e3a8a 0%, ${ACCENT} 46%, #8b5cf6 100%);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: #1e3a8a;
}
.head .sub { color: #64748b; }

.help-meta { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin: 2px 0 16px; }
.help-meta .m-pill {
  font-size: 12px; color: #475569;
  background: linear-gradient(140deg, rgba(255,255,255,.82), rgba(255,255,255,.5));
  border: 1px solid rgba(255,255,255,.85);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.9), 0 4px 12px -6px rgba(59,130,246,.3);
  padding: 3px 11px; border-radius: 999px;
}

.help-section {
  position: relative;
  background: linear-gradient(152deg, rgba(255,255,255,.55), rgba(255,255,255,.28));
  -webkit-backdrop-filter: blur(16px) saturate(160%);
  backdrop-filter: blur(16px) saturate(160%);
  border: 1px solid rgba(255,255,255,.8);
  border-radius: 20px;
  padding: 15px 16px 16px;
  margin: 0 0 15px;
  box-shadow:
    0 14px 34px -20px rgba(30,41,99,.5),
    inset 0 1px 0 rgba(255,255,255,.92),
    inset 0 -1px 0 rgba(255,255,255,.32);
}
.help-section-title { display:flex; align-items:center; gap:9px; font-size:15px; font-weight:750; color:#1e293b; margin-bottom:13px; }
.help-ico {
  flex:0 0 auto; width:27px; height:27px; border-radius:9px; font-size:14px;
  display:inline-flex; align-items:center; justify-content:center;
  background: linear-gradient(145deg, rgba(255,255,255,.95), rgba(219,234,254,.6));
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.9), 0 4px 12px -5px rgba(59,130,246,.45);
}
.help-name { letter-spacing: .01em; }
.help-cnt {
  margin-left:auto; font-size:11px; font-weight:700; color:${ACCENT};
  background: linear-gradient(140deg, rgba(239,246,255,.9), rgba(219,234,254,.6));
  border: 1px solid rgba(147,197,253,.55);
  padding: 1px 9px; border-radius:999px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.9);
}
.help-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap:11px; }
.cmd-cell {
  background: linear-gradient(150deg, rgba(255,255,255,.72), rgba(255,255,255,.42));
  -webkit-backdrop-filter: blur(10px) saturate(150%);
  backdrop-filter: blur(10px) saturate(150%);
  border: 1px solid rgba(255,255,255,.85);
  border-radius: 14px;
  padding: 11px 12px 12px;
  box-shadow: 0 8px 20px -14px rgba(30,41,99,.55), inset 0 1px 0 rgba(255,255,255,.95);
}
.cmd-key {
  display:inline-block; font-family:"SFMono-Regular","JetBrains Mono",Consolas,monospace;
  font-size:12px; font-weight:650; color:#1d4ed8; line-height:1.5; word-break:break-all;
  background: linear-gradient(140deg, rgba(219,234,254,.95), rgba(238,242,255,.7));
  border: 1px solid rgba(147,197,253,.6);
  padding: 2px 9px; border-radius:9px; margin-bottom:7px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.9);
}
.cmd-desc { display:block; font-size:12px; color:#4b5563; line-height:1.6; }
.footer { border-top: 1px solid rgba(148,163,184,.28); color:#94a3b8; }
`

export function buildHelpHtml({ title = 'agents-plugin 帮助', subtitle = '', sections = [] } = {}) {
  const total = sections.reduce((n, s) => n + ((s.commands && s.commands.length) || 0), 0)
  const meta = `<div class="help-meta"><span class="m-pill">✦ ${sections.length} 个分类</span><span class="m-pill">共 ${total} 条指令</span><span class="m-pill">以 # 开头为指令</span></div>`
  const body = meta + sections
    .map((s) => `<div class="help-section">
        <div class="help-section-title">${SECTION_ICON[s.title] ? `<span class="help-ico">${SECTION_ICON[s.title]}</span>` : '<span class="help-ico">•</span>'}<span class="help-name">${esc(s.title)}</span><span class="help-cnt">${s.commands.length}</span></div>
        <div class="help-grid">
          ${s.commands.map((c) => `<div class="cmd-cell"><span class="cmd-key">${esc(c.cmd)}</span><span class="cmd-desc">${esc(c.desc)}</span></div>`).join('')}
        </div>
      </div>`)
    .join('')
  return buildHtml({ title, subtitle, bodyHtml: body, footer: 'agents-plugin · 液态玻璃主题 · 主人指令需管理员权限', extraCss: HELP_CSS })
}

/**
 * 聊天列表图：conversations = [{ id, title, count, updatedAt, preview }]
 */
export function buildChatListHtml({ user = '', conversations = [], activeId = null } = {}) {
  const body = conversations.length
    ? conversations
        .map((c) => `<div class="conv ${c.id === activeId ? 'active' : ''}">
          <div class="conv-id">#${esc(c.id)}</div>
          <div class="conv-body">
            <div class="conv-title">${esc(c.title)}${c.id === activeId ? '<span class="tag">当前</span>' : ''}</div>
            <div class="conv-preview">${esc(c.preview || '（暂无消息）')}</div>
          </div>
          <div class="conv-meta">${esc(c.count)} 条<br>${esc(fmtTime(c.updatedAt))}</div>
        </div>`)
        .join('')
    : '<div class="empty">还没有对话，@机器人 或 #new 开始第一段对话</div>'
  return buildHtml({ title: '聊天列表', subtitle: user ? `用户 ${esc(user)}` : '', bodyHtml: body, footer: '#进入聊天 + id 切换 · #new 新建对话', extraCss: LIST_CSS })
}

/**
 * 人设列表图：personas = [{ id, name, description, tags, builtin }]
 */
export function buildPersonaListHtml({ user = '', personas = [], activeId = null } = {}) {
  const body = personas.length
    ? personas
        .map((p, i) => `<div class="persona ${p.id === activeId ? 'active' : ''}">
          <div class="persona-ava">${esc((p.name || '?').slice(0, 1))}</div>
          <div class="persona-body">
            <div class="persona-name">${esc(p.name)}${p.id === activeId ? '<span class="tag">当前</span>' : ''}<span class="tag">${p.builtin ? '内置' : '自定义'}</span></div>
            <div class="persona-desc">${esc(p.description || '')}</div>
          </div>
          <div class="persona-id">#${i + 1}</div>
        </div>`)
        .join('')
    : '<div class="empty">还没有人设</div>'
  return buildHtml({ title: '人设列表', subtitle: user ? `用户 ${esc(user)}` : '', bodyHtml: body, footer: '#人设 + 序号切换（如 #人设 1）· #新建人设 创建 · #重置人设 恢复默认', extraCss: LIST_CSS })
}
