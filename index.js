/**
 * agents-plugin 入口
 *
 * 自动扫描并加载 apps/ 目录下的所有 .js 应用模块。
 * Yunzai loader 在发现本 index.js 后将只加载它，不会再递归扫描 apps/，
 * 因此应用统一在此处注册，避免重复加载。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Config from './utils/Config.js'
import Log from './utils/Log.js'
import { isPluginClass } from './utils/plugin-class.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appsDir = path.join(__dirname, 'apps')

if (!fs.existsSync(appsDir)) fs.mkdirSync(appsDir, { recursive: true })

const files = fs
  .readdirSync(appsDir)
  .filter(name => name.endsWith('.js') && name !== 'index.js')

let apps = {}
let skippedExports = 0

// 只把 class 交给 Yunzai（工具函数/常量等非 class 导出不外传）——详见 utils/plugin-class.js。
if (files.length) {
  const results = await Promise.allSettled(
    files.map(file => import(`./apps/${file}`)),
  )

  for (let i = 0; i < files.length; i++) {
    const res = results[i]
    if (res.status !== 'fulfilled') {
      Log.error('应用载入失败', files[i], res.reason)
      continue
    }
    for (const [key, value] of Object.entries(res.value || {})) {
      if (isPluginClass(value)) apps[key] = value
      else skippedExports++
    }
  }
  if (skippedExports) Log.debug(`[loader] 已跳过 ${skippedExports} 个非 class 导出（不作为插件类加载）`)
}

const appNames = files.map((f) => f.replace(/\.js$/i, ''))
Log.panel(`agents-plugin v${Config.version}`, [
  ['应用', `${appNames.length} 个 · ${appNames.join(' / ') || '（无）'}`],
  ['运行时', `Node ${process.version} · ${process.platform} ${process.arch}`],
  ['插件目录', Config.path.plugin],
  ['配置文件', Config.path.userConfig],
  ['数据目录', Config.path.data],
])

export { apps }
