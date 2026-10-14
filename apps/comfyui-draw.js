import plugin from '../../../lib/plugins/plugin.js'
import Config from '../utils/Config.js'
import Log from '../utils/Log.js'
import { newClient } from '../tools/comfyui/api.js'
import { DEFAULT_WORKFLOW_DIR } from '../tools/comfyui/discover.js'
import {
  availableModels, missingModels, listWorkflowsSummary, prepareWorkflow,
  uploadWorkflowInputs, executeGraph, formatNodeErrors,
} from '../tools/comfyui/run.js'
import { applyParams } from '../tools/comfyui/params.js'
import { parseDraw, parseReverse, formatWorkflowList, pickWorkflow, kindText } from '../tools/comfyui/command.js'
import { sendImageToChat, sendVideoAsFile, saveToTemp } from '../tools/comfyui/send.js'
import { createMediaService } from '../model/media/index.js'

/**
 * 指令画图 / 提示词反推（免 LLM 的快捷入口，共用 tools/comfyui 的发现/转换/执行链）：
 *   #画图列表                列出服务器上自动发现的工作流（编号/用途/是否需配图/缺模型）
 *   #画图1 银发少女 樱花      用 1 号工作流生成（编号见列表）
 *   #画图 银发少女 樱花       不带编号=自动选（配图→图生图；纯文字→文生图）
 *   #反推                    反推提示词：把图随消息发/引用一张 → 返回 Danbooru 风格标签
 *   （附图或引用一张图）= 作为输入图；img2img/修脸/放大/反推类工作流需要它
 *
 * 配置（agent.comfyui，面板可改）：
 *   enable          总开关（关=工具与指令都不响应）
 *   command.enable  指令开关（默认开）
 *   command.masterOnly  仅主人可用（默认 false）
 *   command.cooldown    同用户冷却秒数（默认 30；0=不限）
 */

const cfg = () => Config.get().agent?.comfyui || {}
const cmdCfg = () => cfg().command || {}
const logger = (lvl, msg) => { try { Log[lvl]?.('comfyui-draw', msg) } catch { /* noop */ } }

/** 同用户冷却（进程内存；重启清空）；key 带用途前缀，画图与反推互不阻塞 */
const lastRun = new Map()

export class ComfyDraw extends plugin {
  constructor() {
    super({
      name: 'agents_画图',
      dsc: 'ComfyUI 指令画图 / 提示词反推（#画图列表、#画图1 关键字、#反推）',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#画图列表$', fnc: 'list' },
        { reg: '^#画图(\\s|\\d|$)', fnc: 'draw' },
        { reg: '^#反推(\\s|$)', fnc: 'reverse' },
      ],
    })
  }

  /**
   * 总开关/权限前置检查。
   * @returns {'ok'|'handled'|'skip'} ok=继续；handled=已回复并结束；skip=不处理（交给其它插件）
   */
  async _gate() {
    const c = cfg()
    if (!c.enable) {
      await this.reply('ComfyUI 未启用（config agent.comfyui.enable=false）')
      return 'handled'
    }
    if (cmdCfg().enable === false) return 'skip'
    if (cmdCfg().masterOnly === true && !this.e.isMaster) {
      await this.reply('该指令仅主人可用（agent.comfyui.command.masterOnly=true）')
      return 'handled'
    }
    return 'ok'
  }

  _client(c) {
    return newClient({ host: c.host, apiKey: c.apiKey, cloud: c.cloud, fetcher: globalThis.fetch })
  }

  _opts() {
    return {
      dir: cfg().workflowDir || DEFAULT_WORKFLOW_DIR,
      ttl: Number(cfg().workflowCacheTtl) || 300,
    }
  }

  /** 画图上下文（供 tools/comfyui/send.js 复用发图/发文件） */
  _ctx() {
    return {
      e: this.e,
      bot: this.e.bot,
      isGroup: this.e.isGroup,
      groupId: this.e.group_id,
      userId: this.e.user_id,
    }
  }

  /** 冷却检查：返回 true=被拦（已回复）；kind 区分用途（draw/reverse 互不阻塞） */
  async _cooldown(kind) {
    const cd = Number(cmdCfg().cooldown ?? 30)
    if (!(cd > 0)) return false
    const key = `${kind}:${this.e.group_id || 'private'}:${this.e.user_id}`
    const last = lastRun.get(key) || 0
    const left = cd - Math.floor((Date.now() - last) / 1000)
    if (left > 0) {
      await this.reply(`⏳ 冷却中：${left} 秒后可再用（agent.comfyui.command.cooldown=${cd}，0=不限）`)
      return true
    }
    lastRun.set(key, Date.now())
    return false
  }

  /** 取消息里（含引用）的图片文件；返回 [{buffer,name}]（新→旧） */
  async _images() {
    try {
      const media = createMediaService({
        bot: this.e.bot || (typeof Bot !== 'undefined' ? Bot : null),
        e: this.e,
        caps: { vision: true },
        protocol: 'openai',
        config: { active: true, maxImages: 2, maxFileBytes: 16 * 1024 * 1024 },
      })
      const files = await media.collectActive()
      return (files || [])
        .filter((f) => f && f.buffer && (f.kind === 'image' || (f.mime || '').startsWith('image/')))
        .map((f) => ({ buffer: f.buffer, name: f.name || f.filename || 'input.png' }))
    } catch (e) {
      logger('warn', `取输入图失败：${e?.message || e}`)
      return []
    }
  }

  /** ComfyUI 连通性快探；不可达时回复并返回 null */
  async _probe(api, c) {
    const ok = await api.systemStats().catch(() => null)
    if (!ok) {
      await this.reply(`ComfyUI 不可达：${c.host}（检查服务是否启动 / agent.comfyui.host）`)
      return null
    }
    return ok
  }

  /**
   * 执行工作流（画图/反推共用）：准备 → 输入图上传 → 参数注入 → 提交轮询下载。
   * @returns {{ok:true, exec, prep, seedUsed}|{ok:false, error, needsImage?}}
   */
  async _runWorkflow({ api, item, prompt, images, allSteps = false }) {
    const c = cfg()
    const prep = await prepareWorkflow({ api, ref: item.path, ...this._opts() })
    if (!prep.ok) return { ok: false, error: `加载工作流失败：${prep.error}` }

    const up = await uploadWorkflowInputs({ api, analysis: prep.analysis, image: images[0] || null, mask: null })
    if (!up.ok) return { ok: false, error: up.error, needsImage: !!prep.analysis.params.input_image }

    const graph = JSON.parse(JSON.stringify(prep.graph))
    const injected = applyParams(graph, prep.analysis, { prompt }, { uploaded: up.uploaded })
    if (!injected.ok) return { ok: false, error: `参数注入失败：${injected.error}` }

    const isVideo = prep.analysis.kinds.includes('video')
    const exec = await executeGraph({
      api, graph,
      timeout: Number(c.timeout) || (isVideo ? 900 : 300),
      interval: c.pollInterval || 1.5,
      maxInterval: c.pollMaxInterval || 8,
      isVideo,
      maxImages: Number(c.maxImages) || 4,
      allSteps,
    })
    if (!exec.ok) {
      let msg = `生成失败：${exec.error}`
      if (exec.status === 'submit') {
        const detail = formatNodeErrors(exec.nodeErrors, prep.analysis, prep.titles)
        const miss = missingModels(prep.analysis, availableModels(prep.objectInfo))
        if (detail) msg += `\n${detail}`
        if (miss.length) msg += `\n工作流引用的模型在服务器上缺失：${miss.join('、')}`
      } else if (exec.promptId) {
        msg += `（prompt_id=${exec.promptId}）`
      }
      logger('warn', `工作流执行失败：${exec.status} ${exec.error}`)
      return { ok: false, error: msg, status: exec.status }
    }
    return { ok: true, exec, prep, seedUsed: injected.seedUsed }
  }

  async list() {
    const gate = await this._gate()
    if (gate === 'skip') return false
    if (gate === 'handled') return true
    const c = cfg()
    const api = this._client(c)
    if (!await this._probe(api, c)) return true
    const listed = await listWorkflowsSummary({ api, ...this._opts() })
    if (!listed.ok) {
      await this.reply(listed.error)
      return true
    }
    if (listed.failed?.length) logger('warn', `部分工作流分析失败：${listed.failed.map((f) => f.path).join('、')}`)
    await this.reply(formatWorkflowList(listed.items))
    return true
  }

  async draw() {
    const gate = await this._gate()
    if (gate === 'skip') return false
    if (gate === 'handled') return true
    const c = cfg()
    const parsed = parseDraw(this.e.msg)
    if (parsed.error) {
      await this.reply(parsed.error)
      return true
    }
    if (await this._cooldown('draw')) return true

    const api = this._client(c)
    if (!await this._probe(api, c)) return true

    // 1. 清单 + 选工作流（配图会参与自动选择）
    const listed = await listWorkflowsSummary({ api, ...this._opts() })
    if (!listed.ok || !listed.items.length) {
      await this.reply(listed.error || '未发现工作流（先在 ComfyUI 里保存工作流）')
      return true
    }
    const images = await this._images()
    const picked = pickWorkflow(listed.items, { n: parsed.n, hasImage: images.length > 0 })
    if (picked.error) {
      await this.reply(`${picked.error}`)
      return true
    }
    const item = picked.item
    const isReverse = (item.kinds || []).includes('interrogate')

    // 2. 提示 + 执行
    const usedPrompt = parsed.prompt || '（用工作流自带默认提示词）'
    await this.reply(`🎨 开始生成｜${picked.index}. ${item.name}［${kindText(item.kinds)}］${picked.auto ? '（自动选择）' : ''}\n关键字：${usedPrompt}${parsed.allSteps ? '\n（--all：连中间步骤图一起发）' : ''}\n预计 30~120 秒，完成后直接发图…`)

    const run = await this._runWorkflow({ api, item, prompt: parsed.prompt, images, allSteps: parsed.allSteps })
    if (!run.ok) {
      await this.reply(`❌ ${run.error}${run.needsImage ? '（把图随消息一起发，或引用一张图再发指令）' : ''}`)
      return true
    }

    // 3. 回发产物（文本类工作流直接回文本）
    const ctx = this._ctx()
    let sentCount = 0
    const texts = run.exec.outputs.filter((o) => o.kind === 'text').map((o) => o.text)
    for (const out of run.exec.outputs) {
      if (out.kind === 'text' || !out.buffer) continue
      try {
        if (out.kind === 'image') {
          const r = await sendImageToChat(ctx, { buffer: out.buffer, filename: out.filename })
          if (r.ok) sentCount++
        } else {
          const saved = saveToTemp(out.buffer, out.filename, c)
          const r = await sendVideoAsFile(ctx, saved, out.filename)
          if (r.ok) sentCount++
        }
      } catch (e) {
        logger('warn', `产物发送失败 ${out.filename}：${e?.message || e}`)
      }
    }
    if (texts.length) await this.reply(texts.join('\n\n'))
    const skipped = run.exec.skippedSteps || []
    const skippedTip = skipped.length ? `\n（另有 ${skipped.length} 张中间步骤图未发，加 --all 可一起发）` : ''
    if (!sentCount && !texts.length) await this.reply(`生成完成，但产物发送失败（查看插件日志）${skippedTip}`)
    else if (sentCount && run.seedUsed != null) await this.reply(`✅ 完成（seed ${run.seedUsed}）${skippedTip}`)
    logger('info', `指令画图完成：${item.name}（图 ${sentCount}，文本 ${texts.length}${isReverse ? '，反推类' : ''}）`)
    return true
  }

  /** #反推：图片 → 提示词（Danbooru 风格标签） */
  async reverse() {
    const gate = await this._gate()
    if (gate === 'skip') return false
    if (gate === 'handled') return true
    const parsed = parseReverse(this.e.msg)
    if (parsed.error) {
      await this.reply(parsed.error)
      return true
    }
    const c = cfg()
    const api = this._client(c)
    if (!await this._probe(api, c)) return true

    const images = await this._images()
    if (!images.length) {
      await this.reply('请把要反推的图随消息一起发（或引用一张图）再发 #反推')
      return true
    }
    if (await this._cooldown('reverse')) return true

    const listed = await listWorkflowsSummary({ api, ...this._opts() })
    if (!listed.ok || !listed.items.length) {
      await this.reply(listed.error || '未发现工作流（先在 ComfyUI 里保存工作流）')
      return true
    }
    const picked = pickWorkflow(listed.items, { only: 'interrogate' })
    if (picked.error) {
      await this.reply(`${picked.error}\n（需要装 WD14 Tagger 等反推节点，并在 ComfyUI 里保存一个反推工作流）`)
      return true
    }

    logger('info', `指令反推：${picked.item.name}（user=${this.e.user_id} gid=${this.e.group_id || '-'}）`)
    const run = await this._runWorkflow({ api, item: picked.item, prompt: '', images })
    if (!run.ok) {
      await this.reply(`❌ ${run.error}`)
      return true
    }
    const texts = run.exec.outputs.filter((o) => o.kind === 'text').map((o) => o.text)
    if (!texts.length) {
      await this.reply('反推完成，但工作流没有返回文本（请确认工作流输出接到了文本节点，如 WD14 Tagger / PreviewAny）')
      return true
    }
    const head = `🏷️ 提示词反推（${picked.item.name}）`
    await this.reply(`${head}\n${texts.join('\n\n')}`)
    logger('info', `指令反推完成：${picked.item.name}（${texts[0].length} 字）`)
    return true
  }
}
