/**
 * Anthropic SSE 流式封装（对应协议文档第 10 节）。
 *
 * Anthropic 流是「命名事件」序列，与 OpenAI 的统一 delta 不同：
 *   message_start → content_block_start(index, block)
 *                → content_block_delta(index, delta) x N
 *                → content_block_stop(index)
 *   ...（多个 block）
 *   message_delta(stop_reason, usage.output_tokens) → message_stop
 *   其间可穿插 ping / error
 *
 * delta 类型：text_delta(text) / input_json_delta(partial_json)
 *             thinking_delta(thinking) / signature_delta(signature)
 *
 * createMessageStream(response) 返回「异步可迭代 + 聚合」对象：
 *   for await (const ev of stream) { ev.text / ev.thinking / ev.partialJson / ev.type ... }
 *   迭代后读 stream.content / stream.text / stream.thinking / stream.toolUses /
 *                   stream.stopReason / stream.usage / stream.id / stream.model
 */

import { parseToolInput } from './helpers.js'
import { APIError } from './errors.js'

export function createMessageStream(response, { idleMs = 60000 } = {}) {
  // 按 content block index 聚合
  const blocks = {} // index -> block 状态
  const order = [] // 已出现过的 index（保持顺序）
  const state = {
    id: null,
    model: null,
    role: 'assistant',
    type: 'message',
    stopReason: null,
    stopSequence: null,
    usage: null,
    content: [],
    rawEvents: [],
  }
  let finalized = false

  function ensureBlock(index, block) {
    if (!blocks[index]) {
      blocks[index] = block
      order.push(index)
    }
    return blocks[index]
  }

  function handleEvent(eventType, data) {
    state.rawEvents.push({ type: eventType, data })
    const out = { type: eventType, raw: data }

    switch (data.type || eventType) {
      case 'message_start': {
        const msg = data.message || {}
        state.id = msg.id ?? null
        state.model = msg.model ?? null
        state.role = msg.role || 'assistant'
        state.type = msg.type || 'message'
        if (msg.usage) state.usage = { ...(state.usage || {}), ...msg.usage }
        out.usage = state.usage
        break
      }
      case 'content_block_start': {
        const idx = data.index
        const cb = data.content_block || {}
        // 初始化 block（input/thinking 后续由 delta 累加）
        const block = { type: cb.type, ...cb }
        if (cb.type === 'tool_use') {
          block.id = cb.id || ''
          block.name = cb.name || ''
          block.inputRaw = ''
        } else if (cb.type === 'text') {
          block.text = cb.text || ''
        } else if (cb.type === 'thinking') {
          block.thinking = cb.thinking || ''
          block.signature = cb.signature || ''
        }
        ensureBlock(idx, block)
        out.index = idx
        out.blockType = cb.type
        if (cb.type === 'tool_use') out.toolUse = { id: block.id, name: block.name }
        break
      }
      case 'content_block_delta': {
        const idx = data.index
        const delta = data.delta || {}
        const block = blocks[idx]
        if (block) {
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            block.text = (block.text || '') + delta.text
            out.text = delta.text
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            block.thinking = (block.thinking || '') + delta.thinking
            out.thinking = delta.thinking
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            block.signature = (block.signature || '') + delta.signature
            out.signature = delta.signature
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            block.inputRaw = (block.inputRaw || '') + delta.partial_json
            out.partialJson = delta.partial_json
          }
        }
        out.index = idx
        out.deltaType = delta.type
        break
      }
      case 'content_block_stop': {
        out.index = data.index
        break
      }
      case 'message_delta': {
        const delta = data.delta || {}
        if (delta.stop_reason) state.stopReason = delta.stop_reason
        if ('stop_sequence' in delta) state.stopSequence = delta.stop_sequence
        if (data.usage) state.usage = { ...(state.usage || {}), ...data.usage }
        out.stopReason = state.stopReason
        out.usage = state.usage
        break
      }
      case 'message_stop': {
        break
      }
      case 'ping': {
        break
      }
      case 'error': {
        const err = data.error || data
        throw new APIError({
          message: err.message || 'Stream error',
          type: err.type ?? null,
          status: null,
        })
      }
      default:
        break
    }
    return out
  }

  /** 解析一个 SSE 事件块（含 event:/data: 行）→ { type, data } 或 null */
  function parseEvent(rawEvent) {
    let type = null
    const dataLines = []
    for (const line of rawEvent.split(/\r?\n/)) {
      const l = line.replace(/\s+$/, '')
      if (!l || l.startsWith(':')) continue
      if (l.startsWith('event:')) {
        type = l.slice(6).trim()
      } else if (l.startsWith('data:')) {
        dataLines.push(l.slice(5).replace(/^[\t ]/, ''))
      }
    }
    if (!dataLines.length) return null
    const dataStr = dataLines.join('\n')
    if (dataStr === '[DONE]') return null
    let data
    try {
      data = JSON.parse(dataStr)
    } catch {
      return null
    }
    return { type: type || data?.type || null, data }
  }

  function finalize() {
    if (finalized) return state.content
    finalized = true
    state.content = order.map((idx) => {
      const b = blocks[idx]
      switch (b.type) {
        case 'text':
          return { type: 'text', text: b.text || '' }
        case 'thinking':
          return { type: 'thinking', thinking: b.thinking || '', signature: b.signature || '' }
        case 'redacted_thinking':
          // 原样保留 data 字段
          return { type: 'redacted_thinking', data: b.data }
        case 'tool_use':
          return {
            type: 'tool_use',
            id: b.id,
            name: b.name,
            input: parseToolInput(b.inputRaw),
          }
        default:
          return { ...b }
      }
    })
    return state.content
  }

  async function* iterate() {
    if (!response?.body?.getReader) {
      throw new Error('流式响应缺少可读 body（response.body.getReader）')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    try {
      while (true) {
        // idle 超时：fetch timeout 只覆盖连接建立，SSE body 读取须单独保护（服务端挂起 → cancel + 抛错）
        let timer = null
        const raced = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(async () => {
              try { await reader.cancel() } catch { /* noop */ }
              reject(new Error(`流式 idle 超时（${idleMs}ms 无数据，服务端可能挂起）`))
            }, idleMs)
          }),
        ]).catch((e) => { clearTimeout(timer); throw e })
        clearTimeout(timer)
        const { done, value } = raced
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep
        // SSE 事件以空行分隔；归一 CR 系行尾（\r\n/\r）为 \n——只切 '\n\n' 会把 CRLF 服务的整流切成一个事件都出不来
        buffer = buffer.replace(/\r\n?/g, '\n')
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const parsed = parseEvent(rawEvent)
          if (parsed) {
            const out = handleEvent(parsed.type, parsed.data)
            if (out) yield out
          }
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) {
        const parsed = parseEvent(buffer)
        if (parsed) {
          const out = handleEvent(parsed.type, parsed.data)
          if (out) yield out
        }
      }
    } finally {
      try {
        reader.releaseLock?.()
      } catch {
        /* noop */
      }
      finalize()
    }
  }

  const self = {
    [Symbol.asyncIterator]() {
      const it = iterate()
      return {
        next: (v) => it.next(v),
        return: (v) => {
          finalize()
          return it.return ? it.return(v) : Promise.resolve({ value: v, done: true })
        },
        throw: (e) => {
          finalize()
          return it.throw ? it.throw(e) : Promise.reject(e)
        },
      }
    },
    get id() {
      return state.id
    },
    get model() {
      return state.model
    },
    get stopReason() {
      return state.stopReason
    },
    get stopSequence() {
      return state.stopSequence
    },
    get usage() {
      return state.usage
    },
    get content() {
      return finalize()
    },
    /** 拼接所有 text block */
    get text() {
      return finalize()
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
    },
    /** 拼接所有 thinking block */
    get thinking() {
      return finalize()
        .filter((b) => b.type === 'thinking')
        .map((b) => b.thinking)
        .join('')
    },
    /** 提取所有 tool_use：[{ id, name, input }] */
    get toolUses() {
      return finalize()
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }))
    },
    get rawEvents() {
      return state.rawEvents
    },
    /** 可回传到下一轮 messages 的 assistant 消息：content 原样（thinking 等不可修改块保持不变） */
    get assistantMessage() {
      return { role: 'assistant', content: finalize() }
    },
  }
  return self
}
