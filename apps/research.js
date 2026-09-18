/**
 * 深度研究命令（#研究 <主题>）—— 接入 model/research/DeepResearch。
 *
 * 结果下发级联（PDF → 高清长图 → 分段文本），任一环节失败自动降级：
 *   1) PDF 文件发送（segment.file）—— 失败/不可用 →
 *   2) 高清长图（puppeteer fullPage @2x PNG）—— 再失败 → Yunzai 内置截图 →
 *   3) 分段文本（按段落边界切分，单段 ≤ ~1800 字，防超 QQ 发送上限）
 *
 * 默认仅主人可用（研究成本高，agent.research.permission 可改为 all）。
 * 搜索经 model/search 多源路由（有 key 用 Tavily/Exa 等，否则 SearXNG，再否则 DDG 兜底）。
 */

import plugin from '../../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import Config from '../utils/Config.js'
import Log from '../utils/Log.js'
import { DeepResearch, buildResearchHtml, safeFilename, splitMessage } from '../model/research/index.js'
import { createSearchManager } from '../model/search/index.js'
import { renderPdf, renderHd, screenshot } from './render.js'
import { getRuntime } from './agent.js'

const MAX_SEG = 1800 // 单段文本字符上限（QQ 消息长度安全阈值）

const PHASE_LABEL = {
  scope: '📋 规划研究范围',
  synthesize: '✍️ 综合撰写报告',
  cite: '📎 校对引用来源',
  evaluate: '✅ 评估报告质量',
}

function tempDir() {
  return Config.path.temp
}

export class Research extends plugin {
  constructor() {
    super({
      name: 'agents研究',
      dsc: '深度研究（#研究 <主题>）→ PDF / 高清图 / 分段文本',
      event: 'message',
      priority: 9000,
      rule: [{ reg: '^#研究\\s+(.+)', fnc: 'research' }],
    })
  }

  async research() {
    const cfg = Config.get().agent || {}
    const perm = cfg.research?.permission || 'master'
    if (perm === 'master' && !this.e.isMaster) {
      await this.e.reply('深度研究默认仅主人可用（配置 agent.research.permission: all 可放开）')
      return true
    }
    const topic = this.e.msg.replace(/^#研究\s+/, '').trim()
    if (!topic) return this.e.reply('请提供研究主题：#研究 <主题>'), true

    let rt
    try {
      rt = await getRuntime()
    } catch (e) {
      await this.e.reply(String(e?.message || e))
      return true
    }

    const searchManager = createSearchManager({
      ...(cfg.search || {}),
      fetcher: (typeof fetch !== 'undefined' && fetch) || undefined,
      logger: Log.tag('search'),
    })
    // 研究 worker「功能模型」引用：可落在任意已注册厂商
    const worker = rt.modelRouter?.resolve(cfg.research?.workerModel || cfg.model) || { provider: rt.provider, model: cfg.model }
    const dr = new DeepResearch({
      provider: rt.provider,
      model: cfg.model,
      workerProvider: worker.provider,
      workerModel: worker.model || cfg.model,
      searchManager,
      maxRounds: cfg.research?.maxRounds ?? 3,
      maxConcurrent: cfg.research?.maxConcurrent ?? 3,
      enableEvaluation: cfg.research?.evaluation !== false,
      logger: Log.tag('research'),
    })

    const startedAt = Date.now()
    await this.e.reply(`🔍 开始研究「${topic}」，可能需要数分钟…`)
    try {
      const result = await dr.run(topic, {
        callbacks: {
          onPhase: (phase) => {
            const label = PHASE_LABEL[phase]
            if (label) this.e.reply(label).catch(() => {})
          },
        },
      })
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      await this._deliver(topic, result, elapsed)
    } catch (e) {
      Log.error('[research] 失败', e?.message || e)
      await this.e.reply(`研究失败：${e?.message || e}`)
    }
    return true
  }

  /** 下发级联：PDF → 高清图 → 分段文本 */
  async _deliver(topic, result, elapsed) {
    const { report, citations, evaluation, rounds } = result || {}
    const html = buildResearchHtml({ topic, report, citations, evaluation, rounds, createdAt: Date.now() })

    if (await this._tryPdf(topic, html)) return
    if (await this._tryHdImage(html)) return
    await this._sendText(topic, report, citations, evaluation, elapsed)
  }

  async _tryPdf(topic, html) {
    try {
      const dir = tempDir()
      await fs.promises.mkdir(dir, { recursive: true }).catch(() => {})
      const file = path.join(dir, `${safeFilename(topic)}-${Date.now().toString(36)}.pdf`)
      const ok = await renderPdf(html, { path: file })
      if (!ok) return false
      const seg = (typeof segment !== 'undefined' && segment) || null
      if (!seg?.file) return false
      const sent = await this.e.reply(seg.file(file, `${safeFilename(topic)}.pdf`)).catch(() => null)
      return !!sent
    } catch (e) {
      Log.warn('[research] PDF 下发失败，降级高清图', e?.message || e)
      return false
    }
  }

  async _tryHdImage(html) {
    try {
      const seg = (typeof segment !== 'undefined' && segment) || null
      const buff = await renderHd('agents-plugin/research', html, { scale: 2, imgType: 'png' })
      if (buff && seg?.image) {
        const sent = await this.e.reply(seg.image(`base64://${buff.toString('base64')}`)).catch(() => null)
        if (sent) return true
      }
      // 再兜底：Yunzai 内置截图
      const img = await screenshot('agents-plugin/research', html)
      if (img) {
        await this.e.reply(img)
        return true
      }
      return false
    } catch (e) {
      Log.warn('[research] 高清图失败，降级文本', e?.message || e)
      return false
    }
  }

  async _sendText(topic, report, citations, evaluation, elapsed) {
    const parts = [`# ${topic}`, report || '（无内容）']
    if (citations?.length) parts.push(`\n## 参考来源\n${citations.map((c, i) => `${i + 1}. ${c}`).join('\n')}`)
    if (evaluation) {
      const pass = evaluation.pass === false ? '未通过' : '通过'
      parts.push(`\n_评估：${pass}${evaluation.score != null ? `（${evaluation.score}）` : ''}_`)
    }
    const chunks = splitMessage(parts.join('\n'), MAX_SEG)
    await this.e.reply(`（文本模式 · ${chunks.length} 段${elapsed ? ` · ${elapsed}s` : ''}）`).catch(() => {})
    for (const chunk of chunks) await this.e.reply(chunk).catch(() => {})
  }
}
