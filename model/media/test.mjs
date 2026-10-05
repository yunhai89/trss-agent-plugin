/**
 * 媒体库离线自检 —— mock bot + mock e，覆盖 collect/resolve/convert/degrade/被动工具。
 * 运行：node model/media/test.mjs
 */
import {
  inferMime,
  sniffMagic,
  extractFromMessage,
  extractForwardResid,
  dedupMedia,
  toOpenaiBlocks,
  toAnthropicBlocks,
  toGeminiBlocks,
  buildUserContent,
  createMediaService,
  resolveMedia,
  listGroupFilesTool,
  getGroupFileTool,
  readAttachmentTool,
} from './index.js'

let passed = 0
let failed = 0
function ok(c, m) {
  if (c) { passed++; console.log('  ✓', m) }
  else { failed++; console.error('  ✗ FAIL', m) }
}
function eq(a, b, m) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, `${m}${same ? '' : `  (got ${JSON.stringify(a)})`}`)
}
async function test(name, fn) {
  console.log(`\n[${name}]`)
  try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) }
}

// 一个最小 PNG 头（魔数 89 50 4e 47）—— 命中 sniffMagic image/png
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')])

// ---------- 1. 魔数嗅探 ----------
await test('sniffMagic：PNG/JPG/PDF', async () => {
  eq(sniffMagic(PNG), 'image/png', 'PNG 魔数')
  eq(sniffMagic(JPG), 'image/jpeg', 'JPG 魔数')
  eq(sniffMagic(PDF), 'application/pdf', 'PDF 魔数')
  eq(sniffMagic(Buffer.from('hello world')), null, '无魔数 → null')
})

// ---------- 1b. 魔数嗅探：视频/容器格式 ----------
const ftyp = (brand) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from(brand)])
await test('sniffMagic：视频容器格式', async () => {
  eq(sniffMagic(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....webm....')])), 'video/webm', 'webm')
  eq(sniffMagic(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....matroska....')])), 'video/x-matroska', 'mkv')
  eq(sniffMagic(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')])), 'video/x-msvideo', 'avi')
  eq(sniffMagic(Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x00])), 'video/x-flv', 'flv')
  eq(sniffMagic(Buffer.from([0x00, 0x00, 0x01, 0xba, 0x00])), 'video/mpeg', 'mpeg-ps')
  eq(sniffMagic(ftyp('isom')), 'video/mp4', 'mp4 isom')
  eq(sniffMagic(ftyp('qt  ')), 'video/quicktime', 'mov qt')
  eq(sniffMagic(ftyp('3gp4')), 'video/3gpp', '3gp')
  eq(sniffMagic(ftyp('M4A ')), 'audio/mp4', 'm4a')
  eq(sniffMagic(ftyp('avif')), 'image/avif', 'avif')
  eq(sniffMagic(ftyp('heic')), 'image/heic', 'heic')
})

// ---------- 2. inferMime：魔数优先，名称扩展兜底 ----------
await test('inferMime：魔数优先 + 名称扩展兜底', async () => {
  eq(inferMime('a.csv', Buffer.from('x,y\n1,2')).mime, 'text/csv', '无魔数 → csv 按名称')
  eq(inferMime('pic.png', PNG).mime, 'image/png', 'png 魔数')
  eq(inferMime('doc', PNG).mime, 'image/png', '无扩展 → 魔数 png')
  eq(inferMime('report.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04])).mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx = zip 家族按名称细化')
  eq(inferMime('notes.txt', Buffer.from('纯文本内容')).mime, 'text/plain', '无魔数 → txt 按名称')
  eq(inferMime('未知', Buffer.from('一些utf8文本没有nul')).mime, 'text/plain', '无魔数无扩展 → 文本嗅探')
  // 名称与实际字节冲突：必须以字节为准（否则 Anthropic 报 media type mismatch）
  eq(inferMime('a.jpg', PNG).mime, 'image/png', 'jpg 名 + PNG 字节 → 以字节为准')
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
  eq(inferMime('a.png', WEBP).mime, 'image/webp', 'png 名 + webp 字节 → 以字节为准')
  // 视频容器：扩展名与魔数
  eq(inferMime('v.mkv', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])).mime, 'video/x-matroska', 'mkv')
  eq(inferMime('v.mp4', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A ')])).mime, 'audio/mp4', 'm4a 字节优先于 mp4 名')
})

// ---------- 3. 段抽取 ----------
await test('extractFromMessage：image/file/record', async () => {
  const out = extractFromMessage({ message: [
    { type: 'text', text: '看这张图' },
    { type: 'image', url: 'http://x/a.png', name: 'a.png' },
    { type: 'file', name: 'report.pdf', fid: 'f1', size: 1024 },
    { type: 'record', url: 'http://x/v.amr' },
    { type: 'at', qq: '123' },
  ] }, 'message')
  eq(out.length, 3, '3 个媒体段（image+file+record）')
  eq(out[0].kind, 'image', 'image kind')
  eq(out[0].source, 'message', 'source=message')
  eq(out[1].kind, 'file', 'file kind')
  eq(out[1].fid, 'f1', 'file fid 透传')
  eq(out[2].kind, 'audio', 'record→audio')
})

// ---------- 4. forward resid ----------
await test('extractForwardResid：xml/json m_resid', async () => {
  eq(extractForwardResid({ type: 'forward', id: 'abc123' }), 'abc123', 'forward.id')
  eq(extractForwardResid({ type: 'xml', data: '<resid m_resid="xx/yy+9=">' }), 'xx/yy+9=', 'xml m_resid')
  eq(extractForwardResid({ type: 'json', data: { m_resid: 'z9' } }), 'z9', 'json m_resid（字符串化）')
  eq(extractForwardResid({ type: 'text', text: 'x' }), null, '无关段 → null')
})

// ---------- 5. dedup ----------
await test('dedupMedia：按 url 去重', async () => {
  const a = { id: '1', url: 'http://x/a.png', name: 'a.png' }
  const b = { id: '2', url: 'http://x/a.png', name: 'dup.png' }
  const c = { id: '3', url: null, name: 'b.txt' }
  eq(dedupMedia([a, b, c]).length, 2, '同 url 去重，保留首项')
})

// ---------- 6. convert：视觉模型原生块 ----------
await test('toOpenaiBlocks / toAnthropicBlocks：视觉模型', async () => {
  const media = [
    { name: 'a.png', mime: 'image/png', buffer: PNG, bytes: PNG.length, kind: 'image' },
    { name: 'note.txt', mime: 'text/plain', buffer: Buffer.from('hello'), bytes: 5, kind: 'file' },
  ]
  const oai = toOpenaiBlocks(media, { caps: { vision: true } })
  eq(oai[0].type, 'image_url', 'openai image_url')
  ok(oai[0].image_url.url.startsWith('data:image/png;base64,'), 'openai data url')
  eq(oai[1].type, 'text', 'openai 文本文件→text 块')
  ok(oai[1].text.includes('hello'), 'openai 文本内容')

  const ant = toAnthropicBlocks(media, { caps: { vision: true } })
  eq(ant[0].type, 'image', 'anthropic image')
  eq(ant[0].source.type, 'base64', 'anthropic base64 source')
  eq(ant[0].source.media_type, 'image/png', 'anthropic media_type')

  // audio：仅显式 caps.audio 才下发 input_audio，否则降级 text（vision≠audio）
  const wav = [{ name: 'r.wav', mime: 'audio/wav', buffer: Buffer.from('wavdata'), bytes: 7, kind: 'audio' }]
  eq(toOpenaiBlocks(wav, { caps: { vision: true } })[0].type, 'text', 'openai 未声明 audio → text')
  eq(toOpenaiBlocks(wav, { caps: { vision: true, audio: true } })[0].type, 'input_audio', 'openai 声明 audio → input_audio')
})

// ---------- 6b. 声明的 image media_type 必须与字节一致（Anthropic 强校验）----------
await test('convert：预置 mime 与字节不符时，image 块按魔数纠正', async () => {
  // 名称/mime 谎报 jpeg，实际字节是 PNG
  const mislabeled = [{ name: 'a.jpg', mime: 'image/jpeg', buffer: PNG, bytes: PNG.length, kind: 'image' }]
  const ant = toAnthropicBlocks(mislabeled, { caps: { vision: true } })
  eq(ant[0].source.media_type, 'image/png', 'anthropic 按字节纠正 media_type')
  const oai = toOpenaiBlocks(mislabeled, { caps: { vision: true } })
  ok(oai[0].image_url.url.startsWith('data:image/png;base64,'), 'openai data url 按字节纠正')
  const gem = toGeminiBlocks(mislabeled, { caps: { vision: true } })
  eq(gem[0].mime_type, 'image/png', 'gemini 按字节纠正 mime_type')
})

await test('convert：AVIF/HEIC 等非通用图片格式降级文本（不发原生 image 块）', async () => {
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypavif')])
  const m = [{ name: 'a.avif', mime: 'image/avif', buffer: avif, bytes: avif.length, kind: 'image' }]
  eq(toOpenaiBlocks(m, { caps: { vision: true } })[0].type, 'text', 'openai 降级 text')
  eq(toAnthropicBlocks(m, { caps: { vision: true } })[0].type, 'text', 'anthropic 降级 text')
  eq(toGeminiBlocks(m, { caps: { vision: true } })[0].type, 'text', 'gemini 降级 text')
  ok(toOpenaiBlocks(m, { caps: { vision: true } })[0].text.includes('不受支持'), '说明含格式原因')
})

// ---------- 7. convert：非视觉降级 ----------
await test('buildUserContent：非视觉降级为字符串', async () => {
  const media = [{ name: 'a.png', mime: 'image/png', buffer: PNG, bytes: PNG.length, kind: 'image' }]
  const s = buildUserContent('这是什么', media, { protocol: 'openai', caps: { vision: false }, degrade: 'note' })
  ok(typeof s === 'string', '非视觉 → 字符串')
  ok(s.includes('这是什么') && s.includes('不支持视觉'), '含降级说明')

  const skipped = buildUserContent('x', media, { caps: { vision: false }, degrade: 'skip' })
  ok(skipped === 'x', 'degrade=skip 丢弃图片仅留文本')
})

// ---------- 8. buildUserContent：无媒体返回字符串 ----------
await test('buildUserContent：无媒体 → 原样字符串', async () => {
  eq(buildUserContent('你好', [], { caps: { vision: true } }), '你好', '空媒体')
  const arr = buildUserContent('看图', [{ name: 'a.png', mime: 'image/png', buffer: PNG, bytes: 10, kind: 'image' }], { protocol: 'openai', caps: { vision: true } })
  ok(Array.isArray(arr), '视觉+图片 → 数组')
  eq(arr[0].type, 'text', '首块为文本')
  eq(arr[1].type, 'image_url', '次块为图片')
})

// ---------- 9. createMediaService 主动收集（mock bot + e） ----------
await test('createMediaService.collectActive：消息图片 → 解析 → 原生块', async () => {
  const bot = {
    download: async (url) => ({ url, file: '/tmp/x', buffer: PNG }),
  }
  const e = { message: [{ type: 'image', url: 'http://x/a.png', name: 'a.png' }], atBot: true }
  const svc = createMediaService({ bot, e, caps: { vision: true }, protocol: 'openai' })
  const files = await svc.collectActive()
  eq(files.length, 1, '收集 1 个')
  eq(files[0].mime, 'image/png', '解析出 mime')
  ok(files[0].buffer?.length > 0, '已下载 buffer')
  const content = svc.buildContent('这是什么图')
  ok(Array.isArray(content) && content[1].type === 'image_url', 'buildContent 产出 image_url 块')
})

// ---------- 10. 群文件：getFileUrl 兜底 ----------
await test('collect：群文件 e.file 无 url → getFileUrl 补全', async () => {
  let asked = null
  const e = {
    message: [{ type: 'text', text: '看群文件' }],
    file: { type: 'file', name: 'doc.pdf', fid: 'f9', busid: 102, size: 2048 },
    group: { getFileUrl: async (fid) => (asked = fid, `http://g/${fid}`) },
  }
  const bot = { download: async (url) => ({ url, buffer: PDF }) }
  const svc = createMediaService({ bot, e, caps: { vision: true, file: true }, protocol: 'anthropic' })
  const files = await svc.collectActive()
  eq(files.length, 1, '收集到群文件')
  eq(asked, 'f9', '调用 getFileUrl(fid)')
  eq(files[0].mime, 'application/pdf', '解析为 pdf')
})

// ---------- 11. 被动工具：list_group_files ----------
await test('被动工具 list_group_files', async () => {
  const ctx = { e: { group: { fs: { ls: async () => ({ files: [{ file_name: 'a.txt', file_id: 'f1', size: 10 }] }) } } } }
  const r = await listGroupFilesTool.execute({}, ctx)
  eq(r.count, 1, '1 个文件')
  eq(r.files[0].name, 'a.txt', '名称归一')

  const r2 = await listGroupFilesTool.execute({}, { e: {} })
  ok(r2.error, '无 fs → 报错')
})

// ---------- 12. 被动工具：get_group_file 文本类 ----------
await test('被动工具 get_group_file：文本类返回内容', async () => {
  const ctx = {
    e: { group_id: 'g1', group: { fs: {
      ls: async () => ({ files: [{ file_name: 'note.txt', file_id: 'f1', busid: 1, size: 5 }] }),
      download: async () => ({ url: 'http://g/note.txt' }),
    } } },
    bot: { download: async () => ({ buffer: Buffer.from('hello world') }) },
  }
  const r = await getGroupFileTool.execute({ name: 'note.txt' }, ctx)
  eq(r.name, 'note.txt', '按名称命中')
  ok(r.content?.includes('hello'), '返回文本内容')
  ok(!r.note, '文本类无 note')
})

// ---------- 12b. 大文本分页（不再静默截断）----------
await test('被动工具 get_group_file：大文本分页读取 + nextOffset 续读', async () => {
  const big = 'A'.repeat(7000) + 'B'.repeat(7000) // 14000 字符，超过单页 6000
  const ctx = {
    e: { group_id: 'g1', group: { fs: {
      ls: async () => ({ files: [{ file_name: 'big.txt', file_id: 'f1', size: big.length }] }),
      download: async () => ({ url: 'http://g/big.txt' }),
    } } },
    bot: { download: async () => ({ buffer: Buffer.from(big) }) },
  }
  const p1 = await getGroupFileTool.execute({ name: 'big.txt' }, ctx)
  eq(p1.total, 14000, 'total=全文长度')
  eq(p1.offset, 0, '首页 offset=0')
  eq(p1.content.length, 6000, '首页 6000 字符')
  eq(p1.nextOffset, 6000, '首页 nextOffset=6000')
  ok(!!p1.note, '大文件带续读指引')
  const p2 = await getGroupFileTool.execute({ name: 'big.txt', offset: p1.nextOffset }, ctx)
  eq(p2.offset, 6000, '第二页 offset=上一页 nextOffset')
  eq(p2.content.length, 6000, '第二页 6000 字符')
  const p3 = await getGroupFileTool.execute({ name: 'big.txt', offset: p2.nextOffset }, ctx)
  eq(p3.content.length, 2000, '末页剩余 2000 字符')
  eq(p3.nextOffset, undefined, '读完无 nextOffset')
  ok(p3.content.endsWith('B'), '末页覆盖到文件结尾（全文可分页读全）')
})

// ---------- 13. 被动工具：read_attachment ----------
await test('被动工具 read_attachment：读本次会话附件', async () => {
  const ctx = { media: [{ name: 'a.txt', mime: 'text/plain', buffer: Buffer.from('xyz'), bytes: 3, kind: 'file' }] }
  const r = await readAttachmentTool.execute({ index: 1 }, ctx)
  eq(r.name, 'a.txt', '按序号命中')
  ok(r.content?.includes('xyz'), '返回内容')

  const r2 = await readAttachmentTool.execute({}, { media: [] })
  ok(r2.error, '无附件 → 报错')
})

await test('被动工具 read_attachment：大文本分页（limit 封顶 + nextOffset）', async () => {
  const big = 'x'.repeat(13000)
  const ctx = { media: [{ name: 'big.txt', mime: 'text/plain', buffer: Buffer.from(big), bytes: big.length, kind: 'file' }] }
  const p1 = await readAttachmentTool.execute({ index: 1, limit: 99999 }, ctx)
  eq(p1.content.length, 12000, 'limit 被夹到上限 12000')
  eq(p1.nextOffset, 12000, 'nextOffset=12000')
  const p2 = await readAttachmentTool.execute({ index: 1, offset: p1.nextOffset }, ctx)
  eq(p2.content.length, 1000, '第二页剩余 1000 字符')
  eq(p2.nextOffset, undefined, '读完无 nextOffset')
})

// ---------- 14. applyLimits：超图片上限 ----------
await test('applyLimits：超过 maxImages 标记降级', async () => {
  const bot = { download: async (url) => ({ buffer: PNG }) }
  const e = { message: [
    { type: 'image', url: 'http://x/1.png', name: '1.png' },
    { type: 'image', url: 'http://x/2.png', name: '2.png' },
  ] }
  const svc = createMediaService({ bot, e, caps: { vision: true }, protocol: 'openai', config: { maxImages: 1 } })
  const files = await svc.collectActive()
  eq(files.length, 2, '都保留（标记）')
  ok(files[1].resolveError === 'limit_images', '第 2 张被标记 limit_images')
})

// ---------- Gemini 多模态块（toGeminiBlocks）----------
await test('toGeminiBlocks：image/audio/pdf + 非视觉降级', async () => {
  const blocks = toGeminiBlocks([
    { kind: 'image', mime: 'image/png', buffer: PNG, name: 'a.png', bytes: 10 },
    { kind: 'audio', mime: 'audio/wav', buffer: Buffer.from('wavdata'), name: 'r.wav', bytes: 7 },
    { kind: 'file', mime: 'application/pdf', buffer: PDF, name: 'd.pdf', bytes: 8 },
  ], { caps: { vision: true, audio: true, file: true } })
  eq(blocks[0].type, 'image', 'image → image 块')
  ok(!!blocks[0].data && blocks[0].mime_type === 'image/png', 'image: data(base64) + mime_type')
  eq(blocks[1].type, 'audio', 'audio → audio 块')
  ok(!!blocks[1].data && blocks[1].mime_type === 'audio/wav', 'audio: data + mime_type')
  eq(blocks[2].type, 'document', 'pdf → document 块')
  // 非视觉降级
  const d = toGeminiBlocks([{ kind: 'image', mime: 'image/png', buffer: PNG, name: 'a.png', bytes: 10 }], { caps: { vision: false }, degrade: 'note' })
  eq(d[0].type, 'text', '非视觉 image 降级为 text 块')
  // 未声明 audio：即使有 vision 也不下发原生 audio 块（防端点 unknown variant input_audio）
  const noAudio = toGeminiBlocks([{ kind: 'audio', mime: 'audio/wav', buffer: Buffer.from('wavdata'), name: 'r.wav', bytes: 7 }], { caps: { vision: true }, degrade: 'note' })
  eq(noAudio[0].type, 'text', '未声明 audio → 降级 text')
})

// ---------- NapCat 兜底取字节：视频走 get_file（不是 get_image）----------
await test('resolveMedia：url 缺失时视频经 get_file 取字节（非 get_image）', async () => {
  const calls = []
  const e = {
    bot: {
      async sendApi(action, params) {
        calls.push([action, params])
        if (action === 'get_file') return { file: 'http://cdn/v.mp4' }
        return {}
      },
    },
  }
  const fetcher = async () => ({ ok: true, arrayBuffer: async () => Uint8Array.from(MP4).buffer })
  const mf = await resolveMedia(
    { id: 'v1', source: 'message', kind: 'video', name: 'v.mp4', url: null, fid: null, segment: { file: 'video_code' } },
    { e, fetcher, log: () => {} },
  )
  ok(calls.some(([a]) => a === 'get_file'), '视频调用 get_file')
  ok(!calls.some(([a]) => a === 'get_image'), '视频不调用 get_image')
  eq(mf.mime, 'video/mp4', '字节为 mp4 → mime 正确')
  eq(mf.resolveError, undefined, '成功解析')
})

await test('resolveMedia：图片仍走 get_image', async () => {
  const calls = []
  const e = { bot: { async sendApi(action) { calls.push(action); return action === 'get_image' ? { file: 'http://cdn/a.png' } : {} } } }
  const fetcher = async () => ({ ok: true, arrayBuffer: async () => Uint8Array.from(PNG).buffer })
  await resolveMedia({ id: 'i1', source: 'message', kind: 'image', name: 'a.png', url: null, fid: null, segment: { file: 'img_code' } }, { e, fetcher, log: () => {} })
  ok(calls.includes('get_image'), '图片调用 get_image')
})

// ---------- 总结 ----------
console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
