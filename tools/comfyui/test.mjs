/**
 * ComfyUI 工具离线自检（不联网、不依赖真实 ComfyUI）：
 *  - convert：前端格式 → API 格式（widget 顺序、seed 控制下拉、Reroute/bypass/Primitive/mute、
 *    Note 收集、缺节点包报错、子图拒绝、API 格式直通与 {prompt} 解包）
 *  - analyze：参数映射（prompt/negative 按语义连接、尺寸/模型/输入图/蒙版、类型提示）
 *  - params：注入（seed 随机/复现、数值归一、未识别参数上报、set 覆盖）
 *  - discover：userdata 发现（路径编码、递归列表、缓存、引用解析）
 *  - 工具级：假 ComfyUI HTTP 服务上跑 list_workflows / inspect_workflow / generate（含输入图上传、
 *    产物回发、node_errors 可读化），验证工具契约与真实调用链
 *
 * 运行：node tools/comfyui/test.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { uiToApi, toApiGraph, inputSpecs, isApiFormat, isUiFormat } from './convert.js'
import { analyzeGraph } from './analyze.js'
import { applyParams } from './params.js'
import { listWorkflowFiles, loadWorkflow, resolveWorkflowRef, clearDiscoveryCache } from './discover.js'
import { parseDraw, formatWorkflowList, pickWorkflow, kindText } from './command.js'
import { listWorkflowsSummary, finalOutputNodeId, nodeDepths, missingModels } from './run.js'
import { newClient } from './api.js'

const PLUGIN = fileURLToPath(new URL('../../', import.meta.url))
const { default: Config } = await import(pathToFileURL(`${PLUGIN}utils/Config.js`).href)
const { default: pack } = await import('./index.js')

let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e); console.error(e?.stack) } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ───────────────────────── 夹具 ─────────────────────────

/** 节点定义（贴近真实 /object_info 形状） */
const OBJECT_INFO = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['model-a.safetensors'], {}] } }, output: ['MODEL', 'CLIP', 'VAE'] },
  VAELoader: { input: { required: { vae_name: [['vae-a.safetensors'], {}] } }, output: ['VAE'] },
  CLIPTextEncode: { input: { required: { clip: ['CLIP', {}], text: ['STRING', { multiline: true }] } }, output: ['CONDITIONING'] },
  EmptyLatentImage: { input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } }, output: ['LATENT'] },
  KSampler: {
    input: {
      required: {
        model: ['MODEL', {}], seed: ['INT', { control_after_generate: true }], steps: ['INT', {}], cfg: ['FLOAT', {}],
        sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m'], {}], scheduler: [['normal', 'karras'], {}],
        positive: ['CONDITIONING', {}], negative: ['CONDITIONING', {}], latent_image: ['LATENT', {}], denoise: ['FLOAT', {}],
      },
    },
    output: ['LATENT'],
  },
  VAEDecode: { input: { required: { samples: ['LATENT', {}], vae: ['VAE', {}] } }, output: ['IMAGE'] },
  SaveImage: { input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', {}] } } },
  LoadImage: { input: { required: { image: [['in.png'], {}], upload: ['IMAGEUPLOAD', {}] } }, output: ['IMAGE', 'MASK'] },
  ImageScale: { input: { required: { image: ['IMAGE', {}], upscale_method: [['nearest-exact', 'lanczos'], {}], width: ['INT', {}], height: ['INT', {}], crop: [['center', 'disabled'], {}] } }, output: ['IMAGE'] },
  VAEEncode: { input: { required: { pixels: ['IMAGE', {}], vae: ['VAE', {}] } }, output: ['LATENT'] },
  FaceDetailer: {
    input: {
      required: {
        image: ['IMAGE', {}], model: ['MODEL', {}], clip: ['CLIP', {}], vae: ['VAE', {}],
        guide_size: ['FLOAT', {}], seed: ['INT', {}], steps: ['INT', {}], cfg: ['FLOAT', {}],
        positive: ['CONDITIONING', {}], negative: ['CONDITIONING', {}], denoise: ['FLOAT', {}], feather: ['INT', {}],
        bbox_detector: ['BBOX_DETECTOR', {}],
      },
    },
    output: ['IMAGE'],
  },
  UltimateSDUpscale: {
    input: {
      required: {
        image: ['IMAGE', {}], model: ['MODEL', {}], positive: ['CONDITIONING', {}], negative: ['CONDITIONING', {}], vae: ['VAE', {}],
        upscale_by: ['FLOAT', {}], seed: ['INT', {}], steps: ['INT', {}], cfg: ['FLOAT', {}],
        sampler_name: [['dpmpp_2m'], {}], scheduler: [['karras'], {}], denoise: ['FLOAT', {}],
        upscale_model: ['UPSCALE_MODEL', {}], mode_type: [['Chess'], {}], tile_width: ['INT', {}],
      },
    },
    output: ['IMAGE'],
  },
  UpscaleModelLoader: { input: { required: { model_name: ['COMBO', { options: ['4x-test.pth'] }] } }, output: ['UPSCALE_MODEL'] },
  UltralyticsDetectorProvider: { input: { required: { model_name: [['bbox/face.pt', 'bbox/hand.pt'], {}] } }, output: ['BBOX_DETECTOR', 'SEGM_DETECTOR'] },
  'WD14Tagger|pysssss': { input: { required: { image: ['IMAGE', {}], model: [['wd-swinv2-tagger-v3'], {}], threshold: ['FLOAT', {}], character_threshold: ['FLOAT', {}], replace_underscore: ['BOOLEAN', {}], trailing_comma: ['BOOLEAN', {}], exclude_tags: ['STRING', {}] } }, output: ['STRING'], output_node: true },
  PreviewAny: { input: { required: { source: ['*', {}] } }, output: ['STRING'], output_node: true },
  VAEDecodeTiled: { input: { required: { samples: ['LATENT', {}], vae: ['VAE', {}], tile_size: ['INT', {}], overlap: ['INT', {}] } }, output: ['IMAGE'] },
  BboxDetectorSEGS: { input: { required: { bbox_detector: ['BBOX_DETECTOR', {}], image: ['IMAGE', {}], threshold: ['FLOAT', {}], dilation: ['INT', {}] } }, output: ['SEGS'] },
  HandRepairCrop2080: { input: { required: { image: ['IMAGE', {}], selection_mode: [['detect', 'manual_box'], {}], hand_index: ['INT', {}], context_factor: ['FLOAT', {}], min_crop: ['INT', {}], target_size: [[512, 640, 768], {}], mask_expand: ['FLOAT', {}] } }, output: ['IMAGE', 'HAND_REPAIR_CONTEXT_2080', 'MASK'] },
  HandPoseGuide2080: { input: { required: { context: ['HAND_REPAIR_CONTEXT_2080', {}], preset: [['waist_rest', 'palm_up'], {}], rotation: ['FLOAT', {}], mirror: ['BOOLEAN', {}], scale: ['FLOAT', {}] } }, output: ['IMAGE'] },
  HandRepairStitch2080: { input: { required: { original: ['IMAGE', {}], repaired: ['IMAGE', {}], context: ['HAND_REPAIR_CONTEXT_2080', {}], feather: ['INT', {}] } }, output: ['IMAGE'] },
  ControlNetLoader: { input: { required: { control_net_name: [['xinsir-openpose-sdxl-1.0.safetensors'], {}] } }, output: ['CONTROL_NET'] },
  ControlNetApplyAdvanced: { input: { required: { positive: ['CONDITIONING', {}], negative: ['CONDITIONING', {}], control_net: ['CONTROL_NET', {}], image: ['IMAGE', {}], strength: ['FLOAT', {}] } }, output: ['CONDITIONING', 'CONDITIONING'] },
  VAEEncodeForInpaint: { input: { required: { pixels: ['IMAGE', {}], vae: ['VAE', {}], mask: ['MASK', {}], grow_mask_by: ['INT', {}] } }, output: ['LATENT'] },
  LoraLoader: { input: { required: { model: ['MODEL', {}], clip: ['CLIP', {}], lora_name: [['lora-a.safetensors'], {}] } }, output: ['MODEL', 'CLIP'] },
}

/** 前端格式工作流：txt2img + Reroute（穿透）+ Primitive（字面量进 widget）+ mute + Note */
const UI_TXT2IMG = {
  last_node_id: 12,
  last_link_id: 20,
  nodes: [
    { id: 1, type: 'CheckpointLoaderSimple', mode: 0, widgets_values: ['model-a.safetensors'], inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }, { name: 'CLIP', type: 'CLIP', links: [2] }, { name: 'VAE', type: 'VAE', links: [3] }] },
    { id: 2, type: 'Reroute', mode: 0, widgets_values: [], inputs: [{ name: '', type: '*', link: 2 }], outputs: [{ name: '', type: 'CLIP', links: [4] }] },
    { id: 3, type: 'CLIPTextEncode', mode: 0, widgets_values: ['a cat, masterpiece'], inputs: [{ name: 'clip', type: 'CLIP', link: 4, widget: null }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [5] }] },
    { id: 4, type: 'CLIPTextEncode', mode: 0, widgets_values: ['worst quality, low quality'], inputs: [{ name: 'clip', type: 'CLIP', link: 2, widget: null }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [6] }] },
    { id: 5, type: 'EmptyLatentImage', mode: 0, widgets_values: [768, 1152, 1], inputs: [], outputs: [{ name: 'LATENT', type: 'LATENT', links: [7] }] },
    { id: 11, type: 'Note', mode: 0, widgets_values: ['用法说明：改 prompt 即可'], inputs: [], outputs: [] },
    { id: 12, type: 'EmptyLatentImage', mode: 2, widgets_values: [64, 64, 1], inputs: [], outputs: [] },
    { id: 9, type: 'PrimitiveNode', mode: 0, widgets_values: [42], inputs: [], outputs: [{ name: 'INT', type: 'INT', links: [9] }] },
    { id: 6, type: 'KSampler', mode: 0, widgets_values: [123, 'fixed', 28, 5, 'euler_ancestral', 'normal', 1], inputs: [
      { name: 'model', type: 'MODEL', link: 1, widget: null },
      { name: 'positive', type: 'CONDITIONING', link: 5, widget: null },
      { name: 'negative', type: 'CONDITIONING', link: 6, widget: null },
      { name: 'latent_image', type: 'LATENT', link: 7, widget: null },
      { name: 'seed', type: 'INT', link: 9, widget: { name: 'seed' } },
    ], outputs: [{ name: 'LATENT', type: 'LATENT', links: [8] }] },
    { id: 7, type: 'VAEDecode', mode: 0, widgets_values: [], inputs: [{ name: 'samples', type: 'LATENT', link: 8 }, { name: 'vae', type: 'VAE', link: 3 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [10] }] },
    { id: 8, type: 'SaveImage', mode: 0, widgets_values: ['test/out'], inputs: [{ name: 'images', type: 'IMAGE', link: 10 }], outputs: [] },
  ],
  links: [
    [1, 1, 0, 6, 0, 'MODEL'],
    [2, 1, 1, 4, 0, 'CLIP'],
    [2, 1, 1, 2, 0, 'CLIP'],
    [3, 1, 2, 7, 1, 'VAE'],
    [4, 2, 0, 3, 0, 'CLIP'],
    [5, 3, 0, 6, 1, 'CONDITIONING'],
    [6, 4, 0, 6, 2, 'CONDITIONING'],
    [7, 5, 0, 6, 3, 'LATENT'],
    [8, 6, 0, 7, 0, 'LATENT'],
    [9, 9, 0, 6, 4, 'INT'],
    [10, 7, 0, 8, 0, 'IMAGE'],
  ],
  extra: {}, version: 0.4,
}

/** img2img：LoadImage → ImageScale → VAEEncode → KSampler */
const UI_IMG2IMG = {
  last_node_id: 6, last_link_id: 6,
  nodes: [
    { id: 1, type: 'CheckpointLoaderSimple', mode: 0, widgets_values: ['model-a.safetensors'], inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }, { name: 'CLIP', type: 'CLIP', links: [2] }, { name: 'VAE', type: 'VAE', links: [3] }] },
    { id: 2, type: 'LoadImage', mode: 0, widgets_values: ['in.png', 'image'], inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [4] }, { name: 'MASK', type: 'MASK', links: [] }] },
    { id: 3, type: 'CLIPTextEncode', mode: 0, widgets_values: ['style x'], inputs: [{ name: 'clip', type: 'CLIP', link: 2 }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [5] }] },
    { id: 4, type: 'ImageScale', mode: 0, widgets_values: ['lanczos', 512, 768, 'center'], inputs: [{ name: 'image', type: 'IMAGE', link: 4 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [6] }] },
    { id: 5, type: 'VAEEncode', mode: 0, widgets_values: [], inputs: [{ name: 'pixels', type: 'IMAGE', link: 6 }, { name: 'vae', type: 'VAE', link: 3 }], outputs: [{ name: 'LATENT', type: 'LATENT', links: [7] }] },
    { id: 6, type: 'KSampler', mode: 0, widgets_values: [1, 'randomize', 20, 7, 'dpmpp_2m', 'karras', 0.6], inputs: [
      { name: 'model', type: 'MODEL', link: 1 }, { name: 'positive', type: 'CONDITIONING', link: 5 },
      { name: 'negative', type: 'CONDITIONING', link: 5 }, { name: 'latent_image', type: 'LATENT', link: 7 },
    ], outputs: [{ name: 'LATENT', type: 'LATENT', links: [8] }] },
  ],
  links: [
    [1, 1, 0, 6, 0, 'MODEL'], [2, 1, 1, 3, 0, 'CLIP'], [3, 1, 2, 5, 1, 'VAE'],
    [4, 2, 0, 4, 0, 'IMAGE'], [5, 3, 0, 6, 1, 'CONDITIONING'], [6, 4, 0, 5, 0, 'IMAGE'],
    [7, 5, 0, 6, 3, 'LATENT'], [8, 6, 0, 6, 1, 'LATENT'],
  ],
}

/** FaceDetailer 风格：seed 无 control_after_generate 声明，但 widgets_values 里仍插了 'fixed' */
const UI_DETAILER = {
  last_node_id: 3, last_link_id: 4,
  nodes: [
    { id: 1, type: 'CheckpointLoaderSimple', mode: 0, widgets_values: ['model-a.safetensors'], inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }, { name: 'CLIP', type: 'CLIP', links: [2] }, { name: 'VAE', type: 'VAE', links: [3] }] },
    { id: 2, type: 'CLIPTextEncode', mode: 0, widgets_values: ['hand fix'], inputs: [{ name: 'clip', type: 'CLIP', link: 2 }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [4] }] },
    { id: 3, type: 'FaceDetailer', mode: 0, widgets_values: [512, 768, 208014, 'fixed', 20, 5, 0.28, 16], inputs: [
      { name: 'image', type: 'IMAGE', link: 1 }, { name: 'model', type: 'MODEL', link: 1 }, { name: 'clip', type: 'CLIP', link: 2 },
      { name: 'vae', type: 'VAE', link: 3 }, { name: 'positive', type: 'CONDITIONING', link: 4 },
      { name: 'negative', type: 'CONDITIONING', link: 4 }, { name: 'bbox_detector', type: 'BBOX_DETECTOR', link: null },
    ], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [] }] },
  ],
  links: [
    [1, 1, 0, 3, 0, 'MODEL'], [2, 1, 1, 2, 0, 'CLIP'], [3, 1, 2, 3, 3, 'VAE'], [4, 2, 0, 3, 4, 'CONDITIONING'],
  ],
}

/** 工作流文件（假服务器返回）：ui 为主，另有 api 格式与缺模型工作流 */
const FILE_TXT2IMG = JSON.stringify(UI_TXT2IMG)
const FILE_IMG2IMG = JSON.stringify(UI_IMG2IMG)
const FILE_API = JSON.stringify({
  _comment: 'API 格式导出（老工具模板同款：顶层带字符串说明键，原样提交会让 ComfyUI 500）',
  prompt: {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model-a.safetensors' } },
    6: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', positive: ['3', 0], negative: ['4', 0], latent_image: ['5', 0], denoise: 1 } },
    3: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: 'api cat' } },
    4: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: 'worst quality' } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  },
})
const FILE_MISSING_MODEL = JSON.stringify({
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'nope.safetensors' } },
  3: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: 'x' } },
  6: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', positive: ['3', 0], latent_image: ['5', 0], denoise: 1 } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
})
/** 放大工作流（API 格式）：引用服务器上没有的放大模型 → 缺模型检查 */
const FILE_MISSING_UPSCALE = JSON.stringify({
  1: { class_type: 'LoadImage', inputs: { image: 'in.png' } },
  2: { class_type: 'UpscaleModelLoader', inputs: { model_name: 'missing-4x.pth' } },
  3: { class_type: 'UltimateSDUpscale', inputs: { image: ['1', 0], upscale_model: ['2', 0], upscale_by: 2, seed: 1, steps: 10, cfg: 5, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 0.2 } },
  4: { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
  5: { class_type: 'UltralyticsDetectorProvider', inputs: { model_name: 'bbox/face.pt' } },
})

const FILE_MISSING_DETECTOR = JSON.stringify({
  1: { class_type: 'UltralyticsDetectorProvider', inputs: { model_name: 'bbox/nope.pt' } },
  2: { class_type: 'FaceDetailer', inputs: { image: ['3', 0], model: ['4', 0], clip: ['5', 0], vae: ['6', 0], positive: ['7', 0], negative: ['7', 0], bbox_detector: ['1', 0], seed: 1, steps: 10, cfg: 5, denoise: 0.5, guide_size: 512 } },
  3: { class_type: 'LoadImage', inputs: { image: 'in.png' } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model-a.safetensors' } },
  5: { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: 'hand fix' } },
  6: { class_type: 'VAELoader', inputs: { vae_name: 'vae-a.safetensors' } },
  7: { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: 'worst quality' } },
})

/** 新版 02 同构：底图 + 手部修复链（ControlNet），内部有 VAEEncodeForInpaint 但无需输入图 */
const FILE_REPAIR_CHAIN = JSON.stringify({
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model-a.safetensors' } },
  3: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: 'base girl' } },
  4: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: 'worst quality' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1152, batch_size: 1 } },
  6: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 1, steps: 28, cfg: 5, sampler_name: 'euler_ancestral', scheduler: 'normal', positive: ['3', 0], negative: ['4', 0], latent_image: ['5', 0], denoise: 1 } },
  7: { class_type: 'VAEDecodeTiled', inputs: { samples: ['6', 0], vae: ['1', 2], tile_size: 512, overlap: 64 } },
  8: { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'r/01_base' } },
  9: { class_type: 'UltralyticsDetectorProvider', inputs: { model_name: 'bbox/hand.pt' } },
  10: { class_type: 'BboxDetectorSEGS', inputs: { bbox_detector: ['9', 0], image: ['7', 0], threshold: 0.3, dilation: 8 } },
  11: { class_type: 'HandRepairCrop2080', inputs: { image: ['7', 0], selection_mode: 'detect', hand_index: 0, context_factor: 3.0, min_crop: 256, target_size: 640, mask_expand: 0.15 } },
  12: { class_type: 'HandPoseGuide2080', inputs: { context: ['11', 1], preset: 'waist_rest', rotation: 0, mirror: false, scale: 0.9 } },
  13: { class_type: 'ControlNetLoader', inputs: { control_net_name: 'xinsir-openpose-sdxl-1.0.safetensors' } },
  14: { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['3', 0], negative: ['4', 0], control_net: ['13', 0], image: ['12', 0], strength: 0.85 } },
  15: { class_type: 'VAEEncodeForInpaint', inputs: { pixels: ['11', 0], vae: ['1', 2], mask: ['11', 2], grow_mask_by: 8 } },
  16: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 9, steps: 30, cfg: 5, sampler_name: 'dpmpp_2m', scheduler: 'karras', positive: ['14', 0], negative: ['14', 1], latent_image: ['15', 0], denoise: 0.95 } },
  17: { class_type: 'VAEDecodeTiled', inputs: { samples: ['16', 0], vae: ['1', 2], tile_size: 512, overlap: 64 } },
  18: { class_type: 'HandRepairStitch2080', inputs: { original: ['7', 0], repaired: ['17', 0], context: ['11', 1], feather: 8 } },
  19: { class_type: 'SaveImage', inputs: { images: ['18', 0], filename_prefix: 'r/02_repaired' } },
})

/** 多段式工作流（底图→中段→最终）：3 个 SaveImage 串联，验证「默认只发最终成品」 */
const FILE_MULTISTAGE = JSON.stringify({
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model-a.safetensors' } },
  3: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: 'multi girl' } },
  4: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: 'worst quality' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768, batch_size: 1 } },
  6: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 1, steps: 8, cfg: 5, sampler_name: 'euler', scheduler: 'normal', positive: ['3', 0], negative: ['4', 0], latent_image: ['5', 0], denoise: 1 } },
  7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
  8: { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'm/01_base' } },
  9: { class_type: 'ImageScale', inputs: { image: ['7', 0], upscale_method: 'lanczos', width: 768, height: 1152, crop: 'center' } },
  10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'm/02_mid' } },
  11: { class_type: 'ImageScale', inputs: { image: ['9', 0], upscale_method: 'lanczos', width: 1024, height: 1536, crop: 'center' } },
  12: { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: 'm/03_final' } },
})

const FILE_TAGGER = JSON.stringify({
  1: { class_type: 'LoadImage', inputs: { image: 'example.png' }, _meta: { title: '① 输入图片' } },
  2: { class_type: 'WD14Tagger|pysssss', inputs: { image: ['1', 0], model: 'wd-swinv2-tagger-v3', threshold: 0.35, character_threshold: 0.85, replace_underscore: true, trailing_comma: false, exclude_tags: '' }, _meta: { title: '② 反推标签' } },
  3: { class_type: 'PreviewAny', inputs: { source: ['2', 0] }, _meta: { title: '③ 标签文本' } },
})

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

// ───────────────────────── 假 ComfyUI 服务 ─────────────────────────
const hits = []
let submitBody = null
let historyResponse = null
let promptResponse = null
let uploadResponse = { name: 'uploaded.png', subfolder: '', type: 'input' }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  hits.push(`${req.method} ${u.pathname}${u.search}`)
  const json = (o, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)) }
  if (u.pathname === '/system_stats') return json({ system: { comfyui_version: '9.9-test' }, devices: [{ name: 'cpu', type: 'cpu', vram_total: 1, vram_free: 1 }], queue_remaining: 0 })
  if (u.pathname === '/object_info') return json(OBJECT_INFO)
  if (u.pathname === '/userdata' && req.method === 'GET') {
    if (u.searchParams.get('dir') !== 'workflows') return json([])
    return json([
      { path: 'sub/01_txt2img.json', size: FILE_TXT2IMG.length, modified: 111 },
      { path: 'sub/02_img2img.json', size: FILE_IMG2IMG.length, modified: 222 },
      { path: '03_api.json', size: FILE_API.length, modified: 333 },
      { path: '04_missing.json', size: FILE_MISSING_MODEL.length, modified: 444 },
      { path: '05_missing_upscale.json', size: FILE_MISSING_UPSCALE.length, modified: 445 },
      { path: '06_missing_detector.json', size: FILE_MISSING_DETECTOR.length, modified: 446 },
      { path: '07_tagger.json', size: FILE_TAGGER.length, modified: 447 },
      { path: '08_multistage.json', size: FILE_MULTISTAGE.length, modified: 448 },
      { path: '09_repair_chain.json', size: FILE_REPAIR_CHAIN.length, modified: 449 },
      { path: 'note.txt', size: 3, modified: 555 },
    ])
  }
  if (u.pathname.startsWith('/userdata/')) {
    const p = decodeURIComponent(u.pathname.slice('/userdata/'.length))
    if (p === 'workflows/sub/01_txt2img.json') return res.end(FILE_TXT2IMG)
    if (p === 'workflows/sub/02_img2img.json') return res.end(FILE_IMG2IMG)
    if (p === 'workflows/03_api.json') return res.end(FILE_API)
    if (p === 'workflows/04_missing.json') return res.end(FILE_MISSING_MODEL)
    if (p === 'workflows/05_missing_upscale.json') return res.end(FILE_MISSING_UPSCALE)
    if (p === 'workflows/06_missing_detector.json') return res.end(FILE_MISSING_DETECTOR)
    if (p === 'workflows/07_tagger.json') return res.end(FILE_TAGGER)
    if (p === 'workflows/08_multistage.json') return res.end(FILE_MULTISTAGE)
    if (p === 'workflows/09_repair_chain.json') return res.end(FILE_REPAIR_CHAIN)
    res.statusCode = 404; return res.end('nope')
  }
  if (u.pathname === '/prompt' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c })
    return req.on('end', () => {
      submitBody = JSON.parse(body)
      if (promptResponse) { res.statusCode = promptResponse.code || 400; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(promptResponse.body)) }
      return json({ prompt_id: 'p1' })
    })
  }
  if (u.pathname === '/history/p1') {
    if (historyResponse) return json(historyResponse)
    const submitted = submitBody?.prompt || {}
    const isTagger = Object.values(submitted).some((n) => n?.class_type === 'WD14Tagger|pysssss')
    // 反推：tagger 节点与 PreviewAny 节点输出同一段文本（验证按内容去重）
    if (isTagger) return json({ p1: { status: { completed: true, status_str: 'success' }, outputs: { 2: { tags: ['1girl, solo, silver hair'] }, 3: { text: ['1girl, solo, silver hair'] } } } })
    // 多段式：3 个 SaveImage 各自出图（验证默认只发最终成品）
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
  if (u.pathname === '/upload/image' && req.method === 'POST') { req.resume(); return req.on('end', () => json(uploadResponse)) }
  if (u.pathname === '/interrupt') return json({})
  res.statusCode = 404; res.end('not found')
})
const base = await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)) })

// 工具启用 + 指向假服务器（内存改，不落盘）
Config.get().agent.comfyui = { enable: true, host: base, timeout: 30, pollInterval: 0.05, pollMaxInterval: 0.1, workflowDir: 'workflows', maxImages: 4, outputDir: '/tmp/comfyui-test-out' }
const tools = Object.fromEntries(pack.resolve({}).map((t) => [t.name, t]))
const client = () => newClient({ host: base })

globalThis.segment = { image: (data) => ({ type: 'image', data }) }
const makeCtx = (media = []) => {
  const sent = []
  return {
    sent,
    ctx: {
      fetcher: globalThis.fetch, media, isGroup: true, groupId: '1', userId: '2',
      e: { reply: async (seg) => { sent.push(seg) } },
    },
  }
}

// ───────────────────────── 测试 ─────────────────────────

await test('convert：前端格式 → API 格式（Reroute 穿透 / Primitive 字面量 / mute 剔除 / Note 收集）', async () => {
  const r = uiToApi(UI_TXT2IMG, OBJECT_INFO)
  ok(r.ok, '转换成功')
  const g = r.prompt
  ok(Object.keys(g).length === 7, `可执行节点 7 个（mute/Note/Primitive 已剔除）：${Object.keys(g).length}`)
  ok(!g['12'], 'muted 节点已剔除')
  ok(g['6'].inputs.positive[0] === '3', 'Reroute 穿透：正向提示词直连到 CLIPTextEncode')
  ok(g['4'].inputs.clip[0] === '1', 'Reroute 穿透：负向 clip 直连 checkpoint')
  ok(g['6'].inputs.seed === 42, 'Primitive 字面量写入 seed widget')
  ok(g['6'].inputs.steps === 28 && g['6'].inputs.cfg === 5, 'seed 后的 control 下拉被跳过，widget 顺序不串位')
  ok(g['3'].inputs.text === 'a cat, masterpiece' && g['4'].inputs.text === 'worst quality, low quality', '提示词文本正确')
  ok(g['5'].inputs.width === 768 && g['5'].inputs.height === 1152 && g['5'].inputs.batch_size === 1, '尺寸字段正确')
  ok(g['8'].inputs.images[0] === '7' && g['7'].inputs.samples[0] === '6', '连线引用为 [节点ID, 槽位]')
  ok(r.notes.length === 1 && /用法说明/.test(r.notes[0].text), 'Note 文本被收集')
  ok(r.warnings.length === 0, '无告警')

  // mute 节点作为来源：断开引用（下游输入缺失，由 server 明确报错），而不是留悬空引用
  const muted = JSON.parse(JSON.stringify(UI_TXT2IMG))
  muted.nodes.find((n) => n.id === 5).mode = 2
  const r2 = uiToApi(muted, OBJECT_INFO)
  ok(r2.ok && !('latent_image' in r2.prompt['6'].inputs), 'mute 来源 → 该输入不写入（悬空引用被断开）')
  ok(r2.warnings.some((w) => /latent_image/.test(w)), 'mute 来源产生可读告警')
})

await test('convert：缺节点包 / 子图 / 非工作流格式 → 明确报错', async () => {
  const ui = { nodes: [{ id: 1, type: 'NoSuchNode', mode: 0, widgets_values: [] }], links: [] }
  const r1 = uiToApi(ui, OBJECT_INFO)
  ok(!r1.ok && r1.missing?.[0] === 'NoSuchNode' && /NoSuchNode/.test(r1.error), '缺节点包报错并列出类型')
  const r2 = uiToApi({ nodes: [{ id: 1, type: 'KSampler', mode: 0 }], links: [], definitions: { subgraphs: [{ id: 'x' }] } }, OBJECT_INFO)
  ok(!r2.ok && /子图/.test(r2.error), '子图工作流明确拒绝')
  const r3 = toApiGraph({ hello: 'world' }, OBJECT_INFO)
  ok(!r3.ok && /无法识别/.test(r3.error), '未知格式报错')
})

await test('convert：API 格式直通 / {prompt} 解包 / 非节点键剔除（_comment 防 500）/ 判定函数', async () => {
  ok(isApiFormat({ 1: { class_type: 'X', inputs: {} } }), 'isApiFormat 识别裸图')
  ok(isApiFormat({ prompt: { 1: { class_type: 'X', inputs: {} } } }), 'isApiFormat 识别 {prompt} 包装')
  ok(isUiFormat(UI_TXT2IMG), 'isUiFormat 识别前端格式')
  const r = toApiGraph(JSON.parse(FILE_API), OBJECT_INFO)
  ok(r.ok && r.format === 'api' && r.prompt['6'].class_type === 'KSampler', 'API 格式直通（无 object_info 也能用）')
  ok(!('_comment' in r.prompt), '{prompt} 包装外的说明键不会进入提交图')
  // 老工具模板同款：裸 API 图里混了字符串键 _comment（原样提交 → ComfyUI validate_prompt 崩 500）
  const bare = toApiGraph({ _comment: '说明', '1': { class_type: 'CheckpointLoaderSimple', inputs: {} } }, OBJECT_INFO)
  ok(bare.ok && !('_comment' in bare.prompt) && bare.prompt['1'], '裸图里的 _comment 被剔除，节点保留')
  ok(bare.warnings.some((w) => /_comment/.test(w)), '剔除行为有告警说明')
  const only = toApiGraph({ _comment: 'x' }, OBJECT_INFO)
  ok(!only.ok && /无法识别/.test(only.error), '只有注释键 → 明确报错')
  const spec = inputSpecs(OBJECT_INFO, 'FaceDetailer')
  ok(spec[0].widget === false && spec.find((s) => s.name === 'seed').widget === true, 'inputSpecs：link/widget 判定')
})

await test('analyze：参数映射（语义连接回溯 prompt/negative，尺寸/模型/类型提示）', async () => {
  const g = uiToApi(UI_TXT2IMG, OBJECT_INFO).prompt
  const a = analyzeGraph(g)
  ok(a.params.prompt?.node === '3' && a.params.negative_prompt?.node === '4', 'prompt/negative 按 positive/negative 连接回溯')
  ok(a.params.seed?.node === '6' && a.params.steps?.field === 'steps', 'seed/steps 落在 KSampler')
  ok(a.params.width?.node === '5' && a.params.height?.node === '5', '尺寸落在 EmptyLatentImage')
  ok(a.params.model?.node === '1' && a.params.model.field === 'ckpt_name', 'model 落在 checkpoint loader')
  ok(eq(a.kinds, ['txt2img']), '类型提示 txt2img')
  ok(a.models.checkpoints[0] === 'model-a.safetensors', '模型引用清单')
  ok(!a.params.input_image, 'txt2img 不需要输入图')
})

await test('analyze：img2img（输入图/尺寸/类型）与 detailer（seed 兜底、无 prompt 连接）', async () => {
  const a = analyzeGraph(uiToApi(UI_IMG2IMG, OBJECT_INFO).prompt)
  ok(a.params.input_image?.node === '2', 'input_image 落在 LoadImage')
  ok(a.params.width?.node === '4' && a.params.height?.node === '4', 'img2img 尺寸落在 ImageScale')
  ok(a.kinds.includes('img2img'), '类型提示 img2img')

  const d = analyzeGraph(uiToApi(UI_DETAILER, OBJECT_INFO).prompt)
  ok(d.params.seed?.node === '3' && d.params.steps?.node === '3', 'detailer 工作流（无 KSampler）seed/steps 兜底命中')
  ok(d.kinds.includes('detailer'), '类型提示 detailer')
})

await test('params：注入（数值归一 / seed 随机与复现 / 未识别上报 / set 覆盖）', async () => {
  const a = analyzeGraph(uiToApi(UI_TXT2IMG, OBJECT_INFO).prompt)
  const g = JSON.parse(JSON.stringify(uiToApi(UI_TXT2IMG, OBJECT_INFO).prompt))
  const r = applyParams(g, a, { prompt: 'new prompt', width: '640', steps: '15', seed: 999, upscale_by: 2, set: [{ node: '6', field: 'denoise', value: 0.7 }, { node: '6', field: 'nope', value: 1 }] })
  ok(r.ok, '注入成功')
  ok(g['3'].inputs.text === 'new prompt', 'prompt 写入')
  ok(g['5'].inputs.width === 640 && typeof g['5'].inputs.width === 'number', 'width 数值化')
  ok(g['6'].inputs.steps === 15 && g['6'].inputs.seed === 999, 'steps/seed 写入')
  ok(r.seedUsed === 999, 'seed_used 回传固定值')
  ok(g['6'].inputs.denoise === 0.7 && r.applied.includes('set:6.denoise'), 'set 覆盖生效')
  ok(r.skipped.some((s) => s.key === 'upscale_by'), '未识别参数上报（upscale_by）')
  ok(r.skipped.some((s) => s.key === 'set:6.nope'), '非法 set 字段上报')
  ok(g['4'].inputs.text === 'worst quality, low quality', '未传参数保留工作流默认')

  const g2 = JSON.parse(JSON.stringify(uiToApi(UI_TXT2IMG, OBJECT_INFO).prompt))
  const r2 = applyParams(g2, a, { seed: -1 })
  ok(r2.seedUsed > 0 && g2['6'].inputs.seed === r2.seedUsed, 'seed 负数 → 随机并回传')
  const g3 = JSON.parse(JSON.stringify(uiToApi(UI_TXT2IMG, OBJECT_INFO).prompt))
  const r3 = applyParams(g3, a, {})
  ok(r3.seedUsed > 0 && g3['6'].inputs.seed === r3.seedUsed, '未传 seed → 随机写入（可复现）')
})

await test('discover：userdata 列表 / 文件读取（路径 %2F 编码）/ 缓存 / 引用解析', async () => {
  clearDiscoveryCache()
  const api = client()
  const entries = await listWorkflowFiles(api, { dir: 'workflows', ttl: 300 })
  ok(entries.length === 9 && !entries.some((e) => e.name === 'note.txt'), '递归列出 9 个 .json（忽略非 json）')
  const e1 = entries.find((e) => e.path === 'sub/01_txt2img.json')
  ok(e1?.udPath === 'workflows/sub/01_txt2img.json', 'udPath 带 dir 前缀（GET /userdata/{file} 用）')
  ok(e1?.folder === 'sub', 'folder 归一')

  const before = hits.filter((h) => h.startsWith('GET /userdata/')).length
  const loaded = await loadWorkflow(api, e1, { ttl: 300, objectInfo: OBJECT_INFO })
  ok(loaded.ok && loaded.format === 'ui' && loaded.analysis.params.prompt, '读取 + 转换 + 分析成功')
  const reqPath = hits.find((h) => h.startsWith('GET /userdata/workflows'))
  ok(reqPath && reqPath.includes('%2F'), `文件路径按单段编码（%2F）：${reqPath}`)
  const loaded2 = await loadWorkflow(api, e1, { ttl: 300, objectInfo: OBJECT_INFO })
  ok(loaded2.ok && hits.filter((h) => h.startsWith('GET /userdata/')).length === before + 1, '二次读取命中缓存（不再请求）')

  ok(resolveWorkflowRef(entries, 'sub/01_txt2img.json').entry?.path === 'sub/01_txt2img.json', '完整路径解析')
  ok(resolveWorkflowRef(entries, '01_txt2img').entry?.path === 'sub/01_txt2img.json', '去扩展名解析')
  ok(resolveWorkflowRef(entries, '4').entry?.path === '04_missing.json', '数字引用按文件名匹配优先（04_missing）')
  ok(resolveWorkflowRef([{ path: 'a/aa.json', name: 'aa.json' }, { path: 'b/bb.json', name: 'bb.json' }], '2').entry?.path === 'b/bb.json', '无名称可匹配时按序号解析')
  const amb = resolveWorkflowRef([{ path: 'a/x.json', name: 'x.json' }, { path: 'b/x.json', name: 'x.json' }], 'x')
  ok(amb.error && amb.candidates.length === 2, '同名歧义 → 报错 + 候选列表')
  ok(resolveWorkflowRef(entries, '不存在').error, '未找到 → 报错')

  // 旧版本 userdata 只返回字符串路径数组（不支持 full_info）：仍可发现
  const old = newClient({ host: base })
  const origList = old.listUserdata
  old.listUserdata = async () => ['legacy/a.json', 'legacy/b.json', 'note.txt']
  const legacyEntries = await listWorkflowFiles(old, { dir: 'workflows', ttl: 0, refresh: true })
  ok(legacyEntries.length === 2 && legacyEntries[0].udPath === 'workflows/legacy/a.json', '兼容字符串数组形态的旧服务器')
  old.listUserdata = origList
})

await test('list_workflows：清单（用途提示/参数/缺模型/说明）与失败项隔离', async () => {
  clearDiscoveryCache()
  const { ctx } = makeCtx()
  const r = await tools['comfyui__list_workflows'].execute({ refresh: true }, ctx)
  ok(r.ok && r.count === 9, `列出 9 个工作流（count=${r.count}）`)
  const t = r.workflows.find((w) => w.name === '01_txt2img.json')
  ok(t && t.kinds.includes('txt2img') && t.params.includes('prompt') && t.params.includes('seed'), 'txt2img 摘要（kinds/params）')
  ok(t?.note && /用法说明/.test(t.note), 'Note 说明随清单下发')
  ok(t?.default_prompt === 'a cat, masterpiece', '默认提示词摘要（供选择参考）')
  const m = r.workflows.find((w) => w.name === '04_missing.json')
  ok(m?.missing_models?.[0] === 'checkpoints:nope.safetensors', '缺模型检查（04_missing 引用不存在模型）')
  const apiWf = r.workflows.find((w) => w.name === '03_api.json')
  ok(apiWf?.format === 'api', 'API 格式工作流同样被发现')
  const tagger = r.workflows.find((w) => w.name === '07_tagger.json')
  ok(tagger?.kinds?.includes('interrogate'), '反推工作流类型提示 interrogate')
  ok(tagger?.needs_input_image === true, '反推工作流标记需配图')
  const up = r.workflows.find((w) => w.name === '05_missing_upscale.json')
  ok(up?.missing_models?.includes('upscale:missing-4x.pth'), '放大模型缺失检查（COMBO options 口径）')
  ok(!up?.missing_models?.some((m) => /bbox\//.test(m)), '检测器权重不按 upscale 源检查（已存在的 bbox/face.pt 不误报缺失）')
  ok(up?.kinds?.includes('upscale'), '放大工作流类型提示')
  const det = r.workflows.find((w) => w.name === '06_missing_detector.json')
  ok(det?.missing_models?.[0] === 'detectors:bbox/nope.pt', '检测器模型缺失按 UltralyticsDetectorProvider 口径上报')
})

await test('inspect_workflow：参数映射 / 模型缺失 / 名称解析', async () => {
  const { ctx } = makeCtx()
  const r = await tools['comfyui__inspect_workflow'].execute({ workflow: '01_txt2img' }, ctx)
  ok(r.ok && r.path === 'sub/01_txt2img.json', '按去扩展名解析到 sub/01_txt2img.json')
  ok(r.params.prompt?.node === '3' && r.params.seed?.node === '6', '参数映射下发')
  ok(r.missing_models.length === 0, '模型齐全（model-a 已安装）')
  const bad = await tools['comfyui__inspect_workflow'].execute({ workflow: 'zzz' }, ctx)
  ok(!bad.ok && bad.candidates?.length === 9, '未找到 → 候选列表')
})

await test('generate：提交图正确（参数注入/seed）+ 产物回发 + 结果字段', async () => {
  const { ctx, sent } = makeCtx()
  const r = await tools['comfyui__generate'].execute({ workflow: '01_txt2img', prompt: 'a dog', width: 640, height: 640, steps: 12, seed: 555 }, ctx)
  ok(r.ok, `生成成功：${r.error || ''}`)
  const sub = submitBody?.prompt || {}
  ok(sub['3'].inputs.text === 'a dog', '提交图里 prompt 已注入')
  ok(sub['5'].inputs.width === 640 && sub['5'].inputs.height === 640, '提交图里尺寸已注入')
  ok(sub['6'].inputs.seed === 555 && sub['6'].inputs.steps === 12, '提交图里 seed/steps 已注入')
  ok(sub['4'].inputs.text === 'worst quality, low quality', '未传参数保留默认')
  ok(r.seed_used === 555 && r.workflow === '01_txt2img.json', '结果回传 seed_used/workflow')
  ok(r.outputs?.[0]?.sent === true && sent.length === 1, '产物已回发聊天（segment 捕获 1 条）')
})

await test('generate：需要输入图（img2img）→ 上传并写入 LoadImage；缺图报错', async () => {
  const media = [{ kind: 'image', name: 'in.png', filename: 'in.png', buffer: Buffer.from('fakeimg') }]
  const { ctx } = makeCtx(media)
  const r = await tools['comfyui__generate'].execute({ workflow: '02_img2img', prompt: 'style y', input_image: '__last__' }, ctx)
  ok(r.ok, `img2img 生成成功：${r.error || ''}`)
  const sub = submitBody?.prompt || {}
  ok(sub['2'].inputs.image === 'uploaded.png', 'LoadImage 写入上传后的文件名')
  ok(r.applied_params.includes('input_image'), 'input_image 记录在 applied')
  const { ctx: ctx2 } = makeCtx([])
  const r2 = await tools['comfyui__generate'].execute({ workflow: '02_img2img', prompt: 'x' }, ctx2)
  ok(!r2.ok && /需要输入图/.test(r2.error), '缺输入图 → 明确报错')
})

await test('generate：node_errors 可读化（节点 id/类型/原因）+ 未识别参数提示', async () => {
  promptResponse = { code: 400, body: { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { '6': { errors: [{ message: 'Value not in list', details: "sampler_name: 'zzz' not in [...]" }], class_type: 'KSampler' } } } }
  const { ctx } = makeCtx()
  const r = await tools['comfyui__generate'].execute({ workflow: '01_txt2img', sampler_name: 'zzz' }, ctx)
  ok(!r.ok && /节点 6\(KSampler\)/.test(r.error) && /Value not in list/.test(r.error), `错误含节点与原因：${(r.error || '').slice(0, 120)}`)
  ok(!!r.node_errors, 'node_errors 透传（便于模型自纠）')
  promptResponse = null

  // 缺模型的工作流：提交失败时补充缺失清单（便于模型/用户换工作流或装模型）
  promptResponse = { code: 400, body: { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { '1': { errors: [{ message: 'Value not in list', details: "ckpt_name: 'nope.safetensors' not in [...]" }] } } } }
  const { ctx: ctx4 } = makeCtx()
  const r4 = await tools['comfyui__generate'].execute({ workflow: '04_missing' }, ctx4)
  ok(!r4.ok && /模型在服务器上缺失/.test(r4.error) && /nope.safetensors/.test(r4.error), `缺模型时补充清单：${(r4.error || '').slice(-90)}`)
  promptResponse = null

  const { ctx: ctx3 } = makeCtx()
  const r3 = await tools['comfyui__generate'].execute({ workflow: '01_txt2img', negative_prompt: 'x', upscale_by: 2 }, ctx3)
  ok(r3.ok && r3.skipped_params?.some((s) => s.key === 'upscale_by'), '未识别参数在结果中提示（upscale_by）')
})

await test('command：指令解析（编号/关键字/数字开头关键字的歧义）', async () => {
  const eqp = (t, want, m) => { const r = parseDraw(t); ok(JSON.stringify({ n: r.n, prompt: r.prompt }) === JSON.stringify(want), `${m}（${t} → ${JSON.stringify({ n: r.n, prompt: r.prompt })}）`) }
  eqp('#画图1 银发少女 樱花', { n: 1, prompt: '银发少女 樱花' }, '编号 + 关键字')
  eqp('#画图 银发少女', { n: null, prompt: '银发少女' }, '无编号=自动选')
  eqp('#画图1', { n: 1, prompt: '' }, '只有编号=用工作流默认提示词')
  eqp('#画图 5月的天空', { n: null, prompt: '5月的天空' }, '数字开头关键字不被当编号（5 后无空白）')
  eqp('#画图2  两格空格', { n: 2, prompt: '两格空格' }, '多余空白归一')
  ok(parseDraw('#画图0 x').error, '编号 0 报错')
  const all1 = parseDraw('#画图2 银发少女 --all')
  ok(all1.n === 2 && all1.prompt === '银发少女' && all1.allSteps === true, `--all 解析并剥离：${JSON.stringify(all1)}`)
  const all2 = parseDraw('#画图2 关键字 --全部')
  ok(all2.allSteps === true && all2.prompt === '关键字', '--全部 同样生效')
  ok(parseDraw('#画图2 关键字').allSteps === false, '默认不带步骤图')
  ok(parseDraw('#画图2 a--all').allSteps === false && parseDraw('#画图2 a--all').prompt === 'a--all', '词中 --all 不当开关')
  ok(parseDraw('#画图abc').n === null, '「#画图abc」= 关键字（自动选）')
  ok(kindText(['txt2img', 'detailer']) === '文生图+修脸/修手', 'kinds 中文标签')
})

await test('command：工作流选择（指定编号 / 有图优先图生图 / 无图优先文生图）与清单文案', async () => {
  const items = [
    { name: 'a.json', kinds: ['txt2img', 'detailer', 'upscale'], needs_input_image: false },
    { name: 'b.json', kinds: ['txt2img'], needs_input_image: false, default_prompt: '1girl, solo' },
    { name: 'c.json', kinds: ['img2img'], needs_input_image: true },
  ]
  ok(pickWorkflow(items, { n: 2 }).item.name === 'b.json', '指定编号取对应项')
  ok(pickWorkflow(items, { n: 9 }).error, '编号越界报错')
  ok(pickWorkflow(items, { n: null, hasImage: true }).item.name === 'c.json', '有配图 → 优先图生图')
  ok(pickWorkflow(items, { n: null, hasImage: false }).item.name === 'b.json', '无配图 → 优先轻量文生图（跳过 detailer 档）')
  ok(pickWorkflow(items, { n: null, hasImage: false }).auto === true, '自动选择带标记')
  ok(pickWorkflow([], {}).error, '空清单报错')
  const txt = formatWorkflowList(items)
  ok(/1\. a\.json/.test(txt) && /文生图\+修脸\/修手/.test(txt), '清单带编号与用途')
  ok(/需配图/.test(txt) && /#画图<编号> <关键字>/.test(txt), '清单标注需配图并含用法')
})

await test('run：listWorkflowsSummary（清单数据源，供工具与指令共用）', async () => {
  clearDiscoveryCache()
  const api = client()
  const r = await listWorkflowsSummary({ api, dir: 'workflows', ttl: 300 })
  ok(r.ok && r.items.length === 9, `清单 9 项（${r.items.length}）`)
  const t = r.items.find((i) => i.name === '01_txt2img.json')
  ok(t?.kinds?.includes('txt2img') && t?.params?.includes('prompt'), '摘要含 kinds/params')
  ok(t?.path === 'sub/01_txt2img.json' && typeof t?.size === 'number', '摘要含路径与体积')
  ok(r.failed.length === 0, '无失败项')
})

await test('generate：反推类工作流返回文本（texts 去重、不发图）', async () => {
  const { ctx, sent } = makeCtx([{ kind: 'image', name: 'rev.png', filename: 'rev.png', buffer: Buffer.from('fakeimg') }])
  const r = await tools['comfyui__generate'].execute({ workflow: '07_tagger', input_image: '__last__' }, ctx)
  ok(r.ok, `反推执行成功：${r.error || ''}`)
  ok(Array.isArray(r.texts) && r.texts.length === 1, `texts 一段（tagger + PreviewAny 同内容已去重）：${JSON.stringify(r.texts)}`)
  ok(r.texts[0] === '1girl, solo, silver hair', '标签文本原样返回')
  ok((r.outputs || []).length === 0 && sent.length === 0, '文本产物不发图')
  ok(/不产图/.test(r.note || ''), `note 说明不产图：${r.note}`)
})

await test('run：最终成品判定（依赖链最深输出节点）', async () => {
  const g = JSON.parse(FILE_MULTISTAGE)
  ok(finalOutputNodeId(g) === '12', `多段式 → 最终节点 12（高清）：${finalOutputNodeId(g)}`)
  const single = { 1: { class_type: 'X', inputs: {} }, 2: { class_type: 'SaveImage', inputs: { images: ['1', 0] } } }
  ok(finalOutputNodeId(single) === '2', '单输出 → 该节点')
  const depths = nodeDepths(g)
  ok(depths.get('8') === 4 && depths.get('12') === 6, '依赖链深度计算（base=4, final=6）')
})

await test('适配新版 02：底图+手部修复链（内部 inpaint 编码不得误标 img2img；ControlNet 模型纳入检查）', async () => {
  clearDiscoveryCache()
  const { ctx } = makeCtx()
  const listed = await tools['comfyui__list_workflows'].execute({ refresh: true }, ctx)
  const w = listed.workflows.find((x) => x.name === '09_repair_chain.json')
  ok(w?.kinds?.includes('txt2img'), `含内部 inpaint 编码但无需输入图 → 仍为 txt2img：${JSON.stringify(w?.kinds)}`)
  ok(!w?.kinds?.includes('img2img'), '不得误标 img2img（回归：旧判定只看 encode 节点）')
  ok(w?.kinds?.includes('detailer'), '手部修复链 → detailer（修脸/修手）')
  ok(w?.needs_input_image === false, '无需输入图')
  ok(!w?.missing_models, `ControlNet 模型已装 → 不报缺失：${JSON.stringify(w?.missing_models)}`)

  const insp = await tools['comfyui__inspect_workflow'].execute({ workflow: '09_repair_chain' }, ctx)
  ok(insp.models.controlnet?.[0] === 'xinsir-openpose-sdxl-1.0.safetensors', 'ControlNet 模型归入 models.controlnet')
  const conv = toApiGraph(JSON.parse(FILE_REPAIR_CHAIN), OBJECT_INFO)
  ok(conv.ok && finalOutputNodeId(conv.prompt) === '19', `修复链最终成品 = 缝合后重绘（节点 19）：${conv.ok ? finalOutputNodeId(conv.prompt) : conv.error}`)
  const depths = nodeDepths(conv.prompt)
  ok(depths.get('8') === 4 && depths.get('19') > depths.get('8'), '底图（8）浅于成品（19）→ 默认只发成品')
})

await test('适配新版 02：缺失的 ControlNet 模型会被点名', async () => {
  const g = JSON.parse(FILE_REPAIR_CHAIN)
  g['13'].inputs.control_net_name = 'nope-openpose.safetensors'
  const a = analyzeGraph(g, {})
  const miss = missingModels(a, { controlnet: ['xinsir-openpose-sdxl-1.0.safetensors'] })
  ok(miss.includes('controlnet:nope-openpose.safetensors'), `缺 ControlNet 上报：${JSON.stringify(miss)}`)
  ok(missingModels(a, { controlnet: ['nope-openpose.safetensors'] }).length === 0, '已装时不报')
})

await test('generate：多段式工作流默认只发最终成品；all_steps=true 才全发', async () => {
  const { ctx, sent } = makeCtx()
  const r = await tools['comfyui__generate'].execute({ workflow: '08_multistage', prompt: 'x' }, ctx)
  ok(r.ok, `执行成功：${r.error || ''}`)
  ok((r.outputs || []).length === 1 && r.outputs[0].filename === 'final.png', `只发最终成品：${JSON.stringify((r.outputs || []).map((o) => o.filename))}`)
  ok(sent.length === 1, '聊天只收到 1 张图')
  ok(JSON.stringify(r.skipped_steps) === JSON.stringify(['base.png', 'mid.png']), `中间步骤图列出但不发：${JSON.stringify(r.skipped_steps)}`)
  ok(/中间步骤图未发/.test(r.note || ''), `note 提示可补发：${r.note}`)

  const { ctx: ctx2, sent: sent2 } = makeCtx()
  const r2 = await tools['comfyui__generate'].execute({ workflow: '08_multistage', prompt: 'x', all_steps: true }, ctx2)
  ok(r2.ok && (r2.outputs || []).length === 3, `all_steps=true → 3 张全发：${JSON.stringify((r2.outputs || []).map((o) => o.filename))}`)
  ok(!r2.skipped_steps, '全发时无被过滤步骤')
  ok(sent2.length === 3, '聊天收到 3 张')
})

await test('generate：主人审批可由配置关闭（agent.comfyui.confirm，缺省仍为开）', async () => {
  const metaOf = () => Object.fromEntries(pack.resolve({}).map((t) => [t.name, t]))['comfyui__generate'].meta
  Config.get().agent.comfyui.confirm = undefined
  ok(metaOf().alwaysConfirm === true, '未配置 → 默认走主人审批（安全缺省）')
  Config.get().agent.comfyui.confirm = false
  ok(metaOf().alwaysConfirm === false, 'confirm=false → 免审批直接生成')
  ok(metaOf().interactive === true, '仍保持 interactive（长任务独占串行）')
  Config.get().agent.comfyui.confirm = true
  ok(metaOf().alwaysConfirm === true, 'confirm=true → 恢复审批')
  Config.get().agent.comfyui.confirm = false
})

await test('status：连通性/版本/工作流与模型计数', async () => {
  const { ctx } = makeCtx()
  const r = await tools['comfyui__status'].execute({}, ctx)
  ok(r.ok && r.version === '9.9-test' && r.workflow_count === 9, `状态聚合（version=${r.version}, workflows=${r.workflow_count}）`)
  ok(r.models?.checkpoints?.[0] === 'model-a.safetensors' && r.models?.upscale?.[0] === '4x-test.pth', '已安装模型清单（含 COMBO options 口径）')
})

// ───────────────────────── 汇总 ─────────────────────────
console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
server.close()
if (failed > 0) process.exitCode = 1
