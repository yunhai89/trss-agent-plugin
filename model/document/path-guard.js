/**
 * 宿主文件路径门禁 —— 供 document 系「读/转/转录」工具共用。
 *
 * 背景（2026-10-17 第 6 轮只读审计 A1/A2）：
 * `file_to_pdf` / `read_pdf` / `read_excel` / `transcribe_media` 原先对 `path` 只做
 * `fs.existsSync`，而它们的 category 是 `query`（`model/agent/policy.js` 对 query 直接放行、
 * 无需审批）⇒ **任意群成员**都能让模型把 `config/config.yaml`、`.env`、`data/logs/*.log`
 * 转成 PDF 发进群或读出正文。同一能力在 `send_file` 上已按历史第 69 条限定目录，这里补齐。
 *
 * 口径：只允许插件临时目录 `data/temp/` 内的文件。所有工具产物（QQ 附件副本、`web_download`
 * 的 downloads/、bilibili 音频、画图产物、研究 PDF）都落在该目录下，正常链路不受影响；
 * `config/`、`.env`、`data/logs/`、`data/memories/` 等宿主敏感文件则一律拒绝。
 * （`send_file` 是主人的 `system` 工具，另按 data/ + data/temp/ 放行，不在此列。）
 *
 * realpath 后做前缀比较：防 `data/temp/../../config/config.yaml` 与符号链接绕行。
 */

import fs from 'node:fs'
import path from 'node:path'
import Config from '../../utils/Config.js'

/** 允许读取的根目录：仅插件临时目录（各工具产物所在处） */
export const allowedReadRoots = () => [Config.path.temp]

/** 真实路径（解符号链接）；不存在时退回 resolve（用于不存在时的越界判定） */
export function realOrResolve(p) {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

/** 路径是否在给定根目录内（realpath 前缀比较） */
export function isUnderRoots(file, roots) {
  const real = realOrResolve(file)
  return (roots || []).some((root) => {
    const r = realOrResolve(root)
    return real === r || real.startsWith(r + path.sep)
  })
}

/**
 * 校验宿主文件路径是否允许被 document 工具读取。
 * @returns {string|null} 越界时返回可直接回给模型的错误文案；通过返回 null
 */
export function hostPathError(file, { roots = allowedReadRoots(), label = '文件' } = {}) {
  if (!file) return `请提供${label}路径`
  if (isUnderRoots(file, roots)) return null
  return `${label}路径越界：只允许读取插件临时目录（data/temp/）内的文件（越界路径：${file}）`
}
