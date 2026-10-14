/**
 * 哔哩哔哩工具包（目录型：index 入口 + sign.js 签名 + api.js 请求 + download.js 下载 + util.js 辅助）。
 *
 * 逆向接口来源：哔哩哔哩野生 API 文档（realysy/bili-apis ≈ SocialSisterYi/bilibili-API-collect）。
 * 匿名可用：搜索 / 详情 / 播放地址 / 评论 / 弹幕 / 榜单 / 热门；需登录 Cookie（SESSDATA）：AI 总结 / 字幕 / 用户空间 / 高清晰度。
 *
 * 工具：
 *  - bilibili__search    视频搜索
 *  - bilibili__video     视频详情
 *  - bilibili__analyze   视频分析包（元数据+AI总结+字幕/STT转录+热评+弹幕，交主 agent 总结）
 *  - bilibili__download  分享卡片(默认)/下载视频(dash合并或durl,可选分辨率)/音频(m4a)
 *  - bilibili__subtitle  字幕文本
 *  - bilibili__comments  热门评论
 *  - bilibili__danmaku   弹幕取样
 *  - bilibili__ranking   排行榜
 *  - bilibili__popular   热门视频
 *  - bilibili__user      UP主信息 + 投稿（需 Cookie）
 *
 * 未启用（config agent.tools.bilibili.enable:false）时 factory 返回 []，零影响。
 */
import fs from 'node:fs'
import { defineToolPack, defineTool, param, ok, fail, sendApi, sendText, getToolConfig } from '../../model/toolkit/index.js'
import Config from '../../utils/Config.js'
import {
  search, getVideo, getConclusion, getSubtitles, getComments, getDanmaku,
  getRanking, getPopular, getUserInfo, getUserVideos, transcribeAudio, BiliError,
} from './api.js'
import { downloadVideo, downloadAudio } from './download.js'
import { fmtCount, fmtDate, parseMid, buildBiliCardJson, resolveQuality, qualityLabel } from './util.js'

const cfg = () => getToolConfig('bilibili')

function optsOf(ctx) {
  const c = cfg()
  return {
    fetcher: ctx?.fetcher,
    cookie: typeof c.cookie === 'string' ? c.cookie.trim() : '',
    timeoutMs: clamp(Number(c.timeout), 3000, 60000, 15000),
    cfg: c,
  }
}
function clamp(n, min, max, d) { return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d }

/** 发送本地媒体文件：用 OneBot 原生上传动作 + **绝对路径**（大文件 base64 会被 NapCat 拒：rich media transfer failed）。 */
async function sendMediaFile(ctx, absPath, name) {
  const base = name || absPath.split('/').pop()
  if (ctx?.isGroup) return !!(await sendApi(ctx, 'upload_group_file', { group_id: ctx.groupId, file: absPath, name: base })).ok
  return !!(await sendApi(ctx, 'upload_private_file', { user_id: ctx.userId, file: absPath, name: base })).ok
}

/** 发送 B站分享卡片（NapCat `json` 消息段，小程序卡片）。失败返回 false，由调用方回退文本链接。 */
async function sendBiliCard(ctx, card) {
  const seg = { type: 'json', data: { data: JSON.stringify(card) } }
  if (ctx?.isGroup && ctx.groupId) return !!(await sendApi(ctx, 'send_group_msg', { group_id: String(ctx.groupId), message: [seg] })).ok
  if (ctx?.userId) return !!(await sendApi(ctx, 'send_private_msg', { user_id: String(ctx.userId), message: [seg] })).ok
  return false
}

function errNote(e) {
  if (e instanceof BiliError && e.kind === 'need_login') return '（需登录 Cookie：agent.tools.bilibili.cookie 填 B站 SESSDATA）'
  if (e instanceof BiliError && e.kind === 'risk') return '（触发风控，稍后再试或配置 Cookie）'
  return ''
}

const VIDEO_PARAM = param.str('视频标识：BV 号 / av 号 / 视频页 URL / b23.tv 短链')

// ─── search ───
const searchTool = defineTool({
  name: 'search',
  description: '哔哩哔哩视频搜索。返回 bvid/标题/UP/播放量/时长等，可交给 bilibili__video / bilibili__analyze。只检索，不下载。',
  category: 'query',
  meta: { summary: 'B站视频搜索', resultCap: 4000 },
  parameters: param.object({
    keyword: param.str('搜索关键词'),
    order: param.enum('排序：综合 totalrank / 最多点击 click / 最新发布 pubdate / 最多弹幕 dm / 最多收藏 stow', ['totalrank', 'click', 'pubdate', 'dm', 'stow']),
    page: param.int('页码（默认 1）', { min: 1 }),
    limit: param.int('返回条数（默认取配置 maxResults）', { min: 1 }),
  }, ['keyword']),
  async execute(p, ctx) {
    try {
      const r = await search(p.keyword, { page: p.page || 1, order: p.order || 'totalrank' }, optsOf(ctx))
      const limit = clamp(Number(p.limit), 1, 30, Number(cfg().maxResults) || 10)
      const items = r.items.slice(0, limit)
      return ok({ keyword: r.keyword, page: r.page, count: items.length, items })
    } catch (e) { return fail(`B站搜索失败：${e?.message || e}${errNote(e)}`, { recoverable: true }) }
  },
})

// ─── video ───
const videoTool = defineTool({
  name: 'video',
  description: '获取哔哩哔哩视频详情：标题/UP/时长/简介/封面/统计/分P。输入 BV 号 / av 号 / URL / 短链。要看内容分析用 bilibili__analyze。',
  category: 'query',
  meta: { summary: 'B站视频详情', resultCap: 4000 },
  parameters: param.object({ video: VIDEO_PARAM }, ['video']),
  async execute(p, ctx) {
    try {
      const v = await getVideo(p.video, optsOf(ctx))
      return ok({
        ...v,
        statText: { view: fmtCount(v.stat.view), like: fmtCount(v.stat.like), danmaku: fmtCount(v.stat.danmaku) },
        url: `https://www.bilibili.com/video/${v.bvid}`,
        pubdateText: fmtDate(v.pubdate),
      })
    } catch (e) { return fail(`B站视频获取失败：${e?.message || e}${errNote(e)}`, { recoverable: true }) }
  },
})

// ─── analyze ───
const analyzeTool = defineTool({
  name: 'analyze',
  description: '哔哩哔哩视频内容分析包：拉取 元数据 + B站AI总结(需Cookie) + 字幕/无字幕时音频STT转录 + 热门评论 + 弹幕取样，返回结构化内容供你（主模型）总结/回答。用户说“分析/总结/讲讲这个B站视频”时用它。',
  category: 'query',
  meta: { summary: 'B站视频内容分析', resultCap: 8000 },
  parameters: param.object({
    video: VIDEO_PARAM,
    question: param.str('用户想了解的重点（可选，用于引导分析）'),
    comments: param.bool('是否包含热门评论（默认 true）'),
    danmaku: param.bool('是否包含弹幕取样（默认 false）'),
    maxChars: param.int('字幕/转录最大字符数（默认 6000）', { min: 500 }),
  }, ['video']),
  async execute(p, ctx) {
    const opts = optsOf(ctx)
    const c = cfg()
    try {
      const v = await getVideo(p.video, opts)
      const cap = clamp(Number(p.maxChars), 500, 20000, 6000)
      const bundle = {
        video: { bvid: v.bvid, title: v.title, up: v.owner.name, mid: v.owner.mid, duration: v.durationText, pubdate: fmtDate(v.pubdate), desc: v.desc, statText: { view: fmtCount(v.stat.view), like: fmtCount(v.stat.like) }, url: `https://www.bilibili.com/video/${v.bvid}` },
        question: p.question || '',
      }
      const notes = []

      // 1) B站 AI 总结（需登录 Cookie）
      try {
        const cc = await getConclusion({ bvid: v.bvid, cid: v.cid, upMid: v.owner.mid }, opts)
        if (cc.summary || cc.outline.length) {
          bundle.aiSummary = { summary: cc.summary, outline: cc.outline.map((o) => ({ title: o.title, points: o.points.map((pt) => pt.content).filter(Boolean) })) }
        } else notes.push('B站 AI 总结为空')
      } catch (e) { notes.push(`AI 总结不可用${errNote(e)}`) }

      // 2) 字幕（需 Cookie）；无字幕且有 STT 时下载音频转录
      let transcript = ''
      try {
        const s = await getSubtitles({ bvid: v.bvid, cid: v.cid }, opts)
        if (s.text) { transcript = s.text; bundle.transcriptSource = `字幕(${s.lan})` }
        else notes.push(`无字幕（可用字幕：${s.available.map((a) => a.lan).join('/') || '无'}）`)
      } catch (e) { notes.push(`字幕不可用${errNote(e)}`) }

      if (!transcript && c.enableStt !== false) {
        const stt = Config.get()?.agent?.stt || {}
        if (stt.enable === false) {
          notes.push('无字幕；STT 已禁用（agent.stt.enable=false），无法转录')
        } else if (!stt.apiKey) {
          notes.push('无字幕且未配置 STT：请在配置中心「多模态 / 工具 / 扩展 → 语音转写 STT」填 Whisper 兼容的 apiKey（OpenAI/Groq/SiliconFlow 等；非 OpenAI 端点需同时填 apiBase），之后即可自动转录音频')
        } else {
          let audioPath = ''
          try {
            const a = await downloadAudio({ bvid: v.bvid, cid: v.cid, title: v.title }, opts)
            audioPath = a.path
            transcript = await transcribeAudio(audioPath, stt, { fetchImpl: ctx?.fetcher })
            bundle.transcriptSource = 'STT 语音转录'
          } catch (e) { notes.push(`STT 转录失败：${e?.message || e}${/401|403|Invalid|apiKey/i.test(e?.message || '') ? '（检查 agent.stt.apiKey/apiBase）' : ''}`) }
          finally { if (audioPath) { try { fs.unlinkSync(audioPath) } catch { /* noop */ } } }
        }
      }

      if (transcript) bundle.transcript = transcript.slice(0, cap)

      // 3) 热门评论
      if (p.comments !== false) {
        try { bundle.comments = await getComments({ aid: v.aid, ps: 10 }, opts) } catch (e) { notes.push(`评论不可用：${e?.message || e}`) }
      }
      // 4) 弹幕取样
      if (p.danmaku === true) {
        try { bundle.danmaku = await getDanmaku(v.cid, { limit: 80 }, opts) } catch (e) { notes.push(`弹幕不可用：${e?.message || e}`) }
      }

      bundle.notes = notes.join('；')
      return ok(bundle)
    } catch (e) { return fail(`B站视频分析失败：${e?.message || e}${errNote(e)}`, { recoverable: true }) }
  },
})

// ─── download / share ───
const downloadTool = defineTool({
  name: 'download',
  description: '分享或下载哔哩哔哩视频。默认只发 B站分享卡片（小程序卡片，点击跳转），不下载文件；send_video=true（或配置 sendMedia）时额外下载并发送文件——分辨率取 videoQuality 配置（1080p+/4k/8k 需大会员，取不到自动回退到可用最高档），dash 分轨用 ffmpeg 合并、缺 ffmpeg 时回退 durl MP4。kind=audio 下音频(m4a)。',
  category: 'query',
  meta: { summary: 'B站分享卡片/下载', resultCap: 3000 },
  parameters: param.object({
    video: VIDEO_PARAM,
    kind: param.enum('下载类型：video 视频 / audio 音频(m4a)', ['video', 'audio']),
    send: param.bool('是否发分享卡片（默认取配置 sendCard）'),
    send_video: param.bool('是否额外下载并发送文件（默认取配置 sendMedia）'),
    quality: param.enum('分辨率（默认取配置 videoQuality；高码率需大会员，取不到自动回退）', ['360', '480', '720', '1080', '1080p+', '4k', '8k']),
    format: param.enum('视频容器格式（默认取配置 videoFormat）', ['mp4', 'mkv']),
  }, ['video']),
  async execute(p, ctx) {
    const opts = optsOf(ctx)
    const c = cfg()
    try {
      const v = await getVideo(p.video, opts)
      const kind = p.kind === 'audio' ? 'audio' : 'video'
      const wantCard = p.send === undefined ? c.sendCard !== false : !!p.send
      const wantMedia = p.send_video === undefined ? !!c.sendMedia : !!p.send_video
      const quality = resolveQuality(p.quality || c.videoQuality || '1080')
      const format = p.format === 'mkv' ? 'mkv' : (p.format || c.videoFormat || 'mp4')
      const vurl = `https://www.bilibili.com/video/${v.bvid}`

      const out = { bvid: v.bvid, title: v.title, url: vurl }
      const notes = []

      // 1) 分享卡片（默认）：json 小程序卡片；失败回退文本链接
      if (wantCard) {
        let cardSent = false
        try {
          cardSent = await sendBiliCard(ctx, buildBiliCardJson({
            title: v.title, desc: v.desc, cover: v.cover, url: vurl,
            uin: ctx?.bot?.uin || ctx?.selfId || '', nick: '哔哩哔哩',
          }))
        } catch { cardSent = false }
        if (!cardSent) { try { await sendText(ctx, `【哔哩哔哩】${v.title}\n${vurl}`) } catch { /* noop */ } }
        out.cardSent = cardSent
        notes.push(cardSent ? '已发送 B站分享卡片' : '卡片发送失败，已回退文本链接')
      }

      // 2) 直接发文件（可选）：分辨率/格式可配，会员档自动回退
      if (wantMedia) {
        const r = kind === 'audio'
          ? await downloadAudio({ bvid: v.bvid, cid: v.cid, title: v.title }, opts)
          : await downloadVideo({ bvid: v.bvid, cid: v.cid, title: v.title }, { ...opts, quality, format, codec: c.videoCodec })
        const maxMB = Number(c.maxMediaMB) || 80
        const sizeMB = Number((r.size / 1048576).toFixed(2))
        let sent = false
        if (r.size > maxMB * 1024 * 1024) {
          notes.push(`文件 ${sizeMB}MB 超过发送上限 ${maxMB}MB，未发送（路径：${r.path}）`)
        } else {
          try { sent = await sendMediaFile(ctx, r.path, r.path.split('/').pop()) } catch { sent = false }
          notes.push(sent ? '已发送文件' : '⚠️ 发送失败：文件已下载到本地（路径见 media.path）')
          if (r.downgraded) notes.push(`分辨率请求 ${qualityLabel(r.requestedQuality)} → 实得 ${qualityLabel(r.quality)}（需大会员或登录 Cookie）`)
        }
        out.sent = sent
        out.media = { file: r.path.split('/').pop(), sizeMB, path: r.path, via: r.via, ext: r.ext, quality: r.quality ? qualityLabel(r.quality) : undefined, downgraded: !!r.downgraded }
      }

      if (!wantCard && !wantMedia) notes.push('未发送（send=false 且 send_video=false）')
      out.note = notes.join('；')
      return ok(out)
    } catch (e) { return fail(`B站分享/下载失败：${e?.message || e}${errNote(e)}`, { recoverable: true }) }
  },
})

// ─── subtitle ───
const subtitleTool = defineTool({
  name: 'subtitle',
  description: '获取哔哩哔哩视频字幕文本（CC / AI 字幕）。需登录 Cookie（SESSDATA）。返回可用语言与正文。',
  category: 'query',
  meta: { summary: 'B站字幕', resultCap: 8000 },
  parameters: param.object({
    video: VIDEO_PARAM,
    maxChars: param.int('最大字符数（默认 6000）', { min: 500 }),
  }, ['video']),
  async execute(p, ctx) {
    const opts = optsOf(ctx)
    try {
      const v = await getVideo(p.video, opts)
      const s = await getSubtitles({ bvid: v.bvid, cid: v.cid }, opts)
      const cap = clamp(Number(p.maxChars), 500, 20000, 6000)
      return ok({ bvid: v.bvid, available: s.available, lan: s.lan, text: s.text.slice(0, cap), truncated: s.text.length > cap })
    } catch (e) { return fail(`B站字幕获取失败：${e?.message || e}${errNote(e)}`, { recoverable: true }) }
  },
})

// ─── comments ───
const commentsTool = defineTool({
  name: 'comments',
  description: '获取哔哩哔哩视频热门评论（按热度）。',
  category: 'query',
  meta: { summary: 'B站热门评论', resultCap: 6000 },
  parameters: param.object({
    video: VIDEO_PARAM,
    limit: param.int('条数（默认 10，最多 20）', { min: 1 }),
  }, ['video']),
  async execute(p, ctx) {
    const opts = optsOf(ctx)
    try {
      const v = await getVideo(p.video, opts)
      const n = clamp(Number(p.limit), 1, 20, 10)
      const r = await getComments({ aid: v.aid, ps: n }, opts)
      return ok({ bvid: v.bvid, count: r.count, items: r.items })
    } catch (e) { return fail(`B站评论获取失败：${e?.message || e}${errNote(e)}`, { recoverable: true }) }
  },
})

// ─── danmaku ───
const danmakuTool = defineTool({
  name: 'danmaku',
  description: '获取哔哩哔哩视频弹幕取样（时间/模式/文本）。',
  category: 'query',
  meta: { summary: 'B站弹幕', resultCap: 6000 },
  parameters: param.object({
    video: VIDEO_PARAM,
    limit: param.int('取样条数（默认 100，最多 300）', { min: 1 }),
  }, ['video']),
  async execute(p, ctx) {
    const opts = optsOf(ctx)
    try {
      const v = await getVideo(p.video, opts)
      const n = clamp(Number(p.limit), 1, 300, 100)
      const r = await getDanmaku(v.cid, { limit: n }, opts)
      return ok({ bvid: v.bvid, total: r.count, sampled: r.items.length, items: r.items })
    } catch (e) { return fail(`B站弹幕获取失败：${e?.message || e}${errNote(e)}`, { recoverable: true }) }
  },
})

// ─── ranking ───
const rankingTool = defineTool({
  name: 'ranking',
  description: '哔哩哔哩排行榜。rid 分区：0 全站 / 1 动画 / 3 音乐 / 4 游戏 / 5 娱乐 / 36 科技 / 119 鬼畜 / 129 舞蹈 / 155 时尚 / 160 生活 / 168 影视 / 181 影视 / 188 数码 / 211 美食 / 217 动物圈 / 223 汽车 / 234 运动 / 249 生活。',
  category: 'query',
  meta: { summary: 'B站排行榜', resultCap: 5000 },
  parameters: param.object({
    rid: param.int('分区 id（默认 0 全站）', { min: 0 }),
    type: param.enum('类型：all 全部 / origin 原创', ['all', 'origin']),
    limit: param.int('返回条数（默认 20，最多 50）', { min: 1 }),
  }, []),
  async execute(p, ctx) {
    try {
      const r = await getRanking({ rid: p.rid || 0, type: p.type || 'all' }, optsOf(ctx))
      const n = clamp(Number(p.limit), 1, 50, 20)
      return ok({ rid: r.rid, count: r.list.length, list: r.list.slice(0, n).map((v, i) => ({ rank: i + 1, ...v, playText: fmtCount(v.play) })) })
    } catch (e) { return fail(`B站排行榜获取失败：${e?.message || e}${errNote(e)}`, { recoverable: true }) }
  },
})

// ─── popular ───
const popularTool = defineTool({
  name: 'popular',
  description: '哔哩哔哩综合热门视频（热门页）。',
  category: 'query',
  meta: { summary: 'B站热门视频', resultCap: 5000 },
  parameters: param.object({
    limit: param.int('返回条数（默认 20，最多 50）', { min: 1 }),
    page: param.int('页码（默认 1）', { min: 1 }),
  }, []),
  async execute(p, ctx) {
    try {
      const n = clamp(Number(p.limit), 1, 50, 20)
      const r = await getPopular({ ps: n, pn: p.page || 1 }, optsOf(ctx))
      return ok({ count: r.list.length, list: r.list.map((v, i) => ({ rank: i + 1, ...v, playText: fmtCount(v.play) })) })
    } catch (e) { return fail(`B站热门获取失败：${e?.message || e}${errNote(e)}`, { recoverable: true }) }
  },
})

// ─── user ───
const userTool = defineTool({
  name: 'user',
  description: '获取哔哩哔哩 UP 主信息与投稿视频（需登录 Cookie）。mid 可用数字或空间链接。',
  category: 'query',
  meta: { summary: 'B站UP主信息/投稿', resultCap: 5000 },
  parameters: param.object({
    mid: param.str('UP主 mid（数字）或 space.bilibili.com/数字 链接'),
    limit: param.int('投稿条数（默认 10，最多 30）', { min: 1 }),
  }, ['mid']),
  async execute(p, ctx) {
    const opts = optsOf(ctx)
    const mid = parseMid(p.mid)
    if (!mid) return fail('无法识别 mid（请给数字或空间链接）')
    try {
      const info = await getUserInfo(mid, opts)
      const n = clamp(Number(p.limit), 1, 30, 10)
      const videos = await getUserVideos(mid, { ps: n, pn: 1 }, opts)
      return ok({ info, videos: videos.list })
    } catch (e) { return fail(`B站UP主获取失败：${e?.message || e}${errNote(e)}`, { recoverable: true }) }
  },
})

export default defineToolPack({
  name: 'bilibili',
  description: '哔哩哔哩检索/详情/分析/下载/字幕/评论/弹幕/榜单/热门/UP主（逆向接口，只读+下载）',
  author: 'trss-agent-plugin',
  version: '1.0.0',
  factory: () => (cfg().enable === false ? [] : [
    searchTool, videoTool, analyzeTool, downloadTool, subtitleTool,
    commentsTool, danmakuTool, rankingTool, popularTool, userTool,
  ]),
})
