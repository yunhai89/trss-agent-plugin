/**
 * 哔哩哔哩工具离线自检 —— Wbi 签名向量 / id 解析 / 归一化 / 工具包注册。
 * 运行：node tools/bilibili/bilibili.test.mjs
 */
import { genMixinKey, encWbi, keyFromWbiUrl, encodeWbiValue } from './sign.js'
import {
  parseVideoId, parseMid, fmtDuration, fmtCount, stripTags, httpsUrl, buildCookie,
  normalizeVideo, normalizeSearchItem, QUALITY_MAP,
  buildBiliCardJson, resolveQuality, pickClosestQuality, qualityLabel,
} from './util.js'
import { transcribeAudio } from './api.js'
import { pickVideoTrack, ffmpegAvailable } from './download.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let passed = 0
let failed = 0
function okf(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); okf(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

await test('Wbi 签名：官方文档测试向量', () => {
  const img = '7cd084941338484aae1ad9425b84077c'
  const sub = '4932caff0ff746eab6f01bf08b70ac45'
  eq(genMixinKey(img, sub), 'ea1db124af3c7062474693fa704f4ff8', 'mixin_key')
  eq(encWbi({ foo: '114', bar: '514', zab: 1919810 }, img, sub, 1702204169).w_rid, '8f6f2b5b3d485fe1886cec6a0be8c5d4', 'w_rid')
  eq(keyFromWbiUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'), img, 'nav url → key')
  eq(encodeWbiValue('one one four'), 'one%20one%20four', '空格 → %20')
  eq(encodeWbiValue('!*'), '%21%2A', "!'()* 百分号编码")
})

await test('parseVideoId：bvid / av / URL / 短链', () => {
  eq(parseVideoId('BV1GJ411x7h7'), { bvid: 'BV1GJ411x7h7' }, 'bvid')
  eq(parseVideoId('av80433022'), { aid: 80433022 }, 'av')
  eq(parseVideoId('https://www.bilibili.com/video/BV1GJ411x7h7/?p=1'), { bvid: 'BV1GJ411x7h7' }, 'URL')
  eq(parseVideoId('https://b23.tv/abcXYZ'), { short: 'https://b23.tv/abcXYZ' }, '短链')
  eq(parseVideoId('乱码'), null, '无法识别')
})
await test('parseMid', () => {
  eq(parseMid('486906719'), '486906719', '数字')
  eq(parseMid('https://space.bilibili.com/486906719/video'), '486906719', '空间链接')
  eq(parseMid('abc'), '', '非法')
})

await test('格式化', () => {
  eq(fmtDuration(59), '0:59', '秒')
  eq(fmtDuration(269), '4:29', '分')
  eq(fmtDuration(3725), '1:02:05', '时')
  eq(fmtCount(999), '999', '小数字')
  eq(fmtCount(12345), '1.2万', '万')
  eq(fmtCount(123456789), '1.2亿', '亿')
  eq(stripTags('<em class="keyword">洛天依</em>'), '洛天依', '去标签')
  eq(httpsUrl('http://i1.hdslb.com/x.jpg'), 'https://i1.hdslb.com/x.jpg', 'http→https')
  eq(httpsUrl('//i1.hdslb.com/x.jpg'), 'https://i1.hdslb.com/x.jpg', '协议相对')
  eq(buildCookie({ a: '1', b: '', c: '3' }), 'a=1; c=3', 'cookie 拼接跳过空值')
  okf(QUALITY_MAP[80] === '1080P', '清晰度映射')
})

await test('normalizeVideo', () => {
  const v = normalizeVideo({
    bvid: 'BV1GJ411x7h7', aid: 80433022, cid: 137649199, title: '<em>标题</em>', desc: 'd',
    pic: 'http://i1.hdslb.com/x.jpg', duration: 213, pubdate: 1577835803, tname: '音乐',
    owner: { mid: 486906719, name: 'UP', face: 'http://i1.hdslb.com/f.jpg' },
    stat: { view: 106920448, like: 100, danmaku: 2, reply: 3, coin: 4, favorite: 5, share: 6 },
    pages: [{ cid: 137649199, page: 1, part: 'P1', duration: 213 }],
  })
  eq(v.title, '标题', '去标签')
  eq(v.cover, 'https://i1.hdslb.com/x.jpg', '封面 https')
  eq(v.durationText, '3:33', '时长')
  eq(v.owner.mid, 486906719, 'UP mid')
  eq(v.pages.length, 1, '分P')
  eq(normalizeVideo(null), null, '空值')
})

await test('normalizeSearchItem', () => {
  const it = normalizeSearchItem({ bvid: 'BV1x', aid: 1, title: '<em>t</em>', author: 'a', mid: 2, duration: '4:29', play: 12345, video_review: 9, pubdate: 1, description: 'd', pic: '//i.x/p.jpg' })
  eq(it.title, 't', '标题')
  eq(it.duration, '4:29', '时长')
  eq(it.playText, '1.2万', '播放量')
  eq(it.cover, 'https://i.x/p.jpg', '封面')
})

await test('transcribeAudio：Whisper 兼容 STT 请求与解析', async () => {
  const tmp = path.join(os.tmpdir(), `bili_stt_${Date.now()}.m4a`)
  fs.writeFileSync(tmp, Buffer.from('fake-audio-bytes'))
  let captured = null
  const fetchImpl = async (url, opts) => {
    captured = { url, method: opts.method, auth: opts.headers?.Authorization, isForm: typeof FormData !== 'undefined' && opts.body instanceof FormData }
    return { ok: true, status: 200, async json() { return { text: '  转写文本  ' } } }
  }
  try {
    const text = await transcribeAudio(tmp, { apiKey: 'k', apiBase: 'https://stt.example/v1/audio/transcriptions', model: 'whisper-1' }, { fetchImpl })
    okf(text.includes('转写文本'), '解析 STT 文本')
    okf(captured.url === 'https://stt.example/v1/audio/transcriptions', 'apiBase 作为完整端点')
    okf(captured.method === 'POST' && captured.auth === 'Bearer k', 'POST + Bearer')
    okf(captured.isForm, 'multipart FormData')
  } finally { try { fs.unlinkSync(tmp) } catch { /* noop */ } }
  // 未配置 apiKey 抛错
  let threw = false
  try { await transcribeAudio(tmp, {}) } catch { threw = true }
  okf(threw, '缺 apiKey 抛错')
})

await test('工具包：resolve 产出 bilibili__ 前缀工具', async () => {
  const mod = await import('./index.js')
  const tools = mod.default.resolve({})
  eq(tools.length, 10, '10 个工具')
  okf(tools.every((t) => t.name.startsWith('bilibili__')), '全部带命名空间前缀')
  eq(tools.map((t) => t.name).sort(), [
    'bilibili__analyze', 'bilibili__comments', 'bilibili__danmaku', 'bilibili__download',
    'bilibili__popular', 'bilibili__ranking', 'bilibili__search', 'bilibili__subtitle',
    'bilibili__user', 'bilibili__video',
  ], '工具集合')
})

await test('B站分享卡片 JSON：结构对齐官方小程序样例', () => {
  const card = buildBiliCardJson({ title: '标题', desc: '简介内容', cover: 'https://i0.hdslb.com/x.jpg', url: 'https://www.bilibili.com/video/BV1x', uin: '123', nick: 'B' })
  eq(card.app, 'com.tencent.miniapp_01', 'app')
  eq(card.view, 'view_8C8E89B49BE609866298ADDFF2DBABA4', 'view')
  eq(card.meta.detail_1.appid, '1109937557', 'appid')
  eq(card.meta.detail_1.shareTemplateId, '8C8E89B49BE609866298ADDFF2DBABA4', 'shareTemplateId')
  eq(card.meta.detail_1.qqdocurl, 'https://www.bilibili.com/video/BV1x', 'qqdocurl 跳转')
  eq(card.meta.detail_1.preview, 'https://i0.hdslb.com/x.jpg', 'preview 封面')
  eq(card.meta.detail_1.host.uin, '123', 'host.uin')
  okf(String(card.meta.detail_1.desc).includes('简介'), 'desc 透传')
  okf(card.config && card.config.ctime > 0, 'config.ctime 生成')
})

await test('清晰度：配置值→qn + 就近回退（会员档不可得时）', () => {
  eq(resolveQuality('1080'), 80, "'1080'→80")
  eq(resolveQuality('1080p+'), 112, "'1080p+'→112")
  eq(resolveQuality('4k'), 120, "'4k'→120")
  eq(resolveQuality(''), 0, '空→0')
  eq(qualityLabel(80), '1080P', 'label 1080P')
  eq(pickClosestQuality([16, 32, 64, 80], 112), 80, '请求 112 只有 ≤80 → 回退 80')
  eq(pickClosestQuality([16, 32, 64, 80], 64), 64, '精确命中')
  eq(pickClosestQuality([16, 32], 0), 32, '未请求取最高')
  eq(pickClosestQuality([80], 64), 80, '无更低档取最低可用')
  eq(pickClosestQuality([], 80), 0, '空列表 0')
})

await test('dash 选轨：分辨率优先 + 编码偏好', () => {
  const tracks = [
    { id: 80, codecs: 'avc1.640032', baseUrl: 'a', bandwidth: 1 },
    { id: 80, codecs: 'hev1.1.6', baseUrl: 'b', bandwidth: 2 },
    { id: 64, codecs: 'avc1', baseUrl: 'c', bandwidth: 3 },
  ]
  eq(pickVideoTrack(tracks, 80).codecs, 'avc1.640032', 'auto 同档优先 H.264')
  eq(pickVideoTrack(tracks, 80, 'hevc').codecs, 'hev1.1.6', 'hevc 偏好')
  eq(pickVideoTrack(tracks, 112).id, 80, '会员档不可得回退 80')
  eq(pickVideoTrack([], 80), null, '空轨 null')
  okf(typeof ffmpegAvailable() === 'boolean', 'ffmpegAvailable 返回布尔')
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
