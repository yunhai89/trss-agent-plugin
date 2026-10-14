/**
 * 工作流发现：列出/读取 ComfyUI 服务器上「真实存在」的工作流（用户保存在 ComfyUI 里的）。
 *
 * 数据源：ComfyUI 前端 userdata 接口（GET /userdata?dir=<dir>&recurse=true&full_info=true），
 * 默认扫 <ComfyUI>/user/default/workflows（dir 可配 agent.comfyui.workflowDir）。
 * 文件可能是前端格式（nodes/links）或 API 格式（{节点ID:{class_type,inputs}}），两种都认。
 *
 * 缓存（进程内，TTL 见 agent.comfyui.workflowCacheTtl）：
 *  - 目录列表、object_info、单文件转换结果（按 path+mtime+size 失效，改动文件后自动重取）。
 */
import { toApiGraph, isUiFormat, unwrapApi } from './convert.js'
import { analyzeGraph } from './analyze.js'

export const DEFAULT_WORKFLOW_DIR = 'workflows'
/** 单文件大小上限（防误传巨型文件占内存） */
export const MAX_WORKFLOW_BYTES = 5 * 1024 * 1024

const _lists = new Map() // host|dir → { at, entries }
const _objectInfo = new Map() // host → { at, data }
const _files = new Map() // host|path → { mtime, size, result }

const now = () => Date.now()

/** 清缓存（测试/热加载用） */
export function clearDiscoveryCache() {
  _lists.clear()
  _objectInfo.clear()
  _files.clear()
}

/** 列工作流文件（递归）；返回 [{path, name, folder, size, modified}]，path 相对 userdata 根 */
export async function listWorkflowFiles(api, { dir = DEFAULT_WORKFLOW_DIR, ttl = 300, refresh = false } = {}) {
  const key = `${api.host}|${dir}`
  const hit = _lists.get(key)
  if (!refresh && hit && now() - hit.at < ttl * 1000) return hit.entries
  const raw = await api.listUserdata(dir, { recurse: true, fullInfo: true })
  const list = Array.isArray(raw) ? raw : []
  const prefix = String(dir || '').replace(/^\/+|\/+$/g, '')
  const entries = list
    // 兼容 full_info 不被支持的旧版本（返回字符串路径数组）
    .map((f) => (typeof f === 'string' ? { path: f, size: 0, modified: 0 } : f))
    .filter((f) => f && typeof f.path === 'string' && /\.json$/i.test(f.path) && (f.size == null || f.size <= MAX_WORKFLOW_BYTES))
    .map((f) => {
      const path = f.path
      const name = path.split('/').pop()
      const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      // udPath：相对 userdata 根的路径（GET /userdata/{file} 要的是它，而非相对 dir）
      const udPath = prefix ? `${prefix}/${path}` : path
      return { path, udPath, name, folder, size: f.size || 0, modified: f.modified || 0 }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
  _lists.set(key, { at: now(), entries })
  return entries
}

/** 取 object_info（带缓存） */
export async function getObjectInfo(api, { ttl = 300, refresh = false } = {}) {
  const hit = _objectInfo.get(api.host)
  if (!refresh && hit && now() - hit.at < ttl * 1000) return hit.data
  const data = await api.objectInfo()
  if (!data || typeof data !== 'object') throw new Error('object_info 返回异常（不是对象）')
  _objectInfo.set(api.host, { at: now(), data })
  return data
}

/**
 * 读取并转换单个工作流（带缓存）。返回：
 * { ok:true, graph, analysis, format, warnings, notes, titles } | { ok:false, error }
 */
export async function loadWorkflow(api, entry, { ttl = 300, objectInfo } = {}) {
  const key = `${api.host}|${entry.path}`
  const hit = _files.get(key)
  const fresh = hit && hit.mtime === entry.modified && hit.size === entry.size && now() - hit.at < ttl * 1000
  if (fresh) return hit.result

  let raw
  try {
    const text = await api.getUserdata(entry.udPath || entry.path)
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '工作流文件为空' }
    if (Buffer.byteLength(text) > MAX_WORKFLOW_BYTES) return { ok: false, error: `工作流文件过大（>${Math.round(MAX_WORKFLOW_BYTES / 1024 / 1024)}MB）` }
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `读取工作流失败：${e?.message || e}` }
  }

  const conv = toApiGraph(raw, objectInfo)
  if (!conv.ok) return { ok: false, error: conv.error, missing: conv.missing }

  // 节点标题：UI 格式取 nodes[].title；API 格式取 _meta.title
  const titles = {}
  if (isUiFormat(raw)) {
    for (const n of raw.nodes) if (n.title) titles[String(n.id)] = String(n.title)
  } else {
    for (const [id, n] of Object.entries(unwrapApi(raw) || {})) if (n?._meta?.title) titles[String(id)] = String(n._meta.title)
  }
  const analysis = analyzeGraph(conv.prompt, { notes: conv.notes, titles })
  const result = { ok: true, graph: conv.prompt, analysis, format: conv.format, warnings: conv.warnings, notes: conv.notes, titles }
  _files.set(key, { at: now(), mtime: entry.modified, size: entry.size, result })
  return result
}

/**
 * 把用户/模型给的工作流引用解析到列表条目。
 * 支持：完整路径、文件名、去扩展名、唯一子串、列表序号（1 起）。
 * @returns {{entry}|{error:string, candidates?:string[]}}
 */
export function resolveWorkflowRef(entries, ref) {
  const s = String(ref || '').trim()
  if (!s) return { error: '缺少 workflow 参数（先用 comfyui__list_workflows 查看可用工作流）' }
  if (!entries.length) return { error: '服务器上未发现任何工作流（请先在 ComfyUI 里保存工作流，或检查 agent.comfyui.workflowDir）' }
  const low = s.toLowerCase()
  const exact = entries.find((e) => e.path.toLowerCase() === low) || entries.find((e) => e.name.toLowerCase() === low)
  if (exact) return { entry: exact }
  const noExt = (x) => x.replace(/\.json$/i, '')
  const byNoExt = entries.filter((e) => noExt(e.name).toLowerCase() === low || noExt(e.path).toLowerCase() === low)
  if (byNoExt.length === 1) return { entry: byNoExt[0] }
  if (byNoExt.length > 1) return { error: `工作流名「${s}」不唯一，请用完整路径指定`, candidates: byNoExt.map((e) => e.path) }
  const sub = entries.filter((e) => e.path.toLowerCase().includes(low))
  if (sub.length === 1) return { entry: sub[0] }
  if (sub.length > 1) return { error: `「${s}」匹配到多个工作流，请用完整路径指定`, candidates: sub.map((e) => e.path) }
  if (/^\d+$/.test(s)) {
    const i = Number(s) - 1
    if (i >= 0 && i < entries.length) return { entry: entries[i] }
  }
  return { error: `未找到工作流「${s}」`, candidates: entries.map((e) => e.path) }
}
