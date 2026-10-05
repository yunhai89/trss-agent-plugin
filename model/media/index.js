/**
 * 媒体库公共出口 —— 文件/图片的底层封装，配合 LLM 多模态。
 *
 * 两种获取方式：
 *  - 主动（active）：用户携带图片/文件提问时，自动从事件中收集（collect.js 的 4 源扫描）
 *      并转为协议原生内容块随消息发送。
 *  - 被动（passive）：用户问题指向某文件但未直接附带，LLM 调用工具主动取
 *      （tool.js：list_group_files / get_group_file / read_attachment）。
 *
 * 框架优先：收集/下载优先用 TRSS-Yunzai 的 e.getReply / e.group.fs / Bot.download / Bot.fileType；
 * 不可用时优雅降级到本库自实现（fetcher 取字节 + 魔数嗅探），保证可移植。
 *
 * 用法（apps 层）：
 *   import { createMediaService } from '../model/media/index.js'
 *   const media = createMediaService({ bot: globalThis.Bot, e, caps, protocol, config: cfg.media })
 *   const files = cfg.media?.active !== false ? await media.collectActive() : []
 *   const content = media.buildContent(text)            // 字符串 或 协议原生 content 数组
 *   const input = Array.isArray(content) ? { role:'user', content, _media:true } : content
 *   await agent.run(input, { ctx: { ...ctx, media: files } })
 *
 * 被动工具一次性注册（buildRuntime）：
 *   tools.register(...makeMediaTools())   // 工具从 ctx.e / ctx.bot / ctx.media 读运行时
 */

import { collectFromEvent, fetchReply, fetchQuotedContext, extractFromMessage, extractForwardResid, kindOf, dedupMedia } from './collect.js'
import { resolveMedia, resolveAll, inferMime, sniffMagic, asBase64, isTextLike, isImage, truncateText, mimeFromName, EXT_MIME } from './resolve.js'
import { toOpenaiBlocks, toAnthropicBlocks, toGeminiBlocks, buildUserContent } from './convert.js'
import { listGroupFilesTool, getGroupFileTool, readAttachmentTool, makeMediaTools } from './tool.js'

/**
 * 创建一次会话的媒体服务。
 * @param {object} opts { bot, e, caps, protocol, config }
 *   - bot: Yunzai Bot 句柄（globalThis.Bot）；可缺省，降级用 fetcher
 *   - e:    Yunzai 事件
 *   - caps: detectCapabilities(...) 结果（{vision, file, ...}）；缺省按视觉支持处理
 *   - protocol: 'openai' | 'anthropic'
 *   - config: { maxImages, maxFileBytes, degrade, active, passive }
 */
export function createMediaService({ bot = null, e = null, caps = {}, protocol = 'openai', config = {}, fetcher, log } = {}) {
  const maxImages = config.maxImages ?? 4
  const maxFileBytes = config.maxFileBytes ?? 8 * 1024 * 1024
  const degrade = config.degrade || 'note'
  const debug = typeof log === 'function' ? log : null

  let active = []

  /** 主动收集 + 解析，应用上限；缓存到 active 供 buildContent / read_attachment 使用 */
  async function collectActive() {
    let list = []
    if (config.active !== false) {
      try {
        list = await collectFromEvent(e, { bot, log: debug })
      } catch (err) {
        debug?.(`collectFromEvent 异常: ${err?.message || err}`)
        list = []
      }
      // 解析字节：e 透传给 resolve，使 NapCat/OneBot 原生接口兜底可用（引用/历史/群文件）
      await resolveAll(list, { bot, fetcher, e, log: debug })
      // 应用上限：先保证图片在视觉模型下入参，超限/超大按 degrade 处理
      list = applyLimits(list, { maxImages, maxFileBytes, caps })
    }
    active = list
    return list
  }

  /** 组装 user 消息 content（字符串或协议原生数组） */
  function buildContent(text) {
    return buildUserContent(text, active, { protocol, caps, degrade })
  }

  /** 替换当前 active 列表（如把图片经视觉子模型转成文本描述后回填） */
  function replaceActive(list) {
    active = Array.isArray(list) ? list : []
  }

  return {
    collectActive,
    buildContent,
    replaceActive,
    activeAttachments: () => active.slice(),
    /** 供 ctx.media 使用：已解析的附件（含 buffer/mime） */
    media: () => active.slice(),
    /** 被动工具是否启用（config.passive !== false） */
    passiveEnabled: config.passive !== false,
  }
}

/** 应用数量 / 大小上限；超限不丢弃而是置 degrade 标记（让 convert 决定降级） */
function applyLimits(list, { maxImages, maxFileBytes, caps }) {
  const out = []
  let imgCount = 0
  for (const mf of list) {
    const isImg = mf.kind === 'image' || isImage(mf.mime)
    if (isImg) {
      imgCount++
      if (imgCount > maxImages) {
        mf.__skipReason = `超过单次图片上限 ${maxImages}`
        mf.resolveError = mf.resolveError || 'limit_images'
        out.push(mf)
        continue
      }
    }
    if (mf.bytes != null && mf.bytes > maxFileBytes) {
      mf.__skipReason = `超过单文件大小上限 ${(maxFileBytes / 1024 / 1024).toFixed(1)}MB`
      mf.resolveError = mf.resolveError || 'limit_size'
      out.push(mf)
      continue
    }
    out.push(mf)
  }
  return out
}

export {
  collectFromEvent,
  fetchReply,
  fetchQuotedContext,
  extractFromMessage,
  extractForwardResid,
  kindOf,
  dedupMedia,
  resolveMedia,
  resolveAll,
  inferMime,
  sniffMagic,
  asBase64,
  isTextLike,
  isImage,
  truncateText,
  mimeFromName,
  EXT_MIME,
  toOpenaiBlocks,
  toAnthropicBlocks,
  toGeminiBlocks,
  buildUserContent,
  listGroupFilesTool,
  getGroupFileTool,
  readAttachmentTool,
  makeMediaTools,
}
