/**
 * transcribe_media 工具 —— 音频/视频转文字（语音识别 STT）。
 *
 * 视频先用 ffmpeg 提取音频，再调 Whisper 兼容 STT API（OpenAI/Groq/Azure 等）转录。
 * 配置：agent.stt { apiBase, apiKey, model, language }。
 *
 * 执行面（2025-10 变更）：显式选择 E2B（agent.sandbox.mode=e2b）后，ffmpeg 音频提取**在会话沙箱内执行**
 * （输入文件上传、mp3 拉回宿主再调 STT API——API Key 不进沙箱）；沙箱不可用或模板缺 ffmpeg 时结构化失败，
 * 绝不回落宿主执行。mode=off（未配置沙箱）时保持旧的宿主 ffmpeg 路径。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import Config from '../../utils/Config.js'
import { toolSandbox, sandboxSelected, sandboxUnavailableError, openToolSession, runToolCommand, missingCommand, sandboxTmp, shellQuote } from '../sandbox/bridge.js'

/** 沙箱档：输入文件上传上限（超大视频可先自行裁剪；避免无上限上传打爆沙箱磁盘） */
const SANDBOX_UPLOAD_MAX = 512 * 1024 * 1024

function _trunc(s, max = 8000) {
  const t = String(s ?? '')
  return t.length <= max ? t : t.slice(0, max) + `\n…[已截断，共 ${t.length} 字符]`
}

/** 固定 ffmpeg 提取音频的 argv（不经过 shell：文件名按字面传递，杜绝 $()/反引号命令替换）。 */
export function buildFfmpegArgs(inputPath, outputPath) {
  return ['-y', '-i', String(inputPath), '-vn', '-acodec', 'libmp3lame', '-q:a', '4', String(outputPath)]
}

/** 主机执行 ffmpeg（argv 数组 + shell:false，路径永远作为独立参数，不做任何 shell 拼接）。 */
export function runFfmpeg(args, { timeout = 180, maxOutput = 8000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile('ffmpeg', args, { timeout: (Number(timeout) || 180) * 1000, maxBuffer: (maxOutput || 8000) * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, exitCode: err ? (Number.isFinite(err.code) ? err.code : 1) : 0, stdout: _trunc(stdout, maxOutput), stderr: _trunc(stderr, maxOutput), signal: err?.signal || null, timedOut: !!(err?.killed && err?.signal === 'SIGTERM') })
      })
    } catch (e) { resolve({ ok: false, exitCode: null, stdout: '', stderr: `execFile 失败：${e?.message || e}`, signal: null }) }
  })
}

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.m4v', '.wmv'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma', '.opus'])
const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac' }

export const transcribeMediaTool = {
  name: 'transcribe_media',
  description: '转录音频/视频文件为文字（语音识别 STT）。视频自动提取音频再转录。何时用：用户发了语音/视频/音频文件，让你听内容、提取信息、总结、翻译时。',
  category: 'query',
  meta: { summary: '音视频转文字(STT)', resultCap: 8000 },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '音频/视频文件本地路径' },
    },
    required: ['path'],
  },
  async execute(params, ctx = {}) {
    const p = String(params?.path || '').trim()
    if (!p) return { error: '请提供文件路径' }
    if (p.includes('\0')) return { error: '非法路径（含空字符）' }
    const abs = path.resolve(p)
    let st = null
    try { st = fs.statSync(abs) } catch { return { error: `文件不存在：${p}` } }
    if (!st.isFile()) return { error: `不是普通文件：${p}` }

    const cfg = Config.get()?.agent?.stt || {}
    if (!cfg.apiKey) return { error: '未配置 STT（agent.stt.apiKey 为空）。请在配置里填 Whisper 兼容 API Key（OpenAI/Groq/Azure 等）。' }

    const ext = path.extname(abs).toLowerCase()
    const isVideo = VIDEO_EXTS.has(ext)
    const isAudio = AUDIO_EXTS.has(ext)
    if (!isVideo && !isAudio) return { error: `不支持的格式：${ext}（支持 ${[...VIDEO_EXTS, ...AUDIO_EXTS].join('/')}）` }

    // 视频 → 提取音频：显式选择 E2B → 沙箱档（不上宿主 shell）；否则宿主档（argv 数组，路径按字面传递）
    let audioPath = abs
    let sandboxed = false
    if (isVideo) {
      const box = toolSandbox(ctx)
      if (box) {
        const r = await extractAudioInSandbox(box, abs, { signal: ctx?.signal || null }).catch((e) => ({ error: `沙箱执行失败：${e?.message || e}` }))
        if (r.error) return r
        audioPath = r.path
        sandboxed = true
      } else if (sandboxSelected(ctx)) {
        return sandboxUnavailableError('transcribe_media（音视频转文字）')
      } else {
        const tmpDir = Config.path.temp
        fs.mkdirSync(tmpDir, { recursive: true })
        audioPath = path.join(tmpDir, `stt_${Date.now()}_${process.pid}.mp3`)
        const r = await runFfmpeg(buildFfmpegArgs(abs, audioPath), { timeout: 180 })
        if (!r.ok) return { error: `音频提取失败（ffmpeg）：${(r.stderr || '').slice(-200) || r.signal || '未知'}` }
      }
    }

    try {
      const text = await callSTT(audioPath, cfg)
      return {
        ok: true, format: isVideo ? 'video→audio→text' : 'audio→text', text: text.slice(0, 8000),
        ...(sandboxed ? { sandboxed: true } : {}),
      }
    } catch (e) {
      return { error: `STT 识别失败：${e?.message || e}` }
    } finally {
      if (audioPath !== abs) try { fs.unlinkSync(audioPath) } catch { /* noop */ }
    }
  },
}

/**
 * 沙箱档：上传输入 → 沙箱内 ffmpeg 提取 mp3 → 流式拉回宿主临时目录（STT API Key 不进沙箱）。
 * @param {object} box toolSandbox(ctx)
 * @param {string} hostPath 宿主输入文件
 * @param {{signal?:AbortSignal, hostTmpDir?:string}} [opt] hostTmpDir 缺省 Config.path.temp（测试可注入）
 * @returns {Promise<{path:string}|{error:string, missing?:string}>}
 */
export async function extractAudioInSandbox(box, hostPath, { signal = null, hostTmpDir = null } = {}) {
  const dir = sandboxTmp('stt')
  const ext = path.extname(hostPath) || '.bin'
  const remoteIn = `${dir}/in${ext}`
  const remoteOut = `${dir}/out.mp3`
  const sess = await openToolSession(box, { purpose: 'tool:transcribe_media' })
  await sess.upload(hostPath, remoteIn, { maxBytes: SANDBOX_UPLOAD_MAX })
  const cmd = `ffmpeg ${buildFfmpegArgs(remoteIn, remoteOut).map((a) => shellQuote(a)).join(' ')}`
  const r = await runToolCommand(box, sess, cmd, { timeoutMs: 180000, maxOutput: 4000, signal, label: 'transcribe_media' })
  if (r.limited) return { error: r.error }
  const miss = missingCommand('ffmpeg', r, 'transcribe_media')
  if (miss) return miss
  if (r.timedOut) return { error: '音频提取超时（沙箱内 ffmpeg >180s，可截短视频后重试）' }
  if (r.sandboxError || r.error || !r.ok) {
    return { error: `音频提取失败（沙箱内 ffmpeg）：${String(r.stderr || '').trim().slice(-200) || '未知原因'}` }
  }
  const outDir = hostTmpDir || Config.path.temp
  fs.mkdirSync(outDir, { recursive: true })
  const hostAudio = path.join(outDir, `stt_${Date.now()}_${process.pid}.mp3`)
  await sess.downloadTo(remoteOut, hostAudio, { signal })
  return { path: hostAudio }
}

/** 调用 Whisper 兼容 STT API */
async function callSTT(audioPath, cfg) {
  const buf = fs.readFileSync(audioPath)
  const ext = path.extname(audioPath).toLowerCase()
  const mime = MIME[ext] || 'audio/mpeg'

  const form = new FormData()
  form.append('file', new Blob([buf], { type: mime }), path.basename(audioPath))
  form.append('model', cfg.model || 'whisper-1')
  if (cfg.language) form.append('language', cfg.language)

  const apiBase = cfg.apiBase || 'https://api.openai.com/v1/audio/transcriptions'
  const res = await fetch(apiBase, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const data = await res.json()
  return data.text || ''
}
