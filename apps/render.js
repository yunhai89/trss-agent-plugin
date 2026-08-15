/**
 * 渲染封装 —— 经 Yunzai 核心 lib/puppeteer 把 HTML 渲染为图片，并为深度研究提供
 * PDF 导出与高清长图（独立 puppeteer 浏览器，懒加载单例）。
 *
 * 所有方法失败返回 null / false，调用方据此降级（PDF→高清图→文本）。
 */

import fs from 'node:fs'
import path from 'node:path'
import Log from '../utils/Log.js'
import Config from '../utils/Config.js'
import { buildHtml, mdToHtml } from '../model/render/index.js'
import { buildChatHtml } from '../model/render/theme.js'
import { inlineImages } from '../model/render/inline-images.js'

let _shotSeq = 0

/**
 * 经 Yunzai 内置 renderer 截图（jpeg）。
 *
 * Yunzai 渲染器为「模板模式」：screenshot(name, data) 要求 data.tplFile（模板文件路径），
 * 不支持裸 data.html；其 dealTpl 用 art-template 渲染模板。
 * 本插件生成的 HTML 是自包含的纯 HTML（无 art-template 的 {{}} 语法），art-template 对其原样输出（已验证）。
 * 故：把完整 HTML 写入临时文件作为 tplFile 传入，复用 Yunzai 已启动的 Chromium（Docker 等环境依赖此路径）。
 *
 * 用「name + 自增序号」做唯一 tplFile：保证每次都重新读取最新 HTML，避开渲染器的模板缓存
 * （聊天列表 / 人设列表等内容会变化）。失败返回 null，调用方据此降级为文本。
 */
export const screenshot = async (name, html) => {
  try {
    const mod = await import('../../../lib/puppeteer/puppeteer.js')
    const puppeteer = mod.default || mod
    if (!puppeteer?.screenshot) return null

    const safe = String(name || 'agents').replace(/[\\/]/g, '_')
    const dir = Config.path.temp
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => {})
    // 清理同 name 的旧临时模板，避免磁盘无限堆积
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(`${safe}__`)) fs.unlinkSync(path.join(dir, f))
      }
    } catch { /* noop */ }
    // 唯一文件名 → 渲染器每次缓存未命中 → 始终读取最新 HTML
    _shotSeq = (_shotSeq + 1) % 100000
    const tplFile = path.join(dir, `${safe}__${_shotSeq}.html`)
    await fs.promises.writeFile(tplFile, String(html ?? ''))

    return await puppeteer.screenshot(name, { tplFile, saveId: safe })
  } catch (e) {
    Log.warn('[render] screenshot 异常', e?.message || e)
    return null
  }
}

/**
 * 把一段文本（markdown）渲染成回复图片（segment.image），失败返回 null。
 * markdown→HTML 用 marked+highlight.js（依赖缺失时自动降级为简易渲染）；截图经 Yunzai 渲染器。
 */
export const renderReplyImage = async (content, { scale = 3, footer, extraCss, chat } = {}) => {
  const sc = Math.min(Math.max(Number(scale) || 3, 1), 4) // clamp [1,4]，防 Chromium OOM
  try {
    const bodyHtml = await inlineImages(await mdToHtml(content)) // 远程图片下载转 base64 内联（防盗链+可靠），见 model/render/inline-images.js
    // 聊天模式：头像 base64 内联（防 puppeteer 加载远程失败/防盗链）
    let chatResolved = chat
    if (chat) {
      const fa = async (u) => { if (!u) return ''; try { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }); const b = Buffer.from(await r.arrayBuffer()); return `data:image/jpeg;base64,${b.toString('base64')}` } catch { return String(u) } }
      const userAvatar = await fa(chat.userAvatar)
      const aiAvatar = await fa(chat.aiAvatar)
      // 多气泡：用户问 + AI 正文 + 每个表情包独立一条（类似微信多消息）
      const messages = [
        { role: 'user', text: chat.userText, avatar: userAvatar },
        { role: 'ai', html: bodyHtml, avatar: aiAvatar, name: chat.aiName },
        // 修复：stickerImgs 的元素已是完整 <img class="sticker" src="data:..."> 标签（manager._imgDataUri 产物，
        // .sticker 样式在 theme.js）——此前误当 URL 再包一层 src="${u}" → 嵌套 HTML 解析崩 → 卡片里只剩空气泡
        ...((chat.stickerImgs || []).map((tag) => ({ role: 'ai', html: String(tag), avatar: aiAvatar, name: chat.aiName }))),
      ]
      chatResolved = { messages, head: chat.groupName ? `${chat.groupName}（${chat.groupId}）` : '私聊', tokens: chat.tokens, reasoningTokens: chat.reasoningTokens, model: chat.model, inputTokens: chat.inputTokens, outputTokens: chat.outputTokens }
    }
    const html = chatResolved
      ? buildChatHtml(chatResolved)
      : buildHtml({ bodyHtml, ...(footer ? { footer } : {}), ...(extraCss ? { extraCss } : {}) })
    // 主路径：独立 puppeteer 高清渲染（dsf + JPEG q95，清晰度远超 Yunzai dsf 1）
    let img = await renderHighQuality(html, { scale: sc })
    if (img) return img
    // 降级 1：Yunzai 渲染器（dsf 1，但总比文本好）。独立 puppeteer 缺包是部署常态，降级属正常兜底，用 debug 不刷屏
    Log.debug('[render] 独立浏览器渲染失败，降级 Yunzai 渲染器…')
    img = await screenshot('agents-plugin/reply', html)
    if (img) return img
    // 降级 2：Yunzai 重试
    Log.warn('[render] Yunzai 首次截图失败，重试中…')
    img = await screenshot('agents-plugin/reply', html)
    if (!img) Log.warn('[render] 重试仍失败，将回退文本')
    return img
  } catch (e) {
    Log.warn('[render] renderReplyImage 异常', e?.message || e)
    return null
  }
}

/**
 * 独立 puppeteer 高清渲染（不经 Yunzai 渲染器，可控制 deviceScaleFactor）。
 * 用 getBrowser 懒加载单例浏览器，setContent 内联 HTML（base64 图片直接加载，无 file://），
 * setViewport deviceScaleFactor=N → 物理像素 N 倍 → 清晰度翻倍。
 * 返回 segment.image（base64），失败 null。
 */
async function renderHighQuality(html, { scale = 3, width = 800, imgType = 'jpeg', quality = 95 } = {}) {
  const buff = await withPage(html, async (page) => {
    await page.setViewport({ width, height: 1200, deviceScaleFactor: scale })
    await page.waitForSelector('#container', { timeout: 8000 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 200)) // 字体/布局/图片稳定
    const opt = { type: imgType }
    if (imgType === 'jpeg') opt.quality = quality
    // 截 #container 元素本身（紧贴卡片 border-box），避免内容少时 fullPage 把视口/body 背景一起截进来、多出大片空白
    const el = await page.$('#container')
    if (el) {
      try { return await el.screenshot(opt) } catch { /* element 截图偶发失败 → 落到 clip 兜底 */ }
    }
    // clip 兜底：按 #container 的精确 bbox 截（同样紧贴卡片，绝不 fullPage）
    const box = await page.evaluate(() => {
      const e = document.querySelector('#container')
      if (!e) return null
      const r = e.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }).catch(() => null)
    if (box && box.width > 0 && box.height > 0) return page.screenshot({ ...opt, clip: box })
    return null // #container 异常 → 返回 null 走降级（Yunzai 渲染器，仍截 #container），不再 fullPage
  })
  if (!buff || !Buffer.isBuffer(buff)) return null
  const seg = (typeof segment !== 'undefined' && segment) || null
  if (!seg) return null
  return seg.image(`base64://${buff.toString('base64')}`)
}

// ─── 独立 puppeteer 浏览器（懒加载单例，用于 PDF / 高清图）───
let _browser = null
let _launching = null

async function getBrowser() {
  if (_browser) return _browser
  if (_launching) return _launching
  _launching = (async () => {
    try {
      const mod = await import('puppeteer')
      const pptr = mod.default || mod
      // 优先复用系统 Chromium（容器里 /usr/sbin/chromium 已装），免去 puppeteer 下载二进制；
      // 未探测到则 executablePath 省略，puppeteer 用默认下载的 Chromium
      const exec = process.env.PUPPETEER_EXECUTABLE_PATH
        || ['/usr/sbin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
            .find((p) => { try { return fs.existsSync(p) } catch { return false } })
      _browser = await pptr.launch({
        headless: 'new',
        ...(exec ? { executablePath: exec } : {}),
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      })
      return _browser
    } catch (e) {
      Log.warn('[render] 独立浏览器 launch 失败', e?.message || e)
      _browser = null
      return null
    } finally {
      _launching = null
    }
  })()
  return _launching
}

async function withPage(html, fn) {
  const browser = await getBrowser()
  if (!browser) return null
  let page = null
  try {
    page = await browser.newPage()
  } catch (e) {
    // newPage 失败 = 浏览器已死 → reset 让下次重新 launch（自愈）
    _browser = null
    return null
  }
  try {
    await page.setContent(String(html), { waitUntil: 'load', timeout: 30000 })
    return await fn(page)
  } catch (e) {
    Log.warn('[render] 页面渲染/截图失败', e?.message || e)
    return null
  } finally {
    if (page) page.close().catch(() => {})
  }
}

/**
 * 渲染 HTML 为 PDF 文件。
 * @param {string} html
 * @param {object} opts { path, format='A4' }
 * @returns {Promise<string|null>} 成功返回写入路径，失败 null
 */
export const renderPdf = async (html, { path: outPath, format = 'A4' } = {}) => {
  if (!outPath) return null
  try {
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true })
  } catch { /* noop */ }
  const buff = await withPage(html, (page) =>
    page.pdf({
      format,
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
      preferCSSPageSize: false,
    }),
  )
  if (!buff) return null
  try {
    await fs.promises.writeFile(outPath, buff)
    return outPath
  } catch (e) {
    return null
  }
}

/**
 * 渲染 HTML 为高清长图（fullPage，deviceScaleFactor 提升清晰度）。
 * @param {string} name 缓存名（保留参数，便于复用 Yunzai 截图命名）
 * @param {string} html
 * @param {object} opts { scale=2, imgType='png', width=820 }
 * @returns {Promise<Buffer|null>}
 */
export const renderHd = async (name, html, { scale = 2, imgType = 'png', width = 820 } = {}) => {
  const buff = await withPage(html, async (page) => {
    await page.setViewport({ width, height: 1200, deviceScaleFactor: scale })
    const opt = { type: imgType, fullPage: true }
    if (imgType === 'jpeg') opt.quality = 92
    return page.screenshot(opt)
  })
  return buff && Buffer.isBuffer(buff) ? buff : null
}
