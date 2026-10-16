/**
 * ComfyUI 工具包 —— 用「服务器上真实存在的工作流」生成图片/视频。
 *
 * 设计（v2，替换旧的内置固定模板方案）：
 *  - 不再内置固定工作流：自动发现 ComfyUI 里用户保存的工作流
 *    （userdata /userdata?dir=workflows 递归列表，默认 <ComfyUI>/user/default/workflows）；
 *  - 前端格式（nodes/links/widgets_values）自动转 API 格式（convert.js，object_info 驱动）；
 *  - 自动识别可覆盖参数（analyze.js：prompt/negative/seed/尺寸/输入图/模型…按语义连接定位），
 *    映射不到的字段可用 set 显式覆盖；
 *  - 执行链与指令插件共用（run.js：发现→准备→输入图上传→提交→轮询→下载产物）；
 *  - LLM 先 list_workflows 拿清单（含用途提示/参数/引用模型），按用户要求选择或自动选择，
 *    再 generate；inspect_workflow 用于不确定时详查。
 *
 * 工具：
 *  - comfyui__list_workflows  发现并列出服务器上的工作流（选工作流/给用户展示）
 *  - comfyui__inspect_workflow 单个工作流详情（节点/参数映射/模型缺失/说明）
 *  - comfyui__generate        执行工作流 → 生成 → 发图到当前会话
 *  - comfyui__status          连通性/版本/显存/队列/工作流与模型概览（运维）
 *
 * 指令入口（#画图列表 / #画图1 关键字）见 apps/comfyui-draw.js（免 LLM）。
 * 未启用（config agent.comfyui.enable:false）时 factory 返回 []，零影响。
 * 参考：发图先例 model/pixiv/tools.js:90-95；工具契约 model/toolkit/define.js。
 */

import { defineToolPack, defineTool, param, ok, fail } from '../../model/toolkit/index.js'
import Config from '../../utils/Config.js'
import Log from '../../utils/Log.js'
import { resolveMedia } from '../../model/media/resolve.js'
import { assertUrlAllowed } from '../../model/stagehand/guard.js'
import { newClient } from './api.js'
import { listWorkflowFiles, getObjectInfo, DEFAULT_WORKFLOW_DIR } from './discover.js'
import { availableModels, missingModels, listWorkflowsSummary, prepareWorkflow, uploadWorkflowInputs, executeGraph, formatNodeErrors } from './run.js'
import { applyParams } from './params.js'
import { sendImageToChat, sendVideoAsFile, saveToTemp } from './send.js'

const cfg = () => Config.get().agent?.comfyui || {}
const logger = (lvl, msg) => { try { Log[lvl]?.('comfyui', msg) } catch { /* noop */ } }

/** 发现配置（目录/TTL 可配；缓存默认 5 分钟） */
const discoverOpts = () => ({
  dir: cfg().workflowDir || DEFAULT_WORKFLOW_DIR,
  ttl: Number(cfg().workflowCacheTtl) || 300,
})

function makeClient(c, ctx) {
  return newClient({ host: c.host, apiKey: c.apiKey, cloud: c.cloud, fetcher: ctx?.fetcher || globalThis.fetch })
}

/** 输入图 URL 直取的上限：防 SSRF + 防超大响应打爆内存（模型可被诱导填内网/元数据地址或大文件 URL） */
const INPUT_IMAGE_MAX_BYTES = 20 * 1024 * 1024
const INPUT_IMAGE_TIMEOUT_MS = 30000

/** 流式读取响应体，超过 cap 立即取消并返回 null；无 body 流（测试桩）时退回 arrayBuffer 再校验长度 */
async function readCapped(res, cap) {
  const reader = res.body?.getReader?.()
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > cap ? null : buf
  }
  const chunks = []
  let total = 0
  let over = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value?.length || 0
      if (total > cap) { over = true; break }
      chunks.push(Buffer.from(value))
    }
  } finally {
    if (over) await reader.cancel().catch(() => {})
  }
  return over ? null : Buffer.concat(chunks, total)
}

/** 取输入图 buffer：附件名 / URL / __last__(最近一张图片附件) */
async function resolveInputImage(ref, ctx, fetcher) {
  const media = Array.isArray(ctx?.media) ? ctx.media : []
  const imgs = media.filter((m) => m && (m.kind === 'image' || (m.mime || '').startsWith('image/')))
  let pick = null
  if (!ref || ref === '__last__') {
    pick = imgs[imgs.length - 1] || null
  } else if (/^https?:\/\//i.test(String(ref))) {
    const f = fetcher || globalThis.fetch
    if (f) {
      // SSRF 门禁：拒绝本机/内网/元数据等地址（请求由宿主进程发出，不能由模型任意指定目标）
      const allowed = await assertUrlAllowed(String(ref)).catch(() => ({ ok: false, reason: '校验异常' }))
      if (!allowed.ok) logger('warn', `input_image URL 被拒绝（${allowed.reason}）：${ref}`)
      else {
        try {
          const r = await f(ref, { signal: AbortSignal.timeout(INPUT_IMAGE_TIMEOUT_MS) })
          if (r.ok) {
            const buf = await readCapped(r, INPUT_IMAGE_MAX_BYTES)
            if (!buf) logger('warn', `input_image 超过 ${INPUT_IMAGE_MAX_BYTES} 字节上限，已丢弃：${ref}`)
            else pick = { buffer: buf, name: String(ref).split('/').pop()?.split('?')[0] || 'input.png' }
          }
        } catch { /* noop */ }
      }
    }
  } else {
    pick = imgs.find((m) => m.name === ref || m.filename === ref) || null
  }
  if (!pick) return null
  if (pick.buffer) return { buffer: pick.buffer, name: pick.name || pick.filename || 'input.png' }
  try {
    const r = await resolveMedia(pick, { bot: ctx?.bot, fetcher, e: ctx?.e })
    if (r?.buffer) return { buffer: r.buffer, name: r.name || pick.name || 'input.png' }
  } catch { /* noop */ }
  return null
}

// ─── comfyui__list_workflows ───
const listWorkflowsTool = defineTool({
  name: 'list_workflows',
  description:
    '列出 ComfyUI 服务器上真实存在的工作流（用户在 ComfyUI 里保存的，自动发现；含用途提示 kinds、可覆盖参数 params、引用模型与缺失检查、工作流自带说明 note）。'
    + '用户要画图/改图/放大/生成视频时先调它拿清单，再按用户指定或按 kinds/note 自动选择，然后 comfyui__generate。',
  category: 'query',
  meta: { summary: '列出 ComfyUI 可用工作流', resultCap: 6000 },
  parameters: param.object({
    refresh: param.bool('强制刷新缓存（默认 5 分钟内复用；刚在 ComfyUI 里保存了新工作流时用）'),
  }),
  async execute(p, ctx) {
    const c = cfg()
    if (!c.enable) return fail('ComfyUI 未启用（config agent.comfyui.enable）')
    const api = makeClient(c, ctx)
    const probe = await api.systemStats().catch(() => null)
    if (!probe) return fail(`ComfyUI 不可达：${c.host}（检查 host/端口/进程；Cloud 模式确认 apiKey）`, { recoverable: true })

    const o = discoverOpts()
    const listed = await listWorkflowsSummary({ api, ...o, refresh: !!p.refresh })
    if (!listed.ok) return fail(listed.error, { recoverable: true })
    if (!listed.items.length) {
      return fail(`未发现工作流：${c.host} 的 user/${o.dir} 目录为空（请先在 ComfyUI 里保存工作流，或用 agent.comfyui.workflowDir 指定目录）`)
    }
    const workflows = listed.items
    logger('debug', `发现工作流 ${workflows.length} 个（${o.dir}@${c.host}，失败 ${listed.failed.length}）`)
    return ok({
      host: c.host,
      dir: o.dir,
      count: workflows.length,
      workflows,
      ...(listed.failed.length ? { failed: listed.failed } : {}),
      ...(listed.objectInfo ? {} : { warning: 'object_info 获取失败：仅返回文件名清单（无法分析参数/模型，可能是 ComfyUI 版本较旧）' }),
    })
  },
})

// ─── comfyui__inspect_workflow ───
const inspectWorkflowTool = defineTool({
  name: 'inspect_workflow',
  description:
    '查看某个工作流的详细信息：节点清单、自动识别的参数映射（哪些参数可覆盖）、引用的模型文件（含缺失检查）、工作流自带说明、警告。'
    + '拿不准某工作流能否满足需求、或 generate 失败需要定位（缺模型/缺节点）时用。',
  category: 'query',
  meta: { summary: '查看 ComfyUI 工作流详情', resultCap: 8000 },
  parameters: param.object({
    workflow: param.str('工作流名称或路径（来自 comfyui__list_workflows，如 01_Anime_Base_8GB.json 或 子目录/文件.json）'),
    raw: param.bool('是否附带转换后的 API 格式 JSON（调试用，可能较长）'),
  }, ['workflow']),
  async execute(p, ctx) {
    const c = cfg()
    if (!c.enable) return fail('ComfyUI 未启用（config agent.comfyui.enable）')
    const api = makeClient(c, ctx)
    const o = discoverOpts()
    const prep = await prepareWorkflow({ api, ref: p.workflow, ...o })
    if (!prep.ok) return fail(prep.error, prep.candidates ? { candidates: prep.candidates } : (prep.missing ? { missing: prep.missing } : {}))

    const a = prep.analysis
    return ok({
      name: prep.entry.name,
      path: prep.entry.path,
      format: prep.format,
      kinds: a.kinds,
      params: a.params,
      models: a.models,
      missing_models: missingModels(a, availableModels(prep.objectInfo)),
      nodes: a.nodes,
      ...(a.notes?.length ? { notes: a.notes } : {}),
      ...(prep.warnings.length ? { warnings: prep.warnings } : {}),
      ...(a.warnings.length ? { analysis_warnings: a.warnings } : {}),
      ...(p.raw ? { api_graph: JSON.stringify(prep.graph).slice(0, 6000) } : {}),
    })
  },
})

// ─── comfyui__generate ───
const generateTool = defineTool({
  name: 'generate',
  description:
    '用指定工作流在 ComfyUI 生成图片/视频，生成后自动把产物发到当前会话。工作流名来自 comfyui__list_workflows（服务器上真实存在的工作流）。'
    + 'prompt/seed/steps/width/height/denoise 等按工作流自动映射注入（未传的保留工作流默认值），映射不到的字段用 set 指定节点字段。'
    + '需要输入图的工作流（kinds 含 img2img/detailer/upscale 且 needs_input_image）要提供 input_image。每次生成消耗 GPU。'
    + 'kinds 含 interrogate 的工作流（提示词反推/打标）不产图，结果在 texts 字段里——原样转述给用户即可。'
    + '多段式工作流（底图+修脸+修手+高清等）默认只发最终成品；用户明确要看中间步骤时才传 all_steps=true。',
  category: 'query',
  meta: { summary: 'ComfyUI 按工作流生成图片/视频', interactive: true, alwaysConfirm: true, resultCap: 4000 },
  parameters: param.object({
    workflow: param.str('工作流名称/路径（来自 comfyui__list_workflows）'),
    prompt: param.str('正向提示词（英文效果最佳；动漫模型用 danbooru 风格 tag）'),
    negative_prompt: param.str('反向提示词（不想要的元素）'),
    seed: param.int('随机种子（留空或负数=随机；想复现填固定值；生成后回传 seed_used）'),
    steps: param.int('采样步数（覆盖工作流默认）'),
    cfg: param.num('CFG 引导强度'),
    sampler_name: param.str('采样器名（如 euler_ancestral/dpmpp_2m，须服务器支持）'),
    scheduler: param.str('调度器名（如 normal/karras）'),
    width: param.int('图宽（覆盖工作流默认尺寸）', { min: 64 }),
    height: param.int('图高', { min: 64 }),
    batch_size: param.int('一次生成张数'),
    denoise: param.num('去噪强度 0-1（img2img 越高越偏离原图）'),
    upscale_by: param.num('放大倍数（放大类工作流）'),
    model: param.str('覆盖工作流里的 checkpoint/UNet 文件名（须服务器上已存在）'),
    input_image: param.str('输入图（附件名 / 图片 URL / 留空用最近一张）；需要输入图的工作流必填'),
    mask_image: param.str('蒙版图（inpaint 类工作流；取法同 input_image）'),
    set: {
      type: 'array',
      description: '显式覆盖节点字段（自动映射不适用时）：[{node:"6", field:"seed", value:123}]；node 为 inspect_workflow 里的节点 id',
      items: { type: 'object', properties: { node: { type: 'string' }, field: { type: 'string' }, value: {} }, required: ['node', 'field'] },
    },
    timeout: param.int('单次最长等待秒数（默认走配置；视频工作流自动放宽到 900）'),
    send_images: param.bool('是否发送产物到聊天（默认 true）'),
    all_steps: param.bool('是否连中间步骤图一起发（默认 false=只发最终成品；用户明确要看底图/修脸/修手等中间步骤时设 true）'),
  }, ['workflow']),
  async execute(p, ctx) {
    const c = cfg()
    if (!c.enable) return fail('ComfyUI 未启用（config agent.comfyui.enable）')
    const api = makeClient(c, ctx)
    const fetcher = ctx?.fetcher || globalThis.fetch

    // 0. 连通性快探（失败给清晰错误，而非卡到超时）
    const probe = await api.systemStats().catch(() => null)
    if (!probe) return fail(`ComfyUI 不可达：${c.host}（检查 host/端口/进程；Cloud 模式确认 apiKey）`, { recoverable: true })

    // 1. 解析工作流 + 转换 + 分析
    const o = discoverOpts()
    const prep = await prepareWorkflow({ api, ref: p.workflow, ...o })
    if (!prep.ok) return fail(prep.error, prep.candidates ? { candidates: prep.candidates } : (prep.missing ? { missing: prep.missing, recoverable: true } : { recoverable: true }))

    const graph = JSON.parse(JSON.stringify(prep.graph))
    const analysis = prep.analysis

    // 2. 输入图 / 蒙版上传（工作流需要时）
    let image = null
    let mask = null
    if (analysis.params.input_image) {
      image = await resolveInputImage(p.input_image, ctx, fetcher)
      if (!image) return fail('该工作流需要输入图（input_image），但未提供或取不到。让用户先发一张图，或给图片 URL', { recoverable: true })
    }
    if (analysis.params.mask_image) {
      mask = await resolveInputImage(p.mask_image, ctx, fetcher)
      if (!mask) return fail('该工作流需要蒙版图（mask_image），但未提供或取不到', { recoverable: true })
    }
    const up = await uploadWorkflowInputs({ api, analysis, image, mask })
    if (!up.ok) return fail(up.error, { recoverable: true })

    // 3. 参数注入
    const injected = applyParams(graph, analysis, p, { uploaded: up.uploaded })
    if (!injected.ok) return fail(injected.error)
    const skippedHint = injected.skipped.length
      ? `未生效参数：${injected.skipped.map((s) => `${s.key}（${s.reason}）`).join('；')}`
      : ''

    // 4. 提交 + 轮询 + 下载
    const isVideo = analysis.kinds.includes('video')
    logger('info', `生成开始：${prep.entry.name}（prompt ${String(p.prompt || '').length} 字，尺寸 ${p.width || '-'}x${p.height || '-'}）`)
    const exec = await executeGraph({
      api, graph,
      timeout: Math.min(Number(p.timeout) || (isVideo ? 900 : c.timeout || 300), 1800),
      interval: c.pollInterval || 1.5,
      maxInterval: c.pollMaxInterval || 8,
      isVideo,
      maxImages: Number(c.maxImages) || 4,
      allSteps: p.all_steps === true,
    })
    if (!exec.ok) {
      if (exec.status === 'submit') {
        const detail = formatNodeErrors(exec.nodeErrors, analysis, prep.titles)
        const miss = missingModels(analysis, availableModels(prep.objectInfo))
        const missHint = miss.length ? `；工作流引用的模型在服务器上缺失：${miss.join('、')}（请安装模型或换工作流）` : ''
        return fail(`${exec.error}${detail ? `；${detail}` : ''}${missHint}`, { node_errors: exec.nodeErrors, recoverable: true })
      }
      const at = exec.promptId ? `（prompt_id=${exec.promptId}）` : ''
      const node = exec.nodeId ? `（节点 ${exec.nodeId}${prep.titles?.[exec.nodeId] ? ' ' + prep.titles[exec.nodeId] : ''}）` : ''
      return fail(`生成失败：${exec.error}${node}${at}`, { prompt_id: exec.promptId, recoverable: exec.status !== 'cancelled' })
    }

    // 5. 产物回发（文本产物不发送——由 LLM 转述/指令插件直接回文本）
    const texts = exec.outputs.filter((o) => o.kind === 'text').map((o) => o.text)
    const sent = []
    for (const out of exec.outputs) {
      if (out.kind === 'text') continue
      const sub = out.subfolder ? { subfolder: out.subfolder } : {}
      try {
        if (!out.buffer) throw new Error(out.error || '下载失败')
        if (out.kind === 'image' && p.send_images !== false) {
          const r = await sendImageToChat(ctx, { buffer: out.buffer, filename: out.filename })
          sent.push({ filename: out.filename, kind: 'image', ...sub, sent: r.ok, ...(r.ok ? {} : { reason: r.reason }) })
        } else if (out.kind === 'video' || out.kind === 'audio') {
          const saved = saveToTemp(out.buffer, out.filename, c)
          const r = await sendVideoAsFile(ctx, saved, out.filename)
          sent.push({ filename: out.filename, kind: out.kind, ...sub, sent: r.ok, path: saved, ...(r.ok ? {} : { reason: r.error }) })
        } else {
          const saved = saveToTemp(out.buffer, out.filename, c)
          sent.push({ filename: out.filename, kind: out.kind || 'file', ...sub, path: saved })
        }
      } catch (e) {
        sent.push({ filename: out.filename, kind: out.kind, sent: false, reason: e?.message || String(e) })
      }
    }

    logger('info', `生成完成：${prep.entry.name}（prompt_id=${exec.promptId}，图片 ${sent.filter((s) => s.sent).length}/${sent.length} 已发送，文本 ${texts.length} 段）`)
    return ok({
      workflow: prep.entry.name,
      path: prep.entry.path,
      prompt_id: exec.promptId,
      seed_used: injected.seedUsed,
      applied_params: injected.applied,
      ...(injected.skipped.length ? { skipped_params: injected.skipped } : {}),
      ...(prep.warnings.length ? { warnings: prep.warnings } : {}),
      ...(texts.length ? { texts } : {}),
      outputs: sent,
      ...(exec.skippedSteps?.length ? { skipped_steps: exec.skippedSteps.map((o) => o.filename) } : {}),
      note: (texts.length && !sent.length ? `已返回 ${texts.length} 段文本（该工作流不产图）` : (sent.some((s) => s.sent) ? `已发送 ${sent.filter((s) => s.sent).length} 个产物` : (sent.length ? '生成完成但发送失败' : '完成但无可发产物')))
        + (texts.length && sent.length ? `；另有 ${texts.length} 段文本` : '')
        + (exec.skippedSteps?.length ? `；另有 ${exec.skippedSteps.length} 张中间步骤图未发（用户要看时用 all_steps=true 重跑）` : '')
        + (skippedHint ? `；${skippedHint}` : ''),
    })
  },
})

// ─── comfyui__status ───
const statusTool = defineTool({
  name: 'status',
  description: '探测 ComfyUI 服务器连通性、版本、显存、当前队列，并汇总可用工作流数量与已安装模型。配置或排错时用。',
  category: 'system',
  parameters: param.object({}, []),
  async execute(_p, ctx) {
    const c = cfg()
    if (!c.enable) return fail('ComfyUI 未启用')
    const api = makeClient(c, ctx)
    try {
      const stats = await api.systemStats()
      const o = discoverOpts()
      let workflowCount = null
      try { workflowCount = (await listWorkflowFiles(api, o)).length } catch { /* noop */ }
      let models = null
      try { models = availableModels(await getObjectInfo(api, o)) } catch { /* noop */ }
      const cap = (arr) => (arr.length > 50 ? [...arr.slice(0, 50), `…共 ${arr.length} 个`] : arr)
      return ok({
        host: c.host,
        cloud: api.isCloud,
        version: stats?.system?.comfyui_version,
        python: stats?.system?.python_version,
        devices: (stats?.devices || []).map((d) => ({ name: d.name, type: d.type, vram_total: d.vram_total, vram_free: d.vram_free })),
        queue_remaining: stats?.queue_remaining,
        workflow_dir: o.dir,
        workflow_count: workflowCount,
        // 模型清单（名）：工作流缺模型时用 model 参数覆盖 / 判断能否跑
        models: models ? {
          checkpoints: cap(models.checkpoints), unet: cap(models.unet), vae: cap(models.vae),
          upscale: cap(models.upscale), loras: cap(models.loras), detectors: cap(models.detectors),
          controlnet: cap(models.controlnet),
        } : null,
      })
    } catch (e) {
      return fail(`ComfyUI 不可达：${c.host} — ${e?.message || e}`)
    }
  },
})

export default defineToolPack({
  name: 'comfyui',
  description: 'ComfyUI 图像/视频生成（自动发现服务器上的真实工作流，按用户选择或 LLM 自动选择执行）',
  author: 'trss-agent-plugin',
  version: '2.0.0',
  // enable:false 时不注册任何工具（零影响，仿 pixiv/sticker）
  // confirm:false 时生成免主人审批（agent.comfyui.confirm，面板可改，热加载生效）
  factory: () => {
    if (!cfg().enable) return []
    const generate = cfg().confirm === false
      ? { ...generateTool, meta: { ...generateTool.meta, alwaysConfirm: false } }
      : generateTool
    return [listWorkflowsTool, inspectWorkflowTool, generate, statusTool]
  },
})
