/**
 * 工具包自动加载器 —— TRSS-Yunzai apps 风格。
 *
 * 扫描目录下的顶层 .js/.mjs 文件 **和子目录**，按导出形态归一为工具包，再拍平为工具数组。
 *
 * 两种形态：
 *   1) 单文件：tools/foo.js（简单工具）—— 导出同下。
 *   2) 目录型：tools/foo/（复杂工具，类似云崽插件包）—— 入口 index.js（或同名 foo.js），
 *      其余 .js（sign.js / api.js / util.js 等）由入口 import，便于拆分签名/请求等复杂逻辑。
 *      例：QQ音乐工具 qqmusic/ → index.js(import sign.js,api.js) + sign.js + api.js
 *
 * 每个入口（文件或目录的 index）可导出（任一）：
 *   - export default defineToolPack({...})         → 工具包（推荐）
 *   - export default [tool1, tool2]                → 工具数组（匿名包）
 *   - export default tool                          → 单个工具
 *   - export default function(ctx){ return [...] } → 工厂（按 ctx 动态生成）
 *   - export const pack / tools                    → 命名导出同上
 *
 * 加载失败的单个文件/目录不中断整体加载（记日志后跳过），与 Yunzai 插件加载一致。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineToolPack } from './define.js'
import { loadPackConfigDir, registerPackConfig } from './pack-config.js'

/** 判断导出物是否已是 pack（defineToolPack 产物） */
function isPack(x) {
  return x && typeof x === 'object' && typeof x.resolve === 'function'
}

/** 把任意导出形态归一为 pack */
function asPack(file, mod, ctx) {
  const exp = mod?.default ?? mod?.pack ?? mod?.tools ?? mod
  // 工厂函数
  if (typeof exp === 'function') {
    return defineToolPack({ name: file, factory: exp })
  }
  // 已是 pack
  if (isPack(exp)) return exp
  // 数组 / 单工具
  const tools = Array.isArray(exp) ? exp : exp && typeof exp === 'object' ? [exp] : []
  return defineToolPack({ name: file, tools })
}

/**
 * 加载目录下所有工具包。
 * @param {string} dir 目录绝对路径
 * @param {object} opts { ctx, logger, ext }
 * @returns {Promise<{ packs, tools, errors }>}
 */
export async function loadToolPacks(dir, { ctx = {}, logger, ext = ['.js', '.mjs'] } = {}) {
  const log = logger || (() => {})
  const packs = []
  const tools = []
  const errors = []
  let entries = []
  try {
    // 顶层 .js/.mjs 文件 + 子目录（目录型工具包：index.js 入口 + 辅助文件，支持复杂逻辑拆分）
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((f) => (f.isFile() && ext.includes(path.extname(f.name))) || f.isDirectory())
      .map((f) => f.name)
      .sort()
  } catch (e) {
    // 目录不存在视为无自定义工具，不报错
    return { packs, tools, errors }
  }

  for (const name of entries) {
    const full = path.resolve(dir, name)
    // 目录型：找入口（index.js / index.mjs / 同名 .js），辅助文件由入口 import
    let entry = full
    let packName = path.basename(name, path.extname(name))
    let isDir = false
    try {
      if (fs.statSync(full).isDirectory()) {
        isDir = true
        const found = ext.flatMap((e) => [path.join(full, `index${e}`), path.join(full, `${name}${e}`)]).find((p) => fs.existsSync(p))
        if (!found) { errors.push({ file: name, error: '目录缺少入口（index.js 或 同名.js）' }); log('warn', `[toolkit] 跳过目录 ${name}：无入口文件`); continue }
        entry = found
        packName = name
      }
    } catch { /* noop */ }
    // 目录型工具包：声明 tool.config.js 时登记配置 schema（运行时 getToolConfig / web 动态读取）
    if (isDir) {
      try {
        const schema = await loadPackConfigDir(full, packName)
        if (schema) registerPackConfig(schema)
      } catch (e) {
        errors.push({ file: name, error: `tool.config.js 解析失败：${e?.message || e}` })
        log('warn', `[toolkit] 工具配置解析失败 ${name}:`, e?.message || e)
      }
    }
    try {
      const mod = await import(pathToFileURL(entry).href)
      const pack = asPack(packName, mod, ctx)
      const resolved = pack.resolve(ctx)
      for (const t of resolved) {
        try {
          // 经 defineTool 校验
          const { defineTool } = await import('./define.js')
          tools.push(defineTool(t))
        } catch (e) {
          errors.push({ file: name, error: e?.message || String(e) })
          log('warn', `[toolkit] 工具校验失败 ${name}:`, e?.message || e)
        }
      }
      packs.push({ name: pack.name, file: name, count: resolved.length })
    } catch (e) {
      errors.push({ file: name, error: e?.message || String(e) })
      log('error', `[toolkit] 加载失败 ${name}:`, e?.message || e)
    }
  }
  return { packs, tools, errors }
}

export { asPack }
