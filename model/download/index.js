/**
 * web_download —— 基于 yt-dlp 的视频/媒体下载工具（受约束，master 限定）。
 *
 * 为什么需要它：下载视频/媒体时，LLM 若没有专用工具会去抓 terminal 裸 shell（不安全、且 curl/wget
 * 下不动需要解析的真实视频站）。本工具封装 yt-dlp（支持 1000+ 站点），给 LLM 一个趁手且受约束的入口。
 * 与 terminal 的区别：不接受任意命令，只接受 URL + 格式；输出到固定临时目录；大小/超时硬上限；
 * 下完自动发聊天并清理。category:'system' → 仅框架主人可用。
 *
 * 安全约束（代码层）：
 *   ① 仅 http(s) URL（拒绝 file:// / 本地路径 / 非 http 协议）；
 *   ② 输出到 per-call 临时子目录（无路径穿越）；
 *   ③ --no-playlist（不抓整个播放列表）+ --max-filesize（超限中止）+ 超时 SIGKILL；
 *   ④ spawn 用参数数组（不经 shell，URL/format 无注入面）；
 *   ⑤ 大文件不发（超 sendLimitBytes 只返回本地路径，供 SFTP 取，不塞 QQ）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Config from '../../utils/Config.js'
import { toFileSegment } from '../../utils/SendFile.js'
import Log from '../../utils/Log.js'

const MB = 1024 * 1024

function trunc(s, max) {
  const t = String(s == null ? '' : s)
  return t.length <= max ? t : t.slice(0, max) + `\n…[已截断，共 ${t.length} 字符]`
}

/**
 * 用 yt-dlp 下载。返回 { ok, files:[abs], stderr, durationMs, timedOut? }。
 * files 为输出目录里本次产出的文件（按 mtime 排序）。
 */
export async function runYtDlp(url, opts = {}) {
  const {
    dir,
    format = 'best[ext=mp4]/best',
    audioOnly = false,
    maxBytes = 600 * MB,       // --max-filesize 上限（yt-dlp 超过则中止该文件）
    timeoutSec = 600,
    extraArgs = [],
    ytDlpBin = 'yt-dlp',
    mergeFormat = 'mp4',
  } = opts

  fs.mkdirSync(dir, { recursive: true })
  const outTmpl = path.join(dir, '%(title).80B.%(ext)s')
  const args = [
    '--no-playlist', '--no-cache-dir', '--no-warnings', '--newline',
    '--retries', '3', '--socket-timeout', '30',
    '--max-filesize', String(Math.floor(maxBytes)),
    '-o', outTmpl,
  ]
  if (audioOnly) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '5')
  } else {
    args.push('-f', format)
    if (mergeFormat) args.push('--merge-output-format', mergeFormat)
  }
  args.push(...extraArgs, url)

  const t0 = Date.now()
  const ms = Math.min(Math.max(30, Number(timeoutSec) || 600), 1800) * 1000
  return new Promise((resolve) => {
    let stderr = ''
    let proc
    const done = (r) => {
      try {
        const files = fs.readdirSync(dir).map((n) => path.join(dir, n)).filter((p) => fs.statSync(p).isFile())
        files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
        resolve({ ...r, files, stderr: trunc(stderr, 4000), durationMs: Date.now() - t0 })
      } catch (e) {
        resolve({ ...r, files: [], stderr: trunc(stderr + '\n' + (e?.message || ''), 4000), durationMs: Date.now() - t0 })
      }
    }
    try {
      proc = spawn(ytDlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return done({ ok: false, error: String(e?.message || e) })
    }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* noop */ } }, ms)
    proc.stdout?.on('data', () => {}) // 进度行不累积（省内存）
    proc.stderr?.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: String(e?.message || e) }) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      done({ ok: code === 0, exitCode: code, timedOut: false })
    })
    // 超时分支
    setTimeout(() => { try { if (!proc.killed) proc.kill('SIGKILL') } catch { /* noop */ } ; done({ ok: false, timedOut: true }) }, ms + 500)
  })
}

/**
 * 构造 web_download 工具。
 * ctx.download = { dir?, maxBytes?, maxTimeoutSec?, sendLimitBytes?, ytDlpBin? }（可被 config 覆盖）
 */
export function makeDownloadTool({ ytDlpBin } = {}) {
  return {
    name: 'web_download',
    description: '从网站下载视频/音频/媒体文件（基于 yt-dlp，支持 YouTube/B站/抖音/西瓜/微博 等 1000+ 站点）。需要下载视频时优先用本工具，不要用 terminal 跑 curl/wget/yt-dlp。下完会自动把文件发到当前会话并清理临时文件。仅主人可用。',
    category: 'system',
    meta: { interactive: true, resultCap: 6000 },
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: '视频/媒体页面的 URL（http/https）' },
        audioOnly: { type: 'boolean', description: '只要音频（提取为 mp3）。默认 false（下载视频）' },
        format: { type: 'string', description: 'yt-dlp 格式选择串（可选，如 "best" / "bestvideo+bestaudio"）。留空=自动选最佳 mp4' },
      },
    },
    async execute(params = {}, ctx) {
      const cfg = ctx?.download || {}
      const url = String(params.url || '').trim()
      // ① URL 校验：仅 http(s)
      if (!/^https?:\/\//i.test(url)) return { error: '仅支持 http/https URL' }
      if (/\s|--|\bsource=|\bexec\b/i.test(url)) return { error: 'URL 含可疑字符' }

      const bin = ytDlpBin || cfg.ytDlpBin || 'yt-dlp'
      const baseDir = cfg.dir || path.join(Config.path.temp, 'downloads')
      const callDir = path.join(baseDir, `${Date.now()}-${randomUUID().slice(0, 8)}`)
      const maxBytes = Number(cfg.maxBytes) || 600 * MB
      const sendLimit = Number(cfg.sendLimitBytes) || 100 * MB
      const timeoutSec = Number(cfg.maxTimeoutSec) || 600

      // ② 下载
      const res = await runYtDlp(url, {
        dir: callDir, bin: undefined, ytDlpBin: bin,
        format: params.format || undefined,
        audioOnly: params.audioOnly === true,
        maxBytes, timeoutSec,
      }).catch((e) => ({ ok: false, error: String(e?.message || e), files: [], durationMs: 0 }))

      const file = (res.files || []).map((p) => ({ p, size: (() => { try { return fs.statSync(p).size } catch { return 0 } })() })).sort((a, b) => b.size - a.size)[0]

      // 失败 / 无文件
      if (!res.ok || !file) {
        try { fs.rmSync(callDir, { recursive: true, force: true }) } catch { /* noop */ }
        return {
          error: res.timedOut ? `下载超时（${timeoutSec}s）` : (res.error || '下载失败'),
          stderr: (res.stderr || '').split('\n').slice(-6).join('\n'),
          durationMs: res.durationMs,
        }
      }

      // ③ 太大不塞 QQ：返回路径（供 SFTP 取），并保留文件
      if (file.size > sendLimit) {
        return {
          ok: true, sent: false,
          file: path.basename(file.p), path: file.p, size: file.size,
          note: `文件 ${Math.round(file.size / MB)}MB 超过发送上限 ${Math.round(sendLimit / MB)}MB，未自动发送。可用 SFTP(sftpadmin) 取：${file.p}`,
          durationMs: res.durationMs,
        }
      }

      // ④ 发送到会话 + 清理
      try {
        const seg = toFileSegment(file.p, path.basename(file.p))
        const e = ctx?.e
        if (e?.reply) await e.reply(seg)
        else if (ctx?.bot?.pickGroup && ctx?.groupId) await ctx.bot.pickGroup(ctx.groupId).sendMsg(seg)
        else throw new Error('无可用的发送出口（缺 ctx.e/ctx.bot）')
        try { fs.rmSync(callDir, { recursive: true, force: true }) } catch { /* noop */ }
        return { ok: true, sent: true, file: path.basename(file.p), size: file.size, durationMs: res.durationMs }
      } catch (e) {
        Log.warn('[download] 发送失败', e?.message || e)
        return { ok: true, sent: false, file: path.basename(file.p), path: file.p, size: file.size, error: `已下载但发送失败：${e?.message || e}（可用 SFTP 取：${file.p}）`, durationMs: res.durationMs }
      }
    },
  }
}
