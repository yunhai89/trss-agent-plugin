/**
 * transcribe_media 工具 —— 音频/视频转文字（语音识别 STT）。
 *
 * 视频先用 ffmpeg 提取音频，再调 Whisper 兼容 STT API（OpenAI/Groq/Azure 等）转录。
 * 配置：agent.stt { apiBase, apiKey, model, language }。
 */

import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import Config from '../../utils/Config.js'

function shellQuote(s) { return `"${String(s).replace(/"/g, '\\"')}"` }

function _trunc(s, max = 8000) {
  const t = String(s ?? '')
  return t.length <= max ? t : t.slice(0, max) + `\n…[已截断，共 ${t.length} 字符]`
}

/** 主机执行 shell（ffmpeg 提取音频：操作主机文件，不走 terminal Docker 沙盒——容器无 ffmpeg 且看不到主机路径）。 */
function runShell(command, { cwd, timeout = 60, maxOutput = 8000 } = {}) {
  return new Promise((resolve) => {
    try {
      exec(command, { cwd: cwd || undefined, timeout: (Number(timeout) || 60) * 1000, maxBuffer: (maxOutput || 8000) * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, exitCode: err ? (Number.isFinite(err.code) ? err.code : 1) : 0, stdout: _trunc(stdout, maxOutput), stderr: _trunc(stderr, maxOutput), signal: err?.signal || null, timedOut: err?.killed && err?.signal === 'SIGTERM' })
      })
    } catch (e) { resolve({ ok: false, exitCode: null, stdout: '', stderr: `exec 失败：${e?.message || e}`, signal: null }) }
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
  async execute(params) {
    const p = String(params?.path || '').trim()
    if (!p) return { error: '请提供文件路径' }
    if (!fs.existsSync(p)) return { error: `文件不存在：${p}` }

    const cfg = Config.get()?.agent?.stt || {}
    if (!cfg.apiKey) return { error: '未配置 STT（agent.stt.apiKey 为空）。请在配置里填 Whisper 兼容 API Key（OpenAI/Groq/Azure 等）。' }

    const ext = path.extname(p).toLowerCase()
    const isVideo = VIDEO_EXTS.has(ext)
    const isAudio = AUDIO_EXTS.has(ext)
    if (!isVideo && !isAudio) return { error: `不支持的格式：${ext}（支持 ${[...VIDEO_EXTS, ...AUDIO_EXTS].join('/')}）` }

    // 视频 → 提取音频
    let audioPath = p
    if (isVideo) {
      const tmpDir = Config.path.temp
      fs.mkdirSync(tmpDir, { recursive: true })
      audioPath = path.join(tmpDir, `stt_${Date.now()}.mp3`)
      const r = await runShell(`ffmpeg -y -i ${shellQuote(p)} -vn -acodec libmp3lame -q:a 4 ${shellQuote(audioPath)}`, { timeout: 180 })
      if (!r.ok) return { error: `音频提取失败（ffmpeg）：${(r.stderr || '').slice(-200) || r.signal || '未知'}` }
    }

    try {
      const text = await callSTT(audioPath, cfg)
      return { ok: true, format: isVideo ? 'video→audio→text' : 'audio→text', text: text.slice(0, 8000) }
    } catch (e) {
      return { error: `STT 识别失败：${e?.message || e}` }
    } finally {
      if (audioPath !== p) try { fs.unlinkSync(audioPath) } catch { /* noop */ }
    }
  },
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
