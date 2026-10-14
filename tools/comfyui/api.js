/**
 * ComfyUI REST 客户端（纯传输层，无 ctx 依赖）。
 *
 * 端点（本地 + Comfy Cloud 同一面，Cloud 仅 auth/path 差异）：
 *   POST /prompt            {prompt, client_id} → {prompt_id, node_errors}
 *   GET  /history/{id}      本地状态轮询（status.status_str / status.completed）
 *   GET  /job/{id}/status   Cloud 状态轮询（pending/in_progress/completed/failed/cancelled）
 *   GET  /jobs/{id}         Cloud 完成后取完整 outputs
 *   GET  /view?filename=&subfolder=&type=   下载产物（Cloud 返 302 → 签名 URL，须剥离 X-API-Key）
 *   POST /upload/image      multipart → {name, subfolder, type}
 *   POST /upload/mask       multipart + original_ref
 *   GET  /system_stats  /object_info  /models/{folder}  /queue
 *   GET  /userdata?dir=&recurse=&full_info=   用户数据文件列表（工作流发现）
 *   GET  /userdata/{file}                     用户数据文件内容（工作流文件）
 *   POST /interrupt         取消运行中
 *
 * Cloud 路由（移植自 Hermes _common.py 的 resolve_url/cloud_endpoint）：
 *   host 是 cloud.comfy.org 或 *.comfy.org 时 → path 加 /api 前缀 +
 *   /history→/history_v2 + /models/<f>→/experiment/models/<f> + /models→/experiment/models。
 */

const DEFAULT_CLOUD_DOMAIN_EXACT = new Set(['cloud.comfy.org'])
const DEFAULT_CLOUD_DOMAIN_SUFFIX = ['.comfy.org']

/** 判定 host 是否指向 Comfy Cloud */
export function isCloudHost(host) {
  if (!host) return false
  try {
    const u = host.includes('://') ? new URL(host) : new URL(`http://${host}`)
    const h = (u.hostname || '').toLowerCase()
    if (DEFAULT_CLOUD_DOMAIN_EXACT.has(h)) return true
    return DEFAULT_CLOUD_DOMAIN_SUFFIX.some((s) => h.endsWith(s))
  } catch {
    return false
  }
}

/** Cloud 端点重命名（/history→/history_v2、/models→/experiment/models） */
function cloudEndpoint(p) {
  if (p.startsWith('/history') && !p.startsWith('/history_v2')) {
    return '/history_v2' + p.slice('/history'.length)
  }
  if (p.startsWith('/models/')) return '/experiment/models/' + p.slice('/models/'.length)
  if (p === '/models') return '/experiment/models'
  return p
}

/** 顶层 URL 解析：Cloud 时先重命名端点再加 /api 前缀 */
export function resolveUrl(base, p, cloud) {
  const c = cloud == null ? isCloudHost(base) : !!cloud
  base = String(base || '').replace(/\/+$/, '')
  if (!p.startsWith('/')) p = '/' + p
  if (c) {
    p = cloudEndpoint(p)
    if (!p.startsWith('/api/')) p = '/api' + p
  }
  return base + p
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 下载产物时按扩展名分类（决定发图还是发文件） */
export function classifyKind(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop()
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) return 'image'
  if (['mp4', 'webm', 'mkv', 'mov', 'avi'].includes(ext)) return 'video'
  if (['wav', 'mp3', 'flac', 'ogg', 'm4a'].includes(ext)) return 'audio'
  return 'file'
}

/**
 * 把 history.outputs（按节点聚合）拍平成产物列表。
 * 文件类：images/gifs/videos/audio（Cloud 为 video）；文本类：text（PreviewAny/ShowText）/ tags（WD14 Tagger）。
 * 同一段文本可能同时出现在标签节点与预览节点 → 调用方按内容去重（见 run.js）。
 */
function flattenOutputs(outputs) {
  const out = []
  for (const [nid, node] of Object.entries(outputs || {})) {
    if (!node || typeof node !== 'object') continue
    // 本地：images/gifs/videos/audio；Cloud：video（singular）
    const buckets = ['images', 'gifs', 'videos', 'audio', 'video']
    for (const bk of buckets) {
      for (const f of node[bk] || []) {
        out.push({
          filename: f.filename,
          subfolder: f.subfolder || '',
          type: f.type || 'output',
          kind: classifyKind(f.filename),
          nodeId: nid,
        })
      }
    }
    // 文本类产物（不落盘、无文件名）
    for (const bk of ['text', 'tags']) {
      const v = node[bk]
      const arr = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : [])
      const text = arr.filter((x) => typeof x === 'string' && x.trim()).join('\n').trim()
      if (text) out.push({ kind: 'text', text, nodeId: nid })
    }
  }
  return out
}

/** 从本地 history entry 的 messages 里提取 execution_error 信息 */
function extractError(entry) {
  const msgs = entry?.status?.messages || []
  for (const m of msgs) {
    if (Array.isArray(m) && m[0] === 'execution_error') {
      const d = m[1] || {}
      return { message: d.exception_message || d.exception_type || 'execution_error', nodeId: d.node_id }
    }
  }
  return { message: '生成失败（execution_error）', nodeId: null }
}

/**
 * 构造 ComfyUI 客户端。
 * @param {object} o { host, apiKey, cloud, fetcher, timeoutMs }
 */
export function newClient({ host, apiKey, cloud, fetcher, timeoutMs = 30000 } = {}) {
  const base = host || 'http://127.0.0.1:8188'
  const isCloud = cloud == null ? isCloudHost(base) : !!cloud
  const fetch = fetcher || globalThis.fetch
  if (!fetch) throw new Error('ComfyUI api 需要 fetcher（globalThis.fetch 不可用）')

  const authHeaders = () => {
    const h = {}
    if (isCloud && apiKey) h['X-API-Key'] = apiKey
    else if (apiKey) h['Authorization'] = `Bearer ${apiKey}`
    return h
  }

  async function req(path, { method = 'GET', headers, body, raw = false, redirect, timeout } = {}) {
    const url = resolveUrl(base, path, isCloud)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error('comfyui request timeout')), timeout || timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: { ...authHeaders(), ...(headers || {}) },
        body,
        signal: ctrl.signal,
        ...(redirect ? { redirect } : {}),
      })
      if (raw) return res
      const txt = await res.text()
      let data = null
      try { data = txt ? JSON.parse(txt) : null } catch { data = txt }
      return { ok: res.ok, status: res.status, data, res }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    isCloud,
    host: base,

    async systemStats() {
      const r = await req('/system_stats')
      if (!r.ok) throw new Error(`/system_stats HTTP ${r.status}`)
      return r.data
    },

    async listModels(folder = 'checkpoints') {
      const r = await req(`/models/${encodeURIComponent(folder)}`)
      if (!r.ok) throw new Error(`/models/${folder} HTTP ${r.status}`)
      return r.data
    },

    /** 节点定义表（转换前端格式工作流用；约数 MB，调用方自行缓存） */
    async objectInfo({ timeout = 60000 } = {}) {
      const r = await req('/object_info', { timeout })
      if (!r.ok) throw new Error(`/object_info HTTP ${r.status}`)
      return r.data
    },

    /**
     * 用户数据文件列表（工作流发现）。
     * @returns {Promise<Array<{path:string,size?:number,modified?:number}>>}
     */
    async listUserdata(dir, { recurse = true, fullInfo = true } = {}) {
      const q = new URLSearchParams({ dir: String(dir || ''), recurse: recurse ? 'true' : 'false', full_info: fullInfo ? 'true' : 'false' })
      const r = await req(`/userdata?${q}`)
      if (!r.ok) {
        const hint = r.status === 404 ? '（目录不存在）' : r.status === 403 ? '（路径不允许）' : ''
        throw new Error(`/userdata 列表失败 HTTP ${r.status}${hint}；该接口需 ComfyUI 较新版本（前端 1.16+）`)
      }
      return r.data
    },

    /** 用户数据文件内容（返回原始文本；工作流 JSON 由调用方解析） */
    async getUserdata(file, { timeout = 30000 } = {}) {
      // 整个相对路径编码为单个路径段（aiohttp 路由 /userdata/{file} 不匹配裸斜杠，必须 %2F）
      const res = await req(`/userdata/${encodeURIComponent(String(file))}`, { raw: true, timeout })
      if (!res.ok) throw new Error(`/userdata/${file} HTTP ${res.status}`)
      return res.text()
    },

    async interrupt() {
      return req('/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    },

    /** 提交工作流 → { prompt_id, node_errors } */
    async submit(workflow, clientId, { timeout = 30000 } = {}) {
      const body = JSON.stringify({ prompt: workflow, client_id: clientId })
      const r = await req('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeout })
      if (!r.ok) {
        const ne = r.data?.node_errors || r.data
        const err = new Error(`提交失败 HTTP ${r.status}：${typeof ne === 'string' ? ne.slice(0, 500) : JSON.stringify(ne).slice(0, 500)}`)
        err.node_errors = ne
        err.status = r.status
        throw err
      }
      return r.data // { prompt_id, number, node_errors }
    },

    /** 本地 history 单条（含 outputs + status） */
    async getHistory(id) {
      const r = await req(`/history/${encodeURIComponent(id)}`)
      if (!r.ok) return null
      return r.data // { <prompt_id>: { outputs, status } }
    },

    /** 上传输入图 → { name, subfolder, type }（server 端文件名） */
    async uploadImage(buffer, filename, type = 'input', { timeout = 60000 } = {}) {
      const form = new FormData()
      form.append('image', new Blob([buffer]), filename)
      form.append('type', type)
      // overwrite=true 覆盖同名，避免重传冲突
      form.append('overwrite', 'true')
      const r = await req('/upload/image', { method: 'POST', body: form, timeout })
      if (!r.ok || !r.data?.name) throw new Error(`上传图片失败 HTTP ${r.status}：${typeof r.data === 'string' ? r.data.slice(0, 200) : JSON.stringify(r.data).slice(0, 200)}`)
      return r.data
    },

    /** 上传蒙版（关联到已上传的源图 originalRef={filename,subfolder,type}） */
    async uploadMask(buffer, filename, originalRef, { timeout = 60000 } = {}) {
      const form = new FormData()
      form.append('image', new Blob([buffer]), filename)
      form.append('original_ref', JSON.stringify(originalRef))
      form.append('overwrite', 'true')
      const r = await req('/upload/mask', { method: 'POST', body: form, timeout })
      if (!r.ok || !r.data?.name) throw new Error(`上传蒙版失败 HTTP ${r.status}`)
      return r.data
    },

    /** 下载产物 → Buffer。Cloud /view 返 302 → 手动跟随并剥离 X-API-Key（防泄露给签名 URL 域） */
    async downloadOutput({ filename, subfolder = '', type = 'output' }, { timeout = 120000 } = {}) {
      const q = new URLSearchParams({ filename, subfolder, type }).toString()
      const url = resolveUrl(base, `/view?${q}`, isCloud)
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(new Error('download timeout')), timeout)
      try {
        let res = await fetch(url, { method: 'GET', headers: authHeaders(), signal: ctrl.signal, redirect: 'manual' })
        // 手动跟随 3xx（Cloud /view → 签名 S3 URL）：跨域时不带认证头
        let hops = 0
        while ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location') && hops < 5) {
          const loc = res.headers.get('location')
          const nextUrl = new URL(loc, url).href
          const sameHost = new URL(nextUrl).hostname === new URL(url).hostname
          const nextHeaders = sameHost ? authHeaders() : {}
          res = await fetch(nextUrl, { method: 'GET', headers: nextHeaders, signal: ctrl.signal, redirect: 'manual' })
          hops++
        }
        if (!res.ok) throw new Error(`/view HTTP ${res.status}`)
        const ab = await res.arrayBuffer()
        return Buffer.from(ab)
      } finally {
        clearTimeout(timer)
      }
    },

    /**
     * 轮询直到完成/失败/超时。
     * @returns { status:'success'|'error'|'timeout'|'cancelled', outputs?, message?, nodeId? }
     */
    async pollStatus(promptId, { onProgress, timeout = 300, interval = 1.5, maxInterval = 8 } = {}) {
      const deadline = Date.now() + timeout * 1000
      let delay = interval * 1000
      while (Date.now() < deadline) {
        await sleep(delay)
        delay = Math.min(delay * 1.5, maxInterval * 1000)
        try {
          if (isCloud) {
            const r = await req(`/job/${encodeURIComponent(promptId)}/status`, { timeout: 15000 })
            if (r.ok && r.data) {
              const st = r.data.status || r.data.state || r.data
              const s = typeof st === 'string' ? st : (st.status || st.state || '')
              if (typeof onProgress === 'function') onProgress({ source: 'cloud', status: s, raw: r.data })
              if (s === 'completed' || s === 'success') {
                const j = await req(`/jobs/${encodeURIComponent(promptId)}`, { timeout: 30000 })
                const outputs = j.ok ? flattenOutputs(j.data?.outputs || j.data?.result?.outputs) : []
                return { status: 'success', outputs }
              }
              if (s === 'failed' || s === 'error') return { status: 'error', message: r.data?.error || 'cloud job failed' }
              if (s === 'cancelled' || s === 'canceled') return { status: 'cancelled' }
            }
          } else {
            const hist = await this.getHistory(promptId)
            const entry = hist?.[promptId]
            if (entry) {
              const st = entry.status || {}
              if (typeof onProgress === 'function' && st.messages) onProgress({ source: 'local', status: st.status_str, raw: st })
              if (st.status_str === 'error') {
                const e = extractError(entry)
                return { status: 'error', message: e.message, nodeId: e.nodeId }
              }
              if (st.completed || st.status_str === 'success') {
                return { status: 'success', outputs: flattenOutputs(entry.outputs) }
              }
            }
          }
        } catch (e) {
          // 单次轮询网络抖动 → 继续等（除非已过 deadline）
          if (typeof onProgress === 'function') onProgress({ source: 'poll', error: e?.message || String(e) })
        }
      }
      return { status: 'timeout' }
    },
  }
}
