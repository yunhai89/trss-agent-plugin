/**
 * 本地不可信代码执行面（审计 P0-1）。
 *
 * 背景：node:vm 官方明确不是安全边界；仅靠 AST 黑名单挡不住别名/计算属性/原型链逃逸。
 * 本地档必须提供**可证明的 OS 隔离**，因此这里组合两层：
 *   1. 网络命名空间隔离：`unshare -n`（不可用时 `unshare -rn`）→ 进程完全没有网络出口；
 *   2. Node 权限模型：`node --permission --allow-fs-read=<允许目录>` → 拒绝一切文件写入、
 *      越界读取、child_process、worker_threads、native addon（Node 官方对不可信代码的权限边界）。
 *
 * 两者缺一不可：缺少任一即视为“本地档隔离不可用”，调用方必须 fail-closed（拒绝执行），
 * 绝不静默降级为普通 node 子进程。E2B 沙箱档不走本模块。
 */
import { spawnSync } from 'node:child_process'

let _cached

/** 重置探测缓存（测试用） */
export function resetIsolationCache() { _cached = undefined }

function which(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8', timeout: 3000 })
  return r.status === 0 && String(r.stdout || '').trim() !== ''
}

function probeUnshare(flags) {
  try {
    const r = spawnSync('unshare', [...flags, process.execPath, '-e', 'process.exit(0)'], { timeout: 5000 })
    return r.status === 0
  } catch { return false }
}

/**
 * 探测可用的 OS 网络隔离启动器。
 * @returns {{kind:string, prefix:string[]}|null} null = 本地档隔离不可用（必须 fail-closed）
 */
export function detectIsolation() {
  if (_cached !== undefined) return _cached
  _cached = null
  if (which('unshare')) {
    if (probeUnshare(['-n'])) _cached = { kind: 'unshare', prefix: ['-n'] }
    else if (probeUnshare(['-rn'])) _cached = { kind: 'unshare-user', prefix: ['-rn'] }
  }
  return _cached
}

/**
 * 构造隔离的 Node 启动命令。
 * @param {object} p { fsReadPaths:string[], nodeFlags?:string[] }
 * @returns {{command:string,args:string[],kind:string}|null} null = 隔离不可用（fail-closed）
 */
export function isolatedNodeCommand({ fsReadPaths = [], nodeFlags = [] } = {}) {
  const iso = detectIsolation()
  if (!iso) return null
  const allow = []
  for (const p of fsReadPaths) if (p) allow.push(`--allow-fs-read=${p}`)
  const permission = ['--permission', ...allow]
  return {
    kind: iso.kind,
    command: 'unshare',
    args: [...iso.prefix, process.execPath, ...permission, ...nodeFlags],
  }
}

export default { detectIsolation, isolatedNodeCommand, resetIsolationCache }
