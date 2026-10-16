/**
 * send_file 工具 —— 发送任意文件到聊天。
 *
 * 模型调用本工具把本地文件（图片/文档/压缩包等）发送给用户。
 * 底层用 segment.file + e.reply（走群文件/好友文件上传 API）。
 *
 * 安全：category=system（仅主人可用，policy.js CATEGORY_MIN.system=3）；本地路径另限插件数据目录
 * （data/、data/temp/，realpath 防符号链接）——否则任意群成员都能借模型把 config.yaml / 私钥 / 记忆库发进群。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Config from '../../utils/Config.js'
import { toFileSegment } from '../../utils/SendFile.js'

/** 允许发送的根目录（各工具产物都在这里：data/、data/temp/ 及其子目录） */
const allowedRoots = () => [Config.path.temp, Config.path.data]

/** 真实路径（解符号链接）；不存在时退回 resolve（用于不存在时的越界判定） */
function realOrResolve(p) {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

/** 本地路径是否在允许目录内（realpath 后前缀比较，防 `data/../config` 与符号链接绕行） */
function isAllowedLocalPath(file) {
  const real = realOrResolve(file)
  return allowedRoots().some((root) => {
    const r = realOrResolve(root)
    return real === r || real.startsWith(r + path.sep)
  })
}

export const sendFileTool = {
  name: 'send_file',
  description: '发送本地文件到聊天（图片/文档/压缩包/音频/视频等任意文件）。仅限插件数据目录（data/、data/temp/）内的文件。何时用：用户让你发某个已存在但尚未发送的文件时。注意：create_excel 等工具在创建文件时会自动发送，不要用本工具重复发送同一文件。',
  category: 'system',
  meta: { summary: '发送文件到聊天' },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '本地文件绝对路径（须在插件 data/ 目录内）' },
      name: { type: 'string', description: '显示文件名（可选，默认用原文件名）' },
    },
    required: ['path'],
  },
  async execute(params, ctx) {
    const p = String(params?.path || '').trim()
    if (!p) return { error: '请提供文件路径' }
    // base64:// 与 http(s):// 由底层原样下发（不读宿主文件，无外泄风险）；其余按本地路径校验
    if (!/^(base64|https?):\/\//i.test(p)) {
      let local = p
      if (/^file:\/\//i.test(p)) {
        try { local = fileURLToPath(p) } catch { return { error: `无法解析的 file:// 路径：${p}` } }
      }
      if (!isAllowedLocalPath(local)) {
        return { error: `拒绝发送：仅允许发送插件数据目录（data/、data/temp/）内的文件（越界路径：${local}）` }
      }
      if (!fs.existsSync(local)) return { error: `文件不存在：${local}` }
    }
    const name = params?.name?.trim() || undefined
    try {
      await ctx?.e?.reply(toFileSegment(p, name))
      return { ok: true, path: p }
    } catch (e) {
      return { error: `发送失败：${e?.message || e}` }
    }
  },
}
