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
.help-section { background:#f8f9fb; border:1px solid #eef0f3; border-radius:14px; padding:14px 16px 16px; margin:0 0 14px; }
.help-section-title { display:flex; align-items:center; font-size:15px; font-weight:700; color:#111827; margin-bottom:12px; padding-left:10px; position:relative; }
.help-section-title::before { content:''; position:absolute; left:0; top:3px; bottom:3px; width:4px; background:linear-gradient(180deg,${ACCENT},#60a5fa); border-radius:2px; }
.help-section-title .help-ico { font-size:16px; margin-right:6px; }
.help-section-title .help-cnt { margin-left:auto; font-size:11px; font-weight:600; color:#9aa3b2; background:#fff; padding:1px 9px; border-radius:20px; border:1px solid #eef0f3; }
.help-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
.cmd-cell { background:#fff; border:1px solid #eef0f3; border-radius:10px; padding:10px 11px; }
.cmd-cell .cmd-key { display:inline-block; font-family:"SFMono-Regular","JetBrains Mono",Consolas,monospace; font-size:12px; font-weight:600; color:#2563eb; background:#eff6ff; padding:2px 8px; border-radius:6px; word-break:break-all; line-height:1.5; margin-bottom:6px; }
.cmd-cell .cmd-desc { display:block; font-size:12px; color:#6b7280; line-height:1.55; }
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
const SECTION_ICON = { '触发对话':'💬', '对话管理':'🗂️', '记忆 / 提醒':'⏰', '知识库':'📚', '定时任务':'🗓️', '人设':'🎭', '深度研究':'🔍', '表情包':'😀', '主人指令':'👑', '在线自进化（主人）':'🧬', '群聊小世界':'🌐' }

export function buildHelpHtml({ title = 'agents-plugin 帮助', subtitle = '', sections = [] } = {}) {
  const body = sections
    .map((s) => `<div class="help-section">
        <div class="help-section-title">${SECTION_ICON[s.title] ? `<span class="help-ico">${SECTION_ICON[s.title]}</span>` : ''}${esc(s.title)}<span class="help-cnt">${s.commands.length}</span></div>
        <div class="help-grid">
          ${s.commands.map((c) => `<div class="cmd-cell"><span class="cmd-key">${esc(c.cmd)}</span><span class="cmd-desc">${esc(c.desc)}</span></div>`).join('')}
        </div>
      </div>`)
    .join('')
  return buildHtml({ title, subtitle, bodyHtml: body, footer: 'agents-plugin · AI Agent 驱动 · 主人指令以 # 标注', extraCss: LIST_CSS })
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
