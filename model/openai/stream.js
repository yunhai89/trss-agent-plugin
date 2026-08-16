/**
 * SSE 流式响应封装（对应协议文档第 4.2 节 + 附录 C）。
 *
 * createStream(response) 返回一个对象：
 *  - 是异步可迭代：for await (const part of stream) 逐增量处理
 *  - 迭代后（或直接读取 getter）得到聚合结果：
 *    content / reasoning / toolCalls / finishReason / usage / assistantMessage
 *
 * 每次 yield 的 part：{ delta:{content?, reasoning?, toolCalls?[], role?}, finishReason, usage, raw }
 * toolCalls 增量项：{ index, id?, name?, argumentsDelta? }
 */

import { parseToolArguments } from './helpers.js'

export function createStream(response, { reasoningFields = [], idleMs = 60000 } = {}) {
  // 增量缓冲
  const buf = { toolCalls: {} } // index -> { id, type, name, argsRaw }
  const state = {
    role: 'assistant',
    content: '',
    reasoning: '',
    finishReason: null,
    usage: null,
    toolCalls: [],
    rawChunks: [],
  }
  let finalized = false

  function finalize() {
    if (finalized) return state.toolCalls
    finalized = true
    const idxs = Object.keys(buf.toolCalls).map(Number).sort((a, b) => a - b)
    state.toolCalls = idxs.map((i) => {
      const c = buf.toolCalls[i]
      return {
        index: i,
        id: c.id,
        type: c.type || 'function',
        name: c.name,
        arguments: parseToolArguments(c.argsRaw || '{}'),
        argumentsRaw: c.argsRaw || '',
      }
    })
    return state.toolCalls
  }

  function processChunk(chunk) {
    const out = { delta: {}, finishReason: null, usage: null, raw: chunk }
    if (chunk.usage) {
      state.usage = chunk.usage
      out.usage = chunk.usage
    }
    const choice = chunk.choices?.[0]
    if (!choice) return out

    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason
      out.finishReason = choice.finish_reason
    }

    const delta = choice.delta || {}
    if (delta.role) {
      state.role = delta.role
      out.delta.role = delta.role
    }
    if (typeof delta.content === 'string' && delta.content) {
      state.content += delta.content
      out.delta.content = delta.content
    }

    // reasoning 归一化：从候选字段累加
    for (const f of reasoningFields) {
      const v = delta[f]
      if (typeof v === 'string' && v) {
        state.reasoning += v
        out.delta.reasoning = (out.delta.reasoning || '') + v
      }
    }

    // 工具调用增量：按 index 缓冲，arguments 字符串增量累加
    if (Array.isArray(delta.tool_calls)) {
      out.delta.toolCalls = []
      for (const tcd of delta.tool_calls) {
        const idx = tcd.index ?? 0
        if (!buf.toolCalls[idx]) {
          buf.toolCalls[idx] = { id: '', type: 'function', name: '', argsRaw: '' }
        }
        const cur = buf.toolCalls[idx]
        if (tcd.id) cur.id = tcd.id
        if (tcd.type) cur.type = tcd.type
        if (tcd.function?.name) cur.name = tcd.function.name
        if (typeof tcd.function?.arguments === 'string') cur.argsRaw += tcd.function.arguments

        const inc = { index: idx }
        if (tcd.id) inc.id = tcd.id
        if (tcd.function?.name) inc.name = tcd.function.name
        if (typeof tcd.function?.arguments === 'string') inc.argumentsDelta = tcd.function.arguments
        out.delta.toolCalls.push(inc)
      }
      finalized = false // 有新增量，需重新 finalize
    }
    return out
  }

  /** 解析一个 SSE 事件块（以空行分隔的原始文本）；非 data 行或 [DONE] 返回 null */
  function parseEvent(rawEvent) {
    const dataLines = []
    for (const line of rawEvent.split(/\r?\n/)) {
      const l = line.replace(/\s+$/, '')
      if (!l || l.startsWith(':')) continue
      if (l.startsWith('data:')) {
        dataLines.push(l.slice(5).replace(/^[\t ]/, ''))
      }
      // event:/id: 等其它字段忽略
    }
    if (!dataLines.length) return null
    const dataStr = dataLines.join('\n')
    if (dataStr === '[DONE]') return null
    let chunk
    try {
      chunk = JSON.parse(dataStr)
    } catch {
      return null
    }
    state.rawChunks.push(chunk)
    return processChunk(chunk)
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
        // idle 超时：fetch 的 timeout 只覆盖连接建立，body 读取(SSE)须单独保护——
        // 两 chunk 间隔超过 idleMs 即判定服务端挂起（cancel reader 释放连接 + 抛错，由上层重试/兜底）
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
        // SSE 规范允许 \n\n / \r\n\r\n / \r\r 作事件分隔；只切 '\n\n' 会把 CRLF 服务的
        // 整流切成一个事件都出不来（'\r\n\r\n' 内不含相邻 '\n\n'）。归一 CR 系行尾为 \n 后再切。
        buffer = buffer.replace(/\r\n?/g, '\n')
        let sep
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const evt = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const part = parseEvent(evt)
          if (part) yield part
        }
      }
      // 处理尾部不足一个空行分隔的残留
      buffer += decoder.decode()
      if (buffer.trim()) {
        const part = parseEvent(buffer)
        if (part) yield part
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

  return {
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

    get content() {
      return state.content
    },
    get reasoning() {
      return state.reasoning
    },
    get role() {
      return state.role
    },
    get finishReason() {
      return state.finishReason
    },
    get usage() {
      return state.usage
    },
    get toolCalls() {
      return finalize()
    },
    get rawChunks() {
      return state.rawChunks
    },
    /** 组装可回传到下一轮 messages 的 assistant 消息（spec 对齐：tool_calls.arguments 为字符串）。
     *  注意：DeepSeek 等需要原样回传 reasoning_content，由调用方按需补字段。 */
    get assistantMessage() {
      finalize()
      const m = { role: state.role || 'assistant' }
      m.content = state.content || null
      if (state.toolCalls.length) {
        m.tool_calls = state.toolCalls.map((c) => ({
          id: c.id,
          type: c.type || 'function',
          function: { name: c.name, arguments: c.argumentsRaw || '' },
        }))
      }
      return m
    },
  }
}
