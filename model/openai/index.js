/**
 * OpenAI 兼容请求库 —— 公共出口。
 *
 * 推荐用法（厂商预设）：
 *   import { createClient, presets } from '../../model/openai/index.js'
 *   const ds = createClient({ ...presets.deepseek, apiKey })
 *   const res = await ds.chat.completions.create({ model, messages })
 *
 * 详见 README.md。
 */

import { OpenAIClient } from './Client.js'
import { presets, getPreset } from './presets.js'
import {
  APIError,
  TimeoutError,
  ConnectionError,
  isRetryableError,
} from './errors.js'
import { parseToolArguments, extractReasoning, toolArgumentsString, splitInlineThink, createThinkStripper, extractToolCallsOpenAI } from './helpers.js'

/** 工厂：合并预设与配置后构造客户端 */
export function createClient(config = {}) {
  return new OpenAIClient(config)
}

function mk(role, content, name) {
  const m = { role, content }
  if (name) m.name = name
  return m
}

/** 消息 / 多模态内容构造器，减少手拼数组的出错面 */
export const msg = {
  // 整条消息
  system: (content, name) => mk('system', content, name),
  developer: (content, name) => mk('developer', content, name),
  user: (content) => ({ role: 'user', content }),
  assistant: (content, extra = {}) => ({ role: 'assistant', content, ...extra }),
  /** 工具执行结果消息 */
  tool: (toolCallId, content) => ({ role: 'tool', tool_call_id: toolCallId, content }),

  // content 数组片段
  text: (text) => ({ type: 'text', text }),
  imageUrl: (url, detail = 'auto') => ({ type: 'image_url', image_url: { url, detail } }),
  imageBase64: (mime, base64, detail = 'auto') => ({
    type: 'image_url',
    image_url: { url: `data:${mime};base64,${base64}`, detail },
  }),
  audio: (base64, format = 'wav') => ({ type: 'input_audio', input_audio: { data: base64, format } }),
  file: ({ filename, fileData, fileId } = {}) => ({
    type: 'file',
    file: { filename, file_data: fileData, file_id: fileId },
  }),

  /** 便捷：文本 + 其它片段组成的 user 多模态消息 */
  userText: (text, ...parts) => ({
    role: 'user',
    content: [{ type: 'text', text }, ...parts],
  }),
}

export {
  OpenAIClient,
  presets,
  getPreset,
  APIError,
  TimeoutError,
  ConnectionError,
  isRetryableError,
  parseToolArguments,
  extractReasoning,
  toolArgumentsString,
  splitInlineThink,
  createThinkStripper,
  extractToolCallsOpenAI,
}
