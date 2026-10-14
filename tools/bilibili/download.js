/**
 * 哔哩哔哩媒体下载。
 *
 * - 视频（高分辨率）：走 dash 分轨（video + audio），用 ffmpeg `-c copy` 合并为 mp4/mkv。
 *   分辨率按请求 qn 选轨；账号拿不到的高码（大会员档）自动回退到可用的最高档并标注。
 * - 视频（回退）：无 ffmpeg 或无 dash 时走 playurl durl（**已合并** MP4，无需合并，匿名通常 360P）。
 * - 音频：dash 的 audio 轨（m4a）单独下载，供 STT 转录或当音频文件发送。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile, spawnSync } from 'node:child_process'
import Config from '../../utils/Config.js'
import { getPlayInfo, pickBestAudio, pickBestDurl, BiliError } from './api.js'
import { defaultHeaders, pickClosestQuality } from './util.js'

const DOWNLOAD_TIMEOUT_MS = 120000
const MERGE_TIMEOUT_MS = 180000

function safeName(s) {
  return String(s || 'bilibili').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
}

function outDir(cfg = {}) {
  const dir = cfg.dir || path.join(Config.path.temp, 'bilibili')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

let _ffmpegOk = null
/** ffmpeg 是否可用（dash 分轨合并依赖；缺失则回退 durl）。结果缓存。 */
export function ffmpegAvailable() {
  if (_ffmpegOk != null) return _ffmpegOk
  try { _ffmpegOk = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0 }
  catch { _ffmpegOk = false }
  return _ffmpegOk
}

/** 运行 ffmpeg（argv 数组 + shell:false，文件名按字面传递，无命令注入面） */
function runFfmpeg(args, timeoutMs = MERGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) return reject(new BiliError(`ffmpeg 合并失败：${String(stderr || err.message).trim().slice(-300)}`, { kind: 'http' }))
      resolve()
    })
  })
}

/** 流式下载 URL 到本地文件（带 Referer/Cookie，防 CDN 403） */
export async function downloadToFile(url, destPath, { fetcher, cookie, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const f = fetcher || globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await f(url, { headers: defaultHeaders(cookie), signal: controller.signal })
    if (!res.ok || !res.body) throw new BiliError(`下载失败 HTTP ${res.status}`, { kind: 'http' })
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath))
    const size = fs.statSync(destPath).size
    return { path: destPath, size }
  } catch (e) {
    try { fs.rmSync(destPath, { force: true }) } catch { /* noop */ }
    if (e?.name === 'AbortError') throw new BiliError(`下载超时（${Math.round(timeoutMs / 1000)}s）`, { kind: 'http' })
    throw e
  } finally { clearTimeout(timer) }
}

/** 从 dash.video 选轨：优先请求分辨率（取不到则最高可用），同分辨率按 codec 兼容度 + 码率排序 */
export function pickVideoTrack(tracks, qn = 0, codec = 'auto') {
  const arr = (Array.isArray(tracks) ? tracks : []).filter((t) => t?.baseUrl)
  if (!arr.length) return null
  const sel = pickClosestQuality(arr.map((t) => Number(t.id)), qn)
  const cand = arr.filter((t) => Number(t.id) === sel)
  const pool = cand.length ? cand : arr
  const rank = (c) => {
    const s = String(c || '').toLowerCase()
    const isAvc = /^avc/.test(s), isHevc = /^hev|^hvc/.test(s), isAv1 = /^av01/.test(s)
    if (codec === 'avc') return isAvc ? 0 : isHevc ? 1 : 2
    if (codec === 'hevc') return isHevc ? 0 : isAvc ? 1 : 2
    if (codec === 'av1') return isAv1 ? 0 : 2
    return isAvc ? 0 : isHevc ? 1 : isAv1 ? 2 : 3 // auto：avc 兼容最好
  }
  return [...pool].sort((a, b) => rank(a.codecs) - rank(b.codecs) || (b.bandwidth || 0) - (a.bandwidth || 0))[0]
}

/**
 * 下载视频。
 * @param {object} o { bvid, cid, title }
 * @param {object} opts { quality(qn), format('mp4'|'mkv'), codec, ... }
 * @returns {{ path, size, kind, ext, quality, requestedQuality, downgraded, via:'dash'|'durl' }}
 */
export async function downloadVideo({ bvid, cid, title }, opts = {}) {
  const requested = Number(opts.quality) || 0
  const info = await getPlayInfo({ bvid, cid, qn: requested }, opts)
  const dashVideo = Array.isArray(info.dash?.video) ? info.dash.video : []
  const dashAudio = Array.isArray(info.dash?.audio) ? info.dash.audio : []
  const ext = opts.format === 'mkv' ? 'mkv' : 'mp4'
  const durlBest = Number(info.quality) || 0
  const dashBest = dashVideo.length ? pickClosestQuality(dashVideo.map((t) => Number(t.id)), requested) : 0

  // 1) dash 分轨 + ffmpeg 合并——仅当 dash 能给出比 durl 更高的清晰度时才走：
  //    匿名场景 dash 常被限到 480P，而 durl 可给 720P，此时用 durl 反而更清晰且无需合并。
  if (ffmpegAvailable() && dashBest > 0 && dashAudio.length && dashBest > durlBest) {
    const track = pickVideoTrack(dashVideo, requested, opts.codec)
    const audio = pickBestAudio(info.dash)
    if (track?.baseUrl && audio?.baseUrl) {
      const dest = path.join(outDir(opts.cfg), `${safeName(title)}_${bvid}_${track.id}.${ext}`)
      const vtmp = `${dest}.v.m4s`
      const atmp = `${dest}.a.m4s`
      try {
        await downloadToFile(track.baseUrl, vtmp, opts)
        await downloadToFile(audio.baseUrl, atmp, opts)
        await runFfmpeg(['-y', '-i', vtmp, '-i', atmp, '-c', 'copy', dest])
        const size = fs.statSync(dest).size
        const got = Number(track.id)
        return {
          path: dest, size, kind: 'video', ext, via: 'dash',
          quality: got, requestedQuality: requested, downgraded: requested > 0 && got < requested,
        }
      } finally {
        try { fs.rmSync(vtmp, { force: true }) } catch { /* noop */ }
        try { fs.rmSync(atmp, { force: true }) } catch { /* noop */ }
      }
    }
  }

  // 2) 回退：durl 已合并 MP4（无需 ffmpeg）
  const d = pickBestDurl(info.durl)
  if (!d?.url) throw new BiliError('未取到可下载的视频流（durl 为空，可能需登录或该视频受限）', { kind: 'need_login' })
  const dest = path.join(outDir(opts.cfg), `${safeName(title)}_${bvid}.mp4`)
  const r = await downloadToFile(d.url, dest, opts)
  const got = Number(info.quality) || 0
  return {
    ...r, kind: 'video', ext: 'mp4', via: 'durl',
    quality: got, requestedQuality: requested, downgraded: requested > 0 && got > 0 && got < requested,
  }
}

/** 下载最优 dash 音频（m4a） */
export async function downloadAudio({ bvid, cid, title }, opts = {}) {
  const info = await getPlayInfo({ bvid, cid }, opts)
  const a = pickBestAudio(info.dash)
  if (!a?.baseUrl) throw new BiliError('未取到可下载的音频流（dash.audio 为空）', { kind: 'need_login' })
  const dest = path.join(outDir(opts.cfg), `${safeName(title)}_${bvid}.m4a`)
  const r = await downloadToFile(a.baseUrl, dest, opts)
  return { ...r, audioId: a.id, kind: 'audio', ext: 'm4a', via: 'dash' }
}
