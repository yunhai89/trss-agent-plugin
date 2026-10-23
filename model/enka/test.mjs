/**
 * Enka 角色展柜离线自检 —— mock fetcher，覆盖归一化/错误/缓存/格式化/工具。
 * 运行：node model/enka/test.mjs
 */
import {
  fetchShowcase, assertUid, clearEnkaCache, EnkaError, formatShowcase,
  normalizeGenshin, normalizeHsr, normalizeZzz,
  enkaGenshinTool, enkaHsrTool, enkaZzzTool,
  GI_CHARACTERS, HSR_CHARACTERS, ZZZ_CHARACTERS,
} from './index.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `  (got ${JSON.stringify(a)})`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

function mockJson(body, { status = 200 } = {}) {
  const calls = []
  const f = async (url, opts) => {
    calls.push({ url, opts })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }
  f.calls = calls
  return f
}

const GI = {
  uid: '618285856',
  ttl: 300,
  playerInfo: { nickname: '旅行者', level: 57, signature: '你好', worldLevel: 8, finishAchievementNum: 600 },
  avatarInfoList: [{
    avatarId: 10000002,
    propMap: { 4001: { val: '90' } },
    talentIdList: [1],
    equipList: [
      { itemId: 11509, weapon: { level: 90, affixMap: { 0: 0 } } },
      { reliquary: {} },
      { reliquary: {} },
    ],
  }],
}

const HSR = {
  uid: '600123456',
  ttl: 120,
  detailInfo: {
    nickname: '开拓者', level: 70, worldLevel: 6, signature: '星穹列车',
    avatarDetailList: [{
      avatarId: 1001, level: 80, rank: 2,
      equipment: { tid: 20000, level: 80, rank: 1 },
      relicList: [{}, {}],
    }],
  },
}

const ZZZ = {
  uid: '100000000',
  ttl: 60,
  PlayerInfo: {
    SocialDetail: { Desc: '新艾利都', ProfileDetail: { Nickname: '绳匠', Level: 60 } },
    ShowcaseDetail: {
      AvatarList: [{
        Id: 1011, Level: 60, TalentLevel: 2,
        Weapon: { Id: 12001, Level: 60, BreakLevel: 1 },
        EquippedList: [{}, {}, {}, {}, {}, {}],
      }],
    },
  },
}

await test('assertUid：9~10 位，拒绝非法值', async () => {
  eq(assertUid('618285856'), '618285856', '9 位')
  eq(assertUid('1000000000'), '1000000000', '10 位')
  let threw = null
  try { assertUid('123') } catch (e) { threw = e }
  ok(threw instanceof EnkaError && threw.code === 'bad_uid', '短 UID → bad_uid')
  let threw2 = null
  try { assertUid('012345678') } catch (e) { threw2 = e }
  ok(threw2 instanceof EnkaError, '0 开头被拒')
})

await test('原神：请求 URL/UA 与归一化', async () => {
  clearEnkaCache()
  const f = mockJson(GI)
  const r = await fetchShowcase('genshin', '618285856', { fetcher: f })
  eq(f.calls.length, 1, '一次请求')
  eq(f.calls[0].url, 'https://enka.network/api/uid/618285856/', '原神端点')
  ok(String(f.calls[0].opts.headers['User-Agent']).includes('trss-agent-plugin'), '带 User-Agent')
  eq(r.player.nickname, '旅行者', '昵称')
  eq(r.player.level, 57, '等级')
  eq(r.player.extra.join(','), '世界等级 8,成就 600', '玩家附加信息')
  eq(r.characters.length, 1, '角色数')
  eq(r.characters[0].name, '神里绫华', '角色名映射')
  eq(r.characters[0].element, '冰', '元素中文化')
  eq(r.characters[0].role, '单手剑', '武器类型中文化')
  eq(r.characters[0].constellation, 1, '命座数')
  eq(r.characters[0].weapon.name, '雾切之回光', '武器名映射')
  eq(r.characters[0].weapon.refine, 1, '精炼 1')
  eq(r.characters[0].relicCount, 2, '圣遗物数量')
})

await test('星铁：detailInfo 归一化', async () => {
  clearEnkaCache()
  const f = mockJson(HSR)
  const r = await fetchShowcase('hsr', '600123456', { fetcher: f })
  eq(f.calls[0].url, 'https://enka.network/api/hsr/uid/600123456/', '星铁端点')
  eq(r.characters[0].name, '三月七', '角色名映射')
  eq(r.characters[0].role, '存护', '命途中文化')
  eq(r.characters[0].constellation, 2, '星魂')
  eq(r.characters[0].weapon.name, '锋镝', '光锥名映射')
  eq(r.characters[0].weapon.refine, 1, '叠影')
  eq(r.characters[0].relicCount, 2, '遗器数量')
})

await test('绝区零：PlayerInfo 归一化', async () => {
  clearEnkaCache()
  const f = mockJson(ZZZ)
  const r = await fetchShowcase('zzz', '100000000', { fetcher: f })
  eq(f.calls[0].url, 'https://enka.network/api/zzz/uid/100000000/', '绝区零端点')
  eq(r.player.nickname, '绳匠', '昵称')
  eq(r.player.level, 60, '绳网等级')
  eq(r.characters[0].name, '安比', '代理人名映射')
  eq(r.characters[0].role, '击破', '职业中文化')
  eq(r.characters[0].constellation, 2, '影画')
  eq(r.characters[0].weapon.name, '「月相」-望', '音擎名映射')
  eq(r.characters[0].weapon.refine, 1, '改造')
  eq(r.characters[0].relicCount, 6, '驱动盘数量')
})

await test('错误：404/429/非法 UID/未知游戏', async () => {
  clearEnkaCache()
  let e404 = null
  try { await fetchShowcase('genshin', '618285856', { fetcher: mockJson({ message: 'Player not found.', code: 'not_found' }, { status: 404 }) }) } catch (e) { e404 = e }
  ok(e404?.code === 'not_found' && /玩家不存在/.test(e404.message) && /Player not found/.test(e404.message), '404 可读且带上游信息')

  let e429 = null
  try { await fetchShowcase('hsr', '600123456', { fetcher: mockJson({}, { status: 429 }) }) } catch (e) { e429 = e }
  ok(e429?.code === 'rate_limited' && /限流/.test(e429.message), '429 限流提示')

  let eUid = null
  try { await fetchShowcase('zzz', 'abc') } catch (e) { eUid = e }
  ok(eUid?.code === 'bad_uid', '非法 UID 不请求')

  let eGame = null
  try { await fetchShowcase('gi', '618285856') } catch (e) { eGame = e }
  ok(eGame?.code === 'bad_game', '未知游戏')
})

await test('超时与网络异常', async () => {
  clearEnkaCache()
  let eTimeout = null
  const timeoutFetch = async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e }
  try { await fetchShowcase('genshin', '618285856', { fetcher: timeoutFetch }) } catch (e) { eTimeout = e }
  ok(eTimeout?.code === 'timeout' && /超时/.test(eTimeout.message), 'TimeoutError → timeout')

  let eNet = null
  const netFetch = async () => { throw new Error('socket hang up') }
  try { await fetchShowcase('genshin', '618285856', { fetcher: netFetch }) } catch (e) { eNet = e }
  ok(eNet?.code === 'network' && /socket hang up/.test(eNet.message), '网络异常→network')
})

await test('缓存：ttl 内命中、ttl=0 不缓存', async () => {
  clearEnkaCache()
  const f = mockJson(GI)
  const a = await fetchShowcase('genshin', '618285856', { fetcher: f })
  const b = await fetchShowcase('genshin', '618285856', { fetcher: f })
  eq(f.calls.length, 1, 'ttl 内只请求一次')
  ok(a.cached !== true && b.cached === true, '第二次标记命中缓存')

  clearEnkaCache()
  const f0 = mockJson({ ...GI, ttl: 0 })
  await fetchShowcase('genshin', '618285856', { fetcher: f0 })
  await fetchShowcase('genshin', '618285856', { fetcher: f0 })
  eq(f0.calls.length, 2, 'ttl=0 不缓存')
})

await test('formatShowcase：中文摘要与截断', async () => {
  const r = normalizeGenshin(GI, '618285856')
  const text = formatShowcase(r)
  ok(text.includes('原神 · UID 618285856'), '标题')
  ok(text.includes('神里绫华') && text.includes('Lv.90'), '角色与等级')
  ok(text.includes('命座1'), '命座')
  ok(text.includes('武器「雾切之回光」Lv.90 精1'), '武器精炼')
  ok(text.includes('圣遗物 2'), '圣遗物数量')
  ok(text.includes('数据来自 Enka.Network'), '数据来源')

  const hsrText = formatShowcase(normalizeHsr(HSR, '600123456'))
  ok(hsrText.includes('光锥「锋镝」Lv.80 叠影1') && hsrText.includes('星魂2'), '星铁术语')
  const zzzText = formatShowcase(normalizeZzz(ZZZ, '100000000'))
  ok(zzzText.includes('音擎「月相」-望') && zzzText.includes('影画2') && zzzText.includes('A级'), '绝区零术语与 A 级稀有度')

  const many = normalizeGenshin({ ...GI, avatarInfoList: Array.from({ length: 25 }, () => GI.avatarInfoList[0]) }, '618285856')
  const cut = formatShowcase(many)
  ok(cut.includes('另有 5 名角色未列出'), '超过 20 名截断')
  ok(!cut.includes('公开角色展柜为空'), '非空不显示空提示')
})

await test('工具：execute 返回 markdown / 失败降级为文案', async () => {
  clearEnkaCache()
  const f = mockJson(GI)
  const text = await enkaGenshinTool.execute({ uid: '618285856' }, { fetcher: f })
  ok(text.includes('神里绫华') && text.includes('展示角色'), '工具输出')
  eq(enkaGenshinTool.category, 'query', 'category=query')
  eq(enkaHsrTool.name, 'enka_hsr', '工具名')
  eq(enkaZzzTool.parameters.required[0], 'uid', '参数 uid 必填')

  const bad = await enkaGenshinTool.execute({ uid: 'abc' }, { fetcher: f })
  ok(bad.startsWith('查询失败：') && bad.includes('UID'), '非法 UID 返回可读文案')
})

await test('内置数据：三游戏角色表可用', async () => {
  ok(Object.keys(GI_CHARACTERS).length >= 150, `原神角色 ${Object.keys(GI_CHARACTERS).length}`)
  ok(Object.keys(HSR_CHARACTERS).length >= 90, `星铁角色 ${Object.keys(HSR_CHARACTERS).length}`)
  eq(HSR_CHARACTERS['8001']?.n, '开拓者', '开拓者占位名已替换')
  ok(Object.keys(ZZZ_CHARACTERS).length >= 60, `绝区零角色 ${Object.keys(ZZZ_CHARACTERS).length}`)
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed) process.exitCode = 1
