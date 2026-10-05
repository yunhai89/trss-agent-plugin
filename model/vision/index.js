/**
 * 图片识别公共出口（A 方案：视觉识别 → 主模型回答）。
 *
 * 用法（apps 层）：
 *   import { VisionService, describeImages } from '../model/vision/index.js'
 *   const vision = new VisionService({ provider, model, protocol })
 *   // 主模型不支持视觉时，把收集到的图片转成文本描述：
 *   const described = await describeImages(vision, files, userQuestion)
 *   media.replaceActive(described)   // 再走 buildContent → 主模型拿到的是描述文本
 */

import { VisionService, DEFAULT_DESCRIBE } from './client.js'
import { isImage } from '../media/resolve.js'

/**
 * 把 mediaList 中的图片/视频逐张交视觉模型识别，替换为携带描述文本的"伪文本媒体"。
 * 非图片/视频媒体原样保留（交由主模型路径按能力降级）。
 *
 * @param {VisionService} vision
 * @param {MediaFile[]} mediaList 收集到的媒体（需已 resolve 出 buffer/mime）
 * @param {string} question 用户当前问题（引导识别重点）
 * @param {object} opts { images?:boolean, video?:boolean } 选择性转换：
 *   images=false 时保留图片原生块（主模型自带视觉，只让子模型转视频）；
 *   video=false 时保留视频原样（一般不用，视频无主模型原生块路径）。
 * @returns {Promise<MediaFile[]>} 转换后的媒体列表（图片/视频 → 文本）
 */
export async function describeImages(vision, mediaList, question, { images = true, video = true } = {}) {
  if (!vision || !Array.isArray(mediaList)) return mediaList || []
  const out = []
  for (const mf of mediaList) {
    const img = mf.kind === 'image' || isImage(mf.mime)
    const vid = mf.kind === 'video' || (mf.mime || '').startsWith('video/')

    if (!img && !vid) { out.push(mf); continue }
    if (img && !images) { out.push(mf); continue } // 主模型可原生看图 → 不转文本
    if (vid && !video) { out.push(mf); continue }

    // 超过大小/数量上限的媒体不送识别（否则把超大字节 base64 发给视觉端，浪费/失败）；
    // 降级为文本说明，保留文件名与来源。
    if (mf.resolveError === 'limit_size' || mf.resolveError === 'limit_images') {
      const label = mf.name ? `[${vid ? '视频' : '图片'} ${mf.name}]` : `[${vid ? '视频' : '图片'}]`
      out.push(toTextMedia(mf, `${label}（${mf.__skipReason || mf.resolveError}，未送识别）`))
      continue
    }

    if (vid) {
      // 视频识别（MiMo-V2.5 等支持 video_url 的模型）
      const label = mf.name ? `[视频 ${mf.name}]` : '[视频]'
      const urlPart = mf.url ? `\n（视频直链：${mf.url}）` : ''
      if (!mf.buffer) {
        out.push(mf.url ? toTextMedia(mf, `${label}（未能取到视频字节，直链：${mf.url}）`) : mf)
        continue
      }
      let desc = ''
      try {
        desc = await vision.recognizeVideo({ buffer: mf.buffer, mime: mf.mime, name: mf.name }, { question })
      } catch (e) {
        desc = ''
      }
      const text = desc ? `${label}：${desc}${urlPart}` : `${label}（识别失败/为空）${urlPart}`
      out.push(toTextMedia(mf, text))
      continue
    }

    // 图片识别
    const label = mf.name ? `[图片 ${mf.name}]` : '[图片]'
    // 保留图片直链：主模型无视觉时看不到图，但可把此 URL 传给视觉类工具/MCP（如 analyze_image）识别，
    // 否则图片被消耗成纯文本后，用户让它用 MCP 识别时模型手里没有地址可传 → "没有看到图片"。
    const urlPart = mf.url ? `\n（图片直链，可供视觉类工具/MCP 使用：${mf.url}）` : ''

    // 关键健壮性：图片字节偶发取不到（引用/历史消息 url 过期、NapCat get_image 缓存未就绪、
    // Docker 跨容器读不到本地路径、下载超时等）时，不能整张丢弃——否则主模型手里既无描述也无地址，
    // 让它用 MCP 视觉时就会"没有图片"。只要还有 url，就包成文本载体把地址交给主模型/MCP；
    // 既无字节也无 url 才无可挽回地原样降级（buildContent 会出占位文案）。
    if (!mf.buffer) {
      if (mf.url) {
        out.push(toTextMedia(mf, `${label}（未能取到图片字节，可改用图片直链交视觉类工具/MCP 识别：${mf.url}）`))
      } else {
        out.push(mf)
      }
      continue
    }

    let desc = ''
    try {
      desc = await vision.recognize({ buffer: mf.buffer, mime: mf.mime, name: mf.name }, { question })
    } catch (e) {
      desc = ''
    }
    const text = desc ? `${label}：${desc}${urlPart}` : `${label}（识别失败/为空）${urlPart}`
    out.push(toTextMedia(mf, text))
  }
  return out
}

/** 替换为文本载体媒体：buildContent 非视觉路径会按 text/plain 抽取为文本 */
function toTextMedia(mf, text) {
  return {
    ...mf,
    kind: 'file',
    mime: 'text/plain',
    ext: 'txt',
    buffer: Buffer.from(text),
    bytes: Buffer.byteLength(text),
    resolveError: undefined,
    __visionDescribed: true,
  }
}

export { VisionService, DEFAULT_DESCRIBE }
