/**
 * QQ 音乐工具包（目录型：index 入口 + sign.js 签名 + api.js 请求 + util.js 辅助）。
 *
 * 逆向接口来源（当前仍在维护的项目，详见 api.js / sign.js 头注释）：
 *  - sansenjian/qq-music-api（Node/TS，活跃维护）
 *  - L-1124/QQMusicApi（Python，持续更新）
 *
 * 工具：
 *  - qqmusic__search    关键字搜歌 / 专辑 / MV
 *  - qqmusic__song      歌曲详情 + 播放链接（需登录 Cookie；可选发语音）
 *  - qqmusic__lyric     歌词（明文 LRC + 翻译）
 *  - qqmusic__top       榜单目录 / 榜单歌曲
 *  - qqmusic__playlist  歌单详情
 *
 * 未启用（config agent.qqmusic.enable:false）时 factory 返回 []，零影响。
 * 读接口均为只读外部调用；Cookie 仅发往 QQ 音乐固定域名，不落库、不回填结果。
 */
import { defineToolPack, defineTool, param, ok, fail, sendVoice, sendMusic, getToolConfig } from '../../model/toolkit/index.js'
import { search, getSongDetail, getSongUrl, getLyric, getTopCategories, getTopSongs, getPlaylist } from './api.js'
import {
  parseUinFromCookie, parseAuthstFromCookie, isValidSongmid, clampInt, normalizeQuality, QUALITY_MAP,
  coverUrl, songJumpUrl, DEFAULT_COVER,
} from './util.js'

const cfg = () => getToolConfig('qqmusic')

/** 组装一次调用所需的传输上下文（cookie 只在内存中转，不写日志） */
function optsOf(ctx) {
  const c = cfg()
  const cookie = typeof c.cookie === 'string' ? c.cookie.trim() : ''
  return {
    fetcher: ctx?.fetcher,
    cookie,
    uin: parseUinFromCookie(cookie),
    authst: parseAuthstFromCookie(cookie),
    timeoutMs: clampInt(c.timeout, 3000, 60000, 15000),
  }
}

function qualityEnum() {
  const vals = Object.keys(QUALITY_MAP)
  return param.enum(`音质：${vals.map((v) => `${v}(${QUALITY_MAP[v].label})`).join(' / ')}`, vals)
}

/** 关键词 → songmid（取搜索首条） */
async function resolveSongmid(keyword, opts) {
  const res = await search(keyword, { page: 1, limit: 1, type: 'song' }, opts)
  return res.items[0]?.songmid || ''
}

// ─── qqmusic__search ───
const searchTool = defineTool({
  name: 'search',
  description:
    'QQ 音乐关键字搜索。type=song 搜歌曲（默认）、album 搜专辑、mv 搜 MV。返回 songmid 等标识，可交给 qqmusic__song 取详情/播放链接。只做检索，不下载/不播放。',
  category: 'query',
  meta: { summary: 'QQ 音乐搜索', resultCap: 4000 },
  parameters: param.object({
    keyword: param.str('搜索关键词（歌名 / 歌手 / 专辑名）'),
    type: param.enum('搜索类型：song 歌曲 / album 专辑 / mv MV', ['song', 'album', 'mv']),
    limit: param.int('返回条数 1-30（默认 10）', { min: 1 }),
    page: param.int('页码（默认 1）', { min: 1 }),
  }, ['keyword']),
  async execute(p, ctx) {
    try {
      const res = await search(p.keyword, { page: p.page || 1, limit: p.limit || cfg().maxResults || 10, type: p.type || 'song' }, optsOf(ctx))
      if (!res.items.length) return ok({ ...res, count: 0, note: '无结果，可换关键词或换 type' })
      return ok({ ...res, count: res.items.length })
    } catch (e) {
      return fail(`QQ 音乐搜索失败：${e?.message || e}`, { recoverable: true })
    }
  },
})

// ─── qqmusic__song ───
const songTool = defineTool({
  name: 'song',
  description:
    '获取 QQ 音乐单曲详情并发送。可用 songmid（精确）或 keyword（搜索取首条）。默认发送 QQ 音乐分享卡片（自定义卡片：封面+标题+跳转，点击可打开 QQ 音乐）。播放直链需要登录 Cookie（agent.tools.qqmusic.cookie，含 uin 与 qqmusic_key），非会员通常只能取 128k/m4a，320k/flac 需绿钻，高档取不到会自动回退低档。card=false 可关卡片；send=true 额外发语音。只处理“确定的一首歌”，批量/探索式找歌请先用 qqmusic__search。',
  category: 'query',
  meta: { summary: 'QQ 音乐歌曲详情/播放', resultCap: 4000 },
  parameters: param.object({
    songmid: param.str('歌曲 mid（与 keyword 二选一，优先）'),
    keyword: param.str('关键词：歌名+歌手，内部搜索取首条（未给 songmid 时使用）'),
    quality: qualityEnum(),
    card: param.bool('是否发送 QQ 音乐分享卡片（默认取配置 agent.tools.qqmusic.sendCard）'),
    send: param.bool('是否额外把播放链接作为语音发送（默认取配置 agent.tools.qqmusic.sendVoice）'),
  }, []),
  async execute(p, ctx) {
    const opts = optsOf(ctx)
    try {
      let songmid = typeof p.songmid === 'string' ? p.songmid.trim() : ''
      if (songmid && !isValidSongmid(songmid)) return fail(`songmid 格式不合法：${songmid}`)
      if (!songmid) {
        if (!p.keyword) return fail('需要提供 songmid 或 keyword')
        songmid = await resolveSongmid(p.keyword, opts)
        if (!songmid) return fail(`未搜索到「${p.keyword}」对应的歌曲`, { recoverable: true })
      }

      const song = await getSongDetail({ songmid }, opts)
      if (!song.songmid && !song.name) {
        return fail(`未获取到歌曲详情（songmid=${songmid} 可能无效，或上游异常），未发送卡片`, { recoverable: true })
      }
      const quality = normalizeQuality(p.quality || cfg().quality || '320')
      let play = { url: '', quality, restriction: 'url_unavailable' }
      try {
        play = await getSongUrl(songmid, { quality, mediaMid: song.mediaMid }, opts)
      } catch (e) {
        play = { url: '', quality, restriction: 'url_unavailable', error: e?.message || String(e) }
      }

      // 分享卡片：用自定义卡片（NapCat 的 music 段 id 解析已被默认签名服务关闭，
      // 原生 type:'qq' 会报 1200；自定义卡片带 url/audio/title/image 可正常生成 QQ 音乐卡片）。
      // 必须有 songmid（跳转地址有效）才发，避免发出空卡片。
      const wantCard = p.card === undefined ? cfg().sendCard !== false : !!p.card
      let cardSent = false
      if (wantCard && song.songmid) {
        cardSent = await sendMusic(ctx, {
          type: 'custom',
          url: songJumpUrl(song.songmid),
          audio: play.url || '',
          title: [song.name, ...song.singers].filter(Boolean).join(' - ') || song.name || 'QQ音乐',
          image: coverUrl(song.albummid) || DEFAULT_COVER,
          content: song.singers.join('/'),
        })
      }

      // 语音：显式 send=true 时发送；未显式指定时，仅当没发成卡片且配置开启才发
      const explicitSend = p.send === true
      const wantVoice = explicitSend || (p.send === undefined && !!cfg().sendVoice && !cardSent)
      let sent = false
      if (wantVoice && play.url) sent = await sendVoice(ctx, play.url)

      const notes = []
      if (cardSent) notes.push('已发送 QQ 音乐分享卡片')
      else if (wantCard && !song.songmid) notes.push('未发送卡片：缺少有效 songmid')
      if (sent) notes.push('已作为语音发送')
      if (!play.url) notes.push(playbackNote(play.restriction, quality))

      return ok({
        song,
        play: {
          quality: play.quality,
          url: play.url,
          needLogin: play.needLogin || false,
          restriction: play.restriction || null,
        },
        cardSent,
        sent,
        note: notes.join('；'),
      })
    } catch (e) {
      return fail(`QQ 音乐歌曲获取失败：${e?.message || e}`, { recoverable: true })
    }
  },
})

/** 播放失败原因 → 准确文案（避免“没配 Cookie”误报） */
function playbackNote(restriction, quality) {
  switch (restriction) {
    case 'login_required':
      return '未取得播放链接：需要登录 Cookie（agent.tools.qqmusic.cookie 填 QQ 音乐 Cookie 的 uin 与 qqmusic_key）。'
    case 'playback_denied':
      return '未取得播放链接：Cookie 已读取，但该账号无播放权限（QQ 音乐 104003）——可能需绿钻/会员、购买，或 Cookie 缺少播放票据。'
    case 'vip_required':
      return `未取得 ${quality} 播放链接：该曲目/音质需要绿钻或会员；可在配置里把默认音质降到 128，非会员通常只能听 128k/m4a。`
    case 'trial_only':
      return '未取得完整播放链接：该曲目仅提供试听片段。'
    default:
      return '未取得播放链接：曲目可能受版权限制或上游接口变动。'
  }
}

// ─── qqmusic__lyric ───
const lyricTool = defineTool({
  name: 'lyric',
  description: '获取 QQ 音乐歌曲歌词（明文 LRC，含翻译行）。需要 songmid（可由 qqmusic__search 或 qqmusic__song 得到）。',
  category: 'query',
  meta: { summary: 'QQ 音乐歌词', resultCap: 6000 },
  parameters: param.object({
    songmid: param.str('歌曲 mid'),
    maxChars: param.int('歌词最大字符数（默认 4000，超出截断）', { min: 100 }),
  }, ['songmid']),
  async execute(p, ctx) {
    const songmid = typeof p.songmid === 'string' ? p.songmid.trim() : ''
    if (!isValidSongmid(songmid)) return fail(`songmid 格式不合法：${songmid}`)
    try {
      const { lyric, trans } = await getLyric({ songmid }, optsOf(ctx))
      const cap = clampInt(p.maxChars, 100, 20000, 4000)
      const truncated = lyric.length > cap
      return ok({
        songmid,
        lyric: truncated ? `${lyric.slice(0, cap)}\n…（已截断）` : lyric,
        trans: trans || undefined,
        truncated,
      })
    } catch (e) {
      return fail(`QQ 音乐歌词获取失败：${e?.message || e}`, { recoverable: true })
    }
  },
})

// ─── qqmusic__top ───
const topTool = defineTool({
  name: 'top',
  description:
    'QQ 音乐榜单。不传 topId 时列出全部榜单目录（返回 topId）；传 topId 时返回该榜榜单曲（含 songmid，可交给 qqmusic__song 取播放链接）。做“排行榜/热歌榜”类需求用它，具体某首歌用 qqmusic__song。',
  category: 'query',
  meta: { summary: 'QQ 音乐榜单', resultCap: 4000 },
  parameters: param.object({
    topId: param.int('榜单 id（不传则返回榜单目录）', { min: 1 }),
    limit: param.int('榜单歌曲条数 1-100（默认 20）', { min: 1 }),
    page: param.int('页码（默认 1）', { min: 1 }),
  }, []),
  async execute(p, ctx) {
    const opts = optsOf(ctx)
    try {
      if (p.topId === undefined || p.topId === null) {
        const categories = await getTopCategories(opts)
        return ok({ count: categories.length, categories: categories.slice(0, 40) })
      }
      const res = await getTopSongs(p.topId, { limit: p.limit || 20, page: p.page || 1 }, opts)
      return ok(res)
    } catch (e) {
      return fail(`QQ 音乐榜单获取失败：${e?.message || e}`, { recoverable: true })
    }
  },
})

// ─── qqmusic__playlist ───
const playlistTool = defineTool({
  name: 'playlist',
  description:
    '获取 QQ 音乐歌单详情与歌曲列表。id 为歌单数字 id（来自歌单分享链接 …/playlist/数字 或 disstid）。分页用 page/limit。需要单曲播放链接时把歌曲的 songmid 交给 qqmusic__song。',
  category: 'query',
  meta: { summary: 'QQ 音乐歌单', resultCap: 4000 },
  parameters: param.object({
    id: param.str('歌单数字 id（disstid）'),
    limit: param.int('返回歌曲条数 1-100（默认 30）', { min: 1 }),
    page: param.int('页码（默认 1）', { min: 1 }),
  }, ['id']),
  async execute(p, ctx) {
    try {
      const res = await getPlaylist(p.id, { limit: p.limit || 30, page: p.page || 1 }, optsOf(ctx))
      return ok(res)
    } catch (e) {
      return fail(`QQ 音乐歌单获取失败：${e?.message || e}`, { recoverable: true })
    }
  },
})

export default defineToolPack({
  name: 'qqmusic',
  description: 'QQ 音乐检索/详情/歌词/榜单/歌单（逆向接口，只读）',
  author: 'trss-agent-plugin',
  version: '1.0.0',
  factory: () => (cfg().enable === false ? [] : [searchTool, songTool, lyricTool, topTool, playlistTool]),
})
