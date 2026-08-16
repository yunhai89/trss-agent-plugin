/**
 * sticker 自动发现离线自检 —— hash / judgeAndTag 解析 / pickByEmotion / index 辅助。
 * 运行：node model/sticker/discover.test.mjs
 */
import { hashImage, normalizeTags, judgeAndTag, pickByEmotion, JUDGE_TAG_PROMPT } from './discover.js'
import { findByHash, addDiscoveredEntry, evictDiscoveredToCap, buildCatalog } from './index.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }

// ─── hashImage ───
await test('hashImage：确定性 + 差分', async () => {
  const a = Buffer.from('xxx')
  ok(hashImage(a) === hashImage(a), '同 buffer 同 hash')
  ok(hashImage(Buffer.from('xxx')) === hashImage(Buffer.from('xxx')), '等值 buffer 同 hash')
  ok(hashImage(Buffer.from('yyy')) !== hashImage(Buffer.from('xxx')), '不同 buffer 不同 hash')
  ok(hashImage(null) === '', '空 buffer 返回空串')
})

// ─── normalizeTags ───
await test('normalizeTags：多分隔符/去重/限长', async () => {
  ok(normalizeTags('开心,大笑，摸鱼、happy; yes').length === 5, '多种分隔符切分')
  ok(normalizeTags(['A', 'a', 'B']).length === 2, '大小写去重（A/a）')
  ok(normalizeTags(['', '  ', 'x']).length === 1, '去空')
  ok(normalizeTags(['开心']).includes('开心'), '保留中文')
  const many = normalizeTags(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])
  ok(many.length === 8, '上限 8 个')
})

// ─── judgeAndTag：JSON 解析 ───
await test('judgeAndTag：干净 JSON 解析', async () => {
  const vision = { analyze: async () => '{"isSticker": true, "name": "笑容", "desc": "开心大笑", "tags": ["开心","大笑","赞同"]}' }
  const r = await judgeAndTag(vision, { buffer: Buffer.from('x'), mime: 'image/png' })
  ok(r.isSticker === true && r.name === '笑容' && r.desc === '开心大笑' && r.tags.length === 3, '干净 JSON 正确解析')
})

await test('judgeAndTag：代码块包裹 / 前后多余文字', async () => {
  const vision = { analyze: async () => '好的，分析结果：\n```json\n{"isSticker":true,"name":"无奈","tags":["无奈","叹气"]}\n```\n完成' }
  const r = await judgeAndTag(vision, { buffer: Buffer.from('x'), mime: 'image/png' })
  ok(r.isSticker === true && r.name === '无奈' && r.tags.includes('无奈'), '代码块包裹也能解析')
})

await test('judgeAndTag：isSticker=false（拒绝照片）', async () => {
  const vision = { analyze: async () => '{"isSticker": false, "name": "", "desc": "", "tags": []}' }
  const r = await judgeAndTag(vision, { buffer: Buffer.from('x'), mime: 'image/jpeg' })
  ok(r.isSticker === false, '照片判定为 false')
})

await test('judgeAndTag：非 JSON 含否定词 → 拒绝', async () => {
  const vision = { analyze: async () => '这不是表情包，是普通照片' }
  const r = await judgeAndTag(vision, { buffer: Buffer.from('x'), mime: 'image/jpeg' })
  ok(r.isSticker === false && r.parseFailed === true, '否定词+不可解析 → 拒绝')
})

await test('judgeAndTag：无 vision → 放行 + noVision + 自动命名', async () => {
  const buf = Buffer.from('abcdef')
  const r = await judgeAndTag(null, { buffer: buf, mime: 'image/png' })
  ok(r.isSticker === true && r.noVision === true, '无 vision 放行')
  ok(r.name.startsWith('表情_') && r.name.includes(hashImage(buf).slice(0, 6)), '自动命名 表情_<hash6>')
})

// ─── pickByEmotion ───
await test('pickByEmotion：标签匹配 + seeded 随机确定', async () => {
  const entries = [
    ['开心_aaa', { tags: ['开心', '大笑'], desc: '', usageCount: 5 }],
    ['无奈_bbb', { tags: ['无奈', '叹气'], desc: '', usageCount: 2 }],
    ['摸鱼_ccc', { tags: ['摸鱼', '困'], desc: '', usageCount: 1 }],
  ]
  // emotion=开心 → 应选 开心_aaa（相似度最高）
  const r1 = pickByEmotion(entries, '开心', { rand: () => 0 })
  ok(r1 === '开心_aaa', 'emotion=开心 命中 开心_aaa')
  const r2 = pickByEmotion(entries, '无奈', { rand: () => 0 })
  ok(r2 === '无奈_bbb', 'emotion=无奈 命中 无奈_bbb')
  // 相同 seed 确定性
  ok(pickByEmotion(entries, '开心', { rand: () => 0.5 }) === pickByEmotion(entries, '开心', { rand: () => 0.5 }), '同 seed 确定')
  // 空库 → null
  ok(pickByEmotion([], '开心') === null, '空库返回 null')
})

await test('pickByEmotion：无 emotion → 低 usage 加权随机', async () => {
  const entries = [
    ['高频', { tags: ['x'], usageCount: 99 }],
    ['冷门1', { tags: ['x'], usageCount: 0 }],
    ['冷门2', { tags: ['x'], usageCount: 1 }],
  ]
  const pick = pickByEmotion(entries, '', { rand: () => 0 })
  ok(pick === '冷门1', '无 emotion 时 rand=0 取最低 usage')
})

// ─── index 辅助 ───
await test('index：addDiscoveredEntry + findByHash 去重', async () => {
  let index = { version: 5, stickers: {} }
  const r1 = addDiscoveredEntry(index, { name: '笑脸', file: 'discovered/aaa.png', desc: '开心', tags: ['开心'], hash: 'aaa' })
  ok(r1.dup === false && r1.index.stickers['笑脸'], '新增成功')
  ok(findByHash(r1.index, 'aaa')?.file === 'discovered/aaa.png', 'findByHash 命中')
  const r2 = addDiscoveredEntry(r1.index, { name: '重复', file: 'discovered/aaa2.png', hash: 'aaa' })
  ok(r2.dup === true && !r2.index.stickers['重复'], '同 hash 去重')
})

await test('index：evictDiscoveredToCap 按低 usage 淘汰', async () => {
  const stickers = {
    a: { source: 'discovered', usageCount: 5, file: 'discovered/a.png' },
    b: { source: 'discovered', usageCount: 1, file: 'discovered/b.png' },
    c: { source: 'discovered', usageCount: 3, file: 'discovered/c.png' },
    repo: { source: 'root', usageCount: 0, file: 'root/r.png' }, // repo 条目不动
  }
  const index = { version: 5, stickers }
  const ev = evictDiscoveredToCap(index, 2) // 3 个 discovered → 淘汰 1 个最低 usage(b)
  ok(Object.keys(ev.index.stickers).filter((k) => ev.index.stickers[k].source === 'discovered').length === 2, '裁到 2 个 discovered')
  ok(!ev.index.stickers['b'], '淘汰最低 usage 的 b')
  ok(ev.index.stickers['repo'], 'repo 条目保留')
  ok(ev.removedFiles.length === 1, '返回 1 个待删文件')
})

await test('index：buildCatalog 含新发现加权 + send_sticker 提示', async () => {
  const stickers = {}
  for (let i = 0; i < 40; i++) stickers[`旧${i}`] = { tags: ['x'], desc: '', usageCount: 100 - i, source: 'root', addedAt: 1 }
  stickers['新发现1'] = { tags: ['开心'], desc: '新', usageCount: 0, source: 'discovered', addedAt: Date.now() }
  stickers['新发现2'] = { tags: ['无奈'], desc: '新', usageCount: 0, source: 'discovered', addedAt: Date.now() - 1 }
  const cat = buildCatalog({ version: 5, stickers }, { listTopN: 10 })
  ok(cat.includes('新发现1'), '新发现（usage=0）被加权进目录')
  ok(cat.includes('send_sticker'), '目录提示 send_sticker 工具')
  ok(cat.includes('共 42 个'), '注明总数')
})

// ─── 缓存确定性：catalog 注入 system 前缀区，输出必须逐字节稳定 ───
await test('buildCatalog：同 index 两次输出完全一致（去随机，展示按名称排序）', async () => {
  const idx = { stickers: {} }
  for (let i = 0; i < 8; i++) idx.stickers['贴纸' + i] = { tags: ['t' + i], desc: 'd' + i, usageCount: 8 - i, source: i < 2 ? 'discovered' : 'repo', addedAt: i }
  idx.stickers['高频贴'] = { tags: ['x'], desc: 'y', usageCount: 99 }
  const a = buildCatalog(idx, { listTopN: 6 })
  const b = buildCatalog(idx, { listTopN: 6 })
  ok(a === b && a.length > 0, `两次输出逐字节一致（曾 Fisher-Yates 洗牌——每轮 system 从表情段起全部 cache miss）`)
  const names = a.split('\n').slice(3).map((l) => (l.match(/- ✨?(.+?):/) || [])[1]).filter((x) => x && !x.includes('sticker'))
  const sorted = [...names].sort((x, y) => x.localeCompare(y))
  ok(JSON.stringify(names) === JSON.stringify(sorted), `展示按名称字典序（防「最高使用恒排第一」的注意力偏置由发送侧承担）`)
})

// ─── 总结 ───
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
