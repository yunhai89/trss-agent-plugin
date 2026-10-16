/**
 * 群文件管理工具（内置）—— NapCat 原生群文件 CRUD。
 *
 * 覆盖：上传/删除文件、创建/删除文件夹、列目录、取直链、移动、重命名、跨群转发。
 * 与 media/tool.js 的 list_group_files/get_group_file（基于 g.fs 封装）互补：
 * 本组走 e.bot.sendApi 原生动作，能力更全（移动/重命名/跨群/直链等）。
 *
 * 【按名解析】所有需要 id 的工具同时接受 name：模型说"把 a.xlsx 移到 报告 文件夹"
 * 即可，工具内部自动 list 根目录把 name→id 解析掉，无需模型先精确查 id
 * （从根上消除"拿不到 id 就放弃/编借口"的失败模式）。
 *
 * RBAC：读类 query；建文件夹/移动/重命名/上传/转发 group_manage（群管）；
 *      删文件/删文件夹 system（master，destructive）。删除/上传标 interactive 确保顺序确认。
 */

import { defineTool, param, groupIdOf, groupScopeError, sendApi } from '../toolkit/index.js'

function needGid(ctx, groupId) {
  // 群号归属：在群里只能操作本群（防跨群删文件/改文件名）
  const scopeErr = groupScopeError(ctx, groupId)
  if (scopeErr) return { error: scopeErr }
  return groupIdOf(ctx, groupId) || null
}

/** 归一化群文件系统返回的 files/folders（OneBot 各端字段不一） */
function normFs(data) {
  const files = [].concat(data?.files || []).map((f) => ({
    fileId: f.file_id || f.id || f.fid || null,
    name: f.file_name || f.name || f.fileName || null,
    size: f.file_size || f.size ? Number(f.file_size || f.size) : null,
    busid: f.busid ?? null,
    pid: f.parent_directory || f.pid || null,
  })).filter((x) => x.fileId || x.name)
  const folders = [].concat(data?.folders || data?.directory || []).map((d) => ({
    folderId: d.folder_id || d.dir_id || d.id || null,
    name: d.folder_name || d.dir_name || d.name || null,
    pid: d.parent_directory || d.pid || null,
  })).filter((x) => x.folderId || x.name)
  return { files, folders }
}

/** 拉根目录文件系统（name→id 自动解析用；单次工具调用内通常拉一次） */
async function fetchRoot(ctx, gid) {
  const r = await sendApi(ctx, 'get_group_root_files', { group_id: gid })
  if (!r.ok) return { files: [], folders: [], _error: r.error }
  return normFs(r.data || {})
}

/** 按 id 或 name(精确→包含模糊)定位文件 → {fileId, busid, name}；找不到返回 null。
 *  仅给 fileId（不在根目录）时直传 id + 调用方给的 busid。 */
function findFile(fs, { fileId, fileName, busid }) {
  let f = null
  if (fileId) f = fs.files.find((x) => String(x.fileId) === String(fileId))
  if (!f && fileName) {
    const n = String(fileName)
    f = fs.files.find((x) => x.name === n) || fs.files.find((x) => x.name && x.name.includes(n))
  }
  if (!f && fileId) return { fileId: String(fileId), busid: busid != null ? Number(busid) : null, name: null }
  return f || null
}

/** 按 id 或 name 定位文件夹 → {folderId, name}；找不到返回 null */
function findFolder(fs, { folderId, folderName }) {
  if (folderId != null && folderId !== '') return fs.folders.find((x) => String(x.folderId) === String(folderId)) || { folderId: String(folderId), name: null }
  if (folderName) {
    const n = String(folderName)
    return fs.folders.find((x) => x.name === n) || fs.folders.find((x) => x.name && x.name.includes(n)) || null
  }
  return null
}

/** upload_group_file：上传文件到群文件（可指定目标文件夹） */
export const uploadGroupFileTool = defineTool({
  name: 'upload_group_file',
  description: '上传文件到群文件系统。file 支持本地路径/URL/base64。可选 folder（文件夹 id）或 folderName（按名解析）指定目标文件夹。',
  category: 'group_manage',
  meta: { summary: '上传群文件', interactive: true },
  parameters: param.object({
    file: param.str('文件路径、URL 或 base64:// 编码'),
    name: param.str('上传后的文件名（含扩展名）'),
    folder: param.str('目标文件夹 id（可选，默认根目录）'),
    folderName: param.str('目标文件夹名（可选，自动解析为 id）'),
    groupId: param.str('群号（可选，默认当前群）'),
  }, ['file', 'name']),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    if (gid?.error) return gid
    if (!gid) return { error: '当前非群聊且未指定 groupId' }
    let folder = p.folder || null
    if (!folder && p.folderName) {
      const fs = await fetchRoot(ctx, gid)
      if (fs._error) return { error: '解析目标文件夹失败：' + fs._error }
      const f = findFolder(fs, { folderName: p.folderName })
      if (!f?.folderId) return { error: `未找到目标文件夹：${p.folderName}`, availableFolders: fs.folders.map((x) => x.name) }
      folder = String(f.folderId)
    }
    const r = await sendApi(ctx, 'upload_group_file', {
      group_id: gid, file: String(p.file), name: String(p.name),
      ...(folder ? { folder: String(folder) } : {}),
    })
    if (!r.ok) return { error: r.error }
    return { ok: true, groupId: gid, uploaded: p.name }
  },
})

/** delete_group_file：删除群文件（按 id 或 name） */
export const deleteGroupFileTool = defineTool({
  name: 'delete_group_file',
  description: '删除群文件。可传 fileId+busid，或传 fileName 自动解析（busid 一并取到）。需 master，destructive，会审批。',
  category: 'system',
  meta: { summary: '删除群文件', interactive: true },
  parameters: param.object({
    fileId: param.str('文件 id（与 fileName 二选一）'),
    fileName: param.str('文件名（自动解析为 id+busid，与 fileId 二选一）'),
    busid: param.int('文件 busid（fileName 解析时自动取；手填 fileId 时可能需要）'),
    groupId: param.str('群号（可选，默认当前群）'),
  }),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    if (gid?.error) return gid
    if (!gid) return { error: '当前非群聊且未指定 groupId' }
    if (!p.fileId && !p.fileName) return { error: '需提供 fileId 或 fileName' }
    const fs = await fetchRoot(ctx, gid)
    if (fs._error) return { error: '解析文件失败：' + fs._error }
    const file = findFile(fs, p)
    if (!file?.fileId) return { error: `未找到文件：${p.fileName || p.fileId}`, available: fs.files.map((x) => `${x.name}(${x.fileId})`) }
    const busid = file.busid != null ? file.busid : (p.busid != null ? Number(p.busid) : null)
    const r = await sendApi(ctx, 'delete_group_file', {
      group_id: gid, file_id: String(file.fileId),
      ...(busid != null ? { busid } : {}),
    })
    if (!r.ok) return { error: r.error }
    return { ok: true, groupId: gid, file: file.name || file.fileId, deleted: true }
  },
})

/** create_group_folder：创建群文件文件夹 */
export const createGroupFolderTool = defineTool({
  name: 'create_group_folder',
  description: '在群文件根目录创建新文件夹。',
  category: 'group_manage',
  meta: { summary: '建群文件文件夹' },
  parameters: param.object({
    name: param.str('文件夹名称'),
    groupId: param.str('群号（可选，默认当前群）'),
  }, ['name']),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    if (gid?.error) return gid
    if (!gid) return { error: '当前非群聊且未指定 groupId' }
    const r = await sendApi(ctx, 'create_group_file_folder', { group_id: gid, name: String(p.name) })
    if (!r.ok) return { error: r.error }
    return { ok: true, groupId: gid, folder: p.name }
  },
})

/** delete_group_folder：删除群文件文件夹（按 id 或 name） */
export const deleteGroupFolderTool = defineTool({
  name: 'delete_group_folder',
  description: '删除群文件中的文件夹。可传 folderId 或 folderName（自动解析）。需 master，destructive，会审批。',
  category: 'system',
  meta: { summary: '删群文件文件夹', interactive: true },
  parameters: param.object({
    folderId: param.str('文件夹 id（与 folderName 二选一）'),
    folderName: param.str('文件夹名（自动解析为 id，与 folderId 二选一）'),
    groupId: param.str('群号（可选，默认当前群）'),
  }),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    if (gid?.error) return gid
    if (!gid) return { error: '当前非群聊且未指定 groupId' }
    if (!p.folderId && !p.folderName) return { error: '需提供 folderId 或 folderName' }
    const fs = await fetchRoot(ctx, gid)
    if (fs._error) return { error: '解析文件夹失败：' + fs._error }
    const folder = findFolder(fs, p)
    if (!folder?.folderId) return { error: `未找到文件夹：${p.folderName || p.folderId}`, availableFolders: fs.folders.map((x) => x.name) }
    const r = await sendApi(ctx, 'delete_group_folder', { group_id: gid, folder_id: String(folder.folderId) })
    if (!r.ok) return { error: r.error }
    return { ok: true, groupId: gid, folder: folder.name || folder.folderId, deleted: true }
  },
})

/** list_group_folder：列群文件目录（群文件操作的入口，先调它取 id） */
export const listGroupFolderTool = defineTool({
  name: 'list_group_folder',
  description: '【群文件操作入口】列出群文件目录内容（文件+文件夹，含 fileId/folderId/busid）。不传 folderId 列根目录。移动/删除/重命名/取直链前若没有 id，先调本工具。',
  category: 'query',
  meta: { summary: '列群文件目录', resultCap: 8000 },
  parameters: param.object({
    folderId: param.str('文件夹 id（可选，默认根目录）'),
    groupId: param.str('群号（可选，默认当前群）'),
  }),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    if (gid?.error) return gid
    if (!gid) return { error: '当前非群聊且未指定 groupId' }
    const action = p.folderId ? 'get_group_files_by_folder' : 'get_group_root_files'
    const r = await sendApi(ctx, action, p.folderId ? { group_id: gid, folder_id: String(p.folderId) } : { group_id: gid })
    if (!r.ok) return { error: r.error }
    const { files, folders } = normFs(r.data || {})
    return { ok: true, groupId: gid, scope: p.folderId ? 'subfolder' : 'root', folderId: p.folderId || null, fileCount: files.length, folderCount: folders.length, files, folders }
  },
})

/** get_group_file_url：取群文件下载直链（按 id 或 name） */
export const getGroupFileUrlTool = defineTool({
  name: 'get_group_file_url',
  description: '获取群文件的下载直链。可传 fileId+busid，或传 fileName 自动解析。',
  category: 'query',
  meta: { summary: '取群文件直链' },
  parameters: param.object({
    fileId: param.str('文件 id（与 fileName 二选一）'),
    fileName: param.str('文件名（自动解析为 id+busid，与 fileId 二选一）'),
    busid: param.int('文件 busid（fileName 解析时自动取）'),
    groupId: param.str('群号（可选，默认当前群）'),
  }),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    if (gid?.error) return gid
    if (!gid) return { error: '当前非群聊且未指定 groupId' }
    if (!p.fileId && !p.fileName) return { error: '需提供 fileId 或 fileName' }
    const fs = await fetchRoot(ctx, gid)
    if (fs._error) return { error: '解析文件失败：' + fs._error }
    const file = findFile(fs, p)
    if (!file?.fileId) return { error: `未找到文件：${p.fileName || p.fileId}`, available: fs.files.map((x) => x.name) }
    const busid = file.busid != null ? file.busid : (p.busid != null ? Number(p.busid) : null)
    const r = await sendApi(ctx, 'get_group_file_url', {
      group_id: gid, file_id: String(file.fileId),
      ...(busid != null ? { busid } : {}),
    })
    if (!r.ok) return { error: r.error }
    return { ok: true, groupId: gid, file: file.name || file.fileId, url: r.data?.url || r.data || null }
  },
})

/** move_group_file：移动群文件（按 id 或 name） */
export const moveGroupFileTool = defineTool({
  name: 'move_group_file',
  description: '把群文件移动到另一个文件夹。可传 fileId+targetDir（精确），或传 fileName+targetFolderName（自动按名解析为 id）。移到根目录则目标留空。例：把"a.xlsx"移到"报告"文件夹。',
  category: 'group_manage',
  meta: { summary: '移动群文件' },
  parameters: param.object({
    fileId: param.str('文件 id（与 fileName 二选一）'),
    fileName: param.str('文件名（自动解析为 id，与 fileId 二选一）'),
    targetDir: param.str('目标文件夹 id（与 targetFolderName 二选一；根目录留空）'),
    targetFolderName: param.str('目标文件夹名（自动解析；移到根目录留空）'),
    groupId: param.str('群号（可选，默认当前群）'),
  }),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    if (gid?.error) return gid
    if (!gid) return { error: '当前非群聊且未指定 groupId' }
    if (!p.fileId && !p.fileName) return { error: '需提供 fileId 或 fileName（要移动哪个文件）' }
    const fs = await fetchRoot(ctx, gid)
    if (fs._error) return { error: '解析文件失败：' + fs._error }
    const file = findFile(fs, p)
    if (!file?.fileId) return { error: `未找到文件：${p.fileName || p.fileId}`, available: fs.files.map((x) => x.name) }
    // 目标目录：显式 targetDir > targetFolderName 解析 > 根目录('')
    let targetDir = ''
    if (p.targetDir) targetDir = String(p.targetDir)
    else if (p.targetFolderName) {
      const folder = findFolder(fs, { folderName: p.targetFolderName })
      if (!folder?.folderId) return { error: `未找到目标文件夹：${p.targetFolderName}`, availableFolders: fs.folders.map((x) => x.name) }
      targetDir = String(folder.folderId)
    }
    // napcat move_group_file 实际要 current_parent_directory(文件当前目录) + target_parent_directory(目标)；根目录用 "/"
    // （查 napcat.mjs DTO 确认，不是 folder_id/target_dir；仓库 napcat-api-doc.md 记的是错字段名）
    const r = await sendApi(ctx, 'move_group_file', {
      group_id: gid,
      file_id: String(file.fileId),
      current_parent_directory: String(file.pid || '/'),
      target_parent_directory: String(targetDir || '/'),
    })
    if (!r.ok) return { error: `移动失败：${r.error}`, napcat: r.raw }
    return { ok: true, groupId: gid, file: file.name || file.fileId, movedTo: p.targetFolderName || (targetDir || '根目录') }
  },
})

/** rename_group_file：重命名群文件（按 id 或 name） */
export const renameGroupFileTool = defineTool({
  name: 'rename_group_file',
  description: '重命名群文件。可传 fileId 或 fileName（自动解析），newName 为新文件名。',
  category: 'group_manage',
  meta: { summary: '重命名群文件' },
  parameters: param.object({
    fileId: param.str('文件 id（与 fileName 二选一）'),
    fileName: param.str('文件名（自动解析为 id，与 fileId 二选一）'),
    newName: param.str('新文件名'),
    currentParentDirectory: param.str('当前所在文件夹 id（根目录留空，可选）'),
    groupId: param.str('群号（可选，默认当前群）'),
  }, ['newName']),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    if (gid?.error) return gid
    if (!gid) return { error: '当前非群聊且未指定 groupId' }
    if (!p.fileId && !p.fileName) return { error: '需提供 fileId 或 fileName' }
    const fs = await fetchRoot(ctx, gid)
    if (fs._error) return { error: '解析文件失败：' + fs._error }
    const file = findFile(fs, p)
    if (!file?.fileId) return { error: `未找到文件：${p.fileName || p.fileId}`, available: fs.files.map((x) => x.name) }
    const r = await sendApi(ctx, 'rename_group_file', {
      group_id: gid, file_id: String(file.fileId),
      new_name: String(p.newName),
      current_parent_directory: String(p.currentParentDirectory || ''),
    })
    if (!r.ok) return { error: r.error }
    return { ok: true, groupId: gid, file: file.name || file.fileId, renamedTo: p.newName }
  },
})

/** transfer_group_file：把群文件转发到另一个群（按 id 或 name） */
export const transferGroupFileTool = defineTool({
  name: 'transfer_group_file',
  description: '把本群文件转发到另一个群。可传 fileId 或 fileName（自动解析），targetGroupId 为目标群号。',
  category: 'group_manage',
  meta: { summary: '跨群转发群文件' },
  parameters: param.object({
    fileId: param.str('文件 id（与 fileName 二选一）'),
    fileName: param.str('文件名（自动解析为 id，与 fileId 二选一）'),
    targetGroupId: param.str('目标群号'),
    groupId: param.str('源群号（可选，默认当前群）'),
  }, ['targetGroupId']),
  async execute(p, ctx) {
    const gid = needGid(ctx, p.groupId)
    if (gid?.error) return gid
    if (!gid) return { error: '当前非群聊且未指定 groupId' }
    if (!p.fileId && !p.fileName) return { error: '需提供 fileId 或 fileName' }
    const fs = await fetchRoot(ctx, gid)
    if (fs._error) return { error: '解析文件失败：' + fs._error }
    const file = findFile(fs, p)
    if (!file?.fileId) return { error: `未找到文件：${p.fileName || p.fileId}`, available: fs.files.map((x) => x.name) }
    // 修 2026-10-17 审计：targetGroupId 原先不做任何校验（needGid 只校验源群），
    // 而 group_manage 对群管自动放行 → 任意群管可把本群文件写进任意其它群。
    // 现要求：目标群必须是纯数字群号；与本群不同则仅主人（ctx.isMaster）可操作。
    const target = String(p.targetGroupId ?? '').trim()
    if (!/^\d{1,20}$/.test(target)) {
      return { error: `目标群号非法：${p.targetGroupId}（应为纯数字群号）` }
    }
    if (target !== String(gid) && ctx?.isMaster !== true) {
      return { error: `跨群转移文件需要主人操作：当前群 ${gid} → 目标群 ${target}（非主人只能在本群内转移）` }
    }
    const r = await sendApi(ctx, 'trans_group_file', {
      group_id: gid, file_id: String(file.fileId), target_group_id: target,
    })
    if (!r.ok) return { error: r.error }
    return { ok: true, fromGroup: gid, toGroup: target, file: file.name || file.fileId, transferred: true }
  },
})

export const groupFileTools = [
  uploadGroupFileTool, deleteGroupFileTool, createGroupFolderTool, deleteGroupFolderTool,
  listGroupFolderTool, getGroupFileUrlTool, moveGroupFileTool, renameGroupFileTool, transferGroupFileTool,
]
