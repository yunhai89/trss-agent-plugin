/**
 * 离线回归 —— 指令画图插件（apps/comfyui-draw.js，真实类 + 假 ComfyUI HTTP 服务）：
 *   #画图列表 / #画图1 关键字 / 自动选（配图→图生图）/ 需配图报错 / 冷却 / 权限 / 编号越界 /
 *   指令关闭时不处理（返回 false，交给其它插件）。
 * 运行：node --import ./stress/e2e/hooks.mjs apps/comfyui-draw.test.mjs
 */
import http from 'node:http'
import { ComfyDraw } from './comfyui-draw.js'
import { __setConfig, __state } from '../stress/e2e/stubs/Config.js'

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 3).join('\n')) } }

// ── 夹具：节点定义 + 两份前端格式工作流（文生图 / 图生图）──
const OBJECT_INFO = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['m.safetensors'], {}] } } },
  VAELoader: { input: { required: { vae_name: [['v.safetensors'], {}] } } },
  CLIPTextEncode: { input: { required: { clip: ['CLIP', {}], text: ['STRING', {}] } } },
  EmptyLatentImage: { input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } } },
  KSampler: { input: { required: { model: ['MODEL', {}], seed: ['INT', { control_after_generate: true }], steps: ['INT', {}], cfg: ['FLOAT', {}], sampler_name: [['euler'], {}], scheduler: [['normal'], {}], positive: ['CONDITIONING', {}], negative: ['CONDITIONING', {}], latent_image: ['LATENT', {}], denoise: ['FLOAT', {}] } } },
  VAEDecode: { input: { required: { samples: ['LATENT', {}], vae: ['VAE', {}] } } },
  SaveImage: { input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', {}] } } },
  LoadImage: { input: { required: { image: [['in.png'], {}], upload: ['IMAGEUPLOAD', {}] } } },
  ImageScale: { input: { required: { image: ['IMAGE', {}], upscale_method: [['lanczos'], {}], width: ['INT', {}], height: ['INT', {}], crop: [['center'], {}] } } },
  VAEEncode: { input: { required: { pixels: ['IMAGE', {}], vae: ['VAE', {}] } } },
  'WD14Tagger|pysssss': { input: { required: { image: ['IMAGE', {}], model: [['wd-swinv2-tagger-v3'], {}], threshold: ['FLOAT', {}], character_threshold: ['FLOAT', {}], replace_underscore: ['BOOLEAN', {}], trailing_comma: ['BOOLEAN', {}], exclude_tags: ['STRING', {}] } }, output: ['STRING'], output_node: true },
  PreviewAny: { input: { required: { source: ['*', {}] } }, output: ['STRING'], output_node: true },
}
const node = (id, type, widgets, inputs, outputs) => ({ id, type, mode: 0, widgets_values: widgets, inputs: inputs || [], outputs: outputs || [] })
const UI_TXT2IMG = {
  nodes: [
    node(1, 'CheckpointLoaderSimple', ['m.safetensors'], [], [{ name: 'MODEL', type: 'MODEL', links: [1] }, { name: 'CLIP', type: 'CLIP', links: [2] }, { name: 'VAE', type: 'VAE', links: [3] }]),
    node(3, 'CLIPTextEncode', ['a cat'], [{ name: 'clip', type: 'CLIP', link: 2 }], [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [4] }]),
    node(4, 'CLIPTextEncode', ['worst quality'], [{ name: 'clip', type: 'CLIP', link: 2 }], [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [5] }]),
    node(5, 'EmptyLatentImage', [768, 1152, 1], [], [{ name: 'LATENT', type: 'LATENT', links: [6] }]),
    node(6, 'KSampler', [1, 'fixed', 20, 7, 'euler', 'normal', 1], [{ name: 'model', type: 'MODEL', link: 1 }, { name: 'positive', type: 'CONDITIONING', link: 4 }, { name: 'negative', type: 'CONDITIONING', link: 5 }, { name: 'latent_image', type: 'LATENT', link: 6 }], [{ name: 'LATENT', type: 'LATENT', links: [7] }]),
    node(7, 'VAEDecode', [], [{ name: 'samples', type: 'LATENT', link: 7 }, { name: 'vae', type: 'VAE', link: 3 }], [{ name: 'IMAGE', type: 'IMAGE', links: [8] }]),
    node(8, 'SaveImage', ['t/out'], [{ name: 'images', type: 'IMAGE', link: 8 }], []),
  ],
  links: [[1, 1, 0, 6, 0, 'MODEL'], [2, 1, 1, 3, 0, 'CLIP'], [2, 1, 1, 4, 0, 'CLIP'], [3, 1, 2, 7, 1, 'VAE'], [4, 3, 0, 6, 1, 'CONDITIONING'], [5, 4, 0, 6, 2, 'CONDITIONING'], [6, 5, 0, 6, 3, 'LATENT'], [7, 6, 0, 7, 0, 'LATENT'], [8, 7, 0, 8, 0, 'IMAGE']],
}
const UI_IMG2IMG = {
  nodes: [
    node(1, 'CheckpointLoaderSimple', ['m.safetensors'], [], [{ name: 'MODEL', type: 'MODEL', links: [1] }, { name: 'CLIP', type: 'CLIP', links: [2] }, { name: 'VAE', type: 'VAE', links: [3] }]),
    node(2, 'LoadImage', ['in.png', 'image'], [], [{ name: 'IMAGE', type: 'IMAGE', links: [4] }, { name: 'MASK', type: 'MASK', links: [] }]),
    node(3, 'CLIPTextEncode', ['style'], [{ name: 'clip', type: 'CLIP', link: 2 }], [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [5] }]),
    node(4, 'ImageScale', ['lanczos', 512, 768, 'center'], [{ name: 'image', type: 'IMAGE', link: 4 }], [{ name: 'IMAGE', type: 'IMAGE', links: [6] }]),
    node(5, 'VAEEncode', [], [{ name: 'pixels', type: 'IMAGE', link: 6 }, { name: 'vae', type: 'VAE', link: 3 }], [{ name: 'LATENT', type: 'LATENT', links: [7] }]),
    node(6, 'KSampler', [1, 'randomize', 20, 7, 'euler', 'normal', 0.6], [{ name: 'model', type: 'MODEL', link: 1 }, { name: 'positive', type: 'CONDITIONING', link: 5 }, { name: 'negative', type: 'CONDITIONING', link: 5 }, { name: 'latent_image', type: 'LATENT', link: 7 }], [{ name: 'LATENT', type: 'LATENT', links: [8] }]),
    node(7, 'VAEDecode', [], [{ name: 'samples', type: 'LATENT', link: 8 }, { name: 'vae', type: 'VAE', link: 3 }], [{ name: 'IMAGE', type: 'IMAGE', links: [9] }]),
    node(8, 'SaveImage', ['t/i2i'], [{ name: 'images', type: 'IMAGE', link: 9 }], []),
  ],
  links: [[1, 1, 0, 6, 0, 'MODEL'], [2, 1, 1, 3, 0, 'CLIP'], [3, 1, 2, 5, 1, 'VAE'], [4, 2, 0, 4, 0, 'IMAGE'], [5, 3, 0, 6, 1, 'CONDITIONING'], [6, 4, 0, 5, 0, 'IMAGE'], [7, 5, 0, 6, 3, 'LATENT'], [8, 6, 0, 7, 0, 'LATENT'], [9, 7, 0, 8, 0, 'IMAGE']],
}
const TAGGER = {
  1: { class_type: 'LoadImage', inputs: { image: 'example.png' } },
  2: { class_type: 'WD14Tagger|pysssss', inputs: { image: ['1', 0], model: 'wd-swinv2-tagger-v3', threshold: 0.35, character_threshold: 0.85, replace_underscore: true, trailing_comma: false, exclude_tags: '' } },
  3: { class_type: 'PreviewAny', inputs: { source: ['2', 0] } },
}
const MULTISTAGE = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
  3: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: 'multi' } },
  4: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: 'worst quality' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768, batch_size: 1 } },
  6: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 1, steps: 8, cfg: 5, sampler_name: 'euler', scheduler: 'normal', positive: ['3', 0], negative: ['4', 0], latent_image: ['5', 0], denoise: 1 } },
  7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
  8: { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'm/01_base' } },
  9: { class_type: 'ImageScale', inputs: { image: ['7', 0], upscale_method: 'lanczos', width: 768, height: 1152, crop: 'center' } },
  10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'm/02_mid' } },
  11: { class_type: 'ImageScale', inputs: { image: ['9', 0], upscale_method: 'lanczos', width: 1024, height: 1536, crop: 'center' } },
  12: { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: 'm/03_final' } },
}
const FILES = { 'wf/01_txt2img.json': JSON.stringify(UI_TXT2IMG), 'wf/02_img2img.json': JSON.stringify(UI_IMG2IMG), 'wf/03_tagger.json': JSON.stringify(TAGGER), 'wf/04_multistage.json': JSON.stringify(MULTISTAGE) }
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(16)])

let lastSubmit = null
let uploadCount = 0
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const json = (o, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)) }
  if (u.pathname === '/system_stats') return json({ system: { comfyui_version: 'test' }, devices: [], queue_remaining: 0 })
  if (u.pathname === '/object_info') return json(OBJECT_INFO)
  if (u.pathname === '/userdata') return json(Object.keys(FILES).map((p, i) => ({ path: p, size: FILES[p].length, modified: i + 1 })))
  if (u.pathname.startsWith('/userdata/')) {
    const p = decodeURIComponent(u.pathname.slice('/userdata/'.length)).replace(/^workflows\//, '')
    if (FILES[p]) return res.end(FILES[p])
    res.statusCode = 404; return res.end('no')
  }
  if (u.pathname === '/prompt') {
    let b = ''; req.on('data', (c) => { b += c })
    return req.on('end', () => { lastSubmit = JSON.parse(b); json({ prompt_id: 'p1' }) })
  }
  if (u.pathname === '/history/p1') {
    const submitted = lastSubmit?.prompt || {}
    const isTagger = Object.values(submitted).some((n) => n?.class_type === 'WD14Tagger|pysssss')
    if (isTagger) return json({ p1: { status: { completed: true, status_str: 'success' }, outputs: { 2: { tags: ['1girl, solo, silver hair, blue eyes'] }, 3: { text: ['1girl, solo, silver hair, blue eyes'] } } } })
    if (Object.keys(submitted).includes('12')) {
      return json({ p1: { status: { completed: true, status_str: 'success' }, outputs: {
        8: { images: [{ filename: 'base.png', subfolder: 'm', type: 'output' }] },
        10: { images: [{ filename: 'mid.png', subfolder: 'm', type: 'output' }] },
        12: { images: [{ filename: 'final.png', subfolder: 'm', type: 'output' }] },
      } } })
    }
    return json({ p1: { status: { completed: true, status_str: 'success' }, outputs: { 8: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } })
  }
  if (u.pathname === '/view') { res.setHeader('Content-Type', 'image/png'); return res.end(PNG) }
  if (u.pathname === '/upload/image') { uploadCount++; req.resume(); return req.on('end', () => json({ name: 'uploaded.png', subfolder: '', type: 'input' })) }
  if (u.pathname === '/img.png') { res.setHeader('Content-Type', 'image/png'); return res.end(PNG) }
  res.statusCode = 404; res.end('nf')
})
const base = await new Promise((r) => { server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)) })

__setConfig({ agent: { comfyui: { enable: true, host: base, timeout: 20, pollInterval: 0.05, pollMaxInterval: 0.1, workflowDir: 'workflows', command: { cooldown: 0 } } } })
const cfgObj = () => __state.config.agent.comfyui

globalThis.segment = { image: (data) => ({ type: 'image', data }) }

function inst({ msg, isMaster = false, uid = 'u1', message = [] } = {}) {
  const replies = []
  const o = new ComfyDraw()
  o.e = { msg, isMaster, isGroup: true, group_id: 'g1', user_id: uid, message, bot: null, reply: async (m) => { replies.push(m) } }
  o.reply = async (m) => { replies.push(m) }
  o._replies = replies
  return o
}

await test('#画图列表：编号 + 用途 + 需配图标记 + 用法', async () => {
  const o = inst({ msg: '#画图列表' })
  const handled = await o.list()
  ok(handled === true, '返回 true（已处理）')
  const txt = o._replies[0] || ''
  ok(/1\. 01_txt2img\.json/.test(txt) && /2\. 02_img2img\.json/.test(txt), '编号与文件名')
  ok(/文生图/.test(txt) && /图生图/.test(txt), '中文用途标签')
  ok(/需配图/.test(txt), '图生图标注需配图')
  ok(/3\. 03_tagger\.json/.test(txt) && /反推提示词/.test(txt), '反推工作流以「反推提示词」列出')
  ok(/提示词反推：#反推/.test(txt), '清单含反推用法')
  ok(/#画图<编号> <关键字>/.test(txt), '含用法说明')
})

await test('#画图1 关键字：进度提示 → 出图 → seed 回报；提交图参数已注入', async () => {
  const o = inst({ msg: '#画图1 银发少女 樱花' })
  const handled = await o.draw()
  ok(handled === true, '返回 true')
  ok(/开始生成｜1\. 01_txt2img\.json/.test(o._replies[0] || ''), '进度提示含编号与工作流名')
  const imgSeg = o._replies.find((m) => m && m.type === 'image')
  ok(!!imgSeg && String(imgSeg.data).startsWith('base64://'), '图片以 base64 段发出')
  ok(/✅ 完成（seed \d+/.test(o._replies.join('\n')), '完成提示带 seed')
  ok(lastSubmit?.prompt?.['3']?.inputs?.text === '银发少女 樱花', '关键字写入正向提示词节点')
  ok(lastSubmit?.prompt?.['5']?.inputs?.width === 768, '未传参数保留工作流默认尺寸')
})

await test('#画图2（img2img）无配图 → 明确报错并提示附图', async () => {
  const o = inst({ msg: '#画图2 改成夜景', uid: 'u2' })
  await o.draw()
  const txt = o._replies.join('\n')
  ok(/需要输入图/.test(txt) && /引用一张图/.test(txt), `报错含取图指引：${txt.slice(-70)}`)
  ok(!o._replies.some((m) => m && m.type === 'image'), '未发图')
})

await test('带图 + 自动选择（不带编号）→ 图生图；LoadImage 写入上传文件名', async () => {
  const before = uploadCount
  const o = inst({ msg: '#画图 改成夜景', uid: 'u3', message: [{ type: 'image', url: `${base}/img.png`, file: 'in.png' }] })
  await o.draw()
  const txt = o._replies[0] || ''
  ok(/2\. 02_img2img\.json/.test(txt) && /自动选择/.test(txt), '自动选中图生图并标注（自动选择）')
  ok(uploadCount === before + 1, '输入图已上传到 ComfyUI（/upload/image 调用 +1）')
  ok(lastSubmit?.prompt?.['2']?.inputs?.image === 'uploaded.png', 'LoadImage 写入上传后的文件名')
  ok(o._replies.some((m) => m && m.type === 'image'), '出图并回发')
})

await test('#反推：带图 → 返回标签文本（不发图）；无图 → 提示附图', async () => {
  const noImg = inst({ msg: '#反推', uid: 'r0' })
  await noImg.reverse()
  ok(/把要反推的图随消息一起发/.test(noImg._replies.join('\n')), '无图时提示附图')

  const o = inst({ msg: '#反推', uid: 'r1', message: [{ type: 'image', url: `${base}/img.png`, file: 'in.png' }] })
  await o.reverse()
  const txt = o._replies.join('\n')
  ok(/🏷️ 提示词反推/.test(txt), '回复带反推标题')
  ok(/1girl, solo, silver hair, blue eyes/.test(txt), '返回 Danbooru 标签')
  ok((txt.match(/1girl, solo, silver hair, blue eyes/g) || []).length === 1, 'tags/text 同内容已去重（只回一段）')
  ok(!o._replies.some((m) => m && m.type === 'image'), '反推不产图')
  ok(lastSubmit?.prompt?.['2']?.class_type === 'WD14Tagger|pysssss', '执行的是反推节点')
  ok(lastSubmit?.prompt?.['1']?.inputs?.image === 'uploaded.png', '输入图已上传并写入 LoadImage')
})

await test('自动选（画图）排除反推类工作流', async () => {
  const o = inst({ msg: '#画图 夜景', uid: 'r2' })
  await o.draw()
  const txt = o._replies[0] || ''
  ok(/1\. 01_txt2img\.json/.test(txt), `纯文字自动选文生图（非反推）：${txt.split('\n')[0]}`)
})

await test('#画图（多段式）：默认只发最终成品 + 提示可加 --all；--all 全发', async () => {
  const o = inst({ msg: '#画图4 关键字', uid: 'm1' })
  await o.draw()
  const imgs = o._replies.filter((m) => m && m.type === 'image')
  ok(imgs.length === 1, `只发 1 张（最终成品），实际 ${imgs.length}`)
  ok(/另有 2 张中间步骤图未发，加 --all 可一起发/.test(o._replies.join('\n')), '提示可加 --all 补发')
  ok(/seed \d+/.test(o._replies.join('\n')), '完成提示含 seed')

  const o2 = inst({ msg: '#画图4 关键字 --all', uid: 'm2' })
  await o2.draw()
  const imgs2 = o2._replies.filter((m) => m && m.type === 'image')
  ok(imgs2.length === 3, `--all → 3 张全发，实际 ${imgs2.length}`)
  ok(/--all：连中间步骤图一起发/.test(o2._replies[0] || ''), '进度提示标注 --all')
  ok(!/中间步骤图未发/.test(o2._replies.join('\n')), '全发时不再提示补发')
})

await test('冷却：同用户连发第二次被拦（command.cooldown）', async () => {
  cfgObj().command.cooldown = 30
  const o1 = inst({ msg: '#画图1 a', uid: 'u4' })
  await o1.draw()
  const o2 = inst({ msg: '#画图1 b', uid: 'u4' })
  await o2.draw()
  ok(/冷却中/.test(o2._replies.join('\n')), '第二次提示冷却中')
  cfgObj().command.cooldown = 0
})

await test('权限：masterOnly=true 时非主人被拒、主人放行', async () => {
  cfgObj().command.masterOnly = true
  const no = inst({ msg: '#画图1 x', uid: 'u5', isMaster: false })
  await no.draw()
  ok(/仅主人可用/.test(no._replies.join('\n')), '非主人被拒')
  const yes = inst({ msg: '#画图1 x', uid: 'u6', isMaster: true })
  await yes.draw()
  ok(!/仅主人可用/.test(yes._replies.join('\n')), '主人放行')
  cfgObj().command.masterOnly = false
})

await test('边界：编号越界 / 格式错误 / 指令关闭时不处理', async () => {
  const o = inst({ msg: '#画图9 x', uid: 'u7' })
  await o.draw()
  ok(/编号 9 不存在/.test(o._replies.join('\n')), '越界编号报错')

  // 「#画图abc」：abc 是关键字（不是编号），走自动选择并出图
  const o2 = inst({ msg: '#画图abc', uid: 'u8' })
  const handled = await o2.draw()
  ok(handled === true && /自动选择/.test(o2._replies[0] || ''), '「#画图abc」把 abc 当关键字（无编号=自动选）')
  ok(lastSubmit?.prompt?.['3']?.inputs?.text === 'abc', '关键字 abc 已注入')

  cfgObj().command.enable = false
  const o3 = inst({ msg: '#画图列表', uid: 'u9' })
  const r3 = await o3.list()
  ok(r3 === false, '指令关闭 → 返回 false（不拦截消息）')
  cfgObj().command.enable = true

  cfgObj().enable = false
  const o4 = inst({ msg: '#画图1 x', uid: 'u10' })
  const r4 = await o4.draw()
  // 总开关关闭 = 零影响（yaml 承诺）：不回复、不吞消息，返回 false 交回其它插件/LLM
  ok(r4 === false && o4._replies.length === 0, '总开关关闭 → 不回复不拦截（零影响）')
  cfgObj().enable = true
})

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
server.close()
if (failed > 0) process.exitCode = 1
