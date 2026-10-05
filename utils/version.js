/**
 * 版本号单一来源 —— 从 package.json 读取，避免各处硬编码漂移。
 *
 * 版本约定（详见 AGENTS.md「版本管理」）：
 *  - bug 修复：patch +1（1.0.0 → 1.0.1 … 最多 1.0.99）
 *  - 新功能：minor +1（1.0.x → 1.1.0 … 最多 1.99.0），超过进位到 major
 *  - 每次发版只需改 package.json 的 version，其余引用本模块自动同步。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))

export const VERSION = pkg.version
export default VERSION
