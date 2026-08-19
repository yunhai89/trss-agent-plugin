/**
 * diagram 交付器 —— 工具结果 → 应用层图片发送的桥（apps/agent.js 与集成测试共用同一生产实现）。
 *
 * 契约：
 *   - onToolEnd(tc, content)：挂在 Agent.run opts，收集 diagram_render 成功结果（未截断 content）；
 *   - flush()：最终回复送达后调用，经 safeReply（受控发送队列）逐张发送：
 *       PNG → segment.image(base64://…)；SVG → toFileSegment 文件段；
 *       同路径只发一次；发送失败记 diagram_send_failed，不影响主回复 delivered 终态；
 *       取消路径（Agent.run 抛 aborted）调用方不会执行到 flush——迟到图片天然不发送。
 */
import fs from 'node:fs'

/**
 * @param {object} deps { safeReply(msg)->Promise<{ok,ret?,error?}>, devLog(event,data,traceId,scope)?, traceId, devScope, logger? }
 */
export function makeDiagramDeliverer({ safeReply, devLog = null, traceId = '', devScope = null, logger = () => {} } = {}) {
  const pending = []
  const sent = new Set()
  const log = (data) => { try { devLog?.('diagram', data, traceId, devScope) } catch { /* 事件失败不影响发送 */ } }

  return {
    /** Agent.run 的 onToolEnd 回调（只认 diagram_render 的成功结果） */
    onToolEnd(tc, content) {
      if (tc?.name !== 'diagram_render' || typeof content !== 'string') return
      try {
        const r = JSON.parse(content)
        if (r && r.ok === true && r.type === 'diagram' && typeof r.path === 'string') pending.push(r)
      } catch { /* 非 JSON（异常路径）不收集；Agent 的 _hint 已引导模型据实回复失败 */ }
    },

    /** 待发送数量（测试/诊断） */
    get pendingCount() { return pending.length },

    /** 最终回复后发送全部收集到的示意图；返回 {sent:[],failed:[]} */
    async flush() {
      const result = { sent: [], failed: [] }
      for (const d of pending) {
        if (sent.has(d.path)) continue // 同路径只发一次（缓存命中复用同一文件）
        sent.add(d.path)
        const evt = { event: 'diagram_send_start', toolCall: 'diagram_render', format: d.format, bytes: d.bytes, width: d.width, height: d.height, title: d.title, specHash: d.specHash }
        log(evt)
        try {
          let seg
          if (d.format === 'svg') {
            const { toFileSegment } = await import('../../utils/SendFile.js')
            seg = toFileSegment(d.path, `diagram-${d.specHash || 'out'}.svg`) // 文件名用 specHash，不用用户标题
          } else {
            const segFn = (typeof segment !== 'undefined' && segment) || null
            if (!segFn) throw new Error('当前环境不支持发送图片段')
            // 本地路径 → base64：不依赖协议端能读宿主文件系统（与 apps/render.js 同策略）
            seg = segFn.image(`base64://${fs.readFileSync(d.path).toString('base64')}`)
          }
          const outcome = await safeReply(seg)
          if (outcome?.ok) {
            log({ ...evt, event: 'diagram_sent' })
            result.sent.push(d.path)
          } else {
            const error = outcome?.error || 'send rejected'
            log({ ...evt, event: 'diagram_send_failed', error })
            logger('warn', '[diagram] 示意图发送失败', d.path, error)
            result.failed.push({ path: d.path, error })
          }
        } catch (e) {
          const error = e?.message || String(e)
          log({ ...evt, event: 'diagram_send_failed', error })
          logger('warn', '[diagram] 示意图发送异常', error)
          result.failed.push({ path: d.path, error })
        }
      }
      return result
    },
  }
}
