/**
 * QQ 音乐工具离线自检 —— sign 向量 / util 归一 / api 解析（mock fetch，不联网）。
 * 运行：node tools/qqmusic/qqmusic.test.mjs
 */
import { zzcSign, hash33 } from './sign.js'
import {
  QUALITY_MAP, normalizeQuality, buildFilename, qualityFromFilename, normalizeCookie,
  parseUinFromCookie, parseAuthstFromCookie, clampInt, isValidSongmid,
  pickPlayDomain, joinPlayUrl, isQqHost, stripTags, fmtDuration, normalizeSong, coverUrl, songJumpUrl, DEFAULT_COVER,
} from './util.js'
import {
  search, getSongDetail, getSongUrl, getLyric, getTopCategories, getTopSongs, getPlaylist,
  signedCgi, parseMaybeJsonp,
} from './api.js'
import { musicSegment } from '../../model/toolkit/media.js'

let passed = 0
let failed = 0
function okf(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); okf(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

// ── mock fetch ──
const DETAIL = {
  code: 0,
  req_0: { code: 0, data: { track_info: { id: 97773, mid: '0039MnYb0qxYhV', name: '晴天', interval: 269, album: { name: '叶惠美', mid: '000MkMni19ClKG' }, singer: [{ name: '周杰伦' }], file: { media_mid: '003Qui1q2u1Zho' } } } },
}
const TOPCAT = { code: 0, req_0: { data: { group: [{ groupName: '巅峰榜', toplist: [{ topId: 62, title: '飙升榜', listenNum: 18633712, totalNum: 100, period: '2026-10-07', intro: '榜单' }] }] } } }

function makeFetch(routes) {
  return async (url, opts = {}) => {
    const u = String(url)
    for (const [key, fn] of routes) {
      if (!u.includes(key)) continue
      const body = fn(u, opts)
      return { ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
    }
    throw new Error('unmocked ' + u)
  }
}
const routes = [
  ['musics.fcg', (_u, opts) => {
    const req = JSON.parse(opts.body).req_0
    if (req.module === 'music.pf_song_detail_svr') return DETAIL
    if (req.module === 'music.musicToplist.Toplist') return TOPCAT
    if (req.module === 'music.vkey.GetEVkey') {
      return { code: 0, req_0: { code: 0, data: {
        sip: ['http://aqqmusic.tc.qq.com/', 'http://ws.stream.qqmusic.qq.com/'],
        midurlinfo: [{ filename: 'M800003Qui1q2u1Zho.mp3', purl: 'C400003Qui1q2u1Zho.m4a?vkey=ABC&guid=1' }],
      } } }
    }
    return { code: 0, req_0: { code: 0, data: {} } }
  }],
  ['client_search_cp', () => ({
    code: 0,
    data: { song: { totalnum: 2, list: [
      { songmid: '0039MnYb0qxYhV', songid: 97773, songname: '晴天', singer: [{ name: '周杰伦' }], albumname: '叶惠美', albummid: '000MkMni19ClKG', interval: 269 },
      { songmid: '001Qu4I30MG6u4', songid: 100, songname: '七里香', singer: [{ name: '周杰伦' }], albumname: '七里香', albummid: '003DFRzD192KKD', interval: 299 },
    ] } },
  })],
  ['musicu.fcg', () => ({
    code: 0,
    req_0: { data: { sip: ['http://aqqmusic.tc.qq.com/', 'http://ws.stream.qqmusic.qq.com/'], midurlinfo: [{ songmid: '0039MnYb0qxYhV', purl: 'C400003Qui1q2u1Zho.m4a?vkey=ABC&guid=1' }] } },
  })],
  ['fcg_query_lyric_new', () => ({ retcode: 0, code: 0, subcode: 0, lyric: '[00:00.00]晴天\n[00:02.00]词：周杰伦' })],
  ['fcg_v8_toplist_cp', () => ({
    total_song_num: 2,
    topinfo: { ListName: '飙升榜' },
    songlist: [
      { data: { songmid: '002qUdaX4ba2ez', songid: 726476108, songname: '自由的你', singer: [{ name: 'G.E.M.邓紫棋' }], albumname: '自由的你', interval: 296 } },
      { data: { songmid: '003ZuQ5z05yCAP', songid: 1, songname: '大梦归', singer: [{ name: '周深' }], albumname: '大梦归', interval: 250 } },
    ],
  })],
  ['fcg_ucc_getcdinfo_byids_cp', () => ({
    cdlist: [{ dissname: '永暗的新发风向', logo: 'http://y.qq.com/cover.jpg', desc: '歌单简介', songlist: [
      { mid: '002i8wkn3SOyIg', name: 'Koglumni dap', singer: [{ name: 'GulzarMusic' }], interval: 170 },
      { mid: '0039MnYb0qxYhV', name: '晴天', singer: [{ name: '周杰伦' }], interval: 269 },
    ] }],
  })],
]
const fetchMock = makeFetch(routes)
const opts = () => ({ fetcher: fetchMock, cookie: '', timeoutMs: 3000 })

// ── sign ──
await test('zzcSign：官方逆向测试向量', () => {
  eq(zzcSign('123'), 'zzcec1b555gzqzg7laztguyjl2bu20r6x1w50c55f60', "sign('123')")
  eq(zzcSign('hello world'), 'zzcfb3415bc4nfoxmd9uik71mkomtubjfjp141a1cbbcc', "sign('hello world')")
  eq(zzcSign('jixun.uk'), 'zzcf47b78apso27mjjbbzgbof0szikfkvyqc7fc3a2b5', "sign('jixun.uk')")
  okf(zzcSign('x').startsWith('zzc'), '前缀 zzc')
})
await test('hash33：与 Python 参考一致（BigInt 无需 32 位截断）', () => {
  eq(hash33('xixixixixixixixix', 5381), 778811173, 'hash33(key,5381)')
  eq(hash33('', 5381), 5381, '空串返回种子')
})

// ── util ──
await test('util：音质 / 文件名 / cookie / 域名白名单', () => {
  eq(normalizeQuality('FLAC'), 'flac', '大小写归一')
  eq(normalizeQuality('bad'), '320', '非法回退')
  eq(buildFilename('320', '0039MnYb0qxYhV'), 'M8000039MnYb0qxYhV.mp3', '无 mediaMid：前缀+songmid+扩展')
  eq(buildFilename('320', '0039MnYb0qxYhV', '003Qui1q2u1Zho'), 'M800003Qui1q2u1Zho.mp3', '有 mediaMid：用 mediaMid')
  eq(qualityFromFilename('F000xxx.flac'), 'flac', '由 filename 反推音质')
  eq(qualityFromFilename('xxx.mp3'), '', '未知前缀返回空')
  okf(QUALITY_MAP.m4a.prefix === 'C400', 'm4a 前缀')
  eq(normalizeCookie({ a: '1', b: '2' }), 'a=1; b=2', '对象 cookie')
  eq(parseUinFromCookie('foo=1; uin=o12345678; qqmusic_key=K'), '12345678', 'uin 去 o 前缀')
  eq(parseAuthstFromCookie('xxx; qqmusic_key=KEY; yyy'), 'KEY', 'authst')
  eq(clampInt('99', 1, 30, 10), 30, '上限裁剪')
  eq(clampInt('abc', 1, 30, 10), 10, '非法回退')
  okf(isValidSongmid('0039MnYb0qxYhV'), '合法 mid')
  okf(!isValidSongmid('bad mid'), '非法 mid')
  eq(pickPlayDomain(['http://ws.stream.qqmusic.qq.com/', 'https://isure.stream.qqmusic.qq.com/']), 'https://isure.stream.qqmusic.qq.com/', '优先 https')
  eq(joinPlayUrl('http://aqqmusic.tc.qq.com/', 'a.mp3'), 'http://aqqmusic.tc.qq.com/a.mp3', '拼接')
  eq(joinPlayUrl('http://evil.com/', 'a.mp3'), '', '非 qq 域拒绝（SSRF）')
  okf(isQqHost('http://aqqmusic.tc.qq.com/x'), 'qq 子域')
  okf(!isQqHost('http://evil.com'), '非 qq 域')
  eq(stripTags('<em>晴天</em>'), '晴天', '去高亮标签')
  eq(fmtDuration(269), '4:29', '时长格式化')
})

await test('util：normalizeSong 兼容多来源结构', () => {
  const a = normalizeSong({ songmid: 'm1', songname: 'n', singer: [{ name: 's' }], albumname: 'al', albummid: 'am', interval: 60 })
  eq([a.songmid, a.name, a.singers, a.album, a.duration], ['m1', 'n', ['s'], 'al', '1:00'], '搜索结构')
  const b = normalizeSong({ mid: 'm2', name: 'n2', singer: [{ name: 's2' }], interval: 0 })
  eq([b.songmid, b.name, b.singers], ['m2', 'n2', ['s2']], '歌单 new_format 结构')
  const c = normalizeSong({ data: { songmid: 'm3', songname: 'n3', singer: [{ name: 's3' }], interval: 30 } })
  eq([c.songmid, c.name, c.duration], ['m3', 'n3', '0:30'], '榜单 data 包裹结构')
  eq(normalizeSong(null), null, '空值')
})

// ── 分享卡片 / 封面 / 跳转 ──
await test('musicSegment：原生 QQ 卡片与自定义卡片', () => {
  eq(musicSegment({ type: 'qq', id: '0039MnYb0qxYhV' }), { type: 'music', data: { type: 'qq', id: '0039MnYb0qxYhV' } }, '原生卡片')
  eq(musicSegment({}), { type: 'music', data: { type: 'qq', id: '' } }, '缺省 qq')
  const c = musicSegment({ type: 'custom', url: 'https://y.qq.com/x', audio: 'http://a/x.mp3', title: 'T', image: 'http://img/x.jpg', content: 'S' })
  eq(c.type, 'music', '段类型')
  eq(c.data, { type: 'custom', url: 'https://y.qq.com/x', image: 'http://img/x.jpg', audio: 'http://a/x.mp3', title: 'T', content: 'S' }, '自定义卡片字段')
})
await test('coverUrl / songJumpUrl', () => {
  eq(coverUrl('000MkMni19ClKG'), 'https://y.gtimg.cn/music/photo_new/T002R300x300M000000MkMni19ClKG.jpg', '封面 URL')
  eq(coverUrl(''), '', '无 albummid 返回空')
  okf(/^https:\/\//.test(DEFAULT_COVER), '兜底封面为 https')
  eq(songJumpUrl('0039MnYb0qxYhV'), 'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV', '跳转 URL')
})

// ── api ──
await test('search：解析歌曲列表', async () => {
  const r = await search('周杰伦', { limit: 2 }, opts())
  eq(r.type, 'song', '类型')
  eq(r.count ?? r.items.length, 2, '2 条')
  eq(r.items[0].songmid, '0039MnYb0qxYhV', '首条 mid')
  eq(r.items[0].singers, ['周杰伦'], '歌手')
  okf(r.total >= 2, 'total')
})
await test('search：空关键词拒绝', async () => {
  let threw = false
  try { await search('  ', {}, opts()) } catch { threw = true }
  okf(threw, '空关键词抛错')
})

await test('getSongDetail：现代签名网关解析 track_info', async () => {
  const s = await getSongDetail({ songmid: '0039MnYb0qxYhV' }, opts())
  eq([s.songmid, s.name, s.album, s.mediaMid], ['0039MnYb0qxYhV', '晴天', '叶惠美', '003Qui1q2u1Zho'], '详情字段')
})
await test('getSongDetail：无效 mid 返回空 track_info 时抛错（不发空卡片）', async () => {
  const empty = makeFetch([
    ['musics.fcg', () => ({ code: 0, req_0: { code: 0, data: { track_info: {} } } })],
    ['musicu.fcg', () => ({ songinfo: { data: { track_info: {} } } })],
  ])
  let threw = false
  try { await getSongDetail({ songmid: '003gZ6qL3TzDyH' }, { fetcher: empty }) } catch { threw = true }
  okf(threw, '空 track_info → 抛错而非返回空歌曲')
})

await test('getSongUrl：签名网关域名拼接 + purl 为空标记 needLogin', async () => {
  const r = await getSongUrl('0039MnYb0qxYhV', { quality: '320' }, opts())
  eq(r.url, 'http://aqqmusic.tc.qq.com/C400003Qui1q2u1Zho.m4a?vkey=ABC&guid=1', '播放链接')
  eq(r.needLogin, false, '有 purl 不需登录')
  eq(r.quality, '320', '匹配到的音质')
  const anon = makeFetch([['musics.fcg', () => ({ req_0: { data: { sip: ['http://aqqmusic.tc.qq.com/'], midurlinfo: [{ filename: 'M500003Qui1q2u1Zho.mp3', purl: '', result: 104003 }] } } })]])
  const r2 = await getSongUrl('0039MnYb0qxYhV', {}, { fetcher: anon })
  eq(r2.url, '', '无 purl')
  eq(r2.needLogin, true, '标记需要登录')
  eq(r2.restriction, 'login_required', '归类 login_required')
})
await test('getSongUrl：非会员高档 → vip_required', async () => {
  const vipFetch = makeFetch([['musics.fcg', () => ({ req_0: { data: { sip: ['http://aqqmusic.tc.qq.com/'], midurlinfo: [{ filename: 'M800003Qui1q2u1Zho.mp3', purl: '', result: 22, pneedbuy: 1 }] } } })]])
  const r = await getSongUrl('0039MnYb0qxYhV', { quality: '320' }, { fetcher: vipFetch, cookie: 'uin=1; qqmusic_key=K', uin: '1', authst: 'K' })
  eq(r.url, '', '无 purl')
  eq(r.restriction, 'vip_required', '归类 vip_required')
})
await test('getSongUrl：非 QQ 域被拒（SSRF 防护）', async () => {
  const evil = makeFetch([['musicu.fcg', () => ({ req_0: { data: { sip: ['http://evil.com/'], midurlinfo: [{ purl: 'a.mp3' }] } } })]])
  const r = await getSongUrl('0039MnYb0qxYhV', {}, { fetcher: evil })
  eq(r.url, '', '恶意 sip 被丢弃')
})

await test('getLyric：明文 + base64 自动解码', async () => {
  const r = await getLyric({ songmid: '0039MnYb0qxYhV' }, opts())
  okf(r.lyric.includes('晴天'), '明文歌词')
  const b64 = Buffer.from('[00:00.00]hi').toString('base64')
  const m = makeFetch([['fcg_query_lyric_new', () => ({ retcode: 0, lyric: b64 })]])
  const r2 = await getLyric({ songmid: 'x' }, { fetcher: m })
  eq(r2.lyric, '[00:00.00]hi', 'base64 解码')
})

await test('getTopCategories：签名榜单目录', async () => {
  const list = await getTopCategories(opts())
  eq(list[0].topId, 62, 'topId')
  eq(list[0].title, '飙升榜', '标题')
  eq(list[0].group, '巅峰榜', '分组')
})
await test('getTopSongs：榜单歌曲含 songmid', async () => {
  const r = await getTopSongs(62, { limit: 2 }, opts())
  eq(r.topId, 62, 'topId')
  eq(r.songs.length, 2, '2 首')
  eq(r.songs[0].songmid, '002qUdaX4ba2ez', 'songmid')
  eq(r.topinfo.name, '飙升榜', '榜单名')
})
await test('getPlaylist：歌单解析 + 分页', async () => {
  const r = await getPlaylist('7515109044', { limit: 1, page: 1 }, opts())
  eq(r.name, '永暗的新发风向', '歌单名')
  eq(r.total, 2, '总数')
  eq(r.songs.length, 1, '分页 1 条')
  eq(r.songs[0].songmid, '002i8wkn3SOyIg', 'mid 归一')
})

await test('signedCgi：请求体签名可复核 + JSONP 解析', async () => {
  let captured = null
  const capFetch = async (url, o) => {
    captured = { url: String(url), body: o.body }
    return { ok: true, status: 200, text: async () => 'cb({"req_0":{"code":0}})' }
  }
  const j = await signedCgi({ module: 'x', method: 'y', param: {} }, { fetcher: capFetch, timeoutMs: 3000 })
  eq(j.req_0.code, 0, 'JSONP 解析')
  okf(captured.url.includes(`sign=${zzcSign(captured.body)}`), 'sign 与请求体一致')
  okf(captured.url.startsWith('https://u6.y.qq.com/cgi-bin/musics.fcg'), '仅现代网关')
})
await test('parseMaybeJsonp：JSON 与 JSONP', () => {
  eq(parseMaybeJsonp('{"a":1}').a, 1, 'JSON')
  eq(parseMaybeJsonp('cb({"a":2});').a, 2, 'JSONP')
  okf((() => { try { parseMaybeJsonp(''); return false } catch { return true } })(), '空响应抛错')
})

await test('超时：AbortError 转为可读超时错误', async () => {
  const slowFetch = (_url, { signal }) => new Promise((_res, rej) => {
    signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e) })
  })
  let msg = ''
  try { await signedCgi({ module: 'x', method: 'y', param: {} }, { fetcher: slowFetch, timeoutMs: 30 }) } catch (e) { msg = e.message }
  okf(/超时/.test(msg), `超时错误可读（${msg}）`)
})

await test('工具包：resolve 产出 qqmusic__ 前缀工具', async () => {
  const mod = await import('./index.js')
  const pack = mod.default
  const tools = pack.resolve({})
  eq(tools.length, 5, '5 个工具')
  okf(tools.every((t) => t.name.startsWith('qqmusic__')), '全部带命名空间前缀')
  eq(tools.map((t) => t.name).sort(), ['qqmusic__lyric', 'qqmusic__playlist', 'qqmusic__search', 'qqmusic__song', 'qqmusic__top'], '工具集合')
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
