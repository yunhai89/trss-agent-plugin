/**
 * 「看视频」—— 把 B 站视频交给多模态视觉模型（agent.vision）观看，产出可直接引用的文本报告。
 *
 * 为什么：字幕常缺失/机翻错漏、B站 AI 总结是二手转述；让多模态模型直接看画面+听声音才接近"看过"。
 * 流程：时长预检 → 下载低码率 mp4（非高清，够看清内容即可）→ 读取字节 → vision.recognizeVideo
 *      （OpenAI 兼容 video_url 块）→ 无论成败都删除临时文件。
 *
 * 硬边界（防把小时级/几百 MB 的视频灌给模型）：
 *  - 仅 openai 兼容协议 + 视觉模型声明视频能力（media.caps.video）；不满足时结构化返回原因，
 *    由 bilibili__analyze 回退字幕/转录（不静默失败、不臆测）；
 *  - 时长 > watchMaxDurationSec、文件 > watchMaxMB 一律不送模型（返回可操作的原因与建议）；
 *  - 报告长度由 maxTokens（watchMaxTokens）控制，思考型模型建议关思考或加大上限。
 */
import fs from 'node:fs'

import { downloadVideo } from './download.js'
import { DEFAULT_VIDEO_DESCRIBE } from '../../model/vision/index.js'
import { fmtDuration, resolveQuality, qualityLabel } from './util.js'

/** 默认上限（可经 agent.tools.bilibili.watch* 覆盖） */
export const WATCH_LIMITS = {
  quality: '360',        // 观看用低码率：内容看得清，字节/传输成本低
  maxMB: 40,             // 单次观看的视频文件上限（整文件读入 + base64 约 1.4×，40MB ≈ 峰值百 MB 级内存）
  maxDurationSec: 600,   // 单次观看的视频时长上限（10 分钟）
  maxTokens: 2048,       // 观看报告输出上限（思考型视觉模型需更宽松）
}

/** 观看用下载超时：整次请求（≤40MB 的低码率视频）放宽到 3 分钟 */
const WATCH_DOWNLOAD_TIMEOUT_MS = 180000

function clampInt(n, min, max, d) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : d
}

/**
 * 能否用当前视觉子模型看视频？返回 null=可以；否则给出原因与修复建议。
 * （与 VisionService.recognizeVideo 的跳过条件保持一致，提前给出可读原因，避免只有一条 warn 日志。）
 */
export function watchIneligibility(vision) {
  if (!vision) {
    return {
      reason: '未配置视觉子模型（agent.vision.model）',
      hint: '在配置中心「多模态 / 视觉」设置支持视频的多模态模型（如 mimo 系 omni）后即可看视频',
    }
  }
  if (String(vision.protocol || 'openai') !== 'openai') {
    return {
      reason: `视觉模型协议 ${vision.protocol} 不支持视频原生块（video_url 仅 OpenAI 兼容端）`,
      hint: '把 agent.vision 换到 OpenAI 兼容端点/模型，或依赖字幕/转录',
    }
  }
  if (vision.videoCapable === false) {
    return {
      reason: `视觉模型 ${vision.model || ''} 未声明视频能力`.trim(),
      hint: '该模型多为纯图像 VL；请在「模型列表」或 media.caps.video 声明视频能力，或换支持视频的模型',
    }
  }
  return null
}

/** 观看指令 = 配置自定义（watchPrompt）或内置视频报告指令 + 用户想了解的重点 */
export function buildWatchPrompt(cfg = {}, question = '') {
  const base = String(cfg.watchPrompt || '').trim() || DEFAULT_VIDEO_DESCRIBE
  const q = String(question || '').trim()
  return q ? `${base}\n\n用户想了解：${q}` : base
}

/**
 * 下载并观看一个 B 站视频。
 * @param {object} o
 * @param {object} o.video 归一的视频详情（normalizeVideo 产物：bvid/cid/title/duration/...）
 * @param {object} o.vision 视觉子模型（rt.vision；可空）
 * @param {object} [o.cfg] agent.tools.bilibili 配置
 * @param {string} [o.question] 用户想了解的重点
 * @param {object} [o.downloadOpts] 透传给 downloadVideo（fetcher/cookie 等）
 * @param {object} [o.deps] 依赖注入（测试用）：{ downloadVideo }
 * @returns {Promise<{ok:true, description, quality, sizeMB, durationSec, via, model, downgraded}|{ok:false, reason, hint?}>}
 */
export async function watchVideo({ video, vision, cfg = {}, question = '', downloadOpts = {}, deps = {} } = {}) {
  const download = deps.downloadVideo || downloadVideo
  const elig = watchIneligibility(vision)
  if (elig) return { ok: false, ...elig }

  const durationSec = Number(video?.duration) || 0
  const maxDurationSec = clampInt(cfg.watchMaxDurationSec, 30, 3600, WATCH_LIMITS.maxDurationSec)
  if (durationSec > maxDurationSec) {
    return {
      ok: false,
      reason: `视频时长 ${fmtDuration(durationSec)} 超过看视频上限 ${fmtDuration(maxDurationSec)}`,
      hint: '调大 agent.tools.bilibili.watchMaxDurationSec，或让模型改用字幕/转录（bilibili__subtitle）',
    }
  }
  if (!video?.bvid || !video?.cid) return { ok: false, reason: '视频信息不完整（缺 bvid/cid），无法下载观看' }

  const quality = resolveQuality(cfg.watchQuality || WATCH_LIMITS.quality) || resolveQuality(WATCH_LIMITS.quality)
  let media = null
  try {
    media = await download(
      { bvid: video.bvid, cid: video.cid, title: video.title },
      {
        ...downloadOpts,
        quality,
        format: 'mp4',   // 多模态端点普遍可解
        codec: 'avc',    // H.264 兼容性最好
        downloadTimeoutMs: WATCH_DOWNLOAD_TIMEOUT_MS, // 媒体整段下载放宽（API 请求仍用配置的 timeoutMs）
      },
    )
  } catch (e) {
    return { ok: false, reason: `下载视频失败：${e?.message || e}` }
  }

  try {
    const maxMB = clampInt(cfg.watchMaxMB, 1, 300, WATCH_LIMITS.maxMB)
    const sizeMB = Number(((Number(media.size) || 0) / 1048576).toFixed(1))
    if (media.size > maxMB * 1048576) {
      return {
        ok: false,
        reason: `视频文件 ${sizeMB}MB 超过看视频上限 ${maxMB}MB`,
        hint: '调大 agent.tools.bilibili.watchMaxMB，或调低 watchQuality；也可让模型改用字幕/转录（bilibili__subtitle）',
      }
    }
    const buffer = fs.readFileSync(media.path)
    const name = String(media.path || '').split('/').pop() || `${video.bvid}.mp4`
    const mime = media.ext === 'mkv' ? 'video/x-matroska' : 'video/mp4'
    const description = await vision.recognizeVideo(
      { buffer, mime, name },
      {
        question: '',
        prompt: buildWatchPrompt(cfg, question),
        maxTokens: clampInt(cfg.watchMaxTokens, 256, 16384, WATCH_LIMITS.maxTokens),
      },
    )
    if (!description) {
      return {
        ok: false,
        reason: '视觉模型未产出观看报告（可能不支持视频输入，或输出被 max_tokens 截断/仅产出思考）',
        hint: '确认 agent.vision.model 支持视频（video_url）；思考型模型请关思考或调大 agent.tools.bilibili.watchMaxTokens',
      }
    }
    return {
      ok: true,
      description: String(description).trim(),
      quality: media.quality ? qualityLabel(media.quality) : '',
      requestedQuality: qualityLabel(quality),
      downgraded: !!media.downgraded,
      sizeMB,
      durationSec,
      via: media.via || '',
      model: String(vision.model || ''),
    }
  } finally {
    // 观看产物是一次性的：成功/失败都不留盘（避免 temp 目录堆积大文件）
    try { fs.unlinkSync(media.path) } catch { /* noop */ }
  }
}
