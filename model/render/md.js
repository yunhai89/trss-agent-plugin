/**
 * Markdown → HTML 渲染。
 *
 * 主路径：marked + marked-highlight + highlight.js（完整 md + 语法高亮）。
 * 降级路径：若未 npm install 这些依赖（import 失败），用内置简易 md 渲染器
 *   （标题/粗斜体/行内代码/代码块/列表/引用/链接/段落，无 token 高亮），
 *   保证插件在缺依赖时仍能出图，只是代码块无语法着色。
 *
 * 代码块统一带 <pre data-lang="X">，配合 theme.js 的语言标签样式。
 */

let _engine // undefined=未加载, null=依赖缺失(用降级), {render, hljs}=就绪
getEngine() // 模块加载即预热（import 异步缓存）

async function getEngine() {
  if (_engine !== undefined) return _engine
  try {
    const [{ Marked, marked: markedNs }, { markedHighlight }, hljsMod] = await Promise.all([
      import('marked'),
      import('marked-highlight'),
      import('highlight.js'),
    ])
    const hljs = hljsMod.default || hljsMod
    const MarkedCtor = Marked || markedNs?.Marked
    if (!MarkedCtor || !markedHighlight || !hljs) throw new Error('marked/hljs 导入不完整')
    const inst = new MarkedCtor(
      markedHighlight({
        langPrefix: 'hljs language-',
        highlight(code, lang) {
          try {
            if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value
            return hljs.highlightAuto(code).value
          } catch {
            return false // 交 marked 正常转义
          }
        },
      }),
      { gfm: true, breaks: false },
      {
        // 原始 HTML 一律转义：正文来自 LLM 回复（可能被工具结果/网页内容间接注入），
        // 而卡片会被注入 JS 的 Chromium 渲染。marked 默认原样透传 <script>/<img onerror=…> → 这里堵死。
        // （另两道防线：文档 CSP meta、独立 puppeteer 路径 setJavaScriptEnabled(false)）
        renderer: {
          html(token) {
            const s = typeof token === 'string' ? token : (token?.text ?? token?.raw ?? '')
            return escapeHtml(s)
          },
          // 链接：只放行 http(s)/mailto，其余（javascript: 等）退化成纯文本（卡片是静态图，链接本就点不了）
          link(token) {
            let text
            try { text = this.parser.parseInline(token?.tokens || []) } catch { text = escapeHtml(token?.text ?? '') }
            const href = String(token?.href ?? '')
            if (!/^(https?:|mailto:)/i.test(href)) return text
            return `<a href="${escapeHtml(href)}">${text}</a>`
          },
        },
      },
    )
    _engine = {
      hljs: true,
      render(md) {
        let html = inst.parse(String(md ?? ''))
        // 给 <pre> 加 data-lang（语言标签样式用）
        html = html.replace(
          /<pre><code class="([^"]*language-([\w+-]+)[^"]*)"/g,
          '<pre data-lang="$2"><code class="$1"',
        )
        return html
      },
    }
  } catch {
    _engine = null // 依赖缺失 → 降级
  }
  return _engine
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/** 行内格式化（降级用）：转义后应用 粗体/斜体/行内代码/链接 */
function inlineFmt(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
}

/** 内置简易 markdown 渲染（依赖缺失时的降级；无高亮） */
export function fallbackMd(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let inCode = false
  let codeLang = ''
  let codeBuf = []
  let listType = null
  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`)
      listType = null
    }
  }
  for (const raw of lines) {
    const fence = raw.match(/^```(.*)$/)
    if (fence) {
      if (!inCode) {
        flushList()
        inCode = true
        codeLang = fence[1].trim()
        codeBuf = []
      } else {
        out.push(`<pre data-lang="${escapeHtml(codeLang)}"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
        inCode = false
        codeBuf = []
        codeLang = ''
      }
      continue
    }
    if (inCode) {
      codeBuf.push(raw)
      continue
    }
    if (!raw.trim()) {
      flushList()
      continue
    }
    const h = raw.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      flushList()
      out.push(`<h${h[1].length}>${inlineFmt(h[2])}</h${h[1].length}>`)
      continue
    }
    if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(raw)) {
      flushList()
      out.push('<hr>')
      continue
    }
    const bq = raw.match(/^>\s?(.*)$/)
    if (bq) {
      flushList()
      out.push(`<blockquote><p>${inlineFmt(bq[1])}</p></blockquote>`)
      continue
    }
    const ul = raw.match(/^[-*+]\s+(.*)$/)
    const ol = raw.match(/^\d+\.\s+(.*)$/)
    if (ul) {
      if (listType !== 'ul') {
        flushList()
        out.push('<ul>')
        listType = 'ul'
      }
      out.push(`<li>${inlineFmt(ul[1])}</li>`)
      continue
    }
    if (ol) {
      if (listType !== 'ol') {
        flushList()
        out.push('<ol>')
        listType = 'ol'
      }
      out.push(`<li>${inlineFmt(ol[1])}</li>`)
      continue
    }
    flushList()
    out.push(`<p>${inlineFmt(raw)}</p>`)
  }
  if (inCode) out.push(`<pre data-lang="${escapeHtml(codeLang)}"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
  flushList()
  return out.join('\n')
}

/** markdown → HTML（异步：主路径可能需加载依赖） */
export async function mdToHtml(md) {
  const engine = await getEngine()
  return engine ? engine.render(md) : fallbackMd(md)
}

/** 同步版（仅降级渲染；主路径未就绪时也走降级）。用于不方便 async 的场景。 */
export function mdToHtmlSync(md) {
  return _engine ? _engine.render(md) : fallbackMd(md)
}

/** 高亮是否可用（依赖已装且就绪） */
export function isHighlightAvailable() {
  return !!(_engine && _engine.hljs)
}
