/**
 * 米游社离线自检 —— mock fetcher，覆盖 DS 签名/解析/格式化/工具。
 * 运行：node model/miyoushe/test.mjs
 */
import {
  generateDS, buildHeaders, htmlToText, extractImagesFromHtml, parsePostFromItem,
  getGameGid, getGameList, searchPosts, getPostDetail, getPostReplies,
  formatSearchResults, formatPostDetail, formatReplies,
  miyousheSearchTool, miyoushePostTool, miyousheRepliesTool,
} from './index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

// ---------- 1. DS 签名 ----------
await test('generateDS：格式 t,r,md5hex', async () => {
  const ds = generateDS()
  const parts = ds.split(',')
  eq(parts.length, 3, '3 段')
  ok(/^\d+$/.test(parts[0]), '第1段时间戳数字')
  ok(parts[1].length === 6, '第2段 6 位随机串')
  ok(/^[0-9a-f]{32}$/.test(parts[2]), '第3段 32 位 md5')
})

// ---------- 2. 请求头 ----------
await test('buildHeaders：含 DS / device_id / app_version', async () => {
  const h = buildHeaders('stoken=abc')
  ok(h.DS && h.DS.includes(','), '含 DS')
  ok(h['x-rpc-device_id'] && h['x-rpc-device_id'].length === 32, 'device_id 32位无横线')
  eq(h['x-rpc-app_version'], '2.104.0', 'app_version')
  ok(h.Cookie.includes('stoken=abc'), 'cookie 透传')
  const h2 = buildHeaders()
  ok(!('Cookie' in h2), '无 cookie 时不带 Cookie 头')
})

// ---------- 3. HTML 解析 ----------
await test('htmlToText / extractImagesFromHtml', async () => {
  const html = '<p>你好</p><br/><img src="http://x/1.png"/><div>世界</div><img src="http://x/2.png">'
  eq(htmlToText(html), '你好\n\n世界', 'HTML→文本')
  eq(extractImagesFromHtml(html), ['http://x/1.png', 'http://x/2.png'], '抽取图片')
  eq(extractImagesFromHtml('<img src="a.png"/><img src="a.png"/>'), ['a.png'], '图片去重')
})

// ---------- 4. 帖子解析（post_status vs stat） ----------
await test('parsePostFromItem：详情(post_status) / 搜索(stat)', async () => {
  const detail = parsePostFromItem({ post: { post_id: 'p1', subject: '标题', content: '<p>正文</p>', post_status: { like_num: 10, reply_num: 2, is_official: 1 } }, user: { nickname: 'A', level_exp: { level: 5 } }, image_list: [] }, 2)
  eq(detail.postId, 'p1', 'postId')
  eq(detail.stats.like, 10, 'post_status 点赞')
  eq(detail.flags.isOfficial, true, '官方标记')
  eq(detail.plainText, '正文', '正文纯文本')
  eq(detail.link, 'https://www.miyoushe.com/ys/article/p1', '原神链接路径')

  const search = parsePostFromItem({ post: { post_id: 'p2', subject: 'S', content: '', stat: { like_num: 3, view_num: 100 } } }, 6)
  eq(search.stats.like, 3, 'stat 点赞')
  eq(search.stats.view, 100, 'stat 浏览')
  eq(search.link.includes('/sr/'), true, '星穹铁道路径')
})

// ---------- 5. 游戏名 → gid ----------
await test('getGameGid：模糊匹配', async () => {
  eq(getGameGid('原神'), 2, '原神')
  eq(getGameGid('崩坏星穹铁道'), 6, '全称')
  eq(getGameGid('星穹铁道'), 6, '简称')
  eq(getGameGid('绝区零'), 8, '绝区零')
  eq(getGameGid('未知游戏'), 2, '未知→默认原神')
  ok(getGameList().includes('原神(gid=2)'), '游戏列表')
})

// ---------- 6. mock fetcher ----------
function mockFetch(response) {
  const calls = []
  const f = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: true, status: 200, json: async () => response }
  }
  f.calls = calls
  return f
}

await test('searchPosts：mock API', async () => {
  const f = mockFetch({ retcode: 0, message: '', data: { posts: [
    { post: { post_id: 'p1', subject: '攻略', content: '<p>内容</p>', stat: { like_num: 5 } }, user: { nickname: 'U' } },
  ] } })
  const r = await searchPosts('纳西妲', { gid: 2, fetcher: f })
  eq(r.posts.length, 1, '1 条结果')
  eq(r.posts[0].title, '攻略', '标题')
  ok(f.calls[0].url.includes('keyword='), 'URL 含 keyword')
  ok(f.calls[0].opts.headers.DS, '请求带 DS 头')
})

await test('getPostDetail / getPostReplies：mock', async () => {
  // getPostFull 的 data.data.post 是"item 包装"（含 .post/.user），parsePostFromItem 读 item.post
  const fd = mockFetch({ retcode: 0, data: { post: { post: { post_id: 'p9', subject: 'D', content: '<p>x</p>' }, user: { nickname: 'U' } } } })
  const d = await getPostDetail('p9', { fetcher: fd })
  eq(d.postId, 'p9', '详情 postId')

  const fr = mockFetch({ retcode: 0, data: { list: [{ reply: { reply_id: 'r1', content: '<p>好</p>', like_num: 2 }, user: { nickname: 'V' } }] } })
  const rs = await getPostReplies('p9', { fetcher: fr })
  eq(rs.length, 1, '1 条评论')
  eq(rs[0].content, '好', '评论纯文本')

  // 评论失败要抛错，不能吞成空数组（否则工具层与用户都会把故障当成「暂无评论」）
  const fErr = async () => ({ ok: true, json: async () => ({ retcode: 1001, message: 'err' }) })
  let threw = null
  try { await getPostReplies('p9', { fetcher: fErr }) } catch (e) { threw = e }
  ok(threw && /1001/.test(threw.message), '失败→抛错且带上游 retcode')

  // 网络层异常同样要抛
  const fNet = async () => { throw new Error('socket hang up') }
  let threw2 = null
  try { await getPostReplies('p9', { fetcher: fNet }) } catch (e) { threw2 = e }
  ok(threw2 && /socket hang up/.test(threw2.message), '网络异常→抛错')
})

// ---------- 7. 格式化 ----------
await test('format 函数', async () => {
  ok(formatSearchResults({ keyword: 'x', posts: [] }).includes('没有找到'), '空结果')
  const det = { title: 'T', plainText: '正文', images: ['http://x/1.png'], flags: { isOriginal: true }, stats: { like: 1, reply: 0, collect: 0, view: 0, share: 0 }, author: { nickname: 'A', uid: '1', level: 1 }, forum: { name: 'F' }, topics: [], createdAt: 0, link: 'L' }
  ok(formatPostDetail(det).includes('![](http://x/1.png)'), '详情含图片 markdown')
  ok(formatPostDetail(det).includes('[原创]'), '详情含原创徽章')
  ok(formatReplies([]) === '暂无评论。', '空评论')
})

// ---------- 8. 工具 execute ----------
await test('miyoushe_search 工具：mock ctx.fetcher', async () => {
  const f = mockFetch({ retcode: 0, data: { posts: [{ post: { post_id: 'p1', subject: '结果', stat: {} }, user: {} }] } })
  const out = await miyousheSearchTool.execute({ keyword: '甘雨', game: '原神' }, { fetcher: f, miyoushe: { cookie: '', defaultGid: 2 } })
  ok(out.includes('结果'), '工具返回格式化文本')
})

await test('miyoushe_post 工具：mock', async () => {
  const f = mockFetch({ retcode: 0, data: { post: { post: { post_id: 'p1', subject: '详情', content: '<p>正文</p>', stat: {} }, user: {} } } })
  const out = await miyoushePostTool.execute({ postId: 'p1' }, { fetcher: f })
  ok(out.includes('详情') && out.includes('正文'), '工具返回详情')
})

await test('miyoushe_replies 工具：mock', async () => {
  const f = mockFetch({ retcode: 0, data: { list: [{ reply: { content: '赞', like_num: 9 }, user: { nickname: 'N' } }] } })
  const out = await miyousheRepliesTool.execute({ postId: 'p1' }, { fetcher: f })
  ok(out.includes('赞'), '工具返回评论')

  // 拉取失败：工具不抛错，而是回可读的「评论获取失败：<原因>」
  const fErr = async () => ({ ok: true, json: async () => ({ retcode: -100, message: '登录已过期' }) })
  const out2 = await miyousheRepliesTool.execute({ postId: 'p1' }, { fetcher: fErr })
  ok(out2.startsWith('评论获取失败：') && out2.includes('-100'), `失败→可读文案：${out2}`)
  ok(!out2.includes('暂无评论'), '失败不再伪装成「暂无评论」')
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
